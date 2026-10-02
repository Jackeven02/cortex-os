import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bootKernel, KERNEL_ABI_VERSION, isProcessExitSignal, type ILLMDriver } from '../src/index.js';
import { PID_KERNEL } from '../src/kernel/process_table.js';

const waitFor = async (condition: () => boolean, message: string): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('agent continuation waits for dispatch after a token budget stop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cortex-budget-resume-'));
  let continued = false;
  const llm: ILLMDriver = {
    name: 'budget-test',
    version: '1.0.0',
    abiCompat: '^1.0.0',
    supportedModels: ['test-model'],
    async call() {
      return {
        text: 'done',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 2, outputTokens: 1, cachedTokens: 0, usd: 0 },
        model: 'test-model',
        driverVersion: '1.0.0',
      };
    },
    async close() {},
  };
  const kernel = await bootKernel({
    kernelAbiVersion: KERNEL_ABI_VERSION,
    dir,
    defaultLLM: 'budget-test',
    autoStart: false,
    loadDrivers(registry) { registry.registerLLM(llm); },
    agentLoader: async () => async (ctx) => {
      await ctx.llm_call({ messages: [{ role: 'user', content: 'test' }] });
      continued = true;
    },
  });
  try {
    const pid = await kernel.spawn({ role: 'budget-test', agent: { module: 'in-memory' }, budgets: { tokens: 1 } });
    kernel.start();
    await waitFor(() => kernel.table.get(pid)?.state === 'stopped', 'process did not stop at its token budget');
    assert.equal(continued, false, 'agent continued while stopped');

    kernel.table.setBudgets(pid, { remaining: { tokens: 100 } });
    await kernel.signals.send(pid, 'SIGCONT', PID_KERNEL);
    await waitFor(() => continued, 'agent did not continue after SIGCONT dispatch');
  } finally {
    await kernel.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('killing the process from the budget hook terminates the continuation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cortex-budget-kill-'));
  let caught: unknown;
  let continued = false;
  const llm: ILLMDriver = {
    name: 'budget-test',
    version: '1.0.0',
    abiCompat: '^1.0.0',
    supportedModels: ['test-model'],
    async call() {
      return {
        text: 'done',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 2, outputTokens: 1, cachedTokens: 0, usd: 0 },
        model: 'test-model',
        driverVersion: '1.0.0',
      };
    },
    async close() {},
  };
  const kernel = await bootKernel({
    kernelAbiVersion: KERNEL_ABI_VERSION,
    dir,
    defaultLLM: 'budget-test',
    autoStart: false,
    loadDrivers(registry) { registry.registerLLM(llm); },
    // A hostile-but-legal hook: kill the overspending process mid-flight.
    // The dispatcher must re-read the table after the hook and surface a
    // clean exit sentinel — never an ESRCH trap from a stale entry.
    async onBudgetExhausted(pid) {
      await kernel.signals.send(pid, 'SIGKILL', PID_KERNEL).catch(() => undefined);
    },
    agentLoader: async () => async (ctx) => {
      try {
        await ctx.llm_call({ messages: [{ role: 'user', content: 'test' }] });
        continued = true;
      } catch (err) {
        caught = err;
        throw err;
      }
    },
  });
  try {
    const pid = await kernel.spawn({ role: 'budget-test', agent: { module: 'in-memory' }, budgets: { tokens: 1 } });
    kernel.start();
    await waitFor(() => caught !== undefined, 'continuation was not terminated');
    assert.equal(continued, false, 'agent continued after being killed mid-syscall');
    assert.ok(isProcessExitSignal(caught), `expected ProcessExitSignal, got ${String(caught)}`);
    assert.equal(caught.exitCode, 152, `budget termination exit code, got ${String(caught.exitCode)}`);
  } finally {
    await kernel.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
