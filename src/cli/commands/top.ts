/**
 * cortex CLI — `cortex top`
 *
 * BACKLOG #041: *"one view a stranger understands in five minutes."*
 *
 * `ps` is a flat table of processes. `top` is the same processes drawn as the
 * tree they actually are — who spawned whom, what each one is doing right now,
 * and what it is waiting on. It exists because the single hardest thing about
 * cortex is not any one primitive; it is *seeing* that a running agent is a
 * process with a parent, a state and a budget, like any other process on your
 * machine.
 *
 * ## The question `top` answers that `ps` cannot
 *
 * *"Is anything stuck?"*
 *
 * A process table says a process is BLOCKED. But a listener parked on a
 * channel and an agent that will never be answered look identical from the
 * outside — both are `blocked`, both are "waiting on a channel". The
 * difference is *how long*, and the difference is not in the process table.
 * It is in the log: every syscall is an `enter` frame and an `exit`/`trap`
 * frame **with the same `callId`**, so a call whose `enter` never got a
 * partner is the call the process is sitting inside, and the `enter` frame's
 * timestamp is when it started.
 *
 * So `top` reads each live process's log the same way `cortex supervise`
 * does — one shared reading, in one place, so the view and the command that
 * acts on it cannot disagree — and shows the call and how long it has been
 * there.
 *
 * This is also the only way to see a process wedged in a model call. The
 * kernel does not park a process while its LLM call is in flight, so such a
 * process is `running`, not `blocked`, and nothing in the process table says
 * anything is wrong. The log says it is 4 minutes into an `llm_call`.
 *
 * With `--stall-after <ms>`, the view also says which ones are over *your*
 * threshold — the same threshold, and the same exemption, that
 * `cortex supervise --kill-after` uses — and hands you the command to act
 * on it.
 *
 * Reads `.meta.json` files from disk. Does NOT boot a kernel — like `ps`, it
 * is a read-only view of what previous invocations left behind.
 *
 * @module cli/commands/top
 */

import { parseArgs } from 'node:util';

import { defaultKernelDir } from '../index.js';
import {
  readProcessView,
  describePendingSignals,
  formatTokens,
  type ProcessRow,
  type ProcessView,
} from '../process_view.js';
import {
  isStalled,
  readOpenCalls,
  describeBlocked,
  formatOpenCall,
  type OpenCall,
} from '../open_call.js';
import { probeKernel } from '../kernel_client.js';
import { describeOutcome, formatOutcomeCode } from '../process_outcome.js';
import { formatDollars, usdToDollars } from '../../money.js';
import { renderHeader, renderRow, ruleUnder, sizeColumns, type ColumnSpec } from '../table.js';
import { PROCESS_STATES } from '../../kernel/process_table.js';

/** A node in the rendered tree. */
interface TreeNode {
  readonly row: ProcessRow;
  readonly children: TreeNode[];
}

/** The length of the longest string in a list. */
function longest(values: readonly string[]): number {
  return values.reduce((max, value) => Math.max(max, value.length), 0);
}

/**
 * The columns of the tree, and the widest each one may be.
 *
 * Every maximum is derived from the value domain it holds, except the **role**
 * — that is whatever the operator typed, so no domain can be derived for it
 * and it gets a stated maximum. A value longer than its column is cut and
 * marked (`…`), never allowed to run on into the next one: a role that ran
 * into the state column made the two read as one word.
 */
const TOP_COLUMNS: readonly ColumnSpec[] = [
  { header: 'PID', max: 8, gap: 2 },
  { header: 'ROLE', max: 24, gap: 2 },
  { header: 'STATE', max: longest(PROCESS_STATES), gap: 2 },
  { header: 'TOKENS', max: longest(['0', '999', '999.9k', '999.9M']), gap: 2 },
  // Money is printed at the resolution the kernel counts it — six decimals
  // (`$0.000027`). Nine characters is not enough for that: the widest a
  // dollar amount gets here is "$1234.567890", and a cost that is cut with
  // an ellipsis is a cost nobody can add up.
  { header: 'USD', max: 12, gap: 2 },
  { header: 'NOTE', max: Number.POSITIVE_INFINITY, gap: 0 },
];


