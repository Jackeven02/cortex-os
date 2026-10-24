# Agent State

> The hardest document in cortex. Everything else is plumbing.

**English** | [简体中文](./STATE.zh-CN.md)

---

## 1. Why this document exists

Unix's `fork()` is famously simple to specify and famously hard to implement. The spec is one sentence: *"create a new process by duplicating the calling process."* The implementation requires the kernel to have a precise definition of **what a process is**.

That definition is the hard part. Process state in Unix is:

- Register file
- Virtual memory pages
- File descriptor table
- Signal mask and pending signals
- Credentials (uid / gid / capabilities)
- Working directory, root, umask
- Resource limits
- Open file locks
- ... and a long tail of others

Every one of these has a well-defined copy semantics: copy-on-write, share, duplicate, or fail. The OS has been refining this list for fifty years.

**Cortex's `fork()` has the same problem and no fifty years of refinement.** What *is* an agent? What gets copied when you fork one? What can't be copied at all?

This document is our first answer. It will be wrong in places. We will revise it. But until we have *something* written down, the kernel cannot be built.

---

## 2. The seven categories of agent state

Every piece of state an agent has falls into one of these:

### 2.1 Identity

- PID, parent PID, role name, creation timestamp.
- **Copy semantics:** new identity for the fork. PID is fresh; `parent_pid` points to the forker; lineage is recorded.

### 2.2 Cognitive context

- The current message history (system prompt, conversation, scratchpad).
- The "current intent" — what the agent thinks it is doing right now.
- Pending tool calls awaiting response.
- **Copy semantics:** deep copy. This is pure serializable JSON. It is also the largest part of the snapshot.

### 2.3 Memory

- Long-term episodic memory (events).
- Semantic memory (facts learned).
- Procedural memory (skills, habits).
- **Copy semantics:** configurable per memory *region*:
  - `private` — deep copy on fork, diverge after.
  - `shared` — both processes see the same backing store; writes are visible to both (see §8.1 on concurrency).
  - `cow` — copy-on-write. Reads shared until first write, then fork the page.
