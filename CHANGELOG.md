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

**On the `0.x` (history, now closed):** the syscall ABI was not frozen during
`0.x`. A minor bump was allowed to carry a breaking change to the ABI or the
state model — `0.1.0` → `0.2.0` was allowed to hurt, and `0.2.0` did
(`blockedOn` gained a `sleep` variant).

**From `1.0.0` the ABI is frozen.** Breaking changes — removing or renaming a
syscall, changing what an argument means, changing an errno contract, changing
a `ProcessInfo` field, or changing the `.crec` / `.csnap` format — require a
major bump. Additive changes that cannot break an existing agent land in a
minor. The full rule is in [docs/ABI.md](./docs/ABI.md) under "ABI status".

---

## [Unreleased]

### Added

- **`cortex ps` says what each agent is waiting on.** The flat table had the
  state and nothing else: `blocked`, with no word about *what* the process was
  blocked on — and `running` for an agent four minutes into a model call,
  which is a fact about the scheduler and not about the agent. The table now
  has a **WAITING** column, and it says "a channel", "child 5", "a model
  call".

  **The column is last, and the cell is a noun.** The existing seven columns
  keep their positions, so a script that reads `cortex ps` by column number
  still reads the column it read before. The cell is the *what* ("a
  channel"); the *how long* stays `cortex top`'s job ("waiting on a channel
  for 44.4s"), because those are different questions. The age column is
  coarse on purpose too — "4m" is enough for an age, and "44s" and "4m" are
  different answers to "should I kill this?".

  **The wording is the wording the other views use.** `describeWait` and
  `describeBlocked` live in `src/cli/open_call.ts`, next to the reading
  itself, so a table cell and a tree line cannot drift apart: `ps` says "a
  channel", `top` says "waiting on a channel for 12.3s", and the dashboard
  says the same sentence. The *rule for which source answers* is shared the
  same way — the kernel's blocked reason wins when it has one (it knows
  *which* child), and the open call is used otherwise, which is how a driver
  call shows up at all, since the kernel does not park a process while its
  model call is in flight (BACKLOG #060).

  **A view that cannot ask does not go silent.** A kernel too old to know the
  `openCalls` command used to leave the table with a row of blanks — and a
  blank says "nothing is being waited on", which is a claim, and it is false
  whenever the log knows better. The table now falls back to the log through
  the *same* function `cortex top` uses, so the two views cannot end up
  disagreeing about the same agent.

  **4 new smoke checks** (683 → 687), all four reverse-verified: the table
  stopping to ask the kernel → "cortex ps says what an agent inside a model
  call is doing" fails; the table phrasing the wait in its own words → "cortex
  ps and cortex top use the same words for the same wait" fails; the *tree*'s
  wording changed instead of the table's → the model-call check fails again;
  and the log fallback removed → "cortex ps still says what a process is
  waiting on when the kernel is too old" fails.

  No ABI change: this round adds no syscall, no transport command, and no
  field to `ProcessInfo` — the table asks the kernel a question the kernel
  could already answer.

- **The dashboard says what each agent is inside.** The page is the operator's
  window, and it was blind to the one fact an operator of an agent OS most
  wants: an agent that is four minutes into a model call read as `running`,
  and an agent parked on a channel read as `blocked` — the process table
  cannot tell a listener waiting for a message from an agent that will never
  be answered, and it cannot see a driver call at all, because the kernel does
  not park a process while its LLM call is in flight (BACKLOG #060).

  The kernel knows: it writes every syscall as an `enter` frame and its
  partner, and it knows which pairs are still open. The dashboard asks it —
  the same way `cortex top` does — and the row carries the answer as
  `insideLabel`: "waiting on a channel for 1m2s". The supervision tree shows
  it too, and the page's filter matches it, so an operator can search
  "model call" to find the agent that is stuck.

  **The wording is one function, not two.** `src/cli/open_call.ts` now holds
  the *words* as well as the reading: what a process is waiting on (`a
  channel`, `a timer`, `a child`, `a model call`) and how long it has been
  waiting. `cortex top` and the dashboard both call it, so an operator who
  reads "waiting on a channel" in one view and something else in the other
  does not have to work out whether those are the same thing. The page prints
  the label it is given and does not re-implement the rule — the same
  discipline the capability column already follows.

  **And the column appears only when the kernel can answer.** The label's
  *presence* is the signal: a row with no label at all means the kernel did
  not answer (it is too old to know the command, or there is no kernel), and
  a column of blanks would claim that nothing is inside a call — a different
  fact from "nothing is inside a call".

  **2 new smoke checks** (681 → 683) and an existing one extended, all
  reverse-verified: the dashboard stopping to ask the kernel → "the dashboard
  says what each agent is inside" fails; the dashboard phrasing the wait in
  its own words → "the dashboard and cortex top phrase the wait the same
  way" fails; and the page working the wording out for itself → "the page
  does not re-implement what it is shown" fails.

  No ABI change: this round adds no syscall, no transport command, and no
  field to `ProcessInfo` — the dashboard asks the kernel a question the
  kernel could already answer.

- **The host stopped rebuilding what the kernel already knew.** `cortex top` and
  `cortex supervise` both answer one question — *which call is this process
  inside, and for how long?* — and they used to answer it by reading the
  process's whole `.crec` and pairing the frames themselves. The kernel can
  answer it directly: it writes every syscall as an `enter` frame and its
  partner, and it knows which pairs are still open. The host was rebuilding a
  fact the kernel had, at O(bytes) instead of O(processes) — and the log of a
  long-lived agent grows for as long as the agent runs, so the operator's most
  frequent question got slower exactly as it was most needed.

  So the kernel answers: `Kernel.openCalls()` on the host side, `openCalls` on
  the transport. The entry is set when the `enter` frame is written and cleared
  when its partner is, and the `since` it reports is **that frame's own
  timestamp** — so the kernel's answer and the log's answer are the same
  number, not two numbers that happen to be close. Measured against a live
  kernel with a 13 MB log: the log path took 273–283 ms per view, the kernel
  path 0–1 ms.

  The call's **arguments** travel with it, and that is not decoration: the
  arguments are what say a `wait` carries its own deadline, and a declared wait
  is not a stall. An earlier version of this dropped them, and the bounded
  `wait` was promptly called a stall — caught by the existing check, because
  the view and the supervisor must agree about what "stuck" means.

  **And the pairing is by call id, because a process can be inside two calls.**
  Nothing forbids an agent from awaiting two syscalls at once. The second
  reaches the dispatcher before the first has parked the process, so both are
  admitted — and the second then traps, because by then the process is no
  longer RUNNING. A bookkeeping that kept one slot per process would close
  the first call's slot when the second call closed, and report "nothing" for
  a process that is demonstrably still inside its `sleep`. A real run against
  a real kernel showed exactly that: the log said `sleep`, the kernel said
  nothing, and the process was still in the sleep.

  **A kernel that cannot be asked is not a kernel with nothing to say.** The
  reader returns nothing at all when the kernel is too old to know the command
  or is not answering, and the caller falls back to the log; an *empty* answer
  from a kernel that was asked means the kernel really has no open calls. And
  a process the kernel no longer holds is not reported at all — a dead
  process's log keeps the `enter` frame of the call it was killed in, and
  reading that as "still inside that call" is a lie.

  **5 smoke checks** (676 → 681), all five reverse-verified: `cortex top`
  reading the log again → "cortex top still knows what a process is inside when
  the log says nothing" fails; the kernel stamping the time at query time
  instead of the frame's own → "the kernel and the log say the same thing
  about an open call" fails, and so does the stall marking, because a call
  that started "now" is never stale; the kernel dropping the arguments → both
  the declared-wait agreement and the bounded-wait view fail; the supervisor
  reading the log instead of asking → "cortex supervise finds the call even
  when the log says nothing" fails; and one slot per process instead of one
  per call → "a process with two calls in flight still reports the one it is
  inside" fails.

  No ABI change: `Kernel.openCalls()` is a host method and `openCalls` is an
  additive transport command, so `KERNEL_ABI_VERSION` stays 1.0.0 and
  `KERNEL_PROTOCOL_VERSION` does not move either.

- **`cortex wrap` stopped reporting success for a run that failed.** A
  process that is **exiting** has not finished: the kernel records its exit
  code *after* it gets there — two disk writes sit between the two — so there
  is a real window in which the process table says "dying" and the code is
  still `null`. The wrapper used to read that window as "no code" and default
  it to `0`, so `cortex wrap -- <command that failed with 127>` sometimes
  reported **success**. The full smoke suite caught it twice in a row under
  load, and the failure looked exactly like the timeout bug that was fixed
  earlier: `process exited (code 0: completed)`.

  Two halves, because the lie was in two places:

  - the wrapper now **waits** for an ending it can trust — the zombie, which
    carries the code, or the reap, which leaves the exit record on disk
    (`attemptFinished`);
  - and the report never invents a zero for a code it did not see: a missing
    code is reported as unknown, not as success (`wrapOutcome`).

  Both are exported pure functions, so the rules are pinned on their own
  rather than left to a race. The end-to-end check now runs the missing
  command three times, because a race that only shows up under load is
  exactly the kind that survives a test suite and shows up in somebody's CI.

  **1 smoke check** (675 → 676), reverse-verified twice: putting the missing
  code back to `0` → the check fails with "an exit code that was never seen
  must not be reported as success, got 0"; and counting `exiting` as finished
  again → the check fails with "a process that is exiting has not finished".

- **The dashboard's process table stopped being a snapshot.** The dashboard is
  the operator's window, and its process list was showing them a picture of
  the past: the table was re-read only when a process *started* or *ended*, so
  an agent that worked for a minute was shown as it was when it started — its
  state frozen, its spend frozen — while the page said "live connection" in
  the corner.

  The kernel says what happens (every syscall, every state transition, and
  when it happened), so **the table is re-read when the kernel says
  something**. The re-read is **throttled**, not debounced: a busy kernel
  says something every few milliseconds, and a re-read that waited for the
  silence would never happen — the table would sit frozen through exactly the
  busy period it exists for. This was not a theory. A real run against a real
  daemon measured **two tables in fifteen seconds** before the throttle and
  about **four a second** after it, and the smoke suite now pins the
  difference (a table that is pushed once and then stops is a failure).

- **The dashboard says what each agent was allowed to do.** `cortex ps` grew a
  CAPS column two rounds ago, because the question "what was this agent
  allowed to do?" used to have no answer in the CLI at all. The dashboard —
  the operator's *window* — still had none. It has one now.

  The label travels with the row (`capsLabel`), produced by the same rule
  `cortex ps` prints (`formatCaps`, which moved from the command into
  `src/cli/process_view.ts` so the two views share it): an agent restricted to
  `spawn` says `spawn`, an agent holding everything says `all`, an agent
  holding nothing says `none`, and a process whose capabilities were never
  recorded says `-` — which is *not* "everything", it is the absence of an
  answer. The page prints the label it is given and does not re-implement the
  rule, because a second rule is a rule that drifts.

- **The footer says which way the page is being refreshed.** It used to claim
  "auto-refresh · every 3 seconds" whatever it was doing — and with a live
  kernel it was not polling every 3 seconds at all. It now names the mode:
  "live push (SSE), reconciled every 30 seconds" while the kernel is pushing,
  "polling every 3 seconds (the live connection is unavailable)" when it is
  not.

  **3 smoke checks** (672 → 675), all three reverse-verified: removing the
  re-read trigger → the table is never pushed again; giving the dashboard its
  own capability rule → the two views disagree (`pid 6 holds "none", got `
  — the empty string a naive join produces); and putting the throttle back to
  a plain debounce → the table stops at two tables in four seconds.

  No ABI change: `KERNEL_ABI_VERSION` stays 1.0.0, and `ProcessInfo` is
  untouched — the dashboard reads the same view `cortex ps` reads and renders
  one more column of it.

- **The supervisor stopped waking up for nothing.** `cortex supervise` was
  built on the event stream, but its *decisions* were still made on a timer: it
  woke every 250 ms to ask itself whether anything had changed. So a process
  that ended at 10:00:00.100 was reported at 10:00:00.310, a stall threshold
  was crossed up to a quarter of a second late, and a supervisor watching a
  quiet agent for an hour woke it fourteen thousand times to find nothing.

  The supervisor now sleeps until something can matter: **an event from the
  kernel, an interrupt, the kernel going away, or the next deadline.** There
  is no tick. The deadline rule is one function (`nextDeadline`), and a
  **declared wait has no deadline at all** — an agent that said it would be
  back in an hour is not something to wake up for, and a `sleep` is not a
  stall. The rule that decides "what counts as a stall" now lives in one
  place (`isDeclaredWait`), shared with `cortex top`, so the two commands
  cannot disagree about what a hang is.

  Measured on a live kernel, with the clock started at the kernel's own
  `process-exit` event and stopped when the supervisor's line reached the
  terminal:

  | | reaction after the kernel said so |
  |---|---|
  | the old 250 ms tick | 106 ms / 156 ms / 261 ms |
  | event-driven | **0 ms / 0 ms / 0 ms** |

- **The supervisor cannot miss an ending.** The subscription opens **before**
  the state check — the same rule `cortex attach` and `cortex logs` follow —
  so a process that ends while the supervisor is still starting up has its
  ending already in hand. (Before this, the check came first, and a process
  that ended in that window left the supervisor waiting for an event that had
  already been and gone: it waited forever.)

  And a process that is **already over** is reported as over. A zombie whose
  parent is still alive is still in the kernel's table, and the supervisor
  reads the ending out of it instead of waiting for a `process-exit` that
  will never come:

  ```console
  $ cortex supervise 12
  # pid 12 exited with code 137 (signal:SIGKILL)
  ```

  **4 smoke checks** (668 → 672), all four reverse-verified: putting the wait
  back on a fixed 5-second poll → the supervisor reacts 5004 ms late instead
  of immediately, and kills a quarter of a second after the threshold instead
  of on it; removing the "already ended" branch → the supervisor waits out its
  whole timeout instead of reporting an ending that already happened.

  No ABI change: `KERNEL_ABI_VERSION` stays 1.0.0. This is the same
  `subscribe` command `cortex watch` uses; only the host's reaction changed.

- **`cortex logs --follow` streams by push — and ends when the agent ends.**
  The last poller in the CLI. It followed a process's printed output by
  re-reading `output.log` every 250 ms and printing whatever was new, so a line
  showed up a quarter of a second after the agent printed it — and "the agent is
  quiet" was indistinguishable from "the follower has not looked yet".

  The lines come **by push** now, over the same transport stream `cortex attach`
  uses. The kernel still does not know what a process *said* — it never will; it
  relays what the host hands it, in the same shape as a record event, and the
  host is the one that knows how to read a stream. Measured on the same live
  agent, the median lag fell from **217 ms to 1 ms**.

  ```console
  $ cortex logs 7 --follow
  # following pid 7 (live — lines by push from the kernel)
  2026-10-23T23:40:44.314Z | out | patient line 0
  2026-10-23T23:40:44.714Z | out | patient line 1
  ...
  # pid 7 exited with code 5 (the printing is done)
  ```

  **The follow ends by itself**, with the **real** exit code: the kernel says
  when a process ends and how it ended, so the follower never has to guess when
  the printing is done.

  **The file and the stream are stitched.** The history comes from
  `output.log`, the lines after it come from the stream, and the two are joined
  by the line's byte offset in that file — a line the file already showed is
  not shown twice, and a line printed while the history was being read is
  printed once, from the stream. The subscription opens *before* the history is
  read, so nothing is lost in between.

  **And the fallback says what it is.** Without a live kernel — or for a
  process the kernel does not hold — the file path is used, and the command
  names the reason (no live kernel, the kernel is not answering, the kernel no
  longer holds this pid) and says that the lines are being read every 250 ms. A
  follower that quietly changed its behaviour would be one the operator could
  not trust.

  **`cortex watch` can ask for the lines** (`--events output`), but does not by
  default: a syscall frame and a printed line are different kinds of fact, and
  mixing them by default would bury the frames.

  **5 smoke checks** (663 → 668), all five reverse-verified: dropping the
  capture→kernel hand-off → not one line is pushed; weakening the offset dedupe
  → a line the file already showed is shown again; dropping the tap's
  self-repair → a third party that replaces `stdout.write` silences the
  capture; forcing the file path → the follow reads the file and says so; and
  removing the exit event → the follow waits out its timeout instead of ending
  with the process.

  No ABI change: `KERNEL_ABI_VERSION` stays 1.0.0, and this is a client of the
  same `subscribe` command `cortex watch` uses — the kernel gained one event
  kind (`output`), not a new command.

- **A replacement is the same agent — not a stronger one.** `cortex supervise
  <pid> --restart` rebuilds a dead agent from the spec that was persisted when
  it was born, and that spec carried the role, the module and the memory
  policies — but not the **authority**. Since a spawn that says nothing about
  capabilities means *fully privileged* (ABI §4.9), the replacement was born
  holding everything the original had been carefully denied. Measured on a
  live kernel, with an agent restricted to `spawn`:

  ```console
  original:    I am pid 3 and I hold [spawn]
  replacement: I am pid 4 and I hold [spawn,kill,fork,tool:dangerous,ipc:any,admin]
  ```

  Nothing said so. The supervisor printed `# restarted as pid 4 (role=limited)`
  and the agent had quietly become an administrator — "the same agent,
  restarted" had become "a stronger agent".

  **Two records carry the authority now, and they are not the same kind of
  record.** The **spec** is the host's *recipe* — what the process was born
  with: its capability set, the pool it may escalate from, and its budget
  ceiling. It records `null` for "unnarrowed" rather than flattening that into
  the full list, because the two are not the same process: an unnarrowed
  process can `release()` a capability and `acquire()` it back, and one
  holding an explicit set cannot. The **exit record**
  (`processes/<pid>/meta.json`) is the **kernel's own fact** — what the
  process held when it died; `PersistedProcessMeta` is documented as the
  subset of `ProcessInfo` the kernel persists, and `capabilities` was missing
  from it, so a process that ran with no capabilities and one that ran with all
  of them left exactly the same files.

  **The supervisor asks the recipe first and the kernel's fact second.**
  Replay the spec; if the spec is too old to say, ask the exit record; and if
  neither can say, take the documented default — full privilege, because that
  is what a process whose spawner said nothing holds — **and say so**, because
  a replacement that may be stronger than the one it replaces has to be
  visible:

  ```console
  # the spec of pid 14 does not record what it was allowed to do, and it has no exit record that says either
  #   the replacement holds every capability — the documented default for an agent whose spawner said nothing (docs/ABI.md §4.9).
  #   if that is more than the original had: 'cortex supervise 14 --restart --restart-as none'
  # restarted as pid 15 (role=limited, caps=every capability (assumed — nothing could say what the original held)))
  ```

  **`--restart-as same|full|none`** is the operator's own lever: `same` (the
  default) replays what the original held, `full` and `none` say it out loud.

  **`cortex ps` grew a CAPS column**, because "what was this agent allowed to
  do?" used to have no answer in the CLI at all — a process that ran with no
  capabilities and one that ran with all of them looked identical from the
  outside.

  **5 smoke checks** (658 → 663), all five reverse-verified: dropping the
  authority from the spec → the replacement's spec has none; dropping it from
  the exit record → the record has none; dropping both (which is how the
  escalation was found) → the replacement comes back holding everything;
  ignoring `--restart-as none` → the replacement is not held to less; and
  removing the "assumed" marker → the supervisor no longer says that it had to
  assume.

  No ABI change: `KERNEL_ABI_VERSION` stays 1.0.0, `ProcessInfo` already
  carried `capabilities`, and neither the `.crec` nor the `.csnap` format
  changed. The two paths that create a process and still do *not* carry the
  authority — `ctx.spawn()` and a cognitive `fork` — are state-model
  questions, so they are written up (BACKLOG #063) instead of being changed
  here.

- **`cortex attach <pid>` follows one agent live — and knows how it ended.**
  The command is the operator's seat in front of a single agent, and it was
  the last poller in the CLI: it followed the process's `.crec` **file**,
  re-reading the whole thing every 250 ms to find what was new. So a frame
  arrived up to a poll interval after the kernel wrote it, and a long-running
  agent's log was read over and over — a 135 KB log cost 540 KB/s of
  pointless reads.

  The transport carries streams now, so when there is a live kernel that
  still holds the process, the frames come **by push** instead. Measured on
  the same live agent, the median lag fell from **204 ms to 1 ms**.

  ```console
  $ cortex attach 5 --follow
  # attach .cortex/processes/5/log.crec (live — frames by push from the kernel)
  time                  pid    syscall           phase   duration  reversibility
  -------------------------------------------------------------------------------------
  22:04:08.838  5      __signal         exit    -         idempotent
  # pid 5 exited with code 143 (signal:SIGTERM)
  # detached
  ```

  **The follow now ends by itself.** Tailing a log was a *tailing*
  operation: it ended when the operator detached. But the kernel knows when
  a process ends and says how — the same `process-exit` event `cortex watch`
  prints, with the **real** exit code. That is the difference between *"I saw
  it finish"* and *"I stopped looking"*. The other ending is reported too:
  when the kernel goes away mid-follow, the follow did not finish, the
  process's fate is unknown, and the command exits 1 — like `cortex watch`
  and `cortex supervise` do.

  **The history still comes from the file, and the two are stitched.** The
  kernel's stream only carries what happens from now on, so the past is read
  from the `.crec` as before. The two overlap — a frame written while the
  history is being read is in both — and the frame's `byteOffset` is what
  keeps it from being printed twice. The subscription opens *before* the
  history is read, so nothing is lost in between.

  **Without a live kernel it is still the file.** A process the kernel does
  not hold (it exited, or another kernel owns it) can only be read from its
  log, and that path is unchanged. The header says which one is running,
  because "it is following something" and "it is following something *now*"
  are different promises.

  **3 smoke checks** (655 → 658), all three reverse-verified: forcing the
  file path → the follow waits out its timeout instead of ending with the
  process, and the header stops claiming the frames are pushed; dropping the
  `byteOffset` dedupe → the frame is printed twice; and not ending the follow
  on the `process-exit` event → the follow waits out its timeout.

  No ABI change: `KERNEL_ABI_VERSION` stays 1.0.0, and the transport
  protocol is unchanged — this is a client of the same `subscribe` command
  `cortex watch` uses.

- **`cortex dashboard` watches the live kernel, not just its leftovers.** The
  dashboard was the operator's window, and it was showing a window onto a
  graveyard. A process that has not exited has no `meta.json` yet — the kernel
  writes it when the process ends — so the process list was a directory of
  *finished* processes and the agent that was actually working was missing
  from it. The activity feed was worse: it was built by scanning the logs of
  the processes that *had* a `meta.json`, so the 200 KB of syscall frames a
  running agent had already produced were sitting on disk, and invisible.

  With a live kernel in the directory, the dashboard now reads that kernel's
  own process table and takes the event stream **by push** — the frames arrive
  as the kernel writes them, and nothing is re-read.

  ```console
  $ cortex dashboard
  Cortex dashboard listening at http://127.0.0.1:4173
  Watching a live kernel — running processes and a pushed event stream.
  Press Ctrl+C to stop.
  ```

  **The disk was not the problem; the *scan* was.** A running process's log is
  on disk from its very first syscall — a `meta.json` is a *process record*,
  not a *log file*, and the dashboard had been using the record to decide
  which logs to read. The scan now covers every process that has a log,
  running or finished, so the history of a live agent is on the screen from
  the moment the page opens.

  **One conversion, two paths.** A frame pushed over the wire and the same
  frame read off disk go through the same `toDashboardEvent()`, so the pushed
  event and the disk event are the same object — two views of the same fact
  cannot disagree. (The same rule the rest of the project follows: `cortex
  top` and `cortex supervise` share one reading of "stuck" for exactly this
  reason.)

  **One process view for the whole project.** `cortex ps`, `cortex top` and the
  dashboard now render the same rows, from one module
  (`src/cli/process_view.ts`). The view takes the connection it is given
  rather than opening its own, so the dashboard holds one connection for its
  whole life — the process table comes from it and the event stream is pushed
  on it.

  **And the dashboard learned to stop.** An open event stream is a connection
  that never ends by itself, and `server.close()` waits for it. The
  dashboard's own UI holds one open from the moment it loads, so **Ctrl+C
  hung the dashboard instead of stopping it** — the operator's way out was
  the one thing that did not work. The server now drops its connections when
  it closes, and closing twice is not an error.

  **4 smoke checks** (651 → 655), all four reverse-verified: making the
  process view unable to reach the kernel → the running process vanishes from
  the list (only `init` is left); never subscribing to the kernel → the
  stream falls back to the disk, and a running process's frames never arrive
  (its log is invisible to a scan that only reads finished processes);
  scanning the metas alone → the running process's history disappears from
  the event feed; and dropping the connection cleanup → the dashboard cannot
  close while a stream is attached.

  No ABI change: `KERNEL_ABI_VERSION` stays 1.0.0, and the transport
  protocol is unchanged — the dashboard is a client of the same `subscribe`
  command `cortex watch` uses.

- **`cortex top` can now tell a waiting process from a stuck one.** The
  process table says a process is BLOCKED, and that is all it says. A
  listener parked on a channel and an agent that will never be answered read
  *identically* — "waiting on a channel" — so the operator's first view could
  not answer the only question that matters: *is anything stuck?*

  The difference is how long, and the difference is not in the process table.
  It is in the log: every syscall is an `enter` frame and an `exit`/`trap`
  frame **with the same `callId`**, so a call whose `enter` never got a
  partner is the call the process is sitting inside — and the `enter` frame's
  timestamp is when it started.

  ```console
  $ cortex top
  cortex top — 3 processes · 2 blocked · 1 running · 1 stuck · live kernel
  0 tokens · $0.0000 spent · home .cortex

     PID  ROLE            STATE     TOKENS  USD      NOTE
  -------------------------------------------------------
     1    init            running   0       $0.0000  1 syscall
  ├─ 2    holder          blocked   0       $0.0000  waiting on a channel for 327ms
  └─ 3    stuck           blocked   0       $0.0000  waiting on a channel for 14m40s — stuck

  # pid 3 has been inside recv for 880154ms — over your 30000ms threshold.
  #   cortex supervise 3 --kill-after 30000
  ```

  **`--stall-after <ms>`** marks what is over *your* threshold and hands over
  the command to act on it. The threshold and the exemption are the ones
  `cortex supervise --kill-after` uses — the same ones, from the same module
  (`src/cli/open_call.ts`), because two commands that answer the same question
  must read the same source. A supervisor that killed a process the
  operator's view called healthy would be worse than either command existing.

  This is also the only way to see a stall in a **driver call**. The kernel
  does not park a process while its LLM call is in flight, so such a process
  reads as `running` and the process table says nothing is wrong; the log
  says it is four minutes into an `llm_call`. PROCESS.md §3.7 now says which
  blocked reasons the kernel actually sets, and the reserved `llm` / `tool`
  ones are recorded as BACKLOG #060 — a state-model question, not a change.

  **A declared wait is not a stall — and that now covers `wait` as well.** A
  `sleep` was already exempt. A `wait` that carries its own deadline
  (`wait(pid, { timeoutMs })`) ends whether or not the child does, so a
  planner waiting for a coder is doing exactly what it said it would do, and
  a supervisor that called it stuck would be killing the supervisor. Without
  that, the view would have called Demo A's planner stuck and handed the
  operator the command to kill it. A `wait` with *no* deadline is still a
  stall — that is the call that hangs when the child hangs.

  The tree's columns line up now too: the gutter is as wide as the deepest
  branch, so the root's numbers sit in the same columns as its children's.
  And `cortex top` — the view this project calls "one a stranger understands
  in five minutes" (BACKLOG #041) — had **no smoke coverage at all** before
  this.

  **6 smoke checks** (645 → 651), all six reverse-verified: dropping the
  duration → the row stops saying how long; dropping the "stuck" marker →
  the threshold does nothing; making every open call a stall → a process that
  keeps making progress gets called stuck; removing the gutter → the columns
  stop lining up; removing the validation → a nonsense `--stall-after` is
  accepted; and dropping the bounded-`wait` exemption → Demo A's planner is
  called stuck. (That last break needed a second attempt: the first version
  was a no-op line, and the assertion passed anyway — which is what a
  reverse-verification is *for*.)

  No ABI change: this is the CLI's reading of the log, and
  `KERNEL_ABI_VERSION` stays 1.0.0.

- **`cortex supervise <pid>` — the shell supervises a live agent.** A stream is
  only half a story. Everything the shell could do with a live agent was
  something a human had to do — the moment an agent got stuck, the operator
  had to be *there*. That is not supervision, that is babysitting. And the
  project's strongest demo (a planner that notices a hung coder, kills it,
  and puts a fresh one in its place) only worked from *inside* an agent,
  written in agent code.

  `cortex supervise` is the shell-side version, built entirely on the event
  stream.

  ```console
  $ cortex supervise 2 --kill-after 30000 --restart
  # supervising pid 2
  # kill it if it stays inside one syscall for more than 30000ms (sleep is exempt — it is a declared wait)
  # restart it when it ends (at most 5 time(s))
  # pid 2 is already inside recv (since 2026-10-23T20:15:39.975Z)
  # pid 2 has been inside recv for 1588ms — killing it
  # pid 2 was not running — its SIGTERM was queued, so it was killed outright
  # pid 2 exited with code 137 (signal:SIGKILL)
  ```

  **A stall is decided by the log, not by silence.** Silence is not evidence
  of a stall: an agent parked in `recv()` waiting for a message, or one deep
  in a legitimate 60-second LLM call, produces no frames, and neither of them
  is stuck. The kernel's log knows the difference — every syscall is an
  `enter` frame and an `exit`/`trap` frame **with the same `callId`**, so a
  process that entered `tool_call` and has produced no matching exit is not
  "quiet" but *inside* `tool_call`, and has been for exactly as long as the
  gap between the frames. `sleep` is exempt: a declared wait, not a stall.

  **The startup window is real, and the log closes it.** The stream only
  carries what happens *after* a subscriber connects, so a supervisor that
  starts while the agent is already blocked would never see that `recv`'s
  `enter` frame — it was written before the supervisor was listening. The
  supervisor reads the process's log once at startup and works out which call
  is still open, and when it opened. This was found by a real run, not by a
  test: the first version of the command sat watching a process that was
  demonstrably stuck and saw nothing at all.

  **A queued signal is not a delivered signal.** `SIGTERM`'s default action is
  "terminate", but the queuing rule (PROCESS.md §7.2) means a signal aimed at
  a process that is not running waits in its pending queue until it wakes up
  — and a process stuck in a `recv` with no timeout may never wake. The
  kernel reports what it did with the signal (the `__signal` record's
  `outcome` is `queued`), and the supervisor reads that off the stream: there
  is nothing to wait for, so it escalates to `SIGKILL` at once instead of
  burning a grace period on a signal that will never be seen.

  Exit codes follow the established convention: the supervised process's own
  code, **124** when the supervisor had to intervene (the convention
  `timeout(1)` uses), **130** when the operator interrupted it.

  Ten smoke checks, three of them reverse-verified: breaking the
  `enter`/`exit` pairing makes the supervisor kill a process that was working
  fine ("has been inside recv for 511ms — killing it"); dropping the `sleep`
  exemption makes it kill a legitimately sleeping process; zeroing the
  intervention exit code fails the contract.

  (docs/ARCHITECTURE.md §12.1; docs/PROCESS.md §7.2; `src/cli/commands/
  supervise.ts`; 10 smoke checks.)

- **`cortex watch` — the kernel's event stream, live.** Everything the
  transport had done so far was *request/response*: a client asked, the kernel
  answered, the client went away. That is the right shape for a question, and
  the wrong shape for a question like *"tell me the moment this agent exits"*
  — watching by polling is a latency tax and a race.

  The kernel now reports facts as they happen, and the transport carries them.

  ```console
  $ cortex watch --pid 1234
  # watching the kernel event stream (Ctrl-C to stop)
  time                  pid    syscall           phase   duration  reversibility
  -------------------------------------------------------------------------------------
  19:50:09.072  1234    sleep            exit    2523ms    idempotent
  19:50:09.073  1234    memory_write     enter   -         reversible
  19:50:09.074  1234    memory_read      exit    0ms       idempotent
  19:50:09.077  1234    exit             enter   -         irreversible
  # pid 1234 exited with code 3 (probe finished on purpose)
  ```

  Three kinds of event, all of them facts: a process being **born**, a process
  **ending** with its real exit code, and every syscall **frame** as it lands
  in the process's `.crec` log. The `record` lines are printed in the same
  layout as `cortex trace` — and they are the *same frames*, at the same
  `byteOffset`, because the hook lives on the recorder rather than on the
  dispatcher.

  That last point was the interesting decision. The obvious place for the
  hook is the dispatcher, and that would have been **wrong**: seven modules
  write records directly through `recorder.append()` — the dispatcher, the
  scheduler, the signal manager, the process table, `fork`, `init` and
  `checkpoint` — because four of them predate the dispatcher and own a record
  of their own. A dispatcher-level hook would have reported a *subset* of the
  log, and a live watcher would have disagreed with `cortex trace` about what
  happened. The recorder is the one place every frame passes through, so a
  subscriber's view of the log and the log itself cannot disagree. The smoke
  suite asserts exactly that.

  Under the hood: `Kernel.subscribe(listener)` is the whole kernel-side API
  (one method, one callback, one unsubscribe function), and the transport
  carries the events on the same socket — a client sends `subscribe`, gets an
  ordinary acknowledgement, and then receives `{event: …}` frames. A listener
  that throws is ignored: a broken watcher cannot take the kernel down, and
  watching never changes what the kernel does.

  ABI unchanged: no syscall was added, `KERNEL_ABI_VERSION` stays 1.0.0, and
  `Kernel.subscribe` is a host API like `awaitExit`. The transport protocol
  gains a command and a frame type, both additive, so
  `KERNEL_PROTOCOL_VERSION` does not bump.

  Seven smoke checks: a subscriber sees a process being born and ending, the
  pushed frames are the frames on disk at the same offsets, unsubscribing stops
  delivery, a throwing listener cannot break the kernel, the transport pushes
  the events (and refuses an unknown event kind with `EINVAL`), `cortex watch`
  prints what it is given, and it says plainly when there is no live kernel.

  (docs/ARCHITECTURE.md §12.1; docs/PROCESS.md §6.3; docs/ABI.md §2.4;
  docs/HACKING.md §7.2; `src/kernel/boot.ts`, `src/kernel/recorder.ts`,
  `src/cli/kernel_protocol.ts`, `kernel_server.ts`, `kernel_client.ts`,
  `commands/watch.ts`; 7 smoke checks.)

- **`cortex wait <pid>` — a process's ending, addressed to that process.** The
  transport could show a process's state (`ps`), its output (`logs`) and its
  knowledge (`memory`), but nothing could **block**: there was no verb for
  "tell me when this finishes". A shell sequencing work after a live agent had
  to poll `cortex ps` in a loop, or sleep and hope.

  `cortex wait <pid>` blocks until the process ends and reports how.

  ```console
  $ cortex wait 1234
  pid 1234 exited with code 0 (finished the task)
  ```

  The code is the **real** one — the number the agent passed to `exit()`, not a
  default. That distinction is the whole point: a shell that answers "exited 0"
  for a process that died without recording an exit is worse than no answer at
  all, because it is a lie you can script against. `cortex wait` also exits
  with the child's own exit code, so `cortex wait 2 || echo failed` behaves the
  way it does in any shell.

  It is a **read**, like `ps` and `memory`: answered by the kernel directly, not
  through the dispatcher, and not recorded in the `.crec` — an operator waiting
  for a process is not something the process did. It answers from the live
  kernel when there is one and from the process's exit record on disk when
  there is not, so a finished process still says how it ended after the daemon
  is gone; a pid that never existed is `ESRCH`, and a still-running process
  with `--timeout-ms` is a timeout — never a silent "exited 0".

  Behind it is a host-facing kernel primitive, `Kernel.awaitExit(pid,
  { timeoutMs })`. It exists because a **host is not in the process tree**:
  `wait` is a parent-child syscall — the kernel parks the caller and wakes the
  caller's run queue — and the agent a host starts is a child of `init`, so
  `dispatcher.invoke(asProcessId(1), 'wait', …)` never settles, however long
  you wait for it. `awaitExit` resolves with the exit code, still answers for a
  process that has already been reaped, and refuses an unknown pid with
  `ESRCH`. docs/HACKING.md §7 is the guide for the next person writing a host.

  Eight smoke checks: `awaitExit` resolves with the real exit code, it still
  answers after the table entry has been reaped, an unknown pid is `ESRCH`, a
  timeout resolves to `undefined`, the transport's `wait` blocks and carries the
  exit code, `cortex wait` prints and returns the child's exit code, it answers
  for an already-finished process from disk, and it says plainly when there is
  no live kernel and no record — without ever claiming "exited with code 0".

  (docs/ARCHITECTURE.md §12.1; docs/PROCESS.md §6.4; docs/HACKING.md §7;
  `src/kernel/boot.ts`, `src/cli/kernel_protocol.ts`, `kernel_server.ts`,
  `commands/wait.ts`; 8 smoke checks.)

- **`cortex memory <pid>` — a running process's knowledge, addressed to that
  process.** The `.crec` log records what a process **did**, and for a
  `memory_write` the argument it records is a **hash**, not the value
  (docs/ABI.md §4.4 — "full values would bloat the log"). So the causal
  history can say that an agent *wrote something down* and never *what it
  wrote down* — and the knowledge is the whole point of an agent that
  remembers. The live kernel still had it; nothing could reach in.

  `cortex memory <pid>` now answers "what does this process know?": which
  regions it has, what kind each one is, how much is in each, **who else can
  see them**, and the entries themselves.

  ```
  $ cortex memory 2
  # memory of pid 2 (inbox-watcher)
  REGION          KIND      BACKING     ENTRIES   SHARED WITH
  -----------------------------------------------------------
  episodic        cow       inmem       2         -
  semantic        shared    inmem       3         3
  procedural      private   inmem       0         -

  $ cortex memory 2 semantic
  # memory of pid 2 (inbox-watcher) — region 'semantic'
  ticket:T-1180  {"id":"T-1180","category":"bug","reply":"Thanks for the report …"}  2026-10-23T19:05:33.842Z
  ```

  The `SHARED WITH` column is the one that earns its keep: a `shared` region
  is visible to every process that declared it, so knowing that agent 3 is
  reading agent 2's notes is the difference between a shared scratchpad and a
  leak. It falls out of comparing physical keys, and it catches the other
  case too — a `cow` region whose forked child has not written yet.

  It is a **read**, like `ps`: answered by the memory engine directly, not
  through the dispatcher, and not recorded in the `.crec` — the operator
  looking at a process's memory is not something the process did. (An
  agent's own `ctx.memory_read()` is unaffected: still a syscall, still
  recorded.) It does need a live kernel, though — a region's contents live in
  the memory driver, and the default `inmem` backing is the kernel process's
  RAM, so there is no on-disk copy to fall back on. The command says plainly
  that it needs one rather than reporting an empty region and letting the
  operator wonder whether the agent really had forgotten everything.

  Six smoke checks: a daemon-registered agent gets its memory regions bound,
  the transport reads a live process's regions and their entries, an unknown
  pid is refused with `ESRCH`, the transport read does not grow the log,
  `cortex memory` prints the regions and dumps a region, and it says plainly
  when there is no live kernel.

  (docs/ARCHITECTURE.md §4.5, §12.1; `src/cli/kernel_protocol.ts`,
  `kernel_server.ts`, `commands/memory.ts`; 6 smoke checks.)

