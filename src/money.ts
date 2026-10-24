/**
 * Money, and only money.
 *
 * The kernel counts money in **microdollars** — an integer count, 1 USD =
 * 1_000_000 (docs/STATE.md §2.4). Two rules live here, and nowhere else:
 *
 *  1. the conversion between the kernel's unit and dollars, and
 *  2. the format money is printed in.
 *
 * ## Why the format is not a preference
 *
 * One model call costs about **$0.000027**. Printed to four decimals that is
 * `$0.0000` — and a run that spent real money then reads as a run that spent
 * nothing. That is not a rounding curiosity; it is the difference between a
 * budget that is being watched and a budget that is being wished for.
 *
 * It was worth getting wrong, twice, in two directions:
 *
 * - `cortex top` printed four decimals, so a tapped run that had spent
 *   $0.000027 was shown as **$0.0000 spent**.
 * - The dashboard's budget panel printed four decimals too, so the operator's
 *   window said the same thing — while the dashboard's *event* row, and
 *   `cortex limit`, both said `$0.000027`, from the same record.
 *
 * Two views of one process's cost, one of them rounding the cost away.
 *
 * **Six decimals is not a taste.** It is the resolution the kernel counts at:
 * one microdollar. A format with fewer digits cannot say what the kernel
 * knows, and a number that cannot say what the kernel knows is not a number,
 * it is a rumour.
 *
 * ## Why it is its own module
 *
 * Money is the one fact that three different layers have to print: the CLI
 * (`cortex top`, `cortex limit`, `cortex wrap --tap`), the fetch tap (its
 * budget-exceeded error), and the dashboard (which reads the dollars the
 * server already converted). A rule that only the CLI layer can reach is a
 * rule the other two will each reinvent — and they did.
 *
 * @module money
 */

/** Microdollars in one dollar. The kernel's unit, in one place. */
export const MICRODOLLARS_PER_DOLLAR = 1_000_000;

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
  return microdollars / MICRODOLLARS_PER_DOLLAR;
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
  return Math.round(dollars * MICRODOLLARS_PER_DOLLAR);
}

/**
 * Money, as it is printed.
 *
 * Six decimals: the resolution the kernel counts at. Zero is not a special
 * case — `$0.000000` is a true answer, and a column of money keeps one
 * shape.
 *
 * The dashboard page cannot import this (it is a static file served over
 * HTTP), so it keeps its own copy of the rule — and a smoke check holds the
 * two to the same string.
 */
export function formatDollars(usd: number): string {
  return `$${usd.toFixed(6)}`;
}
