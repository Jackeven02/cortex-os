# Cortex Backlog

The first issues, prioritized. Phases are sequential — each one assumes the previous is mostly done.

This document is the source of truth for "what we work on next." When an item is done, it gets a strikethrough and a commit/PR link, not a deletion. We want history.

> **v0.0.2 change log** — After cross-review with another model, three things moved:
> 1. `docs/STATE.md` was promoted to Phase 0 (highest priority). It defines the hard part: what gets copied on fork, what cannot be copied at all.
> 2. The capability/permission system was demoted from Phase 1 to the icebox. v0 does not need permissions; v1 may.
> 3. Demo order changed from A→B→C to **B→C→A**. Demo B (long-running, checkpoint/resume across reboot) is the most viral and the most clearly differentiated from existing tools.
> 4. New section: "Why not just X" differentiation questions are tracked as `#002a`-style issues that link to MANIFESTO §IV.

---

## Phase 0 — Design (current)

The point of this phase is to lock the abstractions before writing serious code. A wrong syscall is a thousand rewrites later. A wrong **state model** is a kernel that cannot be implemented at all.

> **Status as of this commit:** 10 of 11 items done. The four core documents (`STATE.md`, `PROCESS.md`, `ABI.md`, `ARCHITECTURE.md`) are drafted v0. `#011` is intentionally rolling — the open questions in each doc's final section will resolve as Phase 1 implementation forces decisions. **Exit criteria are met; Phase 1 is unblocked.**

- [x] **#001** Write `MANIFESTO.md` — the why → `8a2bb3c`
- [x] **#002** Initialize repo skeleton (package.json, tsconfig, dirs) → `8a2bb3c`
- [x] **#002a** Add "Why Not Temporal / LangGraph / Kubernetes" section to MANIFESTO → this commit
- [x] **#003** Write `docs/STATE.md` — agent state model, fork taxonomy, irreversible-action doctrine → this commit
- [x] **#004** Write `docs/ABI.md` — full syscall contract in TypeScript types → this commit
- [x] **#005** Write `docs/PROCESS.md` — agent state machine, lifecycle, transitions → this commit
- [x] **#006** Write `docs/ARCHITECTURE.md` — kernel modules, data flow, driver model → this commit
- [x] **#007** Decide driver interface for LLM providers (`ILLMDriver`) → ABI.md §7.1
- [x] **#008** Decide driver interface for tools (`IToolDriver`, MCP-compatible) → ABI.md §7.2 (two-phase stage/commit)
- [x] **#009** Decide driver interface for memory backends (`IMemoryDriver`) → ABI.md §7.3 (snapshotRegion/restoreRegion)
- [x] **#010** Decide on-disk format details (CBOR vs MessagePack vs JSON for `.csnap`; raw append vs framed for `.crec`) → STATE.md §4 (CBOR, content-addressed `.csnap` + length-prefixed CBOR `.crec`)
- [ ] **#011** Resolve open questions from STATE.md §8, PROCESS.md §11, ABI.md §9, ARCHITECTURE.md §12 (concurrency, budget split, log branching, intent, GC, driver opt-in, side-effect tagging, kernel module boundaries)

**Exit criteria:** a stranger reads STATE.md, ABI.md, PROCESS.md, ARCHITECTURE.md and can predict what the kernel does in any scenario we have not yet coded.

---

## Phase 1 — Kernel skeleton

Target: a "hello world" agent runs, calls one LLM, checkpoints, restores, exits cleanly. ~1500 lines of TypeScript.

- [ ] **#012** `kernel/process.ts` — Process class, PID allocation, state machine
- [ ] **#013** `kernel/scheduler.ts` — round-robin scheduler with token budgets
- [ ] **#014** `kernel/syscall.ts` — syscall dispatcher, registration, logging, reversibility tags
- [ ] **#015** `kernel/ipc.ts` — channels (`send`, `recv`, blocking and non-blocking)
- [ ] **#016** `kernel/signals.ts` — `SIGINT`, `SIGTERM`, `SIGKILL`, `SIGUSR1` (reflect), `SIGUSR2` (summarize)
- [ ] **#017** `kernel/checkpoint.ts` — `checkpoint`, `restore`, snapshot serialization (CBOR)
- [ ] **#018** `kernel/recorder.ts` — every syscall written to append-only `.crec` log
- [ ] **#019** `kernel/memory.ts` — virtual memory abstraction with private/shared/cow regions
- [ ] **#020** `kernel/fork.ts` — cognitive fork per STATE.md §3.1
- [ ] **#021** `kernel/init.ts` — process 1, the supervisor

**Exit criteria:** unit tests cover spawn → llm_call → tool_call → exit; checkpoint → restore round-trips; fork → diverge → diff; signals work; scheduler enforces budgets.

**Demoted to icebox:** the capability/permission system. v0 does not need it. Adding it now would slow the kernel and solve a problem nobody has yet.

---

## Phase 2 — Drivers

Pluggable backends. Each driver is independently testable.

