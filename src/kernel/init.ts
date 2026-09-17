/**
 * cortex kernel — init (PID 1).
 *
 * The first process and the kernel's supervisor. Implements the `InitProcess`
 * interface sketched in docs/ARCHITECTURE.md §4.9 and the supervision duties
 * described in docs/PROCESS.md §4.2, §6.4, §9.
 *
 * ## What init owns
 *
 *   - PID 1 itself: `boot()` allocates it (ppid `null`) and parks it in
 *     RUNNING. Init is hook-driven, not scheduler-driven — the scheduler's
 *     `reconcile()` only adopts READY processes, so a RUNNING init is never
 *     dispatched as an ordinary agent (docs/ARCHITECTURE.md §4.9: "it cannot
 *     exit").
 *   - Orphan reaping: when a process dies, init reparents its children
 *     (`table.reparentOrphans`) and reaps zombies that no live parent will
 *     `wait()` for (docs/PROCESS.md §3, §6.4 — "init inherits the zombie and
 *     reaps it immediately; no double-zombie state").
 *   - SIGCHLD notification: every child that reaches ZOMBIE triggers a
 *     `SIGCHLD` to its parent (docs/ARCHITECTURE.md §4.3). The default
 *     disposition is `ignore`, so this is a cheap wake-up for parents that
 *     registered a handler; everyone else drops it.
 *   - Daemon restart: daemons registered via `registerDaemon()` are restarted
 *     per their `RestartPolicy` (always / on-failure / never), with exponential
 *     backoff, a total `maxRestarts` cap, and sliding-window storm detection
 *     (docs/PROCESS.md §4.2 "restarted 100 times in a minute", §9, §10).
 *   - An audit trail: every supervisory decision is written to init's own
 *     `.crec` as a synthetic `__init` record (double-underscore = kernel
 *     internal, agents cannot invoke it; replay engines treat it as a
 *     supervision event, matching `__state` / `__signal` / `__sched`).
 *
 * ## What init does NOT own
 *
 *   - Running daemon code. A registered daemon is left in READY; the
 *     *scheduler* dispatches it. Init only re-spawns it when it dies.
 *   - The zombie transition itself. signals.ts (signal deaths) and the syscall
 *     dispatcher (#014, normal `exit()`) drive a process to ZOMBIE and then
 *     call `handleZombie()`. Init reacts; it does not kill.
 *   - General supervision policy. docs/PROCESS.md §9.2 keeps rich supervision
 *     (OTP-style trees) in user space; init implements only the kernel-minimal
 *     reaper + daemon-restarter the docs assign to PID 1.
 *
 * ## Wiring (breaking the signals <-> init cycle)
 *
 * signals.ts fires an `OnZombieHook` rather than importing init, precisely so
 * this module can depend on signals without a cycle. The kernel boot code
 * (#014/boot.ts) constructs them in two steps:
 *
 * ```ts
 * let init: InitProcess;
 * const signals = new SignalManager({
 *   table, kernelAbiVersion, now,
 *   onZombie: (pid, code, reason) => init.handleZombie(pid, code, reason),
 * });
 * init = new InitProcess({ table, signals, kernelAbiVersion, now });
 * await init.boot();
 * ```
 *
 * See: docs/ARCHITECTURE.md §4.9, §8; docs/PROCESS.md §3-§4, §6.4, §9-§10
 *
 * @module kernel/init
 */

import {
  type AgentSpec,
  type BudgetLimits,
  type MemoryRegionPolicy,
  type ProcessId,
  type ProcessState,
  type RestartPolicy,
  type Signal,
  type SignalDisposition,
  type Timestamp,
  unbrand,
} from './types.js';
import { CortexError, isCortexError, trap } from './errors.js';
import { PID_INIT, type ProcessTable } from './process_table.js';
import type { SignalManager } from './signals.js';
import type { SyscallRecordInput } from './recorder.js';

// =============================================================================
// §1. Constants
// =============================================================================

