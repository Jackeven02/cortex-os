/**
 * cortex kernel — type definitions.
 *
 * Single source of truth for every TypeScript type referenced by the design
 * documents. If a type changes here, the corresponding doc MUST be updated
 * in the same commit. The ABI is the contract; this file is its
 * compiler-enforced form.
 *
 * Sources of truth:
 *   - docs/STATE.md       §7   — agent state, fork, checkpoint types
 *   - docs/PROCESS.md     §10  — process state machine, signals, spawn, wait
 *   - docs/ABI.md         §8   — CortexContext (the syscall surface)
 *   - docs/ABI.md         §7   — driver interfaces (LLM, Tool, Memory)
 *   - docs/ARCHITECTURE.md §4  — kernel module surface (where types are consumed)
 *
 * Conventions:
 *   - All public types are `readonly`. Mutation is the kernel's job, not the
 *     agent's. Where the kernel needs to mutate internal state, it casts.
 *   - Identity types (`ProcessId`, `ChainId`, `ChannelId`, `SyscallOffset`) are
 *     branded. A `ProcessId` cannot be passed where a `ChainId` is expected,
 *     even though both are nominally `number` / `string`. The brand exists at
 *     compile time only and is erased at runtime.
 *   - Optional fields use `?:` (per `exactOptionalPropertyTypes`), meaning
 *     "may be absent." Use `: T | undefined` when "may be present but
 *     explicitly undefined" is the intent — these are different.
 *   - Syscall argument types end in `Options` or `Request`. Syscall return
 *     types end in `Result` or `Response`. Driver-facing types are prefixed
 *     with `I` (interfaces) or are nouns (`ToolDescriptor`).
 *
 * @module kernel/types
 */

// =============================================================================
// §1. Identity primitives
// =============================================================================

/**
 * Brand helper. Creates a nominal type that is structurally a `T` but cannot
 * be assigned to or from another branded `T` without an explicit cast.
 *
 * Runtime cost: zero. Compile-time benefit: prevents `kill(chainId, ...)`
 * from type-checking, which is exactly the kind of bug we want the compiler
 * to catch.
 */
declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

/**
 * Process identifier. `u64` semantically; `number` in TypeScript (safe up to
 * 2^53, which is plenty given PIDs are never reused and we do not spawn at
 * anywhere near a million per second).
 *
 * Allocation: monotonic from 2 (PID 0 = kernel, PID 1 = init).
 * Lifecycle: allocated on `spawn`/`fork`/`restore`; retained through ZOMBIE;
 * removed on reap; **never reused**.
 *
 * See: docs/PROCESS.md §4.1
 */
export type ProcessId = Brand<number, 'ProcessId'>;

/**
 * Logical identity that survives `checkpoint` → `restore`. A new PID is
 * allocated on restore, but the `ChainId` is preserved. Tooling that cares
 * about "is this the same agent?" tracks `ChainId`, not `ProcessId`.
 *
 * Format: UUIDv4 string.
 *
 * See: docs/PROCESS.md §3.6, §11.3
 */
export type ChainId = Brand<string, 'ChainId'>;

/**
 * IPC channel identifier. Channels are created implicitly on first `send`
 * (see docs/ABI.md §9.3 — this is a known wart and may become explicit in v1).
 *
 * Format: opaque string, conventionally `namespace/name` (e.g. `cortex/init`).
 */
export type ChannelId = Brand<string, 'ChannelId'>;

/**
 * Byte offset into a process's append-only `.crec` syscall log. Used by
 * `Checkpoint.syscallLogOffset` to anchor a snapshot to a position in the
 * recording, and by `ForkResult.sharedCausalPast` to mark the divergence
 * point of two branches.
 *
 * See: docs/STATE.md §4, docs/ABI.md §6
 */
export type SyscallOffset = Brand<number, 'SyscallOffset'>;

/**
 * ISO8601 timestamp string. Returned by `ctx.now()`. In replay mode, returns
 * the recorded time, not wall-clock — this is what makes deterministic replay
 * possible.
 *
 * See: docs/ABI.md §4.6
 */
export type Timestamp = string;

