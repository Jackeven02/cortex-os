# Cookbook

Patterns for writing agents on cortex. Every recipe is a real, runnable
snippet; the full versions live in [`examples/`](../examples/). If you are new
to the kernel, read [`HACKING.md`](./HACKING.md) §6 first for the four gotchas
that explain most surprises.

All examples run offline against the `mock` LLM driver:

```bash
unset OPENAI_API_KEY DEEPSEEK_API_KEY   # force the deterministic mock
```

---

## 1. Supervision tree — spawn, bound, kill, respawn

**When:** a planner/manager owns worker processes and must survive one of them
hanging. This is Erlang's "let it crash", written as ordinary `async`/`await`.

```ts
export default async function planner(ctx: CortexContext): Promise<void> {
  const { pid } = await ctx.spawn({
    role: 'coder:billing',
    agent: { module: import.meta.url, args: { kind: 'coder' } }, // absolute!
    memory: { semantic: { kind: 'shared', backing: 'inmem' } }, // re-declare for children
  });

  try {
    const res = await ctx.wait(pid, { timeoutMs: 8000 }); // bound the child
    console.log(`billing ok(${res.exitCode})`);
  } catch {
    // ETIMEDOUT: the child is still running. A timeout is an observation,
    // not a punishment — killing it is a separate decision, made here.
    await ctx.kill(pid, 'SIGKILL');
    const { pid: replacement } = await ctx.spawn({ /* same role, fresh args */ });
    await ctx.wait(replacement);
  }

  ctx.exit(0, 'planner complete');
}
```

- `wait(pid, { timeoutMs })` traps **`ETIMEDOUT`** on a deadline and leaves the
  child **running** — the kill is yours to make. `timeoutMs: 0` polls without
  parking; omit it to wait forever (POSIX default).
- While the planner is parked in `wait()`, the scheduler runs its children
  (cooperative continuation — see `PROCESS.md` §8.2).
- Run it: `cortex spawn --role planner --module ./examples/supervision-tree.ts`.
- Full version (three coders, one hangs, README assembled from shared memory):
  [`examples/supervision-tree.ts`](../examples/supervision-tree.ts).

> **Gotcha.** A parent spawning a child must pass an **absolute** module path
> (`import.meta.url`). A bare relative path resolves against the kernel, not your
> file, and the child exits `127 agent load failed`.

---

## 2. Pause across reboots — checkpoint, detach, restore

**When:** a long-running agent must survive a machine restart with no work lost.

```ts
export default async function watcher(ctx: CortexContext): Promise<void> {
  // Memory is the only thing that survives the reboot, so it — not a local
  // variable — is the source of truth for "what have I already done".
  const doneRaw = await ctx.memory_read('episodic', { key: 'done' });
  const done: string[] = doneRaw.length > 0 ? (doneRaw[0]!.value as string[]) : [];
  const doneSet = new Set(done);

  const pausedRaw = await ctx.memory_read('episodic', { key: 'paused' });
  const alreadyPaused = pausedRaw.length > 0 && Boolean(pausedRaw[0]!.value);

  for (const item of QUEUE) {
    if (doneSet.has(item.id)) continue;          // skip completed work
    await doWork(ctx, item);
    done.push(item.id);
    await ctx.memory_write('episodic', 'done', done);   // durable progress

    if (!alreadyPaused && done.length >= 3) {
      await ctx.memory_write('episodic', 'paused', true); // guard: pause once
      await ctx.checkpoint({ tag: 'watcher', detach: true }); // snapshot + SUSPEND
      return;
    }
  }
  ctx.exit(0, 'queue drained');
}
```

```bash
cortex spawn --role watcher --module ./examples/checkpoint-agent.ts   # run 1
# ... the machine reboots; the .csnap is on disk ...
cortex restore --tag watcher                                          # run 2
```

- `checkpoint({ detach: true })` writes a `.csnap` and moves the process to
  **SUSPENDED**. `detach: false` (the default) returns it to READY.
- `restore` mints a **new PID** with the same chain id, re-hydrates memory, and
  re-runs the module **from the top**.
