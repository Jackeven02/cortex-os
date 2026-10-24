/**
 * cortex CLI — a process's budget.
 *
 * ## The rule
 *
 * **A budget has a ceiling and a remainder, and they are not the same number.**
 *
 * The kernel keeps two numbers per budget: what the process has **spent** and
 * what it has **left**. `budgetsRemaining` shrinks as the process spends — it
 * is the remainder, and it is never the ceiling.
 *
 * Printing the remainder and calling it "the limit" is how a number that
 * moves under the operator's feet gets read as a fixed promise. `cortex limit`
 * used to print exactly that:
 *
 * ```console
 * $ cortex limit 3
 * pid 3 (spender):
 *   tokens:     spent 42 / limit 958
 * ```
 *
 * for an agent spawned with `--token-budget 1000` that had spent 42 tokens.
 * The ceiling was 1000 — and 1000 was nowhere to be seen. The number on the
 * right of the slash *was* the remainder, wearing the label of the limit.
 *
 * So the ceiling is computed — `spent + remaining`, or ∞ when the budget is
 * unlimited — and the remainder is shown as what it is: what is **left**.
 *
 * ## Where the ceiling reaches the operator
 *
 * `cortex limit` is the report, but it is not the view an operator watches:
 * the tables are. And a table that printed the **spend** without the
 * **ceiling** left the operator with a number they could not act on — "1.2k"
 * is 12% of one budget and 99% of another, and the two need very different
 * answers. So every view that prints a spend prints the ceiling it is
 * measured against beside it (`formatTokenBudget`, `formatUsdBudget`), and
 * two views of one process cannot disagree about what the ceiling is.
 *
 * ## Why it lives here
 *
 * Two sources answer the same question: a live kernel's process table (for a
 * running agent) and the on-disk exit record (for one that has finished).
 * They have to be phrased the same way, or the operator has to work out
 * whether "limit 1000" and "limit 958" are the same fact.
 *
 * @module cli/process_budget
 */

import type { BudgetCounters, BudgetLimits } from '../kernel/types.js';
import { formatDollars, usdToDollars } from '../money.js';
import { formatTokenUsage, formatTokens, tokenUsage } from '../token_usage.js';

/**
 * What the CLI knows about a process's budget.
 *
 * Both sources have this shape: the kernel's `ProcessInfo` and the persisted
 * `ProcessMeta` carry the same two budget records.
 */
export interface BudgetFacts {
  /** What the process has spent. */
  readonly spent: BudgetCounters;
  /** What the process has left. */
  readonly remaining: BudgetLimits;
}

/**
 * The ceiling of one budget: the total the process may ever spend.
 *
 * `null` means **unlimited** — the kernel uses `-1` for that, and a limit of
 * `-1` tokens is not a thing an operator can read.
 */
export function budgetCeiling(spent: number, remaining: number): number | null {
  if (remaining < 0) return null;
  return spent + remaining;
}

/**
 * Microdollars → dollars, and the format money is printed in, live in
 * [`src/money.ts`](../money.ts) — one place, so the CLI, the fetch tap and
 * the dashboard cannot each invent their own version of "how much is this".
 */

/** Format microdollars as dollars. */
function dollars(microdollars: number): string {
  return formatDollars(usdToDollars(microdollars));
}

/**
 * One budget line: what was spent, what the ceiling is, and what is left.
 *
 * The remainder is only worth printing when there is a ceiling to be a
 * remainder *of* — with an unlimited budget, "∞ left" says nothing.
 */
function budgetLine(
  label: string,
  spent: string,
  ceiling: string | null,
  left: string,
): string {
  if (ceiling === null) return `  ${label}spent ${spent} / limit ∞`;
  return `  ${label}spent ${spent} / limit ${ceiling} (${left} left)`;
}

/**
 * What a process's budget says about it, in words.
 *
 * **A process that has run out of budget cannot go on, and the views have to
 * say so.**
 *
 * The kernel knows: `budgetsRemaining` is zero for the budget that ran out.
 * It used to be visible only in `cortex limit` — so a process that had been
 * parked because its wall-clock ceiling had passed looked exactly like one
 * that was merely waiting: a `ready` row that would never run again, and
 * nothing in the table said why. (The wall clock now runs on the kernel's
 * heartbeat, so that happens — a budget that only drained at a model call
 * could not run out while the agent was doing nothing.)
 *
 * The budget that ran out is named the way the kernel's own frames name it —
 * `tokens`, `usd`, `wallTime` (the `BudgetKind` vocabulary, ABI.md §6.1) — so
 * the table and a `__sched:sigxcpu(...)` frame name the same cause the same
 * way.
 *
 * Empty when the process still has budget: a view that says "out of tokens"
 * about a process with a million tokens left is worse than silence.
 */
