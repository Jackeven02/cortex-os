# The Cortex Manifesto

*An operating system for AI agents.*

> **Status:** v0 design phase. Nothing here works yet. Everything here is the point.

---

## I. The Batch Era

Every "agent framework" today treats an agent as a **function**. You call it with a task. It runs to completion. It returns. There is no concept of an agent that exists across time. No concept of two agents sharing work. No concept of pausing, resuming, forking, killing. No resource limits. No permissions. No supervision.

We have been here before.

In 1965, you submitted a job to a mainframe and waited for the operator to hand back a printout. In 1975, Unix gave us the **process** — a running program as a first-class entity with identity, state, lifetime, parents and children. Computing became composable. Everything that followed — the network, the workstation, the cloud, the phone — was built on top of that abstraction.

AI agents are still in the batch era. They are jobs, not processes. They are scripts, not citizens of an operating system.

**Cortex is the Unix moment for AI agents.**

---

## II. What We Believe

### 1. An agent is a process, not a function.

It has identity (PID). It has state (memory, attention, intent). It has a lifetime that can outlive its caller. It can be spawned, paused, forked, signaled, killed, checkpointed, restored. It can have a parent that supervises it and children that it supervises. When it dies, its parent reaps it. When its parent dies, it is reparented to `init`.

This is not a metaphor. This is the actual abstraction.

### 2. Syscalls over magic.

Every interesting thing an agent does is an explicit syscall: `llm_call`, `tool_call`, `memory_read`, `memory_write`, `spawn`, `send`, `recv`, `checkpoint`, `restore`. Each one is logged. Each one can be intercepted, mocked, rate-limited, denied.

We reject the AI-magic school of framework design where *"the agent decided to..."* is treated as an explanation. No. The agent called `tool_call(grep, "TypeError")` at 14:23:04 UTC, and we have the receipt.

### 3. Small kernel, big userland.

The Cortex kernel fits in **3,000 lines of TypeScript**. Everything else is a user-space program.

- LLM providers are drivers.
- Tool protocols (MCP, OpenAPI, custom) are drivers.
- Memory backends (SQLite, Qdrant, files) are drivers.
- Agent harnesses — dsh, LangChain, AutoGen, smolagents — are **user-space runtimes**, like Python or Node running on Linux.

They should run *on top of* Cortex, not compete with it. A kernel that does too much is a kernel that does everything badly.

### 4. Composition is the killer feature.

A system where you can pipe `planner | coder | reviewer` like Unix pipes, where one agent can spawn and supervise a hundred children, where any agent at any point can `fork()` and try an alternative path — that system can do things no monolithic framework can ever do.

Unix won not because it was smarter, but because everything was composable. Cortex bets on the same horse.

### 5. Determinism is non-negotiable.

Every syscall is recorded. Every state transition is logged. Every execution is replayable. Every point in time is forkable.

Debugging an agent should not be harder than debugging a normal program. If you cannot answer *"why did it do that?"* with a stack trace and a syscall log, you do not have a system. You have a slot machine.

### 6. Boring technology.

TypeScript, because it is everywhere. SQLite, because it is reliable. POSIX-shaped abstractions, because they carry 50 years of accumulated wisdom.

We are not here to invent a new programming language, a new database, or a new model of computation. We are here to apply the **existing** model of computation to a domain that has somehow been operating without it.

### 7. Build in the open.

Every design decision documented in the repo. Every mistake recorded in git history. Every argument resolved in a public issue. The repository is the source of truth, not a private Slack channel.

If you cannot read the source, you do not understand the system.

---

## III. What We Reject

**Kitchen-sink frameworks.** LangChain taught a generation that an agent framework should have two hundred abstractions: chains, agents, tools, retrievers, memory, callbacks, outputs, parsers, embeddings, vectorstores, document loaders, text splitters, and so on forever. The right number of abstractions is closer to twelve. We will name them, define them precisely, and stop.

**Hidden state.** If your framework's behavior depends on internal state you cannot inspect, modify, or version-control, it is not a framework. It is a black box with extra steps.

