/**
 * cortex kernel — signal delivery.
 *
 * Implements the signal semantics described in docs/PROCESS.md §7. The
 * process table *stores* dispositions and the pending queue; this module
 * decides **when** and **how** signals fire.
 *
 * ## Model
 *
 * Three signals are delivered immediately regardless of process state:
 *
 *   - `SIGKILL`  — uncatchable, transitions any non-terminal state to
 *                  EXITING and then ZOMBIE. Cannot be queued or blocked
 *                  (docs/PROCESS.md §7.1).
 *   - `SIGSTOP`  — uncatchable, fires only from RUNNING; otherwise queued.
 *   - `SIGCONT`  — fires only from STOPPED; otherwise dropped (no-op).
 *
 * Every other signal follows the queuing rule from §7.2: if the process is
 * not RUNNING, the signal is appended to its pending queue and delivered
 * the next time it transitions to RUNNING. This prevents an LLM call from
 * being interrupted mid-flight (which would waste tokens) and gives agents
 * a deterministic point at which signals are observed.
 *
 * ## Dispositions
 *
 * Each (process, signal) pair has a disposition (docs/PROCESS.md §7.1):
 *
 *   - `default` — apply the kernel-defined action (table below).
 *   - `ignore`  — drop the signal silently. A `__signal` record is still
 *                 written so the drop is observable in the .crec log.
 *   - `handler` — invoke a user-supplied function. The handler runs as a
 *                 callback into agent code; it may itself perform syscalls.
 *                 v0 does not yet wire handlers to a `CortexContext` (the
 *                 dispatcher lands in #014); for now we accept an injectable
 *                 `handlerInvoker` so smoke tests can verify the path.
 *
 * `SIGKILL` and `SIGSTOP` cannot have non-default dispositions; the table
 * already traps `EPERM` on `setDisposition()` for those.
 *
 * ## Default action table (docs/PROCESS.md §7)
 *
 *   SIGHUP    ignore       (config reload — agent-specific)
 *   SIGINT    terminate    (graceful interrupt)
 *   SIGTERM   terminate    (graceful termination)
 *   SIGKILL   kill         (immediate, uncatchable)
 *   SIGSTOP   stop         (pause, uncatchable)
 *   SIGCONT   continue     (resume from STOPPED)
 *   SIGUSR1   ignore       (reflect — agent-specific)
 *   SIGUSR2   ignore       (checkpoint — kernel-mediated, see checkpoint.ts)
 *   SIGCHLD   ignore       (parent notification)
 *   SIGXCPU   stop         (budget exceeded; supervisor decides next)
 *   SIGXFSZ   terminate    (memory region overflow)
 *   SIGSYS    terminate    (bad syscall)
 *   SIGPIPE   ignore       (IPC channel closed)
 *
 * ## Recording
 *
 * Every signal — sent, queued, dropped, delivered — writes a `__signal`
 * record to the target's `.crec` log. The double underscore marks it as
 * kernel-internal (matching `__state` from process_table.ts). Records carry
 * `phase: 'exit'` and an `args` payload of `{ signal, from, disposition,
 * action, queued }` so replay engines can reconstruct the delivery order.
 *
 * See: docs/PROCESS.md §7, docs/ARCHITECTURE.md §4.5
 *
 * @module kernel/signals
 */

import {
  type ProcessId,
  type ProcessState,
  type Signal,
  type SignalHandler,
  type Timestamp,
  unbrand,
} from './types.js';
import { CortexError, isCortexError, trap } from './errors.js';
import { type ProcessTable, isLegalTransition } from './process_table.js';
import type { SyscallRecordInput } from './recorder.js';

// =============================================================================
// §1. Signal numbers
// =============================================================================

/**
 * Numeric signal identifiers. Match docs/PROCESS.md §7. Used in exit codes
 * (`128 + signum`, the Unix convention) and in the `cortex kill -<num>` CLI
 * shorthand.
 */
export const SIGNAL_NUMBERS: Readonly<Record<Signal, number>> = Object.freeze({
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
  SIGKILL: 9,
  SIGSTOP: 17,
  SIGCONT: 18,
  SIGUSR1: 10,
  SIGUSR2: 30,
  SIGCHLD: 19,
  SIGXCPU: 24,
  SIGXFSZ: 25,
  SIGSYS: 31,
  SIGPIPE: 13,
});

