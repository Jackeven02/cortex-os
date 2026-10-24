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
 *   • They **used to skip per-call `.crec` recording** — an async recorder
 *     cannot be awaited from a sync method, and fire-and-forget appends would
 *     reorder against the recorded enter/exit pairs. As of `0.2.0` that is
 *     fixed the only way it can be: `dispatcher.noteSyncCall` builds the record
 *     *at call time*, capturing the exact value the caller is about to receive,
 *     and the dispatcher flushes the queue at the start of the process's next
 *     `invoke` — after everything the body did synchronously, before the next
 *     syscall's `enter` frame. One frame per sync call (`phase: 'exit'`, args
 *     and result together), because a sync call has no duration and cannot fail
 *     past its state gate.
 *
 *     `budget` is still unrecorded, and now *by policy rather than by
 *     accident*: ABI §4.8 keeps it out of the log because it is derivable from
 *     the syscalls that spent it. `on_signal` records the disposition **kind**,
 *     not the handler — a live closure cannot be serialised, and the kind is
 *     what replay actually needs.
 *   • `exit()` throws `ProcessExitSignal` **synchronously** (honouring `never`),
 *     which unwinds the agent's async function. The agent runner catches it and
 *     performs the *real* teardown through `dispatcher.invoke('exit', …)` — one
 *     recorded, state-walked, reaping exit. The sentinel is a control-flow
 *     device, not the teardown itself.
 *
 * @module kernel/boot
 */

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

