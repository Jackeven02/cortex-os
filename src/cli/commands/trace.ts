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
import { unbrand, asProcessId, type SyscallRecord } from '../../kernel/types.js';
import { PROCESS_STATES } from '../../kernel/process_table.js';
import { ALL_SIGNALS, DELIVERY_OUTCOMES } from '../../kernel/signals.js';
import { INIT_ACTIONS } from '../../kernel/init.js';
import { DISPATCH_ACTIONS } from '../../kernel/scheduler.js';

/** The length of the longest string in a list. */
function longest(values: readonly string[]): number {
  return values.reduce((max, value) => Math.max(max, value.length), 0);
}

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
 * - `__state:` + *state* + `->` + *state* — the longest state is
 *   `checkpointing` (13), so `__state:checkpointing->checkpointing` is 36;
 * - `__signal:` + *signal* + `(` + *outcome* + `)` — 27;
 * - `__init:` + *action* — 23 (`restart-gave-up`);
 * - `__sched:` + *action* — 15.
 *
 * The lists come from the kernel modules themselves, so a new state, a new
 * signal or a new supervision action widens the column automatically. There
 * is nothing here to remember to update.
 */
export const TRACE_SYSCALL_WIDTH = Math.max(
  '__state:'.length + longest(PROCESS_STATES) + '->'.length + longest(PROCESS_STATES),
  '__signal:'.length + longest(ALL_SIGNALS) + '('.length + longest(DELIVERY_OUTCOMES) + ')'.length,
  '__init:'.length + longest(INIT_ACTIONS),
  '__sched:'.length + longest(DISPATCH_ACTIONS),
);

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
const TRACE_COLUMNS: readonly (readonly [header: string, width: number, gap: number])[] = [
  ['time', 12, 2],
  ['pid', 7, 1],
  ['syscall', TRACE_SYSCALL_WIDTH, 1],
  ['phase', 6, 1],
  ['duration', 10, 1],
  // `reversibility` is 13 characters — the longest value is `irreversible`,
  // and the heading itself is longer still.
  ['reversibility', 13, 0],
];

/**
 * Fit a cell to its column.
 *
 * A cell that is too long is **cut, and marked** — a name that does not fit
 * is a fact that does not fit, and silently dropping its tail would be the
 * same lie this whole table exists to avoid. The `…` says "there was more
 * here". (Nothing the kernel records can actually reach this: the syscall
 * column is sized for the widest name the kernel can produce, so only a
 * driver that registers an unusually long syscall name could.)
 */
function fit(cell: string, width: number): string {
  if (cell.length <= width) return cell.padEnd(width);
  if (width <= 1) return cell.slice(0, width);
  return `${cell.slice(0, width - 1)}…`;
}

/** Render one row of cells in the shared layout. */
function renderRow(cells: readonly string[]): string {
  const parts = cells.map((cell, i) => {
    const column = TRACE_COLUMNS[i];
    if (column === undefined) return cell;
    const [, width, gap] = column;
    return `${fit(cell, width)}${' '.repeat(gap)}`;
  });
  return parts.join('').trimEnd();
}

/**
 * The name a frame is shown under.
 *
 * A real syscall is named by itself. The kernel's own bookkeeping frames
 * (`__state`, `__init`, `__sched`, `__signal`) are **placeholders** — and
 * every one of them used to print as the same anonymous word, so a log full
 * of them said nothing at all. Ten rows reading `__init` tell an operator
 * that ten things happened and not what they were.
 *
 * That mattered most for **init's log, which is the supervision journal**:
 * the durable record of every restart decision the kernel made, and the one
 * place the answer to "what did the supervisor do?" is kept. The decision is
 * in the frame's `action`, and the frame's name left it out.
 *
 * So the name carries what distinguishes the frame: the action for `__init`
 * and `__sched`, the transition for `__state`, the signal (and what became
 * of it) for `__signal`. The recorded syscall name is untouched — the `.crec`
 * format is frozen, and this is a *view* of it, not a change to it.
 */
export function frameName(rec: SyscallRecord): string {
  const args = rec.args as Record<string, unknown> | undefined;
  switch (rec.syscall) {
    case '__init':
      return typeof args?.['action'] === 'string'
        ? `__init:${args['action']}`
        : rec.syscall;
    case '__sched':
      return typeof args?.['action'] === 'string'
        ? `__sched:${args['action']}`
        : rec.syscall;
    case '__state': {
      const from = typeof args?.['from'] === 'string' ? args['from'] : rec.stateBefore;
      const to = typeof args?.['to'] === 'string' ? args['to'] : rec.stateAfter;
      return from !== undefined && to !== undefined
        ? `__state:${from}->${to}`
        : rec.syscall;
    }
    case '__signal': {
      const signal = typeof args?.['signal'] === 'string' ? args['signal'] : undefined;
      if (signal === undefined) return rec.syscall;
      const outcome = typeof args?.['outcome'] === 'string' ? args['outcome'] : undefined;
      return outcome === undefined ? `__signal:${signal}` : `__signal:${signal}(${outcome})`;
    }
    default:
      return rec.syscall;
  }
}

/**
 * Render one syscall record as a fixed-width `trace`/`attach` line.
 *
 * Shared by `cortex trace` and `cortex attach` so both commands print an
 * identical column layout for the same `.crec` file. Keep this the single
 * source of truth for the on-disk log's human-readable shape.
 */
export function formatRecordLine(rec: SyscallRecord): string {
  return renderRow([
    rec.timestamp.substring(11, 23), // HH:MM:SS.mmm
    String(unbrand(rec.pid)),
    frameName(rec),
    rec.phase,
    rec.durationMs !== undefined ? `${rec.durationMs}ms` : '-',
    rec.reversibility,
  ]);
}

/** The header row that goes with {@link formatRecordLine}. */
export const TRACE_HEADER = renderRow(TRACE_COLUMNS.map(([header]) => header));

/** The rule under the header. */
export const TRACE_RULE = '-'.repeat(TRACE_HEADER.length);

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
