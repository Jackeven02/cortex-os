/**
 * cortex built-in driver — OpenAI LLM (`drivers/llm/openai.ts`).
 *
 * BACKLOG #024: *"second LLM driver, validates the abstraction."* Where
 * `deepseek.ts` (#023) proved the HTTP path against an OpenAI-compatible API,
 * this driver talks to the real OpenAI `/chat/completions` endpoint. It
 * validates that the `ILLMDriver` abstraction is vendor-neutral: the kernel
 * code did not change, only the driver.
 *
 * The driver is structurally parallel to `deepseek.ts` — same error-boundary
 * discipline (the dispatcher does not wrap LLM-driver throws, so this driver
 * translates everything into `CortexError`), same injectable `fetchFn` for
 * network-free tests, same CJK-aware token heuristic for `countTokens`.
 *
 * Differences from DeepSeek:
 *   - Different pricing table (GPT-4o family, GPT-4o-mini, o1, o1-mini, etc.)
 *   - Different env var (`OPENAI_API_KEY`)
 *   - Different default model (`gpt-4o-mini`)
 *   - OpenAI supports `n` (multiple choices) and `response_format` but v0 keeps
 *     the surface minimal — the first choice is always used.
 *   - `o1` / `o3` family models do not support `temperature`; the driver omits
 *     it when the model starts with `o1` or `o3`.
 *
 * See: docs/ABI.md §7.1 (ILLMDriver), §4.3 (llm_call);
 *      BACKLOG #024
 *
 * @module drivers/llm/openai
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
// §1. Injectable transport (same shape as deepseek.ts)
// =============================================================================

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchFn = (url: string, init: RequestInit) => Promise<FetchResponseLike>;

// =============================================================================
// §2. Pricing
// =============================================================================

export interface ModelPricing {
  readonly inputPer1M: number;
  readonly cachedInputPer1M: number;
  readonly outputPer1M: number;
}

/**
 * OpenAI pricing snapshot (USD per 1M tokens). Figures will drift; `pricing`
 * is injectable so callers can override without editing the driver. Unknown
 * models fall back to `gpt-4o-mini` rates (cheapest) rather than throwing.
 */
export const OPENAI_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  'gpt-4o': Object.freeze({ inputPer1M: 2.5, cachedInputPer1M: 1.25, outputPer1M: 10 }),
  'gpt-4o-mini': Object.freeze({ inputPer1M: 0.15, cachedInputPer1M: 0.075, outputPer1M: 0.6 }),
  'gpt-4-turbo': Object.freeze({ inputPer1M: 10, cachedInputPer1M: 5, outputPer1M: 30 }),
  'gpt-4': Object.freeze({ inputPer1M: 30, cachedInputPer1M: 15, outputPer1M: 60 }),
  'gpt-3.5-turbo': Object.freeze({ inputPer1M: 0.5, cachedInputPer1M: 0.25, outputPer1M: 1.5 }),
  'o1': Object.freeze({ inputPer1M: 15, cachedInputPer1M: 7.5, outputPer1M: 60 }),
  'o1-mini': Object.freeze({ inputPer1M: 3, cachedInputPer1M: 1.5, outputPer1M: 12 }),
  'o1-pro': Object.freeze({ inputPer1M: 150, cachedInputPer1M: 75, outputPer1M: 600 }),
  'o3': Object.freeze({ inputPer1M: 15, cachedInputPer1M: 7.5, outputPer1M: 60 }),
  'o3-mini': Object.freeze({ inputPer1M: 3, cachedInputPer1M: 1.5, outputPer1M: 12 }),
});

function roundUsd(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}

export function computeUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number,
  pricing: Readonly<Record<string, ModelPricing>> = OPENAI_PRICING,
): number {
  const p = pricing[model] ?? pricing['gpt-4o-mini'];
  if (p === undefined) return 0;
  const cached = Math.min(Math.max(cachedTokens, 0), Math.max(inputTokens, 0));
  const freshInput = Math.max(inputTokens - cached, 0);
  const usd =
    (freshInput * p.inputPer1M + cached * p.cachedInputPer1M + outputTokens * p.outputPer1M) /
    1_000_000;
  return roundUsd(usd);
}