import {
  type AgentSpec,
  asProcessId,
  type BudgetCounters,
  type BudgetLimits,
  type Capability,
  type ChannelOpenOptions,
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
  type PersistedProcessMeta,
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
  type SyscallRecord,
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

/**
 * What a process was **born** as — the facts a restore needs to rebuild it.
 *
 * The `.csnap` body deliberately omits the role/agent spec (docs/STATE.md §4),
 * so a restore has to be told what to materialise. The kernel knows the spec
 * of every process it creates; this is how it says so out loud.
 */
export interface ProcessBirth {
  readonly pid: number;
  readonly ppid: number | null;
  readonly role: string;
  readonly agent: AgentSpec;
  readonly memory: Readonly<Record<string, MemoryRegionPolicy>>;
  readonly startedAt: Timestamp;
  /**
   * The capabilities this process was born holding (docs/ABI.md §4.9).
   *
   * `null` means **unnarrowed** — it holds everything, because the spawner
   * said nothing. That is not the same as holding the full set explicitly:
   * an unnarrowed process can `release()` a capability and `acquire()` it
   * back, while one holding an explicit set cannot (the kernel's
   * `release` only keeps the full set grantable for an unnarrowed process).
   *
   * The host needs this to *re-create* the process faithfully: a supervisor
   * that puts a fresh agent in a dead one's place must not hand it more
   * authority than the one it replaces, or "the same agent, restarted"
   * becomes "a stronger agent".
   */
  readonly capabilities: readonly Capability[] | null;
  /**
   * The capabilities this process may raise later with `acquire()`.
   *
   * The escalation pool is part of the process's authority too: an agent that
   * was allowed to escalate for one call should be allowed to escalate again
   * after a restart.
   */
  readonly grantable: readonly Capability[];
  /**
   * The budget limits this process was born with (docs/PROCESS.md §10).
   *
   * The *limits*, not what is left of them: a restart is a fresh attempt,
   * and it starts with the same ceiling the original had.
   */
  readonly budgets: BudgetLimits;
}

/**
 * How a process ended.
 *
 * The exit code and reason are the same facts `KernelOptions.onProcessExit`
 * reports and the same ones the CLI persists to `meta.json` — one truth, three
 * ways to reach it. `exitCode` is `null` when the process died without
 * recording an exit (a hard crash), and `exitReason` says so.
 */
export interface ProcessExit {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly exitReason: string | null;
}

/** One host waiting for a process to end. */
interface ExitWaiter {
  readonly resolve: (exit: ProcessExit | undefined) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Something the kernel reports to whoever is watching.
 *
 * ## Why this exists
 *
 * Until now a host could only *ask* the kernel things: `ps`, `memory`, `wait`,
 * `kill`. Asking is fine for a question, but it is the wrong shape for a
 * question like *"tell me the moment this agent exits"* — the host has to
 * poll, and a polling loop is a latency tax and a race. The transport had the
 * same gap: it carried commands, not streams.
 *
 * So the kernel reports facts as they happen, and a host may watch them.
 * `Kernel.subscribe` is the whole API: one method, one callback, one
 * unsubscribe function.
 *
 * ## What the events are
 *
 * - `process-start` — a process was born (pid, parent, role).
 * - `process-exit` — a process ended, with its **real** exit code (the same
 *   facts `awaitExit` resolves with, and the same ones `onProcessExit`
 *   reports — one truth, three ways to reach it).
 * - `record` — a syscall frame was appended to a process's `.crec` log. This
 *   is the live equivalent of `cortex trace`: the same `SyscallRecord`, with
 *   the same `byteOffset`, the instant it lands on disk.
 * - `output` — a line a process printed was appended to its captured
 *   output. The kernel does not know what a process *said* — the host's
 *   capture does — so the host hands the line over and the kernel relays it
 *   (the same shape as a `record` event: a fact about a process, reported
 *   the moment it happens). The `byteOffset` is where the line sits in the
 *   process's `output.log`, which is what lets a follower stitch the file
 *   and the stream without printing a line twice.
 *
 * ## What they are not
 *
 * These are **facts, not commands**. An event carries no request and changes
 * nothing; the kernel does not wait for a listener to finish, and a listener
 * that throws cannot break the kernel (its error is swallowed — a broken
 * watcher must not take the kernel down with it).
 *
 * Events are also not part of the syscall ABI. Nothing is added to
 * `CortexContext`, no errno contract changes, and `KERNEL_ABI_VERSION` stays
 * where it is. A host that never subscribes sees exactly the kernel it saw
 * before.
 */
export type KernelEvent =
  | {
      readonly kind: 'process-start';
      readonly pid: number;
      readonly ppid: number | null;
      readonly role: string;
    }
  | {
      readonly kind: 'process-exit';
      readonly pid: number;
      readonly exitCode: number | null;
      readonly exitReason: string | null;
    }
  | {
      readonly kind: 'record';
      readonly pid: number;
      readonly record: SyscallRecord;
    }
  | {
      readonly kind: 'output';
      readonly pid: number;
      /** Where the line sits in the process's captured output, in bytes. */
      readonly byteOffset: number;
      readonly line: ProcessOutputLine;
    };

/**
 * One line a process printed, as the host's capture saw it.
 *
 * The `stream` tag is the host's — the kernel carries it without
 * interpreting it, exactly as it carries a syscall frame without
 * interpreting the syscall.
 */
export interface ProcessOutputLine {
  /** ISO-8601 timestamp of the moment the line was completed. */
  readonly at: string;
  /** Which stream the line came from. */
  readonly stream: string;
  /** The line itself, without its trailing newline. */
  readonly text: string;
}

/** A host watching the kernel's events. */
export type KernelEventListener = (event: KernelEvent) => void;

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
   * Persist a process's metadata when it exits. Called by the dispatcher at
   * the ZOMBIE transition — *before* the entry is reaped — so the callback
   * sees the full, final `ProcessInfo` (exit code, reason, budgets, agent).
   *
   * The CLI uses this to write a `meta.json` for every process, including
   * ones an agent spawned internally via `ctx.spawn()` (issue C2): without
   * it, `cortex ps` / `cortex top` only ever saw the single top-level PID the
   * CLI spawned itself. Optional; when absent the kernel does not touch the
   * disk beyond its own `.crec` logs.
   */
  readonly onProcessExit?: (meta: PersistedProcessMeta) => void | Promise<void>;

  /**
   * Fired when a process is **created**, with the facts it was born as.
   *
   * The counterpart of {@link KernelOptions.onProcessExit}: that one reports
   * how a process ended, this one reports how it began.
   *
   * It exists because the `.csnap` body does not carry the agent spec, and
   * the CLI's `meta.json` — which does — is only written when a process
   * *exits*. So a snapshot of an agent that was still running when its kernel
   * went away had no spec anywhere on disk, and could not be restored in a
   * later session. The CLI uses this to write the spec down at creation time,
   * before the process can ever be snapshotted.
   *
   * Optional: absent (the default) the kernel keeps no record of it.
   */
  readonly onProcessStart?: (birth: ProcessBirth) => void | Promise<void>;

  /**
   * Run an agent's body inside a scope the caller defines.
   *
   * The kernel knows *which* process a body belongs to; it does not know what
   * the caller wants to do with that knowledge. This option is the seam:
   * the kernel hands the body to the caller's wrapper, which runs it inside
   * whatever context it likes — an `AsyncLocalStorage` scope, say — and the
   * body executes inside it.
   *
   * The CLI uses it to attribute the agent's `console` output to the process
   * that printed it, so a live agent's output is addressable instead of
   * being mixed into the daemon's stdout forever (docs/ARCHITECTURE.md §12.1).
   *
   * Optional: absent (the default) the body simply runs.
   */
  readonly agentScope?: <T>(pid: ProcessId, body: () => Promise<T>) => Promise<T>;

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
  /**
   * pid → how it ended. The table entry is reaped at the ZOMBIE transition,
   * but the *facts* of the exit outlive it — so a host that asks about a
   * process that has already died still gets the real exit code. See
   * `awaitExit`.
   */
  #exits = new Map<number, ProcessExit>();
  /** pid → the hosts waiting for it to end. */
  #exitWaiters = new Map<number, ExitWaiter[]>();
  /** The hosts watching the kernel's event stream. */
  #listeners = new Set<KernelEventListener>();

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
    const openRecorder: RecorderFactory =
      opts.recorderFactory ??
      // One directory per process (docs/ARCHITECTURE.md §7): the log lives at
      // `<dir>/processes/<pid>/log.crec`, so a process's whole footprint is one
      // subtree. `Recorder.open` creates the directory on first write.
      (async (pid: ProcessId) =>
        Recorder.open({ pid, dir: join(this.#processesDir, String(unbrand(pid))) }));

    // Every frame that lands in a process's log is reported to the event
    // stream — through the **recorder**, not the dispatcher, because seven
    // modules write records directly (the dispatcher, the scheduler, the
    // signal manager, the process table, `fork`, `init`, `checkpoint`). The
    // recorder is the one place every frame passes through, so a subscriber's
    // view of the log cannot disagree with the log itself.
    //
    // The factory is wrapped rather than replaced, so a host that supplies its
    // own recorder still gets a working event stream.
    const recorderFactory: RecorderFactory = async (pid: ProcessId) => {
      const recorder = await openRecorder(pid);
      if (recorder === null) return null;
      recorder.setOnRecord((record) => {
        this.#emit({ kind: 'record', pid: unbrand(record.pid), record });
      });
      return recorder;
    };

    // --- process_table ------------------------------------------------------
    const onProcessStart = opts.onProcessStart;
    this.table = new ProcessTable({
      kernelAbiVersion: this.kernelAbiVersion,
      now: this.#now,
      recorderFactory,
      // Claim a PID by creating its directory *exclusively*. The mkdir is the
      // atomic step: exactly one kernel can win a given PID, so a daemon
      // living in this directory and a short-lived CLI invocation working in
      // it cannot end up appending to the same `log.crec`. Only installed for
      // the default on-disk layout — a custom recorder factory may not use
      // directories at all, and an in-memory kernel wants no filesystem in
      // its PID path.
      ...(opts.recorderFactory === undefined
        ? { pidClaim: (pid: number) => claimPidDirectory(this.#processesDir, pid) }
        : {}),
      // Every process is born through `table.allocate()` — the dispatcher's
      // `spawn`, init's daemon registration, and `restore` all land here — so
      // this is the one place that sees every birth. The `process-start`
      // event is emitted here for the same reason: one hook, every birth.
      onCreate: (entry) => {
        const birth: ProcessBirth = {
          pid: unbrand(entry.pid),
          ppid: entry.ppid === null ? null : unbrand(entry.ppid),
          role: entry.role,
          agent: entry.agent,
          memory: Object.fromEntries(entry.memoryRegions),
          startedAt: entry.startedAt,
          // `null` means "unnarrowed" — it holds everything (ABI.md §4.9),
          // and that is not the same as holding the full set explicitly.
          capabilities: entry.capabilities === null ? null : [...entry.capabilities],
          grantable: [...entry.grantable],
          budgets: { ...entry.budgetsRemaining },
        };
        this.#emit({ kind: 'process-start', pid: birth.pid, ppid: birth.ppid, role: birth.role });
        return onProcessStart?.(birth);
      },
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
      // `SIGUSR2` means "checkpoint now" (docs/PROCESS.md §7). The snapshot
      // goes through the dispatcher, so the `checkpoint` frames land in the
      // target's own log exactly like an agent-initiated one — and the
      // `__signal` frame beside them records that the signal is what
      // triggered it. The dispatcher is built further down this constructor,
      // so the reference is resolved when a signal actually arrives.
      checkpointMediator: async (pid: ProcessId) => {
        const result = await this.dispatcher.invoke(pid, 'checkpoint');
        return { chainId: result.chainId };
      },
      onZombie: async (pid, code, reason) => {
        // A process that died from a signal never went through the `exit`
        // syscall, so the dispatcher's exit-metadata hook has not fired for
        // it. Persist it here — *before* init reaps the entry, because once
        // it is reaped there is nothing left to describe. Without this, an
        // agent killed by SIGTERM vanished from `cortex ps` instead of
        // showing up as a zombie with its exit code.
        await this.dispatcher?.persistExitMeta(pid);
        // Init is always constructed below, so by the time any signal is
        // delivered the ref is set. Guard anyway (defensive, cheap).
        return initRef === undefined ? undefined : initRef.handleZombie(pid, code, reason);
      },
    });

    // --- memory (drivers are copied in from the registry at boot) -----------
    // Constructed before init, because init needs it to bind a daemon's
    // declared memory regions when it allocates the process (see
    // InitProcessOptions.memory).
    this.memory = new MemoryManager({
      table: this.table,
      kernelAbiVersion: this.kernelAbiVersion,
      now: this.#now,
      ...(opts.nextCallId !== undefined ? { nextCallId: opts.nextCallId } : {}),
      ...(opts.maxRegionEntries !== undefined ? { maxRegionEntries: opts.maxRegionEntries } : {}),
    });

    this.init = new InitProcess({
      table: this.table,
      signals: this.signals,
      kernelAbiVersion: this.kernelAbiVersion,
      now: this.#now,
      memory: this.memory,
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
      // Checkpoints live beside the process that took them
      // (`processes/<pid>/checkpoints/`), not in one shared pile. Resolution by
      // chainId therefore has to search the tree — see CheckpointManager.
      dirFor: async (pid: ProcessId) =>
        join(this.#processesDir, String(unbrand(pid)), 'checkpoints'),
      processesRoot: this.#processesDir,
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
      // The kernel's own exit bookkeeping runs first, then the host's hook.
      // Both see the same facts at the same moment — the ZOMBIE transition,
      // before init reaps the entry — so a host that awaits a process and a
      // host that persists its metadata cannot disagree about how it ended.
      onProcessExit: (meta) => {
        this.#recordExit(meta);
        return opts.onProcessExit?.(meta);
      },
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
  // §4.2b Waiting for a process to end (the host-facing primitive)
  // ---------------------------------------------------------------------------

  /**
   * Wait for a process to finish, and report how it ended.
   *
   * ## Why a host needs this
   *
   * The `wait` *syscall* is a parent-child operation: only a process's own
   * parent may wait for it, and the wake-up is enqueued into the parent's run
   * queue. A **host** — a program that boots a kernel — is not in the process
   * tree: the processes it spawns are children of init. So a host cannot use
   * `dispatcher.invoke(pid, 'wait', …)` to wait for them: the syscall is
   * addressed to a process that is never scheduled, and the promise never
   * settles.
   *
   * The only thing a host can do today is hand-roll the wait: poll
   * `kernel.table.get(pid)` for liveness and wire `KernelOptions.onProcessExit`
   * at boot to capture the exit code — and then be careful not to default a
   * missing exit code to `0`, which turns a crash into a success. Every host
   * ends up writing that same twenty lines, and getting the race wrong.
   *
   * This is the supported version of it. It resolves when the process reaches
   * ZOMBIE — which is *before* init reaps the entry, so the exit code is
   * still there to be read — and it reports the real code and reason.
   *
   * @param pid    The process to wait for.
   * @param opts   `timeoutMs` bounds the wait; omit it to wait indefinitely.
   *              `signal` cancels the wait (used when the client goes away).
   * @returns The exit facts, or `undefined` if the wait was cancelled or the
   *          timeout elapsed first.
   * @throws CortexError ESRCH when this kernel has never heard of that PID.
   */
  async awaitExit(
    pid: ProcessId,
    opts: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<ProcessExit | undefined> {
    this.#assertBooted('kernel.awaitExit');
    const key = unbrand(pid);

    // Already gone? The exit record outlives the table entry, so the answer
    // is still available — and the race ("it exited while I was setting up
    // the wait") cannot happen.
    const recorded = this.#exits.get(key);
    if (recorded !== undefined) return recorded;

    if (this.table.get(pid) === undefined) {
      trap('ESRCH', 'kernel.awaitExit', {
        pid: key,
        reason: 'no such process in this kernel',
      });
    }

    if (opts.signal?.aborted === true) return undefined;

    const timeoutMs = opts.timeoutMs ?? 0;
    return await new Promise<ProcessExit | undefined>((resolve) => {
      const waiter: ExitWaiter = { resolve, timer: undefined };
      const list = this.#exitWaiters.get(key);
      if (list === undefined) this.#exitWaiters.set(key, [waiter]);
      else list.push(waiter);

      /** Give up on this wait: take the waiter out and resolve with nothing. */
      const abandon = (): void => {
        const current = this.#exitWaiters.get(key);
        if (current !== undefined) {
          const at = current.indexOf(waiter);
          if (at >= 0) current.splice(at, 1);
          if (current.length === 0) this.#exitWaiters.delete(key);
        }
        resolve(undefined);
      };

      if (opts.signal !== undefined) {
        opts.signal.addEventListener('abort', abandon, { once: true });
      }

      if (timeoutMs > 0) {
        const timer = setTimeout(abandon, timeoutMs);
        // A pending wait must not keep the process alive on its own.
        timer.unref?.();
        waiter.timer = timer;
      }
    });
  }

  /**
   * Record a process's exit and release anyone waiting for it.
   *
   * Called from the dispatcher's exit path at the ZOMBIE transition — before
   * init reaps the entry, because once it is reaped there is nothing left to
   * describe. The host's own `onProcessExit` hook runs after this, so a host
   * that writes its own metadata and a host that awaits both see the same
   * facts.
   */
  #recordExit(meta: PersistedProcessMeta): void {
    const key = meta.pid;
    if (this.#exits.has(key)) return;
    const exit: ProcessExit = {
      pid: key,
      exitCode: meta.exitCode,
      exitReason: meta.exitReason,
    };
    this.#exits.set(key, exit);

    // Tell the watchers before releasing the waiters: a subscriber that sees
    // "pid 4 exited" and then asks `awaitExit(4)` must get the same answer
    // the waiter is about to get.
    this.#emit({
      kind: 'process-exit',
      pid: exit.pid,
      // The code exactly as the kernel knows it — never a defaulted zero. A
      // subscriber that sees "exited 0" for a process that failed has been
      // told a lie it will act on.
      exitCode: exit.exitCode,
      exitReason: exit.exitReason,
    });

    const waiters = this.#exitWaiters.get(key);
    if (waiters === undefined) return;
    this.#exitWaiters.delete(key);
    for (const waiter of waiters) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.resolve(exit);
    }
  }

  // ---------------------------------------------------------------------------
  // §4.2c The event stream (facts, pushed to whoever is watching)
  // ---------------------------------------------------------------------------

  /**
   * Watch the kernel's event stream.
   *
   * The kernel reports what happens as it happens; a host decides what to do
   * about it. The returned function unsubscribes.
   *
   * The listener is called **synchronously**, inside the kernel's own turn —
   * so an event is delivered at the moment it happens, not a tick later. It
   * must therefore not block: do the work in the callback, and hand anything
   * slow to a queue of your own.
   *
   * A listener that throws is ignored. A broken watcher must not be able to
   * take the kernel down, and it certainly must not be able to change what
   * the kernel does — events are facts, not commands.
   *
   * ```ts
   * const stop = kernel.subscribe((event) => {
   *   if (event.kind === 'process-exit') console.log(`pid ${event.pid} → ${event.exitCode}`);
   * });
   * // ... later
   * stop();
   * ```
   */
  subscribe(listener: KernelEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Report a line a process printed.
   *
   * The kernel does not know what a process *said* — it knows which process
   * a body belongs to, and the host's capture knows the rest. So the host
   * hands the line over and the kernel does what it does with every other
   * fact: reports it, to whoever is watching, the moment it happens.
   *
   * The `byteOffset` is where the line sits in the process's captured output.
   * It is what lets a follower stitch the file and the stream together: a
   * line whose offset is already behind the follower's read position was
   * printed by the file read, and must not be printed again.
   *
   * Nothing is recorded and nothing is decided — this is a fact, not a
   * command. A host that never publishes anything never sees these events.
   */
  publishOutput(pid: number, line: ProcessOutputLine, byteOffset: number): void {
    this.#emit({ kind: 'output', pid, byteOffset, line });
  }

  /**
   * Report a fact to every watcher.
   *
   * Best-effort by design: a listener that throws is skipped, and the others
   * still get the event. The kernel does not wait for listeners, and no
   * listener can slow the kernel down with anything but its own CPU time.
   */
  #emit(event: KernelEvent): void {
    if (this.#listeners.size === 0) return;
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        /* a broken watcher must not break the kernel */
      }
    }
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
        const value = this.#now();
        // Record the exact value handed back — that is what makes a replay
        // able to serve the same timestamp even when the wall clock differs.
        d.noteSyncCall(pid, 'now', undefined, value);
        return value;
      },
      random: (o?: RandomOptions): number => {
        this.#gateSync(pid, 'random');
        const value = this.#random(o);
        d.noteSyncCall(pid, 'random', o, value);
        return value;
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
        // The handler itself is a live closure and cannot go in the log; what
        // replay needs is *which kind* of disposition this signal ended up
        // with, which is exactly what the log can carry.
        d.noteSyncCall(pid, 'on_signal', { signal }, { disposition: disp.kind });
      },

      // §4.8 Budgets (sync fast-path)
      budget: (): BudgetCounters => {
        this.#gateSync(pid, 'budget');
        return { ...this.table.mustGet(pid, 'budget').budgetsSpent };
      },

      // §4.5 IPC channel lifecycle (docs/ABI.md §9.3)
      channel_open: (opts?: ChannelOpenOptions): Promise<{ readonly channelId: ChannelId }> =>
        d.invoke(pid, 'channel_open', opts),
      channel_close: (channel: ChannelId): Promise<void> =>
        d.invoke(pid, 'channel_close', channel),

      // §4.9 Capabilities
      acquire: (cap: Capability): Promise<void> => d.invoke(pid, 'acquire', cap),
      release: (cap: Capability): Promise<void> => d.invoke(pid, 'release', cap),
      // Sync fast-path, like `budget`: readable introspection is derivable
      // from the log, so it is not recorded (docs/ABI.md §4.8).
      caps: (): readonly Capability[] => {
        this.#gateSync(pid, 'caps');
        return d.capabilitiesOf(pid);
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
        // The body runs inside the caller's scope, if it defined one — that
        // is how "this output belongs to this process" is established
        // (KernelOptions.agentScope). The wrapper is async so that a
        // synchronous agent body is covered by the scope too.
        const scope = this.#opts.agentScope;
        if (scope !== undefined) {
          await scope(pid, async () => {
            await agentFn(ctx, args);
          });
        } else {
          await agentFn(ctx, args);
        }
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
   * Recorders are flushed and closed here too, not just on reap. A process that
   * never finishes — init, which cannot exit without crashing the kernel, or a
   * run still alive when the CLI tears down — would otherwise keep its file
   * descriptor open until the host process exits. That is what produced
   * `Closing file descriptor 3 on garbage collection` on every `cortex wrap`.
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
    // Close, don't just flush: this is the last chance for any recorder whose
    // process was never reaped, and a flush alone would leave the descriptor
    // open for the host to trip over.
    await this.table.closeAllRecorders();
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

/**
 * Claim a PID by creating its process directory *exclusively*.
 *
 * The state directory can host more than one kernel: `cortex daemon run`
 * keeps one alive there while other `cortex` invocations work in the same
 * directory. Each kernel counts PIDs up from its own seed, and without a
 * claim the two counters eventually walk into each other — at which point
 * the loser opens the winner's `log.crec` in append mode and two unrelated
 * processes share one syscall log. The `mkdir` is the fix: it is atomic,
 * so exactly one caller can win a given PID.
 *
 * @returns `true` when this kernel claimed the PID, `false` when somebody
 *          else already holds it.
 */
function claimPidDirectory(processesDir: string, pid: number): boolean {
  const path = join(processesDir, String(pid));
  try {
    // The parent may not exist yet on a fresh state directory.
    mkdirSync(processesDir, { recursive: true });
  } catch {
    return false;
  }
  try {
    // `recursive: false` is the whole point: the mkdir fails when the
    // directory already exists, and that failure is the "somebody else owns
    // this PID" signal.
    mkdirSync(path, { recursive: false });
    return true;
  } catch {
    return false;
  }
}

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
