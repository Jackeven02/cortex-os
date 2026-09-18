# Agent Process Lifecycle

> How a cortex process is born, how it lives, how it dies, and what the kernel does in between.

This document expands the lifecycle preview in [`STATE.md`](./STATE.md) §6 into a complete specification. STATE.md answers *"what is the state of an agent?"*; PROCESS.md answers *"how does that state change over time?"*.

Read STATE.md first.

---

## 1. Why this document exists

Every framework that runs "agents" has a lifecycle, even if it does not name one. LangChain has it (chain start → step → end). AutoGen has it (turn → reply → turn). Most of them are linear, single-shot, and unobservable from outside.

Cortex's lifecycle is **a state machine, defined here, observable from the kernel, controllable via signals.** It is closer to a POSIX process than to a chain runner. That decision buys us:

- Pause and resume across kernel restarts
- Supervision trees without bespoke glue code
- Fork semantics that mean something precise (see STATE.md §3)
- A `ps` command that actually works

It also costs us complexity. This document is the receipt.

---

## 2. The state machine

A cortex process is always in exactly one of eight states.

```
                        ┌──────────── spawn ─────────────┐
                        ↓                                │
                      [NEW]                              │
                        │ first schedule                 │
                        ↓                                │
            ┌────────[READY]←───────────┐                │
            │           │                │                │
   scheduler│           │dispatch         │wake            │
   preempts │           ↓                │                │
            │       [RUNNING]────────────┤                │
            │       │   │   │   │        │                │
            │ yield │   │   │   │exit/SIGTERM             │
            └───────┘   │   │   │        │                │
                        │   │   │        ↓                │
              blocks on │   │   │     [EXITING]           │
              external  │   │   │        │                │
                        │   │   │        │cleanup done    │
                        │   │   │        ↓                │
                        │   │   │     [ZOMBIE]            │
                        │   │   │        │                │
                        │   │   │        │reaped by       │
                        │   │   │        │parent.wait()   │
                        │   │   │        ↓                │
                        │   │   │      (gone)             │
                        │   │   │                         │
                        │   │   │SIGSTOP / SIGXCPU         │
                        │   │   ↓                         │
                        │   │ [STOPPED]                   │
                        │   │   │ SIGCONT                 │
                        │   │   └──────────→ READY        │
                        │   │                             │
                        │   │SIGUSR2 / explicit ckpt      │
                        │   ↓                             │
                        │ [CHECKPOINTING]──→ [SUSPENDED]  │
                        │                          │      │
                        │                          │      │
                        │                          │restore
                        │                          └──────┘
                        │                            (new PID)
                        ↓
                    [BLOCKED]
                        │
                        │ wake condition met
                        └──────────→ READY
```

Eight states, twelve legal transitions, no hidden substates.

---

## 3. State definitions

### 3.1 `NEW`

The process exists in the process table. Its PID is allocated. Its initial snapshot (cognitive context, memory policies, budgets) is loaded. **It has not yet been scheduled.**

A process spends microseconds in NEW under normal conditions. Long NEW residence means the scheduler is starved or the agent definition failed to load.

**Allowed syscalls from NEW:** none. The kernel moves NEW → READY automatically once initialization completes.

### 3.2 `READY`

The process is runnable. It is on the scheduler queue. It is consuming no tokens, no CPU beyond bookkeeping.

**Allowed syscalls from READY:** none directly; the process must first be dispatched to RUNNING.

A ready process waiting too long triggers `SIGXCPU` (scheduler starvation warning) to the supervisor.

### 3.3 `RUNNING`

The process is currently executing a syscall — an LLM call, a tool call, a memory write, an IPC send, etc.

This is the **only** state in which the process can invoke syscalls. Any other state and the syscall traps with `ESRCH` (no such process in runnable state).

A running process is *not* necessarily consuming CPU. While waiting for an LLM response over the network, the kernel switches it to BLOCKED (see §3.7) so other processes can run.

### 3.4 `STOPPED`

The process is paused by user request (SIGSTOP) or by budget exhaustion (SIGXCPU). Its state is fully in memory. Resuming is cheap (SIGCONT → READY).

