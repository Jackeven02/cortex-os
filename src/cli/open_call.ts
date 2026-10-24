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
 * "waiting on a channel". The difference is *how long*, and the difference is
 * not in the process table.
 *
 * Every syscall is written as an `enter` frame and an `exit`/`trap` frame
 * **with the same `callId`**. So the calls that are still open are the ones
 * whose `enter` never got a partner — and the `enter` frame's timestamp is
 * when the call started. That is the whole reading: pair the frames by
 * `callId`, and whatever is left over is the call the process is sitting
 * inside, and for how long.
 *
 * ## Where the answer comes from
 *
 * **The kernel knows it.** It writes those frames itself, so it knows which
 * pairs are still open, and it can be asked — `Kernel.openCalls()` on the
 * host side, `openCalls` on the transport. That costs O(processes), and the
 * number it reports is the same one the log would give: the `since` is that
 * `enter` frame's own timestamp.
 *
 * **The log is the fallback** — for a kernel too old to know the command, or
 * for no kernel at all. It is the same reading kept twice, and it is the
 * slow one: the log of a long-lived agent grows for as long as the agent
 * runs, so a view that reads it on every invocation gets slower exactly as
 * the operator needs it most.
 *
 * ## Why this is not a syscall
 *
 * Because it is a *reading*, not an action. A process that is inside a long
 * driver call is not BLOCKED at all (the kernel does not park a process
 * while its LLM call is in flight), so nothing in the process table can tell
 * you that it is wedged. The call can, because the `enter` frame is there
 * and the `exit` frame is not.
 *
 * ## Why it lives in the CLI, and why it is shared
 *
 * Four views answer the same question — `cortex supervise` decides whether
 * to kill a process, `cortex top` shows the operator which one to look at,
 * `cortex ps` puts it in a column, and the dashboard shows it in the page.
 * If they read it differently they will disagree, and a supervisor that
 * kills a process the operator's view calls healthy is worse than either
 * command not existing. So there is one reading, in one place, and one set
 * of words, and every view uses both.
 *
 * @module cli/open_call
 */

import { existsSync } from 'node:fs';

import { existingCrecPath, readRecords } from '../kernel/recorder.js';
import { asProcessId, unbrand, type BlockedReason } from '../kernel/types.js';
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

// =============================================================================
// §3 The words
// =============================================================================

/**
 * Syscall names an operator would rather read as English.
 *
 * These are the calls that *wait*. The rest are named as they are, because
 * "inside spawn" is more use to a reader than an invented phrase for it.
 */
const FRIENDLY_CALLS: Readonly<Record<string, string>> = {
  recv: 'a channel',
  sleep: 'a timer',
  wait: 'a child',
  llm_call: 'a model call',
  tool_call: 'a tool call',
  memory_read: 'memory',
  memory_write: 'memory',
};

/**
 * Render a `BlockedReason` in words.
 *
 * The kernel's own reason is used when there is one — it knows *which*
 * child, after all. Otherwise the call's own name is used, which is how a
 * model call shows up: the kernel does not park a process while its LLM call
 * is in flight, so there is no blocked reason for it.
 */
export function describeBlocked(blockedOn: BlockedReason | undefined | null): string {
  if (blockedOn === undefined || blockedOn === null) return 'something';
  switch (blockedOn.kind) {
    case 'wait':
      return `child ${String(unbrand(blockedOn.pid))}`;
    case 'recv':
      return 'a channel';
    case 'sleep':
      return 'a timer';
    case 'llm':
      return 'a model call';
    case 'tool':
      return 'a tool call';
    case 'budget':
      return 'its budget';
    case 'lock':
      return `lock ${blockedOn.resource}`;
  }
}

/**
 * What a process is waiting on, as a noun phrase.
 *
 * "a channel", "child 5", "a model call". This is what a table cell wants;
 * `describeCall` is what a line wants. Both come from the same table, so a
 * table and a line cannot drift apart — and a process blocked on a child says
 * *which* child, because the kernel knows.
 *
 * A call that is not one of the waiting ones keeps its own name ("spawn"),
 * because "waiting on spawn" would be a sentence about something that is not
 * waiting at all.
 */
