/**
 * cortex CLI — `cortex replay` core (no I/O).
 *
 * ## What "replay" compares
 *
 * A replay re-runs an agent with the world frozen (see `kernel/replay.ts`).
 * Two things then exist: the **recording** (what happened) and the **replay
 * log** (what happened when the same code ran again). This module turns the
 * two logs into one answer:
 *
 *   - did the replay reproduce the recording? and
 *   - if not, **where** did it first go wrong?
 *
 * ## Why the unit of comparison is a *call*, not a frame
 *
 * A syscall is written down as two frames: an `enter` (the request) and an
 * `exit` or `trap` (the outcome). Comparing frames would compare a request
 * with a request and an outcome with an outcome — two sequences that can
 * drift apart without anything actually going wrong. A **call** is the pair:
 * what was asked *and* what came back. That is the thing an agent's
 * behaviour is made of.
 *
 * ## Why the comparison is positional, not an LCS
 *
 * `diff_core.ts` aligns two logs with an LCS, because a fork's two branches
 * share a causal past and the interesting question is "what did each branch
 * do *differently*". A replay asks a different question: "did the same code,
 * run again, do the same things **in the same order**?". A replay that
 * inserted one extra call has already diverged, and the divergence is
 * *there* — at that call. An LCS would realign around it and report the
 * divergence somewhere else, or hide it. So: the first position where the
 * two sequences differ **is** the answer.
 *
 * ## What is deliberately not compared
 *
 * Four kinds of difference are noise, not behaviour, and are ignored:
 *
 *  1. **Freshly generated identities** — a checkpoint's `chainId`, a fork's
 *     `childChainId`. Every run mints new ones; comparing them would report
 *     a divergence on every single call.
 *  2. **Positions in a byte stream** — a checkpoint's `syscallLogOffset`, a
 *     fork's `sharedCausalPast`. They say *where* the run was written, not
 *     what the agent did.
 *  3. **The size of an opaque blob** — a checkpoint's `byteSize`. The
 *     snapshot's bytes include the moment it was taken.
 *  4. **The replay's own wall clock** — a message's `sentAt`. The replay
 *     happens later; that is the whole point of a replay.
 *
 * Everything else is compared verbatim, including process ids: a replay is
 * given the same pid as the original run, so its children get the same pids
 * too, and a pid that differs is a real difference in the shape of the run.
 *
 * See: docs/STATE.md §5.5, docs/ABI.md §4.3, BACKLOG #072
 *
 * @module cli/replay_core
 */

import type { SyscallRecord } from '../kernel/types.js';
import { stableJson } from './diff_core.js';

// =============================================================================
// §1. Calls
// =============================================================================

/**
 * One logical syscall: the request and the outcome together.
 *
 * `args` is what the process asked for; `result` is what it got back;
 * `error` is what it got instead, when the call trapped. Exactly one of
 * `result` / `error` is present for a call that completed.
 */
export interface ComparedCall {
  /** The syscall's name. */
  readonly syscall: string;
  /** The recorded arguments, if the call had any. */
  readonly args?: unknown;
  /** The outcome, when the call succeeded. */
  readonly result?: unknown;
  /** The failure, when the call trapped. */
  readonly error?: {
    readonly errno: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

/**
 * The result fields that are ignored when two calls are compared.
 *
 * See the module doc for why each group is noise rather than behaviour.
 */
export const IGNORED_RESULT_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // A fresh identity, a position in the log, and the size of a blob that
  // contains the moment it was taken.
  checkpoint: ['chainId', 'byteSize', 'syscallLogOffset'],
  // A fresh identity, and a position in the parent's log.
  fork: ['childChainId', 'sharedCausalPast'],
  // The restored process's pid: a position in the process table.
  restore: ['pid'],
  // The moment the message was sent — the replay happens later, by design.
  recv: ['sentAt'],
});

/**
 * Pull the calls out of a log.
 *
 * The `enter` frame carries the request; its `exit` / `trap` partner carries
 * the outcome. They are paired by `callId`. The kernel's own `__`-prefixed
 * bookkeeping frames are not the agent's work and are skipped: a replay
 * produces its own.
 *
 * A frame with no partner is still a call — that is what a *synchronous*
 * syscall looks like (`now`, `random`, `on_signal` are one frame each), and
 * so is the process's own `exit`.
 */