- **`cortex logs <pid>` — a process's output, addressed to that process.** The
  `.crec` log records what a process **did**: its syscalls, with arguments and
  results. It never recorded what a process **said**, because `console.log` is
  not a syscall, is not in the ABI, and never appeared in the log. So an
  agent's output went to the daemon's stdout — one anonymous stream shared by
  the daemon, `init` and every agent in the tree — and nowhere it could be
  read back from. With two agents running there was no way to tell which one
  printed what, and no way at all to ask an agent what it said after the
  fact.

  Now every process's printed output is captured to
  `processes/<pid>/output.log` — one stamped line per printed line, tagged
  with the stream it came from — and `cortex logs <pid>` reads it back. It is
  a disk read, like `cortex trace`, so it works for a process that has
  already exited and for one whose kernel is gone; `--tail N` shows the last
  N lines, and `--follow` tails the file while a live agent keeps printing.

  ```console
  $ cortex send 2 "hello from the operator"
  sent to pid 2
  $ cortex logs 2
  2026-10-23T18:48:38.338Z | out | [listener] listening (max=∞, tick=1000ms)
  2026-10-23T18:48:48.131Z | out | [listener] message 1 from 1: hello from the operator
  ```

  The mechanism is thin on purpose. The kernel still does not know what a
  process said: it reports which process a body belongs to
  (`KernelOptions.agentScope`) and the CLI decides what "inside a scope"
  means — an `AsyncLocalStorage` holding the PID, which survives every
  `await` inside the body, so a line printed three seconds later by an agent
  that was parked on `recv()` still knows it is PID 7's. The tap is on
  `process.stdout.write` rather than on `console.log`, so the captured text
  is exactly what Node formatted and the original write still happens: the
  output still reaches the daemon's stdout, and now it is *also* addressable.

  Four smoke checks: a process keeps what it printed (stdout and stderr
  tagged separately, and `init` — which printed nothing — has no log at
  all); two processes' output does not mix; `cortex logs` reads the captured
  lines back; and `cortex logs` says plainly when a process printed nothing.

  (docs/ARCHITECTURE.md §7, §12.1; `src/cli/output_capture.ts`,
  `process_store.ts`, `commands/logs.ts`; 4 smoke checks.)

