# Cortex Syscall ABI

> The contract between agents and the kernel.
>
> **If a behavior is not in this document, it does not exist.**

Read [`STATE.md`](./STATE.md) and [`PROCESS.md`](./PROCESS.md) first. This document defines what agents can *ask the kernel to do*; the other two define what they *are* and how they *change over time*.

---

## 1. Why this document exists

Every OS lives or dies by its syscall ABI. POSIX is ~300 syscalls and fifty years of compatibility. Plan 9 fit the whole world into ~30. seL4 fits a verifiable kernel into ~20.

Cortex aims for **nineteen** in v0. Not because nineteen is magic, but because every syscall we add is one more thing every driver, every test, every recording, every replay engine has to handle. Syscalls are forever. We pick carefully.

This document is the contract. The kernel implements it. Agents depend on it. Drivers conform to it. The recording format encodes it. If we get it right, third parties can build cortex-compatible tooling without ever talking to us. If we get it wrong, we will spend years apologizing.

---

## 2. Calling convention

### 2.1 The `ctx` object

Every agent function receives a single argument: a `CortexContext`. This object is **the entire kernel surface**. There is no other way to talk to the kernel.

```typescript
export default async function agent(ctx: CortexContext) {
  const result = await ctx.llm_call({ messages: [...] });
  await ctx.memory_write('notes', 'last_result', result);
  ctx.exit(0);
}
```

The `ctx` object is per-process. Two agents in two processes have two different `ctx` instances even if they run in the same Node.js VM. The kernel routes calls based on which `ctx` invoked them.

### 2.2 Syscalls are async

Most syscalls return `Promise<T>`. Even ones that look synchronous (`now()`, `budget()`) are sync because they read kernel state without blocking — but they are still syscalls and still recorded.

The reason: an agent process must be **interruptible**. While `await`-ing an LLM call, the process moves to BLOCKED, the scheduler runs other processes, signals can be delivered, checkpoints can be written. None of that works if syscalls are synchronous.

### 2.3 Naming convention

Multi-word syscalls use `snake_case`: `llm_call`, `tool_call`, `memory_read`, `memory_write`, `on_signal`.

Single-word syscalls use the obvious form: `spawn`, `wait`, `exit`, `kill`, `ps`, `fork`, `checkpoint`, `restore`, `send`, `recv`, `sleep`, `now`, `random`, `budget`.

This is deliberate. Snake case visually marks the kernel boundary. When you read agent code, you should be able to spot syscalls at a glance. Linters be damned; we will ship an eslint preset that allows it.

### 2.4 What is *not* a syscall

Things that look like syscalls but aren't:

- Property reads (`ctx.pid`, `ctx.ppid`, `ctx.pgid`, `ctx.role`) — these are immutable identity fields, not state queries.
- Pure user-space computation in agent code (loops, conditionals, function calls within the agent).
- Direct calls to npm libraries (e.g. `axios.get(...)`) — **these bypass the kernel and will not be recorded**. Agents that need observability should wrap external calls in `ctx.tool_call(...)`.

This last point is important. Cortex cannot record what it does not see. If your agent does `fetch(...)` directly, the recording has a hole in it and replay will diverge.

---

## 3. The error model

### 3.1 Every syscall can fail

Syscalls throw `CortexError` on failure. The error has an `errno`, a human-readable `message`, and optional `details`.

```typescript
class CortexError extends Error {
  readonly errno: Errno;
  readonly syscall: string;
  readonly details?: unknown;
}
```

### 3.2 Errno table

Modeled on POSIX where possible. New codes prefixed with `E` and documented here.

