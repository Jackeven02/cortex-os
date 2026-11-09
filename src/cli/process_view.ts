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
import type { KernelCommand } from './kernel_protocol.js';
import { formatDuration } from '../duration.js';
import {
  unbrand,
  CAPABILITIES,
  type BlockedReason,
  type BudgetCounters,
  type BudgetLimits,
  type Capability,
  type ProcessState,
  type Signal,
} from '../kernel/types.js';

/**
 * How to print a process's capabilities (docs/ABI.md §4.9).
 *
 * `all` for the full set, the list for a narrowed one, `none` for a process
 * that holds nothing, and `-` for a process whose capabilities were never
 * recorded — a `meta.json` from before the kernel persisted them. That `-` is
 * not "everything": it is the absence of an answer, and the view says so
 * instead of guessing.
 *
 * It lives here, and not in one command, because two views answer the same
 * question — `cortex ps` prints it, and the dashboard shows it — and they
 * must not be able to disagree about what an agent was allowed to do.
 */
export function formatCaps(caps: readonly Capability[] | undefined): string {
  if (caps === undefined) return '-';
  if (caps.length === 0) return 'none';
  if (caps.length === CAPABILITIES.length) return 'all';
  return caps.join(',');
}

/**
 * The signals the kernel has **queued** for a process, said out loud.
 *
 * A signal aimed at a process that is not running does not arrive: it waits in
 * the process's pending queue until the process is RUNNING again
 * (docs/PROCESS.md §7.2). The kernel knows this — the queue is its own, and
 * the transport already sends it in every process record.
 *
 * The views used to drop it. So `cortex ps` printed the *same row* before and
 * after `cortex kill` on a blocked agent: the operator asked a wedged process
 * to die, and the process list said nothing at all about it. The signal was
 * queued, waiting for a wake-up that may never come, and the only place that
 * said so was the command that had just run.
 *
 * "queued" is the kernel's own word for it — the `__signal` record's
 * `outcome`, and what `cortex kill` prints — so the view uses it too.
 *
 * It lives here, and not in one command, because two views answer the same
 * question — `cortex ps` prints it in its WAITING column, `cortex top` in its
 * NOTE — and they must not be able to disagree about what is waiting for what.
 *
 * @param text What the view already says about the process. Empty when it says
 *   nothing, which happens for a process that is stopped rather than waiting.
 * @param pending The signals the kernel has queued. `undefined` means the
 *   kernel did not say — an older kernel, or no kernel at all — which is not
 *   the same as "nothing is queued", and is rendered as nothing either way.
 */
export function describePendingSignals(
  text: string,
  pending: readonly Signal[] | undefined,
  from?: readonly (number | null)[] | undefined,
): string {
  if (pending === undefined || pending.length === 0) return text;
  const names = pending.map((signal, index) => {
    const sender = from?.[index];
    return sender === undefined || sender === null ? signal : `${signal} from ${sender}`;
  });
  const queued = `${names.join(',')} queued`;
  return text === '' ? queued : `${text} — ${queued}`;
}

/**
 * The priority a process runs at (docs/PROCESS.md §8.1).
 *
 * The kernel's word for it is `nice`: -20..19, and **lower runs first**. It
 * is the one fact about a process that decides which of the operator's agents
 * gets the CPU when two of them are ready at the same time — and it used to
 * reach no view at all, so an operator could watch one agent starve and had
 * nothing to read about why.
 *
 * `-` means **not recorded**: a record written before the kernel kept the
 * priority, or a kernel too old to carry it. It does **not** mean "the
 * default" — a view that turns an absence into a number claims a ranking it
 * never read, and the default is the one number that hides the problem.
 */
export function formatNice(nice: number | undefined): string {
  if (nice === undefined) return '-';
  return String(nice);
}

/**
 * The facts a duration needs.
 *
 * How long a process lived is three facts: when it started, whether it is
 * still running, and how much wall time the kernel charged it. Both row
 * shapes the views read carry exactly these — the CLI's `ProcessRow` and the
 * kernel's own `ProcessInfo` — so the rule can be stated once and used by
 * both, and a third view that grows one cannot miss it.
 */
export interface AgeFacts {
  readonly state: ProcessState;
  readonly startedAt: string;
  readonly budgetsSpent: { readonly wallTimeMs: number };
}

/**
 * How long a process has been alive.
 *
 * A running process is aging right now, so its age is the time since it
 * started. A **finished** process is not aging: it lived for a while and then
 * it was over, and the kernel recorded how long that was. So a finished
 * process shows its lifetime — the time it was really alive — and not the
 * time since it started, which keeps growing for as long as the record is on
 * disk and says nothing at all about the process. A dead row that ages for
 * days is a lie in the operator's first table.
 *
 * A record written before the kernel charged the wall clock carries no
 * lifetime, and falls back to the age.
 */
export function processAge(row: AgeFacts, now: number): number {
  const ended = row.state === 'zombie' || row.state === 'exiting';
  if (ended && row.budgetsSpent.wallTimeMs > 0) return row.budgetsSpent.wallTimeMs;
  if (row.startedAt === '—') return 0;
  return now - new Date(row.startedAt).getTime();
}

/**
 * How long a process lived, as the views print it.
 *
 * The same wording in every view that shows a process: the CLI's `cortex ps`
 * and `cortex top` and the dashboard's process table all read it from here, so
 * a duration cannot be `18s` in one view and `18 seconds` in another.
 *
 * The unit follows the size of the number, because a duration has to be
 * readable at a glance and `18000ms` is not: under a second it says
 * milliseconds, under a minute seconds, under an hour minutes, and after that
 * hours with one decimal — which is the precision a human reading "how long
 * has this been running" wants, and the precision the kernel's own wall clock
 * is charged at.
 *
 * The rule itself lives in [`src/duration.ts`](../../duration.ts), next to the
 * other way a duration is printed — the one a **budget's remainder** is
 * printed in, which must not round a remainder up to its ceiling.
 */