- **`cortex fork <pid>` can now find the process it is asked to fork.** The
  command booted a kernel of its own and looked the PID up in *that* kernel's
  table — which holds exactly one entry, init — so it answered *"no such
  process"* for a process that was very much alive somewhere else. It could
  not succeed in any scenario: a fork snapshots a **running** process, and
  there was never a running process in a kernel of the command's own.

  It now asks the kernel that has one. The fork is the target's *own* syscall
  — the ABI allows `fork` from RUNNING, BLOCKED, STOPPED and SUSPENDED — so
  the frame lands in the parent's own log, and the shared causal past it
  records is exactly where `cortex diff` cuts the two branches apart. The
  child is minted by that kernel and keeps running there.

  So the whole of Demo C is drivable from a shell: fork a running agent, send
  the two branches different instructions, and diff them.

  ```console
  $ cortex fork 2 --tag "try the other way"
  forked pid 2 → child pid 3
    chain: eaa679ca-40cc-4617-ae3d-cd2297b2abac
    shared causal past at offset: 15283
    irreversible actions in past: recv
  $ cortex send 3 "the other way"
  $ cortex diff 2 3
    diverged after 26 shared syscall(s) — fork recorded in pid 2 at byte offset 15283
  ```

  (docs/ARCHITECTURE.md §12.1; src/cli/kernel_protocol.ts, kernel_server.ts,
  commands/fork.ts; 1 smoke check.)