A stopped process **does not survive kernel restart**. To survive, use SUSPENDED instead.

**Allowed syscalls from STOPPED:** none. Only signal handling occurs.

### 3.5 `CHECKPOINTING`

A transient state. The kernel is writing the process's snapshot to disk per STATE.md §4. The process is paused; syscalls are queued, not executed.

CHECKPOINTING is observable (you can see it in `cortex ps`) but not controllable. You cannot SIGSTOP a CHECKPOINTING process — it is already paused.

On completion, the process moves to one of:
- **READY** (if the checkpoint was an "in-flight" snapshot, e.g. for backup or forking)
- **SUSPENDED** (if the checkpoint was a "shutdown" snapshot, e.g. SIGUSR2 with `--detach`)

### 3.6 `SUSPENDED`

The process is no longer in memory. Its snapshot is on disk. Its PID is reserved (not reusable). The scheduler ignores it.

A suspended process **survives kernel restart** — `cortex restore <chain_id>` reconstructs it.

Restore creates a **new process with a new PID** in state NEW. The lineage records that the new PID's `chain_id` matches the suspended process's snapshot. The old PID is *not* reanimated; it is reaped (see §6).

This is one of the most consequential decisions in cortex. We chose **new PID on restore** over **same PID** because:
- It keeps the syscall log append-only and unambiguous
- It avoids "is this the same process?" philosophical traps
- It composes cleanly with fork (a restore is morally a fork from the past)

### 3.7 `BLOCKED`

The process is waiting on an external event. The `blockedOn` field says which:

```typescript
type BlockedReason =
  | { kind: 'recv';  channel: ChannelId }   // waiting on IPC
  | { kind: 'wait';  pid: ProcessId }       // waiting on child
  | { kind: 'tool';  callId: string }       // waiting on tool driver
  | { kind: 'llm';   callId: string }       // waiting on LLM driver
  | { kind: 'budget'; until: string }       // rate-limited, awaiting window
  | { kind: 'lock';  resource: string };    // explicit lock (rare)
```

A blocked process is woken by the kernel when its condition is satisfied. Wake transitions BLOCKED → READY (not directly to RUNNING — the scheduler decides when to dispatch).

Most of an agent's life is spent in BLOCKED. This is normal. It is also why cortex can run thousands of agents on a laptop: only RUNNING processes consume tokens; the rest are essentially free.

### 3.8 `EXITING`

The process has called `exit()` or received a terminating signal. Cleanup is in progress:
- Pending syscalls are aborted with `EINTR`
- Open channels are closed (peers receive `SIGPIPE`)
- Drivers are notified to release external resources
- Final budget counters are written
- Exit code and reason are recorded

EXITING is bounded — if cleanup takes more than `exit_timeout_ms` (default 5000), the kernel escalates to ZOMBIE forcibly. This prevents hung drivers from blocking shutdown forever.

### 3.9 `ZOMBIE`

The process has terminated. Its in-memory state is gone. The process table entry survives, holding only:
- PID, PPID, PGID
- Exit code, exit reason
- Final budget counters
- Final syscall log offset
- Timestamp of death

A zombie exists so the parent can `wait()` and learn the exit status. Once reaped, the entry is removed and the PID is **never reused** (see §4).

If the parent dies first, init (PID 1) inherits the zombie and reaps it immediately. There is no "double zombie" state.

---

## 4. Process identity

### 4.1 PID

`ProcessId = u64`. Monotonically allocated, starting from 2 (PID 1 is reserved for init, PID 0 is the kernel and is never a process).

**PIDs are never reused.** With u64 and even thousands of spawns per second, exhaustion is unreachable in any realistic deployment. Never reusing means:
- Syscall logs are unambiguous forever
- Lineage queries (`who is descended from PID 1234?`) are decidable
- Checkpoint files reference PIDs that mean exactly one thing

### 4.2 PPID (parent PID)

Every process has a parent, except init (whose `ppid` is `null`).

