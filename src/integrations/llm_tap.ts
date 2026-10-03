/**
 * Zero-code LLM tap — `integrations/llm_tap.ts`.
 *
 * The problem this solves: `CortexLangChainCallbackHandler` only reaches
 * LangChain, and only if the host wires a callback by hand. Every other client
 * — LlamaIndex, the raw OpenAI SDK, Vercel AI SDK, a hand-rolled `fetch` — is
 * invisible to cortex. Writing one adapter per framework does not scale, and
 * the adapters arrive months after the framework does.
 *
 * The tap goes one level lower. Every one of those clients ultimately calls
 * `fetch()` (or `node:http`), so wrapping `globalThis.fetch` sees all of them
 * at once, with **zero changes to the host project**:
 *
 * ```ts
 * import { tapFetch } from 'cortex-agent-os/integrations/llm-tap';
 *
 * const uninstall = tapFetch({ dir: '.cortex', pid: 42 });
 * // ... the host app's existing agent code runs unchanged ...
 * await uninstall();
 * ```
 *
 * What it gives: token accounting, a `llm_call` pair in `log.crec` (visible in
 * `cortex trace` / `cortex ps` / the dashboard), and a hard budget ceiling
 * that aborts the request instead of discovering the overspend afterwards.
 *
 * What it does NOT give, and this is the honest part — see
 * docs/INTEGRATIONS.md §"What the tap cannot do":
 *
 *   - The tap is an **observer**, not a syscall. The request never passes
 *     through the kernel's `llm_call` route, so it is not capability-checked
 *     and does not appear in a process's own causal log at the point it
 *     happened. It is a separate observer record attributed to `pid`.
 *   - No state capture. `checkpoint` / `fork` / `restore` remain unavailable
 *     because the agent's state lives in the host's JavaScript heap, not in a
 *     kernel-owned image. This is the same limit as the callback adapter, for
 *     the same structural reason.
 *   - Parsing is heuristic. It recognises OpenAI-compatible `/chat/completions`
 *     and `/embeddings` bodies, because that is what nearly everyone means by
 *     "an LLM client". A provider with a different wire format is not counted
 *     rather than counted wrongly.
 *
 * What it deliberately does NOT do: rewrite the request, inject prompts, or
 * silently retry. The tap is a meter, not a proxy. Anything that changes what
 * the model sees belongs in a driver, where it is auditable.
 *
 * @module integrations/llm_tap
 */

import { join } from 'node:path';
import { KERNEL_ABI_VERSION } from '../index.js';
import { OPENAI_PRICING, type FetchFn, type FetchResponseLike } from '../drivers/llm/openai.js';
import { Recorder, type SyscallRecordInput } from '../kernel/recorder.js';
import { asProcessId, type Timestamp } from '../kernel/types.js';

// =============================================================================
// §1. Public options
// =============================================================================

/** What to do when a request would push the process past its budget. */
export type TapBudgetAction =
  /** Record the overrun, let the request finish. Default. */
  | 'record'
  /** Abort the request by throwing, as if the driver returned EDRIVER. */
  | 'throw';

export interface LLMTapOptions {
  /** Cortex state directory. Default `.cortex`. */
  readonly dir?: string;
  /**
   * Owning process for the records. Required — a tap with no process to
   * attribute calls to cannot be read back by `cortex trace`.
   */
  readonly pid: number;
  /**
   * Token ceiling for the tapped process. Once exceeded, behaviour is
   * `onBudget` and the tap records the overrun so `cortex ps` shows it.
   */
  readonly tokenBudget?: number;
  /** What to do when `tokenBudget` is exceeded. Default `record`. */
  readonly onBudget?: TapBudgetAction;
  /**
   * USD ceiling. Same semantics as `tokenBudget`; both may be set, the first
   * one crossed wins.
   */
  readonly usdBudget?: number;
  /** Called for every recognised LLM request, after the record is written. */
  readonly onCall?: (info: TapCallInfo) => void | Promise<void>;
  /**
   * Only tap these URL substrings. Default: any URL whose path looks like an
   * OpenAI-compatible LLM endpoint. Set this to narrow to one provider.
   */
  readonly match?: (url: string) => boolean;
}

