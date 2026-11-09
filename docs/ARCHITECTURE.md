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

Two of the calls that are not syscalls are recorded too, with the exact value that was handed back: `ctx.now()` and `ctx.random()`. They are the two things that would otherwise make two runs of the same code incomparable, so a recording that did not carry them could not answer "did this agent behave the same way?". `replay.ts` (§4.12) is what reads them back.

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

**Thirteen kernel modules + one driver registry.** That is the whole v1 kernel:/nthe twelve in §4.1–§4.12, plus `wake_gate.ts`, which has no section of its own
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

**The outcome is recorded when it is decided.** A process's exit code and
reason are known the moment its exit is *requested* — the syscall was called
with them — so the table carries them **before** the EXITING transition, not
after the cleanup. The exit frame in the log is written later, and that write
awaits the disk; there used to be a window in which the table said "exiting"
and "no exit code", and a host that read it found nothing.

That window was not harmless. "No exit code" is the absence of an answer, and
the CLI turned the absence into zero: `cortex spawn` on an agent that threw
an exception sometimes printed `code 0: completed` and exited 0, while the
kernel's own metadata said `exitCode: 1` the whole time. The invariant now
holds in two halves:

> **A process that is exiting already knows how it will end. And an ending
> nobody saw is reported as unknown — never as success.**

The second half is the CLI's, and it lives in one place
(`src/cli/process_outcome.ts`) so that `cortex spawn`, `cortex restore` and
`cortex wrap` cannot tell the operator different stories about the same run.
The `wait` syscall is held to it too: a parent that is told "the child exited
0" will believe the child succeeded, and a supervisor that believes that does
not restart anything.

**The wall clock is charged by time, not by work.** A process's
`wallTimeMs` is the time it has been alive, and the table keeps the mark up
to which it has already been counted (`lastWallAccountAt`). Every accounting
pass — `spend()`, and the scheduler's heartbeat, `chargeWallClock()` — adds
the real time since that mark and moves the mark to now. The clock runs while
the process is alive and **pauses** while it is stopped or suspended (that
time is not the agent's), and it is exact at the exit.

It used to be charged only at an `llm_call`, and only when the budget was
bounded. Two things were untrue at once: a process with no wall budget
reported `wallTimeMs: 0` for a run that had lasted minutes — and the views
print that number (`cortex limit` says "wall time: spent 0ms") — and a
process that sat in `recv()` never drained its ceiling. A budget an agent can
outlast by doing nothing is not a ceiling.

The kernel's own process (PID 1) is not charged: init is the kernel, not an
agent, and it spends no tokens and no usd either. Charging it would make the
views that total an agent's spend report the kernel's uptime as if it were
work.

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

**And the view says the ceiling.** The kernel knows the resolved cap, and the `ENOMEM` check is measured against it — but no view said so: `cortex memory`'s region table showed how many *entries* a region held and nothing else, so the operator could not tell that the next write would trap. The transport now carries the resolved ceiling with the region (`effectiveMaxEntries`, the ABI's own name; the reply gained a field, so the transport's version does not move), and the table prints it beside the **write count** — the number the cap is actually measured against. The entry count is a different number (a region with three entries written fifteen times holds three entries and has made fifteen writes), and putting a cap next to the entry count without the write count would invite a comparison the kernel never makes. A region the kernel did not report a ceiling for prints `?`, not `∞`: a ceiling nobody reported is not an unbounded region.

**And the view says who may write.** A region's policy may also declare `readOnly`, and then `memory_write` traps **`EPERM`** on it (ABI.md §4.4) — the write is refused before anything else happens. That refusal is only meaningful on a **shared** region: a `shared` binding points every process that declared it at the same physical key, so a process whose own binding is read-only can read what the others write and cannot add a byte to it. (A read-only `private` or `cow` region is a region nothing can ever fill, because the only writer is the process that owns it.) Sharing is not writing, and the two facts live on different sides of the same region.

The kernel knew both, and the transport already carried one of them: the region's own `readOnly` flag had been on the wire since `cortex memory` was born, and **no view printed it**. So an operator whose agent's write had just failed with `EPERM` was left with an errno and no way to know it was a policy and not a bug — and a writer looking at a shared region could see that a peer shared it but not whether that peer could change it.

So the table now says both. The region's own right to write is the **`ACCESS`** column (`read-write`, or `read-only` when the binding refuses writes), and each peer in **`SHARED WITH`** carries its own (`3 (read-only)` — it can see this region and cannot write to it). The transport gained one field for the peers (`readOnlyPeers`, a subset of `sharedWith`) and one for the dump's header (`readOnly`); both are additions to a reply, so the transport's version does not move. The region dump names the same mode in its header — the table and the dump are two views of one region, and they say the same thing about it. An access mode nobody reported prints `?`, never `read-write`: a permission nobody stated is not a granted one.

**And the window says it too.** `cortex memory` was the only view of a region's facts, and the operator's window had none of them: the dashboard could show what an agent **did** (the event table, the syscall timeline) and nothing about what it **knows**. The kernel held all of it — the regions, their entries, their write counts, their ceilings, their access modes and their peers — and the window had no way to ask.

So the window asks. The dashboard serves a process's memory over two endpoints (`GET /api/memory/<pid>` for the regions, `GET /api/memory/<pid>/<region>` for one region's entries), and the process dialog has a **second view beside the syscall timeline**: **记忆**. The panel says the same words `cortex memory` says — the access mode, the ceiling, the peers — because those words live in one module (`src/cli/memory_view.ts`), and each view supplies only **how it prints a number**. Click a region and the window shows what is in it: the keys, the values, and when each was written.

The memory is asked for **on demand** — the panel fetches it when the operator opens it, not on every process-table refresh, because a 250 ms refresh that asked every process for its memory would turn one poll into N round trips to the kernel. And without a live kernel the panel says so plainly instead of showing an empty region: a region's contents live in the kernel that owns it, and there is no on-disk copy to read instead (the same limit `cortex memory` has).

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
  setNice(pid: ProcessId, nice: number): Promise<{ nice: number; from: number }>;
}
```

**Internals.** A priority queue ordered by `(nice, enqueue_time)`. On each tick:

0. Charge the wall clock — every process that is alive pays for the time that
   passed since the last tick. This is the kernel's heartbeat, and it is what
   makes a wall-clock ceiling a ceiling: an agent that is sitting in `recv()`
   spends its budget exactly like one burning tokens (PROCESS.md §8.3).
1. Pop the highest-priority READY process that can still run. A token or usd
   remainder of zero stays parked in the queue. A wall-clock remainder of
   zero is still chosen (PROCESS.md §8.3): the clock runs on the heartbeat,
   so it can hit zero while the process is only waiting for a turn, and
   parking it would leave a READY process that never runs and never says why.
2. Transition to RUNNING.
3. If a budget is already zero, fire `SIGXCPU` before the quantum and do not
   resume the agent. This is how a wall-clock ceiling that expired in the
   queue becomes a stop instead of a hang.
4. Otherwise resume its async function (the agent's `await` returns).
5. When the agent next blocks or yields, transition back to READY/BLOCKED.
6. If a budget hit zero during the syscall, fire `SIGXCPU` instead of returning to READY.

**The queue is ordered by `(nice, enqueue_time)`, but only the second half is
stored.** The rank is read **live** from the process table at selection time,
so an operator who moves a running process (`setNice`) changes the order at
the next dispatch and the queue is never rebuilt. The scheduler's own comment
has said so since the rank was introduced ("so a future `renice` is honoured
without re-queueing"); the verb is what it was waiting for.

`setNice` is the **operator's** verb and it lives on the host's side of the
kernel — `Kernel.setNice()` and the transport's `renice` command. It changes the
table's number and writes a `__sched` frame with the action `renice`, because
the rank already has a history in that log and a change to it belongs beside
that history (PROCESS.md §8.1).

**And since `1.1.0` the agent has a door to the same scheduler.** The
`renice` syscall (ABI.md §4.10) is gated by the same reach rule `kill` and
`send` use — your own tree is yours, a stranger needs the `renice` capability
(ABI.md §4.9) — and it writes the same `__sched` frame, with the **actor**
added: `operator` for the host's door, `agent:<pid>` for the agent's. That is
what moved the ABI, additively, to `1.1.0` (ABI.md §11).

**And the operator's window can reach it.** The verb existed, and the window
showed every process's rank in a column, and the operator still had to leave
the window and open a shell to use it — the window could say "this agent is at
`-7` and that one is at `5`" and do nothing about the difference. The
dashboard's write ops are the operator's buttons (`spawn`, `kill`, `restore`,
and now `renice`), and they are carried out by the same `cortex renice`
command the shell would run, so there is one path to a rank and not two.

The **control** is a button in the ops cell, on the row of the process it
moves: a rank belongs to a process, so the control belongs to that process's
row. It opens the window's existing dialog with a number field — the same
dialog that carries the syscall timeline — because a native `prompt()` cannot
be driven by a test, and a control that cannot be tested is a control whose
behaviour nobody knows.

**The range is the kernel's and the server reports it.** The page does not own
the kernel's value domains and does not get to state them, so the dashboard
answers `/api/ops` with `niceMin` and `niceMax` taken from the kernel's own
constants, and the page renders **no control at all** until the server has
answered. A page that hardcoded the range would be stating a domain it does
not own, and it would be right only until the kernel moved. A rank that was
never reported starts **empty** rather than at `0` — `Number('')` is `0`, so a
pre-filled default would turn a click into "set this process to the default
rank", a number the operator never saw. The **endpoint** applies that rule
too: it reads the body's `nice` as the digits it is and refuses it when it is
not digits, rather than coercing the body first — a careful page behind a
careless door is still a careless door.

A rank change asks **no confirmation**: it is reversible and loses no work, so
a second "are you sure?" would be the window distrusting an operator who has
just said what they want. A kill asks, because a kill ends something. And the
op is behind the same gate as the other writes — `--ops kill` does not quietly
grant renice, and `--ops renice` grants renice and nothing else.

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

**And it reports what it decided.** The restart decisions were always made,
and always recorded in init's own log (`__init` records: `restart`,
`restart-gave-up`) — but they reached nobody who was watching. A daemon that
crashed three times and was then given up on printed nothing at all, and for
a daemon stdout *is* the log. Init now tells the host through
`KernelOptions.onDaemonDecision`: a restart (with the new attempt's pid, and
how the old one ended) or the decision *not* to restart (the policy said so,
or the cap was reached). The CLI prints it; see PROCESS.md §9.1. A host that
embeds the kernel gets the same hook.

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

### 4.12 `replay.ts`

**Responsibility.** Serve a recorded run back to an agent that is running
again: the model's answers, the tool results, the clock and the RNG all come
from the recording instead of from the world.

**Public interface:**

```typescript
type ReplayMode = 'live' | 'cached' | 'strict';

interface ReplaySource {
  take(syscall: string): RecordedCall | undefined;
}

class LogRecording implements ReplaySource {
  static fromFile(path: string): Promise<LogRecording>;
  static fromRecords(records: readonly SyscallRecord[]): LogRecording;
  readonly size: number;
  readonly ordered: readonly RecordedCall[];
  take(syscall: string): RecordedCall | undefined;
  reset(): void;
  childPids(): readonly number[];
}

class ReplayRecordings {
  static of(sources: ReadonlyMap<number, ReplaySource>): ReplayRecordings;
  static fromDirectory(dir: string, rootPid: number): Promise<ReplayRecordings>;
  sourceFor(pid: number): ReplaySource | undefined;
  has(pid: number): boolean;
  readonly pids: readonly number[];
}

