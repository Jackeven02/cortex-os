/**
 * cortex kernel — scheduler.
 *
 * Implements the v0 scheduler described in docs/PROCESS.md §8 and the
 * `Scheduler` interface sketched in docs/ARCHITECTURE.md §4.8. The scheduler
 * decides *which* READY process runs next, moves processes between READY and
 * RUNNING, and enforces the budget system (the kernel's only "preemption"
 * mechanism).
 *
 * ## Algorithm (docs/PROCESS.md §8.1)
 *
 * Round-robin over READY processes, weighted by `nice` (-20..19, lower =
 * higher priority), FIFO tiebreak by enqueue order:
 *
 *   candidates = processes in READY whose budgets are not exhausted
 *   pick the highest-priority candidate (lowest nice, earliest enqueue)
 *   dispatch to RUNNING
 *
 * A process whose budget is already exhausted at selection time is **not** a
 * candidate (§8.1). It stays in the run queue, parked, until the supervisor
 * tops its budget up via `setBudget()` — at which point the next tick picks it
 * up again. The scheduler never silently drops an exhausted process; it just
 * refuses to spend on it.
 *
 * ## Cooperative, not preemptive (§8.2)
 *
 * cortex does not interrupt a running syscall. The scheduler hands the CPU to
 * a process by `await`-ing its injected continuation (`resume`); that
 * continuation runs until the agent yields (returns from a quantum) or blocks
 * (awaits an external event). Only then does control come back to `tick()`.
 * The single exception is the budget system: if a counter hit zero during the
 * quantum, the scheduler fires `SIGXCPU` (default disposition: STOPPED)
 * *instead of* returning the process to READY (§8.3, ARCHITECTURE §4.8 step 5).
 *
 * ## Waking and re-queueing
 *
 * Transitions into READY happen in several places the scheduler does not
 * control: `fork()` lands a child in READY, `SIGCONT` moves STOPPED → READY,
 * and an IPC/tool wake moves BLOCKED → READY. Rather than wire every one of
 * those call sites to `enqueue()`, each `tick()` first calls `reconcile()`,
 * which adopts any READY process the table knows about that is not already
 * queued. This keeps the run queue self-healing in v0; a production kernel
 * (#014/#021) may push wake events directly and skip the scan.
 *
 * ## Recording
 *
 * State transitions (READY → RUNNING → READY/BLOCKED/STOPPED) are recorded by
 * `process_table.setState()` as `__state`; `SIGXCPU` delivery is recorded by
 * `signals.ts` as `__signal`. On top of those, the scheduler writes a concise
 * `__sched` record per dispatch capturing the *decision* (which process, what
 * outcome, which budget kind fired) so a replay engine can reconstruct
 * scheduling order without re-deriving it from interleaved `__state` records.
 * Idle ticks are not recorded (they would dominate the log).
 *
 * See: docs/PROCESS.md §8; docs/ARCHITECTURE.md §4.8; docs/STATE.md §2.4
 *
 * @module kernel/scheduler
 */

import {
  type BudgetLimits,
  type ProcessId,
  type ProcessState,
  type Timestamp,
  unbrand,
} from './types.js';
import { CortexError, isCortexError } from './errors.js';
import { PID_KERNEL, type ProcessTable } from './process_table.js';
import type { SignalManager } from './signals.js';
import type { SyscallRecordInput } from './recorder.js';

// =============================================================================
// §1. Constants and types
// =============================================================================

/**
 * Delay (ms) the auto-loop waits when a tick found nothing to dispatch. Keeps
 * an idle kernel from busy-spinning the Node event loop (docs/PROCESS.md §8.1:
 * "if candidates is empty: sleep until next wake event").
 */
export const DEFAULT_IDLE_DELAY_MS = 10;

/**
 * Delay (ms) before the next tick when the previous tick *did* dispatch work.
 * Zero yields to the event loop (so I/O and timers progress) without an
 * artificial pause between quanta.
 */
export const DEFAULT_BUSY_DELAY_MS = 0;

