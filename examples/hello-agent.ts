/**
 * Example: a minimal cortex agent.
 *
 * This agent calls the LLM once, stores the result in memory, then exits.
 * Run it with:
 *
 *   cortex spawn --role coder --task "say hello"
 *
 * Or programmatically:
 *
 *   import { bootKernel, KERNEL_ABI_VERSION } from 'cortex-os';
 *   import { mockLLM } from 'cortex-os/drivers';
 *
 *   const kernel = await bootKernel({
 *     kernelAbiVersion: KERNEL_ABI_VERSION,
 *     dir: '.cortex',
 *     loadDrivers: (registry) => { registry.registerLLM(mockLLM()); },
 *     autoStart: true,
 *   });
 *   const pid = await kernel.spawn({
 *     role: 'hello',
 *     agent: { module: import.meta.resolve('./hello-agent.ts') },
 *   });
 *
 * The agent receives a `CortexContext` (the `ctx` object) which is the entire
 * kernel surface. There is no other API.
 */

import type { CortexContext } from '../src/index.js';

export default async function helloAgent(ctx: CortexContext): Promise<void> {
  // Call the LLM with a simple prompt.
  const response = await ctx.llm_call({
    messages: [
      { role: 'system', content: 'You are a friendly assistant. Keep responses to one sentence.' },
      { role: 'user', content: 'Say hello and tell me what you can do.' },
    ],
  });

  // Store the response in the agent's private memory.
  await ctx.memory_write('episodic', 'last_response', {
    text: response.text,
    model: response.model,
    tokens: response.usage.inputTokens + response.usage.outputTokens,
  });

  // Log to the console (this is a side effect — visible but not recorded).
  console.log(`[${ctx.role}] LLM said: ${response.text}`);
  console.log(`[${ctx.role}] tokens: ${response.usage.inputTokens} in, ${response.usage.outputTokens} out`);

  // Exit cleanly with code 0.
  ctx.exit(0, 'done');
}
