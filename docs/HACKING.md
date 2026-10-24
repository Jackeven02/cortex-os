# Hacking on cortex

cortex is a small kernel. That is the point: the whole thing is meant to be
legible enough that a stranger can read `src/kernel/` in an afternoon and
predict what it does. This guide is how to change it without breaking the
contracts it is built on.

Read in this order if you are new: **[MANIFESTO.md](../MANIFESTO.md)** (why),
**[ARCHITECTURE.md](./ARCHITECTURE.md)** (the thirteen kernel modules + the driver
registry), **[STATE.md](./STATE.md)** (the hard part: what state is), and
**[ABI.md](./ABI.md)** (the syscall contract).

---

## 1. Setup

Node **>= 22** (`package.json` `engines`).

```bash
npm install
npm run build     # tsc -p tsconfig.json — must be 0 errors
npm run smoke     # tsx scripts/smoke.ts    — THE regression suite
npm run lint      # tsc --noEmit
```

> **`npm test` is not the suite.** It runs `node --test tests/**/*.test.ts`, and
> `tests/` is intentionally empty in v0. The real harness is
> `scripts/smoke.ts` — several hundred assertions that import kernel modules
> directly and exercise them end to end (recorder → dispatcher → boot → CLI).
> When you change behavior, add a `check` there. Do **not** introduce
> jest/vitest/mocha; the zero-dependency discipline is deliberate.

Everything runs offline. The CLI selects an LLM driver from the environment
(`DEEPSEEK_API_KEY` → deepseek, `OPENAI_API_KEY` → openai, else the
deterministic `mock`). For deterministic local runs, `unset` both keys so the
`mock` driver is used.

---

## 2. Layout

```
src/kernel/      the kernel
  types.ts               the ABI, as compiler-enforced types  ← the contract
  errors.ts              CortexError + errno table
  recorder.ts            append-only CBOR .crec framing (the lowest layer)
  syscall_dispatcher.ts  the front door: state gate, recording, budgets, routing
  boot.ts                assembles the modules + driver registry; runs agents
  process_table.ts scheduler.ts signals.ts ipc.ts memory.ts
  checkpoint.ts fork.ts init.ts driver_registry.ts wake_gate.ts
src/drivers/     pluggable backends — llm/ tool/ memory/
src/cli/         the `cortex` binary (index.ts + commands/)
examples/        runnable agent modules (also the Demo A/B/C sources)
scripts/smoke.ts the regression suite
docs/            the contracts
```

---

## 3. The one rule: **documents are the contract**

`STATE.md`, `PROCESS.md`, `ABI.md`, and `ARCHITECTURE.md` are the single source
of truth. `src/kernel/types.ts` is the *compiler-enforced form* of `ABI.md`.

**A type change and its doc change land in the same commit.** If code and docs
disagree, one of them is a bug — fix both, don't pick a side. ABI or state-model
changes deserve an issue first (they are hard to reverse).

---

## 4. Conventions

- **ESM + TypeScript strict**, with `exactOptionalPropertyTypes` **on**. An
  optional field is set with a conditional spread, never `undefined`:

  ```ts
  // do this
  const opts = { role, agent, ...(budgets !== undefined ? { budgets } : {}) };
  // not this — fails to typecheck / writes a stray `undefined`
  const opts = { role, agent, budgets: budgets };
  ```

- **Branded IDs.** `ProcessId` / `ChainId` / `ChannelId` / `SyscallOffset` are
  `Brand<T, B>`. Inside the kernel, construct them with `asProcessId()`,
  `asChainId()`, …; cross the kernel↔driver boundary with `unbrand()`. User
  space never needs the brand constructors.

- **Errors are errnos.** Every kernel error is a `CortexError` carrying an
  errno (`ESRCH`, `ESTATE`, `EREVERSIBLE`, `EDRIVER`, `ERECORD`, `ETIMEDOUT`,
  `ENOENT`, `ENOMEM`, `EINVAL`, `EPERM`, …). Inside the kernel, throw with
  `trap('ESTATE', 'op', { message })`. `exit()` is *not* an error — it throws a
  `ProcessExitSignal` (a control-flow signal).