- **`cortex restore --live` — a restored agent that keeps working.** The
  restore had the same shape of problem the spawn had, from the other end: it
  boots a kernel of its own, restores the snapshot into it, runs the restored
  agent to completion (or to the timeout), and exits. So the restored agent's
  life was bounded by the command — which is the right shape for a one-shot
  restore and the wrong one for the promise a checkpoint makes: *pause, and
  come back to work*.

  `cortex restore --live` asks the kernel that is already running. The
  `.csnap` is found on disk by chain id — the checkpoint manager searches
  `processes/<pid>/checkpoints/`, so a snapshot taken by an earlier kernel
  loads too — the restored process is minted by *that* kernel, and it stays
  there: a new PID, its role intact, and reachable by every other transport
  command (`send`, `checkpoint`, `kill`, `attach --interactive`).

  The kernel rebuilds the restored agent's spec from two places, in this
  order: **the process it is still running** (role and agent spec are right
  there in the process table), and **the disk** (`<pid>.meta.json`, written
  when a process exits). The live one comes first because a running process
  has no `meta.json` yet — which is exactly the case `--live` exists for. The
  lookup cannot confuse two processes: a kernel seeds its PID counter past
  everything already on disk, so a PID from an earlier session is never handed
  out again, and a table hit is always the very process that took the
  snapshot.

  Two things are stated in the command's own output rather than left to be
  discovered: the restored agent's output goes to the daemon's stdout, and it
  runs with the daemon's drivers (the API key is the one the daemon was
  started with). `--driver` is therefore ignored with `--live`, and says so.

  Without a live kernel the command says plainly that there is nothing to
  restore into — and it says *that* before it looks at the tag, because "there
  is no kernel" is the more fundamental problem.

  (docs/ARCHITECTURE.md §12.1; `src/cli/kernel_protocol.ts`,
  `kernel_server.ts`, `commands/restore.ts`, `index.ts`; 3 smoke checks.)

- **The shell can now start an agent inside a running kernel, and stop that
  kernel.** `cortex spawn` had two lifetimes and honoured only one of them. It
  booted a private kernel, ran the agent to completion, printed the result and
  exited — the right behaviour for `spawn` as a *runner*, and the wrong
  behaviour for everything the daemon had just made reachable. A
  `cortex send` could deliver into a live agent, but there was no way to put a
  *new* agent into that kernel from the shell; and no way to end a running
  daemon at all. `cortex daemon` offered `run`, `install`, `list` and
  `uninstall`, so the only way to stop a live kernel was to kill its OS
  process from outside — which is not a lifecycle, it is a Ctrl-C with extra
  steps.

  **`cortex spawn --live`** sends the spawn request to the running kernel
  instead of starting a new one. The agent is created by that kernel, through
  the ordinary `spawn` syscall on the dispatcher, so the state gate, the
  capability gate and the recording path apply exactly as they do locally: a
  remote spawn shows up in the live process table with a real PID, a real
  parent and a real `.crec`, and the command that started it can exit while
  the agent keeps running.

  The default `cortex spawn` is unchanged — one kernel per invocation, result
  printed, exit. `--live` is opt-in precisely because silently changing the
  lifetime of the most-used command is the kind of quiet semantic change this
  project does not make.

  Two things a live spawn does *not* carry with it, both stated in the
  command's output so nobody has to guess:

  - **Output belongs to the daemon.** A live agent's stdout is the daemon's
    stdout; the shell that spawned it gets no stream to read. (It is also
    captured per process — `cortex logs <pid>` reads it back; see the entry
    above.)
  - **The LLM driver comes from the daemon's environment.** API keys and
    driver configuration are read where the process runs, not where the
    command was typed. Typing the key into the spawning shell does not give
    the key to the daemon.

  **`cortex daemon stop`** is the other half: it asks a running daemon to shut
  down through the same transport the other shell commands use, so the kernel
  gets to stop cleanly — logs flushed, endpoint file removed — instead of
  being cut off. With no daemon running it says plainly that there is
  nothing to stop and exits non-zero, rather than reporting a success that did
  not happen.

  Three smoke checks: a remote spawn produces an agent that is in the live
  process table and can receive a message; a remote shutdown asks the kernel
  to stop; and `cortex daemon stop` says there is nothing to stop when there
  is not.

  (docs/ARCHITECTURE.md §12.1; `src/cli/kernel_protocol.ts`,
  `kernel_server.ts`, `commands/spawn.ts`, `commands/daemon.ts`; 3 smoke
  checks.)

- **`SIGUSR2` means "checkpoint now" — and now it does.** The signal has said
  *"Checkpoint now. Kernel writes snapshot"* since docs/PROCESS.md §7 was
  written, the transition table has carried a `running -> checkpointing` edge
  attributed to it, and three places in the source named it. Nothing
  implemented it: `SIGUSR2`'s default action was `ignore`, so the signal was
  delivered, recorded, and dropped on the floor.

  It now takes a snapshot of the target, through the ordinary `checkpoint`
  syscall — so the `checkpoint` frames land in the target's log exactly like
  an agent-initiated checkpoint, and the `__signal` frame beside them records
  the *cause*: SIGUSR2 arrived, from whom, and here is the chain id it
  produced. An agent that checkpoints itself has the frames and no signal;
  that is how a replay tells the two apart.

  This is the only way to ask *another* process to snapshot itself, because
  `checkpoint` is a self-syscall — the ABI gives it no target argument, so
  the subject of a snapshot is always its caller. A signal is the one request
  that crosses the boundary, which is exactly why the ABI reserved one.

  (docs/PROCESS.md §7.4; `src/kernel/signals.ts`, `boot.ts`; 1 smoke check.)

- **`cortex checkpoint <pid>` snapshots a running process.** The command used
  to be one that could not succeed: a checkpoint captures a *running*
  process, and the short-lived CLI kernel holds exactly one process (init),
  so the PID it was asked about was never there — `cortex checkpoint 2`
  always answered "no such process".

  With a live kernel it now takes the snapshot, through the dispatcher, so
  the state gate and the capability gate apply exactly as they do locally,
  and it reports the chain id and the file. `--tag` is recorded in the
  checkpoint frame (which is how `cortex restore --tag` finds it) and
  `--detach` suspends the process, so "save and stop" is now something the
  shell can do to a running agent.

  Without a live kernel the command says plainly that there is nothing to
  snapshot, instead of pretending.

- **A live kernel is now reachable from another `cortex` invocation.** Until
  now the CLI was a short-lived process model: every command booted its own
  kernel, did its work, wrote files, and exited. That made two commands
  theatre.

  `cortex send <pid> <message>` looked like it delivered something. It did
  not: the fresh kernel's process table holds exactly one entry (init), so a
  message addressed to a real agent had no inbox to land in, and the kernel
  exited a millisecond later taking the message with it. The syscall was
  *recorded*; nothing was delivered. `cortex kill` had the same problem from
  the other side — with no live process to signal, it rewrote the on-disk
  metadata and called it a day.

  `cortex daemon run` was already the one command whose kernel stays alive,
  so it is now the one command that can be *reached*. While it runs, the
  kernel serves a loopback control port and publishes its endpoint in
  `<CORTEX_HOME>/kernel.json` (host, port, its OS pid, a per-kernel shared
  secret, and the ABI version it speaks).

  - **`cortex send <pid> <message>`** delivers into a running agent's inbox.
  - **`cortex kill <pid> --signal SIGTERM`** delivers a real signal: the
    target's disposition is honoured (a `handler` runs, `ignore` drops it),
    the signal is queued when the target is not running yet, and the
    delivery is reported as `delivered` / `queued` / `dropped`.
  - **`cortex attach <pid> --interactive`** pipes stdin into the live agent
    while the syscall trace keeps scrolling — the interactive half of
    BACKLOG #031, which was deferred to the daemon.
  - **`cortex ps` / `cortex top`** merge the live kernel's process table
    with the on-disk index, so an agent that is running *right now* is
    visible instead of missing (it has no `meta.json` until it exits).

  Every one of those actions is answered by an existing kernel API through
  the ordinary dispatcher path: a remote `cortex kill` is recorded in the
  kernel's `.crec` exactly like a local one (enter frame, exit frame, the
  `__signal` record in the target's log), and a remote `cortex send` goes
  through the same prepare/commit transaction that keeps a message from
  being half-delivered. The transport adds reachability; it adds no side
  door around the kernel's guarantees. Nothing in `src/kernel/` knows the
  transport exists.

  The wire format is newline-delimited JSON over loopback TCP, chosen so it
  stays inspectable — `nc 127.0.0.1 <port>` and a typed request is a
  legitimate way to ask the kernel what it is doing. Every request carries
  a per-kernel token: a loopback port is reachable by every user on the
  machine, and the commands behind it are not read-only.

  Without a live kernel, `cortex send` now says so plainly instead of
  claiming a delivery it did not make, and `cortex kill` says that what it
  did was bookkeeping rather than a signal.

  (docs/ARCHITECTURE.md §12.1; `src/cli/kernel_endpoint.ts`,
  `kernel_protocol.ts`, `kernel_server.ts`, `kernel_client.ts`,
  `process_view.ts`; new example `examples/listener-agent.ts`; 10 smoke
  checks.)

- **`--module` resolves a bundled example inside the package, not the cwd.**
  Every demo in the README, the cookbook and the example files themselves is
  spelled `--module ./examples/<name>.ts` — but `--module` was resolved
  against the **current working directory**, and an installed package drops
  no `examples/` folder there. So the command the documentation opens with
  was the one command a real `npm i -g cortex-agent-os` user could not run.
  (`cortex example` was built to work around exactly this, but only for the
  examples it knows by name, and it never covered `daemon install`.)

  Now a spec that names a bundled example resolves inside the package: the
  compiled `dist/examples/<name>.js` that ships, or the `examples/<name>.ts`
  sources in a clone. A path that exists in the cwd still wins, so a user's
  own module is never shadowed by one of ours, and an unresolvable path
  still fails the way it always did.

  `cortex daemon install` also **refuses a module that does not exist**. A
  daemon spec persists the module's path, and the daemon runs it later —
  possibly after a reboot, possibly by a different account. A path that does
  not exist now will not exist then either, so it is better refused at
  install time than registered as a daemon that can only fail.

  Three checks: a bundled example resolves inside the package when the cwd
  has no `examples/` folder, a path that exists in the cwd wins over the
  package, and an unresolvable path falls back to the cwd-relative
  resolution.

