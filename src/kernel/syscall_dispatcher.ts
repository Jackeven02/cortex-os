/**
 * cortex kernel — syscall dispatcher.
 *
 * The front door. Every `ctx.foo(...)` an agent calls lands here. This is the
 * capstone of Phase 1: it wires together every other kernel module behind a
 * single, uniform `invoke()` entry point and enforces the cross-cutting
 * invariants that no individual module owns.
 *
 * ## What the dispatcher does (docs/ARCHITECTURE.md §4.10, §5)
 *
 * Per invocation:
 *
 *   1. Look up the process. Trap `ESRCH` if it is gone.
 *   2. Validate the current state against the syscall's allowed-states table
 *      (docs/ABI.md §4). Trap `ESTATE` if disallowed. **This is the single
 *      place the state gate is enforced** — backend modules deliberately do
 *      not re-check it (e.g. `memory.ts` leaves the RUNNING gate to us).
 *   3. Enforce the `forkable` region rule (docs/STATE.md §5.2): an
 *      `irreversible` syscall inside a forkable region traps `EREVERSIBLE`.
 *   4. Write an `enter` record (docs/ABI.md §6).
 *   5. Route to the implementing module.
 *   6. Account budget counters; fire `SIGXCPU` if one hits zero.
 *   7. Write an `exit` or `trap` record.
 *   8. Return the result, or rethrow the `CortexError`.
 *
 * ## Recording ownership — a v0 deviation, stated honestly
 *
 * docs/ARCHITECTURE.md §4.10 says the dispatcher is "the only place syscalls
 * are ... recorded." In the kernel as actually built, four modules predate
 * this file and already write their own syscall records: `memory.ts`
 * (`memory_read` / `memory_write`), `ipc.ts` (`send` / `recv`), `fork.ts`
 * (`fork`), and `checkpoint.ts` (`checkpoint` / `restore`). Re-recording them
 * here would double every log line and break their smoke checks.
 *
 * So v0 splits the duty:
 *
 *   - **Self-recorded syscalls** (`SELF_RECORDED` below) are routed and gated
 *     here, but the *record* is written by the owning module. The dispatcher
 *     still enforces state, reversibility, and budget for them.
 *   - **Dispatcher-recorded syscalls** (everything else) get the full
 *     `enter` + `exit`/`trap` pair written here.
 *   - **Unrecorded syscalls** (`budget`) are never logged, per docs/ABI.md
 *     §4.8 ("would bloat logs; derived from other syscalls' recordings").
 *
 * Collapsing the self-recorded modules onto the dispatcher is a documented
 * follow-up (it touches four modules and their tests); it is deliberately not
 * done in this commit. See docs/ARCHITECTURE.md §4.10 doc-fix note.
 *
 * ## What v0 does NOT wire yet
 *
 *   - **Agent execution.** `spawn` allocates and readies a child; the loop
 *     that actually imports and runs the agent module is `boot.ts` (Phase 3).
 *   - **Real drivers.** `llm_call` / `tool_call` route through injected
 *     resolver hooks. With no resolver configured they trap `EDRIVER` /
 *     `ENOENT`. `driver_registry.ts` (next) supplies the real resolvers.
 *   - **`wait()` wake on an externally-killed child.** `wait()` parks and is
 *     woken when the child exits *through this dispatcher*. A child killed by
 *     a signal goes straight through `signals → init.handleZombie`, which does
 *     not yet call back into the dispatcher's waiter table. Closing that loop
 *     is a `boot.ts` wiring task; the synchronous (already-zombie) path and
 *     the dispatcher-driven exit path both work today.
 *
 * See: docs/ABI.md §4, §5, §6; docs/ARCHITECTURE.md §4.10, §5;
 *      docs/PROCESS.md §5, §6.4, §9; docs/STATE.md §5.2
 *
 * @module kernel/syscall_dispatcher
 */

import {
  type AgentSpec,
  type BudgetCounters,
  type Capability,
  type ChainId,
  type ChannelId,
  type CheckpointOptions,
  type DriverContext,
  type ForkOptions,
  type ForkResult,
  type ILLMDriver,
  type IMemoryDriver,
  type IpcMessage,
  type IToolDriver,
  type LLMRequest,
  type LLMResponse,
  type MemoryEntry,
  type MemoryQuery,
  type MemoryWriteOptions,
  type PersistedProcessMeta,
  type ProcessFilter,
  type ProcessId,
  type ProcessInfo,
  type ProcessState,
  type RandomOptions,
  type RecvOptions,
  type RestoreOptions,
  type Reversibility,
  type SendOptions,
  type Signal,
  type SignalDisposition,
  type SignalHandler,
  type SpawnOptions,
  type Timestamp,
  type ToolCallOptions,
  type ToolDescriptor,
  type ToolInvokeContext,
  type ToolResult,
  type WaitOptions,
  type WaitResult,
  asProcessId,
  unbrand,
  CAPABILITIES,
  DEFAULT_CAPABILITIES,
} from './types.js';
import { CortexError, isCortexError, trap } from './errors.js';
import { PID_KERNEL, type ProcessTable } from './process_table.js';
import type { SignalManager } from './signals.js';
import type { IpcManager, ChannelOpenOptions } from './ipc.js';
import type { MemoryManager } from './memory.js';
import type { CheckpointManager } from './checkpoint.js';
import type { ForkManager } from './fork.js';
import type { InitProcess } from './init.js';
import type { Scheduler } from './scheduler.js';
import type { WakeGate } from './wake_gate.js';
import type { SyscallRecordInput } from './recorder.js';

// =============================================================================
// §1. The syscall name space
// =============================================================================

/**
 * The twenty-four 1.0 syscalls (docs/ABI.md §4). `forkable()` is a structured
 * wrapper, not a syscall, and is exposed separately as `runForkable`.
 *
 * `acquire` / `release` / `caps` are the capability system of §4.9, which
 * docs/ABI.md §9.2 promised for v1. `channel_open` / `channel_close` are the
 * explicit channel lifecycle §9.3 promised (and §10 predicted would land by
 * 0.2 — it did not; it lands here).
 */
export type SyscallName =
  | 'spawn'
  | 'wait'
  | 'exit'
  | 'kill'
  | 'ps'
  | 'fork'
  | 'checkpoint'
  | 'restore'
  | 'llm_call'
  | 'tool_call'
  | 'memory_read'
  | 'memory_write'
  | 'send'
  | 'recv'
  | 'sleep'
  | 'now'
  | 'random'
  | 'on_signal'
  | 'budget'
  | 'acquire'
  | 'release'
  | 'caps'
  | 'channel_open'
  | 'channel_close';

/** Every syscall name as a runtime array (for tooling and validation). */
export const SYSCALL_NAMES: readonly SyscallName[] = Object.freeze([
  'spawn',
  'wait',
  'exit',
  'kill',
  'ps',
  'fork',
  'checkpoint',
  'restore',
  'llm_call',
  'tool_call',
  'memory_read',
  'memory_write',
  'send',
  'recv',
  'sleep',
  'now',
  'random',
  'on_signal',
  'budget',
  'acquire',
  'release',
  'caps',
  'channel_open',
  'channel_close',
]);

/**
 * Positional argument tuples per syscall, mirroring the `CortexContext`
 * method shapes in docs/ABI.md §8 exactly. The dispatcher's `invoke` is
 * variadic over these so `invoke(pid, 'kill', target, sig)` type-checks the
 * same way `ctx.kill(target, sig)` does.
 */
export interface SyscallArgs {
  spawn: [opts: SpawnOptions];
  wait: [pid?: ProcessId, opts?: WaitOptions];
  exit: [code: number, reason?: string];
  kill: [pid: ProcessId, signal: Signal];
  ps: [filter?: ProcessFilter];
  fork: [opts?: ForkOptions];
  checkpoint: [opts?: CheckpointOptions];
  restore: [chainId: ChainId, opts?: RestoreOptions];
  llm_call: [req: LLMRequest];
  tool_call: [name: string, args: unknown, opts?: ToolCallOptions];
  memory_read: [region: string, query: MemoryQuery];
  memory_write: [region: string, key: string, value: unknown, opts?: MemoryWriteOptions];
  send: [target: ProcessId | ChannelId, message: unknown, opts?: SendOptions];
  recv: [source?: ChannelId, opts?: RecvOptions];
  sleep: [ms: number];
  now: [];
  random: [opts?: RandomOptions];
  on_signal: [signal: Signal, handler: SignalHandler | 'default' | 'ignore'];
  budget: [];
  acquire: [cap: Capability];
  release: [cap: Capability];
  caps: [];
  channel_open: [opts?: ChannelOpenOptions];
  channel_close: [channel: ChannelId];
}

/** Return type per syscall (docs/ABI.md §8). */
export interface SyscallReturn {
  spawn: { readonly pid: ProcessId };
  wait: WaitResult;
  exit: never;
  kill: void;
  ps: readonly ProcessInfo[];
  fork: ForkResult;
  checkpoint: { readonly chainId: ChainId };
  restore: { readonly pid: ProcessId };
  llm_call: LLMResponse;
  tool_call: ToolResult;
  memory_read: readonly MemoryEntry[];
  memory_write: void;
  send: void;
  recv: IpcMessage;
  sleep: void;
  now: Timestamp;
  random: number;
  on_signal: void;
  budget: BudgetCounters;
  acquire: void;
  release: void;
  caps: readonly Capability[];
  channel_open: { readonly channelId: ChannelId };
  channel_close: void;
}

