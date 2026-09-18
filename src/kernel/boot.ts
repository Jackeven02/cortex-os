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
 * The execution model: run-to-completion (v0)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The scheduler (docs/ARCHITECTURE.md §4.8) dispatches **one** process per
 * `tick()`, moves it READY → RUNNING, `await`s the `resume` continuation, and
 * then inspects the table: still RUNNING ⇒ the continuation *yielded* (re-queue
 * round-robin); BLOCKED ⇒ parked; EXITING/ZOMBIE ⇒ gone. That contract forces
 * the continuation to be the unit of CPU time.
 *
 * v0 implements the simplest continuation that satisfies it: **run the agent
 * function to completion inside one quantum.** The agent's `await`s still yield
 * to Node's event loop (so timers, driver I/O, and other kernels' work
 * progress), but the scheduler does not pre-empt mid-agent — a process runs
 * start-to-finish in the single tick that dispatched it, then exits. Across
 * ticks this is fair at *process* granularity (round-robin over READY
 * processes), just not time-sliced within a process.
 *
 * docs/ARCHITECTURE.md §13 predicts "the scheduler's 'resume the Promise' trick
 * will be the source of subtle bugs … we will write three implementations before
 * one feels right." This is implementation #1, and it is intentionally naive.
 * True cooperative suspension — where `resume` returns at a yield point and the
 * agent is later *continued* rather than restarted — is the post-v0 rework. Two
 * consequences are accepted and documented here rather than hidden:
 *
 *   • **`wait()` on a not-yet-run child hangs the quantum.** A parent that
 *     spawns a child and then `wait()`s for it parks inside its own `resume`;
 *     the child is not dispatched until that `resume` returns, which it never
 *     does. v0 agents must be leaves or spawn-and-detach. (The dispatcher's
 *     `wait` parking logic is correct; it is the run-to-completion continuation
 *     that cannot interleave a parent with its own child.)
 *   • **`sleep()` blocks the quantum.** `dispatcher.#sleep` awaits a real timer
 *     without the RUNNING → BLOCKED → READY dance (its own header defers that to
 *     boot.ts). With real timers the quantum simply takes `ms` longer and then
 *     completes correctly; the BLOCKED bookkeeping is the deferred piece.
 *
 * Everything else — `llm_call`, `tool_call`, `memory_*`, `send`, `fork`,
 * `checkpoint`, `kill`, `ps` — runs to completion without parking and is fully
 * supported.
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
 */
export type AgentFn = (ctx: CortexContext) => Promise<void> | void;

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
  #now: () => Timestamp;
  #random: (opts?: RandomOptions) => number;
  #importModule: (specifier: string) => Promise<unknown>;
  #loadAgent: AgentLoader;

  /** pid → built `CortexContext` (one proxy per process, reused across calls). */
  #contexts = new Map<number, CortexContext>();
  /** pid → resolved agent function (loaded once). */
  #agents = new Map<number, AgentFn>();
  /** pids whose quantum has finished; guards against a double-dispatch re-run. */
  #done = new Set<number>();
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
      wait: (p?: ProcessId) => d.invoke(pid, 'wait', p),
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
   * Run one process's quantum to completion (see "The execution model"). Called
   * by the scheduler while the process is RUNNING. Loads the agent (once),
   * builds its context, runs it, then drives exit:
   *
   *   • normal return        → exit(0, 'completed')
   *   • `ProcessExitSignal`  → exit(code, reason)  (the agent called ctx.exit())
   *   • any other throw      → exit(1, message)    (an uncaught agent error)
   *
   * The exit is routed through `dispatcher.invoke('exit', …)` so it is recorded,
   * walks the legal states to ZOMBIE, and hands off to init for reaping — the
   * §13 "exits, gets reaped" half of the milestone.
   */
  async #runQuantum(pid: ProcessId): Promise<void> {
    const key = unbrand(pid);
    // Init is never dispatched (it lives in RUNNING, and reconcile adopts only
    // READY), but guard so a stray enqueue cannot run the supervisor as an agent.
    if (unbrand(pid) === unbrand(PID_INIT)) return;
    if (this.#done.has(key)) return;

    const entry = this.table.get(pid);
    if (entry === undefined) return;

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

    const ctx = this.context(pid);
    try {
      await agentFn(ctx);
      await this.#driveExit(pid, 0, 'completed');
    } catch (err) {
      if (isProcessExitSignal(err)) {
        await this.#driveExit(pid, err.exitCode, err.exitReason);
      } else {
        await this.#driveExit(pid, 1, errorMessage(err));
      }
    } finally {
      this.#done.add(key);
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