When a parent dies, its children are reparented to init. Init's job:
- Reap zombies
- Restart daemons according to their restart policy
- Log unusual termination patterns (e.g. a process restarted 100 times in a minute)

### 4.3 PGID (process group ID)

Every process belongs to a process group. The PGID equals the PID of the group's founder.

Process groups exist so you can signal a whole tree at once:

```bash
cortex kill -TERM -1234       # send SIGTERM to all members of pgid 1234
```

The leading `-` is the Unix convention for "group, not pid." We keep it.

Children spawned by a process inherit its PGID by default. This can be overridden with `spawn(..., { group: <other_pgid> })`.

### 4.4 SID (session ID) — post-v0

Unix has sessions (collections of process groups, with a controlling terminal). Cortex does not need sessions in v0. We will add them when we add multi-user / multi-tenant kernels.

For now, PGID is enough.

---

## 5. State transitions

Every legal transition is listed here. Anything not in this table is illegal and traps with `EINVAL`.

| From | To | Trigger | Effect |
|---|---|---|---|
| NEW | READY | scheduler init complete | process enqueued |
| READY | RUNNING | scheduler dispatch | syscall execution begins |
| RUNNING | READY | syscall returns, more work pending | re-enqueued |
| RUNNING | BLOCKED | syscall awaits external event | `blockedOn` set; dequeued |
| BLOCKED | READY | wake condition met | re-enqueued |
| RUNNING | STOPPED | SIGSTOP, SIGXCPU, or budget exhaustion | paused in memory |
| STOPPED | READY | SIGCONT | re-enqueued |
| RUNNING | CHECKPOINTING | SIGUSR2 or `checkpoint()` syscall | snapshot begins |
| BLOCKED | CHECKPOINTING | SIGUSR2 (delivered when blocked) | snapshot begins |
| CHECKPOINTING | READY | snapshot done, no `--detach` | re-enqueued |
| CHECKPOINTING | SUSPENDED | snapshot done with `--detach` | removed from scheduler |
| SUSPENDED | (gone) | `restore <chain_id>` | new PID created in NEW; old entry reaped |
| RUNNING | EXITING | `exit()` or terminating signal | cleanup begins |
| BLOCKED | EXITING | SIGKILL or SIGTERM (with handler) | cleanup begins |
| STOPPED | EXITING | SIGKILL or SIGTERM | cleanup begins |
| EXITING | ZOMBIE | cleanup done or `exit_timeout_ms` elapsed | entry retained for parent |
| ZOMBIE | (gone) | parent `wait()` or init reaping | entry removed |

**Forking** does not appear in this table because fork does not transition the parent. Fork creates a **new** process in NEW state, with a snapshot copied from the parent's current state (whatever it is — RUNNING, BLOCKED, even STOPPED). The parent continues unchanged. See STATE.md §3.

---

## 6. Lifecycle of a process

### 6.1 Birth

```typescript
const child = await ctx.spawn({
  role: 'researcher',
  agent: { system: '...', tools: ['search', 'fetch'] },
  budgets: { usd: 5_000_000 },   // $5 in microdollars
  memory: { notes: { kind: 'private', backing: 'sqlite' } },
  restart: { kind: 'on-failure', maxRestarts: 3 },
});
// child.pid is allocated; state is NEW; will move to READY when scheduler inits it
```

The kernel:
1. Allocates a PID
2. Initializes the cognitive snapshot (empty messages, optional system prompt)
3. Sets up memory regions per policy
4. Allocates budget counters
5. Joins parent's PGID (unless overridden)
6. Records the spawn syscall in the parent's `.crec` log
7. Transitions NEW → READY

### 6.2 Life

The process spends most of its life cycling between READY, RUNNING, and BLOCKED. The kernel records every syscall to the `.crec` log. Budgets decrement on every LLM call.

### 6.3 Death

A process dies in one of three ways:

**Voluntary exit.** The agent calls `exit(code, reason)`. State goes RUNNING → EXITING → ZOMBIE.

**Signal-induced.** SIGTERM (graceful), SIGKILL (immediate), SIGXCPU (budget exceeded; default disposition is "terminate"). State transitions depend on the signal.