/**
 * Opaque JSON Schema document. Tool drivers declare their input schemas in
 * this format; the kernel does not interpret it beyond passing it through to
 * the LLM driver.
 *
 * v0 type: structural minimum. v1 may adopt `json-schema` package types or
 * a stricter subset.
 */
export interface JSONSchema {
  readonly type?: string;
  readonly properties?: Readonly<Record<string, JSONSchema>>;
  readonly required?: readonly string[];
  readonly items?: JSONSchema;
  readonly description?: string;
  readonly [key: string]: unknown;
}

// =============================================================================
// §2. Reversibility
// =============================================================================

/**
 * Every syscall and every tool carries a reversibility tag. The tag drives
 * three kernel behaviors:
 *
 *   1. `forkable` region enforcement — irreversible calls inside a forkable
 *      block trap with `EREVERSIBLE`.
 *   2. Recording verbosity — irreversible calls are always recorded with full
 *      args and results; idempotent calls may be elided in compact mode.
 *   3. `cortex audit` — surfaces untagged tools so driver authors notice.
 *
 * See: docs/STATE.md §5.1, docs/ABI.md §5
 */
export type Reversibility = 'reversible' | 'idempotent' | 'irreversible';

// =============================================================================
// §3. Cognitive state
// =============================================================================

/**
 * One message in an LLM conversation. Matches the OpenAI/Anthropic shape
 * closely enough that drivers can adapt without translation.
 *
 * See: docs/STATE.md §7
 */
export interface Message {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCallId?: string;
  readonly name?: string;
}

/**
 * A tool call that has been issued but not yet completed. Recorded in the
 * cognitive snapshot so that on restore, the kernel knows to either re-issue
 * or surface the orphan to the agent.
 *
 * See: docs/STATE.md §7
 */
export interface PendingCall {
  readonly id: string;
  readonly tool: string;
  readonly args: unknown;
  readonly startedAt: Timestamp;
}

/**
 * The full cognitive state of an agent at a moment in time. This is the
 * largest part of a checkpoint and the only part that is *always* copyable
 * on fork — it is pure serializable JSON.
 *
 * See: docs/STATE.md §2.2, §7
 */
export interface CognitiveSnapshot {
  readonly messages: readonly Message[];
  readonly intent: string | null;
  readonly pendingCalls: readonly PendingCall[];
}

// =============================================================================
// §4. Memory
// =============================================================================

/**
 * A single entry in a memory region. `value` is opaque JSON; the kernel does
 * not interpret it.
 */
export interface MemoryEntry {
  readonly region: string;
  readonly key: string;
  readonly value: unknown;
  readonly at: Timestamp;
}

/**
 * Query parameters for `memory_read`. v0 supports key lookup, prefix scan,
 * and a `limit`. Semantic / vector search is a driver-specific extension
 * (drivers may add fields via `extra`).
 */
