# Cortex Kernel Architecture

> How the kernel is organized internally. ABI.md is the contract; this is how we keep it.

Read [`STATE.md`](./STATE.md), [`PROCESS.md`](./PROCESS.md), and [`ABI.md`](./ABI.md) first. This document is descriptive, not normative — it explains how the v0 kernel will be built. Future kernels may rearrange the modules; the ABI is what stays stable.

---

## 1. Why this document exists

A syscall ABI says *what* the kernel does. An architecture says *how*. Without the second, the first is just a wish.

This document exists so that:

- A new contributor can read it once and know where every line of kernel code belongs.
- We can argue about module boundaries before we have code, when changes are cheap.
- We can predict performance bottlenecks before they ship.
- We can answer "why is X a separate module?" without git archaeology.

It also exists to be **honest about what v0 does not do**. There is a section §10 just for that.

---

## 2. Architectural principles

These are not aspirations. They are constraints every module must satisfy.

### 2.1 Microkernel discipline

The kernel does the minimum: scheduling, IPC, recording, state management, syscall dispatch. **Everything else is a driver or user space.** No vendor-specific code in the kernel. No protocol-specific code in the kernel. No agent-framework-specific code in the kernel.

If a feature can be a driver, it is a driver.

### 2.2 Single Node.js process per kernel

A cortex kernel runs in one Node.js process. All "agent processes" inside it are async functions sharing the heap. Isolation is **logical, not physical**.

This is a v0 limitation, not a virtue. See §9 for what it costs us and §10 for what we'd need to fix it.

### 2.3 Everything is recorded

Every syscall produces a record. There is no "fast path" that skips the recorder. The recorder is part of the syscall, not an observer of it. This is what makes deterministic replay possible.

If recording fails, the syscall fails with `ERECORD`. We would rather halt than produce a partial log.

### 2.4 Modules communicate through narrow interfaces

Each module exposes a small TypeScript interface. Modules do not import each other's internals. The dependency graph is a DAG with the syscall dispatcher at the top.

### 2.5 Async everywhere, but no parallelism

All syscalls are async (ABI.md §2.2). The kernel uses Node's event loop. There is no `worker_threads` usage in v0. There is no child-process spawning. One process, one event loop, cooperative scheduling.

---

## 3. The kernel at a glance

```
┌──────────────────────────────────────────────────────────────────────┐
│                          USER SPACE                                  │
│                                                                      │
│   agent fn          agent fn          agent fn        cortex CLI     │
│   (pid 2)           (pid 3)           (pid 4)         (pid 5+)       │
│      │                 │                 │                │          │
└──────┼─────────────────┼─────────────────┼────────────────┼──────────┘
       │ ctx.syscall()   │                 │                │
═══════╪═════════════════╪═════════════════╪════════════════╪═══════════
       ↓                 ↓                 ↓                ↓
┌──────────────────────────────────────────────────────────────────────┐
│                     SYSCALL DISPATCHER                               │
│         validate args → check state → record enter →                 │
│         route to module → record exit/trap → return                  │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
       ┌──────────────┬────────────┼────────────┬──────────────┐
       ↓              ↓            ↓            ↓              ↓
┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
│  Process   │ │ Scheduler  │ │  Signals   │ │    IPC     │ │  Recorder  │
│   Table    │ │            │ │            │ │ (channels) │ │ (.crec)    │
└────────────┘ └─────┬──────┘ └────────────┘ └────────────┘ └────────────┘
       │              │ dispatch
       │              ↓
       │      ┌───────────────┐
       │      │  WakeGate     │  holds a woken process READY
       │      │ wake_gate.ts  │  until the dispatch that runs it
       │      └───────────────┘
       ↓              ↓
┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
│   Memory   │ │ Checkpoint │ │    Fork    │ │    Init    │
│  (regions) │ │  (.csnap)  │ │            │ │  (pid 1)   │
└────────────┘ └────────────┘ └────────────┘ └────────────┘
                                   │
                                   ↓
┌──────────────────────────────────────────────────────────────────────┐
│                       DRIVER REGISTRY                                │
│                                                                      │
│   ILLMDriver        IToolDriver         IMemoryDriver                │
│   ───────────       ───────────         ─────────────                │
│   deepseek          mcp:filesystem      sqlite                       │
│   openai            mcp:github          inmem                        │
│   mock              fs (built-in)       (post-v0: qdrant, etc.)      │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                                   │
                                   ↓
              external world: LLM APIs, MCP servers, disk, network
```

**Twelve kernel modules + one driver registry.** That is the whole v1 kernel:/nthe eleven in §4.1–§4.11, plus `wake_gate.ts`, which has no section of its own
because it is small and exists only to make §4.8's rule enforceable — it
holds a woken process READY until the scheduler actually dispatches it.

---

## 4. Module specifications

Each module is one TypeScript file in `src/kernel/`. Listed in dependency order — earlier modules are depended on by later ones.

### 4.1 `recorder.ts`

**Responsibility.** Append-only writer for `.crec` syscall log files. The lowest-level module; everything else depends on it.

**Public interface:**

```typescript
interface Recorder {
  open(pid: ProcessId, logPath: string): Promise<RecorderHandle>;
  write(handle: RecorderHandle, record: SyscallRecord): Promise<SyscallOffset>;
  fsync(handle: RecorderHandle): Promise<void>;
  close(handle: RecorderHandle): Promise<void>;
  read(logPath: string, fromOffset: SyscallOffset): AsyncIterable<SyscallRecord>;
}
```

**Internals.** Buffered writes (default 64 KB) with explicit fsync at checkpoint boundaries. CBOR encoding. Each record is length-prefixed for streaming reads.

**Failure mode.** If write fails (disk full, permission denied), the recorder throws `ERECORD` and the syscall traps. We never silently drop records.

**Performance.** Append is O(1) amortized. Read from offset is O(log n) for indexed mode, O(n) for streaming. v0 ships streaming only; indexing is post-v0.

### 4.2 `process_table.ts`

**Responsibility.** Allocate PIDs. Track every process's state, parent, group, budgets, signal dispositions. The kernel's source of truth for "what processes exist."

**Public interface:**

```typescript
interface ProcessTable {
  allocate(spec: ProcessSpec): ProcessId;
  get(pid: ProcessId): ProcessInfo | undefined;
  set(pid: ProcessId, patch: Partial<ProcessInfo>): void;
  transition(pid: ProcessId, to: ProcessState, reason?: string): void;
  childrenOf(pid: ProcessId): readonly ProcessId[];
  reparentOrphans(deadPid: ProcessId): void;
  reap(pid: ProcessId): void;
  listInState(state: ProcessState): readonly ProcessId[];
}
```

**Internals.** Two `Map`s: `byPid` (PID → ProcessInfo) and `byParent` (PPID → Set<PID>). PID counter is a `bigint` (u64 semantics in JS). State transitions validate against PROCESS.md §5; illegal transitions throw `ESTATE`.

**Performance.** All operations O(1) except `listInState` which is O(n) over all processes. For v0 (target: hundreds of processes), this is fine. Post-v0 may add a per-state index.

### 4.3 `signals.ts`

**Responsibility.** Signal delivery, disposition management, pending queues.

**Public interface:**

```typescript
interface SignalManager {
  send(target: ProcessId | { group: ProcessId }, signal: Signal): void;
  setDisposition(pid: ProcessId, signal: Signal, disp: SignalDisposition): void;
  pendingFor(pid: ProcessId): readonly Signal[];
  deliverIfReady(pid: ProcessId): Promise<void>;
}
```