// =============================================================================
// §3. Token estimation (CJK-aware, same as deepseek)
// =============================================================================

export const OPENAI_CHARS_PER_TOKEN = 4;

function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

export function estimateOpenAiTokens(text: string): number {
  if (text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code !== undefined && isCjkCodePoint(code)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / OPENAI_CHARS_PER_TOKEN);
}

export function estimateOpenAiMessageTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateOpenAiTokens(typeof m.content === 'string' ? m.content : '') + 1;
  }
  return total;
}

// =============================================================================
// §4. Error mapping
// =============================================================================

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

function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError';
}

// =============================================================================
// §5. Wire types (OpenAI chat completions)
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

function toCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0;
}

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

export interface OpenAiLLMOptions {
  readonly name?: string;
  readonly version?: string;
  readonly abiCompat?: string;
  readonly supportedModels?: readonly string[];
  readonly defaultModel?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchFn?: FetchFn;
  readonly pricing?: Readonly<Record<string, ModelPricing>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly organization?: string;
}

export const OPENAI_DEFAULTS = {
  name: 'openai',
  version: '1.0.0',
  abiCompat: '^1.0.0',
  supportedModels: [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4-turbo',
    'gpt-4',
    'gpt-3.5-turbo',
    'o1',
    'o1-mini',
    'o1-pro',
    'o3',
    'o3-mini',
  ],
  defaultModel: 'gpt-4o-mini',
  baseUrl: 'https://api.openai.com',
  apiKeyEnv: 'OPENAI_API_KEY',
} as const;

// =============================================================================
// §7. OpenAiLLMDriver
// =============================================================================

export class OpenAiLLMDriver implements ILLMDriver {
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
  #organization: string | undefined;
  #closed = false;

  constructor(opts: OpenAiLLMOptions = {}) {
    this.name = opts.name ?? OPENAI_DEFAULTS.name;
    this.version = opts.version ?? OPENAI_DEFAULTS.version;
    this.abiCompat = opts.abiCompat ?? OPENAI_DEFAULTS.abiCompat;
    this.supportedModels = [...(opts.supportedModels ?? OPENAI_DEFAULTS.supportedModels)];
    this.#defaultModel = opts.defaultModel ?? OPENAI_DEFAULTS.defaultModel;
    this.#baseUrl = (opts.baseUrl ?? OPENAI_DEFAULTS.baseUrl).replace(/\/+$/, '');
    this.#apiKey = opts.apiKey;
    this.#apiKeyEnv = opts.apiKeyEnv ?? OPENAI_DEFAULTS.apiKeyEnv;
    this.#env = opts.env ?? process.env;
    this.#fetchFn = opts.fetchFn ?? defaultFetch;
    this.#pricing = opts.pricing ?? OPENAI_PRICING;
    this.#headers = opts.headers ?? {};
    this.#organization = opts.organization;
  }

  get closed(): boolean {
    return this.#closed;
  }

  #resolveApiKey(): string | undefined {
    if (this.#apiKey !== undefined && this.#apiKey.length > 0) return this.#apiKey;
    const fromEnv = this.#env[this.#apiKeyEnv];
    return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined;
  }