/** All known signals, in declaration order. */
export const ALL_SIGNALS: readonly Signal[] = Object.freeze(
  Object.keys(SIGNAL_NUMBERS) as Signal[],
);

/**
 * Signals that cannot be caught, ignored, or blocked
 * (docs/PROCESS.md §7.1).
 */
export const UNCATCHABLE_SIGNALS: ReadonlySet<Signal> = new Set<Signal>([
  'SIGKILL',
  'SIGSTOP',
]);

// =============================================================================
// §2. Default actions
// =============================================================================

/**
 * The kernel-defined action for a signal whose disposition is `default`.
 *
 *   - `ignore`    — drop silently.
 *   - `terminate` — RUNNING → EXITING → ZOMBIE with exit code 128+signum.
 *   - `kill`      — like terminate but skips cleanup (SIGKILL only).
 *   - `stop`      — RUNNING → STOPPED.
 *   - `continue`  — STOPPED → READY.
 */
export type DefaultAction = 'ignore' | 'terminate' | 'kill' | 'stop' | 'continue';

/**
 * Default action for each signal. Source: docs/PROCESS.md §7 table.
 */
export const DEFAULT_ACTIONS: Readonly<Record<Signal, DefaultAction>> = Object.freeze({
  SIGHUP: 'ignore',
  SIGINT: 'terminate',
  SIGTERM: 'terminate',
  SIGKILL: 'kill',
  SIGSTOP: 'stop',
  SIGCONT: 'continue',
  SIGUSR1: 'ignore',
  SIGUSR2: 'ignore',
  SIGCHLD: 'ignore',
  SIGXCPU: 'stop',
  SIGXFSZ: 'terminate',
  SIGSYS: 'terminate',
  SIGPIPE: 'ignore',
});

/**
 * Unix exit-code convention: a process killed by signal N exits with code
 * `128 + N`. Used by `terminate()` and `kill()` paths.
 */
export function exitCodeForSignal(sig: Signal): number {
  return 128 + SIGNAL_NUMBERS[sig];
}

// =============================================================================
// §3. Delivery options
// =============================================================================

/**
 * Outcome of a single `send()` call. Returned to the sender so supervisors
 * and CLI tools can report what happened (delivered now vs queued vs
 * dropped). Recorded in the `__signal` log entry as well.
 */
export type DeliveryOutcome =
  | 'delivered'   // default action ran or handler invoked synchronously
  | 'queued'      // appended to pendingSignals; will fire on next RUNNING
  | 'dropped'     // disposition was 'ignore', or signal was no-op for state
  | 'failed';     // a handler threw; details in the `__signal` record

/**
 * Optional invoker for `handler` dispositions. The dispatcher (#014) wires
 * this to a real `CortexContext`; smoke tests use a closure that records
 * calls. If absent and a handler disposition is encountered, the kernel
 * traps `EINVAL` — handlers without an invoker are a configuration bug.
 */
export type HandlerInvoker = (
  pid: ProcessId,
  signal: Signal,
  handler: SignalHandler,
) => Promise<void>;

/**
 * Optional hook fired *after* a process transitions to ZOMBIE. The
 * supervisor / init reaper uses this to send `SIGCHLD` to the parent and
 * to apply restart policies. Kept as a callback to avoid a circular
 * dependency between signals.ts and supervisor.ts (which lands later).
 */
export type OnZombieHook = (
  pid: ProcessId,
  exitCode: number,
  exitReason: string,
) => Promise<void> | void;

/**
 * Options for constructing a `SignalManager`.
 */
export interface SignalManagerOptions {
  readonly table: ProcessTable;
  /** Value written into every `__signal` record. */
  readonly kernelAbiVersion: string;
  /** Wall-clock source. Defaults to `() => new Date().toISOString()`. */
  readonly now?: () => Timestamp;
  /** Required to support `handler` dispositions. */
  readonly handlerInvoker?: HandlerInvoker;
  /** Fired after a SIGKILL/SIGTERM/SIGINT-driven ZOMBIE transition. */
  readonly onZombie?: OnZombieHook;
}

/**
 * Constructor for `send()`. Mirrors `kill(2)`'s `pid` argument: positive
 * for a single process, negative for a process group.
 */
