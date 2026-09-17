/**
 * cortex built-in driver — deterministic mock LLM (`drivers/llm/mock.ts`).
 *
 * BACKLOG #022: *"deterministic mock for tests and CI (build this first; it
 * unblocks everything else)."* This is the first concrete `ILLMDriver` and the
 * reference implementation every real driver (deepseek #023, openai #024) is
 * measured against.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY DETERMINISTIC MATTERS
 * ─────────────────────────────────────────────────────────────────────────
 * cortex's whole promise is deterministic replay (docs/ABI.md §4.3: "the
 * recording is what makes deterministic replay possible"). A mock that returns
 * the same response for the same request lets the kernel's own smoke checks,
 * and downstream CI, exercise `llm_call` → budget accounting → recording →
 * replay without a network, an API key, or flakiness.
 *
 * Two determinism modes:
 *
 *   1. PURE (default). With no `script`, `call()` is a pure function of the
 *      request: same messages in → same text, same token counts, same USD out.
 *      `cachedTokens` stays 0 unless `cacheRepeated` is enabled. This is the
 *      replay-safe default.
 *
 *   2. SCRIPTED. Pass `script: [turn0, turn1, ...]` and successive calls
 *      consume turns in order; once exhausted the driver falls back to the
 *      pure echo behaviour. Deterministic for a deterministic call sequence —
 *      exactly what a test controls. `reset()` rewinds the script.
 *
 * Token counts are a stable `ceil(chars / 4)` heuristic (the classic
 * ~4-chars-per-token rule), NOT a real tokenizer. USD is `0` by default
 * (`usdPer1kTokens` opts into a rate) so budget checks are predictable.
 *
 * This driver has NO network, NO filesystem, NO randomness. It is safe to run
 * anywhere and closes trivially.
 *
 * See: docs/ABI.md §7.1 (ILLMDriver), §4.3 (llm_call); BACKLOG #022
 *
 * @module drivers/llm/mock
 */

import {
  type ILLMDriver,
  type LLMRequest,
  type LLMResponse,
  type Message,
  type ToolCall,
  type DriverContext,
} from '../../kernel/types.js';

// =============================================================================
// §1. Token / cost estimation (deterministic heuristics)
// =============================================================================

/** Chars-per-token divisor for the heuristic counter. */
export const MOCK_CHARS_PER_TOKEN = 4;

/**
 * Deterministic token estimate for a string: `ceil(len / 4)`, with `0` for the
 * empty string. Not a real tokenizer — stable and dependency-free, which is
 * all a mock needs.
 */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / MOCK_CHARS_PER_TOKEN);
}

/**
 * Deterministic token estimate for a message list. Each message costs its
 * content estimate plus one token of role/framing overhead, so an empty
 * message still counts as 1.
 */
export function estimateMessageTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTextTokens(typeof m.content === 'string' ? m.content : '') + 1;
  }
  return total;
}