export interface MemoryQuery {
  readonly key?: string;
  readonly prefix?: string;
  readonly limit?: number;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Copy semantics for a memory region on `fork`:
 *   - `private` — deep copy on fork, branches diverge after.
 *   - `shared`  — both processes see the same backing store; writes are
 *                 visible to both. See docs/STATE.md §8.1 on concurrency.
 *   - `cow`     — copy-on-write. Reads shared until first write, then fork
 *                 the page.
 *
 * Defaults: `cow` for episodic, `shared` for semantic, `private` for
 * procedural. See docs/STATE.md §2.3.
 */
export type MemoryRegionKind = 'private' | 'shared' | 'cow';

/**
 * Policy for one memory region. `backing` names the `IMemoryDriver` that
 * stores it (e.g. `'sqlite'`, `'inmem'`, `'qdrant'`).
 */
export interface MemoryRegionPolicy {
  readonly kind: MemoryRegionKind;
  readonly backing: string;
}

/**
 * Optional parameters for `memory_write`. v0 supports TTL and a "do not
 * record value, only hash" mode for large payloads.
 */
export interface MemoryWriteOptions {
  readonly ttlMs?: number;
  readonly recordHashOnly?: boolean;
}

/**
 * The set of memory writes that have occurred since `baseChainId`. Used in
 * checkpoints to avoid duplicating the full memory state when an incremental
 * snapshot suffices.
 *
 * See: docs/STATE.md §4 (MemoryDelta block), §7
 */
export interface MemoryDelta {
  readonly baseChainId: ChainId | null;
  readonly writes: readonly MemoryEntry[];
}

// =============================================================================
// §5. Budgets
// =============================================================================

/**
 * Counters of what has been spent so far. Monotonically increasing for the
 * life of the process. Reset on `fork` per the configured policy.
 *
 * `usdSpent` is in **microdollars** (integer; 1 USD = 1_000_000). Integer
 * arithmetic avoids floating-point drift across long-running daemons.
 *
 * See: docs/STATE.md §2.4, §7
 */
export interface BudgetCounters {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly tokensCached: number;
  readonly usdSpent: number;
  readonly wallTimeMs: number;
  readonly syscallCount: number;
}

/**
 * Remaining budgets. `-1` means unlimited. Decrement on every relevant
 * syscall; when one hits zero, `SIGXCPU` fires.
 *
 * See: docs/PROCESS.md §8.3, §10
 */
export interface BudgetLimits {
  readonly tokens: number;
  readonly usd: number;
  readonly wallTimeMs: number;
}

/**
 * What happens to budgets on `fork`:
 *   - `reset`   — child starts at zero. Default. Treats fork as "new attempt."
 *   - `inherit` — child gets a copy of parent's remaining budgets.
 *   - `split`   — parent and child each get half of parent's remaining.
 *
 * See: docs/STATE.md §2.4, §8.2
 */
export type BudgetForkPolicy = 'reset' | 'inherit' | 'split';

// =============================================================================
// §6. Process state machine
// =============================================================================

/**
 * The eight states a cortex process can be in. Every legal transition is
 * enumerated in docs/PROCESS.md §5. Anything not in that table traps with
 * `EINVAL`.
 *
 * Lowercase string literals match the doc verbatim.
 *
 * See: docs/PROCESS.md §2, §3, §10
 */
export type ProcessState =
  | 'new'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'stopped'
  | 'checkpointing'
  | 'suspended'
  | 'exiting'
  | 'zombie';

/**
 * Why a process is BLOCKED. The kernel uses this to decide when to wake the
 * process. Surfaced in `cortex ps` so users can see at a glance what every
 * agent is waiting on.
 *
 * See: docs/PROCESS.md §3.7, §10
 */
export type BlockedReason =
  | { readonly kind: 'recv'; readonly channel: ChannelId }
  | { readonly kind: 'wait'; readonly pid: ProcessId }
  | { readonly kind: 'tool'; readonly callId: string }
  | { readonly kind: 'llm'; readonly callId: string }
  | { readonly kind: 'budget'; readonly until: Timestamp }
  | { readonly kind: 'lock'; readonly resource: string };

// =============================================================================
// §7. Signals
// =============================================================================

/**
 * Cortex signals. Unix-shaped, with agent-specific semantics for `SIGUSR1`
 * (reflect), `SIGUSR2` (checkpoint), `SIGXCPU` (budget exceeded), and
 * `SIGSYS` (bad syscall).
 *
 * `SIGKILL` and `SIGSTOP` cannot be caught, ignored, or blocked. This is
 * non-negotiable — without it, runaway agents cannot be stopped.
 *
 * See: docs/PROCESS.md §7, §10
 */
export type Signal =
  | 'SIGHUP'
  | 'SIGINT'
  | 'SIGTERM'
  | 'SIGKILL'
  | 'SIGSTOP'
  | 'SIGCONT'
  | 'SIGUSR1'
  | 'SIGUSR2'
  | 'SIGCHLD'
  | 'SIGXCPU'
  | 'SIGXFSZ'
  | 'SIGSYS'
  | 'SIGPIPE';

/**
 * What the kernel does when a signal is delivered:
 *   - `default` — kernel-defined behavior per the table in PROCESS.md §7.
 *   - `ignore`  — signal is dropped.
 *   - `handler` — kernel invokes a user-registered handler.
 */
export type SignalDisposition =
  | { readonly kind: 'default' }
  | { readonly kind: 'ignore' }
  | { readonly kind: 'handler'; readonly handler: SignalHandler };

/**
 * User-defined signal handler. Receives the same `CortexContext` the agent
 * function got, so handlers can call any syscall.
 *
 * Handlers run cooperatively: if the process is BLOCKED when a signal
 * arrives, the handler runs the moment the process becomes RUNNING again.
 *
 * See: docs/PROCESS.md §7.2, docs/ABI.md §4.7
 */
export type SignalHandler = (ctx: CortexContext) => Promise<void> | void;

// =============================================================================
// §8. Process info & filtering
// =============================================================================

/**
 * Snapshot of a process's state, returned by `ps()`. Read-only.
 *
 * See: docs/PROCESS.md §10
 */
export interface ProcessInfo {
  readonly pid: ProcessId;
  readonly ppid: ProcessId | null;
  readonly pgid: ProcessId;
  readonly role: string;
  readonly state: ProcessState;
  readonly blockedOn: BlockedReason | null;
  readonly nice: number;
  readonly startedAt: Timestamp;
  readonly lastTransitionAt: Timestamp;
  readonly budgetsRemaining: BudgetLimits;
  readonly budgetsSpent: BudgetCounters;
  readonly exitCode: number | null;
  readonly exitReason: string | null;
  readonly checkpointChain: readonly ChainId[];
  readonly pendingSignals: readonly Signal[];
}

/**
 * Filter for `ps()`. All fields are ANDed. Missing fields match anything.
 */
export interface ProcessFilter {
  readonly state?: ProcessState;
  readonly role?: string;
  readonly pgid?: ProcessId;
  readonly ppid?: ProcessId;
}

/**
 * Returned by `wait()`. Includes the syscall log range so the parent can
 * trace exactly what the child did between spawn and exit.
 *
 * See: docs/PROCESS.md §6.4, §10
 */
export interface WaitResult {
  readonly pid: ProcessId;
  readonly exitCode: number;
  readonly exitReason: string;
  readonly budgetsSpent: BudgetCounters;
  readonly syscallLogRange: readonly [SyscallOffset, SyscallOffset];
  readonly reapedAt: Timestamp;
}

// =============================================================================
// §9. Spawn
// =============================================================================

/**
 * How to load an agent. v0 supports two forms:
 *   - `{ module: '...' }` — path or import specifier to a module whose
 *     default export is `async (ctx) => void`.
 *   - `{ system: '...', tools?: [...] }` — a minimal "prompt-only" agent
 *     that loops `llm_call` until the model says stop. Useful for tests
 *     and trivial daemons.
 *
 * v1 may add `{ inline: (ctx) => Promise<void> }` for in-process agents,
 * but that breaks checkpointability across kernel restarts, so v0 keeps
 * agents in their own modules.
 */
export type AgentSpec =
  | { readonly module: string; readonly args?: Readonly<Record<string, unknown>> }
  | { readonly system: string; readonly tools?: readonly string[] };

/**
 * When and how init should restart a daemon.
 *
 * See: docs/PROCESS.md §9, §10
 */
export interface RestartPolicy {
  readonly kind: 'always' | 'on-failure' | 'never';
  readonly maxRestarts?: number;
  readonly backoffMs?: number;
  readonly windowMs?: number;
}

/**
 * Arguments to `spawn`. Every field except `role` and `agent` is optional
 * with a documented default.
 *
 * See: docs/PROCESS.md §6.1, §10
 */
export interface SpawnOptions {
  readonly role: string;
  readonly agent: AgentSpec;
  readonly parent?: ProcessId;
  readonly group?: ProcessId;
  readonly budgets?: Partial<BudgetLimits>;
  readonly nice?: number;
  readonly daemon?: boolean;
  readonly autoReap?: boolean;
  readonly restart?: RestartPolicy;
  readonly memory?: Readonly<Record<string, MemoryRegionPolicy>>;
  readonly signals?: Partial<Record<Signal, SignalDisposition>>;
  readonly exitTimeoutMs?: number;
}

// =============================================================================
// §10. Fork
// =============================================================================

/**
 * v0 ships only `cognitive`. `sandbox` and `shadow` are post-v0; see
 * docs/STATE.md §3.2 and §3.4.
 */
export type ForkKind = 'cognitive';

/**
 * Arguments to `fork`. Defaults are opinionated: cognitive fork, budgets
 * reset, driver state closed, no tag.
 *
 * See: docs/STATE.md §3.1, §7
 */
export interface ForkOptions {
  readonly kind?: ForkKind;
  readonly budgets?: BudgetForkPolicy;
  readonly memoryOverrides?: Partial<Record<string, MemoryRegionPolicy>>;
  readonly closeDriverState?: boolean;
  readonly tag?: string;
}

/**
 * Returned by `fork`. `sharedCausalPast` is the byte offset in the parent's
 * `.crec` log where the two branches diverge — useful for `cortex diff`.
 *
 * `irreversibleInPast` lists tool names that already happened before the
 * fork point. Both branches inherit the *memory* of these; the actions
 * themselves occurred exactly once in reality. See docs/STATE.md §5.4.
 *
 * See: docs/STATE.md §7
 */
export interface ForkResult {
  readonly childPid: ProcessId;
  readonly childChainId: ChainId;
  readonly sharedCausalPast: SyscallOffset;
  readonly irreversibleInPast: readonly string[];
}

// =============================================================================
// §11. Checkpoint / restore
// =============================================================================

/**
 * On-disk checkpoint format. CBOR-encoded, content-addressed by SHA-256.
 * The TypeScript shape mirrors the binary layout in docs/STATE.md §4.
 *
 * See: docs/STATE.md §4, §7
 */
export interface Checkpoint {
  readonly magic: 'CRTX';
  readonly version: number;
  readonly pid: ProcessId;
  readonly parentPid: ProcessId | null;
  readonly createdAt: Timestamp;
  readonly chainId: ChainId;
  readonly prevInChain: ChainId | null;
  readonly cognitive: CognitiveSnapshot;
  readonly memoryDelta: MemoryDelta;
  readonly budgets: BudgetCounters;
  readonly syscallLogOffset: SyscallOffset;
  readonly driverStates: Readonly<Record<string, Uint8Array | null>>;
  readonly signature: Uint8Array;
}

/**
 * Arguments to `checkpoint`. `detach: true` transitions the process to
 * SUSPENDED after the snapshot is written (used for cross-reboot pause);
 * `detach: false` (default) returns the process to READY.
 */
export interface CheckpointOptions {
  readonly tag?: string;
  readonly detach?: boolean;
  readonly includeDriverStates?: boolean;
}

/**
 * Arguments to `restore`. Restore creates a **new** process with a **new**
 * PID; the chain_id is preserved so tooling can track logical identity.
 *
 * See: docs/PROCESS.md §3.6, §11.3
 */
export interface RestoreOptions {
  readonly parent?: ProcessId;
  readonly group?: ProcessId;
  readonly budgets?: Partial<BudgetLimits>;
  readonly replayMode?: 'live' | 'cached' | 'strict';
}

// =============================================================================
// §12. LLM
// =============================================================================

/**
 * Tool schema advertised to the LLM. Drivers translate to vendor-specific
 * formats (OpenAI function calling, Anthropic tool use, etc.).
 */
export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchema;
}

