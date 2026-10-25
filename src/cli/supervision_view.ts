/**
 * cortex CLI — what the kernel decided about its own supervision.
 *
 * ## The rule
 *
 * **A decision the kernel made is a fact the operator is owed.**
 *
 * The kernel records every supervisory decision in **init's own log** — the
 * supervision journal (docs/PROCESS.md §9.1, docs/ABI.md §6.1). A daemon was
 * registered; an attempt died; the supervisor started a new one; the
 * supervisor gave up; the kernel booted; the kernel shut down. Each of those
 * is a `__init` frame with the decision in its `action` and the details in
 * its `args`.
 *
 * And the window dropped **all** of it.
 *
 * The activity feed's rule was "the kernel's own `__`-prefixed frames are not
 * the agent's work" — which is right for the per-process bookkeeping
 * (`__state`, `__sched`, `__signal`: those restate something a process's own
 * row already says) and wrong for init's journal, which is a record of
 * **decisions**. So the operator's window showed a daemon crashing three
 * times and said nothing about the fact that the supervisor had restarted it
 * twice and then deliberately given up: the log said `__init:restart` and
 * `__init:restart-gave-up`, and the feed had no rows for either.
 *
 * ## What this module is for
 *
 * Turning one of those frames into the facts it carries and the sentence that
 * says them. The rule (which frame means what) and the wording live here, so
 * the terminal and the window cannot disagree about what the supervisor did —
 * and so a check can hold them to the same sentence.
 *
 * ## What it does not do
 *
 * It does not decide anything. The decisions were made by init, long before
 * any view ran; this reads the record.
 *
 * @module cli/supervision_view
 */

import type { InitAction, InitGiveUpReason } from '../kernel/init.js';
import type { SyscallRecord } from '../kernel/types.js';

/**
 * The facts one supervision frame carries.
 *
 * Every field is `null` when the frame did not report it — never a zero and
 * never a made-up default. A frame that says nothing about the exit code says
 * nothing about the exit code.
 */
export interface SupervisionFacts {
  /** Which decision this is. */
  readonly action: InitAction;
  /** The role of the daemon the decision is about. */
  readonly role: string | null;
  /**
   * The operator's own name for the daemon, when the kernel was given one.
   *
   * It is the join key between the registry and the journal — and between
   * the journal and the live state, which is why it is a fact here and not
   * something a view has to dig out of the frame's args.
   */
  readonly name: string | null;
  /** The logical daemon's id — the pid it was registered under. */
  readonly daemonId: number | null;
  /** The process the decision is about: the one that died, or the one registered. */
  readonly pid: number | null;
  /** The process that took its place, when one did. */
  readonly newPid: number | null;
  /** Which attempt this is — a restart counts the attempts. */
  readonly attempt: number | null;
  /** Why the previous attempt ended. */
  readonly previousExitReason: string | null;
  /** The exit code of the process that ended. */
  readonly exitCode: number | null;
  /** Why the kernel gave up: `max-restarts` or `restart-storm`. */
  readonly reason: string | null;
  /** The restart policy a daemon was registered with. */
  readonly policy: string | null;
  /** How many restarts had happened. */
  readonly restartCount: number | null;
  /** The cap that was reached. */
  readonly maxRestarts: number | null;
  /** The storm: how many restarts, in what window. */
  readonly count: number | null;
  readonly windowMs: number | null;
  /** The shutdown report. */
  readonly signalled: readonly number[] | null;
  readonly reaped: readonly number[] | null;
  readonly restartsCancelled: number | null;
  readonly remaining: readonly number[] | null;
}

/** A read that is a string is a string. */
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A read that is a count is a count. */
function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A read that is a list of pids is a list of pids. */
function asPidList(value: unknown): readonly number[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry));
}

/**
 * The supervision actions this module knows how to say.
 *
 * The kernel's own list lives in `src/kernel/init.ts` (`INIT_ACTIONS`), and a
 * smoke check holds the two to each other — so a new action cannot be added
 * to the kernel and left unsaid here.
 */
export const SUPERVISION_ACTIONS: readonly InitAction[] = [
  'boot',
  'register-daemon',
  'reap',
  'restart',
  'restart-gave-up',
  'shutdown',
];

/**
 * The reasons the supervisor can give up on a daemon — and the ones this
 * module can say.
 *
 * The kernel's own list lives in `src/kernel/init.ts`
 * (`INIT_GIVE_UP_REASONS`), and a smoke check holds the two to each other: a
 * reason the kernel can produce and no view can say is a reason that reaches
 * the operator as an unexplained row. That is exactly what happened to the
 * `policy` give-up — the one the *policy* decides — before the journal named
 * it too.
 */
export const SUPERVISION_GIVE_UP_REASONS: readonly InitGiveUpReason[] = [
  'policy',
  'max-restarts',
  'restart-storm',
];

/**
 * Read one frame's supervision facts — or `undefined` when the frame is not
 * a supervision decision at all.
 *
 * A frame that says `__init` but carries an action nobody knows is **not**
 * turned into facts: an unknown action is a frame this module cannot read,
 * and guessing what it meant is how a view starts lying.
 */