class ReplayEngine {
  constructor(recordings: ReplayRecordings, mode?: ReplayMode);
  readonly recordings: ReplayRecordings;
  readonly mode: ReplayMode;
  sourceFor(pid: number): ReplaySource | undefined;
  syncValue(pid: number, syscall: string): unknown | undefined;
  llmDriver(real: ILLMDriver | undefined, name: string | undefined): ILLMDriver;
  toolDriver(real: { driver: IToolDriver; descriptor: ToolDescriptor } | undefined, name: string): {
    driver: IToolDriver;
    descriptor: ToolDescriptor;
  };
}
```

**One recording per process.** A process's whole footprint is one directory
(`processes/<pid>/log.crec`), so a run of N processes is N recordings — and a
supervision tree is the normal shape of a real agent. The recordings are
therefore keyed by **pid**, and `ReplaySource` is deliberately *not* pid-aware:
the mapping lives in `ReplayRecordings`. A source that could be asked about
any process would make it far too easy to answer a child with its parent's
history — and that failure is not a crash. The child would be handed the
parent's answer and the parent would then find its own recording empty, so the
replay would "work" and be wrong, which is the worst way to be wrong.

**How the tree is found.** Nothing on disk records the shape of a run except
the logs themselves: a `spawn` names its child in `pid`, a `fork` names it in
`childPid`. `LogRecording.childPids()` reads those two links out, and
`ReplayRecordings.fromDirectory()` walks them from the root, loading each
process's own recording. A `restore` is **not** a link: it materialises a
process from a snapshot, and that process's history starts at the snapshot
rather than at the restorer (replaying a restore is a different problem, and
it is not solved here).

**Internals.** The recording is indexed by syscall name, and each name's
frames keep their order — so the Nth `llm_call` of a replay gets the Nth
recorded `llm_call`. The `enter` frames are requests, not outcomes, so they
are not served; the `__`-prefixed frames are the kernel's own bookkeeping, so
they are not either.

**What gets wrapped, and why that.** The *driver resolver* is what the replay
replaces, not the dispatcher. A resolver answers "which driver handles this
call?"; wrapping it changes **where the answer comes from** and nothing else,
so no syscall changes its meaning and the dispatcher needs no replay-specific
code at all. The clock and the RNG are served at the two places where the
kernel hands them to an agent (`ctx.now()` / `ctx.random()`), because those
are the only two calls that would otherwise make two runs of the same code
incomparable.

**A replay does not need the model provider the original run used.** A
resolver that finds no driver still answers — with a recording-backed
placeholder — because the recording *is* the answer. A run recorded against
one provider can therefore be replayed on a machine that has never heard of
that provider's API key. This is the difference between a recording that is
merely archived and one that is usable.

**The three modes.** `live` ignores the recording entirely. `cached` serves
what the recording has and lets the world answer the rest. `strict` serves
what the recording has and **fails** on the rest, with `ERECORD` — because a
replay that quietly goes live looks like a faithful reproduction and is not
one. `strict` is the default.

**What a replay does not do.** It does not rewind the world. A tool that
already ran did not run again: the recorded result is served, so a side
effect is not repeated. That is the point (STATE.md §5), and it is also the
honest boundary — a replay shows what the agent *would* do now, not what the
world *would* answer now.

**Where it is wired.** `KernelOptions.replay` (`{ recordings, mode? }`) turns it
on; the kernel then wraps its own resolvers and serves the two synchronous
calls — from the recording that belongs to *that* process. The host-facing
surface is `cortex replay <pid>` (see §12.1) and `src/cli/replay_core.ts`,
which turns two logs into one answer: did the replay reproduce the recording,
and if not, **where** did it first go wrong?

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

4. Dispatcher parks the process for the call:
   process_table.transition(pid, BLOCKED, {kind: 'llm', callId})
   The await yields the event loop, so other READY processes run.

5. ... time passes. A signal that arrives here is queued.
   A default terminate is not an exception for a model call:
   the call is already in flight, and aborting it would spend
   the tokens and throw the answer away (PROCESS.md §7.2).

6. LLM driver's Promise resolves with response.

7. Dispatcher returns the process to RUNNING inline
   (BLOCKED → RUNNING, trigger `driver-return`). The body never
   left this call, so it does not pass through READY. Pending
   signals are delivered before the result is handed back.

8. Dispatcher receives response:
    ├─ update budget counters (tokens, USD)
    ├─ check budgets: if exhausted, signals.send(pid, SIGXCPU)
    ├─ recorder.write(handle, {phase: 'exit', result: response, duration_ms, ...})
    └─ return response to agent code

9. Agent code continues with `const response = await ...` resolved.
```

**Nine steps for one syscall.** The driver call parks the process and then
returns it to RUNNING in the same call. `recv`, `wait` and `sleep` still
wake through READY, because those bodies are not running until the
scheduler dispatches them (PROCESS.md §3.7).

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

**What `spec.json` holds, and why it is written so early.** The role, the agent spec, the memory region policies a process was created with, and the authority it was born with — its capability set, the pool it may escalate from, and its budget ceiling. The first three are the facts a restore needs to rebuild it, and the facts the `.csnap` body deliberately omits (STATE.md §4); the last three are the facts a *replacement* needs to be the same process rather than a stronger one (ABI §4.9, §12.1 below). It is written when the process is **created**, not when it exits: `meta.json` (which carries the same facts) is written at exit, so a snapshot of an agent that was still running when its kernel died would have had no spec anywhere on disk and could not be restored in a later session. The kernel reports the birth (`KernelOptions.onProcessStart`) and the CLI decides what to write; the kernel itself never touches the disk layout.

**What `meta.json` holds, and who may write it.** The **exit record**: the kernel's own account of a process's life — its identity, the state it ended in, its exit code and reason, what it spent, and the capabilities it held (ABI §4.9). The kernel writes it at the ZOMBIE transition, through `KernelOptions.onProcessExit`; the CLI decides where it lands on disk.

It has a second writer. The CLI writes a record of its own at the end of the command that ran the process — it knows the memory policies it declared and what the process was blocked on, and the kernel does not — so "whoever wrote last" used to decide what the file said, and the race was won by the thinner record. A `cortex spawn` that finished replaced the kernel's exit record with the CLI's, and the capabilities went with it: a process that held every capability was recorded as holding none, and `cortex ps` printed `-` for it — the *absence* of an answer, which is not the same as "everything". The same write put the process in the wrong process group too (the CLI wrote the process's own pid as its group; a child joins its parent's).

So the two writers split the file by ownership, and neither may write the other's facts:

| fact | author |
|---|---|
| identity, state, exit code and reason, budgets, capabilities | the **kernel** — it was there |
| memory policies, blocked reason | the **CLI** — the kernel never sees them |
| money | **grows only** — the CLI may add spend the kernel could not see (`cortex wrap`'s tap); nobody may make a process look like it spent less |

A write is therefore a merge, not a replace. The kernel's account wins where the two meet, because it is the account of what actually happened; the CLI's declaration is kept, because the kernel has no way to know it; and a writer that can see spend the other cannot adds to the counters instead of replacing them.

**One ending has two authors, and the rule says which one.** The ending belongs to whoever *decided* it. A process that ends itself was decided by the process, and the kernel's exit record is the account of that. But a run the **CLI** stops — `cortex wrap --timeout` — was decided by the CLI, and the kernel only saw a signal: its account of the wrapper process ("exited 1 (cancelled)") is not what an operator needs to read afterwards. What they need to read is that *we* killed it, and why. So the CLI says that it decided (`writeProcessView(dir, meta, { ownsEnding: true })`), and the record carries the CLI's account: `137`, the shell's own convention for a run we stopped, and "timed out after 1216ms".

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
│   ├── replay.ts                     # §4.12 — deterministic replay
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
│   │   ├── replay.ts
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
> with the comments) across seventeen modules — the dispatcher alone is 1,400.
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

**And it made the budget reachable.** `cortex limit` used to boot a kernel of
its own and look there — and that kernel holds nothing but init, so the
command answered "no such process" for an agent `cortex ps` was showing as
running. It could not *set* a budget on anything either, ever: the setting
path looked in the same empty kernel. It now asks the kernel that holds the
process, the way `checkpoint` and `kill` do, and falls back to the on-disk
exit record for a process that has finished — a running agent has no
`meta.json` yet (the kernel writes that when it exits), so the disk cannot
answer for it and the transport must.

Two things about that verb are worth naming, because both are the difference
between a number and a promise:

- **The ceiling is not the remainder.** The kernel keeps the *remainder* —
  what is left — and the spend; the ceiling (the total the process may ever
  spend) is their sum (STATE.md §2.4). `cortex limit` used to print the
  remainder under the label "limit", so an agent spawned with
  `--token-budget 1000` that had spent 42 tokens read as `limit 958` — a
  number that shrinks under the operator's feet, wearing the label of a fixed
  promise. It now prints the ceiling and then what is left of it. And
  `--tokens N` means the ceiling is N, which is what the help says and what
  an operator means by it: the kernel keeps the remainder, so the ceiling is
  converted on the way in, against the spend read at the same moment — a
  client that read the spend and then converted it would be racing the very
  spending it is trying to cap.
- **A finished process refuses to have its budget rewritten.** What it spent
  is the kernel's record, written down when it ended. Changing it would be
  changing history, so the command says no — and says *why*: a budget is a
  thing a running process has.

The write is the operator's own action, not the process's, so it is **not
recorded**: the ABI has no `set_budget` (a process cannot raise its own
ceiling), and a budget change is not something the agent did — it is something
the operator did to the agent. The budget a *process* sees is still read
through the `budget()` syscall (ABI.md §4.8), which the ABI leaves unrecorded
on purpose.

**And it gave the operator the queue.** `cortex renice <pid> --nice <n>` moves
a process that is *already running* up or down the queue — the rank it was
born at is set by `cortex spawn --nice` / `cortex daemon install --nice`, and
until now that was the end of it: an agent that had been running for an hour
at the default could not be promoted, and one hogging the queue could not be
pushed back, so the only way to change a running process's rank was to kill
it and start it again.

The kernel was already ready. The scheduler reads `nice` **live** at selection
time, so a changed rank takes effect at the next dispatch and the run queue
is never rebuilt; the verb was the missing piece. Like `limit`, the command
itself is the operator's own — a host-side command (`Kernel.setNice()` and the
transport's `renice`) — and it did not move the ABI when it landed. The *agent's*
door to the same queue did, in `1.1.0`: the `renice` syscall (ABI.md §4.10),
which is additive (ABI.md §11).

It is recorded, and that is the difference from `limit`: the **rank** already
has a history in the process's log (the scheduler writes it on every yield),
so a change to it belongs beside that history — a `__sched` frame with the
action `renice`, carrying the rank it came from and the rank it went to, and
who asked for it. A
**budget** is the opposite case: the ABI leaves budgets out of the log on
purpose, so changing one starts no history and leaves none. A rank that did
not move records nothing.

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
agent work without attaching a debugger to it — by push when a live kernel is
holding the process, and by polling the file when it is not.

The mechanism is deliberately thin, because the kernel still does not know what
a process said. It reports which process a body belongs to
(`KernelOptions.agentScope`) and the CLI decides what "inside a scope" means:
an `AsyncLocalStorage` holding the PID, which survives every `await` inside
the body — so a line printed three seconds later by an agent that was parked on
`recv()` and woken by another process still knows it is PID 7's. The tap is on
`process.stdout.write` rather than on `console.log`, so the captured text is
exactly what Node formatted, and the original write still happens: the output
still goes to the daemon's stdout, and now it is also addressable.

The tap does not let go of the stream. `write` is installed as an *accessor*,
so anything that replaces it later — a logger, a reporter, a test harness — is
re-wrapped instead of switching the capture off. The failure it prevents is
the worst kind: the agent would keep printing to the terminal, the log would
quietly stop growing, and every `cortex logs` would answer with a file that is
missing exactly the lines that mattered.

**And it made the memory addressable.** The other half of "why did the agent
do that?", and the half the syscall log cannot answer. ABI.md §4.4 records a
`memory_write` as a **hash** and a byte count rather than the value — "full
values would bloat the log" — so `cortex trace` can tell you that an agent
wrote something down and never what it wrote down. The knowledge is the whole
point of an agent that remembers, and the log deliberately does not carry it.

The live kernel still has it. `cortex memory <pid>` reaches in: which regions
a process has, what kind each one is, how much is in each, **how much each one
may hold**, **what this process may write to it**, **who else can see them and
which of them may write**, and the entries themselves.

```
$ cortex memory 2
# memory of pid 2 (inbox-watcher)
REGION          KIND      BACKING     ACCESS     ENTRIES   WRITES    LIMIT     SHARED WITH
------------------------------------------------------------------------------------------
episodic        cow       inmem       read-write 2         2         ∞         -
semantic        shared    inmem       read-write 3         4         ∞         3 (read-only)
procedural      private   inmem       read-write 0         0         ∞         -

$ cortex memory 2 semantic
# memory of pid 2 (inbox-watcher) — region 'semantic' (read-write)
ticket:T-1180  {"id":"T-1180","category":"bug","reply":"Thanks for the report …"}  2026-10-23T19:05:33.842Z
```

