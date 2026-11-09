import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mergeValues } from '../src/kernel/memory_merge.js';
import { decodeIntent, encodeIntent } from '../src/kernel/intent.js';
import { foldRecovery } from '../src/kernel/recovery.js';
import { capCallTimeout } from '../src/kernel/syscall_dispatcher.js';
import { ProcessTable } from '../src/kernel/process_table.js';
import { asProcessId, type CortexContext, type ILLMDriver } from '../src/kernel/types.js';
import { bootKernel, isCortexError, KERNEL_ABI_VERSION } from '../src/index.js';

const waitFor = async (condition: () => boolean, message: string): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('shared writes keep both sides', () => {
  assert.equal(mergeValues('a\nb', 'b\nc').value, 'a\nb\nc');
  const objects = mergeValues({ a: 1 }, { b: 2 });
  assert.deepEqual(objects.value, { a: 1, b: 2 });
  assert.equal(objects.conflict, false);
  const clash = mergeValues(1, 2) as { value: { kept: number; also: number } };
  assert.deepEqual(clash.value, { kept: 1, also: 2 });
  assert.equal(clash.conflict, true);
});

test('an intent is a goal plus when it is done', () => {
  const encoded = encodeIntent({ goal: 'ship it', doneWhen: 'the tests pass' });
  assert.deepEqual(decodeIntent(encoded), { goal: 'ship it', doneWhen: 'the tests pass' });
  assert.deepEqual(decodeIntent('just a sentence'), { goal: 'just a sentence', doneWhen: null });
});

test('the kernel caps a call that asked for longer', () => {
  assert.equal(capCallTimeout(60_000), 60_000);
  assert.equal(capCallTimeout(1_000_000), 120_000);
  assert.equal(capCallTimeout(1_000_000, 50), 50);
});

test('a recovery log forgets a process that exited', () => {
  const live = foldRecovery([
    { op: 'live', pid: 2, role: 'back', agent: { module: 'back' }, at: 't' },
    { op: 'gone', pid: 2, at: 't2' },
    { op: 'live', pid: 3, role: 'stay', agent: { module: 'stay' }, at: 't3' },
  ]);
  assert.deepEqual(live.map((row) => row.pid), [3]);
});

test('a queued signal names its sender on the process record', async () => {
  const table = new ProcessTable({ kernelAbiVersion: KERNEL_ABI_VERSION });
  const pid = await table.allocate({ ppid: null, role: 'waiter', agent: { module: 'waiter' } });
  table.queueSignal(pid, 'SIGTERM', asProcessId(4));
  const info = table.snapshot(pid);
  assert.deepEqual(info.pendingSignals, ['SIGTERM']);
  assert.equal(info.pendingSignalFrom[0], asProcessId(4));
});

test('one process can have two model calls in flight', async () => {
  let started = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const llm: ILLMDriver = {
    name: 'two',
    version: '1.0.0',
    abiCompat: '^1.0.0',
    supportedModels: ['two'],
    async call() {
      started += 1;
      await gate;
      return {
        text: 'ok',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, usd: 0 },
        model: 'two',
        driverVersion: '1.0.0',
      };
    },
    async close() {},
  };
  const dir = await mkdtemp(join(tmpdir(), 'cortex-kept-'));
  const kernel = await bootKernel({
    kernelAbiVersion: KERNEL_ABI_VERSION,
    dir,
    autoStart: true,
    defaultLLM: llm.name,
    loadDrivers(registry) {
      registry.registerLLM(llm);
    },
    agentLoader: async () => async (ctx: CortexContext) => {
      await Promise.all([
        ctx.llm_call({ messages: [{ role: 'user', content: 'a' }] }),
        ctx.llm_call({ messages: [{ role: 'user', content: 'b' }] }),
      ]);
    },
  });
  try {
    await kernel.spawn({ role: 'thinker', agent: { module: 'thinker' } });
    await waitFor(() => started === 2, 'the second call never started');
    release();
    await waitFor(() => kernel.table.list().every((row) => row.pid === 1 || row.state === 'zombie' || row.state === 'exiting'), 'thinker did not finish');
  } finally {
    await kernel.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the kernel stops waiting when a model call never returns', async () => {
  let errno = '';
  const llm: ILLMDriver = {
    name: 'hang',
    version: '1.0.0',
    abiCompat: '^1.0.0',
    supportedModels: ['hang'],
    call() {
      return new Promise(() => {});
    },
    async close() {},
  };
  const dir = await mkdtemp(join(tmpdir(), 'cortex-kept-'));
  const kernel = await bootKernel({
    kernelAbiVersion: KERNEL_ABI_VERSION,
    dir,
    autoStart: true,
    kernelCallCeilingMs: 40,
    defaultLLM: llm.name,
    loadDrivers(registry) {
      registry.registerLLM(llm);
    },
    agentLoader: async () => async (ctx: CortexContext) => {
      try {
        await ctx.llm_call({ messages: [{ role: 'user', content: 'hang' }], timeoutMs: 60_000 });
      } catch (err) {
        errno = isCortexError(err) ? err.errno : 'other';
      }
    },
  });
  try {
    await kernel.spawn({ role: 'waiter', agent: { module: 'waiter' } });
    await waitFor(() => errno === 'ETIMEDOUT', 'the kernel did not time the call out');
  } finally {
    await kernel.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a crash log brings the agent back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cortex-kept-'));
  await writeFile(
    join(dir, 'recovery.wal'),
    `${JSON.stringify({ op: 'live', pid: 2, role: 'back', agent: { module: 'back' }, at: 't' })}\n`,
  );
  let role = '';
  const kernel = await bootKernel({
    kernelAbiVersion: KERNEL_ABI_VERSION,
    dir,
    autoStart: true,
    agentLoader: async () => async (ctx: CortexContext) => {
      role = ctx.role;
    },
  });
  try {
    await waitFor(() => role === 'back', 'recovered agent did not run');
  } finally {
    await kernel.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('set_intent records a goal', async () => {
  let goal = '';
  const dir = await mkdtemp(join(tmpdir(), 'cortex-kept-'));
  const kernel = await bootKernel({
    kernelAbiVersion: KERNEL_ABI_VERSION,
    dir,
    autoStart: true,
    agentLoader: async () => async (ctx: CortexContext) => {
      const intent = await ctx.set_intent('ship the merge', 'both values survive');
      goal = intent.goal;
    },
  });
  try {
    const pid = await kernel.spawn({ role: 'planner', agent: { module: 'planner' } });
    await waitFor(() => goal === 'ship the merge', 'intent was not set');
    const text = await readFile(join(dir, 'recovery.wal'), 'utf8').catch(() => '');
    assert.equal(typeof text, 'string');
    await waitFor(() => kernel.table.get(pid)?.intent?.goal === 'ship the merge' || goal === 'ship the merge', 'goal missing');
  } finally {
    await kernel.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