export async function cmdTop(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      'stall-after': { type: 'string' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printHelp();
    return 0;
  }

  const raw = values['stall-after'];
  let stallAfterMs: number | null = null;
  if (raw !== undefined) {
    const trimmed = raw.trim();
    const parsed = trimmed.length === 0 ? Number.NaN : Number(trimmed);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      console.error(`cortex top: invalid --stall-after: '${raw}' (expected milliseconds)`);
      return 1;
    }
    stallAfterMs = parsed;
  }

  const dir = defaultKernelDir();
  // The kernel knows which call each process is inside; the log only says so
  // if somebody reads all of it. One probe, one connection — the same one
  // the process view uses.
  const probe = await probeKernel(dir);
  const client = probe.kind === 'live' ? probe.client : undefined;
  try {
    const view = await readProcessView(dir, client);
    const all = view.rows;

    // What each *live* process is inside, and for how long. A process the
    // kernel has already finished is not "inside" anything, even if it was
    // killed in the middle of a call — its log would keep the unpaired
    // `enter` frame, and reading that as "still inside" would be a lie.
    //
    // With a live kernel the **kernel** answers: it writes every syscall as
    // an `enter` frame and its partner and knows which pairs are still open,
    // so the fact is O(processes) to read instead of O(bytes). Without one,
    // the log is all there is — and it is read once, not per poll.
    const now = Date.now();
    const inside = await readOpenCalls(dir, all, client);

    return renderTop(dir, view, all, inside, now, stallAfterMs);
  } finally {
    client?.close();
  }
}

/** Print the tree. Split out so the connection can be closed on every path. */
function renderTop(
  dir: string,
  view: ProcessView,
  all: readonly ProcessRow[],
  inside: Map<number, OpenCall>,
  now: number,
  stallAfterMs: number | null,
): number {
  const roots = buildTree(all);

  // --- header: one line that says what the whole thing adds up to ----------
  const byState = new Map<string, number>();
  for (const m of all) byState.set(m.state, (byState.get(m.state) ?? 0) + 1);
  const stateSummary = [...byState.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([state, n]) => `${n} ${state}`)
    .join(' · ');
  const tokens = all.reduce((n, m) => n + m.budgetsSpent.tokensIn + m.budgetsSpent.tokensOut, 0);
  const usd = usdToDollars(all.reduce((n, m) => n + m.budgetsSpent.usdSpent, 0));

  const stalled = [...inside.entries()].filter(([, call]) =>
    stallAfterMs !== null ? isStalled(call, now, stallAfterMs) : false,
  );

  console.log(
    `cortex top — ${all.length} process${all.length === 1 ? '' : 'es'} · ${stateSummary}` +
      `${stalled.length > 0 ? ` · ${stalled.length} stuck` : ''}` +
      `${view.live ? ' · live kernel' : ''}`,
  );
  console.log(`${formatTokens(tokens)} tokens · ${formatDollars(usd)} spent · home ${dir}`);
  console.log('');

  if (all.length === 1) {
    console.log('No processes yet. Try: cortex spawn --role demo --prompt "say hi"');
    return 0;
  }

  // The gutter is as wide as the deepest branch, so every row's columns line
  // up — a tree whose numbers do not line up is a tree nobody can read.
  const gutter = gutterWidth(roots);

  // The rows are built before they are printed, because a column is as wide
  // as the widest value in *this* table: the tree has to be known before its
  // shape can be.
  const rows: { prefix: string; cells: string[] }[] = [];
  for (const root of roots) {
    render(root, '', true, true, gutter, inside, now, stallAfterMs, rows);
  }
  const columns = sizeColumns(
    TOP_COLUMNS,
    rows.map((row) => row.cells),
  );

  const header = ' '.repeat(gutter) + renderHeader(columns);
  console.log(header);
  console.log(ruleUnder(header));
  for (const row of rows) {
    console.log(`${row.prefix.padEnd(gutter)}${renderRow(columns, row.cells)}`);
  }

  console.log('');

  // --- what to do about it --------------------------------------------------
  // The view's job is not only to show the problem but to hand over the next
  // command. A table that says "this one is stuck" and then leaves the
  // operator to remember the syntax is only half a tool.
  if (stalled.length > 0) {
    for (const [pid, call] of stalled) {
      const ms = now - call.since;
      console.log(
        `# pid ${pid} has been inside ${call.syscall} for ${ms}ms — over your ${stallAfterMs}ms threshold.`,
      );
      console.log(`#   cortex supervise ${pid} --kill-after ${stallAfterMs}`);
    }
    console.log('');
  }

  console.log('trace one:   cortex trace <pid>      follow one:  cortex attach <pid>');
  return 0;
}

/**
 * Build the forest from a flat list. A process whose parent is missing from
 * the index (reaped, or spawned before an index existed) is hung off init
 * rather than dropped — a tree that silently loses processes is worse than one
 * that guesses where they belong. Cycles are impossible in practice (a process
 * cannot be its own ancestor) but are defended against anyway, since this
 * reads files a human could have edited.
 */
function buildTree(rows: readonly ProcessRow[]): TreeNode[] {
  const nodes = new Map<number, TreeNode>();
  for (const row of rows) nodes.set(row.pid, { row, children: [] });

  const roots: TreeNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.pid) as TreeNode;
    const parent =
      row.ppid === null || row.ppid === row.pid ? undefined : nodes.get(row.ppid);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }

  for (const root of roots) sortTree(root);
  return roots;
}

function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => a.row.pid - b.row.pid);
  for (const child of node.children) sortTree(child);
}