/**
 * The continuation runner. Represents "run this process's agent until it next
 * yields or blocks." In the full kernel this is wired to the syscall
 * dispatcher (#014): every syscall returns a Promise the kernel controls, and
 * the agent's `await` resumes when the scheduler decides. For v0 — and for
 * smoke tests — it is injectable; the default is a no-op (the process yields
 * immediately).
 *
 * The continuation is responsible for its own state transitions *into* BLOCKED
 * (via `setState` + `setBlockedOn`) when it awaits an external event. If it
 * simply returns, the scheduler treats that as a yield and re-queues the
 * process in READY.
 */
export type ResumeFn = (pid: ProcessId) => Promise<void>;

/**
 * Why a dispatched process gave up the CPU. Reported by `tick()` for
 * observability and testing.
 *
 *   - `yielded`  — continuation returned; process went back to READY and was
 *                  re-queued (round-robin).
 *   - `blocked`  — continuation parked the process in BLOCKED; not re-queued
 *                  (a future wake re-queues it).
 *   - `sigxcpu`  — a budget was exhausted; `SIGXCPU` fired (default: STOPPED).
 *                  The process is *not* re-queued.
 *   - `signal`   — a pending signal delivered on dispatch (e.g. a queued
 *                  SIGSTOP/SIGTERM) moved the process out of RUNNING before it
 *                  could run. Not re-queued.
 *   - `exited`   — the process is gone (EXITING/ZOMBIE/reaped) after its
 *                  quantum. Not re-queued.
 *   - `detached` — the process ended in STOPPED / SUSPENDED / CHECKPOINTING;
 *                  left in that state, not re-queued.
 *   - `parked`  — the continuation is still live but suspended on something the
 *                 kernel owes it (a `wait()`/`recv()` wake, a driver call, a
 *                 timer). The process stays RUNNING and is NOT re-queued:
 *                 re-queueing would re-enter its agent body mid-`await`. It is
 *                 resumed by releasing the wake on a later dispatch, or it
 *                 drives its own exit when the body finally settles.
 */
export type DispatchReason =
  | 'yielded'
  | 'blocked'
  | 'sigxcpu'
  | 'signal'
  | 'exited'
  | 'detached'
  | 'parked';

/**
 * Outcome of a single `tick()`. Either nothing was runnable (`dispatched:
 * null`) or exactly one process was dispatched and ran a quantum.
 */
export type TickOutcome =
  | { readonly dispatched: null; readonly reason: 'idle' }
  | { readonly dispatched: ProcessId; readonly reason: DispatchReason };

/**
 * Options for constructing a `Scheduler`.
 */
export interface SchedulerOptions {
  /** The authoritative process registry. */
  readonly table: ProcessTable;
  /**
   * Signal engine. Used to deliver pending signals on dispatch
   * (`deliverPending`) and to fire `SIGXCPU` on budget exhaustion. Required:
   * budget enforcement is meaningless without a way to stop the process.
   */
  readonly signals: SignalManager;
  /** Value written into every `__sched` record. */
  readonly kernelAbiVersion: string;
  /**
   * The continuation runner (see `ResumeFn`). Defaults to a no-op, which makes
   * every dispatched process yield immediately — useful for pure
   * scheduling-order tests.
   */
  readonly resume?: ResumeFn;
  /** Wall-clock source. Defaults to `() => new Date().toISOString()`. */
  readonly now?: () => Timestamp;
  /** Auto-loop idle delay. Defaults to `DEFAULT_IDLE_DELAY_MS`. */
  readonly idleDelayMs?: number;
  /** Auto-loop busy delay. Defaults to `DEFAULT_BUSY_DELAY_MS`. */
  readonly busyDelayMs?: number;
  /**
   * Timer injection for deterministic tests of the auto-loop. Defaults to the
   * global `setTimeout` / `clearTimeout`.
   */
  readonly setTimeoutFn?: (cb: () => void, ms: number) => TimerHandle;
  readonly clearTimeoutFn?: (handle: TimerHandle) => void;
  /**
   * Optional hook fired when a tick finds nothing runnable. The supervisor
   * uses it to log starvation warnings (docs/PROCESS.md §3.3: "a ready process
   * waiting too long triggers SIGXCPU to the supervisor").
   */
  readonly onIdle?: () => void;
  /**
   * Whether each `tick()` first calls `reconcile()` to adopt READY processes
   * the table knows about. docs/PROCESS.md §8.1 defines the candidate set by
   * *scanning the table* for READY processes, so this is the faithful default
   * (`true`) and is what makes fork children / SIGCONT resumes / BLOCKED wakes
   * schedulable without wiring every transition site to `enqueue()`. Set
   * `false` to drive the run queue purely through explicit `enqueue()` /
   * `dequeue()` — useful for tests of the queue API and for a future push-based
   * wake path.
   */
  readonly autoReconcile?: boolean;
  /**
   * "Is this process's continuation still live?" — i.e. has its agent body been
   * started and not yet finished?
   *
   * Needed once the continuation is cooperative (see boot.ts, "The execution
   * model"): `resume` returns as soon as the body hits its first suspension
   * point, so from the scheduler's point of view a dispatched process looks
   * like it merely yielded. Re-queueing it (the `yielded` path) would dispatch
   * it again while its body is still mid-`await`, and the kernel must not run
   * two copies of one agent.
   *
   * When this predicate answers `true` for a still-RUNNING process, the
   * scheduler instead reports `parked`: it leaves the process in RUNNING and
   * drops it from the run queue. It becomes schedulable again the moment the
   * kernel wakes it (BLOCKED → READY) or its body drives its own exit.
   *
   * Defaults to `null` (no cooperative bodies — every `resume` runs to
   * completion, the pre-rework behaviour).
   */
  readonly isLive?: (pid: ProcessId) => boolean;
}

