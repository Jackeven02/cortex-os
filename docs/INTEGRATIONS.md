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
