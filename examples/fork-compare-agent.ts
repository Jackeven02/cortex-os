/**
 * Example: fork into two branches and let them diverge (Demo C — BACKLOG #042).
 *
 * A coder agent hits a decision point — which dedup strategy to ship for a
 * high-volume event stream — and forks so it can explore BOTH strategies in
 * parallel, then you diff the two branches and keep the winner. This is the
 * atom of *agent search*: spawn N branches, evaluate, keep best.
 *
 * Run it, note the two PIDs it prints, then:
 *
 *   cortex spawn --role demo --module ./examples/fork-compare-agent.ts
 *   # -> [parent 2] forked as pid 3 — branch A: counting bloom filter
 *   # -> [branch B pid 3] resumed from the fork's snapshot
 *   cortex diff 2 3
 *
 * The capture in `examples/demo-c.capture.log` shows exactly this.
 *
 * ## How the two branches tell themselves apart
 *
 * A forked child does **not** resume at the fork point. Like a restored
 * checkpoint, it re-runs this module from the top with the parent's cognitive
 * snapshot and memory regions as of the fork (see `examples/checkpoint-agent.ts`
 * for the same contract, stated at greater length). So the agent has to
 * distinguish "am I the original or the fork?" using state that survives — and
 * memory is the only such state.
 *
 * The trick: write a `forked` marker **before** calling `ctx.fork()`. The child
 * inherits it in its snapshot and therefore skips the parent's block; the
 * parent, running past the fork, never re-reads it. Writing the marker *after*
 * the fork would not work — the child's snapshot is already sealed by then.
 *
 * This is not a kernel feature, it is a pattern. The kernel's job is only to
 * guarantee that the two branches then diverge cleanly and that we can diff
 * what each one did.
 *
 * @module examples/fork-compare-agent
 */

import type { CortexContext } from '../src/index.js';

const REGION = 'episodic';
const SHARED = 'semantic';

export default async function forkCompareAgent(ctx: CortexContext): Promise<void> {
  const prior = await ctx.memory_read(REGION, { key: 'forked' });
  const alreadyForked = prior.length > 0 && prior[0]!.value === true;

  if (!alreadyForked) {
    // --- Shared causal past: runs once, before the fork. -------------------
    // Both branches inherit this work (cognitive snapshot + memory regions),
    // which is exactly what makes the later diff meaningful: the divergence
    // starts at the fork, not at the top. In production the requirement would
    // come from an upstream `llm_call`; here it is a fixed spec so the demo
    // runs offline and deterministically.
    const requirement = {
      problem: 'dedupe a high-volume event stream (≈1M ev/s)',
      constraint: 'memory-tight; a tiny false-positive rate is acceptable',
    };
    await ctx.memory_write(SHARED, 'requirement', requirement);

    // Sealed into the child's snapshot — see the header note.
    await ctx.memory_write(REGION, 'forked', true);

    const { childPid } = await ctx.fork({ tag: 'dedup-strategy' });
    console.log(`[parent ${ctx.pid}] forked as pid ${childPid} — branch A: counting bloom filter`);

    // --- Branch A ----------------------------------------------------------
    // The model is asked for the bloom-filter design. The returned text would
    // be parsed in production; here the proposal is the structured decision the
    // agent committed to, written to the shared region so `cortex diff` can see
    // it.
    await ctx.llm_call({
      messages: [
        { role: 'user', content: 'Design dedup with a counting Bloom filter.' },
      ],
    });
    const proposalA = {
      approach: 'counting bloom filter',
      spaceComplexity: 'O(k) bits, k = hashes x bits-per-counter',
      falsePositiveRate: 'tunable, ~1% at 10 bits/key',
      handles: 'memory-tight, very high throughput, tolerates rare false positives',
    };
    await ctx.memory_write(SHARED, 'proposal:A', proposalA);
    console.log(`[branch A pid ${ctx.pid}] ${JSON.stringify(proposalA)}`);
    ctx.exit(0, 'branch A complete');
  }

  // --- Branch B: the forked child, re-running from the top -----------------
  console.log(`[branch B pid ${ctx.pid}] resumed from the fork's snapshot`);
  await ctx.llm_call({
    messages: [
      { role: 'user', content: 'Design dedup with an LRU-bounded hash set.' },
    ],
  });
  const proposalB = {
    approach: 'lru-bounded hash set',
    spaceComplexity: 'O(cap) entries, cap = retained recent window',
    falsePositiveRate: '0 (exact)',
    handles: 'exact dedup, bounded recent window, higher per-key memory',
  };
  await ctx.memory_write(SHARED, 'proposal:B', proposalB);
  console.log(`[branch B pid ${ctx.pid}] ${JSON.stringify(proposalB)}`);
  ctx.exit(0, 'branch B complete');
}
