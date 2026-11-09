import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bootKernel, KERNEL_ABI_VERSION, isCortexError, type ILLMDriver } from '../src/index.js';
import { asProcessId, type CortexContext } from '../src/kernel/types.js';

const waitFor = async (condition: () => boolean, message: string): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const boot = async (agent: (ctx: CortexContext) => Promise<void>, llm?: ILLMDriver) => {
  const dir = await mkdtemp(join(tmpdir(), 'cortex-decisions-'));
  const kernel = await bootKernel({
    kernelAbiVersion: KERNEL_ABI_VERSION,
    dir,
    autoStart: true,
    ...(llm !== undefined
      ? { defaultLLM: llm.name, loadDrivers(registry) { registry.registerLLM(llm); } }
      : {}),
    agentLoader: async () => agent,
  });
  return {
    kernel,
    async close() {
      await kernel.shutdown();
      await rm(dir, { recursive: true, force: true });
    },
  };
};

test('a narrowed parent cannot mint a more privileged child', async () => {
  let errno = '';
  const session = await boot(async (ctx) => {
    try {
      await ctx.spawn({
        role: 'child',
        agent: { module: 'child' },
        capabilities: ['admin'],
      });
    } catch (err) {
      errno = isCortexError(err) ? err.errno : 'other';
    }
  });
  try {
    await session.kernel.spawn({
      role: 'parent',
      agent: { module: 'parent' },
      capabilities: ['spawn'],
    });
    await waitFor(() => errno !== '', 'parent did not try to spawn');
    assert.equal(errno, 'EPERM');
  } finally {
    await session.close();
  }
});

test('omitting capabilities inherits the parent, and fork copies them', async () => {
  const reported: string[][] = [];
  let step = 0;
  const session = await boot(async (ctx) => {
    const mine = step++;
    const held = [...(await ctx.caps())].sort();
    reported.push(held);
    if (mine !== 0) return;
    await ctx.spawn({ role: 'child', agent: { module: 'child' } });
    await ctx.fork();
  });
  try {
    await session.kernel.spawn({
      role: 'parent',
      agent: { module: 'parent' },
      capabilities: ['spawn', 'fork'],
    });
    await waitFor(() => reported.length >= 3, 'the parent, its child and the fork did not all report');
    for (const held of reported) {
      assert.deepEqual(held, ['fork', 'spawn']);
    }
  } finally {
    await session.close();
  }
});

test('SIGTERM stops a process blocked on recv', async () => {
  let errno = '';
  const session = await boot(async (ctx) => {
    try {
      await ctx.recv();
    } catch (err) {
      errno = isCortexError(err) ? err.errno : 'other';
    }
  });
  try {
    const pid = await session.kernel.spawn({ role: 'listener', agent: { module: 'listener' } });
    await waitFor(() => session.kernel.table.get(pid)?.state === 'blocked', 'listener did not block');
    assert.equal(session.kernel.table.get(pid)?.blockedOn?.kind, 'recv');
    const outcome = await session.kernel.signals.send(pid, 'SIGTERM');
    assert.equal(outcome, 'delivered');
    await waitFor(() => errno === 'EINTR', 'recv did not surface EINTR');
  } finally {
    await session.close();
  }
});

test('a model call is blocked, and SIGTERM waits until it returns', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let seen: string | undefined;
  const llm: ILLMDriver = {
    name: 'hold',
    version: '1.0.0',
    abiCompat: '^1.0.0',
    supportedModels: ['hold'],
    async call() {
      await gate;
      return {
        text: 'ok',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, usd: 0 },
        model: 'hold',
        driverVersion: '1.0.0',
      };
    },
    async close() {},
  };
  const session = await boot(async (ctx) => {
    try {
      await ctx.llm_call({ messages: [{ role: 'user', content: 'hold' }] });
    } catch {
      seen = 'interrupted';
    }
  }, llm);
  try {
    const pid = await session.kernel.spawn({ role: 'model', agent: { module: 'model' } });
    await waitFor(() => session.kernel.table.get(pid)?.blockedOn?.kind === 'llm', 'model call did not park');
    await session.kernel.signals.send(pid, 'SIGTERM');
    assert.equal(session.kernel.table.get(pid)?.state, 'blocked');
    assert.ok(session.kernel.table.get(pid)?.pendingSignals.includes('SIGTERM'));
    release();
    await waitFor(() => seen === 'interrupted', 'the call was not interrupted when it returned');
  } finally {
    await session.close();
  }
});

test('cached tokens count in full against the token ceiling', async () => {
  const session = await boot(async () => {});
  try {
    const pid = await session.kernel.spawn({
      role: 'spender',
      agent: { module: 'spender' },
      budgets: { tokens: 100 },
    });
    session.kernel.table.spend(pid, { tokensIn: 10, tokensOut: 2, tokensCached: 8, usdSpent: 1 });
    const entry = session.kernel.table.get(pid);
    assert.equal(entry?.budgetsRemaining.tokens, 88);
    assert.equal(entry?.budgetsSpent.tokensCached, 8);
  } finally {
    await session.close();
  }
});

test('acknowledging a daemon records who noticed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cortex-ack-'));
  const kernel = await bootKernel({
    kernelAbiVersion: KERNEL_ABI_VERSION,
    dir,
    autoStart: false,
    agentLoader: async () => async () => {},
  });
  try {
    await kernel.registerDaemon({
      name: 'inbox',
      role: 'inbox',
      agent: { module: 'inbox' },
      restart: { kind: 'never' },
      capabilities: ['spawn'],
    });
    const before = kernel.daemons().find((daemon) => daemon.name === 'inbox');
    assert.equal(before?.noticed, false);
    assert.equal(kernel.dispatcher.hasCapability(asProcessId(before?.currentPid ?? 0), 'kill'), false);
    const after = await kernel.acknowledgeDaemon('inbox');
    assert.equal(after.noticed, true);
    assert.equal(after.noticedBy, 'operator');
  } finally {
    await kernel.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
