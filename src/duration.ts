/**
 * A duration, and only a duration.
 *
 * The kernel counts time in **milliseconds** — an integer count (docs/STATE.md
 * §2.4). Two rules live here, and nowhere else:
 *
 *  1. the unit a duration is printed in, and
 *  2. how much of it is thrown away.
 *
 * ## Why the format is not a preference
 *
 * A duration has to be readable at a glance, and `18000ms` is not. The unit
 * follows the size of the number — milliseconds under a second, seconds under
 * a minute, minutes under an hour, hours after that — so one span reads the
 * same way everywhere: the process table's **AGE** column, the kernel's
 * uptime, and a budget's remaining time are one rule, not three.
 *
 * ## Why there are two of them
 *
 * An **age** is a rounded answer: "how long has this been running" wants `3m`,
 * not `2m30s`. A **remainder** is not — it is a number the operator acts on,
 * and rounding it turns `9m58s left` into `10m left`, which reads as a budget
 * that is still full when it is nearly empty. It can also turn a remainder
 * into the ceiling it belongs to (`1m left of 1m`), which reads as an empty
 * budget when there is a minute on the clock.
 *
 * So a remainder is **exact to the second**, and the two are told apart by
 * what they are for.
 *
 * ## Why it is its own module
 *
 * A duration is the one fact that three layers have to print: the CLI (the
 * **AGE** column, `cortex top`, the kernel's uptime), the dashboard (the
 * 存活时长 column and the budgets panel), and the budget wording (what is
 * left of the wall clock). A rule only one layer can reach is a rule the
 * other two will each reinvent — and they did.
 *
 * @module duration
 */

/**
 * A duration, rounded to the unit it is printed in.
 *
 * `18000ms` → `18s`, `120000ms` → `2m`, `12600000ms` → `3.5h`.
 *
 * The rounding is the age's: it is a question about how long something has
 * been going on, and `3m` is the answer a person wants. A number that is
 * **acted on** — a budget's remainder — is printed by
 * {@link formatExactDuration} instead.
 */
export function formatDuration(ms: number): string {
  if (ms < 0 || ms < 1000) return `${Math.max(ms, 0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * A duration, exact to the second.
 *
 * `598483ms` → `9m58s`, `600000ms` → `10m`, `90000ms` → `1m30s`,
 * `3600000ms` → `1h`.
 *
 * Nothing is rounded away, so **two numbers printed this way can only be
 * equal when they really are**. That is the whole point of the second rule: a
 * remainder and the ceiling it belongs to are printed together, and rounding
 * either of them would let the pair say "nothing left" while the clock is
 * still running.
 */
export function formatExactDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  if (total < 1000) return `${total}ms`;
  const seconds = Math.floor(total / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds === 0 ? `${minutes}m` : `${minutes}m${restSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h${restMinutes}m`;
}
