/**
 * cortex CLI — what the kernel says about itself, and how the views say it.
 *
 * ## The rule
 *
 * **A view must not claim what it has not checked.**
 *
 * The dashboard's sidebar used to say 「本地节点已连接」 and 「ABI 1.0」 in
 * plain HTML — both of them, always, whether a kernel was running or not, and
 * whatever ABI that kernel actually spoke. The window's own chrome was making
 * two claims the window had never checked, while two panels inside it (the
 * memory view and the tool surface) said out loud that they could not answer
 * without a live kernel. A window that admits "this one needs a kernel" in
 * one place and "the node is connected" in another is a window the operator
 * cannot calibrate.
 *
 * So the kernel is asked. The transport already has the question — `ping` —
 * and the probe already sends it, and throws the answer away. The answer is:
 *
 * - **which** kernel this is (its OS pid),
 * - **what** it speaks (its ABI version),
 * - **how long** it has been up (so a stale window is recognisable),
 * - and **how many** daemons it supervises.
 *
 * ## Three states, not two
 *
 * "There is no kernel here" and "the kernel here is not answering" are
 * different facts, and a view that merges them is guessing:
 *
 * - `live` — it answered.
 * - `none` — no kernel is attached to this window.
 * - `unreachable` — there is one, and it did not answer.
 *
 * ## What it does not say
 *
 * **Anything about the work the kernel is doing.** That is the process table,
 * the event feed and the tool surface. This module says which node the window
 * is attached to — nothing more.
 *
 * @module cli/kernel_view
 */

import { formatAge } from './process_view.js';

/**
 * What the kernel is to this window.
 *
 * `none` and `unreachable` are different answers, so they are different
 * states: a window that cannot tell them apart will either claim a
 * connection that is not there or hide one that is.
 */
export type KernelState = 'live' | 'none' | 'unreachable';

/**
 * The kernel's own answer to "who are you" — the transport's `ping`.
 *
 * Every field is `unknown` here because the transport is a wire: what
 * arrives is whatever the other end sent. A field that is not a string is
 * not a string.
 */
export interface KernelPing {
  readonly abiVersion?: unknown;
  readonly kernelPid?: unknown;
  readonly startedAt?: unknown;
  readonly daemons?: unknown;
}

/** What a view can say about the kernel behind it. */
export interface KernelFacts {
  /** Which of the three states this is. */
  readonly state: KernelState;
  /** The ABI version the kernel speaks, or null when there is none to ask. */
  readonly abiVersion: string | null;
  /** The kernel's OS pid, or null. */
  readonly pid: number | null;
  /** When the kernel started serving, or null. */
  readonly startedAt: string | null;
  /** How many daemons it supervises, or null. */
  readonly daemons: number | null;
  /** How long it has been up, in milliseconds, or null. */
  readonly uptimeMs: number | null;
  /** How long it has been up, as the views print it — or null. */
  readonly uptimeLabel: string | null;
  /** Why it could not be reached, when it could not. */
  readonly error: string | null;
}

/** A read that is not a string is not a string. */
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A read that is not a count is not a count. */
function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Describe the kernel behind a view.
 *
 * `ping` is the answer when there was one; `error` is the reason there was
 * not. Passing neither says "there is no kernel here" — which is a fact the
 * window can state, and used to be the thing it papered over.
 *
 * The uptime is printed with the **same** function the process table prints
 * an age with (`formatAge`), because a duration that reads `31m` in one panel
 * and `1860000ms` in another is two rules, and two rules drift.
 */
export function describeKernel(
  ping?: KernelPing,
  error?: unknown,
  now: number = Date.now(),
): KernelFacts {
  if (error !== undefined) {
    return {
      state: 'unreachable',
      abiVersion: null,
      pid: null,
      startedAt: null,
      daemons: null,
      uptimeMs: null,
      uptimeLabel: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (ping === undefined) {
    // No kernel attached. Every fact about it is *not reported* — which is
    // null, never zero and never a made-up default.
    return {
      state: 'none',
      abiVersion: null,
      pid: null,
      startedAt: null,
      daemons: null,
      uptimeMs: null,
      uptimeLabel: null,
      error: null,
    };
  }

  const startedAt = asString(ping.startedAt);
  const startedMs = startedAt === null ? Number.NaN : Date.parse(startedAt);
  const uptimeMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : null;
  return {
    state: 'live',
    abiVersion: asString(ping.abiVersion),
    pid: asCount(ping.kernelPid),
    startedAt,
    daemons: asCount(ping.daemons),
    uptimeMs,
    uptimeLabel: uptimeMs === null ? null : formatAge(uptimeMs),
    error: null,
  };
}

/**
 * The line the CLI prints about the kernel it is watching.
 *
 * One line, and it **names** the kernel: there is one per project directory
 * (docs/ARCHITECTURE.md §12.2), so "the live kernel" does not say which one
 * the operator is looking at. A pid, the ABI it speaks and how long it has
 * been up — the three facts that tell two kernels apart.
 *
 * The window's sidebar says the same three facts in its own words, from the
 * same facts; what cannot differ between the two views is the *fact*.
 */
export function formatKernelLine(facts: KernelFacts): string {
  if (facts.state === 'none') {
    return 'No live kernel in this directory — showing what is on disk:';
  }
  if (facts.state === 'unreachable') {
    return 'The kernel did not answer — showing what is on disk:';
  }
  return (
    `Watching kernel pid ${facts.pid ?? '?'} (ABI ${facts.abiVersion ?? '?'}, ` +
    `up ${facts.uptimeLabel ?? '?'}) — running processes and a pushed event stream.`
  );
}