/**
 * A tool invocation requested by the LLM. The agent decides whether to
 * actually execute it (via `tool_call`).
 */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

/**
 * Arguments to `llm_call`. The full request is recorded so replay can serve
 * the cached response without re-invoking the model.
 *
 * See: docs/ABI.md §4.3
 */
export interface LLMRequest {
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSchema[];
  readonly driver?: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly seed?: number;
  readonly timeoutMs?: number;
}

/**
 * Returned by `llm_call`. Token usage is recorded verbatim into budget
 * counters; the kernel does not re-count.
 *
 * See: docs/ABI.md §4.3
 */
export interface LLMResponse {
  readonly text: string | null;
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason:
    | 'stop'
    | 'length'
    | 'tool_use'
    | 'content_filter'
    | 'timeout'
    | 'error';
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedTokens: number;
    readonly usd: number;
  };
  readonly model: string;
  readonly driverVersion: string;
}

/**
 * Streaming chunk shape (post-v0). Defined here so the recording format
 * already supports it; the syscall surface does not yet expose it.
 *
 * See: docs/ABI.md §9.1
 */
export interface LLMChunk {
  readonly deltaText?: string;
  readonly deltaToolCall?: Partial<ToolCall>;
  readonly done: boolean;
  readonly finishReason?: LLMResponse['finishReason'];
}