**Internals.** Per-process pending signal queue (Set, since duplicate signals coalesce per PROCESS.md §11.7). Delivery is checked on every BLOCKED → READY transition and on every syscall return.

**Special handling.** `SIGKILL` and `SIGSTOP` bypass disposition lookup. `SIGCHLD` is sent to parent on every child state change to ZOMBIE.

### 4.4 `ipc.ts`

**Responsibility.** Message channels for `send` and `recv`.

**Public interface:**

```typescript
interface IPCManager {
  ensureChannel(id: ChannelId): Channel;
  send(channel: ChannelId, message: Message, opts?: SendOptions): Promise<void>;
  recv(channel: ChannelId, opts?: RecvOptions): Promise<Message>;
  closeChannel(channel: ChannelId): void;
  channelsOf(pid: ProcessId): readonly ChannelId[];
}
```

**Internals.** Per-channel FIFO queue plus a waiters list. `recv` with no message available moves the caller to BLOCKED with `{kind: 'recv', channel}`. When a message arrives, the first waiter is woken.

**v0 simplification.** Channels are created implicitly on first `send` (ABI.md §9.3). All channels are unbounded queues — no backpressure. Both will likely change in v0.2.

### 4.5 `memory.ts`

**Responsibility.** Virtual memory regions per STATE.md §2.3. Routes reads and writes to the configured `IMemoryDriver`.

**Public interface:**

```typescript
interface MemoryManager {
  attachRegion(pid: ProcessId, region: string, policy: MemoryRegionPolicy): void;
  detachRegion(pid: ProcessId, region: string): void;
  read(pid: ProcessId, region: string, query: MemoryQuery): Promise<readonly MemoryEntry[]>;
  write(pid: ProcessId, region: string, key: string, value: unknown, opts?: MemoryWriteOptions): Promise<void>;
  snapshot(pid: ProcessId): Promise<Record<string, Uint8Array>>;
  restore(pid: ProcessId, blobs: Record<string, Uint8Array>): Promise<void>;
  forkCopy(parentPid: ProcessId, childPid: ProcessId): Promise<void>;
}
```

**Internals.** A region table per process: `{region: {policy, driverHandle}}`. COW logic is implemented at the region level, not per-key — when a `cow` region is first written by a forked child, the entire region is duplicated. This is coarser than true COW but vastly simpler.

**Region-size ceiling.** The manager carries a global per-region write-count ceiling (`maxRegionEntries`; `-1` = unlimited), wired from boot config (`KernelOptions.maxRegionEntries`) through to the CLI as `cortex spawn --max-region-entries <n>` and `cortex daemon run --max-region-entries <n>`. On top of that, each region's policy may declare its own `maxEntries`, which **takes precedence** over the global cap: absent inherits it, `-1` opts that region out to unlimited, `0+` is a hard cap. The `ENOMEM` check resolves the *effective* cap per region and still runs *before* copy-on-write divergence, so a rejected write never splits a shared region and the region's share survives intact (ABI.md §4.4 "region size limit"); the resolved value is exposed as `MemoryRegionInfo.effectiveMaxEntries`.

Per-region policies are declared on the CLI via `cortex spawn --memory <json>` and `cortex daemon install --memory <json>` — a JSON object keyed by region name, merged over the standard `episodic`/`semantic`/`procedural` defaults (override-by-name, add-new, keep-untouched). For daemons the resolved policies are persisted in the daemon spec (`daemons.json`) and applied on every (re)spawn; for spawned and restored processes they are written to the process's `.meta.json`, so a cross-invocation `cortex restore` re-declares the same regions (including their `maxEntries`/`readOnly`) rather than silently reverting to defaults. Fork inherits a region's `maxEntries` by reference; `memoryOverrides` may supply a different one for the child.

**A declared region is not yet a bound one.** The policies live on the process-table entry; turning a logical region into a physical key is the memory engine's job (`attachRegion`, and `syncFromTable` to pull the declarations in). Every birth path has to do that sync, and the three are not the same code: the `spawn` syscall does it in the dispatcher, `restore` does it in the checkpoint manager, and a **daemon registration** does it in init. When the daemon path skipped it, a daemon's agent died on its *first* `memory_read` with `ENOENT` ("no such memory region") while the same agent under `cortex spawn` worked — the regions were declared, just never bound. PROCESS.md §6.1 has always promised "sets up memory regions per policy" for every process; the daemon path was the one that did not keep the promise.

**Performance.** Reads and writes are O(1) plus driver overhead. COW duplication is O(region size) on first write. Acceptable for v0; per-key COW is post-v0.

### 4.6 `checkpoint.ts`

**Responsibility.** Snapshot serialization per STATE.md §4. Writes `.csnap` files.

**Public interface:**

```typescript
interface CheckpointManager {
  take(pid: ProcessId, opts?: CheckpointOptions): Promise<{chainId: ChainId; path: string}>;
  load(chainId: ChainId): Promise<Checkpoint>;
  listLineage(chainId: ChainId): Promise<readonly ChainId[]>;
  restoreAs(chainId: ChainId, opts?: RestoreOptions): Promise<ProcessId>;
}
```

**Internals.** Calls into `memory.ts` for region snapshots, `process_table.ts` for cognitive state, `recorder.ts` for current log offset. Assembles the `Checkpoint` structure (STATE.md §7), CBOR-encodes, SHA-256 signs, writes to disk.

**Restore path.** Reads `.csnap`, validates signature, allocates new PID, attaches memory regions from blobs, sets cognitive state, transitions NEW → READY.

### 4.7 `fork.ts`

**Responsibility.** Cognitive fork per STATE.md §3.1. The hardest module.

**Public interface:**

```typescript
interface ForkManager {
  fork(parentPid: ProcessId, opts?: ForkOptions): Promise<ForkResult>;
}
```

**Internals.** Sequence:

1. Validate parent state (RUNNING / BLOCKED / STOPPED / SUSPENDED allowed).
2. Read parent's cognitive snapshot, memory regions, budget counters.
3. Allocate child PID.
4. Apply fork options: budget policy (reset/inherit/split), memory policy overrides.
5. Duplicate memory regions per policy (private = deep copy, shared = same handle, cow = mark COW).
6. Close driver state in both parent and child (STATE.md §2.5).
7. Compute `sharedCausalPast` = current parent log offset.
8. Collect `irreversibleInPast` by scanning parent's log for irreversible syscalls.
9. Transition child NEW → READY.
10. Record the fork syscall in both logs.

**Why a separate module.** Because step 8 (scanning for irreversible past) requires deep knowledge of the recording format, and step 5 (memory duplication) requires deep knowledge of the region policies. Mixing this with `process_table.ts` would create a 1000-line god-module.

### 4.8 `scheduler.ts`

**Responsibility.** Pick the next process to run. Enforce budgets. Move processes between READY and RUNNING.

**Public interface:**

```typescript
interface Scheduler {
  start(): void;
  stop(): Promise<void>;
  enqueue(pid: ProcessId): void;
  dequeue(pid: ProcessId): void;
  tick(): Promise<void>;        // called by event loop
  setBudget(pid: ProcessId, limits: BudgetLimits): void;
}
```

**Internals.** A priority queue ordered by `(nice, enqueue_time)`. On each tick:

