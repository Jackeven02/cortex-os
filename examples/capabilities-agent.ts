/**
 * Example: least privilege — run narrow, escalate only for the one call that
 * needs it (docs/ABI.md §4.9, COOKBOOK §10).
 *
 * The point of this example is that the SAME module behaves differently
 * depending on what you spawn it with. Run it three ways:
 *
 *   # 1. Default: holds everything, so spawn succeeds.
 *   cortex spawn --role demo --module ./examples/capabilities-agent.ts
 *   # -> held: spawn, kill, fork, tool:dangerous, ipc:any, admin
 *   # -> spawn: allowed
 *
 *   # 2. Narrowed: only tool:dangerous, so spawn traps EPERM — and the agent
 *   #    handles it instead of dying.
 *   cortex spawn --role demo --module ./examples/capabilities-agent.ts \
 *     --cap tool:dangerous
 *   # -> held: tool:dangerous
 *   # -> spawn: EPERM (caught)
 *
 *   # 3. Narrowed but grantable: it can raise `spawn` itself.
 *   cortex spawn --role demo --module ./examples/capabilities-agent.ts \
 *     --cap tool:dangerous --grantable spawn
 *   # -> held: tool:dangerous
 *   # -> spawn: EPERM (caught)
 *   # -> after acquire('spawn'): allowed
 *
 * Why the default is full privilege and not least privilege: every agent
 * written before 1.0 predates capabilities. Defaulting to empty would turn all
 * of them into EPERM traps the moment they upgraded. Narrowing is opt-in.
 */

import type { CortexContext } from '../src/index.js';

export default async function capabilitiesAgent(ctx: CortexContext): Promise<void> {
  console.log(`held: ${ctx.caps().join(', ') || '(none)'}`);

  // Killing your own descendants never needs `kill` — that is what keeps a
  // supervision tree expressible without handing the capability to everyone.
  // Reaching across the tree DOES need it.
  console.log(`can kill: ${ctx.caps().includes('kill')}`);

  try {
    await ctx.spawn({ role: 'child', agent: { system: 'You are a child.' } });
    console.log('spawn: allowed');
  } catch (err) {
    // A narrowed agent is expected to hit this — it is a condition to handle,
    // not a crash.
    const errno = (err as { errno?: string }).errno ?? 'unknown';
    console.log(`spawn: ${errno}`);

    if (errno === 'EPERM') {
      // Raise it, if the spawner made it grantable. This is recorded in the
      // .crec log, so "when did it escalate, and what did it do next" is
      // answerable afterward.
      try {
        await ctx.acquire('spawn');
        console.log("acquire('spawn'): granted");
        const { pid } = await ctx.spawn({
          role: 'child',
          agent: { system: 'You are a child.' },
        });
        console.log(`spawn after acquire: allowed (pid ${String(pid)})`);
        // Give it back — dropping a privilege you do not have is not an error,
        // so cleanup paths never need to track state.
        await ctx.release('spawn');
        console.log("release('spawn'): dropped");
      } catch (acquireErr) {
        const aErrno = (acquireErr as { errno?: string }).errno ?? 'unknown';
        console.log(`acquire('spawn'): ${aErrno} (not in the grantable pool)`);
      }
    }
  }

  ctx.exit(0, 'capabilities demo complete');
}