/**
 * The built-in agent that "runs" PID 1. Init is not a user agent — its loop is
 * the kernel's own supervision hooks — but the process table requires an
 * `AgentSpec` for every entry, so we register a reserved module specifier.
 * The driver/agent loader (#014, driver_registry) special-cases it.
 */
export const INIT_AGENT_SPEC: AgentSpec = { module: 'cortex:init' };

/** Default exponential-backoff base (docs/PROCESS.md §10: "default 1000"). */
export const DEFAULT_BACKOFF_MS = 1000;

/** Hard ceiling on a single backoff delay, so a long-lived daemon's restart
 *  delay does not grow without bound. */
export const MAX_BACKOFF_MS = 60_000;

/** Exponent ceiling for `2 ** n` backoff (avoids overflow / silly delays). */
export const MAX_BACKOFF_EXPONENT = 16;

/** Default sliding window for restart-storm detection (1 minute). */
export const DEFAULT_RESTART_WINDOW_MS = 60_000;

/**
 * Default number of restarts inside the window that constitutes a "storm"
 * (docs/PROCESS.md §4.2: "a process restarted 100 times in a minute"). When
 * exceeded, init raises an alarm and gives up on that daemon rather than
 * hot-looping forever.
 */
export const DEFAULT_RESTART_STORM_THRESHOLD = 100;

// =============================================================================
// §2. Daemon spec
// =============================================================================

/**
 * A daemon registration. `registerDaemon()` allocates a process with
 * `ppid = PID_INIT`, `daemon = true`, and `autoReap = true` (init reaps its own
 * daemons), then supervises restarts per `restart`.
 *
 * `DaemonSpec` is referenced by docs/ARCHITECTURE.md §4.9 but was never defined
 * in types.ts; it lives here because init is its only consumer in v0. It is a
 * deliberately small subset of `SpawnOptions` — the fields that make sense for
 * a long-lived supervised process.
 */
export interface DaemonSpec {
  readonly role: string;
  readonly agent: AgentSpec;
  /** Restart policy. Defaults to `{ kind: 'never' }` (spawn once, no restart). */
  readonly restart?: RestartPolicy;
  readonly budgets?: Partial<BudgetLimits>;
  readonly nice?: number;
  readonly memory?: Readonly<Record<string, MemoryRegionPolicy>>;
  readonly signals?: Partial<Record<Signal, SignalDisposition>>;
  readonly exitTimeoutMs?: number;
  /**
   * Event names that should wake this daemon (docs/PROCESS.md §9.1
   * `--wake-on`). Metadata only in v0 — recorded with the registration so the
   * CLI/daemon.json can round-trip it; the wake routing lands with drivers.
   */
  readonly wakeOn?: readonly string[];
}

// =============================================================================
// §3. Alarms and shutdown report
// =============================================================================

/**
 * An unusual-termination notice (docs/PROCESS.md §4.2: "log unusual
 * termination patterns"). Surfaced via the injectable `onAlarm` hook so the
 * kernel can log it, increment a metric, or page an operator.
 */
export type InitAlarm =
  | {
      readonly kind: 'restart-storm';
      readonly daemonId: number;
      readonly role: string;
      readonly count: number;
      readonly windowMs: number;
    }
  | {
      readonly kind: 'max-restarts';
      readonly daemonId: number;
      readonly role: string;
      readonly restartCount: number;
      readonly maxRestarts: number;
    };

export type OnAlarmHook = (alarm: InitAlarm) => void;

/**
 * Result of `shutdown()`. Init itself never exits (docs/ARCHITECTURE.md §4.9),
 * so this reports what it quiesced rather than its own death.
 */
export interface ShutdownReport {
  /** PIDs init sent SIGTERM/SIGKILL to. */
  readonly signalled: readonly number[];
  /** PIDs init explicitly reaped in the final sweep. */
  readonly reaped: readonly number[];
  /** Number of pending restart-backoff timers cancelled. */
  readonly restartsCancelled: number;
  /** Children still in the table afterwards (e.g. SUSPENDED, left on disk). */
  readonly remaining: readonly number[];
  readonly finishedAt: Timestamp;
}

