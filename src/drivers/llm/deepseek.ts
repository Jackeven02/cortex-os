/**
 * cortex built-in driver — DeepSeek LLM (`drivers/llm/deepseek.ts`).
 *
 * BACKLOG #023: *"the first real LLM driver."* Where `mock.ts` is the
 * deterministic stand-in, this is the first `ILLMDriver` that talks to a live
 * vendor API. DeepSeek was chosen because its `/chat/completions` endpoint is
 * OpenAI-compatible: one driver proves out the whole HTTP path (request
 * shaping, auth, tool-calling, usage accounting, error mapping) that #024
 * (openai) will then reuse almost verbatim.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DRIVER IS THE ERROR BOUNDARY
 * ─────────────────────────────────────────────────────────────────────────
 * The syscall dispatcher does NOT wrap LLM-driver exceptions (only memory.ts
 * wraps its own). So whatever this driver throws is what the agent sees, and
 * what gets recorded in the `.crec`. A raw `fetch` rejection or a vendor
 * `429` must therefore be translated into a `CortexError` HERE, with a stable
 * errno, or replay diverges and agents cannot pattern-match on `err.errno`.
 *
 * The HTTP-status → errno map (see `errnoForStatus`) is deliberately POSIX-ish
 * and stable: 400→EINVAL, 401/403→EPERM, 404→ENOENT, 408→ETIMEDOUT,
 * 429→EAGAIN, everything else→EDRIVER. An aborted request (the kernel's
 * timeout fired, docs/ABI.md §4.3) → ETIMEDOUT. A transport-level throw with
 * no HTTP status → `wrapDriverError` → EDRIVER, preserving `cause`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NO NETWORK IN TESTS
 * ─────────────────────────────────────────────────────────────────────────
 * `fetchFn` is injectable. The smoke checks pass a fake that returns canned
 * JSON, so the driver's request-shaping, response-mapping, usage math, and
 * error translation are all exercised without an API key, a socket, or
 * flakiness. The default `fetchFn` is the Node global `fetch`.
 *
 * Known v0 limitation: a cortex `Message` carries `content: string` only — it
 * cannot round-trip an assistant turn's structured `tool_calls`. Responses
 * here DO surface `toolCalls`, but if an agent re-feeds that assistant message
 * into a later request the tool-call structure is lost. Tracked as a Message
 * model gap; not solved in the driver.
 *
 * See: docs/ABI.md §7.1 (ILLMDriver), §4.3 (llm_call), §3.2 (errno);
 *      BACKLOG #023
 *
 * @module drivers/llm/deepseek
 */

import {
  type ILLMDriver,
  type LLMRequest,
  type LLMResponse,
  type Message,
  type ToolCall,
  type ToolSchema,
  type DriverContext,
  type Timestamp,
} from '../../kernel/types.js';
import { CortexError, wrapDriverError, type Errno } from '../../kernel/errors.js';

// =============================================================================
// §1. Injectable transport
// =============================================================================

/**
 * The minimal response surface this driver consumes. Structurally satisfied by
 * the Node/undici global `Response`, and trivially fakeable in tests.
 */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/**
 * An injectable `fetch`. Defaults to the Node global. Tests supply a fake that
 * never touches the network.
 */
export type FetchFn = (url: string, init: RequestInit) => Promise<FetchResponseLike>;

// =============================================================================
// §2. Pricing
// =============================================================================

/**
 * USD per ONE MILLION tokens, split into (uncached) input, cached input, and
 * output. Cached input tokens are billed at a steep discount by DeepSeek, so
 * they are accounted separately.
 *
 * Figures are a snapshot and WILL drift; `pricing` is injectable so a caller
 * can override without editing the driver. Unknown models fall back to
 * `deepseek-chat` rates (the cheaper of the two) rather than throwing — cost
 * accounting should never be the thing that breaks an `llm_call`.
 */
export interface ModelPricing {
  readonly inputPer1M: number;
  readonly cachedInputPer1M: number;
  readonly outputPer1M: number;
}