export function describeWait(
  syscall: string,
  blockedOn?: BlockedReason | null,
): string {
  if (blockedOn !== undefined && blockedOn !== null) return describeBlocked(blockedOn);
  const friendly = FRIENDLY_CALLS[syscall];
  return friendly !== undefined ? friendly : syscall;
}

/**
 * What a process is waiting for, in words.
 *
 * The blocked reason wins when the kernel has one; otherwise the call's own
 * name is used, which is how a model call shows up.
 */
export function describeCall(syscall: string, blockedOn?: BlockedReason | null): string {
  if (blockedOn !== undefined && blockedOn !== null) {
    return `waiting on ${describeBlocked(blockedOn)}`;
  }
  const friendly = FRIENDLY_CALLS[syscall];
  if (friendly !== undefined) return `waiting on ${friendly}`;
  return `inside ${syscall}`;
}

/**
 * A duration, precise to the second.
 *
 * How long a *call* has been open. This is not the same shape as the age
 * `cortex ps` prints, and deliberately so: an age is a coarse fact ("4m" is
 * enough), while the length of a call is the thing a supervisor decides on,
 * and "44s" and "4m" are different answers to "should I kill this?".
 */
export function formatDuration(ms: number): string {
  if (ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * The whole answer, in one line: what the process is inside, and for how long.
 *
 * This is the sentence `cortex top` prints in its WAITING column and the
 * dashboard prints in its "inside" column, and it is one function because two
 * views of the same fact must not be able to phrase it differently — an
 * operator who reads "waiting on a model call" in the tree and "llm_call" in
 * the table has to work out whether those are the same thing.
 */
export function formatOpenCall(
  call: OpenCall,
  blockedOn: BlockedReason | undefined | null,
  now: number,
): string {
  return `${describeCall(call.syscall, blockedOn)} for ${formatDuration(now - call.since)}`;
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
 * The rows an open-call reading needs: a pid, and whether the kernel still
 * holds that process.
 *
 * The `live` flag is not a detail. A process that is gone is not "inside"
 * anything: its log keeps the `enter` frame of the call it was killed in, and
 * reading that as "still inside that call" would be a lie. Every reading here
 * obeys the same rule, so two views of the same fact cannot make different
 * choices about it.
 */
export interface OpenCallRow {
  readonly pid: number;
  readonly live: boolean;
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

/**
 * The open call of every **live** process, read from the logs.
 *
 * The slow way: one full read of each live process's log, in parallel. It is
 * the fallback for a kernel that cannot be asked — one too old to know the
 * `openCalls` command, or one that is not answering.
 *
 * Only *live* processes are read. A process the kernel has finished is not
 * inside anything, whatever its last frame says.
 */
export async function readOpenCallsFromLog(
  dir: string,
  rows: readonly OpenCallRow[],
): Promise<Map<number, OpenCall>> {
  const found = await Promise.all(
    rows
      .filter((row) => row.live)
      .map(async (row): Promise<readonly [number, OpenCall | undefined]> => {
        const call = await readOpenCall(dir, row.pid);
        return [row.pid, call] as const;
      }),
  );
  const map = new Map<number, OpenCall>();
  for (const [pid, call] of found) {
    if (call !== undefined) map.set(pid, call);
  }
  return map;
}

/**
 * The call each live process is inside, however it can be found.
 *
 * The kernel first, the log second — and the log only when the kernel could
 * not be asked at all, because "the kernel says there is no open call" and
 * "the kernel did not answer" are different facts and only the second one
 * licenses reading the log.
 *
 * This is the one entry point every view uses, because two views that read
 * the same fact differently will disagree, and an operator who sees "waiting
 * on a channel" in one view and nothing in the other has to work out which
 * one is lying.
 */
export async function readOpenCalls(
  dir: string,
  rows: readonly OpenCallRow[],
  source?: OpenCallSource,
): Promise<Map<number, OpenCall>> {
  const fromKernel = await readOpenCallsFromKernel(source);
  const raw = fromKernel ?? (await readOpenCallsFromLog(dir, rows));
  // The same filter for both readings: a process the kernel no longer holds
  // is not inside anything, even though its log keeps the `enter` frame of
  // the call it was killed in. Two readings of one fact have to make the
  // same choice, or they are two facts.
  const live = new Set(rows.filter((row) => row.live).map((row) => row.pid));
  return new Map([...raw].filter(([pid]) => live.has(pid)));
}
