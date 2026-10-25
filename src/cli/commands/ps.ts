/**
 * cortex CLI — `cortex ps`
 *
 * BACKLOG #030: *"list processes with state, tokens, age."*
 *
 * Reads `.meta.json` files from disk, and — when a live kernel has published
 * its endpoint — merges in that kernel's own process table, so a process
 * that is running *right now* is visible instead of missing (it has no
 * `meta.json` until it exits). Does NOT boot a kernel.
 *
 * @module cli/commands/ps
 */

import { parseArgs } from 'node:util';
import { defaultKernelDir } from '../index.js';
import {
  formatCaps,
  describePendingSignals,
  formatAge,
  processAge,
  readProcessView,
  type ProcessRow,
} from '../process_view.js';
import { describeWait, readOpenCalls, type OpenCall } from '../open_call.js';
import { describeOutcome } from '../process_outcome.js';
import { describeBudget, formatTokenBudget } from '../process_budget.js';
import { processNote } from '../process_note.js';
import { describeCheckpointPark } from '../checkpoint_view.js';
import { probeKernel } from '../kernel_client.js';
import { renderHeader, renderRow, ruleUnder, sizeColumns, type ColumnSpec } from '../table.js';
import { PROCESS_STATES } from '../../kernel/process_table.js';
import { CAPABILITIES } from '../../kernel/types.js';

/** The length of the longest string in a list. */
function longest(values: readonly string[]): number {
  return values.reduce((max, value) => Math.max(max, value.length), 0);
}

/**
 * How wide the capabilities column may be.
 *
 * `formatCaps` prints `all` for the full set, `none` for an empty one, `-` for
 * "never recorded", and the comma-joined list for a narrowed one. The widest
 * list is every capability but one — and the one that can be left out is the
 * shortest name, so the widest list is all of them joined, minus the shortest
 * name and its separator.
 */
const CAPS_MAX = (() => {
  const joined = CAPABILITIES.join(',');
  const shortest = Math.min(...CAPABILITIES.map((capability) => capability.length));
  const widestList = joined.length - shortest - 1;
  return Math.max(widestList, 'all'.length, 'none'.length, '-'.length);
})();

/**
 * The widest a token cell may be.
 *
 * Derived from the rule instead of guessed at: a cell is the total a process
 * spent, the ceiling that spend is measured against, and — when the provider
 * served part of the input out of its cache — the cached count in brackets.
 * All of it is printed by one formatter. So the widest cell is the one that
 * formatter can produce, and it is produced here, once, by asking the
 * formatter itself.
 */
const TOKENS_MAX = formatTokenBudget({
  spent: {
    tokensIn: 9_999_999_999,
    tokensOut: 0,
    tokensCached: 9_999_999_999,
    usdSpent: 0,
    wallTimeMs: 0,
    syscallCount: 0,
  },
  remaining: { tokens: 9_999_999_999, usd: -1, wallTimeMs: -1 },
}).length;

/**
 * The columns of the process table, and the widest each one may be.
 *
 * Every maximum is derived from the value domain it holds, except the two
 * that cannot be: a **role** is whatever the operator typed, and an **age** is
 * however long the process has been alive. Those get a stated maximum, and a
 * value longer than it is cut and marked (`…`) rather than running on into the
 * next column — which is what used to happen, and which glued a role name to
 * a state and a capability list to an age.
 */
const PS_COLUMNS: readonly ColumnSpec[] = [
  { header: 'PID', max: 8, gap: 2 },
  { header: 'PPID', max: 8, gap: 2 },
  { header: 'ROLE', max: 24, gap: 2 },
  { header: 'STATE', max: longest(PROCESS_STATES), gap: 2 },
  { header: 'TOKENS', max: TOKENS_MAX, gap: 2 },
  { header: 'CAPS', max: CAPS_MAX, gap: 2 },
  { header: 'AGE', max: 10, gap: 2 },
  { header: 'NOTE', max: Number.POSITIVE_INFINITY, gap: 0 },
];