// =============================================================================
// §2. Policy tables
// =============================================================================

/** The eight non-terminal states. "any" in docs/ABI.md §4 means these. */
const ANY_LIVE_STATE: readonly ProcessState[] = Object.freeze([
  'new',
  'ready',
  'running',
  'blocked',
  'stopped',
  'checkpointing',
  'suspended',
  'exiting',
]);

/**
 * Allowed caller states per syscall, transcribed from the "Allowed states"
 * line of each entry in docs/ABI.md §4. A caller in any other state traps
 * `ESTATE` before any side effect occurs.
 */
export const SYSCALL_ALLOWED_STATES: Readonly<Record<SyscallName, readonly ProcessState[]>> =
  Object.freeze({
    spawn: ['running'],
    wait: ['running'],
    exit: ANY_LIVE_STATE,
    kill: ['running'],
    ps: ['running'],
    fork: ['running', 'blocked', 'stopped', 'suspended'],
    checkpoint: ['running', 'blocked', 'stopped'],
    restore: ['running'],
    llm_call: ['running'],
    tool_call: ['running'],
    memory_read: ['running'],
    memory_write: ['running'],
    send: ['running'],
    recv: ['running'],
    sleep: ['running'],
    now: ANY_LIVE_STATE,
    random: ANY_LIVE_STATE,
    on_signal: ['running'],
    budget: ANY_LIVE_STATE,
    acquire: ['running'],
    release: ANY_LIVE_STATE,
    caps: ANY_LIVE_STATE,
    channel_open: ['running'],
    channel_close: ['running'],
  });

/**
 * Static reversibility tag per syscall (docs/ABI.md §4, docs/STATE.md §5.1).
 * Two syscalls refine this at runtime: `kill` (by signal) and `tool_call`
 * (by the driver's declared tag). The static value is the pre-route default
 * used for the `forkable` pre-check and for recording.
 */
export const SYSCALL_REVERSIBILITY: Readonly<Record<SyscallName, Reversibility>> = Object.freeze({
  spawn: 'reversible',
  wait: 'idempotent',
  exit: 'irreversible',
  kill: 'reversible',
  ps: 'idempotent',
  fork: 'reversible',
  checkpoint: 'idempotent',
  restore: 'reversible',
  llm_call: 'reversible',
  tool_call: 'reversible',
  memory_read: 'idempotent',
  memory_write: 'reversible',
  send: 'idempotent',
  recv: 'irreversible',
  sleep: 'idempotent',
  now: 'idempotent',
  random: 'idempotent',
  on_signal: 'reversible',
  budget: 'idempotent',
  acquire: 'reversible',
  release: 'reversible',
  caps: 'idempotent',
  channel_open: 'reversible',
  channel_close: 'reversible',
});

/**
 * Signals whose delivery cannot be undone. docs/ABI.md §4.1: "`SIGKILL` and
 * `SIGTERM` are `irreversible`; `SIGUSR1`/`SIGUSR2`/`SIGCONT` are
 * `reversible`." We extend the irreversible set to every signal whose default
 * action terminates or stops the target, and keep the advisory / control
 * signals reversible.
 */
const IRREVERSIBLE_SIGNALS: ReadonlySet<Signal> = new Set<Signal>([
  'SIGHUP',
  'SIGINT',
  'SIGTERM',
  'SIGKILL',
  'SIGSTOP',
  'SIGXCPU',
  'SIGXFSZ',
  'SIGSYS',
]);

/** Reversibility of a `kill` given its signal. */
export function killReversibility(signal: Signal): Reversibility {
  return IRREVERSIBLE_SIGNALS.has(signal) ? 'irreversible' : 'reversible';
}

/**
 * Syscalls whose owning module already writes the `.crec` record. The
 * dispatcher gates and routes these but does not record them again — see the
 * module header "Recording ownership".
 */
export const SELF_RECORDED_SYSCALLS: ReadonlySet<SyscallName> = new Set<SyscallName>([
  'memory_read',
  'memory_write',
  'send',
  'recv',
  'fork',
  'checkpoint',
  'restore',
]);

/** Syscalls never recorded (docs/ABI.md §4.8). */
export const UNRECORDED_SYSCALLS: ReadonlySet<SyscallName> = new Set<SyscallName>([
  'budget',
  'caps',
]);

/**
 * Capability required for a syscall, when the requirement does not depend on
 * the arguments (docs/ABI.md §4.9).
 *
 * Only the unconditional gates live here. Three syscalls gate on *who or what*
 * you are touching rather than on the mere fact of the call, and are checked
 * inside their handlers where the argument is available:
 *
 * - `kill`  → `kill` capability only when the target is not your descendant
 *             and not in your process group. Killing your own children and
 *             your own group is always allowed; that is what makes a
 *             supervision tree work without handing out a capability.
 * - `tool_call` → `tool:dangerous` only when the driver tagged the tool
 *             `irreversible` (docs/STATE.md §5.1). Reversible tools stay
 *             callable by an unprivileged leaf.
 * - `send`  → `ipc:any` only when the target is a stranger, same rule as
 *             `kill`.
 *
 * A syscall absent from this table needs no capability.
 */
export const SYSCALL_REQUIRED_CAPABILITY: Readonly<Partial<Record<SyscallName, Capability>>> =
  Object.freeze({
    spawn: 'spawn',
    fork: 'fork',
  });

// =============================================================================
// §3. Exit sentinel
// =============================================================================

/**
 * Thrown by `exit()` after the process has been torn down. It is *not* a
 * `CortexError` — exiting is not an error — and the dispatcher's trap recorder
 * recognises it and lets it propagate untouched so it can unwind the agent's
 * async function. `boot.ts`'s agent runner catches it to stop the loop.
 */
export class ProcessExitSignal extends Error {
  readonly exitCode: number;
  readonly exitReason: string;

  constructor(exitCode: number, exitReason: string) {
    super(`process exited with code ${exitCode}${exitReason ? ` (${exitReason})` : ''}`);
    this.name = 'ProcessExitSignal';
    this.exitCode = exitCode;
    this.exitReason = exitReason;
  }
}

/** Type guard for the exit sentinel. */
export function isProcessExitSignal(err: unknown): err is ProcessExitSignal {
  return err instanceof ProcessExitSignal || (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'ProcessExitSignal'
  );
}

// =============================================================================
// §4. Driver resolver hooks
// =============================================================================

/**
 * Resolves the LLM driver for a call. `name` is `req.driver` (may be
 * undefined → the kernel default). Supplied by `driver_registry.ts`; absent
 * until then, which makes `llm_call` trap `EDRIVER`.
 */
export type ResolveLLMHook = (name: string | undefined) => ILLMDriver;

/**
 * Resolves a tool by name to its driver + static descriptor. Returns
 * undefined when no registered driver provides the tool (`tool_call` then
 * traps `ENOENT`). Supplied by `driver_registry.ts`.
 */
export type ResolveToolHook = (
  name: string,
) => { readonly driver: IToolDriver; readonly descriptor: ToolDescriptor } | undefined;

// =============================================================================
// §5. Options
// =============================================================================

export interface DispatcherOptions {
  /** The authoritative process registry. Required. */
  readonly table: ProcessTable;
  /** Signal engine — `kill`, `SIGCHLD`, `SIGXCPU`. Required. */
  readonly signals: SignalManager;
  /** Value written into every record's `kernelAbiVersion` field. */
  readonly kernelAbiVersion: string;

  // Backend modules. Optional so the dispatcher can be exercised before every
  // module is wired (and in focused unit tests); routing to an absent module
  // traps a clear errno rather than throwing a null deref.
  readonly ipc?: IpcManager;
  readonly memory?: MemoryManager;
  readonly checkpoint?: CheckpointManager;
  readonly fork?: ForkManager;
  readonly init?: InitProcess;
  readonly scheduler?: Scheduler;

  /** Wall-clock source. Defaults to `() => new Date().toISOString()`. */
  readonly now?: () => Timestamp;
  /** Call-id source for `enter`/`exit` correlation. Injectable for tests. */
  readonly nextCallId?: () => string;
  /** Deterministic RNG for `random()` (replay serves recorded values). */
  readonly random?: (opts?: RandomOptions) => number;
  /** Default LLM timeout when `req.timeoutMs` is absent. */
  readonly defaultLlmTimeoutMs?: number;
  /** Default tool timeout when the descriptor omits one. */
  readonly defaultToolTimeoutMs?: number;

  readonly resolveLLM?: ResolveLLMHook;
  readonly resolveTool?: ResolveToolHook;

  /** Timer injection so `sleep` is testable without real delays. */
  readonly setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;

  /**
   * Fired after a syscall drives a budget to zero, just before `SIGXCPU`.
   * The supervisor uses it to log; the scheduler's own budget gate remains
   * the backstop on the next tick.
   */
  readonly onBudgetExhausted?: (
    pid: ProcessId,
    kind: 'tokens' | 'usd' | 'wallTime',
  ) => void | Promise<void>;

