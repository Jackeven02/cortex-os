# Cortex Backlog

The first thirty issues, prioritized. Phases are sequential — each one assumes the previous is mostly done.

This document is the source of truth for "what we work on next." When an item is done, it gets a strikethrough and a commit/PR link, not a deletion. We want history.

---

## Phase 0 — Design (current)

The point of this phase is to lock the abstractions before writing serious code. A wrong syscall is a thousand rewrites later.

- [x] **#001** Write `MANIFESTO.md` — the why
- [x] **#002** Initialize repo skeleton (package.json, tsconfig, dirs)
- [ ] **#003** Write `docs/ABI.md` — full syscall contract in TypeScript types
- [ ] **#004** Write `docs/PROCESS.md` — agent state machine, lifecycle, transitions
- [ ] **#005** Write `docs/ARCHITECTURE.md` — kernel modules, data flow, driver model
- [ ] **#006** Decide driver interface for LLM providers (`ILLMDriver`)
- [ ] **#007** Decide driver interface for tools (`IToolDriver`, MCP-compatible)
- [ ] **#008** Decide driver interface for memory backends (`IMemoryDriver`)
- [ ] **#009** Decide on-disk format for process state (SQLite? JSONL? both?)
- [ ] **#010** Decide on recording format for syscall log (the `.crec` file)

**Exit criteria:** a stranger reads ABI.md, PROCESS.md, ARCHITECTURE.md and can predict what the kernel does in any scenario we have not yet coded.

---

## Phase 1 — Kernel skeleton

Target: a "hello world" agent runs, calls one LLM, exits cleanly. ~1500 lines of TS.

- [ ] **#011** `kernel/process.ts` — Process class, PID allocation, state machine
- [ ] **#012** `kernel/scheduler.ts` — round-robin scheduler with token budgets
- [ ] **#013** `kernel/syscall.ts` — syscall dispatcher, registration, logging
- [ ] **#014** `kernel/ipc.ts` — channels (`send`, `recv`, blocking and non-blocking)
- [ ] **#015** `kernel/signals.ts` — `SIGINT`, `SIGTERM`, `SIGKILL`, `SIGUSR1` (reflect), `SIGUSR2` (summarize)
- [ ] **#016** `kernel/checkpoint.ts` — `checkpoint`, `restore`, snapshot serialization
- [ ] **#017** `kernel/recorder.ts` — every syscall written to append-only log
- [ ] **#018** `kernel/memory.ts` — virtual memory abstraction (per-process namespace)
- [ ] **#019** `kernel/capability.ts` — permission tokens, capability passing
- [ ] **#020** `kernel/init.ts` — process 1, the supervisor

**Exit criteria:** unit tests cover spawn → llm_call → tool_call → exit; checkpoint → restore round-trips; signals work; scheduler enforces budgets.

---

## Phase 2 — Drivers

Pluggable backends. Each driver is independently testable.

- [ ] **#021** `drivers/llm/deepseek.ts` — first LLM driver (free tier, user knows it)
- [ ] **#022** `drivers/llm/openai.ts` — second LLM driver, validates the abstraction
- [ ] **#023** `drivers/llm/mock.ts` — deterministic mock for tests and CI
- [ ] **#024** `drivers/tool/mcp.ts` — MCP client, mounts any MCP server as a tool namespace
- [ ] **#025** `drivers/tool/fs.ts` — file system tools (read, write, list, glob)
- [ ] **#026** `drivers/memory/sqlite.ts` — SQLite-backed memory store
- [ ] **#027** `drivers/memory/inmem.ts` — in-memory store for tests

**Exit criteria:** swapping a driver requires changing one import. No kernel code knows about any specific vendor.

---

## Phase 3 — CLI (`cortex` / `ctx`)

The user-facing surface. Should feel like a real OS shell.

- [ ] **#028** `cortex spawn` — start an agent, print PID
- [ ] **#029** `cortex ps` — list processes with state, tokens, age
- [ ] **#030** `cortex attach` / `detach` — interactive session with a running agent
- [ ] **#031** `cortex kill` — send signals
- [ ] **#032** `cortex trace` — strace-style syscall log, live or from `.crec` file
- [ ] **#033** `cortex fork` — clone a running process at its current state
- [ ] **#034** `cortex checkpoint` / `cortex restore`
- [ ] **#035** `cortex send` / `cortex recv` — IPC from the shell
- [ ] **#036** `cortex limit` — set token / cost / time budgets per process
- [ ] **#037** `cortex daemon install` — register a long-running agent to start on boot

**Exit criteria:** the demo from `README.md` runs end-to-end on a laptop.

---

## Phase 4 — Killer demos

Three demos that prove the abstraction matters. Each one becomes a GIF in the README and a post on X / V2EX / HN.

- [ ] **#038** **Demo A — Supervision tree.** A planner spawns three parallel coders, one hangs, planner detects timeout, kills it, spawns a replacement, gathers results. No glue code beyond the planner agent itself.
- [ ] **#039** **Demo B — Pause across reboots.** A long-running inbox-watcher daemon checkpoints, the laptop reboots, `cortex restore` brings it back mid-thought.
- [ ] **#040** **Demo C — Fork and compare.** A coder agent reaches a decision point. We `fork` it, send the two branches different prompts, watch them diverge, then `cortex diff` to compare their final outputs and pick a winner.

**Exit criteria:** all three demos can be reproduced by a stranger following the README in under 10 minutes.

---

## Phase 5 — Polish & launch

- [ ] **#041** Landing page (`cortex.sh` or similar)
- [ ] **#042** `docs/HACKING.md` — how to contribute, how to write a driver
- [ ] **#043** `docs/COOKBOOK.md` — common patterns (supervision, pipelines, daemons)
- [ ] **#044** HN launch post draft
- [ ] **#045** X / V2EX / 即刻 launch post drafts
- [ ] **#046** Chinese translation of `MANIFESTO.md`
- [ ] **#047** Logo (something evocative of layers, nuclei, or branching — not a brain clip-art)

---

## Icebox (post-v0.1)

Things we want, but not yet:

- Distributed cortex (multi-host process tree)
- WebAssembly driver sandbox
- GUI process inspector (think `htop` for agents)
- Time-travel debugger UI on top of `.crec` files
- Capability marketplace (signed, versioned skill packages)
- Erlang-style hot code reloading for running agents
- Plan 9-style "everything is a file" — expose every syscall as a file in a virtual filesystem (`/proc/<pid>/llm_call` you can `echo` into)
- Formal model of the syscall ABI in TLA+ or Alloy

---

## Conventions

- One issue per checkbox above. When you start work, comment on the issue with `[wip]`.
- Commits reference issues: `kernel: implement scheduler (#012)`.
- Anything that changes the ABI requires a `MANIFESTO`-level discussion in an issue first.
- We do not close issues for being "stale." Stale means we have not decided. Decisions get made, not aged out.
