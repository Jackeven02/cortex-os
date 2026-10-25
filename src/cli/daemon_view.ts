/**
 * cortex CLI — what a supervised daemon is doing right now.
 *
 * ## The rule
 *
 * **An installed daemon is not a running daemon.**
 *
 * `cortex daemon list` used to print the **spec** — name, role, restart
 * policy, agent — read from `daemons.json`. That file is the *install
 * receipt*: it says the daemon was written down, and nothing more. It reads
 * exactly like the truth about the daemon, and it is not: an operator who ran
 * it could not tell whether the daemon was running, whether it was flapping,
 * whether the kernel had already given up on it, or whether it was never
 * started at all.
 *
 * The kernel knows all of that. init holds each logical daemon: its
 * identity, the attempt running right now, how many times it has been
 * restarted, how the last attempt ended, and whether the supervisor gave up.
 * None of it was on the way out — so the answer had to be built from the
 * receipt, and the receipt does not contain it.
 *
 * ## Where the facts come from
 *
 * - **The kernel** — `Kernel.daemons()` → the transport's `daemons` command.
 *   This is the *live* answer: it knows about a daemon that was never
 *   started, and about one the supervisor gave up on.
 * - **The registry** (`daemons.json`) — the *installed* answer: which daemons
 *   exist at all, even when nothing is running them.
 *
 * Neither is the whole truth, so the view joins them: on the **name**, which
 * is the operator's own name for the daemon. (The role is not an identity —
 * two daemons may share one — so the join key is the name, and the kernel
 * learned it when the daemon was registered.)
 *
 * ## The rule about not knowing
 *
 * **No live kernel means no answer — not "not running".**
 *
 * A daemon's live state belongs to the kernel that supervises it. Without one
 * there is nothing to ask, so the view says *unknown* and says why. It does
 * not fall back to "not started", which would be a different claim: it would
 * say the daemon was never started, when in fact nobody knows.
 *
 * The same rule applies to the other direction: a daemon that the **live**
 * kernel does not know *was* never started by that kernel — that one is a
 * fact, and it is different from "unknown".
 *
 * ## What this module owns
 *
 * The rule (which status means what) and the wording (how it is said). The
 * terminal and the window both use it, so they cannot disagree about a
 * daemon that is flapping or dead.
 *
 * @module cli/daemon_view
 */

import { formatOutcomeCode } from './process_outcome.js';
import { describeSupervision, formatSupervision } from './supervision_view.js';
import { PID_INIT } from '../kernel/process_table.js';
import { asProcessId } from '../kernel/types.js';
import { existingCrecPath, readRecords } from '../kernel/recorder.js';
import { existsSync } from 'node:fs';
import type { SyscallRecord } from '../kernel/types.js';
import {
  INIT_GIVE_UP_REASONS,
  type DaemonAgent,
  type DaemonGiveUpReason,
  type DaemonState,
  type DaemonStatus,
  type InitAction,
} from '../kernel/init.js';

/**
 * The status a **view** shows for a daemon.
 *
 * The kernel's own `DaemonStatus` has five values; a view has two more,
 * because a view also knows about daemons the kernel has never heard of:
 *
 *   - `not-started` — a live kernel exists and is not supervising this
 *     daemon. It was installed and never registered (or registered with a
 *     different kernel).
 *   - `unknown` — there is no live kernel to ask. Nothing is known.
 */
export type DaemonViewStatus = DaemonStatus | 'not-started' | 'unknown';

/** How urgent a status is, and what colour it gets. */
export type DaemonTone = 'live' | 'warn' | 'dead' | 'idle';

/**
 * The label a status is shown with.
 *
 * Short, because it goes in a table cell; the sentence that explains it goes
 * in `note`.
 */
export interface DaemonStatusLabel {
  readonly tone: DaemonTone;
  readonly label: string;
}

/**
 * The label of each status, in one place.
 *
 * `gave-up` is the only one that is `dead`: it is a daemon that is not coming
 * back, and a window that paints it like a healthy one is lying. `unknown` is
 * `idle` rather than `dead` — nothing is known, so nothing is condemned.
 */
