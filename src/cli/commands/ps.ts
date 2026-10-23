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
import { readProcessView } from '../process_view.js';
import { CAPABILITIES, type Capability } from '../../kernel/types.js';

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
`);
    return 0;
  }

  const dir = defaultKernelDir();
  const view = await readProcessView(dir);

  // Apply filters.
  const filtered = view.rows.filter((p) => {
    if (values.state !== undefined && p.state !== values.state) return false;
    if (values.role !== undefined && p.role !== values.role) return false;
    return true;
  });

  if (filtered.length === 0) {
    console.log('No processes.');
    return 0;
  }

  // Print table header.
  const header =
    'PID'.padEnd(8) +
    'PPID'.padEnd(8) +
    'ROLE'.padEnd(14) +
    'STATE'.padEnd(14) +
    'TOKENS'.padEnd(10) +
    'CAPS'.padEnd(18) +
    'AGE';
  console.log(header);
  console.log('-'.repeat(header.length));

  const now = Date.now();
  for (const p of filtered) {
    const ageMs = p.startedAt === '—' ? 0 : now - new Date(p.startedAt).getTime();
    const age = formatAge(ageMs);
    const tokens = p.budgetsSpent.tokensIn + p.budgetsSpent.tokensOut;
    const tokensStr = tokens > 0 ? `${(tokens / 1000).toFixed(1)}k` : '0';
    const ppidStr = p.ppid !== null ? String(p.ppid) : '-';
    console.log(
      String(p.pid).padEnd(8) +
        ppidStr.padEnd(8) +
        p.role.padEnd(14) +
        p.state.padEnd(14) +
        tokensStr.padEnd(10) +
        formatCaps(p.capabilities).padEnd(18) +
        age,
    );
  }

  return 0;
}

/**
 * How to print a process's capabilities (docs/ABI.md §4.9).
 *
 * `all` for the full set, the list for a narrowed one, and `-` for a process
 * whose capabilities were never recorded — a `meta.json` from before the
 * kernel persisted them. That `-` is not "everything": it is the absence of
 * an answer, and the view says so instead of guessing.
 */
function formatCaps(caps: readonly Capability[] | undefined): string {
  if (caps === undefined) return '-';
  if (caps.length === 0) return 'none';
  if (caps.length === CAPABILITIES.length) return 'all';
  return caps.join(',');
}

function formatAge(ms: number): string {
  if (ms < 0 || ms < 1000) return `${Math.max(ms, 0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
