/**
 * cortex CLI — `cortex supervise <pid>`
 *
 * ## The question this answers
 *
 * *"Keep this agent honest."*
 *
 * Everything the shell could do with a live agent was something a human had
 * to do: look at `ps`, read `logs`, wait for `wait`, watch `watch`. The
 * moment an agent got stuck, the operator had to be *there* to notice. That
 * is not supervision; that is babysitting.
 *
 * `cortex supervise` is the shell-side version of what Demo C's planner does
 * inside an agent: watch a process, notice when it stops making progress,
 * kill it, and put a fresh one in its place.
 *
 * ## How "not making progress" is decided
 *
 * Not by silence. **Silence is not evidence of a stall.** An agent that is
 * parked in `recv()` waiting for a message, or one that is deep in a
 * legitimate 60-second LLM call, produces no frames — but neither of them is
 * stuck.
 *
 * The kernel's log knows the difference. Every syscall is written as an
 * `enter` frame and an `exit`/`trap` frame **with the same `callId`**. So a
 * process that entered `tool_call` at 10:00:00 and has produced no matching
 * exit since is not "quiet" — it is *inside* `tool_call`, and has been for as
 * long as the gap between the two frames. That is a precise stall signal,
 * and it is the one this command uses.
 *
 * `sleep` is exempt by default: a sleep is a **declared wait** ("I will be
 * back in an hour"), not a stall. Everything else counts, including a `recv`
 * that never returns — that one really is a hang.
 *
 * ## The thresholds are the operator's
 *
 * `--kill-after` is a policy, not a fact. Set it longer than your slowest
 * legitimate call: an LLM call that legitimately takes 40 seconds will look
 * exactly like a stuck one at a 30-second threshold.
 *
 * ## Exit codes
 *
 * - the supervised process's own exit code (so `cortex supervise 2 || echo
 *   failed` works the way it does everywhere else in this CLI);
 * - **124** when the supervisor had to kill the process — the convention
 *   `timeout(1)` uses for "I had to intervene";
 * - **130** when the operator interrupted the supervisor;
 * - 1 for a usage error or no live kernel.
 *
 * Usage:
 *   cortex supervise <pid> --kill-after 30000
 *   cortex supervise <pid> --kill-after 30000 --restart
 *   cortex supervise <pid> --timeout-ms 60000
 *
 * @module cli/commands/supervise
 */

import { parseArgs } from 'node:util';

import { defaultKernelDir, readSpec } from '../index.js';
import {
  explainKernelGone,
  probeKernel,
  KernelCommandError,
  type KernelClient,
} from '../kernel_client.js';
import { readOpenCall, isStalled, type OpenCall } from '../open_call.js';
import { asProcessId } from '../../kernel/types.js';

/** How often the supervisor looks at its own state, in ms. */
const POLL_INTERVAL_MS = 250;

/**
 * How long a terminated process is given to actually die, before it is
 * killed outright. SIGTERM is catchable — an agent may have cleanup to do —
 * but a stuck agent may also ignore it, and a supervisor that waits forever
 * is not a supervisor.
 */
const TERMINATE_GRACE_MS = 5000;

/** The exit code `timeout(1)` uses for "I had to intervene". */
const EXIT_INTERVENED = 124;

/** The event shapes this command reads off the stream. */
interface WireEvent {
  readonly kind: string;
  readonly pid: number;
  readonly record?: {
    readonly phase: string;
    readonly callId: string;
    readonly syscall: string;
    readonly args?: unknown;
    readonly timestamp?: string;
  };
  readonly exitCode?: number | null;
  readonly exitReason?: string | null;
}

/** The result of parsing one millisecond option. */
type MsOption =
  | { readonly kind: 'absent' }
  | { readonly kind: 'value'; readonly ms: number }
  | { readonly kind: 'invalid' };

