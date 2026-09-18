/**
 * Example: a self-checkpointing cortex agent (Demo B — pause across reboots).
 *
 * This agent demonstrates the checkpoint/restore lifecycle end-to-end through
 * the CLI. It runs in two phases, separated by a *self* checkpoint:
 *
 *   Phase 1 (first run):
 *     - does a unit of work (one llm_call),
 *     - records its progress in the `episodic` memory region,
 *     - calls `ctx.checkpoint({ tag, detach: true })`.
 *     `detach: true` snapshots the process and then SUSPENDS it. The `.csnap`
 *     is written to `<cortex home>/checkpoints/`. `cortex spawn` sees the
 *     SUSPENDED state and prints the chain id + a `cortex restore` hint.
 *
 *   Phase 2 (after `cortex restore`):
 *     - restore mints a NEW pid, re-hydrates the `episodic` region from the
 *     snapshot, and re-runs this same agent module from the top.
 *     - the agent reads its memory, sees `phase === 1`, and continues past the
 *     checkpoint instead of repeating phase 1.
 *
 * KEY CONTRACT (and an honest v0 limitation): a checkpoint captures the
 * process image — state, memory regions, budgets, lineage — NOT the live JS
 * call stack. The agent function restarts from the top on restore. Making
 * progress idempotent across that restart is the *agent's* job, which is why
 * this example gates phase 2 on a memory marker rather than on a local
 * variable. That is exactly how a real long-running agent should be written.
 *
 * Try it:
 *
 *   cortex spawn --role demo --module ./examples/checkpoint-agent.ts
 *   # -> "process suspended at checkpoint ... resume with: cortex restore --chain <id>"
 *   cortex restore --chain <id>      (or: cortex restore --tag demo-pause)
 *   # -> "[demo] resumed from checkpoint; phase 1 memory survived" ... exits 0
 */

import type { CortexContext } from '../src/index.js';

const TAG = 'demo-pause';
const REGION = 'episodic';
const PHASE_KEY = 'phase';

export default async function checkpointAgent(ctx: CortexContext): Promise<void> {
  // Where are we? Memory is the only state that survives a checkpoint, so it
  // — not a local variable — is the source of truth for "have I already run".
  const prior = await ctx.memory_read(REGION, { key: PHASE_KEY });
  const phase = prior.length > 0 ? (prior[0]!.value as number) : 0;

  if (phase < 1) {
    // --- Phase 1: do some work, then suspend at a checkpoint. --------------
    const resp = await ctx.llm_call({
      messages: [
        { role: 'system', content: 'You are a terse assistant. One short sentence.' },
        { role: 'user', content: 'Remember the number 42 for later.' },
      ],
    });

    await ctx.memory_write(REGION, PHASE_KEY, 1);
    await ctx.memory_write(REGION, 'phase1_note', {
      text: resp.text,
      tokens: resp.usage.inputTokens + resp.usage.outputTokens,
    });

    console.log(`[${ctx.role}] phase 1 done — checkpointing (tag '${TAG}') and suspending`);

    // detach:true => snapshot, then SUSPEND. spawn() reports the chain id.
    const { chainId } = await ctx.checkpoint({ tag: TAG, detach: true });

    // The process is now SUSPENDED. Do NOT call ctx.exit() here — there is no
    // legal suspended->exiting edge. Just return; the kernel leaves the
    // process parked until a future `cortex restore` materialises it.
    console.log(`[${ctx.role}] suspended at checkpoint ${chainId} — run 'cortex restore --tag ${TAG}' to resume`);
    return;
  }

  // --- Phase 2: we were restored; memory proves phase 1 already happened. --
  const note = await ctx.memory_read(REGION, { key: 'phase1_note' });
  console.log(`[${ctx.role}] resumed from checkpoint; phase 1 memory survived`);
  if (note.length > 0) {
    console.log(`[${ctx.role}]   phase1_note = ${JSON.stringify(note[0]!.value)}`);
  }

  await ctx.memory_write(REGION, PHASE_KEY, 2);
  await ctx.memory_write(REGION, 'phase2_note', { resumed: true, at: ctx.now() });

  console.log(`[${ctx.role}] phase 2 done — exiting`);
  ctx.exit(0, 'resumed and completed');
}
