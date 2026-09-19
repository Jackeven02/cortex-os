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

## [0.2.0] — 2026-09-20

The first release that closes v0 gaps instead of only patching defects. Three of
them were places where **the documents already promised behaviour the code did
not implement** — arguably worse than a missing feature, because the docs were
the thing you would have trusted. Each fix moves its documents in the same
commit; nothing here is a silent divergence.

### Fixed

- **`sleep()` parks for real.** `dispatcher.#sleep` used to await a timer with
  the process left in RUNNING the whole time, so `ps` called a napping agent
  runnable — while `docs/ABI.md` §4.6 specified the walk RUNNING → BLOCKED →
  READY and `docs/COOKBOOK.md` printed it in a comment. It now walks that walk,
  reports `blockedOn.kind === 'sleep'`, and wakes through the same gate `wait()`
  and `recv()` use, so the body never resumes while still BLOCKED. `exit`
  cancels a pending sleep timer.
- **A restored process runs on its own.** `restore` handed back a process in NEW
  and nothing in the kernel adopts NEW — the scheduler dispatches READY — so it
  sat there until something outside the kernel walked it forward. The CLI
  carried a stopgap; library users had none. `dispatcher.#restore` now walks
  NEW → READY and enqueues, and the stopgap is deleted. (`restoreAs` still
  mints NEW: adoption is the syscall's job.)
- **The synchronous syscalls are recorded.** `now`, `random` and `on_signal`
  were served by a sync fast-path that replicated the state gate but wrote no
  `.crec` frame, so a replay had to trust that the injected clock and RNG would
  produce the same values — only true if the agent makes the same calls in the
  same order. The frame is now built synchronously, capturing the value actually
  served, and flushed at the process's next async boundary (before that syscall's
  own `enter` record, so the log stays in causal order). `budget` stays
  unrecorded — now by explicit policy (§4.8), because it is derivable, not
  because the plumbing cannot reach it.

### Added

- **`cortex top`** — the process tree as a tree: parent above children, each
  with its state, its spend, and, when it is blocked, *what it is waiting on*
  (`sleep`, a child, a channel, a model call, a tool call). Orphans hang off
  init rather than disappearing. Exists because the hardest thing about cortex
  is not any single primitive; it is seeing that a running agent is a process
  with a parent, a state and a budget. `ProcessMeta` gained an optional
  `blockedOn` so the read-only views can say *why* a process is not running.

### Changed (breaking, allowed under `0.x`)

- **`BlockedReason` gained a `sleep` variant** (`{ kind: 'sleep', until }`).
  Anything that switches exhaustively over `BlockedReason` must add a case. The
  syscall ABI is not frozen until `1.0.0`.

### Still open (honestly)

- **The persistence layout is still flat.** `docs/ARCHITECTURE.md` §7 sketches
  `processes/<pid>/{log.crec,meta.json,checkpoints/}`; the disk is still
  `processes/<pid>.crec` + `<pid>.meta.json` + a single shared `checkpoints/`.
  It was deliberately **not** done in this release: `CheckpointManager` owns one
  directory and resolves a checkpoint by chainId by listing it, so per-process
  checkpoint directories change `load()` from a list into a search across the
  tree — a real refactor, not a rename. Tracked in `BACKLOG.md`.

Smoke: 510 → 512 checks.

## [0.1.8] — 2026-09-19

The region ceiling becomes a real per-region quota. `0.1.6` and `0.1.7` exposed a
single *global*, per-boot write-count cap (`maxRegionEntries`) shared by every
region. This release lets each memory region carry its own `maxEntries`, so one
process can hold `episodic` tight while leaving `semantic` wide open, and it
finally gives the CLI a way to *declare* region policies at all — the thing that
was missing and made the global knob the only reachable one. It is additive and
backwards compatible: the default regions and their copy semantics are unchanged,
unspecified regions keep their defaults, plain `.meta.json` files omit the new
field, and the syscall ABI and state model are untouched.

