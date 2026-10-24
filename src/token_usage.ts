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
 *   fifth of the usual money was reading from the cache — and no view used to
 *   say so. The operator saw the tokens and the dollars and could not make
 *   them add up.
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