/** What the tap observed. Carries no prompt or completion text by design. */
export interface TapCallInfo {
  readonly url: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly usd: number;
  readonly durationMs: number;
  readonly ok: boolean;
  /** `'record'` or `'throw'`, whichever applied. */
  readonly budget: 'ok' | 'record' | 'throw';
}

// =============================================================================
// §2. Wire-format recognition
// =============================================================================

/** Provider-neutral view of the usage fields, covering the common spellings. */
interface ObservedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
}

const num = (...candidates: readonly unknown[]): number => {
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return 0;
};

/**
 * Pull usage out of an OpenAI-compatible response body.
 *
 * The three field names below cover the OpenAI SDK, Azure's deployment-scoped
 * variant, and the several proxies (OpenRouter, vLLM, Together) that copy
 * OpenAI's shape. `prompt_tokens_details.cached_tokens` is where the cached
 * prefix discount hides; missing it just means the ceiling is slightly
 * conservative, never wrong in the dangerous direction.
 */
function usageFrom(body: unknown): ObservedUsage | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const obj = body as Record<string, unknown>;
  const usage = (obj['usage'] ?? obj['token_usage'] ?? obj['usageMetadata']) as Record<string, unknown> | undefined;
  if (usage === undefined || usage === null) return undefined;
  const details = (usage['prompt_tokens_details'] ?? usage['input_tokens_details'] ?? usage['cached_tokens']) as Record<string, unknown> | undefined;
  return {
    inputTokens: num(usage['prompt_tokens'], usage['input_tokens'], usage['inputTokens'], usage['promptTokenCount']),
    outputTokens: num(usage['completion_tokens'], usage['output_tokens'], usage['outputTokens'], usage['candidatesTokenCount']),
    cachedTokens: num(details?.['cached_tokens'], details?.['cache_read_input_tokens'], usage['cached_content_token_count']),
  };
}

/** Model name from an OpenAI-compatible body, else from the URL, else `unknown`. */
function modelFrom(body: unknown, url: string): string {
  if (typeof body === 'object' && body !== null) {
    const m = (body as Record<string, unknown>)['model'];
    if (typeof m === 'string' && m.length > 0) return m;
  }
  const q = /\/models\/([^/?#]+)/.exec(url);
  return q?.[1] ?? 'unknown';
}

/**
 * Is this URL an OpenAI-compatible LLM endpoint?
 *
 * Matching on `/v1/` plus a known endpoint name is deliberately narrow. A
 * wider net (any POST that returns `usage`) would eventually catch a database
 * or a metrics endpoint, and a wrong token count in `cortex ps` is worse than
 * a missing one — it silently corrupts a budget the user set.
 */
export function isLLMUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  return (
    /\/v\d+\/(chat\/completions|completions|embeddings|responses)$/.test(path) ||
    /^\/api\/chat$/.test(path) || // ollama
    /\/v\d+\/messages$/.test(path) // anthropic shape, usage only
  );
}

/** Prompt/completion text must never be recorded, so only shapes are. */
function shapeOf(requestBody: unknown): Record<string, unknown> {
  if (typeof requestBody !== 'object' || requestBody === null) return {};
  const obj = requestBody as Record<string, unknown>;
  const out: Record<string, unknown> = { model: modelFrom(obj, '') };
  if (typeof obj['stream'] === 'boolean') out['stream'] = obj['stream'];
  if (typeof obj['max_tokens'] === 'number') out['max_tokens'] = obj['max_tokens'];
  const messages = obj['messages'];
  if (Array.isArray(messages)) out['messages'] = messages.length;
  const tools = obj['tools'];
  if (Array.isArray(tools)) out['tools'] = tools.length;
  if (typeof obj['input'] === 'string') out['input_chars'] = obj['input'].length;
  return out;
}

// =============================================================================
// §3. Pricing
// =============================================================================

/** Counters as of now, for a host that wants to display spend without reading the `.crec`. */
export interface LLMTapStats {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly usd: number;
}

let lastStats: LLMTapStats = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, usd: 0 };

