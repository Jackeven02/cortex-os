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

A cortex process is always in exactly one of nine states.

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

Nine states, eighteen entries in `LEGAL_TRANSITIONS`, no hidden substates.
(The table in §5 lists 16 of them. Two more live in the code and are not
state-to-state edges: `checkpointing->ready` is retained only as a
best-effort abort path, and §5's two "(gone)" rows — SUSPENDED and ZOMBIE
disappearing — are entry removal, not transitions.)

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
- **SUSPENDED** (if the checkpoint was a "shutdown" snapshot, e.g. `checkpoint --detach`)

### 3.6 `SUSPENDED`

The process is no longer in memory. Its snapshot is on disk. Its PID is reserved (not reusable). The scheduler ignores it.

A suspended process **survives kernel restart** — `cortex restore <chain_id>` reconstructs it.

Restore creates a **new process with a new PID** in state NEW. The lineage records that the new PID's `chain_id` matches the suspended process's snapshot. The old PID is *not* reanimated; it is reaped (see §6).

NEW here describes the *image*, not the outcome: the `restore` syscall immediately adopts the process — NEW → READY, then enqueued — so what the caller gets back is a runnable process, exactly as `spawn` returns one. (`CheckpointManager.restoreAs` on its own leaves it in NEW; adoption is the syscall's job.) Before `0.2.0` the syscall skipped the adoption and a restored process sat in NEW until something outside the kernel walked it forward, which is why `cortex restore` carried a stopgap.

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
  | { kind: 'sleep'; until: string }        // waiting on a timer
  | { kind: 'tool';  callId: string }       // reserved — see below
  | { kind: 'llm';   callId: string }       // reserved — see below
  | { kind: 'budget'; until: string }       // reserved — see below
  | { kind: 'lock';  resource: string };    // reserved — see below
```

A blocked process is woken by the kernel when its condition is satisfied. Wake transitions BLOCKED → READY (not directly to RUNNING — the scheduler decides when to dispatch).

Most of an agent's life is spent in BLOCKED. This is normal. It is also why cortex can run thousands of agents on a laptop: only RUNNING processes consume tokens; the rest are essentially free.

**Which reasons the kernel actually sets.** Three, today: `recv` (parked on a
channel), `wait` (parked on a child) and `sleep` (parked on a timer). The other
four are in the type and reserved for reasons the kernel does not yet have a
way to express — and, in particular, **a process is not parked while a driver
call is in flight**. An agent in a slow `llm_call` is RUNNING, not BLOCKED,
and `blockedOn` is `null`.

That is a deliberate consequence of the cooperative scheduler (§8.2): the
agent's JavaScript is *awaiting* the driver, and the kernel does not preempt a
running process to mark it. The consequence is that a process table alone
cannot tell you that an agent is wedged in a model call. The syscall log can
— the `llm_call`'s `enter` frame is there and its `exit` frame is not — and
that is what `cortex top` reads (docs/ARCHITECTURE.md §12.1). Turning the
reserved reasons on would change the state model, so it is a discussion
rather than a change (BACKLOG #060).

### 3.8 `EXITING`

The process has called `exit()` or received a terminating signal. Cleanup is in progress:
- Pending syscalls are aborted with `EINTR`
- Open channels are closed (peers receive `SIGPIPE`)
- Drivers are notified to release external resources
- Final budget counters are written
- Exit code and reason are recorded

**The outcome is decided before the state says `EXITING`.** The exit code and
the reason are known the moment the exit is *requested* — the syscall was
called with them — so the kernel records them before the transition, not
after the cleanup. The exit frame in the log is written later, and that write
awaits the disk; a host that read the process table in that window used to
find no exit code at all.

That window was not a harmless detail. "No exit code" is the absence of an
answer, and the CLI turned the absence into zero — so `cortex spawn` on an
agent that threw an exception sometimes printed `code 0: completed` and exited
0, while the kernel's own metadata said `exitCode: 1` the whole time. The
invariant now is:

> **A process that is exiting already knows how it will end. And an ending
> nobody saw is reported as unknown — never as success.**

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

**The zombie is the end of the record, and the record has one author per
fact.** The kernel writes the process's exit record at this transition — the
code, the reason, what it spent, and the capabilities it held — and that is
the kernel's own account of how the process lived. The CLI writes to the same
file at the end of the command that ran the process, because it knows things
the kernel does not (the memory policies it declared, what the process was
blocked on). Neither may overwrite the other's facts, and the ending belongs
to whoever *decided* it: a process that exits itself, or the CLI that stops a
run for overrunning. See docs/ARCHITECTURE.md §7 and docs/ABI.md §4.9.

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
| BLOCKED | CHECKPOINTING | `checkpoint()` syscall, or SIGUSR2 once it is delivered | snapshot begins |
| CHECKPOINTING | READY | snapshot done, no `--detach` | re-enqueued |
| CHECKPOINTING | SUSPENDED | snapshot done with `--detach` | removed from scheduler |
| SUSPENDED | (gone) | `restore <chain_id>` | new PID created in NEW; old entry reaped |
| RUNNING | EXITING | `exit()` or terminating signal | cleanup begins |
| BLOCKED | EXITING | SIGKILL or SIGTERM (with handler) | cleanup begins |
| STOPPED | EXITING | SIGKILL or SIGTERM | cleanup begins |
| EXITING | ZOMBIE | cleanup done or `exit_timeout_ms` elapsed | entry retained for parent |
| ZOMBIE | (gone) | parent `wait()` or init reaping | entry removed |

**Forking** does not appear in this table because fork does not transition the parent. Fork creates a **new** process in NEW state, with a snapshot copied from the parent's current state (whatever it is — RUNNING, BLOCKED, even STOPPED). The parent continues unchanged. See STATE.md §3.

**Every transition records why.** The `Trigger` column above says what *kind* of
event moved the process; the kernel records it as a **cause** — the trigger
(`recv`, `sleep`, `wait`, `spawn`, `scheduler-dispatch`, `signal`, …) — and
that cause is in the `__state` frame in the `.crec` log, where `cortex trace`
shows it:

```
__state:running->blocked(recv)
__state:running->exiting(SIGTERM)
```

A transition without a cause is a fact without an explanation, and the reader
had to guess from the transition pair alone. The causes are a **vocabulary**,
not free text: `STATE_TRIGGERS` is exported from the process table and
`setState` takes a `StateTrigger`, so a cause that is not on the list cannot
be recorded — a typo is a compile error, not a frame nobody can explain
(ABI.md §6.1).

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

Step 3 is a **binding**, not a declaration, and it applies to every way a
process comes into being: a `spawn` syscall, a `restore`, and a daemon
registration by init all have to turn the declared regions into live ones. A
daemon whose registration skipped that binding had a process that *looked*
like it had memory regions and trapped `ENOENT` on its first `memory_read` —
so the agent died at the moment it tried to remember anything.

### 6.2 Life

The process spends most of its life cycling between READY, RUNNING, and BLOCKED. The kernel records every syscall to the `.crec` log. Budgets decrement on every LLM call.

### 6.3 Death

A process dies in one of three ways:

**Voluntary exit.** The agent calls `exit(code, reason)`. State goes RUNNING → EXITING → ZOMBIE.

**Signal-induced.** SIGTERM (graceful), SIGKILL (immediate), SIGXCPU (budget exceeded; default disposition is "terminate"). State transitions depend on the signal.

**Crash.** An unhandled exception in agent code, a corrupted snapshot, a kernel-level fault. State goes to EXITING with `exit_reason: 'crash'`. The supervisor's restart policy applies.

**And it is reported, not only stored.** The exit facts — the real code, the
reason — are also *pushed* to whoever is watching the kernel:
`Kernel.subscribe` reports a `process-exit` event carrying the same code and
the same reason (docs/ARCHITECTURE.md §12.1). A host that wants to react to a
death does not have to poll the process table to notice it, and it cannot
miss the window between the death and the reap.

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

**A host is not a parent.** `wait` is a parent-child syscall: the kernel parks
the caller, and when the child exits it wakes the caller's run queue. A process
started *on a host's behalf* is a child of `init`, not of the host — so a host
that waits through the dispatcher (`dispatcher.invoke(asProcessId(1), 'wait',
…)`) waits forever, because the caller it names is init, and init does not wait
on its own children the way a parent does. The host-facing primitive is
`Kernel.awaitExit(pid, { timeoutMs })`: it resolves with the exit code, it
still answers for a process that has already been reaped, and it refuses a pid
the kernel has never known with `ESRCH` (docs/HACKING.md §7).

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
| `SIGUSR2` | 30 | checkpoint | **"Checkpoint now."** Kernel writes snapshot. Agent-specific. |
| `SIGCHLD` | 19 | ignore | Sent to parent when child changes state (RUNNING → ZOMBIE, etc). |
| `SIGXCPU` | 24 | stop | **Budget exceeded** (tokens, USD, or wall time). Default: STOPPED until supervisor decides. |
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

`SIGUSR2` is no exception: a "checkpoint now" aimed at a parked agent waits for the agent to run again, and the snapshot is taken then. The snapshot is of the agent as it is *when it resumes*, not as it was when the signal arrived.

**A queued signal waits for a wake-up that may never come.** The rule above
is right for an agent that is waiting for something — an LLM response, a
message — because it will wake up. But an agent parked in a `recv()` with no
timeout, or one that never wakes at all, will never see the signal: it sits
in the pending queue indefinitely. So `SIGTERM` alone cannot stop such an
agent, and a graceful termination needs a fallback. `SIGKILL` is the
fallback — it is applied immediately, whatever state the target is in — and
`cortex supervise` uses exactly that: it reads the `outcome` of its own
signal out of the target's `__signal` record (`queued` means "not running,
not going to see it") and escalates at once instead of waiting out a grace
period for a signal that will never be delivered. This is a known sharp edge
of the queuing rule, tracked in BACKLOG.md.

**And the operator's views say so.** The queue is the kernel's own, and the
kernel sends it in every process record it hands out — but the views used to
drop it. So `cortex ps` printed the *same row* before and after a `cortex
kill` on a wedged agent: the operator asked a process to die, and the
process list said nothing about it. The only place that mentioned the signal
was the command that had just run.

Now the queued signals are part of what a view says about a process, in the
kernel's own word (`queued`), and in the same words everywhere:

```console
$ cortex ps
PID  PPID  ROLE     STATE    TOKENS  CAPS  AGE  NOTE
----------------------------------------------------
1    -     init     running  0       all   40s
2    1     blocker  blocked  0       all   40s  a channel — SIGTERM queued

$ cortex top
cortex top — 2 processes · 1 running · 1 blocked · live kernel
0 tokens · $0.000000 spent · home .cortex

   PID  ROLE     STATE    TOKENS  USD        NOTE
-------------------------------------------------
   1    init     running  0       $0.000000  1 syscall
└─ 2    blocker  blocked  0       $0.000000  waiting on a channel for 40.3s — SIGTERM queued
```

`cortex ps` puts it in the NOTE column, `cortex top` in its NOTE, and the
dashboard in the column it keeps for "where this process is". One rule, three
views: the wording comes from one function (`describePendingSignals`), so a
table, a tree and a page cannot drift apart.

### 7.3 Group signals

`kill(-pgid, sig)` delivers the signal to every member of the group. This is the standard way to terminate a whole subtree.

### 7.4 SIGUSR2: checkpoint now

`SIGUSR2`'s default action is `checkpoint`: the kernel writes a snapshot of the target (§3.5) and the target keeps running. It is the channel an operator uses to ask a live agent to save itself — `cortex kill <pid> --signal SIGUSR2`, or a cron job that signals a long-running agent on a schedule (see §11.6).

The signal is the *only* way to ask another process to snapshot itself, because `checkpoint` is a self-syscall: the ABI gives it no target argument, so the subject of a snapshot is always its caller. A signal is the one request that crosses the boundary.

Two things are recorded, and they say different things:

- the `checkpoint` syscall frames, in the **target's** log, say "this process was snapshotted" — the subject;
- the `__signal` record, also in the target's log, says "SIGUSR2 arrived, from whom, and here is the snapshot it produced" — the cause.

An agent that checkpoints *itself* has the first pair and no second one. That is how a replay tells the two apart.

A signal-triggered snapshot does not detach: the agent keeps running afterwards. The "save and stop" variant is `checkpoint --detach`, which moves the process to SUSPENDED.

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

**And the wall clock is a clock.** `wall_time_ms` is a ceiling on how long a
process may **live**, so it is charged by time passing — not by the process
doing something. It used to be charged only at an `llm_call`, and only when
the budget was bounded, which meant two things were untrue at once: a process
with no wall budget reported `wallTimeMs: 0` for a run that had lasted minutes
(the views print that number — `cortex limit` says "wall time: spent 0ms"),
and an agent that sat in `recv()` never drained its ceiling. A budget an
agent can outlast by doing nothing is not a ceiling.

The kernel charges it on its heartbeat — the scheduler's tick — so an idle
agent spends its wall-clock budget exactly like one burning tokens, and the
clock stops while the process is stopped or suspended (that time is not the
agent's) and is exact at the exit.

**The kernel cannot stop a process that is not running.** `SIGXCPU` is a
signal, and a signal aimed at a process that is not RUNNING is queued until
it runs again (PROCESS §7.2) — so a process whose wall-clock ceiling is
reached while it is parked is *not* stopped by the kernel. It is left where
it is, and the views say why (`cortex ps` prints "out of wallTime"), because
a `ready` row that will never run again looks exactly like one that is
merely waiting. The supervisor is what acts on it: `cortex supervise
--kill-after` stops an agent the kernel cannot. (How a process that never
wakes should be stopped gracefully is BACKLOG #057, and it is still open.)

**And the log says which counter hit zero.** "Your agent was stopped" and
"your agent ran out of tokens" are different facts, and only one of them tells
the operator what to change — the budget, or the code that spends it. The
scheduler records which one, and the trace renders it in the frame's own name:
`__sched:sigxcpu(tokens)`. The budget kind is a closed vocabulary
(`BudgetKind`: `tokens`, `usd`, `wallTime`), so a frame cannot say anything
else (ABI.md §6.1). The views name the same budget the same way: the note
column says "out of tokens", "out of usd", "out of wallTime".

Budgets are inherited on `spawn()` (default: half of parent's remaining), reset on `fork()` (default; see STATE.md §2.4), preserved on `checkpoint()`/`restore()`.

**A budget has a ceiling and a remainder, and they are not the same number.** The
kernel keeps the remainder — what is left — and the spend; the ceiling (the
total the process may ever spend) is their sum, and is unlimited when the
remainder is `-1`. The remainder shrinks as the process spends, so a view that
prints it under the label "limit" is printing a moving number as a fixed
promise. `cortex limit` prints the ceiling and then what is left of it, from
whichever source has the truth: the live kernel's process table for a running
agent, the exit record for one that has finished (docs/COOKBOOK.md).

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

**And the supervisor says what it did.** A daemon's stdout is its log —
systemd's journal and launchd's log collect it — so the decisions init makes
about a daemon have to be *there*. They used to be nowhere: the decisions were
made and recorded in init's own log, but nothing told the operator. A daemon
that crashed three times and was then given up on printed its registration
line and nothing else, and the terminal said "running" while the agent was
dead and never coming back.

Init now reports each decision to the host
(`KernelOptions.onDaemonDecision`), and the CLI prints it:

```console
$ cortex daemon run crasher
[daemon crasher pid 2] running (restart=on-failure)
[daemon crasher] attempt 1 exited (code 1: boom) — restarting as pid 3 (attempt 2)
[daemon crasher] attempt 2 exited (code 1: boom) — restarting as pid 4 (attempt 3)
[daemon crasher] attempt 3 exited (code 1: boom) — not restarting: gave up after 2 restart(s) (max-restarts: 2)
```

Every decision is reported, including the one that says nothing will happen:
a daemon that exits cleanly under a `never` policy is gone for good, and that
is exactly what the operator has to be told.

**And the journal is readable.** Init's own log is the *durable* record of
those decisions — it survives the shell that was watching. It used to be
unreadable in practice: every frame in it was called `__init`, so the log of
a supervisor that restarted three times read as three identical lines, and
the action that distinguished them was buried in `args`. The frames now
carry their action in the view (`__init:restart`, `__init:restart-gave-up`,
`__init:reap`), so `cortex trace 1` is a readable supervision journal
(ABI.md §6.1 for the naming rule).

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
  | { kind: 'sleep';  until: string }
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
  readonly maxRestarts?: number;    // default Infinity. Cap on RUNS, despite the
                                    // name: init gives up once restartCount has
                                    // reached it, and restartCount advances when
                                    // the restart is decided. So 2 => two runs
                                    // (one initial, one retry).
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
  readonly memory?: Record<string, MemoryRegionPolicy>;  // per-region policy; may set maxEntries (CLI: --memory <json>, merged over defaults)
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