  /**
   * Persist a process's metadata at exit (see `KernelOptions.onProcessExit`).
   * The kernel calls this at the ZOMBIE transition — before `init` reaps the
   * entry — so every process (including those an agent spawned internally via
   * `ctx.spawn()`) lands a `meta.json` the read-only CLI commands can show.
   */
  readonly onProcessExit?: (meta: PersistedProcessMeta) => void | Promise<void>;

  /**
   * The kernel's wake gate. When present, a parked `wait()` is *not* resolved
   * the instant its child zombifies — the resolution is deferred until the
   * scheduler puts the parent back on the CPU, so the agent's next syscall sees
   * RUNNING rather than the transient BLOCKED/READY of the wake itself. See
   * `wake_gate.ts` for the race this closes. Absent ⇒ resolve immediately (the
   * pre-rework behaviour, still correct when continuations run to completion).
   */
  readonly wakeGate?: WakeGate;
}

/** Default LLM call timeout (docs/ABI.md §4.3). */
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;
/** Default tool call timeout (docs/ABI.md §5). */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

// =============================================================================
// §6. Waiter bookkeeping
// =============================================================================

/** A parked `wait()` call, resolved when the awaited child zombifies. */
interface Waiter {
  readonly parentPid: ProcessId;
  /** Specific child awaited, or null for "any child". */
  readonly childPid: ProcessId | null;
  resolve: (result: WaitResult) => void;
  reject: (err: unknown) => void;
  settled: boolean;
  /** Timeout timer, present only when `wait()` was called with a `timeoutMs`. */
  timer: unknown | null;
}

// =============================================================================
// §7. SyscallDispatcher
// =============================================================================

/**
 * The syscall front door. One instance per kernel.
 *
 * Concurrency: single-threaded JS like every other kernel module. `invoke` is
 * async; concurrent invocations from different agents interleave only at
 * `await` points, and each backend module serialises its own recorder writes.
 */
export class SyscallDispatcher {
  readonly kernelAbiVersion: string;

  #table: ProcessTable;
  #signals: SignalManager;
  #ipc: IpcManager | null;
  #memory: MemoryManager | null;
  #checkpointMgr: CheckpointManager | null;
  #fork: ForkManager | null;
  #init: InitProcess | null;
  #scheduler: Scheduler | null;

  #now: () => Timestamp;
  #nextCallId: () => string;
  #random: (opts?: RandomOptions) => number;
  #defaultLlmTimeoutMs: number;
  #defaultToolTimeoutMs: number;
  #resolveLLM: ResolveLLMHook | null;
  #resolveTool: ResolveToolHook | null;
  #setTimeoutFn: (cb: () => void, ms: number) => unknown;
  #clearTimeoutFn: (handle: unknown) => void;
  #onBudgetExhausted: DispatcherOptions['onBudgetExhausted'];
  #onProcessExit: DispatcherOptions['onProcessExit'];
  #wakeGate: WakeGate | null;

  /** pid → forkable-region nesting depth. */
  #forkableDepth = new Map<number, number>();
  /** Parked `wait()` calls awaiting a specific child. */
  #waitersByChild = new Map<number, Waiter[]>();
  /** Parked `wait()` calls awaiting any child of a parent. */
  #waitersAny = new Map<number, Waiter[]>();
  /** pid → handle of the timer armed by a pending `sleep()`. */
  #sleepHandles = new Map<number, unknown>();
  /** pid → records of synchronous syscalls awaiting their next flush. */
  #syncPending = new Map<number, SyscallRecordInput[]>();
  /**
   * Capability state lives on the process-table entry (`entry.capabilities`
   * / `entry.grantable`), **not** here — it is process state, so it has to
   * survive `checkpoint` → `restore` and be visible to `ps` without going
   * through the dispatcher. See docs/ABI.md §4.9.
   */

  #callCounter = 0;

  constructor(opts: DispatcherOptions) {
    this.#table = opts.table;
    this.#signals = opts.signals;
    this.kernelAbiVersion = opts.kernelAbiVersion;
    this.#ipc = opts.ipc ?? null;
    this.#memory = opts.memory ?? null;
    this.#checkpointMgr = opts.checkpoint ?? null;
    this.#fork = opts.fork ?? null;
    this.#init = opts.init ?? null;
    this.#scheduler = opts.scheduler ?? null;
    this.#now = opts.now ?? (() => new Date().toISOString());
    this.#random = opts.random ?? (() => Math.random());
    this.#defaultLlmTimeoutMs = opts.defaultLlmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.#defaultToolTimeoutMs = opts.defaultToolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.#resolveLLM = opts.resolveLLM ?? null;
    this.#resolveTool = opts.resolveTool ?? null;
    this.#setTimeoutFn = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms) as unknown);
    this.#clearTimeoutFn =
      opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    if (opts.onBudgetExhausted !== undefined) {
      this.#onBudgetExhausted = opts.onBudgetExhausted;
    }
    if (opts.onProcessExit !== undefined) {
      this.#onProcessExit = opts.onProcessExit;
    }
    this.#wakeGate = opts.wakeGate ?? null;
    const explicitCallId = opts.nextCallId;
    this.#nextCallId =
      explicitCallId ??
      (() => {
        this.#callCounter += 1;
        return `sc-${this.#callCounter}`;
      });
  }

  // ---------------------------------------------------------------------------
  // §7.1 The front door
  // ---------------------------------------------------------------------------