| Errno | Meaning | Typical syscalls |
|---|---|---|
| `EINVAL` | Invalid argument | all |
| `ESRCH` | No such process | `kill`, `wait`, `send` |
| `ENOENT` | No such entity (memory region, channel, snapshot) | `memory_read`, `recv`, `restore` |
| `EAGAIN` | Resource temporarily unavailable; retry | `recv` (non-blocking), `spawn` (PID exhaustion — should never happen) |
| `EINTR` | Syscall interrupted by signal | any blocking syscall |
| `EPERM` | Permission denied | `kill` (cross-group), driver-internal |
| `ETIMEDOUT` | Driver or kernel timeout | `llm_call`, `tool_call`, `recv` |
| `ENOMEM` | Memory region full or budget exhausted | `memory_write` |
| `EBADF` | Bad channel/file descriptor | `send`, `recv` |
| `ECHILD` | No child processes | `wait` |
| `EBUDGET` | Token / USD / wall-time budget exhausted | `llm_call`, `tool_call`, `spawn` |
| `EREVERSIBLE` | Irreversible syscall attempted inside a `forkable` region | `tool_call`, `exit` |
| `EDRIVER` | Driver returned a non-conforming response | `llm_call`, `tool_call`, `memory_read`, `memory_write` |
| `ESTATE` | Syscall not allowed in current process state | all (see PROCESS.md §5) |
| `ERECORD` | Recording subsystem failure (disk full, etc.) | all |

### 3.3 Trap vs return

A **trap** is a synchronous error that aborts the syscall before any side effect occurs. Example: `kill(999999, 'SIGTERM')` traps with `ESRCH` because no such PID exists. Nothing is logged except the trap itself.

A **return-with-error** is an asynchronous failure after partial work. Example: `llm_call(...)` that times out after the driver has already sent the request. The syscall is logged with its error; tokens may have been spent; the agent must decide what to do.

The distinction matters for replay. Traps are deterministic. Return-with-errors may not be — they depend on real-world conditions.

---

## 4. The syscalls

Nineteen syscalls, grouped by purpose.

### 4.1 Process control

#### `spawn(opts: SpawnOptions): Promise<{ pid: ProcessId }>`

Create a new agent process. See PROCESS.md §6.1 for the full lifecycle.

- **Allowed states:** RUNNING
- **State effect:** caller stays RUNNING; child enters NEW
- **Returns:** the child's PID
- **Errors:** `EINVAL` (bad opts), `EBUDGET` (insufficient budget to inherit), `EDRIVER` (agent module failed to load)
- **Reversibility:** `reversible` — the child can be killed
- **Recording:** full `SpawnOptions`, returned PID, timestamp

```typescript
const child = await ctx.spawn({
  role: 'researcher',
  agent: { module: './agents/researcher.js' },
  budgets: { usd: 5_000_000 },
  restart: { kind: 'on-failure', maxRestarts: 3 },
});
```

#### `wait(pid?: ProcessId, opts?: WaitOptions): Promise<WaitResult>`

Block until a child exits. If `pid` is omitted, wait for any child.

- **Allowed states:** RUNNING → BLOCKED (`{kind: 'wait', pid}`) → READY → RUNNING
- **Returns:** `WaitResult` (see PROCESS.md §10)
- **Errors:** `ECHILD` (no children), `ESRCH` (specific PID is not your child and was never reaped as yours), `ETIMEDOUT` (`timeoutMs` elapsed), `EINTR` (signal delivered while waiting)
- **Reversibility:** `idempotent` — calling twice on the same zombie returns the same result the first time and `ECHILD` the second
- **Recording:** the PID waited on, the result

`WaitOptions`:

```typescript
interface WaitOptions {
  /** Maximum time to park, in ms. `0` polls; omit to wait forever. */
  readonly timeoutMs?: number;
}
```

  - `timeoutMs: undefined` — wait indefinitely (the POSIX default).
  - `timeoutMs: 0` — **poll**: return the child's status if it has already
    exited, otherwise trap `ETIMEDOUT` immediately without ever parking.
  - `timeoutMs: n` — park for at most `n` ms.

A timeout is an **observation, not a punishment**: on `ETIMEDOUT` the child is
left running and the caller is returned to READY. Killing it is the
supervisor's decision, expressed as a separate `kill()` — which is what makes a
restart policy expressible inside the supervisor itself:

```typescript
try {
  await ctx.wait(child, { timeoutMs: 10_000 });
} catch {
  await ctx.kill(child, 'SIGKILL');           // my policy, my call
  const { pid } = await ctx.spawn({ /* fresh attempt */ });
  await ctx.wait(pid);
}
```

**Late waits still work.** init auto-reaps zombies, so a child can be gone
before its parent gets around to waiting for it (the common case when a
supervisor waits for child A, does work, then waits for child B). The table
therefore retains each reaped child's `WaitResult` for its parent
(`ProcessTable.takeReapedChild` / `takeReapedChildAny`), and `wait()` consumes
it. Without that, a late `wait()` would trap `ESRCH` or park forever, and
supervision trees would not be expressible at all. Statuses are consumed once,
exactly like a real reap.