- **`cortex wrap` — run any command as a supervised cortex process.** The two
  integrations (`integrations/langchain`, `integrations/llm-tap`) make an
  existing agent observable; neither makes it supervisable, because
  supervision needs a kernel-owned process and a callback cannot conjure one.
  `wrap` closes that gap the only honest way — it runs the command as a child
  of a kernel process. The project is not modified, not reimplemented, and not
  asked to speak cortex:

  ```bash
  cortex wrap --role research --restart on-failure -- python research.py
  cortex wrap --role api --cwd ./service -- node dist/server.js
  ```

  Afterwards it is an ordinary cortex process: `cortex kill` reaches the child
  (escalating `SIGTERM` → `SIGKILL` after `--kill-grace-ms`), `cortex trace`
  shows its syscall log including the signal handlers it registered,
  `--token-budget` applies, `--restart` re-runs it, and `cortex ps` / `top` /
  the dashboard list it beside kernel-spawned agents.

  **Exit codes are propagated** — `cortex wrap … -- pytest` returns pytest's
  code, and a missing command returns `127` with `command not found` on
  stderr. A supervisor that reported success for a failed run would be worse
  than useless in CI.

  **A timed-out run is stopped, not abandoned.** When `--timeout` expires
  cortex escalates the signal and waits for the child to actually die. A smoke
  check asserts the child stops writing to disk after the CLI exits, because a
  supervisor that leaks its child is not a supervisor. On POSIX the whole
  process group is signalled, so a shell that spawned grandchildren takes them
  along; on Windows `taskkill /T /F` terminates the tree, which cannot be
  caught — a wrapped Windows program is stopped reliably but cannot be asked
  politely, and docs/INTEGRATIONS.md says so.

  An unknown `--restart` value is rejected rather than silently treated as
  `never`: a typo must not disable supervision, which is the one failure mode
  where the command still looks like it worked.

  **`--tap` makes the child's LLM calls countable, and the contract is
  explicit about what it costs.** The wrapper writes `CORTEX_TAP_DIR`,
  `CORTEX_TAP_PID` and optionally `CORTEX_TAP_TOKEN_BUDGET` /
  `CORTEX_TAP_BUDGET_ACTION`; the child reads them with one call near the top of
  its entry point:

  ```ts
  import { installTapFromEnv } from 'cortex-agent-os/integrations/llm-tap';
  await installTapFromEnv();
  ```

  An environment variable cannot make a process import anything — there is no
  way for the parent to reach a child that has never heard of cortex, so
  `cortex wrap --tap` prints that reminder on every run. A flag that silently
  records nothing is worse than no flag. What the env var buys is that the
  child stops hardcoding a directory and a pid: it asks "am I being tapped?"
  and the answer is whatever the host decided. The child's pid does not exist
  until `spawn` allocates it, so the parent writes the literal `@PID@` and the
  wrapper — the only party that knows the answer — substitutes it at launch.

  `--tap-token-budget` and `--tap-abort-on-budget` set the child's ceiling from
  the outside. The tap **records** an overrun by default and lets the request
  finish, because an audit trail beats a surprise crash; the abort flag makes
  the call throw as if the driver returned `EDRIVER`, and the spend is still
  written, so an aborted run stays auditable. `--tap-token-budget` without
  `--tap` is rejected — a ceiling on a tap that was never requested is a limit
  the user believes in and does not have.

  **What checkpoint means here, stated plainly:** a snapshot captures the
  *wrapper's* state, not the child's — the child is a separate OS process and
  no snapshot can reach into it. `restore` on a wrapped run therefore re-runs
  the command from the start rather than resuming it mid-flight. That is why
  the natural checkpoint boundary for a wrapped project is "the run ended",
  the one boundary that is actually true; the outcome is recorded in the
  `episodic` region under `wrap:result` so a later restore knows what it is
  replacing. Real mid-run checkpointing and `fork` still mean
  `cortex spawn --module`.

  `wrap` supervises a *run*; `cortex daemon install` supervises a long-lived
  process that should return after a reboot. Same restart machinery, different
  lifetime.

  Seven new smoke checks: argument validation, the unknown-restart rejection,
  a clean run, exit-code propagation, the 127 path, and two timeout cases
  including the no-leaked-child assertion. Three more cover the `--tap` flag
  contract — the two rejections above, and a check that the run still succeeds
  *and* prints the `installTapFromEnv` reminder, since the reminder is part of
  the feature rather than a nicety.

- **`cortex-agent-os/integrations/llm-tap` — one line to see any LLM client.**
  The LangChain adapter only reaches LangChain, and only if the host wires a
  callback by hand. LlamaIndex, the raw OpenAI SDK, the Vercel AI SDK and a
  hand-rolled `fetch` were all invisible, and one adapter per framework always
  arrives months after the framework does.

  `tapFetch` wraps `globalThis.fetch` instead, so it sees every OpenAI-compatible
  client at once and the host project changes not at all:

  ```ts
  const uninstall = tapFetch({ dir: '.cortex', pid: 42, tokenBudget: 500_000 });
  ```

  Each recognised request records an `llm_call` enter/exit pair in
  `.cortex/processes/<pid>/log.crec`, so `cortex trace`, `cortex ps` and the
  dashboard show a project cortex did not spawn. Token, cached-token and USD
  totals come from the response `usage` block (OpenAI's three spellings plus the
  Ollama and Anthropic shapes) and are priced with the openai driver's table
  rather than a fourth copy of it.

  **The tap is a meter, not a proxy.** It never rewrites a request, injects a
  prompt, or silently retries. The host still receives the untouched response
  body, and a test asserts that, because a tap that broke its host would be
  worse than no tap. What is recorded is the *shape* of a call — message count,
  model, token counts, USD, HTTP status — never prompt or completion text.

  Budget ceilings (`tokenBudget` / `usdBudget`) mark the crossing record with
  `budget: "exceeded"`; `onBudget: 'throw'` additionally aborts the call *after*
  writing the record, so an abort stays auditable. `match` narrows the tap to
  one provider. `llmTapStats()` exposes the running totals for a host that wants
  its own meter.

  `isLLMUrl` is deliberately narrow — OpenAI-compatible endpoints, Ollama's
  `/api/chat`, Anthropic's `/v1/messages`. A wider net would eventually count a
  metrics endpoint, and a wrong token count in `cortex ps` is worse than a
  missing one: it silently corrupts a budget the user set. An unrecognised wire
  format is not counted rather than counted wrongly. A second `tapFetch` call
  returns the first uninstaller instead of stacking a wrapper that would
  double-count every request.

  Documented limits, in docs/INTEGRATIONS.md §"What the tap cannot do": the tap
  is an observer and not a syscall route, so it is not capability-checked; no
  state capture, so `checkpoint`/`fork`/`restore` stay unavailable; and
  `cortex kill` marks a tapped pid without stopping the host's event loop,
  because the host is not a kernel-spawned process. Real supervision still
  means `cortex spawn --module`.

  Ten new smoke checks cover URL recognition, token extraction including the
  cached-prefix path, pass-through of non-LLM requests, the trap path for both
  an HTTP error and a network throw, both budget actions, `match`, the
  double-install guard and uninstall. Verified end to end against a real
  localhost HTTP server: two calls produced exactly two frame pairs, the host
  read its own responses back, a `/health` request on the same origin recorded
  nothing, and neither `CONFIDENTIAL PROMPT` nor the completion text appears
  anywhere in the decoded log.

  **`installTapFromEnv()` — the tap as a cooperation channel.** It reads the
  four `CORTEX_TAP_*` variables `cortex wrap --tap` sets and installs the tap if
  one was requested, returning the uninstaller or `undefined`. The same line is
  therefore safe in a project that is not being watched at all, which is what
  makes the flag adoptable without a debug/production split.

  `CORTEX_TAP_REQUIRED` changes the failure mode, and the difference is the
  point. Without it a malformed budget is ignored, because a typo in someone's
  `.env` should not take down a production run. With it — and `cortex wrap
  --tap` always sets it — a configuration the host cannot honour is an **error**,
  not a shrug, because silently skipping would hand back a run that looks
  supervised and is not. Five more smoke checks cover the no-env no-op, a real
  install from strings alone, the budget and abort action arriving from the
  environment, all three malformed configs throwing under `CORTEX_TAP_REQUIRED`
  (including a literal unsubstituted `@PID@`), and the same inputs degrading
  quietly when it is absent.

- **The LangChain adapter can now write a real `.crec`, so `cortex trace`
  reads an agent cortex did not spawn.** `CortexLangChainCallbackHandler` took
  a `pid` and wrote it into its own `events.jsonl` — a file nothing else in the
  project reads. `cortex trace`, `cortex audit` and the dashboard all read
  `log.crec`, so the one artifact meant to make an existing agent observable
  was invisible to every tool that could show it.

  Passing `pid` now defaults `sink` to `'crec'`: the handler opens a
  `Recorder` on `.cortex/processes/<pid>/` (per ARCHITECTURE §7) and appends
  real `SyscallRecord` frames. `llm.start`/`llm.end` pair as `langchain`,
  `tool.start`/`tool.end` pair as `tool_call` tagged `irreversible`, and an
  unpaired error becomes a `trap` frame — so `cortex trace <pid>` shows a
  LangGraph run sitting next to kernel-spawned agents:

  ```
  time                  pid    syscall           phase   duration  reversibility
  04:29:42.948  9001   langchain        enter   -         idempotent
  04:29:42.960  9001   langchain        exit    12ms      idempotent
  04:29:42.962  9001   tool_call        enter   -         irreversible
  04:29:42.964  9001   tool_call        exit    2ms       irreversible
  ```

  Both sinks are written when `crec` is active: the jsonl file survives a
  `.cortex` reset and holds the untruncated error name, so dropping it would
  be a silent regression for anyone already parsing it. Without a `pid` the
  handler stays on `jsonl` and `crecProcessDir()` throws rather than writing a
  stray log. Added `close()` (flush + release the descriptor) alongside the
  existing `flush()`.

  Recording rules are unchanged in spirit: prompts, model output, tool inputs
  and retrieved documents still never reach disk, now enforced by tests that
  assert the strings are absent from the decoded `.crec`.

  Five new smoke checks cover the frame pairing, the reversibility tag, the
  trap path, jsonl coexistence, and the no-pid guard. All decode back through
  the production `readRecords`, and the `cortex trace` output above is real
  CLI output, not a fixture.

### Changed

- **The syscall dispatcher is now the only place a syscall is recorded.** The
  recording-ownership work that ABI.md §11 described in stages is finished:
  all seven syscalls that used to write their own `.crec` frames
  (`memory_read`, `memory_write`, `send`, `recv`, `fork`, `checkpoint`,
  `restore`) now record through the dispatcher, and `SELF_RECORDED_SYSCALLS`
  is empty. ARCHITECTURE.md §4.10 has said all along that the dispatcher is
  "the only place syscalls are validated and recorded"; that is now true of
  the code as well as the document.

  Two of them could not simply move their frame, and both needed a seam:

  - **`send`** may not do the thing and then record it — a failed record must
    not leave a phantom, half-committed message. `IpcManager.prepareSend()`
    now hands back a prepared send with a `commit()` and a `rollback()`; the
    dispatcher writes the frames and then commits, or rolls the send back if
    the frame could not be written.
  - **`fork`** has to know where its own `enter` frame landed, because the
    shared causal past is everything *before* the fork call and `cortex diff`
    cuts the parent's log there. The dispatcher captures that offset and
    passes it down.

  `fork` and `restore` each also write a frame into a log that is not the
  caller's: the child's birth record and the restored process's birth
  record. Those stay with their modules — they describe a process, they are
  not calls by one, and no other process could write them.

  What changed in the log: `send`, `recv`, `fork`, `restore` and `checkpoint`
  gained the `enter` frame they never had, and `send`'s delivery facts moved
  from the frame's `args` to the `exit` frame's `result`, where every other
  syscall keeps its result. A failed `restore` is now recorded at all — it
  never was, because the module wrote no trap frame for it and the
  dispatcher was not recording that syscall.

  No syscall was added, removed, renamed, or had its meaning changed. The
  on-disk `.crec` format is unchanged: same frame, same fields, same
  encoding.

  The two `send` rollback checks now drive the dispatcher with a recorder
  that fails only on the `exit` frame. That is the window that matters: the
  `enter` frame has to land, or the send would never be prepared and the
  rollback would prove nothing.

### Fixed

- **The output capture could be switched off without a word.** The tap that
  copies an agent's printed lines into `output.log` was installed by
  replacing `process.stdout.write`. That worked — until anything else
  replaced it too. A logger, a reporter, a test harness: any of them could
  take the stream over, and the capture would die **silently**. The agent
  would keep printing to the terminal, the log would quietly stop growing, and
  every `cortex logs` would answer with a file that was missing exactly the
  lines that mattered. Nothing in the system would have said so.

  The tap is now installed as an **accessor**, so a replacement is re-wrapped
  on the spot instead of switching the capture off. This was not
  hypothetical: the project's own smoke suite replaced `stdout.write` to
  capture a command's output, and the follow stopped receiving the lines it
  was supposed to relay — which is how the bug was found.

- **The liveness probe could hang forever.** `probeKernel` bounded the
  *connect* to the kernel but not the answer: a kernel that accepted the
  connection and then never replied left the command waiting with no output
  and no way out. A liveness check that can hang is not a liveness check, so
  the ping is bounded now, and a kernel that does not answer is reported as
  unreachable.

- **The follow's fallback was invisible.** When `cortex logs --follow` could
  not push — no live kernel, a kernel that was not answering, a kernel that no
  longer held the process — it fell back to reading the file every 250 ms and
  said nothing. The lines still arrived, so it looked like it was working; it
  was just a quarter of a second late, and the operator had no way to tell.
  The header now names the reason and says which path is running.

