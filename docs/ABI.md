# Cortex Syscall ABI

> The contract between agents and the kernel.
>
> **If a behavior is not in this document, it does not exist.**

> ## 🔒 ABI status: **FROZEN** since `1.0.0`
>
> Before `1.0.0` the ABI was deliberately unsettled: the version line said
> `0.x`, and a minor bump was allowed to change a syscall, its arguments, or
> the state model. That is over.
>
> From `1.0.0`:
>
> - **Breaking** changes require a **major** bump (`2.0.0`). A breaking change
>   is one that could stop an existing agent from working: removing or
>   renaming a syscall, changing what an argument *means*, changing a
>   syscall's errno contract, changing a field in `ProcessInfo`, or changing
>   the on-disk `.crec` / `.csnap` format.
> - **Additive** changes land in a **minor** bump (`1.1.0`) and must not be
>   able to break an agent that exists today: a new syscall, a new *optional*
>   argument field, a new errno for a condition that previously could not
>   occur, a new capability.
> - The kernel carries `KERNEL_ABI_VERSION`, and every `.crec` record carries
>   `kernel_abi_version`, so a replay engine can tell which contract a log was
>   written under (§9.6).
>
> The freeze is why `1.0` also had to settle the questions §9 had deferred to
> "v1" — capabilities (§9.2) and the channel lifecycle (§9.3). Both are in.

Read [`STATE.md`](./STATE.md) and [`PROCESS.md`](./PROCESS.md) first. This document defines what agents can *ask the kernel to do*; the other two define what they *are* and how they *change over time*.

---

## 1. Why this document exists

Every OS lives or dies by its syscall ABI. POSIX is ~300 syscalls and fifty years of compatibility. Plan 9 fit the whole world into ~30. seL4 fits a verifiable kernel into ~20.

Cortex ships **twenty-four** in 1.0. Not because twenty-four is magic, but because every syscall we add is one more thing every driver, every test, every recording, every replay engine has to handle. Syscalls are forever. We pick carefully.

`0.x` shipped nineteen. `1.0` adds five: three for the capability system (§4.9, promised by §9.2) and two for the explicit channel lifecycle (§4.5, promised by §9.3). Nineteen was the number we could defend without having watched anyone use it; twenty-four is the number we can defend after having done so. The freeze means the next one has to be worth a major version.

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

#### `channel_open(opts?: ChannelOpenOptions): Promise<{ channelId: ChannelId }>`

Create a channel explicitly and get its id back (§9.3). Anonymous unless you claim a name.

```typescript
const { channelId } = await ctx.channel_open();                  // ch-1, ch-2, …
const { channelId } = await ctx.channel_open({ name: 'reviews' }); // claim a name
```

- **Allowed states:** RUNNING
- **Returns:** the new `ChannelId`
- **Errors:** `EINVAL` (name is empty, or already claimed), `EDRIVER` (no IPC engine)
- **Reversibility:** `reversible` (the channel can be closed)
- **Recording:** the channel id, and whether it was named

Why this exists when `send` already creates channels implicitly: implicit creation is a convenience that hides a class of bug. A typo in a channel name used to silently mint a channel nobody was listening on, and there was no way to ask whether a channel existed. `channel_open` makes the channel knowable *before* anyone sends to it.

**Implicit creation is retained on purpose.** Making it an error would break every agent written before `1.0`, and that is exactly the kind of change the freeze now forbids. What changed is that implicit creation is no longer the *only* way to get a channel.

#### `channel_close(channel: ChannelId): Promise<void>`

Retire a channel. Queued messages are dropped, parked `recv()` waiters are rejected `EBADF`, and later `send` traps `EBADF` (and raises `SIGPIPE` on the sender). Idempotent — closing a closed channel is a no-op, so cleanup paths do not need to track state.

- **Allowed states:** RUNNING
- **Returns:** nothing
- **Errors:** `EDRIVER` (no IPC engine)
- **Reversibility:** `reversible`
- **Recording:** the channel id

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

### 4.9 Capabilities

Three syscalls that let a process run with **less** authority than the kernel would otherwise give it. This is the section §9.2 promised for v1.

```typescript
export type Capability =
  | 'spawn'           // create child processes
  | 'kill'            // signal a process that is not yours
  | 'fork'            // cognitive fork
  | 'tool:dangerous'  // call a tool tagged `irreversible`
  | 'ipc:any'         // send to a process that is not yours
  | 'admin';          // may acquire any capability
```

#### The model

A process has two sets:

- **held** — what it can do right now.
- **grantable** — what it may raise later with `acquire()`, but does not hold yet.

`spawn` seeds both. `acquire` moves a capability from grantable to held. `release` drops one. There is no way to delegate a capability to another process — that is a marketplace, and it is in the icebox.

**Default is full privilege, not least privilege.** A process whose spawner said nothing holds every capability. This is the compatibility decision, stated plainly: every agent, example and smoke check written before `1.0` predates capabilities, and defaulting to empty would turn all of them into `EPERM` traps on upgrade. Least privilege is opt-in — pass `capabilities` (and optionally `grantable`) to `spawn`.

#### What each capability gates

| Capability | Gates | Not required for |
|---|---|---|
| `spawn` | creating any child process | — |
| `kill` | signalling a process that is not your descendant and not in your group | **killing your own children** |
| `fork` | cognitive fork | — |
| `tool:dangerous` | calling a tool the driver tagged `irreversible` | every reversible tool |
| `ipc:any` | `send` to a process that is not yours | your children, your group, any channel |
| `admin` | lets `acquire` ignore the grantable pool | — |

