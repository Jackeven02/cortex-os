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

> **Status as of this commit:** 10 of 10 numbered items done, plus the unnumbered `driver_registry.ts` — **the whole v0 kernel of ARCHITECTURE §4 ("ten kernel modules + one driver registry") has landed.** The foundation (`types.ts` + `errors.ts`) plus `recorder.ts`, `process_table.ts`, `signals.ts`, `ipc.ts`, `memory.ts`, `checkpoint.ts`, `fork.ts`, `scheduler.ts`, `init.ts`, the capstone `syscall_dispatcher.ts` (#014), and `driver_registry.ts` (§4.11) are in. The dispatcher is the single front door: it enforces the state gate (`ESTATE`), the forkable-region rule (`EREVERSIBLE`), enter/exit/trap recording, and budget accounting + `SIGXCPU`, then routes to each module and calls `init.handleZombie` on `exit()`. The driver registry version-checks (`abiCompat` semver gate, ABI §9.7) and routes LLM / tool / memory drivers, and its `llmResolver()` / `toolResolver()` feed the dispatcher's `ResolveLLMHook` / `ResolveToolHook` — those hooks are no longer placeholders. One honest v0 deviation: `memory.ts` / `ipc.ts` / `fork.ts` / `checkpoint.ts` predate the dispatcher and still write their own records, so it gates and routes those syscalls without re-recording them (collapsing them onto the dispatcher is a documented follow-up); likewise `MemoryManager` keeps its own backing→driver map, which boot copies from the registry. **The kernel now boots.** `boot.ts` (the agent runner) assembles all ten modules + the registry into a live `Kernel`, wires the scheduler's `resume` continuation to a run-to-completion quantum, materialises the `CortexContext` proxy, and clears the ARCHITECTURE §13 acceptance bar end to end: *spawn a process that calls `llm_call` against the mock driver (#022), exits, gets reaped.* 362 smoke checks green. What remains for a usable v0 is the rest of the Phase 2 drivers (#024 openai onward — #023 deepseek, the first real LLM driver, has landed) and the Phase 3 CLI.

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
> 1. **`restore` does not auto-run.** `checkpoint.restoreAs` mints the restored process in state `NEW` (correct per PROCESS.md §3.6), and the dispatcher enqueues it, but the scheduler only dispatches `READY` and `reconcile()` only adopts `READY`. A restored process therefore sits in `NEW` until something walks it to `READY`. The boot smoke asserts this state rather than papering over it; the fix (a `NEW → READY` step in `#restore`, or a scheduler that adopts `NEW`) is a small follow-up that must not break the existing checkpoint smoke. **CLI stopgap in place:** `cortex restore` walks the restored pid `NEW → READY` and re-enqueues it itself, so cross-invocation restore runs end-to-end (Demo B). The kernel-level gap is unchanged for library users — fixing `#restore` to walk `NEW → READY` would let that stopgap be deleted.
> 2. **Sync syscalls skip per-call recording.** `now` / `random` / `budget` / `on_signal` are synchronous on `CortexContext` (ABI §8) but `dispatcher.invoke` is uniformly async, so boot serves them through a sync fast-path that replicates the state gate (`ESTATE`) but does **not** append a `.crec` record. Determinism for replay comes from the injected clock/RNG (shared with the dispatcher) instead; `on_signal` dispositions are a known replay gap. Either ABI §8 marks these explicitly unrecorded, or replay reconstructs them.
> 3. **Flat persistence layout.** ARCHITECTURE §7 sketches a per-process subdirectory tree; v0 uses flat `<dir>/processes` and `<dir>/checkpoints` (matching `Recorder.open` and the checkpoint store as built). ~~Note `crecPath()` still computes a `proc/` subdir that `Recorder.open` does not use~~ — **resolved:** `crecPath()` now returns `<dir>/processes/<pid>.crec`, matching `Recorder.open` and the CLI's disk index.

**Exit criteria:** unit tests cover spawn → llm_call → tool_call → exit; checkpoint → restore round-trips; fork → diverge → diff; signals work; scheduler enforces budgets.

**Demoted to icebox:** the capability/permission system. v0 does not need it. Adding it now would slow the kernel and solve a problem nobody has yet.

---

## Phase 2 — Drivers

Pluggable backends. Each driver is independently testable.

- [x] **#022** `drivers/llm/mock.ts` — deterministic mock for tests and CI (build this first; it unblocks everything else) → this commit (first concrete `ILLMDriver`; registers through `driver_registry.ts`, exercised end-to-end via the dispatcher in smoke)
- [x] **#023** `drivers/llm/deepseek.ts` — first real LLM driver → this commit (OpenAI-compatible HTTP `/chat/completions`; the driver is its own error boundary — the dispatcher does not wrap LLM-driver throws — so it translates HTTP status / abort / transport failure into stable `CortexError` errnos via `errnoForStatus` + `wrapDriverError`. Injectable `fetchFn` / `env` / `pricing` keep the smoke checks off the network; CJK-aware `countTokens`; cached-input token pricing; no `stream` in v0)
- [x] **#024** `drivers/llm/openai.ts` — second LLM driver, validates the abstraction → implemented (OpenAI `/v1/chat/completions`; same error-boundary discipline as deepseek; injectable `fetchFn`/`pricing`; o1/o3 model temperature handling; CJK-aware `countTokens`)
- [x] **#025** `drivers/tool/mcp.ts` — MCP client, mounts any MCP server as a tool namespace → implemented. JSON-RPC 2.0 over stdio (newline-delimited, spawn-on-first-use), `initialize` + `notifications/initialized` handshake, `tools/list` → `ToolDescriptor`, `tools/call` → `ToolResult`. **No kernel code changed** — MCP enters through the same `IToolDriver` as `fs`, which is the whole point. Three decisions worth arguing about, all documented in the driver header: (1) MCP has no reversibility field, so untagged tools default to `'irreversible'` and therefore *refuse to run inside `forkable()`*; operators override per tool name via the `reversibility` option and `declaredReversibility` records which were declared, so `cortex audit` can surface the rest. (2) `forkable = false` — a live subprocess cannot cross a cognitive fork. (3) server→client requests (sampling/roots/elicitation) are ignored rather than answered, because answering means an unrecorded nested `llm_call`. Tools are exposed as `<namespace>/<name>` so several servers coexist with the built-in `fs` driver. Writes fail fast when the server dies (`onClose` hook) instead of burning the timeout. CLI mounts it opt-in via `CORTEX_MCP_COMMAND` / `CORTEX_MCP_ARGS` / `CORTEX_MCP_NAMESPACE`; a dead server warns and degrades rather than bricking unrelated commands. See `examples/mcp-agent.ts`. 26 smoke checks.
- [x] **#026** `drivers/tool/fs.ts` — file system tools (read, write, list, glob) → implemented (`fs_read`, `fs_write`, `fs_list`, `fs_glob`; sandbox root enforcement; reversibility tags)
- [x] **#027** `drivers/memory/inmem.ts` — in-memory store for tests → implemented (`Map<string, Map<string, Entry>>`; TTL support; snapshot/restore)
- [x] **#028** `drivers/memory/sqlite.ts` — SQLite-backed memory store → implemented (`node:sqlite` (Node 22+); WAL mode; per-region tables; snapshot/restore compatible with inmem)

**Exit criteria:** swapping a driver requires changing one import. No kernel code knows about any specific vendor. → **Met. All five drivers implemented: #022 mock, #023 deepseek, #024 openai, #025 MCP, #026 fs, #027 inmem, #028 sqlite.** The MCP driver is the strongest evidence: it is a completely different transport (subprocess + JSON-RPC) from the in-process `fs` driver, and it registered without a single line of kernel code changing.

---

## Phase 3 — CLI (`cortex` / `ctx`)

The user-facing surface. Should feel like a real OS shell.

- [x] **#029** `cortex spawn` — start an agent, print PID → implemented (`--role`, `--task`, `--system`, `--module`; env-driven driver selection). Hardened this pass: `--module` spawns a user agent module; the previously-dead `--driver`/`--model`/`--max-tokens` now flow through `AgentSpec` into the prompt agent's `llm_call` and `--token-budget` becomes a real spawn budget; every spawned agent gets the three default memory regions (episodic/semantic/procedural) so `memory_write` does not trap ENOENT; and a reaped process's exit status is recovered from the `.crec` exit record instead of being hardcoded to `code 0: completed` (a failed run is no longer reported as success).
- [x] **#030** `cortex ps` — list processes with state, tokens, age → implemented (table format with PID/PPID/ROLE/STATE/TOKENS/AGE; `--state`/`--role` filters)
- [x] **#031** `cortex attach` / `detach` — interactive session with a running agent
  - **v0 (this pass):** `attach <pid>` is a **read-only, disk-based follow-mode syscall trace** — `tail -f` on the process's `.crec`. It dumps every syscall the agent has made so far and, in follow mode (the default), polls the log every 250ms and prints new frames as another `cortex` invocation appends them; SIGINT / SIGTERM detach cleanly. It reuses the same `formatRecordLine` as `cortex trace`, so both commands print identical rows for the same file. Resolves a PID (via `CORTEX_HOME`) or a direct `.crec` path; `--once` for a one-shot dump; `--timeout-ms N` for headless / test use. 4 smoke checks cover `--once`-vs-`trace` row parity, follow-mode mid-window frame pickup, the missing-PID error, and the no-argument help path.
  - **Honest v0 caveat:** the CLI is a short-lived process model, so there is no live in-memory agent for another `cortex` invocation to pipe stdin into. `attach` therefore follows the *on-disk* log, not a running process — new frames appear when a `spawn` / `restore` / `fork` (or a future daemon) appends to that log. The **interactive send-half** (pipe stdin → IPC to a live process, `ctrl-d` to detach) is deferred to **#039**, which introduces the long-running daemon that makes "a running agent" real. The trace surface here does not change when that lands.
- [x] **#032** `cortex kill` — send signals → implemented (`--signal`; all 13 cortex signals)
- [x] **#033** `cortex trace` — strace-style syscall log, live or from `.crec` file → implemented (reads `.crec` by PID or file path)
- [x] **#034** `cortex fork` — clone a running process at its current state → implemented (`--tag`, `--budgets`)
- [x] **#035** `cortex checkpoint` / `cortex restore` → implemented (`--tag`, `--detach`; restore by `--chain` or `--tag`). Cross-invocation restore now works: `bootCliKernel` injects a disk-backed `restoreContext` (rebuilds the agent spec from `<pid>.meta.json`, since the `.csnap` body deliberately omits it), seeds the PID counter from `maxPidOnDisk` so restore never reuses the suspended original's PID, and `--tag` resolves to a chain ID by scanning `.crec` checkpoint records (the tag is not in the `.csnap`). `spawn` now reports a self-checkpointed SUSPENDED process cleanly (with a `restore` hint) instead of as a timeout.
- [x] **#036** `cortex send` — IPC from the shell → implemented (`--channel` or PID target)
- [x] **#037** `cortex limit` — set token / cost / time budgets per process → implemented (`--tokens`, `--usd`, `--wall-time`; show mode when no limits given)
- [x] **#038** `cortex diff` — compare two forked branches' syscall logs and outputs → implemented (`src/cli/diff_core.ts` for the pure logic + `src/cli/commands/diff.ts` for I/O). **The non-obvious part:** you cannot just diff two `.crec` files. A forked child inherits the parent's *state*, not its *log* — the shared causal past exists only in the parent's file. A naive head-to-head align therefore reports the entire shared history as "A only". So diff reads `sharedCausalPast` out of the parent's `fork` record, cuts the parent's log at that byte offset, and only then aligns the two tails with an LCS. LCS rather than a positional compare because branches can *re-converge* (both exit the same way) and a positional compare would call that a difference; LCS also reports one insertion as one insertion instead of a cascade. Signature comparison deliberately excludes `timestamp`/`durationMs`/`callId`/`byteOffset` — otherwise every line differs and the diff is useless. Falls back to a prefix compare (flagged as degenerate, out loud) above `MAX_LCS_CELLS`. Also surfaces `irreversibleInPast` (STATE.md §5.4: those actions happened once, in reality, and both branches inherit them — whoever wins, they already happened). 19 smoke checks, plus `examples/fork-compare-agent.ts` for the live demo.
- [x] **#039** `cortex daemon install` — register a long-running agent to start on boot
  - **v0 (this pass):** `cortex daemon install <name> --role ... [--module|--system] [--restart always|on-failure|never] [--max-restarts n] [--backoff-ms n]` persists a `DaemonSpec` to `.cortex/daemons.json` (the registry ARCHITECTURE §7 already specified) and generates an OS service unit under `<CORTEX_HOME>/units/`: a systemd `.service` on linux, a launchd `.plist` on darwin. Windows gets an `schtasks` command printed instead of a file. `install` deliberately does **not** enable the unit itself — that needs the operator's session / root and is OS-specific — but it prints the exact `systemctl --user enable --now` / `launchctl load` / `schtasks` command. `cortex daemon list` renders the registry; `cortex daemon uninstall <name>` removes the spec and best-effort deletes the unit.
  - **`cortex daemon run [name]` is a real long-lived supervisor**, not the short-lived CLI model: it boots a kernel, registers the daemon(s) through the **existing** `Kernel.registerDaemon` → init supervision machinery (`RestartPolicy` always / on-failure / never, exponential backoff, `maxRestarts` cap, sliding-window restart-storm detection — docs/PROCESS.md §9–§10), and stays alive until SIGTERM/SIGINT (or `--max-runtime-ms n`, for headless / test use). **No kernel code changed** — init already had the supervisor; this command is the thin CLI shell over it. This is also the piece that makes `attach`'s deferred interactive send-half possible.
  - **8 smoke checks:** install persists a spec (with memory regions) and rejects a bad name / bad restart kind; list renders the registry; uninstall removes the spec (and the platform unit when one exists); the pure `generateServiceUnit` renders linux + darwin units correctly (win32 has no unit path); `enableCommand` is correct per platform; `daemon run --max-runtime-ms` actually restarts a crashing agent (asserts ≥ 2 `.crec` files, i.e. the restart fired); `run` on an unknown name fails.
- [x] **#040** `cortex audit` — surface tools that are untagged for reversibility (STATE.md §8.7) → implemented, and **sharpened by #025**: it now prints each tool's tag *and* distinguishes a declared tag from an inferred one. Before MCP, "untagged" meant "the driver author forgot"; with MCP it means "the protocol has no field for it", so every MCP tool would have looked identically untagged. The driver exposes `declaredReversibility` (per exposed tool name) and audit flags the defaulted ones with `<- NOT declared; defaulted`, then summarizes how many are silently locked out of `forkable()` regions and how to fix it.

**Exit criteria:** the demo from `README.md` runs end-to-end on a laptop.

---

## Phase 4 — Killer demos

Three demos that prove the abstraction matters. Each one becomes a GIF in the README and a post on X / V2EX / HN.

**Order chosen for maximum signal:** lead with the demo that no existing tool can do, follow with the demos that show composability.

- [x] **#041** **Demo B (lead) — Pause across reboots.** A long-running inbox-watcher daemon checkpoints mid-thought, the laptop reboots, `cortex restore` brings it back exactly where it left off. This is the demo that makes people say *"oh, that's what's been missing."*
  - **Mechanism: working end-to-end via the CLI** (see `examples/checkpoint-agent.ts`). An agent calls `ctx.checkpoint({ tag, detach: true })` while running; the process SUSPENDS and a `.csnap` is written to disk. A *later, separate* `cortex restore --tag <t>` (or `--chain <id>`) re-materialises it as a new PID with its memory regions re-hydrated, and it continues. This required three fixes: a disk-backed `restoreContext` in `bootCliKernel` (the kernel default reads an in-memory map that is empty in a fresh invocation), seeding the PID counter from `maxPidOnDisk` (so restore does not reuse the suspended original's PID and collide on `.crec`/`.meta.json`), and resolving `--tag` from the `.crec` checkpoint record (the tag is not stored in the `.csnap`).
  - **Honest v0 caveat:** a checkpoint captures the *process image* — state, memory regions, budgets, lineage — **not the live JS call stack.** "Exactly where it left off" therefore means *memory is restored and the agent re-runs from the top, continuing past its own checkpoint marker.* The agent must make its progress idempotent via memory (the example gates phase 2 on a memory key). True continuation capture is a post-v0 concern.
  - **Polished (this pass):** the demo script is now a realistic inbox-watcher — it watches a fixed 6-ticket queue, classifies each ticket (`bug`/`feature`/`question`) via a stem regex, drafts a reply into the shared `semantic` region, and records the processed id in `episodic`; after 3 tickets it checkpoints + detaches; on `restore` it reads back the `done` set, skips the three already handled, and finishes the queue (`inbox cleared (6/6)`). The full spawn → reboot → restore run is captured in `examples/demo-b.capture.log`. **README visual:** `docs/demo-b.html` is a dependency-free animated replay; `docs/demo-b.gif` is produced by `examples/make-demo-b-gif.py` once Pillow is installed — the offline build sandbox blocks `pip install pillow`, so the GIF is generated on a connected machine, not in CI.
- [x] **#042** **Demo C — Fork and compare.** A coder agent reaches a decision point. We `fork` it, send the two branches different prompts, watch them diverge, then `cortex diff` to compare their final outputs and pick a winner. Extends to **agent search**: spawn N branches, evaluate, keep best.
  - **Mechanism: working end-to-end via the CLI** (see `examples/fork-compare-agent.ts`). Verified: `cortex spawn --role demo --module ./examples/fork-compare-agent.ts` → `[parent 2] forked as pid 3` → both branches run, each takes a different `llm_call`, each exits with its own reason → `cortex diff 2 3` reports *"diverged after 4 shared syscall(s) — fork recorded in pid 2 at byte offset 1712"* and lines up the two tails. Requires #038 (diff), which is done.
  - **Honest v0 caveat (same contract as Demo B):** a forked child **re-runs its agent module from the top** with the parent's cognitive snapshot and memory regions; it does not resume at the fork point. The example distinguishes parent from child by writing a `forked` marker to memory *before* calling `ctx.fork()` — the child inherits it in its snapshot and skips the parent's block. Writing it after would not work: the child's snapshot is already sealed. That is a pattern the agent author applies, not a kernel feature.
  - **Polished (this pass):** the demo script is now a concrete decision — a coder commits to a fixed dedup requirement (high-volume event stream, memory-tight, tiny false-positive tolerated), forks, and the two branches each take a real, distinct strategy: branch A a counting Bloom filter, branch B an LRU-bounded hash set. Each branch writes a structured proposal object to the shared `semantic` region and prints it (concrete, diffable output instead of the old placeholder "state the problem in one sentence"). The full spawn → fork → `cortex diff 2 3` run is captured in `examples/demo-c.capture.log` and shows a real divergence (4 shared syscalls, fork at byte offset 1712, distinct A-only / B-only tails, separate final `llm_call` outputs). **README visual:** `docs/demo-c.html` is a dependency-free animated replay; `docs/demo-c.gif` is produced by `examples/make-demo-c-gif.py` once Pillow is installed — the offline build sandbox blocks `pip install pillow`, so the GIF is generated on a connected machine, not in CI.
- [x] **#043** **Demo A — Supervision tree.** A planner spawns three parallel coders, one hangs, planner detects timeout, kills it, spawns a replacement, gathers results. No glue code beyond the planner agent itself.
  - **Mechanism: working end-to-end via the CLI** (see `examples/supervision-tree.ts`). `cortex spawn --role planner --module ./examples/supervision-tree.ts` → planner spawns 3 coders (billing hangs on purpose) → *"billing (pid 8) missed its deadline — killing"* → respawns `billing#2` → gathers all three results from the shared `semantic` region → exits 0 with `planner complete: auth=ok(0),storage=ok(0),billing=respawned(0)`. The planner is ~40 lines of ordinary `async`/`await`; the restart policy is a `catch` block.
  - **This demo required the cooperative-continuation rework, which is now done.** The kernel used to run an agent body to completion inside the quantum that dispatched it, so a parent parked in `wait()` held its own tick forever and its children could never be dispatched — `wait()` deadlocked by construction, and the BACKLOG's "no glue code beyond the planner" bar was unreachable. `Kernel.#runQuantum` now *starts* the body and returns; the body lives in its own Promise across later ticks. Three pieces carry it: `wake_gate.ts` (defer a woken `wait()`/`recv()` until the process is back on the CPU, so the next syscall sees RUNNING instead of trapping ESTATE), `Scheduler.isLive` (a live body ⇒ report `parked`, leave RUNNING, never re-queue), and `Kernel.settle()` (run to quiescence, since one tick is no longer one agent). Docs updated: PROCESS.md §8.2, ABI.md §4.1.
  - **Two real bugs fell out of it, both fixed with regression tests:**
    - *Scheduler run-queue desync.* `#selectNext` dropped stale nodes from the queue array but left the PID in the `#queued` membership mirror, so `enqueue()` — idempotent by checking that mirror — became a permanent no-op and the process sat READY forever, dispatched by nobody. Nothing in the old run-to-completion model could reach that state; a woken body that blocks again on a later `wait()` can.
    - *A late `wait()` lost the child's status.* init auto-reaps zombies, so a supervisor waiting for child A and then child B found B already gone: `wait(B)` trapped `ESRCH` (or parked forever). `ProcessTable` now retains each reaped child's `WaitResult` for its parent (`takeReapedChild`/`takeReapedChildAny`), consumed once like a real reap.
  - **New syscall surface:** `wait(pid, { timeoutMs })` traps `ETIMEDOUT` on a deadline (`timeoutMs: 0` polls without parking). A timeout does *not* kill the child — that stays the supervisor's decision, which is what makes the restart policy expressible in the agent rather than in an orchestrator.
  - **Polished (this pass):** the planner/coder script now does a real task — each coder generates one section of a README for a fictional library ("tinylog") and the planner assembles the finished doc from the shared `semantic` region (captured run in `examples/demo-a.capture.log`). **README visual:** `docs/demo-a.html` is a dependency-free animated replay; `docs/demo-a.gif` is produced by `examples/make-demo-a-gif.py` once Pillow is installed — the offline build sandbox blocks `pip install pillow`, so the GIF is generated on a connected machine, not in CI.

**Exit criteria:** all three demos can be reproduced by a stranger following the README in under 10 minutes.

---

## Phase 5 — Polish & launch

- [ ] **#044** Landing page (`cortex.sh` or similar — domain to be checked)
- [x] **#045** `docs/HACKING.md` — how to contribute, how to write a driver
  - Covers: dev setup (`tsc` + `tsx scripts/smoke.ts`, with an explicit note that `npm test` is *not* the suite and `tests/` is intentionally empty); project layout; the "documents are the contract" rule; the four coding conventions (branded ids, `exactOptionalPropertyTypes` conditional-spread, errno errors / `ProcessExitSignal`, zero runtime deps); how to write each of the three drivers (`ILLMDriver`/`IToolDriver`/`IMemoryDriver`) with a minimal echo-driver example and the reversibility/forkable discipline; how to write an agent + the four gotchas (absolute module path, per-process memory regions, fork/restore re-runs from the top, `--driver` only applies to prompt agents); how to add a syscall (the five files to touch together); and the testing/submitting conventions. Grounded in the real interfaces, not invented.
- [x] **#046** `docs/COOKBOOK.md` — common patterns (supervision, pipelines, daemons, fork-and-compare)
  - Nine runnable recipes: supervision tree (`spawn`/`wait(timeoutMs)`/`kill`/respawn), pause-across-reboots (`checkpoint detach` + `restore` + memory-marker idempotency), fork-and-compare (`fork` before writing the marker + `cortex diff`), long-running daemon (`daemon install/run` + restart policy), budgets/limits, tools + the `forkable` reversibility gate (+ MCP mount), IPC (`send`/`recv`), time/determinism (`now`/`random`/`sleep`), and testing an agent against the mock driver. Every snippet mirrors a real `examples/` module and the real syscall surface.
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