export async function cmdSupervise(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      'kill-after': { type: 'string' },
      restart: { type: 'boolean', default: false },
      'max-restarts': { type: 'string', default: '5' },
      'backoff-ms': { type: 'string', default: '1000' },
      'timeout-ms': { type: 'string', default: '0' },
    },
    allowPositionals: true,
  });

  if (values.help === true || positionals.length === 0) {
    printHelp();
    return values.help === true ? 0 : 1;
  }

  const raw = positionals[0]!;
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid < 0) {
    console.error(`cortex supervise: invalid PID: '${raw}'`);
    return 1;
  }

  const killAfter = parseMs(values['kill-after'], 'kill-after');
  const timeout = parseMs(values['timeout-ms'], 'timeout-ms');
  const backoff = parseMs(values['backoff-ms'], 'backoff-ms');
  const maxRestarts = parseMs(values['max-restarts'], 'max-restarts');
  if (
    killAfter.kind === 'invalid' ||
    timeout.kind === 'invalid' ||
    backoff.kind === 'invalid' ||
    maxRestarts.kind === 'invalid'
  ) {
    return 1;
  }

  // A zero means "not this policy", for the three options where zero is not a
  // meaningful budget. `--max-restarts 0` is different: it is a real answer
  // ("do not restart it"), so it is kept.
  const killAfterMs = killAfter.kind === 'value' && killAfter.ms > 0 ? killAfter.ms : null;
  const timeoutMs = timeout.kind === 'value' && timeout.ms > 0 ? timeout.ms : null;
  const backoffMs = backoff.kind === 'value' ? backoff.ms : 0;
  const restartLimit = maxRestarts.kind === 'value' ? maxRestarts.ms : 5;

  if (killAfterMs === null && values.restart !== true) {
    console.error('cortex supervise: nothing to do — pass --kill-after <ms> and/or --restart');
    return 1;
  }

  const dir = defaultKernelDir();
  const probe = await probeKernel(dir);
  if (probe.kind !== 'live') {
    if (probe.kind === 'stale') {
      console.error(
        `cortex supervise: the kernel that published ${probe.endpoint.host}:${probe.endpoint.port} ` +
          `is not reachable (${probe.reason})`,
      );
    } else {
      console.error('cortex supervise: no live kernel is running in this directory');
      console.error('  start one with `cortex daemon run` — supervision needs a running kernel');
    }
    return 1;
  }

  const client = probe.client;

  /** Set when the kernel goes away while we are supervising. */
  let kernelGone = false;

  // If the kernel goes away, the supervisor has to say so and stop. A
  // supervisor that hangs on after its kernel died is worse than useless: it
  // looks like it is still supervising, and the process it was watching is
  // nobody's business any more.
  client.onClose(() => {
    kernelGone = true;
  });

  // The process has to exist before it can be supervised.
  try {
    const listing = await client.request<{ processes: { pid: number }[] }>('ps');
    if (!listing.processes.some((p) => p.pid === pid)) {
      console.error(`cortex supervise: no such process: ${pid}`);
      client.close();
      return 1;
    }
  } catch (err) {
    client.close();
    if (err instanceof KernelCommandError) {
      console.error(`cortex supervise: ${err.errno}: ${err.message}`);
      return 1;
    }
    throw err;
  }

  console.log(`# supervising pid ${pid}`);
  if (killAfterMs !== null) {
    console.log(
      `# kill it if it stays inside one syscall for more than ${killAfterMs}ms ` +
        `(sleep is exempt — it is a declared wait)`,
    );
  }
  if (values.restart === true) {
    console.log(`# restart it when it ends (at most ${restartLimit} time(s))`);
  }

  let currentPid = pid;
  let restarts = 0;
  // What the process is *already* inside when the supervisor starts. The
  // stream cannot tell us — that `enter` frame was written before we were
  // listening — so the log is asked instead.
  let openCall: OpenCall | undefined = await readOpenCall(dir, pid);
  if (openCall !== undefined) {
    console.log(
      `# pid ${pid} is already inside ${openCall.syscall} ` +
        `(since ${new Date(openCall.since).toISOString()})`,
    );
  }
  let pendingExit: { code: number | null; reason: string | null } | undefined;
  /** Set while a SIGTERM is waiting for the process to actually go. */
  let terminating = false;
  let terminateDeadline = 0;
  /** True when the supervisor killed the current incarnation. */
  let intervened = false;
  /** Set when the kernel reports that our SIGTERM was queued, not delivered. */
  let escalateNow = false;
  let stopped = false;

  const onSignal = (): void => {
    stopped = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = await client.subscribe((raw) => {
      const event = raw as WireEvent;
      if (event.kind === 'record' && event.pid === currentPid) {
        const record = event.record;
        if (record === undefined) return;
        if (record.syscall === '__signal') {
          // The kernel reports what it did with the signal we sent. A
          // **queued** SIGTERM means the target was not running: the signal
          // sits in its pending queue until it wakes up (docs/PROCESS.md
          // §7.2), and a process that is stuck may never wake. There is
          // nothing to wait for, so the grace period is skipped.
          const signalArgs = record.args as
            | { signal?: string; outcome?: string }
            | undefined;
          if (signalArgs?.signal === 'SIGTERM' && signalArgs.outcome === 'queued') {
            escalateNow = true;
          }
          return;
        }
        if (record.phase === 'enter') {
          // Internal frames (`__state`, `__sched`, …) are the kernel's own
          // bookkeeping and do not open a call the agent is sitting in.
          if (record.syscall.startsWith('__')) return;
          // The call's own timestamp, not the moment the event was handled:
          // the two commands that read this must measure the same thing.
          const at = Date.parse(record.timestamp ?? '');
          openCall = {
            callId: record.callId,
            syscall: record.syscall,
            since: Number.isNaN(at) ? Date.now() : at,
            ...(record.args !== undefined ? { args: record.args } : {}),
          };
          return;
        }
        if (openCall !== undefined && openCall.callId === record.callId) {
          openCall = undefined;
        }
        return;
      }
      if (event.kind === 'process-exit' && event.pid === currentPid) {
        pendingExit = {
          code: event.exitCode ?? null,
          reason: event.exitReason ?? null,
        };
      }
    }, {
      kinds: ['record', 'process-exit'],
    });
  } catch (err) {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    client.close();
    if (err instanceof KernelCommandError) {
      console.error(`cortex supervise: ${err.errno}: ${err.message}`);
      return 1;
    }
    throw err;
  }

  const startedAt = Date.now();
  let exitCode = 1;

  try {
    for (;;) {
      await delay(POLL_INTERVAL_MS);
      if (stopped) {
        console.log('# interrupted');
        exitCode = 130;
        break;
      }

      // The kernel went away. Nothing more can be supervised, and nothing
      // more can be *reported*: the fate of the process we were watching is
      // unknown, and a supervisor must not invent one.
      if (kernelGone) {
        const why = await explainKernelGone(dir);
        console.error(`cortex supervise: ${why}`);
        console.error(
          `  the fate of pid ${currentPid} is unknown — the supervisor stopped when the kernel did.`,
        );
        exitCode = 1;
        break;
      }

      // The timeout is the operator's bound, but it does not cut a
      // termination in half: a supervisor that walks away between the
      // SIGTERM and the SIGKILL leaves a process nobody is watching.
      if (timeoutMs !== null && !terminating && Date.now() - startedAt > timeoutMs) {
        console.log(`# gave up after ${timeoutMs}ms`);
        exitCode = 1;
        break;
      }

      // --- escalate a termination that the process ignored ------------------
      if (escalateNow) {
        escalateNow = false;
        terminating = false;
        try {
          await client.request('kill', { pid: currentPid, signal: 'SIGKILL' });
          console.log(
            `# pid ${currentPid} was not running — its SIGTERM was queued, so it was killed outright`,
          );
        } catch {
          // Already gone — which is the outcome we wanted.
        }
      } else if (terminating && Date.now() > terminateDeadline) {
        terminating = false;
        try {
          await client.request('kill', { pid: currentPid, signal: 'SIGKILL' });
          console.log(`# pid ${currentPid} ignored SIGTERM — killed it`);
        } catch {
          // Already gone — which is the outcome we wanted.
        }
      }

      // --- the stall check --------------------------------------------------
      if (
        killAfterMs !== null &&
        openCall !== undefined &&
        !terminating &&
        isStalled(openCall, Date.now(), killAfterMs)
      ) {
        const stuckMs = Date.now() - openCall.since;
        console.log(
          `# pid ${currentPid} has been inside ${openCall.syscall} for ${stuckMs}ms — killing it`,
        );
        openCall = undefined;
        intervened = true;
        terminating = true;
        terminateDeadline = Date.now() + TERMINATE_GRACE_MS;
        try {
          await client.request('kill', { pid: currentPid, signal: 'SIGTERM' });
        } catch (err) {
          if (err instanceof KernelCommandError) {
            // ESRCH: it died on its own between the check and the signal.
            terminating = false;
          } else {
            throw err;
          }
        }
      }

      // --- the exit ---------------------------------------------------------
      if (pendingExit === undefined) continue;
      const ended = pendingExit;
      pendingExit = undefined;
      openCall = undefined;
      terminating = false;

      const codeText = ended.code === null ? 'abnormally' : `with code ${ended.code}`;
      const reasonText = ended.reason === null ? '' : ` (${ended.reason})`;
      console.log(`# pid ${currentPid} exited ${codeText}${reasonText}`);

      const canRestart = values.restart === true && restarts < restartLimit && !stopped;
      if (canRestart) {
        restarts += 1;
        if (backoffMs > 0) await delay(backoffMs);
        const spec = readSpec(dir, asProcessId(currentPid));
        if (spec === undefined) {
          console.error(
            `# cannot restart pid ${currentPid}: its spec was never persisted ` +
              `(no ${currentPid}.spec.json in ${dir})`,
          );
          exitCode = ended.code ?? 1;
          break;
        }
        try {
          const spawned = await client.request<{ pid: number }>('spawn', {
            role: spec.role,
            agent: spec.agent,
            ...(spec.memory !== undefined ? { memory: spec.memory } : {}),
          });
          currentPid = spawned.pid;
          intervened = false;
          openCall = undefined;
          console.log(`# restarted as pid ${currentPid} (role=${spec.role})`);
          continue;
        } catch (err) {
          if (err instanceof KernelCommandError) {
            console.error(`# restart failed: ${err.errno}: ${err.message}`);
          } else {
            console.error(`# restart failed: ${(err as Error).message}`);
          }
          exitCode = ended.code ?? 1;
          break;
        }
      }

      exitCode = intervened ? EXIT_INTERVENED : (ended.code ?? 1);
      break;
    }
  } finally {
    unsubscribe?.();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    client.close();
  }

  return exitCode;
}

