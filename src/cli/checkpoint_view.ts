/**
 * cortex CLI — what a checkpoint holds, and how the views say it.
 *
 * ## The rule
 *
 * **A checkpoint is the one thing in this system you can restore but never
 * look at.**
 *
 * The project keeps every snapshot: the kernel writes a `.csnap`, `cortex
 * restore` re-materialises a process from one, and the dashboard's checkpoint
 * panel lists them by pid, time and size. But nothing — in the terminal or in
 * the operator's window — could say what was *inside* one. So the panel offered
 * a **恢复** button next to no way to see what you were about to restore, and
 * `cortex restore` re-materialised a process without ever naming what it had
 * brought back.
 *
 * A snapshot holds facts an operator acts on:
 *
 * - **Who it was**: which process, taken when, in which chain, and which
 *   checkpoint came before it.
 * - **What the agent was doing**: how long its conversation had been, and
 *   which tool calls it was still waiting on.
 * - **What it knew**: the memory it carried, entry by entry.
 * - **What it had spent**: the budgets at the moment of the snapshot — and
 *   the ceiling they were measured against.
 * - **Where it was cut**: the byte offset in the syscall log that the
 *   snapshot corresponds to.
 *
 * ## What it deliberately does not say
 *
 * **The conversation itself.** A snapshot carries the agent's messages — the
 * prompts and the model answers — and the dashboard does not return those:
 * the same rule that keeps them out of the event table keeps them out of
 * here. What the view says is how *long* the conversation was, not what was
 * in it. The agent's own **intent** is state, not conversation (STATE.md
 * §2.2), and the memory panel already shows agent-authored text, so the
 * intent is said.
 *
 * ## The ceiling the snapshot did not record
 *
 * A checkpoint written by this build carries both the spend and what was
 * left of the budget. An older one may carry only the spend — and a snapshot
 * that does not say what was left **does not say the budget was unlimited**.
 * Those are different facts, so the ceiling is `—` (not reported) and never
 * `∞` (unlimited).
 *
 * ## Why it lives here
 *
 * Two views answer "what does this snapshot hold" — the terminal's
 * `cortex checkpoint --inspect` and the dashboard's checkpoint panel — and
 * they must not be able to disagree about a snapshot's budget or its shape.
 * So the *words* live here, and each view supplies only **how it prints a
 * number**: the CLI shortens (`1.2k`), the dashboard spells it out (`1,234`).
 *
 * @module cli/checkpoint_view
 */

import type { BudgetCounters, BudgetLimits, Checkpoint } from '../kernel/types.js';
import { formatDollars, usdToDollars } from '../money.js';
import { formatTokenUsage, formatTokens, tokenUsage } from '../token_usage.js';

/**
 * One memory entry as a snapshot carries it.
 *
 * The value is opaque JSON, exactly as the kernel recorded it — the view does
 * not interpret it, and neither does the memory panel.
 */
export interface CheckpointMemoryEntry {
  readonly region: string;
  readonly key: string;
  readonly value: unknown;
  readonly at: string;
}

/**
 * A tool call the agent had issued but not yet seen the answer to.
 *
 * The **tool name** is said; the arguments are not. An argument is ordinary
 * syscall input, and the dashboard does not return those either.
 */
export interface CheckpointPendingCall {
  readonly tool: string;
  readonly startedAt: string;
}

/**
 * What a checkpoint holds, as facts.
 *
 * The facts are separated from the wording so that each view can print them
 * in its own shape while saying the same thing.
 */
export interface CheckpointFacts {
  /** The chain this snapshot belongs to. */
  readonly chainId: string;
  /** The process that was snapshotted. */
  readonly pid: number;
  /** Its parent, when it had one. */
  readonly parentPid: number | null;
  /** When the snapshot was taken. */
  readonly createdAt: string;
  /** The checkpoint before this one in the same chain, when there was one. */
  readonly prevInChain: string | null;
  /** What the agent said it was doing, when it said anything. */
  readonly intent: string | null;
  /** How many messages the conversation held — the count, not the content. */
  readonly messageCount: number;
  /** The calls it was still waiting on. */
  readonly pendingCalls: readonly CheckpointPendingCall[];
  /** How many memory entries the snapshot carried. */
  readonly memoryWriteCount: number;
  /** The memory itself, in the order it was written. */
  readonly memoryEntries: readonly CheckpointMemoryEntry[];
  /** What the process had spent at the moment of the snapshot. */
  readonly budgets: BudgetCounters;
  /**
   * What the process had left of its budget.
   *
   * Absent when the snapshot did not record it. Absent means **not
   * reported** — not "unlimited".
   */
  readonly budgetsRemaining?: BudgetLimits;
  /**
   * Where in the process's syscall log the snapshot was cut.
   *
   * The log is the process's own `.crec`; the offset is the byte it was cut
   * at, and it is what ties the snapshot to the frames that came before it.
   */
  readonly logOffset: { readonly byteOffset: number };
  /** The drivers that had state in the snapshot. */
  readonly driverStates: readonly string[];
}

