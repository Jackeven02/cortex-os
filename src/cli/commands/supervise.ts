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
 * ## The replacement is the same agent
 *
 * `--restart` rebuilds the agent from the spec that was persisted when it was
 * born. That spec carries the **authority** it was born with — its
 * capabilities, the pool it may escalate from, its budget ceiling — because a
 * spawn that says nothing about capabilities means *fully privileged*
 * (docs/ABI.md §4.9), and a replacement born stronger than the one it
 * replaces is a different agent, not a restarted one.
 *
 * Where the spec cannot say (it was written by a build that did not record
 * capabilities), the kernel's exit record answers instead: it knows what the
 * process held when it died. Where neither can say, the documented default is
 * taken — full privilege — **and the supervisor says that it had to assume**,
 * because a replacement that may be stronger than the original has to be
 * visible. `--restart-as same|full|none` is the operator's own lever on that.
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
import { readOpenCall, isStalled, isDeclaredWait, type OpenCall } from '../open_call.js';
import { asProcessId, CAPABILITIES, type Capability } from '../../kernel/types.js';
import { parseSemver } from '../../kernel/driver_registry.js';
import { readMeta, type ProcessMeta, type ProcessSpec } from '../process_store.js';

/**
 * How long a terminated process is given to actually die, before it is
 * killed outright. SIGTERM is catchable — an agent may have cleanup to do —
 * but a stuck agent may also ignore it, and a supervisor that waits forever
 * is not a supervisor.
 */
const TERMINATE_GRACE_MS = 5000;

/** The exit code `timeout(1)` uses for "I had to intervene". */
const EXIT_INTERVENED = 124;

/**
 * When the supervisor next has to look.
 *
 * `undefined` means **nothing can change until the kernel says so** — so the
 * supervisor waits for an event instead of waking up on a timer. That is the
 * whole difference between a supervisor that reacts in milliseconds and one
 * that reacts on its next tick, and between an idle supervisor that costs
 * nothing and one that wakes four times a second to find nothing.
 *
 * The three things that can pass a deadline on their own:
 *
 *   - the **stall threshold**: the open call has been open longer than
 *     `--kill-after`. A *declared* wait has no deadline — the agent said it
 *     would be back, and punishing it for keeping its word would be wrong
 *     (and would wake the supervisor up for nothing, forever).
 *   - the **terminate grace**: SIGTERM was sent and the grace period ends.
 *   - the **operator's timeout**: `--timeout-ms`. It does not apply while a
 *     termination is in flight — a supervisor that walks away between the
 *     SIGTERM and the SIGKILL leaves a process nobody is watching.
 */
export interface SupervisorDeadlines {
  /** The call the supervised process is inside, if any. */
  readonly openCall: OpenCall | undefined;
  /** `--kill-after`, in ms — or `null` when there is no such policy. */
  readonly killAfterMs: number | null;
  /** Whether a SIGTERM is waiting for the process to actually go. */
  readonly terminating: boolean;
  /** When the terminate grace ends. */
  readonly terminateDeadline: number;
  /** `--timeout-ms`, in ms — or `null` when there is no such bound. */
  readonly timeoutMs: number | null;
  /** When the supervisor started. */
  readonly startedAt: number;
}

/**
 * The next moment the supervisor has to look, or `undefined` when it can
 * sleep until the kernel says something.
 *
 * Exported because the rule is worth pinning on its own: the timing of a
 * supervisor's decisions is not something an end-to-end test can be relied
 * on to land in.
 */
export function nextDeadline(state: SupervisorDeadlines): number | undefined {
  let earliest: number | undefined;
  const consider = (at: number): void => {
    if (earliest === undefined || at < earliest) earliest = at;
  };

  if (state.terminating) {
    // A termination in flight: the grace period is the only deadline. The
    // operator's timeout does not apply here — walking away between the
    // SIGTERM and the SIGKILL leaves a process nobody is watching.
    consider(state.terminateDeadline);
    return earliest;
  }

  if (
    state.killAfterMs !== null &&
    state.openCall !== undefined &&
    !isDeclaredWait(state.openCall)
  ) {
    consider(state.openCall.since + state.killAfterMs);
  }
  if (state.timeoutMs !== null) {
    consider(state.startedAt + state.timeoutMs);
  }
  return earliest;
}

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

/**
 * What authority a replacement gets.
 *
 * - `same` — exactly what the original held. The default, and the only
 *   answer that keeps "the same agent, restarted" true.
 * - `full` — the operator says so explicitly.
 * - `none` — the operator says so explicitly, and the replacement can do
 *   nothing at all.
 */
type RestartAs = 'same' | 'full' | 'none';