/**
 * Parse a millisecond option.
 *
 * Three outcomes, not two: absent (the option was not given), a value, and
 * invalid (the option was given but is not a number). Collapsing "absent"
 * and "invalid" into one would turn a typo into a silently disabled policy.
 */
function parseMs(raw: string | undefined, name: string): MsOption {
  if (raw === undefined) return { kind: 'absent' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: 'absent' };
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.error(`cortex supervise: invalid --${name}: '${raw}' (expected milliseconds)`);
    return { kind: 'invalid' };
  }
  return { kind: 'value', ms: parsed };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp(): void {
  console.log(`cortex supervise — keep an agent honest while it runs

USAGE
  cortex supervise <pid> --kill-after <ms>    Kill it if it stops making progress
  cortex supervise <pid> --restart            Put a fresh one in its place

OPTIONS
  --kill-after <ms>    Kill the process if it has been stuck inside one syscall
                       for longer than <ms>. A 'sleep' is exempt: it is a
                       declared wait, not a stall. Set this longer than your
                       slowest legitimate call.
  --restart            Respawn the process when it ends, from the spec that
                       was persisted when it was created.
  --max-restarts <n>   Give up after n restarts (default 5).
  --backoff-ms <ms>    Wait this long before a restart (default 1000).
  --timeout-ms <ms>    Stop supervising after <ms> (default 0 = until it ends
                       or you interrupt).
  -h, --help           Show this help

NOTES
  This needs a live kernel — 'cortex daemon run' publishes its endpoint in
  <CORTEX_HOME>/kernel.json.

  "Stuck" is decided by the syscall log, not by silence: every syscall is
  written as an 'enter' frame and an 'exit'/'trap' frame with the same
  callId, so a process that entered a syscall and never came out of it is
  inside that syscall, and has been for exactly as long as the gap.

EXIT CODES
  the supervised process's own exit code; 124 when the supervisor had to kill
  it (the convention timeout(1) uses); 130 when you interrupted it; 1 when
  the kernel went away — the supervised process's fate is then unknown, and
  the supervisor says so rather than inventing an ending.

EXAMPLES
  cortex supervise 2 --kill-after 30000
  cortex supervise 2 --kill-after 30000 --restart --max-restarts 3
`);
}