The `SHARED WITH` column is the one that earns its keep: a `shared` region is
visible to every process that declared it, so knowing that agent 3 is reading
agent 2's notes is the difference between a shared scratchpad and a leak. It
falls out of comparing physical keys, and it also catches the other case — a
`cow` region whose forked child has not written yet. Each peer carries the
access mode it holds the region under, because a peer that may only read it
can see everything in it and cannot add a byte to it.

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
time          pid     syscall                                                    phase  duration   reversibility
----------------------------------------------------------------------------------------------------------------
19:50:09.072  1234    __sched:blocked(recv)                                      exit   -          idempotent
19:50:09.072  1234    sleep                                                      exit   2523ms     idempotent
19:50:09.073  1234    memory_write                                               enter  -          reversible
19:50:09.074  1234    memory_read                                                exit   0ms        idempotent
19:50:09.077  1234    exit                                                       enter  -          irreversible
# pid 1234 exited with code 3 (probe finished on purpose)
```

The `record` lines are printed in the same layout as `cortex trace`, so the
two can be read side by side — and they *are* the same frames, which is the
point.

**And the kernel's own frames got names.** Four syscalls are not really
syscalls — they are the kernel's bookkeeping, and their names say so:
`__state`, `__init`, `__sched`, `__signal`. They were recorded with a
placeholder name and *shown* with it, so a log full of them read as a
column of `__init`: ten rows saying "ten things happened" and nothing
about what they were.

That hurt most in **init's log, which is the supervision journal**. It is
the durable record of every restart decision the kernel made — the one
place the answer to *"what did the supervisor do?"* is kept — and the
decision was sitting in the frame's `action`, where no reader was looking.
Reading init's log meant counting identical lines.

So the *view* now carries the distinguishing part:

| frame | shown as | tells you |
|---|---|---|
| `__init` | `__init:restart-gave-up` | which supervision action was taken |
| `__sched` | `__sched:sigxcpu(tokens)` | which scheduling action was taken, **and what caused it** |
| `__state` | `__state:running->blocked(recv)` | the transition, **and what caused it** |
| `__signal` | `__signal:SIGTERM(delivered)` | which signal, and what became of it |

The `__state` frame is the one that gained a cause. A transition without one
is a fact without an explanation: `running->blocked` says the process
blocked, and not whether it was waiting on a channel, on a timer, on a child,
or on a signal — so the reader had to guess from the transition pair. The
cause was in the frame all along (ABI.md §6.1 — "`from`, `to`, and the
trigger that caused the transition"); the view dropped it.

A signal is named by the **signal**, not by the word "signal": `SIGTERM` says
more than `signal`. Every other cause is the trigger the kernel recorded —
`recv`, `sleep`, `wait`, `scheduler-dispatch`, `init-register-daemon`, and so
on.

**And the scheduler's frames gained one too, by the same rule.** `sigxcpu`
says the process was stopped — and not whether it ran out of tokens, of
money, or of wall time. "Your agent was stopped" and "your agent ran out of
tokens" are different facts, and only one of them tells the operator what to
change. So the frame now says which budget fired, what the process was
waiting on, and why it was gone:

```
__sched:sigxcpu(tokens)
__sched:blocked(recv)
__sched:parked(sleep)
__sched:exited(reaped-during-quantum)
```

**And the causes are a vocabulary, not free text.** `STATE_TRIGGERS` is
exported from the process table, `setState` takes a `StateTrigger`, and so a
cause that is not on the list **cannot be recorded** — a typo is a compile
error (`Type '"revc"' is not assignable to type '"recv" | …'`) and not a frame
nobody can explain. The list also widens the trace table's syscall column by
itself: the widest frame name the kernel can produce is
`__state:checkpointing->checkpointing(init-register-daemon)`, 58 characters.

The scheduler's causes are words the same way: `BUDGET_KINDS` (what a
process can run out of), `BLOCKED_KINDS` (what it can be blocked on) and
`DISPATCH_EXITS` (why a dispatched process was gone) are exported, and the
kernel records a `BudgetKind`, a `BlockedReason` and a `DispatchExit` — so a
frame that says `sigxcpu` and leaves out *which* budget is not something the
code can even write.

The **recorded** syscall name is untouched — the `.crec` format is frozen
(ABI.md §6), and this is a view of a log, not a change to the log. A
`__init` record on disk still says `__init`; `cortex trace`, `cortex
attach` and `cortex watch` render it as `__init:restart`.

**And the frame's own fields are the frame's.** The signal path used to pass
the pid that sent the signal in the transition's metadata, and that metadata
was spread *over* the transition — so the `__state` frame recorded a pid (or
null) where the **state** belonged, and the log said a process came "from
null", which is not a state at all. ABI.md §6.1 says the frame carries
`from`, `to` and the trigger, and now it does: the transition's own values
always win, and the sender is recorded under `sender`.

The same fix removed a second failure that had been hiding in plain sight:
the table's **header** was a hand-typed string. It had drifted — its
`phase` sat five columns to the right of where the rows printed theirs,
and the rule under it was longer than the header it ruled. The header and
the rule are now **generated from the same column specification the rows
use**, in one place shared by all three commands, so a row cannot land
under the wrong heading again.

And the **width of the syscall column is derived, not typed**. Naming the
frames made them longer — `__state:checkpointing->checkpointing` is 36
characters — and a column whose width is a guess is a column that is wrong
eventually: one character too many and every column after it slid right,
so the row stopped lining up with the heading above it and the reader could
no longer tell which column they were looking at. The width is now computed
from the kernel's own value domains (`PROCESS_STATES`, `ALL_SIGNALS`,
`DELIVERY_OUTCOMES`, `INIT_ACTIONS`, `DISPATCH_ACTIONS`), so a new state,
signal or supervision action widens the column by itself. A name that
genuinely cannot fit — a driver registering a very long syscall name — is
**cut and marked** (`…`): a fact that does not fit must not lose its tail
silently.

**And the operator's window says the same thing.** The naming rule was in
`cortex trace`'s own module — and the **dashboard's timeline**, which reads
the same `.crec`, printed the *recorded* syscall name. So the same frame read
as `__state:running->blocked(recv)` in the terminal and as `__state` in the
window: five rows of the operator's timeline that said "something happened"
and not what.

Two views of one log, disagreeing about what it says — and the window is the
one an operator watches. So the naming rule moved into a module **both** can
reach (`src/cli/frame_name.ts`), and the dashboard's timeline API now carries
the name a human reads:

```json
{"syscall":"__state","frame":"__state:running->blocked(recv)","phase":"exit"}
```

`syscall` is still there and still the recorded name — the `.crec` format is
frozen, and a reader that matches on the recorded name keeps working. `frame`
is the view, and the page shows that one.

A rule that only one command can reach is a rule every other view reinvents.
This one was reinvented once already.

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

That module is also where the **words** live: what a process is "waiting on"
(`a channel`, `a timer`, `a child`, `a model call`) and how long it has been
waiting. The dashboard prints the same words, because it is a second view of
the same fact, and two views of one fact must not be able to phrase it
differently.

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

**And a frame that says a fact in the wrong place is a fact nobody sees.** The
conversion reads an `llm_call` result's usage from `usage`, because that is
where ABI.md §4.3 puts it and where every other reader looks. The fetch tap
wrote its usage **flat**, so every ABI-shaped reader — the event table, the
trace view — saw a tapped call with a model and nothing else: no tokens, no
cost. The summary line knew what the call cost, because it read the flat
fields. One call, two answers, and the operator's window was the one missing.

The fix was not to teach every reader about a second shape: that is a tax on
every reader that will ever be written. It was to make the tap write the
shape the ABI already specifies — and to keep the flat fields as well, because
the `.crec` format is frozen and a log written by this build has to stay
readable by an older `cortex wrap`. The reader (`readTapSpend`) takes both
shapes; the frame carries one.

**And a row that is parsed wrong is a row that was never read.** The event
table's "Token / 模型" cell carried its price in a `title` attribute whose value
was a nested template literal:

```html
<td title="${event.usd === undefined ? '' : `$${Number(event.usd).toFixed(6)}`"}">
```

The nested template ends with a backtick *and* a quote, so the attribute came
out one quote too long. The HTML parser then read the **rest of the row** as
that attribute's value: the browser showed six cells where the header has
seven, the time landed under "Token / 模型", and the tokens and the cost never
reached the screen.

This is the one bug in this project that **looks correct everywhere but the
browser** — the template renders seven cells in Node, so a unit test that
rendered it would have passed. It was in the page since v1.2.0 and nobody saw
it, because the only place it shows up is the operator's window, and the
operator's window is looked at, not read.

So the rule the page now follows: **an HTML attribute never holds a template
literal.** A value is computed in JavaScript, escaped once, and dropped in.
And the row's shape is now held by a check that renders a row with the page's
*own* code — its escaper, its labels, its clock, pulled out of the served
page — and asserts that every tag closes its own quotes and that the row has
one cell per header column.

The process list, meanwhile, is the *same view* `cortex ps` shows: one
module (`src/cli/process_view.ts`) answers for both, and it takes the
connection it is given rather than opening its own — the dashboard holds one
connection for its whole life and hands it over.

**And the process table stopped being a snapshot.** It was re-read only when
a process *started* or *ended*, so an agent that worked for a minute was
shown as it was when it started — its state frozen, its spend frozen — while
the page said "live connection". The kernel says what happens (every syscall,
every state transition, and when it happened), so the table is re-read when
the kernel says something, **throttled** at a quarter of a second: a busy
kernel says something every few milliseconds, and a re-read that waited for
the silence would never happen — the table would sit frozen through exactly
the busy period it exists for. That was not a theory: a real run measured
**two tables in fifteen seconds** before the throttle and about **four a
second** after it.

And the table now says **what each agent was allowed to do** — the question
`cortex ps` answers and the dashboard did not. The label travels with the row
(`capsLabel`), produced by the same rule `cortex ps` prints (`formatCaps`),
because two views of the same fact must not be able to disagree: an agent
restricted to `spawn` says `spawn`, an agent holding everything says `all`,
an agent holding nothing says `none`, and a process whose capabilities were
never recorded says `-` — which is *not* "everything", it is the absence of
an answer. The page prints the label it is given; it does not re-implement
the rule, because a second rule is a rule that drifts.

And the **footer says which way the page is being refreshed**: "live push
(SSE), reconciled every 30 seconds" while the kernel is pushing, "polling
every 3 seconds" when it is not. The page used to claim "auto-refresh · every
3 seconds" whatever it was doing — and in the live case it was not polling
every 3 seconds at all. The polling line used to add "the live connection is
unavailable" as well, which is a claim about *why* the push is gone that the
window cannot check: the stream can fail while the kernel is perfectly alive.
What is behind the numbers is the **top bar's** business, and the top bar
asks.

**And the dashboard says what each agent is inside.** The page is the
operator's window, and it had the same blind spot as the process table
itself: an agent that was four minutes into a model call read as
`running`, and an agent parked on a channel read as `blocked` — the
process table cannot tell a listener waiting for a message from an agent
that will never be answered, and it cannot see a driver call at all,
because the kernel does not park a process while its LLM call is in flight
(BACKLOG #060).

So the dashboard asks the kernel, the same way `cortex top` does, and the
row carries the answer as `insideLabel` — "waiting on a channel for 1m2s".
The wording comes from **one function**, shared with `cortex top`
(`src/cli/open_call.ts`), because an operator who reads "waiting on a
channel" in one view and something else in the other has to work out
whether those are the same thing. The page prints the label it is given and
does not re-implement the rule, for the same reason it does not re-implement
the capability rule.

And the column appears **only when the kernel can answer**. The label's
presence is the signal: a row with no label at all means the kernel did not
answer — it is too old to know the command, or there is no kernel — and a
column of blanks would claim that nothing is inside a call, which is a
different fact from "nothing is inside a call".

**And the dashboard learned to stop.** An open event stream is a connection
that never ends by itself, and `server.close()` waits for it. The dashboard's
own UI holds one open from the moment it loads, so Ctrl+C would hang the
dashboard instead of stopping it — the operator's way out was the one thing
that did not work. The server now drops its connections when it closes, and
closing twice is not an error.

**And the activity panel follows the logs instead of re-reading them.** The
panel is built from the syscall logs — every `.crec` of every process — and it
used to be **rebuilt from scratch on every change**: every log read from byte
0, every frame decoded, the newest few kept. That is O(the whole history) per
change, and the history of a long-lived agent is the thing that grows.
Measured on a real directory with a real kernel's log: a **3 MB** log cost
**154 ms** per read, and a **6 MB** one cost **301 ms** — paid again on every
filesystem change, which during a busy agent is several times a second. The
operator's window got slower exactly as the operator needed it.

So the feed is **read once and then followed**. Each process's log gets a
cursor (`LogTail`, in `src/kernel/recorder.ts` — the format knowledge stays
with the format), and every refresh reads only what has been written since.
Measured on the same directory afterwards: the first request still costs the
whole log (**227 ms** — it has to be read once), and every request after it
costs **3–4 ms**, whatever the history has grown to.

**A follower has to know it is still following the same history.** A log that
was replaced by a *different* file of the same size does not look truncated,
and the bytes at the old offset are then the middle of a frame — which reads
as "the writer has not finished the frame yet", not as "this is a different
history". So the frame that was read last is checked: it has to still be at
that offset, with that length, saying the same thing. One frame's worth of
reading to know that the rest is still the rest, and a file that fails the
check is read again from the beginning and reported as replaced — because
keeping the old events would be showing a past the disk has erased.

**And the store says when it cannot answer.** It keeps the newest 5000 events
of each kind — the same cap the API has always had — and a window that reaches
back past what it kept is a window it cannot answer, so the caller asks the
disk. A shorter answer than the disk holds would be a truncation nobody can
see.

**The startup window is real, and the kernel closes it.** The stream only
carries what happens *after* a subscriber connects — a supervisor that
starts while the agent is already blocked would never see that `recv`'s
`enter` frame, because it was written before the supervisor was listening.
So the supervisor asks the kernel once at startup which call is still open
(and when it opened). The kernel can answer because it wrote those frames:
it knows which `enter` frames still have no partner. (It used to read the
process's log to find out — the same answer, at O(bytes) instead of
O(processes). See "the kernel knows it" below.)

**The kernel knows it, so the host does not rebuild it.** "Which call is this
process inside, and for how long?" is a fact the kernel *has*: it writes
every syscall as an `enter` frame and its partner, and it knows which pairs
are still open. The host's alternative was to read the whole log and pair the
frames itself — the same answer, kept twice, at O(bytes) for a fact the
kernel has in O(processes). The log of a long-lived agent grows for as long
as the agent runs, so a view that reads it on every invocation gets slower
exactly as the operator needs it most.

So the kernel answers: `Kernel.openCalls()` on the host side, `openCalls` on
the transport. The entry is set when the `enter` frame is written and cleared
when its partner is, and the `since` it reports is **that frame's own
timestamp** — so the kernel's answer and the log's answer are the same
number, not two numbers that happen to be close. The call's arguments travel
with it, because the arguments are what say a `wait` carries its own
deadline: a declared wait is not a stall, and a supervisor that cannot see
the deadline kills a planner for keeping its word. (An earlier version of
this dropped the arguments, and the bounded `wait` was promptly called a
stall — the same answer, minus the part that made it an answer.)

**The pairing is by call id, because a process can be inside two calls.** A
process is normally inside one syscall at a time, but nothing forbids an
agent from awaiting two: `Promise.all([ctx.sleep(1000), ctx.recv()])`. The
second call reaches the dispatcher before the first has parked the process,
so both are admitted — and the second then traps, because by then the
process is no longer RUNNING. A bookkeeping that kept **one slot per
process** would close the first call's slot when the second call closed, and
report "nothing" for a process that is demonstrably still inside its sleep.
So the kernel's map is keyed by call id, exactly like the log's pairing, and
when several calls are open the **most recently opened** one is reported —
the same choice the log's reader makes, because two readings of one fact
have to make the same choice or they are two facts.

**A process that is gone is not inside anything.** A dead process's log
keeps the `enter` frame of the call it was killed in, and reading that as
"still inside that call" is a lie. So the kernel does not report a process
it no longer holds, and the view applies the same liveness filter to both
readings — one rule, two paths.

`cortex top` and `cortex supervise` now ask the kernel first, and fall back
to the log only when there is no kernel to ask, or when the kernel is too old
to know the command. Measured against a live kernel with a 13 MB log: the log
path took 273–283 ms per view, the kernel path 0–1 ms, and the two reported
the *same* `since` to the millisecond.

**A kernel that cannot be asked is not a kernel with nothing to say.** The two
answers have to stay distinct. "The kernel has no open calls" is a fact; "the
kernel is too old to know the command" is a different one, and answering the
second with the first would make a view quietly report that nothing is
stuck. So the reader returns nothing at all when it cannot ask, and the
caller falls back to the log.

**And `cortex ps` says it too — as a noun, not a sentence.** The flat table had
the state and nothing else: `blocked`, with no word about *what* the process
was blocked on; and `running` for an agent four minutes into a model call,
which is a fact about the scheduler and not about the agent. The table now has
a **NOTE** column, and it says "a channel", "child 5", "a model call".

Two decisions make it fit rather than crowd the table:

- **The column is last.** The existing seven columns keep their order, so a
  script that reads `cortex ps` by field still reads the field it read before.
  (Their *widths* are now sized to the data — see "the table keeps its shape"
  below — so a script that counted characters would have to count again. The
  fields themselves, and the two spaces that separate them, are the same.)
- **The cell is a noun; the duration is `top`'s job.** `ps` says "a channel",
  `top` says "waiting on a channel for 44.4s". The two are deliberately
  different in shape because they answer different questions — *what* is it
  waiting on, and *how long* has it been waiting. (The age column is coarse
  on purpose too: "4m" is enough for an age, and "44s" and "4m" are
  different answers to "should I kill this?".)

The wording is the wording `cortex top` and the dashboard use
(`describeWait` / `describeBlocked`, in `src/cli/open_call.ts`), so a table
cell and a tree line cannot drift apart. And the *rule for which source
answers* is shared too: the kernel's blocked reason wins when it has one — it
knows *which* child — and the open call is used otherwise, which is how a
driver call shows up at all, since the kernel does not park a process while
its model call is in flight.

**And the column says how a process ended.** A finished run and a crashed one
read as the same word — `zombie` — in the table an operator reads first, so
"did it finish, or did it crash?" needed a second command to answer, and the
answer was in the row the whole time: `ProcessRow` has carried `exitCode` and
`exitReason` from the start. The NOTE column says it now — `exit 1 (boom)` —
and the column was **renamed** from `WAITING` because it stopped being only
about waiting: a process that has ended is not waiting for anything.

The wording is one function (`describeOutcome`, in
`src/cli/process_outcome.ts`), so `cortex top`, `cortex ps` and the
dashboard cannot drift apart — and an unknown code still prints as `?`,
because `?` is a question and `0` would be an answer the kernel never gave.

**And the column says when the budget is gone.** A process whose ceiling has
been reached cannot go on, and nothing else in the row said so: a `ready` row
that will never run again looked exactly like one that was merely waiting.
The wall clock runs on the kernel's heartbeat (PROCESS.md §8.3), so a parked
agent can run out of wall time while it waits — and now the column names the
budget that ran out: `out of tokens`, `out of usd`, `out of wallTime`. The
words are the `BudgetKind` vocabulary, the same one a `__sched:sigxcpu(...)`
frame carries, and the wording is one function (`describeBudget`, in
`src/cli/process_budget.ts`).

**And the order of the facts is the same everywhere.** One cell, one order:
the ending first (a dead process is not waiting for anything), then the
budget, then what it is waiting on. `cortex ps`, `cortex top` and the
dashboard's page all use it (`processNote`, in `src/cli/process_note.ts`), so a
table, a tree and a page cannot disagree about which fact comes first.

**And the age column says how long a process lived.** A running process is
aging, so its age is the time since it started. A finished process is not
aging: it lived for a while and then it was over, and the kernel recorded
how long that was. The column used to keep counting from the start, so a
process that died 41 seconds in read as `7100.0h` the next day — a number
about the record, not about the process. A finished process now shows its
lifetime (`processAge`, in `src/cli/process_view.ts`); a record written
before the kernel charged the wall clock carries no lifetime and falls back
to the age.

**And the other two views say it too.** That rule was real, and it lived in
one view. `cortex top`'s tree said what a process was *doing* and never how
long it had been doing it, and the operator's window said the same: its
process table showed the **start time** and nothing else — and a start time
is not a duration. For a process that died an hour ago it says nothing at
all about how long it lived, and it keeps saying "yesterday" for as long as
the record is on disk.

So the number and the wording moved to one place (`processAge` and
`formatAge`, in `src/cli/process_view.ts`), and all three views read it:
`cortex ps` in its `AGE` column, `cortex top` in its own, and the dashboard's
process table in a **存活时长** column — beside the start time, because the
two are different facts and an operator wants both. The page is a static file
and cannot import the rule, so the server computes the label and hands it
down, the same way the token label and the budget label travel.

And the rule is the same rule everywhere, and it is the rule that makes the
number true: a **running** process is aging, so the number is the time since
it started; a **finished** one is not, so the number is the lifetime the
kernel recorded, and it stops growing there. One table shows both branches
at once — two finished processes at `2s` beside three running ones at `19s`,
and the finished ones do not creep up while the others do.

**And the table keeps its shape.** A table makes a promise: *the thing under
STATE is the state*. That promise was broken by the simplest thing there is —
`String(value).padEnd(width)`, which **does not cut**: a value longer than the
column simply ran on into the next one. And the values are not tame. A role is
whatever the operator typed, and a narrowed capability set is wider than any
sensible column:

```console
$ cortex ps
PID     PPID    ROLE          STATE         TOKENS    CAPS              AGE       WAITING
-----------------------------------------------------------------------------------------
2       1       researcher:deep-dive-agentzombie        15.0k     spawn,kill,fork,tool:dangerous,ipc:any7113.8h
```

Two fields had become one word — `researcher:deep-dive-agent` and `zombie`,
and the capability list and the age — and the reader had to count characters
to find out what they were looking at. (`cortex top` had the same fault, and
one more: its state column was ten characters wide, and `checkpointing` is
thirteen.)

So the three tables — `cortex trace` (and `attach`/`watch`), `cortex ps` and
`cortex top` — now share one shape (`src/cli/table.ts`), and the shape has
three rules:

- **A column is as wide as the widest value in this table**, up to a stated
  maximum — so the table is compact when the data is compact, and wide enough
  to say everything when the data is wide. The maximum is derived from the
  value domain wherever that domain is knowable (the process states, the
  capability vocabulary, the token format) and is a stated constant where it
  is not, because a role is the operator's own text.
- **A value that does not fit is cut, and marked** — `…` says "there was more
  here". Silently dropping the tail would be the same lie the table exists to
  avoid.
- **The heading and the rows come from one column list**, so they cannot
  drift apart, and the rule under the heading is generated from it too.

**And the two views stopped disagreeing about a number.** `cortex ps` had its
own token rule and `cortex top` had another: anything under a thousand
rounded up to `1.0k` in the table and was printed exactly in the tree. So 999
tokens read as `1.0k` in one view and `999` in the other — two views of one
process, and no way for the operator to tell which one was the truth. The
rule now lives in one place (`formatTokens`, in `src/token_usage.ts`), so both
views say `999`. (It used to sit in `src/cli/process_view.ts`, next to the
capability wording — until the dashboard needed the same rule, and a rule
the dashboard cannot import is a rule the dashboard will re-implement.)

**And a token count says which part of it was cached.** The kernel records
three token counters (STATE.md §2.4): the input, the output, and the part of
the input the provider served out of its cache. The cached part is **inside**
the input — the provider reports the whole prompt and says how much of it it
did not have to read again — so the total a process spent is
`tokensIn + tokensOut`, with the cached tokens counted **once**. And they are
worth saying out loud, because they are billed at the cache price rather than
the fresh one: a process that spent 1,000 tokens for a fifth of the usual
money was reading from the cache, and no view said so. The operator saw the
tokens and the dollars and could not make them add up.

So every view that shows tokens now says which part of them was cached —
`cortex ps` and `cortex top` print `1.2k (300 cached)`, `cortex limit` prints
`spent 1200 (300 cached)`, the dashboard prints the same cell plus a column of
its own — and the arithmetic and the wording live in one module
(`src/token_usage.ts`): the total, the cached part, the fresh part, and the
cell that puts them together. Each view supplies only **how it prints a
number** — the CLI shortens (`1.2k`), the dashboard spells it out (`1,234`) —
because the shape of the cell has to be the same in both, and the number
style is the view's to choose.

The same module is what the kernel charges the token ceiling with: the
ceiling is charged for the input and the output, with the cached part inside
the input and counted once. (Whether a cached token *should* be charged in
full is still open — BACKLOG #092.)

**And a spend says the ceiling it is measured against.** The kernel knows each
budget's ceiling — the total a process may ever spend — and the views that
showed the spend did not show it: `cortex ps` and `cortex top` printed `1.2k`
and `$0.000000`, and a spend on its own is 12% of one budget and 99% of
another. The two need very different answers, and the operator had no way to
tell which one they were looking at: the ceiling was visible only in
`cortex limit`, the report — which is not the view an operator watches.

So the ceiling stands beside the spend it is measured against: `1.2k (300
cached) of 10k`, `$0.000000 of $1.000000`, and `of ∞` for a budget that has no
ceiling at all. Every view that prints a spend prints it — `cortex ps`,
`cortex top`, the summary lines of `cortex spawn` and `cortex wrap`, and the
dashboard's process rows — and the rule lives in one place
(`src/cli/process_budget.ts`), so two views of one process cannot disagree
about what its budget was.

**And the window says a process's money, not a role's.** The dashboard showed
a process's **tokens** per process, and its **money** only in the budget
panel — and that panel rolls the money up **by role**. Three agents called
`coder` became one line with one number on it, so the operator could see
which agent spent the tokens and could **not** see which one spent the money.
The two numbers were about the same question and each answered a different
part of it.

So the money is in the process table now, beside the tokens, in the words
`cortex top` prints — `$0.000250 of $1.000000`, the spend and the ceiling it
is measured against — built by the same function (`formatUsdBudget`, in
`src/cli/process_budget.ts`). The budget panel keeps its roll-up, because
"where did the money go" is a different question from "how much did *this*
process cost", and the roll-up is the right answer to the first one.

The money's precision is not the page's to choose: six decimals is what a
microdollar count can say exactly (`src/money.ts`), so a cost printed at
another resolution would not add up to the spend beside it.

**And a call says what it spent, not just a process.** A process's spend is one
total; a **call's** is a pair — what the model read and what it wrote, and the
part of the input that came out of the provider's cache — and the price. The
kernel records all of it in the `llm_call` frame's result, in the ABI's `usage`
shape (ABI.md §4.3). The frame was there the whole time: the dashboard's event
table read it and said so, while `cortex trace` — the CLI's deepest view —
printed the syscall, the phase, the duration and the reversibility, and nothing
at all about what the call cost. The operator had to leave the trace to find
out what an agent's calls had cost.

So the trace has a last column now, `spend`, and it says the price first and
the tokens after it: `$0.000161 · 1.2k in / 80 out (900 cached)`. The order is
a rule, not a preference — a cell too wide for its column is cut from the end,
the tail is the cached count, and the price is not the thing to lose.

Two views of one frame cannot disagree about it, so both read it with the same
function (`callUsage`, in `src/token_usage.ts`) — and both say only what the
frame reported. A counter the frame did not report is **not** a counter of
zero: a frame that says how many tokens it read and nothing about how many it
wrote says `1.2k in`, not `1.2k in / 0 out`. And a frame that spent nothing at
all says nothing — an empty cell is honest, and `$0.000000` would be a claim
about a number nobody spent.

**And the window's own two views of a frame now say the same thing.** The
operator's window is not one view: it has the **event table** (every call the
agent made) and the **syscall timeline** (every frame, in order), and both
read the same `.crec`. The timeline read the usage with its own inline shape
— and that shape had no `cachedTokens` in it, so a call the provider served
out of its cache read as a call that was not. It also printed the tokens raw
(`1200` beside the event table's `1,200`), it dropped the price the server
had already sent it, and it printed `0 out` for a call that never reported
how many tokens it wrote.

So the server reads the frame with `callUsage` — the same function the CLI's
trace reads it with — and the page asks **one** helper (`callSummary`) for
the tokens, which both the event row and the timeline row use. Two views of
one frame inside one window cannot drift apart, and neither of them can drift
from the terminal.

**And the window says which calls can be undone.** The kernel tags every frame
with what it would take to undo it — `reversible`, `idempotent`,
`irreversible` (ABI.md §4.1) — and the tag is not decoration. It traps an
irreversible call inside a `forkable` region with `EREVERSIBLE`, it decides
how verbosely the frame is recorded, and it is what `cortex audit` reads to
surface the tools that never declared one. `cortex trace` prints it in a
column of its own.

The window dropped it. The event table said what was called, how long it took
and what it spent, and nothing about whether it could be taken back — so a
tool call that charged a credit card read exactly like a read, and the one
distinction an operator watching the window most needs was the one the window
threw away. The tag was in the frame the whole time; the view discarded it.

So the event table has a **可逆性** column now, between the duration and the
cost — the order `cortex trace` uses: how long it took, whether it can be
undone, what it spent. The word is the **recorded** one, because the recorded
one is the word the terminal prints and the word the kernel acts on. A frame
that carries no tag is *not reported*, not "reversible", and says so with the
same em dash every other cell in that table uses. The syscall timeline says it
too — the window's two views of one frame cannot disagree about what a frame
means.

The two sinks of the LangChain integration now answer the same question the
same way. The `.crec` frame carried the tag and the jsonl line did not — and
the dashboard's event table merges the two, so half of its rows could not say
whether they could be undone. The tag is decided **once**, where the event is
born (`reversibilityForEvent`, in `src/integrations/langchain.ts`), and
travels with it: the jsonl line, the `.crec` frame and the host's `onEvent`
callback all get the same word.

That rule is deliberately conservative. A callback knows only **that a tool
ran**, not what the tool did — so a tool call is `irreversible`. A read-only
tool would be `idempotent`, and the friendlier guess is the one tag nobody can
act on. A retrieval is a read, so it is `reversible`; everything else is
`idempotent`.

**And the two event shapes are made one.** The event table merges two
sources: the kernel's `.crec` frames and the LangChain callback log. They
arrived speaking different vocabularies — a kernel frame names a call's
counters `tokensIn` / `tokensOut` (the dashboard's names), a callback line
names them `inputTokens` / `outputTokens` (the integration's names, which
are the ABI's own). The page read one set, so the other half of the feed
said `—` about calls that had spent tokens: **the numbers were on disk, under
the other name.**

So the shapes are made one in the **server**, where the conversion lives
(`toCallbackEvent`, beside `toActivityEvent` in `src/dashboard/event_store.ts`),
and the page reads one set of names for a call's counters whichever log the
event came from. The `type` stays the callback's own (`llm.end`, `tool.end`) —
a callback event is not a syscall frame, and the row says which one it is —
and so does every other fact the line reported.

**And the two paths that answer the feed must answer it the same way.** The
feed is read once and then followed; a window that reaches past what the
store kept is answered from the disk instead. Both read the callback log, so
both convert it — with the **same** function, so a line read into the store
and the same line read from the disk are one event and not two.

**And the window says what the agent knows.** The window could show what an
agent **did** — the event table, the syscall timeline — and nothing about what
it **knows**. For an agent the knowledge is the point: the event table says
what it called, and nothing said what it wrote down. The kernel had it all
along — every region, its entries, its write count, its ceiling, its access
mode and its peers — and the window had no way to ask for any of it.

So the process dialog has **two views of one process**: the syscall timeline
(what it did) and the memory panel (what it knows), one click apart. The panel
shows the regions — name, kind, backing, access, entries, writes, ceiling,
peers — in the same words `cortex memory` uses, because the words live in one
module (`src/cli/memory_view.ts`) and each view supplies only **how it prints
a number**. Click a region and the window shows what is in it: the keys, the
values, and when each was written.

The memory is fetched **on demand** — when the operator opens the panel, not
on every process-table refresh. A 250 ms refresh that asked every process for
its memory would turn one poll into N round trips to the kernel, and the
answer changes only when the agent writes something.

**A view that cannot ask says so.** Without a live kernel the panel says
plainly that it needs one, rather than showing an empty region: a region's
contents live in the kernel that owns it, and there is no on-disk copy to read
instead. The same limit `cortex memory` has — and the same rule: a view that
has no answer must not look like a view whose answer is "nothing".

**And the window says what the agent said.** The window could show what an
agent **did** — the event table, the syscall timeline — and what it **knows** —
the memory panel. It could not show what it **said**, and that is the first
thing an operator reaches for when an agent is behaving strangely: the line
the agent printed is the evidence, and everything else is the story around it.

The lines were not missing — they were **kept**. The capture writes one
stamped line per printed line into `processes/<pid>/output.log`, and
`cortex logs` reads them back, prints them live by push, and joins them to the
file with the byte offset. What was missing was a way to *ask* for them from
the window.

So the process dialog has **three views of one process** now: what it **did**
(the syscall timeline), what it **knows** (the memory panel), and what it
**said** (the output panel) — one click apart, and the same three facts
`cortex trace`, `cortex memory` and `cortex logs` answer in the terminal.

The panel is fed by a **disk read** (`GET /api/output/:pid?tail=N`), so it
answers for a process that has already exited and for one whose kernel is
gone — the same limit `cortex logs` has, and the same freedom. It needs no
live kernel, and it never pretends that a missing kernel means an empty
history: a process that printed nothing has no output log, and the panel says
that it printed nothing.

**The file is the truth, so the panel reads it.** The live path tells the page
*that* something was printed and *which* process printed it — not the line
itself — and the page re-reads the file. So the window and the log cannot end
up saying different things about the same line, and a line that was still
being written cannot reach the screen as half a line. The kernel relays every
printed line the moment it is printed, and the window used to drop those
events on the floor; now `/api/stream` carries an `output` frame naming the
pids that printed, and without a live kernel the window watches the file
instead.

**A panel that shows the end of a longer history says so.** The endpoint
answers with the lines *and* with how many there were, and the panel says
`共 12,000 行,这里显示最后 500 行`. A panel showing the last 500 lines of 12,000
must not look like a process that printed 500 lines — the same rule as
everywhere else here: a view that is showing part of the truth must say that
it is.

**The separator belongs to the format, not to the text.** A captured line is
`<at> | <stream> | <text>`, and the format and its inverse live together
(`formatOutputEntry` and `parseOutputEntry`, in `src/cli/process_store.ts`),
so a line the writer wrote is a line a reader can take apart — and every
reader takes it apart the same way. Only the **first two** separators are
separators: the text may hold the separator itself, and everything after them
is the line. A line that is not in the format is not a captured line, and
says so by being absent — a reader must not invent a timestamp for it.

**And the window says what a checkpoint holds.** A `.csnap` was the one thing
in this system you could **restore** but never **look at**. The dashboard's
checkpoint panel listed them by pid, time and size and offered a **恢复**
button — you could press it, but not see what you were about to restore. And
`cortex restore` re-materialised a process without ever naming what it had
brought back.

So the snapshot describes itself. The panel's chain cell is a door: click it
and the window says who the snapshot was of, when it was taken, which chain it
belongs to and which one came before it, how long the agent's conversation had
been, which tool call it was still waiting on, the memory it carried entry by
entry, what it had spent **next to the ceiling that spend was measured
against**, and the byte in the syscall log it was cut at. The terminal asks
the same question — `cortex checkpoint --inspect <chainId>` — and the two
answer it from one module (`src/cli/checkpoint_view.ts`), so a snapshot
cannot look like two different things in two places.

**The reader is one, and it is the kernel's.** The kernel's `load()` resolves
a chain id to a path and reads it; the window already knows a path. Both must
apply the **same** checks — the file magic, the body version and the SHA-256
signature — or the window could describe a body the kernel would refuse to
restore, which would be showing the operator something untrue. So the reading
lives in one place (`readCheckpointFile`, in `src/kernel/checkpoint.ts`) and
both callers use it. A file that is not a checkpoint is not described as one:
it is refused, with the same `EINVAL` the kernel would have given.

**The conversation is counted, not quoted.** A snapshot carries the agent's
messages — the prompts and the model answers — and the dashboard does not
return those; the same rule that keeps them out of the event table keeps them
out of here. What the view says is how *long* the conversation was. The
agent's own **intent** is state rather than conversation (STATE.md §2.2), and
the memory panel already shows agent-authored text, so the intent is said.

**And a snapshot that does not say what was left does not say "unlimited".**
The two are different facts, so the ceiling is `—` when the envelope was not
recorded and `∞` when the budget really had no ceiling. The same rule the
budget views follow, for the same reason: *not reported* is not the same
answer as *no limit*.

**And the reader was throwing away half of every budget.** The snapshot
records **both** the spend and what was left of the ceiling — and the reader
dropped the second one on the way in. So every restored process woke up with
the *default* envelope: an agent capped at 1,000 tokens came back
**unlimited**, silently, and nothing said so. The code said it meant to keep
it ("set spent + remaining directly … a `tokens: 1000` agent would wake up
unlimited"), and the reader took the branch that comment was about away from
it. The envelope is now read back, and a restored process keeps the ceiling
it was given. A snapshot written before the field existed carries no envelope
and behaves exactly as it did before — the fallback is the old one, not a new
silence.

**And a unit has exactly one conversion point.** `budgetsSpent.usdSpent` is in
**microdollars** — an integer count, 1 USD = 1_000_000 (STATE.md §2.4). Three
places disagreed about that, and two of them were wrong by a factor of a
million. The dashboard's budget panel added the raw counters up and printed
them as dollars, so a process that had spent **$0.0034** was shown in the
operator's window as having spent **$3400.0000** — while `cortex top`, reading
the same record, said `$0.0034`. In the other direction, `cortex wrap --tap`
folded the tap's spend into the budget **without converting**: the tap prices
its calls in dollars, the budget counts microdollars, and the two were added
together. `meta.json` ended up holding `0.00005325` — a *fraction*, in a
field the state model defines as an integer count — where it meant `53`. Every
other view then read a run that had spent money as a run that had spent
nothing: `cortex limit` printed `usd: spent $0.000000`.

So the conversion lives in one module (`src/money.ts`:
`usdToDollars` / `dollarsToMicrodollars`), and the dashboard does not do it at
all: the server converts once and hands the page `usdSpentDollars`, so the page
is never in a position to get the scale wrong. A view that reads a raw
microdollar counter and prints it next to a dollar sign is not a formatting
choice — it is a number about money, and it has to be the same number
everywhere it appears.

**And a unit has exactly one format too.** The scale was fixed; the
*precision* was not, and it cost the same thing. One model call costs about
**$0.000027**, and printed to four decimals that is `$0.0000` — so `cortex top`
said **$0.0000 spent** for a run that had spent real money, and the
dashboard's budget panel said `$0.0000` in the operator's window, while
`cortex limit` and the event row both said `$0.000027` from the same record.
Two views of one process's cost, one of them rounding the cost away.

The resolution is not a taste: **six decimals is what a microdollar count can
say exactly.** A cost that rounds away is not a small cost, it is no cost —
and a budget that reads as untouched is a budget nobody is watching.

So the format lives beside the conversion, in the same module
(`formatDollars`), and it is its own module rather than a CLI one because
three layers have to print money: the CLI, the fetch tap (its budget-exceeded
error), and the dashboard. A rule only the CLI layer can reach is a rule the
other two reinvent — and they did. The page itself cannot import it (it is a
static file served over HTTP), so it keeps its own copy of the rule and a
smoke check holds the two to the same string.

**A view that cannot ask does not go silent.** A kernel too old to know the
`openCalls` command must not turn the column into a row of blanks: a blank
says "nothing is being waited on", which is a claim, and it is false
whenever the log knows better. So the table falls back to the log — through
the *same* function `cortex top` uses, so the two views cannot end up
disagreeing about the same agent.

**And the window says what this system can call.** The dashboard could show
what an agent **did** and what it **knew** — and nothing about the system it
was running in: which tools existed, which model was driving it, and — the one
that bites — which of those tools never said whether they could be undone.

`cortex audit` answers that, and it always has. But it **boots a kernel of its
own** to do it, and the answer it gives is about *that* kernel: an MCP
server's tool list is pulled from the server when the driver registers, so the
surface of the kernel actually running the agents is not the surface of a
second one booted next to it. The terminal was right about its own kernel, and
the window had no answer at all.

So the kernel answers it. The transport grew a `drivers` command — a **read**,
like `ps` and `openCalls`, and like them not recorded: the operator *looking*
at the registry is not something the kernel did, so a window that polls it
every second must not grow init's causal history. The facts live in one module
(`src/cli/audit_view.ts`), because the terminal and the window ask the same
question of the same kernel and must not be able to disagree about it.

**And a defaulted tag is not a declared one.** An MCP server cannot declare
reversibility at all (ABI.md §5, §7.2), so the driver invents a tag — and the
invented one is `irreversible`, which is safe and **silent**: a tool nobody
declared refuses to run inside a `forkable()` region, and the operator finds
that out as a puzzling `EREVERSIBLE` days later. So the surface says which
tags were *invented* (`not-declared`), in the terminal and in the window, with
the same word.

And a tool the registry cannot resolve is neither declared nor undeclared: it
is `?`. "We cannot tell" is not "nobody said so", and it is certainly not
"irreversible" — the same rule every other view in this project follows, and
the same one the budget views follow when a snapshot does not record what was
left of its ceiling.

One thing the old wording got wrong: declaring a tag does not make a tool
**forkable**. An MCP driver is `forkable = false` whatever its tools are
tagged (STATE.md §8.6); declaring a tag makes the tool *allowed to run
inside* a `forkable()` region. The sentence now says that, because a sentence
that overstates what a knob does sends the operator to the wrong file.

The window says it plainly when it cannot answer: the tool list lives in the
registry of the kernel that owns it, there is no on-disk copy to read
instead, and an empty surface would look like a kernel with no tools at all.

**And the window stopped claiming what it had not checked.** The sidebar said
「本地节点已连接」 and 「ABI 1.0」 — in plain HTML, always, whether a kernel
was running or not, and whatever ABI that kernel actually spoke. Two panels
inside the same window said out loud that they could not answer without a
live kernel, and the chrome around them said the opposite. A window that
admits *"this one needs a kernel"* in one place and *"the node is connected"*
in another is a window the operator cannot calibrate.

So the chrome asks. The transport already had the question — `ping` — and the
probe already sent it and threw the answer away. The answer is **which** kernel
this is (its pid), **what** it speaks (its ABI), **how long** it has been up,
and **how many** daemons it supervises.

And the answer was itself wrong. `ping` reported `startedAt` as *the moment of
the ping*: it read the raw server options, where the value is usually absent,
and fell back to `new Date()`. So a kernel said it had started **just now**,
every time it was asked — and "how long has this kernel been up" came back as
`0ms` from a kernel that had been running for an hour. The endpoint
descriptor had the right instant all along; the ping did not. The start time
is now resolved **once**, when the server starts, and every command that
reports it reports the same instant.

And there are **three** states, not two: a kernel that answered, a workspace
with no kernel, and a kernel that is there and not answering. Merging the last
two would either claim a connection that is not there, or hide one that is —
and "the kernel died under my window" is the fact an operator needs most.

The uptime is printed with the **same** function the process table prints an
age with (`formatAge`): a duration that reads `2m` in one panel and `90000ms`
in another is two rules, and two rules drift. And an unreported fact is
`—`, never a zero: a window with no kernel to ask says `ABI —`, not `ABI
1.0.0`.

The terminal says the same thing. `cortex dashboard` used to print *"Watching
a live kernel"* — which does not say **which** one, and there is one kernel
per project directory (this section). It names the kernel now: its pid, its
ABI and how long it has been up, read from the same facts the window's
sidebar reads.

And the window's own directory is named. The sidebar claimed to show *"the
current working directory"* and showed the string `Cortex workspace` — a brand
name under a label that promises a path. It shows the directory the window is
actually reading now, and calls it what it is: the **state directory**.

**And the window's own light stopped claiming a connection it had not
checked.** The top bar's green dot said 「实时连接（SSE）」 — always, whatever was
behind it. There was no kernel at all: the stream that was open was following
the *directory*, not a kernel. The kernel had died under the window: the push
could not deliver another frame, and the sidebar — one screen over — had
already turned red and said 「内核失联」. And when a poll failed, the dot
**stayed red for good**: a window that cannot get back to green has stopped
saying anything about the connection at all.

So the bar asks, too. The server answers with what it checked: the kernel's
state, and how much to believe the numbers on the screen — `live` (a kernel is
behind them), `warn` (they are the disk's records), `dead` (the kernel is gone
and this is what the disk still has). The words come from one module
(`src/dashboard/connection_view.ts`), so the page — a static file that cannot
import the rule — prints what it is given, and the meaning cannot drift.

The one thing the server cannot check for itself is **how the window is
fetching**: a pushed stream or a poll. That is a fact about the *window*, so
the window says which it is doing when it asks.

And the push **ends** when the kernel goes away. A stream that stays open over
a dead socket delivers nothing and looks exactly like a healthy one; so the
dashboard listens for the connection ending, ends the stream, and the window
falls back to polling, asks the kernel again (it will not answer), and says out
loud that what it is showing is what the disk still has.

**And the window says what the supervisor did.** The kernel records every
supervisory decision in **init's own log** — the supervision journal
(PROCESS.md §9.1, ABI.md §6.1): a daemon was registered; an attempt died; the
supervisor started a new one; the supervisor gave up; the kernel booted; the
kernel shut down. Each of those is a `__init` frame, and each carries the
decision in its `action` and the details in its `args`.

And the window dropped **all** of it. The activity feed's rule was *"the
kernel's own `__`-prefixed frames are not the agent's work"* — which is right
for the per-process bookkeeping (`__state`, `__sched`, `__signal` restate what
a process's own row already says) and wrong for init's journal, which is a
record of **decisions**. So the operator's window showed a daemon crashing
three times and said nothing about the fact that the supervisor had restarted
it twice and then deliberately given up: the log said `__init:restart` and
`__init:restart-gave-up`, and the feed had no rows for either.

The rule is the sharper one now: the **bookkeeping** stays out, the **journal**
comes in. A decision the kernel made is a fact the operator is owed — "my
daemon keeps dying" and "my daemon was restarted twice and then abandoned" are
different situations, and only one of them is true.

The wording lives in one module (`src/cli/supervision_view.ts`), so the
terminal and the window cannot disagree about what the supervisor did, and a
check can hold them to the same sentence. And an action nobody knows is
**not** turned into a fact: guessing what a decision meant is how a view
starts lying.

**An installed daemon is not a running daemon.** `cortex daemon list` printed
the **spec** — name, role, restart policy, agent — read from `daemons.json`.
That file is the *install receipt*: it says the daemon was written down, and
nothing else. It reads exactly like the truth about the daemon, and it is
not. An operator who ran it could not tell whether the daemon was running,
whether it was flapping, whether the kernel had already given up on it, or
whether it was never started at all.

The kernel knows all of that. init holds each **logical** daemon: its
identity (the pid of its *first* attempt), the attempt running right now, how
many times it has been restarted, how the last attempt ended, and whether the
supervisor gave up — and the reason it gave up. None of it was on the way out.

So it goes out now, the way the kernel's other answers go out: as a **read**,
not a reconstruction. `Kernel.daemons()` on the host side, `daemons` on the
transport — like `ps`, `openCalls` and `drivers`, and like them a read that is
*not* recorded. The answer is O(daemons); replaying the supervision journal
would be O(bytes of log), and worse: a journal can only say what *happened*.
A daemon that was installed and never started leaves no trace in it at all,
and a daemon the kernel gave up on looks exactly like one that is merely
between attempts unless you replay the whole log and get the policy right.

**And the two lists finally have a join key.** The registry and the kernel
used to have nothing in common but the role — and a role is not an identity:
two daemons may share one and differ only by their module. So the kernel
*learns* the name: `DaemonSpec.name` (internal to init, so not an ABI
change), passed at registration by `cortex daemon run`, and carried in the
journal's records as well. The operator's own name for the daemon is what
the registry and the kernel are lined up on.

**No kernel to ask means the answer is unknown — not "not running".** A
daemon's live state belongs to the kernel that supervises it; without one
there is nothing to ask, so the view says *unknown* and says why. It does
not fall back to "not started", which is a different claim: it would say the
daemon was never started, when in fact nobody knows. (A live kernel that does
*not* have the daemon **is** a fact, and a different one — that daemon was
never started by that kernel.)

The wording lives in one module (`src/cli/daemon_view.ts`), so the terminal
and the window cannot disagree about a daemon that is flapping or dead — and
so a check can hold them to the same sentence.

**Two answers to one question, and nothing kept them in step.** The kernel
answers *"what is this daemon doing right now?"* as a read. It also keeps a
**journal**: every decision the supervisor ever made, in init's own log
(PROCESS.md §9.1). The read says **now**; the journal says **what was
decided**. Both are true and they answer different questions — but nothing
compared them, and one of them was not even complete.

The journal had a hole in it. It named two of the three ways a supervisor
gives up — *max restarts reached* and *restart storm* — and not the third:
the one the **policy** decides. A daemon whose policy said `never` left the
log with a `reap` frame and nothing else. The live state said *"gave up: the
restart policy says no"*, and the journal said *"not restarted"*: the kernel
knew a decision it could not read back.

So the give-up is recorded now, like the other two, and the two answers are
put side by side. `cortex daemon list` and the dashboard's **守护进程** panel
print the live state **and** the supervisor's last word about it — and when
the two do not match (the kernel remembers a give-up the journal never
recorded; the journal counts restarts the kernel does not; one side has never
heard of the daemon at all), they say so, in words, instead of leaving the
operator to find the difference by hand.

The join is on the daemon's **identity** — the pid of its *first* attempt,
which survives restarts — and on its **name** for a daemon the kernel is not
running, which is what the journal carries now. A daemon that the kernel is
not running gets no disagreement: the journal's decisions about it are
**history** (an earlier kernel's), not a conflict with a live state that does
not exist.

**The window used to forget what the operator asked for.** The event table is
a window onto the history, and the operator's request for it — *show me more,
further back* — is part of that window's state. A push **replaced** the table
with the newest page, and the 30-second poll did the same: so an operator who
clicked 加载更多 to read back through the history lost those pages the next
time the kernel said something. The rows on screen stayed true — they were the
newest ones — but the window silently dropped what had been asked for, and the
count under the table was only refreshed by the poll that dropped it.

Three things hold it together now, and they are one thing: **the window's
state belongs to the window.**

- The push carries the **rows and the count together** (`{"events": [...],
  "total": N, "totalExact": true|false}`), measured by the same reader the read
  endpoint uses — so `total` is the same number `GET /api/events` reports in
  `x-total-count`, and the number under the table is as fresh as the rows above
  it. When the server cannot count the window it was asked about, it says so
  (`total: null`) instead of sending a number it did not measure.
- **And the count says what it is.** The store keeps the newest events of each
  kind, and so do the disk readers, so a count of either can be a **lower
  bound** on the history rather than its size: measured on a real window over a
  real workspace, 6,000 events on the disk and 「共 5,000 条」 under the table —
  a claim about a history nobody had counted. Both readers know when they
  dropped something, so the answer carries that: `totalExact` in the push, the
  `x-total-exact` header in the read. The page words it accordingly — 「共 N 条」
  when the count is the whole of it, 「至少 N 条」 when it is only a lower bound —
  and the two paths always answer the same way, because the count and what it
  is travel together.
- The stream answers about the **window it was asked about**: it takes the
  same range the read takes. The read took a range and the push ignored it, so
  a window filtered to one hour was fed the whole history and the filter was a
  decoration.
- The page **merges** what the server sends into the window it is showing.
  The pushed page and the loaded window are two slices of one history, so the
  merged window is the pushed rows followed by the loaded rows the pushed page
  does not carry — nothing dropped, nothing shown twice, newest first. When
  the two do not meet — the server's page reached past everything the window
  holds, so the rows in between were never seen — the page asks again rather
  than show a gap it cannot see.

**And the window's timers die with the window.** An open event stream keeps
one repeating timer: the 15-second heartbeat that keeps the connection warm.
That timer belongs to the window, and when the window is gone — nobody left
to answer — it has to go with it.

It used not to. The stream handler **awaits the disk twice** before it
starts that heartbeat (once for the process table, once to seed the feed), and
a window that hung up in that gap left the handler running: it then started a
heartbeat for a connection that was already closed. Nothing would ever stop
that timer, so it kept the whole process alive — every run of the dashboard
hung at the end, and so did every run of the smoke that drove it.

So the close handler is armed **before the first await**, it is the one place
that ends the window, and it clears everything the handler owns: the
heartbeat, the feed timer, the process refresh, the output timer, the file
watcher, the kernel subscription. And no timer is created for a window that
is already closed.

**A parked process says it is parked.** A process that was checkpointed with
`--detach` is SUSPENDED (PROCESS.md §3.6): it is not running, not waiting,
and not stuck — it stopped *on purpose*, and the chain it was parked in is
what brings it back. The kernel knows the chain (it is in the process
record: `checkpointChain`), and **no view said so**: the table said
`suspended` and nothing else, so a process that stopped on purpose read
exactly like one whose agent died in the middle of a call.

So the row says it: `checkpointed — 'cortex restore --chain <id>' brings it
back`. The chain id is the kernel's own, and the command is the one that
actually works — a table that says "this one is parked" and then leaves the
operator to remember the syntax is only half a tool. The words are **one
function** (`describeCheckpointPark`), so the table, the tree and the
operator's window cannot say different things about the same parked process,
and the page prints the label it is given rather than writing a second
version of it.

A process whose chain the kernel did not report says only that it is
checkpointed: the command needs a chain id, and one that was not reported is
not invented.

**The breakdown classifies every process.** The window's 运行状态 panel says
「按进程状态分类」 — a classification — and named five states: running, ready,
blocked, stopped, zombie. A process in any *other* state was in the panel's
total and in **no row**: one parked at a checkpoint, one that had not run yet,
one on its way out. The rows added up to less than the number of processes, so
the panel claimed a classification it had not made — and `cortex top`, counting
the states it finds, said something different about the very same processes.

So the rule is one rule: the five states an operator watches always have a row,
and **every other state that is present gets one too** — which makes the rows
add up to the number of processes, *by construction*. The panel says so as
well (「各行之和即总数」), so the operator is not left to work out whether the
numbers are supposed to add up.

A state the page has no Chinese word for is printed as the **kernel words it**.
The kernel has nine states (`ProcessState`, PROCESS.md §10) and the page names
the ones an operator reads often; a state it does not know gets the kernel's
own name — not a made-up one, and not a dropped row.

**The wall clock's ceiling reaches the operator.** The token and money
ceilings stand beside their spend in every table. The wall clock's did not:
its ceiling was in `cortex limit` and nowhere else, so an agent with ten
minutes of wall clock looked exactly like an agent with all of it — and an
operator watching a row had no way to know that the agent they were watching
was about to be stopped.

It cannot be printed the way the other two are. Their spend is their spend;
the wall clock's spend is the process's **age**, and the age is a *different*
number: the clock is charged on the kernel's heartbeat and it **pauses**
while a process is stopped or parked (PROCESS.md §8.3), so a charged second
and a lived second are not the same second. A table that printed "4m of 10m"
beside an age of "4m03s" would invite a comparison the kernel does not make.

So the wall-clock budget says the two things it can say **exactly**: how much
is **left** of it, and how much there was — `wall time 9m58s left of 10m`.
Both numbers are the kernel's own (the remainder, and the ceiling computed
from it), and neither is a comparison with the age beside it. The remainder is
printed to the second and never rounded up, because a remainder that rounds
up to its ceiling reads as a budget that is still full when it is nearly
empty; and it says *left*, because a bare "of" would read as a spend, the way
the token and money cells read. A budget with no ceiling says nothing — there
is no limit to report — and an exhausted one says the cause instead ("out of
wallTime"), which is the kernel's own word for it.

The wording is **one function** (`describeBudget`, in
`src/cli/process_budget.ts`), so `cortex ps`, `cortex top` and the dashboard's
row cannot say different things about the same budget, and the page prints the
label it is given. The durations are one rule too (`src/duration.ts`, next to
`src/money.ts`): an **age** is rounded ("3m" for "how long has this been
running"), and a **remainder** is not — a remainder is a number the operator
acts on, and rounding it turns "9m58s left" into "10m left".

**And the tree says the same note the table says.** The window has two views
of the process table — 表格 and 监督树 — and the tree used to build its note
from its own list of facts, which was missing one: the park. A process
stopped at a checkpoint read `suspended` in the table and `suspended` in the
tree, and only the table said it was parked and handed over the command that
brings it back. The two views now build the note with **one function**
(`processDetail`, on the page), in the order `cortex ps` prints: how it
ended, then the budget, then the park, then what it is waiting on.

**The number next to the table describes the table.** The process panel's title
reads 「Agent 进程 (4)」 — the workspace's process count — while the rows under
it were the **filtered** ones. One panel, two numbers for one thing,
disagreeing: an operator who typed into 「筛选进程…」 and was left with one row
could not tell whether the other three were filtered out or the count was
simply wrong.

So the number is the table's: **(1 / 4)** while a filter is narrowing the list,
**(4)** when it is not. One rule either way — the first number is what the table
shows, the second is what the workspace holds, so the workspace's size never
leaves the screen. The numbers that are about the *workspace* say so: the
metric card's foot reads 「当前工作区记录」, and the 运行状态 panel's total is the
workspace's processes, with its rows adding up to that total (above).

**And the two views filter by the same rule.** The panel has two views — 表格
and 监督树 — and each had **its own copy** of "does this process match what the
operator typed". The tree's copy was missing two of the columns: a process
holding one capability, and one parked at a checkpoint. The same filter box, in
the same panel, found a process in the table and said **没有匹配的进程** in the
tree. The rule is one function now (`processMatches`, on the page), and the tree
is built from it.

The tree says what it shows, because of that rule: the processes that match
**and the path they hang under** — a child that matches is shown with its
parents, because a tree that drops the parent is not a tree — and the node that
matched is marked, so the operator can tell it from the parents that are only
there as its path. It used to render the **whole subtree** of anything that
matched, so a filter that found one process showed the operator the unfiltered
workspace.

**A queued signal is not a delivered signal.** `SIGTERM`'s default action is
"terminate", but the queuing rule (PROCESS.md §7.2) means a signal aimed at
a process that is *not running* sits in its pending queue until it wakes up
— and a process stuck in a `recv` with no timeout may never wake. The kernel
says what it did with the signal (the `__signal` record's `outcome` is
`queued`), and the supervisor reads that off the stream: there is nothing to
wait for, so it escalates to `SIGKILL` at once instead of burning the grace
period. The alternative — waiting out a grace period for a signal that will
never be seen — is how a supervisor ends up waiting on a corpse.

**And the queue is on the row.** The kernel owns the pending queue and sends
it in every process record it hands out — and the views used to drop it, so
`cortex ps` printed the *same row* before and after a `cortex kill` on a
wedged agent. The operator asked a process to die; the process list said
nothing about it; and the only place that mentioned the signal was the
command that had just run. A fact the kernel is holding, in a queue, on the
behalf of an operator who is waiting to see it — and no view of it.

So the queued signals are part of what a view says about a process, in the
kernel's own word:

```console
$ cortex ps
2       1       blocker       blocked       0         all               31s       a channel — SIGTERM queued
```

`cortex ps` puts it in the NOTE column, `cortex top` in its NOTE, and the
dashboard in the column it keeps for "where this process is". The wording
comes from one function (`describePendingSignals`, in
`src/cli/process_view.ts`), because a table, a tree and a page that each
phrased it for themselves would be three rules — and three rules drift.

**And the rank a process runs at is on the row.** The kernel's `ProcessInfo`
carries a process's **`nice`** — -20..19, lower runs first — and the
scheduler honours it: among the READY processes it dispatches the lowest
`nice` first (PROCESS.md §8.1). So `nice` decides **which of the operator's
agents runs first**, and when two of them compete, the one with the lower
`nice` wins every time and the other can be starved.

**No view said so.** Measured on a live kernel: two agents at `-7` and `5`,
and their rows in `cortex ps` differed in **nothing but their names**. The
transport sent the number in every process record — `nice=-7` was in the
JSON the client received — and the table dropped it. The tree said nothing
either, and the dashboard's process list had no `nice` key at all.

So the priority is a **column**, and it is the same column everywhere:

```console
$ cortex ps
PID  PPID  ROLE      STATE    TOKENS  CAPS  AGE    NOTE       NICE
-------------------------------------------------------------------
2    1     greedy    blocked  0 of ∞  all   425ms  a channel  -7
3    1     polite    blocked  0 of ∞  all   423ms  a channel  5
```

`cortex ps` and `cortex top` print it at the **end** of the table — the
columns keep the positions they have had since #070, and a new fact goes
at the end, never in the middle of them — and the window prints 优先级 on
the row and on the tree node. All of them read the number through **one
function** (`formatNice`, in `src/cli/process_view.ts`), and the window's
label is computed by the **server**, so a table, a tree and a page cannot
say different things about how a process is ranked.

A priority that was **not recorded** says so — `-` in the table, `—` in the
window — and is never shown as `0`: the default is the one number that
hides the problem, and a view that turns an absence into a number claims a
ranking it never read.

**The record keeps it.** The kernel's exit record (`PersistedProcessMeta`)
carries the rank the process ran at, so a finished agent's row says it too:
an agent that never got a turn and one that ran first leave the same
syscall log, and only the record says which one the scheduler would have
picked. The field is optional and additive — the same treatment
`capabilities` got when it was added to that record — so the **ABI did not
move**: no syscall, no argument, no errno, no `ProcessInfo` field, no
`.crec`/`.csnap` format.

**And there is a knob.** `cortex spawn --nice <n>` and `cortex daemon
install --nice <n>`, both refused outside the kernel's own range (-20..19)
rather than handed to a kernel that would have accepted them and ranked the
process against numbers it never promised. `--nice -7` works in the spaced
spelling too: Node's argument parser reads a value that starts with a dash
as another option, and the priority is negative more often than not.

The number the command prints is **read back from the process table**: it
reports what the kernel did, not what it intended. A spawn that asked for
`-7` and got `0` says `nice: 0`.

**A stream needs an ending.** A subscriber is watching something that can
leave. The kernel can be stopped, and it can crash — and when it does, the
socket closes and the stream stops without saying a word. That silence is
the dangerous kind: a `watch` that ends because its kernel died looks exactly
like a watch that finished, and a supervisor that keeps waiting on a dead socket
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

**And `cortex attach` stopped polling.** The last poller in the CLI. It
followed the process's `.crec` **file**: it re-read the whole file every
250 ms and printed whatever was new, so a frame arrived up to a poll interval
after the kernel wrote it, and a long-running agent's log was read over and
over (a 135 KB log cost 540 KB/s of pointless reads). The transport carries
streams now, so when there is a live kernel that still holds the process, the
frames come by push instead — measured on the same live agent, the median
lag fell from **204 ms to 1 ms**.

The history still comes from the file (the kernel's stream only carries what
happens from now on), and the two are stitched by the frame's `byteOffset`:
a frame the history already showed is not printed twice, and a frame written
while the history was being read is *held* and printed after it. The
subscription opens **before** the history is read, so nothing is lost in
between.

**And the follow ended by itself.** Following a process's log was a
*tailing* operation: it ended when the operator detached. But the kernel knows
when a process ends, and says how — the same `process-exit` event `cortex
watch` prints, with the real exit code. So `cortex attach <pid>` now ends
when the agent ends:

```console
$ cortex attach 5 --follow
# attach .cortex/processes/5/log.crec (live — frames by push from the kernel)
time          pid     syscall                              phase  duration   reversibility
------------------------------------------------------------------------------------------
22:04:08.838  5       __signal:SIGTERM(delivered)          exit   -          idempotent
# pid 5 exited with code 143 (signal:SIGTERM)
# detached
```

That is the difference between *"I saw it finish"* and *"I stopped looking"*.
And the other ending is reported too: when the kernel goes away mid-follow,
the follow did not finish — the process's fate is unknown — and the command
exits 1, like `cortex watch` and `cortex supervise` do.

Without a live kernel — or for a process the kernel does not hold, because it
exited or another kernel owns it — the file path is used, exactly as before.
The header says which one is running, because "it is following something" and
"it is following something *now*" are different promises.

**And `cortex logs --follow` stopped polling.** The last poller left. It
followed a process's printed output the way it had always been followed: by
re-reading `output.log` every 250 ms and printing whatever was new — so a line
showed up a quarter of a second after the agent printed it, and the operator
could not tell "the agent is quiet" from "the follower has not looked yet".

The lines come by push now, over the same transport stream `cortex attach`
uses. The kernel still does not know what a process *said* — it never will;
it relays what the host hands it, in the same shape as a record event, and the
host is the one that knows how to read a stream. Measured on the same live
agent, the median lag fell from **217 ms to 1 ms**.

The file and the stream are stitched the way `cortex attach` stitches them:
the subscription opens **before** the history is read, and the lines are
joined by their byte offset in `output.log` — a line the file already showed
is not shown twice, and a line printed while the history was being read is
printed once, from the stream.

And the follow ends with the process, because the kernel says when a process
ends and how it ended:

```console
$ cortex logs 7 --follow
# following pid 7 (live — lines by push from the kernel)
2026-10-23T23:40:44.314Z | out | patient line 0
2026-10-23T23:40:44.714Z | out | patient line 1
...
# pid 7 exited with code 5 (the printing is done)
```

Nothing about that ending is guessed. The follower is told the process is
over because the kernel saw it happen, and it reports the real exit code.

When there is nothing to push from, the file path is used — and the command
**says which one is running and why**: no live kernel, a kernel that is not
answering, or a kernel that no longer holds this process. A follower that
quietly changed its behaviour would be one the operator could not trust, and
"the lines still arrive" is exactly the kind of half-truth this project keeps
fighting.

The probe that decides is **bounded**: a kernel that accepts the connection
and then never answers is reported as unreachable, instead of hanging the
command that asked. A liveness check that can hang is not a liveness check.

**And the supervisor stopped waking up for nothing.** `cortex supervise` was
built on the stream, but its *decisions* were still made on a timer: it woke
every 250 ms to ask itself whether anything had changed. So a process that
ended at 10:00:00.100 was reported at 10:00:00.310, a stall threshold was
crossed up to a quarter of a second late, and a supervisor watching a quiet
agent for an hour woke it fourteen thousand times to find nothing.

The supervisor now sleeps until something can matter: an event from the
kernel, an interrupt, the kernel going away, or the **next deadline** — the
stall threshold, the terminate grace, the operator's `--timeout-ms`. The
deadline rule is one function (`nextDeadline`), and a **declared wait has no
deadline at all**: an agent that said it would be back in an hour is not
something to wake up for, and a `sleep` is not a stall. The rule that decides
what counts as a stall lives in one place (`isDeclaredWait`) and is shared with
`cortex top` — the view and the killer cannot disagree about what a hang is.

Measured on a live kernel, with the clock started at the kernel's own
`process-exit` event and stopped when the supervisor's line reached the
terminal:

| | reaction after the kernel said so |
|---|---|
| the old 250 ms tick | 106 ms / 156 ms / 261 ms |
| event-driven | **0 ms / 0 ms / 0 ms** |

**And it cannot miss an ending.** The subscription opens **before** the state
check, so a process that ends while the supervisor is still starting up has
its ending already in hand — the same rule `cortex attach` and `cortex logs`
follow. And a process that is *already* over is reported as over: a zombie
whose parent is still alive is still in the kernel's table, and the supervisor
reads the ending out of it instead of waiting for a `process-exit` event that
has been and gone. (Before this, that case waited forever — the supervisor
had no way to learn that the ending it was waiting for had already happened.)

**And the replacement was the same agent.** `cortex supervise --restart` puts a
fresh agent in a dead one's place, rebuilt from the spec that was persisted
when it was born (`processes/<pid>/spec.json`). That spec carried the role,
the module and the memory policies — but not the **authority**. And a spawn
that says nothing about capabilities means *fully privileged* (ABI §4.9), so
the replacement was born with everything the original had been carefully
denied. Measured, on a live kernel, with an agent restricted to `spawn`:

```
original:   I am pid 3 and I hold [spawn]
replacement: I am pid 4 and I hold [spawn,kill,fork,tool:dangerous,ipc:any,admin]
```

Nothing said so. The supervisor printed `# restarted as pid 4 (role=limited)`
and the agent had quietly become an administrator. "The same agent, restarted"
had become "a stronger agent".