  /**
   * Dispatch one syscall. The single entry point behind every `CortexContext`
   * method.
   *
   * @throws CortexError ESRCH (no such process), ESTATE (state gate),
   *         EREVERSIBLE (irreversible call in a forkable region), or whatever
   *         the routed module raises. `exit` throws `ProcessExitSignal`.
   */
  async invoke<S extends SyscallName>(
    pid: ProcessId,
    syscall: S,
    ...args: SyscallArgs[S]
  ): Promise<SyscallReturn[S]> {
    const entry = this.#table.get(pid);
    if (entry === undefined) {
      trap('ESRCH', syscall, { pid: unbrand(pid) });
    }
    const stateBefore = entry.state;

    // §4.10 step 2 — the uniform state gate.
    assertStateIn(stateBefore, SYSCALL_ALLOWED_STATES[syscall], syscall);

    // §4.10 step 2.5 — the capability gate (docs/ABI.md §4.9). Runs before
    // the forkable check and before any side effect. Conditional gates (kill /
    // send / tool_call) are inside their handlers, where the argument that
    // decides them is in scope.
    this.#checkCapability(pid, syscall);

    // §4.10 step 4 — forkable-region enforcement (static tag; `tool_call`
    // and `kill` refine theirs inside the handler before any side effect).
    const staticReversibility = SYSCALL_REVERSIBILITY[syscall];
    if (staticReversibility === 'irreversible' && this.#inForkable(pid)) {
      trap('EREVERSIBLE', syscall, {
        pid: unbrand(pid),
        reversibility: staticReversibility,
      });
    }

    const callId = this.#nextCallId();
    const selfRecorded = SELF_RECORDED_SYSCALLS.has(syscall);
    const recorded = !selfRecorded && !UNRECORDED_SYSCALLS.has(syscall);
    const startedAt = Date.now();

    // Anything the body did *synchronously* since its last syscall (now /
    // random / on_signal) is recorded here — before this syscall's own `enter`
    // frame, so the log still reads in the order it happened.
    await this.flushSyncCalls(pid);

    if (recorded) {
      await this.#write(pid, syscall, callId, 'enter', {
        stateBefore,
        stateAfter: stateBefore,
        reversibility: staticReversibility,
        args: recordArgs(args),
      });
    }

    try {
      const result = (await this.#route(pid, syscall, args, callId)) as SyscallReturn[S];

      // §4.10 step 9 — budget accounting (skipped for `exit`, which throws).
      this.#account(pid, syscall, result);

      const stateAfter = this.#table.get(pid)?.state ?? stateBefore;
      if (recorded) {
        await this.#write(pid, syscall, callId, 'exit', {
          stateBefore,
          stateAfter,
          reversibility: this.#actualReversibility(syscall, args, result),
          result: recordResult(syscall, result),
          durationMs: Date.now() - startedAt,
        });
      }
      return result;
    } catch (err) {
      // `exit` tears down and records itself, then throws the sentinel.
      if (isProcessExitSignal(err)) throw err;
      if (recorded && isCortexError(err)) {
        const stateAfter = this.#table.get(pid)?.state ?? stateBefore;
        await this.#write(pid, syscall, callId, 'trap', {
          stateBefore,
          stateAfter,
          reversibility: staticReversibility,
          error: {
            errno: err.errno,
            message: err.message,
            ...(err.details !== undefined ? { details: err.details } : {}),
          },
          durationMs: Date.now() - startedAt,
        }).catch(() => {
          /* a trap record that itself fails must not mask the original error */
        });
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // §7.1b The synchronous syscalls' recording path
  // ---------------------------------------------------------------------------

  /**
   * Queue a record for a **synchronous** syscall (`now`, `random`,
   * `on_signal`) — one that `CortexContext` serves without ever awaiting
   * anything (docs/ABI.md §8).
   *
   * Why a queue and not a direct write: the recorder is async (it awaits a
   * framed append), and a sync method cannot await it. Fire-and-forget
   * appends would land out of order against the enter/exit pairs of the
   * syscalls around them. So the record is built *now* — capturing the exact
   * value the caller is about to receive, which is what replay needs — and
   * written at the next async boundary, which is the start of the process's
   * next `invoke` (see `#flushSync`). Order is preserved: everything the body
   * did synchronously since its last syscall is recorded before the next
   * syscall's `enter` frame.
   *
   * Each sync syscall is one frame, not an enter/exit pair: it has no
   * duration and cannot fail after its state gate. The frame is `phase:
   * 'exit'` and carries both `args` and `result`.
   *
   * `budget` is deliberately *not* queued — ABI §4.8 keeps it unrecorded by
   * policy (it is derivable from the syscalls that spent it).
   */
  noteSyncCall(
    pid: ProcessId,
    syscall: SyscallName,
    args: unknown,
    result: unknown,
  ): void {
    if (this.#table.recorderFor(pid) === null) return;
    const state = this.#table.get(pid)?.state ?? 'running';
    const list = this.#syncPending.get(unbrand(pid)) ?? [];
    list.push({
      timestamp: this.#now(),
      pid,
      syscall,
      callId: this.#nextCallId(),
      phase: 'exit',
      stateBefore: state,
      stateAfter: state,
      reversibility: SYSCALL_REVERSIBILITY[syscall],
      kernelAbiVersion: this.kernelAbiVersion,
      ...(args !== undefined ? { args } : {}),
      ...(result !== undefined ? { result } : {}),
    });
    this.#syncPending.set(unbrand(pid), list);
  }

  /** Flush queued sync-syscall records for `pid`. Idempotent. */
  async flushSyncCalls(pid: ProcessId): Promise<void> {
    const list = this.#syncPending.get(unbrand(pid));
    if (list === undefined || list.length === 0) return;
    this.#syncPending.delete(unbrand(pid));
    const recorder = this.#table.recorderFor(pid);
    if (recorder === null) return;
    for (const rec of list) {
      try {
        await recorder.append(rec);
      } catch (err) {
        if (isCortexError(err)) throw err;
        throw new CortexError('ERECORD', rec.syscall, {
          message: `failed to record a deferred ${rec.syscall}`,
          details: { pid: unbrand(pid), phase: rec.phase },
          cause: err,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // §7.2 Forkable regions (docs/STATE.md §5.2)
  // ---------------------------------------------------------------------------

  /**
   * Run `fn` inside a forkable region for `pid`. While the region is open,
   * any `irreversible` syscall traps `EREVERSIBLE`. Regions nest; the
   * enforcement lifts only when the outermost one closes.
   *
   * This backs `ctx.forkable(async () => { ... })`.
   */
  async runForkable<T>(pid: ProcessId, fn: () => Promise<T>): Promise<T> {
    const key = unbrand(pid);
    this.#forkableDepth.set(key, (this.#forkableDepth.get(key) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const depth = (this.#forkableDepth.get(key) ?? 1) - 1;
      if (depth <= 0) this.#forkableDepth.delete(key);
      else this.#forkableDepth.set(key, depth);
    }
  }

  /** Whether `pid` is currently inside at least one forkable region. */
  inForkableRegion(pid: ProcessId): boolean {
    return this.#inForkable(pid);
  }

  #inForkable(pid: ProcessId): boolean {
    return (this.#forkableDepth.get(unbrand(pid)) ?? 0) > 0;
  }

  // ---------------------------------------------------------------------------
  // §7.3b Capabilities (docs/ABI.md §4.9)
  // ---------------------------------------------------------------------------

  /**
   * Seed a process's capabilities at creation time.
   *
   * Called by `#spawn` for children and by boot for the top-level process.
   * **Both arguments omitted means "leave it fully privileged"** — the
   * caller said nothing about capabilities, so the process behaves exactly as
   * it would have before 1.0. Passing either argument narrows it.
   */
  setCapabilities(
    pid: ProcessId,
    capabilities?: readonly Capability[],
    grantable?: readonly Capability[],
  ): void {
    if (capabilities === undefined && grantable === undefined) return;
    const entry = this.#table.get(pid);
    if (entry === undefined) return;
    entry.capabilities = new Set(capabilities ?? []);
    entry.grantable = new Set(grantable ?? []);
  }

  /** Capabilities `pid` currently holds. Unnarrowed processes hold all. */
  capabilitiesOf(pid: ProcessId): readonly Capability[] {
    const entry = this.#table.get(pid);
    if (entry === undefined || entry.capabilities === null) return DEFAULT_CAPABILITIES;
    return [...entry.capabilities];
  }

  /**
   * Whether `pid` holds `cap`. Unnarrowed processes hold everything.
   *
   * `admin` is deliberately *not* treated as "holds everything": it governs
   * `acquire` (it may raise any capability, ignoring the grantable pool), not
   * the checks themselves. Conflating the two would make `admin` impossible
   * to reason about — you could never tell whether an action was permitted or
   * merely acquirable.
   */
  hasCapability(pid: ProcessId, cap: Capability): boolean {
    const entry = this.#table.get(pid);
    if (entry === undefined || entry.capabilities === null) return true;
    return entry.capabilities.has(cap);
  }

  /** Trap `EPERM` unless `pid` holds `cap`. */
  #requireCapability(pid: ProcessId, syscall: SyscallName, cap: Capability): void {
    if (this.hasCapability(pid, cap)) return;
    trap('EPERM', syscall, {
      pid: unbrand(pid),
      capability: cap,
      held: [...this.capabilitiesOf(pid)],
    });
  }

  /** The unconditional capability gate, run for every syscall. */
  #checkCapability(pid: ProcessId, syscall: SyscallName): void {
    const cap = SYSCALL_REQUIRED_CAPABILITY[syscall];
    if (cap !== undefined) this.#requireCapability(pid, syscall, cap);
  }

  /**
   * Whether `target` is someone `pid` may reach without the `kill` / `ipc:any`
   * capability: itself, a descendant, or a member of its own process group.
   *
   * This is the "you may always discipline your own children" rule. Without
   * it, a supervision tree would need the `kill` capability for the single
   * most ordinary thing it does — killing the child that missed its deadline —
   * and the capability would be handed out so widely that it stopped meaning
   * anything. The capability governs reaching *across* the tree.
   */
  #isKin(pid: ProcessId, target: ProcessId): boolean {
    if (unbrand(pid) === unbrand(target)) return true;
    const self = this.#table.get(pid);
    const other = this.#table.get(target);
    if (self === undefined || other === undefined) return false;
    if (unbrand(self.pgid) === unbrand(other.pgid)) return true;
    // Walk the target's ancestry looking for `pid`.
    let cur = other.ppid;
    for (let guard = 0; cur !== null && guard < 64; guard += 1) {
      if (unbrand(cur) === unbrand(pid)) return true;
      cur = this.#table.get(cur)?.ppid ?? null;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // §7.3 Routing
  // ---------------------------------------------------------------------------

  async #route(
    pid: ProcessId,
    syscall: SyscallName,
    args: readonly unknown[],
    callId: string,
  ): Promise<unknown> {
    switch (syscall) {
      case 'spawn':
        return await this.#spawn(pid, args[0] as SpawnOptions);
      case 'wait':
        return await this.#wait(
          pid,
          args[0] as ProcessId | undefined,
          args[1] as WaitOptions | undefined,
        );
      case 'exit':
        // Never returns; throws ProcessExitSignal after recording.
        return await this.#exit(pid, args[0] as number, args[1] as string | undefined, callId);
      case 'kill':
        return await this.#kill(pid, args[0] as ProcessId, args[1] as Signal);
      case 'ps':
        return this.#ps(pid, args[0] as ProcessFilter | undefined);
      case 'fork':
        return await this.#forkSyscall(pid, args[0] as ForkOptions | undefined);
      case 'checkpoint':
        return await this.#checkpoint(pid, args[0] as CheckpointOptions | undefined);
      case 'restore':
        return await this.#restore(pid, args[0] as ChainId, args[1] as RestoreOptions | undefined);
      case 'llm_call':
        return await this.#llmCall(pid, args[0] as LLMRequest, callId);
      case 'tool_call':
        return await this.#toolCall(
          pid,
          args[0] as string,
          args[1],
          args[2] as ToolCallOptions | undefined,
          callId,
        );
      case 'memory_read':
        return await this.#memoryRead(pid, args[0] as string, args[1] as MemoryQuery);
      case 'memory_write':
        return await this.#memoryWrite(
          pid,
          args[0] as string,
          args[1] as string,
          args[2],
          args[3] as MemoryWriteOptions | undefined,
        );
      case 'send':
        return await this.#send(
          pid,
          args[0] as ProcessId | ChannelId,
          args[1],
          args[2] as SendOptions | undefined,
        );
      case 'recv':
        return await this.#recv(pid, args[0] as ChannelId | undefined, args[1] as RecvOptions | undefined);
      case 'sleep':
        return await this.#sleep(pid, args[0] as number);
      case 'now':
        return this.#now();
      case 'random':
        return this.#random(args[0] as RandomOptions | undefined);
      case 'on_signal':
        return this.#onSignal(pid, args[0] as Signal, args[1] as SignalHandler | 'default' | 'ignore');
      case 'budget':
        return this.#budget(pid);
      case 'acquire':
        return this.#acquire(pid, args[0] as Capability);
      case 'release':
        return this.#release(pid, args[0] as Capability);
      case 'caps':
        return this.caps(pid);
      case 'channel_open':
        return this.#channelOpen(pid, args[0] as ChannelOpenOptions | undefined);
      case 'channel_close':
        return this.#channelClose(pid, args[0] as ChannelId);
      default: {
        // Exhaustiveness guard: adding a SyscallName without a case is a
        // compile error here, not a silent runtime hole.
        const _never: never = syscall;
        return trap('EINVAL', String(_never), { reason: 'unhandled syscall' });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // §7.4 Process control
  // ---------------------------------------------------------------------------

  async #spawn(pid: ProcessId, opts: SpawnOptions): Promise<{ readonly pid: ProcessId }> {
    if (typeof opts?.role !== 'string' || opts.agent === undefined) {
      trap('EINVAL', 'spawn', { reason: 'spawn requires { role, agent }' });
    }
    const childPid = await this.#table.allocate({
      ppid: pid,
      role: opts.role,
      agent: opts.agent,
      ...(opts.budgets !== undefined ? { budgets: opts.budgets } : {}),
      ...(opts.nice !== undefined ? { nice: opts.nice } : {}),
      ...(opts.daemon !== undefined ? { daemon: opts.daemon } : {}),
      ...(opts.autoReap !== undefined ? { autoReap: opts.autoReap } : {}),
      ...(opts.restart !== undefined ? { restart: opts.restart } : {}),
      ...(opts.memory !== undefined ? { memory: opts.memory } : {}),
      ...(opts.signals !== undefined ? { signals: opts.signals } : {}),
      ...(opts.exitTimeoutMs !== undefined ? { exitTimeoutMs: opts.exitTimeoutMs } : {}),
      ...(opts.group !== undefined ? { pgid: opts.group } : {}),
      // Least privilege, when the spawner asked for it (docs/ABI.md §4.9).
      // Both omitted ⇒ the child is unnarrowed, as before 1.0.
      ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
      ...(opts.grantable !== undefined ? { grantable: opts.grantable } : {}),
    });

    // NEW → READY so the scheduler's reconcile adopts it. The agent module is
    // loaded and run by boot.ts (Phase 3); the dispatcher only readies it.
    await this.#table.setState(childPid, 'ready', { trigger: 'spawn', parent: unbrand(pid) });
    this.#scheduler?.enqueue(childPid);

    // A child's memory regions are declared in the table at allocate; sync the
    // memory engine so they are bound before the child first runs.
    this.#memory?.syncFromTable(childPid);

    return { pid: childPid };
  }

  async #wait(pid: ProcessId, target?: ProcessId, opts?: WaitOptions): Promise<WaitResult> {
    const timeoutMs = opts?.timeoutMs;
    const children = this.#table.children(pid);

    if (target !== undefined) {
      if (!children.includes(target)) {
        // Not a live child. Either it was already reaped (init auto-reaps
        // zombies, so this is the common case for a supervisor that waits
        // late) — in which case the table retained its status — or it was
        // never our child at all.
        const retained = this.#table.takeReapedChild(pid, target);
        if (retained !== null) return retained;
        trap('ESRCH', 'wait', { pid: unbrand(pid), target: unbrand(target) });
      }
      const tEntry = this.#table.get(target);
      if (tEntry !== undefined && tEntry.state === 'zombie') {
        return await this.#table.reap(target, { retain: false });
      }
      // `timeoutMs: 0` is a poll: never park.
      if (timeoutMs === 0) {
        trap('ETIMEDOUT', 'wait', {
          pid: unbrand(pid),
          target: unbrand(target),
          timeoutMs: 0,
        });
      }
      return await this.#parkWait(pid, target, timeoutMs);
    }

    // Any-child form: collect a child that exited before we got here first, so
    // waiting late is not distinguishable from waiting on time.
    const retainedAny = this.#table.takeReapedChildAny(pid);
    if (retainedAny !== null) return retainedAny;

    if (children.length === 0) {
      trap('ECHILD', 'wait', { pid: unbrand(pid) });
    }
    // Reap the first already-zombie child if there is one (idempotent path).
    for (const child of children) {
      const cEntry = this.#table.get(child);
      if (cEntry !== undefined && cEntry.state === 'zombie') {
        return await this.#table.reap(child, { retain: false });
      }
    }
    if (timeoutMs === 0) {
      trap('ETIMEDOUT', 'wait', { pid: unbrand(pid), timeoutMs: 0 });
    }
    return await this.#parkWait(pid, null, timeoutMs);
  }

  /**
   * Park the caller in BLOCKED until an awaited child zombifies — or until
   * `timeoutMs` elapses, in which case the wait traps `ETIMEDOUT` and the
   * caller is returned to READY. The child is deliberately *not* killed: that
   * is the supervisor's call, and `kill()` is its own syscall (docs/ABI.md
   * §4.1). This is what lets a supervisor express "bound every child, kill and
   * respawn the ones that hang" as ordinary control flow.
   */
  #parkWait(
    parentPid: ProcessId,
    childPid: ProcessId | null,
    timeoutMs?: number,
  ): Promise<WaitResult> {
    return new Promise<WaitResult>((resolve, reject) => {
      const waiter: Waiter = { parentPid, childPid, resolve, reject, settled: false, timer: null };
      const key = childPid === null ? unbrand(parentPid) : unbrand(childPid);
      const map = childPid === null ? this.#waitersAny : this.#waitersByChild;
      const list = map.get(key) ?? [];
      list.push(waiter);
      map.set(key, list);

      if (timeoutMs !== undefined) {
        waiter.timer = this.#setTimeoutFn(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          this.#removeWaiter(waiter);
          this.#unpark(parentPid, () => {
            waiter.reject(new CortexError('ETIMEDOUT', 'wait', {
              message: `wait timed out after ${timeoutMs}ms`,
              details: {
                parent: unbrand(parentPid),
                child: childPid === null ? null : unbrand(childPid),
              },
            }));
          });
        }, timeoutMs);
      }

      // Best-effort BLOCKED transition. If the state machine forbids it (the
      // caller is somehow not RUNNING), leave the state alone — the promise
      // still resolves when the child dies.
      const entry = this.#table.get(parentPid);
      if (entry !== undefined && entry.state === 'running') {
        this.#table.setBlockedOn(
          parentPid,
          childPid === null
            ? { kind: 'wait', pid: parentPid }
            : { kind: 'wait', pid: childPid },
        );
        void this.#table
          .setState(parentPid, 'blocked', { trigger: 'wait' })
          .catch(() => {
            /* state recording is best-effort here; the wait itself is what matters */
          });
      }
    });
  }

  /** Remove a parked waiter from whichever list it is registered in. */
  #removeWaiter(waiter: Waiter): void {
    const key =
      waiter.childPid === null ? unbrand(waiter.parentPid) : unbrand(waiter.childPid);
    const map = waiter.childPid === null ? this.#waitersAny : this.#waitersByChild;
    const list = map.get(key);
    if (list === undefined) return;
    const idx = list.indexOf(waiter);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) map.delete(key);
  }

  /**
   * Resolve and reap a zombified child for any parked `wait()`. Called after
   * the dispatcher drives a child to ZOMBIE (via `exit`). Returns the reaped
   * result, or null when nobody was waiting / the child was already reaped.
   */
  async #wakeWaiters(childPid: ProcessId): Promise<void> {
    const childKey = unbrand(childPid);
    const specific = this.#waitersByChild.get(childKey) ?? [];
    this.#waitersByChild.delete(childKey);

    const childEntry = this.#table.get(childPid);
    const parentPid = childEntry?.ppid ?? null;

    // Reap once (retain:true). Because reap() only retains for a live, non-init
    // parent, a child that exits while its parent has no waiter parked yet is
    // still collected later by that parent's wait(). When we DO deliver the
    // result to a live waiter below, we consume this retained copy so the same
    // exit status can never be collected twice.
    let result: WaitResult | null = null;
    if (childEntry !== undefined && childEntry.state === 'zombie') {
      try {
        result = await this.#table.reap(childPid);
      } catch {
        result = null;
      }
    }

    // Whether the real (non-ECHILD) result was handed to at least one waiter.
    let delivered = false;
    const deliver = (waiter: Waiter): void => {
      if (waiter.settled) return;
      waiter.settled = true;
      // A child that exited beat the timeout: cancel it, or the parent would be
      // woken twice (once by the reap, once by a stale timer).
      if (waiter.timer !== null) {
        this.#clearTimeoutFn(waiter.timer);
        waiter.timer = null;
      }
      if (result !== null) {
        delivered = true;
        this.#unpark(waiter.parentPid, () => waiter.resolve(result));
      } else {
        // Child vanished without a usable zombie (already reaped elsewhere).
        this.#unpark(waiter.parentPid, () => {
          waiter.reject(new CortexError('ECHILD', 'wait', {
            message: 'awaited child is gone',
            details: { child: childKey },
          }));
        });
      }
    };

    for (const w of specific) deliver(w);

    if (parentPid !== null) {
      const anyList = this.#waitersAny.get(unbrand(parentPid)) ?? [];
      const stillWaiting: Waiter[] = [];
      for (const w of anyList) {
        if (w.settled) continue;
        deliver(w);
      }
      // "any child" waiters that were not settled stay parked for the next child.
      for (const w of anyList) if (!w.settled) stillWaiting.push(w);
      if (stillWaiting.length === 0) this.#waitersAny.delete(unbrand(parentPid));
      else this.#waitersAny.set(unbrand(parentPid), stillWaiting);
    }

    // The status went straight to a live waiter — drop the ledger copy so a
    // later wait() for this same child does not re-collect it. When nothing was
    // delivered, the retained copy stays for a late wait().
    if (delivered && parentPid !== null) {
      this.#table.takeReapedChild(parentPid, childPid);
    }
  }

  /**
   * Return a parked parent from BLOCKED to READY (the scheduler re-adopts it),
   * then settle its `wait()`.
   *
   * The two halves are deliberately decoupled. `resume` — resolving or rejecting
   * the parked Promise — is handed to the wake gate instead of being called
   * inline, so the agent body restarts on its next *dispatch* rather than in
   * the middle of the wake. Resolving inline would let the body run its next
   * syscall while the process is still BLOCKED (the state transition behind it
   * is an `await` on the recorder) and trap ESTATE. See `wake_gate.ts`.
   *
   * With no gate configured, `resume` runs immediately — correct for hosts whose
   * continuations run to completion inside one quantum.
   */
  #unpark(parentPid: ProcessId, resume: () => void): void {
    const entry = this.#table.get(parentPid);
    if (entry === undefined) {
      resume();
      return;
    }
    if (entry.state !== 'blocked') {
      // Not parked on `wait` (or already woken): nothing to schedule, and the
      // gate would never be released, so settle inline.
      resume();
      return;
    }
    this.#table.setBlockedOn(parentPid, null);
    if (this.#wakeGate !== null) this.#wakeGate.defer(parentPid, resume);
    void this.#table
      .setState(parentPid, 'ready', { trigger: 'wait-return' })
      .then(() => this.#scheduler?.enqueue(parentPid))
      .catch(() => {
        // The state write failed: never leave the wake stranded behind a
        // dispatch that cannot happen.
        this.#wakeGate?.clear(parentPid);
        resume();
      });
    if (this.#wakeGate === null) resume();
  }

  async #exit(
    pid: ProcessId,
    code: number,
    reason: string | undefined,
    callId: string,
  ): Promise<never> {
    const exitReason = reason ?? 'exit';
    const entry = this.#table.mustGet(pid, 'exit');
    const stateBefore = entry.state;

    // A process that exits while parked in `sleep()` leaves a live timer behind
    // whose only job would be to wake a dead PID.
    this.#cancelSleep(pid);

    // Walk to EXITING. Legal directly from running/blocked/stopped; new/ready
    // route through running first. checkpointing/suspended have no edge to
    // exiting (docs/PROCESS.md §5) — exit from those is a kernel bug.
    await this.#walkToExiting(pid, stateBefore);

    // Write the exit record *before* the recorder is closed by reap.
    const recorder = this.#table.recorderFor(pid);
    if (recorder !== null) {
      const rec: SyscallRecordInput = {
        timestamp: this.#now(),
        pid,
        syscall: 'exit',
        callId,
        phase: 'exit',
        result: { code, reason: exitReason },
        stateBefore,
        stateAfter: 'exiting',
        reversibility: 'irreversible',
        kernelAbiVersion: this.kernelAbiVersion,
      };
      await recorder.append(rec).catch(() => {
        /* recording failure must not block teardown */
      });
    }

    const finalLogOffset = recorder?.currentOffset ?? entry.initialLogOffset;
    this.#table.setExitInfo(pid, code, exitReason, finalLogOffset);
    await this.#table.setState(pid, 'zombie', { trigger: 'exit', code });

    // Persist metadata NOW, before `init.handleZombie` may reap the entry.
    // This is what makes agent-internal `ctx.spawn()` children visible to
    // `ps` / `top` in a later CLI invocation (issue C2): every process lands a
    // `meta.json` at exit, not just the single PID the CLI spawned directly.
    if (this.#onProcessExit !== undefined) {
      const meta: PersistedProcessMeta = {
        pid: unbrand(pid),
        ppid: entry.ppid === null ? null : unbrand(entry.ppid),
        pgid: unbrand(entry.pgid),
        role: entry.role,
        state: 'zombie',
        exitCode: entry.exitCode,
        exitReason: entry.exitReason,
        startedAt: entry.startedAt,
        lastTransitionAt: entry.lastTransitionAt,
        budgetsSpent: { ...entry.budgetsSpent },
        budgetsRemaining: { ...entry.budgetsRemaining },
        agent: entry.agent,
        kernelAbiVersion: this.kernelAbiVersion,
      };
      try {
        await this.#onProcessExit(meta);
      } catch {
        // Meta persistence is best-effort: a failure here must not turn a
        // clean exit into a teardown crash.
      }
    }

    // Hand off to the supervisor: reparent orphans, SIGCHLD, conditional reap,
    // daemon restart. Then wake any parent parked in wait().
    if (this.#init !== null) {
      await this.#init.handleZombie(pid, code, exitReason);
    } else {
      await this.#wakeWaiters(pid);
    }
    // init.handleZombie does not know about dispatcher waiters; wake them too.
    await this.#wakeWaiters(pid);

    throw new ProcessExitSignal(code, exitReason);
  }

  /** Drive a live process to EXITING along legal edges. */
  async #walkToExiting(pid: ProcessId, from: ProcessState): Promise<void> {
    const path: readonly ProcessState[] = (() => {
      switch (from) {
        case 'exiting':
          return [];
        case 'running':
        case 'blocked':
        case 'stopped':
          return ['exiting'];
        case 'ready':
          return ['running', 'exiting'];
        case 'new':
          return ['ready', 'running', 'exiting'];
        default:
          return trap('EINVAL', 'exit', {
            pid: unbrand(pid),
            state: from,
            reason: 'cannot exit from this state',
          });
      }
    })();
    for (const next of path) {
      await this.#table.setState(pid, next, { trigger: 'exit' });
    }
  }

  async #kill(pid: ProcessId, target: ProcessId, signal: Signal): Promise<void> {
    const raw = unbrand(target);
    if (raw < 0) {
      // Unix convention: negative pid signals the whole process group.
      // Reaching into someone else's group needs `kill`; your own does not.
      const ownGroup = this.#table.get(pid)?.pgid;
      if (ownGroup === undefined || unbrand(ownGroup) !== -raw) {
        this.#requireCapability(pid, 'kill', 'kill');
      }
      await this.#signals.sendGroup(asProcessId(-raw), signal, pid);
      return;
    }
    // Killing your own descendant or group-mate always works — that is what
    // makes a supervision tree expressible without handing out `kill`. The
    // capability governs reaching across the tree (docs/ABI.md §4.9).
    if (!this.#isKin(pid, target)) {
      this.#requireCapability(pid, 'kill', 'kill');
    }
    await this.#signals.send(target, signal, pid);
  }

  #ps(_pid: ProcessId, filter?: ProcessFilter): readonly ProcessInfo[] {
    return this.#table.list(filter);
  }

  // ---------------------------------------------------------------------------
  // §7.5 State management
  // ---------------------------------------------------------------------------

  async #forkSyscall(pid: ProcessId, opts?: ForkOptions): Promise<ForkResult> {
    if (this.#fork === null) {
      trap('EDRIVER', 'fork', { reason: 'fork engine not configured' });
    }
    return await this.#fork.fork(pid, opts);
  }

  async #checkpoint(
    pid: ProcessId,
    opts?: CheckpointOptions,
  ): Promise<{ readonly chainId: ChainId }> {
    if (this.#checkpointMgr === null) {
      trap('EDRIVER', 'checkpoint', { reason: 'checkpoint engine not configured' });
    }
    const ref = await this.#checkpointMgr.take(pid, opts);
    return { chainId: ref.chainId };
  }

  async #restore(
    pid: ProcessId,
    chainId: ChainId,
    opts?: RestoreOptions,
  ): Promise<{ readonly pid: ProcessId }> {
    if (this.#checkpointMgr === null) {
      trap('EDRIVER', 'restore', { reason: 'checkpoint engine not configured' });
    }
    const restoreOpts: RestoreOptions = {
      ...(opts ?? {}),
      // The restoring process is the parent of the materialised one unless the
      // caller said otherwise.
      ...(opts?.parent === undefined ? { parent: pid } : {}),
    };
    const newPid = await this.#checkpointMgr.restoreAs(chainId, restoreOpts);

    // `restoreAs` deliberately mints the process in NEW — restore is morally a
    // fork from the past, so it begins life exactly like a spawned one
    // (PROCESS.md §3.6). But nothing inside the kernel adopts NEW: the
    // scheduler dispatches READY and `reconcile()` only reconciles READY. Left
    // as-is, a restored process sat in NEW until something *outside* the kernel
    // walked it forward — which is why the CLI needed a stopgap. Adopt it here
    // instead: whoever asked for the restore wants the process to run.
    //
    // Best-effort: if the transition is refused the PID is still handed back,
    // and the caller can drive it (or observe why it could not).
    await this.#table.setState(newPid, 'ready', { trigger: 'restore' }).catch(() => {
      /* a restored process that cannot be made READY is still a valid PID */
    });
    this.#scheduler?.enqueue(newPid);
    return { pid: newPid };
  }

  // ---------------------------------------------------------------------------
  // §7.6 Cognition (driver-backed)
  // ---------------------------------------------------------------------------

  async #llmCall(pid: ProcessId, req: LLMRequest, callId: string): Promise<LLMResponse> {
    if (this.#resolveLLM === null) {
      trap('EDRIVER', 'llm_call', {
        pid: unbrand(pid),
        reason: 'no LLM driver resolver configured',
      });
    }
    const driver = this.#resolveLLM(req.driver);
    const timeoutMs = req.timeoutMs ?? this.#defaultLlmTimeoutMs;
    const abort = new AbortController();
    const timer = this.#setTimeoutFn(() => abort.abort(), timeoutMs);
    const driverCtx: DriverContext = {
      pid,
      callId,
      deadline: this.#deadline(timeoutMs),
      abortSignal: abort.signal,
      kernelAbiVersion: this.kernelAbiVersion,
    };
    try {
      const response = await driver.call(req, driverCtx);
      // Token / USD accounting happens in #account via the returned usage.
      return response;
    } finally {
      this.#clearTimeoutFn(timer);
    }
  }

  async #toolCall(
    pid: ProcessId,
    name: string,
    args: unknown,
    opts: ToolCallOptions | undefined,
    callId: string,
  ): Promise<ToolResult> {
    if (this.#resolveTool === null) {
      trap('EDRIVER', 'tool_call', {
        pid: unbrand(pid),
        reason: 'no tool driver resolver configured',
      });
    }
    const resolved = this.#resolveTool(name);
    if (resolved === undefined) {
      trap('ENOENT', 'tool_call', { pid: unbrand(pid), tool: name });
    }
    const { driver, descriptor } = resolved;

    // Forkable-region enforcement uses the driver's *declared* tag, which is
    // only known now (docs/ABI.md §5). Checked before any side effect.
    if (descriptor.reversibility === 'irreversible' && this.#inForkable(pid)) {
      trap('EREVERSIBLE', 'tool_call', {
        pid: unbrand(pid),
        tool: name,
        reversibility: descriptor.reversibility,
      });
    }

    // An irreversible tool is the one thing an agent can do that reaches
    // outside the sandbox for real, so it is gated on `tool:dangerous`
    // (docs/ABI.md §4.9). Reversible tools stay callable by a narrowed leaf,
    // which is what makes least privilege usable rather than merely safe.
    if (descriptor.reversibility === 'irreversible') {
      this.#requireCapability(pid, 'tool_call', 'tool:dangerous');
    }

    const timeoutMs = opts?.timeoutMs ?? descriptor.timeoutMs ?? this.#defaultToolTimeoutMs;
    const abort = new AbortController();
    const timer = this.#setTimeoutFn(() => abort.abort(), timeoutMs);
    const invokeCtx: ToolInvokeContext = {
      pid,
      callId,
      deadline: this.#deadline(timeoutMs),
      abortSignal: abort.signal,
    };
    try {
      if (opts?.stageOnly === true) {
        if (driver.stage === undefined) {
          trap('EINVAL', 'tool_call', {
            tool: name,
            reason: 'driver does not support two-phase staging',
          });
        }
        const staged = await driver.stage(name, args, invokeCtx);
        return {
          output: staged,
          error: null,
          durationMs: 0,
          reversibility: descriptor.reversibility,
        };
      }
      return await driver.invoke(name, args, invokeCtx);
    } finally {
      this.#clearTimeoutFn(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // §7.7 Memory (self-recorded by memory.ts)
  // ---------------------------------------------------------------------------

  async #memoryRead(
    pid: ProcessId,
    region: string,
    query: MemoryQuery,
  ): Promise<readonly MemoryEntry[]> {
    if (this.#memory === null) {
      trap('EDRIVER', 'memory_read', { reason: 'memory engine not configured' });
    }
    return await this.#memory.read(pid, region, query);
  }

  async #memoryWrite(
    pid: ProcessId,
    region: string,
    key: string,
    value: unknown,
    opts?: MemoryWriteOptions,
  ): Promise<void> {
    if (this.#memory === null) {
      trap('EDRIVER', 'memory_write', { reason: 'memory engine not configured' });
    }
    await this.#memory.write(pid, region, key, value, opts);
  }

  // ---------------------------------------------------------------------------
  // §7.8 IPC (self-recorded by ipc.ts)
  // ---------------------------------------------------------------------------

  async #send(
    pid: ProcessId,
    target: ProcessId | ChannelId,
    message: unknown,
    opts?: SendOptions,
  ): Promise<void> {
    if (this.#ipc === null) {
      trap('EDRIVER', 'send', { reason: 'ipc engine not configured' });
    }
    // `ipc:any` governs messaging a stranger. A channel is not a process and
    // has no owner, so only the process-target form is gated — messaging your
    // own descendants and group-mates always works (docs/ABI.md §4.9).
    const raw = unbrand(target) as number | string;
    if (typeof raw === 'number' && !this.#isKin(pid, asProcessId(raw))) {
      this.#requireCapability(pid, 'send', 'ipc:any');
    }
    await this.#ipc.send(pid, target, message, opts ?? {});
  }

  /**
   * Explicit channel creation (docs/ABI.md §4.5, §9.3). Returns a fresh
   * `ChannelId` — anonymous unless a `name` was claimed.
   */
  #channelOpen(
    pid: ProcessId,
    opts?: ChannelOpenOptions,
  ): { readonly channelId: ChannelId } {
    if (this.#ipc === null) {
      trap('EDRIVER', 'channel_open', { reason: 'ipc engine not configured' });
    }
    return { channelId: this.#ipc.openChannel(pid, opts ?? {}) };
  }

  /**
   * Retire a channel: queued messages are dropped, parked `recv()` waiters
   * are rejected `EBADF`, and later use traps `EBADF` (or raises `SIGPIPE` on
   * the sender). Idempotent — closing a closed channel is a no-op.
   */
  #channelClose(pid: ProcessId, channel: ChannelId): void {
    if (this.#ipc === null) {
      trap('EDRIVER', 'channel_close', { reason: 'ipc engine not configured' });
    }
    this.#ipc.closeChannel(channel);
  }

  async #recv(
    pid: ProcessId,
    source?: ChannelId,
    opts?: RecvOptions,
  ): Promise<IpcMessage> {
    if (this.#ipc === null) {
      trap('EDRIVER', 'recv', { reason: 'ipc engine not configured' });
    }
    return await this.#ipc.recv(pid, source, opts ?? {});
  }

  // ---------------------------------------------------------------------------
  // §7.9 Time, determinism, signals, budgets
  // ---------------------------------------------------------------------------

  /**
   * Park the caller on a timer: RUNNING → BLOCKED → READY → RUNNING.
   *
   * The process really is `blocked` while the timer is pending —
   * `blockedOn.kind === 'sleep'` with the wake timestamp — so `ps` and the
   * audit log tell the truth about a sleeping agent instead of reporting it as
   * runnable (docs/ABI.md §4.6, docs/PROCESS.md §5).
   *
   * The wake goes through `#unpark`, i.e. through the wake gate: the process is
   * made READY and enqueued first, and the body's `await` returns only once the
   * scheduler has dispatched it again. Resolving inline would resume the body
   * while it is still BLOCKED and its very next syscall would trap `ESTATE` —
   * the race `wake_gate.ts` exists to remove.
   */
  async #sleep(pid: ProcessId, ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) {
      trap('EINVAL', 'sleep', { ms });
    }
    const entry = this.#table.get(pid);

    // Best-effort park: a caller that is somehow not RUNNING, or a table that
    // refuses the edge, still gets a plain yield. The timer is what the agent
    // asked for; losing it because bookkeeping failed would be worse than an
    // incomplete state trace.
    if (entry !== undefined && entry.state === 'running') {
      const until = new Date(Date.parse(this.#now()) + ms).toISOString();
      this.#table.setBlockedOn(pid, { kind: 'sleep', until });
      await this.#table.setState(pid, 'blocked', { trigger: 'sleep' }).catch(() => {
        /* state recording is best-effort here; the timer still governs the yield */
      });
    }

    await new Promise<void>((resolve) => {
      const handle = this.#setTimeoutFn(() => {
        this.#sleepHandles.delete(unbrand(pid));
        this.#unpark(pid, () => resolve());
      }, ms);
      // Retained so a future EINTR path (and teardown) can cancel a pending
      // timer instead of letting it fire into a dead process.
      this.#sleepHandles.set(unbrand(pid), handle);
    });
  }

  /** Cancel a pending `sleep` timer for `pid`, if one is armed. */
  #cancelSleep(pid: ProcessId): void {
    const key = unbrand(pid);
    const handle = this.#sleepHandles.get(key);
    if (handle === undefined) return;
    this.#sleepHandles.delete(key);
    this.#clearTimeoutFn(handle);
  }

  #onSignal(
    pid: ProcessId,
    signal: Signal,
    handler: SignalHandler | 'default' | 'ignore',
  ): void {
    const disp: SignalDisposition =
      handler === 'default'
        ? { kind: 'default' }
        : handler === 'ignore'
          ? { kind: 'ignore' }
          : { kind: 'handler', handler };
    // setDisposition traps EPERM for SIGKILL/SIGSTOP and EINVAL for unknowns.
    this.#table.setDisposition(pid, signal, disp);
  }

  #budget(pid: ProcessId): BudgetCounters {
    const entry = this.#table.mustGet(pid, 'budget');
    return { ...entry.budgetsSpent };
  }

  // ---------------------------------------------------------------------------
  // §7.10b Capability syscalls (docs/ABI.md §4.9)
  // ---------------------------------------------------------------------------

  /**
   * Raise `cap` from the grantable pool into the held set.
   *
   * Idempotent when already held, `EINVAL` for a name that is not a
   * capability at all, `EPERM` when it is neither held nor grantable.
   *
   * A fully-privileged process (no capability state at all) trivially
   * succeeds: it already holds everything, so escalation is a no-op rather
   * than a permission error. That keeps `acquire` safe to call unconditionally
   * in an agent that may or may not have been narrowed.
   */
  #acquire(pid: ProcessId, cap: Capability): void {
    if (!(CAPABILITIES as readonly string[]).includes(cap)) {
      trap('EINVAL', 'acquire', {
        pid: unbrand(pid),
        capability: String(cap),
        reason: 'unknown capability',
      });
    }
    const entry = this.#table.get(pid);
    if (entry === undefined || entry.capabilities === null) return;
    if (entry.capabilities.has(cap)) return;
    if (!entry.grantable.has(cap) && !entry.capabilities.has('admin')) {
      trap('EPERM', 'acquire', {
        pid: unbrand(pid),
        capability: cap,
        held: [...entry.capabilities],
        grantable: [...entry.grantable],
      });
    }
    entry.capabilities.add(cap);
    entry.grantable.delete(cap);
  }

  /**
   * Drop `cap`. Never fails, including for a capability the process never
   * held: giving up a privilege you do not have is not an error, and making
   * it one only breaks cleanup paths.
   *
   * On a fully-privileged process this *narrows* it — the process stops
   * holding everything and starts holding everything except `cap`, with the
   * full set retained as grantable so the drop is reversible via `acquire`.
   */
  #release(pid: ProcessId, cap: Capability): void {
    const entry = this.#table.get(pid);
    if (entry === undefined) return;
    if (entry.capabilities === null) {
      // Narrowing a fully-privileged process: it now holds everything except
      // `cap`, with the full set kept grantable so `acquire` can undo this.
      const held = new Set(DEFAULT_CAPABILITIES);
      held.delete(cap);
      entry.capabilities = held;
      entry.grantable = new Set(DEFAULT_CAPABILITIES);
      return;
    }
    entry.capabilities.delete(cap);
  }

  /** The capabilities `pid` holds (docs/ABI.md §4.9). */
  caps(pid: ProcessId): readonly Capability[] {
    return this.capabilitiesOf(pid);
  }

  // ---------------------------------------------------------------------------
  // §7.10 Budget accounting
  // ---------------------------------------------------------------------------

  /**
   * Spend the resources a syscall consumed and enforce the budget envelope.
   * Every syscall costs one `syscallCount`; `llm_call` additionally charges
   * the tokens and USD reported by the driver (docs/ABI.md §4.3, §5 of
   * ARCHITECTURE.md). When a finite budget hits zero we fire `SIGXCPU`.
   */
  #account(pid: ProcessId, syscall: SyscallName, result: unknown): void {
    if (!this.#table.has(pid)) return;

    const llmUsage =
      syscall === 'llm_call' && isLLMResponse(result) ? result.usage : null;
    // `usd` is a float dollars figure from the driver; counters store integer
    // microdollars (docs/STATE.md §2.4).
    const delta: Partial<BudgetCounters> =
      llmUsage === null
        ? { syscallCount: 1 }
        : {
            syscallCount: 1,
            tokensIn: llmUsage.inputTokens,
            tokensOut: llmUsage.outputTokens,
            tokensCached: llmUsage.cachedTokens,
            usdSpent: Math.max(0, Math.round(llmUsage.usd * 1_000_000)),
          };
    this.#table.spend(pid, delta);

    const check = this.#table.checkBudget(pid);
    if (check !== 'ok') {
      const entry = this.#table.get(pid);
      if (this.#onBudgetExhausted !== undefined) {
        void Promise.resolve(this.#onBudgetExhausted(pid, check.kind)).catch(() => {
          /* hook errors are swallowed */
        });
      }
      // Fire SIGXCPU only from RUNNING (running→stopped is the legal edge).
      if (entry !== undefined && entry.state === 'running') {
        void this.#signals.send(pid, 'SIGXCPU', PID_KERNEL).catch(() => {
          /* best-effort; the scheduler's own gate is the backstop */
        });
      }
    }
  }

  /** Reversibility actually recorded, refining the static tag where needed. */
  #actualReversibility(
    syscall: SyscallName,
    args: readonly unknown[],
    result: unknown,
  ): Reversibility {
    if (syscall === 'kill') {
      return killReversibility(args[1] as Signal);
    }
    if (syscall === 'tool_call' && isToolResult(result)) {
      return result.reversibility;
    }
    return SYSCALL_REVERSIBILITY[syscall];
  }

  // ---------------------------------------------------------------------------
  // §7.11 Recording helpers
  // ---------------------------------------------------------------------------

  /** Absolute deadline timestamp `ms` from now, for driver contexts. */
  #deadline(ms: number): Timestamp {
    return new Date(Date.now() + ms).toISOString();
  }

  /**
   * Append one dispatcher-owned record. A missing recorder (test mode) is a
   * no-op; a recorder write failure surfaces as `ERECORD` per
   * docs/ARCHITECTURE.md §2.3 ("we would rather halt than produce a partial
   * log").
   */
  async #write(
    pid: ProcessId,
    syscall: SyscallName,
    callId: string,
    phase: 'enter' | 'exit' | 'trap',
    fields: {
      readonly stateBefore: ProcessState;
      readonly stateAfter: ProcessState;
      readonly reversibility: Reversibility;
      readonly args?: unknown;
      readonly result?: unknown;
      readonly error?: { readonly errno: string; readonly message: string; readonly details?: unknown };
      readonly durationMs?: number;
    },
  ): Promise<void> {
    const recorder = this.#table.recorderFor(pid);
    if (recorder === null) return;

    const rec: SyscallRecordInput = {
      timestamp: this.#now(),
      pid,
      syscall,
      callId,
      phase,
      stateBefore: fields.stateBefore,
      stateAfter: fields.stateAfter,
      reversibility: fields.reversibility,
      kernelAbiVersion: this.kernelAbiVersion,
      ...(fields.args !== undefined ? { args: fields.args } : {}),
      ...(fields.result !== undefined ? { result: fields.result } : {}),
      ...(fields.error !== undefined ? { error: fields.error } : {}),
      ...(fields.durationMs !== undefined ? { durationMs: fields.durationMs } : {}),
    };

    try {
      await recorder.append(rec);
    } catch (err) {
      if (isCortexError(err)) throw err;
      throw new CortexError('ERECORD', syscall, {
        message: `failed to record ${phase} of ${syscall}`,
        details: { pid: unbrand(pid), phase },
        cause: err,
      });
    }
  }
}