**Crash.** An unhandled exception in agent code, a corrupted snapshot, a kernel-level fault. State goes to EXITING with `exit_reason: 'crash'`. The supervisor's restart policy applies.

### 6.4 Reaping

The parent eventually calls `wait(pid)` or `wait_any()`. The kernel:
1. Returns the exit code, reason, final budget counters
2. Removes the zombie entry
3. Records the reap in the parent's `.crec` log

If the parent never reaps and dies itself, init inherits and reaps immediately.

If the parent set `autoReap: true` on spawn, the kernel reaps automatically and the parent receives a `SIGCHLD` with the exit info embedded. This is the right choice for high-volume short-lived children (e.g. a planner that spawns 1000 micro-agents).

**Waiting late still works.** Because a zombie can be reaped before its parent
gets around to waiting for it — init reaps orphans, and a supervisor that waits
for child A and *then* child B will routinely find B already gone — the table
retains each reaped child's `WaitResult` for its parent
(`takeReapedChild` / `takeReapedChildAny`). A `wait()` for an already-reaped
child consumes that retained status instead of trapping `ESRCH` or parking
forever. Consumed once, exactly like a real reap.

**Bounded waits.** `wait(pid, { timeoutMs })` traps `ETIMEDOUT` if the child has
not exited in time (`timeoutMs: 0` polls without parking). The child is *not*
killed — a timeout is an observation; the supervisor decides what to do about
it, with `kill()` and a fresh `spawn()`. See ABI.md §4.1.

---

## 7. Signals

Cortex signals are Unix-shaped but with agent-specific semantics.

| Signal | Num | Default | Agent meaning |
|---|---|---|---|
| `SIGHUP` | 1 | ignore | "Reload your config." Re-read system prompt, refresh tool list. |
| `SIGINT` | 2 | terminate | "Interrupt." Stop current task gracefully; ask supervisor what to do. |
| `SIGTERM` | 15 | terminate | "Terminate gracefully." Run exit handlers, then die. |
| `SIGKILL` | 9 | **kill, uncatchable** | "Die now." No cleanup. Immediate ZOMBIE. |
| `SIGSTOP` | 17 | **stop, uncatchable** | "Pause." Move to STOPPED. State remains in memory. |
| `SIGCONT` | 18 | continue | "Resume from pause." STOPPED → READY. |
| `SIGUSR1` | 10 | ignore | **"Reflect."** Write a self-summary to memory. Agent-specific. |
| `SIGUSR2` | 30 | ignore | **"Checkpoint now."** Kernel writes snapshot. Agent-specific. |
| `SIGCHLD` | 19 | ignore | Sent to parent when child changes state (RUNNING → ZOMBIE, etc). |
| `SIGXCPU` | 24 | stop | **Budget exceeded** (tokens or USD). Default: STOPPED until supervisor decides. |
| `SIGXFSZ` | 25 | terminate | Memory region exceeded its size limit. |
| `SIGSYS` | 31 | terminate | Bad syscall — driver rejected, permission denied, malformed args. |
| `SIGPIPE` | 13 | ignore | IPC channel closed by peer. |

### 7.1 Dispositions

Every signal has a disposition per process:
- `default` — kernel-defined behavior (table above)
- `ignore` — signal is dropped
- `handler` — kernel calls a registered syscall (e.g. invoke a user-defined reflection routine)

`SIGKILL` and `SIGSTOP` cannot be caught, ignored, or blocked. This is non-negotiable — without it, runaway agents cannot be stopped.

### 7.2 Pending signals

If a signal arrives while the process is BLOCKED or STOPPED, it is queued. When the process next transitions to RUNNING, pending signals are delivered before the next syscall.

This means an agent that is blocked waiting on an LLM response and receives SIGTERM will not interrupt the LLM call mid-flight (which would waste tokens) — it will be delivered the moment the call returns.

### 7.3 Group signals

`kill(-pgid, sig)` delivers the signal to every member of the group. This is the standard way to terminate a whole subtree.

---

## 8. Scheduling

Cortex's scheduler is intentionally simple in v0.