#### `exit(code: number, reason?: string): never`

Terminate self. State goes RUNNING → EXITING → ZOMBIE.

- **Allowed states:** any (the kernel handles cleanup)
- **Returns:** never (the process is gone)
- **Errors:** none (exit always succeeds)
- **Reversibility:** `irreversible` — you cannot un-exit. Traps with `EREVERSIBLE` inside a `forkable` region.
- **Recording:** code, reason, final budget counters

#### `kill(pid: ProcessId, signal: Signal): Promise<void>`

Send a signal to another process. Use negative `pid` to signal a process group (Unix convention).

- **Allowed states:** RUNNING
- **Returns:** nothing (signal delivery is fire-and-forget)
- **Errors:** `ESRCH` (no such PID), `EPERM` (cross-group signal in restricted mode), `EINVAL` (unknown signal)
- **Reversibility:** depends on the signal. `SIGKILL` and `SIGTERM` are `irreversible`; `SIGUSR1`/`SIGUSR2`/`SIGCONT` are `reversible`.
- **Recording:** target, signal, delivery status

#### `ps(filter?: ProcessFilter): Promise<readonly ProcessInfo[]>`

Inspect the process table. Read-only.

- **Allowed states:** RUNNING
- **Returns:** array of `ProcessInfo`
- **Errors:** none in v0
- **Reversibility:** `idempotent`
- **Recording:** the filter, the count returned (not the full result — that would bloat logs)

### 4.2 State management

#### `fork(opts?: ForkOptions): Promise<ForkResult>`

Duplicate the calling process per STATE.md §3.1 (cognitive fork).

- **Allowed states:** RUNNING, BLOCKED, STOPPED, SUSPENDED (the last via `restore`)
- **State effect:** caller unchanged; child enters NEW
- **Returns:** `ForkResult` with child PID, child chain ID, shared causal past offset, list of irreversible actions already in past
- **Errors:** `EBUDGET` (cannot allocate child budgets), `EDRIVER` (a driver refused to close cleanly)
- **Reversibility:** `reversible` — the child can be killed
- **Recording:** options, child PID, shared causal past offset

```typescript
const { childPid, irreversibleInPast } = await ctx.fork({ budgets: 'split' });
if (irreversibleInPast.includes('send_email')) {
  console.warn('Both branches remember sending the email.');
}
```

#### `checkpoint(opts?: CheckpointOptions): Promise<{ chainId: ChainId }>`

Write a snapshot to disk per STATE.md §4. State briefly enters CHECKPOINTING then returns to RUNNING (or SUSPENDED with `detach: true`).

- **Allowed states:** RUNNING, BLOCKED, STOPPED
- **Returns:** the new `chainId`
- **Errors:** `ERECORD` (disk failure), `EDRIVER` (a driver could not serialize its state)
- **Reversibility:** `idempotent` — multiple checkpoints are fine
- **Recording:** options, chainId, byte size of snapshot

#### `restore(chainId: ChainId, opts?: RestoreOptions): Promise<{ pid: ProcessId }>`

Create a **new** process from a checkpoint. The new process gets a new PID (PROCESS.md §3.6, §11.3).

The kernel adopts the process before returning: it is walked NEW → READY and
enqueued, so it is *runnable* — the scheduler will dispatch it like any spawned
process. (`CheckpointManager.restoreAs` still mints it in NEW; the adoption is
the syscall's job, so a caller who wants an unadopted image can use the manager
directly. Until `0.2.0` the syscall skipped this and a restored process sat in
NEW until something outside the kernel walked it forward — the CLI carried a
stopgap for exactly this.)

- **Allowed states:** RUNNING (caller is unaffected; restore is morally a `spawn` from the past)
- **Returns:** the new PID
- **Errors:** `ENOENT` (no such chainId), `EINVAL` (snapshot version mismatch), `EDRIVER` (driver state could not be re-hydrated)
- **Reversibility:** `reversible`
- **Recording:** chainId, new PID, options

### 4.3 Cognition

#### `llm_call(req: LLMRequest): Promise<LLMResponse>`

