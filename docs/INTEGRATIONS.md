# Embedding Cortex

Cortex can be embedded in a Node.js application or used as a read-only observer for an existing agent. Integrations do not require adding a framework dependency to Cortex.

## LangChain callbacks

`CortexLangChainCallbackHandler` implements LangChain's callback handler methods without importing LangChain. It records chain, model, tool, retriever, and agent lifecycle events. Prompts, model outputs, tool inputs, and retrieved documents are deliberately omitted.

### Two sinks

| `sink` | Writes | Read by |
|---|---|---|
| `crec` *(default when `pid` is set)* | `.cortex/processes/<pid>/log.crec` **and** `.cortex/integrations/langchain/events.jsonl` | `cortex trace`, `cortex audit`, `cortex ps`, the dashboard |
| `jsonl` *(default without `pid`)* | `.cortex/integrations/langchain/events.jsonl` | the integration's own consumers only |

The `crec` sink is the point of this adapter: it makes an agent that cortex did *not* spawn readable by the same tools as one it did. Events become real `SyscallRecord` frames — `llm.start`/`llm.end` pair as `langchain`, `tool.start`/`tool.end` pair as `tool_call` tagged `irreversible`, and errors become a `trap` frame — so `cortex trace <pid>` shows a LangGraph run sitting next to kernel-spawned agents:

```
$ cortex trace 9001
# tracing .cortex/processes/9001/log.crec
time                  pid    syscall           phase   duration  reversibility
-------------------------------------------------------------------------------------
04:29:42.948  9001   langchain        enter   -         idempotent
04:29:42.960  9001   langchain        exit    12ms      idempotent
04:29:42.962  9001   tool_call        enter   -         irreversible
04:29:42.964  9001   tool_call        exit    2ms       irreversible
# 4 record(s)
```

Both sinks are written when `crec` is active: the jsonl file is the integration's own audit trail and survives a `.cortex` reset, so removing it would be a silent regression for anyone already parsing it.

```ts
import { CortexLangChainCallbackHandler } from 'cortex-agent-os/integrations/langchain';

const cortexCallbacks = new CortexLangChainCallbackHandler({
  dir: '.cortex',
  pid: 42,                        // required for the crec sink
  onEvent: (event) => console.info(event.type, event.durationMs ?? ''),
});

const result = await chain.invoke(input, {
  callbacks: [cortexCallbacks],
  metadata: { cortexPid: 42 },     // per-run override of the owning pid
});
await cortexCallbacks.close();     // flush + release the file handle
```

Without `pid` the handler falls back to `jsonl`, because a `.crec` frame belongs to a process and there is nothing to attach it to. `close()` is worth calling on shutdown; `flush()` alone leaves the descriptor open.

### What this is not

This adapter adds **observability** to an existing execution. The chain still runs in the host application's event loop: callback instrumentation does not move it into a Cortex process, does not make its state checkpointable, and does not give it a PID of its own. It borrows one (`pid` above) so its records have somewhere to live. For checkpoint / fork / supervision, the agent has to be spawned by the kernel — see `cortex spawn --module`.

## The fetch tap — any LLM client, zero code changes

The callback handler above only reaches LangChain, and only if the host wires it up by hand. LlamaIndex, the raw OpenAI SDK, the Vercel AI SDK, a hand-rolled `fetch` — none of them are reachable that way, and writing one adapter per framework means always arriving months after the framework does.

`tapFetch` goes one level lower. Every one of those clients ends up calling `fetch()`, so wrapping `globalThis.fetch` sees all of them at once and **the host project does not change at all**:

```ts
import { tapFetch, llmTapStats } from 'cortex-agent-os/integrations/llm-tap';

const uninstall = tapFetch({ dir: '.cortex', pid: 42, tokenBudget: 500_000 });

// ... the host's existing agent code runs completely unchanged ...

console.info(llmTapStats()); // { calls, inputTokens, outputTokens, cachedTokens, usd }
await uninstall();
```

That is one line, in any project, in any framework. It records an `llm_call` pair per request, so `cortex trace <pid>` shows the run and `cortex ps` shows its spend:

```
$ cortex trace 9100
time                  pid    syscall           phase   duration  reversibility
-------------------------------------------------------------------------------------
04:38:49.313  9100   llm_call         enter   -         reversible
04:38:49.313  9100   llm_call         exit    18ms      reversible
04:38:49.332  9100   llm_call         enter   -         reversible
04:38:49.332  9100   llm_call         exit    3ms       reversible
# 4 record(s)
```

What lands in the log is the shape, never the text:

```jsonc
// enter frame args
{ "via": "fetch-tap", "url": "https://api.openai.com/v1/chat/completions", "model": "gpt-4o-mini", "messages": 1 }
// exit frame result
{ "model": "gpt-4o-mini", "inputTokens": 250, "cachedTokens": 32, "outputTokens": 60, "usd": 0.0000711, "httpStatus": 200 }
```

Message *count*, not message *text*. Enough to debug a regression, impossible to leak a prompt.

### Options

| Option | Default | Effect |
|---|---|---|
| `pid` | *required* | Owning process for the records. Without it there is nothing to attribute calls to. |
| `dir` | `.cortex` | Cortex state directory. |
| `tokenBudget` | — | Token ceiling. Crossing it is visible in the record as `budget: "exceeded"`. |
| `usdBudget` | — | Same, in dollars. First one crossed wins. |
| `onBudget` | `'record'` | `'record'` logs the overrun; `'throw'` aborts the call *after* recording it, so the spend stays auditable. |
| `match` | `isLLMUrl` | Narrow to one provider: `match: (url) => url.includes('openai.com')`. |
| `onCall` | — | Called per request with the usage, for a host that wants its own meter. |

`isLLMUrl` matches OpenAI-compatible `/v1/{chat/completions,completions,embeddings,responses}`, Ollama's `/api/chat`, and Anthropic's `/v1/messages`. It is deliberately narrow: a wider net would eventually count a metrics endpoint, and a wrong token count in `cortex ps` is worse than a missing one because it silently corrupts a budget the user set. A provider with an unrecognised shape is **not counted rather than counted wrongly**.

Only one tap is installed at a time. A second `tapFetch` call returns the first one's uninstaller instead of stacking a second wrapper — two wrappers would double-count every request, which surfaces as "why is my budget wrong" and costs an afternoon.

### What the tap cannot do

Stated plainly, because these are structural and not fixable with effort:

- **The tap is an observer, not a syscall.** The request never passes through the kernel's `llm_call` route, so it is not capability-checked, and the record is an observer entry attributed to `pid` rather than a frame in that process's own causal log at the point the call happened.
- **No state capture.** `checkpoint` / `fork` / `restore` stay unavailable, because the agent's state lives in the host's JavaScript heap rather than a kernel-owned image. Same limit as the callback adapter, same reason.
- **The host keeps running.** `cortex kill` on a tapped pid marks the entry a zombie; it cannot stop the host's event loop, because the host is not a kernel-spawned process. To get real supervision, spawn the agent with `cortex spawn --module`.

The tap is a meter, not a proxy. It never rewrites a request, injects a prompt, or silently retries — anything that changes what the model sees belongs in a driver, where it is auditable.

## `cortex wrap` — supervision without a rewrite

The two integrations above make an existing agent **observable**. Neither makes it **supervisable**, because supervision needs a kernel-owned process and a callback cannot conjure one.

`cortex wrap` closes that gap the only honest way: it runs somebody else's command as a child of a kernel process. The project is not modified, not reimplemented, and not asked to speak cortex. It gets a PID, a parent, a state, a budget, a signal disposition and a restart policy.

```bash
cortex wrap --role demo -- echo hello
cortex wrap --role research --restart on-failure -- python research.py
cortex wrap --role api --cwd ./service -- node dist/server.js
cortex wrap --role agent --tap -- npx tsx my-agent.ts
```

Afterwards the run is an ordinary cortex process:

```
$ cortex ps
PID     PPID    ROLE          STATE         TOKENS    AGE
---------------------------------------------------------
1       -       init          running       0         0ms
2       1       demo          zombie        0         5s

$ cortex trace 2
time                  pid    syscall           phase   duration  reversibility
-------------------------------------------------------------------------------------
09:12:05.117  2      __state          exit    -         idempotent
09:12:05.132  2      __state          exit    -         idempotent
09:12:05.151  2      on_signal        exit    -         reversible
09:12:05.314  2      memory_write     enter   -         reversible
09:12:05.315  2      memory_write     exit    1ms       reversible
09:12:05.315  2      exit             enter   -         irreversible
```

| What you get | How |
|---|---|
| Killable | `cortex kill <pid>` — the signal reaches the child, escalated to `SIGKILL` after `--kill-grace-ms` |
| Auditable | `cortex trace <pid>` — the wrapper's syscall log, including the signal handlers it registered |
| Budgeted | `--token-budget` for kernel-routed calls; `--tap-token-budget` for the child's own LLM calls, metered by the tap and folded back into the reported spend |
| Restartable | `--restart on-failure \| always`, with `--max-restarts` and the kernel's restart-storm detection |
| Visible | `cortex ps`, `cortex top`, the dashboard — same as a spawned agent |

