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
import { readProcessView, type ProcessRow, type ProcessView } from '../process_view.js';
import {
  isStalled,
  readOpenCall,
  readOpenCallsFromKernel,
  type OpenCall,
} from '../open_call.js';
import { probeKernel } from '../kernel_client.js';

/** A node in the rendered tree. */
interface TreeNode {
  readonly row: ProcessRow;
  readonly children: TreeNode[];
}

/** The column widths. Fixed, so two runs line up under each other. */
const COL = {
  pid: 5,
  role: 16,
  state: 10,
  tokens: 8,
  usd: 9,
} as const;

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
    const fromKernel = await readOpenCallsFromKernel(client);
    const raw = fromKernel ?? (await readOpenCalls(dir, all));
    // The same filter for both readings: a process the kernel no longer holds
    // is not inside anything, even though its log keeps the `enter` frame of
    // the call it was killed in. Two readings of one fact have to make the
    // same choice, or they are two facts.
    const live = new Set(all.filter((row) => row.live).map((row) => row.pid));
    const inside = new Map([...raw].filter(([pid]) => live.has(pid)));

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
  const usd = all.reduce((n, m) => n + m.budgetsSpent.usdSpent, 0) / 1_000_000;

  const stalled = [...inside.entries()].filter(([, call]) =>
    stallAfterMs !== null ? isStalled(call, now, stallAfterMs) : false,
  );

  console.log(
    `cortex top — ${all.length} process${all.length === 1 ? '' : 'es'} · ${stateSummary}` +
      `${stalled.length > 0 ? ` · ${stalled.length} stuck` : ''}` +
      `${view.live ? ' · live kernel' : ''}`,
  );
  console.log(`${formatTokens(tokens)} tokens · $${usd.toFixed(4)} spent · home ${dir}`);
  console.log('');

  if (all.length === 1) {
    console.log('No processes yet. Try: cortex spawn --role demo --prompt "say hi"');
    return 0;
  }

  // The gutter is as wide as the deepest branch, so every row's columns line
  // up — a tree whose numbers do not line up is a tree nobody can read.
  const gutter = gutterWidth(roots);
  const header =
    ' '.repeat(gutter) +
    'PID'.padEnd(COL.pid) +
    'ROLE'.padEnd(COL.role) +
    'STATE'.padEnd(COL.state) +
    'TOKENS'.padEnd(COL.tokens) +
    'USD'.padEnd(COL.usd) +
    'NOTE';
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const root of roots) render(root, '', true, true, gutter, inside, now, stallAfterMs);

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
 * Read the open call of every *live* process, in parallel.
 *
 * The logs are read once, not per poll — `top` is a command an operator runs,
 * not a loop. Reading them concurrently keeps the wall time at the slowest
 * log rather than the sum of all of them.
 */
async function readOpenCalls(
  dir: string,
  rows: readonly ProcessRow[],
): Promise<Map<number, OpenCall>> {
  const found = await Promise.all(
    rows
      .filter((row) => row.live)
      .map(async (row): Promise<readonly [number, OpenCall | undefined]> => {
        const call = await readOpenCall(dir, row.pid);
        return [row.pid, call] as const;
      }),
  );
  const map = new Map<number, OpenCall>();
  for (const [pid, call] of found) {
    if (call !== undefined) map.set(pid, call);
  }
  return map;
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
): void {
  // Every node but the root draws a slot for itself: `├─ ` or `└─ `. The
  // root has no slot — it is the top of the tree — but it is still padded to
  // the full gutter, which is what makes the columns line up.
  const own = isRoot ? '' : isLast ? '└─ ' : '├─ ';
  const line = (ancestors + own).padEnd(gutter);
  console.log(`${line}${lineFor(node.row, inside.get(node.row.pid), now, stallAfterMs)}`);

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
    );
  });
}