export function describeSupervision(record: SyscallRecord): SupervisionFacts | undefined {
  if (record.syscall !== '__init') return undefined;
  const args = (record.args ?? {}) as Record<string, unknown>;
  const action = asString(args['action']);
  if (action === null) return undefined;
  if (!SUPERVISION_ACTIONS.includes(action as InitAction)) return undefined;

  const restartCount = asCount(args['restartCount']);
  const exitCode = asCount(args['exitCode']);
  const newPid = asCount(args['newPid']);
  // The `reap` frame's `restarted` field names the process that replaced the
  // one that died — and is null when the supervisor let it go. That is the
  // same fact the `restart` frame carries as `newPid`.
  const restarted = asCount(args['restarted']);

  return {
    action: action as InitAction,
    role: asString(args['role']),
    name: asString(args['name']),
    daemonId: asCount(args['daemonId']),
    pid: asCount(args['pid']),
    newPid: newPid ?? restarted,
    attempt: restartCount,
    previousExitReason: asString(args['prevExitReason']) ?? asString(args['exitReason']),
    exitCode,
    reason: asString(args['reason']),
    policy: asString(args['restart']),
    restartCount,
    maxRestarts: asCount(args['maxRestarts']),
    count: asCount(args['count']),
    windowMs: asCount(args['windowMs']),
    signalled: asPidList(args['signalled']),
    reaped: asPidList(args['reaped']),
    restartsCancelled: asCount(args['restartsCancelled']),
    remaining: asPidList(args['remaining']),
  };
}

/**
 * The sentence that says what the supervisor decided.
 *
 * One sentence per decision, in the same words everywhere. The wording is
 * plain and says the thing that happened: **what** was decided, **to whom**,
 * and — where there is one — **why**.
 */
export function formatSupervision(facts: SupervisionFacts): string {
  const role = facts.role ?? 'daemon';
  // The operator's own name, when the kernel was given one.
  //
  // A role is not an identity — two daemons may share one and differ only by
  // their module — so a decision that names only the role cannot be
  // attributed to a daemon. The journal carries the name now, and the
  // sentence says it.
  const who = facts.name === null ? `daemon ${role}` : `daemon ${facts.name} (${role})`;
  switch (facts.action) {
    case 'boot':
      return 'kernel booted';
    case 'register-daemon': {
      const policy = facts.policy;
      return policy === null
        ? `${who} registered`
        : `${who} registered (restart: ${policy})`;
    }
    case 'restart': {
      const attempt = facts.attempt === null ? '' : `attempt ${facts.attempt}`;
      const previous = facts.previousExitReason === null
        ? ''
        : `, previous exit: ${facts.previousExitReason}`;
      const pid = facts.newPid === null ? '' : ` as pid ${facts.newPid}`;
      const detail = [attempt, previous.replace(/^, /, '')].filter((part) => part !== '').join(', ');
      return `${who} restarted${pid}${detail === '' ? '' : ` (${detail})`}`;
    }
    case 'reap': {
      const ended = facts.exitCode === null
        ? ''
        : `exit ${facts.exitCode}${facts.previousExitReason === null ? '' : `: ${facts.previousExitReason}`}`;
      const pid = facts.pid === null ? 'a process' : `pid ${facts.pid}`;
      const replacement = facts.newPid === null
        ? 'not restarted'
        : `restarted as pid ${facts.newPid}`;
      return `${pid} reaped${ended === '' ? '' : ` (${ended})`} -> ${replacement}`;
    }
    case 'restart-gave-up': {
      if (facts.reason === 'restart-storm') {
        const count = facts.count === null ? 'many' : String(facts.count);
        const window = facts.windowMs === null ? '' : ` in ${facts.windowMs} ms`;
        return `${who} not restarted -> restart storm (${count} restarts${window})`;
      }
      if (facts.reason === 'max-restarts') {
        const cap = facts.maxRestarts === null ? '' : ` (${facts.maxRestarts})`;
        const count = facts.restartCount === null ? '' : ` after ${facts.restartCount} restart(s)`;
        return `${who} not restarted -> max restarts reached${cap}${count}`;
      }
      if (facts.reason === 'policy') {
        // The give-up the **policy** decides. It used to be the one give-up
        // the journal had no word for: the kernel knew it, the live state
        // said it, and the supervision journal said only "not restarted".
        const policy = facts.policy === null ? '' : ` (${facts.policy})`;
        return `${who} not restarted -> the restart policy says no${policy}`;
      }
      return `${who} not restarted`;
    }
    case 'shutdown': {
      const signalled = facts.signalled === null ? 0 : facts.signalled.length;
      const reaped = facts.reaped === null ? 0 : facts.reaped.length;
      const cancelled = facts.restartsCancelled === null ? 0 : facts.restartsCancelled;
      const remaining = facts.remaining === null ? 0 : facts.remaining.length;
      return `kernel shut down (${signalled} signalled, ${reaped} reaped, ${cancelled} restart(s) cancelled, ${remaining} remaining)`;
    }
    default:
      // An action this module does not know. `describeSupervision` refuses
      // those, so this is unreachable — and if it ever is reached, the
      // sentence says so rather than inventing a decision.
      return `supervision decision (${String(facts.action)})`;
  }
}