export const DEEPSEEK_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  'deepseek-chat': Object.freeze({ inputPer1M: 0.14, cachedInputPer1M: 0.014, outputPer1M: 0.28 }),
  'deepseek-reasoner': Object.freeze({ inputPer1M: 0.55, cachedInputPer1M: 0.14, outputPer1M: 2.19 }),
});

/** Round a USD figure to whole microdollars (6 dp) to avoid float drift. */
function roundUsd(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/**
 * Compute USD for a completion. Cached input tokens are billed at the cached
 * rate, the remaining input tokens at the full input rate, output tokens at the
 * output rate.
 */
export function computeUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number,
  pricing: Readonly<Record<string, ModelPricing>> = DEEPSEEK_PRICING,
): number {
  const p = pricing[model] ?? pricing['deepseek-chat'];
  if (p === undefined) return 0;
  const cached = Math.min(Math.max(cachedTokens, 0), Math.max(inputTokens, 0));
  const freshInput = Math.max(inputTokens - cached, 0);
  const usd =
    (freshInput * p.inputPer1M + cached * p.cachedInputPer1M + outputTokens * p.outputPer1M) /
    1_000_000;
  return roundUsd(usd);
}

// =============================================================================
// §3. Token estimation (CJK-aware heuristic)
// =============================================================================

/**
 * Chars-per-token divisor for the non-CJK portion of a string. DeepSeek (like
 * most BPE tokenizers) averages ~4 latin chars per token; CJK is far denser
 * (~1 token per char), so it is counted separately. Not a real tokenizer — a
 * stable, dependency-free estimate for `countTokens`.
 */
export const DEEPSEEK_CHARS_PER_TOKEN = 4;

/** True for the common CJK / kana / hangul / fullwidth code-point ranges. */
function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // hiragana + katakana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK ext A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
    (code >= 0xac00 && code <= 0xd7af) || // hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compat
    (code >= 0xff00 && code <= 0xffef) // halfwidth / fullwidth forms
  );
}

/**
 * Deterministic, CJK-aware token estimate for a string: each CJK code point
 * counts as one token; the remaining characters are grouped at
 * `DEEPSEEK_CHARS_PER_TOKEN`. Empty string → 0.
 */
export function estimateDeepSeekTokens(text: string): number {
  if (text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code !== undefined && isCjkCodePoint(code)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / DEEPSEEK_CHARS_PER_TOKEN);
}

/**
 * Token estimate for a message list: each message's content plus one token of
 * role/framing overhead, so an empty message still counts as 1.
 */
export function estimateDeepSeekMessageTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateDeepSeekTokens(typeof m.content === 'string' ? m.content : '') + 1;
  }
  return total;
}

// =============================================================================
// §4. Error mapping
// =============================================================================

/**
 * Map an HTTP status to a stable cortex errno. Kept exported so smoke checks
 * (and future drivers) can assert the contract directly.
 */
export function errnoForStatus(status: number): Errno {
  switch (status) {
    case 400:
      return 'EINVAL';
    case 401:
    case 403:
      return 'EPERM';
    case 404:
      return 'ENOENT';
    case 408:
      return 'ETIMEDOUT';
    case 429:
      return 'EAGAIN';
    default:
      return 'EDRIVER';
  }
}

/**
 * Best-effort detection of an abort (the kernel's `llm_call` timeout fired and
 * tripped `ctx.abortSignal`). undici surfaces this as a `DOMException` named
 * `AbortError`, or as a plain error whose `name` is `AbortError`.
 */
function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError';
}

// =============================================================================
// §5. Wire types (OpenAI-compatible chat completions)
// =============================================================================

interface WireToolCall {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly function?: { readonly name?: unknown; readonly arguments?: unknown };
}

interface WireMessage {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly tool_calls?: readonly WireToolCall[];
}

interface WireChoice {
  readonly message?: WireMessage;
  readonly finish_reason?: unknown;
}

interface WireUsage {
  readonly prompt_tokens?: unknown;
  readonly completion_tokens?: unknown;
  readonly prompt_tokens_details?: { readonly cached_tokens?: unknown };
}

interface WireCompletion {
  readonly choices?: readonly WireChoice[];
  readonly usage?: WireUsage;
  readonly model?: unknown;
}