function lineFor(
  m: ProcessRow,
  call: OpenCall | undefined,
  now: number,
  stallAfterMs: number | null,
): string {
  const pid = String(m.pid).padEnd(COL.pid);
  const role = m.role.padEnd(COL.role);
  const state = m.state.padEnd(COL.state);
  const spend = `${formatTokens(m.budgetsSpent.tokensIn + m.budgetsSpent.tokensOut)}`.padEnd(
    COL.tokens,
  );
  const usd = `$${(m.budgetsSpent.usdSpent / 1_000_000).toFixed(4)}`.padEnd(COL.usd);

  // The column that makes the state legible: why is it not running, and for
  // how long.
  let note = '';
  if (m.state === 'zombie') {
    note = m.exitReason === null ? 'exited' : `exit ${m.exitCode ?? 0} (${m.exitReason})`;
  } else if (call !== undefined) {
    const ms = now - call.since;
    note = `${describeCall(m, call.syscall)} for ${formatDuration(ms)}`;
    if (stallAfterMs !== null && isStalled(call, now, stallAfterMs)) {
      note += ' — stuck';
    }
  } else if (m.blockedOn !== undefined && m.blockedOn !== null) {
    note = `waiting on ${describeBlocked(m.blockedOn)}`;
  } else if (m.state === 'running' || m.state === 'ready') {
    const n = m.budgetsSpent.syscallCount;
    note = `${n} syscall${n === 1 ? '' : 's'}`;
  }
  return `${pid}${role}${state}${spend}${usd}${note}`;
}

/**
 * What a process is waiting for, in words.
 *
 * The blocked reason is used when the kernel has one — it knows *which*
 * child, after all. Otherwise the call's own name is used, which is how a
 * model call shows up: the kernel does not park a process while its LLM call
 * is in flight, so there is no blocked reason for it.
 */
function describeCall(m: ProcessRow, syscall: string): string {
  if (m.blockedOn !== undefined && m.blockedOn !== null) {
    return `waiting on ${describeBlocked(m.blockedOn)}`;
  }
  const friendly = FRIENDLY_CALLS[syscall];
  if (friendly !== undefined) return `waiting on ${friendly}`;
  return `inside ${syscall}`;
}

/**
 * Syscall names an operator would rather read as English.
 *
 * These are the calls that *wait*. The rest are named as they are, because
 * "inside spawn" is more use to a reader than an invented phrase for it.
 */
const FRIENDLY_CALLS: Readonly<Record<string, string>> = {
  recv: 'a channel',
  sleep: 'a timer',
  wait: 'a child',
  llm_call: 'a model call',
  tool_call: 'a tool call',
  memory_read: 'memory',
  memory_write: 'memory',
};

/** Render a `BlockedReason` without importing the kernel type. */
function describeBlocked(blockedOn: ProcessRow['blockedOn']): string {
  if (blockedOn === undefined || blockedOn === null) return 'something';
  const kind = (blockedOn as { kind?: string }).kind ?? 'something';
  switch (kind) {
    case 'wait':
      return `child ${String((blockedOn as { pid?: unknown }).pid ?? '?')}`;
    case 'recv':
      return 'a channel';
    case 'sleep':
      return 'a timer';
    case 'llm':
      return 'a model call';
    case 'tool':
      return 'a tool call';
    case 'budget':
      return 'its budget';
    case 'lock':
      return `lock ${String((blockedOn as { resource?: unknown }).resource ?? '?')}`;
    default:
      return kind;
  }
}

/** A duration, in the same shape `cortex ps` prints an age in. */
function formatDuration(ms: number): string {
  if (ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatTokens(n: number): string {
  if (n === 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
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

NOTES
  "Waiting" and "stuck" are different, and only one of them is in the process
  table. A process that is blocked on a channel and a process that will never
  be answered both read as 'waiting on a channel'; the log knows how long the
  call has been open, and that is what this view shows. A process inside a
  model call is not blocked at all — the kernel does not park it while the
  call is in flight — so the log is the only place its stall shows up.

EXAMPLES
  cortex top
  cortex top --stall-after 30000
`);
}