// =============================================================================
// §13. Tools
// =============================================================================

/**
 * Static description of one tool, returned by `IToolDriver.listTools()`.
 * `reversibility` is declared by the driver author and trusted by the
 * kernel; `cortex audit` surfaces untagged tools.
 *
 * See: docs/ABI.md §5, docs/STATE.md §8.7
 */
export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  readonly reversibility: Reversibility;
  readonly estimatedCostUsd?: number;
  readonly timeoutMs?: number;
}

/**
 * Per-invocation context handed to the driver. Carries the calling PID and
 * a `callId` so the driver can correlate its own logs with the kernel's
 * `.crec` recording.
 */
export interface ToolInvokeContext {
  readonly pid: ProcessId;
  readonly callId: string;
  readonly deadline: Timestamp;
  readonly abortSignal: AbortSignal;
}

/**
 * Optional parameters for `tool_call`. v0 supports per-call timeout override
 * and a "stage only, do not commit" mode for two-phase tools.
 *
 * See: docs/ABI.md §4.3, docs/STATE.md §5.3
 */
export interface ToolCallOptions {
  readonly timeoutMs?: number;
  readonly stageOnly?: boolean;
}

/**
 * Returned by `tool_call`. `output` is opaque JSON; the kernel does not
 * interpret it. `reversibility` is the driver's declared tag, surfaced here
 * so the agent can decide whether it is safe to fork past this point.
 */