- **Defaults:** `cow` for episodic, `shared` for semantic, `private` for procedural.
- **Size ceiling:** each region may declare `maxEntries` — a write-count cap that `memory_write` enforces with `ENOMEM` *before* any copy-on-write divergence. Absent inherits the kernel-wide ceiling; `-1` opts that region out to unlimited. Declared per region via `cortex spawn`/`cortex daemon install --memory` and inherited on `fork` unless `memoryOverrides` supplies a different value. **The ceiling is a fact the operator can see**: `cortex memory`'s region table prints the region's **write count** (the number the cap is measured against) and the resolved cap beside it (`∞` when unbounded, `?` when the kernel did not report one). The *entry* count is a different number — a region with three entries written fifteen times holds three entries and has made fifteen writes — so the cap is never printed beside the entry count alone.
- **Write access:** a region may also declare `readOnly`, and then `memory_write` traps `EPERM` on it. The access mode belongs to the *binding*, not to the region: a `shared` region's physical key is shared, so a process whose own binding is read-only reads what the others write and cannot change it — which is the only shape in which `readOnly` does anything (a read-only `private` region can never be filled). **The access mode is a fact the operator can see too**: `cortex memory` prints this process's own mode in the `ACCESS` column (`read-write` / `read-only`, `?` when the kernel did not report one) and each peer's mode in `SHARED WITH` (`3 (read-only)`), and the region dump names the same mode in its header. Sharing is not writing, and the two are said apart on both sides of the region.
- **The window sees the same memory the CLI sees.** A region's facts are not only in the terminal: the dashboard serves a process's memory over two endpoints (`GET /api/memory/<pid>` for the regions, `GET /api/memory/<pid>/<region>` for one region's entries), and the process dialog has a second view beside the syscall timeline — **记忆** — because an operator's window could show what an agent *did* and nothing about what it *knows*. The panel says the same words `cortex memory` says (the access mode, the ceiling, the peers), since the words live in one module (`src/cli/memory_view.ts`) and each view supplies only how it prints a number. The memory is fetched **on demand** — when the panel opens, not on every process-table refresh, which would turn one poll into N round trips. Without a live kernel the panel says it needs one rather than showing an empty region: the contents live in the kernel that owns them, and there is no on-disk copy to read instead.

### 2.4 Resource budgets

- Tokens spent (input / output / cached).
- **The cached part is inside the input, and it is counted once.** The provider reports the whole prompt (`prompt_tokens`) and says how much of it it did not have to read again (`cached_tokens`), so `tokensCached` is a **subset of** `tokensIn` — not a third column of spend. The total a process spent is `tokensIn + tokensOut`, and a total that added the cached part on top would drain the token ceiling twice as fast as the work did. The cached tokens are worth naming anyway, because they are billed at the cache price rather than the fresh one — so every view that shows tokens says which part of them was cached, and the arithmetic and the wording live in one module (`src/token_usage.ts`).
- Money spent (microdollars per provider).
- Wall-clock time alive.
- **How long a process lived is a fact the operator can see.** The kernel charges wall-clock time against the budget (PROCESS.md §8.3) and records the total for a process that has finished, so the duration is a fact and not a guess. Every view that shows a process says it: `cortex ps` has an `AGE` column, `cortex top` has one too, and the dashboard's process table has **存活时长**. The rule is one rule — a **running** process is aging, so the number is the time since it started; a **finished** process is not aging, so the number is the lifetime the kernel recorded and it stops growing there. A start time is not a duration: for a process that died an hour ago it says nothing about how long it lived.
- Syscall count.
- **Copy semantics:** configurable. Default is **reset to zero** on fork. The fork is a new attempt; the parent's sunk cost should not burden it. Alternatives: `inherit`, `split`.
- **A budget has two numbers, and they are not the same number: the ceiling and the remainder.** The kernel keeps the *remainder* (`budgetsRemaining` — what is left, which shrinks as the process spends) and the *spend* (`budgetsSpent`). The **ceiling** — the total the process may ever spend — is the sum of the two, and is unlimited when the remainder is `-1`. Printing the remainder under the label "limit" is how a number that moves under the operator's feet gets read as a fixed promise, so every view that names a budget must name the ceiling and mark the remainder as what is left. `cortex limit` is the report; **the tables say the ceiling too** — a spend on its own ('1.2k') is 12% of one budget and 99% of another, and the two need very different answers, so every cell that shows a spend shows the ceiling it is measured against beside it ('1.2k of 10k', and ∞ when the budget has none). The rule lives in one place (`src/cli/process_budget.ts`), so `cortex ps`, `cortex top`, `cortex spawn`, `cortex wrap` and the dashboard cannot disagree about it.
- **A process's two spends travel together.** The window shows a process's tokens and its money in the same row. The money used to live only in the budget panel, which rolls it up **by role** — so an operator could see which agent spent the tokens and could not see which one spent the money, and the money each agent was allowed to spend was nowhere in the window at all. The rule is one rule (`formatUsdBudget`, in `src/cli/process_budget.ts`), so the window and `cortex top` say the same cost for the same process, and a spend always carries the ceiling it is measured against.
- **The money counter is an integer count of microdollars, and it is converted in exactly one place.** `usdSpent` is in **microdollars** (1 USD = 1_000_000), and it is an integer — a fractional dollar is not a value this counter can hold. Anything folded into the budget from outside the kernel (the tap's price, a driver's usage) arrives in **dollars** and is converted at that boundary. Every view that shows the number to a human converts it too, and the conversion lives in one module (`src/money.ts`) so there is a single place to be wrong about the scale. A view that prints a raw microdollar counter next to a dollar sign is not formatting: it is a number about money, and it has to be the same number in every view that shows it.
- **Money is printed at the resolution the kernel counts it — six decimals.** Not a taste: one model call costs about **$0.000027**, and printed to four decimals that is `$0.0000`. A run that spent real money then reads as a run that spent nothing, and a budget that is being watched reads as a budget nobody has touched. Six decimals is what a microdollar count can say exactly. The rule lives beside the conversion, in the same module (`formatDollars`), because a format that only one layer can reach is a format the other layers reinvent — and they did: `cortex top` and the dashboard's budget panel said `$0.0000` while `cortex limit` said `$0.000027`, from the same record.
- **A process's spend is a total; a call's is a pair.** The counters above are what a *process* accumulated. One `llm_call` spent its own share of them, and the kernel records that share in the frame's result, in the ABI's `usage` shape (ABI.md §4.3): the input it read, the output it wrote, the part of the input the provider served out of its cache, and the price. The views read that shape with one function (`callUsage`, in `src/token_usage.ts`) — the CLI's trace, the dashboard's event table **and the dashboard's syscall timeline** — so none of them can disagree about the same frame. **A counter the frame did not report is not a counter of zero:** it stays absent, and a view that prints it as `0` would be claiming something nobody said. A frame that spent nothing says nothing at all — an empty cell is honest, and `$0.000000` would be a claim about a number nobody spent.

### 2.5 Driver / tool state

- Open MCP server sessions.
- File handles in the agent's sandbox.
- DB connections, HTTP session cookies, OAuth tokens cached mid-flow.
- Child process handles.
- **Copy semantics: NOT GENERALLY COPYABLE.** This is the first hard limit. Most external resources cannot be duplicated meaningfully — two processes cannot share the same socket, the same DB transaction, the same authenticated session.
- **Cortex policy:** fork **closes** all driver state in both parent and child by default. Each must re-acquire. Drivers may opt into a `forkable: true` capability if they can serialize and re-hydrate themselves. This is rare and the kernel does not trust the claim without tests.

### 2.6 Side effects in the world

- Emails sent.
- Files written to the host filesystem (outside the sandbox).
- API calls made — orders placed, tweets posted, money transferred.
- Database mutations committed.
- **Copy semantics: UNCOPYABLE BY DEFINITION.** Reality has only one branch. The fork remembers sending the email; the email itself exists exactly once.

This is the philosophical heart of the document. See §5.

### 2.7 Lineage

- Syscall history (the recording).
- Checkpoint chain (which snapshots preceded this state).
- Fork tree (who forked from whom).
- **Copy semantics:** append-only, branched on fork. Both children share the prefix; each appends its own suffix.

---

## 3. The fork taxonomy

Not all forks are the same. Cortex distinguishes four kinds.

### 3.1 Cognitive fork (default, v0)

Copy categories 1–4 and 7. Close category 5. Acknowledge category 6 as shared past.

**Use case:** explore an alternative reasoning path from a decision point. *"What if I had asked the LLM differently?"*

### 3.2 Sandbox fork (post-v0)

Cognitive fork **plus** a copy-on-write filesystem overlay and a network egress recorder. Side effects in the sandbox do not escape to the host until committed.

**Use case:** let an agent try a risky edit without committing it. The branch that wins gets `commit()`-ed; the loser gets discarded along with its overlay.

Requires a sandbox driver. Not in v0.

### 3.3 Replay (not really a fork)

Do not fork a live process. Reconstruct from a checkpoint and run forward.

**Use case:** deterministic testing, debugging, "what if I changed the prompt at step 12?"

This is the bread-and-butter of agent debugging and it is in v0.

### 3.4 Shadow process (post-v0)

Spawn a new process with the same cognitive snapshot but a different driver config — different LLM, different temperature, different system prompt.

**Use case:** A/B comparing model behavior on identical state.

Cheap to add once cognitive fork works. Not in v0.

**v0 ships cognitive fork and replay.** Sandbox fork and shadow process are post-v0.

("Replay" here means re-running a *recorded* run against its recording — the
deterministic replay of §5.5, `cortex replay`. It is not the "seek the
syscall log to an offset and replay forward" of §4, which is what a restore
does.)

---

## 4. Checkpoint format

A checkpoint is a single file. Binary, CBOR-encoded, content-addressed by SHA-256.

```
.csnap file:

  Header
    magic:        "CRTX"
    version:      u32
    pid:          u64
    parent_pid:   u64 | null
    created_at:   ISO8601
    chain_id:     uuid       # links checkpoints in a lineage
    prev_in_chain: chain_id | null

  CognitiveSnapshot
    messages:      Message[]
    intent:        string | null
    pending_calls: PendingCall[]

  MemoryDelta
    base_chain_id: chain_id | null    # if incremental
    writes:        MemoryEntry[]      # since base

  BudgetCounters
    tokens_in:      u64
    tokens_out:     u64
    tokens_cached:  u64
    usd_spent:      u64              # microdollars
    wall_time_ms:   u64
    syscall_count:  u64

  SyscallLogOffset
    file:         path               # usually .crec next to .csnap
    byte_offset:  u64

  DriverStates
    [driver_name: string]: opaque blob | null
    # null = "this driver had no state at checkpoint"
    # blob = driver-defined; kernel does not interpret

  Signature
    sha256(everything above)
```

The **syscall log** itself is a separate append-only file (`.crec`). Checkpoints reference an offset into it. Restoring means: load checkpoint, seek syscall log to offset, replay forward — with cached responses if deterministic mode is on, with live calls otherwise.

Why two files? Because syscall logs grow continuously and we want them streamable; checkpoints are discrete snapshots and we want them content-addressed. Mixing them is a mistake every workflow engine eventually regrets.

---

## 5. The irreversible action doctrine

This is the section that distinguishes cortex from naive "agent time travel" pitches.

> **Claim:** *Fork is a cognitive operation, not a physical time machine.*

When an agent calls `tool_call("send_email", ...)` and the email is sent, that email exists in the world. If you later fork the agent, the fork has the **memory** of sending the email — but the email itself was sent exactly once.

This is not a bug. It is a fundamental property of operating in reality. Any framework that pretends otherwise is selling you something dishonest.

Cortex's policy:

### 5.1 Syscalls are tagged

Every tool declares its side-effect class:

- `reversible` — can be undone by another call (e.g. `file_write` can be reverted from backup).
- `idempotent` — calling it twice is the same as calling it once (e.g. `http_get`).
- `irreversible` — once done, cannot be undone (e.g. `send_email`, `stripe_charge`, `tweet_post`).

Tagging is per-tool, declared by the driver author. The kernel records the tag in the syscall log.

**The tag is a fact the operator can see.** The kernel records it on every frame (ABI.md §4.1) and `cortex trace` prints it in a column of its own — but the operator's window dropped it: the dashboard's event table said what was called, how long it took and what it spent, and nothing about whether the call could be taken back. A tool call that charged a credit card read exactly like a read, and the one distinction an operator watching the window most needs was the one the window threw away. The event table has a **可逆性** column now — between the duration and the cost, the order `cortex trace` uses — and the syscall timeline says it too, so the window's two views of one frame cannot disagree about it. The word is the **recorded** one, and a frame that carries no tag is *not reported*, not "reversible".

### 5.2 Forkable regions

An agent can declare a span of execution as a **forkable region**:

```typescript
await ctx.forkable(async () => {
  // Inside here, irreversible syscalls trap.
  // The kernel asks the supervisor before allowing them.
  await ctx.llm_call(...);
  await ctx.tool_call('grep', ...);   // idempotent, fine
  // await ctx.tool_call('send_email', ...);  // TRAP
});
```

This is the discipline that makes meaningful fork possible: you fork **before** reality commits, not after.

### 5.3 Two-phase pattern

Drivers can implement `stage` and `commit` operations:

```typescript
const staged = await ctx.tool_call('email.stage', { to, body });
await ctx.checkpoint({ tag: 'before-send' });
// ... fork here, explore alternatives ...
await ctx.tool_call('email.commit', { staged_id: staged.id });
```

Between stage and commit, fork gives a real choice point. After commit, both branches inherit the same past.

### 5.4 After the fact

If you fork an agent that has already done irreversible work, both branches inherit the memory. The kernel records this as a **shared causal past**. Neither branch can undo it.

This is fine. **Forks are for exploring future branches, not for rewriting past ones.**

### 5.5 What we promise, what we don't

We promise:
- You can always replay an agent's reasoning deterministically.
- You can always fork at any checkpointed point and explore an alternative future.
- You can always know which actions were reversible and which were not.

**The first one is now a command.** `cortex replay <pid>` re-runs a recorded
agent with the world frozen — the model's answers, the tool results, the clock
and the RNG all come from the recording — and compares the two runs, so the
answer is "it behaved the same way" or "it first diverged *here*"
(docs/ARCHITECTURE.md §4.12). Note what the promise does **not** say: a
replay does not undo committed reality. A tool that already ran is not run
again — the recorded result is served — because the promise is about the
agent's reasoning, not about the world.

**And it holds for a whole tree.** A run is usually a supervisor and its
children, and each process has its own recording — so each one answers from
**its own** history, and the report says *which* process diverged. That is the
honest form of the promise: "the agent's reasoning" means every agent's
reasoning, and a child that answered from its parent's recording would be
reproducing something that never happened.

We do not promise:
- Undo of committed reality.
- Distributed transaction semantics over external services.
- "Rollback" of side effects in the world.

If you want those, you want a workflow engine with compensating transactions (look at Temporal). Cortex is a different tool.

---

## 6. The state lifecycle (preview)

Full state machine in `PROCESS.md`. Quick summary:

```
                       spawn
                         ↓
                       [new]
                         ↓
                       [ready] ←──────────────┐
                         ↓                  │
                       [running]            │
                  ↙       ↓        ↘        │
            [blocked]  [exiting]  [checkpointing]
                ↓         ↓             ↓
              ready    [zombie]    [suspended]
                                          ↓
                                       restore
                                          ↓
                                        ready

           fork (from running or suspended)
                         ↓
                creates new [new] process
                with copied snapshot
                both processes append to their own
                branch of the syscall log
```

---

## 7. TypeScript types

The kernel-side contract. These types live in `src/kernel/types.ts` (the
compiler-enforced form of the ABI) and are re-exported from `cortex-agent-os`. The
three id types are **branded** — `Brand<T, B>` — so a `ChainId` can never be
passed where a `ProcessId` is expected; construct them with the kernel's
`asProcessId()` / `asChainId()` / `asSyscallOffset()` and strip the brand with
`unbrand()` at the kernel↔driver boundary.

```typescript
export type ProcessId = Brand<number, 'ProcessId'>;
export type ChainId = Brand<string, 'ChainId'>;        // UUID linking checkpoints
export type SyscallOffset = Brand<number, 'SyscallOffset'>;  // byte offset in .crec log

export type Reversibility = 'reversible' | 'idempotent' | 'irreversible';

export interface Message {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCallId?: string;
}

export interface PendingCall {
  readonly id: string;
  readonly tool: string;
  readonly args: unknown;
  readonly startedAt: string;
}

export interface CognitiveSnapshot {
  readonly messages: readonly Message[];
  readonly intent: string | null;
  readonly pendingCalls: readonly PendingCall[];
}

export interface BudgetCounters {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly tokensCached: number;
  readonly usdSpent: number;        // microdollars, integer
  readonly wallTimeMs: number;
  readonly syscallCount: number;
}

export interface MemoryDelta {
  readonly baseChainId: ChainId | null;
  readonly writes: readonly MemoryEntry[];
}

export interface MemoryEntry {
  readonly region: string;
  readonly key: string;
  readonly value: unknown;
  readonly at: string;
}

export type MemoryRegionKind = 'private' | 'shared' | 'cow';

export interface MemoryRegionPolicy {
  readonly kind: MemoryRegionKind;
  readonly backing: string;         // driver-identified
  readonly readOnly?: boolean;      // memory_write traps EPERM when true
  readonly maxEntries?: number;     // per-region write-count ceiling:
                                    //   absent = inherit kernel maxRegionEntries
                                    //   -1     = unlimited for this region
                                    //   0+     = hard cap (ENOMEM, checked
                                    //            before cow divergence)
}

export interface Checkpoint {
  readonly magic: 'CRTX';
  readonly version: number;
  readonly pid: ProcessId;
  readonly parentPid: ProcessId | null;
  readonly createdAt: string;       // ISO8601
  readonly chainId: ChainId;
  readonly prevInChain: ChainId | null;
  readonly cognitive: CognitiveSnapshot;
  readonly memoryDelta: MemoryDelta;
  readonly budgets: BudgetCounters;
  readonly syscallLogOffset: SyscallOffset;
  readonly driverStates: Readonly<Record<string, Uint8Array | null>>;
  readonly signature: Uint8Array;   // sha256
}

export type ForkKind = 'cognitive';   // v0; sandbox/shadow added later

export type BudgetForkPolicy = 'reset' | 'inherit' | 'split';

export interface ForkOptions {
  readonly kind?: ForkKind;                       // default 'cognitive'
  readonly budgets?: BudgetForkPolicy;            // default 'reset'
  readonly memoryOverrides?: Partial<Record<string, MemoryRegionPolicy>>;
  readonly closeDriverState?: boolean;            // default true
  readonly tag?: string;                          // human label
}

export interface ForkResult {
  readonly childPid: ProcessId;
  readonly childChainId: ChainId;
  readonly sharedCausalPast: SyscallOffset;       // log offset where branches diverge
  readonly irreversibleInPast: readonly string[]; // tool names that already happened
}
```

---

## 8. Open questions

These we have not decided. Each gets an issue.

### 8.1 Concurrency on shared memory

If two forked agents both write to a `shared` semantic memory region, what happens?

- **Last-write-wins.** Simple. Surprising. Probably wrong for facts.
- **CRDT.** Correct. Heavy. Requires choosing a CRDT library and a data model.
- **Lock.** Familiar. Forces coordination the agents may not want.

**Instinct:** start with last-write-wins, log every conflict, add CRDT later if the logs show real pain. Do not over-engineer v0.

### 8.2 Budget split semantics

If parent has $5 budget and forks, does child get $0 (reset), $5 (inherit), or $2.50 (split)?

Default `reset` is opinionated. It treats fork as "new attempt" rather than "parallel exploration." For Demo C (compare two branches), `split` may be more honest. We may need to make this a per-fork option, with `reset` as default.

### 8.3 Syscall log branching

After fork, do both processes append to the same log file with PID tags, or do they get separate log files with a shared prefix?

- **Same file** makes "diff the two branches" tooling trivial.
- **Separate files** are simpler to implement and reason about.

**Instinct:** separate files, plus a small index that knows the branch point. Easier to GC, easier to ship to disk.

### 8.4 What is "intent"?

We have a slot for it but no definition. Is it:

- The last user message?
- A free-form summary the agent writes to itself?
- A structured task object with a schema?

**v0 answer:** free-form string, agent's responsibility. v1 may standardize once we see how people use it.

### 8.5 Checkpoint chain pruning

Long-running daemons will produce thousands of checkpoints. Do we garbage-collect? On what policy?

**v0:** never prune; user problem; provide `cortex gc` as a manual command.
**v1:** configurable retention (keep last N, keep tagged, keep daily).

### 8.6 Driver state opt-in

A driver claiming `forkable: true` is making a strong promise. How do we test that promise?

- Property-based tests in CI?
- Trust the driver author?
- Runtime detection (try to fork, see what breaks)?

**Instinct:** trust + warn for v0. Add a `cortex doctor` command in v1 that probes drivers.

### 8.7 What counts as a "side effect"?

A read-only HTTP GET that hits a rate-limited API and burns quota — is that a side effect? A `console.log` that goes to stdout the user is watching — is that a side effect?

**v0 answer:** if the driver author tags it `irreversible`, we believe them. We provide a `cortex audit` tool to surface untagged tools so authors notice.

---

## 9. What we will get wrong

This document is v0. Some predictions:

- We will discover a category of state we did not list (§2 will grow to nine or ten).
- The default memory policies (§2.3) will turn out to be wrong for some common case.
- The "forkable region" abstraction (§5.2) will feel awkward and we will redesign it.
- Driver state (§2.5) will turn out to be copyable more often than we expect, especially for stateless HTTP-based tools.

These are not failures. They are the document doing its job: being concrete enough to be wrong about.

---

*This document is the heart of cortex. If you find a flaw here, open an issue — it matters more than any kernel bug.*