**Exit codes are propagated.** `cortex wrap … -- pytest` returns pytest's exit code, and a missing command returns `127` with `command not found` on stderr. A supervisor that reported success for a failed run would be worse than useless in CI.

**A run cortex kills exits non-zero.** When `--timeout` expires, `cortex wrap` stops the child and returns `137` — the shell's own `128 + SIGKILL` convention. It is deliberately distinct from any code the child could return on its own, so a log tells "we killed it" from "it failed". This was a bug: the timeout path had a null exit code and fell through to `0`, which made `cortex wrap --timeout 60 -- pytest` go green on a hung suite.

**Timed-out runs are stopped, not abandoned.** When `--timeout` expires, cortex escalates `SIGTERM` → `SIGKILL` and waits for the child to actually die. A test asserts the child stops writing after the CLI exits, because a supervisor that leaks its child is not a supervisor.

### `--tap`: the one line your project has to add

`--tap` makes the child's LLM calls countable. It works by having the wrapper write four environment variables — `CORTEX_TAP_DIR`, `CORTEX_TAP_PID`, and optionally `CORTEX_TAP_TOKEN_BUDGET` / `CORTEX_TAP_BUDGET_ACTION` — and the child reading them.

**An environment variable cannot make a process import anything.** There is no way for the parent to reach into a child that has never heard of cortex. So the child has to ask, once, near the top of its entry point:

```ts
import { installTapFromEnv } from 'cortex-agent-os/integrations/llm-tap';

await installTapFromEnv();
```

It returns an uninstaller, or `undefined` when no tap was requested — so the same line is safe in production, where nobody is watching. **Call the uninstaller on shutdown** (or just let the process exit) so buffered frames reach the `.crec`.

`cortex wrap --tap` prints this reminder on every run, precisely because a flag that silently records nothing is worse than no flag.

Why an env var at all, if the child has to cooperate anyway? Because it moves both hardcoded values to the parent. The child stops hardcoding a directory and a pid; the parent stops hardcoding where the child lives. The child only asks "am I being tapped?", and the answer is whatever the host decided.

The child's pid is not known until `spawn` allocates it, so the wrapper substitutes it at launch time — the parent writes the literal `@PID@` and the wrapper, the only party that knows the answer, replaces it.

Two flags tune the ceiling from the outside:

```bash
cortex wrap --role agent --tap --tap-token-budget 500000 -- npx tsx my-agent.ts
cortex wrap --role agent --tap --tap-token-budget 500000 --tap-abort-on-budget -- npx tsx my-agent.ts
```

By default the tap **records** an overrun and lets the request finish — an audit trail beats a surprise crash. `--tap-abort-on-budget` makes the call throw instead, as if the driver returned `EDRIVER`. The spend is still written either way, so an aborted run is still auditable.

`CORTEX_TAP_REQUIRED` changes the failure mode on the child's side. Without it, a malformed budget is ignored, because a typo in someone's `.env` should not take down a production run. With it — and `cortex wrap --tap` always sets it — a configuration the host cannot honour is an **error**, not a shrug. Returning a run that looks supervised and is not is the one outcome this project will not ship.

### The money has to come back out of the log

A tapped child's LLM calls never pass through the kernel's syscall dispatcher, so the kernel's own `budgetsSpent` counters read **zero** for a run that spent real tokens. The tap appends `llm_call` frames to the same `.crec`, and if nothing reads them back the numbers are simply gone: the summary line prints `tokens: 0` and `meta.json` persists zeros, so `cortex ps`, the dashboard and `cortex audit` all report a spending run as free.

`readTapSpend(dir, pid)` is the other half of the tap — it sums those frames back out:

```ts
const spend = await readTapSpend('.cortex', 42);
// { calls, inputTokens, outputTokens, cachedTokens, usd, failedCalls }
```

`cortex wrap` calls it after every run and folds the result into `budgetsSpent`, so the terminal summary, `meta.json` and `cortex trace` cannot disagree:

```
process exited (code 0: node exited 0)
tokens: 240 (in 200, out 40)
tap: 2 llm calls ($0.000053)
```

Three details worth knowing:

- **`enter` frames are excluded.** They carry no usage, and a naive "sum every `llm_call` frame" counts every call twice.
- **A failed call is counted separately, and still billed.** A request the provider answered with a 500 cost money. `failedCalls` keeps it visible without pretending it succeeded.
- **A killed run keeps its spend.** The frames are on disk by the time the child is stopped, so a run that hung and was killed still reports what it cost before it died — which is the question you actually have at that moment.