export interface ToolResult {
  readonly output: unknown;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly durationMs: number;
  readonly reversibility: Reversibility;
}

/**
 * A staged-but-not-committed action. Used by the two-phase pattern in
 * docs/STATE.md §5.3: stage before the fork point, commit after.
 */
export interface StagedAction {
  readonly id: string;
  readonly tool: string;
  readonly args: unknown;
  readonly expiresAt: Timestamp;
}

// =============================================================================
// §14. IPC
// =============================================================================

/**
 * IPC message envelope. Distinct from `Message` (which is an LLM
 * conversation message). The two were both called `Message` in early doc
 * drafts; the rename to `IpcMessage` is a v0 clarification.
 *
 * Note: docs/ABI.md §4.5 still uses `Message` as the return type of `recv`.
 * That doc will be updated in a follow-up commit.
 */
export interface IpcMessage {
  readonly from: ProcessId | ChannelId;
  readonly to: ProcessId | ChannelId;
  readonly body: unknown;
  readonly sentAt: Timestamp;
  readonly callId?: string;
}

/**
 * Optional parameters for `send`. v0 supports non-blocking mode and a
 * queue-depth limit.
 */
export interface SendOptions {
  readonly blocking?: boolean;
  readonly queueLimit?: number;
}

/**
 * Optional parameters for `recv`. v0 supports non-blocking mode and a
 * timeout. Blocking by default per docs/ABI.md §4.5.
 */
export interface RecvOptions {
  readonly blocking?: boolean;
  readonly timeoutMs?: number;
}

// =============================================================================
// §15. Time and determinism
// =============================================================================

/**
 * Optional parameters for `random`. v0 supports a per-call seed override
 * (rarely used; mostly the process-level seed is enough).
 *
 * See: docs/ABI.md §4.6
 */
export interface RandomOptions {
  readonly seed?: number;
}

// =============================================================================
// §16. Driver context
// =============================================================================

/**
 * Context handed to LLM drivers on every call. Carries enough info for the
 * driver to do its own logging and budgeting without reaching back into
 * kernel internals.
 */
