/**
 * cortex kernel — process table.
 *
 * The authoritative registry of every process the kernel knows about. Owns
 * PID allocation, the eight-state machine, the legal-transition table, and
 * the zombie/reap lifecycle. Every other kernel module asks the table
 * "what is the state of PID X?" rather than tracking it themselves.
 *
 * ## What this module owns
 *
 *   - PID allocation (monotonic u64, never reused, starting at 2)
 *   - The `ProcessEntry` for each live, zombie, or suspended process
 *   - The state machine: 8 states, the legal transitions enumerated in
 *     docs/PROCESS.md §5, and `EINVAL` traps for anything else
 *   - Recording every state transition to the process's `.crec` log
 *   - Zombie retention until reaped by parent or init
 *   - `ProcessInfo` snapshots for `ps()`
 *
 * ## What this module does NOT own
 *
 *   - Signal *delivery* (that is signals.ts; the table only stores
 *     dispositions and the pending queue)
 *   - Scheduling decisions (that is scheduler.ts; the table only reports
 *     which processes are READY)
 *   - Budget *enforcement* (that is scheduler.ts; the table only stores
 *     counters and limits)
 *   - Fork lineage tracking beyond ppid (that is fork.ts + the recorder)
 *   - Init registration (PID 1 is reserved here but registered by init.ts)
 *
 * ## Recording
 *
 * Every `setState()` writes a synthetic record to the process's `.crec`
 * with `syscall: '__state'`. The double underscore marks it as
 * kernel-internal — agents cannot invoke it, and replay engines treat it
 * as a scheduler/signal event rather than a user syscall.
 *
 * Syscall-induced transitions are *also* captured in the syscall's own
 * enter/exit records (via `stateBefore` / `stateAfter`). The `__state`
 * record is redundant in that case but kept for uniformity: the table
 * does not know whether a transition was syscall-induced or kernel-induced,
 * so it always records. v1 may elide redundant `__state` records.
 *
 * See: docs/PROCESS.md §3-§6, docs/ARCHITECTURE.md §4.2
 *
 * @module kernel/process_table
 */

import {
  type AgentSpec,
  type BlockedReason,
  type BudgetCounters,
  type BudgetLimits,
  type ChainId,
  type MemoryRegionPolicy,
  type ProcessFilter,
  type ProcessId,
  type ProcessInfo,
  type ProcessState,
  type RestartPolicy,
  type Signal,
  type SignalDisposition,
  type SyscallOffset,
  type Timestamp,
  type WaitResult,
  asProcessId,
  asSyscallOffset,
  unbrand,
} from './types.js';
import { CortexError, isCortexError, trap } from './errors.js';
import { type Recorder, type SyscallRecordInput } from './recorder.js';

// =============================================================================
// §1. Reserved PIDs
// =============================================================================

/**
 * PID 0 is the kernel itself. Never allocated to a process. Matches Unix
 * convention (swapper / idle task).
 */
export const PID_KERNEL = asProcessId(0);

/**
 * PID 1 is init. Reserved at table construction; registered by `init.ts`
 * (#021) during boot. Until init registers, PID 1 is reserved but absent
 * from the table.
 */
export const PID_INIT = asProcessId(1);

/** First PID available to user processes. */
export const PID_FIRST_USER = 2;

// =============================================================================
// §2. State machine
// =============================================================================

/**
 * The eight process states. Lowercase string literals match
 * docs/PROCESS.md §3 verbatim.
 */
export const PROCESS_STATES = [
  'new',
  'ready',
  'running',
  'blocked',
  'stopped',
  'checkpointing',
  'suspended',
  'exiting',
  'zombie',
] as const satisfies readonly ProcessState[];

/**
 * Legal state transitions, encoded as a set of `"from->to"` keys.
 *
 * Source: docs/PROCESS.md §5 (the normative table). Note that §2 prose says
 * "twelve legal transitions" but the §5 table enumerates more; the table is
 * authoritative and §2 needs a doc fix.
 *
 * Terminal transitions (to "gone") are NOT in this set. They are handled by
 * `reap()` (ZOMBIE → removed) and `restore()` (SUSPENDED → removed, new PID
 * created elsewhere). The table never deletes an entry as a side effect of
 * `setState()`.
 */