/** Opaque timer handle (matches both Node's `Timeout` and the browser's number). */
export type TimerHandle = unknown;

// =============================================================================
// §2. Run-queue node
// =============================================================================

/**
 * One entry in the run queue. `nice` is read live from the table at selection
 * time (so a future `renice` is honoured without re-queueing); only `seq` — the
 * FIFO tiebreak — is stored here.
 */
interface QueueNode {
  readonly pid: ProcessId;
  readonly seq: number;
}

/**
 * States that mean "this process is being handled elsewhere / is done"; a run
 * queue entry pointing at one of these is stale and dropped on the next scan.
 * READY and NEW are kept (NEW will become READY; READY-exhausted may become
 * schedulable after `setBudget`).
 */
const NON_QUEUEABLE: ReadonlySet<ProcessState> = new Set<ProcessState>([
  'running',
  'blocked',
  'stopped',
  'checkpointing',
  'suspended',
  'exiting',
  'zombie',
]);

// =============================================================================
// §3. Scheduler
// =============================================================================

/**
 * The v0 round-robin scheduler. One instance per kernel.
 *
 * Concurrency: like `ProcessTable` and `SignalManager`, this class assumes
 * single-threaded JS. `tick()` is async (it awaits state recording and the
 * continuation), but the auto-loop never overlaps two ticks — it awaits one
 * before scheduling the next. Manual callers should likewise avoid concurrent
 * `tick()`s.
 */
export class Scheduler {
  readonly kernelAbiVersion: string;

  #table: ProcessTable;
  #signals: SignalManager;
  #resume: ResumeFn;
  #now: () => Timestamp;
  #idleDelayMs: number;
  #busyDelayMs: number;
  #setTimeoutFn: (cb: () => void, ms: number) => TimerHandle;
  #clearTimeoutFn: (handle: TimerHandle) => void;
  #onIdle: (() => void) | null;
  #autoReconcile: boolean;
  #isLive: ((pid: ProcessId) => boolean) | null;

  /** The run queue. Unsorted array; selection does a linear min-scan (§4). */
  #queue: QueueNode[] = [];
  /**
   * Membership mirror of `#queue` for O(1) idempotent enqueue.
   *
   * It must be kept *exactly* in step with `#queue`. Every removal path has to
   * clear both: a PID left behind here makes `enqueue()` a silent no-op, and
   * since `reconcile()` also defers to it, the process can then never re-enter
   * the run queue — it sits READY forever, dispatched by nobody. That is not
   * hypothetical: a cooperative agent body is enqueued when the kernel wakes it
   * and can block again on a later `wait()`, which leaves exactly such a stale
   * node behind (see `#selectNext`).
   */
  #queued = new Set<number>();
  /** Monotonic FIFO counter for tie-breaking equal-nice processes. */
  #seqCounter = 0;

