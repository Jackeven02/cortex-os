/**
 * cortex CLI — what a view says about a process, in one cell, in one order.
 *
 * ## The rule
 *
 * **One cell, one order, one rule — in every view.**
 *
 * A process table has room for exactly one note per row, so the facts about
 * that process have to be put in an order, and the order *is* the rule: which
 * fact the operator reads first.
 *
 * The order is the order of how much the fact decides:
 *
 * 1. **How it ended.** A dead process is not waiting for anything, and its
 *    ending is the only thing left to say about it.
 * 2. **That it has run out of budget.** A process whose ceiling has been
 *    reached cannot go on — and if it is parked, nothing else in the row says
 *    why it is not making progress.
 * 3. **That it was parked at a checkpoint**, and the command that brings it
 *    back. A parked process is not waiting for anything — it is stopped on
 *    purpose — so this and the next one never both apply.
 * 4. **What it is waiting on**, and what is waiting for it.
 *
 * The dashboard's page, `cortex ps` and `cortex top` all use this order, so
 * a table, a tree and a page cannot disagree about which fact comes first.
 *
 * @module cli/process_note
 */

/**
 * The facts a view has about one process.
 *
 * Every part is optional: a view may know some of them and not others, and a
 * part that is empty is simply not said.
 */
export interface ProcessNoteParts {
  /** How the process ended, if it has. */
  readonly ending?: string | undefined;
  /** That it has run out of budget, if it has. */
  readonly budget?: string | undefined;
  /**
   * That it was parked at a checkpoint, and the command that brings it back.
   *
   * The words come from `describeCheckpointPark` (one rule, shared with the
   * checkpoint command and the dashboard), so a parked process cannot be
   * described one way in the table and another way in the window.
   */
  readonly checkpoint?: string | undefined;
  /** What it is waiting on, and what is waiting for it. */
  readonly waiting?: string | undefined;
}

/**
 * The note for one process: the facts that are there, in the order above.
 *
 * A process that has ended says **only** how it ended — the other facts are
 * about a process that is still there.
 */
export function processNote(parts: ProcessNoteParts): string {
  const ending = parts.ending ?? '';
  if (ending !== '') return ending;
  const rest = [
    parts.budget ?? '',
    parts.checkpoint ?? '',
    parts.waiting ?? '',
  ].filter((part) => part !== '');
  return rest.join(' — ');
}