- **The CLI lied when the kernel went away.** Three commands watch a live
  kernel, and all three had a different way of failing when that kernel died
  — and every one of those ways was a lie.

  `cortex watch` **exited silently, with a success code**. Nothing was
  holding its event loop open any more, so the process simply ended — exit 0,
  no message. To the operator that reads exactly like "the watch finished".
  `cortex wait` printed the raw socket error (`cortex: read ECONNRESET`) —
  technically true, and actionable by nobody. And `cortex supervise`, the
  worst of the three, **hung forever**: its polling timer kept the event
  loop alive, so it sat there supervising a kernel that was no longer there,
  watching a process whose fate nobody would ever learn.

  The transport now says when the connection ends. `KernelClient` exposes it
  (`closed`, `onClose(handler)`), and each command turns it into an ending
  that means something and an exit code that tells the truth:

  ```console
  $ cortex watch          # the daemon dies underneath it
  cortex watch: the connection to the kernel was lost — it looks like the kernel died (connect ECONNREFUSED 127.0.0.1:60869)
    the watch did not finish — it lost the kernel it was watching.
  $ echo $?
  1
  ```

  `cortex wait` reports that no exit was seen ("pid 8 did not report an exit
  — nobody is waiting on it now"), and `cortex supervise` reports that the
  supervised process's fate is unknown ("the fate of pid 10 is unknown — the
  supervisor stopped when the kernel did"). Both exit 1. **None of them
  invents an outcome it did not observe**, and none of them reports success.

  `cortex attach --interactive` is the odd one out, because it has two
  halves: its trace half follows the `.crec` file and does not need a kernel,
  so it keeps going — but it says that delivery is over ("the kernel went
  away — messages can no longer be delivered", said once, not once per
  keystroke) and exits 1, because half of the command failed.

  The client knows *that* the connection ended; the directory says *why*. A
  descriptor that is gone means the kernel shut down cleanly; a descriptor
  that is still there with nothing listening means it died; a descriptor that
  answers means another kernel has taken the directory over. Those are three
  different endings, and the operator is told which one happened.

  **A bug the fix was built on.** `KernelClient.closed` only ever became true
  when the *client* closed the connection — the socket's own `close` handler
  did not set it. So the first version of this fix consulted a flag that was
  never set, and `cortex wait` printed the raw socket error exactly as
  before. The smoke suite caught it: with the flag reverted, two of the four
  new checks fail.

  **4 smoke checks** (641 → 645), all four reverse-verified: reverting the
  watch's ending → it exits 0 again ("the watch reports the failure, got 0");
  reverting the wait's ending → the raw "connection closed" surfaces; and
  reverting the supervisor's ending → **it hangs**, and the check's deadline
  catches it ("the supervisor did not stop when the kernel went away").

  **Real run** (daemon + live kernel, killed with `Stop-Process -Force`):
  `cortex watch` → exit 1, "the watch did not finish — it lost the kernel it
  was watching"; `cortex wait 8` → exit 1, "pid 8 did not report an exit —
  nobody is waiting on it now"; `cortex supervise 10 --kill-after 30000` →
  exit 1, "the fate of pid 10 is unknown — the supervisor stopped when the
  kernel did".

  No ABI change: this is the CLI's side of the transport, and
  `KERNEL_ABI_VERSION` stays 1.0.0.

- **A daemon-registered agent had no memory regions, and died on its first
  memory access.** The regions were *declared* on the process-table entry and
  never *bound* in the memory engine: `syncFromTable` was called on two of the
  three birth paths — the `spawn` syscall (in the dispatcher) and `restore` (in
  the checkpoint manager) — and not on the third, a daemon registration in
  init. So a daemon's agent trapped `ENOENT` ("no such memory region") the
  first time it tried to remember anything, while the same agent under
  `cortex spawn` worked.

  The asymmetry is what hid it. The Demo B agent reads its `done` set from
  memory, and it is run with `cortex spawn`; the daemon path had only ever
  been exercised with agents that touch no memory at all. PROCESS.md §6.1 has
  always promised "sets up memory regions per policy" for every process — the
  daemon path was the one that did not keep the promise.

  Init now takes the memory engine (`InitProcessOptions.memory`) and syncs the
  regions it allocates, which also covers daemon **restarts** (they go through
  the same allocation path). Reproduced on a real daemon first: the
  `checkpoint-agent` — Demo B's own agent — died with `no such memory region
  'episodic'` the moment it started.

- **The published assertion count was stale.** The READMEs' quickstart, the
  landing page's status panel and the HN launch draft all said "580 smoke
  checks"; the suite is 641. The numbers were last refreshed when the landing
  page was first built and were never moved again, so a reader who ran the
  suite saw sixty-one more assertions than the documents promised. All four
  places now say 641, and the landing page's primitive grid grew a `logs`, a
  `memory`, a `watch` and a `supervise` tile — the grid listed twelve verbs
  and there are now sixteen.

- **Every `cortex ps` against a live kernel wrote a frame into the
  supervisor's log.** The transport's `ps` went through the dispatcher — init
  calling the `ps` syscall on the operator's behalf — so a monitoring loop
  polling every second grew init's `.crec` without doing any work, and the
  supervisor's causal history filled up with frames about looking.

  The transport now reads the process table directly. The distinction is
  deliberate: `ping` and `shutdown` are transport-level housekeeping, and
  `ps` is the operator *looking* — none of the three is an action by an
  agent, so none of them belongs in the kernel's record of what its agents
  did. Everything that *acts* (`send`, `kill`, `checkpoint`, `restore`,
  `spawn`) still goes through the dispatcher and is still recorded exactly
  like the local equivalent.

  An agent's own `ctx.ps()` is untouched: it is still a syscall, still
  recorded, still shaped by ABI.md §4.1. Only the transport's view of the
  table changed, and the wire format did not.

  The check fails without the change — it was confirmed to fail, not merely
  to pass.

  (src/cli/kernel_server.ts; 1 smoke check.)

- **A snapshot of a running agent could not be restored once its kernel was
  gone.** The `.csnap` body deliberately omits the agent spec (docs/STATE.md
  §4) — a restore has to be told what to rebuild. The only thing on disk that
  carried it was the `meta.json`, and the CLI writes that when a process
  *exits*. So a snapshot of an agent that was still running had no spec
  anywhere once its kernel was gone, and a later `cortex restore` answered
  *"no on-disk meta for pid N — cannot rebuild the agent spec"*. That is the
  flagship case: a daemon's agent checkpoints itself, the machine reboots, and
  the agent cannot come back.

  The kernel now reports every birth — `KernelOptions.onProcessStart`, the
  counterpart of `onProcessExit` — and the CLI writes the spec down at
  creation, in `processes/<pid>/spec.json`: role, agent spec, and the memory
  region policies the process was declared with. Every process is born
  through `table.allocate()` — the dispatcher's `spawn`, init's daemon
  registration, and `restore` all land there — so one hook covers all of
  them.

  The restore context now has three sources, best first: the process this
  kernel is still running, the spec written at creation, and the meta written
  at exit. The spec comes before the meta because it carries the memory
  policies the process was actually declared with, which the exit meta
  usually does not.

  Verified end to end: a daemon's agent is checkpointed, the daemon is killed
  uncleanly (no clean shutdown, so no `meta.json` is ever written), and
  `cortex restore --tag` restores it in a fresh session. The check fails
  without the change — it was confirmed to fail, not merely to pass.

  (src/kernel/boot.ts, process_table.ts; src/cli/process_store.ts,
  index.ts; 1 smoke check.)

- **`cortex restore --tag` could not find a checkpoint that was sitting on
  disk.** The tag is an *argument* and the chain id is a *result*, and since
  the `checkpoint` syscall moved onto the dispatcher's recording path the two
  facts landed in different frames of the same call: the `enter` frame carries
  `{tag, detach}`, the `exit` frame carries `{chainId, byteSize,
  syscallLogOffset}`. The tag reader still looked for a single frame carrying
  both — which the old checkpoint module happened to write, because it wrote
  one frame for the whole call. When the frames split, the reader quietly
  stopped finding anything: `cortex restore --tag X` answered *"no checkpoint
  found with tag X"* for a checkpoint that was right there.

  That is the documented way to resume after a reboot — the README's "pause and
  resume across reboots" example, and Demo B's own resume line — so it was
  worth more than a small fix.

  The reader now pairs the two frames by call id, and still reads the old
  single-frame shape so logs written before the move keep working.

  The check that should have caught it did not: it wrote a *hand-made* record
  carrying the tag and the chain id in one frame — a frame the kernel never
  produces. The new check takes a real checkpoint through the kernel and
  resolves its tag back out of the log.

  (src/cli/process_store.ts; 1 smoke check, which fails without the fix.)

- **A checkpoint no longer kills the agent it was saving.** Taking a snapshot
  of a *blocked* process moves it out of BLOCKED — the snapshot is taken
  while it is CHECKPOINTING, and it comes back READY — but its pending `recv`
  waiter is still there, and the wake that settles that waiter was waiting
  for a dispatch that never came. The agent hung forever: no further syscall
  frames, no messages, no error. Worse, a wake that arrived *during* the
  snapshot resumed the body while the process was still READY, and the body's
  next syscall tripped the state gate with `ESTATE` — which killed it.

  Both are the same bug. The wake gate releases a deferred wake on the next
  *dispatch*, and the scheduler only dispatches READY processes, so a process
  that had been moved out of BLOCKED had no dispatch left to wait for. The
  IPC half of the wake protocol now makes the receiver READY again in that
  case — the same move the normal path makes out of BLOCKED — and the
  dispatcher's state gate waits for an in-flight snapshot to land instead of
  trapping, so a body that resumes mid-snapshot waits rather than dies.

  (src/kernel/ipc.ts, `syscall_dispatcher.ts`, `checkpoint.ts`; 1 smoke check,
  which fails without the fix.)

- **A process killed by a signal never got its exit metadata.** The
  `onProcessExit` hook — the thing that writes a `meta.json` so `cortex ps`
  and `cortex top` can show a process after it ends — fired only from the
  `exit` syscall. A process that died from a signal never went through that
  path: `signals.ts` walked it to ZOMBIE and handed it to `init` for
  reaping, and the entry was gone before anything could describe it. The
  consequence was that a signalled process did not show up as a *zombie*
  with its exit code — it simply vanished from the process list.

  That was invisible while `cortex kill` could not actually signal
  anything, because it rewrote the metadata itself. The moment the CLI
  could deliver a real signal (the loopback transport, above), it became
  the difference between "the agent is dead, here is exit 137 (signal:
  SIGKILL)" and "the agent is gone". The signal path now persists the exit
  metadata before `init` reaps the entry, and the dispatcher exposes that
  step as `persistExitMeta()` so both doors into ZOMBIE share it.

- **Two kernels in one state directory could hand out the same PID.** A
  state directory can host more than one kernel — `cortex daemon run` keeps
  one alive there while other `cortex` invocations work in the same
  directory — and each kernel counted PIDs up from its own seed. The two
  counters were not coordinated, so they walked into each other, and the
  loser opened the winner's `log.crec` in append mode: two unrelated
  processes sharing one syscall log, silently, with no error anywhere.

  The fix is a *claim*. A PID's directory is created with an exclusive
  `mkdir`, which is atomic, so exactly one kernel can win a given PID; the
  other skips to the next one. The PID space belongs to the directory, and
  now the directory enforces it. (`docs/ARCHITECTURE.md` §7.)

- **A failed `recv` or `checkpoint` was written to the log twice.** The
  recording-ownership work in ABI.md §11 moved `recv` and `checkpoint` onto
  the dispatcher's single path — but it moved only their *success* records.
  Their *trap* records stayed behind in `ipc.ts` and `checkpoint.ts`, and the
  dispatcher writes a trap frame of its own whenever a syscall fails. So one
  failed `recv` produced two `trap` frames:

  ```
  recv  enter   -          irreversible
  recv  trap    -          idempotent      ← ipc.ts's own frame
  recv  trap    2ms        irreversible    ← the dispatcher's frame
  ```

  Three things were wrong with that, and only the first is visible in the
  frame count. The module's frame carried a `callId` the dispatcher never
  issued, so it paired with no `enter` frame and a replay engine had no way to
  line the failure up with the call that caused it. It carried a
  `reversibility` tag the module had hardcoded — `idempotent`, while `recv` is
  `irreversible` — so the log misreported how dangerous the failed operation
  was. And it carried no `durationMs`.

  The modules no longer write trap frames. `ipc.ts` and `checkpoint.ts` now
  throw and let the dispatcher record, which is what ABI.md §11 already
  promised ("their `trap` frames come from the dispatcher's uniform path") and
  what ARCHITECTURE.md §4.10 has always said ("This module is the only place
  syscalls are validated and recorded"). The `send` trap path still writes its
  own frame — `send` is still self-recorded, for the reason in ABI.md §11.

  Two smoke checks: a failed `recv` writes exactly one `enter`+`trap` pair
  under one `callId`, and a `checkpoint` that fails inside the module (a
  cognitive source that throws) writes one trap frame instead of two.

- **`cortex wrap --restart` now restarts anything.** The flag was parsed,
  validated, stored on the process entry — and read by nobody. `kernel.spawn`
  accepts a `restart` option and keeps it on `ProcessEntry`, but the entire
  restart mechanism (exponential backoff, sliding-window storm detection, the
  `maxRestarts` cap, the `restart` records) lives in `InitProcess` and is
  reached only through `registerDaemon`. So `--restart on-failure` ran the
  command exactly once and reported success or failure as if the policy did not
  exist. A test that only checked "the flag is accepted" could never have
  caught it.

  `wrap` now registers as a daemon when a policy is set, which gets the real
  machinery instead of a second copy of it. Two behaviours come with that, both
  correct: init reaps its own daemons, and **each restart mints a fresh pid**, so
  every attempt gets its own directory and its own `.crec`. Attempt 2's spend
  cannot be confused with attempt 1's, and `cortex trace <pid>` shows one
  attempt's calls.

  That last point changed the reporting. The poll loop follows
  `InitProcess.currentPidOf()` rather than the pid it was handed — polling the
  original would see it reaped, conclude "finished", and report attempt 1's exit
  code while attempts 2..N were still to come. It also waits while
  `restartCount < maxRestarts` rather than waiting for a new pid to appear,
  because init restarts on a *deferred* backoff timer (1s by default) and the
  replacement does not exist yet at the moment the old one dies. The persisted
  `meta.json` carries the last attempt's pid, so `cortex ps` describes how the
  run actually ended, and the summary says which attempt the numbers belong to.

  `--max-restarts N` turns out to be a cap on *runs*, not restarts: init gives
  up once `restartCount >= N`, and `restartCount` advances when the restart is
  decided, so N=2 runs the command twice. The field name says otherwise.
  Renaming it or changing the arithmetic would break the frozen 1.0 ABI, so the
  behaviour stands and is now written down in `docs/PROCESS.md` (on the field
  itself) and `docs/INTEGRATIONS.md` (on the flag), and pinned by a smoke check
  on both the daemon and the wrap side.

  `InitProcess` gained `currentPidOf()` and `restartCountOf()`: `registerDaemon`
  returns the *original* pid as the daemon's stable identity, so that value goes
  stale on the first restart and a supervisor holding it polls a process that no
  longer exists.

  Verified end to end: a command that fails once then succeeds runs twice, ends
  with the success code, and leaves two separate logs. A command that always
  fails under `--max-restarts 2` runs twice and gives up with the command's own
  exit code.

- **Recorders are closed at shutdown, not just at reap.** `ProcessTable.reap()`
  closes the recorder of the process it removes, which covers every process that
  finishes. It did not cover the ones that never do: init is still RUNNING at
  shutdown by definition, and a run stopped by `--timeout` may still be alive
  when the CLI tears down. Those kept their file descriptors open until the host
  process exited, which Node reports as
  `Closing file descriptor 3 on garbage collection` on every `cortex wrap` — and
  on a long-lived host is an actual descriptor leak rather than cosmetic noise.
  `closeAllRecorders()` flushes and closes whatever is left, and
  `Kernel.shutdown()` calls it.

- **A tapped run no longer reports zero spend.** The tap wrote `llm_call`
  frames into the `.crec`, and nothing ever read them back. A child's LLM calls
  do not pass through the syscall dispatcher, so the kernel's `budgetsSpent`
  stayed at zero for a run that spent real money — the summary line printed
  `tokens: 0 (in 0, out 0)`, and `meta.json` persisted those zeros, so
  `cortex ps`, the dashboard and `cortex audit` all showed a spending run as
  free. A number that looks measured but is not is worse than no number.

  `readTapSpend(dir, pid)` is the other half of the tap: it sums the `llm_call`
  frames back out of the same log every other tool reads, so the summary and
  `cortex trace` cannot disagree. `enter` frames are excluded (they carry no
  usage — a naive sum counts every call twice), a `trap` is counted under
  `failedCalls` and still billed, since a 500 was charged for, and a missing or
  torn log yields the partial sum rather than throwing, because a summary line
  that fails to print is worse than one that honestly says zero.

  `cortex wrap` now folds the result into `budgetsSpent`, and the wrapper
  records it in `wrap:result` so a later `restore` knows what the run it is
  replacing cost. Verified end to end against a real localhost server: two calls
  reported `tokens: 240 (in 200, out 40)` / `tap: 2 llm calls ($0.000053)` and
  `meta.json` carried the same numbers, and a run that hung and was killed
  still reported the 240/40 it had spent before it died.

- **A timed-out `cortex wrap` no longer exits 0.** The timeout path left
  `exitCode` null and `return exitCode ?? 0` turned "we killed it because it
  overran" into success. In CI that is the worst available failure:
  `cortex wrap --timeout 60 -- pytest` went green on a hung suite. It now
  returns `137` — the shell's `128 + SIGKILL` convention, chosen because it is
  non-zero *and* distinct from any code the child could return, so a log tells
  "we killed it" from "it failed". A smoke check that had been asserting the old
  `code === 0` was itself wrong about this and now asserts 137.

  The timeout summary also states the code it is about to return, rather than
  leaving the reader to infer it.

### Documentation

- **The kernel-size claim was off by more than half.** MANIFESTO §II.3
  promised "the Cortex kernel fits in 3,000 lines of TypeScript". The kernel
  is ~6,800 lines of code — 13,200 counting the comments — across sixteen
  modules, and the dispatcher alone is 1,400. The number was a Phase-1
  estimate that never got revisited, and the architecture document still
  carried it as a promise.

  The claim that was *behind* the number still holds, and holds better than
  it did: the kernel is under half the codebase, with the CLI, the drivers,
  the dashboard and the integrations together now slightly larger than it.
  Both MANIFESTOs (EN + zh-CN) now state the measured numbers, and
  ARCHITECTURE's Phase-1 estimate carries a note saying what it was and
  what happened to it.

- **The Demo C transcript in the README was from an older kernel.** The
  captured run said `diverged after 4 shared syscall(s)`; the current kernel
  says 7, because the syscalls that record through the dispatcher gained the
  `enter` frame they never had, and each one counts in the shared history.
  The capture log (`examples/demo-c.capture.log`) has been re-recorded from a
  real run, `docs/demo-c.html` regenerated from it, and both READMEs and
  BACKLOG.md updated to match. The old capture also carried a note that one
  branch had no `meta.json`; that stopped being true when every process
  started persisting its own metadata, and the note is gone with it.

- **The landing page's status panel was a version behind.** It said eleven
  kernel modules and 525 smoke checks. Twelve and 580 now — the module count
  matching ARCHITECTURE §3's own number, which the panel should have agreed
  with months ago. The launch drafts in `docs/launch/` carried the same
  stale module count, and the counts in the *release notes* were left alone
  on purpose: those describe what was true at the time of that release.

- **The docs now match the code.** A line-by-line audit of every doc claim
  against the implementation turned up no missing features — every syscall,
  environment variable, CLI command, driver and bundled example promised in
  the docs exists. What it did turn up was stale bookkeeping in eight files:

  - **`cortex dashboard` is documented in both READMEs** (EN + zh-CN). It is
    the headline feature of 1.1/1.2 and appeared only in
    `docs/INTEGRATIONS.md`; the GitHub landing page did not mention it at all.
    The new section covers the read-only default, the `--ops` gate, why
    `restore`/`kill` work without a resident kernel and `spawn` does not, the
    30s spawn cap, and the `cortex-agent-os/dashboard` export.
  - **The release badge said `v1.0.1` while the package was `1.2.0`.** Now
    `v1.2.0`, in both READMEs.
  - **Three dead image links removed.** README (EN + zh-CN) embedded
    `docs/demo-{a,b,c}.gif`, which were never produced — the capture logs and
    the `make-demo-*-gif.py` renderers exist, but Pillow is not a dependency, so
    the binaries are not in the repo. The images now point at
    `docs/demo-{a,b,c}.html`, which do exist, ship with the package, and
    replay the captured syscall log frame by frame with zero dependencies.
  - **`wake_gate.ts` is now a documented kernel module.** It shipped in 1.2.0
    and is load-bearing (§4.8's "a woken body resumes on a dispatch, not on the
    wake" is unenforceable without it), but it was missing from the §3 module
    diagram, the §11 file layout, and every module count. The count is now
    twelve everywhere: ARCHITECTURE §3/§11, HACKING's reading list, both
    READMEs, and both MANIFESTOs.
  - **`PROCESS.md` no longer says "eight states, twelve legal transitions."**
    There are nine states and eighteen `LEGAL_TRANSITIONS` entries; the doc now
    says so and explains the three-way gap between that number, the sixteen rows
    in its own §5 table, and the two "(gone)" rows that are entry removals
    rather than transitions.

  Also propagated the corrected counts to `docs/README.md`, `MANIFESTO.md` and
  `MANIFESTO.zh-CN.md`. No code, ABI, or on-disk format change.

### Changed

- **`memory_read` / `memory_write` / `recv` / `checkpoint` now record through
  the dispatcher's single recording path** (instead of `MemoryManager`,
  `IpcManager` and `CheckpointManager` writing their own frames). All four
  gain the `enter` frame they never had, which makes `cortex trace` and any
  replay read them like every other syscall, and their `trap` frames now come
  from the dispatcher's uniform path too. The redaction rules move with the
  records, unchanged: a read records `{count, valuesHash}` rather than the
  values themselves, and a write hashes any value above the manager's
  `largeValueBytes` threshold or with `recordHashOnly` set.
  `MemoryManager` no longer holds a recorder or a call-ID counter, and
  `IpcManager` / `CheckpointManager` no longer record `recv` / `checkpoint`.

  Two of them needed the dispatcher to distinguish *what is recorded* from
  *what is returned*: `recv` records the delivered message
  (`{from, to, body, sentAt}` — the wait time is the frame's own
  `durationMs`), and `checkpoint` records `{chainId, byteSize,
  syscallLogOffset}` while the agent still receives exactly `{ chain_id }`.
  `CheckpointManager.take()` therefore returns the snapshot's `byteSize` and
  `syscallLogOffset`; the log offset is what makes a checkpoint replayable
  against `.crec`. A checkpoint record's `stateBefore` / `stateAfter` are now
  the states either side of the syscall, like every other syscall, rather than
  the module's internal `checkpointing` → final transition.

  This closes four of the seven self-recorded syscalls tracked in ABI.md. The
  remaining three keep their own frames for concrete reasons now written into
  that section: `fork` writes into two logs, `send` must order its record
  inside its own atomicity window, and `restore` records into the *restored*
  process's log. No syscall, `.crec`, or `.csnap` format change:
  `KERNEL_ABI_VERSION` stays `1.0.0`.

## [1.2.0] — 2026-10-02

Dashboard grows from read-only monitor to ops console; budget exhaustion now
truly halts the agent instead of merely signalling it. No syscall, `.crec`,
or `.csnap` format change — `KERNEL_ABI_VERSION` stays `1.0.0`.

### Added

- **Dashboard supervision tree + budget rollup** (`166b728`): a tree view
  built from `ppid` links (search keeps ancestor chains, `?view=tree` deep
  link), and a per-role budget panel aggregating tokens / USD / wall time /
  syscalls.
- **Dashboard live updates over SSE** (`GET /api/stream`): file-watch driven
  pushes with a 15s heartbeat; the UI falls back to polling automatically.
- **Dashboard checkpoints panel**: lists `.csnap` snapshots (parsed from file
  names) and offers one-click restore.
- **Dashboard events filtering and pagination**: `GET /api/events` accepts
  `from`/`to`/`offset`/`limit` and reports `x-total-count`.
- **Dashboard write operations, gated and fine-grained**: every op is off by
  default; enable with `--allow-ops` (all) or `--ops spawn,kill,restore`
  (exact list). Ops run the matching CLI command in-process against the
  dashboard's state directory, so CLI validation still applies:
  - `POST /api/ops/spawn` — start an agent (waits until it finishes,
    self-checkpoints, or times out; default 30s bound).
  - `POST /api/ops/kill` — mark a process zombie in its on-disk meta,
    exactly like `cortex kill` (v0 disk semantics).
  - `POST /api/ops/restore` — restore a checkpointed process, exactly like
    `cortex restore`.
  `GET /api/ops` reports `{ allowOps, ops }`; the UI only renders buttons
  for enabled ops.
- **Dashboard usage and error visibility**: the events table and syscall
  trace now carry `model` / `tokensIn` / `tokensOut` / `usd` from completed
  LLM calls, plus a sanitized `errorMessage` for trapped syscalls — Bearer
  tokens, `sk-…` keys, and `key=…` pairs are stripped and the message is
  capped at 240 characters. Prompts and model outputs are never returned.
- **MCP reversibility via environment**: `CORTEX_MCP_DEFAULT_REVERSIBILITY`
  sets the conservative default tag (`irreversible`, `reversible`, or
  `idempotent`); `CORTEX_MCP_REVERSIBILITY` takes a JSON map of tool names
  to tags (prototype-injection safe). Declared tools stay visible to
  `cortex audit`.
- **A real test suite**: `npm test` now runs `node --test` over `tests/`
  (wake gate, budget resume/kill, MCP reversibility) alongside the smoke
  runner.

### Changed

- **Budget exhaustion gates the syscall return.** Previously a budget breach
  fired `SIGXCPU` (which stops the process) but let the in-flight syscall
  return normally, so the agent body kept running with an exhausted budget.
  Now the dispatcher holds the return: if the process was killed meanwhile
  the continuation receives a clean `ProcessExitSignal(152)`
  (128 + SIGXCPU), and if it was stopped it parks on the wake gate until a
  later dispatch (top up the budget, then `SIGCONT`). The budget hook is
  arbitrary user code, so the dispatcher re-reads the process table after
  the hook and keeps the `SIGXCPU` send best-effort.
- Dashboard timestamps render in the viewer's local timezone (previously
  raw UTC ISO strings).

## [1.1.0] — 2026-09-28

First minor release on the frozen ABI: additive only. Adds a local read-only
monitoring dashboard, a dependency-free LangChain integration, and a budget
reporting fix in `cortex spawn`. No syscall, `.crec`, or `.csnap` format
change — `KERNEL_ABI_VERSION` stays `1.0.0`.

### Added

- **`cortex dashboard` — a local read-only monitoring console.** Serves a
  single-page UI (default `http://127.0.0.1:4173`) plus three JSON endpoints:
  `GET /api/processes` (persisted process metadata, or a live kernel snapshot
  when embedded), `GET /api/events` (model / tool / kernel syscalls merged
  with LangChain callback events, newest first), and `GET /api/trace/:pid`
  (a redacted per-process syscall timeline). Read-only by construction: GET
  handlers only, and any other method answers `405`. Binds to `127.0.0.1`
  unless `--host` says otherwise. The dashboard reads only from disk (meta
  files, `.crec` logs, integration event files), so it works across the
  CLI's short-lived process model and never requires a running kernel.
- **LangChain callback integration — `CortexLangChainCallbackHandler`.** A
  dependency-free handler implementing LangChain's callback protocol without
  importing LangChain. Records chain, model, tool, retriever, and agent
  lifecycle events as metadata only (type, timing, duration, token counts,
  error *name*) to `.cortex/integrations/langchain/events.jsonl`. Prompts,
  model outputs, tool inputs, and retrieved documents are deliberately
  omitted. Set `metadata: { cortexPid: <pid> }` on an invocation to
  associate events with a Cortex process. Concurrent handler calls are
  serialized, so the JSONL stays line-valid. `await handler.flush()` before
  process exit.
- **New package exports** `cortex-agent-os/dashboard`
  (`startDashboard` / `RunningDashboard`) and
  `cortex-agent-os/integrations/langchain`
  (`CortexLangChainCallbackHandler`), both documented in the new
  [docs/INTEGRATIONS.md](./docs/INTEGRATIONS.md).
- **[docs/DRIVERS.md](./docs/DRIVERS.md)** — the built-in LLM drivers
  (mock / deepseek / openai): selection order, environment variables, and
  endpoint overrides, collected in one page.

### Fixed

- **`cortex spawn` reported zeroed budgets when the kernel entry was already
  reaped.** When the process finished (and was reaped) before the CLI
  collected final state, the token counters and timestamps fell back to
  defaults. `spawn` now falls back to the persisted `meta.json` (written by
  the kernel's `onProcessExit` hook in 1.0.3) before giving up, so budgets
  and timestamps survive.

## [1.0.3] — 2026-09-24

Bug-fix release. All eight issues from the `v1.0.1` field report are now
resolved; seven were code bugs (C5 was already fixed by the `1.0.2` packaging
work). No syscall, `.crec`, or `.csnap` format change — the ABI frozen at
`1.0.0` is untouched, so this is a drop-in patch.

### Fixed

- **C1 — `checkpoint()` left the process in `ready`, trapping `ESTATE` on the
  next syscall.** The non-`detach` snapshot now returns the process to
  `running` (matching [docs/ABI.md](./docs/ABI.md)), and `checkpointing→running`
  is a legal transition. `RUNNING`↔`RUNNING` is preserved; a checkpoint taken
  from `BLOCKED` still returns to `READY`.
- **C2 — subprocesses were invisible to `ps` / `top`.** `cortex spawn` only
  persisted a meta for the single PID it booted; the children an agent spawned
  internally via `ctx.spawn()` had no `meta.json`, so `cortex top`'s "process
  tree" was a single node. The kernel now fires an `onProcessExit` hook (a new,
  optional `KernelOptions` field) at the ZOMBIE transition — *before* `init`
  reaps the entry — and the CLI writes a `meta.json` for **every** process,
  including internal children. `ps` / `top` now draw the real supervision tree.
- **C3 — the CLI could not target an OpenAI-compatible endpoint.** `bootCliKernel`
  now reads `OPENAI_BASE_URL` / `OPENAI_MODEL` (and the existing
  `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL`) and forwards them to the LLM drivers,
  so OpenRouter / vLLM / any proxy works without bypassing the CLI. Documented
  in `cortex help`'s ENVIRONMENT section.
- **C4 — `cortex restore` silently fell back to the mock driver.** Restored
  processes now honor `--driver <name>` (and the original agent's declared
  driver is force-loaded so a missing key fails *clearly* rather than echoing
  deterministic output). When the restored agent declared a driver that is not
  loaded in the current environment, `restore` prints an explicit warning
  instead of silently swapping in the default.
- **C6 — an already-aborted call was reported as `ETIMEDOUT`.** The LLM drivers
  conflated a real deadline timeout with an interrupt raised by process
  teardown. They now compare against `ctx.deadline`: past the deadline ⇒
  `ETIMEDOUT`; aborted earlier ⇒ `EINTR` — so the genuine failure cause is no
  longer drowned out during host-level retries.
- **C7 — `ESTATE` errors carried no context.** The dispatcher now reports the
  current state and the allowed states in the error (`spawn requires one of
  [running]; current state: ready`).
- **C8 — `cortex spawn` could not pass arguments to an agent.** New `--args
  <json>` flag hands a JSON object to the agent as `AgentSpec.args` (only with
  `--module`), so one agent module serves many tasks.

### Added

- `KernelOptions.onProcessExit` (kernel) and `PersistedProcessMeta` (kernel
  types) — both additive and optional, so they do not affect the frozen ABI.

## [1.0.2] — 2026-09-23

### Fixed — the bundled demos actually load for an npm user

`1.0.1` shipped `examples/` in the tarball, but that only exposed the second bug:
Node refuses to type-strip `.ts` files **under `node_modules`**
(`Stripping types is currently unsupported for files under node_modules`), so
`cortex spawn --module ./examples/hello-agent.ts` still died with
`code 127: agent load failed` for a real `npm i` user. Worse, the README told
those users to run `./examples/<x>.ts` against their **cwd**, where the folder
does not exist.

- Examples are now **compiled to plain JS** in `dist/examples/` (`tsc -p
  tsconfig.examples.json`, added to `build`), so they load on every Node in
  `engines` with no type-stripping caveats.
- New **`cortex example <name>`** command resolves the bundled module relative
  to the *package itself* and forwards to `spawn` with the demo's default role.
  No paths, no flags: `cortex example hello`, `cortex example demo-a`,
  `cortex example caps --cap tool:dangerous`.
- Both READMEs now point at `cortex example` and drop the inaccurate "Node
  22.18 type stripping" workaround (it never applied under `node_modules`).

No kernel or ABI change — this is a packaging and CLI patch. The `.ts` sources
still ship and still work straight from a clone with `tsx`.

## [1.0.1] — 2026-09-23

### Fixed — the README's demos did not work for an npm user

`examples/` was deliberately left out of the published tarball, but every demo
in the README runs `cortex spawn --module ./examples/<something>.ts`. So anyone
who did `npm i -g cortex-agent-os` and followed the README hit *module not
found* on the very first thing it asked them to do — which also broke the
BACKLOG's own Phase 4 exit criterion ("a stranger reproduces all three demos
from the README in under 10 minutes"). `examples/` now ships in the package.

Shipping them surfaced one caveat, now documented in both READMEs: the examples
are `.ts`, loaded by Node's type stripping. That is on by default from **Node
22.18+**; earlier 22.x needs `NODE_OPTIONS=--experimental-strip-types`. And
`cortex spawn --role x --task "..."` needs no `.ts` at all, if you would rather
not think about it.

### Fixed

- README / README.zh-CN said 513 assertions; the suite is 525.

No kernel or ABI change — this is a packaging and documentation patch.

## [1.0.0] — 2026-09-23

**The syscall ABI is frozen.** This is the release that settles the contract
rather than adding to it, and it exists mainly to close two things the ABI had
explicitly deferred to "v1".

### Added — capabilities (docs/ABI.md §4.9, promised by §9.2)

Three syscalls: `acquire(cap)`, `release(cap)`, `caps()`. Six capabilities in a
closed set — `spawn`, `kill`, `fork`, `tool:dangerous`, `ipc:any`, `admin`. A
process now has two sets, *held* (what it can do now) and *grantable* (what it
may raise later), seeded by `spawn` and adjusted by the two syscalls.

- **Default is full privilege, not least privilege.** Every agent, example and
  smoke check written before 1.0 predates capabilities; defaulting to empty
  would turn all of them into `EPERM` traps on upgrade. Least privilege is
  opt-in via `SpawnOptions.capabilities` / `grantable`, and via
  `cortex spawn --cap` / `--grantable`.
- **Two gates are conditional, by design.** `kill` and `ipc:any` apply only to
  processes that are not your descendant and not in your own process group;
  `tool:dangerous` applies only to tools the driver tagged `irreversible`. A
  supervision tree can always kill the child that missed its deadline, and a
  narrowed leaf can still read, compute and call reversible tools. Without
  this, `kill` would be handed to every supervisor and would mean nothing.
- **Escalation is recorded.** `acquire` writes a `.crec` frame like any other
  syscall, so "when did this agent escalate, and what did it do next" is
  answerable from the log. That is why it is a syscall and not a config flag.
- Capability state lives on the process-table entry, not beside the
  dispatcher, so it survives `checkpoint` → `restore` and shows up in `ps`
  without going through the dispatcher.

### Added — explicit channel lifecycle (docs/ABI.md §4.5, promised by §9.3)

Two syscalls: `channel_open(opts?)`, `channel_close(channel)`. `channel_open`
returns a fresh `ChannelId` — anonymous, or a claimed `name` (duplicate names
are `EINVAL`) — so a channel is knowable *before* anyone sends to it.
`channel_close` retires it: queued messages are dropped, parked `recv()`
waiters are rejected `EBADF`, later `send` traps `EBADF`. Idempotent.

**Implicit creation on `send` is kept.** Removing it would break every agent
written before 1.0 — exactly the kind of change the freeze now forbids. What
changed is that implicit creation is no longer the *only* way to get a channel.
(Worth noting: ABI §10 predicted this would land in `0.2`. It was right about
the problem and four minor versions wrong about the date.)

### Changed

- **24 syscalls, up from 19.** `SYSCALL_NAMES` and every policy table
  (`SYSCALL_ALLOWED_STATES`, `SYSCALL_REVERSIBILITY`, `SyscallArgs`,
  `SyscallReturn`) are exhaustive over the new set, so adding one without
  updating all seven sites is a compile error.
- `ProcessInfo` gained a required `capabilities` field.
- `SpawnOptions` gained optional `capabilities` / `grantable`.
- `CortexContext` gained five methods (`acquire`, `release`, `caps`,
  `channel_open`, `channel_close`).

### Deliberately deferred to 1.1 (not an ABI change, so it does not block the freeze)

Collapsing the self-recorded syscalls (`memory_read`, `memory_write`, `send`,
`recv`, `fork`, `checkpoint`, `restore`) onto the dispatcher's single recording
path. Those modules predate the dispatcher and still write their own `.crec`
frames; the on-disk format is identical either way, so this is internal
tidying rather than a contract change — and `send`'s atomicity (a failed
record must not leave a phantom message) depends on the module controlling
when it records. Worth doing, worth doing carefully, not worth holding the
freeze hostage.