/** Coerce an unknown JSON value to a non-negative integer, or 0. */
function toCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0;
}

/**
 * Parse a tool-call `arguments` payload. DeepSeek sends it as a JSON *string*;
 * we surface the parsed value when possible, else the raw string, so the agent
 * always gets something usable.
 */
function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return raw;
  }
}

/**
 * Map a vendor `finish_reason` onto the cortex `LLMResponse['finishReason']`
 * enum. `tool_calls` is the only real rename (→ `tool_use`). Unknown reasons
 * fall back to `tool_use` when tool calls are present, else `stop`.
 */
function mapFinishReason(
  raw: unknown,
  toolCallCount: number,
): LLMResponse['finishReason'] {
  switch (raw) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'content_filter';
    default:
      return toolCallCount > 0 ? 'tool_use' : 'stop';
  }
}

// =============================================================================
// §6. Options + defaults
// =============================================================================

export interface DeepSeekLLMOptions {
  /** Driver name. Default `'deepseek'`. */
  readonly name?: string;
  /** Driver version. Default `'1.0.0'`. */
  readonly version?: string;
  /** ABI range matched by the registry. Default `'^1.0.0'`. */
  readonly abiCompat?: string;
  /** Models this driver claims. Default `['deepseek-chat', 'deepseek-reasoner']`. */
  readonly supportedModels?: readonly string[];
  /** Model used when a request omits `model`. Default `'deepseek-chat'`. */
  readonly defaultModel?: string;
  /** API base. Default `'https://api.deepseek.com'`. */
  readonly baseUrl?: string;
  /**
   * Bearer token. Resolved lazily in `call()`: explicit `apiKey` wins, else
   * `env[apiKeyEnv]`. A missing key traps `EINVAL` at call time (constructing
   * without a key is fine — the env may be populated later).
   */
  readonly apiKey?: string;
  /** Env var holding the key. Default `'DEEPSEEK_API_KEY'`. */
  readonly apiKeyEnv?: string;
  /** Injectable environment. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injectable transport. Default the Node global `fetch`. */
  readonly fetchFn?: FetchFn;
  /** Injectable pricing table. Default `DEEPSEEK_PRICING`. */
  readonly pricing?: Readonly<Record<string, ModelPricing>>;
  /** Extra headers merged onto every request (e.g. a proxy auth header). */
  readonly headers?: Readonly<Record<string, string>>;
}

export const DEEPSEEK_DEFAULTS = {
  name: 'deepseek',
  version: '1.0.0',
  abiCompat: '^1.0.0',
  supportedModels: ['deepseek-chat', 'deepseek-reasoner'],
  defaultModel: 'deepseek-chat',
  baseUrl: 'https://api.deepseek.com',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
} as const;

// =============================================================================
// §7. DeepSeekLLMDriver
// =============================================================================

/**
 * A real `ILLMDriver` speaking DeepSeek's OpenAI-compatible HTTP API. Stateless
 * (no forkable/serialize hooks — those are `IToolDriver`-only), so it forks and
 * checkpoints for free.
 */
export class DeepSeekLLMDriver implements ILLMDriver {
  readonly name: string;
  readonly version: string;
  readonly abiCompat: string;
  readonly supportedModels: readonly string[];

  #defaultModel: string;
  #baseUrl: string;
  #apiKey: string | undefined;
  #apiKeyEnv: string;
  #env: Readonly<Record<string, string | undefined>>;
  #fetchFn: FetchFn;
  #pricing: Readonly<Record<string, ModelPricing>>;
  #headers: Readonly<Record<string, string>>;
  #closed = false;

