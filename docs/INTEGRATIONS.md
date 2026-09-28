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

The dashboard is read-only, refreshes automatically, and binds to `127.0.0.1` by default. It shows live processes when given a `processes` callback, persisted process metadata otherwise, recent LangChain callback events, and a redacted syscall timeline. The API is available at `GET /api/processes`, `GET /api/events`, and `GET /api/trace/:pid`.

For a standalone local console, run `cortex dashboard` from a project using Cortex, or pass `--dir` to select the state directory. Use `--host` only when you intentionally want to expose the dashboard beyond the local machine.
