/**
 * cortex CLI — the call a process is currently inside.
 *
 * ## The question this answers
 *
 * *"Is this agent waiting, or is it stuck?"*
 *
 * The process table says a process is BLOCKED. That is true, and it is not
 * enough: a listener parked on a channel and an agent that will never be
 * answered look identical from the outside — both are `blocked`, both are
 * "waiting on a channel". The difference is *how long*, and the only place
 * that is written down is the log.
 *
 * Every syscall is written as an `enter` frame and an `exit`/`trap` frame
 * **with the same `callId`**. So the calls that are still open are the ones
 * whose `enter` never got a partner — and the `enter` frame's timestamp is
 * when the call started. That is the whole reading: pair the frames by
 * `callId`, and whatever is left over is the call the process is sitting
 * inside, and for how long.
 *
 * ## Why this is not a syscall
 *
 * Because it is a *reading*, not an action, and it is a reading of the log —
 * which is the record. A process that is inside a long driver call is not
 * BLOCKED at all (the kernel does not park a process while its LLM call is
 * in flight), so nothing in the process table can tell you that it is
 * wedged. The log can, because the `enter` frame is there and the `exit`
 * frame is not.
 *
 * ## Why it lives in the CLI, and why it is shared
 *
 * Two commands answer the same question — `cortex supervise` decides whether
 * to kill a process, `cortex top` shows the operator which one to look at.
 * If they read the log differently they will disagree, and a supervisor that
 * kills a process the operator's view calls healthy is worse than either
 * command not existing. So there is one reading, in one place, and both
 * commands use it.
 *
 * @module cli/open_call
 */

import { existsSync } from 'node:fs';

import { existingCrecPath, readRecords } from '../kernel/recorder.js';
import { asProcessId } from '../kernel/types.js';
import type { KernelCommand } from './kernel_protocol.js';

/** A syscall call that has started and has not yet finished. */
export interface OpenCall {
  /** The call's id — the same one its `enter` frame carries. */
  readonly callId: string;
  /** The syscall the process is inside (`recv`, `llm_call`, `tool_call`, …). */
  readonly syscall: string;
  /** When the call started, in epoch milliseconds. */
  readonly since: number;
  /** The call's arguments, as its `enter` frame recorded them. */
  readonly args?: unknown;
}

/**
 * Syscalls that are a *declared wait* rather than work in progress, and so
 * are not stalls no matter how long they take.
 *
 * A `sleep` is the agent saying "I will be back at this time". Killing it
 * for being slow would be punishing a process for keeping its word.
 */
export const EXEMPT_FROM_STALL: ReadonlySet<string> = new Set(['sleep']);

/**
 * Whether a call is a *declared* wait — one that will end on its own.
 *
 * A `sleep` always is. A `wait` on a child is when it carries a deadline:
 * `wait(pid, { timeoutMs })` wakes up whether or not the child does, so a
 * planner waiting for a coder is doing exactly what it said it would do, and
 * a supervisor that killed it would be killing the supervisor.
 *
 * A `wait` with **no** deadline is not a declared wait. That is the call
 * that hangs forever when the child hangs (BACKLOG #057), and it is the one
 * worth killing.
 *
 * Exported because a caller has to know it too: a supervisor that arms a
 * deadline for a declared wait would wake up for nothing, over and over, for
 * as long as the agent politely waits.
 */
export function isDeclaredWait(call: OpenCall): boolean {
  if (EXEMPT_FROM_STALL.has(call.syscall)) return true;
  if (call.syscall !== 'wait') return false;
  // The `wait` frame records its arguments as a positional tuple:
  // `[childPid, { timeoutMs }]`. A single argument is the bare pid, and no
  // options means no deadline.
  const args = call.args;
  if (!Array.isArray(args)) return false;
  const options = args[1] as { timeoutMs?: unknown } | undefined;
  return (
    options !== undefined &&
    options !== null &&
    typeof options.timeoutMs === 'number' &&
    Number.isFinite(options.timeoutMs)
  );
}

/**
 * Whether a process that has been inside `call` for this long is stuck.
 *
 * The rule lives here, and not in either command, because two commands
 * answer the same question: `cortex supervise` decides whether to kill a
 * process, `cortex top` shows the operator which one to look at. If they
 * disagreed about what "stuck" means, the view would call a process healthy
 * that the supervisor was about to kill — or worse, the reverse.
 */
export function isStalled(call: OpenCall, now: number, thresholdMs: number): boolean {
  if (isDeclaredWait(call)) return false;
  return now - call.since > thresholdMs;
}

