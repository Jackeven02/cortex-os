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

## [0.1.3] — 2026-09-19

A bug-fix pass over `0.1.2`. The syscall ABI (`docs/ABI.md`), the state model
(`docs/STATE.md`), the CLI surface and the on-disk formats are all unchanged —
this is a patch bump, not a new contract. Every fix below was reproduced before
it was changed, and each is now pinned by a regression check; the smoke suite
grew from 479 to 483 assertions.

### Fixed

- **A PID could be handed out twice across two CLI invocations, silently
  merging two processes' logs.** This is the one that mattered. The CLI treats
  the disk as the source of truth and, on every invocation, seeds its PID
  counter from the highest PID already on disk so a new process never collides
  with an old one. But `maxPidOnDisk` only scanned `*.meta.json` files — and a
  *forked* child writes a `<pid>.crec` syscall log without ever writing a meta
  file. So the highest live PID could be invisible to the scan; the next spawn
  or fork reused it, and because `Recorder.open` uses `'a+'`, the two logs were
  appended into one file. Verified empirically: a forked `3.crec` grew from
  3,412 to 6,165 bytes when a second process was allowed to reuse PID 3.
  `maxPidOnDisk` now scans `*.crec` and `*.meta.json` alike.
- **A completed child could be `wait()`ed for twice.** When a child exited, its
  final status was retained in the table so a parent that called `wait()` *late*
  (after the child was already a zombie) could still collect it — but the retain
  was unconditional and the retained copy was never consumed on delivery. A
  second `wait()` for the same, now-gone child found the stale copy and handed
  the status back again, which real Unix `wait()` can never do. `reap()` now
  takes an explicit `retain` option; the fast (already-zombie) `wait()` paths
  reap without retaining, and the wake path retains only long enough to deliver,
  then consumes the copy — while still leaving it in place when a *different*
  child exits and the parked parent has no waiter for *that* one yet. A second
  `wait()` for a collected child now traps `ESRCH`.
- **A reaped process's kernel-side attachments leaked.** Nothing was wired to
  clean up after a process died: its parked IPC waiters, its memory-region
  bindings, and its entry in the wake-gate all outlived it. A `close()`d channel
  could leave a waiter parked forever, and stale region bindings could pin
  copy-on-write backing memory. `InitProcess` now takes an `onReaped` hook, and
  `boot.ts` wires it to cancel the dead PID's IPC waiters, release its memory
  bindings, and clear its wake-gate entry. Reaping is the single choke point
  every exit path flows through, so the cleanup is guaranteed regardless of how
  the process died.
- **The MCP tool driver crashed on a lenient server.** The response handler
  treated any `error` field that was not `undefined` as a JSON-RPC failure — but
  a number of servers echo `error: null` alongside a perfectly good result, and
  `null !== undefined`, so the driver threw on success. The guard now only
  rejects when `error` is a non-null object.
- **The driver ABI gate rejected a legal version range.** `>= 1.0.0` — a
  comparator with a space before the version, which npm and semver both accept —
  was parsed by splitting on whitespace, so the comparator `>=` and the operand
  `1.0.0` were treated as two unrelated tokens and the constraint could never
  match. `satisfiesAbi` now normalises whitespace immediately after a comparator
  before it splits.
- **`cortex restore` wrote a placeholder meta file, and both `spawn` and
  `restore` accepted garbage `--timeout` values.** After a successful restore the
  command re-read the live table for the new PID, but by then the poll loop could
  already have reaped it, so the meta written to disk carried placeholder
  `agent`/`ppid`/budget fields instead of the restored process's real ones —
  lying to every later command that reads that index. The real spec is now
  captured before the poll can touch it. Separately, `--timeout` was parsed with
  `parseInt` and never validated, so `--timeout abc` silently became `NaN` (no
  timeout at all) and `--timeout -5` behaved as an immediate timeout; both
  commands now reject non-positive-integer timeouts up front with exit 1.
- **The filesystem driver's sandbox could be escaped by a glob.** `fs_glob`
  resolved its `cwd` against the root but never filtered the *matches*, so a
  pattern like `../*` returned paths outside the declared sandbox root. Each
  match is now checked against the root the same way a direct path is.
- **`sqlite` memory reads interpolated an unvalidated limit.** The `limit` was
  spliced into the SQL text; while the surrounding `> 0` guard already rejected
  the only way to actually inject through it, the read path is now hardened to a
  bound `LIMIT ?` parameter with an explicit safe-integer check, so it cannot
  regress into a live injection if the caller-side guard ever moves.
- **A checkpoint lost the process's remaining budget.** A snapshot stored only
  the *spent* counters, so restoring re-seeded a process with a full (untouched)
  budget envelope and it got a free refill of every token and dollar it had
  already burned. The `Checkpoint` record now also carries `budgetsRemaining`
  (optional, so snapshots taken by `0.1.2` still load), and `restoreAs` overwrites
  both the limits and the spent counters from the snapshot rather than
  "spending" the recorded totals against a fresh envelope.

---

## [0.1.2] — 2026-09-19

Documentation only. No code, no ABI, no CLI surface, no behaviour change —
`0.1.2` is `0.1.1`.

### Changed

- **The READMEs now explain how to install the thing.** Neither one had an install
  section at all: both went straight from the CLI demo to Status, and the only
  install instructions anywhere in the tree were the `git clone` lines in the
  publish runbook — while the package had been on npm since `0.1.0`. `README.md`
  and `README.zh-CN.md` now carry an `## Install` / `## 安装` section in the same
  position, covering the global install (`npm i -g cortex-agent-os`, which puts
  `cortex` and `ctx` on the `PATH`), the `npx` form, the Node and dependency
  requirements, the clone-and-run-the-suite path for anyone working on Cortex
  itself, and why the npm package is `cortex-agent-os` while the binary is still
  `cortex`.

---

## [0.1.1] — 2026-09-19

A one-defect patch. The kernel, the syscall ABI, the CLI surface, the drivers and
the state model are all untouched — `0.1.1` is behaviourally identical to `0.1.0`
apart from the version string the CLI prints about itself.

### Fixed

- **The CLI reported the wrong version about itself.** `cortex --version` and
  `cortex help` both printed `cortex v0.0.1` while the manifest said `0.1.0`. The
  number was written out by hand in three places — the `VERSION` constant in
  `src/index.ts` plus a literal banner in each of `src/cli/index.ts` and
  `src/cli/commands/help.ts` — and all three were missed when `package.json` was
  bumped for the release. `VERSION` is now read from the package manifest at load
  time, so the two cannot disagree again; it is resolved against
  `import.meta.url` so it works from both `src/` and `dist/`.
- **The smoke check that should have caught this was too weak to.** It asserted
  only that `VERSION` was a non-empty string, never what it contained, so a
  release shipping `v0.0.1` passed 479/479. It now compares `VERSION` against
  `package.json` and additionally fails if either CLI banner reintroduces a
  hardcoded `cortex v<x.y.z>` literal.

### Note on the npm package name

The npm artifact is **`cortex-agent-os`**, not `cortex-os`. npm refuses
`cortex-os` as too similar to the already-registered `cortexos` — the two are
identical once punctuation is stripped — and that guard is evaluated only at
publish time, so it cannot be checked for in advance. The repository name and the
`cortex` / `ctx` binary names are unchanged; only the package you install differs.

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

[0.1.2]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.1.2
[0.1.1]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.1.1
[0.1.0]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.1.0