const STATUS_LABELS: Readonly<Record<DaemonViewStatus, DaemonStatusLabel>> = {
  running: { tone: 'live', label: 'running' },
  dying: { tone: 'warn', label: 'just ended' },
  'backing-off': { tone: 'warn', label: 'waiting to restart' },
  'gave-up': { tone: 'dead', label: 'given up' },
  stopped: { tone: 'idle', label: 'stopped' },
  'not-started': { tone: 'idle', label: 'not started' },
  unknown: { tone: 'idle', label: 'unknown' },
};

/**
 * The label of a status.
 *
 * An unknown status is not a status this module knows: it is reported as
 * `unknown` rather than guessed at, because a status nobody can read is a
 * status nobody may claim to understand.
 */
export function describeDaemonStatus(status: DaemonViewStatus | string): DaemonStatusLabel {
  const known = STATUS_LABELS[status as DaemonViewStatus];
  return known ?? { tone: 'idle', label: 'unknown' };
}

/**
 * Why the supervisor gave up on a daemon, in words.
 *
 * The kernel decided this; the wording is here so the terminal and the window
 * say it the same way.
 */
export function describeDaemonGiveUp(reason: DaemonGiveUpReason | null): string | null {
  switch (reason) {
    case 'policy':
      return 'the restart policy says no';
    case 'max-restarts':
      return 'max restarts reached';
    case 'restart-storm':
      return 'restart storm';
    default:
      return null;
  }
}

/**
 * What a view knows about one daemon.
 *
 * Every field is `null` when it is not known — never a zero and never a
 * made-up default. A daemon that has not been restarted has *zero* restarts;
 * a daemon whose restart count is not known has *null* restarts, and the two
 * are different claims.
 */
export interface DaemonFacts {
  /** The operator's name for the daemon, or `null` when it has none. */
  readonly name: string | null;
  /**
   * The daemon's stable identity — the pid of its *first* attempt.
   *
   * It is the join key between the **live state** and the **journal**: the
   * kernel's own bookkeeping and init's log both name the daemon this way,
   * and it survives restarts (a restart mints a fresh pid).
   */
  readonly daemonId: number | null;
  readonly role: string;
  /** Whether the registry has an entry for this daemon. */
  readonly installed: boolean;
  readonly status: DaemonViewStatus;
  /** The attempt running right now, or `null` when none is. */
  readonly pid: number | null;
  /** How many times it has been restarted, or `null` when unknown. */
  readonly restarts: number | null;
  readonly lastExitCode: number | null;
  readonly lastExitReason: string | null;
  /** Why the supervisor gave up, or `null` if it has not. */
  readonly gaveUpReason: DaemonGiveUpReason | null;
  /** The restart policy's kind. */
  readonly restart: 'always' | 'on-failure' | 'never';
  /** The total restart cap, or `null` when unlimited. */
  readonly maxRestarts: number | null;
  /** Which agent it runs, or `null` when that is not known. */
  readonly agent: DaemonAgent | null;
}

/**
 * An installed daemon, as the registry knows it.
 *
 * The receipt is the spec — it says the daemon exists, not that it runs.
 */
export interface DaemonReceipt {
  readonly name: string;
  readonly role: string;
  readonly restart: 'always' | 'on-failure' | 'never';
  readonly maxRestarts: number | null;
  readonly agent: DaemonAgent | null;
}

/**
 * Join the installed daemons with the live ones.
 *
 * The join is on the **name**: the registry's key and the name the kernel
 * was given when the daemon was registered. (The role is not an identity —
 * two daemons may share a role and differ only by their module — so joining
 * on the role would silently merge two different daemons.)
 *
 * `live` is `null` when there is no live kernel: then every installed daemon
 * is `unknown`, because nothing knows whether it is running. It is **not**
 * `not-started` — "nobody is running it" and "nobody knows" are different
 * claims, and only one of them is true.
 *
 * A live daemon the registry has no entry for is still shown: it is running,
 * and the registry is behind.
 */
