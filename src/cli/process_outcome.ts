/**
 * cortex CLI — how a process ended.
 *
 * ## The rule
 *
 * **A missing exit code is not a success.**
 *
 * It is the absence of an answer, and turning it into zero tells the shell
 * that a failed run passed. Every command that reports how a process ended
 * has to answer the same question — *what do I know, and what do I not
 * know?* — and they have to answer it the same way, or the CLI contradicts
 * itself: one command says "code 1" and the next says "code 0" for the same
 * run.
 *
 * ## Where the "not knowing" comes from
 *
 * A process is on its way out (`EXITING`) before its exit frame has been
 * written, and a host that reads the table in that window used to find no
 * exit code. Two disk writes sit between the process becoming EXITING and
 * the code being recorded — and a CLI that read the window said "no code",
 * then defaulted it to zero. So `cortex spawn` on an agent that threw a
 * `TypeError` sometimes printed `code 0: completed` and exited 0.
 *
 * The kernel no longer has that window (the outcome is recorded when it is
 * *decided*, before the EXITING transition — docs/PROCESS.md §3.8), and this
 * module is what the CLI falls back on when it still does not know: an
 * unknown ending is reported as **unknown**, never as success.
 *
 * ## What the sources are
 *
 * - **The table entry** — the kernel's own answer, live and exact.
 * - **The exit record** — the durable answer, read from the process's `.crec`
 *   (`readExitRecord` in `process_store.ts`). It survives the reap, so it is
 *   what a CLI has when the process is already gone.
 *
 * @module cli/process_outcome
 */

import type { ProcessState } from '../kernel/types.js';

/** The part of a table entry that says how the process ended. */
export interface OutcomeEntry {
  readonly state: ProcessState;
  readonly exitCode: number | null;
  readonly exitReason: string | null;
}

/** The durable exit facts, read from a process's log. */
export interface ExitRecord {
  readonly code: number;
  readonly reason: string;
}

/** What the CLI knows about how a process ended. */
export interface ProcessOutcome {
  /** The state the process was in when it was last seen. */
  readonly state: ProcessState;
  /** The exit code, or `null` when it was never seen. */
  readonly exitCode: number | null;
  /** The exit reason, or `null` when it was never seen. */
  readonly exitReason: string | null;
}

/**
 * What the CLI says about a process that ended without a code anyone saw.
 *
 * One, not zero: a run whose ending is unknown did not succeed, and a
 * command that reports zero for it tells CI that a broken build passed.
 */
const UNKNOWN_EXIT_CODE = 1;

/**
 * Combine what the table knows with what the log knows.
 *
 * The rules, in the order they are asked:
 *
 * 1. **Reaped** — the entry is gone. The exit record is the answer; without
 *    one the ending is unknown, and unknown is not success.
 * 2. **Zombie** — the process is done and the kernel knows how it ended.
 * 3. **Exiting** — the process is on its way out. The outcome may or may not
 *    have been decided yet; whatever is not known stays unknown.
 * 4. **Suspended** — a clean pause, not a failure.
 * 5. **Anything else** — still running; there is no ending to report.
 */
export function processOutcome(
  entry: OutcomeEntry | undefined,
  exitRecord: ExitRecord | undefined,
): ProcessOutcome {
  if (entry === undefined) {
    // Reaped: recover the REAL status from the exit record rather than
    // assuming success, or a killed run would print "code 0: completed".
    return {
      state: 'zombie',
      exitCode: exitRecord?.code ?? UNKNOWN_EXIT_CODE,
      exitReason:
        exitRecord?.reason ?? 'reaped with no exit record (crashed or killed before recording)',
    };
  }
  if (entry.state === 'zombie') {
    return {
      state: 'zombie',
      exitCode: entry.exitCode ?? exitRecord?.code ?? UNKNOWN_EXIT_CODE,
      exitReason: entry.exitReason ?? exitRecord?.reason ?? 'unknown ending',
    };
  }
  if (entry.state === 'exiting') {
    // The code is not known yet — or, on a kernel that has not been fixed,
    // it is not known *yet*. Whatever is available is used; what is not
    // available stays **unknown**. A null code is reported as "the run never
    // finished", never as success.
    return {
      state: 'exiting',
      exitCode: entry.exitCode ?? exitRecord?.code ?? null,
      exitReason: entry.exitReason ?? exitRecord?.reason ?? null,
    };
  }
  if (entry.state === 'suspended') {
    return { state: 'suspended', exitCode: 0, exitReason: 'checkpointed (suspended)' };
  }
  return { state: entry.state, exitCode: null, exitReason: null };
}

/**
 * How a command reports an outcome on the terminal.
 *
 * An unknown code prints as `?`, because `?` is a question and `0` is an
 * answer — and the answer would be a lie.
 */
export function formatOutcomeCode(exitCode: number | null): string {
  return exitCode === null ? '?' : String(exitCode);
}

/**
 * How a process's ending is said out loud.
 *
 * **The ending is a fact the kernel has, and every view has to say it.**
 *
 * `cortex top` said it — `exit 1 (cannot read properties of undefined ...)` —
 * and the two views an operator reads *first* did not. `cortex ps` and the
 * dashboard's process table both showed the same word for a run that finished
 * and a run that died: `zombie`. So "did it finish, or did it crash?" — the
 * first question about an agent — needed a second command to answer, and the
 * answer was sitting in the row the whole time (`ProcessRow` has carried
 * `exitCode` and `exitReason` from the start).
 *
 * The wording lives here, next to the rules about unknown endings, because
 * three views answer this question and they must not phrase it differently:
 * an operator who reads "exit 1 (boom)" in the tree and "crashed" in the
 * table has to work out whether those are the same thing.
 *
 * A process that has not ended has no ending to report, and this says
 * nothing at all — the empty string is not "it ended cleanly".
 */
export function describeOutcome(row: OutcomeEntry): string {
  if (row.state !== 'zombie') return '';
  if (row.exitReason === null) return 'exited';
  return `exit ${formatOutcomeCode(row.exitCode)} (${row.exitReason})`;
}
