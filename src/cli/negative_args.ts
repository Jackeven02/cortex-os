/**
 * cortex CLI — arguments whose value may be a negative number.
 *
 * ## The problem
 *
 * `cortex spawn --nice -7` is the spelling an operator reaches for: the
 * kernel's priority is negative more often than not, because the whole point
 * of a priority is to run *sooner*. And Node's argument parser reads a value
 * that starts with a dash as **another option**, not as a value:
 *
 * ```console
 * $ cortex spawn --nice -7
 * Option '--nice' argument is ambiguous.
 * ```
 *
 * `--nice=-7` is the same flag and the parser is happy with it — but the
 * operator has to know that, and a flag whose natural spelling fails is a
 * flag people give up on.
 *
 * ## The rule
 *
 * An option that is allowed to take a negative number gets it, in the spaced
 * spelling too: the pair `--nice -7` is rewritten to `--nice=-7` before the
 * parser ever sees it. Nothing else is touched — a value that does not start
 * with a digit is left exactly as it was, so `--nice --live` still means
 * "--nice, with the option --live", and a mistake is still a mistake.
 *
 * @module cli/negative_args
 */

/**
 * Rewrite `--flag -3` into `--flag=-3`, for the flags that may take a
 * negative number.
 *
 * @param args The arguments as the operator typed them.
 * @param options The flags whose value may be negative, spelled the way the
 *   operator types them (`--nice`).
 */
export function rewriteNegativeValues(
  args: readonly string[],
  options: readonly string[],
): string[] {
  const takesNegative = new Set(options);
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const next = args[i + 1];
    // A value that is a dash followed by a digit is a negative number. A
    // dash followed by anything else is another option, and the parser
    // should keep saying so.
    if (takesNegative.has(arg) && next !== undefined && /^-\d/.test(next)) {
      out.push(`${arg}=${next}`);
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}
