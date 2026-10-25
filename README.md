# cortex

> An operating system for AI agents.

[![release](https://img.shields.io/badge/release-v1.2.0-brightgreen)](./CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![runtime](https://img.shields.io/badge/runtime-TypeScript%20%2F%20Node%2022%2B-3178c6)](./package.json)

**English** | [简体中文](./README.zh-CN.md)

**Today's agent frameworks treat an agent as a function. Cortex treats it as a process.**

PIDs. Fork. Exec. Signals. IPC. Checkpoint. Restore. Supervision trees. Syscall traces. Token budgets. Process groups. Everything Unix gave to programs in 1975, applied to agents in 2026.

Read the **[Manifesto](./MANIFESTO.md)** first. It is short, opinionated, and explains why this project exists.

---

## What it will look like

```bash
# Spawn an agent as a background process
$ cortex spawn --role coder --task "fix issue #42"
[pid 1234]

# Inspect the process tree
$ cortex ps
PID  PPID  ROLE            STATE    TOKENS      CAPS  AGE  NOTE
---------------------------------------------------------------
1    -     init            running  0 of ∞      all   19s
2    1     holder          blocked  0 of 20.0k  all   19s  a channel — SIGTERM queued
3    1     planner         blocked  0 of ∞      all   19s  child 6 — SIGCHLD queued
4    3     coder:overview  zombie   0 of ∞      all   2s   exit 137 (signal:SIGKILL)
5    3     coder:install   zombie   0 of ∞      all   2s   exit 137 (signal:SIGKILL)
6    3     coder:api       blocked  0 of ∞      all   19s  a timer

# Same processes, as the tree they actually are — and what each is waiting
# on, and for how long. AGE is how long each one has lived: the two that
# finished show the lifetime the kernel recorded for them (2s), and it stops
# growing there — the running ones are still aging (19s).
$ cortex top
cortex top — 6 processes · 3 blocked · 2 zombie · 1 running · live kernel
0 tokens · $0.000000 spent · home .cortex

      PID  ROLE            STATE    TOKENS      USD                     AGE  NOTE
---------------------------------------------------------------------------------
      1    init            running  0 of ∞      $0.000000 of ∞          19s  3 syscalls
├─    2    holder          blocked  0 of 20.0k  $0.000000 of $1.000000  19s  waiting on a channel for 18.8s — SIGTERM queued
└─    3    planner         blocked  0 of ∞      $0.000000 of ∞          19s  waiting on child 6 for 18.8s — SIGCHLD queued
   ├─ 4    coder:overview  zombie   0 of ∞      $0.000000 of ∞          2s   exit 137 (signal:SIGKILL)
   ├─ 5    coder:install   zombie   0 of ∞      $0.000000 of ∞          2s   exit 137 (signal:SIGKILL)
   └─ 6    coder:api       blocked  0 of ∞      $0.000000 of ∞          19s  waiting on a timer for 18.8s

trace one:   cortex trace <pid>      follow one:  cortex attach <pid>

# ...and the ones that are stuck, with the command to act on them
$ cortex top --stall-after 5000
# pid 2 has been inside recv for 18830ms — over your 5000ms threshold.
#   cortex supervise 2 --kill-after 5000
# pid 3 has been inside wait for 18821ms — over your 5000ms threshold.
#   cortex supervise 3 --kill-after 5000

# What may this agent spend, in total — and how much of that is left
# (a running agent's budget lives in the kernel, so this needs a live kernel:
#  `cortex daemon run` — a finished one is answered from its exit record)
$ cortex limit 1234
pid 1234 (coder):
  tokens:    spent 12300 / limit 20000 (7700 left)
  usd:       spent $0.014000 / limit $1.000000 ($0.986000 left)
  wall time: spent 120000ms / limit ∞
$ cortex limit 1234 --tokens 20000   # the ceiling is 20000 — not a top-up
set the budget for 1234 (coder):
  tokens:    spent 12300 / limit 20000 (7700 left)

# Follow a running agent's syscall stream (push, when a kernel is running)
$ cortex attach 1234
# attach .cortex/processes/1234/log.crec (live — frames by push from the kernel)
time          pid     syscall                                                    phase  duration   reversibility
----------------------------------------------------------------------------------------------------------------
14:23:01.402  1234    memory_read                                                 exit   -          idempotent
14:23:04.115  1234    llm_call                                                   exit   2523ms     reversible
14:23:06.221  1234    __state:running->exiting(exit)                             exit   -          idempotent
# pid 1234 exited with code 0 (completed)
# detached
# (with a live kernel running: cortex attach 1234 --interactive
#  delivers each line of stdin to the running agent)

# Fork state to try an alternative path
# (a fork snapshots a *running* process, so this needs a live kernel:
#  `cortex daemon run` — the child stays in that kernel)
$ cortex fork 1234 --tag "try the other way"
forked pid 1234 → child pid 1240
  chain: 7c1f0f2e-...
  shared causal past at offset: 18244
$ cortex send 1240 "try dynamic programming instead"

# Compare the two branches and pick a winner
$ cortex diff 1234 1240

# Re-run a recorded agent — or a whole supervision tree — and see whether it
# still behaves the same way. The model, the tools, the clock and the RNG all
# answer from the recording, so the comparison is about the agent, not about
# the world. Every process answers from its OWN recording.
$ cortex replay 1234
  recording: 2 process(es) — pid 1234, pid 1235
  pid 1234: recording 23 call(s), replay 23 call(s)
  pid 1235: recording 4 call(s), replay 4 call(s)
  REPRODUCED — every process made the same calls, in the same order,
  with the same outcomes.
# (and when the agent's code has changed since, it says where — and which
#  process changed:
#  DIVERGED — pid 1235 did not reproduce the recording.
#  #3 changed
#      the request differs at request.messages[1].content
#        recorded: "summarise the diff"
#        replay:   "summarise the log")

# Trace every syscall
$ cortex trace 1234
# tracing .cortex/processes/1234/log.crec
time          pid     syscall                                                    phase  duration   reversibility spend
----------------------------------------------------------------------------------------------------------------------
14:23:01.402  1234    llm_call                                                   exit   2523ms     reversible    $0.000161 · 1.2k in / 80 out (900 cached)
14:23:04.115  1234    tool_call                                                  exit   -          irreversible
14:23:06.221  1234    __state:running->exiting(exit)                             exit   -          idempotent
# 3 record(s)
# (the kernel's own frames are named too — and they say *why*:
#  __state:running->blocked(recv), __state:new->ready(spawn),
#  __init:restart-gave-up, __sched:parked(recv), __signal:SIGTERM(queued) — so a log
#  reads as the story it is, not a row of anonymous placeholders)
# (and a call that spent something says what it spent — the price first, then the
#  tokens it read and wrote, and the part of the input that came out of the
#  cache. A frame that spent nothing says nothing: an empty cell is honest,
#  "$0.000000" would be a claim)

# Read back what a process printed (kept per process, not mixed into the
# daemon's stdout — stdout and stderr are tagged separately)
$ cortex logs 1234
2026-10-23T14:23:01.402Z | out | [coder] starting on issue #42
2026-10-23T14:23:06.115Z | err | [coder] grep timed out, retrying
# (--tail 20 for the last 20 lines; --follow streams a live agent's lines by
#  push, and ends by itself when the agent ends)

# Read back what a running process KNOWS — its memory regions.
# The syscall log stores a hash of a memory value, not the value, so
# `cortex trace` can show that the agent wrote something down and never what.
# The table also says how much each region MAY hold: LIMIT is the write-count
# ceiling the kernel enforces with ENOMEM, and WRITES is the count it is
# measured against (ENTRIES is a different number — how many keys it holds).
# And it says who may WRITE: ACCESS is this process's own right to write
# (a read-only region traps EPERM), and each peer in SHARED WITH carries its
# own — sharing is not writing.
$ cortex memory 1234
# memory of pid 1234 (coder)
REGION          KIND      BACKING     ACCESS     ENTRIES   WRITES    LIMIT     SHARED WITH
------------------------------------------------------------------------------------------
episodic        cow       inmem       read-write 0         0         100       -
semantic        shared    inmem       read-write 2         3         ∞         1240 (read-only)
procedural      private   inmem       read-write 0         0         ∞         -
$ cortex memory 1234 semantic
# memory of pid 1234 (coder) — region 'semantic' (read-write)
issue:42     "found it — src/foo.ts:42"  2026-10-23T14:23:04.881Z
last_result  "ok"  2026-10-23T14:23:06.115Z
# 2 entries

# Wait for a process to end — and get its REAL exit code
# (the exit code is the child's own, so `cortex wait 2 || echo failed` works)
$ cortex wait 1234
pid 1234 exited with code 0 (finished the task)

# Watch the kernel live — every syscall frame, as it happens.
# These are the same frames `cortex trace` reads, pushed instead of polled.
$ cortex watch --pid 1234
# watching the kernel event stream (Ctrl-C to stop)
time          pid     syscall                                                    phase  duration   reversibility spend
----------------------------------------------------------------------------------------------------------------------
19:50:09.072  1234    sleep                                                      exit   64ms       idempotent
19:50:09.077  1234    __state:running->blocked(sleep)                            exit   -          idempotent
19:50:09.138  1234    __state:blocked->ready(wait-return)                        exit   -          idempotent
# pid 1234 exited with code 3 (probe finished on purpose)

# Supervise a live agent: kill it if it stops making progress, and put
# a fresh one in its place. "Stuck" is read off the syscall log, not off
# silence — a sleep is a declared wait, not a stall. The replacement is
# the same agent: it gets the authority the original held, not more.
$ cortex supervise 1234 --kill-after 30000 --restart
# pid 1234 has been inside recv for 1588ms — killing it
# pid 1234 exited with code 137 (signal:SIGKILL)
# restarted as pid 1240 (role=coder, caps=all)

# If the kernel dies underneath a watcher, the CLI says so — and refuses to
# pretend the watch finished.
$ cortex watch
cortex watch: the connection to the kernel was lost — it looks like the kernel died (connect ECONNREFUSED 127.0.0.1:60869)
  the watch did not finish — it lost the kernel it was watching.

# Pause and resume across reboots
# (a checkpoint captures a live process, so this needs a live kernel:
#  `cortex daemon run` — and SIGUSR2 means "checkpoint now")
$ cortex checkpoint 1234 --tag "before risky edit"
$ cortex kill 1234
# ... next day ...
$ cortex restore --tag "before risky edit"
[restored as pid 1502]

# ...or put the snapshot back into a kernel that is still running, so the
# restored agent keeps working after the command exits
$ cortex restore --live --tag "before risky edit"
[pid 1503]
  restored into the live kernel — it keeps running after this command

# Register a long-running agent to start on boot, and supervise it
$ cortex daemon install inbox-watcher --role inbox-watcher \
    --module ./examples/checkpoint-agent.ts --restart on-failure
[daemon inbox-watcher] installed (role=inbox-watcher, restart=on-failure)
$ cortex daemon run inbox-watcher
[daemon inbox-watcher pid 2] running (restart=on-failure)

# start another agent *inside* that running kernel, from the shell
$ cortex spawn --live --role extra --module ./examples/listener-agent.ts
[pid 3] spawned into the live kernel — it keeps running after this command

# ...and stop the kernel again, from the shell
$ cortex daemon stop
daemon stop requested
```

Most of this works now — `spawn`, `ps`, `kill`, `trace`, `attach`, `fork`, `diff`, `replay`, `checkpoint`, `restore`, `send`, `limit`, `audit` and `daemon` are implemented and covered by the smoke suite. `attach` follows one agent's syscall stream — by push when a live kernel holds the process (median lag 1 ms, and the follow ends by itself when the agent does, with its real exit code), and by tailing the log file when there is no kernel; with a live kernel running it also delivers your keystrokes to the agent (`--interactive`); `cortex daemon run` is the real long-lived supervisor (BACKLOG #039) and is what makes a live kernel reachable in the first place — with one, `cortex send` delivers into a running agent, `cortex kill` delivers a real signal, `cortex checkpoint <pid>` snapshots a running agent, `cortex spawn --live` starts a *new* agent inside that kernel, `cortex restore --live` puts a snapshot back into it, `cortex fork <pid>` clones a running agent into a second branch you can drive and diff, and `cortex daemon stop` shuts it down again. `cortex top` reads each live process's log the same way `cortex supervise` does, so the view and the command that acts on it cannot disagree — with `--stall-after <ms>` it marks what is over *your* threshold and hands you the command to run. It also says **which signals are queued** for a process: a `kill` aimed at a wedged agent is not delivered but queued, waiting for a wake-up that may never come, and the view says so instead of leaving it to the command that sent it. And `cortex limit` reaches a running agent's budget — a budget is a thing the *kernel* holds, so the command asks the kernel that holds the process rather than a kernel of its own that holds nothing but init — and it names the **ceiling** (what the process may spend in total) apart from what is left of it, because a remainder that shrinks under your feet is not a limit. `--tokens N` sets that ceiling; a finished process refuses to have its budget rewritten, because what it spent is the kernel's record. The tables keep their shape, too: a column is as wide as the widest value in it, a value that does not fit is cut **and marked** (`…`), and `cortex ps` and `cortex top` say the same number for the same spend. And a token count says which part of it the provider served out of its cache — `1.2k (300 cached)` — because those tokens are billed at the cache price rather than the fresh one, and no view used to say so. And the kernel's own frames say **why** — `__state:running->blocked(recv)` is not just a transition, it is a transition with a cause, and `__state:running->exiting(SIGTERM)` names the signal that did it. All seven drivers (LLM, MCP, filesystem, memory) ship. See [BACKLOG.md](./BACKLOG.md) for what is done and what comes next.

---

## Install

```bash
npm i -g cortex-agent-os     # puts `cortex` and `ctx` on your PATH
cortex help
```

Or without installing anything:

```bash
npx cortex-agent-os help
```

Requires **Node 22+**. One runtime dependency (`cborg`, for the syscall log), and
no API key is needed to try it — the mock driver is deterministic and offline.

`examples/` ships **inside the package** — compiled to plain JS in
`dist/examples/`, so the demos below run for a real `npm i` user with no extra
flags and no Node-version caveats (`cortex example hello` works on every Node in
`engines`). The `.ts` sources are also included and run straight from a clone
with `tsx`. If you would rather not think about it at all, `cortex spawn --role
coder --task "..."` needs no module file — `cortex` has a built-in prompt agent.

Working on Cortex itself instead? Clone it and run the suite:

```bash
git clone https://github.com/Jackeven02/cortex-os
cd cortex-os && npm install
unset OPENAI_API_KEY DEEPSEEK_API_KEY   # fall back to the deterministic mock
npx tsx scripts/smoke.ts                # 824 assertions, 0 failures
```

> **The npm package is `cortex-agent-os`, not `cortex-os`.** npm refuses the
> shorter name as too similar to the already-registered `cortexos` — the two are
> identical once punctuation is stripped. The repository name did not change, and
> neither did the binaries: you still type `cortex`.

---

## Status

**Released as [`v1.0.0`](./CHANGELOG.md)** (2026-09-23) — **the syscall ABI is frozen.**

Everything through `0.2.1` was building the thing and then closing the gaps the documents had promised: `sleep()` really parks a process, a restored process runs on its own, the synchronous syscalls are recorded, the persistence layout is the per-process subtree ARCHITECTURE §7 described, and `cortex top` shows what a blocked process is waiting on.

`1.0.0` is a different kind of release — it settles the contract. Two things the ABI had explicitly deferred to "v1" are now in:

- **Capabilities (§4.9)** — `acquire` / `release` / `caps` over a closed set of six (`spawn`, `kill`, `fork`, `tool:dangerous`, `ipc:any`, `admin`). A process can now run with *less* authority than the kernel would give it. The default is full privilege, not least privilege, because defaulting to least privilege would turn every pre-1.0 agent into an `EPERM` trap; you narrow a child explicitly at `spawn`. Two gates are conditional by design: killing your own children and calling reversible tools never need a capability — otherwise `kill` would be handed to every supervisor and mean nothing.
- **Explicit channels (§4.5)** — `channel_open` / `channel_close`. Implicit creation on `send` is kept for compatibility, but it is no longer the only way to get a channel, and a typo'd channel name no longer silently mints one nobody reads.

That is 24 syscalls, up from 19. **From here:** breaking changes need a major bump; additive changes land in a minor. See [ABI.md §"ABI status"](./docs/ABI.md).

**Phase 0 — Design (complete).** Four documents drafted v0: `STATE.md` (the hard part), `PROCESS.md` (lifecycle), `ABI.md` (syscall contract), `ARCHITECTURE.md` (kernel modules). Open questions in each doc are logged and resolve as implementation forces decisions.

**Phases 1–3 — largely complete.** The kernel boots; all thirteen kernel modules plus the driver registry are in; all seven drivers ship (mock / deepseek / openai LLM, MCP and filesystem tools, inmem and sqlite memory); most of the CLI works. `cortex spawn → llm_call → exit → reap` runs, and checkpoint/restore survives across separate CLI invocations. Known v0 gaps are recorded honestly in [BACKLOG.md](./BACKLOG.md), not hidden.

**Phase 4 — Killer demos.** All three are polished and captured as replays. Demo A (supervision tree): coders each generate one section of a README for a fictional library (see `examples/supervision-tree.ts`, [`docs/demo-a.html`](./docs/demo-a.html)). Demo B (pause across reboots): an inbox-watcher classifies tickets, checkpoints mid-run, and resumes after a reboot (see `examples/checkpoint-agent.ts`, [`docs/demo-b.html`](./docs/demo-b.html)). Demo C (fork and compare): a coder forks to explore two dedup strategies in parallel, then `cortex diff` lines up the branches so you keep the winner (see `examples/fork-compare-agent.ts`, [`docs/demo-c.html`](./docs/demo-c.html)). `cortex attach` ships as a follow-mode syscall trace (BACKLOG #031) and, with a live kernel, as an interactive session too; `cortex daemon install/run` registers and supervises long-lived agents and publishes the kernel's endpoint, which is what makes the running agent reachable (BACKLOG #039). **Phase 3 is now complete** — every command in the demo above works.

Demo A is worth calling out because it changed the kernel: agents used to run to completion inside the quantum that dispatched them, so a parent parked in `wait()` held its own tick and its children could never run — `wait()` deadlocked by construction, and a supervision tree could not be written at all. The continuation is now cooperative (see PROCESS.md §8.2), so this works with no orchestrator:

**Live replay: [`docs/demo-a.html`](./docs/demo-a.html)** — a self-contained, dependency-free page that replays the captured syscall log frame by frame.

The planner spawns three coders, each of which generates one section of a real README for a fictional library ("tinylog") and publishes it to a shared `semantic` memory region. One coder ("api") hangs — a model call that never returns — so the planner notices a bounded `wait`, kills it, spawns a replacement, and assembles the finished README from the three sections:

```bash
$ cortex example supervision-tree        # or: cortex example demo-a
[planner pid 2] spawning 3 coders (tinylog README)
[coder api pid 5] slow model — will miss its deadline
[planner] api (pid 5) missed its 8000ms deadline — killing
[coder api#2 pid 6] generating section: api
[planner] overview=ok(0) install=ok(0) api=respawned(0)
[planner] assembled README.md: # tinylog / ## Overview / ## Install / ## API
process exited (code 0: planner complete: overview=ok(0),install=ok(0),api=respawned(0))
```

Demo B makes the reboot story concrete. A checkpoint captures the *process image* — memory regions, budgets, lineage — not the live JS stack, so on `restore` the agent re-runs from the top and skips already-handled tickets by reading its own `episodic` marker (the documented idempotency pattern, not a kernel feature). The result is a long-running agent that survives a power cycle with zero work lost:

**Live replay: [`docs/demo-b.html`](./docs/demo-b.html)** — the checkpoint and reboot, replayed frame by frame.

The inbox-watcher classifies each ticket (`bug` / `feature` / `question`), drafts a reply into the shared `semantic` region, and records the processed id in `episodic`. After three it checkpoints and detaches; after a reboot, `cortex restore` re-materialises it as a new PID, it reads back the `done` set, skips the three it already handled, and finishes the queue:

```bash

$ cortex example checkpoint-agent        # or: cortex example demo-b
[inbox-watcher pid 2] 6 tickets in queue
[inbox-watcher pid 2] #T-1180 App crashes on launch after the 2.3 update -> bug; reply drafted
[inbox-watcher pid 2] #T-1181 Can I export my data to CSV? -> feature; reply drafted
[inbox-watcher pid 2] #T-1182 How do I reset my password? -> question; reply drafted
[inbox-watcher pid 2] 3/6 handled — checkpointing (tag 'inbox-watcher') before shutdown
process suspended at checkpoint
###  laptop reboots - kernel torn down, .csnap persists on disk  ###
$ cortex restore --tag inbox-watcher
[inbox-watcher pid 3] recovered 3 processed ticket(s) from memory
[inbox-watcher pid 3] skip T-1180 (already handled)
[inbox-watcher pid 3] skip T-1181 (already handled)
[inbox-watcher pid 3] skip T-1182 (already handled)
[inbox-watcher pid 3] #T-1183 Dark mode flickers on Windows 11 -> bug; reply drafted
[inbox-watcher pid 3] #T-1184 Please add keyboard shortcuts for navigation -> feature; reply drafted
[inbox-watcher pid 3] #T-1185 I was charged twice this month -> bug; reply drafted
[inbox-watcher pid 3] inbox cleared (6/6)
process exited (code 0: inbox cleared)
```

Demo C is the atom of *agent search*: reach a decision point, `fork` to explore every branch at once, then `diff` and keep the winner. The coder commits to a requirement, forks, and the two branches each take a different dedup design (a counting Bloom filter vs an LRU-bounded hash set) — the child re-runs from the top and knows it is the fork because a `forked` marker was written *before* the fork (see the example header for the full pattern). The kernel guarantees the two tails diverge cleanly, and `cortex diff` aligns them from the shared causal past:

**Live replay: [`docs/demo-c.html`](./docs/demo-c.html)** — both branches interleaving, then the `diff`.

```bash
$ cortex example fork-compare-agent      # or: cortex example demo-c
[parent 2] forked as pid 3 — branch A: counting bloom filter
[branch A pid 2] {"approach":"counting bloom filter","spaceComplexity":"O(k) bits, ...}
[branch B pid 3] resumed from the fork's snapshot
[branch B pid 3] {"approach":"lru-bounded hash set","spaceComplexity":"O(cap) entries, ...}
process exited (code 0: branch A complete)

$ cortex diff 2 3
  diverged after 7 shared syscall(s) — fork recorded in pid 2 at byte offset 2307
  syscall diff   (7 shared, - 7 A-only, + 9 B-only)
  - 16:08:15.616  fork         in  {"tag":"dedup-strategy"}
  - 16:08:15.619  fork         out {"childChainId":"8a644ebd-...","c...
  - 16:08:15.620  llm_call     in  {"messages":[{"content":"Design dedup with a counting Blo...
  + 16:08:15.628  llm_call     in  {"messages":[{"content":"Design dedup with an LRU-bounded...
  + 16:08:15.630  exit         out {"code":0,"reason":"branch B complete"}
  summary
    records   19            14      syscalls  15        10
    exit      0 branch A    0 branch B
  last llm_call output
    A: mock reply to: Design dedup with a counting Bloom filter.
    B: mock reply to: Design dedup with an LRU-bounded hash set.
```

---

## The dashboard

`cortex dashboard` serves a dependency-free monitoring console on localhost. It is the one place you can watch a whole process tree breathe — and, with an explicit flag, drive it:

```bash
$ cortex dashboard                  # read-only: watch only
$ cortex dashboard --ops spawn,kill,restore   # allow those three from the UI
```

Read-only by default. With a live kernel in the directory (`cortex daemon run`), the dashboard **watches that kernel**: the processes that are *running* appear in the list — a running process has no `meta.json` yet, so a disk-only view would show a directory of corpses — and the event stream arrives by push, as the kernel writes it. Without one it does what any viewer of a filesystem can do: it reads `.cortex/processes/<pid>/meta.json`, decodes the `.crec` syscall logs (including the logs of processes that are still running), lists checkpoints, and renders the tree. `restore` is a pure disk write, which is why it works even in v0's no-daemon model.

**And the money in it is the money the CLI prints.** The cost panel reads the kernel's microdollar counter, converts it once on the server, and shows dollars — so a process that spent `$0.003400` reads as `$0.003400` here *and* in `cortex top`, instead of one view saying `$3400` and the other saying `$0.0034`. And it is printed at the resolution the kernel counts: one model call costs about `$0.000027`, and that reads as `$0.000027` — not `$0.0000`, which is how a run that spent real money comes to look like a run that spent nothing.

**And the tokens say what was cached.** The provider reports the whole prompt and says how much of it it did not have to read again — and those tokens are billed at the cache price rather than the fresh one. The window says so: the process table prints `1,234 (300 cached)`, the budget panel has a **缓存** column and a **缓存命中** total beside it, and the event table says which part of a single call was cached.

**And the event table shows what a call cost.** `cortex wrap --tap` records the model's own HTTP calls into the same log a driver call goes into, so those calls show up in the event table too — with their tokens and their price, written in the ABI's `usage` shape, the same shape every other reader of an `llm_call` frame looks in.

**And `cortex trace` says it too.** The window was not the only view that could say what a call spent — the CLI's deepest view could not, and it was the view an operator opens to find out what an agent has been doing. Its last column now says what each call spent (`$0.000161 · 1.2k in / 80 out (900 cached)`), and it reads the frame with the same function the event table does, so the two cannot disagree. A frame that spent nothing says nothing: an empty cell is honest, and `$0.000000` would be a claim about a number nobody spent.

**And so does the window's own timeline.** The operator's window has two views of the same frames — the event table and the syscall timeline — and the timeline used to say less than the event table beside it: no cached part (the server was not even reading it), no price (the server sent it and the page dropped it), and `0 out` for a call that never reported how many tokens it wrote. Both now ask one helper for the tokens, and the server reads the frame with the same function the CLI's trace uses — so the terminal, the event table and the timeline all say the same thing about the same call.

**And the timeline reads like the terminal's.** The kernel's own frames are placeholders on disk (`__state`, `__sched`) — the *view* is what distinguishes them: `__state:running->blocked(recv)`, `__sched:sigxcpu(tokens)`. The window prints the same names `cortex trace` does, because both ask the same function.

**And the window shows what the agent knows.** The process dialog had one view of a process — the syscall timeline, which is what it *did*. An agent's memory is what it *knows*, and nothing in the window said a word about it. Now it has two views: click a process, switch to **记忆**, and the window lists its memory regions — name, kind, backing, access mode, entries, writes, ceiling, and the other processes bound to the same region — and clicking a region shows what is inside it: the keys, the values, and when each was written.

It says the same words `cortex memory` says (`read-write`, `read-only`, `∞`, `3 (read-only)`), because the wording lives in one module and each view only chooses how it prints a number. The memory is fetched when you open the panel, not on every refresh of the process table, and without a live kernel the panel says so rather than showing an empty region — a region's contents live in the kernel that owns them, and there is no on-disk copy to read instead.

**And the window says how long each process lived.** Its process table showed the *start time* and nothing else — and a start time is not a duration: for a process that died an hour ago it says nothing at all about how long it lived. There is a **存活时长** column beside it now, and the number is the same one `cortex ps` and `cortex top` print, because the rule lives in one place. A running process is aging, so its number keeps counting up; a finished one is not, so it shows the lifetime the kernel recorded and stops there.

**And the window says what each process spent, in money as well as tokens.** The money used to live only in the budget panel, and that panel rolls it up **by role** — three agents called `coder` became one line with one number on it, so you could see which agent spent the tokens and not which one spent the money. The process table carries a **USD** cell beside the tokens now, in the same words `cortex top` prints (`$0.000250 of $1.000000`), so a cost can be matched to the process that paid it.

**And the window says which calls can be undone.** The kernel tags every frame with what it would take to undo it — `reversible`, `idempotent`, `irreversible` — and the tag is not decoration: it is what traps an irreversible call inside a `forkable` region, and what `cortex audit` reads to surface the tools that never declared one. The event table dropped it, so a tool call that charged a credit card read exactly like a read. There is a **可逆性** column now, between the duration and the cost, in the same words `cortex trace` prints — and the syscall timeline says it too.

**And the window says what a LangChain call spent.** The event table merges two sources — the kernel's syscall frames and the LangChain callback log — and the two used to name a call's tokens differently (`tokensIn`/`tokensOut` against `inputTokens`/`outputTokens`). The window read one set, so half its rows said `—` about calls that had spent tokens: the numbers were on disk, under the other name. Both sources now come out in one shape, so the tokens show up whichever log the event came from.

**And the window says what the agent said.** The process dialog had two views of one process — the syscall timeline (what it *did*) and the memory panel (what it *knows*) — and neither could show the lines the agent printed. That is the first thing you reach for when an agent is behaving strangely: the printed line is the evidence, and everything else is the story around it.

The lines were already kept — one stamped line per printed line in `processes/<pid>/output.log`, relayed by the kernel the moment it is printed, and read back by `cortex logs`. What was missing was a way to *ask* for them from the window. There is a third view now: click a process, switch to **输出**, and the window shows what it said, line by line, with the error stream marked.

The panel re-reads the file rather than trusting a pushed copy of the line, so the window and the log cannot end up saying different things about the same line. When the history is longer than the panel shows, it says so (`12,000 lines in all — showing the last 500`) instead of looking like a process that printed 500 lines — and a process that printed nothing says so too.

**And the window says what a checkpoint holds.** A `.csnap` was the one thing you could **restore** but never **look at**: the panel listed your snapshots and gave you a **恢复** button, with no way to see what you were about to restore. Click the chain id now and the window says who the snapshot was of, when it was taken, how long the agent's conversation had been, what it was still waiting on, the memory it carried, what it had spent **next to the ceiling that spend was measured against**, and the byte in the syscall log it was cut at. The conversation itself is counted, not quoted — the prompts and the model answers stay out of the window, as they do out of the event table. `cortex checkpoint --inspect <chainId>` asks the same question in the terminal.

**And a restored process keeps the ceiling it was given.** A snapshot records both halves of a budget — what the process spent and what was left of the ceiling — and the reader was dropping the second one, so every restored process woke up with the *default* envelope. An agent capped at 1,000 tokens came back **unlimited**, silently. It does not any more.

The three mutating operations are gated because they *do* boot a real kernel to do the work:

- `spawn` — runs a new agent to completion (or until it self-suspends, or `--timeout`). Default cap: 30s, so the HTTP request never hangs.
- `kill` — sends the signal to the process. With no live kernel in the state directory it marks the entry a zombie on disk; with one, the signal is delivered for real through the kernel's signal engine.
- `restore` — writes the snapshot back and re-materialises the process as a new PID.

Ops are fine-grained: `--ops spawn` gives you a spawn button and nothing else. `GET /api/ops` reports what the current server was granted, and each `POST /api/ops/<op>` returns `403` for anything not granted. The server binds to `127.0.0.1` unless `--host` says otherwise, and serves a static, CSP-locked HTML file — no CDN, no build step, zero dependencies. You can also embed it in your own Node app via `cortex-agent-os/dashboard`. Full endpoint reference: [docs/INTEGRATIONS.md](./docs/INTEGRATIONS.md#embedded-dashboard).

---

See **[BACKLOG.md](./BACKLOG.md)** for the full list, prioritized.

---

## Documentation

| Document | What it covers |
|---|---|
| [MANIFESTO.md](./MANIFESTO.md) | Why cortex exists. Start here. |
| [docs/STATE.md](./docs/STATE.md) | **The hard part.** What agent state is, what gets copied on fork, what cannot be copied at all. |
| [docs/PROCESS.md](./docs/PROCESS.md) | Agent lifecycle: 9 states, the legal-transition table, signals, scheduling |
| [docs/ABI.md](./docs/ABI.md) | Syscall contract: 24 syscalls, 3 driver interfaces, error model, recording format |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Kernel modules and data flow: 13 modules, syscall lifecycle, persistence layout, concurrency model |
| [docs/HACKING.md](./docs/HACKING.md) | Contributor guide: dev setup, conventions, how to write a driver / agent / syscall, testing. |
| [docs/COOKBOOK.md](./docs/COOKBOOK.md) | Recipes: supervision trees, pause-and-resume, fork-and-compare, daemons, tools, IPC (+ explicit channels), budgets, least privilege (capabilities), testing. |
| [docs/PUBLISHING.md](./docs/PUBLISHING.md) | Release runbook: pre-flight checks, npm login/publish (and the regional-mirror trap), version bumps. |
| [docs/logo.md](./docs/logo.md) | The mark: why layers + a nucleus + a fork, and which file to use where. |
| [docs/CRITIQUE.md](./docs/CRITIQUE.md) | Running log of external critique and what we changed because of it. |
| [CHANGELOG.md](./CHANGELOG.md) | Release history, the versioning policy, and this release's known limitations. |
| [BACKLOG.md](./BACKLOG.md) | First issues, prioritized |

---

## Design lineage

Cortex is what would have happened if **Plan 9**, **Erlang/OTP**, and **MINIX** had been designed for LLM agents instead of file systems, telecom switches, and teaching kernels.

We borrow shamelessly:

- From Unix: processes, signals, file descriptors, "everything is a file."
- From Plan 9: the syscall as a clean, uniform interface; protocol as the universal solvent.
- From Erlang: supervision trees, hot code reloading, "let it crash."
- From MINIX: microkernel discipline, smallness as a virtue.
- From seL4: the long-term aspiration of formal guarantees.

---

## Contributing

This is a v0 design phase. The most valuable contributions right now are:

1. **Arguments.** Open an issue and tell us why a syscall is wrong, missing, or redundant.
2. **Prior art.** Point us to existing systems (research or production) that already do part of this.
3. **Benchmarks.** Propose workloads the kernel must handle gracefully.
4. **Code.** Once the ABI lands, kernel and driver work will move fast.

If you want to build the OS layer for agents with us, open an issue titled `[hello]` and tell us what you care about.

---

## License

MIT. See [LICENSE](./LICENSE).

---

## A note on the name

A *cortex* is the outer layer of an organ where the interesting work happens — the cerebral cortex, the adrenal cortex, the renal cortex. It is not the whole brain. It is the part that thinks.

That is what this kernel aspires to be: not the whole agent stack, but the thin layer where everything else becomes possible.
