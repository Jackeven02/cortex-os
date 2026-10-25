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

Both sinks carry the same **reversibility** tag for the same call, so a reader that merges them — the dashboard's event table does — cannot be told two different things about one action. The tag is decided once, where the event is born: a tool call is `irreversible` (a callback knows only that a tool ran, and the friendlier guess is the one tag nobody can act on), a retrieval is `reversible` (it is a read), and everything else is `idempotent`. The jsonl line carries it as `reversibility`; the `.crec` frame carries it in the field the ABI defines (ABI.md §4.1).

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
PID  PPID  ROLE  STATE    TOKENS  CAPS  AGE    NOTE
---------------------------------------------------
1    -     init  running  0       -     0ms
2    1     demo  zombie   0       all   326ms  exit 0 (completed)

$ cortex trace 2
time          pid     syscall                              phase  duration   reversibility
------------------------------------------------------------------------------------------
09:12:05.117  2       __state:new->ready                   exit   -          idempotent
09:12:05.132  2       __state:ready->running               exit   -          idempotent
09:12:05.151  2       on_signal                            exit   -          reversible
09:12:05.314  2       memory_write                         enter  -          reversible
09:12:05.315  2       memory_write                         exit   1ms        reversible
09:12:05.315  2       exit                                 enter  -          irreversible
```

| What you get | How |
|---|---|
| Killable | `cortex kill <pid>` — the signal reaches the child, escalated to `SIGKILL` after `--kill-grace-ms` |
| Auditable | `cortex trace <pid>` — the wrapper's syscall log, including the signal handlers it registered |
| Budgeted | `--token-budget` for kernel-routed calls; `--tap-token-budget` for the child's own LLM calls, metered by the tap and folded back into the reported spend |
| Restartable | `--restart on-failure \| always`, with `--max-restarts` and the kernel's restart-storm detection |
| Visible | `cortex ps`, `cortex top`, the dashboard — same as a spawned agent |

**`--restart` re-runs the command through init, not through a second code path.** The policy needs the supervisor, and the supervisor is `InitProcess` — exponential backoff, the sliding-window storm check and the `maxRestarts` cap all live there.

`--max-restarts N` is a cap on **runs**, which is not what the name suggests: init gives up when `restartCount >= N`, and `restartCount` advances the moment a restart is decided. So `--max-restarts 2` runs the command twice — one initial run plus one retry. Renaming the field or changing the arithmetic would break the frozen 1.0 ABI, so the behaviour stands and is written down here instead. The first restart waits `backoffMs` (1s by default), doubling each time, so a policy with room for several retries takes correspondingly longer to exhaust.

Each attempt is a **separate process with its own pid, directory and `.crec`**. Two consequences worth knowing:

- The summary line reports the **final** attempt. A retry that spent money is not free — the earlier attempt's spend is still on record under its own pid, and `cortex trace <pid>` shows that attempt's calls.
- `cortex ps` persists the last attempt's pid, so it points at the numbers that actually describe how the run ended.

**Exit codes are propagated.** `cortex wrap … -- pytest` returns pytest's exit code, and a missing command returns `127` with `command not found` on stderr. A supervisor that reported success for a failed run would be worse than useless in CI.

**And an exit code the wrapper has not seen yet is never reported as success.** This was a bug, and it was the same kind of bug as the timeout one below. A process that is **exiting** has not finished: the kernel records its exit code *after* it gets there — two disk writes sit between the two — so there is a real window in which the process table says "dying" and the code is still `null`. The wrapper used to read that window as "no code" and default it to `0`, which turned `cortex wrap -- <command that failed with 127>` into a **successful** run. The full smoke suite caught it twice in a row under load, and the fix has two halves: the wrapper now **waits** for an ending it can trust (the zombie, which carries the code, or the reap, which leaves the exit record on disk), and the report itself never invents a zero for a code it did not see — a missing code is reported as unknown, not as success.

**A run cortex kills exits non-zero.** When `--timeout` expires, `cortex wrap` stops the child and returns `137` — the shell's own `128 + SIGKILL` convention. It is deliberately distinct from any code the child could return on its own, so a log tells "we killed it" from "it failed". This was a bug: the timeout path had a null exit code and fell through to `0`, which made `cortex wrap --timeout 60 -- pytest` go green on a hung suite.

**And the record says so too.** The run's exit record — what `cortex ps` and `cortex top` read afterwards — carries the same account: `exitCode: 137`, `exitReason: "timed out after 1216ms"`, `state: "zombie"`. It used to say `"running"` with no code, because the CLI wrote its snapshot of the run *before* it killed it and then wrote that snapshot over the kernel's exit record. And when the two writers were separated by ownership (docs/ARCHITECTURE.md §7), the kernel's account of the wrapper process came through instead — "exited 1 (cancelled)", which reads like a command that failed on its own. The ending belongs to whoever decided it, and here the CLI decided it: we killed the run, and the record says that.

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

**And the units are converted on the way in.** The tap prices its calls in
**dollars** — that is what `result.usd` in an `llm_call` frame holds, and that
is what `readTapSpend()` returns. The budget counts **microdollars**: an
integer count where 1 USD = 1_000_000 (STATE.md §2.4). Those are not the same
number, and adding them together is not an option.

The fold used to skip the conversion, so `meta.json` ended up holding
`0.00005325` — a *fraction*, in a field the state model defines as an integer
count — where it meant `53`. Every other view then read a run that had spent
money as a run that had spent nothing: `cortex limit` printed
`usd: spent $0.000000`. The conversion now happens at that boundary, in one
place (`dollarsToMicrodollars`, in `src/money.ts`), and the
summary line prints the tap's own dollars — the same money, in the unit the
operator reads.

**The tap's money is printed like every other money.** One model call costs
about **$0.000027**, so the format is six decimals — the resolution a
microdollar count can say exactly. Four decimals would print `$0.0000`, and a
run that spent real money would read as a run that spent nothing. The tap's
budget-exceeded error says the same number in the same format as `cortex top`
and `cortex limit`, because all of them ask `formatDollars` in `src/money.ts`.

### The frame is an `llm_call` frame, so it is shaped like one

The tap's frames go into the same `.crec` a driver call goes into, under the
same syscall name. ABI.md §4.3 says what an `llm_call` result looks like, and
the usage lives under `usage` — which is where every reader looks: the
dashboard's event table, the trace view.

The tap used to write its usage **flat**, so every one of those readers saw a
tapped call with a model and nothing else:

```json
{"usd":0.000026625,"model":"gpt-4o-mini","httpStatus":200,"inputTokens":100,"cachedTokens":5,"outputTokens":20}
```

The summary line knew what the call cost. The operator's window did not — it
showed the model and no tokens, no cost. The tap now writes `usage` where the
ABI says it is:

```json
{"model":"gpt-4o-mini","usage":{"inputTokens":100,"outputTokens":20,"cachedTokens":5,"usd":0.000026625},"httpStatus":200,...}
```

The flat fields stay in the frame as well. The `.crec` format is frozen, so a
log written by this build has to stay readable by an older `cortex wrap`,
whose `readTapSpend` knows only the flat shape; and `readTapSpend` reads
**both**, so a log already on a disk still adds up.

What the tap still does not record is the **text** — no prompt, no
completion. That is deliberate (a log is something people paste into bug
reports), and it is why a tapped frame is not a complete `LLMResponse`: it
carries the usage, the model and the status, and no words.

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

It also says **what this system can call**. The 工具面 button in the top bar opens the tool surface: every tool driver and the tools it exposes, each with the reversibility the kernel would enforce and whether anybody ever **declared** that tag — plus the model drivers and the memory drivers. That is the question `cortex audit` answers, asked of the kernel that is actually running the agents: `cortex audit` boots a kernel of its own, and an MCP server's tool list is pulled from the server when the driver registers, so a second kernel's surface is not this kernel's surface. The two views read their facts and their wording from one module (`src/cli/audit_view.ts`), so they cannot disagree about which tools exist, what tag they carry, and which of them nobody ever declared.

**And the window knows which node it is attached to.** The sidebar used to say 「本地节点已连接」 and 「ABI 1.0」 in plain HTML — always, whether a kernel was running or not, and whatever ABI that kernel actually spoke. The chrome now reads the same answer the sidebar's panel does, from `GET /api/node`: which kernel it is (its pid), what it speaks, how long it has been up, and — when there is no kernel — that there is none. Three states, not two: a kernel that answered, a workspace with no kernel, and a kernel that is there and not answering. `cortex dashboard` says the same thing in the terminal, for the same reason: there is one kernel per project directory, so "a live kernel" does not say which one the operator is looking at.

The process rows also say **what each agent is inside** — "waiting on a channel for 1m2s" — which is the fact an operator of an agent OS most wants, and the one the process table cannot give: the kernel does not park a process while its LLM call is in flight, so an agent four minutes into a model call reads as `running`. The dashboard asks the kernel for it, and the wording is the same wording `cortex top` prints. That needs a live kernel it can question — pass the transport client as `kernel` (the `KernelClient` the CLI uses) rather than only the `processes` callback. **Without one the column is not shown at all**: a column of blanks would claim that nothing is inside a call, which is a different fact from "nothing is inside a call".

Updates are pushed over Server-Sent Events at `GET /api/stream` (file-watch based, 15s heartbeat); the UI falls back to polling automatically when SSE is unavailable. **The stream ends when the kernel goes away**: a push that stays open over a dead socket delivers nothing and looks exactly like a healthy one, so the dashboard listens for the connection ending, ends the stream, and the window falls back to polling, asks the kernel again (it will not answer) and says out loud that what it is showing is what the disk still has. The stream carries an `output` frame when a process printed something — it names *which* processes printed, not the lines: the file is the truth, and the page re-reads it. With a live kernel the frames come from the kernel's own relay of every printed line; without one they come from watching the output log.

The event table includes model name and token usage from completed LLM calls — including the calls the fetch tap recorded, which are `llm_call` frames in the same log — plus sanitized, length-limited syscall error summaries. Prompts, model responses, and ordinary syscall arguments/results are not returned by these views. For MCP tools, use `CORTEX_MCP_DEFAULT_REVERSIBILITY` to set the conservative default (`irreversible`, `reversible`, or `idempotent`) and `CORTEX_MCP_REVERSIBILITY` to provide per-tool JSON overrides, for example `{"search":"idempotent","create_order":"irreversible"}`. Declaring a default is explicit metadata; without it, unannotated tools remain visible to `cortex audit` and to the dashboard's tool surface, both of which mark them `not-declared`.

The API is available at:

- `GET /api/processes` — process table (live or persisted). Each row carries the kernel's own `budgetsSpent` **in microdollars** (STATE.md §2.4) *and* `usdSpentDollars`, the same spend already converted to dollars — the page is handed dollars so it cannot print a microdollar counter next to a dollar sign. Each row also carries `tokenLabel` and `usdLabel`, the two spends beside the ceilings they are measured against, in the same words `cortex ps` and `cortex top` print them: `1,234 (300 cached) of 10,000` and `$0.000250 of $1.000000` (`of ∞` for a budget with no ceiling). And `ageLabel`, how long that process lived: a **running** process is aging, so the number is the time since it started, and a **finished** one shows the lifetime the kernel recorded for it and stops there.
- `GET /api/trace/:pid` — redacted syscall timeline. Each row carries `syscall` — the **recorded** syscall name, unchanged, for a reader that matches on it — and `frame`, the name a human reads: `__state:running->blocked(recv)`, `__sched:sigxcpu(tokens)`. The two are the same frame; `frame` is what `cortex trace` prints, so the window and the terminal say the same thing.
- `GET /api/events?from=&to=&offset=&limit=` — merged callback + syscall events, newest first. `from`/`to` are millisecond timestamps; results are paginated and the total count is returned in the `x-total-count` header. Each event carries `reversibility` — the **recorded** tag (`reversible` / `idempotent` / `irreversible`), the same word `cortex trace` prints. It is absent for an event whose source did not report one, and absent means *not reported*, not "reversible".
  **Both sources come out in one shape.** A callback line names a call's counters `inputTokens` / `outputTokens` — the integration's own names, and the ABI's — and the feed renames them to the dashboard's `tokensIn` / `tokensOut`, which is what every kernel frame already arrives under and what the page reads. The old names are **not** carried alongside: one number, one name. The callback's own `type` survives (`llm.end`, `tool.end`), because a callback event is not a syscall frame, and so does every other fact the line reported (`runId`, `parentRunId`, `name`, `pid`, `durationMs`, `error`, `reversibility`).
- **The kernel's own decisions are in the feed too.** The kernel records every supervisory decision in init's own log — the supervision journal (PROCESS.md §9.1, ABI.md §6.1): a daemon was registered, an attempt died, the supervisor started a new one, the supervisor gave up, the kernel booted, the kernel shut down. Those frames used to be dropped along with the per-process bookkeeping, so an operator watching a daemon crash three times was never told that the supervisor had restarted it twice and then deliberately given up. Now they arrive as events of type `kernel.supervision`, with the sentence that says the decision in `name`: `daemon crasher restarted as pid 3 (attempt 1, previous exit: boom)`, `pid 2 reaped (exit 3: boom) -> restarted as pid 3`, `daemon crasher not restarted -> max restarts reached (2) after 2 restart(s)`, `daemon crasher registered (restart: on-failure)`, `kernel booted`. The wording comes from one module (`src/cli/supervision_view.ts`), so the terminal and the window cannot disagree about what the supervisor did. The per-process bookkeeping frames (`__state`, `__sched`, `__signal`) stay out of the feed — they restate what a process's own row already says.
- `GET /api/checkpoints` — checkpoints under `processes/<pid>/checkpoints/`, parsed from file names (`createdAt`/`chainId`) plus on-disk size.
- `GET /api/checkpoints/:chain` — **what one checkpoint holds**: `pid`, `parentPid`, `createdAt`, `chainId`, `prevInChain`, the `intent`, how many messages the conversation held (`messageCount`), the `pendingCalls` it was waiting on (by tool name), the `memoryEntries` it carried, the `budgets` it had spent, the `budgetsRemaining` it had left, the `logOffset` it was cut at, and the `driverStates` it held. `tokenLabel` and `usdLabel` come with it, computed by the server — the page is a static file and cannot compute them — and they are the same words every other view uses for a budget: the spend next to the ceiling it was measured against (`1,280 (900 cached) of 10,080`, `$0.000250 of $1.000000`). The **conversation itself is not returned**: the prompts and the model answers stay out, and only the count of them is said. `memoryEntryCount` says how many entries the snapshot carried, so a view showing the last N of them (`?limit=`, default 200) can say so. It is a **disk read**, and it is read with the *same reader the kernel uses* — the magic, the version and the signature are checked the same way — so the window can only describe a body the kernel would actually restore. A chain id that is not on disk answers `404`; a file that is not a valid checkpoint answers `502`.
- `GET /api/ops` — reports which write operations are enabled: `{ allowOps: boolean, ops: string[] }`.
- `GET /api/memory/:pid` — the memory regions of a process: for each region its `region`, `kind`, `backing`, `access` (`read-write` / `read-only` / `?`), `entries`, `writes`, `limit` (the write-count ceiling: the number, `∞`, or `?`) and `sharedWith` (the peers, each with the access mode it holds the region under — `3 (read-only)`). The words are the ones `cortex memory` prints, because both read them from one module (`src/cli/memory_view.ts`).
- `GET /api/memory/:pid/:region` — one region's entries: `region`, `access`, and `entries` (`key`, `value`, `at`).
- `GET /api/output/:pid?tail=N` — what a process **said**: the lines it printed, read back from `processes/<pid>/output.log`. Each line is `{ at, stream, text }` — the moment the line was completed, the stream it went to (`out` / `err`), and the line itself. `total` says how many lines there were, so a view that is showing the last N of a longer history can say so rather than look like a process that printed N lines. `tail` defaults to `500`; a `tail` that is not a number is not a tail, and falls back to the default. This is a **disk read**: it answers for a process that has already exited and for one whose kernel is gone — the same limit `cortex logs` has, and the same freedom. A process that printed nothing has no output log, and that is not an error: the answer is an empty list and a total of `0`.
- `GET /api/drivers` — **what this system can call**: the whole surface of the kernel that is running the agents. `toolDrivers` (each with its `name`, `version`, `abiCompat`, whether it is `forkable`, whether it is `twoPhase`, and its `tools`), `llmDrivers` and `memoryDrivers`, plus `toolCount` and `undeclaredCount`. Each tool carries its `name`, the `reversibility` the kernel would enforce (`reversible` / `idempotent` / `irreversible`, or `?` when the registry cannot resolve it), whether anybody **declared** that tag (`true` declared, `false` defaulted, `null` unknown) and the `declaredLabel` that says it in words (`declared` / `not-declared` / `?`). The label and the `summary` sentence are computed by the server — the page is a static file and cannot import the rule — and they are the same words `cortex audit` prints, because both read them from one module (`src/cli/audit_view.ts`). A tool nobody declared is marked `not-declared` because an MCP server cannot declare reversibility at all: the driver invents a tag, the invented one is `irreversible`, and a defaulted irreversible tool is refused inside a `forkable()` region without saying why. `summary` is the sentence about those tools, or `null` when there are none.
- `GET /api/node` — **which node this window is attached to**. The sidebar used to say 「本地节点已连接」 and 「ABI 1.0」 in plain HTML: always, whether a kernel was running or not, and whatever ABI that kernel actually spoke. So the window asks, and the answer is here: `dir` (the state directory the window is serving) and `dirName` (its last path segment), plus `kernel` — the kernel's own `ping` answer, described by `src/cli/kernel_view.ts`. `kernel.state` is one of three: `live` (it answered), `none` (no kernel is attached to this window), or `unreachable` (there is one, and it did not answer — with the reason in `kernel.error`). When it is `live`, `kernel` also carries `abiVersion`, `pid`, `startedAt`, `daemons`, `uptimeMs` and `uptimeLabel` — the uptime printed with the **same** function the process table prints an age with, so a duration cannot read `2m` in one panel and `90000ms` in another. This endpoint **always** answers `200`: "there is no kernel here" is one of its answers and not an error, and every fact it cannot report is `null` — never a zero, and never a made-up ABI version.
- The same answer carries the **top bar**: `connection` is what the window's light may claim. `tone` says how much to believe the numbers on the screen — `live` (a kernel is behind them), `warn` (they are the disk's records), `dead` (the kernel is gone and this is what the disk still has) — and `label` says it in words: 「内核实时推送（SSE）」, 「磁盘记录 · 目录跟随（SSE）」, 「磁盘记录 · 轮询更新」, 「活内核 · 轮询更新」, 「内核失联 · 只能读磁盘记录」. The words and the meaning come from one module (`src/dashboard/connection_view.ts`), so the page — a static file that cannot import the rule — prints what it is given and the meaning cannot drift. The one fact the server cannot check for itself is **how the window is fetching** — a pushed stream or a poll — because that is a fact about the *window*: it says which one it is doing in `?transport=sse` (anything else, and the default, is `poll`).
- The tool list lives in the registry of the kernel that owns it — an MCP server's tools are pulled from the server when the driver registers — so this endpoint needs a **live kernel**, like the two memory endpoints below. Without one it answers `409` and says so; there is no on-disk copy to read instead, and an empty surface would look like a kernel with no tools at all.
- `GET /api/daemons` — **what the supervised daemons are doing right now**. The window could show what an agent *did* and what it *knew*, and nothing about the daemons the kernel supervises; the only list the operator had was the **install receipt** (`daemons.json`), which says a daemon was written down and nothing about whether it runs. So the live answer comes from the kernel that owns the daemons (over the transport's `daemons` command, a read like `ps` and `drivers`), the receipt comes from disk, and the two are joined on the daemon's **name** — the role is not an identity, because two daemons may share one. Each row carries `name` (the operator's name, or `null` when the host registered the daemon without one), `role`, `installed` (whether the registry still has an entry for it), `status` and `statusLabel` (`running` / `just ended` / `waiting to restart` / `given up` / `stopped` / `not started` / `unknown`), `tone` (`live` / `warn` / `dead` / `idle`), `pid`, `restarts`, `exitLabel` (`exit 3 (boom)`, with `?` for a code nobody saw), `policyLabel` (`on-failure (max 3)`), `agentLabel` and `note`. `kernelLive` says whether a kernel answered at all, and `summary` is the one-line sentence about the whole set. The words come from `src/cli/daemon_view.ts`, so the terminal (`cortex daemon list`) and the window cannot phrase the same daemon differently.
- **No kernel to ask means `unknown`, not "not running".** A daemon's live state belongs to the kernel that supervises it; without one there is nothing to ask, so the rows say `unknown` and the `note` says why. This endpoint always answers `200`: "nobody knows" is one of its answers, not an error — and it is a different answer from `not started`, which is what a **live** kernel that does not have the daemon gets.

A region's contents live in the memory driver of the kernel that owns the process, so these two endpoints need a **live kernel**. Without one they answer `409` and say so — there is no on-disk copy to read instead. A process the kernel does not have answers `404`; any other failure answers `502`.

By default every write operation is rejected. Opt in from the CLI with `--allow-ops` (enable everything) or `--ops spawn,kill,restore` (enable exactly the listed ops), or pass `startDashboard({ allowOps: true | ['spawn', 'kill'] })` when embedding. Enabled ops are served as `POST /api/ops/<op>` and run the matching CLI command in-process against the dashboard's own state directory, so all CLI validation still applies:

- `POST /api/ops/spawn` with `{ "role": "...", "module"?, "task"?, "driver"?, "timeoutMs"? }` — starts a new agent (waits until it finishes, self-checkpoints, or times out).
- `POST /api/ops/kill` with `{ "pid": 7, "signal"? }` — sends the signal to the process. With no live kernel in the state directory it marks the process as zombie in its on-disk meta, exactly like `cortex kill`; with one (a `cortex daemon run` serving the same directory) the signal is delivered for real, through the kernel's own signal engine.
- `POST /api/ops/restore` with `{ "chain": "<chainId>" }` — restores a checkpointed process, exactly like `cortex restore`.

The standalone CLI accepts `--dir` to select the state directory. Use `--host` only when you intentionally want to expose the dashboard beyond the local machine, and prefer `--ops` with the narrowest list over `--allow-ops`.