/**
 * The authority a replacement is born with, and how to say it out loud.
 *
 * `capabilities: undefined` means **unnarrowed** — the process holds
 * everything, exactly as a process whose spawner said nothing does. That is
 * not the same as holding the full list explicitly: `release()` on an
 * unnarrowed process keeps the full set grantable so `acquire()` can undo it,
 * while `release()` on an explicit set does not (docs/ABI.md §4.9). A
 * replacement that only *looks* the same is not the same agent.
 */
interface RestartAuthority {
  readonly capabilities?: readonly Capability[];
  readonly grantable?: readonly Capability[];
  /** For the operator's eyes — never parsed. */
  readonly label: string;
  /**
   * True when the authority was **assumed**, not known.
   *
   * Nothing could say what the original was allowed to do, so the
   * replacement gets the documented default — full privilege, because that
   * is what a process whose spawner said nothing holds (docs/ABI.md §4.9).
   * The supervisor says so, because a replacement that may be stronger than
   * the one it replaces is a thing the operator has to be able to see.
   */
  readonly assumed?: boolean;
}

/**
 * Decide what authority the replacement gets.
 *
 * Two sources, and they are not equal:
 *
 *   - the **spec** is the host's recipe — what the process was *born* with.
 *     It is the precise answer, because it also remembers whether the
 *     process was unnarrowed (`null`) or held an explicit set.
 *   - the **exit record** is the kernel's own fact — what the process held
 *     when it died. It is the fallback for a spec written by a build that
 *     did not record capabilities.
 *
 * When neither can say, the replacement gets the documented default (full
 * privilege) and the supervisor says that it had to assume.
 */