const LEGAL_TRANSITIONS: ReadonlySet<string> = new Set([
  'new->ready', // scheduler init complete
  'ready->running', // scheduler dispatch
  'running->ready', // syscall returned, more work pending
  'running->blocked', // syscall awaits external event
  'blocked->ready', // wake condition met
  'running->stopped', // SIGSTOP / SIGXCPU / budget exhaustion
  'stopped->ready', // SIGCONT
  'running->checkpointing', // SIGUSR2 or checkpoint() syscall
  'blocked->checkpointing', // SIGUSR2 delivered while blocked
  'checkpointing->ready', // snapshot done, no --detach
  'checkpointing->suspended', // snapshot done with --detach
  'running->exiting', // exit() or terminating signal
  'blocked->exiting', // SIGKILL or SIGTERM with handler
  'stopped->exiting', // SIGKILL or SIGTERM
  'exiting->zombie', // cleanup done or exit_timeout_ms elapsed
]);

/**
 * Check whether a transition is legal. Exported so the scheduler and signal
 * modules can pre-validate before attempting a transition.
 */
export function isLegalTransition(from: ProcessState, to: ProcessState): boolean {
  return LEGAL_TRANSITIONS.has(`${from}->${to}`);
}

/**
 * Return the set of states reachable from `from` in one legal transition.
 * Used by `assertState` error messages and by `cortex ps` tooling.
 */
export function legalSuccessors(from: ProcessState): readonly ProcessState[] {
  const out: ProcessState[] = [];
  for (const key of LEGAL_TRANSITIONS) {
    const [f, t] = key.split('->') as [ProcessState, ProcessState];
    if (f === from) out.push(t);
  }
  return out;
}

// =============================================================================
// §3. ProcessEntry (internal, mutable)
// =============================================================================

/**
 * Internal mutable record for one process. Not exported as part of the
 * public ABI — external code sees `ProcessInfo` (immutable snapshot) via
 * `table.snapshot(pid)` or `table.list(filter)`.
 *
 * The kernel modules (scheduler, signals, fork, checkpoint) hold references
 * to entries and mutate them through table methods. Direct field mutation
 * outside the table is a bug.
 */
export interface ProcessEntry {
  readonly pid: ProcessId;
  ppid: ProcessId | null;
  pgid: ProcessId;
  role: string;
  state: ProcessState;
  blockedOn: BlockedReason | null;
  nice: number;
  startedAt: Timestamp;
  lastTransitionAt: Timestamp;
  budgetsRemaining: BudgetLimits;
  budgetsSpent: BudgetCounters;
  exitCode: number | null;
  exitReason: string | null;
  checkpointChain: ChainId[];
  pendingSignals: Signal[];
  signalDispositions: Map<Signal, SignalDisposition>;
  daemon: boolean;
  autoReap: boolean;
  restart: RestartPolicy | null;
  exitTimeoutMs: number;
  agent: AgentSpec;
  memoryRegions: Map<string, MemoryRegionPolicy>;
  /** Set when the process exits; used by reap() to build WaitResult. */
  diedAt: Timestamp | null;
  /** Syscall log offset at time of death; used by reap(). */
  finalLogOffset: SyscallOffset | null;
  /** Syscall log offset at time of spawn; used by reap() for range. */
  initialLogOffset: SyscallOffset;
}

// =============================================================================
// §4. Allocation options
// =============================================================================

/**
 * Arguments to `ProcessTable.allocate()`. Mirrors `SpawnOptions` but with
 * kernel-internal fields the agent does not control (explicit PID for
 * restore, initial log offset, etc.).
 */
export interface AllocateOptions {
  /**
   * Explicit PID. Used by `restore()` to... actually no — restore allocates
   * a *new* PID per docs/PROCESS.md §3.6. This field exists for tests and
   * for init registration (PID 1). Production `spawn`/`fork` leave it
   * undefined and let the table auto-allocate.
   */
  readonly pid?: ProcessId;
  readonly ppid: ProcessId | null;
  readonly pgid?: ProcessId;
  readonly role: string;
  readonly agent: AgentSpec;
  readonly budgets?: Partial<BudgetLimits>;
  readonly nice?: number;
  readonly daemon?: boolean;
  readonly autoReap?: boolean;
  readonly restart?: RestartPolicy;
  readonly memory?: Readonly<Record<string, MemoryRegionPolicy>>;
  readonly signals?: Partial<Record<Signal, SignalDisposition>>;
  readonly exitTimeoutMs?: number;
  readonly startedAt?: Timestamp;
  readonly initialLogOffset?: SyscallOffset;
}

