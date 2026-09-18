# Hacking on cortex

cortex is a small kernel. That is the point: the whole thing is meant to be
legible enough that a stranger can read `src/kernel/` in an afternoon and
predict what it does. This guide is how to change it without breaking the
contracts it is built on.

Read in this order if you are new: **[MANIFESTO.md](../MANIFESTO.md)** (why),
**[ARCHITECTURE.md](./ARCHITECTURE.md)** (the ten kernel modules + the driver
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

- **No runtime dependencies.** Only `cborg`. Adding a dependency needs a very
  good reason.

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

## 7. Add a syscall

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

## 8. Tests

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

## 9. Submitting

- One logical change per commit; reference the issue: `kernel: implement X (#0NN)`.
- Never skip hooks (`--no-verify`).
- If you touched the ABI or the state model, the doc change is part of the
  commit, not a follow-up.
- New to the codebase? Open an issue titled `[hello]` and say what you care
  about — see [README.md § Contributing](../README.md#contributing).