A region's `maxEntries` resolves in three states and **takes precedence** over
the global cap — absent inherits it, `-1` opts that region out to unlimited, `0+`
is a hard cap. The `MemoryManager` resolves the *effective* cap per region at
write time and still runs the `ENOMEM` check *before* any copy-on-write
divergence, so a rejected write never splits a shared region. The resolved value
is now visible to introspection as `MemoryRegionInfo.effectiveMaxEntries`.

On the CLI, a new `--memory <json>` option on `cortex spawn` and
`cortex daemon install` takes a JSON object keyed by region name and merges it
over the standard `episodic`/`semantic`/`procedural` defaults — override-by-name,
add-new, keep-untouched — so you only spell out what you change. Parsing,
validation and merging live in a new pure module, `src/cli/regions.ts`, which
rejects malformed JSON and bad policy shapes (unknown fields, a bad `kind`, an
empty `backing`, a non-boolean `readOnly`, a non-integer or sub-`-1`
`maxEntries`) and makes the command exit `1` *before* booting. For daemons the
resolved policies persist in the daemon spec and apply on every (re)spawn; for
spawned and restored processes they persist in the process's `.meta.json` (a new
optional `memory` field), which `bootCliKernel`'s `restoreContext` now re-declares
instead of reverting to defaults. That last piece also closes a pre-existing
latent gap: a custom region policy set at spawn time (even just `readOnly`) used
to be silently dropped across a cross-invocation `cortex restore`.

### Added

- **`MemoryRegionPolicy.maxEntries`** — the per-region write-count ceiling, with
  `MemoryManager` enforcement (precedence over the global cap, `ENOMEM`-before-
  COW preserved) and `MemoryRegionInfo.effectiveMaxEntries` introspection. Fork
  inherits a region's `maxEntries` by reference; `memoryOverrides` may supply a
  different one for the child.
- **`--memory <json>` on `cortex spawn` and `cortex daemon install`**, backed by
  the new `src/cli/regions.ts` parser/validator/merger.
- **Cross-invocation persistence of resolved region policies** via a new optional
  `ProcessMeta.memory` field written by `spawn`/`restore` and honored by the
  disk-backed `restoreContext`.

The smoke suite grew from 492 to 510 — 18 new checks covering manager-level
per-region precedence, the `-1` opt-out and effective-cap introspection,
per-region `ENOMEM`-before-COW, fork inheritance and `memoryOverrides`, a boot
end-to-end tighten-and-opt-out through the real `spawn` path, unit coverage of
the `regions.ts` parser and its validation rejections, the `ProcessMeta.memory`
round-trip, and the `cmdSpawn --memory` argument-validation path.

---

## [0.1.7] — 2026-09-19

A small follow-on to `0.1.6`: the region-entry ceiling is now reachable from the
supervised long-running path too, not just one-shot `spawn`. Additive and
backwards compatible — the boot-level plumbing and the `ENOMEM` enforcement are
unchanged, the default is still unlimited, and the ABI/state model is untouched.

### Added

- **`cortex daemon run --max-region-entries <n>`.** The same boot-configurable
  per-region write-count ceiling introduced in `0.1.6` is now surfaced on the
  daemon supervisor command, so a long-lived supervised daemon's `memory_write`
  calls are bounded the same way a `spawn`-ed agent's are. It is a boot-level
  option applied to the kernel that runs the daemon(s) (deliberately *not*
  persisted into `daemons.json`, which would require a `DaemonSpec`/data-model
  change), validated as a positive integer, and omitted means unlimited exactly
  as before. ARCHITECTURE.md §4.5 was updated to list both `cortex spawn` and
  `cortex daemon run` as surfaces. No smoke-suite change (the manager-side
  enforcement and the boot→manager plumbing are already covered by the `0.1.6`
  tests, which this path reuses verbatim); verified end to end at the CLI level.

---

## [0.1.6] — 2026-09-19