### Tests

Smoke **513 → 525 checks, 0 failures.** Nine new checks cover the capability
model (default-full-privilege, `EPERM` on spawn without `spawn`, `acquire`
from the grantable pool, `EPERM` outside the pool, `EINVAL` for a non-capability
name, `release`, killing your own child without `kill`, and `EPERM` for
killing a stranger), and three cover the channel lifecycle (open → exists
before any send, named channels + duplicate-name `EINVAL`, close → `EBADF`).
The syscall-count assertion now also names the five new syscalls, so a future
addition cannot silently change the surface.

## [0.2.1] — 2026-09-20

Closes the last of the four v0 gaps: the on-disk layout is now the per-process
subtree ARCHITECTURE §7 always described. `Recorder.open` writes `log.crec`
inside the process's own directory (`processes/<pid>/{log.crec, meta.json,
checkpoints/}`), created on first open, so `rm -rf processes/<pid>` removes the
process's entire footprint — log, index and checkpoints — with no global index
to sweep. `CheckpointManager` gained a `dirFor(pid)` and scans the tree when it
must resolve a checkpoint by chainId.

### Changed

- **Per-process persistence subtree.** The flat `processes/<pid>.crec` +
  `<pid>.meta.json` + one shared `checkpoints/` is replaced by
  `processes/<pid>/{log.crec, meta.json, checkpoints/}`. `boot.ts`,
  `recorder.ts`, `checkpoint.ts`, `process_store.ts` and the CLI path helpers
  (`crecPath` / `metaPath` / `procDir` / `procCheckpointsDir`) all resolve under
  it; `existingCrecPath` returns the new path when present, the legacy flat file
  otherwise.
- **Legacy homes still read.** `existingCrecPath`, `readMeta`, `maxPidOnDisk`
  and `findCheckpointByTag` fall back to the pre-`0.2.1` flat files (`processes/
  <pid>.crec` / `<pid>.meta.json`, shared `checkpoints/`), so a home written by
  an older build upgrades transparently on first read. `maxPidOnDisk` keeps
  scanning both layouts — a forked child has a `.crec` but no `.meta.json`, and
  counting the raw `.crec` is what stops the PID counter reusing a dead child's
  file.

### Still open (honestly)

- Nothing in the original four-gap list remains. The kernel now does everything
  the v0 documents promised: `sleep()` parks, a restored process runs on its
  own, the synchronous syscalls are recorded, and the persistence layout is the
  per-process subtree.

Smoke: 512 → 513 checks.

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
[1.0.1]: https://github.com/Jackeven02/cortex-os/releases/tag/v1.0.1
[1.0.0]: https://github.com/Jackeven02/cortex-os/releases/tag/v1.0.0
[0.2.1]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.2.1
[0.2.0]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.2.0
[0.1.7]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.1.7
[0.1.6]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.1.6
[0.1.5]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.1.5
[0.1.4]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.1.4
[0.1.3]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.1.3
[0.1.2]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.1.2
[0.1.1]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.1.1
[0.1.0]: https://github.com/Jackeven02/cortex-os/releases/tag/v0.1.0
