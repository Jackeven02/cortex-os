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
import { PROCESS_STATES, STATE_TRIGGERS } from '../../kernel/process_table.js';
import { ALL_SIGNALS, DELIVERY_OUTCOMES } from '../../kernel/signals.js';
import { INIT_ACTIONS } from '../../kernel/init.js';
import { DISPATCH_ACTIONS } from '../../kernel/scheduler.js';
import { renderHeader, renderRow, ruleUnder, type Column } from '../table.js';

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
 * - `__state:` + *state* + `->` + *state* + `(` + *cause* + `)` — the
 *   longest state is `checkpointing` (13) and the longest cause is
 *   `init-register-daemon` (20), so 58;
 * - `__signal:` + *signal* + `(` + *outcome* + `)` — 27;
 * - `__init:` + *action* — 23 (`restart-gave-up`);
 * - `__sched:` + *action* — 15.
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
const TRACE_COLUMNS: readonly Column[] = [
  { header: 'time', width: 12, gap: 2 },
  { header: 'pid', width: 7, gap: 1 },
  { header: 'syscall', width: TRACE_SYSCALL_WIDTH, gap: 1 },
  { header: 'phase', width: 6, gap: 1 },
  { header: 'duration', width: 10, gap: 1 },
  // `reversibility` is 13 characters — the longest value is `irreversible`,
  // and the heading itself is longer still.
  { header: 'reversibility', width: 13, gap: 0 },
];

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
      if (from === undefined || to === undefined) return rec.syscall;
      // The cause: **why** the process moved. Without it the log says a
      // process went from `running` to `blocked` and not whether it was
      // waiting on a channel, on a timer, on a child, or on a signal — a
      // fact without an explanation. The trigger was in the frame all along
      // (ABI.md §6.1); the view just dropped it.
      //
      // A signal is named by the signal itself, because "SIGTERM" says more
      // than "signal"; every other cause is the trigger.
      const cause = stateCause(args);
      return cause === '' ? `__state:${from}->${to}` : `__state:${from}->${to}(${cause})`;
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
 * What caused a state transition.
 *
 * A signal is named by the signal — "SIGTERM" says more than "signal" — and
 * everything else is the trigger the kernel recorded (`recv`, `sleep`,
 * `wait`, `scheduler-dispatch`, …).
 *
 * Empty when the frame carries no cause at all: an older kernel recorded the
 * transition without one, and a frame that says nothing is better than one
 * that guesses.
 */
function stateCause(args: Record<string, unknown> | undefined): string {
  if (args === undefined) return '';
  const signal = args['signal'];
  if (typeof signal === 'string' && signal !== '') return signal;
  const trigger = args['trigger'];
  return typeof trigger === 'string' ? trigger : '';
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