Turned a latent capability into a usable knob. The kernel has always had a
per-region write-count ceiling that traps `ENOMEM` when a memory region grows
past it — but nothing outside the kernel could set it, so in practice the guard
was unreachable and every region was effectively unlimited. This release wires
that ceiling from the boot config all the way up to the CLI. It is additive and
backwards compatible: the default is unchanged (unlimited), the syscall ABI,
state model and existing behavior are untouched, and the `ENOMEM`-before-COW
ordering was already corrected in `0.1.5`. The smoke suite grew from 490 to 492.

### Added

- **A boot-configurable region-size ceiling, reachable from the CLI.**
  `KernelOptions.maxRegionEntries` is now threaded through `boot.ts` into the
  `MemoryManager`, so a kernel can be booted with a global cap on how many
  writes any single region may accept before `memory_write` traps `ENOMEM`
  (docs/ABI.md §4.4 "region size limit"). It is surfaced on the command line as
  `cortex spawn --max-region-entries <n>`, validated as a positive integer
  (omitting the flag means unlimited, exactly as before). A read-only
  `MemoryManager.maxRegionEntries` getter exposes the effective ceiling for
  introspection and tests. Regression-tested two ways: the manager defaults to
  unlimited and a boot-configured value reaches it intact; and a spawned process
  carrying a private region enforces the cap end to end, accepting the writes up
  to the limit and trapping `ENOMEM` on the first one that would exceed it while
  leaving the accepted writes in place.
  - *Scope note:* this is one coarse ceiling shared by every region on the
    kernel, not a per-region quota — a `MemoryRegionPolicy.maxEntries` field and
    cross-invocation persistence of per-region limits are natural future
    refinements, deliberately left out of this release to avoid touching the
    checkpoint/`meta.json` data model.
  - *Docs:* ARCHITECTURE.md §4.5 (the ceiling and its boot/CLI wiring), ABI.md
    §4.4 (the `ENOMEM` error now points at the configurable ceiling), and
    COOKBOOK.md (a usage example) were updated in the same change.

---

## [0.1.5] — 2026-09-19

Three more defects from the `0.1.3` review's "found but deferred" list, chosen
because each is a genuine correctness break rather than a stylistic wart. The
syscall ABI, the state model, the CLI surface and the memory/IPC/contract text
are all unchanged; this is a patch bump. The smoke suite grew from 486 to 490
assertions.

### Fixed

- **A finite `wallTimeMs` budget never drained, so wall-clock time could never
  trip `SIGXCPU`.** The budget docs promise remaining time "decrements on every
  relevant syscall", and `checkBudget()` looks for the wall-time counter to reach
  zero — but the accounting path only ever charged wall-time from an explicit
  `delta.wallTimeMs` in the syscall result, which no driver ever supplies. Real
  elapsed time between syscalls was simply dropped, so a process configured with
  unlimited tokens and USD but a capped wall time ran forever. Each process now
  carries a `lastWallAccountAt` timestamp; `spend()` adds the elapsed interval
  since the last charge (and advances the stamp) before decrementing the
  remaining wall-time budget, clamping to zero on exhaustion as the other budget
  kinds do. `setBudgets()` — used by `fork` under `inherit`/`split` policies and
  by checkpoint restore — resets the stamp so a fresh process does not inherit a
  stale window. Regression-tested end to end: with tokens and USD unlimited and
  `wallTimeMs: 100`, advancing the clock past the cap and issuing one `llm_call`
  drains the budget to zero, fires `SIGXCPU`, stops the process, and a further
  syscall then traps `ESTATE`.
- **`send()` mutated channel state before an awaitable record that can fail, so
  a "failed" send could still take effect.** Both the direct-handoff and the
  enqueue branches incremented counters / shifted a parked waiter / pushed onto
  the queue *before* `await this.#recordSend(...)`. If the `.crec` append threw,
  the call surfaced `ERECORD` while the message had in fact been delivered or
  enqueued and the counters bumped — a phantom, half-committed send. The mutation
  branches are now atomic: commit, attempt the record, and on failure roll back
  (restore the waiter to the front of the parked set and undo the send/recv
  counters for a handoff; pop the queued message and decrement `totalSent` for an
  enqueue) before rethrowing. `#recordSend` also captures the queue depth as a
  parameter taken *before* the mutation, so the recorded value no longer depends
  on live channel state that a rollback might have undone. Channel-membership
  bookkeeping is left in place on rollback because it is purely diagnostic.
  Regression-tested both ways: a recording failure leaves the queue empty and
  `totalSent` at zero (and a later healthy send still commits), and a failed
  handoff leaves the very same waiter parked and the receiver still blocked, so
  the next healthy send serves it.
