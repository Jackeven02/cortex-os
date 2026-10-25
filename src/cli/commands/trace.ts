/**
 * cortex CLI — `cortex trace`
 *
 * BACKLOG #033: *"strace-style syscall log, live or from .crec file."*
 *
 * Reads a `.crec` file from disk. Does NOT boot a kernel.
 *
 * Usage:
 *   cortex trace <pid>            — read the .crec file for <pid>
 *   cortex trace <file.crec>      — read a specific .crec file
 *
 * @module cli/commands/trace
 */

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { defaultKernelDir, existingCrecPath } from '../index.js';
import { readRecords } from '../../kernel/recorder.js';
import { unbrand, asProcessId, BUDGET_KINDS, BLOCKED_KINDS, NICE_MAX, NICE_MIN, type SyscallRecord } from '../../kernel/types.js';
import { PROCESS_STATES, STATE_TRIGGERS } from '../../kernel/process_table.js';
import { ALL_SIGNALS, DELIVERY_OUTCOMES } from '../../kernel/signals.js';
import { INIT_ACTIONS } from '../../kernel/init.js';
import { DISPATCH_ACTIONS, DISPATCH_EXITS, SCHED_ACTIONS } from '../../kernel/scheduler.js';
import { renderHeader, renderRow, ruleUnder, type Column } from '../table.js';
import { frameName } from '../frame_name.js';
import { callUsage, formatCallUsage, formatTokens } from '../../token_usage.js';
import { formatDollars } from '../../money.js';

/** The length of the longest string in a list. */
function longest(values: readonly string[]): number {
  return values.reduce((max, value) => Math.max(max, value.length), 0);
}

/**
 * How wide the pid column is — seven characters, which is the widest pid the
 * table accounts for.
 *
 * It is here because **two** things depend on it: the column itself, and the
 * actor a `__sched:renice` frame names (`agent:<pid>`), which is a pid too.
 * One number, so the two cannot drift apart.
 */
const TRACE_PID_WIDTH = 7;

/**
 * How wide the syscall column has to be so that **no** frame name the naming
 * rule can produce is ever cut short.
 *
 * This used to be a number somebody typed. That is how the header and the
 * rows came to disagree: the width was a guess, the names were not, and a
 * name one character too long pushed every column after it to the right —
 * so the row stopped lining up with the heading above it, and the reader
 * could no longer tell which column they were looking at.
 *
 * So the width is **derived** from the kernel's own value domains:
 *
 * - `__state:` + *state* + `->` + *state* + `(` + *cause* + `)` — the
 *   longest state is `checkpointing` (13) and the longest cause is
 *   `init-register-daemon` (20), so 58;
 * - `__signal:` + *signal* + `(` + *outcome* + `)` — 27;
 * - `__init:` + *action* — 23 (`restart-gave-up`);
 * - `__sched:` + *action* + `(` + *cause* + `)` — the longest is
 *   `__sched:exited(reaped-during-quantum)` (36).
 *
 * The lists come from the kernel modules themselves, so a new state, a new
 * signal, a new supervision action or a new transition cause widens the
 * column automatically. There is nothing here to remember to update.
 */
export const TRACE_SYSCALL_WIDTH = Math.max(
  '__state:'.length +
    longest(PROCESS_STATES) +
    '->'.length +
    longest(PROCESS_STATES) +
    '('.length +
    longest(STATE_TRIGGERS) +
    ')'.length,
  '__signal:'.length + longest(ALL_SIGNALS) + '('.length + longest(DELIVERY_OUTCOMES) + ')'.length,
  '__init:'.length + longest(INIT_ACTIONS),
  // `__sched:` + *action* — and, when the frame recorded one, the cause it
  // recorded: which budget ran out, what the process was waiting on, why it
  // was gone. The widest is `__sched:exited(reaped-during-quantum)`.
  '__sched:'.length + longest(SCHED_ACTIONS),
  '__sched:'.length + 'sigxcpu'.length + '('.length + longest(BUDGET_KINDS) + ')'.length,
  '__sched:'.length + 'blocked'.length + '('.length + longest(BLOCKED_KINDS) + ')'.length,
  '__sched:'.length + 'exited'.length + '('.length + longest(DISPATCH_EXITS) + ')'.length,
  // `__sched:renice(<from>-><nice> by <who>)` — two ranks, both of which can be
  // the widest the kernel holds, so the width is derived from the range rather
  // than from the numbers that happened to be in a log; and the actor, which
  // is either the operator or an agent's pid — bounded by the pid column.
  '__sched:'.length +
    'renice'.length +
    '('.length +
    String(NICE_MIN).length +
    '->'.length +
    String(NICE_MAX).length +
    ' by '.length +
    Math.max('operator'.length, 'agent:'.length + TRACE_PID_WIDTH) +
    ')'.length,
);

/**
 * How wide the spend column has to be.
 *
 * Derived from the rule, the same way the syscall column is: the widest cell
 * is the one the formatter can produce, and it is produced here, once, by
 * asking the formatter itself.
 *
 * The width only reserves space — a row that spent nothing ends where its own
 * content ends, and the heading is trimmed with it — so the reservation is
 * the **worst case** rather than a typical one. That way a call that spent a
 * lot is never cut short, which is the one thing a spend column must not do.
 *
 * The ceiling is the one the rest of the project uses for tokens
 * (`cortex ps`, `cortex top`): ten digits. The money is the ceiling
 * `cortex top`'s USD column uses — four digits and six decimals, because six
 * decimals is the resolution the kernel counts at (docs/STATE.md §2.4).
 */
