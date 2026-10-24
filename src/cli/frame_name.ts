/**
 * cortex CLI — the name a frame is shown under.
 *
 * ## The rule
 *
 * **A frame is named after the thing that distinguishes it.**
 *
 * A real syscall is named by itself. The kernel's own bookkeeping frames
 * (`__state`, `__init`, `__sched`, `__signal`) are **placeholders** — and
 * every one of them used to print as the same anonymous word, so a log full
 * of them said nothing at all. Ten rows reading `__init` tell an operator
 * that ten things happened and not what they were.
 *
 * That mattered most for **init's log, which is the supervision journal**:
 * the durable record of every restart decision the kernel made, and the one
 * place the answer to "what did the supervisor do?" is kept. The decision is
 * in the frame's `action`, and the frame's name left it out.
 *
 * So the name carries what distinguishes the frame: the action for `__init`
 * and `__sched`, the transition **and its cause** for `__state`, the signal
 * (and what became of it) for `__signal`.
 *
 * ## Why it is its own module
 *
 * Because there is more than one view. `cortex trace`, `cortex attach` and
 * `cortex watch` print these names, and so does the **dashboard's timeline**
 * — and a frame named `__state` in one of them and
 * `__state:running->blocked(recv)` in the other is two views of one log that
 * disagree about what it says.
 *
 * A rule that only the CLI command can reach is a rule the other view
 * reinvents — and it did: the dashboard's timeline showed the bare
 * placeholder names, so the operator's window said "something happened" where
 * the terminal said what.
 *
 * The recorded syscall name is untouched — the `.crec` format is frozen, and
 * this is a *view* of it, not a change to it.
 *
 * @module cli/frame_name
 */

import type { SyscallRecord } from '../kernel/types.js';

/**
 * The name a frame is shown under.
 *
 * The recorded syscall name is untouched — the `.crec` format is frozen, and
 * this is a *view* of it, not a change to it.
 */
export function frameName(rec: SyscallRecord): string {
  const args = rec.args as Record<string, unknown> | undefined;
  switch (rec.syscall) {
    case '__init':
      return typeof args?.['action'] === 'string'
        ? `__init:${args['action']}`
        : rec.syscall;
    case '__sched': {
      const action = typeof args?.['action'] === 'string' ? args['action'] : undefined;
      if (action === undefined) return rec.syscall;
      // The cause: **why** the scheduler decided what it decided. The frame
      // recorded it — which budget ran out, what the process was waiting on,
      // why it was gone — and the view dropped it, so the log said "sigxcpu"
      // and not whether the agent had run out of tokens, of money, or of
      // wall time. One of those is actionable and two are not, and the reader
      // could not tell them apart.
      //
      // The shape is the same one the other frames use: `__state:<from>-><to>
      // (<cause>)`, `__signal:<signal>(<outcome>)`.
      const cause = schedCause(action, args);
      return cause === '' ? `__sched:${action}` : `__sched:${action}(${cause})`;
    }
    case '__state': {
      const from = typeof args?.['from'] === 'string' ? args['from'] : rec.stateBefore;
      const to = typeof args?.['to'] === 'string' ? args['to'] : rec.stateAfter;
      if (from === undefined || to === undefined) return rec.syscall;
      // The cause: **why** the process moved. Without it the log says a
      // process went from `running` to `blocked` and not whether it was
      // waiting on a channel, on a timer, on a child, or on a signal — a
      // fact without an explanation. The trigger was in the frame all along
      // (ABI.md §6.1); the view just dropped it.
      //
      // A signal is named by the signal itself, because "SIGTERM" says more
      // than "signal"; every other cause is the trigger.
      const cause = stateCause(args);
      return cause === '' ? `__state:${from}->${to}` : `__state:${from}->${to}(${cause})`;
    }
    case '__signal': {
      const signal = typeof args?.['signal'] === 'string' ? args['signal'] : undefined;
      if (signal === undefined) return rec.syscall;
      const outcome = typeof args?.['outcome'] === 'string' ? args['outcome'] : undefined;
      return outcome === undefined ? `__signal:${signal}` : `__signal:${signal}(${outcome})`;
    }
    default:
      return rec.syscall;
  }
}

/**
 * What caused a state transition.
 *
 * A signal is named by the signal — "SIGTERM" says more than "signal" — and
 * everything else is the trigger the kernel recorded (`recv`, `sleep`,
 * `wait`, `scheduler-dispatch`, …).
 *
 * Empty when the frame carries no cause at all: an older kernel recorded the
 * transition without one, and a frame that says nothing is better than one
 * that guesses.
 */
function stateCause(args: Record<string, unknown> | undefined): string {
  if (args === undefined) return '';
  const signal = args['signal'];
  if (typeof signal === 'string' && signal !== '') return signal;
  const trigger = args['trigger'];
  return typeof trigger === 'string' ? trigger : '';
}

/**
 * What made the scheduler decide what it decided.
 *
 * Each action carries the one detail that explains it:
 *
 * - `sigxcpu` — **which budget ran out**. "Your agent was stopped" and "your
 *   agent ran out of tokens" are different facts, and only one of them tells
 *   the operator what to change.
 * - `blocked` / `parked` — **what it is waiting on**, by kind. The channel id
 *   and the call id stay in the frame; a column of ids would be a column of
 *   noise.
 * - `exited` — **why it was gone**.
 *
 * Empty when the frame carries no cause: an older kernel recorded the action
 * without one, and a frame that says nothing is better than one that guesses.
 */
function schedCause(action: string, args: Record<string, unknown> | undefined): string {
  if (args === undefined) return '';
  if (action === 'sigxcpu') {
    const kind = args['budgetKind'];
    return typeof kind === 'string' ? kind : '';
  }
  if (action === 'blocked' || action === 'parked') {
    const blockedOn = args['blockedOn'];
    if (blockedOn === null || typeof blockedOn !== 'object') return '';
    const kind = (blockedOn as { readonly kind?: unknown }).kind;
    return typeof kind === 'string' ? kind : '';
  }
  if (action === 'exited') {
    const reason = args['reason'];
    return typeof reason === 'string' ? reason : '';
  }
  return '';
}
