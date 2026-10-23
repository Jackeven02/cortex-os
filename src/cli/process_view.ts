/**
 * cortex CLI — the effective process view.
 *
 * `ps` and `top` read `.meta.json` files from disk. That is the right
 * default — the disk is the source of truth *across* CLI invocations — but
 * it has one blind spot: a process that is **running right now** has no
 * `meta.json` yet, because the kernel writes it when the process exits. So
 * while a daemon is alive, the disk view cannot show the very processes the
 * operator is thinking about. `cortex ps` would list a directory of corpses
 * and omit the one agent that is actually working.
 *
 * This module closes that gap. When a live kernel has published its
 * endpoint, its process table is authoritative for the processes it owns,
 * and the two views are merged:
 *
 *   - a PID the live kernel still holds comes from the kernel (its real
 *     state, its real `blockedOn`, its real spend);
 *   - a PID the kernel has finished keeps its disk row — the kernel wrote
 *     that `meta.json` on the way out, so it is the same fact, seen later.
 *
 * Without a live kernel this is exactly the old behaviour: the disk, and
 * nothing else.
 *
 * @module cli/process_view
 */

import {
  readAllMetas,
  type ProcessMeta,
} from './process_store.js';
import { probeKernel } from './kernel_client.js';
import {
  unbrand,
  type BlockedReason,
  type BudgetCounters,
  type BudgetLimits,
  type ProcessState,
} from '../kernel/types.js';

/**
 * The subset of a process's facts that the read-only views need.
 *
 * Narrower than `ProcessMeta` on purpose: a live process has no
 * `meta.json`, and therefore no persisted `AgentSpec` to quote. A row that
 * demanded one would push the view into inventing a spec it does not have —
 * and an invented agent spec is exactly the kind of detail that looks
 * authoritative and is not.
 */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number | null;
  readonly pgid: number;
  readonly role: string;
  readonly state: ProcessState;
  readonly exitCode: number | null;
  readonly exitReason: string | null;
  readonly startedAt: string;
  readonly lastTransitionAt: string;
  readonly budgetsSpent: BudgetCounters;
  readonly budgetsRemaining: BudgetLimits;
  readonly blockedOn?: BlockedReason | null;
  /**
   * Whether the kernel still has this process.
   *
   * A process that is *running* has no `meta.json` yet (the kernel writes it
   * when the process exits), so the disk view cannot say "this one is alive".
   * The live kernel can — and it is the difference between a process that is
   * still inside a call and a process that was killed in the middle of one.
   * A dead process's log can have an unpaired `enter` frame, and reading
   * that as "it is still inside that call" would be a lie.
   */
  readonly live: boolean;
}

/** The process list the read-only views render. */
export interface ProcessView {
  /** Every process, sorted by PID. Always contains init. */
  readonly rows: readonly ProcessRow[];
  /** Whether a live kernel answered — i.e. whether rows include live processes. */
  readonly live: boolean;
}

/** The synthetic init row used when no live kernel is around. */
function syntheticInit(): ProcessRow {
  return {
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
    blockedOn: null,
    live: false,
  };
}

/** The shape the kernel's `ps` syscall returns (docs/PROCESS.md §10). */
interface LiveProcessInfo {
  readonly pid: number;
  readonly ppid: number | null;
  readonly pgid: number;
  readonly role: string;
  readonly state: ProcessState;
  readonly blockedOn: BlockedReason | null;
  readonly startedAt: string;
  readonly lastTransitionAt: string;
  readonly budgetsRemaining: BudgetLimits;
  readonly budgetsSpent: BudgetCounters;
  readonly exitCode: number | null;
  readonly exitReason: string | null;
}

function rowFromMeta(meta: ProcessMeta): ProcessRow {
  return {
    pid: meta.pid,
    ppid: meta.ppid,
    pgid: meta.pgid,
    role: meta.role,
    state: meta.state,
    exitCode: meta.exitCode,
    exitReason: meta.exitReason,
    startedAt: meta.startedAt,
    lastTransitionAt: meta.lastTransitionAt,
    budgetsSpent: meta.budgetsSpent,
    budgetsRemaining: meta.budgetsRemaining,
    ...(meta.blockedOn !== undefined ? { blockedOn: meta.blockedOn } : {}),
    live: false,
  };
}

function rowFromLive(info: LiveProcessInfo): ProcessRow {
  return {
    pid: info.pid,
    ppid: info.ppid,
    pgid: info.pgid,
    role: info.role,
    state: info.state,
    exitCode: info.exitCode,
    exitReason: info.exitReason,
    startedAt: info.startedAt,
    lastTransitionAt: info.lastTransitionAt,
    budgetsSpent: info.budgetsSpent,
    budgetsRemaining: info.budgetsRemaining,
    blockedOn: info.blockedOn,
    live: true,
  };
}

/**
 * Read the process list the read-only views should render.
 *
 * Never throws: a live kernel that cannot be reached (crashed, stopped) is
 * not an error for a read-only view — it just means the disk is all there
 * is, which is exactly what the view showed before the transport existed.
 */
export async function readProcessView(dir: string): Promise<ProcessView> {
  const disk = readAllMetas(dir);

  const probe = await probeKernel(dir);
  if (probe.kind !== 'live') {
    return {
      rows: [syntheticInit(), ...disk.map(rowFromMeta)].sort((a, b) => a.pid - b.pid),
      live: false,
    };
  }

  try {
    const result = await probe.client.request<{ processes: readonly LiveProcessInfo[] }>('ps');
    const live = result.processes.map(rowFromLive);
    const livePids = new Set(live.map((r) => r.pid));
    const merged = [
      ...live,
      ...disk.filter((m) => !livePids.has(m.pid)).map(rowFromMeta),
    ].sort((a, b) => a.pid - b.pid);
    // The live kernel always has init in its table; if it somehow does not,
    // keep the synthetic row so the tree still has a root.
    if (!livePids.has(1)) merged.unshift(syntheticInit());
    return { rows: merged, live: true };
  } catch {
    return {
      rows: [syntheticInit(), ...disk.map(rowFromMeta)].sort((a, b) => a.pid - b.pid),
      live: false,
    };
  } finally {
    probe.client.close();
  }
}

/** Re-export so the views can talk about PIDs without importing the kernel. */
export { unbrand };