export function joinDaemons(
  receipts: readonly DaemonReceipt[],
  live: readonly DaemonState[] | null,
): DaemonFacts[] {
  const rows: DaemonFacts[] = [];
  const receiptNames = new Set(receipts.map((receipt) => receipt.name));

  if (live === null) {
    for (const receipt of receipts) {
      rows.push({
        name: receipt.name,
        daemonId: null,
        role: receipt.role,
        installed: true,
        status: 'unknown',
        pid: null,
        restarts: null,
        lastExitCode: null,
        lastExitReason: null,
        gaveUpReason: null,
        restart: receipt.restart,
        maxRestarts: receipt.maxRestarts,
        agent: receipt.agent,
      });
    }
    return rows;
  }

  // Live daemons by name. A name may map to more than one daemon — a host
  // can register two daemons under one name — and both are shown: dropping
  // one would hide a running daemon behind a duplicate.
  const byName = new Map<string, DaemonState[]>();
  for (const state of live) {
    if (state.name === null) continue;
    const bucket = byName.get(state.name);
    if (bucket === undefined) byName.set(state.name, [state]);
    else bucket.push(state);
  }

  for (const receipt of receipts) {
    const matches = byName.get(receipt.name) ?? [];
    if (matches.length === 0) {
      // Installed, and the live kernel is not supervising it. That is a
      // fact: the kernel is right there and it does not have this daemon.
      rows.push({
        name: receipt.name,
        daemonId: null,
        role: receipt.role,
        installed: true,
        status: 'not-started',
        pid: null,
        restarts: null,
        lastExitCode: null,
        lastExitReason: null,
        gaveUpReason: null,
        restart: receipt.restart,
        maxRestarts: receipt.maxRestarts,
        agent: receipt.agent,
      });
      continue;
    }
    for (const state of matches) {
      rows.push(factsOf(state, true));
    }
  }

  // Live daemons the registry has no entry for: running, but the registry is
  // behind (it was uninstalled after the kernel started, or the host
  // registered it directly).
  for (const state of live) {
    if (state.name !== null && receiptNames.has(state.name)) continue;
    rows.push(factsOf(state, false));
  }

  return rows;
}

/** The facts of one live daemon. */
function factsOf(state: DaemonState, installed: boolean): DaemonFacts {
  return {
    name: state.name,
    daemonId: state.daemonId,
    role: state.role,
    installed,
    status: state.status,
    pid: state.currentPid,
    restarts: state.restartCount,
    lastExitCode: state.lastExitCode,
    lastExitReason: state.lastExitReason,
    gaveUpReason: state.gaveUpReason,
    restart: state.restart,
    maxRestarts: state.maxRestarts,
    agent: state.agent,
  };
}

/**
 * How the last attempt's ending is said.
 *
 * An unknown code prints as `?`, because `?` is a question and `0` is an
 * answer — and the answer would be a lie. A daemon that has never had an
 * attempt end has no ending to report, and this says nothing at all.
 */
export function formatDaemonExit(code: number | null, reason: string | null): string {
  if (code === null && reason === null) return '';
  const shown = formatOutcomeCode(code);
  return reason === null ? `exit ${shown}` : `exit ${shown} (${reason})`;
}

/**
 * How the restart policy is said.
 *
 * `on-failure (max 3)` — the cap is part of the policy, and a policy without
 * its cap is not the policy that is in force.
 */
export function formatDaemonPolicy(
  kind: 'always' | 'on-failure' | 'never',
  maxRestarts: number | null,
): string {
  return maxRestarts === null ? kind : `${kind} (max ${maxRestarts})`;
}

/**
 * Which agent a daemon runs, in one word each.
 *
 * The system prompt is cut short — it is a prompt, not an identity — and the
 * cut is the same cut in the terminal and in the window.
 */
export function formatDaemonAgent(agent: DaemonAgent | null): string {
  if (agent === null) return '—';
  if (agent.kind === 'module') {
    return `module:${agent.module.replace(/^file:\/\//, '')}`;
  }
  const head = agent.system.slice(0, 24);
  return `system:${head}${agent.system.length > 24 ? '…' : ''}`;
}