/** Round a USD figure to whole microdollars (6 dp) to avoid float drift. */
function roundUsd(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/**
 * A tiny, stable 32-bit string hash (FNV-1a). Used only for the optional
 * prompt-cache simulation; it never leaks into a response.
 */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// =============================================================================
// §2. Scripted turns + options
// =============================================================================

/**
 * One canned response in a `script`. Any field omitted falls back to the
 * driver's deterministic computation (echo text, heuristic tokens, etc.).
 */
export interface MockTurn {
  /** Assistant text. `null` produces a tool-use-only turn. */
  readonly text?: string | null;
  /** Tool calls to emit; a non-empty list flips the default finishReason to `tool_use`. */
  readonly toolCalls?: readonly ToolCall[];
  /** Override the computed finish reason. */
  readonly finishReason?: LLMResponse['finishReason'];
  /** Override individual usage counters (merged onto the heuristic values). */
  readonly usage?: Partial<LLMResponse['usage']>;
  /** Override the response model name. */
  readonly model?: string;
}

export interface MockLLMOptions {
  /** Driver name. Default `'mock'`. */
  readonly name?: string;
  /** Driver version. Default `'1.0.0'`. */
  readonly version?: string;
  /** ABI range matched by the registry. Default `'^1.0.0'`. */
  readonly abiCompat?: string;
  /** Models this driver claims. Default `['mock-1', 'mock-mini']`. */
  readonly supportedModels?: readonly string[];
  /** Model used when a request omits `model`. Default `'mock-1'`. */
  readonly defaultModel?: string;
  /** Canned turns consumed in order before falling back to the echo. */
  readonly script?: readonly MockTurn[];
  /** USD per 1k total tokens. Default `0` (free, so budgets stay predictable). */
  readonly usdPer1kTokens?: number;
  /**
   * Artificial latency in ms. Default `0` (resolve immediately). When `> 0`,
   * `call()` waits on a real timer and honours `ctx.abortSignal` by rejecting.
   */
  readonly latencyMs?: number;
  /**
   * Simulate a prompt cache: when the same message list is seen again, report
   * its input tokens as `cachedTokens`. Default `false` to keep `call()` a
   * pure function of the request (replay-safe).
   */
  readonly cacheRepeated?: boolean;
  /** Prefix for the echoed reply text. Default `'mock reply to: '`. */
  readonly replyPrefix?: string;
}

/** Defaults, exported so tests can assert against them. */
export const MOCK_DEFAULTS = {
  name: 'mock',
  version: '1.0.0',
  abiCompat: '^1.0.0',
  supportedModels: ['mock-1', 'mock-mini'],
  defaultModel: 'mock-1',
  usdPer1kTokens: 0,
  latencyMs: 0,
  cacheRepeated: false,
  replyPrefix: 'mock reply to: ',
} as const;

// =============================================================================
// §3. MockLLMDriver
// =============================================================================

/**
 * A deterministic `ILLMDriver` for tests, CI, and the first end-to-end smoke
 * (docs/ARCHITECTURE.md §13: "spawn a process that calls llm_call against the
 * mock driver").
 */
export class MockLLMDriver implements ILLMDriver {
  readonly name: string;
  readonly version: string;
  readonly abiCompat: string;
  readonly supportedModels: readonly string[];

  #defaultModel: string;
  #script: readonly MockTurn[];
  #usdPer1kTokens: number;
  #latencyMs: number;
  #cacheRepeated: boolean;
  #replyPrefix: string;

  #scriptIndex = 0;
  #callCount = 0;
  #closed = false;
  #seen = new Set<number>();

  constructor(opts: MockLLMOptions = {}) {
    this.name = opts.name ?? MOCK_DEFAULTS.name;
    this.version = opts.version ?? MOCK_DEFAULTS.version;
    this.abiCompat = opts.abiCompat ?? MOCK_DEFAULTS.abiCompat;
    this.supportedModels = [...(opts.supportedModels ?? MOCK_DEFAULTS.supportedModels)];
    this.#defaultModel = opts.defaultModel ?? MOCK_DEFAULTS.defaultModel;
    this.#script = opts.script ?? [];
    this.#usdPer1kTokens = opts.usdPer1kTokens ?? MOCK_DEFAULTS.usdPer1kTokens;
    this.#latencyMs = opts.latencyMs ?? MOCK_DEFAULTS.latencyMs;
    this.#cacheRepeated = opts.cacheRepeated ?? MOCK_DEFAULTS.cacheRepeated;
    this.#replyPrefix = opts.replyPrefix ?? MOCK_DEFAULTS.replyPrefix;
  }

  /** How many times `call()` has resolved since construction / last reset. */
  get callCount(): number {
    return this.#callCount;
  }

  /** Whether `close()` has run. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Rewind the script, clear the prompt-cache memory, and zero the call count. */
  reset(): void {
    this.#scriptIndex = 0;
    this.#callCount = 0;
    this.#seen.clear();
  }

  /**
   * Deterministic reply text: an echo of the last user message (or the last
   * message of any role), prefixed by `replyPrefix`. Empty conversations get a
   * fixed string so the output is still deterministic.
   */
  #echoText(messages: readonly Message[]): string {
    let lastUser: Message | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m !== undefined && m.role === 'user') {
        lastUser = m;
        break;
      }
    }
    const anchor = lastUser ?? messages[messages.length - 1];
    if (anchor === undefined) return `${this.#replyPrefix.trimEnd()}: (empty)`;
    return `${this.#replyPrefix}${anchor.content}`;
  }

  async call(req: LLMRequest, ctx: DriverContext): Promise<LLMResponse> {
    if (this.#closed) {
      throw new Error(`mock LLM driver '${this.name}' is closed`);
    }

    // Optional latency, honouring the kernel's abort signal (docs/ABI.md §4.3
    // ETIMEDOUT path). Default 0 → no timer, resolves on the microtask queue.
    if (this.#latencyMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          ctx.abortSignal.removeEventListener('abort', onAbort);
          resolve();
        }, this.#latencyMs);
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(new Error(`mock LLM driver '${this.name}' aborted`));
        };
        if (ctx.abortSignal.aborted) {
          onAbort();
          return;
        }
        ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
      });
    }

    // Pick the turn: scripted (in order) or the deterministic echo.
    const scripted: MockTurn | undefined =
      this.#scriptIndex < this.#script.length ? this.#script[this.#scriptIndex++] : undefined;

    const text: string | null =
      scripted !== undefined && scripted.text !== undefined
        ? scripted.text
        : this.#echoText(req.messages);
    const toolCalls: readonly ToolCall[] = scripted?.toolCalls ?? [];
    const finishReason: LLMResponse['finishReason'] =
      scripted?.finishReason ?? (toolCalls.length > 0 ? 'tool_use' : 'stop');

    // Heuristic usage, then any scripted overrides.
    const inputTokens = estimateMessageTokens(req.messages);
    const baseOutputTokens = estimateTextTokens(text ?? '') + 4 * toolCalls.length;

    let cachedTokens = 0;
    if (this.#cacheRepeated) {
      const fingerprint = fnv1a(
        req.messages.map((m) => `${m.role}:${m.content}`).join('\u0000'),
      );
      if (this.#seen.has(fingerprint)) cachedTokens = inputTokens;
      this.#seen.add(fingerprint);
    }

    const totalTokens = inputTokens + baseOutputTokens;
    const usd = roundUsd((totalTokens / 1000) * this.#usdPer1kTokens);

    const usage = {
      inputTokens: scripted?.usage?.inputTokens ?? inputTokens,
      outputTokens: scripted?.usage?.outputTokens ?? baseOutputTokens,
      cachedTokens: scripted?.usage?.cachedTokens ?? cachedTokens,
      usd: scripted?.usage?.usd ?? usd,
    };

    this.#callCount++;

    return {
      text,
      toolCalls,
      finishReason,
      usage,
      model: scripted?.model ?? req.model ?? this.#defaultModel,
      driverVersion: this.version,
    };
  }

  /**
   * Deterministic token count without invoking (docs/ABI.md §7.1 optional
   * `countTokens`). Present so `DriverRegistry.listAll()` reports
   * `countsTokens: true`.
   */
  async countTokens(messages: readonly Message[]): Promise<number> {
    return estimateMessageTokens(messages);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#seen.clear();
  }
}

/**
 * Convenience factory. `mockLLM()` returns a ready-to-register deterministic
 * driver; `DriverRegistry.registerLLM(mockLLM())` is the whole wiring.
 */
export function mockLLM(opts: MockLLMOptions = {}): MockLLMDriver {
  return new MockLLMDriver(opts);
}