/**
 * The bit of a live kernel the open-call reader needs.
 *
 * A `KernelClient` satisfies this. It is an interface rather than a concrete
 * client so that a caller which *already* holds a connection can hand it
 * over instead of opening (and closing) another one.
 */
export interface OpenCallSource {
  request(cmd: KernelCommand, args?: Record<string, unknown>): Promise<unknown>;
}

/**
 * The call each live process is inside, as the **kernel** says.
 *
 * The kernel knows this: the dispatcher writes every syscall as an `enter`
 * frame and its partner, and it knows which pairs are still open. Asking it
 * is O(processes); reading the log is O(bytes) — and the log of a long-lived
 * agent grows for as long as the agent runs, so a view that reads it on every
 * invocation gets slower exactly as the operator needs it most.
 *
 * The answer is the *same* fact the log would give: the kernel's entry is
 * set when the `enter` frame is written and cleared when its partner is, and
 * the `since` it reports is that frame's own timestamp. So the two readings
 * cannot disagree — they are the same pairing, kept two ways.
 *
 * @returns The open calls, or `undefined` when the kernel **could not be
 *   asked** — a kernel too old to know the command, or one that is not
 *   answering. The caller falls back to the log then. An empty map is a
 *   different answer: the kernel was asked and has no open calls.
 */
export async function readOpenCallsFromKernel(
  source: OpenCallSource | undefined,
): Promise<Map<number, OpenCall> | undefined> {
  if (source === undefined) return undefined;
  let raw: unknown;
  try {
    raw = await source.request('openCalls');
  } catch {
    // A kernel that cannot answer is a kernel we know nothing about; the
    // caller falls back to the log rather than pretending there is no call.
    return undefined;
  }
  const calls = (raw as { calls?: unknown }).calls;
  if (!Array.isArray(calls)) return undefined;
  const out = new Map<number, OpenCall>();
  for (const entry of calls) {
    const call = entry as {
      pid?: unknown;
      syscall?: unknown;
      callId?: unknown;
      since?: unknown;
      args?: unknown;
    };
    if (typeof call.pid !== 'number' || typeof call.syscall !== 'string') continue;
    const at = Date.parse(typeof call.since === 'string' ? call.since : '');
    out.set(call.pid, {
      callId: typeof call.callId === 'string' ? call.callId : '',
      syscall: call.syscall,
      since: Number.isNaN(at) ? Date.now() : at,
      // The arguments come with the call: they are what say a `wait` carries
      // its own deadline, and a declared wait is never a stall.
      ...(call.args !== undefined ? { args: call.args } : {}),
    });
  }
  return out;
}

/**
 * Read the syscall a process is *currently inside*, from its log.
 *
 * Returns `undefined` when there is no open call — and also when the log
 * cannot be read at all. The two are not the same fact, but they lead to
 * the same *rendering* (nothing to say about this process), and a reader
 * that had to tell them apart would only be able to report "we do not
 * know", which is not something a table can say.
 *
 * The cost is one full read of the process's log — the same read
 * `cortex trace` does. It is paid once, not per poll.
 */
export async function readOpenCall(dir: string, pid: number): Promise<OpenCall | undefined> {
  const path = existingCrecPath(dir, asProcessId(pid));
  if (!existsSync(path)) return undefined;

  /** callId → the call it opened, and when it opened. */
  const open = new Map<string, { syscall: string; since: number; args?: unknown }>();
  try {
    for await (const record of readRecords(path)) {
      // Internal frames (`__state`, `__sched`, …) are the kernel's own
      // bookkeeping: they are never a call an agent is sitting inside.
      if (record.syscall.startsWith('__')) continue;
      if (record.phase === 'enter') {
        const at = Date.parse(record.timestamp);
        open.set(record.callId, {
          syscall: record.syscall,
          since: Number.isNaN(at) ? Date.now() : at,
          ...(record.args !== undefined ? { args: record.args } : {}),
        });
        continue;
      }
      open.delete(record.callId);
    }
  } catch {
    // A log we cannot read is a log we cannot learn from; the caller still
    // works from the stream alone.
    return undefined;
  }

  if (open.size === 0) return undefined;
  // A process makes one syscall at a time, so there is at most one open
  // call. If there are more (a hand-edited log, say), the last one wins.
  const entries = [...open.entries()];
  const [callId, info] = entries[entries.length - 1]!;
  return {
    callId,
    syscall: info.syscall,
    since: info.since,
    ...(info.args !== undefined ? { args: info.args } : {}),
  };
}