export async function cmdPs(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      state: { type: 'string' },
      role: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`cortex ps — list processes

USAGE
  cortex ps [options]

OPTIONS
  --state <state>   Filter by state (new, ready, running, blocked, stopped, suspended, zombie)
  --role <string>    Filter by role name
  -h, --help         Show this help

COLUMNS
  PID PPID ROLE STATE TOKENS CAPS AGE NOTE

  TOKENS is what the process spent and what it is measured against:
  '1.2k (300 cached) of 10k'. The ceiling is the total the process may ever
  spend, so a spend on its own — '1.2k' — is 12% of one budget and 99% of
  another, and the two need very different answers; ∞ means the budget has
  no ceiling. The cached tokens are part of that spend, not extra ones —
  they were read from the cache, and they are billed at the cache price.

  AGE is how long the process lived. A process that is still alive is aging,
  so this is the time since it started. A process that has ENDED is not aging:
  the kernel recorded how long it really lived, and that is what the column
  shows — it stops growing at the moment the process ended, instead of
  counting the days its record has been sitting on disk.

  NOTE says what the process is doing. For a process that is still alive, it
  says what it is waiting on — a channel, a child, a timer, a model call. It
  is the one thing the state column cannot be: the kernel does not park a
  process while its model call is in flight, so an agent that has been inside
  one for four minutes reads as 'running', and 'running' is not what the
  operator needs to know.

  It also says when the process was **parked**: a process that was
  checkpointed with '--detach' is SUSPENDED, and the row says it is
  checkpointed and hands over the command that brings it back ('cortex
  restore --chain <id>'). A row that says only 'suspended' reads exactly
  like a row whose agent died in the middle of a call, and the operator
  cannot tell the two apart from the table they read first.

  For a process that has ENDED, it says how it ended — 'exit 1 (boom)'. The
  kernel knows the code and the reason, and 'zombie' on its own cannot tell a
  finished run from a crash.

  And it says when the budget is gone: 'out of tokens', 'out of usd',
  'out of wallTime'. A process whose ceiling has been reached cannot go on,
  and a row that looks like any other waiting row says nothing about that.

  It also says what is waiting for the process: a signal the kernel has queued
  for it ('SIGTERM queued') is not delivered until the process runs again, so
  a 'cortex kill' on a wedged agent leaves a signal in the queue and the row
  says so.

  Where the answer comes from: with a live kernel, from the kernel; without
  one, from the process's log. The two give the same words.
`);
    return 0;
  }

  const dir = defaultKernelDir();
  // One connection, two questions: the process table, and the call each live
  // process is inside. The kernel knows the second one — it writes every
  // syscall as an `enter` frame and its partner — and the log would have to
  // be read to find out. A kernel too old to be asked falls back to the log,
  // so this table never goes silent just because the daemon is behind.
  const probe = await probeKernel(dir);
  const client = probe.kind === 'live' ? probe.client : undefined;
  let rows: readonly ProcessRow[];
  let calls: Map<number, OpenCall>;
  try {
    const view = await readProcessView(dir, client);
    rows = view.rows;
    calls = await readOpenCalls(dir, rows, client);
  } finally {
    client?.close();
  }

  // Apply filters.
  const filtered = rows.filter((p) => {
    if (values.state !== undefined && p.state !== values.state) return false;
    if (values.role !== undefined && p.role !== values.role) return false;
    return true;
  });

  /**
   * What a row says about what the process is waiting for — and about what is
   * waiting for *it*.
   *
   * Two sources, one rule. The kernel's **blocked reason** wins when it has
   * one — it knows *which* child, after all — and the open call is used
   * otherwise, which is how a driver call shows up: the kernel does not park
   * a process while its LLM call is in flight, so there is no blocked reason
   * for it, and the process table alone says only 'running'.
   *
   * A process that is not live is not waiting for anything, whatever its log
   * says: a dead process's last frame is history, not a wait.
   *
   * The **queued signals** are the other half of the sentence, and they are
   * the kernel's own: a `cortex kill` on a blocked agent does not deliver
   * anything, it queues a SIGTERM for a wake-up that may never come. The
   * wording is shared with `cortex top` (and the dashboard), so two views of
   * the same fact cannot say different things about it.
   */
  /**
   * What the row says about the process's situation — how it ended, whether
   * it has run out of budget, or what it is waiting on.
   *
   * Three facts, one cell, one order (see `src/cli/process_note.ts`): the
   * ending first (a dead process is not waiting for anything), then the
   * budget (a process whose ceiling has been reached cannot go on, and
   * nothing else in the row says so), then the wait.
   */
  const note = (p: ProcessRow): string => {
    const ending = describeOutcome(p);
    let wait = '';
    if (p.live) {
      const call = calls.get(p.pid);
      const blocked = p.blockedOn !== undefined && p.blockedOn !== null;
      if (call !== undefined || blocked) {
        wait = describeWait(call?.syscall ?? '', p.blockedOn);
      }
    }
    return processNote({
      ending,
      budget: describeBudget({ spent: p.budgetsSpent, remaining: p.budgetsRemaining }),
      checkpoint: describeCheckpointPark(p),
      waiting: describePendingSignals(wait, p.pendingSignals),
    });
  };

  if (filtered.length === 0) {
    console.log('No processes.');
    return 0;
  }

  const now = Date.now();

  // The cells first, then the columns: a column is as wide as the widest
  // value in *this* table, so the table is compact when the data is compact
  // and wide enough to say everything when the data is wide. The heading and
  // the rows come from the same list, so they cannot drift apart.
  const cells: string[][] = filtered.map((p) => {
    const ageMs = processAge(p, now);
    return [
      String(p.pid),
      p.ppid !== null ? String(p.ppid) : '-',
      p.role,
      p.state,
      formatTokenBudget({ spent: p.budgetsSpent, remaining: p.budgetsRemaining }),
      formatCaps(p.capabilities),
      formatAge(ageMs),
      note(p),
    ];
  });
  const columns = sizeColumns(PS_COLUMNS, cells);

  const header = renderHeader(columns);
  console.log(header);
  console.log(ruleUnder(header));
  for (const row of cells) {
    console.log(renderRow(columns, row));
  }

  return 0;
}
