/**
 * cortex — what a process's token spend means, and how it is printed.
 *
 * ## The rule
 *
 * **A token count has three parts, and the cached one is a part of the input.**
 *
 * The kernel records three counters (docs/STATE.md §2.4): the tokens a model
 * read, the tokens it wrote, and the part of the input it did not have to read
 * again. The provider reports its input count **including** the cached part —
 * `prompt_tokens` is the whole prompt, and `cached_tokens` says how much of it
 * came out of the cache — so two things follow, and every view depends on
 * them:
 *
 * - The **total** a process spent is `tokensIn + tokensOut`, and the cached
 *   tokens are already in there. Adding them again would count the same
 *   tokens twice, and a budget that drains twice as fast as the work did is a
 *   budget nobody can reason about.
 * - The **cached** part is worth saying out loud. It is billed at the cache
 *   price rather than the fresh one, so a process that spent 1,000 tokens for a
 *   fifth of the usual money was reading from the cache. The token ceiling
 *   counts those tokens in full (it bounds the work). The money ceiling uses
 *   the cache price (it bounds the invoice). The cached part is what makes
 *   the two numbers readable next to each other.
 *
 * ## Why it lives here
 *
 * Three views answer "how many tokens did this process spend" — `cortex ps`,
 * `cortex top` and the dashboard — and they must not be able to disagree about
 * what the number means, or about which part of it was cached. So the *rule*
 * and the *wording* live here, and each view supplies only **how it prints a
 * number**: the CLI shortens (`1.2k`), the dashboard spells it out (`1,234`).
 * The shape of the cell — the total, and the cached part in brackets — is the
 * same in both, because it is decided once, here.
 *
 * ## Two levels: a process and a call
 *
 * A **process** spends one total; a **call** spends a pair. So the two are
 * printed in two shapes, from two functions, and never mixed:
 *
 * - a process: `1.2k (300 cached)` — one number, and the part of it that was
 *   cached;
 * - a call: `1.2k in / 80 out (900 cached)` — what it read, what it wrote, and
 *   the part of the input that came out of the cache.
 *
 * The second shape is what `cortex trace` prints for a model call, and it is
 * the same shape the dashboard's event row prints — read by the same function,
 * from the same frame.
 *
 * @module token_usage
 */

/**
 * The token counters of a process.
 *
 * Narrower than the kernel's `BudgetCounters` on purpose: these are the three
 * that say what a token count *is*. The rest of the counters are money, time
 * and calls, and they have their own rules.
 */
export interface TokenSpend {
  /** The tokens the model read — the cached ones included. */
  readonly tokensIn: number;
  /** The tokens the model wrote. */
  readonly tokensOut: number;
  /** The input tokens the provider served from its cache. */
  readonly tokensCached: number;
}

/**
 * A token spend, read as its parts.
 *
 * `cached` and `fresh` add up to the input; `total` is the input plus the
 * output. The cached part is **inside** the total, never next to it.
 */
export interface TokenUsage {
  /** Every token the process spent — the cached ones included. */
  readonly total: number;
  /** The input tokens the provider served from its cache. */
  readonly cached: number;
  /** The input tokens the provider had to read for real. */
  readonly fresh: number;
}

/**
 * Read a token spend as its parts.
 *
 * The cached count is clamped to the input it is part of: a provider that
 * reported more cached tokens than input tokens would otherwise make the
 * "fresh" count negative, and a negative count of tokens read for real is a
 * number no operator can use.
 */
export function tokenUsage(spent: TokenSpend): TokenUsage {
  const input = Math.max(0, spent.tokensIn);
  const cached = Math.min(Math.max(0, spent.tokensCached), input);
  return {
    total: input + Math.max(0, spent.tokensOut),
    cached,
    fresh: input - cached,
  };
}

/**
 * How a token count is printed.
 *
 * Exact below a thousand, then `k`, then `M`.
 *
 * It lives here, and not in one command, because every view that shows a token
 * count shows it this way — `cortex ps` in its TOKENS column, `cortex top` in
 * its own, the dashboard in its own — and they must not be able to disagree
 * about the same process. They used to: `cortex ps` had its own inline rule
 * that rounded anything under a thousand up to `1.0k`, while `cortex top`
 * printed the exact number. So 999 tokens read as `1.0k` in one view and
 * `999` in the other — two views of one process, two different numbers, and no
 * way for the operator to tell which one was the truth.
 */
