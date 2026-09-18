/**
 * cortex CLI — `cortex ps`
 *
 * BACKLOG #030: *"list processes with state, tokens, age."*
 *
 * Reads `.meta.json` files from disk. Does NOT boot a kernel.
 *
 * @module cli/commands/ps
 */

import { parseArgs } from 'node:util';
import { defaultKernelDir, readAllMetas, type ProcessMeta } from '../index.js';

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
  const metas = readAllMetas(dir);

  // Always show init (PID 1) at the top, even if no user processes exist.
  const allMetas: ProcessMeta[] = [
    {
      pid: 1,
      ppid: null,
      pgid: 1,
      role: 'init',
      state: 'running',
      exitCode: null,
      exitReason: null,
      startedAt: '—',
      lastTransitionAt: '—',
      budgetsSpent: { tokensIn: 0, tokensOut: 0, tokensCached: 0, usdSpent: 0, wallTimeMs: 0, syscallCount: 0 },
      budgetsRemaining: { tokens: -1, usd: -1, wallTimeMs: -1 },
      agent: { system: 'init' },
      kernelAbiVersion: '1.0.0',
    },
    ...metas,
  ];

  // Apply filters.
  const filtered = allMetas.filter((p) => {
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
        age,
    );
  }

  return 0;
}

function formatAge(ms: number): string {
  if (ms < 0 || ms < 1000) return `${Math.max(ms, 0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