/**
 * The sentence that explains a status, when the label alone is not enough.
 *
 * It explains the two states that are *about knowing*: `unknown` (there was
 * nobody to ask) and `not-started` (there was, and it does not have this
 * daemon).
 */
export function describeDaemonNote(facts: DaemonFacts): string | null {
  if (facts.status === 'unknown') {
    return 'no live kernel in this directory — a daemon’s live state belongs to the kernel that supervises it';
  }
  if (facts.status === 'not-started') {
    return 'the live kernel is not supervising it';
  }
  if (facts.status === 'gave-up') {
    const reason = describeDaemonGiveUp(facts.gaveUpReason);
    return reason === null ? 'the supervisor gave up on it' : `the supervisor gave up: ${reason}`;
  }
  if (!facts.installed) {
    return 'the registry has no entry for it';
  }
  return null;
}

/**
 * The sentence that says what the daemons are doing, in one line.
 *
 * Used by the terminal below its table and by the window above its panel, so
 * the two say the same thing about the same set.
 */
export function formatDaemonSummary(rows: readonly DaemonFacts[]): string {
  if (rows.length === 0) return 'no daemons';
  const counts = new Map<DaemonViewStatus, number>();
  for (const row of rows) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [status, count] of counts) {
    parts.push(`${count} ${describeDaemonStatus(status).label}`);
  }
  const plural = rows.length === 1 ? 'daemon' : 'daemons';
  return `${rows.length} ${plural}: ${parts.join(', ')}`;
}

// =============================================================================
// The journal — what the supervisor said about these daemons
// =============================================================================

/**
 * What the supervision journal says about one daemon.
 *
 * The journal is init's own log (docs/PROCESS.md §9.1) — the durable record
 * of every decision the supervisor made. The live state answers **now**; the
 * journal answers **what was decided**, and it outlives the kernel.
 *
 * These are the *decisions* about one daemon: it was registered, it was
 * restarted, it was given up on. The `reap` frames are not here — a reap is a
 * process dying, and the decision about what happens next is the frame that
 * follows it.
 */
export interface DaemonDecisions {
  /** The daemon's stable identity — the pid of its first attempt. */
  readonly daemonId: number;
  /** The operator's name for it, when the journal carried one. */
  readonly name: string | null;
  readonly role: string;
  /** The journal saw it registered. */
  readonly registered: boolean;
  /** How many restarts the journal recorded. */
  readonly restarts: number;
  /** The pid of the last attempt the journal saw start. */
  readonly lastPid: number | null;
  /** Which attempt that last restart was. */
  readonly lastAttempt: number | null;
  /** Why the supervisor gave up, if the journal says it did. */
  readonly gaveUpReason: DaemonGiveUpReason | null;
  /** The last decision, in the wording every view of the journal uses. */
  readonly lastDecision: string | null;
  /** Which decision that was. */
  readonly lastAction: InitAction | null;
}

/** Is this string one of the reasons the kernel can give up? */
function isGiveUpReason(value: string | null): value is DaemonGiveUpReason {
  return value !== null && (INIT_GIVE_UP_REASONS as readonly string[]).includes(value);
}

/**
 * Fold the supervision journal into one entry per daemon.
 *
 * The frames that carry a daemon's identity are its **decisions**: the
 * registration, the restarts, the give-up. Everything else in the journal is
 * about the kernel (it booted, it shut down) or about a process that died.
 *
 * A frame nobody can read is **not** a decision: `describeSupervision` refuses
 * an action it does not know, and guessing what a decision meant is how a
 * view starts lying.
 */