1. Pop highest-priority READY process whose budgets are not exhausted.
2. Transition to RUNNING.
3. Resume its async function (the agent's `await` returns).
4. When the agent next blocks or yields, transition back to READY/BLOCKED.
5. If a budget hit zero during the syscall, fire `SIGXCPU` instead of returning to READY.

**The "resume the async function" part** is the trickiest. Each agent process is implemented as a Promise that the kernel can suspend and resume. v0 uses a simple continuation-passing approach: every syscall returns a Promise that the kernel controls. When the scheduler decides to resume, it resolves the Promise.

Two consequences of that design are worth stating explicitly, because the first
implementation got them wrong:

  - **A dispatch starts the body; it does not finish it.** `resume` returns as
    soon as the body reaches a suspension point, and the body keeps running on
    the event loop across later ticks. Running it to completion inside the
    quantum (the first implementation) made `wait()` deadlock by construction —
    a parent parked on a child held the tick the child needed in order to run.
  - **A woken body resumes on a dispatch, not on the wake.** When a `wait()` or
    `recv()` is satisfied the process is made READY, but the Promise is resolved
    only once the scheduler puts it back in RUNNING (`wake_gate.ts`). Resolving
    it inline races the state transition and the agent's next syscall traps
    `ESTATE`.

See PROCESS.md §8.2 for the full statement, and boot.ts "The execution model".

### 4.9 `init.ts` (PID 1)

**Responsibility.** The first process. Reaps orphaned zombies. Restarts daemons per their restart policies. Logs unusual patterns.

**Public interface:**

```typescript
interface InitProcess {
  boot(): Promise<void>;
  registerDaemon(spec: DaemonSpec): ProcessId;
  shutdown(): Promise<void>;
}
```

**Internals.** Init is itself an agent function — it uses the same syscall surface as any other process. The only difference: it has no parent, it cannot exit (would crash the kernel), and it has special privileges to reparent orphans.

### 4.10 `syscall_dispatcher.ts`

**Responsibility.** The front door. Every `ctx.foo(...)` call lands here.

**Public interface:**

```typescript
interface SyscallDispatcher {
  invoke<S extends SyscallName>(
    pid: ProcessId,
    syscall: S,
    args: SyscallArgs[S]
  ): Promise<SyscallReturn[S]>;
}
```

**Internals.** Sequence per invocation:

1. Look up process in `process_table`. Trap `ESRCH` if missing.
2. Validate `state_before` against the syscall's allowed-states table (ABI.md §4). Trap `ESTATE` if disallowed.
3. Validate args against the syscall's schema. Trap `EINVAL` if bad.
4. Check reversibility tag against current `forkable` region (STATE.md §5.2). Trap `EREVERSIBLE` if violation.
5. Write `enter` record to `recorder`.
6. Route to the implementing module (`memory.ts` for `memory_read`, etc.).
7. Await result or catch error.
8. Write `exit` or `trap` record to `recorder`.
9. Update budget counters if syscall consumed tokens/USD.
10. Return result or throw `CortexError`.

This module is the only place syscalls are validated and recorded. No other module talks to the recorder directly except for internal events (state transitions, signal delivery) and for the **birth record of a forked or restored child** — a frame about the new process, written into the new process's own log, which no other process could write.

That exception is narrow on purpose. Four modules used to write their own syscall frames (`memory.ts`, `ipc.ts`, `fork.ts`, `checkpoint.ts` — seven syscalls between them), which meant two recording paths and therefore two places for the log and the code to drift apart. All seven now record through the dispatcher (ABI.md §11). What is left in the modules are the birth records, and those are events *about* a process rather than calls *by* one.

Two syscalls needed more than a moved frame:

- **`send`** cannot simply do the thing and then record it: a failed record must not leave a phantom, half-committed message (ABI.md §11), so the module has to control exactly when the message becomes real. `IpcManager.prepareSend()` hands back a prepared send with a `commit()` and a `rollback()`; the dispatcher writes the frames and then commits, or rolls back if the frame could not be written.
- **`fork`** needs to know where its own `enter` frame landed, because the shared causal past is everything *before* the fork call (STATE.md §4). The dispatcher captures that offset and passes it down; without it the module could only read the parent's current offset, which is already past the frame.


### 4.11 `driver_registry.ts`

**Responsibility.** Load, version-check, and route to drivers.

**Public interface:**

```typescript
interface DriverRegistry {
  registerLLM(driver: ILLMDriver): void;
  registerTool(driver: IToolDriver): void;
  registerMemory(driver: IMemoryDriver): void;
  resolveLLM(name?: string): ILLMDriver;
  resolveTool(name: string): { driver: IToolDriver; descriptor: ToolDescriptor };
  resolveMemory(name: string): IMemoryDriver;
  listAll(): DriverManifest;
  closeAll(): Promise<void>;
}
```

**Internals.** Three `Map`s, one per driver type. Default driver configurable per type. Tool resolution searches all registered `IToolDriver`s for the named tool; collisions trap `EINVAL` at registration time.

**Version check.** On registration, driver's `abiCompat` is matched against kernel's ABI version (semver). Mismatch refuses registration.

---

## 5. The lifecycle of a syscall

A complete trace of `await ctx.llm_call({messages: [...]})`:

```
1. Agent code calls ctx.llm_call(req).
   → ctx is a thin proxy that forwards to dispatcher.

2. dispatcher.invoke(pid, 'llm_call', req)
   ├─ process_table.get(pid) → ProcessInfo (state: RUNNING)
   ├─ validate state (RUNNING ∈ allowed states for llm_call) ✓
   ├─ validate args against LLMRequest schema ✓
   ├─ check forkable region: llm_call is 'reversible' → no trap
   ├─ recorder.write(handle, {phase: 'enter', syscall: 'llm_call', args: req, ...})
   │   → returns byte_offset
   └─ route to LLM driver

3. driver_registry.resolveLLM(req.driver) → ILLMDriver
   driver.call(req, driverCtx) → Promise<LLMResponse>

4. Kernel suspends agent's async function.
   process_table.transition(pid, BLOCKED, {kind: 'llm', callId})
   scheduler.dequeue(pid)

5. Scheduler picks next READY process. Other agents run.

6. ... time passes ...

7. LLM driver's Promise resolves with response.

8. Kernel wakes the agent:
   process_table.transition(pid, READY)
   scheduler.enqueue(pid)

9. Scheduler eventually picks pid, transitions to RUNNING, resumes Promise.

10. Dispatcher receives response:
    ├─ update budget counters (tokens, USD)
    ├─ check budgets: if exhausted, signals.send(pid, SIGXCPU)
    ├─ recorder.write(handle, {phase: 'exit', result: response, duration_ms, ...})
    └─ return response to agent code

11. Agent code continues with `const response = await ...` resolved.
```

**Eleven steps for one syscall.** This is the cost of full observability and replayability. We think it's worth it.

---

## 6. Driver model

### 6.1 Loading

Drivers are loaded at kernel boot from three sources, in order:

1. **Built-in** — bundled with the kernel (`drivers/llm/mock.ts`, etc.)
2. **Configured** — listed in `cortex.config.json` at the kernel's working directory
3. **Dynamic** — registered at runtime via the CLI (`cortex driver load ./my-driver.js`)

### 6.2 Lifecycle

```
load → version check → register → ready
                                    ↓
                              (kernel uses driver)
                                    ↓
                                close (on kernel shutdown or driver unload)
```

Drivers that throw during `close` are logged but do not block kernel shutdown.

### 6.3 Sandboxing

**v0 has none.** Drivers run in the kernel's Node.js process with full host privileges. A malicious driver can read your files, exfiltrate data, do anything.

This is a serious limitation. We document it loudly. v1 will explore `worker_threads` isolation; v2 may use WebAssembly or V8 isolates.

For v0, **only install drivers you trust**. Same advice as npm packages generally.

---

## 7. Persistence layout

```
.cortex/                              # kernel state directory (per-kernel)
├── kernel.json                       # the live kernel's endpoint descriptor
├── processes/                        # one directory per PID — a PID's CLAIM
│   ├── 1/                            # init
│   │   ├── log.crec                  # append-only syscall log
│   │   ├── spec.json                 # how the process was born (see below)
│   │   └── meta.json                 # cached ProcessInfo (for fast ps)
│   ├── 2/
│   │   ├── log.crec
│   │   ├── spec.json
│   │   ├── meta.json
│   │   ├── output.log                # what the process printed (see below)
│   │   └── checkpoints/
│   │       ├── 2026-09-17T10:23:01Z_<chainid>.csnap
│   │       └── ...
│   └── ...
├── memory/
│   ├── sqlite/                       # IMemoryDriver: sqlite backing
│   │   ├── private_<pid>_<region>.db
│   │   ├── shared_<region>.db
│   │   └── ...
│   └── inmem/                        # serialized on checkpoint only
├── channels/
│   └── <channelid>.json              # persisted IPC queues (post-v0)
├── units/                            # generated OS service units (daemon install)
│   ├── cortex-<name>.service         # systemd (linux)
│   └── sh.cortex.daemon.<name>.plist # launchd (darwin)
└── daemons.json                      # registered daemon specs
```

**Why one directory per process.** So you can `rm -rf .cortex/processes/1234/` to fully remove a dead process. No global indices to clean up.

**Why the process directory is also the PID's claim.** A state directory can host more than one kernel — `cortex daemon run` keeps one alive there while other `cortex` invocations work in the same directory — and each kernel counts PIDs up from its own seed. The directory is created with an *exclusive* `mkdir`, so exactly one kernel can win a given PID. Without it, the two counters walk into each other and the loser opens the winner's `log.crec` in append mode: two unrelated processes sharing one syscall log, silently. See §12.1.

**What `spec.json` holds, and why it is written so early.** The role, the agent spec, and the memory region policies a process was created with — the facts a restore needs to rebuild it, and the facts the `.csnap` body deliberately omits (STATE.md §4). It is written when the process is **created**, not when it exits: `meta.json` (which carries the same facts) is written at exit, so a snapshot of an agent that was still running when its kernel died would have had no spec anywhere on disk and could not be restored in a later session. The kernel reports the birth (`KernelOptions.onProcessStart`) and the CLI decides what to write; the kernel itself never touches the disk layout.

**What `output.log` holds, and why it is a separate file.** The `.crec` log
records what a process **did** — its syscalls, with arguments and results. It
says nothing about what the process **said**: `console.log` is not a syscall,
is not in the ABI, and never appeared in the log. So an agent's output went to
the daemon's stdout — one anonymous stream shared by the daemon, `init`, and
every agent in the tree — and nowhere it could be read back from. The one
stream an operator reaches for first, when an agent is behaving strangely,
was the one stream the system did not keep.

`output.log` is where it goes: one line per printed line, stamped, tagged with
the stream it came from.

```
2026-10-23T15:39:35.034Z | out | [listener] listening (max=∞, tick=1000ms)
2026-10-23T15:39:48.131Z | out | [listener] message 1 from 1: hello
```

The kernel does not know what a process printed — it only knows which process a
body belongs to. So it reports the body and the PID (`KernelOptions.agentScope`)
and the CLI decides what "inside a scope" means: an `AsyncLocalStorage` holding
the PID, which survives every `await` inside the body, so a line printed three
seconds later by an agent that was parked on `recv()` still knows it is PID 7's.
The tap is on `process.stdout.write`, not on `console.log`, so the captured text
is exactly what Node formatted and the original write still happens — the
output goes to the daemon's stdout *and* to the log. `cortex logs <pid>` reads
it back; the file is plain text and needs no live kernel.

**What `kernel.json` holds.** The endpoint descriptor of the kernel serving this directory: the loopback host and port, the kernel's OS pid, a per-kernel shared secret, and the ABI version it speaks. It is written when a kernel starts serving and removed when it stops. (The "kernel config (drivers, defaults)" role this file was sketched for is still aspirational — v0 has no config file.)

**Why `.crec` separate from `.csnap`.** Logs grow continuously and we want them streamable. Snapshots are discrete and we want them content-addressed. Mixing them is a mistake every workflow engine eventually regrets (STATE.md §4).

---

## 8. Boot sequence

What happens when you run `cortex spawn ...` for the first time:

```
1. CLI parses args, looks for .cortex/ in cwd or $CORTEX_HOME.
2. If no kernel running:
   a. Create .cortex/ directory structure.
   b. Spawn kernel as a daemon Node.js process.
   c. Wait for kernel ready signal (Unix socket or named pipe).
3. Kernel boot:
   a. Load kernel.json (driver list, defaults).
   b. Initialize recorder, process_table, signals, ipc, memory, checkpoint, fork, scheduler.
   c. Initialize driver_registry; load drivers in order.
   d. Spawn init (PID 1) with built-in init agent.
   e. Init registers any daemons from daemons.json.
   f. Scheduler starts ticking.
   g. Kernel signals "ready" to CLI.
4. CLI sends spawn request to kernel via socket.
5. Kernel:
   a. dispatcher.invoke(caller_pid, 'spawn', opts)
   b. process_table.allocate(...)
   c. agent module loaded
   d. NEW → READY
   e. Return PID to CLI.
6. CLI prints PID and exits.
7. Kernel keeps running. Scheduler eventually picks up the new process.
```

If the kernel is already running, steps 2-3 are skipped and step 4 talks to the existing kernel.

---

## 9. Concurrency model

### 9.1 Single-threaded cooperative

The kernel runs on Node's event loop. All agents share that loop. An agent runs until it `await`s a syscall. While awaiting, other agents run.

**This means:**
- 1000 agents are cheap if they're mostly blocked.
- 1000 agents are impossible if they're CPU-bound (one blocks all).
- Agent code that does `while (true) { /* compute */ }` will hang the kernel.

### 9.2 What we get from this

- No locks. No race conditions inside the kernel.
- Trivially deterministic recording (the event loop's order is the record order).
- Simple mental model.

### 9.3 What it costs us

- No true parallelism. Cortex on a 16-core machine uses one core.
- No isolation between agents. A bug in one agent can corrupt kernel state.
- No protection against runaway code.

For v0, we accept all three. Post-v0 plans in §10.

---

## 10. What v0 deliberately omits

A list of things we know we'll need eventually but are refusing to build now.

| Omitted | Why | When |
|---|---|---|
| **Threads within a process** | Adds shared-mutable-state complexity to STATE.md §2 | Maybe v1, only if workloads demand it |
| **PID namespaces** | Single-tenant kernel in v0 | v1, when multi-tenant lands |
| **`worker_threads` isolation** | Doubles kernel complexity | v1 |
| **WebAssembly driver sandbox** | Big lift; trust model unclear | v2 |
| **Distributed kernel** | Multi-host process tree is a research project | v2+ |
| **Preemptive scheduling** | Conflicts with token economics (PROCESS.md §8.2) | Never, probably |
| **Streaming LLM responses** | Recording format already supports it; ABI doesn't expose it | v0.2 |
| **Explicit channel creation** | Implicit is fine for v0 workloads | v0.2 (predicted in ABI.md §10) |
| **Capability / permission system** | Demoted from Phase 1 | v1, when there's demand |
| **GUI process inspector** | CLI is enough for v0 | Post-v0, separate project |
| **CRDT-backed shared memory** | Last-write-wins is fine until it isn't | Post-v0, after telemetry shows pain |
| **Hot code reloading** | Erlang does this; we'd need to think hard | Post-v0 |

The discipline of writing this list is the point. Every "we'll add it later" is a "we promise not to add it now."

---

## 11. File layout

What `src/kernel/` will look like at end of Phase 1:

```
src/
├── index.ts                          # public exports
├── kernel/
│   ├── index.ts                      # kernel barrel
│   ├── abi.ts                        # CortexContext + syscall types (from ABI.md §8)
│   ├── types.ts                      # ProcessId, ChainId, Signal, etc.
│   ├── errors.ts                     # CortexError, Errno
│   ├── recorder.ts                   # §4.1
│   ├── process_table.ts              # §4.2
│   ├── signals.ts                    # §4.3
│   ├── ipc.ts                        # §4.4
│   ├── memory.ts                     # §4.5
│   ├── checkpoint.ts                 # §4.6
│   ├── fork.ts                       # §4.7
│   ├── scheduler.ts                  # §4.8
│   ├── init.ts                       # §4.9
│   ├── syscall_dispatcher.ts         # §4.10
│   ├── driver_registry.ts            # §4.11
│   ├── boot.ts                       # §8 boot sequence
│   └── wake_gate.ts                  # §4.8 — resume only on dispatch
├── drivers/
│   ├── llm/
│   │   ├── mock.ts                   # built-in, deterministic
│   │   ├── deepseek.ts
│   │   └── openai.ts
│   ├── tool/
│   │   ├── fs.ts                     # built-in filesystem tools
│   │   └── mcp.ts                    # MCP client bridge
│   └── memory/
│       ├── inmem.ts
│       └── sqlite.ts
├── cli/
│   ├── index.ts                      # cortex / ctx binary entry
│   ├── commands/
│   │   ├── spawn.ts
│   │   ├── ps.ts
│   │   ├── attach.ts
│   │   ├── kill.ts
│   │   ├── trace.ts
│   │   ├── fork.ts
│   │   ├── checkpoint.ts
│   │   ├── restore.ts
│   │   ├── send.ts
│   │   ├── recv.ts
│   │   ├── limit.ts
│   │   ├── diff.ts
│   │   ├── daemon.ts
│   │   └── audit.ts
│   └── client.ts                     # talks to running kernel via socket
└── util/
    ├── cbor.ts                       # encoding helpers
    ├── sha256.ts
    └── paths.ts                      # .cortex/ layout helpers
```

**Estimated total at end of Phase 1:** ~3000 lines of TypeScript (matching MANIFESTO §II.3 promise).

> **That estimate did not survive contact with the implementation, and the
> promise behind it did.** The kernel is now ~6,800 lines of code (13,200
> with the comments) across sixteen modules — the dispatcher alone is 1,400.
> What the promise *was* about still holds: the kernel is under half the
> codebase, with the CLI, the drivers, the dashboard and the integrations
> together now slightly larger than it. MANIFESTO §II.3 states the current
> numbers rather than the original estimate.

---

## 12. Open questions

### 12.1 Kernel ↔ CLI transport

The CLI talks to a running kernel via... what?

- **Unix domain socket** — POSIX, fast, but Windows support is awkward.
- **Named pipe** — Windows-native, but POSIX support is awkward.
- **Localhost TCP** — cross-platform, slight overhead, requires picking a port.
- **File-based mailbox** — simplest, slowest.

**v0 answer: localhost TCP, and the port is published in `.cortex/kernel.json`.** Implemented (`src/cli/kernel_endpoint.ts`, `kernel_protocol.ts`, `kernel_server.ts`, `kernel_client.ts`). The instinct held up; here is what the implementation added on top of it:

- **The descriptor is the address, not the port.** `kernel.json` names the
  host, the port, the kernel's OS pid, a per-kernel token, and the ABI
  version. The port is ephemeral (the OS picks it), so two kernels — one per
  project directory, §12.2 — never fight over it.
- **A token, because the port is not a secret.** Every request carries a
  per-kernel random token; the server rejects anything else with `EPERM`.
  A loopback port is reachable by every user on the machine, and the
  commands behind it are not read-only. The token lives beside the logs it
  protects, so the guarantee it buys is "another local user cannot drive
  your kernel", not "another local user cannot read your home directory".
- **Newline-delimited JSON.** One JSON object per line. NDJSON was chosen
  so the transport stays inspectable: `nc 127.0.0.1 <port>` and a typed
  request is a legitimate way to ask the kernel what it is doing.
- **Every command is an existing kernel API, through the dispatcher.** A
  remote `cortex kill` is recorded in the kernel's `.crec` exactly like a
  local one, and a remote `cortex send` goes through the same
  prepare/commit transaction that keeps a message from being half-delivered.
  The transport adds reachability; it adds no side door.
- **The kernel stays transport-agnostic.** Nothing in `src/kernel/` knows
  the transport exists. The server is a *client* of the kernel.

**What it bought.** `cortex send <pid> <msg>` used to be a recording, not a
delivery: a short-lived CLI kernel holds exactly one process (init), so the
message had no inbox to land in and the kernel exited a millisecond later
taking it away. `cortex kill` could not signal anything either — it
rewrote the on-disk metadata. Both are real now, against a live kernel.

**And the cognitive fork became reachable.** `cortex fork <pid>` was a
command that could not succeed: a fork snapshots a *running* process, and the
short-lived CLI kernel holds only init, so the PID it was asked about was
never there — the answer was always "no such process", for a process that was
very much alive somewhere else. It now asks the kernel that has the process.

The fork is the target's *own* syscall — the ABI allows `fork` from RUNNING,
BLOCKED, STOPPED and SUSPENDED (ABI.md §4.2) — so the frame lands in the
parent's own log, and the shared causal past it records is exactly where
`cortex diff` cuts the two branches apart. The child is minted by that kernel
and keeps running there, so the whole of Demo C can be driven from a shell:
fork a running agent, send the two branches different instructions, and diff
them.

**And it stopped polluting the log.** Every transport command that *acts* —
`send`, `kill`, `checkpoint`, `restore`, `spawn` — is answered through the
dispatcher, so it is recorded in the kernel's `.crec` exactly like the local
equivalent. The read-only ones are not: `ping` and `shutdown` are
transport-level housekeeping, and `ps` is the operator *looking* at the
process table. The transport reads the table directly rather than making init
call the `ps` syscall on the operator's behalf — because a monitoring loop
that polls every second would otherwise write a frame into init's log for
every poll, and a read is not something the kernel's causal history should
record. (An agent's own `ctx.ps()` is unaffected: still a syscall, still
recorded — ABI.md §4.1.) `memory` is a read for the same reason and by the
same rule: the operator looking at a process's memory is not something the
process did. (An agent's own `ctx.memory_read()` is unaffected too — still a
syscall, still recorded, ABI.md §4.4.)

**And it made the snapshot reachable.** `cortex checkpoint <pid>` used to be
a command that could not succeed: a checkpoint captures a *running* process,
and the short-lived CLI kernel holds only init, so the PID it was asked about
was never there. It now asks the kernel that does have the process, takes the
snapshot through the ordinary `checkpoint` syscall, and reports the chain id
and the file. The other route is the signal: `SIGUSR2` means "checkpoint now"
(docs/PROCESS.md §7.4), so `cortex kill <pid> --signal SIGUSR2` asks a live
agent to save itself.

**And it gave the shell a lifecycle.** `cortex spawn` boots a kernel of its
own, runs the agent to completion, and exits — the agent's life is bounded by
the command, and every later `cortex` invocation finds only the files it left
behind. `cortex spawn --live` asks the kernel that is already running
instead: the agent is spawned into it, keeps running after the command exits,
and is reachable by every other transport command (`send`, `checkpoint`,
`kill`, `attach --interactive`). `cortex daemon stop` closes the loop by
asking the running kernel to shut down.

The default is unchanged on purpose. `cortex spawn` without `--live` still
runs the agent to completion and prints its result — the quiet mode of a
short-lived process is what most invocations want — and the opt-in is what
makes the different behaviour visible instead of silent. Two things travel
with a live-spawned agent and are worth knowing: its output goes to the
daemon's stdout (it is the daemon's child now), and its LLM drivers come from
the daemon's environment — the API key the daemon was started with, not the
one in the shell that typed the command.

**And it made the output addressable.** That first sentence was the last gap in
the live-kernel story. A live agent's output went to the daemon's stdout — one
anonymous stream shared by the daemon, `init`, and every agent in the tree —
and nowhere else. With two agents running there was no way to tell which one
printed what, and no way at all to read back what an agent said.

Now every process's printed output is captured to `processes/<pid>/output.log`
(§7), one stamped line per printed line, tagged with the stream it came from,
and `cortex logs <pid>` reads it back. It is a disk read, like `cortex trace`,
so it works for a process that has already exited and for one whose kernel is
gone; `cortex logs <pid> --follow` tails it, so an operator can watch a live
agent work without attaching a debugger to it.

The mechanism is deliberately thin, because the kernel still does not know what
a process said. It reports which process a body belongs to
(`KernelOptions.agentScope`) and the CLI decides what "inside a scope" means:
an `AsyncLocalStorage` holding the PID, which survives every `await` inside
the body — so a line printed three seconds later by an agent that was parked on
`recv()` and woken by another process still knows it is PID 7's. The tap is on
`process.stdout.write` rather than on `console.log`, so the captured text is
exactly what Node formatted, and the original write still happens: the output
still goes to the daemon's stdout, and now it is also addressable.

**And it made the memory addressable.** The other half of "why did the agent
do that?", and the half the syscall log cannot answer. ABI.md §4.4 records a
`memory_write` as a **hash** and a byte count rather than the value — "full
values would bloat the log" — so `cortex trace` can tell you that an agent
wrote something down and never what it wrote down. The knowledge is the whole
point of an agent that remembers, and the log deliberately does not carry it.

The live kernel still has it. `cortex memory <pid>` reaches in: which regions
a process has, what kind each one is, how much is in each, **who else can see
them**, and the entries themselves.

```
$ cortex memory 2
# memory of pid 2 (inbox-watcher)
REGION          KIND      BACKING     ENTRIES   SHARED WITH
-----------------------------------------------------------
episodic        cow       inmem       2         -
semantic        shared    inmem       3         3
procedural      private   inmem       0         -

$ cortex memory 2 semantic
# memory of pid 2 (inbox-watcher) — region 'semantic'
ticket:T-1180  {"id":"T-1180","category":"bug","reply":"Thanks for the report …"}  2026-10-23T19:05:33.842Z
```

The `SHARED WITH` column is the one that earns its keep: a `shared` region is
visible to every process that declared it, so knowing that agent 3 is reading
agent 2's notes is the difference between a shared scratchpad and a leak. It
falls out of comparing physical keys, and it also catches the other case — a
`cow` region whose forked child has not written yet.

It is a **read**, like `ps`: answered by the memory engine directly, not
through the dispatcher, and not recorded in the `.crec`. It does need the live
kernel, though — a region's contents live in the memory driver (the default
`inmem` backing is the kernel process's RAM), and there is no on-disk copy to
fall back on. So the command says plainly that it needs one rather than
reporting an empty region and letting the operator wonder whether the agent
really had forgotten everything.

**And it completed the loop.** `cortex restore` had the same shape of problem
from the other end: it boots a kernel of its own, restores the snapshot into
it, runs the restored agent to completion (or to the timeout), and exits — so
the restored agent's life is bounded by the command too. That is the right
shape for a one-shot restore and the wrong one for the promise a checkpoint
makes: *pause, and come back to work*. `cortex restore --live` asks the
running kernel instead. The `.csnap` is found on disk by chain id (the
checkpoint manager searches `processes/<pid>/checkpoints/`, so a snapshot taken
by an earlier kernel loads too), the restored process is minted by that
kernel, and it stays there — with a new PID, its role intact, and reachable by
every other transport command.

The kernel rebuilds the restored agent's spec from three places, best first:
**the process it is still running** (its role and agent spec are right there in
the process table), **the spec written when it was created**
(`<pid>.spec.json`, §7), and **the meta written when it exited**
(`<pid>.meta.json`). The live one comes first because a running process has no
`meta.json` yet — which is exactly the case `restore --live` exists for. The
lookup cannot confuse two processes: a kernel seeds its PID counter past
everything already on disk, so a PID from an earlier session is never handed
out again, and a table hit is always the very process that took the snapshot.

**And it made the ending addressable.** The last thing an operator wants is the
one thing no log records plainly: *how did it end?* The `.crec` does hold the
`exit` frame, but reading it means parsing the causal history of a process that
may be long gone, and the transport had no verb for "tell me when this
finishes" — `cortex ps` shows state, `cortex logs` shows output, `cortex memory`
shows knowledge, and none of them can block.

`cortex wait <pid>` blocks until the process ends and reports how.

```console
$ cortex wait 1234
pid 1234 exited with code 0 (finished the task)
```

The code is the **real** one — the number the agent passed to `exit()`, not a
default. That distinction is the whole point: a shell that answers "exited 0"
for a process that died without recording an exit is worse than no answer at
all, because it is a lie you can script against. `cortex wait` also exits with
the child's own exit code, so `cortex wait 2 || echo failed` behaves the way it
does in any shell.

It is a **read**, like `ps` and `memory`: answered by the kernel directly, not
through the dispatcher, and not recorded in the `.crec` — an operator waiting
for a process is not something the process did. It answers from the live kernel
when there is one, and from the process's exit record on disk when there is
not, so a finished process still says how it ended after the daemon is gone. A
pid that never existed is `ESRCH`, and a process that is still running with
`--timeout-ms` set is a timeout — never a silent "exited 0".

**And a host is not in the process tree.** `wait` is a *parent-child* syscall:
the kernel parks the caller, and when the child exits it wakes the caller's run
queue. A host that starts an agent through the kernel is not that agent's
parent — the agent is a child of `init` — so
`dispatcher.invoke(asProcessId(1), 'wait', …)` never settles, however long you
wait for it. The host-facing primitive is `Kernel.awaitExit(pid, { timeoutMs })`:
it resolves with the exit code, it still answers for a process that has already
been reaped, and it refuses a pid the kernel has never known with `ESRCH`.
docs/HACKING.md §7 is the whole story.

**And it made the kernel a stream.** Everything above was still the transport
carrying **commands**: a client asked, the kernel answered, the client went
away. That is the right shape for a question, and the wrong shape for a
question like *"tell me the moment this agent exits"* — and it is the one gap
this section had named for a while. Asking is fine; *watching* is different,
and watching by polling is a latency tax and a race.

So the kernel now reports facts as they happen, and the transport carries
them. `Kernel.subscribe(listener)` is the whole kernel-side API: one method,
one callback, one unsubscribe function.

```typescript
const stop = kernel.subscribe((event) => {
  if (event.kind === 'process-exit') console.log(`pid ${event.pid} → ${event.exitCode}`);
});
```

Three kinds of event, all of them facts:

- **`process-start`** — a process was born (pid, parent, role).
- **`process-exit`** — a process ended, with its **real** exit code — the same
  facts `awaitExit` resolves with, and the same ones `onProcessExit` reports.
  One truth, three ways to reach it.
- **`record`** — a syscall frame was appended to a process's `.crec` log. This
  is the live equivalent of `cortex trace`: the same `SyscallRecord`, with the
  same `byteOffset`, the instant it lands on disk.

That last one has a subtlety worth naming, because it decided where the hook
lives. **Seven** modules write records directly, through `recorder.append()`:
the dispatcher, the scheduler, the signal manager, the process table, `fork`,
`init` and `checkpoint` — four of them predate the dispatcher and own a record
of their own. A hook on the dispatcher would therefore have reported a
*subset* of the log, and a live watcher would have disagreed with
`cortex trace` about what happened. The hook belongs on the **recorder**,
which is the one place every frame passes through, so a subscriber's view of
the log and the log itself cannot disagree. (The smoke suite asserts exactly
that: the pushed frames and the frames on disk must be the same frames, at
the same offsets.)

Over the wire, the transport carries the stream on the same socket: a client
sends `subscribe`, gets an ordinary acknowledgement, and then the kernel
*pushes* `{event: …}` frames on that connection. `cortex watch` is the shell's
view of it.

```console
$ cortex watch --pid 1234
# watching the kernel event stream (Ctrl-C to stop)
time                  pid    syscall           phase   duration  reversibility
-------------------------------------------------------------------------------------
19:50:09.072  1234    __sched          exit    -         idempotent
19:50:09.072  1234    sleep            exit    2523ms    idempotent
19:50:09.073  1234    memory_write     enter   -         reversible
19:50:09.074  1234    memory_read      exit    0ms       idempotent
19:50:09.077  1234    exit             enter   -         irreversible
# pid 1234 exited with code 3 (probe finished on purpose)
```

The `record` lines are printed in the same layout as `cortex trace`, so the
two can be read side by side — and they *are* the same frames, which is the
point.

**And it made the shell a supervisor.** A stream is only half a story. Until
something *acts* on it, the operator is still the one who has to be there —
and the project's strongest demo (a planner that notices a hung coder, kills
it, and puts a fresh one in its place) only worked from *inside* an agent,
written in agent code.