- [ ] **#022** `drivers/llm/mock.ts` — deterministic mock for tests and CI (build this first; it unblocks everything else)
- [ ] **#023** `drivers/llm/deepseek.ts` — first real LLM driver
- [ ] **#024** `drivers/llm/openai.ts` — second LLM driver, validates the abstraction
- [ ] **#025** `drivers/tool/mcp.ts` — MCP client, mounts any MCP server as a tool namespace
- [ ] **#026** `drivers/tool/fs.ts` — file system tools (read, write, list, glob)
- [ ] **#027** `drivers/memory/inmem.ts` — in-memory store for tests
- [ ] **#028** `drivers/memory/sqlite.ts` — SQLite-backed memory store

**Exit criteria:** swapping a driver requires changing one import. No kernel code knows about any specific vendor.

---

## Phase 3 — CLI (`cortex` / `ctx`)

The user-facing surface. Should feel like a real OS shell.

- [ ] **#029** `cortex spawn` — start an agent, print PID
- [ ] **#030** `cortex ps` — list processes with state, tokens, age
- [ ] **#031** `cortex attach` / `detach` — interactive session with a running agent
- [ ] **#032** `cortex kill` — send signals
- [ ] **#033** `cortex trace` — strace-style syscall log, live or from `.crec` file
- [ ] **#034** `cortex fork` — clone a running process at its current state
- [ ] **#035** `cortex checkpoint` / `cortex restore`
- [ ] **#036** `cortex send` / `cortex recv` — IPC from the shell
- [ ] **#037** `cortex limit` — set token / cost / time budgets per process
- [ ] **#038** `cortex diff` — compare two forked branches' syscall logs and outputs
- [ ] **#039** `cortex daemon install` — register a long-running agent to start on boot
- [ ] **#040** `cortex audit` — surface tools that are untagged for reversibility (STATE.md §8.7)

**Exit criteria:** the demo from `README.md` runs end-to-end on a laptop.

---

## Phase 4 — Killer demos

Three demos that prove the abstraction matters. Each one becomes a GIF in the README and a post on X / V2EX / HN.

**Order chosen for maximum signal:** lead with the demo that no existing tool can do, follow with the demos that show composability.

- [ ] **#041** **Demo B (lead) — Pause across reboots.** A long-running inbox-watcher daemon checkpoints mid-thought, the laptop reboots, `cortex restore` brings it back exactly where it left off. This is the demo that makes people say *"oh, that's what's been missing."*
- [ ] **#042** **Demo C — Fork and compare.** A coder agent reaches a decision point. We `fork` it, send the two branches different prompts, watch them diverge, then `cortex diff` to compare their final outputs and pick a winner. Extends to **agent search**: spawn N branches, evaluate, keep best.
- [ ] **#043** **Demo A — Supervision tree.** A planner spawns three parallel coders, one hangs, planner detects timeout, kills it, spawns a replacement, gathers results. No glue code beyond the planner agent itself.

**Exit criteria:** all three demos can be reproduced by a stranger following the README in under 10 minutes.

---

## Phase 5 — Polish & launch

- [ ] **#044** Landing page (`cortex.sh` or similar — domain to be checked)
- [ ] **#045** `docs/HACKING.md` — how to contribute, how to write a driver
- [ ] **#046** `docs/COOKBOOK.md` — common patterns (supervision, pipelines, daemons, fork-and-compare)
- [ ] **#047** HN launch post draft
- [ ] **#048** X / V2EX / 即刻 launch post drafts
- [ ] **#049** Chinese translations
  - [x] `README.zh-CN.md` → this commit
  - [ ] `MANIFESTO.zh-CN.md`
  - [ ] `docs/STATE.zh-CN.md`
- [ ] **#050** Logo (something evocative of layers, nuclei, or branching — not a brain clip-art)

---

## Icebox (post-v0.1)

Things we want, but not yet:

**From the v0 design:**
- Capability / permission system (was Phase 1, demoted)
- Sandbox fork (STATE.md §3.2) — copy-on-write filesystem overlay
- Shadow process (STATE.md §3.4) — same state, different driver config
- Two-phase tool pattern (`stage` / `commit`) for irreversible actions
- `cortex doctor` to probe driver fork-safety claims
- CRDT-backed shared memory regions (if last-write-wins hurts)

**From the long-term vision:**
- Distributed cortex (multi-host process tree)
- WebAssembly driver sandbox
- GUI process inspector (think `htop` for agents)
- Time-travel debugger UI on top of `.crec` files
- Capability marketplace (signed, versioned skill packages)
- Erlang-style hot code reloading for running agents
- Plan 9-style "everything is a file" — expose every syscall as a file in a virtual filesystem (`/proc/<pid>/llm_call` you can `echo` into)
- Formal model of the syscall ABI in TLA+ or Alloy
- Optional Temporal-backed persistence driver (prove our "you can build cortex on Temporal" claim)

---

## Conventions

- One issue per checkbox above. When you start work, comment on the issue with `[wip]`.
- Commits reference issues: `kernel: implement scheduler (#013)`.
- Anything that changes the ABI or the state model requires a MANIFESTO-level discussion in an issue first.
- We do not close issues for being "stale." Stale means we have not decided. Decisions get made, not aged out.
- External critique is welcome and gets logged. See `docs/CRITIQUE.md` (forthcoming) for the running record of what reviewers said and what we changed because of it.
