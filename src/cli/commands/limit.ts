/**
 * cortex CLI — `cortex limit`
 *
 * BACKLOG #037: *"set token / cost / time budgets per process."*
 *
 * ## The two things it does
 *
 * **Show a process's budget, and change it.** Both need the right source:
 *
 * - **A live kernel is running** (`cortex daemon run`): the kernel's own
 *   process table is authoritative, and it is the *only* source for a running
 *   agent — a running process has no `meta.json` yet, because the kernel
 *   writes that when the process exits.
 * - **No live kernel**: the on-disk exit record answers for a process that
 *   has finished, and nothing can answer for one that is still running
 *   somewhere else.
 *
 * The command used to boot a kernel of its own and look there. That kernel
 * holds nothing but init, so the command could never see — let alone
 * change — the budget of any process an operator cared about: it answered
 * "no such process" for an agent that `cortex ps` was showing as running.
 *
 * ## What a budget is
 *
 * A budget has a **ceiling** (the total the process may ever spend) and a
 * **remainder** (what it has left). They are not the same number, and the
 * remainder shrinks as the process spends. So:
 *
 * - `--tokens N` means **the ceiling is N** — what the help says, and what an
 *   operator means by it. The kernel keeps the remainder, so the ceiling is
 *   converted on the way in, against the spend read at the same moment.
 * - What the command prints is the ceiling, and then what is left of it.
 *   Printing the remainder and calling it "the limit" is how a number that
 *   moves under the operator's feet gets read as a fixed promise.
 *
 * @module cli/commands/limit
 */

import { parseArgs } from 'node:util';
import { defaultKernelDir, parsePid, readMeta } from '../index.js';
import { formatBudgetLines, type BudgetFacts } from '../process_budget.js';
import { KernelCommandError, probeKernel } from '../kernel_client.js';
import { unbrand, type BudgetCounters, type BudgetLimits } from '../../kernel/types.js';

export async function cmdLimit(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      tokens: { type: 'string' },
      usd: { type: 'string' },
      'wall-time': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`cortex limit — show or set a process's resource budget

USAGE
  cortex limit <pid> [options]

OPTIONS
  --tokens <n>       Total token budget (input + output)
  --usd <n>          Total USD budget (in dollars)
  --wall-time <ms>   Total wall-clock time budget in milliseconds
  -h, --help         Show this help

EXAMPLES
  cortex limit 2                    # what has pid 2 spent, and what is left of it
  cortex limit 2 --tokens 10000     # pid 2 may spend 10000 tokens in total
  cortex limit 2 --usd 0.50         # …and $0.50 in total
  cortex limit 2 --wall-time 60000  # …and 60 seconds of wall-clock time

NOTES
  A budget has a ceiling and a remainder, and they are not the same number:
  the remainder shrinks as the process spends, so the command prints the
  ceiling (what the process may spend in total) and then what is left of it.

  Setting a budget needs a live kernel ('cortex daemon run'), because a
  budget is a thing a running process has. Without one, the command can still
  show what a finished process spent.

  Setting a budget on a process that is not running is refused: the record of
  what it spent is the kernel's, and rewriting it would be rewriting history.
`);
    return values.help ? 0 : 1;
  }

  const pid = parsePid(positionals[0]!);
  const tokens = values.tokens !== undefined ? parseInt(values.tokens, 10) : undefined;
  const usd = values.usd !== undefined ? parseFloat(values.usd) : undefined;
  const wallTime = values['wall-time'] !== undefined ? parseInt(values['wall-time'], 10) : undefined;

  if (tokens !== undefined && (!Number.isFinite(tokens) || tokens < 0)) {
    console.error(`cortex limit: invalid --tokens: '${values.tokens}'`);
    return 1;
  }
  if (usd !== undefined && (!Number.isFinite(usd) || usd < 0)) {
    console.error(`cortex limit: invalid --usd: '${values.usd}'`);
    return 1;
  }
  if (wallTime !== undefined && (!Number.isFinite(wallTime) || wallTime < 0)) {
    console.error(`cortex limit: invalid --wall-time: '${values['wall-time']}'`);
    return 1;
  }
  const setting = tokens !== undefined || usd !== undefined || wallTime !== undefined;

  const dir = defaultKernelDir();
  const probe = await probeKernel(dir);
  const client = probe.kind === 'live' ? probe.client : undefined;
  try {
    if (client !== undefined) {
      try {
        const reply = await client.request<{
          pid: number;
          role: string;
          spent: BudgetCounters;
          remaining: BudgetLimits;
        }>('limit', {
          pid: unbrand(pid),
          ...(tokens !== undefined ? { tokens } : {}),
          // The wire speaks the ABI's unit: microdollars (ABI.md §4.8).
          ...(usd !== undefined ? { usd: Math.round(usd * 1_000_000) } : {}),
          ...(wallTime !== undefined ? { wallTimeMs: wallTime } : {}),
        });
        printBudget(pid, reply.role, { spent: reply.spent, remaining: reply.remaining }, setting);
        return 0;
      } catch (err) {
        if (!(err instanceof KernelCommandError)) throw err;
        if (err.errno !== 'ESRCH') {
          console.error(`cortex limit: ${err.errno}: ${err.message}`);
          return 1;
        }
        // The kernel does not hold this process: it has finished (or it
        // belongs to another kernel). Fall through to the disk.
      }
    }

    if (setting) {
      console.error(
        `cortex limit: pid ${pid} is not running — a budget is a thing a running process has.`,
      );
      console.error(
        `  (start a kernel with 'cortex daemon run', then 'cortex limit ${pid} --tokens N')`,
      );
      return 1;
    }

    // No live kernel, or it does not hold this process: the on-disk record.
    const meta = readMeta(dir, pid);
    if (meta === undefined) {
      console.error(`cortex limit: no such process: ${pid} (no .meta.json found)`);
      console.error(`  (did you 'cortex spawn' this PID?)`);
      return 1;
    }
    printBudget(
      pid,
      meta.role,
      { spent: meta.budgetsSpent, remaining: meta.budgetsRemaining },
      false,
    );
    return 0;
  } finally {
    client?.close();
  }
}

/**
 * Print a process's budget.
 *
 * The *same* lines whether the numbers came from a live kernel or from the
 * on-disk record — one rule, and an operator comparing the two does not have
 * to work out whether they are looking at the same kind of number.
 */
function printBudget(
  pid: number,
  role: string,
  facts: BudgetFacts,
  justSet: boolean,
): void {
  console.log(`${justSet ? 'set the budget for' : 'pid'} ${pid} (${role}):`);
  for (const line of formatBudgetLines(facts)) console.log(line);
}
