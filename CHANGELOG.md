# Changelog

All notable changes to Cortex are recorded here. This file is the release
history; [BACKLOG.md](./BACKLOG.md) is the work history.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## How versioning works here

Two numbering systems live side by side in this repo, and they mean different
things:

- **Phases** (`Phase 0` … `Phase 5`) are *build milestones* — design, kernel
  skeleton, drivers, CLI, demos, launch materials. They are a construction
  order, not releases. They are recorded in [BACKLOG.md](./BACKLOG.md).
- **Versions** (`0.1.0`, `0.2.0`, …) are *releases* — a tagged, citable point in
  the code. This file is the record of those.

Everything from Phase 0 through Phase 5 is covered by **`0.1.0`**, the first
tagged release.

The docs use **`v0`** as a generation label, not as a version number: when
[docs/STATE.md](./docs/STATE.md) says "sandbox fork is post-v0", it means "not in
this generation of the design," not "not in 0.1.0". Wherever a *specific*
version matters, it is written as a semver like `0.1.0`.

**On the `0.x`:** the syscall ABI is not frozen yet. A `0.x` minor bump may
carry a breaking change to the ABI or the state model — `0.1.0` → `0.2.0` is
allowed to hurt. The ABI freezes at `1.0.0`, and after that the usual semver
rules apply without exception. If you are building against Cortex today, pin the
exact version.

---

## [0.1.0] — 2026-09-19

The first tagged release. The kernel boots, all seven drivers ship, the CLI is
complete, and the three demos run end to end — offline, against a deterministic
mock driver, with no API key.

### Added

**Kernel** (`src/kernel/`)
- Process table and a cooperative scheduler. Agent bodies are *started* by the
  quantum that dispatches them and then live across ticks; a parent parked in
  `wait()` no longer holds its own tick.
- Syscall dispatcher with **19 syscalls** (`spawn`, `ps`, `kill`, `wait`,
  `fork`, `diff`, `checkpoint`, `restore`, `llm_call`, `tool_call`,
  `memory_read`, `memory_write`, `send`, `recv`, `sleep`, `now`, `random`,
  `on_signal`, `budget`) plus `forkable()` as a structured wrapper.
- Append-only syscall recorder — CBOR-encoded `.crec` files, replayable.
- Checkpoints — `.csnap`, CBOR, content-addressed, SHA-256 signed; tampering
  fails verification with `EINVAL`.
- Fork with a recorded `sharedCausalPast` byte offset: the exact point where two
  branches diverge, which is what makes `cortex diff` able to align only the
  tails.
- IPC (`send` / `recv`), **13 signals**, per-process token / USD / wall-clock /
  syscall budgets, and `audit` for surfacing undeclared reversibility.
- `init` with daemon supervision: `registerDaemon(spec)`, restart policies
  (`always` / `on-failure` / `never`), exponential backoff, `maxRestarts`, and
  restart-storm detection.
- A wake gate so a `wait()` / `recv()` resumed by a signal is deferred to the
  next dispatch instead of resolving mid-state.

**Drivers** (`src/drivers/`) — seven, across the three interfaces
- LLM: `mock` (deterministic, the default when no key is set), `deepseek`,
  `openai`.
- Tools: `filesystem`, `mcp` (Model Context Protocol; tools namespaced
  `<namespace>/<raw>`, undeclared reversibility defaults to `irreversible`).
- Memory: `inmem`, `sqlite`.

**CLI** (`src/cli/`) — `spawn`, `ps`, `kill`, `wait`, `trace`, `attach`, `fork`,
`diff`, `checkpoint`, `restore`, `send`, `limit`, `audit`, `daemon`
(`install` / `run` / `list` / `uninstall`), and `help`. Every command follows the
short-lived-process model: boot a kernel, do the work, write `.cortex/`, exit.
Process identity survives across invocations via `ChainId` plus on-disk state.

**Demos** (`examples/`)
- **A — supervision tree** (`supervision-tree.ts`): a planner spawns three
  coders, notices one hanging via a bounded `wait`, kills it, respawns it, and
  assembles the result. ~40 lines of ordinary `async`/`await`, no orchestrator.
- **B — pause across reboots** (`checkpoint-agent.ts`): an inbox-watcher
  checkpoints mid-run and detaches; after a reboot it is restored as a *new PID*
  with memory rehydrated, skips what it already did, and clears the queue.
- **C — fork and compare** (`fork-compare-agent.ts`): a coder forks at a
  decision point; the two branches take different dedup designs and `cortex diff`
  aligns them from the shared causal past.

**Documentation**
- Four design contracts: [STATE](./docs/STATE.md) (what agent state *is*),
  [PROCESS](./docs/PROCESS.md) (lifecycle), [ABI](./docs/ABI.md) (the syscall
  contract), [ARCHITECTURE](./docs/ARCHITECTURE.md) (modules and data flow).
- [HACKING.md](./docs/HACKING.md) (contributor guide) and
  [COOKBOOK.md](./docs/COOKBOOK.md) (nine runnable recipes).
- A dependency-free [landing page](./docs/index.html) and the
  [logo](./docs/logo.md).
- Chinese translations: [MANIFESTO.zh-CN.md](./MANIFESTO.zh-CN.md),
  [docs/STATE.zh-CN.md](./docs/STATE.zh-CN.md),
  [README.zh-CN.md](./README.zh-CN.md).

**Tests** — `scripts/smoke.ts`, **479 assertions, 0 failures**. This is the
regression suite; `npm test` is not (`tests/` is intentionally empty).

### Changed

- **Execution model (the load-bearing change).** Agents used to run to
  completion inside the quantum that dispatched them, which made `wait()`
  deadlock by construction — a parent parked in its own resume meant its
  children could never be scheduled. Continuations are now cooperative (see
  PROCESS.md §8.2), which is what makes supervision trees writable at all.
- Checkpoint/restore now works across separate CLI invocations, and the CLI
  returns real exit codes.
- Reversibility in `audit` distinguishes *declared* from *inferred*.

### Known limitations

These are deliberate `v0` boundaries, not oversights. Each is recorded in
[BACKLOG.md](./BACKLOG.md) rather than hidden.

- A checkpoint captures the process **image** — memory, budgets, lineage — not
  the live JS call stack. A restored agent re-runs from the top and skips
  completed work via a memory marker. True continuation capture is post-v0. This
  is the sharpest limitation; see [docs/STATE.md](./docs/STATE.md) §5.4.
- `attach` is a read-only, disk-based follow-mode trace. The interactive
  "pipe stdin into a live agent" half needs a first-class long-running kernel;
  `daemon run` supervises one, but the CLI is otherwise short-lived.
- Single host, single process. No distribution, no k8s, and no cross-kernel IPC
  (one kernel per state directory).
- Synchronous syscalls (`now`, `random`, `budget`, `on_signal`) are not written
  to `.crec`.
- `sleep()` does not do `RUNNING → BLOCKED → READY` accounting; a sleeping
  process still reports as `RUNNING`.
- `restore` does not automatically `RUN` the restored process; the CLI applies a
  stopgap.
- Persistence is a flat directory, not the subtree described in ARCHITECTURE §7.
- Sandbox fork, shadow process, `cortex gc`, and `cortex doctor` are post-v0.

[0.1.0]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.1.0