export function describeDaemonDecisions(records: readonly SyscallRecord[]): DaemonDecisions[] {
  const byDaemon = new Map<number, DaemonDecisions>();
  for (const record of records) {
    const facts = describeSupervision(record);
    if (facts === undefined) continue;
    if (
      facts.action !== 'register-daemon' &&
      facts.action !== 'restart' &&
      facts.action !== 'restart-gave-up'
    ) {
      continue;
    }
    if (facts.daemonId === null) continue;

    const previous = byDaemon.get(facts.daemonId);
    const isRestart = facts.action === 'restart';
    const lastPid = isRestart
      ? (facts.newPid ?? previous?.lastPid ?? null)
      : facts.action === 'register-daemon'
        ? facts.daemonId
        : (previous?.lastPid ?? null);

    byDaemon.set(facts.daemonId, {
      daemonId: facts.daemonId,
      name: facts.name ?? previous?.name ?? null,
      role: facts.role ?? previous?.role ?? 'daemon',
      registered: previous?.registered === true || facts.action === 'register-daemon',
      restarts: (previous?.restarts ?? 0) + (isRestart ? 1 : 0),
      lastPid,
      lastAttempt: isRestart ? (facts.attempt ?? previous?.lastAttempt ?? null) : (previous?.lastAttempt ?? null),
      gaveUpReason:
        facts.action === 'restart-gave-up' && isGiveUpReason(facts.reason)
          ? facts.reason
          : (previous?.gaveUpReason ?? null),
      lastDecision: formatSupervision(facts),
      lastAction: facts.action,
    });
  }
  return [...byDaemon.values()].sort((a, b) => a.daemonId - b.daemonId);
}

/**
 * The supervision journal in this directory — init's own log.
 *
 * The one reader: the log is read with the **same** reader the kernel writes
 * it with (`readRecords`), so a journal that cannot be read is reported as
 * *no journal* rather than as an empty one — which would say "the supervisor
 * decided nothing" about a log nobody managed to read.
 */
export async function readDaemonDecisions(dir: string): Promise<DaemonDecisions[]> {
  const path = existingCrecPath(dir, asProcessId(PID_INIT));
  if (!existsSync(path)) return [];
  const records: SyscallRecord[] = [];
  try {
    for await (const record of readRecords(path)) records.push(record);
  } catch {
    return [];
  }
  return describeDaemonDecisions(records);
}

/** The decisions, keyed by the daemon's stable identity. */
export function indexDaemonDecisions(
  decisions: readonly DaemonDecisions[],
): ReadonlyMap<number, DaemonDecisions> {
  const index = new Map<number, DaemonDecisions>();
  for (const entry of decisions) index.set(entry.daemonId, entry);
  return index;
}

/**
 * What the supervisor's own record says about one row — beside what the
 * kernel says right now.
 *
 * Two things, and they are not the same:
 *
 *   - the **decision** — the last thing the supervisor did about this daemon,
 *     from the journal. It is history, and it outlives the kernel.
 *   - the **disagreement** — the two answers do not match: the kernel
 *     remembers a give-up the journal never recorded, or the journal counts
 *     restarts the kernel does not, or one side has never heard of the
 *     daemon at all.
 *
 * A disagreement is never silently dropped: two answers to one question
 * that differ is exactly what an operator needs to be told, and it is what
 * nobody could see while the two lived in different places.
 */
export interface DaemonDetail {
  /** The daemon, as the row names it. */
  readonly who: string;
  /** The supervisor's last decision, or `null` when the journal has none. */
  readonly decision: string | null;
  /** The sentence that says what differs, or `null` when nothing does. */
  readonly disagreement: string | null;
}

/**
 * Pair every row with the supervisor's record of it.
 *
 * The join is on the daemon's **identity** — the pid of its first attempt,
 * which survives restarts — and, for a daemon the kernel is not running, on
 * its **name**, which the journal carries since the kernel learned it.
 *
 * A row the kernel is not running gets no disagreement: the journal's
 * decisions about it are **history** (an earlier kernel's), not a conflict
 * with a live state that does not exist.
 */