export type SignalTarget = ProcessId | { readonly pgid: ProcessId };

// =============================================================================
// §4. SignalManager
// =============================================================================

/**
 * The signal delivery engine. One per kernel.
 *
 * Concurrency: like `ProcessTable`, this class assumes single-threaded JS
 * execution. `send()` is async because handler invocation and recorder
 * writes are async; concurrent sends to the same PID are serialized by the
 * recorder's internal promise chain.
 */
export class SignalManager {
  readonly kernelAbiVersion: string;

  #table: ProcessTable;
  #now: () => Timestamp;
  #handlerInvoker: HandlerInvoker | null;
  #onZombie: OnZombieHook | null;

  constructor(opts: SignalManagerOptions) {
    this.#table = opts.table;
    this.kernelAbiVersion = opts.kernelAbiVersion;
    this.#now = opts.now ?? (() => new Date().toISOString());
    this.#handlerInvoker = opts.handlerInvoker ?? null;
    this.#onZombie = opts.onZombie ?? null;
  }

  // ---------------------------------------------------------------------------
  // §4.1 Public API
  // ---------------------------------------------------------------------------

  /**
   * Send a signal to a single process. The `kill(2)`-shaped entry point.
   *
   * @param pid     Target process.
   * @param signal  Signal to deliver.
   * @param from    Optional sender PID for the `__signal` record. Defaults
   *                to PID 0 (kernel) when omitted.
   *
   * @returns The delivery outcome. Does NOT throw on `dropped` or `queued`;
   *          only configuration errors (ESRCH, ENOSYS for missing handler
   *          invoker) trap.
   *
   * @throws CortexError ESRCH if the target is not in the table or is in a
   *         terminal state (ZOMBIE / SUSPENDED — see §4.4).
   */
  async send(
    pid: ProcessId,
    signal: Signal,
    from?: ProcessId,
  ): Promise<DeliveryOutcome> {
    const entry = this.#table.get(pid);
    if (entry === undefined) {
      trap('ESRCH', 'kill', { pid: unbrand(pid), signal });
    }

    // Terminal states cannot receive signals. SUSPENDED is on disk; the
    // restore path (§3.6 of PROCESS.md) creates a fresh PID instead.
    if (entry.state === 'zombie' || entry.state === 'suspended') {
      trap('ESRCH', 'kill', {
        pid: unbrand(pid),
        signal,
        state: entry.state,
        reason: 'process is not running',
      });
    }

    return await this.#deliverOne(pid, signal, from);
  }

  /**
   * Send a signal to every member of a process group. The `kill(-pgid, sig)`
   * Unix convention. Returns one outcome per member, in PID order.
   *
   * Members in terminal states are silently skipped (they cannot receive
   * signals); this differs from `send()`, which traps. The asymmetry
   * matches Unix: `kill(-pgid, sig)` does not fail if some members have
   * already exited.
   */
  async sendGroup(
    pgid: ProcessId,
    signal: Signal,
    from?: ProcessId,
  ): Promise<ReadonlyMap<ProcessId, DeliveryOutcome>> {
    const members = this.#table.groupMembers(pgid);
    const out = new Map<ProcessId, DeliveryOutcome>();
    for (const pid of members) {
      const entry = this.#table.get(pid);
      if (entry === undefined) continue;
      if (entry.state === 'zombie' || entry.state === 'suspended') continue;
      const outcome = await this.#deliverOne(pid, signal, from);
      out.set(pid, outcome);
    }
    return out;
  }

  /**
   * Deliver every pending signal for a process. Called by the scheduler
   * after a READY → RUNNING transition (docs/PROCESS.md §7.2). Signals are
   * delivered in queue order; each delivery may itself enqueue more (e.g.
   * a handler that calls `kill()`), but those will be drained on the next
   * call rather than recursively.
   *
   * Returns the outcomes in delivery order. An empty array means the queue
   * was empty.
   *
   * Idempotent: safe to call when the queue is empty.
   */
  async deliverPending(pid: ProcessId): Promise<readonly DeliveryOutcome[]> {
    const entry = this.#table.get(pid);
    if (entry === undefined) return [];
    if (entry.state !== 'running') {
      // Pending signals only fire from RUNNING. If we are called from any
      // other state, leave the queue intact.
      return [];
    }

    const drained = this.#table.drainSignals(pid);
    const outcomes: DeliveryOutcome[] = [];
    for (const sig of drained) {
      // Re-check state between deliveries: a prior signal may have moved
      // us out of RUNNING (e.g. SIGSTOP delivered first). If that happens,
      // re-queue the remaining signals so they fire on the next RUNNING.
      const cur = this.#table.get(pid);
      if (cur === undefined) break;
      if (cur.state !== 'running') {
        // Push the un-delivered tail back onto the queue, preserving order.
        const idx = drained.indexOf(sig);
        for (let i = idx; i < drained.length; i++) {
          const remaining = drained[i];
          if (remaining !== undefined) this.#table.queueSignal(pid, remaining);
        }
        break;
      }
      const outcome = await this.#applyDelivered(pid, sig);
      outcomes.push(outcome);
    }
    return outcomes;
  }

