/**
 * Phase 1 smoke check — types.ts + errors.ts + recorder.ts + process_table.ts
 * + signals.ts runtime sanity.
 *
 * Not a real test (no test framework yet, that lands with #012+). This is
 * a "does the module load and do the runtime bits behave" check, run via
 * `npm run smoke`. Once Phase 1 has a test runner, this gets absorbed into
 * tests/ and deleted.
 */

import {
  CortexError,
  isCortexError,
  trap,
  wrapDriverError,
  assertState,
  ErrnoCode,
  ErrnoFromCode,
  ErrnoMessage,
  asProcessId,
  asChainId,
  asChannelId,
  asSyscallOffset,
  unbrand,
  KERNEL_ABI_VERSION,
  VERSION,
  CODENAME,
  Recorder,
  readRecords,
  effectiveEof,
  crecPath,
  CREC_MAGIC,
  CREC_MAX_FRAME_SIZE,
  type SyscallRecord,
  ProcessTable,
  nullRecorderFactory,
  isLegalTransition,
  legalSuccessors,
  PROCESS_STATES,
  PID_KERNEL,
  PID_INIT,
  PID_FIRST_USER,
  type ProcessState,
  type Signal,
  SignalManager,
  SIGNAL_NUMBERS,
  ALL_SIGNALS,
  UNCATCHABLE_SIGNALS,
  DEFAULT_ACTIONS,
  exitCodeForSignal,
  isImmediateSignal,
  signalFromNumber,
  type DeliveryOutcome,
} from '../src/index.js';

let passed = 0;
let failed = 0;

function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${label}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${label}`);
    console.error(`       ${(err as Error).message}`);
    failed++;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

console.log(`cortex v${VERSION} (${CODENAME}) — ABI ${KERNEL_ABI_VERSION}`);
console.log('smoke check: types + errors\n');

check('errno table has 15 entries', () => {
  const n = Object.keys(ErrnoCode).length;
  assert(n === 15, `expected 15 errnos, got ${n}`);
});

check('errno reverse lookup round-trips', () => {
  for (const [name, code] of Object.entries(ErrnoCode)) {
    assert(ErrnoFromCode[code] === name, `reverse lookup failed for ${name}`);
  }
});

check('every errno has a default message', () => {
  for (const name of Object.keys(ErrnoCode) as (keyof typeof ErrnoCode)[]) {
    assert(typeof ErrnoMessage[name] === 'string', `missing message for ${name}`);
    assert(ErrnoMessage[name].length > 0, `empty message for ${name}`);
  }
});

check('CortexError extends Error', () => {
  const err = new CortexError('EINVAL', 'spawn');
  assert(err instanceof Error, 'not instanceof Error');
  assert(err instanceof CortexError, 'not instanceof CortexError');
  assert(err.name === 'CortexError', `wrong name: ${err.name}`);
});

check('CortexError carries errno + code + syscall', () => {
  const err = new CortexError('EBUDGET', 'llm_call', {
    message: 'token budget exhausted',
    details: { kind: 'tokens', spent: 100000, limit: 100000 },
  });
  assert(err.errno === 'EBUDGET', `wrong errno: ${err.errno}`);
  assert(err.errnoCode === ErrnoCode.EBUDGET, 'errnoCode mismatch');
  assert(err.syscall === 'llm_call', `wrong syscall: ${err.syscall}`);
  assert(err.message === 'token budget exhausted', `wrong message: ${err.message}`);
  assert(err.details?.['kind'] === 'tokens', 'details lost');
});

check('CortexError falls back to default message', () => {
  const err = new CortexError('ESRCH', 'kill');
  assert(err.message === ErrnoMessage.ESRCH, `expected default, got: ${err.message}`);
});

check('CortexError preserves cause', () => {
  const original = new Error('driver exploded');
  const err = new CortexError('EDRIVER', 'tool_call', { cause: original });
  assert(err.cause === original, 'cause not preserved');
});

check('toJSON produces recordable shape', () => {
  const err = new CortexError('EREVERSIBLE', 'tool_call', {
    details: { tool: 'send_email' },
  });
  const json = err.toJSON();
  assert(json.errno === 'EREVERSIBLE', 'json.errno wrong');
  assert(json.errnoCode === ErrnoCode.EREVERSIBLE, 'json.errnoCode wrong');
  assert(json.syscall === 'tool_call', 'json.syscall wrong');
  assert(json.details?.['tool'] === 'send_email', 'json.details wrong');
  assert(JSON.stringify(json).length > 0, 'json not serializable');
});

check('isCortexError discriminates correctly', () => {
  assert(isCortexError(new CortexError('EINVAL', 'x')), 'should detect CortexError');
  assert(!isCortexError(new Error('plain')), 'should reject plain Error');
  assert(!isCortexError(null), 'should reject null');
  assert(!isCortexError(undefined), 'should reject undefined');
  assert(!isCortexError('string'), 'should reject string');
  assert(!isCortexError({ errno: 'EINVAL' }), 'should reject duck-typed missing name');
  assert(
    isCortexError({ name: 'CortexError', errno: 'EINVAL' }),
    'should accept duck-typed (cross-module copy)',
  );
});

check('trap() throws CortexError with details', () => {
  let caught: unknown;
  try {
    trap('ESRCH', 'kill', { pid: 999999 });
  } catch (err) {
    caught = err;
  }
  assert(isCortexError(caught), 'trap did not throw CortexError');
  assert(caught.errno === 'ESRCH', `wrong errno: ${caught.errno}`);
  assert(caught.details?.['pid'] === 999999, 'details lost in trap');
});

check('trap() omits undefined details/message (exactOptionalPropertyTypes)', () => {
  let caught: unknown;
  try {
    trap('EINVAL', 'spawn');
  } catch (err) {
    caught = err;
  }
  assert(isCortexError(caught), 'trap did not throw');
  assert(caught.details === undefined, 'details should be undefined');
  assert(caught.message === ErrnoMessage.EINVAL, 'message should be default');
});

check('wrapDriverError preserves original as cause', () => {
  const original = new TypeError('bad response shape');
  const wrapped = wrapDriverError('llm_call', 'deepseek', original);
  assert(wrapped.errno === 'EDRIVER', `wrong errno: ${wrapped.errno}`);
  assert(wrapped.cause === original, 'cause not preserved');
  assert(wrapped.details?.['driver'] === 'deepseek', 'driver name lost');
});

check('wrapDriverError passes through CortexError unchanged', () => {
  const original = new CortexError('ETIMEDOUT', 'llm_call');
  const wrapped = wrapDriverError('llm_call', 'deepseek', original);
  assert(wrapped === original, 'should pass through, not re-wrap');
});

check('assertState passes for allowed states', () => {
  assertState('running', ['running', 'blocked'], 'kill');
  assertState('blocked', ['running', 'blocked'], 'kill');
});

check('assertState traps with ESTATE for disallowed states', () => {
  let caught: unknown;
  try {
    assertState('zombie', ['running', 'blocked'], 'kill');
  } catch (err) {
    caught = err;
  }
  assert(isCortexError(caught), 'assertState did not throw CortexError');
  assert(caught.errno === 'ESTATE', `wrong errno: ${caught.errno}`);
  assert(caught.details?.['currentState'] === 'zombie', 'currentState lost');
});

check('brand constructors produce values that round-trip', () => {
  const pid = asProcessId(1234);
  const cid = asChainId('550e8400-e29b-41d4-a716-446655440000');
  const chid = asChannelId('cortex/init');
  const off = asSyscallOffset(4096);
  assert(unbrand(pid) === 1234, 'pid brand round-trip failed');
  assert(unbrand(cid) === '550e8400-e29b-41d4-a716-446655440000', 'chainId round-trip failed');
  assert(unbrand(chid) === 'cortex/init', 'channelId round-trip failed');
  assert(unbrand(off) === 4096, 'syscallOffset round-trip failed');
});

check('version constants are frozen string literals', () => {
  assert(typeof VERSION === 'string' && VERSION.length > 0, 'VERSION bad');
  assert(typeof CODENAME === 'string' && CODENAME.length > 0, 'CODENAME bad');
  assert(
    typeof KERNEL_ABI_VERSION === 'string' && /^\d+\.\d+\.\d+$/.test(KERNEL_ABI_VERSION),
    `KERNEL_ABI_VERSION not semver: ${KERNEL_ABI_VERSION}`,
  );
});

// =============================================================================
// Async checks (recorder)
// =============================================================================

async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${label}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${label}`);
    console.error(`       ${(err as Error).message}`);
    failed++;
  }
}

