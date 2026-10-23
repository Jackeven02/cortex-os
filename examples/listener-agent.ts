/**
 * Example: a long-lived agent that waits for messages — the transport demo.
 *
 * The point of this example is the *pair* of commands around it. A running
 * agent is only reachable if something can reach it, and until the kernel had
 * a transport (docs/ARCHITECTURE.md §12.1) there was no such thing: every
 * `cortex` invocation booted its own kernel and exited. Now `cortex daemon
 * run` keeps a kernel alive, and other invocations can talk to it.
 *
 * Run it:
 *
 *   # 1. Start the supervisor. It boots a kernel, registers the daemon, and
 *   #    publishes its endpoint in <CORTEX_HOME>/kernel.json.
 *   cortex daemon install listener --role listener --module ./examples/listener-agent.ts
 *   cortex daemon run listener
 *
 *   # 2. From another terminal, talk to it.
 *   cortex send 2 "what is the weather?"
 *   cortex attach 2 --interactive        # type lines; each one is delivered
 *
 * The agent below parks on `ctx.recv()` — which is a *blocking* syscall, so
 * the process honestly reports itself as BLOCKED rather than pretending to be
 * runnable — and prints whatever arrives.
 *
 * The timeout is what keeps the loop honest: a `recv` that times out raises
 * `ETIMEDOUT`, which is caught and turned into an idle tick. Without it the
 * agent would sit inside one syscall forever and the supervisor would have
 * no way to notice it was still alive.
 *
 * @module examples/listener-agent
 */

import type { CortexContext } from 'cortex-agent-os';

export default async function listenerAgent(
  ctx: CortexContext,
  args: Record<string, unknown> = {},
): Promise<void> {
  const max = typeof args['max'] === 'number' ? args['max'] : 0;
  const timeoutMs = typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : 1000;

  console.log(`[${ctx.role}] listening (max=${max || '∞'}, tick=${timeoutMs}ms)`);

  let received = 0;
  for (;;) {
    try {
      const msg = await ctx.recv(undefined, { timeoutMs });
      received += 1;
      console.log(`[${ctx.role}] message ${received} from ${String(msg.from)}: ${String(msg.body)}`);
      if (max > 0 && received >= max) break;
    } catch (err) {
      const errno = (err as { errno?: string }).errno ?? 'unknown';
      // A timeout is the idle case, not a failure.
      if (errno === 'ETIMEDOUT') continue;
      throw err;
    }
  }

  ctx.exit(0, `received ${received} message(s)`);
}