Two records carry the authority now, and they are not the same kind of record:

- The **spec** is the host's *recipe* — what the process was **born** with:
  its capability set, the pool it may escalate from, and its budget ceiling.
  It records `null` for "unnarrowed" rather than flattening that into the
  full list, because the two are not the same process: an unnarrowed process
  can `release()` a capability and `acquire()` it back, and one holding an
  explicit set cannot (ABI §4.9). A replacement that only *looks* the same is
  not the same agent.
- The **exit record** (`processes/<pid>/meta.json`) is the **kernel's own
  fact** — what the process held when it died. `PersistedProcessMeta` is
  documented as the subset of `ProcessInfo` the kernel persists, and
  `capabilities` was missing from it: a process that ran with no capabilities
  and one that ran with all of them left exactly the same files.

The supervisor's rule is to ask the recipe first and the kernel's fact second:
replay the spec; if the spec is too old to say (written by a build that did
not record capabilities), ask the exit record; and if neither can say, take
the documented default — full privilege, because that is what a process whose
spawner said nothing holds — **and say so**. The assumption is printed, in
the place the operator is already looking:

```console
$ cortex supervise 14 --restart
# the spec of pid 14 does not record what it was allowed to do, and it has no exit record that says either
#   the replacement holds every capability — the documented default for an agent whose spawner said nothing (docs/ABI.md §4.9).
#   if that is more than the original had: 'cortex supervise 14 --restart --restart-as none'
# restarted as pid 15 (role=limited, caps=every capability (assumed — nothing could say what the original held))
```

