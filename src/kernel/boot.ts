/**
 * boot.ts — the kernel assembly + agent runner (docs/ARCHITECTURE.md §8, §13).
 *
 * This is the module that turns "ten modules + one registry" into a *running*
 * kernel. It owns three responsibilities the other modules deliberately do not:
 *
 *   1. **Assembly.** Construct every kernel module in dependency order and wire
 *      the cycles (signals ↔ init, dispatcher → everything) exactly the way
 *      docs/ARCHITECTURE.md §8 step 3 describes.
 *   2. **The agent runner.** The dispatcher readies a spawned process
 *      (`syscall_dispatcher.ts` #spawn: "the agent module is loaded and run by
 *      boot.ts"); it never loads or executes agent code. boot.ts is the
 *      scheduler's `resume` continuation: it loads the agent module, builds the
 *      `CortexContext` the agent sees, runs it, and drives its exit.
 *   3. **The `CortexContext` proxy.** docs/ABI.md §8 / types.ts §19 define the
 *      eighteen-syscall surface. boot.ts materialises it for a given PID,
 *      forwarding async syscalls to `dispatcher.invoke` and serving the four
 *      *synchronous* syscalls (`now`, `random`, `budget`, `on_signal`) plus the
 *      throwing `exit` directly — see "The sync/async seam" below.
 *
 * docs/ARCHITECTURE.md §13 sets the v0 acceptance bar: "spawn a process that
 * calls `llm_call` against the mock driver, exits, gets reaped. If that works,
 * the kernel is alive." `Kernel` clears exactly that bar, and the smoke check
 * exercises it end to end.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The execution model: a cooperative continuation
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The scheduler (docs/ARCHITECTURE.md §4.8) dispatches **one** process per
 * `tick()`, moves it READY → RUNNING, calls the `resume` continuation, and then
 * inspects the table: BLOCKED ⇒ parked; EXITING/ZOMBIE ⇒ gone; still RUNNING ⇒
 * the body either yielded (re-queue round-robin) or is still live inside its
 * own Promise (report `parked`, leave it RUNNING, do not re-queue).
 *
 * `resume` **starts** the agent body and returns. It does not run it to
 * completion: the body keeps running on the Node event loop while the scheduler
 * moves on to other processes. This is what makes a process tree possible — a
 * parent parked in `wait()` is not holding the CPU, so its children get
 * dispatched in later ticks, and the parent resumes where it left off when the
 * kernel wakes it.
 *
 * Three details carry that design, and all three are load-bearing:
 *
 *   • **The wake gate** (`wake_gate.ts`). When a parked `wait()`/`recv()` is
 *     satisfied, the process is made READY but the Promise is *not* resolved
 *     inline — the resolution is deferred and released on the next dispatch.
 *     Otherwise the body resumes while the process is still BLOCKED (or merely
 *     READY) and its next syscall traps `ESTATE`.
 *   • **`isLive`** (`Scheduler` option). A still-RUNNING process whose body has
 *     not finished is reported `parked` and left out of the run queue;
 *     re-queueing it would re-enter the agent mid-`await`.
 *   • **`settle()`** (§4.4b). "Run to quiescence" for hosts and tests, since
 *     one `tick()` no longer means one finished agent.
 *
 * The previous implementation ran the body to completion inside its quantum
 * ("run-to-completion"). It was simpler and it passed every test we had, but it
 * made `wait()` on a child deadlock by construction: the child could not be
 * dispatched until the parent's `resume` returned, and that never happened, so
 * v0 agents had to be leaves or spawn-and-detach and supervision trees were
 * unwritable. docs/ARCHITECTURE.md §13 predicted "the scheduler's 'resume the
 * Promise' trick will be the source of subtle bugs … we will write three
 * implementations before one feels right." This is implementation #2.
 *
 * `sleep()` parks for real (since `0.2.0`). `dispatcher.#sleep` walks
 * RUNNING → BLOCKED (`blockedOn.kind === 'sleep'`) → READY and wakes through
 * `#unpark`, i.e. through the same gate `wait()` and `recv()` use — so the body
 * resumes only once the scheduler has handed the CPU back, and `ps` tells the
 * truth about a napping agent instead of calling it runnable. Before this, the
 * process stayed RUNNING for the whole nap: correct, but dishonest in the audit
 * log.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The sync/async seam
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `dispatcher.invoke` is *uniformly async* (it awaits `.crec` recording). But
 * docs/ABI.md §8 declares four syscalls synchronous on `CortexContext`:
 * `now(): Timestamp`, `random(): number`, `budget(): BudgetCounters`,
 * `on_signal(): void`, plus `exit(): never` (a synchronous throw). An async
 * `invoke` cannot satisfy a sync signature, so the `CortexContext` proxy serves
 * these five directly:
 *
 *   • They replicate the dispatcher's **uniform state gate** synchronously
 *     (`#gateSync` reads the table and applies `SYSCALL_ALLOWED_STATES`), so an
 *     illegal-state call still traps `ESTATE` exactly as `invoke` would.
 *   • They **skip per-call `.crec` recording.** An async recorder cannot be
 *     awaited from a sync method, and fire-and-forget appends would reorder
 *     against the recorded enter/exit pairs. This is a deliberate v0 trade:
 *     `now`/`random` determinism for replay is provided by the *injected*
 *     clock/RNG sources (shared with the dispatcher, so record and replay see
 *     one timeline), not by per-call records; `budget` is `UNRECORDED` by policy
 *     anyway; `on_signal` dispositions are reconstructable from the spawn-time
 *     signal map (a known replay gap, tracked for the replay work).
 *   • `exit()` throws `ProcessExitSignal` **synchronously** (honouring `never`),
 *     which unwinds the agent's async function. The agent runner catches it and
 *     performs the *real* teardown through `dispatcher.invoke('exit', …)` — one
 *     recorded, state-walked, reaping exit. The sentinel is a control-flow
 *     device, not the teardown itself.
 *
 * @module kernel/boot
 */