/**
 * Default budget limits for a process whose parent did not specify any.
 * `-1` means unlimited per docs/PROCESS.md §10.
 */
const DEFAULT_BUDGETS: BudgetLimits = {
  tokens: -1,
  usd: -1,
  wallTimeMs: -1,
};

const DEFAULT_SPENT: BudgetCounters = {
  tokensIn: 0,
  tokensOut: 0,
  tokensCached: 0,
  usdSpent: 0,
  wallTimeMs: 0,
  syscallCount: 0,
};

// =============================================================================
// §5. Recorder factory
// =============================================================================

/**
 * The table needs a `.crec` recorder for each process to log state
 * transitions. Rather than owning file I/O directly, it takes a factory.
 * Production passes one that opens `.cortex/proc/<pid>.crec`; tests pass
 * one that writes to a temp dir or returns a no-op.
 *
 * The factory is called once per `allocate()`. The table caches the
 * returned recorder and closes it on `reap()`.
 */
export type RecorderFactory = (pid: ProcessId) => Promise<Recorder | null>;

/**
 * A recorder factory that records nothing. Useful for unit tests of the
 * state machine in isolation. Production code should never use this —
 * "everything is recorded" is an architectural invariant
 * (docs/ARCHITECTURE.md §2).
 */
export const nullRecorderFactory: RecorderFactory = async () => null;

// =============================================================================
// §6. ProcessTable
// =============================================================================

/**
 * Options for constructing a `ProcessTable`.
 */
export interface ProcessTableOptions {
  /** Factory for per-process recorders. Required in production. */
  readonly recorderFactory?: RecorderFactory;
  /** Value written into every record's `kernelAbiVersion` field. */
  readonly kernelAbiVersion: string;
  /**
   * Wall-clock source. Injectable so tests can control time. Defaults to
   * `() => new Date().toISOString()`.
   */
  readonly now?: () => Timestamp;
}

/**
 * The authoritative process registry. One instance per kernel.
 *
 * Concurrency: the table is NOT internally synchronized beyond a promise
 * chain for recorder writes. Node is single-threaded, so synchronous
 * mutations (setState, allocate, reap) are atomic with respect to other
 * JS code. Async operations (recorder writes) are serialized per-process.
 */
export class ProcessTable {
  readonly kernelAbiVersion: string;

  #entries = new Map<number, ProcessEntry>();
  #recorders = new Map<number, Recorder | null>();
  #nextPid = PID_FIRST_USER;
  #recorderFactory: RecorderFactory;
  #now: () => Timestamp;

  constructor(opts: ProcessTableOptions) {
    this.kernelAbiVersion = opts.kernelAbiVersion;
    this.#recorderFactory = opts.recorderFactory ?? nullRecorderFactory;
    this.#now = opts.now ?? (() => new Date().toISOString());
  }

  // ---------------------------------------------------------------------------
  // §6.1 PID allocation
  // ---------------------------------------------------------------------------