`--restart-as same|full|none` is the operator's own lever on that last step:
`same` (the default) replays what the original held, `full` and `none` say
it out loud. And `cortex ps` grew a **CAPS** column, because the question
"what was this agent allowed to do?" used to have no answer in the CLI at
all — a process that ran with no capabilities and one that ran with all of
them looked identical from the outside.

**And now the recording can be run again.** `cortex replay <pid>` re-runs a
recorded agent with the world frozen — the model's answers, the tool results,
the clock and the RNG all come from the recording — and then compares what
happened with what was recorded:

```console
$ cortex replay 7
replaying pid 7 (role: coder) from .cortex/processes/7/log.crec
  mode: strict
  recording: 2 process(es) — pid 7, pid 8
  replay home: .cortex/replays/7-1792814566250

  pid 7: recording 23 call(s), replay 23 call(s)
  pid 8: recording 4 call(s), replay 4 call(s)

  REPRODUCED — every process made the same calls, in the same order,
  with the same outcomes.
  replay home: .cortex/replays/7-1792814566250
```

And when the agent's code has changed since, it says **where**:

```console
$ cortex replay 7
  ...
  DIVERGED — pid 8 did not reproduce the recording.
#3 changed
    the request differs at request.messages[1].content
      recorded: "summarise the diff"
      replay:   "summarise the log"
  replay log: .cortex/replays/7-1792814612296/processes/8/log.crec
```