- **The honest limitation:** a checkpoint captures the *process image* (state,
  memory, budgets, lineage), **not the live JS call stack**. Idempotency across
  the restart is the agent's job — hence the `done`/`paused` memory markers.
- Full version: [`examples/checkpoint-agent.ts`](../examples/checkpoint-agent.ts).

---

## 3. Fork and compare — explore branches in parallel

**When:** a decision point with several plausible paths; you want to try them
all and keep the winner (the atom of *agent search*).

```ts
export default async function coder(ctx: CortexContext): Promise<void> {
  const prior = await ctx.memory_read('episodic', { key: 'forked' });
  const alreadyForked = prior.length > 0 && prior[0]!.value === true;

  if (!alreadyForked) {
    // Write the marker BEFORE the fork: the child inherits this snapshot,
    // so it knows it is the child. Writing it after would be too late.
    await ctx.memory_write('episodic', 'forked', true);
    const { childPid } = await ctx.fork({ tag: 'strategy' });
    console.log(`parent forked as ${childPid}; branch A: bloom filter`);
    await ctx.memory_write('semantic', 'proposal:A', { approach: 'bloom filter' });
    ctx.exit(0, 'branch A complete');
  }

  console.log(`branch B (pid ${ctx.pid}) resumed from the snapshot`);
  await ctx.memory_write('semantic', 'proposal:B', { approach: 'lru hash set' });
  ctx.exit(0, 'branch B complete');
}
```

```bash
cortex spawn --role demo --module ./examples/fork-compare-agent.ts
cortex diff 2 3   # lines up the two branches from their shared causal past
```

- A forked child inherits the parent's **state** and **re-runs the module from
  the top**; it does not resume at the fork point. Distinguish parent from child
  with a memory marker written **before** `fork`.
- `cortex diff` reads the fork's `sharedCausalPast` byte offset out of the
  parent's `.crec`, cuts the log there, and aligns only the two tails. (Branch
  tails can re-converge, which is why it uses an LCS, not a positional compare.)
- Full version: [`examples/fork-compare-agent.ts`](../examples/fork-compare-agent.ts).

---

## 4. A long-running daemon that starts on boot

**When:** an agent should stay up independently of any CLI invocation.

```bash
# Register the spec + generate an OS service unit (restart on failure, 5 max).
cortex daemon install watcher \
    --role inbox-watcher \
    --module ./examples/checkpoint-agent.ts \
    --restart on-failure --max-restarts 5

cortex daemon list           # show the registry
cortex daemon run watcher    # run it as a supervised, long-lived process
cortex daemon uninstall watcher
```

- `install` writes `.cortex/daemons.json` and generates a unit under
  `<CORTEX_HOME>/units/` (systemd `.service` on linux, launchd `.plist` on
  darwin; Windows prints an `schtasks` command). It does **not** enable it for
  you — it prints the exact `systemctl --user enable --now` / `launchctl load`
  command, because enabling needs your session or root.
- `run` boots a kernel, registers the daemon, and supervises restarts per the
  `RestartPolicy` (`always` / `on-failure` / `never`, exponential backoff capped
  at 60s, `maxRestarts` cap, restart-storm detection). It stays alive until
  SIGTERM/SIGINT (or `--max-runtime-ms n` for headless use).
- Follow its syscall stream while it runs: `cortex attach <pid>`.

---

## 5. Budgets and limits

**When:** you want to bound what an agent can spend (tokens, USD, wall time).

```ts
const before = ctx.budget();          // synchronous snapshot of spent/remaining
await ctx.llm_call({ messages });
const after = ctx.budget();
console.log(`spent ${after.tokensIn + after.tokensOut} tokens`);
```

```bash
cortex spawn --role coder --task "..." --token-budget 20000
cortex limit 1234 --tokens 10000 --usd 0.50 --wall-time 60000
cortex limit 1234                      # show current limits
cortex spawn --role hoarder --task "..." --max-region-entries 500  # global cap: every region stops at 500 writes (ENOMEM beyond it; omit = unlimited)
cortex spawn --role hoarder --task "..." --max-region-entries 500 \
  --memory '{"episodic":{"kind":"cow","backing":"inmem","maxEntries":50},"semantic":{"kind":"shared","backing":"inmem","maxEntries":-1}}'
  # per-region overrides win over the global 500: episodic caps at 50,
  # semantic opts out to unlimited (-1)
```