`cortex supervise <pid>` is the shell-side version of that, and it is built
entirely on the stream:

```console
$ cortex supervise 2 --kill-after 30000 --restart
# supervising pid 2
# kill it if it stays inside one syscall for more than 30000ms (sleep is exempt — it is a declared wait)
# restart it when it ends (at most 5 time(s))
# pid 2 is already inside recv (since 2026-10-23T20:15:39.975Z)
# pid 2 has been inside recv for 1588ms — killing it
# pid 2 was not running — its SIGTERM was queued, so it was killed outright
# pid 2 exited with code 137 (signal:SIGKILL)
```

**How a stall is decided — not by silence.** Silence is not evidence of a
stall: an agent parked in `recv()` waiting for a message, or one deep in a
legitimate 60-second LLM call, produces no frames, and neither of them is
stuck. The kernel's log knows the difference. Every syscall is written as an
`enter` frame and an `exit`/`trap` frame **with the same `callId`**, so a
process that entered `tool_call` at 10:00:00 and has produced no matching
exit since is not "quiet" — it is *inside* `tool_call`, and has been for
exactly as long as the gap between the two frames. That is a precise stall
signal, and it is the one the supervisor uses. `sleep` is exempt: a sleep is
a **declared wait**, not a stall.

**And now the view says it too.** `cortex top` answers the same question —
*is this agent waiting, or is it stuck?* — and it answers it from the same
place: the same reading of the same log, with the same exemption, in one
module (`src/cli/open_call.ts`). Two commands that answer the same question
must read the same source, or they will disagree — and a supervisor that
kills a process the operator's view calls healthy is worse than either
command existing. `cortex top --stall-after 30000` marks what is over the
operator's own threshold and hands over the command to act on it.

