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
 * Microdollars → dollars.
 *
 * `budgetsSpent.usdSpent` is in **microdollars** — an integer count, 1 USD =
 * 1_000_000 (docs/STATE.md §2.4). Every place that puts that number in front
 * of a human converts here, and only here: a second copy of this division is
 * a second chance to be wrong by a million.
 *
 * It was worth getting wrong. `cortex top` divided and the dashboard did not,
 * so the operator's window said a process that spent **$0.0034** had spent
 * **$3400.0000** — a thousand times the money, which is the kind of number
 * that gets a budget cut.
 */
export function usdToDollars(microdollars: number): number {
  return microdollars / 1_000_000;
}

/**
 * Dollars → microdollars, the unit `budgetsSpent.usdSpent` is in.
 *
 * Used where a number from outside the kernel — a tap's price, a driver's
 * usage — is folded into the budget. Rounded because the field is an integer
 * count of microdollars, and clamped at zero because a spend is never
 * negative.
 */
export function dollarsToMicrodollars(dollars: number): number {
  if (!Number.isFinite(dollars) || dollars <= 0) return 0;
  return Math.round(dollars * 1_000_000);
}

/** Format microdollars as dollars. */
function dollars(microdollars: number): string {
  return `$${usdToDollars(microdollars).toFixed(6)}`;
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
 * The three budget lines, in the order the CLI prints them.
 *
 * One function, so every view phrases a budget the same way — and so a
 * number that is not a limit is never printed as one.
 */
export function formatBudgetLines(facts: BudgetFacts): readonly string[] {
  const spentTokens = facts.spent.tokensIn + facts.spent.tokensOut;
  const tokenCeiling = budgetCeiling(spentTokens, facts.remaining.tokens);
  const usdCeiling = budgetCeiling(facts.spent.usdSpent, facts.remaining.usd);
  const wallCeiling = budgetCeiling(facts.spent.wallTimeMs, facts.remaining.wallTimeMs);

  return [
    budgetLine(
      'tokens:    ',
      String(spentTokens),
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