export function formatAge(ms: number): string {
  return formatDuration(ms);
}

/**
 * The bit of a live kernel the read-only views need.
 *
 * A `KernelClient` satisfies this. It is a separate interface so that a
 * caller that *already* holds a connection can hand it over instead of
 * having the view open (and close) one of its own — the dashboard holds
 * one connection for its whole life, and the view has to be able to use it.
 */
export interface ProcessSource {
  request(cmd: KernelCommand, args?: Record<string, unknown>): Promise<unknown>;
}

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
   * What this process was allowed to do (docs/ABI.md §4.9).
   *
   * Absent means *not recorded* — a `meta.json` written before the kernel
   * started persisting capabilities. It does **not** mean "everything": a row
   * that says nothing is a row that says nothing, and the view must not turn
   * silence into a claim.
   */
  readonly capabilities?: readonly Capability[];
  /**
   * The signals the kernel has queued for this process.
   *
   * A signal aimed at a process that is not running waits in its queue until
   * the process runs again (docs/PROCESS.md §7.2) — so this list is the
   * operator's answer to "did my `kill` land?". Absent means *not reported*:
   * the kernel did not say, because there is no kernel, or it is too old to
   * know. It does **not** mean "nothing is queued".
   */
  readonly pendingSignals?: readonly Signal[];
  /** Who queued each pending signal, in the same order. */
  readonly pendingSignalFrom?: readonly (number | null)[];
  /**
   * The checkpoints this process was parked at, oldest first.
   *
   * A process that was checkpointed with `--detach` is SUSPENDED, and the
   * chain it was parked in is what brings it back — so this list is the
   * operator's answer to "can this one be resumed, and from where?".
   *
   * Absent means *not reported*: the kernel did not say, because there is no
   * kernel, or it is too old to know. It does **not** mean "this process was
   * never checkpointed".
   */
  readonly checkpointChain?: readonly string[];
  /**
   * The priority this process runs at (docs/PROCESS.md §8.1) — the kernel's
   * `nice`, -20..19, lower runs first.
   *
   * Absent means *not reported*: the record was written by a build that did
   * not keep it, or there is no kernel to ask. It does **not** mean "the
   * default" — a row that shows `0` for a process it never checked is
   * claiming a ranking it did not read.
   */
  readonly nice?: number;
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
  /** What it holds right now (docs/ABI.md §4.9). */
  readonly capabilities: readonly Capability[];
  /**
   * The signals the kernel has queued for it.
   *
   * Optional, because the transport's answer is the kernel's own process
   * record and a kernel too old to carry the field simply does not have it.
   * Absent is *not reported*; it never means "nothing queued".
   */
  readonly pendingSignals?: readonly Signal[];
  readonly pendingSignalFrom?: readonly (number | null)[];
  /**
   * The checkpoints this process was parked at, oldest first.
   *
   * Optional, for the same reason `pendingSignals` is: a kernel too old to
   * carry the field does not have it. Absent is *not reported* — it never
   * means "this process was never checkpointed".
   */
  readonly checkpointChain?: readonly string[];
  /**
   * The priority it runs at.
   *
   * Optional, for the same reason `pendingSignals` is: a kernel too old to
   * carry the field does not have it. Absent is *not reported* — it never
   * means "the default".
   */
  readonly nice?: number;
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
    ...(meta.capabilities !== undefined ? { capabilities: meta.capabilities } : {}),
    ...(meta.nice !== undefined ? { nice: meta.nice } : {}),
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
    capabilities: info.capabilities,
    ...(info.pendingSignals !== undefined ? { pendingSignals: info.pendingSignals } : {}),
    ...(info.pendingSignalFrom !== undefined ? { pendingSignalFrom: info.pendingSignalFrom } : {}),
    ...(info.checkpointChain !== undefined ? { checkpointChain: info.checkpointChain } : {}),
    ...(info.nice !== undefined ? { nice: info.nice } : {}),
    live: true,
  };
}

/**
 * Read the process list the read-only views should render.
 *
 * Never throws: a live kernel that cannot be reached (crashed, stopped) is
 * not an error for a read-only view — it just means the disk is all there
 * is, which is exactly what the view showed before the transport existed.
 *
 * @param source An already-open connection to a live kernel. When given,
 *   the view uses it and **does not close it** — the caller owns it. When
 *   omitted, the view finds a kernel itself and closes the connection again.
 */
export async function readProcessView(
  dir: string,
  source?: ProcessSource,
): Promise<ProcessView> {
  const disk = readAllMetas(dir);

  let live: ProcessSource | undefined = source;
  let owned = false;
  if (live === undefined) {
    const probe = await probeKernel(dir);
    if (probe.kind !== 'live') {
      return {
        rows: [syntheticInit(), ...disk.map(rowFromMeta)].sort((a, b) => a.pid - b.pid),
        live: false,
      };
    }
    live = probe.client;
    owned = true;
  }

  try {
    const result = (await live.request('ps')) as {
      readonly processes: readonly LiveProcessInfo[];
    };
    const rows = result.processes.map(rowFromLive);
    const livePids = new Set(rows.map((r) => r.pid));
    const merged = [
      ...rows,
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
    if (owned) (live as { close?: () => void }).close?.();
  }
}

/** Re-export so the views can talk about PIDs without importing the kernel. */
export { unbrand };