export function decideAuthority(
  spec: ProcessSpec,
  meta: ProcessMeta | undefined,
  mode: RestartAs,
): RestartAuthority {
  if (mode === 'full') {
    return { label: 'every capability (the operator asked for it)' };
  }
  if (mode === 'none') {
    return { capabilities: [], grantable: [], label: 'no capability (the operator asked for it)' };
  }

  // `same`: replay the original's authority exactly.
  if (spec.capabilities !== undefined) {
    if (spec.capabilities === null) {
      // Unnarrowed — it holds everything, and it can drop a capability and
      // take it back. Passing the full list explicitly would change that.
      return { label: 'every capability (unnarrowed, as it was)' };
    }
    return {
      capabilities: spec.capabilities,
      grantable: spec.grantable ?? [],
      label:
        spec.capabilities.length === 0 ? 'no capability' : spec.capabilities.join(','),
    };
  }

  // The spec cannot say — it was written by a build that did not record
  // capabilities. The kernel's exit record can: it knows what the process
  // held when it died.
  const held = meta?.capabilities;
  if (held !== undefined) {
    if (held.length === CAPABILITIES.length) {
      // Everything: indistinguishable from "unnarrowed", and the more
      // capable of the two readings (an unnarrowed process can drop a
      // capability and take it back).
      return { label: 'every capability (from the kernel exit record)' };
    }
    return {
      capabilities: held,
      grantable: [],
      label: held.length === 0 ? 'no capability (from the kernel exit record)' : held.join(','),
    };
  }

  // Nothing can say. The documented default for "the spawner said nothing"
  // is full privilege (docs/ABI.md §4.9) — and it is the default the
  // original almost certainly had, because narrowing is opt-in. The
  // supervisor says that it had to assume, because a replacement that may
  // be stronger than the one it replaces has to be visible.
  const abi = parseSemver(spec.kernelAbiVersion);
  if (abi !== null && abi.major < 1) {
    // The original predates capabilities, so it *could not* have been
    // narrowed: full privilege is not an assumption here, it is a fact.
    return { label: 'every capability (the original predates capabilities)' };
  }
  return {
    label: 'every capability (assumed — nothing could say what the original held)',
    assumed: true,
  };
}

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
      'restart-as': { type: 'string' },
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

  // `--restart-as` only means something together with `--restart`. Accepting
  // it alone would turn a mistyped command line into a silent no-op.
  const restartAs = parseRestartAs(values['restart-as']);
  if (restartAs === undefined) {
    console.error(
      `cortex supervise: invalid --restart-as: '${values['restart-as']}' ` +
        `(expected same, full or none)`,
    );
    return 1;
  }
  if (values['restart-as'] !== undefined && values.restart !== true) {
    console.error('cortex supervise: --restart-as only applies together with --restart');
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

  // ---- what wakes the supervisor -------------------------------------------
  /** Resolves the wait when something happens that the supervisor must see. */
  let wakeUp: (() => void) | undefined;
  /** Set when something happened while the supervisor was busy. */
  let dirty = false;

  const wake = (): void => {
    dirty = true;
    wakeUp?.();
  };

  /**
   * Wait until the kernel says something, or until the next deadline.
   *
   * There is no tick. A supervisor that wakes four times a second to find
   * nothing is a supervisor that costs the operator four wake-ups a second,
   * and a decision that waits for the next tick is a decision that is late.
   */
  const waitForWake = (deadline: number | undefined): Promise<void> =>
    new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        wakeUp = undefined;
        resolve();
      };
      wakeUp = done;
      if (deadline !== undefined) {
        // At least a millisecond: a deadline that has already passed must not
        // turn the loop into a busy spin.
        timer = setTimeout(done, Math.max(1, deadline - Date.now()));
      }
    });

  // If the kernel goes away, the supervisor has to say so and stop. A
  // supervisor that hangs on after its kernel died is worse than useless: it
  // looks like it is still supervising, and the process it was watching is
  // nobody's business any more.
  client.onClose(() => {
    kernelGone = true;
    wake();
  });

  // ---- the state the supervisor keeps --------------------------------------
  let currentPid = pid;
  let restarts = 0;
  /** What the *stream* says the process is inside — trustworthy once it spoke. */
  let handlerOpenCall: OpenCall | undefined;
  /** Whether the stream has told us about a call opening or closing. */
  let handlerSpoke = false;
  /** What the supervisor believes the process is inside. */
  let openCall: OpenCall | undefined;
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
    wake();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  /** Fold one event off the stream into what the supervisor knows. */
  const handleEvent = (event: WireEvent): void => {
    if (event.kind === 'record' && event.pid === currentPid) {
      const record = event.record;
      if (record === undefined) return;
      if (record.syscall === '__signal') {
        // The kernel reports what it did with the signal we sent. A
        // **queued** SIGTERM means the target was not running: the signal
        // sits in its pending queue until it wakes up (docs/PROCESS.md
        // §7.2), and a process that is stuck may never wake. There is
        // nothing to wait for, so the grace period is skipped.
        const signalArgs = record.args as { signal?: string; outcome?: string } | undefined;
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
        handlerOpenCall = {
          callId: record.callId,
          syscall: record.syscall,
          since: Number.isNaN(at) ? Date.now() : at,
          ...(record.args !== undefined ? { args: record.args } : {}),
        };
        handlerSpoke = true;
        openCall = handlerOpenCall;
        return;
      }
      // An exit (or a trap) closes a call — but only a *real* one. The
      // kernel's own bookkeeping frames are not calls, and must not be
      // mistaken for one closing.
      if (record.syscall.startsWith('__')) return;
      handlerSpoke = true;
      if (handlerOpenCall !== undefined && handlerOpenCall.callId === record.callId) {
        handlerOpenCall = undefined;
      }
      openCall = handlerOpenCall;
      return;
    }
    if (event.kind === 'process-exit' && event.pid === currentPid) {
      pendingExit = {
        code: event.exitCode ?? null,
        reason: event.exitReason ?? null,
      };
    }
  };

  // ---- the subscription opens FIRST ----------------------------------------
  //
  // The ending of the supervised process arrives as an event, and an event
  // that has already been and gone cannot be waited for. If the state check
  // came first, a process that ended in between would leave the supervisor
  // waiting for something that will never arrive — and with nothing else to
  // wake it, that wait is forever. The same rule `cortex attach` and
  // `cortex logs` follow: subscribe, then read the history.
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = await client.subscribe((raw) => {
      try {
        handleEvent(raw as WireEvent);
      } finally {
        wake();
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

  // ---- and only then: does the process exist, and is it still alive? -------
  let target:
    | { readonly state?: string; readonly exitCode?: number | null; readonly exitReason?: string | null }
    | undefined;
  try {
    const listing = await client.request<{
      processes: {
        pid: number;
        state?: string;
        exitCode?: number | null;
        exitReason?: string | null;
      }[];
    }>('ps');
    target = listing.processes.find((p) => p.pid === pid);
  } catch (err) {
    unsubscribe();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    client.close();
    if (err instanceof KernelCommandError) {
      console.error(`cortex supervise: ${err.errno}: ${err.message}`);
      return 1;
    }
    throw err;
  }

  if (target === undefined) {
    console.error(`cortex supervise: no such process: ${pid}`);
    unsubscribe();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    client.close();
    return 1;
  }

  if (target.state === 'zombie' || target.state === 'exiting') {
    // It is **already over**. That is an ending to report, not a process to
    // wait for: its `process-exit` event has been and gone, and waiting for
    // it would wait forever.
    const codeText =
      target.exitCode === null || target.exitCode === undefined
        ? 'abnormally'
        : `with code ${target.exitCode}`;
    const reasonText =
      target.exitReason === null || target.exitReason === undefined ? '' : ` (${target.exitReason})`;
    console.log(`# pid ${pid} exited ${codeText}${reasonText}`);
    unsubscribe();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    client.close();
    return target.exitCode ?? 1;
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
    if (restartAs === 'same') {
      console.log('# the replacement gets the authority the original had, as far as it is known');
    } else {
      console.log(`# the replacement gets ${restartAs === 'full' ? 'every capability' : 'no capability'}`);
    }
  }

  // What the process is *already* inside when the supervisor starts. The
  // stream cannot tell us — that `enter` frame was written before we were
  // listening — so the log is asked instead. But the stream may have spoken
  // already (it is subscribed, and the log takes a moment to read), and then
  // the stream is the newer answer: it has seen everything since the
  // subscription, the log has not.
  const logOpenCall = await readOpenCall(dir, pid);
  openCall = handlerSpoke ? handlerOpenCall : logOpenCall;
  if (openCall !== undefined) {
    console.log(
      `# pid ${pid} is already inside ${openCall.syscall} ` +
        `(since ${new Date(openCall.since).toISOString()})`,
    );
  }

  const startedAt = Date.now();
  let exitCode = 1;

  try {
    for (;;) {
      // Sleep until something can matter: an event from the kernel, an
      // interrupt, the kernel going away, or the next deadline. Nothing
      // else — there is no tick, and nothing is decided on a timer that the
      // kernel could have told us about sooner.
      if (!dirty) {
        await waitForWake(
          nextDeadline({
            openCall,
            killAfterMs,
            terminating,
            terminateDeadline,
            timeoutMs,
            startedAt,
          }),
        );
      }
      dirty = false;

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
      if (timeoutMs !== null && !terminating && Date.now() - startedAt >= timeoutMs) {
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
              `(no spec.json under ${dir}/processes/${currentPid}/)`,
          );
          exitCode = ended.code ?? 1;
          break;
        }
        // A replacement must be the *same* agent. The spec carries what the
        // original was born allowed to do — its capabilities, the pool it may
        // escalate from, and its budget ceiling — because a spawn that says
        // nothing means "fully privileged", and a replacement that was born
        // silently promoted would be a different agent in every way that
        // matters (docs/ABI.md §4.9).
        const authority = decideAuthority(spec, readMeta(dir, asProcessId(currentPid)), restartAs);
        if (authority.assumed === true) {
          // Say it. A replacement that may be stronger than the one it
          // replaces is a thing the operator has to be able to see — and
          // the way to make it not happen is `--restart-as none`.
          console.error(
            `# the spec of pid ${currentPid} does not record what it was allowed to do, ` +
              `and it has no exit record that says either`,
          );
          console.error(
            `#   the replacement holds every capability — the documented default for an ` +
              `agent whose spawner said nothing (docs/ABI.md §4.9).`,
          );
          console.error(
            `#   if that is more than the original had: ` +
              `'cortex supervise ${currentPid} --restart --restart-as none'`,
          );
        }
        try {
          const spawned = await client.request<{ pid: number }>('spawn', {
            role: spec.role,
            agent: spec.agent,
            ...(spec.memory !== undefined ? { memory: spec.memory } : {}),
            ...(authority.capabilities !== undefined
              ? { capabilities: authority.capabilities }
              : {}),
            ...(authority.grantable !== undefined
              ? { grantable: authority.grantable }
              : {}),
            ...(spec.budgets !== undefined ? { budgets: spec.budgets } : {}),
          });
          currentPid = spawned.pid;
          intervened = false;
          // The replacement is a different process, so the stream's view of
          // "what is it inside" starts empty again — and the log is asked
          // about the replacement, the same way it was asked about the
          // original.
          handlerOpenCall = undefined;
          handlerSpoke = false;
          openCall = await readOpenCall(dir, currentPid);
          console.log(
            `# restarted as pid ${currentPid} (role=${spec.role}, caps=${authority.label})`,
          );
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
 * Parse the `--restart-as` policy.
 *
 * Absent means `same` — the replacement is the original agent, with the
 * authority it had. Anything else is a policy the operator has to spell out.
 */
function parseRestartAs(raw: string | undefined): RestartAs | undefined {
  if (raw === undefined) return 'same';
  const value = raw.trim().toLowerCase();
  if (value === 'same' || value === 'full' || value === 'none') return value;
  return undefined;
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
  --restart-as <mode>  What authority a replacement gets (default 'same'):
                         same  exactly what the original held
                         full  every capability
                         none  no capability at all
                       'same' replays what the original held — from its spec,
                       or from the kernel's exit record when the spec is too
                       old to say. If neither can say, the replacement gets
                       the documented default (every capability) and the
                       supervisor says that it had to assume.
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