### 8.1 Algorithm

Round-robin over READY processes, weighted by `nice` value (-20 to 19, lower = higher priority).

```
loop:
  candidates = processes in READY whose budgets are not exhausted
  if candidates is empty:
    sleep until next wake event
    continue
  pick highest-priority candidate (lowest nice value, FIFO tiebreak)
  dispatch to RUNNING
```

### 8.2 Cooperative, not preemptive

Cortex does **not** preempt a running syscall. If an LLM call is in flight, it completes. If a tool call hangs, it hangs until its own timeout.

This is a deliberate choice. Preempting an LLM call wastes the tokens already spent. Preempting a tool call leaves external state inconsistent. Cooperative scheduling means agents must yield explicitly (return from a syscall) or block (await external event).

#### The continuation

`resume(pid)` — the scheduler's continuation — starts the agent body and
returns; it does **not** run the body to completion. The body then lives in its
own Promise, advancing on the Node event loop while the scheduler goes on to
other processes. Consequences:

  - A parent parked in `wait()` does not hold the CPU. Its child is dispatched
    in a later tick; when the child exits, the kernel wakes the parent, and it
    resumes at the next statement *inside a quantum* — i.e. in RUNNING, so its
    next syscall is legal. The wake is handed over by `wake_gate.ts`, which
    defers the resolution of the parked `wait()` until the process is
    dispatched again. Resolving it inline would race the BLOCKED → READY
    transition and trap `ESTATE` on the agent's very next call.
  - A dispatch of a process whose body is still live reports `parked`: the
    process stays RUNNING and is **not** re-queued, because re-queueing would
    re-enter the agent body mid-`await`. It re-enters the run queue only when
    the kernel wakes it (BLOCKED → READY) or when its body drives its own exit.
  - An earlier implementation ran the body to completion inside its quantum
    ("run-to-completion"). It was simpler, but it made `wait()` on a child
    deadlock by construction — the child could not be dispatched until the
    parent's `resume` returned, which it never did. Supervision trees were
    therefore impossible. That is why the continuation is cooperative now.

The kernel's only "preemption" mechanism is the budget system: when budgets are exhausted, SIGXCPU fires and the default disposition is STOPPED. The supervisor decides what to do.

### 8.3 Budgets

Every process has three budgets:
- `tokens` — total tokens (input + output)
- `usd` — total cost in microdollars
- `wall_time_ms` — total wall-clock time alive

Budgets decrement on every relevant syscall. When exhausted:
- A counter hits zero → `SIGXCPU` fires
- Default disposition: STOPPED
- Supervisor may: increase budget, terminate, fork a fresh attempt