  /**
   * Allocate the next PID. Monotonic, never reused.
   *
   * PID 0 (kernel) and PID 1 (init) are reserved and skipped. Allocation
   * starts at PID_FIRST_USER (2).
   *
   * With `number` as the underlying type, we are bounded by 2^53 rather
   * than 2^64. At a million spawns per second, exhaustion takes ~285
   * years. Acceptable for v0; a bigint-backed PID is a v2 concern.
   */
  nextPid(): ProcessId {
    // Skip reserved PIDs if somehow the counter lands on them.
    while (this.#nextPid === unbrand(PID_KERNEL) || this.#nextPid === unbrand(PID_INIT)) {
      this.#nextPid++;
    }
    return asProcessId(this.#nextPid++);
  }

  /**
   * Current value of the PID counter (the next PID that will be allocated).
   * Exposed for diagnostics and `cortex ps --meta`.
   */
  get pidCounter(): ProcessId {
    return asProcessId(this.#nextPid);
  }

  /**
   * Advance the PID counter so the next allocation is at least `minNext`.
   * No-op when the counter is already >= `minNext`.
   *
   * Used by the CLI to seed a freshly-booted kernel past the highest PID
   * already persisted on disk (`maxPidOnDisk`). Without this, every new
   * invocation restarts the counter at PID_FIRST_USER and reuses PIDs,
   * colliding on `<pid>.crec` / `<pid>.meta.json` — most visibly when
   * `restore` re-mints the same PID the suspended original already owns.
   */
  advancePidCounterTo(minNext: number): void {
    if (minNext > this.#nextPid) {
      this.#nextPid = minNext;
    }
  }

  // ---------------------------------------------------------------------------
  // §6.2 Lifecycle: allocate / get / reap
  // ---------------------------------------------------------------------------

  /**
   * Create a new process entry in state NEW. Returns the allocated PID.
   *
   * The entry is registered in the table immediately. The scheduler moves
   * it NEW → READY when initialization completes (docs/PROCESS.md §6.1).
   *
   * @throws CortexError ESRCH if `ppid` is specified but not in the table
   *         (and is not null), EINVAL if `pid` is explicitly given and
   *         already taken, ERECORD if the recorder factory fails.
   */
  async allocate(opts: AllocateOptions): Promise<ProcessId> {
    // Validate parent exists (if specified).
    if (opts.ppid !== null && !this.#entries.has(unbrand(opts.ppid))) {
      trap('ESRCH', 'allocate', {
        ppid: unbrand(opts.ppid),
        reason: 'parent process not in table',
      });
    }

    // Determine PID.
    const pid = opts.pid ?? this.nextPid();
    if (this.#entries.has(unbrand(pid))) {
      trap('EINVAL', 'allocate', {
        pid: unbrand(pid),
        reason: 'PID already in use',
      });
    }

    // Determine PGID. Default: parent's PGID, or self if no parent.
    let pgid = opts.pgid;
    if (pgid === undefined) {
      if (opts.ppid !== null) {
        const parent = this.#entries.get(unbrand(opts.ppid));
        pgid = parent?.pgid ?? pid;
      } else {
        pgid = pid;
      }
    }

    const now = opts.startedAt ?? this.#now();
    const budgetsRemaining: BudgetLimits = {
      ...DEFAULT_BUDGETS,
      ...opts.budgets,
    };

    const entry: ProcessEntry = {
      pid,
      ppid: opts.ppid,
      pgid,
      role: opts.role,
      state: 'new',
      blockedOn: null,
      nice: opts.nice ?? 0,
      startedAt: now,
      lastTransitionAt: now,
      budgetsRemaining,
      budgetsSpent: { ...DEFAULT_SPENT },
      exitCode: null,
      exitReason: null,
      checkpointChain: [],
      pendingSignals: [],
      signalDispositions: new Map(Object.entries(opts.signals ?? {}) as [Signal, SignalDisposition][]),
      daemon: opts.daemon ?? false,
      autoReap: opts.autoReap ?? false,
      restart: opts.restart ?? null,
      exitTimeoutMs: opts.exitTimeoutMs ?? 5000,
      agent: opts.agent,
      memoryRegions: new Map(Object.entries(opts.memory ?? {})),
      diedAt: null,
      finalLogOffset: null,
      initialLogOffset: opts.initialLogOffset ?? asSyscallOffset(0),
    };

    // Open the recorder before registering, so a factory failure does not
    // leave a half-registered entry.
    let recorder: Recorder | null;
    try {
      recorder = await this.#recorderFactory(pid);
    } catch (err) {
      if (isCortexError(err)) throw err;
      throw new CortexError('ERECORD', 'allocate', {
        message: `recorder factory failed for pid ${unbrand(pid)}`,
        cause: err,
      });
    }

    this.#entries.set(unbrand(pid), entry);
    this.#recorders.set(unbrand(pid), recorder);

    return pid;
  }

  /**
   * Look up a process entry. Returns undefined if the PID is not in the
   * table (never allocated, or already reaped).
   *
   * Internal modules use this to mutate entries. External code should use
   * `snapshot()` for an immutable view.
   */
  get(pid: ProcessId): ProcessEntry | undefined {
    return this.#entries.get(unbrand(pid));
  }

  /**
   * Look up a process entry, trapping with ESRCH if absent. Convenience
   * wrapper for kernel modules that consider "PID not found" a fatal error
   * rather than a condition to handle.
   */
  mustGet(pid: ProcessId, syscall = 'process_table'): ProcessEntry {
    const entry = this.#entries.get(unbrand(pid));
    if (entry === undefined) {
      trap('ESRCH', syscall, { pid: unbrand(pid) });
    }
    return entry;
  }

  /**
   * Whether a PID is currently in the table (any state, including zombie
   * and suspended).
   */
  has(pid: ProcessId): boolean {
    return this.#entries.has(unbrand(pid));
  }

  /**
   * Remove a zombie entry and return the wait result. Called by the parent's
   * `wait()` syscall or by init's reaper.
   *
   * The PID is **never reused** after reaping (docs/PROCESS.md §4.1).
   *
   * @throws CortexError ESRCH if the PID is not in the table, ESTATE if the
   *         process is not in ZOMBIE state (cannot reap a live process).
   */
  async reap(pid: ProcessId): Promise<WaitResult> {
    const entry = this.mustGet(pid, 'reap');
    if (entry.state !== 'zombie') {
      trap('ESTATE', 'reap', {
        pid: unbrand(pid),
        currentState: entry.state,
        reason: 'can only reap a zombie',
      });
    }

    const reapedAt = this.#now();
    const result: WaitResult = {
      pid,
      exitCode: entry.exitCode ?? 0,
      exitReason: entry.exitReason ?? 'unknown',
      budgetsSpent: { ...entry.budgetsSpent },
      syscallLogRange: [entry.initialLogOffset, entry.finalLogOffset ?? entry.initialLogOffset],
      reapedAt,
    };

    // Close the recorder before removing the entry.
    const recorder = this.#recorders.get(unbrand(pid));
    if (recorder !== null && recorder !== undefined) {
      try {
        await recorder.close();
      } catch {
        // Best-effort close; a failure here should not block reaping.
        // The fd will be cleaned up on process exit.
      }
    }

    this.#entries.delete(unbrand(pid));
    this.#recorders.delete(unbrand(pid));
    return result;
  }

  // ---------------------------------------------------------------------------
  // §6.3 State machine
  // ---------------------------------------------------------------------------

  /**
   * Transition a process to a new state. Validates the transition against
   * the legal table, updates `lastTransitionAt`, and records the transition
   * to the process's `.crec` log.
   *
   * @param pid     Target process.
   * @param next    New state.
   * @param meta    Optional context recorded with the transition (trigger,
   *                signal, syscall name, etc.).
   *
   * @throws CortexError ESRCH if the PID is absent, EINVAL if the transition
   *         is not in the legal table, ERECORD if recording fails.
   */
  async setState(
    pid: ProcessId,
    next: ProcessState,
    meta: { readonly trigger?: string; readonly [key: string]: unknown } = {},
  ): Promise<void> {
    const entry = this.mustGet(pid, 'setState');
    const prev = entry.state;

    if (prev === next) {
      // No-op transitions are allowed and not recorded. This keeps callers
      // simple (they do not have to pre-check the current state).
      return;
    }

    if (!isLegalTransition(prev, next)) {
      trap('EINVAL', 'setState', {
        pid: unbrand(pid),
        from: prev,
        to: next,
        legalSuccessors: legalSuccessors(prev),
        reason: 'illegal state transition',
      });
    }

    const now = this.#now();
    entry.state = next;
    entry.lastTransitionAt = now;

    // Side effects of specific transitions.
    if (next === 'blocked') {
      // blockedOn must be set by the caller via setBlockedOn() before or
      // immediately after this transition. We do not enforce it here to
      // keep the table dumb; the syscall dispatcher is responsible.
    } else {
      // Leaving any non-BLOCKED state (or transitioning between non-BLOCKED
      // states) clears a stale blockedOn reason.
      entry.blockedOn = null;
    }

    if (next === 'exiting') {
      entry.diedAt = now;
    }

    // Record the transition.
    await this.#recordTransition(entry, prev, next, meta);
  }

  /**
   * Set or clear the `blockedOn` field. Only valid when the process is in
   * (or about to enter) BLOCKED state. The table does not enforce the
   * state precondition — the caller (syscall dispatcher) is responsible.
   */
  setBlockedOn(pid: ProcessId, reason: BlockedReason | null): void {
    const entry = this.mustGet(pid, 'setBlockedOn');
    entry.blockedOn = reason;
  }

  /**
   * Record the final exit code and reason. Called by the exit syscall and
   * by signal-induced termination, before the EXITING → ZOMBIE transition.
   */
  setExitInfo(pid: ProcessId, code: number, reason: string, finalLogOffset: SyscallOffset): void {
    const entry = this.mustGet(pid, 'setExitInfo');
    entry.exitCode = code;
    entry.exitReason = reason;
    entry.finalLogOffset = finalLogOffset;
  }

  // ---------------------------------------------------------------------------
  // §6.4 Snapshots and queries
  // ---------------------------------------------------------------------------

  /**
   * Produce an immutable `ProcessInfo` snapshot of one process. This is
   * what `ps()` returns to agents and what the CLI prints.
   *
   * @throws CortexError ESRCH if the PID is absent.
   */
  snapshot(pid: ProcessId): ProcessInfo {
    const entry = this.mustGet(pid, 'snapshot');
    return entryToInfo(entry);
  }

  /**
   * List processes matching an optional filter. All filter fields are
   * ANDed; missing fields match anything.
   *
   * Returns snapshots, not live entries — mutating the result does not
   * affect the table.
   */
  list(filter?: ProcessFilter): readonly ProcessInfo[] {
    const out: ProcessInfo[] = [];
    for (const entry of this.#entries.values()) {
      if (filter !== undefined && !matchesFilter(entry, filter)) continue;
      out.push(entryToInfo(entry));
    }
    // Stable sort by PID so output is deterministic across calls.
    out.sort((a, b) => unbrand(a.pid) - unbrand(b.pid));
    return out;
  }

  /**
   * All PIDs currently in the table, in allocation order. Includes zombies
   * and suspended processes.
   */
  pids(): readonly ProcessId[] {
    return [...this.#entries.values()]
      .map((e) => e.pid)
      .sort((a, b) => unbrand(a) - unbrand(b));
  }

  /**
   * Number of entries currently in the table.
   */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * Children of a given parent, in allocation order. Used by `wait()` and
   * by init's reaper.
   */
  children(ppid: ProcessId): readonly ProcessId[] {
    const target = unbrand(ppid);
    const out: ProcessId[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.ppid !== null && unbrand(entry.ppid) === target) {
        out.push(entry.pid);
      }
    }
    return out.sort((a, b) => unbrand(a) - unbrand(b));
  }

  /**
   * Members of a process group, in allocation order. Used by
   * `kill(-pgid, sig)`.
   */
  groupMembers(pgid: ProcessId): readonly ProcessId[] {
    const target = unbrand(pgid);
    const out: ProcessId[] = [];
    for (const entry of this.#entries.values()) {
      if (unbrand(entry.pgid) === target) {
        out.push(entry.pid);
      }
    }
    return out.sort((a, b) => unbrand(a) - unbrand(b));
  }

  /**
   * Reparent every child of `deadPid` to init (PID 1). Called when a process
   * dies: its children become orphans and init inherits them (docs/PROCESS.md
   * §4.2, §3 — "when a parent dies, its children are reparented to init").
   * Mirrors the `reparentOrphans(deadPid)` method sketched in
   * docs/ARCHITECTURE.md §4.2.
   *
   * Works even if `deadPid` itself is already gone (reaped): orphaned children
   * still carry the dead PID as their `ppid`, so we match on that rather than
   * requiring the parent entry to exist. Process-group membership (`pgid`) is
   * preserved — only `ppid` changes, matching Unix (a group outlives its
   * founder).
   *
   * Metadata-only mutation: records nothing itself (init writes the `__init`
   * event describing the reparent), matching the `setBudgets` precedent.
   *
   * @returns The reparented PIDs, in ascending order. Empty if the dead
   *          process had no children.
   */
  reparentOrphans(deadPid: ProcessId): readonly ProcessId[] {
    const target = unbrand(deadPid);
    const moved: ProcessId[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.ppid !== null && unbrand(entry.ppid) === target) {
        entry.ppid = PID_INIT;
        moved.push(entry.pid);
      }
    }
    return moved.sort((a, b) => unbrand(a) - unbrand(b));
  }

  // ---------------------------------------------------------------------------
  // §6.5 Signals (storage only — delivery is signals.ts)
  // ---------------------------------------------------------------------------

  /**
   * Queue a signal for later delivery. The table does not decide *when* or
   * *whether* to deliver — that is signals.ts. Coalescing (collapsing
   * duplicate pending signals of the same type, per docs/PROCESS.md §11.7)
   * happens here.
   */
  queueSignal(pid: ProcessId, signal: Signal): void {
    const entry = this.mustGet(pid, 'queueSignal');
    // Coalesce: if the same signal is already pending, do not duplicate.
    if (!entry.pendingSignals.includes(signal)) {
      entry.pendingSignals.push(signal);
    }
  }

  /**
   * Drain and return all pending signals for a process. Called by the
   * signal delivery machinery when the process transitions to RUNNING.
   */
  drainSignals(pid: ProcessId): readonly Signal[] {
    const entry = this.mustGet(pid, 'drainSignals');
    const drained = entry.pendingSignals;
    entry.pendingSignals = [];
    return drained;
  }

  /**
   * Set or replace the disposition for a signal.
   *
   * @throws CortexError EPERM if attempting to catch SIGKILL or SIGSTOP
   *         (docs/PROCESS.md §7.1 — non-negotiable).
   */
  setDisposition(pid: ProcessId, signal: Signal, disp: SignalDisposition): void {
    if ((signal === 'SIGKILL' || signal === 'SIGSTOP') && disp.kind !== 'default') {
      trap('EPERM', 'setDisposition', {
        pid: unbrand(pid),
        signal,
        reason: 'SIGKILL and SIGSTOP cannot be caught, ignored, or blocked',
      });
    }
    const entry = this.mustGet(pid, 'setDisposition');
    entry.signalDispositions.set(signal, disp);
  }

  /**
   * Look up the disposition for a signal. Falls back to `{ kind: 'default' }`
   * if none was explicitly set.
   */
  getDisposition(pid: ProcessId, signal: Signal): SignalDisposition {
    const entry = this.mustGet(pid, 'getDisposition');
    return entry.signalDispositions.get(signal) ?? { kind: 'default' };
  }

  // ---------------------------------------------------------------------------
  // §6.6 Budgets (storage only — enforcement is scheduler.ts)
  // ---------------------------------------------------------------------------

  /**
   * Add to the spent counters and subtract from the remaining limits.
   * Negative limits mean unlimited and are not decremented.
   *
   * The table does NOT trap on exhaustion — it only updates counters. The
   * scheduler checks `checkBudget()` and fires SIGXCPU.
   */
  spend(pid: ProcessId, delta: Partial<BudgetCounters>): void {
    const entry = this.mustGet(pid, 'spend');
    const spent = entry.budgetsSpent;
    const remaining = entry.budgetsRemaining;

    const tokensIn = delta.tokensIn ?? 0;
    const tokensOut = delta.tokensOut ?? 0;
    const tokensCached = delta.tokensCached ?? 0;
    const usdSpent = delta.usdSpent ?? 0;
    const wallTimeMs = delta.wallTimeMs ?? 0;
    const syscallCount = delta.syscallCount ?? 0;

    entry.budgetsSpent = {
      tokensIn: spent.tokensIn + tokensIn,
      tokensOut: spent.tokensOut + tokensOut,
      tokensCached: spent.tokensCached + tokensCached,
      usdSpent: spent.usdSpent + usdSpent,
      wallTimeMs: spent.wallTimeMs + wallTimeMs,
      syscallCount: spent.syscallCount + syscallCount,
    };

    const totalTokens = tokensIn + tokensOut;
    entry.budgetsRemaining = {
      tokens: remaining.tokens < 0 ? -1 : Math.max(0, remaining.tokens - totalTokens),
      usd: remaining.usd < 0 ? -1 : Math.max(0, remaining.usd - usdSpent),
      wallTimeMs:
        remaining.wallTimeMs < 0 ? -1 : Math.max(0, remaining.wallTimeMs - wallTimeMs),
    };
  }

  /**
   * Check whether any budget is exhausted. Returns 'ok' or the first
   * exhausted kind. Used by the scheduler to decide whether to fire
   * SIGXCPU.
   */
  checkBudget(pid: ProcessId): 'ok' | { readonly kind: 'tokens' | 'usd' | 'wallTime' } {
    const entry = this.mustGet(pid, 'checkBudget');
    const r = entry.budgetsRemaining;
    if (r.tokens === 0) return { kind: 'tokens' };
    if (r.usd === 0) return { kind: 'usd' };
    if (r.wallTimeMs === 0) return { kind: 'wallTime' };
    return 'ok';
  }

  /**
   * Directly overwrite a process's remaining budget limits and/or spent
   * counters. Kernel-internal: used by `fork.ts` to apply budget policies
   * (`reset` / `inherit` / `split`), which `spend()` cannot express —
   * `inherit` copies the parent's spent counters onto the child *without*
   * decrementing the child's remaining, and `split` moves remaining budget
   * from parent to child without either process "spending" it.
   *
   * Records no syscall; the caller (fork) records the chosen policy. Does not
   * validate budget legality — `checkBudget()` remains the arbiter of whether
   * a process may keep running.
   *
   * @throws CortexError ESRCH if the PID is absent.
   */
  setBudgets(
    pid: ProcessId,
    patch: {
      readonly remaining?: Partial<BudgetLimits>;
      readonly spent?: Partial<BudgetCounters>;
    },
  ): void {
    const entry = this.mustGet(pid, 'setBudgets');
    if (patch.remaining !== undefined) {
      entry.budgetsRemaining = { ...entry.budgetsRemaining, ...patch.remaining };
    }
    if (patch.spent !== undefined) {
      entry.budgetsSpent = { ...entry.budgetsSpent, ...patch.spent };
    }
  }

  // ---------------------------------------------------------------------------
  // §6.7 Checkpoint chain
  // ---------------------------------------------------------------------------

  /**
   * Append a chain ID to the process's checkpoint history. Called by
   * checkpoint.ts after a successful snapshot.
   */
  pushCheckpoint(pid: ProcessId, chainId: ChainId): void {
    const entry = this.mustGet(pid, 'pushCheckpoint');
    entry.checkpointChain.push(chainId);
  }

  // ---------------------------------------------------------------------------
  // §6.8 Recorder access
  // ---------------------------------------------------------------------------

  /**
   * Get the recorder for a process. Returns null if the factory produced
   * no recorder (test mode). Kernel modules use this to write syscall
   * records; the table itself uses it for `__state` transition records.
   */
  recorderFor(pid: ProcessId): Recorder | null {
    return this.#recorders.get(unbrand(pid)) ?? null;
  }

  // ---------------------------------------------------------------------------
  // §6.9 Internal: recording
  // ---------------------------------------------------------------------------

  async #recordTransition(
    entry: ProcessEntry,
    prev: ProcessState,
    next: ProcessState,
    meta: { readonly trigger?: string; readonly [key: string]: unknown },
  ): Promise<void> {
    const recorder = this.#recorders.get(unbrand(entry.pid));
    if (recorder === null || recorder === undefined) return;

    const record: SyscallRecordInput = {
      timestamp: entry.lastTransitionAt,
      pid: entry.pid,
      syscall: '__state',
      callId: `state-${unbrand(entry.pid)}-${entry.lastTransitionAt}`,
      phase: 'exit',
      args: { from: prev, to: next, ...meta },
      stateBefore: prev,
      stateAfter: next,
      reversibility: 'idempotent',
      kernelAbiVersion: this.kernelAbiVersion,
    };

    try {
      await recorder.append(record);
    } catch (err) {
      // Recording failure is serious but should not crash the kernel.
      // Surface as ERECORD; the caller (scheduler, signal handler) decides
      // whether to continue or halt the process.
      if (isCortexError(err)) throw err;
      throw new CortexError('ERECORD', 'setState', {
        message: `failed to record transition ${prev}->${next} for pid ${unbrand(entry.pid)}`,
        cause: err,
      });
    }
  }
}