/** Current running totals. Returns zeros when no tap is installed. */
export function llmTapStats(): LLMTapStats {
  return lastStats;
}

/**
 * USD for the observed usage.
 *
 * Drivers keep their own pricing tables; the tap reuses the openai one rather
 * than inventing a fourth copy. An unknown model costs 0, which is the safe
 * direction: the tap under-reports spend instead of over-reporting it, and
 * `cortex limit` remains the authoritative guard.
 */
function priceOf(model: string, usage: ObservedUsage): number {
  const table = OPENAI_PRICING[model] ?? OPENAI_PRICING['gpt-4o-mini'];
  if (table === undefined) return 0;
  const freshIn = Math.max(0, usage.inputTokens - usage.cachedTokens);
  return (
    (freshIn * table.inputPer1M + usage.cachedTokens * table.cachedInputPer1M + usage.outputTokens * table.outputPer1M) /
    1_000_000
  );
}

// =============================================================================
// §4. The tap
// =============================================================================

let installed: (() => Promise<void>) | undefined;

/**
 * Wrap `globalThis.fetch` so LLM requests are counted and recorded.
 *
 * @returns an uninstall function. Call it before process exit — it flushes the
 * recorder, so skipping it can cost the last few records.
 *
 * Only one tap is installed at a time; a second call returns the first one's
 * uninstaller rather than stacking wrappers. Two wrappers would double-count
 * every request, which is the kind of bug that shows up as "why is my budget
 * wrong" and costs an afternoon.
 */