export function extractCalls(records: readonly SyscallRecord[]): ComparedCall[] {
  /** callId → the request half of a call that is still open. */
  const open = new Map<string, { readonly syscall: string; readonly args: unknown }>();
  const calls: ComparedCall[] = [];

  for (const record of records) {
    if (record.syscall.startsWith('__')) continue;

    if (record.phase === 'enter') {
      open.set(record.callId, { syscall: record.syscall, args: record.args });
      continue;
    }

    const request = open.get(record.callId);
    if (request !== undefined) {
      open.delete(record.callId);
      calls.push({
        syscall: request.syscall,
        ...(request.args !== undefined ? { args: request.args } : {}),
        ...(record.result !== undefined ? { result: record.result } : {}),
        ...(record.error !== undefined ? { error: record.error } : {}),
      });
      continue;
    }

    // No request half: a standalone frame (a synchronous syscall, or the
    // process's own exit).
    calls.push({
      syscall: record.syscall,
      ...(record.args !== undefined ? { args: record.args } : {}),
      ...(record.result !== undefined ? { result: record.result } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
    });
  }

  return calls;
}

// =============================================================================
// §2. Comparison
// =============================================================================

/** How the two runs first differ. */
export type DivergenceKind =
  /** The same call, with a different request or a different outcome. */
  | 'changed'
  /** The replay made a call the recording does not have. */
  | 'extra'
  /** The recording has a call the replay never made. */
  | 'missing';

export interface ReplayDivergence {
  /** Where in the sequence the two runs first differ (0-based). */
  readonly index: number;
  /** Which way they differ. */
  readonly kind: DivergenceKind;
  /** The call the recording made. */
  readonly original: ComparedCall | null;
  /** The call the replay made. */
  readonly replay: ComparedCall | null;
}

export interface ReplayComparison {
  /** Did the replay make the same calls, in the same order, with the same outcomes? */
  readonly reproduced: boolean;
  /** How many calls the recording holds. */
  readonly originalCalls: number;
  /** How many calls the replay holds. */
  readonly replayCalls: number;
  /** The first difference, or `null` when there is none. */
  readonly divergence: ReplayDivergence | null;
}

/**
 * The identity of a call, for comparison purposes.
 *
 * The ignored fields are dropped *before* the value is serialised, so a
 * difference in one of them cannot show up as a difference in the signature.
 */
export function callSignature(call: ComparedCall): string {
  const ignored = IGNORED_RESULT_FIELDS[call.syscall] ?? [];
  const result =
    call.result === undefined
      ? undefined
      : dropFields(call.result, ignored);
  return JSON.stringify([
    call.syscall,
    call.args === undefined ? null : stableJson(call.args),
    result === undefined ? null : stableJson(result),
    call.error === undefined ? null : stableJson(call.error),
  ]);
}

/** Remove the named fields from an object, if it is one. */
function dropFields(value: unknown, fields: readonly string[]): unknown {
  if (fields.length === 0) return value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    if (fields.includes(key)) continue;
    out[key] = src[key];
  }
  return out;
}

/**
 * Compare two runs' calls.
 *
 * The first position where the two sequences differ is the divergence —
 * everything after it is downstream of it and is not reported.
 */
export function compareCalls(
  original: readonly ComparedCall[],
  replay: readonly ComparedCall[],
): ReplayComparison {
  const shared = Math.min(original.length, replay.length);
  for (let i = 0; i < shared; i++) {
    const a = original[i]!;
    const b = replay[i]!;
    if (callSignature(a) === callSignature(b)) continue;
    return {
      reproduced: false,
      originalCalls: original.length,
      replayCalls: replay.length,
      divergence: { index: i, kind: 'changed', original: a, replay: b },
    };
  }

  if (original.length > replay.length) {
    return {
      reproduced: false,
      originalCalls: original.length,
      replayCalls: replay.length,
      divergence: {
        index: shared,
        kind: 'missing',
        original: original[shared] ?? null,
        replay: null,
      },
    };
  }
  if (replay.length > original.length) {
    return {
      reproduced: false,
      originalCalls: original.length,
      replayCalls: replay.length,
      divergence: {
        index: shared,
        kind: 'extra',
        original: null,
        replay: replay[shared] ?? null,
      },
    };
  }

  return {
    reproduced: true,
    originalCalls: original.length,
    replayCalls: replay.length,
    divergence: null,
  };
}

// =============================================================================
// §3. Reporting
// =============================================================================

/**
 * Where two values part ways.
 *
 * "The replay diverged" is not an answer; "the request differs at
 * `messages[1].content`" is. This walks two values side by side and reports
 * the first place they differ, in words a human can act on.
 */