export interface DriverContext {
  readonly pid: ProcessId;
  readonly callId: string;
  readonly deadline: Timestamp;
  readonly abortSignal: AbortSignal;
  readonly kernelAbiVersion: string;
}

// =============================================================================
// §17. Driver interfaces
// =============================================================================

/**
 * LLM driver. One per vendor (deepseek, openai, mock, ...). Multiple
 * instances may be registered under different names.
 *
 * See: docs/ABI.md §7.1
 */
export interface ILLMDriver {
  readonly name: string;
  readonly version: string;
  readonly abiCompat: string;
  readonly supportedModels: readonly string[];

  call(req: LLMRequest, ctx: DriverContext): Promise<LLMResponse>;
  stream?(req: LLMRequest, ctx: DriverContext): AsyncIterable<LLMChunk>;
  countTokens?(messages: readonly Message[]): Promise<number>;
  close(): Promise<void>;
}

/**
 * Tool driver. The MCP integration is implemented as a tool driver that
 * proxies to any MCP server.
 *
 * See: docs/ABI.md §7.2
 */
export interface IToolDriver {
  readonly name: string;
  readonly version: string;
  readonly abiCompat: string;

  listTools(): Promise<readonly ToolDescriptor[]>;
  invoke(name: string, args: unknown, ctx: ToolInvokeContext): Promise<ToolResult>;

  stage?(name: string, args: unknown, ctx: ToolInvokeContext): Promise<StagedAction>;
  commit?(staged: StagedAction, ctx: ToolInvokeContext): Promise<ToolResult>;

  /**
   * Driver claims it can survive a cognitive fork. Kernel does not trust
   * this claim without tests in v0; see docs/STATE.md §8.6.
   */
  readonly forkable?: boolean;
  serializeState?(): Promise<Uint8Array | null>;
  restoreState?(blob: Uint8Array): Promise<void>;

  close(): Promise<void>;
}

/**
 * Memory driver. Backs the named regions configured at `spawn`.
 *
 * `snapshotRegion` and `restoreRegion` are required so the kernel can
 * implement fork and checkpoint without reaching into driver internals.
 *
 * See: docs/ABI.md §7.3
 */
export interface IMemoryDriver {
  readonly name: string;
  readonly version: string;
  readonly abiCompat: string;

  read(region: string, query: MemoryQuery): Promise<readonly MemoryEntry[]>;
  write(
    region: string,
    key: string,
    value: unknown,
    opts?: MemoryWriteOptions,
  ): Promise<void>;
  delete(region: string, key: string): Promise<void>;
  listRegions(): Promise<readonly string[]>;

  snapshotRegion(region: string): Promise<Uint8Array>;
  restoreRegion(region: string, blob: Uint8Array): Promise<void>;

  close(): Promise<void>;
}

// =============================================================================
// §18. Recording format
// =============================================================================

/**
 * One record in a `.crec` file. Two records per syscall: `enter` and one of
 * `exit` / `trap`. CBOR-encoded with a length prefix; see docs/ABI.md §6.
 *
 * The TypeScript shape mirrors the binary layout. The recorder writes
 * `args` only on `enter`, `result` only on `exit`, `error` only on `trap`.
 */
export interface SyscallRecord {
  readonly byteOffset: SyscallOffset;
  readonly timestamp: Timestamp;
  readonly pid: ProcessId;
  readonly syscall: string;
  readonly callId: string;
  readonly phase: 'enter' | 'exit' | 'trap';
  readonly args?: unknown;
  readonly result?: unknown;
  readonly error?: {
    readonly errno: string;
    readonly message: string;
    readonly details?: unknown;
  };
  readonly durationMs?: number;
  readonly stateBefore: ProcessState;
  readonly stateAfter: ProcessState;
  readonly reversibility: Reversibility;
  readonly kernelAbiVersion: string;
}

// =============================================================================
// §19. The kernel surface (CortexContext)
// =============================================================================

/**
 * The entire kernel surface available to an agent function. There is no
 * other way to talk to the kernel.
 *
 * Eighteen syscalls plus four identity properties plus `forkable()` as a
 * structured wrapper around reversibility enforcement.
 *
 * See: docs/ABI.md §2.1, §8
 */