- **A write destined for `ENOMEM` still paid for — and left behind — a
  copy-on-write split.** In `memory_write`, the COW divergence ran before the
  entry-count ceiling check. Duplicating a shared region is not free: it
  snapshots and restores the whole region, releases the shared physical key, and
  rebinds the writer to a fresh key — and none of that was rolled back when the
  subsequent `ENOMEM` rejected the write. The result was that a syscall which
  should be observably a no-op silently broke the parent/child share: the
  sibling relationship diverged even though no data was ever written. The
  entry-count check now runs first, so a rejected write fails before touching any
  state. The accept/reject decision is unchanged because divergence copies the
  size forward to the new key rather than resetting it, so the count being tested
  is the same either way. Regression-tested: writing to a shared `cow` region at
  its limit traps `ENOMEM`, triggers no region snapshot, and leaves both the
  binding keys identical and the refcount at 2.

---

## [0.1.4] — 2026-09-19

Two more real defects, both from the "found but deferred" list of the `0.1.3`
review — picked because they actually bite rather than merely being untidy. The
syscall ABI, the state model, the CLI surface and the memory/IPC contracts are
unchanged; this is a patch bump. The smoke suite grew from 483 to 486 assertions.

### Fixed

- **The filesystem driver's sandbox could be escaped with a symlink or a
  directory junction.** Containment was checked on the *lexical* path —
  `path.resolve()` collapses `..` but never follows a reparse point. So an agent
  could plant a link *inside* the sandbox root that points at a file *outside*
  it, read the link path, and the guard would wave it through because the string
  looked contained while the real target was not. Reproduced on Windows with a
  directory junction (and trivially on Linux/macOS with a symlink): `fs_read` on
  the link path returned the outside file's contents. Every entry point
  (`read`/`write`/`list`/`glob`) now canonicalises through `realpath` before the
  containment check, resolving the deepest existing ancestor so not-yet-created
  write targets are still checked at their real location, and compares the
  canonical path to the canonical root via `relative()` (robust to separators and
  case). `glob` matches are likewise canonicalised before being tested, so a
  linked directory inside the tree can no longer leak its outside contents.
- **Two logically distinct memory regions could silently share one SQLite
  table.** The SQLite driver turned a region name into a table name by replacing
  every non-alphanumeric character with `_`, which is lossy: `mem-1` and `mem_1`
  both became `r_mem_1`, so writes to one region overwrote the other's entries,
  and `listRegions()` — which just sliced off the prefix — could not tell them
  apart either. Reproduced: `mem-1`'s value was clobbered by `mem_1` and only one
  region was listed. Region names are now encoded with a reversible, injective
  scheme (safe characters verbatim, `_` doubled, every other code point as `_`
  plus six fixed-width hex digits), and `listRegions()` decodes back to the exact
  original name. Common names like `episodic`/`semantic` are unchanged, so the
  kernel's own region handling is unaffected.
  - *Behaviour note:* tables created by `0.1.3` and earlier used the lossy name,
    so after upgrading a persisted DB will present those under the new encoding;
    use a fresh database file or re-register the regions. This does not touch the
    in-memory driver, checkpoints, or any ABI.

The symlink regression test creates a real reparse point and self-skips only on
platforms that forbid it outright (e.g. a stock Windows shell without developer
mode); Linux/macOS CI exercises the escape path for real.

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

[0.1.8]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.1.8
[0.2.0]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.2.0
[0.1.7]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.1.7
[0.1.6]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.1.6
[0.1.5]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.1.5
[0.1.4]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.1.4
[0.1.3]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.1.3
[0.1.2]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.1.2
[0.1.1]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.1.1
[0.1.0]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.1.0