// =============================================================================
// §8. Module-local helpers
// =============================================================================

/**
 * State gate. Kept local rather than reusing `errors.assertState` only because
 * that helper takes `string` args; this preserves the `ProcessState` typing
 * for callers. Behaviour is identical: trap `ESTATE` when not allowed.
 */
function assertStateIn(
  current: ProcessState,
  allowed: readonly ProcessState[],
  syscall: string,
): void {
  if (!allowed.includes(current)) {
    // The message states the constraint outright. The generic errno text
    // ("syscall not allowed in current process state") is true but useless on
    // its own: it names neither the state you are in nor the states that would
    // have worked, which turns a five-second read into a full debugging round.
    trap(
      'ESTATE',
      syscall,
      {
        currentState: current,
        allowedStates: [...allowed],
      },
      `${syscall} requires one of [${allowed.join(', ')}]; current state: ${current}`,
    );
  }
}

/**
 * Shape the `args` payload for an `enter` record. Zero-arg syscalls record
 * nothing; single-arg syscalls unwrap to the bare value for readability;
 * multi-arg syscalls record the positional tuple.
 */
function recordArgs(args: readonly unknown[]): unknown {
  if (args.length === 0) return undefined;
  if (args.length === 1) return args[0];
  return [...args];
}

/**
 * Shape the `result` payload for an `exit` record. `ps` records only the
 * count (the full table would bloat logs); everything else records verbatim.
 */
function recordResult(syscall: SyscallName, result: unknown): unknown {
  if (syscall === 'ps' && Array.isArray(result)) {
    return { count: result.length };
  }
  return result;
}

/** Narrow an unknown result to LLMResponse for budget accounting. */
function isLLMResponse(v: unknown): v is LLMResponse {
  return (
    typeof v === 'object' &&
    v !== null &&
    'usage' in v &&
    typeof (v as { usage?: unknown }).usage === 'object' &&
    (v as { usage: unknown }).usage !== null
  );
}

/** Narrow an unknown result to ToolResult for reversibility refinement. */
function isToolResult(v: unknown): v is ToolResult {
  return (
    typeof v === 'object' &&
    v !== null &&
    'reversibility' in v &&
    typeof (v as { reversibility?: unknown }).reversibility === 'string'
  );
}

// Re-export the memory-driver type so consumers wiring a kernel from this
// module's options do not need a second import path. (Type-only; erased at
// runtime under verbatimModuleSyntax.)
export type { IMemoryDriver };