export interface Difference {
  /** The path to the difference, e.g. `request.messages[1].content`. */
  readonly path: string;
  /** The recorded value at that path. */
  readonly recorded: unknown;
  /** The replayed value at that path. */
  readonly replay: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The first place two values differ, or `null` when they do not.
 *
 * `root` names the value being compared, so the path reads as a sentence:
 * `firstDifference(a, b, 'request')` reports `request.messages[1].content`.
 */
export function firstDifference(recorded: unknown, replay: unknown, root: string): Difference | null {
  if (Array.isArray(recorded) && Array.isArray(replay)) {
    if (recorded.length !== replay.length) {
      return {
        path: `${root} (${recorded.length} entries vs ${replay.length})`,
        recorded: recorded.length,
        replay: replay.length,
      };
    }
    for (let i = 0; i < recorded.length; i++) {
      const diff = firstDifference(recorded[i], replay[i], `${root}[${i}]`);
      if (diff !== null) return diff;
    }
    return null;
  }
  if (isPlainObject(recorded) && isPlainObject(replay)) {
    const keys = [...new Set([...Object.keys(recorded), ...Object.keys(replay)])].sort();
    for (const key of keys) {
      if (!(key in recorded) || !(key in replay)) {
        return { path: `${root}.${key}`, recorded: recorded[key], replay: replay[key] };
      }
      const diff = firstDifference(recorded[key], replay[key], `${root}.${key}`);
      if (diff !== null) return diff;
    }
    return null;
  }
  if (stableJson(recorded) !== stableJson(replay)) {
    return { path: root, recorded, replay };
  }
  return null;
}

/** A short, human-readable rendering of one call. */
export function formatCall(call: ComparedCall | null): string {
  if (call === null) return '(nothing)';
  const request = call.args === undefined ? '' : ` ${brief(call.args)}`;
  if (call.error !== undefined) {
    return `${call.syscall}${request} → trap ${call.error.errno}`;
  }
  return `${call.syscall}${request} → ${brief(call.result)}`;
}

/** A one-line rendering of a divergence. */
export function formatDivergence(divergence: ReplayDivergence): string {
  const at = `#${divergence.index + 1}`;
  switch (divergence.kind) {
    case 'changed':
      return `${at} changed\n${describeChanged(divergence.original!, divergence.replay!)}`;
    case 'extra':
      return `${at} only in the replay\n    replay:   ${formatCall(divergence.replay)}`;
    case 'missing':
      return `${at} only in the recording\n    recorded: ${formatCall(divergence.original)}`;
  }
}

/**
 * Say *what* changed between two calls.
 *
 * The syscall is the same in both — that is why they are compared position by
 * position — so the difference is in the request, the outcome, or the
 * failure. Each is reported separately, with the first differing path inside
 * it, because "the outcome differs at `text`" is the answer and "the outcome
 * differs" is only the beginning of one.
 */
function describeChanged(original: ComparedCall, replay: ComparedCall): string {
  const lines: string[] = [];
  const request = firstDifference(original.args, replay.args, 'request');
  if (request !== null) {
    lines.push(`    the request differs at ${request.path}`);
    lines.push(`      recorded: ${brief(request.recorded)}`);
    lines.push(`      replay:   ${brief(request.replay)}`);
  }
  const outcome = firstDifference(original.result, replay.result, 'outcome');
  if (outcome !== null) {
    lines.push(`    the outcome differs at ${outcome.path}`);
    lines.push(`      recorded: ${brief(outcome.recorded)}`);
    lines.push(`      replay:   ${brief(outcome.replay)}`);
  }
  const failure = firstDifference(original.error, replay.error, 'failure');
  if (failure !== null) {
    lines.push(`    the failure differs at ${failure.path}`);
    lines.push(`      recorded: ${brief(failure.recorded)}`);
    lines.push(`      replay:   ${brief(failure.replay)}`);
  }
  if (lines.length === 0) {
    // The signatures differ but no field-level difference was found — the
    // ignored fields (a fresh chain id, a log offset) are all that changed.
    lines.push('    (only the run-specific bookkeeping differs)');
  }
  return lines.join('\n');
}

function brief(value: unknown): string {
  if (value === undefined) return '-';
  let s: string;
  try {
    s = JSON.stringify(stableJson(value)) ?? String(value);
  } catch {
    s = String(value);
  }
  return s.length > 72 ? `${s.slice(0, 69)}...` : s;
}
