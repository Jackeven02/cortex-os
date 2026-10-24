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
import { formatCaps, describePendingSignals, readProcessView, type ProcessRow } from '../process_view.js';
import { describeWait, readOpenCalls, type OpenCall } from '../open_call.js';
import { probeKernel } from '../kernel_client.js';

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
  PID PPID ROLE STATE TOKENS CAPS AGE WAITING

  WAITING is what the process is waiting on — a channel, a child, a timer, a
  model call. It is the one thing the state column cannot be: the kernel does
  not park a process while its model call is in flight, so an agent that has
  been inside one for four minutes reads as 'running', and 'running' is not
  what the operator needs to know.

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
  const waitingFor = (p: ProcessRow): string => {
    let wait = '';
    if (p.live) {
      const call = calls.get(p.pid);
      const blocked = p.blockedOn !== undefined && p.blockedOn !== null;
      if (call !== undefined || blocked) {
        wait = describeWait(call?.syscall ?? '', p.blockedOn);
      }
    }
    return describePendingSignals(wait, p.pendingSignals);
  };

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
    'AGE'.padEnd(10) +
    'WAITING';
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
        age.padEnd(10) +
        waitingFor(p),
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
