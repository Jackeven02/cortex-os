/**
 * cortex dashboard — what the window's connection indicator may claim.
 *
 * ## The rule
 *
 * **A view must not claim what it has not checked.** This module exists
 * because the window's top bar broke that rule in three different ways at
 * once, and the sidebar (which was fixed to ask the kernel) contradicted it
 * on the same screen:
 *
 * - it said 「实时连接（SSE）」 with a green dot **when there was no kernel at
 *   all** — the stream was following the *directory*, not a kernel;
 * - it said the same thing **after the kernel died under the window** — the
 *   push could not deliver another frame, and the sidebar had already turned
 *   red and said 「内核失联」;
 * - and when the stream failed and the window fell back to polling, the dot
 *   **stayed red forever** — a window that cannot get back to green is a
 *   window that has stopped saying anything about the connection at all.
 *
 * So the top bar now says what the window can actually back up, and the
 * words come from here — one place, so the terminal and the window cannot
 * drift apart, and so a check can hold them to the same sentence.
 *
 * ## What the indicator is allowed to talk about
 *
 * Two facts, and only two:
 *
 * - **where the data comes from** — a live kernel, the disk, or a kernel that
 *   stopped answering. The kernel is asked (`ping`), so this is checked.
 * - **how the window is fetching it** — a pushed stream or a poll. This is a
 *   fact about the *window*, and the window is the only thing that knows it,
 *   so it says so when it asks.
 *
 * ## The tone
 *
 * The tone is not a colour — it is *how much to believe the numbers on the
 * screen*: `live` (a kernel is behind them), `warn` (they are the disk's
 * records, which is all there is), `dead` (the kernel is gone and what is on
 * screen is what the disk still has). The page owns the palette; this module
 * owns the meaning.
 *
 * @module dashboard/connection_view
 */

import type { KernelState } from '../cli/kernel_view.js';

/**
 * How the window is fetching its data.
 *
 * `sse` — a pushed event stream. `poll` — the window asks every few seconds.
 */
export type WindowTransport = 'sse' | 'poll';

/** What the indicator is allowed to claim. */
export interface ConnectionFacts {
  /**
   * How the window is fetching its data.
   *
   * A fact about the window rather than about the world, so the window is
   * the one that reports it.
   */
  readonly transport: WindowTransport;
  /** What the kernel behind the window is doing — checked, never assumed. */
  readonly kernel: KernelState;
}

/**
 * How much to believe the numbers on the screen.
 *
 * `live` — a kernel is behind them. `warn` — they are the disk's records.
 * `dead` — the kernel is gone; what is on screen is what the disk still has.
 */
export type ConnectionTone = 'live' | 'warn' | 'dead';

/** What the indicator says, and how seriously to take it. */
export interface ConnectionLabels {
  readonly tone: ConnectionTone;
  /** The line next to the dot. */
  readonly label: string;
}

/**
 * Say what the window's connection is.
 *
 * The unreachable case comes first, because it is the one that used to be
 * claimed as a live connection: a kernel that stopped answering is not a
 * kernel that is pushing, and the data on screen is the disk's.
 */
export function describeConnection(facts: ConnectionFacts): ConnectionLabels {
  if (facts.kernel === 'unreachable') {
    return {
      tone: 'dead',
      label: '内核失联 · 只能读磁盘记录',
    };
  }
  if (facts.kernel === 'none') {
    // No kernel here. The stream that is open follows the **directory** — it
    // is real and it is fresh, but it is not a kernel saying anything.
    return facts.transport === 'sse'
      ? { tone: 'warn', label: '磁盘记录 · 目录跟随（SSE）' }
      : { tone: 'warn', label: '磁盘记录 · 轮询更新' };
  }
  return facts.transport === 'sse'
    ? { tone: 'live', label: '内核实时推送（SSE）' }
    : { tone: 'live', label: '活内核 · 轮询更新' };
}