export interface CortexContext {
  // ---------------------------------------------------------------------------
  // Identity (properties, not syscalls — see docs/ABI.md §2.4)
  // ---------------------------------------------------------------------------
  readonly pid: ProcessId;
  readonly ppid: ProcessId | null;
  readonly pgid: ProcessId;
  readonly role: string;

  // ---------------------------------------------------------------------------
  // §4.1 Process control
  // ---------------------------------------------------------------------------
  spawn(opts: SpawnOptions): Promise<{ readonly pid: ProcessId }>;
  wait(pid?: ProcessId): Promise<WaitResult>;
  exit(code: number, reason?: string): never;
  kill(pid: ProcessId, signal: Signal): Promise<void>;
  ps(filter?: ProcessFilter): Promise<readonly ProcessInfo[]>;

  // ---------------------------------------------------------------------------
  // §4.2 State management
  // ---------------------------------------------------------------------------
  fork(opts?: ForkOptions): Promise<ForkResult>;
  checkpoint(opts?: CheckpointOptions): Promise<{ readonly chainId: ChainId }>;
  restore(
    chainId: ChainId,
    opts?: RestoreOptions,
  ): Promise<{ readonly pid: ProcessId }>;

  // ---------------------------------------------------------------------------
  // §4.3 Cognition
  // ---------------------------------------------------------------------------
  llm_call(req: LLMRequest): Promise<LLMResponse>;
  tool_call(
    name: string,
    args: unknown,
    opts?: ToolCallOptions,
  ): Promise<ToolResult>;

  // ---------------------------------------------------------------------------
  // §4.4 Memory
  // ---------------------------------------------------------------------------
  memory_read(
    region: string,
    query: MemoryQuery,
  ): Promise<readonly MemoryEntry[]>;
  memory_write(
    region: string,
    key: string,
    value: unknown,
    opts?: MemoryWriteOptions,
  ): Promise<void>;

  // ---------------------------------------------------------------------------
  // §4.5 IPC
  // ---------------------------------------------------------------------------
  send(
    target: ProcessId | ChannelId,
    message: unknown,
    opts?: SendOptions,
  ): Promise<void>;
  recv(source?: ChannelId, opts?: RecvOptions): Promise<IpcMessage>;

  // ---------------------------------------------------------------------------
  // §4.6 Time and determinism
  // ---------------------------------------------------------------------------
  sleep(ms: number): Promise<void>;
  now(): Timestamp;
  random(opts?: RandomOptions): number;

  // ---------------------------------------------------------------------------
  // §4.7 Signals
  // ---------------------------------------------------------------------------
  on_signal(
    signal: Signal,
    handler: SignalHandler | 'default' | 'ignore',
  ): void;

  // ---------------------------------------------------------------------------
  // §4.8 Budgets
  // ---------------------------------------------------------------------------
  budget(): BudgetCounters;

  // ---------------------------------------------------------------------------
  // Forkable regions (docs/STATE.md §5.2)
  // ---------------------------------------------------------------------------
  forkable<T>(fn: () => Promise<T>): Promise<T>;
}

// =============================================================================
// §20. Brand constructors (kernel-internal)
// =============================================================================

/**
 * Construct a `ProcessId` from a raw number. Kernel-internal; user space
 * should never need this. The function exists so the brand is not just a
 * compile-time lie — every branded value passes through one of these.
 *
 * @internal
 */
export function asProcessId(n: number): ProcessId {
  return n as ProcessId;
}

/** @internal */
export function asChainId(s: string): ChainId {
  return s as ChainId;
}

/** @internal */
export function asChannelId(s: string): ChannelId {
  return s as ChannelId;
}

/** @internal */
export function asSyscallOffset(n: number): SyscallOffset {
  return n as SyscallOffset;
}

/**
 * Strip a brand. Used at the kernel ↔ driver boundary, where drivers see
 * raw `number` / `string` and should not have to know about brands.
 *
 * @internal
 */
export function unbrand<T, B extends string>(v: Brand<T, B>): T {
  return v as T;
}