import { join } from 'node:path';

import {
  type AgentSpec,
  asProcessId,
  type BudgetCounters,
  type ChainId,
  type ChannelId,
  type CheckpointOptions,
  type CognitiveSnapshot,
  type CortexContext,
  type ForkOptions,
  type LLMRequest,
  type LLMResponse,
  type MemoryQuery,
  type MemoryRegionPolicy,
  type MemoryWriteOptions,
  type Message,
  type ProcessFilter,
  type ProcessId,
  type RandomOptions,
  type RecvOptions,
  type RestoreOptions,
  type SendOptions,
  type Signal,
  type SignalDisposition,
  type SignalHandler,
  type SpawnOptions,
  type Timestamp,
  type ToolCallOptions,
  type WaitOptions,
  type ToolResult,
  unbrand,
} from './types.js';
import { assertState, isCortexError, trap } from './errors.js';
import { Recorder } from './recorder.js';
import { PID_INIT, ProcessTable, type RecorderFactory } from './process_table.js';
import { SignalManager, type HandlerInvoker } from './signals.js';
import { IpcManager } from './ipc.js';
import { MemoryManager } from './memory.js';
import { CheckpointManager, type RestoreContext } from './checkpoint.js';
import { ForkManager } from './fork.js';
import { Scheduler } from './scheduler.js';
import { WakeGate } from './wake_gate.js';
import {
  InitProcess,
  type DaemonSpec,
  type InitAlarm,
  type OnAlarmHook,
  type ShutdownReport,
} from './init.js';
import {
  ProcessExitSignal,
  SYSCALL_ALLOWED_STATES,
  SyscallDispatcher,
  isProcessExitSignal,
  type SyscallName,
} from './syscall_dispatcher.js';
import { DriverRegistry } from './driver_registry.js';

// =============================================================================
// §1. Agent surface
// =============================================================================

/**
 * The function an agent module default-exports (docs/ARCHITECTURE.md §12.3:
 * "Agent modules are ES modules with a default-exported async function
 * `(ctx) => Promise<void> | void`"). It receives the kernel surface and runs
 * until it returns (clean exit, code 0) or calls `ctx.exit()` (which throws).
 *
 * `args` is the second parameter: whatever `AgentSpec.args` carried when the
 * process was spawned (`{ module: '...', args: { seed: 7 } }` →
 * `agent(ctx, { seed: 7 })`). The field has always been part of `AgentSpec`
 * (docs/ABI.md §9.2) but v0's loader dropped it on the floor, which forced
 * agent authors to smuggle configuration through `ctx.role`. Passing it through
 * is the difference between "a module can be parameterised" and "you need one
 * file per configuration" — supervision trees need the former.
 *
 * A function that takes only `ctx` still assignable here; existing agents keep
 * compiling unchanged.
 */
export type AgentFn = (
  ctx: CortexContext,
  args: Readonly<Record<string, unknown>>,
) => Promise<void> | void;

/**
 * Resolves an `AgentSpec` to a runnable `AgentFn`. Injectable so tests (and a
 * future manifest loader) can supply agents without touching the filesystem or
 * the dynamic-`import` machinery. The default loader handles both v0 spec
 * forms: `{ module }` (dynamic import of the default export) and `{ system }`
 * (the built-in prompt-only loop, §3).
 */
export type AgentLoader = (spec: AgentSpec) => Promise<AgentFn>;

/**
 * Safety cap on the built-in prompt-only agent's tool-use loop, so a model that
 * keeps requesting tools cannot spin forever inside one quantum.
 */
export const PROMPT_AGENT_MAX_TURNS = 8;

// =============================================================================
// §2. Kernel options
// =============================================================================

/** Per-PID metadata boot keeps so `restore` can rebuild an agent spec. */
interface ProcessMeta {
  readonly role: string;
  readonly agent: AgentSpec;
  readonly memory?: Readonly<Record<string, MemoryRegionPolicy>>;
}

export interface KernelOptions {
  /** Written into every `.crec` / `.csnap` record. Required (no silent default). */
  readonly kernelAbiVersion: string;

  /**
   * The kernel state directory (`.cortex/`). Recorders are opened under
   * `<dir>/processes`, checkpoints under `<dir>/checkpoints`, unless overridden
   * below. docs/ARCHITECTURE.md §7 sketches a per-process subdirectory layout;
   * v0 uses flat directories (the recorder's `crecPath` and the checkpoint
   * store are both flat) — a documented simplification, not a behaviour change.
   */
  readonly dir: string;

  /** Override the per-process `.crec` directory. Defaults to `<dir>/processes`. */
  readonly processesDir?: string;
  /** Override the `.csnap` directory. Defaults to `<dir>/checkpoints`. */
  readonly checkpointDir?: string;
  /**
   * Override the recorder factory entirely (e.g. `nullRecorderFactory` for a
   * pure in-memory kernel). When present, `processesDir` is ignored.
   */
  readonly recorderFactory?: RecorderFactory;

  /**
   * A pre-populated driver registry. When omitted, boot constructs one from
   * `defaultLLM` / `defaultMemory` / `onCloseError` and hands it to
   * `loadDrivers`.
   */
  readonly registry?: DriverRegistry;
  /** Docs/ARCHITECTURE.md §8 step 3c — register drivers, in order, at boot. */
  readonly loadDrivers?: (registry: DriverRegistry) => Promise<void> | void;
  readonly defaultLLM?: string;
  readonly defaultMemory?: string;
  readonly onCloseError?: (name: string, err: unknown) => void;

  /** Docs/ARCHITECTURE.md §8 step 3e — daemons registered on init at boot. */
  readonly daemons?: readonly DaemonSpec[];