This is also why `llmTapStats()` and `readTapSpend()` are not redundant: the first answers "how much has this process spent" from *inside* the tapped process, the second answers "how much did that process spend" from *outside*, after it exited. Only the second vantage point exists for a supervisor, a dashboard or `cortex ps`.

### What checkpoint means here

A snapshot captures the *wrapper's* state, not the child's. The child is a separate OS process with its own heap; no snapshot can reach into it. So **`restore` on a wrapped run re-runs the command from the start** rather than resuming it mid-flight.

This is not a gap we papered over — it is *why* the natural checkpoint boundary for a wrapped project is "the run ended", the one boundary that is actually true. The run's outcome is written to the `episodic` region under `wrap:result` (command, exit code, whether it was cancelled), so a later restore knows what it is replacing.

For real mid-run checkpointing and `fork`, the agent has to be spawned by the kernel: `cortex spawn --module`. More work, more power.

### Relation to `cortex daemon`

`wrap` supervises a **run**. `cortex daemon install` supervises a **long-lived process that should come back after a reboot** — same restart machinery, but with a persisted `DaemonSpec` and an OS service unit. Use `wrap` for a batch job or a one-off script; use `daemon` for a service.

### Platform note

On POSIX, cancelling a wrapped process signals the whole process group, so a shell that spawned grandchildren of its own takes them along. On Windows there is no graceful equivalent — `taskkill /T /F` terminates the tree without giving the child a `SIGTERM` handler a chance to run, so a Windows-wrapped program cannot flush on cancel. It is stopped, and it is stopped reliably; it just cannot be asked nicely.

## Embedded dashboard

```ts
import { startDashboard } from 'cortex-agent-os/dashboard';

const dashboard = await startDashboard({
  dir: '.cortex',
  port: 4173,
  // Pass a live kernel snapshot when Cortex runs in this application.
  processes: () => kernel.table.list(),
});
console.info(`Cortex console: ${dashboard.url}`);

// On application shutdown:
await dashboard.close();
```

The dashboard is read-only, refreshes automatically, and binds to `127.0.0.1` by default. It shows live processes when given a `processes` callback, persisted process metadata otherwise, a supervision tree built from `ppid` links, a per-role budget rollup, checkpoint snapshots, recent LangChain callback events, and a redacted syscall timeline.

Updates are pushed over Server-Sent Events at `GET /api/stream` (file-watch based, 15s heartbeat); the UI falls back to polling automatically when SSE is unavailable.

The event table includes model name and token usage from completed LLM calls, plus sanitized, length-limited syscall error summaries. Prompts, model responses, and ordinary syscall arguments/results are not returned by these views. For MCP tools, use `CORTEX_MCP_DEFAULT_REVERSIBILITY` to set the conservative default (`irreversible`, `reversible`, or `idempotent`) and `CORTEX_MCP_REVERSIBILITY` to provide per-tool JSON overrides, for example `{"search":"idempotent","create_order":"irreversible"}`. Declaring a default is explicit metadata; without it, unannotated tools remain visible to `cortex audit`.

The API is available at:

- `GET /api/processes` — process table (live or persisted).
- `GET /api/trace/:pid` — redacted syscall timeline.
- `GET /api/events?from=&to=&offset=&limit=` — merged callback + syscall events, newest first. `from`/`to` are millisecond timestamps; results are paginated and the total count is returned in the `x-total-count` header.
- `GET /api/checkpoints` — checkpoints under `processes/<pid>/checkpoints/`, parsed from file names (`createdAt`/`chainId`) plus on-disk size.
- `GET /api/ops` — reports which write operations are enabled: `{ allowOps: boolean, ops: string[] }`.

By default every write operation is rejected. Opt in from the CLI with `--allow-ops` (enable everything) or `--ops spawn,kill,restore` (enable exactly the listed ops), or pass `startDashboard({ allowOps: true | ['spawn', 'kill'] })` when embedding. Enabled ops are served as `POST /api/ops/<op>` and run the matching CLI command in-process against the dashboard's own state directory, so all CLI validation still applies:

- `POST /api/ops/spawn` with `{ "role": "...", "module"?, "task"?, "driver"?, "timeoutMs"? }` — starts a new agent (waits until it finishes, self-checkpoints, or times out).
- `POST /api/ops/kill` with `{ "pid": 7, "signal"? }` — marks the process as zombie in its on-disk meta, exactly like `cortex kill`.
- `POST /api/ops/restore` with `{ "chain": "<chainId>" }` — restores a checkpointed process, exactly like `cortex restore`.

The standalone CLI accepts `--dir` to select the state directory. Use `--host` only when you intentionally want to expose the dashboard beyond the local machine, and prefer `--ops` with the narrowest list over `--allow-ops`.