  constructor(opts: DeepSeekLLMOptions = {}) {
    this.name = opts.name ?? DEEPSEEK_DEFAULTS.name;
    this.version = opts.version ?? DEEPSEEK_DEFAULTS.version;
    this.abiCompat = opts.abiCompat ?? DEEPSEEK_DEFAULTS.abiCompat;
    this.supportedModels = [...(opts.supportedModels ?? DEEPSEEK_DEFAULTS.supportedModels)];
    this.#defaultModel = opts.defaultModel ?? DEEPSEEK_DEFAULTS.defaultModel;
    this.#baseUrl = (opts.baseUrl ?? DEEPSEEK_DEFAULTS.baseUrl).replace(/\/+$/, '');
    this.#apiKey = opts.apiKey;
    this.#apiKeyEnv = opts.apiKeyEnv ?? DEEPSEEK_DEFAULTS.apiKeyEnv;
    this.#env = opts.env ?? process.env;
    this.#fetchFn = opts.fetchFn ?? defaultFetch;
    this.#pricing = opts.pricing ?? DEEPSEEK_PRICING;
    this.#headers = opts.headers ?? {};
  }

  /** Whether `close()` has run. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Resolve the bearer token: explicit key, else the configured env var. */
  #resolveApiKey(): string | undefined {
    if (this.#apiKey !== undefined && this.#apiKey.length > 0) return this.#apiKey;
    const fromEnv = this.#env[this.#apiKeyEnv];
    return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined;
  }