A region's own `maxEntries` (in `--memory`) takes precedence over the global
`--max-region-entries`: `absent` inherits it, `-1` is unlimited, `0+` is a hard
cap. `--memory` is a JSON object keyed by region name, merged over the standard
`episodic`/`semantic`/`procedural` defaults — you only spell out what you change.

Exceeding a budget raises `SIGXCPU` (see `PROCESS.md` §6). `ctx.budget()` is a
**synchronous** syscall — it does not write a `.crec` record (a known v0 gap).

---

## 6. Tools, and the forkable gate

**When:** the agent needs to act on the world — a file, an MCP server, an API.

```ts
// Plain tool call.
const r = await ctx.tool_call('fs_read', { path: 'package.json' });
if (r.error === null) console.log(r.output);

// Two-phase tool (stage before a fork, commit after) — post-v0 pattern.
const staged = await ctx.tool_call('payments/charge', { amount: 10 }, { stageOnly: true });

// Anything that must be safe to fork goes through forkable().
await ctx.forkable(async () => {
  await ctx.tool_call('fs_write', { path: 'out.txt', content: 'hi' });
});
```

- Every tool carries a declared `reversibility` (`reversible` / `idempotent` /
  `irreversible`). An **untagged** tool defaults to `irreversible` and therefore
  **refuses to run inside `forkable()`** (`EREVERSIBLE`) — the safe default.
- `cortex audit` lists every tool and flags the ones whose tag was *inferred*
  rather than declared.
- Mount an MCP server as a tool namespace (opt-in):

  ```bash
  export CORTEX_MCP_COMMAND=npx
  export CORTEX_MCP_ARGS="-y @modelcontextprotocol/server-filesystem ."
  cortex spawn --role agent --module ./examples/mcp-agent.ts
  ```

  MCP tools appear as `mcp/<name>`; see [`examples/mcp-agent.ts`](../examples/mcp-agent.ts).

---

## 7. Talking between processes — IPC

**When:** two processes need to exchange a message rather than fork.

```ts
// Sender
await ctx.send(targetPid, { kind: 'result', value: 42 });

// Receiver — blocking by default; bound it if you must not park forever.
const msg = await ctx.recv(undefined, { timeoutMs: 5000 });
console.log(msg.from, msg.body);
```

```bash
cortex send 1234 "try the dynamic-programming approach"   # from the shell
```

A message is `{ from, to, body, sentAt }`. `recv` blocks by default; a
`timeoutMs` returns control without a message. See `ABI.md` §4.5.

---

## 8. Time and determinism

**When:** you need a clock, jitter, or a delay — and you want replay to be
deterministic.

```ts
await ctx.sleep(300);                     // RUNNING -> BLOCKED -> READY
const t = ctx.now();                      // injectable clock, NOT Date.now()
const jitter = ctx.random();              // injectable RNG, NOT Math.random()
```

Use `ctx.now()` / `ctx.random()` instead of `Date.now()` / `Math.random()` so
the kernel's injected clock and seed govern your agent too. (In v0 these
synchronous syscalls are **not** written to `.crec`; determinism comes from the
injected sources — see `BACKLOG.md` known gaps.)

---

## 9. Testing an agent

Run it against the mock driver and assert on its output — no network, no flake.

```bash
unset OPENAI_API_KEY DEEPSEEK_API_KEY
cortex spawn --role test --module ./my-agent.ts   # stdout is your assertion target
```

For a check inside the regression suite, exercise kernel modules directly
(`scripts/smoke.ts` `check` / `checkAsync`), or capture the CLI command's
`console.log` the way the `cortex diff` / `cortex attach` / `cortex daemon`
checks do. A bug fix without a regression check is not done — see
[`HACKING.md`](./HACKING.md) §8.
