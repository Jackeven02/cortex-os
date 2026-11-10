import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { rankMemory } from '../src/kernel/memory_search.js';
import type { CortexContext, ILLMDriver, MemoryEntry } from '../src/kernel/types.js';
import { bootKernel, KERNEL_ABI_VERSION } from '../src/index.js';

const waitFor = async (condition: () => boolean, message: string): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('a memory scan ranks words and vectors', () => {
  const entries: MemoryEntry[] = [
    { region: 'semantic', key: 'a', value: 'billing invoice', at: 't' },
    { region: 'semantic', key: 'b', value: 'weather report', at: 't' },
    { region: 'semantic', key: 'c', value: { vector: [1, 0], text: 'unused' }, at: 't' },
    { region: 'semantic', key: 'd', value: { vector: [0, 1], text: 'unused' }, at: 't' },
  ];
  const byWord = rankMemory(entries, { extra: { text: 'invoice' }, limit: 1 });
  assert.deepEqual(byWord.map((entry) => entry.key), ['a']);
  const byVector = rankMemory(entries, { extra: { vector: [0, 1] }, limit: 1 });
  assert.deepEqual(byVector.map((entry) => entry.key), ['d']);
});

test('a shadow fork calls the other model', async () => {
  let parentPid = 0;
  let seen: { model?: string; system?: string } | undefined;
  const llm: ILLMDriver = {
    name: 'two',
    version: '1.0.0',
    abiCompat: '^1.0.0',
    supportedModels: ['two', 'other'],
    async call(req) {
      seen = {
        ...(req.model !== undefined ? { model: req.model } : {}),
        system: req.messages.find((message) => message.role === 'system')?.content,
      };
      return {
        text: 'ok',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, usd: 0 },
        model: req.model ?? 'two',
        driverVersion: '1.0.0',
      };
    },
    async close() {},
  };
  const dir = await mkdtemp(join(tmpdir(), 'cortex-shadow-'));
  const kernel = await bootKernel({
    kernelAbiVersion: KERNEL_ABI_VERSION,
    dir,
    autoStart: true,
    defaultLLM: llm.name,
    loadDrivers(registry) {
      registry.registerLLM(llm);
    },
    agentLoader: async () => async (ctx: CortexContext) => {
      if (parentPid === 0) {
        parentPid = Number(ctx.pid);
        await ctx.fork({
          kind: 'shadow',
          shadow: { model: 'other', system: 'be brief' },
        });
        return;
      }
      await ctx.llm_call({ messages: [{ role: 'user', content: 'hi' }] });
    },
  });
  try {
    await kernel.spawn({ role: 'origin', agent: { module: 'origin' } });
    await waitFor(() => seen?.model === 'other' && seen.system === 'be brief', 'shadow did not call');
  } finally {
    await kernel.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