export function describeBudget(remaining: BudgetLimits): string {
  const out: string[] = [];
  if (remaining.tokens === 0) out.push('tokens');
  if (remaining.usd === 0) out.push('usd');
  if (remaining.wallTimeMs === 0) out.push('wallTime');
  if (out.length === 0) return '';
  return `out of ${out.join(', ')}`;
}

/**
 * The three budget lines, in the order the CLI prints them.
 *
 * One function, so every view phrases a budget the same way — and so a
 * number that is not a limit is never printed as one.
 */
export function formatBudgetLines(facts: BudgetFacts): readonly string[] {
  // The token line counts exactly — no `k`, no rounding — because it is a
  // budget: the operator has to be able to add the numbers up. And it says
  // which part of the spend the provider served out of its cache, because
  // those tokens were billed at the cache price while the ceiling was charged
  // the full count for them.
  const spentTokens = formatTokenUsage(facts.spent, (n) => String(n));
  const tokenCeiling = tokenCeilingOf(facts);
  const usdCeiling = usdCeilingOf(facts);
  const wallCeiling = budgetCeiling(facts.spent.wallTimeMs, facts.remaining.wallTimeMs);

  return [
    budgetLine(
      'tokens:    ',
      spentTokens,
      tokenCeiling === null ? null : String(tokenCeiling),
      String(facts.remaining.tokens),
    ),
    budgetLine(
      'usd:       ',
      dollars(facts.spent.usdSpent),
      usdCeiling === null ? null : dollars(usdCeiling),
      dollars(facts.remaining.usd),
    ),
    budgetLine(
      'wall time: ',
      `${facts.spent.wallTimeMs}ms`,
      wallCeiling === null ? null : `${wallCeiling}ms`,
      `${facts.remaining.wallTimeMs}ms`,
    ),
  ];
}

/**
 * The token budget's ceiling: the total the process may ever spend.
 *
 * `null` means **unlimited**. The same computation the budget report uses,
 * so a table cell and the report cannot disagree about what the ceiling is.
 */
export function tokenCeilingOf(facts: BudgetFacts): number | null {
  return budgetCeiling(tokenUsage(facts.spent).total, facts.remaining.tokens);
}

/**
 * The money budget's ceiling: the total the process may ever spend.
 *
 * In **microdollars**, like the spend it is measured against — the conversion
 * to dollars happens in the cell, not in the number.
 */
export function usdCeilingOf(facts: BudgetFacts): number | null {
  return budgetCeiling(facts.spent.usdSpent, facts.remaining.usd);
}

/**
 * A spend, next to the ceiling it is measured against.
 *
 * **"1.2k (300 cached) of 10k"** — the spend, and the total it is a part of.
 *
 * The ceiling belongs next to the spend, and not in a column of its own,
 * because a number without the number it is measured against is a number
 * the operator has to guess about: "1.2k" on its own is 12% of a budget or
 * 99% of one, and the two need very different answers. The ceiling is the
 * one that is stable — the spend moves, the ceiling is what was granted.
 *
 * `∞` when the budget has no ceiling: the spend is unbounded, and saying so
 * is more useful than leaving it out.
 *
 * @param spent The spend, already formatted by whoever owns its shape.
 * @param ceiling The total it is measured against, or `null` for unlimited.
 * @param format How this view prints a number.
 */
export function formatBudgetCell(
  spent: string,
  ceiling: number | null,
  format: (n: number) => string,
): string {
  return `${spent} of ${ceiling === null ? '∞' : format(ceiling)}`;
}

/**
 * A process's token spend, next to the token budget's ceiling.
 *
 * The spend keeps the shape the token rule gives it — the total, and the
 * cached part in brackets (`src/token_usage.ts`) — and the ceiling comes
 * after it.
 *
 * @param facts What the process spent and what it has left.
 * @param format How this view prints a number. The CLI shortens (`1.2k`),
 *   the dashboard spells it out (`1,234`).
 */
export function formatTokenBudget(
  facts: BudgetFacts,
  format: (n: number) => string = formatTokens,
): string {
  return formatBudgetCell(
    formatTokenUsage(facts.spent, format),
    tokenCeilingOf(facts),
    format,
  );
}

/**
 * A process's money spend, next to the money budget's ceiling.
 *
 * Both numbers are printed in dollars, at the resolution the kernel counts
 * them (`src/money.ts`) — a ceiling printed at another resolution would not
 * add up to the spend beside it.
 */
export function formatUsdBudget(facts: BudgetFacts): string {
  return formatBudgetCell(dollars(facts.spent.usdSpent), usdCeilingOf(facts), dollars);
}