// =============================================================================
// §7. Helpers
// =============================================================================

/**
 * Convert a mutable internal entry to an immutable public snapshot.
 * Arrays and maps are copied so later mutations of the entry do not
 * leak into previously-returned snapshots.
 */
function entryToInfo(entry: ProcessEntry): ProcessInfo {
  return {
    pid: entry.pid,
    ppid: entry.ppid,
    pgid: entry.pgid,
    role: entry.role,
    state: entry.state,
    blockedOn: entry.blockedOn,
    nice: entry.nice,
    startedAt: entry.startedAt,
    lastTransitionAt: entry.lastTransitionAt,
    budgetsRemaining: { ...entry.budgetsRemaining },
    budgetsSpent: { ...entry.budgetsSpent },
    exitCode: entry.exitCode,
    exitReason: entry.exitReason,
    checkpointChain: [...entry.checkpointChain],
    pendingSignals: [...entry.pendingSignals],
  };
}

/**
 * Apply a `ProcessFilter` to an entry. All specified fields must match;
 * unspecified fields match anything.
 */
function matchesFilter(entry: ProcessEntry, filter: ProcessFilter): boolean {
  if (filter.state !== undefined && entry.state !== filter.state) return false;
  if (filter.role !== undefined && entry.role !== filter.role) return false;
  if (filter.pgid !== undefined && unbrand(entry.pgid) !== unbrand(filter.pgid)) return false;
  if (filter.ppid !== undefined) {
    if (entry.ppid === null) return false;
    if (unbrand(entry.ppid) !== unbrand(filter.ppid)) return false;
  }
  return true;
}