export function formatTokens(n: number): string {
  if (n === 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * The cached part of a spend, said out loud — or nothing at all.
 *
 * Empty when nothing was cached: a cell that says "(0 cached)" about every
 * process is a cell nobody reads, and it would push the real ones out of
 * sight.
 *
 * @param cached How many tokens were served out of the cache.
 * @param format How this view prints a number.
 */
export function cachedSuffix(cached: number, format: (n: number) => string): string {
  if (cached <= 0) return '';
  return ` (${format(cached)} cached)`;
}

/**
 * A whole token cell: the total, and the cached part when there is one.
 *
 * The total comes first, because it is the number the budget spends and the
 * number the operator is looking for. The cached part comes after it, in
 * brackets, because it is a *part* of that total and not an extra one.
 *
 * @param spent The process's token counters.
 * @param format How this view prints a number. The CLI shortens
 *   (`1.2k`), the dashboard spells it out (`1,234`).
 */
export function formatTokenUsage(
  spent: TokenSpend,
  format: (n: number) => string = formatTokens,
): string {
  const usage = tokenUsage(spent);
  return `${format(usage.total)}${cachedSuffix(usage.cached, format)}`;
}

/**
 * What one model call spent.
 *
 * The shape the ABI gives a driver's usage (docs/ABI.md §4.3): the tokens the
 * model read, the tokens it wrote, the part of the input the provider served
 * out of its cache, and the price.
 *
 * Every counter is optional because a frame can report **less** than the ABI
 * says: a recording written by an older driver, or a host that only priced
 * the call. A counter that was not reported is **not** a counter of zero, and
 * a view that printed zero for it would be claiming something nobody said.
 */
export interface CallUsage {
  /** The model that answered, when the frame says so. */
  readonly model?: string;
  /** The tokens the model read. */
  readonly inputTokens?: number;
  /** The tokens the model wrote. */
  readonly outputTokens?: number;
  /** The input tokens the provider served out of its cache. */
  readonly cachedTokens?: number;
  /** The price, in dollars. */
  readonly usd?: number;
}

/**
 * Read a recorded frame's result as what a model call spent.
 *
 * `undefined` when the frame is not a model call, or when it carries nothing
 * at all to say: no model and no counter. None of those spent anything an
 * operator can be told about.
 *
 * Everything that *is* there is read, and what is not there stays absent — the
 * counters come back `undefined` rather than `0`, so a view that prints them
 * cannot invent a number nobody reported. That is the whole difference
 * between "this call cost nothing" and "this frame does not say what it cost".
 *
 * It lives here because two views read the same frame — the CLI's trace and
 * the dashboard's event table — and a rule one of them cannot import is a
 * rule it will re-implement.
 *
 * @param syscall The frame's syscall name.
 * @param result The frame's recorded result.
 */
export function callUsage(syscall: string, result: unknown): CallUsage | undefined {
  if (syscall !== 'llm_call') return undefined;
  if (typeof result !== 'object' || result === null) return undefined;
  const frame = result as Record<string, unknown>;
  const model = typeof frame['model'] === 'string' ? frame['model'] : undefined;
  // The usage is where the ABI puts the counters (docs/ABI.md §4.3). A frame
  // that carries none of them still may name the model that answered.
  const raw = frame['usage'];
  const counters =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const inputTokens = count(counters['inputTokens']);
  const outputTokens = count(counters['outputTokens']);
  const cachedTokens = count(counters['cachedTokens']);
  const usd = count(counters['usd']);
  if (
    model === undefined &&
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedTokens === undefined &&
    usd === undefined
  ) {
    return undefined;
  }
  return {
    ...(model !== undefined ? { model } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    ...(usd !== undefined ? { usd } : {}),
  };
}

/** A number in a recorded frame, or `undefined` when it is not one. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * One model call's tokens, in words: the input it read, the output it wrote,
 * and the cached part of that input.
 *
 * A **call** is not a **process**: a process's spend is one total, while a
 * call's is a pair — and the input is the interesting half, because it is
 * most of what the price is made of.
 *
 * **Only the counters the frame reported are printed.** A frame that says how
 * many tokens it read and nothing about how many it wrote says "1.2k in", and
 * not "1.2k in / 0 out" — because a counter nobody reported is not a counter
 * of zero, and printing zero would be a claim about a number that was never
 * made. The kernel charges an unreported counter as zero (`spend()` reads the
 * same fields), but what the kernel charged and what the frame said are two
 * different questions, and this cell answers the second one.
 *
 * @param usage What the call spent.
 * @param format How this view prints a number.
 */
export function formatCallUsage(usage: CallUsage, format: (n: number) => string): string {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`${format(usage.inputTokens)} in`);
  if (usage.outputTokens !== undefined) parts.push(`${format(usage.outputTokens)} out`);
  const text = parts.join(' / ');
  const cached = cachedSuffix(usage.cachedTokens ?? 0, format);
  if (cached === '') return text;
  return text === '' ? cached.trim() : `${text}${cached}`;
}