**A run is a tree, and the replay replays the tree.** The example above has
two processes in it: a supervisor and the child it started. Each process has
its own recording, so each answers from **its own** history — and the report
names the process that diverged, not just the run. A single shared source
would let the child consume the parent's recorded model calls: the child would
be handed the parent's answer, the parent would then find its own recording
empty, and the replay would "work" and be wrong.

Two things make that work, and both were found by running it rather than by
reading it:

- **The replayed process holds the authority the original held.** The spec
  says `capabilities: null` (unnarrowed — it holds everything) and
  `grantable: []`. Passing the `grantable` on its own says "it holds
  nothing", and the kernel reads that as *exactly* nothing: the first
  capability-gated syscall — a supervisor's `spawn` — traps `EPERM`, and the
  replayed tree never gets off the ground. The replacement must be the same
  process, not a weaker one (ABI.md §4.9). So the replay passes `capabilities`
  and `grantable` **together or not at all**.
- **The tree is found in the logs.** Nothing on disk records the shape of a
  run except the recordings themselves: a `spawn` names its child in `pid`, a
  `fork` names it in `childPid`. The replay walks those links from the root
  and loads each process's own recording (§4.12).

Three things make this a real answer rather than a demo.

**The replay does not need the model provider the original run used.** The
recording *is* the answer, so a run recorded against one provider can be
replayed on a machine that has never heard of that provider's API key. That
is the difference between a recording that is merely archived and one that is
usable.