/**
 * What a view says about a process that was **parked at a checkpoint**.
 *
 * The rule: **SUSPENDED means checkpointed.** That is the state a checkpoint
 * with `--detach` puts a process in (`src/kernel/checkpoint.ts`), and it is
 * the only thing that puts it there — and `suspended` has no way out except a
 * restore, which builds a **new** process from the snapshot. So a suspended
 * process is not stuck and not waiting: it is *parked*, on purpose, and the
 * chain it was parked in is what brings it back.
 *
 * A row that says only `suspended` reads exactly like a row whose agent
 * died in the middle of a call, and the operator cannot tell the two apart
 * from the table they read first. So the sentence says both: that the
 * process is parked, and the command that unparks it — because a table that
 * says "this one is parked" and then leaves the operator to remember the
 * syntax is only half a tool.
 *
 * A process the kernel did not report a chain for says only that it is
 * parked: the command needs a chain id, and one that was not reported is not
 * invented.
 *
 * The words live here, next to the rest of the checkpoint wording, so the
 * table, the tree and the operator's window cannot say different things
 * about the same parked process.
 */
export function describeCheckpointPark(row: {
  readonly state?: string | undefined;
  readonly checkpointChain?: readonly string[] | undefined;
}): string {
  if (row.state !== 'suspended') return '';
  const chain = row.checkpointChain;
  // The chain is oldest first, so the **last** one is the checkpoint the
  // process was parked at — and the one that restores it to where it is.
  const latest = chain === undefined || chain.length === 0 ? undefined : chain[chain.length - 1];
  if (latest === undefined) return 'checkpointed';
  return `checkpointed — 'cortex restore --chain ${latest}' brings it back`;
}

/**
 * Take a checkpoint apart into the facts a view can say.
 *
 * The reading itself lives in the kernel (`readCheckpointFile`), so the
 * window and the kernel apply the same checks to the same bytes — a body the
 * kernel would refuse to restore is never described here either.
 */
export function describeCheckpoint(cp: Checkpoint): CheckpointFacts {
  const writes = cp.memoryDelta.writes;
  return {
    chainId: String(cp.chainId),
    pid: Number(cp.pid),
    parentPid: cp.parentPid === null ? null : Number(cp.parentPid),
    createdAt: cp.createdAt,
    prevInChain: cp.prevInChain === null ? null : String(cp.prevInChain),
    intent: cp.cognitive.intent ?? null,
    messageCount: cp.cognitive.messages.length,
    pendingCalls: cp.cognitive.pendingCalls.map((call) => ({
      tool: call.tool,
      startedAt: call.startedAt,
    })),
    memoryWriteCount: writes.length,
    memoryEntries: writes.map((write) => ({
      region: write.region,
      key: write.key,
      value: write.value,
      at: write.at,
    })),
    budgets: cp.budgets,
    ...(cp.budgetsRemaining !== undefined ? { budgetsRemaining: cp.budgetsRemaining } : {}),
    logOffset: {
      byteOffset: Number(cp.syscallLogOffset),
    },
    driverStates: Object.keys(cp.driverStates),
  };
}

/**
 * The token ceiling a snapshot was measured against.
 *
 * `null` means **unlimited** and `undefined` means **not reported** — the
 * snapshot did not say what was left. The two are different facts, and a
 * snapshot that stayed silent must not be read as one that said "unlimited".
 */
export function checkpointTokenCeiling(facts: CheckpointFacts): number | null | undefined {
  if (facts.budgetsRemaining === undefined) return undefined;
  const remaining = facts.budgetsRemaining.tokens;
  if (remaining < 0) return null;
  return tokenUsage(facts.budgets).total + remaining;
}

/**
 * The money ceiling a snapshot was measured against.
 *
 * In **microdollars**, like the spend it is measured against — the
 * conversion to dollars happens in the cell, not in the number.
 */
export function checkpointUsdCeiling(facts: CheckpointFacts): number | null | undefined {
  if (facts.budgetsRemaining === undefined) return undefined;
  const remaining = facts.budgetsRemaining.usd;
  if (remaining < 0) return null;
  return facts.budgets.usdSpent + remaining;
}

/**
 * A snapshot's token spend, next to the ceiling it was measured against.
 *
 * The same shape every other view uses (`formatTokenBudget`), and the same
 * em dash for a number nobody reported.
 *
 * @param facts What the snapshot holds.
 * @param format How this view prints a number. The CLI shortens (`1.2k`),
 *   the dashboard spells it out (`1,234`).
 */
export function formatCheckpointTokenBudget(
  facts: CheckpointFacts,
  format: (n: number) => string = formatTokens,
): string {
  const spent = formatTokenUsage(facts.budgets, format);
  const ceiling = checkpointTokenCeiling(facts);
  if (ceiling === undefined) return `${spent} of —`;
  return `${spent} of ${ceiling === null ? '∞' : format(ceiling)}`;
}

/**
 * A snapshot's money spend, next to the ceiling it was measured against.
 *
 * Printed in dollars, at the resolution the kernel counts them
 * (`src/money.ts`) — a ceiling printed at another resolution would not add
 * up to the spend beside it.
 */
export function formatCheckpointUsdBudget(facts: CheckpointFacts): string {
  const spent = formatDollars(usdToDollars(facts.budgets.usdSpent));
  const ceiling = checkpointUsdCeiling(facts);
  if (ceiling === undefined) return `${spent} of —`;
  return `${spent} of ${ceiling === null ? '∞' : formatDollars(usdToDollars(ceiling))}`;
}