async function runRecorderChecks(): Promise<void> {
  const { mkdtemp, rm, writeFile, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const tmp = await mkdtemp(join(tmpdir(), 'cortex-smoke-'));

  try {
    await checkAsync('crecPath produces conventional layout', async () => {
      const p = crecPath('/var/lib/cortex', asProcessId(42));
      assert(
        p === join('/var/lib/cortex', 'proc', '42.crec'),
        `unexpected path: ${p}`,
      );
    });

    await checkAsync('Recorder.open creates file with magic', async () => {
      const rec = await Recorder.open({ pid: asProcessId(100), dir: tmp });
      assert(rec.currentOffset === asSyscallOffset(8), `expected offset 8, got ${rec.currentOffset}`);
      const buf = await readFile(rec.path);
      assert(buf.byteLength === 8, `expected 8-byte file, got ${buf.byteLength}`);
      assert(buf.equals(Buffer.from(CREC_MAGIC)), 'magic mismatch');
      await rec.close();
    });

    await checkAsync('append + readRecords round-trips a record', async () => {
      const rec = await Recorder.open({ pid: asProcessId(101), dir: tmp });
      const offset = await rec.append({
        timestamp: '2026-01-01T00:00:00.000Z',
        pid: asProcessId(101),
        syscall: 'llm_call',
        callId: 'call-1',
        phase: 'enter',
        args: { messages: [{ role: 'user', content: 'hi' }] },
        stateBefore: 'running',
        stateAfter: 'blocked',
        reversibility: 'reversible',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      assert(offset === asSyscallOffset(8), `first record should be at offset 8, got ${offset}`);
      await rec.flush();
      await rec.close();

      const records: SyscallRecord[] = [];
      for await (const r of readRecords(rec.path)) records.push(r);
      assert(records.length === 1, `expected 1 record, got ${records.length}`);
      const r0 = records[0]!;
      assert(r0.syscall === 'llm_call', `wrong syscall: ${r0.syscall}`);
      assert(r0.phase === 'enter', `wrong phase: ${r0.phase}`);
      assert(r0.callId === 'call-1', `wrong callId: ${r0.callId}`);
      assert(r0.byteOffset === 8, `wrong byteOffset: ${r0.byteOffset}`);
      assert(
        (r0.args as { messages: { content: string }[] }).messages[0]!.content === 'hi',
        'args lost in round-trip',
      );
    });

    await checkAsync('append serializes concurrent writes (no interleaving)', async () => {
      const rec = await Recorder.open({ pid: asProcessId(102), dir: tmp });
      // Fire 50 appends concurrently. If serialization is broken, frames
      // will interleave and readRecords will fail or produce garbage.
      const promises = Array.from({ length: 50 }, (_, i) =>
        rec.append({
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
          pid: asProcessId(102),
          syscall: 'now',
          callId: `call-${i}`,
          phase: 'exit',
          result: i,
          stateBefore: 'running',
          stateAfter: 'running',
          reversibility: 'idempotent',
          kernelAbiVersion: KERNEL_ABI_VERSION,
        }),
      );
      const offsets = await Promise.all(promises);
      // Offsets must be strictly increasing (each frame lands after the previous).
      for (let i = 1; i < offsets.length; i++) {
        assert(offsets[i]! > offsets[i - 1]!, `offsets not monotonic at ${i}`);
      }
      await rec.flush();
      await rec.close();

      let count = 0;
      for await (const r of readRecords(rec.path)) {
        assert(r.syscall === 'now', `unexpected syscall: ${r.syscall}`);
        count++;
      }
      assert(count === 50, `expected 50 records, got ${count}`);
    });

    await checkAsync('reopen appends to existing log (kernel restart)', async () => {
      const pid = asProcessId(103);
      const rec1 = await Recorder.open({ pid, dir: tmp });
      await rec1.append({
        timestamp: '2026-01-01T00:00:00.000Z',
        pid,
        syscall: 'spawn',
        callId: 'c1',
        phase: 'enter',
        stateBefore: 'new',
        stateAfter: 'ready',
        reversibility: 'reversible',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      const offsetAfterFirst = rec1.currentOffset;
      await rec1.close();

      // Simulate kernel restart: reopen the same file.
      const rec2 = await Recorder.open({ pid, dir: tmp });
      assert(
        rec2.currentOffset === offsetAfterFirst,
        `reopen should resume at ${offsetAfterFirst}, got ${rec2.currentOffset}`,
      );
      await rec2.append({
        timestamp: '2026-01-01T00:01:00.000Z',
        pid,
        syscall: 'exit',
        callId: 'c2',
        phase: 'enter',
        stateBefore: 'running',
        stateAfter: 'exiting',
        reversibility: 'irreversible',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await rec2.close();

      let count = 0;
      for await (const _ of readRecords(rec2.path)) count++;
      assert(count === 2, `expected 2 records after reopen, got ${count}`);
    });

    await checkAsync('readRecords rejects non-.crec files (magic mismatch)', async () => {
      const bogus = join(tmp, 'bogus.crec');
      await writeFile(bogus, Buffer.from('NOTACRECFILE........'));
      let caught: unknown;
      try {
        for await (const _ of readRecords(bogus)) {
          /* should not yield */
        }
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught), 'should throw CortexError');
      assert(caught.errno === 'EINVAL', `expected EINVAL, got ${caught.errno}`);
    });

    await checkAsync('readRecords discards torn frame at EOF', async () => {
      const pid = asProcessId(104);
      const rec = await Recorder.open({ pid, dir: tmp });
      await rec.append({
        timestamp: '2026-01-01T00:00:00.000Z',
        pid,
        syscall: 'now',
        callId: 'c1',
        phase: 'exit',
        result: 1,
        stateBefore: 'running',
        stateAfter: 'running',
        reversibility: 'idempotent',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await rec.flush();
      const cleanEof = rec.currentOffset;
      await rec.close();

      // Append a partial frame header + truncated payload to simulate a
      // crash mid-write.
      const { appendFile } = await import('node:fs/promises');
      const partialHeader = Buffer.alloc(4);
      partialHeader.writeUInt32BE(1000, 0); // declares 1000 bytes
      await appendFile(rec.path, partialHeader);
      await appendFile(rec.path, Buffer.alloc(10)); // but only 10 arrive

      // Reader should yield the one clean record and stop at the torn frame.
      const records: SyscallRecord[] = [];
      for await (const r of readRecords(rec.path)) records.push(r);
      assert(records.length === 1, `expected 1 clean record, got ${records.length}`);

      // effectiveEof should report the offset just past the last complete frame.
      const eof = await effectiveEof(rec.path);
      assert(eof === cleanEof, `effectiveEof should be ${cleanEof}, got ${eof}`);
    });

    await checkAsync('append after close traps with ESTATE', async () => {
      const rec = await Recorder.open({ pid: asProcessId(105), dir: tmp });
      await rec.close();
      let caught: unknown;
      try {
        await rec.append({
          timestamp: '2026-01-01T00:00:00.000Z',
          pid: asProcessId(105),
          syscall: 'now',
          callId: 'c1',
          phase: 'exit',
          stateBefore: 'running',
          stateAfter: 'running',
          reversibility: 'idempotent',
          kernelAbiVersion: KERNEL_ABI_VERSION,
        });
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught), 'should throw CortexError');
      assert(caught.errno === 'ESTATE', `expected ESTATE, got ${caught.errno}`);
    });

    await checkAsync('close is idempotent', async () => {
      const rec = await Recorder.open({ pid: asProcessId(106), dir: tmp });
      await rec.close();
      await rec.close(); // should not throw
      assert(rec.closed === true, 'closed flag not set');
    });

    await checkAsync('oversized frame traps with EINVAL', async () => {
      const rec = await Recorder.open({ pid: asProcessId(107), dir: tmp });
      const huge = 'x'.repeat(CREC_MAX_FRAME_SIZE + 1);
      let caught: unknown;
      try {
        await rec.append({
          timestamp: '2026-01-01T00:00:00.000Z',
          pid: asProcessId(107),
          syscall: 'llm_call',
          callId: 'c1',
          phase: 'exit',
          result: huge,
          stateBefore: 'running',
          stateAfter: 'running',
          reversibility: 'reversible',
          kernelAbiVersion: KERNEL_ABI_VERSION,
        });
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught), 'should throw CortexError');
      assert(caught.errno === 'EINVAL', `expected EINVAL, got ${caught.errno}`);
      await rec.close();
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

await runRecorderChecks();

// =============================================================================
// Async checks (process_table)
// =============================================================================

async function runProcessTableChecks(): Promise<void> {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const tmp = await mkdtemp(join(tmpdir(), 'cortex-smoke-pt-'));

  // Frozen clock so timestamps are deterministic across checks.
  let fakeNow = Date.UTC(2026, 0, 1, 0, 0, 0);
  const clock = () => new Date(fakeNow).toISOString();
  const tick = (ms = 1000) => {
    fakeNow += ms;
  };

  /** Build a table whose recorders write into the temp dir. */
  async function makeTable(): Promise<ProcessTable> {
    return new ProcessTable({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      recorderFactory: async (pid) => Recorder.open({ pid, dir: tmp }),
    });
  }

  /** Minimal valid agent spec for allocation. */
  const agent = { module: './agents/noop.js' } as const;

  try {
    await checkAsync('reserved PID constants are correct', async () => {
      assert(unbrand(PID_KERNEL) === 0, 'PID_KERNEL should be 0');
      assert(unbrand(PID_INIT) === 1, 'PID_INIT should be 1');
      assert(PID_FIRST_USER === 2, 'PID_FIRST_USER should be 2');
    });

    await checkAsync('PROCESS_STATES has 9 entries (8 live + zombie)', async () => {
      // docs/PROCESS.md §2 says "eight states" but §3 enumerates nine
      // (including ZOMBIE). The table is authoritative; §2 prose needs a
      // doc fix. We assert nine here.
      assert(PROCESS_STATES.length === 9, `expected 9 states, got ${PROCESS_STATES.length}`);
    });

    await checkAsync('isLegalTransition matches the §5 table', async () => {
      assert(isLegalTransition('new', 'ready'), 'new->ready should be legal');
      assert(isLegalTransition('ready', 'running'), 'ready->running should be legal');
      assert(isLegalTransition('running', 'blocked'), 'running->blocked should be legal');
      assert(isLegalTransition('blocked', 'ready'), 'blocked->ready should be legal');
      assert(isLegalTransition('running', 'exiting'), 'running->exiting should be legal');
      assert(isLegalTransition('exiting', 'zombie'), 'exiting->zombie should be legal');
      assert(!isLegalTransition('new', 'running'), 'new->running should be ILLEGAL');
      assert(!isLegalTransition('zombie', 'ready'), 'zombie->ready should be ILLEGAL');
      assert(!isLegalTransition('suspended', 'ready'), 'suspended->ready should be ILLEGAL (restore creates new PID)');
    });

    await checkAsync('legalSuccessors returns reachable states', async () => {
      const fromRunning = legalSuccessors('running');
      assert(fromRunning.includes('ready'), 'running should reach ready');
      assert(fromRunning.includes('blocked'), 'running should reach blocked');
      assert(fromRunning.includes('exiting'), 'running should reach exiting');
      assert(fromRunning.includes('stopped'), 'running should reach stopped');
      assert(fromRunning.includes('checkpointing'), 'running should reach checkpointing');
      const fromZombie = legalSuccessors('zombie');
      assert(fromZombie.length === 0, 'zombie should have no successors (reap is terminal)');
    });

    await checkAsync('allocate assigns monotonic PIDs starting at 2', async () => {
      const table = await makeTable();
      const p1 = await table.allocate({ ppid: null, role: 'init', agent });
      const p2 = await table.allocate({ ppid: p1, role: 'worker', agent });
      const p3 = await table.allocate({ ppid: p1, role: 'worker', agent });
      assert(unbrand(p1) === 2, `first PID should be 2, got ${unbrand(p1)}`);
      assert(unbrand(p2) === 3, `second PID should be 3, got ${unbrand(p2)}`);
      assert(unbrand(p3) === 4, `third PID should be 4, got ${unbrand(p3)}`);
      assert(table.size === 3, `table size should be 3, got ${table.size}`);
    });

    await checkAsync('allocate places process in NEW state', async () => {
      const table = await makeTable();
      const pid = await table.allocate({ ppid: null, role: 'init', agent });
      const info = table.snapshot(pid);
      assert(info.state === 'new', `expected state new, got ${info.state}`);
      assert(info.role === 'init', 'role mismatch');
      assert(info.ppid === null, 'root process should have null ppid');
      assert(unbrand(info.pgid) === unbrand(pid), 'root process pgid should equal pid');
    });

    await checkAsync('allocate with missing parent traps ESRCH', async () => {
      const table = await makeTable();
      let caught: unknown;
      try {
        await table.allocate({ ppid: asProcessId(9999), role: 'orphan', agent });
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught), 'should throw CortexError');
      assert(caught.errno === 'ESRCH', `expected ESRCH, got ${caught.errno}`);
    });

    await checkAsync('allocate with duplicate explicit PID traps EINVAL', async () => {
      const table = await makeTable();
      const pid = await table.allocate({ ppid: null, role: 'init', agent });
      let caught: unknown;
      try {
        await table.allocate({ pid, ppid: null, role: 'dupe', agent });
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught), 'should throw CortexError');
      assert(caught.errno === 'EINVAL', `expected EINVAL, got ${caught.errno}`);
    });

    await checkAsync('child inherits parent PGID by default', async () => {
      const table = await makeTable();
      const root = await table.allocate({ ppid: null, role: 'root', agent });
      const child = await table.allocate({ ppid: root, role: 'child', agent });
      const grandchild = await table.allocate({ ppid: child, role: 'grandchild', agent });
      assert(unbrand(table.snapshot(child).pgid) === unbrand(root), 'child pgid should equal root pid');
      assert(unbrand(table.snapshot(grandchild).pgid) === unbrand(root), 'grandchild pgid should equal root pid');
      const members = table.groupMembers(root);
      assert(members.length === 3, `group should have 3 members, got ${members.length}`);
    });

    await checkAsync('legal transition sequence succeeds and records', async () => {
      const table = await makeTable();
      const pid = await table.allocate({ ppid: null, role: 'init', agent });
      await table.setState(pid, 'ready', { trigger: 'scheduler-init' });
      tick();
      await table.setState(pid, 'running', { trigger: 'dispatch' });
      tick();
      await table.setState(pid, 'blocked', { trigger: 'llm_call' });
      table.setBlockedOn(pid, { kind: 'llm', callId: 'call-1' });
      tick();
      await table.setState(pid, 'ready', { trigger: 'llm-response' });
      tick();
      await table.setState(pid, 'running', { trigger: 'dispatch' });
      tick();
      await table.setState(pid, 'exiting', { trigger: 'exit-syscall' });
      table.setExitInfo(pid, 0, 'normal', asSyscallOffset(0));
      tick();
      await table.setState(pid, 'zombie', { trigger: 'cleanup-done' });

      assert(table.snapshot(pid).state === 'zombie', 'final state should be zombie');

      // Verify __state records landed in the .crec log.
      const rec = table.recorderFor(pid);
      assert(rec !== null, 'recorder should exist');
      await rec!.flush();
      const stateRecords: SyscallRecord[] = [];
      for await (const r of readRecords(rec!.path)) {
        if (r.syscall === '__state') stateRecords.push(r);
      }
      // 7 transitions: new->ready, ready->running, running->blocked,
      // blocked->ready, ready->running, running->exiting, exiting->zombie
      assert(stateRecords.length === 7, `expected 7 __state records, got ${stateRecords.length}`);
      assert(stateRecords[0]!.args !== undefined, 'first record should carry args');
      const args0 = stateRecords[0]!.args as { from: string; to: string; trigger: string };
      assert(args0.from === 'new' && args0.to === 'ready', 'first transition wrong');
      assert(args0.trigger === 'scheduler-init', 'trigger metadata lost');
    });

    await checkAsync('illegal transition traps EINVAL with legalSuccessors', async () => {
      const table = await makeTable();
      const pid = await table.allocate({ ppid: null, role: 'init', agent });
      let caught: unknown;
      try {
        await table.setState(pid, 'running'); // NEW -> RUNNING is illegal
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught), 'should throw CortexError');
      assert(caught.errno === 'EINVAL', `expected EINVAL, got ${caught.errno}`);
      const details = caught.details as { from: string; to: string; legalSuccessors: string[] };
      assert(details.from === 'new', 'details.from wrong');
      assert(details.to === 'running', 'details.to wrong');
      assert(details.legalSuccessors.includes('ready'), 'legalSuccessors should include ready');
    });

    await checkAsync('no-op setState (same state) is allowed and not recorded', async () => {
      const table = await makeTable();
      const pid = await table.allocate({ ppid: null, role: 'init', agent });
      await table.setState(pid, 'ready');
      const rec = table.recorderFor(pid)!;
      await rec.flush();
      const offsetBefore = rec.currentOffset;
      await table.setState(pid, 'ready'); // no-op
      const offsetAfter = rec.currentOffset;
      assert(offsetBefore === offsetAfter, 'no-op transition should not write a record');
    });

    await checkAsync('snapshot is an immutable copy', async () => {
      const table = await makeTable();
      const pid = await table.allocate({ ppid: null, role: 'init', agent });
      const snap1 = table.snapshot(pid);
      await table.setState(pid, 'ready');
      const snap2 = table.snapshot(pid);
      assert(snap1.state === 'new', 'earlier snapshot should not change');
      assert(snap2.state === 'ready', 'later snapshot should reflect new state');
      assert(snap1 !== snap2, 'snapshots should be distinct objects');
    });

    await checkAsync('list with filter narrows results', async () => {
      const table = await makeTable();
      const root = await table.allocate({ ppid: null, role: 'init', agent });
      await table.allocate({ ppid: root, role: 'worker', agent });
      await table.allocate({ ppid: root, role: 'worker', agent });
      await table.allocate({ ppid: root, role: 'researcher', agent });

      assert(table.list().length === 4, 'unfiltered list should have 4');
      assert(table.list({ role: 'worker' }).length === 2, 'role filter should match 2');
      assert(table.list({ state: 'new' }).length === 4, 'state filter should match 4');
      assert(table.list({ ppid: root }).length === 3, 'ppid filter should match 3');
      assert(table.list({ role: 'nonexistent' }).length === 0, 'unknown role should match 0');
    });

    await checkAsync('children returns direct children in PID order', async () => {
      const table = await makeTable();
      const root = await table.allocate({ ppid: null, role: 'init', agent });
      const c1 = await table.allocate({ ppid: root, role: 'a', agent });
      const c2 = await table.allocate({ ppid: root, role: 'b', agent });
      const kids = table.children(root);
      assert(kids.length === 2, `expected 2 children, got ${kids.length}`);
      assert(unbrand(kids[0]!) === unbrand(c1), 'children should be PID-ordered');
      assert(unbrand(kids[1]!) === unbrand(c2), 'children should be PID-ordered');
    });

    await checkAsync('reap requires ZOMBIE state, traps ESTATE otherwise', async () => {
      const table = await makeTable();
      const pid = await table.allocate({ ppid: null, role: 'init', agent });
      let caught: unknown;
      try {
        await table.reap(pid); // still NEW
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught), 'should throw CortexError');
      assert(caught.errno === 'ESTATE', `expected ESTATE, got ${caught.errno}`);
    });

    await checkAsync('reap removes entry and PID is never reused', async () => {
      const table = await makeTable();
      const pid = await table.allocate({ ppid: null, role: 'init', agent });
      await table.setState(pid, 'ready');
      await table.setState(pid, 'running');
      await table.setState(pid, 'exiting');
      table.setExitInfo(pid, 42, 'test-exit', asSyscallOffset(123));
      await table.setState(pid, 'zombie');

      const result = await table.reap(pid);
      assert(result.exitCode === 42, `exitCode should be 42, got ${result.exitCode}`);
      assert(result.exitReason === 'test-exit', 'exitReason mismatch');
      assert(!table.has(pid), 'entry should be removed after reap');
      assert(table.recorderFor(pid) === null, 'recorder should be cleared after reap');

      // Next allocation must NOT reuse the reaped PID.
      const nextPid = await table.allocate({ ppid: null, role: 'fresh', agent });
      assert(unbrand(nextPid) > unbrand(pid), `new PID ${unbrand(nextPid)} should exceed reaped ${unbrand(pid)}`);
    });

    await checkAsync('signal queue coalesces duplicates and drains', async () => {
      const table = await makeTable();
      const pid = await table.allocate({ ppid: null, role: 'init', agent });
      table.queueSignal(pid, 'SIGUSR1');
      table.queueSignal(pid, 'SIGUSR1'); // duplicate, should coalesce
      table.queueSignal(pid, 'SIGTERM');
      table.queueSignal(pid, 'SIGUSR1'); // still pending, coalesce again

      const info = table.snapshot(pid);
      assert(info.pendingSignals.length === 2, `expected 2 pending, got ${info.pendingSignals.length}`);
      assert(info.pendingSignals.includes('SIGUSR1'), 'SIGUSR1 should be pending');
      assert(info.pendingSignals.includes('SIGTERM'), 'SIGTERM should be pending');

      const drained = table.drainSignals(pid);
      assert(drained.length === 2, `drain should return 2, got ${drained.length}`);
      assert(table.snapshot(pid).pendingSignals.length === 0, 'queue should be empty after drain');
    });

    await checkAsync('setDisposition rejects catching SIGKILL/SIGSTOP with EPERM', async () => {
      const table = await makeTable();
      const pid = await table.allocate({ ppid: null, role: 'init', agent });

      for (const sig of ['SIGKILL', 'SIGSTOP'] as Signal[]) {
        let caught: unknown;
        try {
          table.setDisposition(pid, sig, { kind: 'ignore' });
        } catch (err) {
          caught = err;
        }
        assert(isCortexError(caught), `${sig}: should throw CortexError`);
        assert(caught.errno === 'EPERM', `${sig}: expected EPERM, got ${caught.errno}`);
      }

      // SIGUSR1 CAN be caught.
      table.setDisposition(pid, 'SIGUSR1', { kind: 'ignore' });
      assert(table.getDisposition(pid, 'SIGUSR1').kind === 'ignore', 'SIGUSR1 disposition should be set');
      // Default fallback for unset signals.
      assert(table.getDisposition(pid, 'SIGHUP').kind === 'default', 'unset signal should default');
    });

    await checkAsync('budget spend decrements remaining and checkBudget detects exhaustion', async () => {
      const table = await makeTable();
      const pid = await table.allocate({
        ppid: null,
        role: 'init',
        agent,
        budgets: { tokens: 1000, usd: 500, wallTimeMs: -1 },
      });

      assert(table.checkBudget(pid) === 'ok', 'fresh process should be ok');

      table.spend(pid, { tokensIn: 300, tokensOut: 200, usdSpent: 100 });
      const info = table.snapshot(pid);
      assert(info.budgetsSpent.tokensIn === 300, 'tokensIn spend wrong');
      assert(info.budgetsRemaining.tokens === 500, `remaining tokens should be 500, got ${info.budgetsRemaining.tokens}`);
      assert(info.budgetsRemaining.usd === 400, 'remaining usd wrong');
      assert(info.budgetsRemaining.wallTimeMs === -1, 'unlimited wallTime should stay -1');

      table.spend(pid, { tokensIn: 500 }); // exhausts tokens
      assert(table.checkBudget(pid) === 'ok' || (table.checkBudget(pid) as { kind: string }).kind === 'tokens',
        'tokens should be exhausted');
      const exhausted = table.checkBudget(pid);
      assert(exhausted !== 'ok', 'budget should be exhausted');
      assert((exhausted as { kind: string }).kind === 'tokens', 'exhausted kind should be tokens');
    });

    await checkAsync('pushCheckpoint appends to chain', async () => {
      const table = await makeTable();
      const pid = await table.allocate({ ppid: null, role: 'init', agent });
      const c1 = asChainId('chain-1');
      const c2 = asChainId('chain-2');
      table.pushCheckpoint(pid, c1);
      table.pushCheckpoint(pid, c2);
      const chain = table.snapshot(pid).checkpointChain;
      assert(chain.length === 2, `expected 2 checkpoints, got ${chain.length}`);
      assert(chain[0] === c1 && chain[1] === c2, 'chain order wrong');
    });

    await checkAsync('nullRecorderFactory produces a table that does not write', async () => {
      const table = new ProcessTable({
        kernelAbiVersion: KERNEL_ABI_VERSION,
        now: clock,
        recorderFactory: nullRecorderFactory,
      });
      const pid = await table.allocate({ ppid: null, role: 'init', agent });
      await table.setState(pid, 'ready');
      assert(table.recorderFor(pid) === null, 'recorder should be null');
      assert(table.snapshot(pid).state === 'ready', 'state should still update');
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

await runProcessTableChecks();

// =============================================================================
// Async checks (signals)
// =============================================================================

async function runSignalsChecks(): Promise<void> {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const tmp = await mkdtemp(join(tmpdir(), 'cortex-smoke-sig-'));

  let fakeNow = Date.UTC(2026, 0, 1, 0, 0, 0);
  const clock = () => new Date(fakeNow).toISOString();
  const tick = (ms = 1000) => {
    fakeNow += ms;
  };

  async function makeTable(): Promise<ProcessTable> {
    return new ProcessTable({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      recorderFactory: async (pid) => Recorder.open({ pid, dir: tmp }),
    });
  }

  const agent = { module: './agents/noop.js' } as const;

  /** Allocate a process and walk it to RUNNING. Returns [table, pid]. */
  async function spawnRunning(table: ProcessTable, role = 'worker'): Promise<ProcessIdAlias> {
    const pid = await table.allocate({ ppid: null, role, agent });
    await table.setState(pid, 'ready', { trigger: 'init' });
    tick();
    await table.setState(pid, 'running', { trigger: 'dispatch' });
    tick();
    return pid;
  }

  try {
    await checkAsync('SIGNAL_NUMBERS has 13 entries with unique numbers', async () => {
      assert(ALL_SIGNALS.length === 13, `expected 13 signals, got ${ALL_SIGNALS.length}`);
      const nums = ALL_SIGNALS.map((s) => SIGNAL_NUMBERS[s]);
      const uniq = new Set(nums);
      assert(uniq.size === nums.length, 'signal numbers should be unique');
      // Spot-check a few well-known numbers from PROCESS.md §7.
      assert(SIGNAL_NUMBERS.SIGHUP === 1, 'SIGHUP should be 1');
      assert(SIGNAL_NUMBERS.SIGKILL === 9, 'SIGKILL should be 9');
      assert(SIGNAL_NUMBERS.SIGTERM === 15, 'SIGTERM should be 15');
      assert(SIGNAL_NUMBERS.SIGSTOP === 17, 'SIGSTOP should be 17');
      assert(SIGNAL_NUMBERS.SIGCONT === 18, 'SIGCONT should be 18');
    });

    await checkAsync('signalFromNumber round-trips for every signal', async () => {
      for (const sig of ALL_SIGNALS) {
        const n = SIGNAL_NUMBERS[sig];
        assert(signalFromNumber(n) === sig, `round-trip failed for ${sig} (${n})`);
      }
      assert(signalFromNumber(9999) === undefined, 'unknown number should return undefined');
    });

    await checkAsync('every signal has a default action', async () => {
      for (const sig of ALL_SIGNALS) {
        const action = DEFAULT_ACTIONS[sig];
        assert(
          action === 'ignore' || action === 'terminate' || action === 'kill' ||
          action === 'stop' || action === 'continue',
          `${sig} has invalid default action: ${action}`,
        );
      }
      // Specific values from PROCESS.md §7.
      assert(DEFAULT_ACTIONS.SIGKILL === 'kill', 'SIGKILL default should be kill');
      assert(DEFAULT_ACTIONS.SIGTERM === 'terminate', 'SIGTERM default should be terminate');
      assert(DEFAULT_ACTIONS.SIGSTOP === 'stop', 'SIGSTOP default should be stop');
      assert(DEFAULT_ACTIONS.SIGCONT === 'continue', 'SIGCONT default should be continue');
      assert(DEFAULT_ACTIONS.SIGXCPU === 'stop', 'SIGXCPU default should be stop');
      assert(DEFAULT_ACTIONS.SIGHUP === 'ignore', 'SIGHUP default should be ignore');
    });

    await checkAsync('UNCATCHABLE_SIGNALS is exactly {SIGKILL, SIGSTOP}', async () => {
      assert(UNCATCHABLE_SIGNALS.size === 2, `expected 2, got ${UNCATCHABLE_SIGNALS.size}`);
      assert(UNCATCHABLE_SIGNALS.has('SIGKILL'), 'SIGKILL should be uncatchable');
      assert(UNCATCHABLE_SIGNALS.has('SIGSTOP'), 'SIGSTOP should be uncatchable');
      assert(!UNCATCHABLE_SIGNALS.has('SIGTERM'), 'SIGTERM should be catchable');
    });

    await checkAsync('exitCodeForSignal follows 128+N convention', async () => {
      assert(exitCodeForSignal('SIGKILL') === 137, `SIGKILL exit should be 137, got ${exitCodeForSignal('SIGKILL')}`);
      assert(exitCodeForSignal('SIGTERM') === 143, `SIGTERM exit should be 143, got ${exitCodeForSignal('SIGTERM')}`);
      assert(exitCodeForSignal('SIGINT') === 130, `SIGINT exit should be 130, got ${exitCodeForSignal('SIGINT')}`);
    });

    await checkAsync('isImmediateSignal flags SIGKILL and SIGCONT only', async () => {
      assert(isImmediateSignal('SIGKILL'), 'SIGKILL should be immediate');
      assert(isImmediateSignal('SIGCONT'), 'SIGCONT should be immediate');
      assert(!isImmediateSignal('SIGTERM'), 'SIGTERM should not be immediate');
      assert(!isImmediateSignal('SIGSTOP'), 'SIGSTOP should not be immediate (only fires from RUNNING)');
    });

    await checkAsync('SIGTERM to RUNNING process terminates with exit 143', async () => {
      const table = await makeTable();
      const pid = await spawnRunning(table);
      const mgr = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const outcome = await mgr.send(pid, 'SIGTERM');
      assert(outcome === 'delivered', `expected delivered, got ${outcome}`);
      const info = table.snapshot(pid);
      assert(info.state === 'zombie', `expected zombie, got ${info.state}`);
      assert(info.exitCode === 143, `expected exit 143, got ${info.exitCode}`);
      assert(info.exitReason === 'signal:SIGTERM', `wrong exitReason: ${info.exitReason}`);
    });

    await checkAsync('SIGKILL from BLOCKED walks blocked->exiting->zombie', async () => {
      const table = await makeTable();
      const pid = await spawnRunning(table);
      await table.setState(pid, 'blocked', { trigger: 'llm_call' });
      table.setBlockedOn(pid, { kind: 'llm', callId: 'call-1' });
      tick();

      const mgr = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const outcome = await mgr.send(pid, 'SIGKILL');
      assert(outcome === 'delivered', `expected delivered, got ${outcome}`);
      assert(table.snapshot(pid).state === 'zombie', 'should be zombie after SIGKILL');
      assert(table.snapshot(pid).exitCode === 137, 'exit code should be 137');
    });

    await checkAsync('SIGKILL from NEW walks new->ready->running->exiting->zombie', async () => {
      const table = await makeTable();
      const pid = await table.allocate({ ppid: null, role: 'fresh', agent });
      const mgr = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const outcome = await mgr.send(pid, 'SIGKILL');
      assert(outcome === 'delivered', `expected delivered, got ${outcome}`);
      assert(table.snapshot(pid).state === 'zombie', 'should be zombie');
    });

    await checkAsync('SIGSTOP from RUNNING transitions to STOPPED', async () => {
      const table = await makeTable();
      const pid = await spawnRunning(table);
      const mgr = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const outcome = await mgr.send(pid, 'SIGSTOP');
      assert(outcome === 'delivered', `expected delivered, got ${outcome}`);
      assert(table.snapshot(pid).state === 'stopped', 'should be stopped');
    });

    await checkAsync('SIGSTOP from BLOCKED is queued', async () => {
      const table = await makeTable();
      const pid = await spawnRunning(table);
      await table.setState(pid, 'blocked');
      tick();

      const mgr = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const outcome = await mgr.send(pid, 'SIGSTOP');
      assert(outcome === 'queued', `expected queued, got ${outcome}`);
      assert(table.snapshot(pid).state === 'blocked', 'state should not change');
      assert(table.snapshot(pid).pendingSignals.includes('SIGSTOP'), 'SIGSTOP should be pending');
    });

    await checkAsync('SIGCONT from STOPPED transitions to READY', async () => {
      const table = await makeTable();
      const pid = await spawnRunning(table);
      const mgr = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      await mgr.send(pid, 'SIGSTOP');
      assert(table.snapshot(pid).state === 'stopped', 'precondition: stopped');
      const outcome = await mgr.send(pid, 'SIGCONT');
      assert(outcome === 'delivered', `expected delivered, got ${outcome}`);
      assert(table.snapshot(pid).state === 'ready', 'should be ready after SIGCONT');
    });

    await checkAsync('SIGCONT from RUNNING is dropped (no-op)', async () => {
      const table = await makeTable();
      const pid = await spawnRunning(table);
      const mgr = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const outcome = await mgr.send(pid, 'SIGCONT');
      assert(outcome === 'dropped', `expected dropped, got ${outcome}`);
      assert(table.snapshot(pid).state === 'running', 'state should be unchanged');
    });

    await checkAsync('SIGTERM to BLOCKED process queues until next RUNNING', async () => {
      const table = await makeTable();
      const pid = await spawnRunning(table);
      await table.setState(pid, 'blocked');
      tick();

      const mgr = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const queued = await mgr.send(pid, 'SIGTERM');
      assert(queued === 'queued', `expected queued, got ${queued}`);
      assert(table.snapshot(pid).state === 'blocked', 'should still be blocked');

      // Wake the process and dispatch.
      await table.setState(pid, 'ready');
      tick();
      await table.setState(pid, 'running');
      tick();

      const outcomes = await mgr.deliverPending(pid);
      assert(outcomes.length === 1, `expected 1 delivery, got ${outcomes.length}`);
      assert(outcomes[0] === 'delivered', `expected delivered, got ${outcomes[0]}`);
      assert(table.snapshot(pid).state === 'zombie', 'should be zombie after pending SIGTERM');
    });

    await checkAsync('ignore disposition drops the signal', async () => {
      const table = await makeTable();
      const pid = await spawnRunning(table);
      table.setDisposition(pid, 'SIGTERM', { kind: 'ignore' });

      const mgr = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const outcome = await mgr.send(pid, 'SIGTERM');
      assert(outcome === 'dropped', `expected dropped, got ${outcome}`);
      assert(table.snapshot(pid).state === 'running', 'should still be running');
    });

    await checkAsync('handler disposition invokes the handlerInvoker', async () => {
      const table = await makeTable();
      const pid = await spawnRunning(table);

      const calls: { pid: ProcessIdAlias; signal: Signal }[] = [];
      const handler = (): void => {
        /* recorded by the invoker */
      };
      table.setDisposition(pid, 'SIGUSR1', { kind: 'handler', handler });

      const mgr = new SignalManager({
        table,
        kernelAbiVersion: KERNEL_ABI_VERSION,
        now: clock,
        handlerInvoker: async (p, s) => {
          calls.push({ pid: p, signal: s });
        },
      });

      const outcome = await mgr.send(pid, 'SIGUSR1');
      assert(outcome === 'delivered', `expected delivered, got ${outcome}`);
      assert(calls.length === 1, `handler should be invoked once, got ${calls.length}`);
      assert(calls[0]!.signal === 'SIGUSR1', 'wrong signal passed to handler');
      assert(unbrand(calls[0]!.pid) === unbrand(pid), 'wrong pid passed to handler');
      assert(table.snapshot(pid).state === 'running', 'state should be unchanged');
    });

    await checkAsync('handler that throws produces failed outcome', async () => {
      const table = await makeTable();
      const pid = await spawnRunning(table);
      table.setDisposition(pid, 'SIGUSR1', {
        kind: 'handler',
        handler: () => {
          throw new Error('handler exploded');
        },
      });

      const mgr = new SignalManager({
        table,
        kernelAbiVersion: KERNEL_ABI_VERSION,
        now: clock,
        handlerInvoker: async (_p, _s, h) => {
          await h({} as never); // trigger the throw
        },
      });

      const outcome = await mgr.send(pid, 'SIGUSR1');
      assert(outcome === 'failed', `expected failed, got ${outcome}`);
      assert(table.snapshot(pid).state === 'running', 'process should survive a failed handler');
    });

    await checkAsync('handler disposition without invoker traps EINVAL', async () => {
      const table = await makeTable();
      const pid = await spawnRunning(table);
      table.setDisposition(pid, 'SIGUSR1', { kind: 'handler', handler: () => {} });

      const mgr = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      let caught: unknown;
      try {
        await mgr.send(pid, 'SIGUSR1');
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught), 'should throw CortexError');
      assert(caught.errno === 'EINVAL', `expected EINVAL, got ${caught.errno}`);
    });

    await checkAsync('send to absent PID traps ESRCH', async () => {
      const table = await makeTable();
      const mgr = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      let caught: unknown;
      try {
        await mgr.send(asProcessId(9999), 'SIGTERM');
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught), 'should throw CortexError');
      assert(caught.errno === 'ESRCH', `expected ESRCH, got ${caught.errno}`);
    });

    await checkAsync('send to ZOMBIE traps ESRCH', async () => {
      const table = await makeTable();
      const pid = await spawnRunning(table);
      const mgr = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      await mgr.send(pid, 'SIGKILL');
      assert(table.snapshot(pid).state === 'zombie', 'precondition: zombie');

      let caught: unknown;
      try {
        await mgr.send(pid, 'SIGTERM');
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught), 'should throw CortexError');
      assert(caught.errno === 'ESRCH', `expected ESRCH, got ${caught.errno}`);
    });

    await checkAsync('sendGroup delivers to all live members and skips zombies', async () => {
      const table = await makeTable();
      const root = await table.allocate({ ppid: null, role: 'root', agent });
      await table.setState(root, 'ready');
      await table.setState(root, 'running');
      const c1 = await table.allocate({ ppid: root, role: 'c1', agent });
      await table.setState(c1, 'ready');
      await table.setState(c1, 'running');
      const c2 = await table.allocate({ ppid: root, role: 'c2', agent });
      await table.setState(c2, 'ready');
      await table.setState(c2, 'running');

      // Kill c2 first so it's a zombie when the group signal arrives.
      const mgr = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      await mgr.send(c2, 'SIGKILL');
      assert(table.snapshot(c2).state === 'zombie', 'c2 should be zombie');

      const outcomes = await mgr.sendGroup(table.snapshot(root).pgid, 'SIGTERM');
      assert(outcomes.size === 2, `expected 2 outcomes (root + c1), got ${outcomes.size}`);
      assert(outcomes.get(root) === 'delivered', 'root should be delivered');
      assert(outcomes.get(c1) === 'delivered', 'c1 should be delivered');
      assert(!outcomes.has(c2), 'zombie c2 should be skipped');
      assert(table.snapshot(root).state === 'zombie', 'root should be zombie');
      assert(table.snapshot(c1).state === 'zombie', 'c1 should be zombie');
    });

    await checkAsync('SIGXCPU default action stops the process', async () => {
      const table = await makeTable();
      const pid = await spawnRunning(table);
      const mgr = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const outcome = await mgr.send(pid, 'SIGXCPU');
      assert(outcome === 'delivered', `expected delivered, got ${outcome}`);
      assert(table.snapshot(pid).state === 'stopped', 'SIGXCPU should stop the process');
    });

    await checkAsync('SIGHUP default action is ignore (drop)', async () => {
      const table = await makeTable();
      const pid = await spawnRunning(table);
      const mgr = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const outcome = await mgr.send(pid, 'SIGHUP');
      assert(outcome === 'dropped', `expected dropped, got ${outcome}`);
      assert(table.snapshot(pid).state === 'running', 'state should not change');
    });

    await checkAsync('coalescing: duplicate SIGUSR1 in queue stays single', async () => {
      const table = await makeTable();
      const pid = await spawnRunning(table);
      await table.setState(pid, 'blocked');
      tick();

      const mgr = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      await mgr.send(pid, 'SIGUSR1');
      await mgr.send(pid, 'SIGUSR1');
      await mgr.send(pid, 'SIGUSR1');
      const pending = table.snapshot(pid).pendingSignals;
      assert(pending.length === 1, `expected coalesced to 1, got ${pending.length}`);
      assert(pending[0] === 'SIGUSR1', 'wrong signal pending');
    });

    await checkAsync('__signal records land in the .crec log', async () => {
      // Use a dedicated subdir so we don't see records from prior checks
      // (ProcessTable starts PIDs at 2 every time and the recorder appends).
      const { mkdir } = await import('node:fs/promises');
      const sub = join(tmp, 'sig-records');
      await mkdir(sub, { recursive: true });
      const table = new ProcessTable({
        kernelAbiVersion: KERNEL_ABI_VERSION,
        now: clock,
        recorderFactory: async (pid) => Recorder.open({ pid, dir: sub }),
      });
      const pid = await spawnRunning(table);
      const mgr = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      await mgr.send(pid, 'SIGHUP'); // dropped, but still recorded
      await mgr.send(pid, 'SIGTERM'); // delivered

      const rec = table.recorderFor(pid);
      assert(rec !== null, 'recorder should exist');
      await rec!.flush();

      const sigRecords: SyscallRecord[] = [];
      for await (const r of readRecords(rec!.path)) {
        if (r.syscall === '__signal') sigRecords.push(r);
      }
      assert(sigRecords.length === 2, `expected 2 __signal records, got ${sigRecords.length}`);

      const args0 = sigRecords[0]!.args as { signal: string; outcome: string };
      assert(args0.signal === 'SIGHUP', 'first record should be SIGHUP');
      assert(args0.outcome === 'dropped', `first outcome should be dropped, got ${args0.outcome}`);

      const args1 = sigRecords[1]!.args as { signal: string; outcome: string };
      assert(args1.signal === 'SIGTERM', 'second record should be SIGTERM');
      assert(args1.outcome === 'delivered', `second outcome should be delivered, got ${args1.outcome}`);
    });

    await checkAsync('onZombie hook fires after terminate', async () => {
      const table = await makeTable();
      const pid = await spawnRunning(table);
      const events: { pid: ProcessIdAlias; code: number; reason: string }[] = [];
      const mgr = new SignalManager({
        table,
        kernelAbiVersion: KERNEL_ABI_VERSION,
        now: clock,
        onZombie: (p, code, reason) => {
          events.push({ pid: p, code, reason });
        },
      });
      await mgr.send(pid, 'SIGTERM');
      assert(events.length === 1, `expected 1 onZombie call, got ${events.length}`);
      assert(events[0]!.code === 143, 'wrong exit code in hook');
      assert(events[0]!.reason === 'signal:SIGTERM', 'wrong reason in hook');
    });

    await checkAsync('deliverPending re-queues tail if state changes mid-drain', async () => {
      const table = await makeTable();
      const pid = await spawnRunning(table);
      await table.setState(pid, 'blocked');
      tick();

      const mgr = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      // Queue SIGSTOP first (will move us out of RUNNING), then SIGUSR1.
      await mgr.send(pid, 'SIGSTOP');
      await mgr.send(pid, 'SIGUSR1');
      // Both queued because state is BLOCKED.
      assert(table.snapshot(pid).pendingSignals.length === 2, 'both should be queued');

      // Wake and dispatch.
      await table.setState(pid, 'ready');
      await table.setState(pid, 'running');
      tick();

      const outcomes = await mgr.deliverPending(pid);
      assert(outcomes.length === 1, `expected 1 delivery before state change, got ${outcomes.length}`);
      assert(table.snapshot(pid).state === 'stopped', 'should be stopped after SIGSTOP fires');
      // SIGUSR1 should have been re-queued for the next RUNNING.
      assert(
        table.snapshot(pid).pendingSignals.includes('SIGUSR1'),
        'SIGUSR1 should be re-queued after SIGSTOP moved us out of RUNNING',
      );
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// Local alias to keep the helper signatures above short.
type ProcessIdAlias = ReturnType<typeof asProcessId>;

await runSignalsChecks();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