  /** Injectable determinism sources, shared with every module that needs them. */
  readonly now?: () => Timestamp;
  readonly random?: (opts?: RandomOptions) => number;
  readonly nextCallId?: () => string;
  readonly nextChainId?: () => ChainId;
  readonly setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;

  /** Override agent loading (tests supply in-memory agents). */
  readonly agentLoader?: AgentLoader;
  /**
   * Override the dynamic-`import` used by the default `{ module }` loader.
   * Injectable so tests never hit the filesystem.
   */
  readonly importModule?: (specifier: string) => Promise<unknown>;

  /** Cognitive-snapshot hooks, passed through to checkpoint + fork. v0 leaves
   *  them undefined (the kernel does not yet track agent cognition), so
   *  checkpoints carry `EMPTY_COGNITIVE`; a real agent runtime injects these. */
  readonly cognitiveSource?: (pid: ProcessId) => CognitiveSnapshot | Promise<CognitiveSnapshot>;
  readonly cognitiveSink?: (pid: ProcessId, snap: CognitiveSnapshot) => void | Promise<void>;
  readonly driverStateSource?: () =>
    | Readonly<Record<string, Uint8Array | null>>
    | Promise<Readonly<Record<string, Uint8Array | null>>>;
  /** Override how `restore` rebuilds an agent spec. Defaults to boot's
   *  per-PID `ProcessMeta` table keyed on the checkpoint's originating PID. */
  readonly restoreContext?: (cp: { readonly pid: ProcessId; readonly parentPid: ProcessId | null }) => RestoreContext | Promise<RestoreContext>;
  readonly defaultMemoryBacking?: string;

  /**
   * Global per-region write-count ceiling handed to the `MemoryManager`. When
   * a region accrues this many writes, further `memory_write` calls against it
   * trap `ENOMEM` (docs/ABI.md §4.4 "region size limit"). `-1` or `undefined`
   * (the default) means unlimited. This is a single coarse guard shared by
   * every region on the kernel — a per-region override is a possible future
   * refinement — surfaced on the CLI as `cortex spawn --max-region-entries`.
   */
  readonly maxRegionEntries?: number;

  /** Supervisor hooks. */
  readonly onAlarm?: OnAlarmHook;
  readonly onBudgetExhausted?: (pid: ProcessId, kind: 'tokens' | 'usd' | 'wallTime') => void | Promise<void>;

  /**
   * Start the scheduler's auto-loop at the end of `boot()`. Defaults to
   * `false` so tests (and the CLI) drive `tick()` / `start()` explicitly;
   * docs/ARCHITECTURE.md §8 step 3f is then the caller's `kernel.start()`.
   */
  readonly autoStart?: boolean;
}

// =============================================================================
// §3. The built-in prompt-only agent
// =============================================================================

/**
 * Build the `{ system, tools? }` prompt-only agent (types.ts §9). It is the
 * minimal "loop `llm_call` until the model stops" agent useful for trivial
 * daemons and tests. v0 keeps it deliberately small: it seeds a conversation
 * with the system prompt, calls the model, executes any tool calls it returns
 * (feeding results back as `tool` messages), and stops on the first
 * no-tool-call turn or after `PROMPT_AGENT_MAX_TURNS`. Tool *schemas* are not
 * advertised in v0 (the registry resolution of `ToolSchema` lands with the tool
 * drivers); a model that wants tools must already know them.
 */