**The replay does not repeat a side effect.** A tool that already ran is not
run again: the recorded result is served. A replay shows what the agent
*would* do now, not what the world *would* answer now — and it says so.

**A replay that cannot answer says so.** `strict` is the default mode, and in
it a call the recording does not have is an error (`ERECORD`), not a silent
fall-through to the live world: a replay that quietly goes live looks like a
faithful reproduction and is not one. `cached` and `live` are there when the
operator wants the other behaviour.

The replay runs in a directory of its own (`<cortex home>/replays/<pid>-<n>`),
because the recording is its *input* and must not be written over, and it is
given the **same pid** as the original run, so the replay is the same run and
not a similar one — the children get the same pids too, and a pid that
differs is a real difference in the shape of the run. The comparison itself is
`src/cli/replay_core.ts`: the unit is a *call* (a request and its outcome
together), and the comparison is positional, because a replay that inserted
one extra call has already diverged — and the divergence is *there*.

**Every process is compared on its own.** The tree is compared process by
process, and each process's own log is compared with its own replay log. Four
kinds of difference are noise rather than behaviour, and are ignored: a
freshly minted identity (`chainId`), a position in a byte stream (`syscallLogOffset`,
`syscallLogRange`), the size of an opaque blob (`byteSize`), and the replay's
own wall clock (`reapedAt`, `sentAt`, `wallTimeMs`). Everything else is
compared verbatim — including the tokens a child spent, which *are* behaviour.