Invoke an LLM via the configured driver. This is the syscall that makes cortex an *agent* OS rather than a generic process OS.

- **Allowed states:** RUNNING → BLOCKED (`{kind: 'llm', callId}`) → READY → RUNNING
- **Returns:** `LLMResponse` (text, tool calls, token usage, finish reason)
- **Errors:** `EBUDGET` (insufficient tokens/USD), `ETIMEDOUT` (driver timeout), `EDRIVER` (malformed response), `EINTR` (signal during call)
- **Reversibility:** `reversible` (it's just tokens; the response is recorded and replayable)
- **Recording:** full request, full response, token counts, latency, model name, driver version

This is the most-recorded syscall. The recording is what makes deterministic replay possible.

```typescript
interface LLMRequest {
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSchema[];
  readonly driver?: string;          // override default LLM driver
  readonly model?: string;           // override default model
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly seed?: number;            // for reproducibility where supported
  readonly timeoutMs?: number;       // default 60_000
}

interface LLMResponse {
  readonly text: string | null;
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason: 'stop' | 'length' | 'tool_use' | 'content_filter' | 'timeout' | 'error';
  readonly usage: { inputTokens: number; outputTokens: number; cachedTokens: number; usd: number };
  readonly model: string;
  readonly driverVersion: string;
}
```

#### `tool_call(name: string, args: unknown, opts?: ToolCallOptions): Promise<ToolResult>`

Invoke a tool by name. Tools are provided by `IToolDriver` implementations (typically MCP servers).

- **Allowed states:** RUNNING → BLOCKED (`{kind: 'tool', callId}`) → READY → RUNNING
- **Returns:** `ToolResult` (output, error if any, reversibility tag from driver)
- **Errors:** `ENOENT` (no such tool), `EINVAL` (args don't match schema), `ETIMEDOUT`, `EDRIVER`, `EPERM` (capability denied — post-v0), `EREVERSIBLE` (irreversible tool inside `forkable` region)
- **Reversibility:** **declared by the tool's driver**, not by the kernel. See §5.
- **Recording:** name, args, result, duration, declared reversibility

```typescript
const result = await ctx.tool_call('grep', { pattern: 'TypeError', path: 'src/' });
```

### 4.4 Memory

#### `memory_read(region: string, query: MemoryQuery): Promise<readonly MemoryEntry[]>`

Read entries from a named memory region. Regions are configured at `spawn()` per STATE.md §2.3.

- **Allowed states:** RUNNING (may briefly BLOCK on backing store I/O)
- **Returns:** matching entries
- **Errors:** `ENOENT` (no such region), `EDRIVER`
- **Reversibility:** `idempotent`
- **Recording:** region, query, count returned, hash of returned values (full values would bloat logs)

#### `memory_write(region: string, key: string, value: unknown, opts?: MemoryWriteOptions): Promise<void>`

Write a value to a memory region.

- **Allowed states:** RUNNING
- **Returns:** nothing
- **Errors:** `ENOENT` (no such region), `ENOMEM` (region reached its effective write-count ceiling — the region's own `maxEntries` if declared via `--memory`, else the kernel-wide `maxRegionEntries`; unlimited when neither is set, and a per-region `maxEntries: -1` opts that region out of a lower global cap), `EDRIVER`, `EPERM` (region is read-only)
- **Reversibility:** `reversible` — every write is logged and can be undone from the log
- **Recording:** region, key, value (or value hash if large), policy kind

### 4.5 IPC

#### `send(target: ProcessId | ChannelId, message: unknown): Promise<void>`

Send a message to another process or a named channel. Non-blocking by default.

- **Allowed states:** RUNNING
- **Returns:** nothing once the message is enqueued
- **Errors:** `ESRCH` (no such process), `EBADF` (no such channel), `EAGAIN` (queue full and `blocking: false`)
- **Reversibility:** `idempotent` *if* the receiver hasn't consumed it; otherwise effectively `irreversible` (you can't unsay it). v0 records the ambiguity honestly.
- **Recording:** target, message, queue depth at send time

#### `recv(source?: ChannelId, opts?: RecvOptions): Promise<Message>`

Receive a message. Blocking by default.

- **Allowed states:** RUNNING → BLOCKED (`{kind: 'recv', channel}`) → READY → RUNNING
- **Returns:** the message
- **Errors:** `EAGAIN` (non-blocking and queue empty), `EINTR` (signal delivered), `ETIMEDOUT` (`timeoutMs` elapsed), `EBADF`
- **Reversibility:** `irreversible` once consumed (the message is gone from the queue). Recording captures the message so replay can re-deliver.
- **Recording:** source, message, wait duration

### 4.6 Time and determinism

#### `sleep(ms: number): Promise<void>`

Yield to the scheduler for at least `ms` milliseconds. The caller really is
parked: it sits in BLOCKED with `blockedOn.kind === 'sleep'` for the duration,
is made READY when the timer fires, and resumes on its next dispatch.

- **Allowed states:** RUNNING → BLOCKED (`{kind: 'sleep', until}`) → READY → RUNNING
- **Returns:** nothing
- **Errors:** `EINVAL` (negative or non-finite `ms`)
- **Reversibility:** `idempotent`
- **Recording:** requested ms, actual ms (replay may differ)

A sleeping process is `blocked`, not `runnable` — that is the whole point, and
it is what `ps()` reports. Waking goes through the wake gate (`wake_gate.ts`):
the body's `await` returns only after the scheduler has dispatched the process
again, so the instruction after `sleep()` never runs while the process is still
BLOCKED. `exit` cancels a pending sleep timer, so a killed sleeper cannot leave
one armed.

#### `now(): Timestamp`

Return the current time. **In replay mode, returns the recorded time, not wall-clock.** This is what makes deterministic replay possible.

- **Allowed states:** any
- **Returns:** ISO8601 string
- **Errors:** none
- **Reversibility:** `idempotent`
- **Recording:** the value returned (so replay can serve the same)

#### `random(opts?: RandomOptions): number`

Return a random number in `[0, 1)`. **In replay mode, returns the recorded value.** Seeds are tracked per process.

- **Allowed states:** any
- **Returns:** float in `[0, 1)`
- **Errors:** none
- **Reversibility:** `idempotent` (within a replay)
- **Recording:** the value returned, the seed state

Agents that need true entropy (e.g. cryptographic) should call `tool_call('crypto.randomBytes', ...)` instead, which is explicitly non-replayable.

### 4.7 Signals

#### `on_signal(signal: Signal, handler: SignalHandler): void`

Register a handler for a signal. Replaces the default disposition (PROCESS.md §7).

- **Allowed states:** RUNNING (synchronous registration)
- **Returns:** nothing
- **Errors:** `EINVAL` (unknown signal), `EPERM` (cannot catch `SIGKILL` or `SIGSTOP`)
- **Reversibility:** `reversible` — handlers can be unregistered with `on_signal(sig, 'default')`
- **Recording:** registration event

```typescript
ctx.on_signal('SIGUSR1', async (ctx) => {
  // "Reflect" — write a self-summary to memory
  const summary = await ctx.llm_call({ messages: [...ctx.history, { role: 'user', content: 'Summarize what you have done so far.' }] });
  await ctx.memory_write('reflections', ctx.now(), summary.text);
});
```

### 4.8 Budgets

#### `budget(): BudgetCounters`

Return current budget state (spent and remaining). Read-only.

- **Allowed states:** any
- **Returns:** `BudgetCounters` (see STATE.md §7)
- **Errors:** none
- **Reversibility:** `idempotent`
- **Recording:** not recorded (would bloat logs); derived from other syscalls' recordings

---

## 5. Reversibility tagging

Every syscall has a reversibility tag, defined in STATE.md §5.1. Tags drive three behaviors:

1. **Forkable region enforcement.** An `irreversible` syscall inside a `forkable(async () => { ... })` block traps with `EREVERSIBLE`.
2. **Recording verbosity.** `Irreversible` syscalls are always recorded with full args and results. `Idempotent` syscalls may be elided in compact recordings.
3. **Audit tooling.** `cortex audit` (BACKLOG #040) surfaces untagged tools so driver authors notice.

For tool calls, the tag comes from the driver:

```typescript
interface IToolDriver {
  readonly name: string;
  listTools(): Promise<readonly ToolDescriptor[]>;
  invoke(name: string, args: unknown, ctx: ToolInvokeContext): Promise<ToolResult>;
}

interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  readonly reversibility: 'reversible' | 'idempotent' | 'irreversible';
  readonly estimatedCostUsd?: number;   // for budget pre-flight
  readonly timeoutMs?: number;          // default 30_000
}
```

A driver that lies about reversibility will produce subtly broken forks. We do not have a way to detect this in v0. See §10.

---

## 6. Recording format

Every syscall produces a record in the process's `.crec` file. Format: append-only, framed CBOR (BACKLOG #010 will lock this).

```
Record layout:
  byte_offset:    u64         # position in file
  timestamp:      ISO8601
  pid:            ProcessId
  syscall:        string      # 'llm_call', 'spawn', etc.
  call_id:        uuid        # correlates request and response
  phase:          'enter' | 'exit' | 'trap'
  args:           CBOR        # only on 'enter'
  result:         CBOR        # only on 'exit'
  error:          { errno, message, details }   # only on 'trap'
  duration_ms:    u64         # only on 'exit' / 'trap'
  state_before:   ProcessState
  state_after:    ProcessState
  reversibility:  'reversible' | 'idempotent' | 'irreversible'
```

Two records per syscall (enter + exit/trap). This is what allows the recording to be streamed and partially replayed.

The byte offsets are what `checkpoint.syscallLogOffset` references (STATE.md §4).

---

## 7. Driver interfaces

Three driver types in v0. Each is independently loadable. Each can have multiple implementations registered.

### 7.1 `ILLMDriver`

```typescript
interface ILLMDriver {
  readonly name: string;          // 'deepseek', 'openai', 'mock'
  readonly version: string;
  readonly supportedModels: readonly string[];

  call(req: LLMRequest, ctx: DriverContext): Promise<LLMResponse>;

  // Optional: for streaming responses (post-v0)
  stream?(req: LLMRequest, ctx: DriverContext): AsyncIterable<LLMChunk>;

  // Optional: token counting without invoking
  countTokens?(messages: readonly Message[]): Promise<number>;

  // Required: cleanup on process exit
  close(): Promise<void>;
}
```

### 7.2 `IToolDriver`

```typescript
interface IToolDriver {
  readonly name: string;          // 'mcp:filesystem', 'fs', 'shell'
  readonly version: string;

  listTools(): Promise<readonly ToolDescriptor[]>;
  invoke(name: string, args: unknown, ctx: ToolInvokeContext): Promise<ToolResult>;

  // Optional: for STATE.md §5.3 two-phase pattern
  stage?(name: string, args: unknown, ctx: ToolInvokeContext): Promise<StagedAction>;
  commit?(staged: StagedAction, ctx: ToolInvokeContext): Promise<ToolResult>;

  // Optional: claim fork-safety (STATE.md §2.5)
  forkable?: boolean;
  serializeState?(): Promise<Uint8Array | null>;
  restoreState?(blob: Uint8Array): Promise<void>;

  close(): Promise<void>;
}
```

**v0 ships two tool drivers, and the contrast is the point.** `drivers/tool/fs.ts` is in-process: four hardcoded tools, each with a hand-declared reversibility tag. `drivers/tool/mcp.ts` (#025) is a *subprocess*: it spawns an MCP server, speaks JSON-RPC 2.0 over stdio, and discovers whatever tools that server advertises at runtime. Same interface, same kernel path, no kernel change. That is the abstraction holding.

Two MCP-specific notes that live in the driver, not here:

- **Namespacing.** MCP tool names are server-local (`read_file`); cortex tool names are global. The driver exposes them as `<namespace>/<name>` so several servers can coexist with `fs`.
- **Reversibility.** MCP has no such field. Undeclared tools default to `irreversible`; see §10.

### 7.3 `IMemoryDriver`

```typescript
interface IMemoryDriver {
  readonly name: string;          // 'sqlite', 'inmem', 'qdrant'
  readonly version: string;

  read(region: string, query: MemoryQuery): Promise<readonly MemoryEntry[]>;
  write(region: string, key: string, value: unknown, opts?: MemoryWriteOptions): Promise<void>;
  delete(region: string, key: string): Promise<void>;
  listRegions(): Promise<readonly string[]>;

  // Required for fork: snapshot a region's contents
  snapshotRegion(region: string): Promise<Uint8Array>;
  restoreRegion(region: string, blob: Uint8Array): Promise<void>;

  close(): Promise<void>;
}
```

The kernel does not interpret driver internals. It only enforces the interface contract and records what comes back.

---

## 8. The full TypeScript surface

Single source of truth. This is what `src/kernel/abi.ts` will export.

```typescript
export interface CortexContext {
  // Identity (properties, not syscalls)
  readonly pid: ProcessId;
  readonly ppid: ProcessId | null;
  readonly pgid: ProcessId;
  readonly role: string;

  // 4.1 Process control
  spawn(opts: SpawnOptions): Promise<{ pid: ProcessId }>;
  wait(pid?: ProcessId, opts?: WaitOptions): Promise<WaitResult>;
  exit(code: number, reason?: string): never;
  kill(pid: ProcessId, signal: Signal): Promise<void>;
  ps(filter?: ProcessFilter): Promise<readonly ProcessInfo[]>;

  // 4.2 State management
  fork(opts?: ForkOptions): Promise<ForkResult>;
  checkpoint(opts?: CheckpointOptions): Promise<{ chainId: ChainId }>;
  restore(chainId: ChainId, opts?: RestoreOptions): Promise<{ pid: ProcessId }>;

  // 4.3 Cognition
  llm_call(req: LLMRequest): Promise<LLMResponse>;
  tool_call(name: string, args: unknown, opts?: ToolCallOptions): Promise<ToolResult>;

  // 4.4 Memory
  memory_read(region: string, query: MemoryQuery): Promise<readonly MemoryEntry[]>;
  memory_write(region: string, key: string, value: unknown, opts?: MemoryWriteOptions): Promise<void>;

  // 4.5 IPC
  send(target: ProcessId | ChannelId, message: unknown, opts?: SendOptions): Promise<void>;
  recv(source?: ChannelId, opts?: RecvOptions): Promise<Message>;

  // 4.6 Time and determinism
  sleep(ms: number): Promise<void>;
  now(): Timestamp;
  random(opts?: RandomOptions): number;

  // 4.7 Signals
  on_signal(signal: Signal, handler: SignalHandler | 'default' | 'ignore'): void;

  // 4.8 Budgets
  budget(): BudgetCounters;

  // Forkable regions (STATE.md §5.2)
  forkable<T>(fn: () => Promise<T>): Promise<T>;
}
```

**Nineteen syscalls.** Plus identity properties. Plus `forkable()` as a structured wrapper around the reversibility enforcement.

That is the whole kernel surface. Anything else lives in user space.

### 8.1 The synchronous syscalls and their records

Five members are synchronous: `now()`, `random()`, `budget()`,
`on_signal()` return a value; `exit()` throws. They are synchronous because a
clock read, a draw, a counter and a registration have nothing to await —
forcing them through a Promise would only make agent code noisier.

Synchronous means they cannot await the recorder, so they cannot write their
own frame at call time. They are recorded as follows:

| syscall | recorded? | what the frame carries |
|---|---|---|
| `now` | yes | the timestamp served |
| `random` | yes | the value served (and its options) |
| `on_signal` | yes | the signal and the disposition **kind** (`handler` / `default` / `ignore`) — not the handler, which is a live closure and cannot be serialised |
| `budget` | **no** | unrecorded by policy (§4.8): it is derivable from the syscalls that spent it |

The frame is built synchronously — capturing the exact value the caller is
about to receive, which is the whole point — and queued; the dispatcher writes
the queue at the process's next async boundary, which is the start of its next
`invoke`. So the log still reads in the order things happened: everything the
body did synchronously appears **before** the next syscall's `enter` frame.
Each sync syscall is a single frame (`phase: 'exit'`, `args` and `result`
together), not an enter/exit pair — a synchronous call has no duration and
cannot fail past its state gate.

Before `0.2.0` these were not recorded at all, and replay leaned on the
injected clock and RNG happening to produce the same values — which is only
true if the agent makes the same calls in the same order.

---

## 9. Open questions

### 9.1 Streaming LLM responses

`llm_call` returns a complete response. Real apps want streaming. Adding `llm_stream` doubles the syscall surface for what is arguably the same operation.

**v0 answer:** no streaming. v1 may add `llm_call(..., { stream: true })` returning an `AsyncIterable`. The recording format already supports it (multiple `exit` phases per `call_id`).

### 9.2 Capability / permission syscalls

PROCESS.md demoted capabilities to icebox. But some syscalls (`kill` cross-group, `tool_call` dangerous tools) will eventually need permission checks.

**v0 answer:** no capability syscalls. Kernel uses simple group membership rules. v1 introduces `acquire(cap)` / `release(cap)` if real workloads demand it.

### 9.3 Channel creation

`send` and `recv` reference channels by `ChannelId`, but how are channels created?

**v0 answer:** implicit. Sending to a non-existent channel creates it. This is convenient but messy. v1 may add explicit `channel_open()` / `channel_close()`.

### 9.4 Synchronous tool calls

Some tools are pure functions (e.g. `math.sqrt`). Forcing them through async `tool_call` adds overhead.

**v0 answer:** all tool calls are async. The overhead is microseconds. Optimize later if profiling shows it matters.

### 9.5 What happens to in-flight syscalls during `fork()`?

If the parent is BLOCKED on `llm_call` when fork is invoked, what does the child see?

**v0 answer:** fork is only allowed from RUNNING (when no syscall is in flight) or from BLOCKED-with-pending-syscall (the child inherits the pending state and the kernel re-issues the call against the child's recorded snapshot). This is subtle and we will probably get it wrong first.

### 9.6 Syscall versioning

If we add `llm_stream` in v1, do old recordings still replay?

**v0 answer:** every record includes a `kernel_abi_version` field. Replay engines must handle multiple versions. We commit to backward compatibility within a major version.

### 9.7 Driver versioning

A driver returning a malformed `LLMResponse` is `EDRIVER`. But what if the driver is *correctly* implementing an old version of the interface?

**v0 answer:** drivers declare `abiCompat: '^1.0.0'`. Kernel rejects incompatible drivers at load time with `EDRIVER`.

---

## 10. What we will get wrong

Predictions:

- **Reversibility tagging will be inconsistent across drivers.** Some authors will tag everything `reversible` to avoid friction. We will need a `cortex audit` tool to surface this and shame them gently.
  - **Worse than predicted, and already hit:** MCP (§7.2) has *no reversibility field at all*. A third-party server cannot declare whether its tools mutate the world, so the driver must invent a tag. `drivers/tool/mcp.ts` defaults every undeclared tool to `irreversible` — an untagged tool therefore refuses to run inside `forkable()` rather than silently corrupting a fork. Operators override per tool name; `declaredReversibility` records which names were declared so `cortex audit` can surface the rest. The default is safe, not correct, and the audit loop is what makes it temporary.
- **`recv` semantics will turn out to need explicit channels.** The "implicit channel creation" decision (§9.3) will bite us. We will add `channel_open` in v0.2.
- **`now()` and `random()` recording will bloat logs.** Agents that call them in tight loops will produce gigabytes of `.crec`. We will add a "compact recording" mode that elides repeated identical calls.
- **`fork()` from BLOCKED state will be the source of three subtle bugs.** We will document the workarounds, then fix the kernel.
- **We will need a syscall we did not anticipate.** Likely candidates: `migrate` (move process to another kernel), `observe` (subscribe to another process's syscall stream), `attest` (cryptographically sign a checkpoint).

These are not failures. The ABI is a living document. v1 will look different. The point of writing v0 carefully is to make the differences *deliberate* rather than *accidental*.

---

## 11. What comes next

ABI.md is the last design document blocking Phase 1. After this:

- **`docs/ARCHITECTURE.md`** — how the kernel is internally organized. Modules, data flow, where each syscall is implemented, how drivers are loaded. Less normative than ABI.md, more descriptive.
- **Phase 1: kernel skeleton** — `src/kernel/process.ts`, `scheduler.ts`, `syscall.ts`, `ipc.ts`, `signals.ts`, `checkpoint.ts`, `recorder.ts`, `memory.ts`, `fork.ts`, `init.ts`. ~1500 lines of TypeScript.

The ABI is the contract. The architecture is how we keep that contract. The kernel is the implementation. In that order.

---

*If a syscall is missing, malformed, or wrong — open an issue. The ABI is the most consequential document in cortex; arguments here are worth having.*