The reading is also the only way to see a stall in a **driver call**. The
kernel does not park a process while its LLM call is in flight (PROCESS.md
§3.7), so such a process is `running`, not `blocked`, and the process table
says nothing is wrong. The log says it is four minutes into an `llm_call`.

**And the dashboard stopped reading only the dead.** The dashboard is the
operator's window, and it had the same blind spot as everything else that
reads the disk: a process that has not exited has no `meta.json` yet, because
the kernel writes it when the process ends. So its process list was a
directory of corpses — the agents that had finished — and the agent that was
actually working was missing from it. The activity feed was worse: it was
built by scanning the logs of the processes that *had* a `meta.json`, so the
200 KB of syscall frames a running agent had already produced were on disk
and invisible.

With a live kernel the dashboard reads that kernel's own process table, and
takes the event stream by push: the frames arrive as the kernel writes them,
and nothing is re-read. The disk is still the source for everything that has
finished, and the log of a running process is still read from disk — a
`meta.json` is a *process record*, not a *log file*, and the log is there
from the very first syscall.

The two paths produce the same events, because they go through the same
conversion (`toDashboardEvent`): a frame pushed over the wire and the same
frame read off disk are the same object. That is the rule the whole project
follows — two views of the same fact must not be able to disagree.

The process list, meanwhile, is the *same view* `cortex ps` shows: one
module (`src/cli/process_view.ts`) answers for both, and it takes the
connection it is given rather than opening its own — the dashboard holds one
connection for its whole life and hands it over.