  /**
   * `o1` / `o3` family models do not accept `temperature`. Detect by prefix so
   * the request body omits it for those models.
   */
  #supportsTemperature(model: string): boolean {
    return !model.startsWith('o1') && !model.startsWith('o3');
  }

  #buildBody(req: LLMRequest, model: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      stream: false,
      messages: req.messages.map((m) => toWireMessage(m)),
    };
    if (req.tools !== undefined && req.tools.length > 0) {
      body.tools = req.tools.map((t) => toWireTool(t));
    }
    if (req.temperature !== undefined && this.#supportsTemperature(model)) {
      body.temperature = req.temperature;
    }
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.seed !== undefined) body.seed = req.seed;
    return body;
  }

  async call(req: LLMRequest, ctx: DriverContext): Promise<LLMResponse> {
    const syscall = 'llm_call';
    if (this.#closed) {
      throw new CortexError('EDRIVER', syscall, {
        message: `openai LLM driver '${this.name}' is closed`,
        details: { driver: this.name },
      });
    }

    const apiKey = this.#resolveApiKey();
    if (apiKey === undefined) {
      throw new CortexError('EINVAL', syscall, {
        message: `openai LLM driver '${this.name}' has no API key (set '${this.#apiKeyEnv}' or pass apiKey)`,
        details: { driver: this.name, env: this.#apiKeyEnv },
      });
    }

    const model = req.model ?? this.#defaultModel;
    const url = `${this.#baseUrl}/v1/chat/completions`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      ...this.#headers,
    };
    if (this.#organization !== undefined && this.#organization.length > 0) {
      headers['OpenAI-Organization'] = this.#organization;
    }

    let res: FetchResponseLike;
    try {
      res = await this.#fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(this.#buildBody(req, model)),
        signal: ctx.abortSignal,
      });
    } catch (err) {
      if (isAbortError(err) || ctx.abortSignal.aborted) {
        // Distinguish a genuine deadline timeout from an interrupt raised by
        // kernel teardown (a process being killed / a quantum torn down). A
        // fetch that aborts once we are past its deadline is a real timeout;
        // one aborted *before* the deadline was interrupted by a signal, which
        // is a different failure and must not be reported as ETIMEDOUT — doing
        // so drowned the genuine cause (e.g. EDRIVER) under a pile of spurious
        // timeouts during host-level retry loops (issue C6).
        const pastDeadline = Date.parse(ctx.deadline) <= Date.now();
        if (pastDeadline) {
          throw new CortexError('ETIMEDOUT', syscall, {
            message: `openai llm_call timed out (deadline ${ctx.deadline})`,
            details: { driver: this.name, model, deadline: ctx.deadline as Timestamp },
            cause: err,
          });
        }
        throw new CortexError('EINTR', syscall, {
          message: `openai llm_call interrupted before deadline ${ctx.deadline} (process abort / signal)`,
          details: { driver: this.name, model, deadline: ctx.deadline as Timestamp },
          cause: err,
        });
      }
      throw wrapDriverError(syscall, this.name, err);
    }

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 500);
      } catch {
        detail = '';
      }
      throw new CortexError(errnoForStatus(res.status), syscall, {
        message: `openai llm_call failed: HTTP ${res.status}${detail.length > 0 ? ` — ${detail}` : ''}`,
        details: { driver: this.name, model, status: res.status },
      });
    }

    let data: WireCompletion;
    try {
      data = (await res.json()) as WireCompletion;
    } catch (err) {
      throw new CortexError('EDRIVER', syscall, {
        message: `openai llm_call returned a non-JSON body`,
        details: { driver: this.name, model },
        cause: err,
      });
    }

    return this.#mapResponse(data, req, model, syscall);
  }

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
        message: `openai llm_call returned no choices`,
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
    const responseModel =
      typeof data.model === 'string' && data.model.length > 0 ? data.model : requestedModel;
    const usd = computeUsd(responseModel, inputTokens, outputTokens, cachedTokens, this.#pricing);

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

  async countTokens(messages: readonly Message[]): Promise<number> {
    return estimateOpenAiMessageTokens(messages);
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

// =============================================================================
// §8. Wire-shaping helpers + default transport
// =============================================================================

function toWireMessage(m: Message): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    role: m.role,
    content: m.content,
  };
  if (m.toolCallId !== undefined) wire.tool_call_id = m.toolCallId;
  if (m.name !== undefined) wire.name = m.name;
  return wire;
}

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

function defaultFetch(url: string, init: RequestInit): Promise<FetchResponseLike> {
  return fetch(url, init) as Promise<FetchResponseLike>;
}

/**
 * Convenience factory. `openaiLLM({ apiKey })` returns a ready-to-register
 * driver; `DriverRegistry.registerLLM(openaiLLM())` is the whole wiring (the
 * key resolves from `OPENAI_API_KEY` if not passed).
 */
export function openaiLLM(opts: OpenAiLLMOptions = {}): OpenAiLLMDriver {
  return new OpenAiLLMDriver(opts);
}
