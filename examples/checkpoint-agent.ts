/**
 * Example: a long-running inbox-watcher that survives a reboot (Demo B — pause
 * across reboots). This is the lead demo: it is the one no existing agent tool
 * does, because "pause exactly where I was and come back after the machine
 * restarted" is a *process* primitive, not a prompt-engineering trick.
 *
 * The watcher processes a fixed inbox of support tickets: it classifies each,
 * drafts a reply, and records the processed id in the `episodic` region. After
 * the third ticket it checkpoints and detaches — the "laptop is about to
 * reboot". A separate `cortex restore` invocation re-materialises the process
 * as a NEW pid, re-hydrates memory, and the agent continues from where it left
 * off, skipping the tickets it already handled.
 *
 *   Run 1 (the laptop is up):
 *     cortex spawn --role inbox-watcher --module ./examples/checkpoint-agent.ts
 *     # -> processes T-1180..T-1182, then "checkpointing ... suspended"
 *
 *   ... the laptop reboots; the kernel is torn down, the .csnap is on disk ...
 *
 *   Run 2 (after reboot):
 *     cortex restore --tag inbox-watcher
 *     # -> "recovered 3 processed ticket(s) from memory", skips T-1180..T-1182,
 *     #    processes T-1183..T-1185, exits 0 "inbox cleared"
 *
 * KEY CONTRACT (and an honest v0 limitation): a checkpoint captures the process
 * image — state, memory regions, budgets, lineage — NOT the live JS call stack.
 * On restore the agent function restarts from the top. Making progress
 * idempotent across that restart is the *agent's* job, which is why this example
 * gates the checkpoint and the skip logic on memory markers (`done`, `paused`)
 * rather than on local variables. That is exactly how a real long-running agent
 * should be written: memory is the only thing that survives the reboot, so it
 * is the source of truth for "what have I already done".
 *
 * The ticket-handling is deterministic and offline (no LLM call) so the demo
 * reproduces identically in CI and in the README replay. Swap `processTicket`
 * for a real `ctx.llm_call` and the pause/resume behaviour is unchanged.
 *
 * @module examples/checkpoint-agent
 */

import type { CortexContext } from 'cortex-agent-os';

const TAG = 'inbox-watcher';
const PROGRESS = 'episodic'; // survives the checkpoint
const RESULTS = 'semantic'; // where the drafted replies live
const PAUSE_AFTER = 3; // "shut down" once three tickets are handled

interface Ticket {
  readonly id: string;
  readonly subject: string;
}

const TICKETS: readonly Ticket[] = [
  { id: 'T-1180', subject: 'App crashes on launch after the 2.3 update' },
  { id: 'T-1181', subject: 'Can I export my data to CSV?' },
  { id: 'T-1182', subject: 'How do I reset my password?' },
  { id: 'T-1183', subject: 'Dark mode flickers on Windows 11' },
  { id: 'T-1184', subject: 'Please add keyboard shortcuts for navigation' },
  { id: 'T-1185', subject: 'I was charged twice this month' },
];

type Category = 'bug' | 'feature' | 'question';

function classify(subject: string): Category {
  const s = subject.toLowerCase();
  if (/(crash|bug|error|flicker|charg|broken|fail|freez)/.test(s)) return 'bug';
  if (/(export|add|keyboard|shortcut|csv|feature|allow|enable)/.test(s)) return 'feature';
  return 'question';
}

function draftReply(t: Ticket, category: Category): string {
  switch (category) {
    case 'bug':
      return `Thanks for the report — we've filed this and a fix is in review. Tracking as ${t.id}.`;
    case 'feature':
      return `Good suggestion; I've added ${t.id} to the roadmap with your note attached.`;
    case 'question':
      return `You can do that from Settings → Account → Security (see ${t.id}).`;
  }
}

export default async function checkpointAgent(ctx: CortexContext): Promise<void> {
  // Memory is the only state that survives a restore, so it — not a local
  // variable — is the source of truth for "what have I already done".
  const doneRaw = await ctx.memory_read(PROGRESS, { key: 'done' });
  const done: string[] = doneRaw.length > 0 ? (doneRaw[0]!.value as string[]) : [];
  const doneSet = new Set(done);

  const pausedRaw = await ctx.memory_read(PROGRESS, { key: 'paused' });
  const alreadyPaused = pausedRaw.length > 0 && Boolean(pausedRaw[0]!.value);

  console.log(`[${ctx.role} pid ${ctx.pid}] inbox-watcher up — ${TICKETS.length} tickets in queue`);
  if (doneSet.size > 0) {
    console.log(`[${ctx.role} pid ${ctx.pid}] recovered ${doneSet.size} processed ticket(s) from memory`);
  }

  for (const t of TICKETS) {
    if (doneSet.has(t.id)) {
      console.log(`[${ctx.role} pid ${ctx.pid}] skip ${t.id} (already handled)`);
      continue;
    }

    const category = classify(t.subject);
    const reply = draftReply(t, category);
    await ctx.memory_write(RESULTS, `ticket:${t.id}`, { id: t.id, category, reply });
    done.push(t.id);
    await ctx.memory_write(PROGRESS, 'done', done);
    console.log(`[${ctx.role} pid ${ctx.pid}] #${t.id} ${t.subject} -> ${category}; reply drafted`);

    // Stand in for real per-ticket work (a model call, a tool, ...).
    await ctx.sleep(300);

    // The laptop is about to reboot: snapshot and suspend. We only do this
    // once — `alreadyPaused` is itself a memory marker that survives the reboot.
    if (!alreadyPaused && done.length >= PAUSE_AFTER) {
      await ctx.memory_write(PROGRESS, 'paused', true);
      console.log(
        `[${ctx.role} pid ${ctx.pid}] ${done.length}/${TICKETS.length} handled — checkpointing (tag '${TAG}') before shutdown`,
      );
      const { chainId } = await ctx.checkpoint({ tag: TAG, detach: true });
      console.log(
        `[${ctx.role} pid ${ctx.pid}] suspended at ${chainId} — resume after reboot: cortex restore --tag ${TAG}`,
      );
      return;
    }
  }

  console.log(`[${ctx.role} pid ${ctx.pid}] inbox cleared (${done.length}/${TICKETS.length})`);
  ctx.exit(0, 'inbox cleared');
}