**And the dashboard learned to stop.** An open event stream is a connection
that never ends by itself, and `server.close()` waits for it. The dashboard's
own UI holds one open from the moment it loads, so Ctrl+C would hang the
dashboard instead of stopping it — the operator's way out was the one thing
that did not work. The server now drops its connections when it closes, and
closing twice is not an error.

**The startup window is real, and the log closes it.** The stream only
carries what happens *after* a subscriber connects — a supervisor that
starts while the agent is already blocked would never see that `recv`'s
`enter` frame, because it was written before the supervisor was listening.
So the supervisor reads the process's log once at startup and works out which
call is still open (and when it opened). The log is the record of what the
process is doing; asking it is cheaper than guessing.

**A queued signal is not a delivered signal.** `SIGTERM`'s default action is
"terminate", but the queuing rule (PROCESS.md §7.2) means a signal aimed at
a process that is *not running* sits in its pending queue until it wakes up
— and a process stuck in a `recv` with no timeout may never wake. The kernel
says what it did with the signal (the `__signal` record's `outcome` is
`queued`), and the supervisor reads that off the stream: there is nothing to
wait for, so it escalates to `SIGKILL` at once instead of burning the grace
period. The alternative — waiting out a grace period for a signal that will
never be seen — is how a supervisor ends up waiting on a corpse.

