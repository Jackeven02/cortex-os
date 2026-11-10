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
  type BudgetKind,
  type BudgetLimits,
  type Capability,
  type ChainId,
  type MemoryRegionPolicy,
  type ProcessFilter,
  type ProcessId,
  type ProcessInfo,
  type ProcessState,
  type RestartPolicy,
  type Signal,
  type SignalDisposition,
  type ShadowSpec,
  type SyscallOffset,
  type Timestamp,
  type WaitResult,
  asProcessId,
  asSyscallOffset,
  unbrand,
  DEFAULT_CAPABILITIES,
  NICE_MAX,
  NICE_MIN,
  isValidNice,
} from './types.js';
import type { Intent } from './intent.js';
import { CortexError, isCortexError, trap } from './errors.js';
import { type Recorder, type SyscallRecordInput } from './recorder.js';
import { tokenUsage } from '../token_usage.js';

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
 * The states in which a process is **living**, and the wall clock runs.
 *
 * A stopped process (SIGSTOP, or the default SIGXCPU disposition) is not
 * running, and a suspended one (checkpointed) is not running at all: their
 * time is not the agent's, and charging it to them would drain a budget for
 * work that is not happening. A process that has exited is done.
 *
 * The clock is *paused* for those states rather than reset: the time spent
 * alive before a stop is still the process's, and the time spent stopped is
 * not.
 */
const WALL_CLOCK_STATES: ReadonlySet<ProcessState> = new Set<ProcessState>([
  'new',
  'ready',
  'running',
  'blocked',
]);

/**
 * Why a process changed state — the **trigger** recorded with every
 * transition.
 *
 * A transition without a cause is a fact without an explanation: the log says
 * the process went from `running` to `blocked`, and not whether it was
 * waiting on a channel, on a timer, on a child, or on a signal. The trigger
 * is that answer, and it was in the `__state` frame all along — the views
 * just dropped it.
 *
 * The list is exported so that:
 *
 * - a view can size its column to the widest cause the kernel can produce
 *   rather than guess at one (ABI.md §6.1);
 * - a cause that is not on the list cannot be recorded — `setState` takes a
 *   {@link StateTrigger}, so a typo is a compile error and not a frame
 *   nobody can explain.
 *
 * The list is exhaustive by construction: every `setState` call site names
 * one of these.
 */
export const STATE_TRIGGERS = [
  'init-boot',
  'init-register-daemon',
  'spawn',
  'fork',
  'fork-abort',
  'restore',
  'checkpoint',
  'checkpoint-abort',
  'recv',
  'recv-wake',
  'recv-cancel',
  'wait',
  'wait-return',
  'sleep',
  'llm-call',
  'tool-call',
  'driver-return',
  'exit',
  'signal',
  'kill',
  'cleanup-done',
  'scheduler-dispatch',
  'scheduler-yield',
] as const;

