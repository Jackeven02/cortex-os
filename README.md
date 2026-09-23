# cortex

> An operating system for AI agents.

[![release](https://img.shields.io/badge/release-v1.0.1-brightgreen)](./CHANGELOG.md)
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
PID    PPID   ROLE       STATE     TOKENS   AGE
1234   1      coder      running   12.3k    2m
1235   1234   tester     waiting   0        30s
1236   1234   reviewer   blocked   2.1k     10s

# Same processes, as the tree they actually are — and what each is waiting on
$ cortex top
cortex top — 4 processes · 2 blocked · 1 running · 1 zombie
31.4k tokens · $0.0480 spent · home .cortex

1     init             running   0        $0.0000   0 syscalls
└─ 1234 coder          blocked   12.3k    $0.0190   waiting on a model call
   ├─ 1235 tester      blocked   0        $0.0000   waiting on a timer
   └─ 1236 reviewer    zombie    2.1k     $0.0040   exit 0 (completed)

# Follow a running agent's syscall stream (tail -f on its .crec)
$ cortex attach 1234
# attach .cortex/processes/1234.crec (follow-mode)
14:23:01 1234  __state     exit  idempotent
14:23:01 1234  memory_read  exit  idempotent
14:23:04 1234  llm_call     exit  reversible
# (interactive send / live prompt lands with cortex daemon install, #039)

# Fork state to try an alternative path
$ cortex fork 1234
[forked as pid 1240]
$ cortex send 1240 "try dynamic programming instead"

# Compare the two branches and pick a winner
$ cortex diff 1234 1240

# Trace every syscall
$ cortex trace 1234
14:23:01 llm_call(prompt=..., tools=[grep,edit]) -> "I'll search..."
14:23:04 tool_call(grep, "TypeError") -> "src/foo.ts:42"
14:23:06 llm_call(...) -> "Found it, editing now"

# Pause and resume across reboots
$ cortex checkpoint 1234 --tag "before risky edit"
$ cortex kill 1234
# ... next day ...
$ cortex restore --tag "before risky edit"
[restored as pid 1502]

# Register a long-running agent to start on boot, and supervise it
$ cortex daemon install inbox-watcher --role inbox-watcher \
    --module ./examples/checkpoint-agent.ts --restart on-failure
[daemon inbox-watcher] installed (role=inbox-watcher, restart=on-failure)
$ cortex daemon run inbox-watcher
[daemon inbox-watcher pid 2] running (restart=on-failure)
```

Most of this works now — `spawn`, `ps`, `kill`, `trace`, `attach`, `fork`, `diff`, `checkpoint`, `restore`, `send`, `limit`, `audit` and `daemon` are implemented and covered by the smoke suite. `attach` is a read-only, disk-based follow-mode syscall trace in v0 (it tails the on-disk `.crec`, not a live in-memory process — see its honest caveat in [BACKLOG.md](./BACKLOG.md) #031); `cortex daemon run` is the real long-lived supervisor (BACKLOG #039). All seven drivers (LLM, MCP, filesystem, memory) ship. See [BACKLOG.md](./BACKLOG.md) for what is done and what comes next.

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

`examples/` ships **inside the package**, so the demos below work straight after
`npm i -g`. They are `.ts` files, loaded by Node's type stripping: that is on by
default from **Node 22.18+**, so on earlier 22.x prefix your command with
`NODE_OPTIONS=--experimental-strip-types`. If you would rather not think about
it at all, `cortex spawn --role coder --task "..."` needs no `.ts` file.

Working on Cortex itself instead? Clone it and run the suite:

```bash
git clone https://github.com/Jackeven02/cortex-os
cd cortex-os && npm install
unset OPENAI_API_KEY DEEPSEEK_API_KEY   # fall back to the deterministic mock
npx tsx scripts/smoke.ts                # 525 assertions, 0 failures
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

**Phases 1–3 — largely complete.** The kernel boots; all ten kernel modules plus the driver registry are in; all seven drivers ship (mock / deepseek / openai LLM, MCP and filesystem tools, inmem and sqlite memory); most of the CLI works. `cortex spawn → llm_call → exit → reap` runs, and checkpoint/restore survives across separate CLI invocations. Known v0 gaps are recorded honestly in [BACKLOG.md](./BACKLOG.md), not hidden.

**Phase 4 — Killer demos.** All three are polished and captured as replays. Demo A (supervision tree): coders each generate one section of a README for a fictional library (see `examples/supervision-tree.ts`, [`docs/demo-a.html`](./docs/demo-a.html), `docs/demo-a.gif`). Demo B (pause across reboots): an inbox-watcher classifies tickets, checkpoints mid-run, and resumes after a reboot (see `examples/checkpoint-agent.ts`, [`docs/demo-b.html`](./docs/demo-b.html), `docs/demo-b.gif`). Demo C (fork and compare): a coder forks to explore two dedup strategies in parallel, then `cortex diff` lines up the branches so you keep the winner (see `examples/fork-compare-agent.ts`, [`docs/demo-c.html`](./docs/demo-c.html), `docs/demo-c.gif`). `cortex attach` ships as a follow-mode syscall trace (BACKLOG #031), and `cortex daemon install/run` registers and supervises long-lived agents, the piece that makes `attach`'s interactive send-half possible (BACKLOG #039). **Phase 3 is now complete** — every command in the demo above works.

Demo A is worth calling out because it changed the kernel: agents used to run to completion inside the quantum that dispatched them, so a parent parked in `wait()` held its own tick and its children could never run — `wait()` deadlocked by construction, and a supervision tree could not be written at all. The continuation is now cooperative (see PROCESS.md §8.2), so this works with no orchestrator:

![Demo A: a supervision tree](./docs/demo-a.gif)
*(Live replay: [`docs/demo-a.html`](./docs/demo-a.html). The GIF is produced by `examples/make-demo-a-gif.py` once Pillow is installed.)*

The planner spawns three coders, each of which generates one section of a real README for a fictional library ("tinylog") and publishes it to a shared `semantic` memory region. One coder ("api") hangs — a model call that never returns — so the planner notices a bounded `wait`, kills it, spawns a replacement, and assembles the finished README from the three sections:

```bash
$ cortex spawn --role planner --module ./examples/supervision-tree.ts
[planner pid 2] spawning 3 coders (tinylog README)
[coder api pid 5] slow model — will miss its deadline
[planner] api (pid 5) missed its 8000ms deadline — killing
[coder api#2 pid 6] generating section: api
[planner] overview=ok(0) install=ok(0) api=respawned(0)
[planner] assembled README.md: # tinylog / ## Overview / ## Install / ## API
process exited (code 0: planner complete: overview=ok(0),install=ok(0),api=respawned(0))
```

Demo B makes the reboot story concrete. A checkpoint captures the *process image* — memory regions, budgets, lineage — not the live JS stack, so on `restore` the agent re-runs from the top and skips already-handled tickets by reading its own `episodic` marker (the documented idempotency pattern, not a kernel feature). The result is a long-running agent that survives a power cycle with zero work lost:

![Demo B: pause across reboots](./docs/demo-b.gif)
*(Live replay: [`docs/demo-b.html`](./docs/demo-b.html). The GIF is produced by `examples/make-demo-b-gif.py` once Pillow is installed.)*

The inbox-watcher classifies each ticket (`bug` / `feature` / `question`), drafts a reply into the shared `semantic` region, and records the processed id in `episodic`. After three it checkpoints and detaches; after a reboot, `cortex restore` re-materialises it as a new PID, it reads back the `done` set, skips the three it already handled, and finishes the queue:

```bash

$ cortex spawn --role inbox-watcher --module ./examples/checkpoint-agent.ts
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

![Demo C: fork and compare](./docs/demo-c.gif)
*(Live replay: [`docs/demo-c.html`](./docs/demo-c.html). The GIF is produced by `examples/make-demo-c-gif.py` once Pillow is installed.)*

```bash
$ cortex spawn --role demo --module ./examples/fork-compare-agent.ts
[parent 2] forked as pid 3 — branch A: counting bloom filter
[branch A pid 2] {"approach":"counting bloom filter","spaceComplexity":"O(k) bits, ...}
[branch B pid 3] resumed from the fork's snapshot
[branch B pid 3] {"approach":"lru-bounded hash set","spaceComplexity":"O(cap) entries, ...}
process exited (code 0: branch A complete)

$ cortex diff 2 3
  diverged after 4 shared syscall(s) — fork recorded in pid 2 at byte offset 1712
  syscall diff   (4 shared, - 6 A-only, + 8 B-only)
  - 15:21:58.345  fork         out {"childChainId":"9c7acbf9-...","c...
  - 15:21:58.346  llm_call     in  {"messages":[{"content":"Design dedup with a counting Blo...
  + 15:21:58.352  llm_call     in  {"messages":[{"content":"Design dedup with an LRU-bounded...
  + 15:21:58.353  exit         out {"code":0,"reason":"branch B complete"}
  summary
    records   14            12      syscalls  10        8
    exit      0 branch A    0 branch B
  last llm_call output
    A: mock reply to: Design dedup with a counting Bloom filter.
    B: mock reply to: Design dedup with an LRU-bounded hash set.
```

See **[BACKLOG.md](./BACKLOG.md)** for the full list, prioritized.

---

## Documentation

| Document | What it covers |
|---|---|
| [MANIFESTO.md](./MANIFESTO.md) | Why cortex exists. Start here. |
| [docs/STATE.md](./docs/STATE.md) | **The hard part.** What agent state is, what gets copied on fork, what cannot be copied at all. |
| [docs/PROCESS.md](./docs/PROCESS.md) | Agent lifecycle: 8 states, 12 transitions, signals, scheduling |
| [docs/ABI.md](./docs/ABI.md) | Syscall contract: 24 syscalls, 3 driver interfaces, error model, recording format |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Kernel modules and data flow: 11 modules, syscall lifecycle, persistence layout, concurrency model |
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