export const TRACE_SPEND_WIDTH =
  formatCallUsage(
    {
      inputTokens: 9_999_999_999,
      outputTokens: 9_999_999_999,
      cachedTokens: 9_999_999_999,
      usd: 0,
    },
    formatTokens,
  ).length +
  ' · '.length +
  formatDollars(1234.567890).length;

/**
 * The columns of the trace table, in order: the header, the width of the
 * cell, and the gap that follows it.
 *
 * **One list, so the header and the rows cannot drift apart.** The header
 * used to be a hand-typed string, and it had drifted: its "phase" sat five
 * columns to the right of where the rows printed theirs, and the rule under
 * it was longer than the header it ruled. Reading a row meant counting
 * characters. Now the header is generated from the same layout the rows use.
 */
const TRACE_COLUMNS: readonly Column[] = [
  { header: 'time', width: 12, gap: 2 },
  { header: 'pid', width: TRACE_PID_WIDTH, gap: 1 },
  { header: 'syscall', width: TRACE_SYSCALL_WIDTH, gap: 1 },
  { header: 'phase', width: 6, gap: 1 },
  { header: 'duration', width: 10, gap: 1 },
  // `reversibility` is 13 characters — the longest value is `irreversible`,
  // and the heading itself is longer still.
  { header: 'reversibility', width: 13, gap: 1 },
  // What a frame that spent something spent. Empty for every frame that spent
  // nothing, which is most of them — and empty is honest: a state transition
  // costs nothing, and a cell that said "$0.000000" would be a claim.
  { header: 'spend', width: TRACE_SPEND_WIDTH, gap: 0 },
];

/**
 * What a frame that spent something spent.
 *
 * The rule: **a syscall that spent something says what it spent.** The
 * kernel records the usage of a model call in the frame's result — the
 * tokens it read and wrote, the part of the input that came out of the
 * provider's cache, and the price — and the trace used to print none of it.
 * The dashboard's event table said it; the CLI's deepest view did not.
 *
 * Two things decide the shape:
 *
 * - **The money comes first**, because it is what the column is about, and
 *   because a cell that is too wide is cut from the end — the tail is the
 *   cached count, and the price is not the thing to lose.
 * - **Only what the frame reported is printed.** A frame that reported a
 *   price and no tokens says the price; a frame that reported tokens and no
 *   price says the tokens. A frame that reported neither says nothing, and a
 *   cell that said "$0.000000" would be a claim about a number nobody spent.
 */
function spendCell(rec: SyscallRecord): string {
  const usage = callUsage(rec.syscall, rec.result);
  if (usage === undefined) return '';
  const parts: string[] = [];
  if (usage.usd !== undefined) parts.push(formatDollars(usage.usd));
  const tokens = formatCallUsage(usage, formatTokens);
  if (tokens !== '') parts.push(tokens);
  return parts.join(' · ');
}

/**
 * Render one syscall record as a fixed-width `trace`/`attach` line.
 *
 * Shared by `cortex trace` and `cortex attach` so both commands print an
 * identical column layout for the same `.crec` file. Keep this the single
 * source of truth for the on-disk log's human-readable shape.
 */
export function formatRecordLine(rec: SyscallRecord): string {
  return renderRow(TRACE_COLUMNS, [
    rec.timestamp.substring(11, 23), // HH:MM:SS.mmm
    String(unbrand(rec.pid)),
    frameName(rec),
    rec.phase,
    rec.durationMs !== undefined ? `${rec.durationMs}ms` : '-',
    rec.reversibility,
    spendCell(rec),
  ]);
}

/** The header row that goes with {@link formatRecordLine}. */
export const TRACE_HEADER = renderHeader(TRACE_COLUMNS);

/** The rule under the header. */
export const TRACE_RULE = ruleUnder(TRACE_HEADER);

export async function cmdTrace(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`cortex trace — strace-style syscall log

USAGE
  cortex trace <pid>           Read the .crec log for the given PID
  cortex trace <file.crec>     Read a specific .crec file

OPTIONS
  -h, --help   Show this help

COLUMNS
  time           when the frame was recorded
  pid            the process the frame belongs to
  syscall        what was called — and the kernel's own frames, named after
                 what distinguishes them (__state:running->blocked(recv))
  phase          enter (the call started) or exit (it finished)
  duration       how long it took
  reversibility  whether it can be undone
  spend          what the call spent: the price first, then the tokens it read
                 and wrote, and the part of the input the provider served out
                 of its cache. A frame that spent nothing says nothing

EXAMPLES
  cortex trace 2
  cortex trace .cortex/processes/2.crec
`);
    return values.help ? 0 : 1;
  }

  const target = positionals[0]!;

  // Determine the .crec file path.
  let crecFile: string;
  if (existsSync(target) && target.endsWith('.crec')) {
    crecFile = target;
  } else {
    // Treat as PID.
    const pid = Number(target);
    if (!Number.isInteger(pid) || pid < 0) {
      console.error(`cortex trace: invalid PID or file: '${target}'`);
      return 1;
    }
    const dir = defaultKernelDir();
    crecFile = existingCrecPath(dir, asProcessId(pid));
    if (!existsSync(crecFile)) {
      console.error(`cortex trace: no .crec file at '${crecFile}'`);
      console.error(`  (did you 'cortex spawn' this PID?)`);
      return 1;
    }
  }

  // Read and print records.
  console.log(`# tracing ${crecFile}`);
  console.log(TRACE_HEADER);
  console.log(TRACE_RULE);

  let count = 0;
  for await (const rec of readRecords(crecFile) as AsyncGenerator<SyscallRecord>) {
    console.log(formatRecordLine(rec));
    count++;
  }

  console.log(`# ${count} record(s)`);
  return 0;
}