  /** Build the OpenAI-compatible request body from a cortex `LLMRequest`. */
  #buildBody(req: LLMRequest, model: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      stream: false,
      messages: req.messages.map((m) => toWireMessage(m)),
    };
    if (req.tools !== undefined && req.tools.length > 0) {
      body.tools = req.tools.map((t) => toWireTool(t));
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.seed !== undefined) body.seed = req.seed;
    return body;
  }

  async call(req: LLMRequest, ctx: DriverContext): Promise<LLMResponse> {
    const syscall = 'llm_call';
    if (this.#closed) {
      throw new CortexError('EDRIVER', syscall, {
        message: `deepseek LLM driver '${this.name}' is closed`,
        details: { driver: this.name },
      });
    }

    const apiKey = this.#resolveApiKey();
    if (apiKey === undefined) {
      throw new CortexError('EINVAL', syscall, {
        message: `deepseek LLM driver '${this.name}' has no API key (set '${this.#apiKeyEnv}' or pass apiKey)`,
        details: { driver: this.name, env: this.#apiKeyEnv },
      });
    }

    const model = req.model ?? this.#defaultModel;
    const url = `${this.#baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      ...this.#headers,
    };

    let res: FetchResponseLike;
    try {
      res = await this.#fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(this.#buildBody(req, model)),
        signal: ctx.abortSignal,
      });
    } catch (err) {
      // Transport failure or the kernel's timeout tripping the abort signal.
      if (isAbortError(err) || ctx.abortSignal.aborted) {
        // Past the deadline ⇒ genuine timeout; earlier ⇒ interrupted by a
        // signal/teardown (EINTR). Reporting the latter as ETIMEDOUT used to
        // drown the real failure during host-level retries (issue C6).
        const pastDeadline = Date.parse(ctx.deadline) <= Date.now();
        if (pastDeadline) {
          throw new CortexError('ETIMEDOUT', syscall, {
            message: `deepseek llm_call timed out (deadline ${ctx.deadline})`,
            details: { driver: this.name, model, deadline: ctx.deadline as Timestamp },
            cause: err,
          });
        }
        throw new CortexError('EINTR', syscall, {
          message: `deepseek llm_call interrupted before deadline ${ctx.deadline} (process abort / signal)`,
          details: { driver: this.name, model, deadline: ctx.deadline as Timestamp },
          cause: err,
        });
      }
      throw wrapDriverError(syscall, this.name, err);
    }

    if (!res.ok) {
      // Non-2xx: translate the HTTP status into a stable errno, carrying the
      // vendor's error text in the message so it survives into the `.crec`.
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 500);
      } catch {
        detail = '';
      }
      throw new CortexError(errnoForStatus(res.status), syscall, {
        message: `deepseek llm_call failed: HTTP ${res.status}${detail.length > 0 ? ` — ${detail}` : ''}`,
        details: { driver: this.name, model, status: res.status },
      });
    }

    let data: WireCompletion;
    try {
      data = (await res.json()) as WireCompletion;
    } catch (err) {
      throw new CortexError('EDRIVER', syscall, {
        message: `deepseek llm_call returned a non-JSON body`,
        details: { driver: this.name, model },
        cause: err,
      });
    }

    return this.#mapResponse(data, req, model, syscall);
  }

  /** Translate a wire completion into a cortex `LLMResponse`. */
  #mapResponse(
    data: WireCompletion,
    req: LLMRequest,
    requestedModel: string,
    syscall: string,
  ): LLMResponse {
    const choices = data.choices;
    const choice = choices !== undefined ? choices[0] : undefined;
    if (choice === undefined) {
      throw new CortexError('EDRIVER', syscall, {
        message: `deepseek llm_call returned no choices`,
        details: { driver: this.name, model: requestedModel },
      });
    }

    const wireMsg = choice.message;
    const rawContent = wireMsg?.content;
    const text: string | null = typeof rawContent === 'string' ? rawContent : null;

    const wireToolCalls = wireMsg?.tool_calls ?? [];
    const toolCalls: ToolCall[] = [];
    for (const tc of wireToolCalls) {
      const fn = tc.function;
      toolCalls.push({
        id: typeof tc.id === 'string' ? tc.id : '',
        name: typeof fn?.name === 'string' ? fn.name : '',
        arguments: parseToolArguments(fn?.arguments),
      });
    }

    const finishReason = mapFinishReason(choice.finish_reason, toolCalls.length);

    const usage = data.usage;
    const inputTokens = toCount(usage?.prompt_tokens);
    const outputTokens = toCount(usage?.completion_tokens);
    const cachedTokens = toCount(usage?.prompt_tokens_details?.cached_tokens);
    const responseModel = typeof data.model === 'string' && data.model.length > 0
      ? data.model
      : requestedModel;
    const usd = computeUsd(responseModel, inputTokens, outputTokens, cachedTokens, this.#pricing);

    // `req` is currently unused beyond the model fallback; keep the parameter
    // so future per-request pricing overrides have a home.
    void req;

    return {
      text,
      toolCalls,
      finishReason,
      usage: { inputTokens, outputTokens, cachedTokens, usd },
      model: responseModel,
      driverVersion: this.version,
    };
  }

  /**
   * Optional `countTokens` (docs/ABI.md §7.1). A CJK-aware heuristic, not the
   * vendor tokenizer; present so `DriverRegistry.listAll()` reports
   * `countsTokens: true` and budget pre-flight has a cheap estimate.
   */
  async countTokens(messages: readonly Message[]): Promise<number> {
    return estimateDeepSeekMessageTokens(messages);
  }

  /**
   * Streaming is not implemented in v0 (`stream` is optional on `ILLMDriver`;
   * omitting it makes `listAll()` report `streams: false`). A future version
   * can add an SSE reader yielding `LLMChunk`s.
   */
  // stream?(req, ctx): AsyncIterable<LLMChunk> — intentionally absent in v0.

  async close(): Promise<void> {
    this.#closed = true;
  }
}

// =============================================================================
// §8. Wire-shaping helpers + default transport
// =============================================================================

/** Project a cortex `Message` onto the OpenAI wire shape. */
function toWireMessage(m: Message): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    role: m.role,
    content: m.content,
  };
  if (m.toolCallId !== undefined) wire.tool_call_id = m.toolCallId;
  if (m.name !== undefined) wire.name = m.name;
  return wire;
}

/** Project a cortex `ToolSchema` onto the OpenAI function-tool wire shape. */
function toWireTool(t: ToolSchema): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  };
}

/** The default transport: the Node global `fetch`. */
function defaultFetch(url: string, init: RequestInit): Promise<FetchResponseLike> {
  return fetch(url, init) as Promise<FetchResponseLike>;
}

/**
 * Convenience factory. `deepseekLLM({ apiKey })` returns a ready-to-register
 * driver; `DriverRegistry.registerLLM(deepseekLLM())` is the whole wiring (the
 * key resolves from `DEEPSEEK_API_KEY` if not passed).
 */
export function deepseekLLM(opts: DeepSeekLLMOptions = {}): DeepSeekLLMDriver {
  return new DeepSeekLLMDriver(opts);
}