Budgets are inherited on `spawn()` (default: half of parent's remaining), reset on `fork()` (default; see STATE.md §2.4), preserved on `checkpoint()`/`restore()`.

### 8.4 Async I/O

LLM and tool calls are async. While waiting, the process is BLOCKED, and the scheduler runs other processes. This is how cortex achieves "thousands of agents on a laptop" — most of them are blocked most of the time.

The kernel itself runs on Node's event loop. There is no thread pool. There is no parallel CPU work in v0. There may be in v1.

---

## 9. Daemons and supervision

### 9.1 Daemons

A daemon is a process with three properties:
- Its parent is init (PID 1), not the spawning shell
- It has no controlling terminal (`cortex attach` requires explicit permission)
- It has a restart policy registered with init

Daemons survive shell exit. They are how long-running agents (inbox watchers, PR reviewers, schedulers) are deployed.

```bash
cortex daemon install --role inbox-watcher \
                      --agent ./agents/inbox.ts \
                      --restart on-failure \
                      --wake-on email_arrived
```

### 9.2 Supervision

Cortex does not bake supervision into the kernel. Supervision is a **user-space pattern** built from kernel primitives:

- `spawn()` to create children
- `wait()` or `SIGCHLD` to learn about termination
- `kill()` to terminate stuck children
- `fork()` to retry from a known good state

The canonical Erlang/OTP-style supervisor is ~50 lines of TypeScript. We will ship one in `examples/supervisor.ts` as a reference, not as a kernel feature.

This decision keeps the kernel small (per MANIFESTO §II.3) and lets users invent supervision policies we did not anticipate.

---

## 10. TypeScript types

```typescript
// kernel/process.ts

export type ProcessState =
  | 'new' | 'ready' | 'running' | 'blocked'
  | 'stopped' | 'checkpointing' | 'suspended'
  | 'exiting' | 'zombie';

export type BlockedReason =
  | { kind: 'recv';   channel: ChannelId }
  | { kind: 'wait';   pid: ProcessId }
  | { kind: 'tool';   callId: string }
  | { kind: 'llm';    callId: string }
  | { kind: 'budget'; until: string }
  | { kind: 'lock';   resource: string };

export type Signal =
  | 'SIGHUP'  | 'SIGINT'  | 'SIGTERM' | 'SIGKILL'
  | 'SIGSTOP' | 'SIGCONT' | 'SIGUSR1' | 'SIGUSR2'
  | 'SIGCHLD' | 'SIGXCPU' | 'SIGXFSZ' | 'SIGSYS'  | 'SIGPIPE';

export type SignalDisposition =
  | { kind: 'default' }
  | { kind: 'ignore' }
  | { kind: 'handler'; onSignal: SyscallRef };

export interface BudgetLimits {
  readonly tokens: number;          // remaining; -1 = unlimited
  readonly usd: number;             // microdollars remaining; -1 = unlimited
  readonly wallTimeMs: number;      // -1 = unlimited
}

export interface RestartPolicy {
  readonly kind: 'always' | 'on-failure' | 'never';
  readonly maxRestarts?: number;    // default Infinity
  readonly backoffMs?: number;      // default 1000, exponential
  readonly window?: number;         // sliding window for "too many restarts" alarm
}

export interface SpawnOptions {
  readonly role: string;
  readonly agent: AgentSpec;
  readonly parent?: ProcessId;                    // default: caller's pid
  readonly group?: ProcessId;                     // default: parent's pgid
  readonly budgets?: Partial<BudgetLimits>;       // default: inherit half
  readonly nice?: number;                         // -20..19, default 0
  readonly daemon?: boolean;                      // default false
  readonly autoReap?: boolean;                    // default false
  readonly restart?: RestartPolicy;               // default never
  readonly memory?: Record<string, MemoryRegionPolicy>;
  readonly signals?: Partial<Record<Signal, SignalDisposition>>;
  readonly exitTimeoutMs?: number;                // default 5000
}

export interface ProcessInfo {
  readonly pid: ProcessId;
  readonly ppid: ProcessId | null;
  readonly pgid: ProcessId;
  readonly role: string;
  readonly state: ProcessState;
  readonly blockedOn: BlockedReason | null;
  readonly nice: number;
  readonly startedAt: string;            // ISO8601
  readonly lastTransitionAt: string;
  readonly budgetsRemaining: BudgetLimits;
  readonly budgetsSpent: BudgetCounters; // see STATE.md §7
  readonly exitCode: number | null;
  readonly exitReason: string | null;
  readonly checkpointChain: ChainId[];
  readonly pendingSignals: readonly Signal[];
}

export interface WaitResult {
  readonly pid: ProcessId;
  readonly exitCode: number;
  readonly exitReason: string;
  readonly budgetsSpent: BudgetCounters;
  readonly syscallLogRange: [SyscallOffset, SyscallOffset];
  readonly reapedAt: string;
}

export interface KernelSignals {
  kill(pid: ProcessId, signal: Signal): void;
  killGroup(pgid: ProcessId, signal: Signal): void;
  setDisposition(pid: ProcessId, signal: Signal, disp: SignalDisposition): void;
}

export interface KernelProcess {
  spawn(opts: SpawnOptions): Promise<{ pid: ProcessId }>;
  wait(pid: ProcessId): Promise<WaitResult>;
  waitAny(children?: readonly ProcessId[]): Promise<WaitResult>;
  ps(filter?: ProcessFilter): readonly ProcessInfo[];
  exit(code: number, reason?: string): never;
}
```

---

## 11. Open questions

Each of these gets an issue. None of them block writing ABI.md, but several will block writing the kernel.

### 11.1 Cooperative scheduling and runaway LLM calls

If an LLM driver hangs (no response, no timeout), the process is BLOCKED forever. The scheduler is fine — other processes run — but the supervisor sees a stuck child.

**Default answer:** every LLM and tool call has a driver-level timeout (default 60s, configurable). On timeout, the syscall returns `ETIMEDOUT`. The agent decides what to do.

**Open:** should the kernel impose a hard ceiling regardless of driver timeout?

### 11.2 SIGKILL semantics for groups

`kill -9 -pgid` kills the whole group. Does it kill children spawned by group members after the signal was sent? Unix says no (signals are delivered to current members only). We will follow Unix.

But this means a "kill all my agents" operation needs to walk the tree, not just the group. Should `cortex kill --tree <pid>` exist?

**Instinct:** yes, as a CLI sugar over a recursive walk. Not as a kernel concept.

### 11.3 Restore semantics and identity

When you `restore <chain_id>`, you get a new PID. Is it the "same agent"? Lineage says yes; PID says no.

For most uses this does not matter. For some (e.g. "resume the inbox watcher daemon") the user expects the same logical entity.

**v0 answer:** restore returns the new PID and the chain_id. The CLI prints both. Tooling that cares about logical identity tracks chain_id, not PID.

### 11.4 Threads within a process

Should a single agent process be able to run "parallel thoughts"? E.g. one process, multiple concurrent LLM calls?

Unix has threads. Cortex v0 does not. An agent that wants concurrency spawns children.

**Why:** threads introduce shared mutable state within a process, which complicates the state model in STATE.md §2 enormously. Children are cleaner.

We may revisit in v1 if real workloads demand it.

### 11.5 PID namespaces (multi-tenant)

If two users share a cortex kernel, should their PIDs be isolated? Linux says yes (PID namespaces). v0 says no — single-tenant kernel.

This is a "we know we'll need it eventually, but not now" decision.

### 11.6 What happens to BLOCKED processes during kernel restart?

A process that is BLOCKED on an LLM call when the kernel dies — what happens on restart?

- The LLM call's response is lost
- The process's state is in memory, also lost
- If checkpointed recently, restore gives a slightly stale process
- If not, the process is gone

**v0 answer:** kernel restart kills all non-suspended processes. The supervisor's restart policy decides what comes back. Long-running agents should checkpoint periodically (e.g. on a timer, or on SIGUSR2 from a cron job).

**v1 may add:** automatic checkpointing on graceful kernel shutdown.

### 11.7 Auto-reap and SIGCHLD ordering

If `autoReap: true`, the parent gets `SIGCHLD` with exit info. But signals are queued, and if 1000 children die at once, the queue may overflow.

**v0 answer:** SIGCHLD is coalesced — pending signals of the same type collapse to one. The handler must call `wait_any()` in a loop to drain.

This matches Unix and is fine, but worth documenting.

---

## 12. What we will get wrong

Predictions:

- The eight-state machine will turn out to need a ninth state for "awaiting supervisor decision after SIGXCPU." We will resist adding it; we will eventually add it.
- Cooperative scheduling will hurt us when LLM drivers misbehave. We will add per-driver hard timeouts and call it "kernel-imposed."
- `autoReap` semantics will surprise someone badly. We will write a Cookbook entry titled "Why did my planner lose track of its children?"
- The decision to give restored processes new PIDs will be controversial. We will defend it; we may eventually add a `--reuse-pid` flag with strict caveats.

These are not failures. They are the document doing its job: being concrete enough to be wrong about.

---

## 13. What comes next

PROCESS.md defines *how* a process changes state. The next document defines *what* a process can ask the kernel to do:

- **`docs/ABI.md`** — every syscall, its arguments, its return values, its errors, which states it can be invoked from, and how it interacts with the state machine above.

After ABI.md, the kernel can be written.

---

*If you find a state transition that should exist but does not, or one that exists but should not, open an issue. The state machine is the contract; everything else is implementation.*