  #started = false;
  #timer: TimerHandle | null = null;
  #inFlight: Promise<TickOutcome> | null = null;

  constructor(opts: SchedulerOptions) {
    this.#table = opts.table;
    this.#signals = opts.signals;
    this.kernelAbiVersion = opts.kernelAbiVersion;
    this.#resume = opts.resume ?? (async () => {});
    this.#now = opts.now ?? (() => new Date().toISOString());
    this.#idleDelayMs = opts.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS;
    this.#busyDelayMs = opts.busyDelayMs ?? DEFAULT_BUSY_DELAY_MS;
    this.#setTimeoutFn =
      opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms) as unknown as TimerHandle);
    this.#clearTimeoutFn =
      opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.#onIdle = opts.onIdle ?? null;
    this.#autoReconcile = opts.autoReconcile ?? true;
    this.#isLive = opts.isLive ?? null;
  }

  // ---------------------------------------------------------------------------
  // §3.1 Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Begin scheduling. Starts a self-scheduling loop that calls `tick()`
   * repeatedly: back-to-back (modulo `busyDelayMs`) while there is work, and
   * backed off to `idleDelayMs` when the run queue is empty. Idempotent.
   *
   * This *is* "the event loop" of ARCHITECTURE §4.8 in v0 — there is no
   * separate driver. Callers may also drive the kernel manually by invoking
   * `tick()` directly without calling `start()` (the smoke tests do this).
   */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#scheduleLoop(this.#idleDelayMs);
  }

  /**
   * Stop scheduling. Clears any pending loop timer and awaits an in-flight
   * tick so the kernel reaches a quiescent state. Idempotent. Does NOT touch
   * running processes — a process mid-quantum finishes its continuation, then
   * the loop declines to schedule another tick.
   */
  async stop(): Promise<void> {
    this.#started = false;
    if (this.#timer !== null) {
      this.#clearTimeoutFn(this.#timer);
      this.#timer = null;
    }
    if (this.#inFlight !== null) {
      await this.#inFlight.catch(() => {});
      this.#inFlight = null;
    }
  }

  /** Whether the auto-loop is currently running. */
  get running(): boolean {
    return this.#started;
  }

  // ---------------------------------------------------------------------------
  // §3.2 Run-queue management
  // ---------------------------------------------------------------------------

  /**
   * Mark a process runnable. Called by the kernel whenever a process enters
   * READY (wake, SIGCONT, fork) — though `reconcile()` also catches these, so
   * external callers may rely on either path. Idempotent: enqueueing an
   * already-queued PID is a no-op (it does not bump its FIFO position).
   *
   * Does not validate state; `tick()` re-checks that the process is genuinely
   * READY before dispatching (it may have been killed between enqueue and
   * tick). Enqueueing a non-READY process is harmless — it is dropped on the
   * next scan.
   */
  enqueue(pid: ProcessId): void {
    const key = unbrand(pid);
    if (this.#queued.has(key)) return;
    this.#queued.add(key);
    this.#queue.push({ pid, seq: this.#seqCounter++ });
  }

  /**
   * Remove a process from the run queue without running it. Called when a
   * READY process is moved out of READY by an external event (SIGKILL, an
   * explicit checkpoint, etc.). Idempotent: dequeueing an absent PID is a
   * no-op.
   */
  dequeue(pid: ProcessId): void {
    const key = unbrand(pid);
    if (!this.#queued.has(key)) return;
    this.#queued.delete(key);
    const idx = this.#queue.findIndex((n) => unbrand(n.pid) === key);
    if (idx >= 0) this.#queue.splice(idx, 1);
  }

  /** Whether a PID is currently in the run queue. */
  isQueued(pid: ProcessId): boolean {
    return this.#queued.has(unbrand(pid));
  }

  /** Number of entries in the run queue (includes parked/exhausted ones). */
  get queueLength(): number {
    return this.#queue.length;
  }

  /**
   * Adopt any READY process the table knows about that is not already queued.
   * This is how the scheduler picks up fork children, SIGCONT-resumed
   * processes, and BLOCKED → READY wakes without each of those call sites
   * having to call `enqueue()` directly. Called at the top of every `tick()`;
   * also exposed so a supervisor can force a reconcile.
   *
   * O(n) over the table. Acceptable in v0 because most processes are BLOCKED
   * (docs/PROCESS.md §8.4) and thus not READY; a push-based wake path is the
   * future optimisation.
   */
  reconcile(): void {
    for (const pid of this.#table.pids()) {
      const entry = this.#table.get(pid);
      if (entry === undefined) continue;
      if (entry.state !== 'ready') continue;
      this.enqueue(pid);
    }
  }

  /**
   * Set a process's remaining budgets and, if it is parked READY (e.g. it had
   * been exhausted), make it schedulable again on the next tick. This is the
   * supervisor's recovery path from `SIGXCPU` (docs/PROCESS.md §8.3:
   * "increase budget, terminate, fork a fresh attempt").
   *
   * @throws CortexError ESRCH if the PID is absent (propagated from the table).
   */
  setBudget(pid: ProcessId, limits: BudgetLimits): void {
    this.#table.setBudgets(pid, { remaining: limits });
    // If the process is READY again and somehow not queued, adopt it so the
    // top-up takes effect without waiting for an external enqueue.
    const entry = this.#table.get(pid);
    if (entry !== undefined && entry.state === 'ready') {
      this.enqueue(pid);
    }
  }

  // ---------------------------------------------------------------------------
  // §3.3 The tick
  // ---------------------------------------------------------------------------

  /**
   * Run one scheduling quantum: reconcile the run queue, pick the
   * highest-priority runnable candidate, dispatch it to RUNNING, deliver any
   * pending signals, run its continuation, then move it back to READY (or
   * leave it BLOCKED / fire SIGXCPU). Dispatches **at most one** process per
   * call.
   *
   * ARCHITECTURE §4.8 sketches `tick(): Promise<void>`; we widen the return to
   * a `TickOutcome` so callers (and smoke tests) can observe the decision
   * without re-reading the table. The extra return value is additive — a
   * `Promise<void>` consumer can ignore it. (Doc-fix candidate for §4.8.)
   *
   * @returns The dispatch decision. `dispatched: null` means nothing was
   *          runnable this tick.
   */
  async tick(): Promise<TickOutcome> {
    if (this.#autoReconcile) this.reconcile();

    const pid = this.#selectNext();
    if (pid === null) {
      if (this.#onIdle !== null) this.#onIdle();
      return { dispatched: null, reason: 'idle' };
    }

    // READY → RUNNING (recorded as __state by the table).
    await this.#table.setState(pid, 'running', { trigger: 'scheduler-dispatch' });

    // Deliver signals queued while the process was not RUNNING (§7.2). A queued
    // SIGSTOP/SIGTERM/SIGKILL may move it straight back out of RUNNING.
    await this.#signals.deliverPending(pid);

    let entry = this.#table.get(pid);
    if (entry === undefined) {
      await this.#recordSched(pid, 'exited', { reason: 'vanished-after-dispatch' });
      return { dispatched: pid, reason: 'exited' };
    }
    if (entry.state !== 'running') {
      // A pending signal pre-empted the quantum. Leave the process wherever
      // the signal put it; do not resume, do not re-queue.
      await this.#recordSched(pid, 'signal', { stateAfter: entry.state });
      return { dispatched: pid, reason: 'signal' };
    }

    // Budget gate *before* running: §8.1 excludes exhausted processes from the
    // candidate set. #selectNext already skipped budget-exhausted READY
    // processes, so reaching here means the budget was OK a moment ago. We
    // re-check defensively (a concurrent setBudget(…,0) could have landed).
    let budget = this.#table.checkBudget(pid);
    if (budget !== 'ok') {
      await this.#fireSigxcpu(pid, budget.kind, 'pre-dispatch');
      return { dispatched: pid, reason: 'sigxcpu' };
    }

    // --- Run the quantum (cooperative: this await is the CPU hand-off). ---
    await this.#resume(pid);

    entry = this.#table.get(pid);
    if (entry === undefined) {
      await this.#recordSched(pid, 'exited', { reason: 'reaped-during-quantum' });
      return { dispatched: pid, reason: 'exited' };
    }

    const state: ProcessState = entry.state;
    budget = this.#table.checkBudget(pid);

    if (state === 'running') {
      // The continuation returned with the process still runnable: it yielded.
      if (budget !== 'ok') {
        // §8.3 / ARCHITECTURE §4.8 step 5: budget hit zero during the quantum →
        // SIGXCPU instead of returning to READY. Default disposition STOPs it.
        await this.#fireSigxcpu(pid, budget.kind, 'post-quantum');
        return { dispatched: pid, reason: 'sigxcpu' };
      }
      // A cooperative continuation that has not finished: it is suspended on a
      // kernel wake, a driver call, or a timer. Leaving it RUNNING (and out of
      // the run queue) is the "resume the Promise" half of the contract — it is
      // re-adopted when the kernel wakes it, or it exits on its own.
      if (this.#isLive !== null && this.#isLive(pid)) {
        await this.#recordSched(pid, 'parked', {
          nice: entry.nice,
          blockedOn: entry.blockedOn ?? null,
        });
        return { dispatched: pid, reason: 'parked' };
      }

      // RUNNING → READY, re-queued at the back of its nice band (round-robin).
      await this.#table.setState(pid, 'ready', { trigger: 'scheduler-yield' });
      this.enqueue(pid);
      await this.#recordSched(pid, 'yielded', { nice: entry.nice });
      return { dispatched: pid, reason: 'yielded' };
    }

    if (state === 'blocked') {
      // Parked awaiting an external event. Not re-queued; a future wake moves
      // it BLOCKED → READY and reconcile() re-adopts it. Budget exhaustion is
      // deferred to the next dispatch (§8.1 handles it then).
      await this.#recordSched(pid, 'blocked', {
        blockedOn: entry.blockedOn,
      });
      return { dispatched: pid, reason: 'blocked' };
    }

    // exiting / zombie / stopped / suspended / checkpointing: the continuation
    // (or a signal) moved it out of the schedulable set. Leave it as-is.
    const reason: DispatchReason = state === 'exiting' || state === 'zombie' ? 'exited' : 'detached';
    await this.#recordSched(pid, reason, { stateAfter: state });
    return { dispatched: pid, reason };
  }

  // ---------------------------------------------------------------------------
  // §3.4 Auto-loop
  // ---------------------------------------------------------------------------

  #scheduleLoop(delay: number): void {
    if (!this.#started) return;
    this.#timer = this.#setTimeoutFn(() => {
      void this.#loopOnce();
    }, delay);
  }

  async #loopOnce(): Promise<void> {
    this.#timer = null;
    if (!this.#started) return;
    let outcome: TickOutcome = { dispatched: null, reason: 'idle' };
    try {
      this.#inFlight = this.tick();
      outcome = await this.#inFlight;
    } catch (err) {
      // A throwing tick must not kill the loop. Surface via onIdle-less path:
      // we swallow non-Cortex errors here (the recorder/signal layers already
      // wrapped them) and keep scheduling. CortexErrors are re-thrown only in
      // manual tick() usage; the loop degrades gracefully.
      if (isCortexError(err) || err instanceof Error) {
        // Best-effort: nothing to do but continue. Kept explicit so the catch
        // is not empty (lint) and so a future kernel-log hook has a seam.
      }
    } finally {
      this.#inFlight = null;
    }
    if (!this.#started) return;
    const delay = outcome.dispatched === null ? this.#idleDelayMs : this.#busyDelayMs;
    this.#scheduleLoop(delay);
  }

  // ---------------------------------------------------------------------------
  // §3.5 Internal: selection
  // ---------------------------------------------------------------------------

  /**
   * Pick the next process to run and remove it from the queue.
   *
   * Linear min-scan over the run queue (v0-simple; a binary heap keyed by
   * `(nice, seq)` is the documented future optimisation). During the scan we
   * drop stale entries — processes that have left the schedulable set (RUNNING
   * elsewhere, BLOCKED, STOPPED, EXITING, ZOMBIE, SUSPENDED, CHECKPOINTING, or
   * gone). READY-but-exhausted and NEW entries are *kept* (they may become
   * schedulable later) but are not chosen.
   *
   * Among runnable candidates (READY and budget OK), the winner is the lowest
   * `nice`, ties broken by earliest `seq` (FIFO). Returns null if there is
   * nothing to run this tick.
   */
  #selectNext(): ProcessId | null {
    const kept: QueueNode[] = [];
    let best: QueueNode | null = null;
    let bestNice = 0;

    for (const node of this.#queue) {
      const entry = this.#table.get(node.pid);
      if (entry === undefined || NON_QUEUEABLE.has(entry.state)) {
        // Stale: the process is gone, or it has left the schedulable set and is
        // being handled elsewhere. Drop it from the array **and** from the
        // membership mirror — see the bug note on `#queued` below.
        this.#queued.delete(unbrand(node.pid));
        continue;
      }

      // Kept: state is 'ready' or 'new'.
      kept.push(node);

      if (entry.state !== 'ready') continue; // 'new' → not schedulable yet
      if (this.#table.checkBudget(node.pid) !== 'ok') continue; // exhausted → parked

      // Runnable candidate.
      if (
        best === null ||
        entry.nice < bestNice ||
        (entry.nice === bestNice && node.seq < best.seq)
      ) {
        best = node;
        bestNice = entry.nice;
      }
    }

    if (best === null) {
      this.#queue = kept;
      return null;
    }

    const bestKey = unbrand(best.pid);
    this.#queued.delete(bestKey);
    this.#queue = kept.filter((n) => n !== best);
    return best.pid;
  }

  // ---------------------------------------------------------------------------
  // §3.6 Internal: SIGXCPU + recording
  // ---------------------------------------------------------------------------

  /**
   * Fire `SIGXCPU` at a RUNNING process whose budget is exhausted. The default
   * disposition is `stop` (docs/PROCESS.md §7 table), so this transitions the
   * process RUNNING → STOPPED; a custom disposition (handler/ignore) is
   * honoured by signals.ts. The process is NOT re-queued — the supervisor
   * decides what happens next (docs/PROCESS.md §8.3).
   */
  async #fireSigxcpu(
    pid: ProcessId,
    kind: 'tokens' | 'usd' | 'wallTime',
    phase: 'pre-dispatch' | 'post-quantum',
  ): Promise<void> {
    // signals.send records the delivery as __signal; we add the scheduling
    // context as a __sched record so the budget kind is queryable.
    await this.#signals.send(pid, 'SIGXCPU', PID_KERNEL);
    const entry = this.#table.get(pid);
    await this.#recordSched(pid, 'sigxcpu', {
      budgetKind: kind,
      phase,
      stateAfter: entry?.state ?? 'zombie',
    });
  }

  /**
   * Append a `__sched` record to the process's `.crec` log. Best-effort: a
   * missing recorder (null factory) is a silent no-op so smoke tests run
   * without disk I/O; a recorder failure is wrapped as ERECORD and rethrown
   * (matching signals.ts) so a broken audit trail is never silent in
   * production.
   */
  async #recordSched(
    pid: ProcessId,
    action: DispatchReason | 'idle',
    details: Record<string, unknown>,
  ): Promise<void> {
    const recorder = this.#table.recorderFor(pid);
    if (recorder === null) return;

    const entry = this.#table.get(pid);
    const stateNow: ProcessState = entry?.state ?? 'zombie';

    const record: SyscallRecordInput = {
      timestamp: this.#now(),
      pid,
      syscall: '__sched',
      callId: `sched-${unbrand(pid)}-${action}-${this.#seqCounter}`,
      phase: 'exit',
      args: { action, ...details },
      stateBefore: stateNow,
      stateAfter: stateNow,
      reversibility: 'idempotent',
      kernelAbiVersion: this.kernelAbiVersion,
    };

    try {
      await recorder.append(record);
    } catch (err) {
      if (isCortexError(err)) throw err;
      throw new CortexError('ERECORD', '__sched', {
        message: `failed to record scheduler ${action} for pid ${unbrand(pid)}`,
        cause: err,
      });
    }
  }
}
