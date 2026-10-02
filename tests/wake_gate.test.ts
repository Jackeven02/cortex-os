import assert from 'node:assert/strict';
import test from 'node:test';
import { WakeGate } from '../src/kernel/wake_gate.js';
import { asProcessId } from '../src/kernel/types.js';

test('wake gate resumes a continuation only on release', async () => {
  const gate = new WakeGate();
  const pid = asProcessId(42);
  const resumed = gate.waitForDispatch(pid);

  assert.equal(gate.isPending(pid), true);
  assert.equal(gate.release(pid), 1);
  assert.equal(await resumed, true);
  assert.equal(gate.isPending(pid), false);
});

test('wake gate cancels a parked continuation on clear', async () => {
  const gate = new WakeGate();
  const pid = asProcessId(42);
  const resumed = gate.waitForDispatch(pid);

  gate.clear(pid);
  assert.equal(await resumed, false);
  assert.equal(gate.isPending(pid), false);
});