// =============================================================================
// §4. Options
// =============================================================================

export interface InitProcessOptions {
  /** The authoritative process registry. */
  readonly table: ProcessTable;
  /**
   * Signal engine. Init uses it to deliver `SIGCHLD` to parents and to
   * terminate children on `shutdown()`. Required.
   */
  readonly signals: SignalManager;
  /** Value written into every `__init` record. */
  readonly kernelAbiVersion: string;
  /** Wall-clock source. Defaults to `() => new Date().toISOString()`. */
  readonly now?: () => Timestamp;
  /** Timer injection for deterministic backoff tests. Defaults to global. */
  readonly setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
  /** Hook for unusual-termination notices (storm / max-restarts). */
  readonly onAlarm?: OnAlarmHook;
  /** Override the default restart-storm threshold (see §1). */
  readonly restartStormThreshold?: number;
}

// =============================================================================
// §5. Internal daemon bookkeeping
// =============================================================================

/**
 * One supervised daemon. `daemonId` is the *original* PID and serves as the
 * stable identity across restarts (PIDs are never reused, so each restart mints
 * a fresh `currentPid`). The storm window and backoff exponent are tracked per
 * logical daemon, not per PID.
 */
interface DaemonRecord {
  readonly daemonId: ProcessId;
  readonly spec: DaemonSpec;
  currentPid: ProcessId;
  restartCount: number;
  /** Epoch-ms of each restart, pruned to the sliding window. */
  restartTimestamps: number[];
  /** Pending backoff timer, if a restart is scheduled but not yet fired. */
  restartTimer: unknown | null;
}

// =============================================================================
// §6. InitProcess
// =============================================================================

/**
 * The PID 1 supervisor. One instance per kernel.
 *
 * Concurrency: like the other kernel modules, this assumes single-threaded JS.
 * `handleZombie()` is async (it awaits signal delivery, reaping, and recording)
 * and is re-entrant across *different* PIDs; restarts of the *same* daemon are
 * serialized by the fact that a daemon must die (and be reaped) before it can
 * die again.
 */
export class InitProcess {
  readonly kernelAbiVersion: string;

  #table: ProcessTable;
  #signals: SignalManager;
  #now: () => Timestamp;
  #setTimeoutFn: (cb: () => void, ms: number) => unknown;
  #clearTimeoutFn: (handle: unknown) => void;
  #onAlarm: OnAlarmHook | null;
  #stormThreshold: number;

  /** Keyed by `unbrand(daemonId)`. */
  #daemons = new Map<number, DaemonRecord>();
  /** Keyed by `unbrand(currentPid)` → `unbrand(daemonId)`. */
  #pidToDaemon = new Map<number, number>();
  /** In-flight deferred restarts, awaited by `shutdown()`. */
  #pendingRestarts = new Set<Promise<void>>();

  #booted = false;
  #shuttingDown = false;
  #recordSeq = 0;