/** One cause of a state transition. */
export type StateTrigger = (typeof STATE_TRIGGERS)[number];

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
  // A driver call parks the process, then the same syscall resolves inline.
  // The body is still on the CPU, so the next line is a syscall. READY would
  // trap ESTATE (the checkpointing->running edge exists for the same reason).
  // recv / wait / sleep still wake through READY: those bodies are not running.
  'blocked->running',
  'running->stopped', // SIGSTOP / SIGXCPU / budget exhaustion
  'stopped->ready', // SIGCONT
  'running->checkpointing', // SIGUSR2 or checkpoint() syscall
  'blocked->checkpointing', // SIGUSR2 delivered while blocked
  // Snapshot done, no --detach. The process goes straight back to RUNNING,
  // not to READY: the agent body is still live and its `await ctx.checkpoint()`
  // resolves inline, so the very next statement issues a syscall. Leaving it
  // READY meant that next syscall trapped ESTATE — the body was executing
  // while the process claimed not to be running. (READY means "dispatchable
  // but not yet dispatched", which is simply not true here.)
  'checkpointing->running', // snapshot done, no --detach
  'checkpointing->ready', // retained for the best-effort abort path
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
  /**
   * Timestamp up to which this process's wall-clock budget has already been
   * charged. The clock is charged from here to now on every accounting pass —
   * `spend()` and the kernel's heartbeat (`chargeWallClock`) — so a finite
   * `wallTimeMs` budget actually drains, and a process that runs long enough
   * reports the time it really lived. Kept monotonic; set at allocation and
   * refreshed whenever the clock is paused or the budgets are reset.
   */
  lastWallAccountAt: Timestamp;
  budgetsRemaining: BudgetLimits;
  budgetsSpent: BudgetCounters;
  exitCode: number | null;
  exitReason: string | null;
  checkpointChain: ChainId[];
  pendingSignals: Signal[];
  /**
   * Who queued each entry of `pendingSignals`, in the same order.
   * `null` is a signal whose sender was not named. This is part of the
   * process record a `ps` snapshot returns.
   */
  pendingSignalFrom: (ProcessId | null)[];
  /** What this process is trying to do. Null until `set_intent`. */
  intent: Intent | null;
  /**
   * Model defaults for a shadow fork. Absent on every other process.
   * A call that names its own driver, model, or temperature keeps that.
   */
  llmPin: ShadowSpec | null;
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
  /**
   * Capabilities this process holds (docs/ABI.md §4.9), or **`null` for
   * "unnarrowed"** — a process nobody said anything about holds everything,
   * which is what keeps pre-1.0 agents working after the upgrade.
   *
   * Stored on the entry rather than beside the dispatcher because it *is*
   * process state: it must survive a `checkpoint`/`restore` round-trip, and
   * `ps` must be able to report it without asking the dispatcher.
   */
  capabilities: Set<Capability> | null;
  /** Capabilities this process may raise later via `acquire(cap)`. */
  grantable: Set<Capability>;
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
  /**
   * Capabilities the new process holds from birth (docs/ABI.md §4.9).
   * Omitted — along with `grantable` — means fully privileged.
   */
  readonly capabilities?: readonly Capability[];
  /** Capabilities the new process may raise later via `acquire(cap)`. */
  readonly grantable?: readonly Capability[];
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
  /**
   * Try to *claim* a PID before it is handed out.
   *
   * A PID is only meaningful inside one kernel, but the PID *space* belongs
   * to the kernel's state directory — and a directory can host more than one
   * kernel. `cortex daemon run` keeps a kernel alive in `.cortex/` while
   * other `cortex` invocations work in the same directory, and each of them
   * counts PIDs up from its own seed. Without a claim, the two counters walk
   * into each other, and the loser opens the winner's `log.crec` in append
   * mode: two unrelated processes sharing one syscall log, silently.
   *
   * The claim is the fix, and it has to be atomic — hence the filesystem
   * rather than a counter. The production claimer creates
   * `<dir>/processes/<pid>/` with an *exclusive* mkdir, which exactly one
   * caller can win. A false return means "someone else holds this PID" and
   * the table moves on to the next one.
   *
   * Optional: absent (the default) the table allocates purely in memory,
   * which is what an in-memory kernel wants.
   */
  readonly pidClaim?: (pid: number) => boolean;

  /**
   * Called once per allocated process, right after the entry is registered.
   *
   * The kernel reports the fact; whoever owns the disk decides what to do with
   * it. Every process is born through `allocate()` — the dispatcher's
   * `spawn`, init's daemon registration, and `restore` all land here — so
   * this is the one place that sees every birth.
   *
   * A failure here must not stop the process from existing: the hook is a
   * notification, not part of the allocation.
   */
  readonly onCreate?: (entry: ProcessEntry) => void | Promise<void>;
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
  /**
   * Retained exit statuses of already-reaped children, keyed by *parent* pid
   * and then child pid.
   *
   * A `wait()` is a race against whoever else reaps the child — in practice
   * init, which auto-reaps every zombie. Without this ledger a supervisor that
   * waits for child A, does some work, and *then* waits for child B loses B's
   * status entirely (B was reaped while the parent was busy), and the wait
   * either traps or parks forever. Real Unix has the same shape but no
   * auto-reaper, so it never bites; here it would make supervision trees
   * unusable. Statuses are consumed once by `wait`, exactly like a real reap.
   */
  #reapedChildren = new Map<number, Map<number, WaitResult>>();
  #nextPid = PID_FIRST_USER;
  #recorderFactory: RecorderFactory;
  #now: () => Timestamp;
  #pidClaim: ((pid: number) => boolean) | null;
  #onCreate: ((entry: ProcessEntry) => void | Promise<void>) | null;

  constructor(opts: ProcessTableOptions) {
    this.kernelAbiVersion = opts.kernelAbiVersion;
    this.#recorderFactory = opts.recorderFactory ?? nullRecorderFactory;
    this.#now = opts.now ?? (() => new Date().toISOString());
    this.#pidClaim = opts.pidClaim ?? null;
    this.#onCreate = opts.onCreate ?? null;
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
   * Allocate a PID that this kernel can prove is unclaimed.
   *
   * Without a claimer this is just `nextPid()`. With one, a candidate that
   * somebody else already holds is skipped — the claim is what keeps two
   * kernels sharing a state directory from writing the same `.crec` file
   * (see `ProcessTableOptions.pidClaim`).
   *
   * The bound on the search is a backstop, not a policy: a directory with
   * 4096 consecutive taken PIDs is not a thing that happens, and looping
   * forever on a broken claimer would be worse than failing loudly.
   */
  #claimNextPid(): ProcessId {
    const claim = this.#pidClaim;
    if (claim === null) return this.nextPid();
    for (let attempt = 0; attempt < 4096; attempt += 1) {
      const candidate = this.nextPid();
      if (claim(unbrand(candidate))) return candidate;
    }
    trap('EAGAIN', 'allocate', {
      reason: 'could not find an unclaimed PID',
      attempts: 4096,
    });
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
    const pid = opts.pid ?? this.#claimNextPid();
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

    // The rank a process is born at has to be one the kernel can hold. The
    // range is the kernel's own (types.ts), and the kernel is the one that has
    // to hold it: a rank of 99 would sit in the table, be printed in a column
    // that cannot hold it, and be compared against ranks it was never
    // measured on. The CLI refuses one before it gets here; this is the
    // authority behind that refusal.
    if (opts.nice !== undefined && !isValidNice(opts.nice)) {
      trap('EINVAL', 'allocate', {
        nice: opts.nice,
        range: `${NICE_MIN}..${NICE_MAX}`,
        reason: 'a process cannot be born at a priority outside the kernel\'s range',
      });
    }

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
      lastWallAccountAt: now,
      budgetsRemaining,
      budgetsSpent: { ...DEFAULT_SPENT },
      exitCode: null,
      exitReason: null,
      checkpointChain: [],
      pendingSignals: [],
      pendingSignalFrom: [],
      intent: null,
      llmPin: null,
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
      // null = unnarrowed = holds everything (docs/ABI.md §4.9).
      capabilities:
        opts.capabilities === undefined && opts.grantable === undefined
          ? null
          : new Set(opts.capabilities ?? []),
      grantable: new Set(opts.grantable ?? []),
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

    // Report the birth. This is a notification, not part of the allocation:
    // a listener that fails must not stop the process from existing.
    if (this.#onCreate !== null) {
      try {
        await this.#onCreate(entry);
      } catch {
        /* the birth report is best-effort */
      }
    }

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
  async reap(pid: ProcessId, opts?: { retain?: boolean }): Promise<WaitResult> {
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
      // A zombie always knows how it ended: the outcome is recorded when it
      // is decided, before the EXITING transition. The fallback is here for
      // the impossible case, and it is **not** zero — a parent that is told
      // "the child exited 0" will believe the child succeeded, and a child
      // whose ending the kernel cannot name did not succeed.
      exitCode: entry.exitCode ?? 1,
      exitReason: entry.exitReason ?? 'unknown ending',
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

    // Retain the status for the parent so a *late* `wait()` can still collect
    // it — but ONLY when the parent is actually able to collect it:
    //   - `retain !== false`: an active collector (a parked waiter served by the
    //     dispatcher, or a parent calling wait() now) is resolving the result
    //     directly to the caller. Retaining here would let a *subsequent* wait()
    //     collect the same status a second time — real Unix returns ECHILD.
    //   - parent is not init: init never calls `wait()`, so retaining under
    //     PID 1 for every top-level / daemon child is an unbounded leak.
    //   - parent is still present: a gone parent cannot consume its ledger.
    const parentKey = entry.ppid === null ? null : unbrand(entry.ppid);
    const shouldRetain =
      opts?.retain !== false &&
      parentKey !== null &&
      parentKey !== unbrand(PID_INIT) &&
      this.#entries.has(parentKey);
    if (shouldRetain && parentKey !== null) {
      let ledger = this.#reapedChildren.get(parentKey);
      if (ledger === undefined) {
        ledger = new Map<number, WaitResult>();
        this.#reapedChildren.set(parentKey, ledger);
      }
      ledger.set(unbrand(pid), result);
    }

    this.clearQueuedFrom(pid);
    this.#entries.delete(unbrand(pid));
    this.#recorders.delete(unbrand(pid));
    // The reaped process's own ledger is now unreachable — a dead parent cannot
    // wait. Drop it so a long-lived kernel does not grow without bound.
    this.#reapedChildren.delete(unbrand(pid));
    return result;
  }

  // ---------------------------------------------------------------------------
  // §6.2b Retained exit statuses
  // ---------------------------------------------------------------------------

  /**
   * Take the retained status of one reaped child, if the parent has not
   * collected it yet. Consumes it: a second `wait()` for the same child sees
   * nothing, matching real reap semantics.
   */
  takeReapedChild(parentPid: ProcessId, childPid: ProcessId): WaitResult | null {
    const ledger = this.#reapedChildren.get(unbrand(parentPid));
    if (ledger === undefined) return null;
    const result = ledger.get(unbrand(childPid));
    if (result === undefined) return null;
    ledger.delete(unbrand(childPid));
    if (ledger.size === 0) this.#reapedChildren.delete(unbrand(parentPid));
    return result;
  }

  /**
   * Take the oldest retained status for any child of `parentPid`. Used by the
   * `wait()` (any-child) form so a supervisor that waits late still sees
   * children that exited while it was busy, in exit order.
   */
  takeReapedChildAny(parentPid: ProcessId): WaitResult | null {
    const ledger = this.#reapedChildren.get(unbrand(parentPid));
    if (ledger === undefined || ledger.size === 0) return null;
    const [childKey, result] = ledger.entries().next().value as [number, WaitResult];
    ledger.delete(childKey);
    if (ledger.size === 0) this.#reapedChildren.delete(unbrand(parentPid));
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
   *                signal, syscall name, etc.). The trigger is typed: only a
   *                cause on {@link STATE_TRIGGERS} can be recorded.
   *
   * @throws CortexError ESRCH if the PID is absent, EINVAL if the transition
   *         is not in the legal table, ERECORD if recording fails.
   */
  async setState(
    pid: ProcessId,
    next: ProcessState,
    meta: { readonly trigger?: StateTrigger; readonly [key: string]: unknown } = {},
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
    const clockRan = this.#wallClockRuns(entry);
    entry.state = next;
    entry.lastTransitionAt = now;

    // The wall clock follows the process's life: it runs while the process is
    // alive, and it stops when the process stops being alive. The time spent
    // alive before a stop is still the process's; the time spent stopped is
    // not, and charging it would drain a budget for work that is not
    // happening.
    const clockRuns = this.#wallClockRuns(entry);
    if (clockRan && !clockRuns) {
      // The last slice of this process's life — charged, then paused.
      this.#applyWallCharge(entry, this.#accrueWallTime(entry));
    } else if (!clockRan && clockRuns) {
      // The clock starts again now.
      entry.lastWallAccountAt = now;
    }

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
   * Record how the process is going to end.
   *
   * Called the moment the outcome is **decided** — before the EXITING
   * transition — so a reader of the table never sees a process that is on
   * its way out without knowing how it will end. The exit syscall knows the
   * code and the reason before it writes anything; the log frame and the
   * final offset come later, and they are recorded separately.
   *
   * The two used to be one call, and the split is the fix: the exit path
   * walks to EXITING, then *awaits* the recorder to write the exit frame,
   * and only then set the code. Two disk writes sat in that window, and a
   * host that read the table in it saw `exitCode: null` — and the honest
   * reaction to "no exit code" is "it failed", not "it succeeded".
   *
   * docs/PROCESS.md §3.8 says the exit code and reason are recorded in
   * EXITING. Now the code agrees.
   */
  setExitOutcome(pid: ProcessId, code: number, reason: string): void {
    const entry = this.mustGet(pid, 'setExitOutcome');
    entry.exitCode = code;
    entry.exitReason = reason;
  }

  /**
   * Record the final log offset — the byte range the process's log spans.
   *
   * Separate from the outcome because it is only known once the last frame
   * has been written, which is *after* the outcome is decided.
   */
  setFinalLogOffset(pid: ProcessId, offset: SyscallOffset): void {
    const entry = this.mustGet(pid, 'setFinalLogOffset');
    entry.finalLogOffset = offset;
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
   * Who queued a signal, keyed beside `pendingSignals`.
   *
   * `pendingSignals` is part of `ProcessInfo` and stays a list of signal
   * names. The sender is not a field on that list. It lives here so a signal
   * that has to wait can still name who sent it when it is finally delivered.
   * The first sender wins: a second copy of the same signal coalesces, and
   * does not replace the sender.
   */
  #queuedFrom = new Map<string, ProcessId | undefined>();

  #fromKey(pid: ProcessId, signal: Signal): string {
    return `${unbrand(pid)}:${signal}`;
  }

  /**
   * Queue a signal for later delivery. The table does not decide *when* or
   * *whether* to deliver — that is signals.ts. Coalescing (collapsing
   * duplicate pending signals of the same type, per docs/PROCESS.md §11.7)
   * happens here. `from` is the first sender; a later copy of the same
   * signal does not replace it.
   */
  queueSignal(pid: ProcessId, signal: Signal, from?: ProcessId): void {
    const entry = this.mustGet(pid, 'queueSignal');
    // Coalesce: if the same signal is already pending, do not duplicate.
    if (!entry.pendingSignals.includes(signal)) {
      entry.pendingSignals.push(signal);
      entry.pendingSignalFrom.push(from ?? null);
      this.#queuedFrom.set(this.#fromKey(pid, signal), from);
    }
  }

  /** What this process last said it was trying to do. */
  intentOf(pid: ProcessId): Intent | null {
    return this.mustGet(pid, 'intent').intent;
  }

  /** Replace the intent. The caller has already checked the shape. */
  setIntent(pid: ProcessId, intent: Intent): void {
    this.mustGet(pid, 'set_intent').intent = intent;
  }

  /** Model defaults pinned by a shadow fork. Null for every other process. */
  llmPinOf(pid: ProcessId): ShadowSpec | null {
    return this.mustGet(pid, 'fork').llmPin;
  }

  /** Pin the model a shadow child will call. */
  setLlmPin(pid: ProcessId, pin: ShadowSpec): void {
    this.mustGet(pid, 'fork').llmPin = pin;
  }

  /** The sender recorded when `signal` was queued, if one was named. */
  queuedFrom(pid: ProcessId, signal: Signal): ProcessId | undefined {
    return this.#queuedFrom.get(this.#fromKey(pid, signal));
  }

  /** Drop the sender once the signal has been delivered. */
  forgetQueuedFrom(pid: ProcessId, signal: Signal): void {
    this.#queuedFrom.delete(this.#fromKey(pid, signal));
  }

  /** Drop every sender recorded for a process that is leaving the table. */
  clearQueuedFrom(pid: ProcessId): void {
    const prefix = `${unbrand(pid)}:`;
    for (const key of this.#queuedFrom.keys()) {
      if (key.startsWith(prefix)) this.#queuedFrom.delete(key);
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
    entry.pendingSignalFrom = [];
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
    const syscallCount = delta.syscallCount ?? 0;

    // The wall clock is **real time**, and it runs whatever the process is
    // doing. It used to be charged here — and *only* here, and only when the
    // budget was bounded — so an agent that sat in `recv()` never drained it,
    // and a process with no wall budget at all reported "spent 0ms" for a run
    // that had lasted minutes. The kernel's heartbeat charges the same clock
    // (`chargeWallClock`), so it is one number whichever path notices the
    // time passing.
    const wallTimeMs = this.#accrueWallTime(entry) + (delta.wallTimeMs ?? 0);

    entry.budgetsSpent = {
      tokensIn: spent.tokensIn + tokensIn,
      tokensOut: spent.tokensOut + tokensOut,
      tokensCached: spent.tokensCached + tokensCached,
      usdSpent: spent.usdSpent + usdSpent,
      wallTimeMs: spent.wallTimeMs + wallTimeMs,
      syscallCount: spent.syscallCount + syscallCount,
    };

    // The token ceiling is charged for the **input and the output** — and the
    // cached part of the input is inside the input, so it is charged once, not
    // twice (`src/token_usage.ts` is where that is written down). A cached
    // token is a token the provider did not have to read again; it is cheaper
    // in money and the same in work.
    const totalTokens = tokenUsage({ tokensIn, tokensOut, tokensCached: 0 }).total;
    entry.budgetsRemaining = {
      tokens: remaining.tokens < 0 ? -1 : Math.max(0, remaining.tokens - totalTokens),
      usd: remaining.usd < 0 ? -1 : Math.max(0, remaining.usd - usdSpent),
      wallTimeMs:
        remaining.wallTimeMs < 0 ? -1 : Math.max(0, remaining.wallTimeMs - wallTimeMs),
    };
  }

  /**
   * Charge the wall clock.
   *
   * The wall-clock budget is a **ceiling on how long a process may live**, so
   * it has to be charged by time passing — not by the process doing something.
   * An agent that sits in `recv()` for ten minutes spends ten minutes of its
   * budget doing nothing, and the budget that does not notice that is not a
   * ceiling: it is a suggestion. So the kernel charges the clock on its
   * heartbeat (the scheduler's tick), for every process that is alive.
   *
   * With a PID, only that process is charged — which is how the exit path
   * closes the books on the last slice of a process's life.
   */
  chargeWallClock(pid?: ProcessId): void {
    if (pid !== undefined) {
      const entry = this.#entries.get(unbrand(pid));
      if (entry === undefined || !this.#wallClockRuns(entry)) return;
      this.#applyWallCharge(entry, this.#accrueWallTime(entry));
      return;
    }
    for (const entry of this.#entries.values()) {
      if (!this.#wallClockRuns(entry)) continue;
      this.#applyWallCharge(entry, this.#accrueWallTime(entry));
    }
  }

  /**
   * Whether the wall clock is running for this process right now.
   *
   * - **The kernel's own process is not an agent.** Init spends no tokens and
   *   no usd — and no wall clock either. Its liveness is the age of the
   *   kernel, not a cost anybody is paying, and the views that total an
   *   agent's spend would otherwise report the kernel's uptime as if it were
   *   an agent's work.
   * - **A stopped or suspended process is not running.** Its clock is paused
   *   (see {@link WALL_CLOCK_STATES}).
   */
  #wallClockRuns(entry: ProcessEntry): boolean {
    if (unbrand(entry.pid) === unbrand(PID_INIT)) return false;
    return WALL_CLOCK_STATES.has(entry.state);
  }

  /**
   * The wall-clock time to charge since the last accounting pass.
   *
   * Returns the elapsed milliseconds and moves the accounting mark to now.
   * The caller applies it: `spend()` folds it into the counters it is already
   * writing, and `chargeWallClock()` applies it on its own.
   */
  #accrueWallTime(entry: ProcessEntry): number {
    const nowIso = this.#now();
    const elapsed = Date.parse(nowIso) - Date.parse(entry.lastWallAccountAt);
    if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
    entry.lastWallAccountAt = nowIso;
    return elapsed;
  }

  /**
   * Charge `elapsed` milliseconds of wall-clock time to a process.
   *
   * An unlimited budget stays unlimited (`-1`); a bounded one drains, and
   * stops at zero — the scheduler's budget gate does the rest.
   */
  #applyWallCharge(entry: ProcessEntry, elapsed: number): void {
    if (elapsed <= 0) return;
    const remaining = entry.budgetsRemaining.wallTimeMs;
    entry.budgetsSpent = {
      ...entry.budgetsSpent,
      wallTimeMs: entry.budgetsSpent.wallTimeMs + elapsed,
    };
    entry.budgetsRemaining = {
      ...entry.budgetsRemaining,
      wallTimeMs: remaining < 0 ? -1 : Math.max(0, remaining - elapsed),
    };
  }

  /**
   * Check whether any budget is exhausted. Returns 'ok' or the first
   * exhausted kind. Used by the scheduler to decide whether to fire
   * SIGXCPU.
   */
  checkBudget(pid: ProcessId): 'ok' | { readonly kind: BudgetKind } {
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
      // The envelope was redefined (fork inherit/split, restore). Restart the
      // wall-clock accrual window from now so spend() cannot charge time that
      // predates this new budget, nor reuse a stale ancestor's allocation time.
      entry.lastWallAccountAt = this.#now();
    }
    if (patch.spent !== undefined) {
      entry.budgetsSpent = { ...entry.budgetsSpent, ...patch.spent };
    }
  }

  /**
   * Change the rank a process runs at.
   *
   * Kernel-internal: the table holds the fact, and the caller — the scheduler,
   * which owns the `__sched` vocabulary — records the change. Like
   * `setBudgets`, this mutates and says nothing: a table that recorded its own
   * edits would have two places that know what happened.
   *
   * The scheduler reads `nice` **live** at selection time, so a changed rank
   * takes effect at the next dispatch without the run queue being rebuilt.
   *
   * @throws CortexError ESRCH if the PID is absent.
   */
  setNice(pid: ProcessId, nice: number): void {
    const entry = this.mustGet(pid, 'setNice');
    entry.nice = nice;
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

  /**
   * Flush every open recorder to disk.
   *
   * Appends are chained and buffered (see `Recorder.flush`), so a host that
   * wants to read the `.crec` logs — or hand them to another process — must ask
   * for an explicit flush rather than hope the event loop got around to it.
   * `Kernel.settle()` does this on the way out; `shutdown()` should too.
   *
   * Best-effort: a recorder that was already closed (its process was reaped) is
   * skipped rather than failing the whole flush.
   */
  async flushAll(): Promise<void> {
    for (const recorder of this.#recorders.values()) {
      if (recorder === null) continue;
      try {
        await recorder.flush();
      } catch {
        // Already closed, or the fd went away. Nothing useful to do.
      }
    }
  }

  /**
   * Flush and close every recorder still open.
   *
   * `reap()` closes the recorder of the process it removes, which covers every
   * process that actually finishes. It does not cover the ones that never do:
   * init is still RUNNING at shutdown by definition (it cannot exit without
   * crashing the kernel), and a run stopped by `--timeout` may still be alive
   * when the CLI tears down. Those recorders kept their file descriptors open
   * until the host process exited, which Node reports as
   * `Closing file descriptor 3 on garbage collection` — and, on a long-lived
   * host, is an actual descriptor leak rather than a cosmetic warning.
   *
   * Best-effort per recorder, like `flushAll()`: one that is already closed
   * (its process was reaped on the way here) must not stop the rest.
   */
  async closeAllRecorders(): Promise<void> {
    for (const [pid, recorder] of this.#recorders) {
      if (recorder === null) continue;
      try {
        await recorder.close();
      } catch {
        // Already closed, or the fd went away.
      }
      // Drop the reference either way — a recorder we failed to close must not
      // be retried forever on the next shutdown.
      this.#recorders.delete(pid);
    }
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
      // The transition's own `from` and `to` are spread **last**, on purpose:
      // they are what the frame means (ABI.md §6.1 — "`from`, `to`, and the
      // trigger that caused the transition"), and a caller must not be able
      // to shadow them with something else. The signal path used to pass the
      // *sender's* pid under `from`, and the frame recorded that instead of
      // the state the process came from — so the log said a process went
      // "from null", which is not a state at all.
      args: { ...meta, from: prev, to: next },
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
    pendingSignalFrom: [...entry.pendingSignalFrom],
    capabilities:
      entry.capabilities === null ? DEFAULT_CAPABILITIES : [...entry.capabilities],
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