/**
 * How wide the tree gutter has to be for every row's columns to line up.
 *
 * Each level of the tree costs three characters (`├─ `), so the gutter is
 * three times the depth of the deepest branch — and the root is indented by
 * all of it, which is what `ps --forest` does and why the numbers line up.
 */
function gutterWidth(roots: readonly TreeNode[]): number {
  let deepest = 0;
  const walk = (node: TreeNode, depth: number): void => {
    if (depth > deepest) deepest = depth;
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return deepest * 3;
}

function render(
  node: TreeNode,
  ancestors: string,
  isLast: boolean,
  isRoot: boolean,
  gutter: number,
  inside: ReadonlyMap<number, OpenCall>,
  now: number,
  stallAfterMs: number | null,
  rows: { prefix: string; cells: string[] }[],
): void {
  // Every node but the root draws a slot for itself: `├─ ` or `└─ `. The
  // root has no slot — it is the top of the tree — but it is still padded to
  // the full gutter, which is what makes the columns line up.
  const own = isRoot ? '' : isLast ? '└─ ' : '├─ ';
  rows.push({
    prefix: ancestors + own,
    cells: cellsFor(node.row, inside.get(node.row.pid), now, stallAfterMs),
  });

  // A child inherits its ancestors' slots, and its own slot is decided by
  // whether it is the last of them.
  const childAncestors = isRoot ? '' : ancestors + (isLast ? '   ' : '│  ');
  node.children.forEach((child, i) => {
    render(
      child,
      childAncestors,
      i === node.children.length - 1,
      false,
      gutter,
      inside,
      now,
      stallAfterMs,
      rows,
    );
  });
}

/**
 * The cells of one row: the facts, in the order the columns ask for them.
 *
 * They are returned as cells rather than as a finished line, because the
 * column widths are only known once every row has been seen.
 */
function cellsFor(
  m: ProcessRow,
  call: OpenCall | undefined,
  now: number,
  stallAfterMs: number | null,
): string[] {
  // The column that makes the state legible: why is it not running, and for
  // how long.
  let note = '';
  if (m.state === 'zombie') {
    // The same wording `cortex ps` prints — one rule, two views.
    note = describeOutcome(m);
  } else if (call !== undefined) {
    note = formatOpenCall(call, m.blockedOn, now);
    if (stallAfterMs !== null && isStalled(call, now, stallAfterMs)) {
      note += ' — stuck';
    }
  } else if (m.blockedOn !== undefined && m.blockedOn !== null) {
    note = `waiting on ${describeBlocked(m.blockedOn)}`;
  } else if (m.state === 'running' || m.state === 'ready') {
    const n = m.budgetsSpent.syscallCount;
    note = `${n} syscall${n === 1 ? '' : 's'}`;
  }
  // A signal the kernel has queued for this process, if any. It is not
  // delivered until the process runs again, so it belongs with the note that
  // says why the process is not running — and the wording is the same one
  // `cortex ps` uses, so the two views cannot disagree.
  const noteWithSignals = describePendingSignals(note, m.pendingSignals);

  return [
    String(m.pid),
    m.role,
    m.state,
    formatTokens(m.budgetsSpent.tokensIn + m.budgetsSpent.tokensOut),
    formatDollars(usdToDollars(m.budgetsSpent.usdSpent)),
    noteWithSignals,
  ];
}

function printHelp(): void {
  console.log(`cortex top — the process tree, and what each process is waiting for

USAGE
  cortex top
  cortex top --stall-after <ms>

OPTIONS
  --stall-after <ms>  Mark the processes that have been inside one syscall for
                      longer than <ms>, and print the command to act on them.
                      The same rule, and the same exemption, that
                      'cortex supervise --kill-after' uses.
  -h, --help          Show this help

Reads the process index on disk (like \`ps\`) and draws it as a tree: parent
above children, each with its state, its spend, and — when it is inside a
call — what it is waiting for and for how long. When a live kernel is running,
its own process table is merged in, so running agents appear in the tree too.

  STATE     running, ready, blocked, stopped, suspended, zombie
  WAITING   a channel (recv), a timer (sleep), a child (wait),
            a model call (llm_call), a tool call (tool_call)
  SPEND     tokens in+out, then USD
  NOTE      also says what is waiting for the process: a signal the kernel has
            queued for it ('SIGTERM queued') is not delivered until the
            process runs again

NOTES
  "Waiting" and "stuck" are different, and only one of them is in the process
  table. A process that is blocked on a channel and a process that will never
  be answered both read as 'waiting on a channel'; how long the call has been
  open is what this view shows. A process inside a model call is not blocked
  at all -- the kernel does not park it while the call is in flight -- so the
  process table says only 'running', and the call has to be asked for.

  Where the answer comes from: with a live kernel, from the kernel. It writes
  every syscall as an 'enter' frame and its partner, and it knows which pairs
  are still open. Without one, from the process's log. The two readings give
  the same numbers -- the log is just the slower way to get them.

EXAMPLES
  cortex top
  cortex top --stall-after 30000
`);
}