**A stream needs an ending.** A subscriber is watching something that can
leave. The kernel can be stopped, and it can crash — and when it does, the
socket closes and the stream stops without saying a word. That silence is
the dangerous kind: a `watch` that ends because its kernel died looks exactly
like a watch that finished, and a supervisor that keeps polling a dead socket
looks exactly like a supervisor that is still supervising.

So the transport says when the connection ends. `KernelClient` reports it
(`closed`, `onClose(handler)`), and each command turns it into an ending that
means something and an exit code that tells the truth: `cortex watch` reports
that the watch did not finish and exits 1; `cortex wait` reports that no exit
was seen and exits 1; `cortex supervise` reports that the supervised
process's fate is unknown and exits 1. **None of them invents an outcome it
did not observe.**

The client knows *that* the connection ended; the directory says *why*. A
descriptor that is gone means the kernel shut down cleanly; a descriptor that
is still there with nothing listening means it died; a descriptor that
answers means another kernel has taken the directory over. Those are three
different endings, and the operator is told which one happened.

**Known limits (v0).**

- **Watching is still not reacting — for a *host*.** The transport carries a
  stream, and `cortex supervise` reacts to it. But the reaction lives in the
  CLI, not in the kernel: nothing in the kernel *acts* on what a subscriber
  sees, and a subscriber that wants to kill a runaway agent still has to
  issue the `kill` itself. That is deliberate — an operator watching a
  kernel must not be able to change what the kernel does by watching it —
  but it means the supervisor is a program, not a kernel feature.