**Vendor lock-in.** Cortex runs on any LLM provider, any tool protocol, any memory backend. The driver interface is the contract. If a vendor cannot be plugged in, that is a bug in our driver model — not a feature of the vendor.

**"AI does it for you" UX.** Cortex is for builders who want to *understand and control* their agents. If you want magic, there are excellent products for you. They are not us.

**Premature distribution.** No Kubernetes operator. No managed cloud service. No SaaS. No funding round. The kernel runs on a laptop, or it does not run.

---

## IV. Why Not...

Cortex is not the first project to want durable, composable, debuggable agents. You will reasonably ask why we exist when these do.

**Why not Temporal?**
Temporal is excellent at durable execution — but its model is *"a human writes a workflow as code; the engine guarantees the code survives crashes."* The decisions are pre-determined by the programmer; the engine just makes them reliable. Cortex's model is different: **the agent makes decisions at runtime, via LLM syscalls.** The decision graph is emergent, not declared. You could absolutely build Cortex on top of Temporal as a persistence backend — that is a driver decision, not an architecture decision.

**Why not LangGraph?**
LangGraph builds graphs. You declare nodes and edges; it runs them. But the topology is fixed at code time. An agent that decides *"I am going to spawn three sub-agents, wait for them, then merge their findings"* cannot be a static graph — the spawning is itself a runtime decision. Cortex says: there is no graph. There are processes. They spawn each other dynamically. The "graph" is whatever shape the process tree happens to take at runtime.

**Why not Kubernetes?**
Kubernetes supervises containers, not cognition. It can restart a pod, but it cannot tell you why an agent decided to call a tool. It has no concept of LLM budgets, tool side effects, or reasoning state. You can run Cortex on k8s. Each Cortex kernel becomes a pod. K8s does not know or care what is inside.

**Why not just a library?**
We *are* a library — TypeScript, installable from npm. The "OS" framing is not about deployment shape. It is about **abstraction discipline**. Syscalls, processes, signals, IPC: these are concepts with fifty years of refinement. We are inheriting that refinement instead of inventing new abstractions. A library that calls itself an OS is making a promise: the abstractions are universal, composable, and small enough to fit in your head. We intend to keep that promise.

**The position nobody has occupied** is the one we are taking: **the first system to treat LLM decisions as first-class schedulable units.** Not as steps in a human-declared workflow. Not as containers in a cluster. As processes — with all the discipline that word implies.

---

## V. What Success Looks Like

**In 12 months.** A hacker in Shenzhen spawns a Cortex daemon to watch her inbox, another to review her PRs, a third to draft her weekly report. They run on a $5 VPS. They survive reboots. They talk to each other through IPC, not through a Slack integration. Total monthly LLM cost: $12. None of them are LangChain agents. She wrote forty lines of TypeScript.

**In 3 years.** Every serious agent product runs on Cortex or a Cortex-derived kernel. *"Is it Cortex-compatible?"* is a question developers ask before adopting any agent tool. The syscall ABI is documented in three languages. There is a small conference. There are at least two academic papers citing the design. There is a healthy ecosystem of third-party drivers.

**In 10 years.** Someone writes a history of AI infrastructure. Cortex gets a paragraph. Maybe two.

---

## VI. Who Should Join

- Systems people who looked at LangChain and thought *"this is not how computers work."*
- Agent developers tired of rewriting the same orchestration glue for every project.
- OS nerds who want a new playground where the abstractions actually matter.
- Researchers who want a deterministic, replayable substrate for studying agent behavior.
- Philosophers who want to argue about what an agent is — with people who will build it.

---

## VII. What Comes Next

This document is the **why**. The next documents are the **how**:

| Document | Purpose | Status |
|---|---|---|
| `docs/STATE.md` | What agent state *is*; fork & checkpoint semantics | **drafted — read this first** |
| `docs/ABI.md` | The syscall contract, in TypeScript types | pending |
| `docs/PROCESS.md` | The agent lifecycle and state machine | pending |
| `docs/ARCHITECTURE.md` | Kernel modules and data flow | pending |
| `BACKLOG.md` | The first issues, prioritized | live |

Then code.

---

*Cortex is a working title for a working idea. If you have read this far and your fingers are itching to argue, open an issue. We will read every one.*
