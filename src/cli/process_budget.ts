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
import { formatDollars, usdToDollars } from '../money.js';

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
