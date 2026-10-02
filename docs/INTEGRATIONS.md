# Embedding Cortex

Cortex can be embedded in a Node.js application or used as a read-only observer for an existing agent. Integrations do not require adding a framework dependency to Cortex.

## LangChain callbacks

`CortexLangChainCallbackHandler` implements LangChain's callback handler methods without importing LangChain. It records chain, model, tool, retriever, and agent lifecycle events to `.cortex/integrations/langchain/events.jsonl`. Prompts, model outputs, tool inputs, and retrieved documents are deliberately omitted.

```ts
import { CortexLangChainCallbackHandler } from 'cortex-agent-os/integrations/langchain';

const cortexCallbacks = new CortexLangChainCallbackHandler({
  dir: '.cortex',
  onEvent: (event) => console.info(event.type, event.durationMs ?? ''),
});

const result = await chain.invoke(input, {
  callbacks: [cortexCallbacks],
  metadata: { cortexPid: 42 }, // optional: associate events with a Cortex PID
});
await cortexCallbacks.flush();
```

This adapter adds observability to an existing LangChain execution. The chain still runs in the host application's execution loop; callback instrumentation alone does not move its execution into a Cortex process or make its state checkpointable.

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
