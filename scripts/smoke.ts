/**
 * Phase 1 smoke check — types.ts + errors.ts + recorder.ts runtime sanity.
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