/** Hand one turn to the Node event loop. Injected so tests can stay deterministic. */
function defaultYield(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function makePromptAgent(spec: {
  readonly system: string;
  readonly driver?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
}): AgentFn {
  return async (ctx: CortexContext): Promise<void> => {
    const messages: Message[] = [{ role: 'system', content: spec.system }];
    for (let turn = 0; turn < PROMPT_AGENT_MAX_TURNS; turn++) {
      const resp: LLMResponse = await ctx.llm_call({
        messages,
        ...(spec.driver !== undefined ? { driver: spec.driver } : {}),
        ...(spec.model !== undefined ? { model: spec.model } : {}),
        ...(spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {}),
        ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
      });
      messages.push({ role: 'assistant', content: resp.text ?? '' });
      if (resp.toolCalls.length === 0) return;
      for (const tc of resp.toolCalls) {
        const result: ToolResult = await ctx.tool_call(tc.name, tc.arguments);
        messages.push({
          role: 'tool',
          content: JSON.stringify(result.output ?? null),
          toolCallId: tc.id,
          name: tc.name,
        });
      }
    }
  };
}

// =============================================================================
// §4. Kernel
// =============================================================================

/**
 * A running Cortex kernel: every module assembled, init booted, and the agent
 * runner wired into the scheduler. One instance per kernel
 * (docs/ARCHITECTURE.md §2.2).
 *
 * Lifecycle: `new Kernel(opts)` (constructs modules, no I/O) → `await boot()`
 * (loads drivers, boots PID 1, registers daemons) → `start()` / `tick()` (run
 * processes) → `await shutdown()` (quiesce children, close drivers).
 *
 * Concurrency: single-threaded JS like every other module. `boot()`, `spawn()`,
 * `tick()`, and `shutdown()` are async but not re-entrant; the scheduler's
 * auto-loop already serialises its own ticks.
 */
export class Kernel {
  readonly kernelAbiVersion: string;
  readonly dir: string;

  // Modules (public + readonly so the CLI and tests can introspect).
  readonly table: ProcessTable;
  readonly signals: SignalManager;
  readonly ipc: IpcManager;
  readonly memory: MemoryManager;
  readonly checkpoint: CheckpointManager;
  readonly fork: ForkManager;
  readonly scheduler: Scheduler;
  readonly dispatcher: SyscallDispatcher;
  readonly registry: DriverRegistry;
  readonly init: InitProcess;

  #opts: KernelOptions;
  #processesDir: string;
  /**
   * The kernel's wake gate: shared by the syscall dispatcher (`wait`) and the
   * IPC engine (`recv`), released here when a live body is re-dispatched. See
   * `wake_gate.ts` — without it a woken agent resumes mid-`await` in a state
   * its next syscall will reject.
   */
  #gate = new WakeGate();
  #now: () => Timestamp;
  #random: (opts?: RandomOptions) => number;
  #importModule: (specifier: string) => Promise<unknown>;
  #loadAgent: AgentLoader;

  /** pid → built `CortexContext` (one proxy per process, reused across calls). */
  #contexts = new Map<number, CortexContext>();
  /** pid → resolved agent function (loaded once). */
  #agents = new Map<number, AgentFn>();
  /** pids whose agent body has finished; guards against a double-dispatch re-run. */
  #done = new Set<number>();
  /**
   * pids whose agent body has been *started*. Distinct from `#done`: once
   * launched, the agent lives in its own Promise and later dispatches must not
   * start it again (and must not block on it) — see the class doc comment.
   */
  #launched = new Set<number>();
  /** pid → spec metadata, surviving reap, so `restore` can rebuild an agent. */
  #processMeta = new Map<number, ProcessMeta>();

  #booted = false;
  #shutdownReport: ShutdownReport | null = null;

  constructor(opts: KernelOptions) {
    if (opts.kernelAbiVersion === '') {
      trap('EINVAL', 'kernel', { reason: 'kernelAbiVersion is required' });
    }
    if (opts.dir === '') {
      trap('EINVAL', 'kernel', { reason: 'dir is required' });
    }
    this.#opts = opts;
    this.kernelAbiVersion = opts.kernelAbiVersion;
    this.dir = opts.dir;
    this.#processesDir = opts.processesDir ?? join(opts.dir, 'processes');
    const checkpointDir = opts.checkpointDir ?? join(opts.dir, 'checkpoints');

    this.#now = opts.now ?? (() => new Date().toISOString());
    this.#random = opts.random ?? (() => Math.random());
    this.#importModule = opts.importModule ?? ((s: string) => import(s));
    this.#loadAgent = opts.agentLoader ?? ((spec) => this.#defaultLoadAgent(spec));

    // --- recorder factory (§8 step 3b: initialise recorder) -----------------
    const recorderFactory: RecorderFactory =
      opts.recorderFactory ??
      (async (pid: ProcessId) => Recorder.open({ pid, dir: this.#processesDir }));

    // --- process_table ------------------------------------------------------
    this.table = new ProcessTable({
      kernelAbiVersion: this.kernelAbiVersion,
      now: this.#now,
      recorderFactory,
    });

    // --- signals ↔ init (deferred ref breaks the cycle, as in the smoke) -----
    let initRef: InitProcess | undefined;
    const handlerInvoker: HandlerInvoker = (pid, signal, handler) =>
      this.#invokeHandler(pid, signal, handler);
    this.signals = new SignalManager({
      table: this.table,
      kernelAbiVersion: this.kernelAbiVersion,
      now: this.#now,
      handlerInvoker,
      onZombie: (pid, code, reason) => {
        // Init is always constructed below, so by the time any signal is
        // delivered the ref is set. Guard anyway (defensive, cheap).
        return initRef === undefined ? undefined : initRef.handleZombie(pid, code, reason);
      },
    });

    this.init = new InitProcess({
      table: this.table,
      signals: this.signals,
      kernelAbiVersion: this.kernelAbiVersion,
      now: this.#now,
      ...(opts.setTimeoutFn !== undefined ? { setTimeoutFn: opts.setTimeoutFn } : {}),
      ...(opts.clearTimeoutFn !== undefined ? { clearTimeoutFn: opts.clearTimeoutFn } : {}),
      ...(opts.onAlarm !== undefined ? { onAlarm: opts.onAlarm } : {}),
      onReaped: (pid) => {
        // Per-PID teardown the supervisor cannot own: cancel a dead receiver's
        // parked recv waiters (so a later send can never hand a message to a
        // zombie and lose it), release its memory bindings (so COW/private
        // physical keys are not pinned for the kernel's lifetime), and drop any
        // deferred wake-gate callback. These modules are assigned later in this
        // constructor, but this only runs at reap time — well after boot.
        this.ipc.cancelWaitersFor(pid);
        this.memory.releaseProcess(pid);
        this.#gate.clear(pid);
      },
    });
    initRef = this.init;

    // --- driver_registry (before the dispatcher: it supplies the resolvers) ---
    this.registry =
      opts.registry ??
      new DriverRegistry({
        kernelAbiVersion: this.kernelAbiVersion,
        ...(opts.defaultLLM !== undefined ? { defaultLLM: opts.defaultLLM } : {}),
        ...(opts.defaultMemory !== undefined ? { defaultMemory: opts.defaultMemory } : {}),
        ...(opts.onCloseError !== undefined ? { onCloseError: opts.onCloseError } : {}),
      });

    // --- memory (drivers copied from the registry at boot) -------------------
    this.memory = new MemoryManager({
      table: this.table,
      kernelAbiVersion: this.kernelAbiVersion,
      now: this.#now,
      ...(opts.nextCallId !== undefined ? { nextCallId: opts.nextCallId } : {}),
      ...(opts.maxRegionEntries !== undefined ? { maxRegionEntries: opts.maxRegionEntries } : {}),
    });

    // --- ipc ----------------------------------------------------------------
    // NOTE: IpcManager types its timer hooks as `typeof setTimeout`, which does
    // not accept the kernel's injectable `(cb, ms) => unknown` shape, so v0 lets
    // IPC recv timeouts use the global timers. (boot's other modules — scheduler,
    // dispatcher, init — all take the injectable shape and are wired above.)
    this.ipc = new IpcManager({
      table: this.table,
      kernelAbiVersion: this.kernelAbiVersion,
      now: this.#now,
      signals: this.signals,
      wakeGate: this.#gate,
    });

    // --- checkpoint ---------------------------------------------------------
    const restoreContext =
      opts.restoreContext ?? ((cp: { readonly pid: ProcessId; readonly parentPid: ProcessId | null }) => {
        const meta = this.#processMeta.get(unbrand(cp.pid));
        if (meta === undefined) {
          trap('EINVAL', 'restore', {
            reason: 'no agent metadata for checkpoint; boot cannot rebuild the spec',
            pid: unbrand(cp.pid),
          });
        }
        return {
          role: meta.role,
          agent: meta.agent,
          ...(meta.memory !== undefined ? { memory: meta.memory } : {}),
          ppid: cp.parentPid,
        };
      });
    this.checkpoint = new CheckpointManager({
      table: this.table,
      kernelAbiVersion: this.kernelAbiVersion,
      dir: checkpointDir,
      now: this.#now,
      memory: this.memory,
      restoreContext,
      ...(opts.nextChainId !== undefined ? { nextChainId: opts.nextChainId } : {}),
      ...(opts.cognitiveSource !== undefined ? { cognitiveSource: opts.cognitiveSource } : {}),
      ...(opts.cognitiveSink !== undefined ? { cognitiveSink: opts.cognitiveSink } : {}),
      ...(opts.driverStateSource !== undefined ? { driverStateSource: opts.driverStateSource } : {}),
      ...(opts.defaultMemoryBacking !== undefined
        ? { defaultMemoryBacking: opts.defaultMemoryBacking }
        : {}),
    });

    // --- fork ---------------------------------------------------------------
    this.fork = new ForkManager({
      table: this.table,
      kernelAbiVersion: this.kernelAbiVersion,
      now: this.#now,
      memory: this.memory,
      ...(opts.nextChainId !== undefined ? { nextChainId: opts.nextChainId } : {}),
      ...(opts.nextCallId !== undefined ? { nextCallId: opts.nextCallId } : {}),
      ...(opts.cognitiveSource !== undefined ? { cognitiveSource: opts.cognitiveSource } : {}),
      ...(opts.cognitiveSink !== undefined ? { cognitiveSink: opts.cognitiveSink } : {}),
    });

    // --- scheduler (resume = the agent runner) ------------------------------
    this.scheduler = new Scheduler({
      table: this.table,
      signals: this.signals,
      kernelAbiVersion: this.kernelAbiVersion,
      now: this.#now,
      resume: (pid: ProcessId) => this.#runQuantum(pid),
      // A live agent body is suspended somewhere inside its own Promise, not
      // parked READY. Tell the scheduler so it does not re-queue (and thus
      // re-enter) it: the body resumes on a wake, or drives its own exit.
      isLive: (pid: ProcessId) => this.#isLiveBody(pid),
      ...(opts.setTimeoutFn !== undefined ? { setTimeoutFn: opts.setTimeoutFn } : {}),
      ...(opts.clearTimeoutFn !== undefined ? { clearTimeoutFn: opts.clearTimeoutFn } : {}),
    });

    // --- dispatcher (on top, holding everything) ----------------------------
    this.dispatcher = new SyscallDispatcher({
      table: this.table,
      signals: this.signals,
      kernelAbiVersion: this.kernelAbiVersion,
      now: this.#now,
      ipc: this.ipc,
      memory: this.memory,
      checkpoint: this.checkpoint,
      fork: this.fork,
      init: this.init,
      scheduler: this.scheduler,
      resolveLLM: this.registry.llmResolver(),
      resolveTool: this.registry.toolResolver(),
      ...(opts.random !== undefined ? { random: opts.random } : {}),
      ...(opts.nextCallId !== undefined ? { nextCallId: opts.nextCallId } : {}),
      ...(opts.setTimeoutFn !== undefined ? { setTimeoutFn: opts.setTimeoutFn } : {}),
      ...(opts.clearTimeoutFn !== undefined ? { clearTimeoutFn: opts.clearTimeoutFn } : {}),
      ...(opts.onBudgetExhausted !== undefined ? { onBudgetExhausted: opts.onBudgetExhausted } : {}),
      wakeGate: this.#gate,
    });
  }

  // ---------------------------------------------------------------------------
  // §4.1 Boot (docs/ARCHITECTURE.md §8 step 3)
  // ---------------------------------------------------------------------------

  /** Whether `boot()` has completed. */
  get booted(): boolean {
    return this.#booted;
  }

  /**
   * Bring the kernel up: load drivers, copy memory drivers into the memory
   * engine, boot init (PID 1), register any daemons. Idempotency is *not*
   * offered — a second `boot()` is a construction bug and traps `EINVAL`
   * (matching `InitProcess.boot`).
   */
  async boot(): Promise<void> {
    if (this.#booted) {
      trap('EINVAL', 'kernel.boot', { reason: 'kernel already booted' });
    }

    // 3c. Load drivers into the registry (built-in → configured → dynamic is
    //     the caller's ordering concern; boot just awaits the hook).
    if (this.#opts.loadDrivers !== undefined) {
      await this.#opts.loadDrivers(this.registry);
    }

    // The registry is the source of truth for *which* memory drivers exist; the
    // memory engine is the source of truth for *bindings*. v0 copies the former
    // into the latter (a documented seam — see driver_registry.ts header).
    for (const driver of this.registry.memoryDrivers()) {
      if (!this.memory.hasDriver(driver.name)) {
        this.memory.registerDriver(driver);
      }
    }

    // 3d. Spawn init (PID 1) with the built-in init agent.
    await this.init.boot();

    // 3e. Register daemons.
    for (const spec of this.#opts.daemons ?? []) {
      await this.init.registerDaemon(spec);
    }

    this.#booted = true;

    // 3f. Optionally start ticking.
    if (this.#opts.autoStart === true) {
      this.scheduler.start();
    }
  }

  /** Start the scheduler's auto-loop (docs/ARCHITECTURE.md §8 step 3f). */
  start(): void {
    this.#assertBooted('kernel.start');
    this.scheduler.start();
  }

  /** Stop the auto-loop and await an in-flight tick. */
  async stop(): Promise<void> {
    await this.scheduler.stop();
  }

  // ---------------------------------------------------------------------------
  // §4.2 Spawning
  // ---------------------------------------------------------------------------

  /**
   * Spawn a top-level process as a child of init. This is the kernel-side entry
   * the CLI's `cortex spawn` maps to (docs/ARCHITECTURE.md §8 step 5): it runs
   * the *real* `spawn` syscall with init as the caller, so the process is
   * allocated, recorded on init's log, readied, and enqueued exactly as an
   * in-agent `ctx.spawn` would be. Returns the new PID; the agent itself runs on
   * a later `tick()`.
   *
   * @throws CortexError ESTATE if the kernel is not booted (init not RUNNING).
   */
  async spawn(opts: SpawnOptions): Promise<ProcessId> {
    this.#assertBooted('kernel.spawn');
    const result = await this.dispatcher.invoke(PID_INIT, 'spawn', opts);
    return result.pid;
  }

  /** Register a supervised daemon (delegates to init). */
  async registerDaemon(spec: DaemonSpec): Promise<ProcessId> {
    this.#assertBooted('kernel.registerDaemon');
    return await this.init.registerDaemon(spec);
  }

  // ---------------------------------------------------------------------------
  // §4.3 The CortexContext proxy (docs/ABI.md §8, types.ts §19)
  // ---------------------------------------------------------------------------

  /**
   * Build (or return the cached) `CortexContext` for a PID. Async syscalls
   * forward to `dispatcher.invoke`; the four sync syscalls and `exit` are served
   * directly (see "The sync/async seam" in the module header).
   */
  context(pid: ProcessId): CortexContext {
    const key = unbrand(pid);
    const cached = this.#contexts.get(key);
    if (cached !== undefined) return cached;

    const entry = this.table.mustGet(pid, 'context');
    const d = this.dispatcher;

    const ctx: CortexContext = {
      // Identity (properties, not syscalls — docs/ABI.md §2.4).
      pid,
      ppid: entry.ppid,
      pgid: entry.pgid,
      role: entry.role,

      // §4.1 Process control
      spawn: (o: SpawnOptions) => d.invoke(pid, 'spawn', o),
      wait: (p?: ProcessId, o?: WaitOptions) => d.invoke(pid, 'wait', p, o),
      exit: (code: number, reason?: string): never => {
        // Synchronous throw honouring `never`; the agent runner catches it and
        // drives the real, recorded teardown through the dispatcher.
        throw new ProcessExitSignal(code, reason ?? 'exit');
      },
      kill: (t: ProcessId, s: Signal) => d.invoke(pid, 'kill', t, s),
      ps: (f?: ProcessFilter) => d.invoke(pid, 'ps', f),

      // §4.2 State management
      fork: (o?: ForkOptions) => d.invoke(pid, 'fork', o),
      checkpoint: (o?: CheckpointOptions) => d.invoke(pid, 'checkpoint', o),
      restore: (c: ChainId, o?: RestoreOptions) => d.invoke(pid, 'restore', c, o),

      // §4.3 Cognition
      llm_call: (r: LLMRequest) => d.invoke(pid, 'llm_call', r),
      tool_call: (name: string, args: unknown, o?: ToolCallOptions) =>
        d.invoke(pid, 'tool_call', name, args, o),

      // §4.4 Memory
      memory_read: (region: string, q: MemoryQuery) => d.invoke(pid, 'memory_read', region, q),
      memory_write: (region: string, k: string, v: unknown, o?: MemoryWriteOptions) =>
        d.invoke(pid, 'memory_write', region, k, v, o),

      // §4.5 IPC
      send: (target: ProcessId | ChannelId, message: unknown, o?: SendOptions) =>
        d.invoke(pid, 'send', target, message, o),
      recv: (source?: ChannelId, o?: RecvOptions) => d.invoke(pid, 'recv', source, o),

      // §4.6 Time and determinism (sync fast-paths)
      sleep: (ms: number) => d.invoke(pid, 'sleep', ms),
      now: (): Timestamp => {
        this.#gateSync(pid, 'now');
        return this.#now();
      },
      random: (o?: RandomOptions): number => {
        this.#gateSync(pid, 'random');
        return this.#random(o);
      },

      // §4.7 Signals (sync fast-path)
      on_signal: (signal: Signal, handler: SignalHandler | 'default' | 'ignore'): void => {
        this.#gateSync(pid, 'on_signal');
        const disp: SignalDisposition =
          handler === 'default'
            ? { kind: 'default' }
            : handler === 'ignore'
              ? { kind: 'ignore' }
              : { kind: 'handler', handler };
        // setDisposition traps EPERM for SIGKILL/SIGSTOP, EINVAL for unknowns.
        this.table.setDisposition(pid, signal, disp);
      },

      // §4.8 Budgets (sync fast-path)
      budget: (): BudgetCounters => {
        this.#gateSync(pid, 'budget');
        return { ...this.table.mustGet(pid, 'budget').budgetsSpent };
      },

      // Forkable regions (docs/STATE.md §5.2)
      forkable: <T>(fn: () => Promise<T>): Promise<T> => d.runForkable(pid, fn),
    };

    this.#contexts.set(key, ctx);
    return ctx;
  }

  /**
   * Replicate the dispatcher's uniform state gate synchronously, for the four
   * sync syscalls. Reads the live table state and applies the same
   * `SYSCALL_ALLOWED_STATES` policy `invoke` would.
   */
  #gateSync(pid: ProcessId, syscall: SyscallName): void {
    const entry = this.table.get(pid);
    if (entry === undefined) {
      trap('ESRCH', syscall, { pid: unbrand(pid) });
    }
    assertState(entry.state, SYSCALL_ALLOWED_STATES[syscall], syscall);
  }

  // ---------------------------------------------------------------------------
  // §4.4 The agent runner (the scheduler's `resume` continuation)
  // ---------------------------------------------------------------------------

  /**
   * Run one process's quantum (see "The execution model"). Called by the
   * scheduler while the process is RUNNING — once to *start* the agent, and
   * again each time the kernel wakes it.
   *
   * The agent body is deliberately **not** awaited here. It is started as an
   * independent Promise (`#runAgentBody`), which drives its own exit:
   *
   *   • normal return        → exit(0, 'completed')
   *   • `ProcessExitSignal`  → exit(code, reason)  (the agent called ctx.exit())
   *   • any other throw      → exit(1, message)    (an uncaught agent error)
   *
   * Every exit is routed through `dispatcher.invoke('exit', …)` so it is
   * recorded, walks the legal states to ZOMBIE, and hands off to init for
   * reaping — the §13 "exits, gets reaped" half of the milestone.
   *
   * On a *re*-dispatch of a body that is still live this method does exactly one
   * thing: release the wake gate. The process has just been put back in RUNNING,
   * so any `wait()`/`recv()` the kernel owes it may resume — and it resumes
   * *here*, inside a quantum, with a state its next syscall accepts. Starting a
   * second copy of the body instead would interleave two executions of one
   * process, which is what the gate exists to prevent.
   */
  async #runQuantum(pid: ProcessId): Promise<void> {
    const key = unbrand(pid);
    // Init is never dispatched (it lives in RUNNING, and reconcile adopts only
    // READY), but guard so a stray enqueue cannot run the supervisor as an agent.
    if (unbrand(pid) === unbrand(PID_INIT)) return;
    if (this.#done.has(key)) return;

    const entry = this.table.get(pid);
    if (entry === undefined) return;

    if (this.#launched.has(key)) {
      this.#gate.release(pid);
      return;
    }

    // Remember the spec so a later `restore` of this process's checkpoints can
    // rebuild it (the `.csnap` body does not carry role/agent).
    if (!this.#processMeta.has(key)) {
      this.#processMeta.set(key, {
        role: entry.role,
        agent: entry.agent,
        memory: Object.fromEntries(entry.memoryRegions),
      });
    }

    let agentFn = this.#agents.get(key);
    if (agentFn === undefined) {
      try {
        agentFn = await this.#loadAgent(entry.agent);
        this.#agents.set(key, agentFn);
      } catch (err) {
        await this.#driveExit(pid, 127, `agent load failed: ${errorMessage(err)}`);
        this.#done.add(key);
        return;
      }
    }

    // Start the body and let the quantum end. The body keeps running on the
    // event loop across later ticks, which is what makes `wait()` on a child
    // (and every other inter-process interleaving) work.
    const ctx = this.context(pid);
    const args = 'args' in entry.agent ? entry.agent.args ?? {} : {};
    this.#launched.add(key);
    void this.#runAgentBody(pid, agentFn, ctx, args);
  }

  /**
   * The agent body's own continuation. Runs outside any quantum: it may park on
   * a `wait()`, a driver call, or a timer, and it resumes when the kernel wakes
   * it (see `#runQuantum`). It settles `#done` exactly once, and drives the
   * recorded exit.
   *
   * A rejection here is a bug in *our* plumbing, not in the agent — every agent
   * outcome (return, `exit()`, throw) is converted into an exit above. It is
   * logged rather than swallowed so a broken continuation is never silent.
   */
  async #runAgentBody(
    pid: ProcessId,
    agentFn: AgentFn,
    ctx: CortexContext,
    args: Record<string, unknown>,
  ): Promise<void> {
    try {
      try {
        await agentFn(ctx, args);
        await this.#driveExit(pid, 0, 'completed');
      } catch (err) {
        if (isProcessExitSignal(err)) {
          await this.#driveExit(pid, err.exitCode, err.exitReason);
        } else {
          await this.#driveExit(pid, 1, errorMessage(err));
        }
      }
    } catch (err) {
      // #driveExit itself failed (a recorder/state-machine fault). The process
      // is likely already gone; mark the body done so `settle()` can return.
      // eslint-disable-next-line no-console
      console.error(`cortex: agent body for pid ${unbrand(pid)} failed to exit cleanly`, err);
    } finally {
      this.#done.add(unbrand(pid));
    }
  }

  /**
   * Drive the real, recorded exit. `dispatcher.invoke('exit', …)` always throws
   * `ProcessExitSignal` after tearing down; that is success, so it is swallowed.
   * A `CortexError` (e.g. the process already left the live set) is swallowed
   * too — teardown is best-effort and must not abort the scheduler loop. Any
   * other error propagates.
   */
  async #driveExit(pid: ProcessId, code: number, reason: string): Promise<void> {
    // An agent that checkpointed itself with detach:true is now SUSPENDED (or
    // transiently CHECKPOINTING) and awaiting a future restore. There is no
    // legal suspended->exiting edge, so driving an exit would only record a
    // spurious trap. Leave it suspended.
    const cur = this.table.get(pid);
    if (cur !== undefined && (cur.state === 'suspended' || cur.state === 'checkpointing')) {
      return;
    }
    try {
      await this.dispatcher.invoke(pid, 'exit', code, reason);
    } catch (err) {
      if (isProcessExitSignal(err)) return; // expected: exit completed
      if (isCortexError(err)) return; // already gone / illegal state; best-effort
      throw err;
    }
  }

  /** The `HandlerInvoker` wired into signals: run a handler with the agent's ctx. */
  async #invokeHandler(pid: ProcessId, _signal: Signal, handler: SignalHandler): Promise<void> {
    await handler(this.context(pid));
  }

  // ---------------------------------------------------------------------------
  // §4.4b Settling (a "run to quiescence" primitive for hosts and tests)
  // ---------------------------------------------------------------------------

  /**
   * Whether `pid`'s agent body is currently suspended inside its own Promise.
   *
   * The scheduler asks this immediately after a quantum, and only when the
   * process is still RUNNING: a live body must be left alone (reported
   * `parked`), not re-queued — re-queueing would re-enter the agent
   * mid-`await`. The process state is therefore irrelevant here; "started and
   * not finished" is the whole answer.
   */
  #isLiveBody(pid: ProcessId): boolean {
    const key = unbrand(pid);
    return this.#launched.has(key) && !this.#done.has(key);
  }

  /**
   * Agent bodies that have been started but have not yet finished.
   *
   * A body whose process has already been reaped is excluded: it can no longer
   * drive a meaningful exit, and waiting on it would hold `settle()` open for a
   * wake that cannot arrive.
   */
  get busyAgents(): number {
    let n = 0;
    for (const key of this.#launched) {
      if (this.#done.has(key)) continue;
      if (this.table.get(asProcessId(key)) === undefined) continue;
      n++;
    }
    return n;
  }

  /**
   * Drive the scheduler until every launched agent body has finished.
   *
   * Necessary because the continuation no longer runs an agent to completion
   * inside one quantum (see the class doc comment): `tick()` gives one process
   * one dispatch, and a body parked on `wait()`, a driver call, or a timer needs
   * both later ticks *and* the Node event loop to make progress. `settle()` is
   * the "let the system run to quiescence" primitive for hosts and tests that
   * want synchronous-looking results from an asynchronous kernel.
   *
   * **Caveat — it does not wait out wall-clock timers.** The default `yieldFn`
   * is `setImmediate`, so a full 2000-tick budget can elapse in microseconds,
   * i.e. *before* a pending `setTimeout` fires. That is the right default for
   * deterministic tests, but a test (or host) whose agents park on real time
   * — `ctx.sleep(ms)`, `wait({ timeoutMs })`, a driver timeout — must pass a
   * yield that lets the timer queue run, e.g.
   * `settle(200, () => new Promise(r => setTimeout(r, 5)))`.
   *
   * @returns the number of ticks actually run.
   */
  async settle(
    maxTicks = 2000,
    yieldFn: () => Promise<void> = defaultYield,
  ): Promise<number> {
    let ticks = 0;
    for (;;) {
      if (ticks >= maxTicks) break;
      const outcome = await this.scheduler.tick();
      // Hand control to the Node event loop so pending agent Promises (driver
      // calls, timers, IPC wakes) can actually advance.
      await yieldFn();
      ticks++;
      // Stop when the scheduler found nothing to dispatch AND no agent body is
      // still parked. Checking only `busyAgents` would exit immediately on a
      // freshly spawned process that has not had its first quantum yet.
      if (outcome.dispatched === null && this.busyAgents === 0) break;
    }
    // Let post-exit bookkeeping (reap → recorder close) settle, then flush
    // everything still open so the host can read the `.crec` logs right away.
    await yieldFn();
    await this.table.flushAll();
    return ticks;
  }

  // ---------------------------------------------------------------------------
  // §4.5 Default agent loading
  // ---------------------------------------------------------------------------

  async #defaultLoadAgent(spec: AgentSpec): Promise<AgentFn> {
    if ('module' in spec) {
      const mod = await this.#importModule(spec.module);
      const candidate = (mod as { default?: unknown }).default ?? mod;
      if (typeof candidate !== 'function') {
        trap('EINVAL', 'spawn', {
          module: spec.module,
          reason: 'agent module has no default-exported function',
        });
      }
      return candidate as AgentFn;
    }
    // `{ system, tools? }` — the built-in prompt-only agent.
    return makePromptAgent(spec);
  }

  // ---------------------------------------------------------------------------
  // §4.6 Shutdown (docs/ARCHITECTURE.md §8 teardown)
  // ---------------------------------------------------------------------------

  /**
   * Quiesce the kernel: stop the auto-loop, let init terminate + reap its
   * children, then close every driver (docs/ARCHITECTURE.md §6.2 — a driver
   * that throws during close is logged via `onCloseError` but never blocks
   * shutdown). Idempotent: a second call returns the first call's report.
   *
   * Init itself is left RUNNING (it cannot exit without crashing the kernel);
   * the process table and its recorders are disposed by the host process exit.
   */
  async shutdown(): Promise<ShutdownReport> {
    if (this.#shutdownReport !== null) return this.#shutdownReport;
    await this.scheduler.stop();
    const report = this.#booted
      ? await this.init.shutdown()
      : {
          signalled: [],
          reaped: [],
          restartsCancelled: 0,
          remaining: [],
          finishedAt: this.#now(),
        };
    await this.registry.closeAll();
    this.#shutdownReport = report;
    return report;
  }

  #assertBooted(op: string): void {
    if (!this.#booted) {
      trap('ESTATE', op, { reason: 'kernel not booted' });
    }
  }
}

// =============================================================================
// §5. Helpers
// =============================================================================

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Convenience wrapper: construct and boot a kernel in one call. Mirrors
 * docs/ARCHITECTURE.md §8 step 3. The caller then drives it with `start()` (or
 * `tick()` in tests) and tears it down with `shutdown()`.
 */
export async function bootKernel(opts: KernelOptions): Promise<Kernel> {
  const kernel = new Kernel(opts);
  await kernel.boot();
  return kernel;
}

// Re-exported so consumers of `boot.js` can reach the alarm shape without a
// second import (init.ts owns the definition).
export type { InitAlarm };