- **Exactly one runtime dependency: `cborg`** (the CBOR codec for the append-only
  syscall log). Everything else is a devDependency, and `scripts/smoke.ts` runs
  on `node --test`-free plain assertions rather than pulling in a framework.
  Adding a second runtime dependency needs a very good reason.

---

## 5. Write a driver

A driver is a backend for one of three interfaces, all in `types.ts` (§17).
Drivers are the only place vendor-specific code lives; **no kernel code knows
any vendor's name.**

### 5.1 LLM driver (`ILLMDriver`)

```ts
interface ILLMDriver {
  readonly name: string;
  readonly version: string;
  readonly abiCompat: string;            // semver range vs KERNEL_ABI_VERSION
  readonly supportedModels: readonly string[];
  call(req: LLMRequest, ctx: DriverContext): Promise<LLMResponse>;
  stream?(req: LLMRequest, ctx: DriverContext): AsyncIterable<LLMChunk>;
  countTokens?(messages: readonly Message[]): Promise<number>;
  close(): Promise<void>;
}
```

The smallest useful driver (an echo):

```ts
import type { ILLMDriver, LLMRequest, LLMResponse, DriverContext } from '../../kernel/types.js';

export function echoLLM(): ILLMDriver {
  return {
    name: 'echo',
    version: '1.0.0',
    abiCompat: '^1.0.0',
    supportedModels: ['echo-1'],
    async call(req: LLMRequest, _ctx: DriverContext): Promise<LLMResponse> {
      const last = req.messages[req.messages.length - 1];
      const text = `echo: ${last?.content ?? ''}`;
      return {
        text, toolCalls: [], finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, usd: 0 },
        model: req.model ?? 'echo-1', driverVersion: '1.0.0',
      };
    },
    async close(): Promise<void> {},
  };
}
```

Register it with `registry.registerLLM(echoLLM())`. The first registered driver
becomes the default unless a `{ system }` agent (or `defaultLLM`) names another.

**Errors are your responsibility.** The dispatcher does *not* wrap LLM-driver
throws, so translate HTTP status / abort / transport failure into a
`CortexError` with a stable errno yourself. See `src/drivers/llm/deepseek.ts`
(`errnoForStatus` + `wrapDriverError`) for the pattern. Make the network layer
injectable (`fetchFn`, `env`, `pricing`) so the smoke suite can test it without
a network — that is why every real driver here has those knobs.

### 5.2 Tool driver (`IToolDriver`)

```ts
interface IToolDriver {
  readonly name: string; readonly version: string; readonly abiCompat: string;
  listTools(): Promise<readonly ToolDescriptor[]>;
  invoke(name: string, args: unknown, ctx: ToolInvokeContext): Promise<ToolResult>;
  stage?(name: string, args: unknown, ctx: ToolInvokeContext): Promise<StagedAction>;
  commit?(staged: StagedAction, ctx: ToolInvokeContext): Promise<ToolResult>;
  readonly forkable?: boolean;
  serializeState?(): Promise<Uint8Array | null>;
  restoreState?(blob: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
```

Three things to get right:

1. **Declare `reversibility` on every `ToolDescriptor`.** It is a claim, and
   the kernel *trusts* it. A tool that is untagged defaults to `'irreversible'`,
   which means it **refuses to run inside `forkable()`** (`EREVERSIBLE`) — the
   safe default. `cortex audit` surfaces untagged/defaulted tools so an
   operator can see what got locked out. If your protocol has no reversibility
   field (MCP does not), default to irreversible and expose which tags were
   *declared* vs *inferred* (see `src/drivers/tool/mcp.ts`).
2. **`forkable` is a real promise.** Claim it only if you can
   `serializeState`/`restoreState` across a cognitive fork. A live subprocess
   cannot, so the MCP driver sets `forkable = false`. The kernel matches tools
   to drivers by name, and rejects a fork that would carry a non-forkable
   region.
