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

> **Status as of this commit:** 10 of 10 numbered items done, plus the unnumbered `driver_registry.ts` — **the whole v0 kernel of ARCHITECTURE §4 ("ten kernel modules + one driver registry") has landed.** The foundation (`types.ts` + `errors.ts`) plus `recorder.ts`, `process_table.ts`, `signals.ts`, `ipc.ts`, `memory.ts`, `checkpoint.ts`, `fork.ts`, `scheduler.ts`, `init.ts`, the capstone `syscall_dispatcher.ts` (#014), and `driver_registry.ts` (§4.11) are in. The dispatcher is the single front door: it enforces the state gate (`ESTATE`), the forkable-region rule (`EREVERSIBLE`), enter/exit/trap recording, and budget accounting + `SIGXCPU`, then routes to each module and calls `init.handleZombie` on `exit()`. The driver registry version-checks (`abiCompat` semver gate, ABI §9.7) and routes LLM / tool / memory drivers, and its `llmResolver()` / `toolResolver()` feed the dispatcher's `ResolveLLMHook` / `ResolveToolHook` — those hooks are no longer placeholders. One honest v0 deviation: `memory.ts` / `ipc.ts` / `fork.ts` / `checkpoint.ts` predate the dispatcher and still write their own records, so it gates and routes those syscalls without re-recording them (collapsing them onto the dispatcher is a documented follow-up); likewise `MemoryManager` keeps its own backing→driver map, which boot copies from the registry. **The kernel now boots.** `boot.ts` (the agent runner) assembles all ten modules + the registry into a live `Kernel`, wires the scheduler's `resume` continuation to a run-to-completion quantum, materialises the `CortexContext` proxy, and clears the ARCHITECTURE §13 acceptance bar end to end: *spawn a process that calls `llm_call` against the mock driver (#022), exits, gets reaped.* 339 smoke checks green. What remains for a usable v0 is the rest of the Phase 2 drivers (#023 deepseek onward) and the Phase 3 CLI.

- [x] **#012** `kernel/process.ts` — Process class, PID allocation, state machine → `d339502` (landed as `process_table.ts`)
- [x] **#013** `kernel/scheduler.ts` — round-robin scheduler with token budgets → this commit
- [x] **#014** `kernel/syscall.ts` — syscall dispatcher, registration, logging, reversibility tags → this commit (landed as `syscall_dispatcher.ts`)
- [x] **#015** `kernel/ipc.ts` — channels (`send`, `recv`, blocking and non-blocking) → `6950f40`
- [x] **#016** `kernel/signals.ts` — `SIGINT`, `SIGTERM`, `SIGKILL`, `SIGUSR1` (reflect), `SIGUSR2` (summarize) → `2ff3be9`
- [x] **#017** `kernel/checkpoint.ts` — `checkpoint`, `restore`, snapshot serialization (CBOR) → `6e4a851`
- [x] **#018** `kernel/recorder.ts` — every syscall written to append-only `.crec` log → `c85e697`
- [x] **#019** `kernel/memory.ts` — virtual memory abstraction with private/shared/cow regions → `a8313e4`
- [x] **#020** `kernel/fork.ts` — cognitive fork per STATE.md §3.1 → `f24cd87`
- [x] **#021** `kernel/init.ts` — process 1, the supervisor → `c224259`
- [x] **(unnumbered)** `kernel/driver_registry.ts` — the "+1 driver registry" of ARCHITECTURE §4 / §4.11: load, version-check (`abiCompat` semver gate), and route LLM / tool / memory drivers; supplies the dispatcher's `ResolveLLMHook` / `ResolveToolHook` → this commit
- [x] **(unnumbered)** `kernel/boot.ts` — the agent runner / kernel assembly (ARCHITECTURE §8, §13): constructs all ten modules + the registry into a live `Kernel`, boots init, loads drivers/daemons, wires the scheduler's `resume` to a run-to-completion quantum, materialises the `CortexContext` proxy, and drives spawn → run → exit → reap. Clears the §13 "kernel is alive" bar with the mock LLM driver → this commit

> **Known v0 gaps surfaced by `boot.ts`** (tracked here, not silently hidden — each is a doc-fix or post-v0 work candidate):
> 1. **`restore` does not auto-run.** `checkpoint.restoreAs` mints the restored process in state `NEW` (correct per PROCESS.md §3.6), and the dispatcher enqueues it, but the scheduler only dispatches `READY` and `reconcile()` only adopts `READY`. A restored process therefore sits in `NEW` until something walks it to `READY`. The boot smoke asserts this state rather than papering over it; the fix (a `NEW → READY` step in `#restore`, or a scheduler that adopts `NEW`) is a small follow-up that must not break the existing checkpoint smoke.
> 2. **Sync syscalls skip per-call recording.** `now` / `random` / `budget` / `on_signal` are synchronous on `CortexContext` (ABI §8) but `dispatcher.invoke` is uniformly async, so boot serves them through a sync fast-path that replicates the state gate (`ESTATE`) but does **not** append a `.crec` record. Determinism for replay comes from the injected clock/RNG (shared with the dispatcher) instead; `on_signal` dispositions are a known replay gap. Either ABI §8 marks these explicitly unrecorded, or replay reconstructs them.
> 3. **Flat persistence layout.** ARCHITECTURE §7 sketches a per-process subdirectory tree; v0 uses flat `<dir>/processes` and `<dir>/checkpoints` (matching `Recorder.open` and the checkpoint store as built). Note `crecPath()` still computes a `proc/` subdir that `Recorder.open` does not use — reconcile the helper or the doc.

**Exit criteria:** unit tests cover spawn → llm_call → tool_call → exit; checkpoint → restore round-trips; fork → diverge → diff; signals work; scheduler enforces budgets.

**Demoted to icebox:** the capability/permission system. v0 does not need it. Adding it now would slow the kernel and solve a problem nobody has yet.

---

## Phase 2 — Drivers

Pluggable backends. Each driver is independently testable.

- [x] **#022** `drivers/llm/mock.ts` — deterministic mock for tests and CI (build this first; it unblocks everything else) → this commit (first concrete `ILLMDriver`; registers through `driver_registry.ts`, exercised end-to-end via the dispatcher in smoke)
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