export function describeDaemonDetails(
  rows: readonly DaemonFacts[],
  states: readonly DaemonState[] | null,
  decisions: readonly DaemonDecisions[],
): DaemonDetail[] {
  const byDaemon = new Map<number, DaemonDecisions>();
  const byName = new Map<string, DaemonDecisions>();
  for (const entry of decisions) {
    byDaemon.set(entry.daemonId, entry);
    if (entry.name !== null && !byName.has(entry.name)) byName.set(entry.name, entry);
  }
  const statesById = new Map<number, DaemonState>();
  for (const state of states ?? []) statesById.set(state.daemonId, state);

  return rows.map((row) => {
    const who = row.name ?? (row.daemonId === null ? '(unnamed)' : `(pid ${row.daemonId})`);
    if (row.daemonId === null) {
      const history = row.name === null ? undefined : byName.get(row.name);
      return {
        who,
        decision: history?.lastDecision ?? null,
        disagreement: null,
      };
    }
    const entry = byDaemon.get(row.daemonId);
    const comparison = compareDaemonState(statesById.get(row.daemonId), entry);
    return {
      who,
      decision: comparison.agreement === 'agree' ? (entry?.lastDecision ?? null) : null,
      disagreement:
        comparison.agreement === 'agree' ? null : (comparison.detail ?? comparison.agreement),
    };
  });
}

/**
 * Whether the live state and the journal agree about one daemon.
 *
 *   - `agree` — they say the same thing;
 *   - `disagree` — both know the daemon, and they say **different** things;
 *   - `journal-only` — the journal knows it and the kernel does not (the
 *     journal may be from an earlier kernel);
 *   - `state-only` — the kernel knows it and the journal does not (the
 *     journal may predate this kernel, or the recording failed).
 *
 * The last two are not failures: they are what a journal and a kernel from
 * different runs look like. They are named so that nobody has to guess which
 * of the two it is.
 */
export type DaemonAgreement = 'agree' | 'disagree' | 'journal-only' | 'state-only';

export interface DaemonComparison {
  readonly agreement: DaemonAgreement;
  /** The sentence that says what differs, or `null` when they agree. */
  readonly detail: string | null;
}

/**
 * Compare what the kernel says now with what the journal says happened.
 *
 * The two answers are about different questions — *now* and *what was
 * decided* — so they are allowed to differ. What they are **not** allowed to
 * do is differ silently: a give-up the kernel remembers and the journal never
 * recorded is a decision nobody can read back, and a restart count the two
 * sides keep differently is bookkeeping that has drifted.
 */
export function compareDaemonState(
  state: DaemonState | undefined,
  decisions: DaemonDecisions | undefined,
): DaemonComparison {
  if (state === undefined && decisions === undefined) {
    return { agreement: 'agree', detail: null };
  }
  if (state === undefined) {
    return {
      agreement: 'journal-only',
      detail:
        'the journal knows this daemon, but the kernel does not have it — the journal may be from an earlier kernel',
    };
  }
  if (decisions === undefined) {
    return {
      agreement: 'state-only',
      detail:
        'the kernel is supervising it, but the journal has no record of it — the journal may predate this kernel',
    };
  }

  if (state.gaveUpReason !== null && decisions.gaveUpReason === null) {
    const reason = describeDaemonGiveUp(state.gaveUpReason) ?? state.gaveUpReason;
    return {
      agreement: 'disagree',
      detail: `the kernel says the supervisor gave up (${reason}), but the journal has no such decision`,
    };
  }
  if (state.gaveUpReason === null && decisions.gaveUpReason !== null) {
    const reason = describeDaemonGiveUp(decisions.gaveUpReason) ?? decisions.gaveUpReason;
    return {
      agreement: 'disagree',
      detail: `the journal says the supervisor gave up (${reason}), but the kernel does not`,
    };
  }
  if (state.restartCount !== decisions.restarts) {
    return {
      agreement: 'disagree',
      detail: `the kernel counts ${state.restartCount} restart(s), the journal records ${decisions.restarts}`,
    };
  }
  if (decisions.lastPid !== null && state.currentPid !== decisions.lastPid) {
    return {
      agreement: 'disagree',
      detail: `the kernel runs pid ${state.currentPid}, the journal's last attempt was pid ${decisions.lastPid}`,
    };
  }
  return { agreement: 'agree', detail: null };
}