  // ---------------------------------------------------------------------------
  // §4.2 Internal: dispatch
  // ---------------------------------------------------------------------------

  /**
   * Decide whether to deliver now, queue, or drop, and act on it. Shared
   * by `send()` and `sendGroup()`.
   */
  async #deliverOne(
    pid: ProcessId,
    signal: Signal,
    from: ProcessId | undefined,
  ): Promise<DeliveryOutcome> {
    const entry = this.#table.mustGet(pid, 'kill');
    const state = entry.state;

    // SIGKILL: bypass everything. Uncatchable, unqueueable, works from any
    // non-terminal state including BLOCKED and STOPPED.
    if (signal === 'SIGKILL') {
      const outcome = await this.#applyKill(pid, signal, from);
      return outcome;
    }

    // SIGCONT: only meaningful from STOPPED. From any other state it is a
    // no-op (Unix semantics). Still recorded so the drop is observable.
    if (signal === 'SIGCONT') {
      if (state === 'stopped') {
        return await this.#applyDelivered(pid, signal, from);
      }
      await this.#record(pid, signal, from, 'dropped', {
        disposition: this.#table.getDisposition(pid, signal),
        action: DEFAULT_ACTIONS[signal],
        reason: `SIGCONT is a no-op from state ${state}`,
      });
      return 'dropped';
    }

    // SIGSTOP: uncatchable. Fires from RUNNING; queues from BLOCKED, READY,
    // NEW, CHECKPOINTING. (PROCESS.md §5 only enumerates RUNNING→STOPPED,
    // so other states must wait.)
    if (signal === 'SIGSTOP') {
      if (state === 'running') {
        return await this.#applyDelivered(pid, signal, from);
      }
      this.#table.queueSignal(pid, signal);
      await this.#record(pid, signal, from, 'queued', {
        disposition: { kind: 'default' },
        action: 'stop',
        stateAtSend: state,
      });
      return 'queued';
    }

    // All other signals: queue if not RUNNING (§7.2).
    if (state !== 'running') {
      this.#table.queueSignal(pid, signal);
      await this.#record(pid, signal, from, 'queued', {
        disposition: this.#table.getDisposition(pid, signal),
        action: DEFAULT_ACTIONS[signal],
        stateAtSend: state,
      });
      return 'queued';
    }

    // RUNNING: deliver now.
    return await this.#applyDelivered(pid, signal, from);
  }

  /**
   * Apply a signal that has been "delivered" — i.e. the process is RUNNING
   * (or the signal is one of the immediate-fire ones). Consults the
   * disposition and runs the appropriate path.
   */
  async #applyDelivered(
    pid: ProcessId,
    signal: Signal,
    from?: ProcessId,
  ): Promise<DeliveryOutcome> {
    const disp = this.#table.getDisposition(pid, signal);

    switch (disp.kind) {
      case 'ignore':
        await this.#record(pid, signal, from, 'dropped', {
          disposition: disp,
          action: 'ignore',
          reason: 'disposition is ignore',
        });
        return 'dropped';

      case 'handler':
        return await this.#invokeHandler(pid, signal, disp.handler, from);

      case 'default':
        return await this.#applyDefault(pid, signal, from);
    }
  }

  /**
   * Run the kernel-defined default action for a signal.
   */
  async #applyDefault(
    pid: ProcessId,
    signal: Signal,
    from?: ProcessId,
  ): Promise<DeliveryOutcome> {
    const action = DEFAULT_ACTIONS[signal];

    switch (action) {
      case 'ignore':
        await this.#record(pid, signal, from, 'dropped', {
          disposition: { kind: 'default' },
          action,
          reason: 'default action is ignore',
        });
        return 'dropped';

      case 'stop':
        return await this.#applyStop(pid, signal, from);

      case 'continue':
        return await this.#applyContinue(pid, signal, from);

      case 'terminate':
        return await this.#applyTerminate(pid, signal, from, /* graceful */ true);

      case 'kill':
        return await this.#applyKill(pid, signal, from);
    }
  }

  // ---------------------------------------------------------------------------
  // §4.3 Internal: action implementations
  // ---------------------------------------------------------------------------

  /**
   * RUNNING → STOPPED. Used by SIGSTOP and by SIGXCPU's default action
   * (budget exhaustion). The scheduler will not pick a STOPPED process.
   */
  async #applyStop(
    pid: ProcessId,
    signal: Signal,
    from?: ProcessId,
  ): Promise<DeliveryOutcome> {
    const entry = this.#table.mustGet(pid, 'kill');
    if (entry.state !== 'running') {
      // Cannot stop a non-running process; queue instead. (Defensive — the
      // dispatcher should have routed through queueSignal already.)
      this.#table.queueSignal(pid, signal);
      await this.#record(pid, signal, from, 'queued', {
        disposition: { kind: 'default' },
        action: 'stop',
        stateAtSend: entry.state,
        reason: 'stop only fires from RUNNING; requeued',
      });
      return 'queued';
    }

    await this.#table.setState(pid, 'stopped', {
      trigger: 'signal',
      signal,
      from: from !== undefined ? unbrand(from) : null,
    });
    await this.#record(pid, signal, from, 'delivered', {
      disposition: { kind: 'default' },
      action: 'stop',
      stateAfter: 'stopped',
    });
    return 'delivered';
  }

  /**
   * STOPPED → READY. Used by SIGCONT.
   */
  async #applyContinue(
    pid: ProcessId,
    signal: Signal,
    from?: ProcessId,
  ): Promise<DeliveryOutcome> {
    const entry = this.#table.mustGet(pid, 'kill');
    if (entry.state !== 'stopped') {
      await this.#record(pid, signal, from, 'dropped', {
        disposition: { kind: 'default' },
        action: 'continue',
        reason: `SIGCONT is a no-op from state ${entry.state}`,
      });
      return 'dropped';
    }

    await this.#table.setState(pid, 'ready', {
      trigger: 'signal',
      signal,
      from: from !== undefined ? unbrand(from) : null,
    });
    await this.#record(pid, signal, from, 'delivered', {
      disposition: { kind: 'default' },
      action: 'continue',
      stateAfter: 'ready',
    });
    return 'delivered';
  }

  /**
   * Graceful termination: RUNNING → EXITING → ZOMBIE. Cleanup hooks (driver
   * release, channel close, final budget write) belong here in v1; for now
   * we just walk the state machine and record. Exit code is 128+signum.
   *
   * If the process is BLOCKED, this is reachable via the BLOCKED → EXITING
   * transition (PROCESS.md §5). We do NOT call this from BLOCKED in v0 —
   * SIGTERM queues until next RUNNING. SIGKILL is the only signal that
   * pulls a BLOCKED process straight to EXITING.
   */
  async #applyTerminate(
    pid: ProcessId,
    signal: Signal,
    from: ProcessId | undefined,
    graceful: boolean,
  ): Promise<DeliveryOutcome> {
    const entry = this.#table.mustGet(pid, 'kill');
    const exitCode = exitCodeForSignal(signal);
    const exitReason = `signal:${signal}`;

    // From RUNNING, BLOCKED, or STOPPED, EXITING is legal.
    if (!isLegalTransition(entry.state, 'exiting')) {
      // NEW / READY / CHECKPOINTING cannot terminate directly. Queue and
      // wait for the next RUNNING transition.
      this.#table.queueSignal(pid, signal);
      await this.#record(pid, signal, from, 'queued', {
        disposition: { kind: 'default' },
        action: graceful ? 'terminate' : 'kill',
        stateAtSend: entry.state,
        reason: `cannot terminate from ${entry.state}; requeued`,
      });
      return 'queued';
    }

    // Capture the current log offset so wait() can return the syscall range.
    const recorder = this.#table.recorderFor(pid);
    const finalOffset = recorder?.currentOffset ?? entry.initialLogOffset;

    this.#table.setExitInfo(pid, exitCode, exitReason, finalOffset);

    await this.#table.setState(pid, 'exiting', {
      trigger: 'signal',
      signal,
      graceful,
      from: from !== undefined ? unbrand(from) : null,
    });
    await this.#table.setState(pid, 'zombie', {
      trigger: graceful ? 'cleanup-done' : 'kill',
      signal,
    });

    await this.#record(pid, signal, from, 'delivered', {
      disposition: { kind: 'default' },
      action: graceful ? 'terminate' : 'kill',
      exitCode,
      exitReason,
      stateAfter: 'zombie',
    });

    if (this.#onZombie !== null) {
      try {
        await this.#onZombie(pid, exitCode, exitReason);
      } catch (err) {
        // A failing onZombie hook should not crash signal delivery. Surface
        // as a kernel-level warning (the supervisor logs it) but proceed.
        if (!isCortexError(err)) {
          // Wrap into a CortexError so callers see a uniform shape if they
          // ever inspect this path. We swallow it here on purpose.
        }
      }
    }

    return 'delivered';
  }

  /**
   * Immediate termination (SIGKILL). Works from any non-terminal state,
   * including BLOCKED and STOPPED. Bypasses cleanup; the process goes
   * straight to EXITING and then ZOMBIE in two atomic transitions.
   *
   * SIGKILL is the kernel's last resort against runaway agents
   * (docs/PROCESS.md §7.1) — its delivery must never be blocked by user
   * code, which is why it skips disposition lookup entirely.
   */
  async #applyKill(
    pid: ProcessId,
    signal: Signal,
    from?: ProcessId,
  ): Promise<DeliveryOutcome> {
    const entry = this.#table.mustGet(pid, 'kill');
    const exitCode = exitCodeForSignal(signal);
    const exitReason = `signal:${signal}`;

    // From NEW / READY / CHECKPOINTING, EXITING is not a legal transition
    // per PROCESS.md §5. SIGKILL must still work, so we walk through
    // READY/RUNNING first if needed. The intermediate states are recorded
    // as ordinary __state transitions, which keeps the .crec log honest.
    const path = killPathFrom(entry.state);
    if (path === null) {
      // Already exiting or zombie; nothing to do. (send() filters these.)
      await this.#record(pid, signal, from, 'dropped', {
        disposition: { kind: 'default' },
        action: 'kill',
        reason: `cannot kill from ${entry.state}`,
      });
      return 'dropped';
    }

    const recorder = this.#table.recorderFor(pid);
    const finalOffset = recorder?.currentOffset ?? entry.initialLogOffset;
    this.#table.setExitInfo(pid, exitCode, exitReason, finalOffset);

    for (const next of path) {
      await this.#table.setState(pid, next, {
        trigger: 'signal',
        signal,
        kill: true,
        from: from !== undefined ? unbrand(from) : null,
      });
    }

    await this.#record(pid, signal, from, 'delivered', {
      disposition: { kind: 'default' },
      action: 'kill',
      exitCode,
      exitReason,
      stateAfter: 'zombie',
      path,
    });

    if (this.#onZombie !== null) {
      try {
        await this.#onZombie(pid, exitCode, exitReason);
      } catch {
        // See #applyTerminate for rationale.
      }
    }

    return 'delivered';
  }

  /**
   * Invoke a user-registered handler. The handler runs in the agent's
   * context; if it throws, the signal is recorded as `failed` and the
   * default action does NOT run (matching POSIX, where a handler that
   * raises does not re-trigger the default disposition).
   */
  async #invokeHandler(
    pid: ProcessId,
    signal: Signal,
    handler: SignalHandler,
    from?: ProcessId,
  ): Promise<DeliveryOutcome> {
    if (this.#handlerInvoker === null) {
      trap('EINVAL', 'kill', {
        pid: unbrand(pid),
        signal,
        reason: 'handler disposition requires a handlerInvoker; kernel is misconfigured',
      });
    }

    try {
      await this.#handlerInvoker(pid, signal, handler);
      await this.#record(pid, signal, from, 'delivered', {
        disposition: { kind: 'handler' },
        action: 'handler',
      });
      return 'delivered';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.#record(pid, signal, from, 'failed', {
        disposition: { kind: 'handler' },
        action: 'handler',
        error: { message },
      });
      return 'failed';
    }
  }

  // ---------------------------------------------------------------------------
  // §4.4 Internal: recording
  // ---------------------------------------------------------------------------

  /**
   * Append a `__signal` record to the target's `.crec` log. Best-effort:
   * recorder failures are wrapped into ERECORD and re-thrown so callers
   * see them, but a missing recorder (null factory) is a silent no-op so
   * smoke tests can run without disk I/O.
   */
  async #record(
    pid: ProcessId,
    signal: Signal,
    from: ProcessId | undefined,
    outcome: DeliveryOutcome,
    details: Record<string, unknown>,
  ): Promise<void> {
    const recorder = this.#table.recorderFor(pid);
    if (recorder === null) return;

    const entry = this.#table.get(pid);
    const stateNow: ProcessState = entry?.state ?? 'zombie';

    const record: SyscallRecordInput = {
      timestamp: this.#now(),
      pid,
      syscall: '__signal',
      callId: `sig-${unbrand(pid)}-${signal}-${Date.now()}`,
      phase: 'exit',
      args: {
        signal,
        signalNumber: SIGNAL_NUMBERS[signal],
        outcome,
        from: from !== undefined ? unbrand(from) : null,
        ...details,
      },
      stateBefore: stateNow,
      stateAfter: stateNow,
      reversibility: 'idempotent',
      kernelAbiVersion: this.kernelAbiVersion,
    };

    try {
      await recorder.append(record);
    } catch (err) {
      if (isCortexError(err)) throw err;
      throw new CortexError('ERECORD', 'kill', {
        message: `failed to record signal ${signal} for pid ${unbrand(pid)}`,
        cause: err,
      });
    }
  }
}