  constructor(opts: InitProcessOptions) {
    this.#table = opts.table;
    this.#signals = opts.signals;
    this.kernelAbiVersion = opts.kernelAbiVersion;
    this.#now = opts.now ?? (() => new Date().toISOString());
    this.#setTimeoutFn =
      opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms) as unknown);
    this.#clearTimeoutFn =
      opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.#onAlarm = opts.onAlarm ?? null;
    this.#stormThreshold = opts.restartStormThreshold ?? DEFAULT_RESTART_STORM_THRESHOLD;
  }

  /** Whether `boot()` has run. */
  get booted(): boolean {
    return this.#booted;
  }

  /** Whether `shutdown()` has begun. */
  get shuttingDown(): boolean {
    return this.#shuttingDown;
  }

  /** Number of registered daemons (logical, across restarts). */
  get daemonCount(): number {
    return this.#daemons.size;
  }

  // ---------------------------------------------------------------------------
  // §6.1 Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Allocate PID 1 and bring it to RUNNING. Idempotency is *not* offered: a
   * second `boot()` is a kernel construction bug and traps `EINVAL` (the same
   * error `allocate()` raises for a PID already in use).
   *
   * Init ends in RUNNING, not READY. The scheduler's `reconcile()` adopts only
   * READY processes, so init is never dispatched as an ordinary agent — it lives
   * entirely in the kernel's supervision hooks (docs/ARCHITECTURE.md §4.9).
   */
  async boot(): Promise<void> {
    if (this.#booted) {
      trap('EINVAL', 'init.boot', {
        pid: unbrand(PID_INIT),
        reason: 'init already booted',
      });
    }

    await this.#table.allocate({
      pid: PID_INIT,
      ppid: null,
      role: 'init',
      agent: INIT_AGENT_SPEC,
    });
    // NEW → READY → RUNNING (both edges are legal, docs/PROCESS.md §5).
    await this.#table.setState(PID_INIT, 'ready', { trigger: 'init-boot' });
    await this.#table.setState(PID_INIT, 'running', { trigger: 'init-boot' });

    this.#booted = true;
    await this.#record('boot', { pid: unbrand(PID_INIT) });
  }

  /**
   * Register a daemon: allocate it as a child of init, mark it `daemon` +
   * `autoReap`, leave it READY for the scheduler, and remember its spec so it
   * can be restarted on death.
   *
   * NOTE: docs/ARCHITECTURE.md §4.9 sketches this as synchronous
   * (`registerDaemon(spec): ProcessId`). It must be `async` because
   * `table.allocate()` opens a `.crec` recorder. This is an additive widening of
   * the doc sketch (same shape as `tick(): Promise<void>` → `Promise<TickOutcome>`),
   * and a doc-fix candidate.
   *
   * @throws CortexError ESTATE if init is not booted or is shutting down.
   */
  async registerDaemon(spec: DaemonSpec): Promise<ProcessId> {
    if (!this.#booted) {
      trap('ESTATE', 'init.registerDaemon', { reason: 'init not booted' });
    }
    if (this.#shuttingDown) {
      trap('ESTATE', 'init.registerDaemon', { reason: 'init is shutting down' });
    }

    const pid = await this.#allocateDaemon(spec);
    const rec: DaemonRecord = {
      daemonId: pid,
      spec,
      currentPid: pid,
      restartCount: 0,
      restartTimestamps: [],
      restartTimer: null,
    };
    this.#daemons.set(unbrand(pid), rec);
    this.#pidToDaemon.set(unbrand(pid), unbrand(pid));

    await this.#record('register-daemon', {
      daemonId: unbrand(pid),
      role: spec.role,
      restart: spec.restart?.kind ?? 'never',
      wakeOn: spec.wakeOn ?? [],
    });
    return pid;
  }

  /**
   * Quiesce the kernel's children: cancel pending restarts, terminate every
   * living child of init (SIGTERM, escalating to SIGKILL for processes that
   * cannot terminate gracefully from NEW/READY/CHECKPOINTING), reap leftover
   * zombies, and report.
   *
   * Init itself is left RUNNING — it cannot exit without crashing the kernel
   * (docs/ARCHITECTURE.md §4.9). Kernel teardown disposes the table separately.
   * SUSPENDED children are left alone (they live on disk and are restored with
   * a fresh PID; docs/PROCESS.md §3.6). Idempotent: a second call returns the
   * first call's report.
   */
  async shutdown(): Promise<ShutdownReport> {
    if (this.#shuttingDown) {
      // Already shut down (or in progress). Return a fresh empty report rather
      // than re-signalling; init is idempotent here on purpose.
      return {
        signalled: [],
        reaped: [],
        restartsCancelled: 0,
        remaining: this.#table.children(PID_INIT).map(unbrand),
        finishedAt: this.#now(),
      };
    }
    this.#shuttingDown = true;

    // 1. Cancel pending restart timers — no daemon comes back during teardown.
    let restartsCancelled = 0;
    for (const rec of this.#daemons.values()) {
      if (rec.restartTimer !== null) {
        this.#clearTimeoutFn(rec.restartTimer);
        rec.restartTimer = null;
        restartsCancelled += 1;
      }
    }

    // 2. Terminate living children. SIGTERM is graceful; from states that
    //    cannot terminate directly it merely queues (signals.ts #applyTerminate),
    //    so we escalate to SIGKILL, which always walks to ZOMBIE. Each death
    //    fires the onZombie hook → handleZombie, which reaps it (parent is init)
    //    and — because #shuttingDown is set — skips the restart.
    const signalled: number[] = [];
    for (const childPid of this.#table.children(PID_INIT)) {
      const entry = this.#table.get(childPid);
      if (entry === undefined) continue;
      if (entry.state === 'zombie' || entry.state === 'suspended') continue;

      signalled.push(unbrand(childPid));
      try {
        await this.#signals.send(childPid, 'SIGTERM', PID_INIT);
      } catch {
        // A child with a `handler` disposition but no invoker traps EINVAL, and
        // a child that raced to a terminal state traps ESRCH. Teardown is
        // best-effort; fall through to the SIGKILL escalation below.
      }

      const after = this.#table.get(childPid);
      if (after !== undefined && after.state !== 'zombie' && after.state !== 'suspended') {
        // SIGTERM was queued/ignored; force it down. SIGKILL bypasses
        // disposition lookup, so it cannot trap EINVAL for a missing invoker.
        try {
          await this.#signals.send(childPid, 'SIGKILL', PID_INIT);
        } catch {
          // Already gone; nothing more to do.
        }
      }
    }

    // 3. Let any in-flight deferred restart finish (it will see #shuttingDown
    //    and not re-spawn, but we still await to reach a quiescent state).
    if (this.#pendingRestarts.size > 0) {
      await Promise.allSettled([...this.#pendingRestarts]);
    }

    // 4. Sweep and reap any zombie children that were not already reaped.
    const reaped: number[] = [];
    for (const childPid of this.#table.children(PID_INIT)) {
      const entry = this.#table.get(childPid);
      if (entry !== undefined && entry.state === 'zombie') {
        await this.#table.reap(childPid);
        reaped.push(unbrand(childPid));
      }
    }

    const remaining = this.#table.children(PID_INIT).map(unbrand);
    const finishedAt = this.#now();
    await this.#record('shutdown', {
      signalled,
      reaped,
      restartsCancelled,
      remaining,
    });

    return { signalled, reaped, restartsCancelled, remaining, finishedAt };
  }

  // ---------------------------------------------------------------------------
  // §6.2 Zombie handling (the OnZombieHook target)
  // ---------------------------------------------------------------------------

  /**
   * React to a process that has just reached ZOMBIE. This is the
   * `OnZombieHook` wired into signals.ts (signal-induced deaths) and is also
   * called by the syscall dispatcher (#014) after a normal `exit()`.
   *
   * Steps (docs/PROCESS.md §3, §4.2, §6.4; docs/ARCHITECTURE.md §4.3):
   *   1. Reparent the dead process's children to init (they are now orphans).
   *   2. Send `SIGCHLD` to the parent (unless the parent *is* init or is gone).
   *   3. Apply the daemon restart policy, if this PID was a registered daemon.
   *   4. Reap if no live parent will `wait()` for it: `autoReap`, parent-is-init,
   *      or parent-gone. Otherwise leave the zombie for the parent.
   *   5. Record the decision on init's log.
   *
   * Defensive: if the PID is already gone (double-notification), this is a
   * no-op. A failing `SIGCHLD` delivery is swallowed so it cannot abort the
   * reap/restart (the parent's death notification is best-effort).
   */
  async handleZombie(pid: ProcessId, exitCode: number, exitReason: string): Promise<void> {
    const entry = this.#table.get(pid);
    if (entry === undefined) {
      // Already reaped (e.g. by a parent's wait() that raced the hook). The
      // dead PID is never reused, so there is nothing left to do.
      return;
    }

    const ppid = entry.ppid;
    const autoReap = entry.autoReap;

    // 1. Orphan reparenting. Works even though `pid` is still a zombie entry;
    //    matches on the children's `ppid`, records nothing itself.
    const orphans = this.#table.reparentOrphans(pid);

    // 1b. Reap any reparented child that is *already* a zombie. init inherits
    //     it and reaps immediately (docs/PROCESS.md §3: "if the parent dies
    //     first, init inherits the zombie and reaps it immediately; there is no
    //     double-zombie state"). Live orphans are left running under init.
    const inheritedReaped: number[] = [];
    for (const orphanPid of orphans) {
      const orphan = this.#table.get(orphanPid);
      if (orphan !== undefined && orphan.state === 'zombie') {
        await this.#table.reap(orphanPid);
        inheritedReaped.push(unbrand(orphanPid));
      }
    }

    // 2. SIGCHLD to the parent (ARCHITECTURE §4.3). Skip init-as-parent (init
    //    is the reaper; signalling itself is pointless) and skip a parent that
    //    is already gone or itself terminal.
    let sigchld = false;
    const parentIsInit = ppid !== null && unbrand(ppid) === unbrand(PID_INIT);
    if (ppid !== null && !parentIsInit && this.#table.has(ppid)) {
      const parent = this.#table.get(ppid);
      if (
        parent !== undefined &&
        parent.state !== 'zombie' &&
        parent.state !== 'suspended'
      ) {
        try {
          await this.#signals.send(ppid, 'SIGCHLD', PID_INIT);
          sigchld = true;
        } catch {
          // Best-effort. A parent with a `handler` disposition but no invoker,
          // or one that died mid-delivery, must not block reaping. signals.ts
          // already records the attempt on the parent's log.
          sigchld = false;
        }
      }
    }

    // 3. Restart decision (daemons only). Looks up the logical daemon by the
    //    dying PID, then schedules or performs the restart.
    const daemonIdNum = this.#pidToDaemon.get(unbrand(pid));
    let restarted: number | null = null;
    if (daemonIdNum !== undefined) {
      const newPid = await this.#maybeRestart(daemonIdNum, exitCode, exitReason);
      if (newPid !== null) restarted = unbrand(newPid);
      // The dying PID no longer maps to a daemon (its replacement, if any, is
      // already registered under a fresh PID by #maybeRestart).
      this.#pidToDaemon.delete(unbrand(pid));
    }

    // 4. Reap if no live parent will wait() for it. init never reaps itself
    //    (PID 1 cannot exit — docs/ARCHITECTURE.md §4.9), so the `ppid === null`
    //    case is excluded by construction.
    const parentGone = ppid !== null && !parentIsInit && !this.#table.has(ppid);
    const isInit = unbrand(pid) === unbrand(PID_INIT);
    const shouldReap =
      !isInit &&
      entry.state === 'zombie' &&
      (autoReap || parentIsInit || parentGone);
    if (shouldReap) {
      await this.#table.reap(pid);
    }

    // 5. Audit.
    await this.#record('reap', {
      pid: unbrand(pid),
      exitCode,
      exitReason,
      reparented: orphans.map(unbrand),
      inheritedReaped,
      sigchld,
      reaped: shouldReap,
      restarted,
    });
  }

  // ---------------------------------------------------------------------------
  // §6.3 Restart policy
  // ---------------------------------------------------------------------------

  /**
   * Decide whether (and when) to restart a daemon that just died. Returns the
   * new PID if the restart happened synchronously (zero backoff), or `null` if
   * no restart is due, the restart was deferred to a timer, or the daemon gave
   * up (max-restarts / storm).
   */
  async #maybeRestart(
    daemonIdNum: number,
    exitCode: number,
    prevExitReason: string,
  ): Promise<ProcessId | null> {
    const rec = this.#daemons.get(daemonIdNum);
    if (rec === undefined) return null;
    if (this.#shuttingDown) return null;

    const policy: RestartPolicy = rec.spec.restart ?? { kind: 'never' };
    if (!shouldRestartFromCode(policy.kind, exitCode)) {
      return null;
    }

    // Total cap (docs/PROCESS.md §10: default Infinity).
    const maxRestarts = policy.maxRestarts ?? Infinity;
    if (rec.restartCount >= maxRestarts) {
      this.#alarm({
        kind: 'max-restarts',
        daemonId: daemonIdNum,
        role: rec.spec.role,
        restartCount: rec.restartCount,
        maxRestarts,
      });
      await this.#record('restart-gave-up', {
        daemonId: daemonIdNum,
        role: rec.spec.role,
        reason: 'max-restarts',
        restartCount: rec.restartCount,
        maxRestarts,
      });
      return null;
    }

    // Sliding-window storm detection (docs/PROCESS.md §4.2). Prune timestamps
    // outside the window, then compare the count against the threshold.
    const nowMs = this.#epochMs();
    const windowMs = policy.windowMs ?? DEFAULT_RESTART_WINDOW_MS;
    rec.restartTimestamps = rec.restartTimestamps.filter((t) => nowMs - t <= windowMs);
    if (rec.restartTimestamps.length >= this.#stormThreshold) {
      this.#alarm({
        kind: 'restart-storm',
        daemonId: daemonIdNum,
        role: rec.spec.role,
        count: rec.restartTimestamps.length,
        windowMs,
      });
      await this.#record('restart-gave-up', {
        daemonId: daemonIdNum,
        role: rec.spec.role,
        reason: 'restart-storm',
        count: rec.restartTimestamps.length,
        windowMs,
      });
      return null;
    }

    // Exponential backoff from the number of restarts already performed.
    const backoffMs = policy.backoffMs ?? DEFAULT_BACKOFF_MS;
    const exponent = Math.min(rec.restartCount, MAX_BACKOFF_EXPONENT);
    const delay = Math.min(backoffMs * 2 ** exponent, MAX_BACKOFF_MS);

    // Bookkeeping advances now, whether the restart is immediate or deferred.
    rec.restartCount += 1;
    rec.restartTimestamps.push(nowMs);

    if (delay <= 0) {
      return await this.#doRestart(rec, prevExitReason);
    }

    // Deferred: schedule and return immediately so we do not block the caller
    // (handleZombie runs inside signals.send / the dispatcher).
    this.#scheduleRestart(rec, prevExitReason, delay);
    return null;
  }

  /**
   * Arm a backoff timer for a deferred restart. The callback re-spawns the
   * daemon and is tracked in `#pendingRestarts` so `shutdown()` can await it.
   */
  #scheduleRestart(rec: DaemonRecord, prevExitReason: string, delay: number): void {
    rec.restartTimer = this.#setTimeoutFn(() => {
      rec.restartTimer = null;
      if (this.#shuttingDown) return;
      const p = this.#doRestart(rec, prevExitReason).then(
        () => undefined,
        () => undefined,
      );
      this.#pendingRestarts.add(p);
      void p.finally(() => this.#pendingRestarts.delete(p));
    }, delay);
  }

  /**
   * Re-spawn a daemon from its stored spec: a brand-new PID, fresh budgets
   * (whatever the spec declares), left READY for the scheduler. Updates the
   * logical-daemon bookkeeping to point at the new PID.
   */
  async #doRestart(rec: DaemonRecord, prevExitReason: string): Promise<ProcessId> {
    const newPid = await this.#allocateDaemon(rec.spec);
    rec.currentPid = newPid;
    this.#pidToDaemon.set(unbrand(newPid), unbrand(rec.daemonId));

    await this.#record('restart', {
      daemonId: unbrand(rec.daemonId),
      newPid: unbrand(newPid),
      role: rec.spec.role,
      restartCount: rec.restartCount,
      prevExitReason,
    });
    return newPid;
  }

  /**
   * Allocate a daemon process and leave it READY. Shared by `registerDaemon()`
   * and `#doRestart()`. Optional fields are conditionally spread because the
   * codebase compiles under `exactOptionalPropertyTypes` (passing an explicit
   * `undefined` for an optional field is an error).
   */
  async #allocateDaemon(spec: DaemonSpec): Promise<ProcessId> {
    const pid = await this.#table.allocate({
      ppid: PID_INIT,
      role: spec.role,
      agent: spec.agent,
      daemon: true,
      // init reaps its own daemons automatically (docs/PROCESS.md §6.4).
      autoReap: true,
      ...(spec.restart !== undefined ? { restart: spec.restart } : {}),
      ...(spec.nice !== undefined ? { nice: spec.nice } : {}),
      ...(spec.budgets !== undefined ? { budgets: spec.budgets } : {}),
      ...(spec.memory !== undefined ? { memory: spec.memory } : {}),
      ...(spec.signals !== undefined ? { signals: spec.signals } : {}),
      ...(spec.exitTimeoutMs !== undefined ? { exitTimeoutMs: spec.exitTimeoutMs } : {}),
    });
    // NEW → READY; the scheduler's reconcile() adopts it on the next tick.
    await this.#table.setState(pid, 'ready', { trigger: 'init-register-daemon' });
    return pid;
  }

  // ---------------------------------------------------------------------------
  // §6.4 Helpers
  // ---------------------------------------------------------------------------

  /**
   * Epoch-ms derived from the injected clock, so the storm window and the
   * record timestamps share one time source. A frozen fake clock yields a
   * stable value; tests advance it to exercise window pruning.
   */
  #epochMs(): number {
    const t = Date.parse(this.#now());
    return Number.isNaN(t) ? 0 : t;
  }

  /** Fire an alarm if a hook is registered. Never throws into the caller. */
  #alarm(alarm: InitAlarm): void {
    if (this.#onAlarm === null) return;
    try {
      this.#onAlarm(alarm);
    } catch {
      // A misbehaving alarm hook must not break supervision.
    }
  }

  /**
   * Append an `__init` record to init's own `.crec` log. Best-effort: a null
   * recorder (pure-state tests) is a silent no-op; a recorder failure is
   * wrapped as ERECORD and rethrown, matching signals.ts / scheduler.ts so a
   * broken audit trail is never silent in production.
   *
   * All init records land on PID 1's log — init is the actor, and its log is
   * the supervision journal. (The reaped child's recorder is closed by
   * `reap()`, so writing there would race the close.)
   */
  async #record(action: string, details: Record<string, unknown>): Promise<void> {
    const recorder = this.#table.recorderFor(PID_INIT);
    if (recorder === null) return;

    const entry = this.#table.get(PID_INIT);
    const stateNow: ProcessState = entry?.state ?? 'running';

    const record: SyscallRecordInput = {
      timestamp: this.#now(),
      pid: PID_INIT,
      syscall: '__init',
      callId: `init-${action}-${this.#recordSeq++}`,
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
      throw new CortexError('ERECORD', '__init', {
        message: `failed to record init ${action}`,
        cause: err,
      });
    }
  }
}

// =============================================================================
// §7. Module helpers
// =============================================================================

/**
 * Pure restart decision from a policy kind and an exit code. `on-failure`
 * restarts only on a non-zero exit; signal deaths carry `128 + signum`
 * (signals.ts `exitCodeForSignal`), which is non-zero, so a SIGKILLed daemon
 * with `on-failure` does restart. Exported for tests.
 */
export function shouldRestartFromCode(
  kind: RestartPolicy['kind'],
  exitCode: number,
): boolean {
  switch (kind) {
    case 'always':
      return true;
    case 'on-failure':
      return exitCode !== 0;
    case 'never':
      return false;
  }
}