3. **Return errors in the `ToolResult`, don't throw** — `{ output, error: { code,
   message } | null, durationMs, reversibility }`. Throwing is for driver-level
   failures (the server died), not for a tool that ran and failed.

`src/drivers/tool/fs.ts` is the reference (in-process, simple);
`src/drivers/tool/mcp.ts` is the interesting one (subprocess + JSON-RPC over
stdio, lazy spawn, `<namespace>/<name>` tool names).

### 5.3 Memory driver (`IMemoryDriver`)

```ts
interface IMemoryDriver {
  readonly name: string; readonly version: string; readonly abiCompat: string;
  read(region: string, query: MemoryQuery): Promise<readonly MemoryEntry[]>;
  write(region: string, key: string, value: unknown, opts?: MemoryWriteOptions): Promise<void>;
  delete(region: string, key: string): Promise<void>;
  listRegions(): Promise<readonly string[]>;
  snapshotRegion(region: string): Promise<Uint8Array>;
  restoreRegion(region: string, blob: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
```

`snapshotRegion` / `restoreRegion` are **required**, because fork and checkpoint
must serialize a region without reaching into your internals. A region is
usually a `Map<string, Entry>`; `restoreRegion` replaces it wholesale.
**Copy-on-write is the kernel's job** (`memory.ts`), not yours — a driver just
stores and snapshots. `read` supports `{ key }`, `{ prefix }`, `{ limit }`;
drivers may add fields via `query.extra` for vector/semantic search (post-v0).
See `src/drivers/memory/inmem.ts` (simplest) and `sqlite.ts`.

---

## 6. Write an agent

An agent is a module whose **default export** is:

```ts
export default async function myAgent(
  ctx: CortexContext,
  args: Record<string, unknown> = {},
): Promise<void> { /* ... */ }
```

Run it:

```bash
cortex spawn --role my-role --module ./examples/my-agent.ts
```

The `CortexContext` surface (docs/ABI.md §8):

| Group | Calls |
|---|---|
| Process control | `spawn`, `wait(pid?, { timeoutMs })`, `exit(code, reason)`, `kill(pid, signal)`, `ps(filter?)` |
| State | `fork({ tag? })`, `checkpoint({ tag?, detach? })`, `restore(chainId, opts?)` |
| Cognition | `llm_call({ messages, tools?, model? })`, `tool_call(name, args, { stageOnly? })` |
| Memory | `memory_read(region, { key?/prefix?/limit? })`, `memory_write(region, key, value, { ttlMs? })` |
| IPC | `send(target, message)`, `recv(source?, { timeoutMs? })` |
| Time | `sleep(ms)`, `now()`, `random()` |
| Signals | `on_signal(signal, handler \| 'default' \| 'ignore')` |
| Budgets | `budget()` |
| Fork safety | `forkable(async () => { ... })` |

Identity (`ctx.pid`, `ctx.ppid`, `ctx.pgid`, `ctx.role`) are properties, not
syscalls.

**Four gotchas that will bite you** (all real, all learned the hard way):

1. **A parent spawning a child must pass an absolute `module`.** A bare
   relative specifier resolves against the *importing* module
   (`src/kernel/boot.ts`), not the cwd, so `'./examples/x.ts'` looks for
   `src/kernel/examples/x.ts` and the child exits `127 agent load failed`. Use
   `import.meta.url` (see `examples/supervision-tree.ts`'s `SELF`). The CLI's
   `--module` does this conversion for you — only *parent-spawns-child* hits it.
2. **Memory regions are declared per process, not inherited.** A child spawned
   without a `memory` map has no regions and its first `memory_write` traps
   `ENOENT`. `cortex spawn` declares the three standard regions for the process
   *it* creates, but you must declare them again for any child you spawn.
3. **`fork` and `restore` children re-run your module from the top.** They
   inherit *state* (memory), not the live JS call stack. To skip completed work,
   write a marker into memory **before** the `fork`/`checkpoint` — the child
   inherits it. Writing it after does nothing (the snapshot is already sealed).
   This is the documented idempotency pattern (`examples/checkpoint-agent.ts`),
   not a kernel feature.
4. **`--driver` / `--model` / `--max-tokens` only apply to `{ system }` prompt
   agents**, not to `--module` agents (which drive their own `llm_call`).

---

## 7. Write a host

An **agent** is a module the kernel runs. A **host** is a program that boots
the kernel and drives it: a test harness, a server, an orchestrator, your own
agent framework. You are the host when you call `bootKernel()` yourself
instead of going through the `cortex` CLI.

This section is the API boundary a host needs to know, and the two places
where it is genuinely different from what an agent sees.

### 7.1 You are not in the process tree

The processes a host spawns are **children of init** — `kernel.spawn()` runs
the `spawn` syscall with init as the caller. The host itself is not a process
in that kernel.

That matters for exactly one syscall: **`wait`**.

- `wait` is a **parent-child** operation. Only a process's own parent may
  wait for it.
- Its wake-up is enqueued into the **parent's** run queue.

So a host that tries `await kernel.dispatcher.invoke(asProcessId(1), 'wait',
pid, { timeoutMs })` gets a promise that **never settles**: the wake-up is
queued against init, which is parked in RUNNING and never dispatched. It is
not a timeout and not a deadlock in your code — it is the syscall being
addressed to a process that is not scheduled.

**Use `kernel.awaitExit(pid)` instead.** It is the host-facing primitive for
exactly this, and it resolves when the process reaches ZOMBIE — *before* init
reaps the entry, so the exit code is still there to read:

```ts
const kernel = await bootKernel({ /* … */ });
const pid = await kernel.spawn({ role: 'worker', agent: { module: 'file:///…' } });

const exit = await kernel.awaitExit(pid, { timeoutMs: 30_000 });
if (exit === undefined) {
  // still running — the timeout elapsed
} else {
  console.log(exit.exitCode, exit.exitReason);
}
```

Three properties it guarantees, which the hand-rolled version does not:

1. **It reports the real exit code.** A process that died without recording
   an exit comes back with `exitCode: null` — not `0`. Never default a
   missing exit code to success; that is how a crash gets reported as a
   clean run.
2. **It still answers after the entry is reaped.** init reaps a process
   whose parent is init, so the table entry is gone — but the *facts* of the
   exit outlive it, and the kernel keeps them. Asking a moment too late
   still gets the right answer.
3. **It fails loudly on a PID the kernel never knew** (`ESRCH`), instead of
   waiting forever for something that will not arrive.

The same facts reach you three ways — `awaitExit`, the
`KernelOptions.onProcessExit` hook, and the `meta.json` the CLI persists —
and they cannot disagree: all three are taken at the same moment, the ZOMBIE
transition.

**And the CLI cannot overwrite the kernel's account of it.** `meta.json` has
two writers — the kernel, through `onProcessExit`, and the CLI, which knows
things the kernel does not (the memory policies it declared, what the process
was blocked on). They write the same file, so the CLI writes it as a **merge**
(`writeProcessView`), not a replace: the kernel keeps the process's life
(identity, state, exit code and reason, budgets, capabilities) and the CLI
keeps the declaration. The one exception is the ending the **CLI** decided
itself — a run it stopped for overrunning — which it claims explicitly
(`{ ownsEnding: true }`). A host that writes its own `meta.json` should do
the same: a view of a process that is already gone is a guess, and a guess
that overwrites a fact is worse than no fact at all.

**And the exit code is known before the process is gone.** A process that is
`EXITING` already carries its exit code and reason: the outcome is recorded
when it is **decided**, not after the cleanup. So a host that polls the table
and sees `state === 'exiting'` can read the code the process will end with —
it does not have to wait for the zombie, and it never has to guess.

That matters because the gap between "the process is leaving" and "the exit
code is written" used to be a real window: the exit frame's write awaits the
disk, and a host that read the table in that window found nothing at all.
`null` is the absence of an answer — report it as unknown, never as success.
The CLI keeps that rule in one place (`src/cli/process_outcome.ts`), so
`cortex spawn`, `cortex restore` and `cortex wrap` cannot tell the operator
different stories about the same run.

### 7.2 The other host-facing surface

| What you want | What to use |
|---|---|
| wait for a process to end | `kernel.awaitExit(pid, { timeoutMs })` |
| read a process's memory regions | `kernel.memory.regionsOf(pid)` / `kernel.memory.read(pid, region, query)` |
| see the live process table | `kernel.table.list(filter)` |
| snapshot a running process | `kernel.dispatcher.invoke(pid, 'checkpoint', { tag })` |
| be told when a process is created | `KernelOptions.onProcessStart` |
| be told when a process ends | `KernelOptions.onProcessExit` |
| **watch everything, as it happens** | **`kernel.subscribe(listener)`** |
| see whether a process is *stuck* | **`kernel.openCalls()`** — the call each process is inside, and since when |
| ...and if you want the frames themselves | read its `.crec` and pair the `enter`/`exit` frames |
| follow a log that is still being written | **`new LogTail(path)`** — `read()` returns only the frames written since the last call |
| **re-run a recorded agent** | **`KernelOptions.replay`** — the model, the tools, the clock and the RNG answer from the recording |

`KernelOptions.onProcessExit` is still worth wiring — it is how you persist
your own metadata, and it fires at the same instant as `awaitExit` resolves.
But it is a *notification*, not a *join*: it tells you a process ended, it
does not wait for one.

**`kernel.openCalls()` answers "what is this process doing?" without the log.**
It returns, for every process that is inside a syscall, the syscall's name,
the call id, when the call started, and the call's arguments. That last one is
not decoration: the arguments are what say a `wait` carries its own deadline,
and a **declared wait is not a stall** — a supervisor that cannot see the
deadline will kill a planner for keeping its word.
The kernel can answer because it writes every syscall as an `enter` frame and
its partner, and it knows which pairs are still open. Reading the log and
pairing the frames yourself gives the same answer — the `since` is that
frame's own timestamp, not a second reading of the clock — but it costs
O(bytes) instead of O(processes), and the log of a long-lived agent grows for
as long as the agent runs. Use the kernel's answer when there is a kernel;
keep the log for the case where there is not.

**`LogTail` is for the case where there is no kernel — or where you want the
frames themselves.** `readRecords(path)` answers "what is in this file" by
reading the whole file, every time; a watcher that asks "what is new" that
way pays for the whole history on every poll. `new LogTail(path)` follows
the file instead: `read()` returns only the frames written since the last
call, and reports the byte offset it stopped at. Two details worth knowing:

- **A torn frame at EOF is not an error.** The writer may be interrupted
  mid-frame; the read stops before it and the next call picks it up.
- **A file that was replaced is reported, not guessed at.** The tail checks
  that the frame it read last is still there, at the same offset, with the
  same call id — so a log that was swapped for a different one is read again
  from the beginning and reported as `replaced`, instead of splicing two
  histories together.

The dashboard's activity panel is built on exactly this (see
`src/dashboard/event_store.ts`), and the difference is measured: on a real
6 MB log, re-reading cost **301 ms** per refresh, and following costs **3–4
ms**.

`kernel.subscribe(listener)` is the other shape again: it reports what the
kernel does as it does it — a process being born, a process ending with its
real exit code, and every syscall frame as it lands in the process's `.crec`
log. The listener is called synchronously, so the event arrives at the moment
it happens; keep it quick and hand slow work to a queue of your own. It
returns an unsubscribe function, and a listener that throws is ignored — a
broken watcher cannot take the kernel down.

```typescript
const stop = kernel.subscribe((event) => {
  if (event.kind === 'process-exit') {
    console.log(`pid ${event.pid} ended with ${String(event.exitCode)}`);
  }
});
```

One thing to know about the `record` events: they are the frames **as they
are on disk**, with the same `byteOffset` — so a live watcher and
`cortex trace` can never tell different stories about the same log. That is
also why the hook lives on the recorder rather than on the dispatcher: seven
modules write records directly, and the recorder is the only place all of
them pass through.

**A host can supervise with this.** `cortex supervise` is the CLI's version,
and it is worth reading as an example: it decides that a process is stuck by
pairing the `enter` and `exit` frames of each call (same `callId`) and
measuring the gap — *not* by treating silence as a stall, which would kill
every agent waiting on a message or in the middle of a long LLM call. The
same shape works in a host:

```typescript
const open = new Map<string, { syscall: string; since: number }>();
kernel.subscribe((event) => {
  if (event.kind !== 'record') return;
  const r = event.record;
  if (r.phase === 'enter') open.set(r.callId, { syscall: r.syscall, since: Date.now() });
  else open.delete(r.callId);
  // …decide what to do about an open call that is too old
});
```

One trap worth naming: the stream only carries what happens **after** you
subscribe. If the process is already stuck when you start watching, its
`enter` frame is in the past — read the process's `.crec` once at startup
to find out what it is already inside. (`cortex supervise` does.)

**And to see whether a process is *stuck*.** The process table cannot tell
you: a listener parked on a channel and an agent that will never be answered
are both `blocked`, and a process in a long model call is not even blocked —
the kernel does not park a process while its driver call is in flight. The
log can tell you. Every syscall is an `enter` frame and an `exit`/`trap`
frame **with the same `callId`**, so a call whose `enter` never got a
partner is the call the process is sitting inside, and the `enter` frame's
timestamp is when it started.

The CLI does this in one place (`src/cli/open_call.ts`), and `cortex top`
(which shows it), `cortex ps` (which puts it in a column) and `cortex supervise`
(which acts on it) use it — so the view and the command that acts on it cannot
disagree. A host
wanting the same fact should read it the same way. Two details are worth
copying: a `sleep` is a **declared wait**, not a stall; and so is a `wait`
that carries its own deadline (`wait(pid, { timeoutMs })` ends whether or not
the child does). A `wait` with no deadline is not — that is the call that
hangs when the child hangs.

**And a host that watches a kernel it does not own must notice it leaving.**
The API above is for a host that booted the kernel, so the kernel cannot
vanish from under it. A host that talks to a kernel **over the transport** —
the way the CLI does — is in a different position: the kernel can be stopped,
or crash, and the connection ends without a word.

The client reports that (`KernelClient.closed`, `KernelClient.onClose`), and
the directory can say why: a descriptor that is gone means the kernel shut
down, a descriptor that is still there with nothing listening means it died,
and a descriptor that answers means another kernel has taken over. What a
host must *not* do is treat a dead connection as a finished watch — that is
how "the kernel died" gets reported as "the agent exited cleanly".

**And a host can replay a recorded run.** Boot the kernel with a recording
and the world is frozen: the model's answers, the tool results, the clock and
the RNG all come from the recording instead of from the world.

```typescript
import { LogRecording, ReplayRecordings } from 'cortex-agent-os';
import { bootKernel } from 'cortex-agent-os';

const source = await LogRecording.fromFile('.cortex/processes/7/log.crec');

const kernel = await bootKernel({
  kernelAbiVersion: KERNEL_ABI_VERSION,
  dir: '.cortex/replays/7',
  // The recordings are keyed by pid: a run of N processes is N recordings,
  // and each process must answer from its OWN history.
  replay: {
    recordings: ReplayRecordings.of(new Map([[7, source]])),
    mode: 'strict',          // 'strict' | 'cached' | 'live'
  },
  loadDrivers: (registry) => registry.registerLLM(mockLLM()),
  autoStart: true,
});
```

Five things worth knowing before you rely on it.

- **The recording answers even when you have no such driver.** The resolver
  returns a recording-backed placeholder when the model provider the original
  run used is not registered here — so a run recorded against one provider
  replays on a machine with none of its API keys. Registering the driver
  anyway is still right if you want `cached` mode to be able to fall through.
- **`strict` is the default and it is the honest one.** A call the recording
  does not have is an error (`ERECORD`), not a silent fall-through to the live
  world: a replay that quietly goes live looks like a faithful reproduction
  and is not one. Use `cached` when you *want* the fall-through, and say so.
- **A recording is consumed as it is served.** The Nth `llm_call` of a replay
  gets the Nth recorded `llm_call`, and the cursor never goes back. Call
  `source.reset()` (or read the file again) to replay the same recording twice.
- **A replay does not repeat a side effect.** A tool that already ran is not
  run again — the recorded result is served. A replay shows what the agent
  *would* do now, not what the world *would* answer now.
- **One recording per process, and the pid is the key.** A run of N processes
  is N recordings — a supervision tree is the normal shape of a real agent —
  so the mapping from a process to its history lives in `ReplayRecordings`,
  not in the source. A source that could be asked about any process would
  make it far too easy to answer a child with its parent's history: the
  child would be handed the parent's answer and the parent would then find
  its own recording empty. The replay would "work" and be wrong, which is the
  worst way to be wrong. If the tree is on disk, `ReplayRecordings.fromDirectory(dir, rootPid)`
  walks it for you — the shape of the run is in the logs (`spawn` names its
  child in `pid`, `fork` in `childPid`).

The CLI does all of this and adds the comparison — `cortex replay <pid>`
(`src/cli/commands/replay.ts`), with the comparison itself in
`src/cli/replay_core.ts`: the unit is a *call* (a request and its outcome
together), the comparison is positional, and the report names the path —
"the request differs at request.messages[1].content". `extractCalls()` and
`compareCalls()` are exported (`import { extractCalls, compareCalls } from
'cortex-agent-os/replay';`), so a host can do the same over its own logs.
The CLI compares **the whole tree**, process by process, and says which
process diverged.

### 7.3 What a host cannot do

- **Call syscalls as a process.** `dispatcher.invoke(pid, …)` runs the
  syscall *as that process* — its state gate, its capability gate and its
  `.crec` log apply. Invoking it as init means init is the actor: the frame
  lands in init's log, and init's capabilities are the ones checked. The
  transport's read-only commands (`ps`, `memory`) deliberately avoid the
  dispatcher for exactly this reason (ARCHITECTURE §12.1).
- **Get at a process's JS call stack.** A checkpoint captures the process
  image — state, memory, budgets, lineage — not the live stack. A restored
  agent re-runs its module from the top (PROCESS.md §8.2).

---

## 8. Add a syscall

A syscall touches five places. Do them together:

1. **`src/kernel/types.ts`** — the argument and return types (the ABI shape).
2. **`docs/ABI.md`** — the normative description. Same commit.
3. **`src/kernel/syscall_dispatcher.ts`** — add to `SyscallName`,
   `SyscallArgs`, and `SyscallReturn`, then register the handler. Let the
   dispatcher record the syscall: it already does the state gate (`ESTATE`),
   enter/exit/trap recording, reversibility enforcement, and budget accounting
   for you. Don't record inside your handler if it goes through `invoke()`.
4. **`src/kernel/boot.ts`** — expose it on the `CortexContext` proxy.
5. **`scripts/smoke.ts`** — a check that exercises the happy path *and* the
   trap path.

If it changes the state model (a new process state, a new transition), update
`docs/PROCESS.md` / `docs/STATE.md` too.

---

## 9. Tests

The harness is tiny and lives at the top of `scripts/smoke.ts`:

```ts
check('sync assertion', () => { assert(cond, 'message'); });
await checkAsync('async assertion', async () => { /* await ... */ });
```

Add a check for every behavior change — especially for a bug fix (a regression
test is the only proof the bug is gone). Tests import kernel modules **directly**
(no subprocess); for CLI commands, capture `console.log` and assert on the
output (see the `cortex diff` / `cortex attach` / `cortex daemon` checks).

---

## 10. Submitting

- One logical change per commit; reference the issue: `kernel: implement X (#0NN)`.
- Never skip hooks (`--no-verify`).
- If you touched the ABI or the state model, the doc change is part of the
  commit, not a follow-up.
- New to the codebase? Open an issue titled `[hello]` and say what you care
  about — see [README.md § Contributing](../README.md#contributing).
