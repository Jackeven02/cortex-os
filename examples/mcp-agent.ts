/**
 * Example: an agent driving a real MCP server (BACKLOG #025).
 *
 * Cortex's kernel has no idea what MCP is. This agent calls an MCP tool exactly
 * the way it calls a built-in filesystem tool — `ctx.tool_call(name, args)` —
 * because the MCP driver implements the same `IToolDriver` contract.
 *
 * The second half demonstrates the reversibility gate, which is the interesting
 * part: MCP has no reversibility field, so the driver defaults every untagged
 * tool to `irreversible`. That means an untagged MCP tool **refuses to run
 * inside a `forkable()` region** — safe by default, overridable by the operator.
 *
 * Try it:
 *
 *   export CORTEX_MCP_COMMAND=node
 *   export CORTEX_MCP_ARGS="./.demo/echo-server.js"
 *   cortex spawn --role demo --module ./examples/mcp-agent.ts
 *
 * @module examples/mcp-agent
 */

import type { CortexContext } from 'cortex-agent-os';

export default async function mcpAgent(ctx: CortexContext): Promise<void> {
  // 1. Call an MCP tool. From the agent's side this is indistinguishable from
  //    calling `fs_read`.
  const res = await ctx.tool_call('mcp/echo', { message: 'hello from cortex' });
  const output = res.output as { text: string | null };
  console.log(`[${ctx.role}] echo said: ${output.text}`);
  console.log(`[${ctx.role}] reversibility: ${res.reversibility}`);
  console.log(`[${ctx.role}] duration: ${res.durationMs}ms`);

  // 2. The same call inside a forkable region. It should be REFUSED: the tool
  //    carries no reversibility declaration, so the driver tagged it
  //    'irreversible' and the dispatcher traps with EREVERSIBLE.
  try {
    await ctx.forkable(async () => {
      await ctx.tool_call('mcp/echo', { message: 'inside a forkable region' });
    });
    console.log(`[${ctx.role}] forkable region allowed the call — the gate did not fire`);
  } catch (err) {
    console.log(
      `[${ctx.role}] forkable region refused it: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  ctx.exit(0, 'mcp demo complete');
}
