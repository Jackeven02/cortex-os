import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chooseCheckpointKeep } from '../src/cli/gc.js';
import { judgeForkClaim } from '../src/cli/doctor_view.js';
import { ProcessTable } from '../src/kernel/process_table.js';
import { asProcessId, type CortexContext } from '../src/kernel/types.js';
import { bootKernel, KERNEL_ABI_VERSION } from '../src/index.js';

test('a queued signal keeps the first sender', async () => {
  const table = new ProcessTable({ kernelAbiVersion: KERNEL_ABI_VERSION });
  const pid = await table.allocate({
    ppid: null,
    role: 'waiter',
    agent: { module: 'waiter' },
  });
  const first = asProcessId(4);
  const second = asProcessId(5);
  table.queueSignal(pid, 'SIGTERM', first);
  table.queueSignal(pid, 'SIGTERM', second);
  assert.equal(table.snapshot(pid).pendingSignals.length, 1);
  assert.equal(table.queuedFrom(pid, 'SIGTERM'), first);
  table.drainSignals(pid);
  assert.equal(table.queuedFrom(pid, 'SIGTERM'), first);
  table.forgetQueuedFrom(pid, 'SIGTERM');
  assert.equal(table.queuedFrom(pid, 'SIGTERM'), undefined);
});

test('gc keeps the newest checkpoint in a directory', () => {
  const choice = chooseCheckpointKeep([
    { path: 'a.csnap', mtimeMs: 10 },
    { path: 'b.csnap', mtimeMs: 30 },
    { path: 'c.csnap', mtimeMs: 20 },
  ]);
  assert.equal(choice.keep?.path, 'b.csnap');
  assert.deepEqual(choice.drop.map((file) => file.path), ['c.csnap', 'a.csnap']);
});

test('doctor names a fork claim that cannot be shown', () => {
  assert.equal(judgeForkClaim({
    name: 'fs',
    forkable: false,
    canSerialize: false,
    canRestore: false,
  }).verdict, 'closed-on-fork');
  assert.equal(judgeForkClaim({
    name: 'fs',
    forkable: true,
    canSerialize: true,
    canRestore: true,
  }).verdict, 'round-trip-declared');
  assert.equal(judgeForkClaim({
    name: 'fs',
    forkable: true,
    canSerialize: true,
    canRestore: false,
  }).verdict, 'unprovable');
});

const waitFor = async (condition: () => boolean, message: string): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('daemon shutdown writes a checkpoint of a living agent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cortex-products-'));
  const kernel = await bootKernel({
    kernelAbiVersion: KERNEL_ABI_VERSION,
    dir,
    autoStart: true,
    checkpointOnShutdown: true,
    agentLoader: async () => async (ctx: CortexContext) => {
      await ctx.recv();
    },
  });
  try {
    const pid = await kernel.spawn({ role: 'sleeper', agent: { module: 'sleeper' } });
    await waitFor(
      () => kernel.table.get(pid)?.state === 'blocked',
      'sleeper did not block',
    );
  } finally {
    await kernel.shutdown();
  }
  const processes = await readdir(join(dir, 'processes'));
  const snaps: string[] = [];
  for (const name of processes) {
    const dirName = join(dir, 'processes', name, 'checkpoints');
    let files: string[] = [];
    try {
      files = await readdir(dirName);
    } catch {
      continue;
    }
    snaps.push(...files.filter((file) => file.endsWith('.csnap')));
  }
  assert.ok(snaps.length >= 1, 'shutdown wrote no checkpoint');
  await rm(dir, { recursive: true, force: true });
});