export async function tapFetch(options: LLMTapOptions): Promise<() => Promise<void>> {
  if (installed !== undefined) return installed;

  const dir = options.dir ?? '.cortex';
  const pid = asProcessId(options.pid);
  const match = options.match ?? isLLMUrl;
  const onBudget = options.onBudget ?? 'record';

  const recorder = await Recorder.open({ pid, dir: join(dir, 'processes', String(options.pid)) });

  // Running totals for the ceiling check. The kernel owns the authoritative
  // counters for a spawned process; for a tapped external process there is no
  // kernel entry, so the tap keeps its own and the dashboard shows the
  // per-record usage.
  let tokensIn = 0;
  let tokensOut = 0;
  let cachedTotal = 0;
  let usdSpent = 0;
  let callSeq = 0;

  const original = globalThis.fetch;

  const wrapped: FetchFn = async (url: string, init: RequestInit = {}): Promise<FetchResponseLike> => {
    if (!match(url)) return original(url, init) as unknown as Promise<FetchResponseLike>;

    const callId = `tap-${(callSeq += 1)}`;
    const startedAt = Date.now();
    const startedAtIso = new Date().toISOString();
    // Read the body without consuming it for the caller: the host needs the
    // bytes, so they are parsed from a clone of the buffer.
    const rawBody = typeof init.body === 'string' ? init.body : undefined;

    // A request that is already over budget is not sent under `throw`: the
    // point of the ceiling is to stop *before* spending more, and aborting
    // mid-flight would leave the caller with no usage data at all.
    const preOver =
      (options.tokenBudget !== undefined && tokensIn + tokensOut >= options.tokenBudget) ||
      (options.usdBudget !== undefined && usdSpent >= options.usdBudget);

    const write = async (phase: 'enter' | 'exit' | 'trap', extra: Partial<SyscallRecordInput>): Promise<void> => {
      const record: SyscallRecordInput = {
        timestamp: startedAtIso as Timestamp,
        pid,
        syscall: 'llm_call',
        callId,
        phase,
        stateBefore: 'running',
        stateAfter: 'running',
        reversibility: 'reversible',
        kernelAbiVersion: KERNEL_ABI_VERSION,
        ...extra,
      };
      await recorder.append(record);
    };

    await write('enter', { args: { via: 'fetch-tap', url, ...shapeOf(rawBody === undefined ? undefined : safeParse(rawBody)) } });

    let response: Response;
    try {
      response = await original(url, init);
    } catch (err) {
      await write('trap', {
        error: { errno: 'EDRIVER', message: err instanceof Error ? err.name : 'fetch failed' },
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }

    // Clone before reading: the caller still needs an unread body. `clone()`
    // throws synchronously if the body is already consumed or locked, so the
    // try is not optional — a tapped host that streams must not crash here.
    let bodyText = '';
    try {
      bodyText = await response.clone().text();
    } catch {
      bodyText = '';
    }
    const parsed = safeParse(bodyText);
    const usage = usageFrom(parsed);
    const model = modelFrom(parsed, url);

    if (usage !== undefined) {
      tokensIn += usage.inputTokens;
      tokensOut += usage.outputTokens;
      cachedTotal += usage.cachedTokens;
    }
    const usd = usage === undefined ? 0 : priceOf(model, usage);
    if (usage !== undefined) usdSpent += usd;

    const postOver =
      (options.tokenBudget !== undefined && tokensIn + tokensOut > options.tokenBudget) ||
      (options.usdBudget !== undefined && usdSpent > options.usdBudget);
    const breached = (preOver || postOver) && usage !== undefined;
    const budget: TapCallInfo['budget'] = !breached ? 'ok' : onBudget === 'throw' ? 'throw' : 'record';

    await write(response.ok ? 'exit' : 'trap', {
      result: {
        model,
        ...(usage !== undefined
          ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedTokens }
          : {}),
        usd,
        ...(breached ? { budget: 'exceeded' } : {}),
        httpStatus: response.status,
      },
      ...(response.ok
        ? {}
        : { error: { errno: 'EDRIVER', message: `HTTP ${response.status}` } }),
      durationMs: Date.now() - startedAt,
    });

    if (options.onCall !== undefined) {
      await options.onCall({
        url,
        model,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cachedTokens: usage?.cachedTokens ?? 0,
        usd,
        durationMs: Date.now() - startedAt,
        ok: response.ok,
        budget,
      });
    }
    lastStats = {
      calls: callSeq,
      inputTokens: tokensIn,
      outputTokens: tokensOut,
      cachedTokens: cachedTotal,
      usd: usdSpent,
    };

    // `throw` fires after the record is written, so the overrun is auditable
    // even though the caller sees an exception.
    if (budget === 'throw') {
      throw new Error(`cortex llm_tap: budget exceeded for pid ${options.pid} (${tokensIn + tokensOut} tokens, $${usdSpent.toFixed(4)})`);
    }
    return response as unknown as FetchResponseLike;
  };

  globalThis.fetch = wrapped as unknown as typeof globalThis.fetch;

  const uninstall = async (): Promise<void> => {
    if (installed === undefined) return;
    installed = undefined;
    globalThis.fetch = original;
    await recorder.close();
  };
  installed = uninstall;
  return uninstall;
}

/** Parse without throwing: a non-JSON body is a fact, not an error. */
function safeParse(text: string | undefined): unknown {
  if (text === undefined || text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Counters as of now. Useful for a host that wants to display its own spend
 * without reading the `.crec`.
 */
export interface LLMTapStats {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly usd: number;
}

/** Where the tap writes, for a host that wants to pre-create the directory. */
export function llmTapProcessDir(dir: string, pid: number): string {
  return join(dir, 'processes', String(pid));
}

/** Test seam: reset module state between cases. Not part of the public API. */
export async function __resetLLMTapForTests(): Promise<void> {
  await installed?.();
  lastStats = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, usd: 0 };
}