- **A driver call does not park the process.** The kernel does not preempt a
  running process to mark it BLOCKED, so an agent in a slow `llm_call` reads
  as `running` in `cortex ps`, and `blockedOn` is `null` (PROCESS.md §3.7).
  `cortex top` finds the stall anyway — it reads the log — but `ps` is the
  flat table and does not, and a *host* that only looks at the process table
  will not see it either. The reserved `llm` / `tool` blocked reasons exist
  for exactly this and are not yet produced; turning them on is a state-model
  change (BACKLOG #060).
- **The supervisor cannot see a hang that never made a syscall.** Its signal
  is "this process is inside one syscall, and has been for too long". A
  process that stops calling the kernel altogether — spinning in plain
  JavaScript, or parked on a promise — is invisible to it, because there is
  no frame to pair. The kernel is cooperative and does not preempt
  (PROCESS.md §8.2); nothing short of real isolation would catch that.
- `cortex attach` still follows the `.crec` file on disk (which the daemon
  writes to) and delivers the interactive half over the wire. `cortex logs
  --follow` has the same shape: it polls `output.log` every 250 ms. Both work
  without a live kernel, which is why they keep that shape; `cortex watch` is
  the live one.
- **Memory inspection needs the live kernel.** `cortex memory <pid>` reads a
  process's memory regions through the transport, because a region's contents
  live in the memory driver — with the default `inmem` backing, in the kernel
  process's RAM — and there is no on-disk copy to fall back on. The only other
  place a region's contents appear is inside a `.csnap`, and that is a
  snapshot of one moment, not the present. So the command says plainly that
  it needs a running kernel instead of reporting an empty region.
- **The `wait` syscall is unavailable to a host.** It is a parent-child
  operation — the kernel parks the caller and wakes the caller's run queue —
  and a host is not in the process tree: the agent it started is a child of
  `init`. A host waits with `Kernel.awaitExit(pid, { timeoutMs })` instead
  (docs/HACKING.md §7).
- **The syscall log deliberately does not carry memory values.** It stores a
  hash and a byte count (ABI.md §4.4 — "full values would bloat the log"), so
  `cortex trace` can show that an agent wrote something down and never what.
  That is a deliberate trade, and it is the gap `cortex memory` exists to
  close — but it also means a *replay* cannot reproduce the values.
- Captured output is captured from the **kernel's** stdout, so it covers what
  the agent printed inside this kernel. Output written by a process that ran
  under an older build, or before the capture existed, is not there.
- `cortex spawn` still boots its own short-lived kernel by default, and
  `cortex spawn --live` opts into the live one. Either way the two kernels
  can share a directory, which is why the PID claim exists (§7): the claim
  keeps them off each other's PIDs and off each other's logs.
- **A snapshot does not carry its agent's spec.** The `.csnap` body holds the
  process image — state, memory, budgets, lineage — and deliberately not the
  role/agent spec, which is why a restore needs a context (the kernel's
  `restoreContext`). That context comes from the process table, from
  `<pid>.spec.json` (written when the process was created, §7), or from
  `<pid>.meta.json` (written when it exited). A snapshot taken before this
  round's change — or by a kernel that persisted no specs — can only be
  restored while its process is still around, or after the process has
  exited and written its meta.
- A crashed kernel leaves a stale `kernel.json` behind. Clients detect it
  (the port refuses the connection) and fall back to the disk view.
- **The dashboard's pushed stream needs the kernel.** Without one, it falls
  back to watching the directory and re-reading every log on every change —
  the thing the live path replaced. And the *process list* is then the disk's:
  a running process has no `meta.json` yet, so it has no row (its log is
  still shown).
- A **queued** signal loses its sender. The pending queue holds the signal
  (`pendingSignals` is part of `ProcessInfo`, and the ABI is frozen), so a
  `SIGUSR2` that had to wait for the target to run again is recorded without
  a `from`. The snapshot it produced is still identified by its chain id.
- `checkpoint` is legal from RUNNING / BLOCKED / STOPPED, so a process that
  is momentarily READY (scheduled, not yet dispatched) cannot be snapshotted
  yet. The transport waits for that window rather than refusing; a process
  that is STOPPED cannot be snapshotted at all, because the transition table
  has no `stopped -> checkpointing` edge (BACKLOG #011).

### 12.2 Multiple kernels on one machine

Should we support it? E.g. one kernel per project directory.

**v0 answer:** yes, via different `.cortex/` directories and different TCP ports. No coordination between kernels. Distributed cortex is post-v0.

### 12.3 Agent module format

How does an agent get loaded? `import('./agents/foo.js')` and call its default export?

**v0 answer:** yes. Agent modules are ES modules with a default-exported async function `(ctx) => Promise<void> | void`. The kernel imports them at `spawn` time.

Open: should we support manifest files (`agent.json` with metadata + entry point)? v0 says no. v1 may.

### 12.4 Driver loading and ESM/CJS interop

Drivers are npm packages or local files. ESM-only or both?

**v0 answer:** ESM only. The kernel is ESM (`"type": "module"` in package.json). CJS drivers can be wrapped with `createRequire`. We do not test this path in v0.

### 12.5 Crash recovery

If the kernel Node.js process crashes, what happens on restart?

**v0 answer:** all in-memory state is lost. Suspended processes can be restored from `.csnap` files. RUNNING/BLOCKED processes are gone. The supervisor (init) restarts daemons per their restart policies.

Post-v0: write-ahead log on every state transition would let us recover non-suspended processes too. Big lift, not v0.

### 12.6 How big can a `.crec` file get?

A long-running daemon could produce gigabytes. Do we rotate?

**v0 answer:** no rotation. User problem. Provide `cortex gc` to compact old logs (drop entries below the most recent checkpoint).

v1 may add automatic rotation with checkpoint anchors.

---

## 13. What we will get wrong

Predictions:

- **The scheduler's "resume the Promise" trick (§4.8) will be the source of subtle bugs.** Async/await was not designed for kernel-style suspension. We will write three implementations before one feels right.
- **CBOR will turn out to be slower than expected for hot paths.** We will benchmark, then either switch to a faster encoder or move recording off the critical path with a queue.
- **Implicit channel creation (§4.4) will produce a haunting bug.** Someone will send to a typo'd channel name and silently create a parallel universe. Predicted in ABI.md §10; will still happen.
- **`.cortex/` directory layout will need a migration in v0.2.** We will write `cortex migrate` and promise to never break it again. We will break it again in v0.3.
- **Driver loading order will matter when we said it wouldn't.** Two drivers will provide the same tool name and the resolution order will determine behavior. We will add explicit priority and apologize.
- **Single-threaded will hurt sooner than we expect.** A user will run 50 agents and complain about latency. We will profile, find a hot path, optimize it, and buy six months.

None of these are reasons to delay. They are reasons to write tests.

---

## 14. What comes next

This is the last design document of Phase 0. With STATE.md, PROCESS.md, ABI.md, and ARCHITECTURE.md drafted, the kernel can be built.

Phase 1 starts with `src/kernel/types.ts` and `src/kernel/errors.ts` — pure type definitions, no logic. Then `recorder.ts` (the lowest-level module). Then `process_table.ts`. Then everything else, in dependency order.

The first end-to-end smoke test: spawn a process that calls `llm_call` against the mock driver, exits, gets reaped. If that works, the kernel is alive.

---

*If a module boundary looks wrong, argue now. Once code exists, boundaries calcify.*