The report has to know that list. Saying "the outcome differs at
`outcome.reapedAt`" about a field the comparison has already ruled out would
contradict the verdict it is reporting: the two runs agree there, and the
report would be telling the operator they do not.

**Known limits (v0).**

- **Watching is still not reacting — for a *host*.** The transport carries a
  stream, and `cortex supervise` reacts to it. But the reaction lives in the
  CLI, not in the kernel: nothing in the kernel *acts* on what a subscriber
  sees, and a subscriber that wants to kill a runaway agent still has to
  issue the `kill` itself. That is deliberate — an operator watching a
  kernel must not be able to change what the kernel does by watching it —
  but it means the supervisor is a program, not a kernel feature.
- **Without a live kernel, the open-call view is the log again.** `cortex top`
  and `cortex supervise` ask the kernel first, but a kernel that is not
  running (or is too old to know `openCalls`) leaves the log as the only
  source — and the log is O(bytes), not O(processes). A 13 MB log cost
  273–283 ms per view; the same view against the kernel cost 0–1 ms. So the
  cost of the operator's most frequent question still tracks the size of the
  agent's history when there is no kernel to ask.
- **A driver call parks the process, and the signal waits.** `llm_call` and
  `tool_call` move the process to BLOCKED with `blockedOn.kind` of `llm` or
  `tool` for the duration, then back to RUNNING when the driver returns
  (PROCESS.md §3.7). `cortex ps` therefore says `blocked`, not `running`.
  A signal that arrives during the call is still queued until that return:
  the request is already in flight. A default terminate on `recv` or `wait`
  is the other case — those waits can last forever, so it is delivered
  immediately (PROCESS.md §7.2).
- **The supervisor cannot see a hang that never made a syscall.** Its signal
  is "this process is inside one syscall, and has been for too long". A
  process that stops calling the kernel altogether — spinning in plain
  JavaScript, or parked on a promise — is invisible to it, because there is
  no frame to pair. The kernel is cooperative and does not preempt
  (PROCESS.md §8.2); nothing short of real isolation would catch that.
- **A process the kernel already reaped cannot be supervised after the
  fact.** The supervisor can report an ending that has *already happened* —
  but only when the kernel still holds the process. A process that ended
  normally is collected by the dispatcher as soon as it exits, and a process
  killed by a signal is reaped by init once its parent is init or is already
  gone; either way it leaves the table, and `cortex supervise <pid>` answers
  `no such process`. The exit status itself is not lost — the kernel keeps it
  for the *parent* to collect with `wait()` — but a host is not in the
  process tree and has no parent to be. So "supervise a process that already
  ended" works for the case the kernel still remembers (a zombie under a
  live parent) and not for the rest.
- `cortex attach` follows the `.crec` file on disk when there is no live
  kernel (which the daemon writes to), and takes the frames by push when
  there is one; `cortex logs --follow` has the same shape: it takes the
  printed lines by push when a live kernel holds the process, and reads
  `output.log` every 250 ms when it does not. The kernel does not interpret
  what a process said — it relays the lines the host hands it — so the host
  is the one that has to be there. Both work without a live kernel, which is
  why they keep that shape.
- `cortex logs --follow` does not *retry* the push. A kernel that fails a
  probe is treated as gone for the rest of the follow: the lines keep coming
  from the file, at a quarter of a second's delay, and the header says so.
  A follow that upgraded itself back to the live path mid-flight would need
  a second stitch — the file's offset and the stream's offset — and the
  value of the push path is that there is exactly one stitch.
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
- **A child cannot outrank its parent.** A parent that holds `admin`, and an
  unnarrowed parent, may still name any sets. A narrowed parent may only
  give a child capabilities it holds; omitting the sets inherits them, and
  naming a richer set is `EPERM` (ABI §4.9, since `1.2.0`). `fork` copies
  the parent's held and grantable sets. A checkpoint carries them; a
  snapshot written before the field existed restores unnarrowed.
  `cortex daemon install --cap` writes the same sets onto the `DaemonSpec`,
  and a restart allocates from that spec, so a daemon does not come back
  fully privileged. `cortex supervise --restart` still replays the spec it
  was given.
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
- **The tool surface needs the kernel too.** An MCP server's tool list is
  pulled from the server when the driver registers, so there is nothing on disk
  to read instead — and the window says so (a `409`) rather than showing an
  empty surface that would look like a kernel with no tools. `cortex audit` has
  no such limit because it boots a kernel of its own; what it cannot do is
  answer about *another* kernel's drivers, which is the whole reason the
  transport carries `drivers`.
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

**And the spec is resolved, not passed through.** `AgentSpec.module` is a
*path or an import specifier* (ABI §4.1), but the loader used to hand the
string straight to `import()`, which only understands import specifiers. On
POSIX a relative path happened to survive — Node resolves `./x.js` against
the importing module — and on Windows an absolute path did not:

```
Only URLs with a scheme in: file, data, and node are supported by the default
ESM loader. On Windows, absolute paths must be valid file:// URLs.
Received protocol 'f:'
```

So the CLI and the kernel disagreed, and the loser was the one the ABI
documents: `ctx.spawn({ role: 'child', agent: { module: './child.js' } })` —
the exact form in ABI §4.1 — gave a child that died with "agent load
failed", and on Windows a child it could not even name. The CLI took a path
(`cortex spawn --module ./x.js`); the kernel took a URL.

The rule now lives in one module (`src/module_spec.ts`), and every entry
point uses it — the kernel's default loader, the CLI's `--module` flag, and
the daemon registry that persists one:

1. **A URL is used as it is** — `file:`, `node:`, `data:`, `https:`.
2. **A path is resolved against the working directory** and becomes a
   `file://` URL. Something is a path when it *looks* like one (`./x`,
   `../x`, `/x`, `C:\x`) or when it names a file that is really there.
3. **Anything else is an import specifier** — a package name — and goes to
   `import()` untouched.

The working directory is the host's current directory when the kernel booted
(`KernelOptions.cwd` overrides it), so `./child.js` means the file next to
the caller rather than one next to the kernel's internals — an installed
package has no agent modules beside its own source. A rule only the CLI can
reach is a rule the kernel reinvents, and it did: in the shape of "hand the
string to `import()` and hope".

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