The "not required for" column is the design. A supervision tree kills the child that missed its deadline — if that needed `kill`, the capability would be handed out so widely that it would stop meaning anything. The capability governs reaching *across* the tree, not disciplining your own. Likewise a narrowed leaf can still read, compute and call reversible tools; it is structurally unable to touch the outside world.

#### `acquire(cap: Capability): Promise<void>`

Raise `cap` from grantable to held.

- **Allowed states:** RUNNING
- **Returns:** nothing
- **Errors:** `EPERM` (neither held nor grantable), `EINVAL` (not a capability name)
- **Reversibility:** `reversible` (`release` undoes it)
- **Recording:** recorded, like any other syscall

Recorded on purpose: "when did this agent escalate, and what did it do next" has to be answerable from the `.crec` log. That is the whole reason escalation is a syscall rather than a config flag. Idempotent when already held, and a no-op on a fully-privileged process — so an agent can call it unconditionally whether or not it was narrowed.

#### `release(cap: Capability): Promise<void>`

Drop `cap`. Never fails, including for a capability the process never held: giving up a privilege you do not have is not an error, and making it one only breaks cleanup paths. On a fully-privileged process this *narrows* it — it then holds everything except `cap`, with the full set retained as grantable so `acquire` can undo it.

- **Allowed states:** any
- **Returns:** nothing
- **Errors:** none
- **Reversibility:** `reversible`

#### `caps(): readonly Capability[]`

The capabilities this process currently holds. Synchronous and unrecorded, like `budget()` (§4.8) — readable introspection is derivable.

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

### 9.2 Capability / permission syscalls — **RESOLVED in 1.0**

PROCESS.md demoted capabilities to icebox. But some syscalls (`kill` cross-group, `tool_call` dangerous tools) will eventually need permission checks.

**v0 answer:** no capability syscalls. Kernel uses simple group membership rules. v1 introduces `acquire(cap)` / `release(cap)` if real workloads demand it.

**1.0 answer (§4.9):** shipped, as promised — `acquire` / `release` / `caps`, over a closed set of six capabilities (`spawn`, `kill`, `fork`, `tool:dangerous`, `ipc:any`, `admin`). The default is **full privilege**, because defaulting to least privilege would have turned every pre-1.0 agent into an `EPERM` trap; privilege is narrowed explicitly at `spawn` time. Two gates are deliberately *conditional* rather than blanket: `kill` and `ipc:any` apply only to processes that are not your descendant and not in your group, and `tool:dangerous` applies only to `irreversible` tools. Without that, `kill` would have been handed to every supervisor and meant nothing.

### 9.3 Channel creation — **RESOLVED in 1.0**

`send` and `recv` reference channels by `ChannelId`, but how are channels created?

**v0 answer:** implicit. Sending to a non-existent channel creates it. This is convenient but messy. v1 may add explicit `channel_open()` / `channel_close()`.

**1.0 answer (§4.5):** `channel_open` / `channel_close` shipped. Implicit creation on `send` is **kept** — removing it would break every agent written before 1.0, which the freeze now forbids — but it is no longer the only way to obtain a channel. `channel_open` returns an id you can hold before anyone has sent to it, and can claim a name; duplicate names are `EINVAL`.

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
  - **Verdict: right problem, wrong date — and it landed in `1.0`, not `0.2`.** `channel_open` / `channel_close` shipped with the capability work (§4.5, §9.3). The part we got right was the diagnosis: a typo'd channel name silently minting a channel nobody reads. The part we got wrong was the timeline, by four minor versions — a useful calibration for how much to trust the dates in this section.
- **`now()` and `random()` recording will bloat logs.** Agents that call them in tight loops will produce gigabytes of `.crec`. We will add a "compact recording" mode that elides repeated identical calls.
- **`fork()` from BLOCKED state will be the source of three subtle bugs.** We will document the workarounds, then fix the kernel.
- **We will need a syscall we did not anticipate.** Likely candidates: `migrate` (move process to another kernel), `observe` (subscribe to another process's syscall stream), `attest` (cryptographically sign a checkpoint).

These are not failures. The ABI is a living document. v1 will look different. The point of writing v0 carefully is to make the differences *deliberate* rather than *accidental*.

---

## 11. What comes next

*(This section was written when ABI.md was the last document blocking Phase 1. All of that is done — the kernel, the drivers, the CLI and the demos shipped in `0.x`. What follows replaces it.)*

The ABI is now frozen, which changes what "what comes next" means.

**Within `1.x` (additive only):** new syscalls, new optional argument fields, new capabilities, new errnos for conditions that could not previously occur. Each must be impossible to break an agent that exists today. The live candidates from §10 are `llm_stream` (§9.1), `observe`, `attest` and `migrate`.

**Requiring `2.0`:** anything that removes or renames a syscall, changes what an argument means, changes the errno contract, changes `ProcessInfo`, or changes the `.crec` / `.csnap` format.

**Deliberately deferred to `1.1`, because it is *not* an ABI change:** collapsing the self-recorded syscalls (`memory_read`, `memory_write`, `send`, `recv`, `fork`, `checkpoint`, `restore`) onto the dispatcher's single recording path. Those modules predate the dispatcher and still write their own `.crec` frames; the on-disk format is identical either way, so this is internal tidying rather than a contract change — and `send`'s atomicity (a failed record must not leave a phantom message) depends on the module controlling when it records. It is worth doing and worth doing carefully, so it does not hold the freeze hostage.

The ABI is the contract. The architecture is how we keep that contract. The kernel is the implementation. In that order.

---

*If a syscall is missing, malformed, or wrong — open an issue. The ABI is the most consequential document in cortex; arguments here are worth having.*