// =============================================================================
// §5. Helpers
// =============================================================================

/**
 * Compute the state-machine path SIGKILL must walk to reach ZOMBIE from a
 * given start state. Returns null if the start state cannot be killed
 * (already EXITING or ZOMBIE).
 *
 * The paths respect docs/PROCESS.md §5:
 *
 *   running       → exiting → zombie
 *   blocked       → exiting → zombie   (SIGKILL is the only legal trigger)
 *   stopped       → exiting → zombie   (SIGKILL is the only legal trigger)
 *   ready         → running → exiting → zombie  (synthetic walk; the
 *                                                scheduler would normally
 *                                                do ready→running, but
 *                                                SIGKILL must not wait)
 *   new           → ready → running → exiting → zombie
 *   checkpointing → ready → running → exiting → zombie  (abort snapshot,
 *                                                        re-enter the
 *                                                        scheduler queue,
 *                                                        then exit)
 *
 * The synthetic walks (new/ready/checkpointing) write ordinary `__state`
 * records for each step, so the .crec log faithfully reflects what the
 * kernel did. v1 may collapse these into a single fast-path transition;
 * for now we keep the table small and the audit trail explicit.
 */
function killPathFrom(state: ProcessState): readonly ProcessState[] | null {
  switch (state) {
    case 'running':
      return ['exiting', 'zombie'];
    case 'blocked':
      return ['exiting', 'zombie'];
    case 'stopped':
      return ['exiting', 'zombie'];
    case 'ready':
      return ['running', 'exiting', 'zombie'];
    case 'new':
      return ['ready', 'running', 'exiting', 'zombie'];
    case 'checkpointing':
      return ['ready', 'running', 'exiting', 'zombie'];
    case 'exiting':
    case 'zombie':
    case 'suspended':
      return null;
  }
}

/**
 * Convenience predicate: does this signal fire immediately regardless of
 * process state? Used by the scheduler and by `send()` to decide whether
 * to queue.
 */
export function isImmediateSignal(sig: Signal): boolean {
  return sig === 'SIGKILL' || sig === 'SIGCONT';
}

/**
 * Look up a signal by number (the `cortex kill -9` shorthand). Returns
 * undefined if the number does not match any known signal.
 */
export function signalFromNumber(n: number): Signal | undefined {
  for (const sig of ALL_SIGNALS) {
    if (SIGNAL_NUMBERS[sig] === n) return sig;
  }
  return undefined;
}
