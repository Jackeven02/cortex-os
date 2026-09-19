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
 * Reads `.meta.json` files from disk. Does NOT boot a kernel — like `ps`, it
 * is a read-only view of what previous invocations left behind.
 *
 * @module cli/commands/top
 */

import { parseArgs } from 'node:util';

import { defaultKernelDir, readAllMetas, type ProcessMeta } from '../index.js';

/** A node in the rendered tree. */
interface TreeNode {
  readonly meta: ProcessMeta;
  readonly children: TreeNode[];
}

export async function cmdTop(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`cortex top — the process tree, and what each process is waiting for

USAGE
  cortex top

Reads the process index on disk (like \`ps\`) and draws it as a tree: parent
above children, each with its state, its spend, and — when it is blocked —
what it is blocked on.

  STATE     running, ready, blocked, stopped, suspended, zombie
  WAITING   sleep (a timer), wait (a child), recv (a channel),
            llm / tool (a driver call), budget (SIGXCPU)
  SPEND     tokens in+out, then USD

-h, --help   Show this help
`);
    return 0;
  }

  const dir = defaultKernelDir();
  const metas = readAllMetas(dir);

  // init (PID 1) is the root of everything and is never on disk itself.
  const initMeta: ProcessMeta = {
    pid: 1,
    ppid: null,
    pgid: 1,
    role: 'init',
    state: 'running',
    exitCode: null,
    exitReason: null,
    startedAt: '—',
    lastTransitionAt: '—',
    budgetsSpent: {
      tokensIn: 0,
      tokensOut: 0,
      tokensCached: 0,
      usdSpent: 0,
      wallTimeMs: 0,
      syscallCount: 0,
    },
    budgetsRemaining: { tokens: -1, usd: -1, wallTimeMs: -1 },
    agent: { system: 'init' },
    kernelAbiVersion: '1.0.0',
  };

  const roots = buildTree([initMeta, ...metas]);

  // --- header: one line that says what the whole thing adds up to ----------
  const all = [initMeta, ...metas];
  const byState = new Map<string, number>();
  for (const m of all) byState.set(m.state, (byState.get(m.state) ?? 0) + 1);
  const stateSummary = [...byState.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([state, n]) => `${n} ${state}`)
    .join(' · ');
  const tokens = all.reduce((n, m) => n + m.budgetsSpent.tokensIn + m.budgetsSpent.tokensOut, 0);
  const usd = all.reduce((n, m) => n + m.budgetsSpent.usdSpent, 0) / 1_000_000;

  console.log(
    `cortex top — ${all.length} process${all.length === 1 ? '' : 'es'} · ${stateSummary}`,
  );
  console.log(`${formatTokens(tokens)} tokens · $${usd.toFixed(4)} spent · home ${dir}`);
  console.log('');

  if (all.length === 1) {
    console.log('No processes yet. Try: cortex spawn --role demo --prompt "say hi"');
    return 0;
  }

  for (const root of roots) render(root, '', true);

  console.log('');
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
function buildTree(metas: readonly ProcessMeta[]): TreeNode[] {
  const nodes = new Map<number, TreeNode>();
  for (const meta of metas) nodes.set(meta.pid, { meta, children: [] });

  const roots: TreeNode[] = [];
  for (const meta of metas) {
    const node = nodes.get(meta.pid) as TreeNode;
    const parent =
      meta.ppid === null || meta.ppid === meta.pid ? undefined : nodes.get(meta.ppid);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }

  for (const root of roots) sortTree(root);
  return roots;
}

function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => a.meta.pid - b.meta.pid);
  for (const child of node.children) sortTree(child);
}

function render(node: TreeNode, prefix: string, isLast: boolean): void {
  const branch = prefix === '' ? '' : `${prefix}${isLast ? '└─ ' : '├─ '}`;
  console.log(`${branch}${lineFor(node.meta)}`);
  const childPrefix = prefix === '' ? '   ' : `${prefix}${isLast ? '   ' : '│  '}`;
  node.children.forEach((child, i) => {
    render(child, childPrefix, i === node.children.length - 1);
  });
}

function lineFor(m: ProcessMeta): string {
  const pid = String(m.pid).padEnd(5);
  const role = m.role.padEnd(16);
  const state = m.state.padEnd(10);
  const spend = `${formatTokens(m.budgetsSpent.tokensIn + m.budgetsSpent.tokensOut)}`.padEnd(8);
  const usd = `$${(m.budgetsSpent.usdSpent / 1_000_000).toFixed(4)}`.padEnd(9);

  // The column that makes the state legible: why is it not running?
  let note = '';
  if (m.state === 'zombie') {
    note = m.exitReason === null ? 'exited' : `exit ${m.exitCode ?? 0} (${m.exitReason})`;
  } else if (m.blockedOn !== undefined && m.blockedOn !== null) {
    note = `waiting on ${describeBlocked(m.blockedOn)}`;
  } else if (m.state === 'running' || m.state === 'ready') {
    note = `${m.budgetsSpent.syscallCount} syscalls`;
  }
  return `${pid}${role}${state}${spend}${usd}${note}`;
}

/** Render a `BlockedReason` without importing the kernel type. */
function describeBlocked(blockedOn: ProcessMeta['blockedOn']): string {
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

function formatTokens(n: number): string {
  if (n === 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
