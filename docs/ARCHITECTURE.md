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
└────────────┘ └────────────┘ └────────────┘ └────────────┘ └────────────┘
       │              │
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

**Ten kernel modules + one driver registry.** That is the whole v0 kernel.

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

This module is the only place syscalls are validated and recorded. No other module talks to the recorder directly except for internal events (state transitions, signal delivery).

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
├── kernel.json                       # kernel config (drivers, defaults)
├── processes/
│   ├── 1/                            # init
│   │   ├── log.crec                  # append-only syscall log
│   │   └── meta.json                 # cached ProcessInfo (for fast ps)
│   ├── 2/
│   │   ├── log.crec
│   │   ├── meta.json
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
│   └── boot.ts                       # §8 boot sequence
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

---

## 12. Open questions

### 12.1 Kernel ↔ CLI transport

The CLI talks to a running kernel via... what?

- **Unix domain socket** — POSIX, fast, but Windows support is awkward.
- **Named pipe** — Windows-native, but POSIX support is awkward.
- **Localhost TCP** — cross-platform, slight overhead, requires picking a port.
- **File-based mailbox** — simplest, slowest.

**v0 instinct:** localhost TCP on a port written to `.cortex/kernel.json`. Cross-platform, debuggable with `nc`. Revisit if it hurts.

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
