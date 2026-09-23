# Hacker News — "Show HN" draft

**Title options** (pick one; HN strips editorializing after the colon):

1. `Show HN: Cortex – An operating system for AI agents`
2. `Show HN: Cortex – Treat AI agents as processes, not functions`
3. `Show HN: A kernel that gives AI agents PIDs, fork, and checkpoint/restore`

**URL:** `https://github.com/Jackeven02/cortex-os`

---

## Body

Hi HN. Cortex is a small TypeScript kernel that gives AI agents the primitives
Unix gave programs in the 1970s — PIDs, fork, signals, IPC, checkpoint/restore,
supervision trees, syscall traces, resource budgets — instead of the *"call a
function, get a result"* model every agent framework uses today.

The one-line thesis: **today an agent is a function; Cortex makes it a
process.** A process has identity that outlives its caller, a parent that
supervises it, a log of everything it did, and the ability to be paused,
forked, and resumed.

**What actually runs today** (v0; `npm install`; everything below runs offline
against a deterministic mock driver, no API key):

- **Process control:** `spawn`, `ps`, `kill` (13 signals), `wait` — including
  `wait(pid, { timeoutMs })`, which lets a supervisor bound a child and act on
  the timeout *inside the supervisor*, no external orchestrator.
- **State:** `fork` (cognitive fork), `checkpoint`, `restore`. A fork's result
  carries the byte offset where two branches diverge, which `cortex diff` uses
  to align their syscall logs.
- **Cognition / memory / IPC:** `llm_call`, `tool_call`, `memory_read/write`,
  `send`, `recv`, `sleep`, `now`, `random`, `on_signal`, `budget`.
- 11 kernel modules, 24 syscalls, 7 drivers (mock/deepseek/openai LLMs;
  filesystem + MCP tools; inmem + sqlite memory), 479 assertions in the test
  suite.

**Three demos, each reproducible end-to-end from the README:**

1. **Pause across reboots.** An inbox-watcher checkpoints mid-run and suspends.
   The machine reboots (kernel torn down, snapshot on disk). `cortex restore`
   brings it back as a *new PID* with memory rehydrated, and it skips the work
   it already did. (GIF in the README.)
2. **Fork and compare.** A coder reaches a decision point, forks, and the two
   branches each take a different approach. `cortex diff` reads the fork's
   shared-causal-past offset out of the parent's log and aligns only the two
   tails.
3. **Supervision tree.** A planner spawns three coders; one hangs; the planner
   notices via a bounded `wait`, kills it, respawns it, and assembles the
   result — ~40 lines of ordinary `async`/`await`, no orchestrator.

**Where I'd push back on myself — the honest v0 gaps** (all in the repo, not
hidden):

- A checkpoint captures the process *image* — memory, budgets, lineage — **not
  the live JS call stack.** A restored agent re-runs from the top and skips
  completed work via a memory marker. True continuation capture is post-v0.
  This is the sharpest limitation; I'd like to be argued out of the design or
  into a better one.
- `attach` follows the on-disk syscall log; the interactive *"pipe stdin into a
  live agent"* half needs a first-class long-running kernel. `cortex daemon run`
  supervises a long-lived agent today, but the CLI is otherwise a
  short-lived-process model.
- Single host, single process. No distribution, no k8s.

The design docs came before the code, deliberately — `STATE.md` (*"what does
`fork()` actually copy?"*) was written first, because it's the hard part and a
wrong state model costs a rewrite. They're in the repo and are the source of
truth.

**Why not Temporal / LangGraph / k8s?** Short version: Temporal makes a
*human-written* workflow durable — the decision graph is declared up front.
LangGraph runs a *static* graph. In both, an agent that decides at runtime
*"spawn three sub-agents, wait, merge"* doesn't fit, because the spawning **is**
the decision. Cortex's bet is that the "graph" is just the shape the process
tree happens to take at runtime.

There's nothing here a determined person couldn't build on top of a
durable-execution engine. The bet is that the abstraction — the
syscall/process/signal discipline — is the thing worth getting right, and that
it's small enough (the kernel is a few thousand lines) to actually read.

Repo: `https://github.com/Jackeven02/cortex-os`

I'd genuinely like the harshest critique — especially on the fork/checkpoint
semantics, and on whether "agent as process" earns its keep or is a metaphor
that collapses under real workloads.

---

## Posting notes

- **First comment (post yourself, immediately):** the single most convincing
  30-second artifact — the Demo B transcript (spawn → checkpoint → reboot →
  restore → `inbox cleared (6/6)`). HN readers often don't click through; give
  them the payoff in the thread.
- **Have ready before posting:** answers to *"how is this different from
  Temporal?"*, *"doesn't Erlang already do this?"*, *"why TypeScript?"*,
  *"what's the actual kernel LOC?"*, *"can I run two agents on one box?"*
  (answer honestly: one kernel per state dir, no cross-kernel IPC yet).
- **Don't** say "revolutionary", "game-changing", or "10x". State what it does.
