/**
 * Phase 1 smoke check — types.ts + errors.ts + recorder.ts + process_table.ts
 * + signals.ts runtime sanity.
 *
 * Not a real test (no test framework yet, that lands with #012+). This is
 * a "does the module load and do the runtime bits behave" check, run via
 * `npm run smoke`. Once Phase 1 has a test runner, this gets absorbed into
 * tests/ and deleted.
 */

import { readFileSync } from 'node:fs';
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
  Recorder,
  readRecords,
  effectiveEof,
  crecPath,
  legacyCrecPath,
  existingCrecPath,
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
  IpcManager,
  pidInboxChannel,
  isProcessTarget,
  resolveChannel,
  DEFAULT_QUEUE_LIMIT,
  DEFAULT_RECV_TIMEOUT_MS,
  type ChannelInfo,
  MemoryManager,
  sharedPhysicalKey,
  serializeValue,
  hashValue,
  valueByteSize,
  DEFAULT_LARGE_VALUE_BYTES,
  DEFAULT_MAX_REGION_ENTRIES,
  type IMemoryDriver,
  type MemoryRegionPolicy,
  type MemoryQuery,
  type MemoryEntry,
  CheckpointManager,
  CSNAP_MAGIC,
  CSNAP_MAGIC_STR,
  CSNAP_HEADER_SIZE,
  CHECKPOINT_VERSION,
  SIGNATURE_SIZE,
  EMPTY_COGNITIVE,
  safeTimestamp,
  type Checkpoint,
  type CognitiveSnapshot,
  type RestoreContext,
  ForkManager,
  FORK_ALLOWED_STATES,
  DEFAULT_FORK_KIND,
  DEFAULT_BUDGET_POLICY,
  type ForkResult,
  type ForkOptions,
  Scheduler,
  DEFAULT_IDLE_DELAY_MS,
  DEFAULT_BUSY_DELAY_MS,
  type TickOutcome,
  type DispatchReason,
  type ResumeFn,
  InitProcess,
  INIT_AGENT_SPEC,
  DEFAULT_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_BACKOFF_EXPONENT,
  DEFAULT_RESTART_WINDOW_MS,
  DEFAULT_RESTART_STORM_THRESHOLD,
  shouldRestartFromCode,
  type DaemonSpec,
  type InitAlarm,
  type OnAlarmHook,
  type ShutdownReport,
  SyscallDispatcher,
  ProcessExitSignal,
  isProcessExitSignal,
  SYSCALL_NAMES,
  SYSCALL_ALLOWED_STATES,
  SYSCALL_REVERSIBILITY,
  SYSCALL_REQUIRED_CAPABILITY,
  SELF_RECORDED_SYSCALLS,
  UNRECORDED_SYSCALLS,
  killReversibility,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  type ResolveLLMHook,
  type ResolveToolHook,
  type ILLMDriver,
  type IToolDriver,
  type ToolDescriptor,
  type DriverContext,
  type StagedAction,
  type Reversibility,
  type SignalHandler,
  type SpawnOptions,
  type RandomOptions,
  type BudgetLimits,
  DriverRegistry,
  satisfiesAbi,
  parseSemver,
  type DriverManifest,
  type ToolDriverInfo,
  type ToolCall,
  type Message,
  Kernel,
  bootKernel,
  PROMPT_AGENT_MAX_TURNS,
  type AgentFn,
  type KernelOptions,
} from '../src/index.js';

import {
  MockLLMDriver,
  mockLLM,
  estimateTextTokens,
  estimateMessageTokens,
  MOCK_DEFAULTS,
  MOCK_CHARS_PER_TOKEN,
  type MockTurn,
} from '../src/drivers/llm/mock.js';

import {
  DeepSeekLLMDriver,
  deepseekLLM,
  DEEPSEEK_DEFAULTS,
  DEEPSEEK_PRICING,
  DEEPSEEK_CHARS_PER_TOKEN,
  estimateDeepSeekTokens,
  estimateDeepSeekMessageTokens,
  computeUsd,
  errnoForStatus,
  type FetchFn,
  type FetchResponseLike,
} from '../src/drivers/llm/deepseek.js';

import {
  OpenAiLLMDriver,
  openaiLLM,
  OPENAI_DEFAULTS,
  OPENAI_PRICING,
  OPENAI_CHARS_PER_TOKEN,
  estimateOpenAiTokens,
  estimateOpenAiMessageTokens,
  computeUsd as computeOpenAiUsd,
  errnoForStatus as openaiErrnoForStatus,
  type FetchFn as OpenAiFetchFn,
  type FetchResponseLike as OpenAiFetchResponseLike,
} from '../src/drivers/llm/openai.js';

import {
  FsToolDriver,
  fsTool,
  FS_DEFAULTS,
} from '../src/drivers/tool/fs.js';

import {
  McpToolDriver,
  mcpTool,
  MCP_DEFAULTS,
  StdioMcpTransport,
  mapCallResult,
  errnoForRpcError,
  isMcpToolDriver,
  type McpTransport,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcResponse,
} from '../src/drivers/tool/mcp.js';

import { CAPABILITIES, type ToolInvokeContext, type Capability } from '../src/kernel/types.js';

import {
  diffRecords,
  findDivergence,
  splitAtOffset,
  summarize,
  filterStateRecords,
  recordSignature,
  recordDetail,
  formatMs,
  clockOf,
  stableJson,
  MAX_LCS_CELLS,
  type DiffLine,
} from '../src/cli/diff_core.js';

import { cmdDiff } from '../src/cli/commands/diff.js';
import { cmdTrace } from '../src/cli/commands/trace.js';
import { cmdAttach } from '../src/cli/commands/attach.js';
import {
  listDaemons,
  readDaemon,
  writeDaemon,
  deleteDaemon,
} from '../src/cli/daemon_store.js';
import {
  cmdDaemon,
  generateServiceUnit,
  enableCommand,
  unitPathFor,
} from '../src/cli/commands/daemon.js';

import {
  InMemMemoryDriver,
  inmemMemory,
} from '../src/drivers/memory/inmem.js';

import {
  SqliteMemoryDriver,
  sqliteMemory,
  SQLITE_DEFAULTS,
} from '../src/drivers/memory/sqlite.js';

import {
  writeMeta,
  readMeta,
  readAllMetas,
  maxPidOnDisk,
  metaPath,
  legacyMetaPath,
  procDir,
  listProcDirs,
  readExitRecord,
  findCheckpointByTag,
  type ProcessMeta,
} from '../src/cli/process_store.js';

import {
  parseMemoryArg,
  mergeRegionPolicies,
  validateRegionPolicy,
  MemoryArgError,
} from '../src/cli/regions.js';
import { cmdSpawn } from '../src/cli/commands/spawn.js';
import { DEFAULT_MEMORY_REGIONS } from '../src/cli/index.js';

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

console.log(`cortex v${VERSION} — ABI ${KERNEL_ABI_VERSION}`);
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

check('VERSION tracks package.json and no banner hardcodes a version', () => {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const declared = (manifest as { version?: unknown }).version;
  assert(typeof declared === 'string', 'package.json declares no version');
  assert(
    VERSION === declared,
    `VERSION ${VERSION} != package.json ${declared} — read the manifest, never hardcode`,
  );
  assert(/^\d+\.\d+\.\d+$/.test(VERSION), `VERSION not semver: ${VERSION}`);
  assert(
    typeof KERNEL_ABI_VERSION === 'string' && /^\d+\.\d+\.\d+$/.test(KERNEL_ABI_VERSION),
    `KERNEL_ABI_VERSION not semver: ${KERNEL_ABI_VERSION}`,
  );
  // `0.1.0` shipped reporting itself as `v0.0.1`, because both CLI banners
  // carried their own literal while `package.json` moved on. The constant is
  // derived now, so this guards the call sites: a `cortex v<semver>` literal
  // anywhere in the CLI means the bug is back. (The old assertion here only
  // checked that VERSION was a non-empty string, which is why it passed.)
  for (const rel of ['src/cli/index.ts', 'src/cli/commands/help.ts']) {
    const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    assert(
      !/cortex v\d+\.\d+\.\d+/.test(src),
      `${rel} hardcodes a version in its banner — interpolate VERSION instead`,
    );
  }
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
p === join('/var/lib/cortex', 'processes', '42', 'log.crec'),
`unexpected path: ${p}`,
);
// A log written before 0.2.1 is still findable for reading.
assert(
legacyCrecPath('/var/lib/cortex', asProcessId(42)) ===
join('/var/lib/cortex', 'processes', '42.crec'),
'legacy flat path helper still resolves the old layout',
);
});

    await checkAsync('Recorder.open creates file with magic', async () => {
      const rec = await Recorder.open({ pid: asProcessId(100), dir: join(tmp, '100') });
      assert(rec.currentOffset === asSyscallOffset(8), `expected offset 8, got ${rec.currentOffset}`);
      const buf = await readFile(rec.path);
      assert(buf.byteLength === 8, `expected 8-byte file, got ${buf.byteLength}`);
      assert(buf.equals(Buffer.from(CREC_MAGIC)), 'magic mismatch');
      await rec.close();
    });

    await checkAsync('append + readRecords round-trips a record', async () => {
      const rec = await Recorder.open({ pid: asProcessId(101), dir: join(tmp, '101') });
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
      const rec = await Recorder.open({ pid: asProcessId(102), dir: join(tmp, '102') });
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
      const rec1 = await Recorder.open({ pid, dir: join(tmp, String(unbrand(pid))) });
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
      const rec2 = await Recorder.open({ pid, dir: join(tmp, String(unbrand(pid))) });
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
      const rec = await Recorder.open({ pid, dir: join(tmp, String(unbrand(pid))) });
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
      const rec = await Recorder.open({ pid: asProcessId(105), dir: join(tmp, '105') });
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
      const rec = await Recorder.open({ pid: asProcessId(106), dir: join(tmp, '106') });
      await rec.close();
      await rec.close(); // should not throw
      assert(rec.closed === true, 'closed flag not set');
    });

    await checkAsync('oversized frame traps with EINVAL', async () => {
      const rec = await Recorder.open({ pid: asProcessId(107), dir: join(tmp, '107') });
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
  const tables: ProcessTable[] = [];

  // Frozen clock so timestamps are deterministic across checks.
  let fakeNow = Date.UTC(2026, 0, 1, 0, 0, 0);
  const clock = () => new Date(fakeNow).toISOString();
  const tick = (ms = 1000) => {
    fakeNow += ms;
  };

  /** Build a table whose recorders write into the temp dir. */
  async function makeTable(): Promise<ProcessTable> {
    const t = new ProcessTable({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      recorderFactory: async (pid) => Recorder.open({ pid, dir: join(tmp, String(unbrand(pid))) }),
    });
    tables.push(t);
    return t;
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
    for (const t of tables) {
      for (const pid of t.pids()) {
        const rec = t.recorderFor(pid);
        if (rec !== null) await rec.close().catch(() => {});
      }
    }
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
  const tables: ProcessTable[] = [];

  let fakeNow = Date.UTC(2026, 0, 1, 0, 0, 0);
  const clock = () => new Date(fakeNow).toISOString();
  const tick = (ms = 1000) => {
    fakeNow += ms;
  };

  async function makeTable(): Promise<ProcessTable> {
    const t = new ProcessTable({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      recorderFactory: async (pid) => Recorder.open({ pid, dir: join(tmp, String(unbrand(pid))) }),
    });
    tables.push(t);
    return t;
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
        recorderFactory: async (pid) => Recorder.open({ pid, dir: join(sub, String(unbrand(pid))) }),
      });
      tables.push(table);
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
    for (const t of tables) {
      for (const pid of t.pids()) {
        const rec = t.recorderFor(pid);
        if (rec !== null) await rec.close().catch(() => {});
      }
    }
    await rm(tmp, { recursive: true, force: true });
  }
}

// Local alias to keep the helper signatures above short.
type ProcessIdAlias = ReturnType<typeof asProcessId>;

await runSignalsChecks();

// =============================================================================
// Async checks (ipc)
// =============================================================================

async function runIpcChecks(): Promise<void> {
  const { mkdtemp, rm, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const tmp = await mkdtemp(join(tmpdir(), 'cortex-smoke-ipc-'));
  const tables: ProcessTable[] = [];

  let fakeNow = Date.UTC(2026, 0, 1, 0, 0, 0);
  const clock = () => new Date(fakeNow).toISOString();
  const tick = (ms = 1000) => {
    fakeNow += ms;
  };

  async function makeTable(): Promise<ProcessTable> {
    const t = new ProcessTable({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      recorderFactory: async (pid) => Recorder.open({ pid, dir: join(tmp, String(unbrand(pid))) }),
    });
    tables.push(t);
    return t;
  }

  const agent = { module: './agents/noop.js' } as const;

  /** Allocate a process and walk it to RUNNING. */
  async function spawnRunning(table: ProcessTable, role = 'worker'): Promise<ProcessIdAlias> {
    const pid = await table.allocate({ ppid: null, role, agent });
    await table.setState(pid, 'ready', { trigger: 'init' });
    tick();
    await table.setState(pid, 'running', { trigger: 'dispatch' });
    tick();
    return pid;
  }

  /**
   * Controllable timer so the timeout test does not depend on wall-clock.
   * `fireTimers()` runs every scheduled callback synchronously.
   */
  function makeFakeTimer(): {
    setTimeoutFn: typeof setTimeout;
    clearTimeoutFn: typeof clearTimeout;
    fireTimers: () => void;
    pending: () => number;
  } {
    type Entry = { id: number; fn: () => void; cleared: boolean };
    const entries: Entry[] = [];
    let nextId = 1;
    const setTimeoutFn = ((fn: () => void, _ms?: number): unknown => {
      const entry: Entry = { id: nextId++, fn, cleared: false };
      entries.push(entry);
      return entry as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;
    const clearTimeoutFn = ((handle: unknown): void => {
      const entry = handle as Entry;
      if (entry && typeof entry === 'object') entry.cleared = true;
    }) as typeof clearTimeout;
    const fireTimers = (): void => {
      for (const e of entries.splice(0)) {
        if (!e.cleared) e.fn();
      }
    };
    const pending = (): number => entries.filter((e) => !e.cleared).length;
    return { setTimeoutFn, clearTimeoutFn, fireTimers, pending };
  }

  /**
   * Poll a predicate until it holds, yielding to the event loop between
   * checks. Needed because `setState` mutates process state synchronously
   * but the recorder's file I/O — and the promise executor that registers
   * a waiter/timer — complete on later ticks. A single setImmediate is not
   * reliably enough.
   */
  async function waitFor(pred: () => boolean, label = 'condition', maxTicks = 200): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
      if (pred()) return;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error(`waitFor timed out: ${label}`);
  }

  try {
    await checkAsync('pidInboxChannel produces pid:<n> format', async () => {
      const id = pidInboxChannel(asProcessId(42));
      assert(unbrand(id) === 'pid:42', `expected pid:42, got ${unbrand(id)}`);
    });

    await checkAsync('isProcessTarget discriminates number vs string brands', async () => {
      assert(isProcessTarget(asProcessId(7)) === true, 'ProcessId should be a process target');
      assert(isProcessTarget(asChannelId('chan')) === false, 'ChannelId should not be a process target');
    });

    await checkAsync('resolveChannel routes ProcessId to inbox, ChannelId to itself', async () => {
      const pid = asProcessId(9);
      assert(unbrand(resolveChannel(pid)) === 'pid:9', 'ProcessId should resolve to inbox');
      const chan = asChannelId('named');
      assert(unbrand(resolveChannel(chan)) === 'named', 'ChannelId should resolve to itself');
    });

    await checkAsync('DEFAULT_QUEUE_LIMIT is unbounded (-1)', async () => {
      assert(DEFAULT_QUEUE_LIMIT === -1, `expected -1, got ${DEFAULT_QUEUE_LIMIT}`);
      assert(DEFAULT_RECV_TIMEOUT_MS === -1, `expected -1, got ${DEFAULT_RECV_TIMEOUT_MS}`);
    });

    await checkAsync('send implicitly creates the channel', async () => {
      const table = await makeTable();
      const a = await spawnRunning(table, 'a');
      const mgr = new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const chan = asChannelId('auto-created');
      assert(!mgr.hasChannel(chan), 'channel should not exist yet');
      await mgr.send(a, chan, { hello: 'world' });
      assert(mgr.hasChannel(chan), 'channel should exist after send');
      const info = mgr.getChannel(chan);
      assert(info !== undefined, 'getChannel should return info');
      assert(info!.queueDepth === 1, `queue depth should be 1, got ${info!.queueDepth}`);
      assert(info!.totalSent === 1, 'totalSent should be 1');
      assert(unbrand(info!.createdBy!) === unbrand(a), 'createdBy should be the sender');
    });

    await checkAsync('ensureChannel is idempotent', async () => {
      const table = await makeTable();
      const mgr = new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const chan = asChannelId('idem');
      const first = mgr.ensureChannel(chan);
      const second = mgr.ensureChannel(chan);
      assert(first.createdAt === second.createdAt, 'second ensure should not recreate');
      assert(mgr.listChannels().filter((c) => unbrand(c.id) === 'idem').length === 1, 'should be one channel');
    });

    await checkAsync('send to ProcessId routes to its inbox channel', async () => {
      const table = await makeTable();
      const a = await spawnRunning(table, 'a');
      const b = await spawnRunning(table, 'b');
      const mgr = new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      await mgr.send(a, b, { ping: true });
      const inbox = pidInboxChannel(b);
      assert(mgr.hasChannel(inbox), 'inbox channel should exist');
      const msg = await mgr.recv(b, inbox, { blocking: false });
      assert((msg.body as { ping: boolean }).ping === true, 'body mismatch');
      assert(unbrand(msg.from as ProcessIdAlias) === unbrand(a), 'from should be sender');
    });

    await checkAsync('send to absent process traps ESRCH', async () => {
      const table = await makeTable();
      const a = await spawnRunning(table, 'a');
      const mgr = new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      let caught: unknown;
      try {
        await mgr.send(a, asProcessId(9999), 'nope');
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught), 'should throw CortexError');
      assert(caught.errno === 'ESRCH', `expected ESRCH, got ${caught.errno}`);
    });

    await checkAsync('recv defaults to the process inbox', async () => {
      const table = await makeTable();
      const a = await spawnRunning(table, 'a');
      const b = await spawnRunning(table, 'b');
      const mgr = new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      await mgr.send(a, b, { toInbox: 1 });
      // recv with no source argument should read b's inbox.
      const msg = await mgr.recv(b, undefined, { blocking: false });
      assert((msg.body as { toInbox: number }).toInbox === 1, 'should read from inbox');
    });

    await checkAsync('blocking recv parks in BLOCKED, send wakes to READY', async () => {
      const table = await makeTable();
      const a = await spawnRunning(table, 'a');
      const b = await spawnRunning(table, 'b');
      const mgr = new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const chan = asChannelId('blocking-test');

      // Start a blocking recv but don't await it yet.
      const recvPromise = mgr.recv(b, chan);
      // Wait until the waiter is actually registered (recorder I/O and the
      // promise executor complete on later ticks).
      await waitFor(() => mgr.getChannel(chan)?.waiterCount === 1, 'waiter registered');
      assert(table.snapshot(b).state === 'blocked', `b should be blocked, got ${table.snapshot(b).state}`);
      const blockedOn = table.snapshot(b).blockedOn;
      assert(blockedOn !== null && blockedOn.kind === 'recv', 'blockedOn should be recv');

      // Now send — this should hand off directly and wake b.
      await mgr.send(a, chan, { woke: true });
      const msg = await recvPromise;
      assert((msg.body as { woke: boolean }).woke === true, 'message mismatch');
      assert(table.snapshot(b).state === 'ready', `b should be ready after wake, got ${table.snapshot(b).state}`);
    });

    await checkAsync('non-blocking recv on empty queue traps EAGAIN', async () => {
      const table = await makeTable();
      const b = await spawnRunning(table, 'b');
      const mgr = new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      let caught: unknown;
      try {
        await mgr.recv(b, asChannelId('empty'), { blocking: false });
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught), 'should throw CortexError');
      assert(caught.errno === 'EAGAIN', `expected EAGAIN, got ${caught.errno}`);
      assert(table.snapshot(b).state === 'running', 'state should be unchanged');
    });

    await checkAsync('recv timeout traps ETIMEDOUT', async () => {
      const table = await makeTable();
      const b = await spawnRunning(table, 'b');
      const timer = makeFakeTimer();
      const mgr = new IpcManager({
        table,
        kernelAbiVersion: KERNEL_ABI_VERSION,
        now: clock,
        setTimeoutFn: timer.setTimeoutFn,
        clearTimeoutFn: timer.clearTimeoutFn,
      });

      const recvPromise = mgr.recv(b, asChannelId('timeout-chan'), { timeoutMs: 500 });
      await waitFor(() => timer.pending() === 1, 'timer registered');
      assert(table.snapshot(b).state === 'blocked', 'should be blocked before timeout');
      assert(timer.pending() === 1, 'one timer should be pending');

      // Fire the timeout.
      timer.fireTimers();
      let caught: unknown;
      try {
        await recvPromise;
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught), 'should throw CortexError');
      assert(caught.errno === 'ETIMEDOUT', `expected ETIMEDOUT, got ${caught.errno}`);
      assert(table.snapshot(b).state === 'ready', 'should be pulled back to ready after timeout');
    });

    await checkAsync('recv from non-RUNNING state traps ESTATE', async () => {
      const table = await makeTable();
      const b = await spawnRunning(table, 'b');
      await table.setState(b, 'blocked');
      const mgr = new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      let caught: unknown;
      try {
        await mgr.recv(b, asChannelId('whatever'), { blocking: false });
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught), 'should throw CortexError');
      assert(caught.errno === 'ESTATE', `expected ESTATE, got ${caught.errno}`);
    });

    await checkAsync('FIFO ordering across multiple queued messages', async () => {
      const table = await makeTable();
      const a = await spawnRunning(table, 'a');
      const b = await spawnRunning(table, 'b');
      const mgr = new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const chan = asChannelId('fifo');
      await mgr.send(a, chan, 1);
      await mgr.send(a, chan, 2);
      await mgr.send(a, chan, 3);
      // Walk b to RUNNING for each recv (recv requires RUNNING).
      const got: unknown[] = [];
      for (let i = 0; i < 3; i++) {
        if (table.snapshot(b).state !== 'running') {
          await table.setState(b, 'running');
        }
        const m = await mgr.recv(b, chan, { blocking: false });
        got.push(m.body);
      }
      assert(got[0] === 1 && got[1] === 2 && got[2] === 3, `FIFO violated: ${JSON.stringify(got)}`);
    });

    await checkAsync('direct handoff leaves the queue empty', async () => {
      const table = await makeTable();
      const a = await spawnRunning(table, 'a');
      const b = await spawnRunning(table, 'b');
      const mgr = new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const chan = asChannelId('handoff');

      const recvPromise = mgr.recv(b, chan);
      await waitFor(() => mgr.getChannel(chan)?.waiterCount === 1, 'waiter registered');
      await mgr.send(a, chan, { direct: true });
      await recvPromise;

      const info = mgr.getChannel(chan)!;
      assert(info.queueDepth === 0, `queue should be empty after handoff, got ${info.queueDepth}`);
      assert(info.totalSent === 1 && info.totalRecv === 1, 'counters should both be 1');
    });

    await checkAsync('send rolls back the enqueue when recording fails (ERECORD)', async () => {
      // A throwaway recorder whose append fails on demand. `fail` stays false
      // during spawn (the __state records must land); we flip it only around
      // the send we want to fail.
      let fail = false;
      const fake = {
        append: async () => {
          if (fail) throw new Error('disk on fire');
        },
        flush: async () => {},
        close: async () => {},
        path: '',
      } as unknown as Recorder;
      const table = new ProcessTable({
        kernelAbiVersion: KERNEL_ABI_VERSION,
        now: clock,
        recorderFactory: async () => fake,
      });
      tables.push(table);
      const a = await spawnRunning(table, 'a');
      const mgr = new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const chan = asChannelId('rollback-enqueue');

      fail = true;
      let caught: unknown;
      try {
        await mgr.send(a, chan, 'nope');
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught), 'failed send should throw CortexError');
      assert(caught.errno === 'ERECORD', `expected ERECORD, got ${caught.errno}`);
      // The commit must be undone: no phantom message, counter restored.
      const info = mgr.getChannel(chan)!;
      assert(info.queueDepth === 0, `queue should roll back to empty, got ${info.queueDepth}`);
      assert(info.totalSent === 0, `totalSent should roll back to 0, got ${info.totalSent}`);

      // A later send with a healthy recorder commits normally.
      fail = false;
      await mgr.send(a, chan, 'ok');
      assert(mgr.getChannel(chan)!.queueDepth === 1, 'healthy send should enqueue');
      assert(mgr.getChannel(chan)!.totalSent === 1, 'totalSent should be 1 after healthy send');
    });

    await checkAsync('send rolls back a failed direct handoff, leaving the waiter parked', async () => {
      let fail = false;
      const fake = {
        append: async () => {
          if (fail) throw new Error('disk on fire');
        },
        flush: async () => {},
        close: async () => {},
        path: '',
      } as unknown as Recorder;
      const table = new ProcessTable({
        kernelAbiVersion: KERNEL_ABI_VERSION,
        now: clock,
        recorderFactory: async () => fake,
      });
      tables.push(table);
      const a = await spawnRunning(table, 'a');
      const b = await spawnRunning(table, 'b');
      const mgr = new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const chan = asChannelId('rollback-handoff');

      const recvPromise = mgr.recv(b, chan);
      await waitFor(() => mgr.getChannel(chan)?.waiterCount === 1, 'waiter registered');

      fail = true;
      let caught: unknown;
      try {
        await mgr.send(a, chan, 'lost');
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught) && caught.errno === 'ERECORD', 'handoff send should ERECORD');
      // The waiter must be restored to the parked set and counters unchanged;
      // the receiver must still be blocked (recv did not resolve).
      assert(mgr.getChannel(chan)!.waiterCount === 1, 'waiter should be restored to the parked set');
      assert(
        mgr.getChannel(chan)!.totalSent === 0 && mgr.getChannel(chan)!.totalRecv === 0,
        'counters should stay 0 after a failed handoff',
      );
      assert(table.snapshot(b).state === 'blocked', 'receiver should still be blocked');

      // With a healthy recorder, that very same parked waiter is served next.
      fail = false;
      await mgr.send(a, chan, 'served');
      const got = await recvPromise;
      assert(got.body === 'served', `parked waiter should get the second message, got ${JSON.stringify(got.body)}`);
      assert(mgr.getChannel(chan)!.waiterCount === 0, 'waiter consumed after successful handoff');
      assert(
        mgr.getChannel(chan)!.totalSent === 1 && mgr.getChannel(chan)!.totalRecv === 1,
        'counters should be 1 after the successful handoff',
      );
    });

    await checkAsync('closeChannel rejects parked waiters with EBADF', async () => {
      const table = await makeTable();
      const b = await spawnRunning(table, 'b');
      const mgr = new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const chan = asChannelId('close-me');

      const recvPromise = mgr.recv(b, chan);
      await waitFor(() => mgr.getChannel(chan)?.waiterCount === 1, 'waiter registered');
      assert(table.snapshot(b).state === 'blocked', 'precondition: blocked');

      mgr.closeChannel(chan);
      let caught: unknown;
      try {
        await recvPromise;
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught), 'should throw CortexError');
      assert(caught.errno === 'EBADF', `expected EBADF, got ${caught.errno}`);
      assert(mgr.getChannel(chan)!.closed === true, 'channel should be marked closed');
    });

    await checkAsync('closeChannel drops queued messages', async () => {
      const table = await makeTable();
      const a = await spawnRunning(table, 'a');
      const mgr = new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const chan = asChannelId('drop-me');
      await mgr.send(a, chan, 'msg1');
      await mgr.send(a, chan, 'msg2');
      assert(mgr.getChannel(chan)!.queueDepth === 2, 'precondition: 2 queued');
      mgr.closeChannel(chan);
      assert(mgr.getChannel(chan)!.queueDepth === 0, 'queue should be dropped on close');
    });

    await checkAsync('send to closed channel traps EBADF and raises SIGPIPE', async () => {
      const table = await makeTable();
      const a = await spawnRunning(table, 'a');

      // Track SIGPIPE delivery via a handler disposition. The SignalManager
      // needs an invoker to actually run handlers.
      let sigpipeFired = false;
      table.setDisposition(a, 'SIGPIPE', {
        kind: 'handler',
        handler: () => {
          sigpipeFired = true;
        },
      });
      const signals = new SignalManager({
        table,
        kernelAbiVersion: KERNEL_ABI_VERSION,
        now: clock,
        handlerInvoker: async (_p, _s, h) => {
          await h({} as never);
        },
      });
      // A single IpcManager owns the channel map end-to-end.
      const mgr = new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock, signals });
      const chan = asChannelId('closed-chan');
      mgr.ensureChannel(chan);
      mgr.closeChannel(chan);

      let caught: unknown;
      try {
        await mgr.send(a, chan, 'too late');
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught), 'should throw CortexError');
      assert(caught.errno === 'EBADF', `expected EBADF, got ${caught.errno}`);
      assert(sigpipeFired, 'SIGPIPE handler should have fired');
    });

    await checkAsync('recv from closed channel traps EBADF', async () => {
      const table = await makeTable();
      const b = await spawnRunning(table, 'b');
      const mgr = new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const chan = asChannelId('closed-recv');
      mgr.ensureChannel(chan);
      mgr.closeChannel(chan);
      let caught: unknown;
      try {
        await mgr.recv(b, chan, { blocking: false });
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught), 'should throw CortexError');
      assert(caught.errno === 'EBADF', `expected EBADF, got ${caught.errno}`);
    });

    await checkAsync('cancelWaitersFor rejects with EINTR and returns count', async () => {
      const table = await makeTable();
      const b = await spawnRunning(table, 'b');
      const mgr = new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const c1 = asChannelId('cancel-1');
      const c2 = asChannelId('cancel-2');

      const p1 = mgr.recv(b, c1);
      await waitFor(() => mgr.getChannel(c1)?.waiterCount === 1, 'waiter registered');
      // b is blocked on c1; to also block on c2 we'd need a second process.
      // Cancel the one waiter we have.
      const cancelled = mgr.cancelWaitersFor(b, 'test-cancel');
      assert(cancelled === 1, `expected 1 cancelled, got ${cancelled}`);
      let caught: unknown;
      try {
        await p1;
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught), 'should throw CortexError');
      assert(caught.errno === 'EINTR', `expected EINTR, got ${caught.errno}`);
      // Cancelling again is a no-op.
      assert(mgr.cancelWaitersFor(b) === 0, 'second cancel should find nothing');
      void c2;
    });

    await checkAsync('queueLimit overflow traps EAGAIN', async () => {
      const table = await makeTable();
      const a = await spawnRunning(table, 'a');
      const mgr = new IpcManager({
        table,
        kernelAbiVersion: KERNEL_ABI_VERSION,
        now: clock,
        defaultQueueLimit: 2,
      });
      const chan = asChannelId('limited');
      await mgr.send(a, chan, 'one');
      await mgr.send(a, chan, 'two');
      let caught: unknown;
      try {
        await mgr.send(a, chan, 'three');
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught), 'should throw CortexError');
      assert(caught.errno === 'EAGAIN', `expected EAGAIN, got ${caught.errno}`);
      assert(mgr.getChannel(chan)!.queueDepth === 2, 'queue should stay at limit');
    });

    await checkAsync('channelsOf tracks membership for senders and receivers', async () => {
      const table = await makeTable();
      const a = await spawnRunning(table, 'a');
      const b = await spawnRunning(table, 'b');
      const mgr = new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const chan = asChannelId('membership');
      await mgr.send(a, chan, 'hi');
      await mgr.recv(b, chan, { blocking: false });
      assert(mgr.channelsOf(a).some((c) => unbrand(c) === 'membership'), 'sender should be a member');
      assert(mgr.channelsOf(b).some((c) => unbrand(c) === 'membership'), 'receiver should be a member');
      assert(mgr.channelsOf(asProcessId(9999)).length === 0, 'unknown pid should have no channels');
    });

    await checkAsync('send/recv records land in .crec with correct reversibility', async () => {
      const sub = join(tmp, 'ipc-records');
      await mkdir(sub, { recursive: true });
      const table = new ProcessTable({
        kernelAbiVersion: KERNEL_ABI_VERSION,
        now: clock,
        recorderFactory: async (pid) => Recorder.open({ pid, dir: join(sub, String(unbrand(pid))) }),
      });
      tables.push(table);
      const a = await spawnRunning(table, 'a');
      const b = await spawnRunning(table, 'b');
      const mgr = new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const chan = asChannelId('recorded');

      await mgr.send(a, chan, { recorded: true });
      // Walk b to RUNNING (it already is) and recv.
      const msg = await mgr.recv(b, chan, { blocking: false });
      assert((msg.body as { recorded: boolean }).recorded === true, 'body mismatch');

      const recA = table.recorderFor(a)!;
      const recB = table.recorderFor(b)!;
      await recA.flush();
      await recB.flush();

      const sendRecords: SyscallRecord[] = [];
      for await (const r of readRecords(recA.path)) {
        if (r.syscall === 'send') sendRecords.push(r);
      }
      assert(sendRecords.length === 1, `expected 1 send record, got ${sendRecords.length}`);
      assert(sendRecords[0]!.reversibility === 'idempotent', 'send should be idempotent');
      assert(sendRecords[0]!.phase === 'exit', 'send record should be exit phase');

      const recvRecords: SyscallRecord[] = [];
      for await (const r of readRecords(recB.path)) {
        if (r.syscall === 'recv') recvRecords.push(r);
      }
      assert(recvRecords.length === 1, `expected 1 recv record, got ${recvRecords.length}`);
      assert(recvRecords[0]!.reversibility === 'irreversible', 'recv should be irreversible');
      const result = recvRecords[0]!.result as { body: { recorded: boolean } };
      assert(result.body.recorded === true, 'recv record should capture the message body');
    });

    await checkAsync('trap records land in .crec on EAGAIN', async () => {
      const sub = join(tmp, 'ipc-traps');
      await mkdir(sub, { recursive: true });
      const table = new ProcessTable({
        kernelAbiVersion: KERNEL_ABI_VERSION,
        now: clock,
        recorderFactory: async (pid) => Recorder.open({ pid, dir: join(sub, String(unbrand(pid))) }),
      });
      tables.push(table);
      const b = await spawnRunning(table, 'b');
      const mgr = new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      try {
        await mgr.recv(b, asChannelId('trap-chan'), { blocking: false });
      } catch {
        /* expected */
      }
      const recB = table.recorderFor(b)!;
      await recB.flush();
      const traps: SyscallRecord[] = [];
      for await (const r of readRecords(recB.path)) {
        if (r.syscall === 'recv' && r.phase === 'trap') traps.push(r);
      }
      assert(traps.length === 1, `expected 1 trap record, got ${traps.length}`);
      assert(traps[0]!.error?.errno === 'EAGAIN', `trap errno should be EAGAIN, got ${traps[0]!.error?.errno}`);
    });
  } finally {
    for (const t of tables) {
      for (const pid of t.pids()) {
        const rec = t.recorderFor(pid);
        if (rec !== null) await rec.close().catch(() => {});
      }
    }
    await rm(tmp, { recursive: true, force: true });
  }
}

await runIpcChecks();

// =============================================================================
// Async checks (memory)
// =============================================================================

/**
 * Minimal in-memory `IMemoryDriver` for the smoke checks. Stores
 * physical-region → key → {value, at}. snapshot/restore JSON-round-trip the
 * region so COW and fork deep-copies exercise the real code path.
 */
class FakeMemoryDriver implements IMemoryDriver {
  readonly name = 'inmem';
  readonly version = '0.0.0';
  readonly abiCompat: string;

  #store = new Map<string, Map<string, { value: unknown; at: string }>>();
  #now: () => string;
  snapshotCalls: string[] = [];
  restoreCalls: string[] = [];
  failRead = false;
  failWrite = false;

  constructor(now: () => string, abiCompat: string) {
    this.#now = now;
    this.abiCompat = abiCompat;
  }

  async read(region: string, query: MemoryQuery): Promise<readonly MemoryEntry[]> {
    if (this.failRead) throw new Error('driver read boom');
    const m = this.#store.get(region);
    if (m === undefined) return [];
    let entries: MemoryEntry[] = [...m.entries()].map(([key, v]) => ({
      region,
      key,
      value: v.value,
      at: v.at,
    }));
    if (query.key !== undefined) entries = entries.filter((e) => e.key === query.key);
    if (query.prefix !== undefined) {
      const p = query.prefix;
      entries = entries.filter((e) => e.key.startsWith(p));
    }
    if (query.limit !== undefined) entries = entries.slice(0, query.limit);
    return entries;
  }

  async write(region: string, key: string, value: unknown): Promise<void> {
    if (this.failWrite) throw new Error('driver write boom');
    let m = this.#store.get(region);
    if (m === undefined) {
      m = new Map<string, { value: unknown; at: string }>();
      this.#store.set(region, m);
    }
    m.set(key, { value, at: this.#now() });
  }

  async delete(region: string, key: string): Promise<void> {
    this.#store.get(region)?.delete(key);
  }

  async listRegions(): Promise<readonly string[]> {
    return [...this.#store.keys()];
  }

  async snapshotRegion(region: string): Promise<Uint8Array> {
    this.snapshotCalls.push(region);
    const m = this.#store.get(region) ?? new Map<string, { value: unknown; at: string }>();
    const obj = Object.fromEntries([...m.entries()]);
    return new TextEncoder().encode(JSON.stringify(obj));
  }

  async restoreRegion(region: string, blob: Uint8Array): Promise<void> {
    this.restoreCalls.push(region);
    const obj = JSON.parse(new TextDecoder().decode(blob)) as Record<
      string,
      { value: unknown; at: string }
    >;
    const m = new Map<string, { value: unknown; at: string }>();
    for (const [k, v] of Object.entries(obj)) m.set(k, v);
    this.#store.set(region, m);
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}

async function runMemoryChecks(): Promise<void> {
  const { mkdtemp, rm, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const tmp = await mkdtemp(join(tmpdir(), 'cortex-smoke-mem-'));
  const tables: ProcessTable[] = [];

  let fakeNow = Date.UTC(2026, 0, 1, 0, 0, 0);
  const clock = () => new Date(fakeNow).toISOString();
  const tick = (ms = 1000) => {
    fakeNow += ms;
  };

  async function makeTable(): Promise<ProcessTable> {
    const t = new ProcessTable({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      recorderFactory: async (pid) => Recorder.open({ pid, dir: join(tmp, String(unbrand(pid))) }),
    });
    tables.push(t);
    return t;
  }

  const agent = { module: './agents/noop.js' } as const;

  async function spawnRunning(table: ProcessTable, role = 'worker'): Promise<ProcessIdAlias> {
    const pid = await table.allocate({ ppid: null, role, agent });
    await table.setState(pid, 'ready', { trigger: 'init' });
    tick();
    await table.setState(pid, 'running', { trigger: 'dispatch' });
    tick();
    return pid;
  }

  function makeManager(table: ProcessTable, opts?: Partial<ConstructorParameters<typeof MemoryManager>[0]>): MemoryManager {
    const driver = new FakeMemoryDriver(clock, KERNEL_ABI_VERSION);
    const mgr = new MemoryManager({
      table,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      drivers: { inmem: driver },
      ...opts,
    });
    return mgr;
  }

  const cow: MemoryRegionPolicy = { kind: 'cow', backing: 'inmem' };
  const priv: MemoryRegionPolicy = { kind: 'private', backing: 'inmem' };
  const shared: MemoryRegionPolicy = { kind: 'shared', backing: 'inmem' };

  // --- pure helpers ---------------------------------------------------------

  check('sharedPhysicalKey is deterministic', () => {
    assert(
      sharedPhysicalKey('inmem', 'semantic') === sharedPhysicalKey('inmem', 'semantic'),
      'same inputs should yield the same key',
    );
    assert(
      sharedPhysicalKey('inmem', 'a') !== sharedPhysicalKey('inmem', 'b'),
      'different regions should differ',
    );
    assert(sharedPhysicalKey('inmem', 'a').startsWith('sh:'), 'shared keys use the sh: prefix');
  });

  check('serializeValue / hashValue / valueByteSize behave', () => {
    assert(serializeValue({ a: 1 }) === '{"a":1}', 'serializes objects');
    assert(hashValue('x') === hashValue('x'), 'hash is stable');
    assert(hashValue('x') !== hashValue('y'), 'distinct values hash distinctly');
    assert(valueByteSize('abc') === 5, 'byte size counts the JSON serialization (quotes included)');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert(typeof serializeValue(circular) === 'string', 'circular falls back without throwing');
  });

  check('memory defaults are unbounded / 1024 bytes', () => {
    assert(DEFAULT_MAX_REGION_ENTRIES === -1, 'default region limit is unbounded');
    assert(DEFAULT_LARGE_VALUE_BYTES === 1024, 'default large-value threshold is 1024');
  });

  // --- attach / read / write ------------------------------------------------

  await checkAsync('attachRegion derives physical key from kind', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const mgr = makeManager(table);
    const sh = mgr.attachRegion(pid, 'semantic', shared);
    const pr = mgr.attachRegion(pid, 'procedural', priv);
    assert(sh.bindingKey === sharedPhysicalKey('inmem', 'semantic'), 'shared uses deterministic key');
    assert(pr.bindingKey.startsWith('pr:inmem:'), 'private uses a unique owned key');
    assert(sh.refCount === 1 && pr.refCount === 1, 'fresh bindings have refCount 1');
  });

  await checkAsync('write then read round-trips', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const mgr = makeManager(table);
    mgr.attachRegion(pid, 'episodic', priv);
    await mgr.write(pid, 'episodic', 'e1', { hello: 'world' });
    const entries = await mgr.read(pid, 'episodic', {});
    assert(entries.length === 1, `expected 1 entry, got ${entries.length}`);
    assert(entries[0]!.key === 'e1', 'key mismatch');
    assert((entries[0]!.value as { hello: string }).hello === 'world', 'value mismatch');
  });

  await checkAsync('read remaps entry.region to the logical name', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const mgr = makeManager(table);
    mgr.attachRegion(pid, 'episodic', priv);
    await mgr.write(pid, 'episodic', 'e1', 1);
    const entries = await mgr.read(pid, 'episodic', {});
    assert(entries[0]!.region === 'episodic', 'agent should never see the physical key');
  });

  await checkAsync('query key / prefix / limit are honored', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const mgr = makeManager(table);
    mgr.attachRegion(pid, 'kv', priv);
    await mgr.write(pid, 'kv', 'user:1', 'a');
    await mgr.write(pid, 'kv', 'user:2', 'b');
    await mgr.write(pid, 'kv', 'post:1', 'c');
    const byKey = await mgr.read(pid, 'kv', { key: 'user:1' });
    assert(byKey.length === 1 && byKey[0]!.value === 'a', 'key lookup');
    const byPrefix = await mgr.read(pid, 'kv', { prefix: 'user:' });
    assert(byPrefix.length === 2, `prefix scan expected 2, got ${byPrefix.length}`);
    const limited = await mgr.read(pid, 'kv', { limit: 1 });
    assert(limited.length === 1, 'limit caps results');
  });

  // --- error paths ----------------------------------------------------------

  await checkAsync('read/write on missing region traps ENOENT', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const mgr = makeManager(table);
    let rErr: unknown;
    try {
      await mgr.read(pid, 'nope', {});
    } catch (e) {
      rErr = e;
    }
    assert(isCortexError(rErr) && rErr.errno === 'ENOENT', 'read should trap ENOENT');
    let wErr: unknown;
    try {
      await mgr.write(pid, 'nope', 'k', 1);
    } catch (e) {
      wErr = e;
    }
    assert(isCortexError(wErr) && wErr.errno === 'ENOENT', 'write should trap ENOENT');
  });

  await checkAsync('write to readOnly region traps EPERM', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const mgr = makeManager(table);
    mgr.attachRegion(pid, 'ro', { kind: 'private', backing: 'inmem', readOnly: true });
    let err: unknown;
    try {
      await mgr.write(pid, 'ro', 'k', 1);
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'EPERM', 'readOnly write should trap EPERM');
    // Reads still work.
    const entries = await mgr.read(pid, 'ro', {});
    assert(entries.length === 0, 'read on empty readOnly region is fine');
  });

  await checkAsync('missing driver traps EDRIVER', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const mgr = new MemoryManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
    mgr.attachRegion(pid, 'episodic', { kind: 'private', backing: 'ghost' });
    let err: unknown;
    try {
      await mgr.read(pid, 'episodic', {});
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'EDRIVER', 'absent driver should trap EDRIVER');
  });

  await checkAsync('driver throw is wrapped as EDRIVER', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const driver = new FakeMemoryDriver(clock, KERNEL_ABI_VERSION);
    const mgr = new MemoryManager({
      table,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      drivers: { inmem: driver },
    });
    mgr.attachRegion(pid, 'episodic', priv);
    driver.failWrite = true;
    let err: unknown;
    try {
      await mgr.write(pid, 'episodic', 'k', 1);
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'EDRIVER', 'driver failure should wrap to EDRIVER');
  });

  await checkAsync('entry-count ceiling traps ENOMEM', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const mgr = makeManager(table, { maxRegionEntries: 1 });
    mgr.attachRegion(pid, 'small', priv);
    await mgr.write(pid, 'small', 'k1', 1); // ok, count → 1
    let err: unknown;
    try {
      await mgr.write(pid, 'small', 'k2', 2); // exceeds limit
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'ENOMEM', 'over-limit write should trap ENOMEM');
  });

  await checkAsync('ENOMEM is checked before cow divergence: a rejected write leaves the share intact', async () => {
    const table = await makeTable();
    const parent = await spawnRunning(table, 'parent');
    const driver = new FakeMemoryDriver(clock, KERNEL_ABI_VERSION);
    const mgr = new MemoryManager({
      table,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      drivers: { inmem: driver },
      maxRegionEntries: 1,
    });
    mgr.attachRegion(parent, 'memory', cow);
    await mgr.write(parent, 'memory', 'seed', 'v'); // fills the single allowed entry

    const child = await table.allocate({ ppid: parent, role: 'child', agent });
    await mgr.forkCopy(parent, child); // cow share: refCount 2, no eager copy
    assert(mgr.regionInfo(parent, 'memory')!.refCount === 2, 'precondition: shared, refCount 2');

    const snapshotsBefore = driver.snapshotCalls.length;
    let err: unknown;
    try {
      await mgr.write(child, 'memory', 'overflow', 'x'); // over the limit → ENOMEM
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'ENOMEM', 'over-limit write should trap ENOMEM');
    // The rejection must not have paid for — or left behind — a COW split.
    assert(
      driver.snapshotCalls.length === snapshotsBefore,
      'a write that will ENOMEM must not trigger a cow region copy',
    );
    assert(
      mgr.regionInfo(child, 'memory')!.bindingKey === mgr.regionInfo(parent, 'memory')!.bindingKey,
      'child must remain bound to the shared physical key after the rejected write',
    );
    assert(
      mgr.regionInfo(parent, 'memory')!.refCount === 2,
      'the parent/child share must survive the rejection',
    );
  });

  // --- per-region maxEntries -----------------------------------------------

  await checkAsync('per-region maxEntries imposes its own cap under an unlimited global', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const mgr = makeManager(table); // global unlimited (default -1)
    mgr.attachRegion(pid, 'bounded', { kind: 'private', backing: 'inmem', maxEntries: 2 });
    await mgr.write(pid, 'bounded', 'k1', 1);
    await mgr.write(pid, 'bounded', 'k2', 2);
    let err: unknown;
    try {
      await mgr.write(pid, 'bounded', 'k3', 3); // exceeds per-region cap 2
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'ENOMEM', 'per-region cap should trap ENOMEM');
    if (isCortexError(err)) {
      assert((err.details as { scope?: string }).scope === 'region', 'ENOMEM should report region scope');
    }
  });

  await checkAsync('per-region maxEntries tightens a lower-than-global ceiling', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const mgr = makeManager(table, { maxRegionEntries: 5 }); // global 5
    mgr.attachRegion(pid, 'tight', { kind: 'private', backing: 'inmem', maxEntries: 1 });
    await mgr.write(pid, 'tight', 'k1', 1);
    let err: unknown;
    try {
      await mgr.write(pid, 'tight', 'k2', 2); // per-region cap 1 wins over global 5
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'ENOMEM', 'per-region cap 1 should override global 5');
  });

  await checkAsync('per-region maxEntries:-1 opts a region out of a lower global cap', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const mgr = makeManager(table, { maxRegionEntries: 2 }); // global 2
    mgr.attachRegion(pid, 'free', { kind: 'private', backing: 'inmem', maxEntries: -1 });
    mgr.attachRegion(pid, 'capped', { kind: 'private', backing: 'inmem' }); // inherits global 2
    // 'free' is unbounded — write far past the global cap without error.
    for (let i = 0; i < 10; i++) await mgr.write(pid, 'free', `k${i}`, i);
    // 'capped' still obeys the global 2.
    await mgr.write(pid, 'capped', 'a', 1);
    await mgr.write(pid, 'capped', 'b', 2);
    let err: unknown;
    try {
      await mgr.write(pid, 'capped', 'c', 3);
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'ENOMEM', 'sibling region should still hit global cap 2');
    if (isCortexError(err)) {
      assert((err.details as { scope?: string }).scope === 'global', 'global-cap ENOMEM reports global scope');
    }
  });

  await checkAsync('effectiveMaxEntries reflects region value then global default', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const mgr = makeManager(table, { maxRegionEntries: 8 });
    mgr.attachRegion(pid, 'own', { kind: 'private', backing: 'inmem', maxEntries: 3 });
    mgr.attachRegion(pid, 'inherited', { kind: 'private', backing: 'inmem' });
    mgr.attachRegion(pid, 'unlimited', { kind: 'private', backing: 'inmem', maxEntries: -1 });
    assert(mgr.regionInfo(pid, 'own')!.effectiveMaxEntries === 3, 'region cap wins');
    assert(mgr.regionInfo(pid, 'inherited')!.effectiveMaxEntries === 8, 'falls back to global');
    assert(mgr.regionInfo(pid, 'unlimited')!.effectiveMaxEntries === -1, 'explicit -1 opt-out');
  });

  await checkAsync('per-region ENOMEM is checked before cow divergence', async () => {
    const table = await makeTable();
    const parent = await spawnRunning(table, 'parent');
    const driver = new FakeMemoryDriver(clock, KERNEL_ABI_VERSION);
    const mgr = new MemoryManager({
      table,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      drivers: { inmem: driver },
      // global unlimited; the per-region cap is what must bite.
    });
    mgr.attachRegion(parent, 'memory', { kind: 'cow', backing: 'inmem', maxEntries: 1 });
    await mgr.write(parent, 'memory', 'seed', 'v');

    const child = await table.allocate({ ppid: parent, role: 'child', agent });
    await mgr.forkCopy(parent, child);
    assert(mgr.regionInfo(parent, 'memory')!.refCount === 2, 'precondition: cow share refCount 2');

    const snapshotsBefore = driver.snapshotCalls.length;
    let err: unknown;
    try {
      await mgr.write(child, 'memory', 'overflow', 'x'); // exceeds per-region cap 1
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'ENOMEM', 'per-region cap should trap ENOMEM');
    assert(
      driver.snapshotCalls.length === snapshotsBefore,
      'a per-region ENOMEM must not trigger a cow copy',
    );
    assert(
      mgr.regionInfo(child, 'memory')!.bindingKey === mgr.regionInfo(parent, 'memory')!.bindingKey,
      'child stays bound to the shared physical key after rejection',
    );
  });

  // --- shared semantics -----------------------------------------------------

  await checkAsync('shared region: write by one process is visible to another', async () => {
    const table = await makeTable();
    const a = await spawnRunning(table, 'a');
    const b = await spawnRunning(table, 'b');
    const driver = new FakeMemoryDriver(clock, KERNEL_ABI_VERSION);
    const mgr = new MemoryManager({
      table,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      drivers: { inmem: driver },
    });
    mgr.attachRegion(a, 'semantic', shared);
    mgr.attachRegion(b, 'semantic', shared);
    assert(
      mgr.regionInfo(a, 'semantic')!.bindingKey === mgr.regionInfo(b, 'semantic')!.bindingKey,
      'shared bindings converge on one physical key',
    );
    assert(mgr.regionInfo(a, 'semantic')!.refCount === 2, 'refCount should be 2');
    await mgr.write(a, 'semantic', 'fact', 'sky is blue');
    const fromB = await mgr.read(b, 'semantic', { key: 'fact' });
    assert(fromB.length === 1 && fromB[0]!.value === 'sky is blue', 'B should see A\'s write');
  });

  // --- private fork ---------------------------------------------------------

  await checkAsync('private fork deep-copies and diverges', async () => {
    const table = await makeTable();
    const parent = await spawnRunning(table, 'parent');
    const mgr = makeManager(table);
    mgr.attachRegion(parent, 'procedural', priv);
    await mgr.write(parent, 'procedural', 'skill', 'ride bike');

    const child = await table.allocate({ ppid: parent, role: 'child', agent });
    await mgr.forkCopy(parent, child);

    assert(
      mgr.regionInfo(parent, 'procedural')!.bindingKey !==
        mgr.regionInfo(child, 'procedural')!.bindingKey,
      'private fork should give the child its own physical key',
    );
    const inherited = await mgr.read(child, 'procedural', { key: 'skill' });
    assert(inherited.length === 1 && inherited[0]!.value === 'ride bike', 'child inherits a deep copy');

    await mgr.write(child, 'procedural', 'skill2', 'swim');
    const parentView = await mgr.read(parent, 'procedural', { key: 'skill2' });
    assert(parentView.length === 0, 'parent must NOT see the child\'s post-fork write');
    await mgr.write(parent, 'procedural', 'skill3', 'fly');
    const childView = await mgr.read(child, 'procedural', { key: 'skill3' });
    assert(childView.length === 0, 'child must NOT see the parent\'s post-fork write');
  });

  // --- cow fork -------------------------------------------------------------

  await checkAsync('cow fork shares until first write, then diverges', async () => {
    const table = await makeTable();
    const parent = await spawnRunning(table, 'parent');
    const driver = new FakeMemoryDriver(clock, KERNEL_ABI_VERSION);
    const mgr = new MemoryManager({
      table,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      drivers: { inmem: driver },
    });
    mgr.attachRegion(parent, 'episodic', cow);
    await mgr.write(parent, 'episodic', 'base', 'shared past');

    const child = await table.allocate({ ppid: parent, role: 'child', agent });
    const snapshotsBefore = driver.snapshotCalls.length;
    await mgr.forkCopy(parent, child);
    assert(
      driver.snapshotCalls.length === snapshotsBefore,
      'cow fork should NOT copy eagerly',
    );
    assert(
      mgr.regionInfo(parent, 'episodic')!.bindingKey ===
        mgr.regionInfo(child, 'episodic')!.bindingKey,
      'child shares the parent physical key pre-write',
    );
    assert(mgr.regionInfo(parent, 'episodic')!.refCount === 2, 'refCount 2 while shared');

    // Child reads see the shared data.
    const childRead = await mgr.read(child, 'episodic', { key: 'base' });
    assert(childRead.length === 1 && childRead[0]!.value === 'shared past', 'child reads shared region');

    // Child's first write triggers duplication.
    await mgr.write(child, 'episodic', 'branch', 'child only');
    assert(
      mgr.regionInfo(parent, 'episodic')!.bindingKey !==
        mgr.regionInfo(child, 'episodic')!.bindingKey,
      'child should diverge to a fresh physical key after writing',
    );
    assert(mgr.regionInfo(parent, 'episodic')!.refCount === 1, 'parent refCount back to 1');
    assert(mgr.regionInfo(child, 'episodic')!.refCount === 1, 'child refCount is 1');

    const parentView = await mgr.read(parent, 'episodic', { key: 'branch' });
    assert(parentView.length === 0, 'parent must NOT see the child branch write');
    const childBoth = await mgr.read(child, 'episodic', {});
    assert(childBoth.length === 2, 'child keeps base + its own branch write');
  });

  await checkAsync('cow divergence is symmetric (parent writes first)', async () => {
    const table = await makeTable();
    const parent = await spawnRunning(table, 'parent');
    const mgr = makeManager(table);
    mgr.attachRegion(parent, 'episodic', cow);
    await mgr.write(parent, 'episodic', 'base', 'common');
    const child = await table.allocate({ ppid: parent, role: 'child', agent });
    await mgr.forkCopy(parent, child);

    // Parent writes first this time.
    await mgr.write(parent, 'episodic', 'ponly', 'parent branch');
    const childView = await mgr.read(child, 'episodic', { key: 'ponly' });
    assert(childView.length === 0, 'child must NOT see the parent\'s divergent write');
    const childBase = await mgr.read(child, 'episodic', { key: 'base' });
    assert(childBase.length === 1 && childBase[0]!.value === 'common', 'child still has the shared past');
  });

  await checkAsync('forkCopy override changes copy semantics', async () => {
    const table = await makeTable();
    const parent = await spawnRunning(table, 'parent');
    const mgr = makeManager(table);
    mgr.attachRegion(parent, 'data', priv);
    await mgr.write(parent, 'data', 'k', 'v');
    const child = await table.allocate({ ppid: parent, role: 'child', agent });
    await mgr.forkCopy(parent, child, { data: shared });
    const info = mgr.regionInfo(child, 'data')!;
    assert(info.kind === 'shared', 'override should change the child kind');
    assert(info.bindingKey === sharedPhysicalKey('inmem', 'data'), 'override to shared uses the deterministic key');
    const seeded = await mgr.read(child, 'data', { key: 'k' });
    assert(seeded.length === 1 && seeded[0]!.value === 'v', 'shared region seeded from parent content');
  });

  // --- snapshot / restore ---------------------------------------------------

  await checkAsync('snapshot + restore moves state across processes', async () => {
    const table = await makeTable();
    const src = await spawnRunning(table, 'src');
    const mgr = makeManager(table);
    mgr.attachRegion(src, 'episodic', priv);
    await mgr.write(src, 'episodic', 'memory', 'remember me');

    const blobs = await mgr.snapshot(src);
    assert(blobs.episodic !== undefined, 'snapshot should include the logical region');

    const dst = await table.allocate({ ppid: null, role: 'dst', agent });
    mgr.attachRegion(dst, 'episodic', priv);
    await mgr.restore(dst, blobs);
    const restored = await mgr.read(dst, 'episodic', { key: 'memory' });
    assert(restored.length === 1 && restored[0]!.value === 'remember me', 'restore should reload the value');
  });

  // --- detach / sync --------------------------------------------------------

  await checkAsync('detachRegion releases the binding', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const mgr = makeManager(table);
    mgr.attachRegion(pid, 'tmp', priv);
    assert(mgr.hasRegion(pid, 'tmp'), 'region attached');
    mgr.detachRegion(pid, 'tmp');
    assert(!mgr.hasRegion(pid, 'tmp'), 'region detached');
    assert(mgr.regionsOf(pid).length === 0, 'no regions left');
    mgr.detachRegion(pid, 'tmp'); // idempotent
  });

  await checkAsync('syncFromTable attaches declared regions', async () => {
    const table = await makeTable();
    const pid = await table.allocate({
      ppid: null,
      role: 'worker',
      agent,
      memory: { episodic: cow, semantic: shared },
    });
    const mgr = makeManager(table);
    assert(!mgr.hasRegion(pid, 'episodic'), 'not bound before sync');
    mgr.syncFromTable(pid);
    assert(mgr.hasRegion(pid, 'episodic') && mgr.hasRegion(pid, 'semantic'), 'both regions bound after sync');
    assert(mgr.regionInfo(pid, 'episodic')!.kind === 'cow', 'policy preserved');
  });

  // --- recording ------------------------------------------------------------

  await checkAsync('memory_read / memory_write records land in .crec', async () => {
    const sub = join(tmp, 'mem-records');
    await mkdir(sub, { recursive: true });
    const table = new ProcessTable({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      recorderFactory: async (pid) => Recorder.open({ pid, dir: join(sub, String(unbrand(pid))) }),
    });
    tables.push(table);
    const pid = await spawnRunning(table);
    const mgr = makeManager(table);
    mgr.attachRegion(pid, 'episodic', priv);
    await mgr.write(pid, 'episodic', 'k', { small: true });
    await mgr.read(pid, 'episodic', { key: 'k' });

    const rec = table.recorderFor(pid)!;
    await rec.flush();
    const records: SyscallRecord[] = [];
    for await (const r of readRecords(rec.path)) records.push(r);

    const writes = records.filter((r) => r.syscall === 'memory_write');
    const reads = records.filter((r) => r.syscall === 'memory_read');
    assert(writes.length === 1, `expected 1 write record, got ${writes.length}`);
    assert(reads.length === 1, `expected 1 read record, got ${reads.length}`);

    assert(writes[0]!.reversibility === 'reversible', 'memory_write is reversible');
    assert(writes[0]!.phase === 'exit', 'write record is exit phase');
    const wArgs = writes[0]!.args as { region: string; key: string; policyKind: string; value: unknown };
    assert(wArgs.region === 'episodic' && wArgs.key === 'k', 'write args capture region+key');
    assert(wArgs.policyKind === 'private', 'write args capture policy kind');
    assert((wArgs.value as { small: boolean }).small === true, 'small value recorded inline');

    assert(reads[0]!.reversibility === 'idempotent', 'memory_read is idempotent');
    const rResult = reads[0]!.result as { count: number; valuesHash: string };
    assert(rResult.count === 1, 'read result captures count');
    assert(typeof rResult.valuesHash === 'string' && rResult.valuesHash.length === 64, 'read result hashes values');
  });

  await checkAsync('large values and recordHashOnly log a hash, not the value', async () => {
    const sub = join(tmp, 'mem-hash');
    await mkdir(sub, { recursive: true });
    const table = new ProcessTable({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      recorderFactory: async (pid) => Recorder.open({ pid, dir: join(sub, String(unbrand(pid))) }),
    });
    tables.push(table);
    const pid = await spawnRunning(table);
    const mgr = makeManager(table, { largeValueBytes: 8 });
    mgr.attachRegion(pid, 'big', priv);
    await mgr.write(pid, 'big', 'huge', 'this value is definitely larger than eight bytes');
    await mgr.write(pid, 'big', 'small', 1, { recordHashOnly: true });

    const rec = table.recorderFor(pid)!;
    await rec.flush();
    const writes: SyscallRecord[] = [];
    for await (const r of readRecords(rec.path)) {
      if (r.syscall === 'memory_write') writes.push(r);
    }
    assert(writes.length === 2, `expected 2 write records, got ${writes.length}`);
    for (const w of writes) {
      const a = w.args as Record<string, unknown>;
      assert(a.value === undefined, 'hashed write must not record the raw value');
      assert(typeof a.valueHash === 'string', 'hashed write records a valueHash');
      assert(typeof a.valueBytes === 'number' && (a.valueBytes as number) > 0, 'hashed write records byte size');
    }
  });

  await checkAsync('trap records land in .crec on ENOENT', async () => {
    const sub = join(tmp, 'mem-traps');
    await mkdir(sub, { recursive: true });
    const table = new ProcessTable({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      recorderFactory: async (pid) => Recorder.open({ pid, dir: join(sub, String(unbrand(pid))) }),
    });
    tables.push(table);
    const pid = await spawnRunning(table);
    const mgr = makeManager(table);
    try {
      await mgr.write(pid, 'ghost', 'k', 1);
    } catch {
      /* expected */
    }
    const rec = table.recorderFor(pid)!;
    await rec.flush();
    const traps: SyscallRecord[] = [];
    for await (const r of readRecords(rec.path)) {
      if (r.phase === 'trap') traps.push(r);
    }
    assert(traps.length === 1, `expected 1 trap record, got ${traps.length}`);
    assert(traps[0]!.syscall === 'memory_write', 'trap records the syscall name');
    assert(traps[0]!.error?.errno === 'ENOENT', `trap errno should be ENOENT, got ${traps[0]!.error?.errno}`);
  });

  // --- cleanup --------------------------------------------------------------
  for (const t of tables) {
    for (const pid of t.pids()) {
      const rec = t.recorderFor(pid);
      if (rec !== null) await rec.close().catch(() => {});
    }
  }
  await rm(tmp, { recursive: true, force: true });
}

async function runCheckpointChecks(): Promise<void> {
  const { mkdtemp, rm, mkdir, readFile, writeFile, stat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const tmp = await mkdtemp(join(tmpdir(), 'cortex-smoke-ckpt-'));
  const tables: ProcessTable[] = [];

  let fakeNow = Date.UTC(2026, 0, 1, 0, 0, 0);
  const clock = () => new Date(fakeNow).toISOString();
  const tick = (ms = 1000) => {
    fakeNow += ms;
  };

  async function makeTable(): Promise<ProcessTable> {
    const t = new ProcessTable({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      recorderFactory: async (pid) => Recorder.open({ pid, dir: join(tmp, String(unbrand(pid))) }),
    });
    tables.push(t);
    return t;
  }

  const agent = { module: './agents/noop.js' } as const;

  async function spawnRunning(table: ProcessTable, role = 'worker'): Promise<ProcessIdAlias> {
    const pid = await table.allocate({ ppid: null, role, agent });
    await table.setState(pid, 'ready', { trigger: 'init' });
    tick();
    await table.setState(pid, 'running', { trigger: 'dispatch' });
    tick();
    return pid;
  }

  // --- injected cognitive state store + deterministic chain ids -------------
  const cognitive = new Map<number, CognitiveSnapshot>();
  const getCognitive = (pid: ProcessIdAlias): CognitiveSnapshot =>
    cognitive.get(unbrand(pid)) ?? EMPTY_COGNITIVE;
  const putCognitive = (pid: ProcessIdAlias, snap: CognitiveSnapshot): void => {
    cognitive.set(unbrand(pid), snap);
  };

  let chainCounter = 0;
  const nextChainId = () => {
    chainCounter += 1;
    return asChainId(`chain-${chainCounter}`);
  };

  let dirCounter = 0;
  const defaultRestoreContext = (): RestoreContext => ({ role: 'worker', agent });

  function makeCkpt(
    table: ProcessTable,
    opts?: Partial<ConstructorParameters<typeof CheckpointManager>[0]>,
  ): { ckpt: CheckpointManager; memory: MemoryManager; driver: FakeMemoryDriver; dir: string } {
    const driver = new FakeMemoryDriver(clock, KERNEL_ABI_VERSION);
    const memory = new MemoryManager({
      table,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      drivers: { inmem: driver },
    });
    dirCounter += 1;
    const dir = join(tmp, `csnap-${dirCounter}`);
    const ckpt = new CheckpointManager({
      table,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      dir,
      now: clock,
      nextChainId,
      memory,
      cognitiveSource: getCognitive,
      cognitiveSink: putCognitive,
      restoreContext: defaultRestoreContext,
      defaultMemoryBacking: 'inmem',
      ...opts,
    });
    return { ckpt, memory, driver, dir };
  }

  const priv: MemoryRegionPolicy = { kind: 'private', backing: 'inmem' };
  const shared: MemoryRegionPolicy = { kind: 'shared', backing: 'inmem' };

  // --- constants / helpers --------------------------------------------------

  check('checkpoint constants and safeTimestamp', () => {
    assert(CSNAP_MAGIC_STR === 'CRTX', 'magic string is CRTX');
    assert(CSNAP_HEADER_SIZE === 4, 'header is 4 bytes');
    assert(CSNAP_MAGIC.length === CSNAP_HEADER_SIZE, 'magic bytes match header size');
    assert(SIGNATURE_SIZE === 32, 'sha256 signature is 32 bytes');
    assert(CHECKPOINT_VERSION === 1, 'checkpoint version is 1');
    assert(
      safeTimestamp('2026-01-01T00:00:00.000Z') === '2026-01-01T00-00-00-000Z',
      'colons and dots are replaced for Windows-safe filenames',
    );
    assert(
      EMPTY_COGNITIVE.messages.length === 0 && EMPTY_COGNITIVE.intent === null,
      'EMPTY_COGNITIVE is empty',
    );
  });

  // --- take -----------------------------------------------------------------

  await checkAsync('take from RUNNING returns to READY and writes a .csnap file', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    assert(table.get(pid)!.state === 'running', 'starts running');
    const { ckpt, dir } = makeCkpt(table);
    const { chainId, path } = await ckpt.take(pid);
    tick();
    assert(table.get(pid)!.state === 'ready', 'back to READY after take');
    assert(typeof unbrand(chainId) === 'string' && unbrand(chainId).length > 0, 'chainId returned');
    assert(path.startsWith(dir), 'file written into the checkpoint dir');
    const st = await stat(path);
    assert(
      st.size > CSNAP_HEADER_SIZE + SIGNATURE_SIZE,
      'file holds magic + body + signature',
    );
    assert(path.endsWith('.csnap'), 'file uses the .csnap extension');
  });

  await checkAsync('take with detach suspends the process', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const { ckpt } = makeCkpt(table);
    await ckpt.take(pid, { detach: true });
    assert(table.get(pid)!.state === 'suspended', 'detach → SUSPENDED');
  });

  await checkAsync('take from BLOCKED returns to READY', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    await table.setState(pid, 'blocked', { trigger: 'recv' });
    const { ckpt } = makeCkpt(table);
    await ckpt.take(pid);
    assert(table.get(pid)!.state === 'ready', 'blocked → checkpointing → ready');
  });

  await checkAsync('take from STOPPED traps EINVAL and leaves the process stopped', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    await table.setState(pid, 'stopped', { trigger: 'SIGSTOP' });
    const { ckpt } = makeCkpt(table);
    let err: unknown;
    try {
      await ckpt.take(pid);
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'EINVAL', 'illegal source state → EINVAL');
    assert(table.get(pid)!.state === 'stopped', 'process left exactly as it was');
  });

  await checkAsync('take of an unknown pid traps ESRCH', async () => {
    const table = await makeTable();
    const { ckpt } = makeCkpt(table);
    let err: unknown;
    try {
      await ckpt.take(asProcessId(9999));
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'ESRCH', 'absent pid → ESRCH');
  });

  await checkAsync('a snapshot-phase failure traps EDRIVER and recovers to READY', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const { ckpt } = makeCkpt(table, {
      driverStateSource: () => {
        throw new Error('driver serialize boom');
      },
    });
    let err: unknown;
    try {
      await ckpt.take(pid);
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'EDRIVER', 'raw throw wrapped as EDRIVER');
    assert(
      table.get(pid)!.state === 'ready',
      'recovered to READY, never stranded in CHECKPOINTING',
    );
  });

  // --- load / round-trip ----------------------------------------------------

  await checkAsync('load round-trips header, budgets, and syscall log offset', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    table.spend(pid, { tokensIn: 100, tokensOut: 40, usdSpent: 0.5 });
    const { ckpt } = makeCkpt(table);
    const { chainId } = await ckpt.take(pid);
    const cp = await ckpt.load(chainId);
    assert(cp.magic === 'CRTX' && cp.version === CHECKPOINT_VERSION, 'magic + version');
    assert(cp.signature.length === SIGNATURE_SIZE, 'signature is 32 bytes');
    assert(unbrand(cp.pid) === unbrand(pid), 'pid captured');
    assert(cp.parentPid === null, 'root parentPid captured as null');
    assert(cp.budgets.tokensIn === 100 && cp.budgets.tokensOut === 40, 'budgets captured');
    assert(
      unbrand(cp.syscallLogOffset) > 0,
      'syscall log offset reflects prior recorded syscalls',
    );
  });

  await checkAsync('cognitive snapshot round-trips through the checkpoint', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const { ckpt } = makeCkpt(table);
    putCognitive(pid, {
      messages: [
        { role: 'user', content: 'remember this' },
        { role: 'assistant', content: 'ok' },
      ],
      intent: 'persist',
      pendingCalls: [{ id: 'c1', tool: 'lookup', args: { x: 1 }, startedAt: clock() }],
    });
    const { chainId } = await ckpt.take(pid);
    const cp = await ckpt.load(chainId);
    assert(cp.cognitive.messages.length === 2, 'messages captured');
    assert(cp.cognitive.messages[0]!.content === 'remember this', 'message content preserved');
    assert(cp.cognitive.intent === 'persist', 'intent captured');
    assert(
      cp.cognitive.pendingCalls.length === 1 && cp.cognitive.pendingCalls[0]!.tool === 'lookup',
      'pendingCalls captured',
    );
  });

  await checkAsync('memoryDelta captures every region entry as a full snapshot', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const { ckpt, memory } = makeCkpt(table);
    memory.attachRegion(pid, 'episodic', priv);
    memory.attachRegion(pid, 'semantic', shared);
    await memory.write(pid, 'episodic', 'e1', { a: 1 });
    await memory.write(pid, 'semantic', 's1', 'shared-value');
    const { chainId } = await ckpt.take(pid);
    const cp = await ckpt.load(chainId);
    assert(cp.memoryDelta.baseChainId === null, 'v0 delta is a full snapshot (baseChainId null)');
    assert(
      cp.memoryDelta.writes.length === 2,
      `both entries captured, got ${cp.memoryDelta.writes.length}`,
    );
    const regions = new Set(cp.memoryDelta.writes.map((w) => w.region));
    assert(
      regions.has('episodic') && regions.has('semantic'),
      'entries are remapped to logical region names',
    );
  });

  await checkAsync('driverStates blobs round-trip as bytes', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const blob = new Uint8Array([1, 2, 3, 250]);
    const { ckpt } = makeCkpt(table, {
      driverStateSource: () => ({ mydriver: blob, empty: null }),
    });
    const { chainId } = await ckpt.take(pid);
    const cp = await ckpt.load(chainId);
    const got = cp.driverStates.mydriver;
    assert(
      got instanceof Uint8Array && got.length === 4 && got[3] === 250,
      'driver byte blob preserved through CBOR',
    );
    assert(cp.driverStates.empty === null, 'null driver state preserved');
  });

  await checkAsync('a tampered checkpoint fails signature verification with EINVAL', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const { ckpt } = makeCkpt(table);
    const { chainId, path } = await ckpt.take(pid);
    const bytes = await readFile(path);
    const orig = bytes[CSNAP_HEADER_SIZE] ?? 0;
    bytes[CSNAP_HEADER_SIZE] = orig ^ 0xff; // flip a body byte
    await writeFile(path, bytes);
    let err: unknown;
    try {
      await ckpt.load(chainId);
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'EINVAL', 'tampered body → EINVAL');
  });

  await checkAsync('load of an unknown chainId traps ENOENT', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const { ckpt } = makeCkpt(table);
    await ckpt.take(pid);
    let err: unknown;
    try {
      await ckpt.load(asChainId('does-not-exist'));
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'ENOENT', 'unknown chainId → ENOENT');
  });

  await checkAsync('load resolves by directory scan when the in-memory index is cold', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const { ckpt, dir } = makeCkpt(table);
    const { chainId } = await ckpt.take(pid);
    // A fresh manager has an empty index and must find the file by scanning.
    const cold = new CheckpointManager({
      table,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      dir,
      now: clock,
    });
    const cp = await cold.load(chainId);
    assert(unbrand(cp.chainId) === unbrand(chainId), 'cold load resolves by scanning the dir');
  });

  await checkAsync('successive checkpoints link prevInChain; listLineage is oldest→newest', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const { ckpt } = makeCkpt(table);
    const a = await ckpt.take(pid);
    tick();
    await table.setState(pid, 'running', { trigger: 'redispatch' });
    const b = await ckpt.take(pid);

    const cpA = await ckpt.load(a.chainId);
    const cpB = await ckpt.load(b.chainId);
    assert(cpA.prevInChain === null, 'first checkpoint has no predecessor');
    assert(unbrand(cpB.prevInChain!) === unbrand(a.chainId), 'second links back to first');

    const lineage = await ckpt.listLineage(b.chainId);
    assert(lineage.length === 2, `lineage has 2 links, got ${lineage.length}`);
    assert(
      unbrand(lineage[0]!) === unbrand(a.chainId) && unbrand(lineage[1]!) === unbrand(b.chainId),
      'lineage ordered oldest → newest',
    );
    assert(
      table.get(pid)!.checkpointChain.length === 2,
      'process checkpointChain tracks both snapshots',
    );
  });

  // --- restoreAs ------------------------------------------------------------

  await checkAsync('restoreAs mints a NEW pid in state NEW, leaving the source untouched', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const { ckpt } = makeCkpt(table);
    const { chainId } = await ckpt.take(pid);
    const newPid = await ckpt.restoreAs(chainId);
    assert(unbrand(newPid) !== unbrand(pid), 'restore allocates a fresh pid');
    assert(table.get(newPid)!.state === 'new', 'new process starts in NEW');
    assert(table.get(pid)!.state === 'ready', 'source process is unaffected');
    assert(
      table.get(newPid)!.checkpointChain.some((c) => unbrand(c) === unbrand(chainId)),
      'new process continues the same chain',
    );
  });

  await checkAsync('restoreAs preserves spent budgets and re-hydrates memory + cognition', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    table.spend(pid, { tokensIn: 77, tokensOut: 33 });
    const { ckpt, memory } = makeCkpt(table);
    memory.attachRegion(pid, 'episodic', priv);
    await memory.write(pid, 'episodic', 'k1', { v: 1 });
    putCognitive(pid, {
      messages: [{ role: 'user', content: 'hi' }],
      intent: 'resume',
      pendingCalls: [],
    });
    const { chainId } = await ckpt.take(pid);
    const newPid = await ckpt.restoreAs(chainId);

    assert(table.get(newPid)!.budgetsSpent.tokensIn === 77, 'spent tokensIn preserved');
    assert(table.get(newPid)!.budgetsSpent.tokensOut === 33, 'spent tokensOut preserved');

    const entries = await memory.read(newPid, 'episodic', {});
    assert(entries.length === 1 && entries[0]!.key === 'k1', 'memory entry re-hydrated');
    assert((entries[0]!.value as { v: number }).v === 1, 'memory value preserved');

    const restored = getCognitive(newPid);
    assert(
      restored.messages.length === 1 && restored.intent === 'resume',
      'cognitiveSink received the snapshot',
    );
  });

  await checkAsync('restoreAs without a restoreContext provider traps EINVAL', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const { ckpt, dir } = makeCkpt(table);
    const { chainId } = await ckpt.take(pid);
    const bare = new CheckpointManager({
      table,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      dir,
      now: clock,
    });
    let err: unknown;
    try {
      await bare.restoreAs(chainId);
    } catch (e) {
      err = e;
    }
    assert(
      isCortexError(err) && err.errno === 'EINVAL',
      'restore needs the agent spec, which the checkpoint does not carry',
    );
  });

  // --- recording ------------------------------------------------------------

  await checkAsync('take records an idempotent checkpoint syscall', async () => {
    const sub = join(tmp, 'ckpt-records');
    await mkdir(sub, { recursive: true });
    const table = new ProcessTable({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      recorderFactory: async (pid) => Recorder.open({ pid, dir: join(sub, String(unbrand(pid))) }),
    });
    tables.push(table);
    const pid = await spawnRunning(table);
    const { ckpt } = makeCkpt(table);
    const { chainId } = await ckpt.take(pid, { tag: 'pre-deploy' });
    const rec = table.recorderFor(pid)!;
    await rec.flush();
    const records: SyscallRecord[] = [];
    for await (const r of readRecords(rec.path)) records.push(r);
    const ck = records.filter((r) => r.syscall === 'checkpoint');
    assert(ck.length === 1, `expected 1 checkpoint record, got ${ck.length}`);
    assert(ck[0]!.phase === 'exit', 'exit phase');
    assert(ck[0]!.reversibility === 'idempotent', 'checkpoint is idempotent');
    assert(
      ck[0]!.stateBefore === 'checkpointing' && ck[0]!.stateAfter === 'ready',
      'state transition recorded',
    );
    const res = ck[0]!.result as { chainId: string; byteSize: number; syscallLogOffset: number };
    assert(res.chainId === unbrand(chainId), 'result carries chainId');
    assert(typeof res.byteSize === 'number' && res.byteSize > 0, 'result carries byteSize');
    const args = ck[0]!.args as { tag?: string; detach: boolean };
    assert(args.tag === 'pre-deploy', 'tag captured in args');
    assert(args.detach === false, 'detach flag captured');
  });

  await checkAsync('restoreAs records a reversible restore syscall in the new log', async () => {
    const sub = join(tmp, 'restore-records');
    await mkdir(sub, { recursive: true });
    const table = new ProcessTable({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      recorderFactory: async (pid) => Recorder.open({ pid, dir: join(sub, String(unbrand(pid))) }),
    });
    tables.push(table);
    const pid = await spawnRunning(table);
    const { ckpt } = makeCkpt(table);
    const { chainId } = await ckpt.take(pid);
    const newPid = await ckpt.restoreAs(chainId);
    const rec = table.recorderFor(newPid)!;
    await rec.flush();
    const records: SyscallRecord[] = [];
    for await (const r of readRecords(rec.path)) records.push(r);
    const rs = records.filter((r) => r.syscall === 'restore');
    assert(rs.length === 1, `expected 1 restore record, got ${rs.length}`);
    assert(rs[0]!.reversibility === 'reversible', 'restore is reversible');
    assert(
      rs[0]!.stateBefore === 'new' && rs[0]!.stateAfter === 'new',
      'new process stays in NEW',
    );
    const args = rs[0]!.args as { chainId: string; sourcePid: number };
    assert(args.chainId === unbrand(chainId), 'restore args carry chainId');
    assert(args.sourcePid === unbrand(pid), 'restore args carry the source pid');
  });

  // --- cleanup --------------------------------------------------------------
  for (const t of tables) {
    for (const pid of t.pids()) {
      const rec = t.recorderFor(pid);
      if (rec !== null) await rec.close().catch(() => {});
    }
  }
  await rm(tmp, { recursive: true, force: true });
}

async function runForkChecks(): Promise<void> {
  const { mkdtemp, rm, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const tmp = await mkdtemp(join(tmpdir(), 'cortex-smoke-fork-'));
  const tables: ProcessTable[] = [];

  let fakeNow = Date.UTC(2026, 0, 1, 0, 0, 0);
  const clock = () => new Date(fakeNow).toISOString();
  const tick = (ms = 1000) => {
    fakeNow += ms;
  };

  async function makeTable(dir = tmp): Promise<ProcessTable> {
    const t = new ProcessTable({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      recorderFactory: async (pid) => Recorder.open({ pid, dir: join(dir, String(unbrand(pid))) }),
    });
    tables.push(t);
    return t;
  }

  const agent = { module: './agents/noop.js' } as const;

  async function toRunning(table: ProcessTable, pid: ProcessIdAlias): Promise<void> {
    await table.setState(pid, 'ready', { trigger: 'init' });
    tick();
    await table.setState(pid, 'running', { trigger: 'dispatch' });
    tick();
  }

  async function spawnRunning(
    table: ProcessTable,
    role = 'worker',
    memory?: Readonly<Record<string, MemoryRegionPolicy>>,
    budgets?: { tokens: number; usd: number; wallTimeMs: number },
  ): Promise<ProcessIdAlias> {
    const pid = await table.allocate({
      ppid: null,
      role,
      agent,
      ...(memory !== undefined ? { memory } : {}),
      ...(budgets !== undefined ? { budgets } : {}),
    });
    await toRunning(table, pid);
    return pid;
  }

  // --- injected cognitive store + deterministic chain ids -------------------
  const cognitive = new Map<number, CognitiveSnapshot>();
  const getCognitive = (pid: ProcessIdAlias): CognitiveSnapshot =>
    cognitive.get(unbrand(pid)) ?? EMPTY_COGNITIVE;
  const putCognitive = (pid: ProcessIdAlias, snap: CognitiveSnapshot): void => {
    cognitive.set(unbrand(pid), snap);
  };

  let chainCounter = 0;
  const nextChainId = () => {
    chainCounter += 1;
    return asChainId(`fork-chain-${chainCounter}`);
  };

  function makeFork(
    table: ProcessTable,
    opts?: Partial<ConstructorParameters<typeof ForkManager>[0]>,
  ): { fork: ForkManager; memory: MemoryManager; driver: FakeMemoryDriver } {
    const driver = new FakeMemoryDriver(clock, KERNEL_ABI_VERSION);
    const memory = new MemoryManager({
      table,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      drivers: { inmem: driver },
    });
    const fork = new ForkManager({
      table,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      nextChainId,
      memory,
      cognitiveSource: getCognitive,
      cognitiveSink: putCognitive,
      ...opts,
    });
    return { fork, memory, driver };
  }

  const priv: MemoryRegionPolicy = { kind: 'private', backing: 'inmem' };
  const shared: MemoryRegionPolicy = { kind: 'shared', backing: 'inmem' };
  const cow: MemoryRegionPolicy = { kind: 'cow', backing: 'inmem' };

  // --- constants ------------------------------------------------------------

  check('fork constants', () => {
    assert(DEFAULT_FORK_KIND === 'cognitive', 'v0 only ships cognitive fork');
    assert(DEFAULT_BUDGET_POLICY === 'reset', 'default budget policy is reset');
    const allowed: readonly string[] = FORK_ALLOWED_STATES;
    for (const s of ['running', 'blocked', 'stopped', 'suspended']) {
      assert(allowed.includes(s), `${s} is forkable`);
    }
    assert(!allowed.includes('ready'), 'READY is not forkable');
    assert(!allowed.includes('new'), 'NEW is not forkable');
  });

  // --- identity / lineage ---------------------------------------------------

  await checkAsync('fork from RUNNING mints a READY child and leaves the parent running', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table, 'researcher');
    const { fork } = makeFork(table);
    const res: ForkResult = await fork.fork(pid);
    assert(unbrand(res.childPid) !== unbrand(pid), 'child gets a fresh pid');
    const child = table.get(res.childPid)!;
    assert(child.state === 'ready', 'child lands in READY');
    assert(unbrand(child.ppid!) === unbrand(pid), 'child ppid points at the forker');
    assert(child.role === 'researcher', 'role inherited');
    assert(table.get(pid)!.state === 'running', 'parent unchanged');
    assert(typeof unbrand(res.childChainId) === 'string', 'child chainId returned');
    assert(unbrand(res.sharedCausalPast) >= 0, 'shared causal past offset returned');
    assert(Array.isArray(res.irreversibleInPast), 'irreversible list returned');
  });

  await checkAsync('fork is allowed from BLOCKED, STOPPED, and SUSPENDED', async () => {
    // blocked
    const t1 = await makeTable();
    const p1 = await spawnRunning(t1);
    await t1.setState(p1, 'blocked', { trigger: 'recv' });
    const f1 = makeFork(t1).fork;
    const r1 = await f1.fork(p1);
    assert(t1.get(p1)!.state === 'blocked', 'parent stays blocked');
    assert(t1.get(r1.childPid)!.state === 'ready', 'child ready from blocked parent');

    // stopped
    const t2 = await makeTable();
    const p2 = await spawnRunning(t2);
    await t2.setState(p2, 'stopped', { trigger: 'SIGSTOP' });
    const r2 = await makeFork(t2).fork.fork(p2);
    assert(t2.get(p2)!.state === 'stopped', 'parent stays stopped');
    assert(t2.get(r2.childPid)!.state === 'ready', 'child ready from stopped parent');

    // suspended (reached via the legal running→checkpointing→suspended path)
    const t3 = await makeTable();
    const p3 = await spawnRunning(t3);
    await t3.setState(p3, 'checkpointing', { trigger: 'test' });
    await t3.setState(p3, 'suspended', { trigger: 'test' });
    const r3 = await makeFork(t3).fork.fork(p3);
    assert(t3.get(p3)!.state === 'suspended', 'parent stays suspended');
    assert(t3.get(r3.childPid)!.state === 'ready', 'child ready from suspended parent');
  });

  await checkAsync('fork from READY traps ESTATE', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    await table.setState(pid, 'ready', { trigger: 'yield' });
    const { fork } = makeFork(table);
    let err: unknown;
    try {
      await fork.fork(pid);
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'ESTATE', 'READY is not a forkable state');
    assert(table.get(pid)!.state === 'ready', 'parent untouched');
  });

  await checkAsync('fork from NEW traps ESTATE', async () => {
    const table = await makeTable();
    const pid = await table.allocate({ ppid: null, role: 'worker', agent });
    const { fork } = makeFork(table);
    let err: unknown;
    try {
      await fork.fork(pid);
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'ESTATE', 'NEW is not a forkable state');
  });

  await checkAsync('fork of an unknown pid traps ESRCH', async () => {
    const table = await makeTable();
    const { fork } = makeFork(table);
    let err: unknown;
    try {
      await fork.fork(asProcessId(9999));
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'ESRCH', 'absent parent → ESRCH');
  });

  await checkAsync("fork with a non-cognitive kind traps EINVAL", async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const { fork } = makeFork(table);
    let err: unknown;
    try {
      await fork.fork(pid, { kind: 'sandbox' } as unknown as ForkOptions);
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'EINVAL', 'sandbox fork is post-v0');
  });

  // --- budget policies ------------------------------------------------------

  await checkAsync('budget reset (default) zeroes the child spent counters', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    table.spend(pid, { tokensIn: 100, tokensOut: 50 });
    const { fork } = makeFork(table);
    const res = await fork.fork(pid);
    const child = table.get(res.childPid)!;
    assert(child.budgetsSpent.tokensIn === 0, 'child spent reset to zero');
    assert(child.budgetsSpent.tokensOut === 0, 'child spent reset to zero');
    assert(
      child.budgetsRemaining.tokens === table.get(pid)!.budgetsRemaining.tokens,
      'child inherits the remaining envelope',
    );
  });

  await checkAsync('budget inherit copies the parent spent counters', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    table.spend(pid, { tokensIn: 100, tokensOut: 50 });
    const { fork } = makeFork(table);
    const res = await fork.fork(pid, { budgets: 'inherit' });
    const child = table.get(res.childPid)!;
    assert(child.budgetsSpent.tokensIn === 100, 'child remembers parent spend');
    assert(child.budgetsSpent.tokensOut === 50, 'child remembers parent spend');
  });

  await checkAsync('budget split halves the remaining envelope between parent and child', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table, 'worker', undefined, {
      tokens: 1000,
      usd: 10,
      wallTimeMs: -1,
    });
    const { fork } = makeFork(table);
    const res = await fork.fork(pid, { budgets: 'split' });
    const parent = table.get(pid)!;
    const child = table.get(res.childPid)!;
    assert(child.budgetsRemaining.tokens === 500, `child tokens 500, got ${child.budgetsRemaining.tokens}`);
    assert(parent.budgetsRemaining.tokens === 500, `parent tokens 500, got ${parent.budgetsRemaining.tokens}`);
    assert(child.budgetsRemaining.usd === 5 && parent.budgetsRemaining.usd === 5, 'usd split');
    assert(
      child.budgetsRemaining.wallTimeMs === -1 && parent.budgetsRemaining.wallTimeMs === -1,
      'unlimited stays unlimited',
    );
  });

  await checkAsync('fork into an exhausted budget traps EBUDGET', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table, 'worker', undefined, {
      tokens: 0,
      usd: -1,
      wallTimeMs: -1,
    });
    const { fork } = makeFork(table);
    let err: unknown;
    try {
      await fork.fork(pid);
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'EBUDGET', 'child would be born exhausted');
  });

  // --- memory copy semantics ------------------------------------------------

  await checkAsync('private region deep-copies and diverges after fork', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table, 'worker', { episodic: priv });
    const { fork, memory } = makeFork(table);
    memory.syncFromTable(pid);
    await memory.write(pid, 'episodic', 'e1', { a: 1 });
    const res = await fork.fork(pid);
    const child = res.childPid;

    const before = await memory.read(child, 'episodic', {});
    assert(before.length === 1 && before[0]!.key === 'e1', 'child inherits the private entry');

    await memory.write(child, 'episodic', 'e2', { b: 2 });
    const parentAfter = await memory.read(pid, 'episodic', {});
    const childAfter = await memory.read(child, 'episodic', {});
    assert(parentAfter.length === 1, 'parent does not see the child write');
    assert(childAfter.length === 2, 'child sees its own write');
  });

  await checkAsync('shared region: a child write is visible to the parent', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table, 'worker', { semantic: shared });
    const { fork, memory } = makeFork(table);
    memory.syncFromTable(pid);
    await memory.write(pid, 'semantic', 's1', 'fact');
    const res = await fork.fork(pid);
    await memory.write(res.childPid, 'semantic', 's2', 'new-fact');
    const parentEntries = await memory.read(pid, 'semantic', {});
    const keys = parentEntries.map((e) => e.key).sort();
    assert(keys.length === 2 && keys[0] === 's1' && keys[1] === 's2', 'parent sees both shared keys');
  });

  await checkAsync('cow region shares until the child writes, then diverges', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table, 'worker', { episodic: cow });
    const { fork, memory } = makeFork(table);
    memory.syncFromTable(pid);
    await memory.write(pid, 'episodic', 'e1', { a: 1 });
    const res = await fork.fork(pid);
    const child = res.childPid;

    const sharedRead = await memory.read(child, 'episodic', {});
    assert(sharedRead.length === 1, 'child reads the shared cow page');

    await memory.write(child, 'episodic', 'e2', { b: 2 }); // triggers the copy
    const parentAfter = await memory.read(pid, 'episodic', {});
    const childAfter = await memory.read(child, 'episodic', {});
    assert(parentAfter.length === 1, 'parent keeps only e1 after cow split');
    assert(childAfter.length === 2, 'child has e1 + e2 after cow split');
  });

  await checkAsync('memoryOverrides change a region copy semantics on fork', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table, 'worker', { episodic: cow });
    const { fork, memory } = makeFork(table);
    memory.syncFromTable(pid);
    await memory.write(pid, 'episodic', 'e1', { a: 1 });
    const res = await fork.fork(pid, { memoryOverrides: { episodic: priv } });
    assert(
      memory.regionInfo(res.childPid, 'episodic')!.kind === 'private',
      'override turned cow into private for the child',
    );
  });

  await checkAsync('per-region maxEntries inherits through fork', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table, 'worker', {
      notes: { kind: 'private', backing: 'inmem', maxEntries: 2 },
    });
    const { fork, memory } = makeFork(table);
    memory.syncFromTable(pid);
    const res = await fork.fork(pid);
    assert(
      memory.regionInfo(res.childPid, 'notes')!.effectiveMaxEntries === 2,
      'child inherits the parent region cap of 2',
    );
    // The cap bites on the child independently.
    await memory.write(res.childPid, 'notes', 'a', 1);
    await memory.write(res.childPid, 'notes', 'b', 2);
    let err: unknown;
    try {
      await memory.write(res.childPid, 'notes', 'c', 3);
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'ENOMEM', 'inherited per-region cap enforced on child');
  });

  await checkAsync('memoryOverrides can change maxEntries on fork', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table, 'worker', {
      notes: { kind: 'private', backing: 'inmem', maxEntries: 2 },
    });
    const { fork, memory } = makeFork(table);
    memory.syncFromTable(pid);
    const res = await fork.fork(pid, {
      memoryOverrides: { notes: { kind: 'private', backing: 'inmem', maxEntries: 1 } },
    });
    assert(
      memory.regionInfo(res.childPid, 'notes')!.effectiveMaxEntries === 1,
      'override cap of 1 wins for the child',
    );
    await memory.write(res.childPid, 'notes', 'a', 1);
    let err: unknown;
    try {
      await memory.write(res.childPid, 'notes', 'b', 2);
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'ENOMEM', 'override cap enforced on child');
  });

  // --- cognitive ------------------------------------------------------------

  await checkAsync('cognitive snapshot is deep-copied to the child', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const { fork } = makeFork(table);
    putCognitive(pid, {
      messages: [{ role: 'user', content: 'explore' }],
      intent: 'branch',
      pendingCalls: [],
    });
    const res = await fork.fork(pid);
    const childSnap = getCognitive(res.childPid);
    assert(childSnap.messages.length === 1 && childSnap.intent === 'branch', 'child got the snapshot');
    // Mutating the child's copy must not touch the parent's.
    childSnap.messages[0]!.content = 'mutated';
    assert(
      getCognitive(pid).messages[0]!.content === 'explore',
      'parent cognitive state is independent',
    );
  });

  // --- driver state ---------------------------------------------------------

  await checkAsync('closeDriverState runs for both parent and child', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const closed: number[] = [];
    const { fork } = makeFork(table, {
      closeDriverState: (p) => {
        closed.push(unbrand(p));
      },
    });
    const res = await fork.fork(pid);
    assert(closed.includes(unbrand(pid)), 'parent driver state closed');
    assert(closed.includes(unbrand(res.childPid)), 'child driver state closed');
  });

  await checkAsync('a driver that refuses to close traps EDRIVER and aborts the child', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const before = table.pids().length;
    const { fork } = makeFork(table, {
      closeDriverState: () => {
        throw new Error('socket in use');
      },
    });
    let err: unknown;
    try {
      await fork.fork(pid);
    } catch (e) {
      err = e;
    }
    assert(isCortexError(err) && err.errno === 'EDRIVER', 'driver close failure → EDRIVER');
    assert(table.get(pid)!.state === 'running', 'parent unchanged');
    assert(table.pids().length === before + 1, 'a child pid was allocated');
    const states = table.pids().map((p) => table.get(p)!.state);
    assert(states.includes('zombie'), 'the half-built child was reaped to ZOMBIE');
  });

  // --- causal past ----------------------------------------------------------

  await checkAsync('irreversibleInPast surfaces irreversible syscalls from the shared log', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    const rec = table.recorderFor(pid)!;
    await rec.append({
      timestamp: clock(),
      pid,
      syscall: 'send_email',
      callId: 'email-1',
      phase: 'exit',
      stateBefore: 'running',
      stateAfter: 'running',
      reversibility: 'irreversible',
      kernelAbiVersion: KERNEL_ABI_VERSION,
    });
    await rec.flush();
    const { fork } = makeFork(table);
    const res = await fork.fork(pid);
    assert(
      res.irreversibleInPast.includes('send_email'),
      'both branches remember the irreversible action',
    );
    assert(unbrand(res.sharedCausalPast) > 0, 'shared causal past reflects the parent log');
  });

  // --- recording ------------------------------------------------------------

  await checkAsync('fork records a reversible syscall in both parent and child logs', async () => {
    const sub = join(tmp, 'fork-records');
    await mkdir(sub, { recursive: true });
    const table = await makeTable(sub);
    const pid = await spawnRunning(table);
    const { fork } = makeFork(table);
    const res = await fork.fork(pid, { tag: 'explore-alt' });

    const parentRec = table.recorderFor(pid)!;
    await parentRec.flush();
    const parentRecords: SyscallRecord[] = [];
    for await (const r of readRecords(parentRec.path)) parentRecords.push(r);
    const pf = parentRecords.filter((r) => r.syscall === 'fork');
    assert(pf.length === 1, `parent log has 1 fork record, got ${pf.length}`);
    assert(pf[0]!.reversibility === 'reversible', 'fork is reversible');
    assert(pf[0]!.phase === 'exit', 'exit phase');
    const pRes = pf[0]!.result as { childPid: number; childChainId: string };
    assert(pRes.childPid === unbrand(res.childPid), 'parent record carries child pid');
    const pArgs = pf[0]!.args as { tag?: string; budgets: string };
    assert(pArgs.tag === 'explore-alt', 'tag captured');
    assert(pArgs.budgets === 'reset', 'budget policy captured');

    const childRec = table.recorderFor(res.childPid)!;
    await childRec.flush();
    const childRecords: SyscallRecord[] = [];
    for await (const r of readRecords(childRec.path)) childRecords.push(r);
    const cf = childRecords.filter((r) => r.syscall === 'fork');
    assert(cf.length === 1, `child log has 1 fork record, got ${cf.length}`);
    const cArgs = cf[0]!.args as { origin: string; parentPid: number };
    assert(cArgs.origin === 'child', 'child record marked as origin child');
    assert(cArgs.parentPid === unbrand(pid), 'child record carries parent pid');
    assert(
      cf[0]!.stateBefore === 'new' && cf[0]!.stateAfter === 'ready',
      'child record captures NEW → READY',
    );
  });

  // --- cleanup --------------------------------------------------------------
  for (const t of tables) {
    for (const pid of t.pids()) {
      const rec = t.recorderFor(pid);
      if (rec !== null) await rec.close().catch(() => {});
    }
  }
  await rm(tmp, { recursive: true, force: true });
}

async function runSchedulerChecks(): Promise<void> {
  const { mkdtemp, rm, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const tmp = await mkdtemp(join(tmpdir(), 'cortex-smoke-sched-'));
  const tables: ProcessTable[] = [];

  let fakeNow = Date.UTC(2026, 0, 1, 0, 0, 0);
  const clock = () => new Date(fakeNow).toISOString();
  const advance = (ms = 1000) => {
    fakeNow += ms;
  };

  async function makeTable(opts: { record?: boolean; dir?: string } = {}): Promise<ProcessTable> {
    const dir = opts.dir ?? tmp;
    const record = opts.record ?? false;
    const t = new ProcessTable({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      ...(record ? { recorderFactory: async (pid) => Recorder.open({ pid, dir: join(dir, String(unbrand(pid))) }) } : {}),
    });
    tables.push(t);
    return t;
  }

  const agent = { module: './agents/noop.js' } as const;

  interface SpawnOpts {
    role?: string;
    nice?: number;
    budgets?: { tokens: number; usd: number; wallTimeMs: number };
  }

  // Allocate and move NEW → READY (the schedulable state).
  async function spawn(table: ProcessTable, opts: SpawnOpts = {}): Promise<ProcessIdAlias> {
    const pid = await table.allocate({
      ppid: null,
      role: opts.role ?? 'worker',
      agent,
      ...(opts.nice !== undefined ? { nice: opts.nice } : {}),
      ...(opts.budgets !== undefined ? { budgets: opts.budgets } : {}),
    });
    await table.setState(pid, 'ready', { trigger: 'init' });
    advance();
    return pid;
  }

  function makeSched(
    table: ProcessTable,
    opts: Partial<ConstructorParameters<typeof Scheduler>[0]> = {},
  ): { sched: Scheduler; signals: SignalManager } {
    const signals =
      opts.signals ?? new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
    const sched = new Scheduler({
      table,
      signals,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      ...opts,
    });
    return { sched, signals };
  }

  // --- constants ------------------------------------------------------------

  check('scheduler constants', () => {
    assert(DEFAULT_IDLE_DELAY_MS === 10, 'idle delay defaults to 10ms');
    assert(DEFAULT_BUSY_DELAY_MS === 0, 'busy delay defaults to 0ms');
    assert(DEFAULT_BUSY_DELAY_MS < DEFAULT_IDLE_DELAY_MS, 'busy loop is tighter than idle');
  });

  // --- idle -----------------------------------------------------------------

  await checkAsync('tick on an empty table is idle and fires onIdle', async () => {
    const table = await makeTable();
    let idles = 0;
    const { sched } = makeSched(table, {
      onIdle: () => {
        idles++;
      },
    });
    const out: TickOutcome = await sched.tick();
    assert(out.dispatched === null, 'nothing dispatched');
    assert(out.reason === 'idle', 'reason is idle');
    assert(idles === 1, 'onIdle fired once');
    assert(sched.queueLength === 0, 'run queue empty');
  });

  // --- dispatch / yield -----------------------------------------------------

  await checkAsync('tick dispatches READY → RUNNING → yields back to READY and re-queues', async () => {
    const table = await makeTable();
    const pid = await spawn(table);
    const seen: ProcessState[] = [];
    const resume: ResumeFn = async (p) => {
      seen.push(table.get(p)!.state);
    };
    const { sched } = makeSched(table, { resume });
    const out = await sched.tick();
    assert(
      out.dispatched !== null && unbrand(out.dispatched) === unbrand(pid),
      'dispatched the ready pid',
    );
    assert(out.reason === 'yielded', 'a no-op continuation yields');
    assert(seen.length === 1 && seen[0] === 'running', 'resume ran while RUNNING');
    assert(table.get(pid)!.state === 'ready', 'back to READY after yield');
    assert(sched.isQueued(pid), 're-queued for round-robin');
  });

  // --- priority -------------------------------------------------------------

  await checkAsync('lower nice preempts higher nice', async () => {
    const table = await makeTable();
    const low = await spawn(table, { role: 'low', nice: 5 });
    const high = await spawn(table, { role: 'high', nice: -3 });
    // high blocks after its first quantum so it leaves the run queue.
    const resume: ResumeFn = async (p) => {
      if (unbrand(p) === unbrand(high)) {
        await table.setState(p, 'blocked', { trigger: 'recv' });
        table.setBlockedOn(p, { kind: 'lock', resource: 'test' });
      }
    };
    const { sched } = makeSched(table, { resume });
    const first = await sched.tick();
    assert(
      first.dispatched !== null && unbrand(first.dispatched) === unbrand(high),
      'nice -3 preempts nice 5',
    );
    assert(first.reason === 'blocked', 'high blocked itself');
    const second = await sched.tick();
    assert(
      second.dispatched !== null && unbrand(second.dispatched) === unbrand(low),
      'low runs once high is blocked',
    );
  });

  await checkAsync('equal nice is scheduled FIFO by enqueue order', async () => {
    const table = await makeTable();
    const a = await spawn(table, { role: 'a' });
    const b = await spawn(table, { role: 'b' });
    const resume: ResumeFn = async (p) => {
      await table.setState(p, 'blocked', { trigger: 'recv' });
    };
    const { sched } = makeSched(table, { resume });
    const first = await sched.tick();
    const second = await sched.tick();
    assert(
      first.dispatched !== null && unbrand(first.dispatched) === unbrand(a),
      'earlier pid (a) runs first',
    );
    assert(
      second.dispatched !== null && unbrand(second.dispatched) === unbrand(b),
      'later pid (b) runs second',
    );
  });

  await checkAsync('a yielding process goes to the back of its nice band (round-robin)', async () => {
    const table = await makeTable();
    const a = await spawn(table, { role: 'a' });
    const b = await spawn(table, { role: 'b' });
    const order: number[] = [];
    const resume: ResumeFn = async (p) => {
      order.push(unbrand(p));
    };
    const { sched } = makeSched(table, { resume });
    await sched.tick();
    await sched.tick();
    await sched.tick();
    assert(order.length === 3, 'three quanta ran');
    assert(
      order[0] === unbrand(a) && order[1] === unbrand(b) && order[2] === unbrand(a),
      `round-robin order a,b,a — got ${order.join(',')}`,
    );
  });

  // --- budgets --------------------------------------------------------------

  await checkAsync('an exhausted READY process is parked, then scheduled after setBudget', async () => {
    const table = await makeTable();
    const broke = await spawn(table, { role: 'broke', budgets: { tokens: 0, usd: -1, wallTimeMs: -1 } });
    const { sched } = makeSched(table);
    const out = await sched.tick();
    assert(out.dispatched === null, 'exhausted process is not a candidate');
    assert(out.reason === 'idle', 'tick reports idle');
    assert(table.get(broke)!.state === 'ready', 'still READY (parked, not stopped)');
    assert(sched.isQueued(broke), 'kept in the run queue for later');
    // Supervisor tops up the budget (PROCESS.md §8.3 recovery path).
    sched.setBudget(broke, { tokens: 1000, usd: -1, wallTimeMs: -1 });
    const out2 = await sched.tick();
    assert(
      out2.dispatched !== null && unbrand(out2.dispatched) === unbrand(broke),
      'schedulable after top-up',
    );
    assert(out2.reason === 'yielded', 'runs and yields');
  });

  await checkAsync('budget exhausted during a quantum fires SIGXCPU and STOPs the process', async () => {
    const table = await makeTable();
    const pid = await spawn(table, { budgets: { tokens: 100, usd: -1, wallTimeMs: -1 } });
    // The continuation spends the whole token budget then returns (still RUNNING).
    const resume: ResumeFn = async (p) => {
      table.spend(p, { tokensIn: 100 });
    };
    const { sched } = makeSched(table, { resume });
    const out = await sched.tick();
    assert(out.reason === 'sigxcpu', 'tick reports sigxcpu');
    assert(table.get(pid)!.state === 'stopped', 'SIGXCPU default action stopped it');
    assert(!sched.isQueued(pid), 'stopped process is not re-queued');
    assert(table.checkBudget(pid) !== 'ok', 'budget still exhausted');
  });

  await checkAsync('SIGXCPU dispatch writes __signal and __sched records', async () => {
    const sub = join(tmp, 'sched-records');
    await mkdir(sub, { recursive: true });
    const table = await makeTable({ record: true, dir: sub });
    const pid = await spawn(table, { budgets: { tokens: 10, usd: -1, wallTimeMs: -1 } });
    const resume: ResumeFn = async (p) => {
      table.spend(p, { tokensIn: 10 });
    };
    const { sched } = makeSched(table, { resume });
    const out = await sched.tick();
    assert(out.reason === 'sigxcpu', 'sigxcpu fired');

    const rec = table.recorderFor(pid)!;
    await rec.flush();
    const records: SyscallRecord[] = [];
    for await (const r of readRecords(rec.path)) records.push(r);

    const sig = records.filter((r) => r.syscall === '__signal');
    assert(
      sig.some((r) => (r.args as { signal?: string }).signal === 'SIGXCPU'),
      'a SIGXCPU __signal record exists',
    );
    const schedRecs = records.filter((r) => r.syscall === '__sched');
    const sigx = schedRecs.find((r) => (r.args as { action?: string }).action === 'sigxcpu');
    assert(sigx !== undefined, 'a __sched sigxcpu record exists');
    assert(
      (sigx!.args as { budgetKind?: string }).budgetKind === 'tokens',
      '__sched records the exhausted budget kind',
    );
    assert(
      schedRecs.some((r) => (r.args as { action?: string }).action === 'sigxcpu'),
      'sched action recorded',
    );
  });

  // --- blocking / waking ----------------------------------------------------

  await checkAsync('a blocked continuation is not re-queued; reconcile re-adopts it on wake', async () => {
    const table = await makeTable();
    const pid = await spawn(table);
    let phase = 0;
    const resume: ResumeFn = async (p) => {
      phase++;
      if (phase === 1) {
        await table.setState(p, 'blocked', { trigger: 'recv' });
        table.setBlockedOn(p, { kind: 'recv', channel: asChannelId('test') });
      }
    };
    const { sched } = makeSched(table, { resume });
    const out1 = await sched.tick();
    assert(out1.reason === 'blocked', 'first quantum blocks');
    assert(table.get(pid)!.state === 'blocked', 'process is BLOCKED');
    assert(!sched.isQueued(pid), 'blocked process left the run queue');
    const idleOut = await sched.tick();
    assert(idleOut.reason === 'idle', 'nothing runnable while blocked');
    // Wake: BLOCKED → READY.
    await table.setState(pid, 'ready', { trigger: 'wake' });
    const out2 = await sched.tick();
    assert(
      out2.dispatched !== null && unbrand(out2.dispatched) === unbrand(pid),
      'reconcile re-adopted the woken process',
    );
    assert(out2.reason === 'yielded', 'second quantum yields');
    assert(phase === 2, 'resume ran twice');
  });

  await checkAsync('a process dropped from the run queue while queued can be enqueued again', async () => {
    // Regression. `#selectNext` drops stale nodes (gone, or no longer in the
    // schedulable set) from `#queue` but used to leave the PID in the
    // membership mirror, so `enqueue()` — which is idempotent *by checking that
    // mirror* — became a permanent no-op for it. The process then sat READY
    // forever, dispatched by nobody. Nothing in the run-to-completion model
    // could reach that state; a cooperative body can: it is enqueued when the
    // kernel wakes it, and it blocks again on its next `wait()` while still
    // queued. That is exactly how the supervision tree deadlocked.
    const table = await makeTable();
    const pid = await spawn(table); // lands READY
    const { sched } = makeSched(table, { autoReconcile: false });
    sched.enqueue(pid);
    assert(sched.isQueued(pid) && sched.queueLength === 1, 'queued while READY');

    // It leaves the schedulable set while still queued (here: it got the CPU by
    // another path — in the kernel it is a woken body that blocks again on its
    // next `wait()` before the scheduler reaches it). Either way the queue node
    // is now stale.
    await table.setState(pid, 'running', { trigger: 'test' });
    const stale = await sched.tick();
    assert(stale.dispatched === null, 'a non-READY process is not dispatched');
    assert(sched.queueLength === 0, 'its stale queue entry is dropped');
    assert(!sched.isQueued(pid), 'and it is dropped from the membership mirror too');

    // …then it wakes up again and must be schedulable once more.
    await table.setState(pid, 'ready', { trigger: 'wake' });
    sched.enqueue(pid);
    assert(sched.queueLength === 1, 'enqueue() re-adds it');
    const out = await sched.tick();
    assert(
      out.dispatched !== null && unbrand(out.dispatched) === unbrand(pid),
      'and it is dispatched again',
    );
  });

  await checkAsync('a pending signal delivered on dispatch pre-empts the quantum', async () => {
    const table = await makeTable();
    const pid = await spawn(table);
    table.queueSignal(pid, 'SIGSTOP');
    let resumed = false;
    const resume: ResumeFn = async () => {
      resumed = true;
    };
    const { sched } = makeSched(table, { resume });
    const out = await sched.tick();
    assert(out.reason === 'signal', 'tick reports a signal pre-emption');
    assert(table.get(pid)!.state === 'stopped', 'queued SIGSTOP stopped it on dispatch');
    assert(!resumed, 'continuation never ran');
    assert(!sched.isQueued(pid), 'stopped process not re-queued');
  });

  // --- explicit run-queue API ----------------------------------------------

  await checkAsync('run-queue API: enqueue is idempotent, dequeue removes', async () => {
    const table = await makeTable();
    const a = await spawn(table, { role: 'a' });
    const b = await spawn(table, { role: 'b' });
    // autoReconcile off so the explicit queue is the only source of truth.
    const { sched } = makeSched(table, { autoReconcile: false });
    sched.enqueue(a);
    sched.enqueue(a); // idempotent
    sched.enqueue(b);
    assert(sched.queueLength === 2, 'two distinct entries');
    assert(sched.isQueued(a) && sched.isQueued(b), 'both queued');
    sched.dequeue(a);
    assert(!sched.isQueued(a), 'a dequeued');
    assert(sched.queueLength === 1, 'one entry remains');
    sched.dequeue(a); // idempotent no-op
    assert(sched.queueLength === 1, 'double dequeue is a no-op');
    const out = await sched.tick();
    assert(
      out.dispatched !== null && unbrand(out.dispatched) === unbrand(b),
      'only the still-queued b runs',
    );
  });

  // --- detach / exit --------------------------------------------------------

  await checkAsync('a continuation that detaches (STOPPED) is left as-is', async () => {
    const table = await makeTable();
    const pid = await spawn(table);
    const resume: ResumeFn = async (p) => {
      await table.setState(p, 'stopped', { trigger: 'self' });
    };
    const { sched } = makeSched(table, { resume });
    const out = await sched.tick();
    assert(out.reason === 'detached', 'stopped continuation reports detached');
    assert(table.get(pid)!.state === 'stopped', 'left stopped');
    assert(!sched.isQueued(pid), 'not re-queued');
  });

  await checkAsync('a continuation that exits reports exited', async () => {
    const table = await makeTable();
    const pid = await spawn(table);
    const resume: ResumeFn = async (p) => {
      await table.setState(p, 'exiting', { trigger: 'exit' });
      await table.setState(p, 'zombie', { trigger: 'cleanup-done' });
    };
    const { sched } = makeSched(table, { resume });
    const out = await sched.tick();
    assert(out.reason === 'exited', 'zombie continuation reports exited');
    assert(table.get(pid)!.state === 'zombie', 'left zombie');
    assert(!sched.isQueued(pid), 'not re-queued');
  });

  // --- auto-loop ------------------------------------------------------------

  await checkAsync('start() drives the auto-loop; stop() quiesces it', async () => {
    const table = await makeTable();
    await spawn(table);
    let runs = 0;
    const resume: ResumeFn = async () => {
      runs++;
    };
    const { sched } = makeSched(table, { resume, idleDelayMs: 1, busyDelayMs: 0 });
    sched.start();
    sched.start(); // idempotent
    assert(sched.running, 'scheduler reports running');
    await new Promise((r) => setTimeout(r, 40));
    await sched.stop();
    assert(!sched.running, 'scheduler stopped');
    assert(runs > 0, `auto-loop dispatched at least one quantum (runs=${runs})`);
    const before = runs;
    await new Promise((r) => setTimeout(r, 25));
    assert(runs === before, 'no further quanta after stop()');
    await sched.stop(); // idempotent
  });

  // --- cleanup --------------------------------------------------------------
  for (const t of tables) {
    for (const pid of t.pids()) {
      const rec = t.recorderFor(pid);
      if (rec !== null) await rec.close().catch(() => {});
    }
  }
  await rm(tmp, { recursive: true, force: true });
}

async function runInitChecks(): Promise<void> {
  const { mkdtemp, rm, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const tmp = await mkdtemp(join(tmpdir(), 'cortex-smoke-init-'));
  const tables: ProcessTable[] = [];

  let fakeNow = Date.UTC(2026, 0, 1, 0, 0, 0);
  const clock = () => new Date(fakeNow).toISOString();
  const advance = (ms = 1000) => {
    fakeNow += ms;
  };

  async function makeTable(opts: { record?: boolean; dir?: string } = {}): Promise<ProcessTable> {
    const dir = opts.dir ?? tmp;
    const record = opts.record ?? false;
    const t = new ProcessTable({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      ...(record ? { recorderFactory: async (pid) => Recorder.open({ pid, dir: join(dir, String(unbrand(pid))) }) } : {}),
    });
    tables.push(t);
    return t;
  }

  const agent = { module: './agents/noop.js' } as const;

  // Fake, manually-driven timers for deterministic backoff tests.
  interface FakeTimerEntry {
    id: number;
    cb: () => void;
    ms: number;
  }
  function makeFakeTimers(): {
    timers: FakeTimerEntry[];
    setTimeoutFn: (cb: () => void, ms: number) => unknown;
    clearTimeoutFn: (handle: unknown) => void;
    fireAll: () => void;
  } {
    const timers: FakeTimerEntry[] = [];
    let nextId = 1;
    const setTimeoutFn = (cb: () => void, ms: number): unknown => {
      const id = nextId++;
      timers.push({ id, cb, ms });
      return id;
    };
    const clearTimeoutFn = (handle: unknown): void => {
      const id = handle as number;
      const idx = timers.findIndex((t) => t.id === id);
      if (idx >= 0) timers.splice(idx, 1);
    };
    const fireAll = (): void => {
      const pending = timers.splice(0, timers.length);
      for (const t of pending) t.cb();
    };
    return { timers, setTimeoutFn, clearTimeoutFn, fireAll };
  }
  // Let fire-and-forget restart promises settle (they run on the microtask
  // queue after the synchronous fake-timer callback returns).
  const drain = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };

  interface KernelOpts {
    setTimeoutFn?: (cb: () => void, ms: number) => unknown;
    clearTimeoutFn?: (handle: unknown) => void;
    onAlarm?: OnAlarmHook;
    restartStormThreshold?: number;
  }

  // Wire signals <-> init exactly the way boot.ts will: the SignalManager's
  // onZombie hook forwards to init.handleZombie via a closure over a ref that
  // is assigned right after construction (breaks the signals <-> init cycle).
  function makeKernel(
    table: ProcessTable,
    opts: KernelOpts = {},
  ): { init: InitProcess; signals: SignalManager } {
    let init!: InitProcess;
    const signals = new SignalManager({
      table,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      onZombie: (pid, code, reason) => init.handleZombie(pid, code, reason),
    });
    init = new InitProcess({
      table,
      signals,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      ...opts,
    });
    return { init, signals };
  }

  // Allocate a process and move NEW -> READY.
  async function alloc(
    table: ProcessTable,
    opts: { ppid?: ProcessIdAlias | null; role?: string } = {},
  ): Promise<ProcessIdAlias> {
    const pid = await table.allocate({
      ppid: opts.ppid === undefined ? null : opts.ppid,
      role: opts.role ?? 'worker',
      agent,
    });
    await table.setState(pid, 'ready', { trigger: 'test' });
    advance();
    return pid;
  }

  // Drive a process to ZOMBIE with an explicit exit code, then notify init.
  // This is exactly what the syscall dispatcher's exit() path will do (#014);
  // signal deaths reach handleZombie through the onZombie hook instead.
  async function exitWithCode(
    init: InitProcess,
    table: ProcessTable,
    pid: ProcessIdAlias,
    code: number,
    reason = 'exit',
  ): Promise<void> {
    const e = table.get(pid)!;
    if (e.state === 'new') await table.setState(pid, 'ready', { trigger: 'test' });
    if (e.state === 'ready') await table.setState(pid, 'running', { trigger: 'test' });
    const rec = table.recorderFor(pid);
    const off = rec?.currentOffset ?? asSyscallOffset(0);
    table.setExitInfo(pid, code, reason, off);
    await table.setState(pid, 'exiting', { trigger: 'test-exit' });
    await table.setState(pid, 'zombie', { trigger: 'test-exit' });
    await init.handleZombie(pid, code, reason);
  }

  // The single living child of init (used right after a synchronous restart).
  function onlyChild(table: ProcessTable): ProcessIdAlias | undefined {
    const kids = table.children(PID_INIT);
    return kids.length === 1 ? kids[0] : undefined;
  }

  // --- constants ------------------------------------------------------------

  check('init constants', () => {
    assert(DEFAULT_BACKOFF_MS === 1000, 'default backoff is 1000ms');
    assert(MAX_BACKOFF_MS === 60_000, 'backoff capped at 60s');
    assert(MAX_BACKOFF_EXPONENT === 16, 'backoff exponent capped at 16');
    assert(DEFAULT_RESTART_WINDOW_MS === 60_000, 'default storm window is 1min');
    assert(DEFAULT_RESTART_STORM_THRESHOLD === 100, 'default storm threshold is 100');
    assert(
      'module' in INIT_AGENT_SPEC && INIT_AGENT_SPEC.module === 'cortex:init',
      'reserved init agent specifier',
    );
  });

  check('shouldRestartFromCode policy matrix', () => {
    assert(shouldRestartFromCode('always', 0) === true, 'always restarts on clean exit');
    assert(shouldRestartFromCode('always', 1) === true, 'always restarts on failure');
    assert(shouldRestartFromCode('on-failure', 0) === false, 'on-failure skips clean exit');
    assert(shouldRestartFromCode('on-failure', 1) === true, 'on-failure restarts on error');
    assert(
      shouldRestartFromCode('on-failure', 137) === true,
      'on-failure restarts on SIGKILL (128+9)',
    );
    assert(shouldRestartFromCode('never', 1) === false, 'never restarts');
  });

  // --- boot -----------------------------------------------------------------

  await checkAsync('boot allocates PID 1 in RUNNING with no parent', async () => {
    const table = await makeTable();
    const { init } = makeKernel(table);
    await init.boot();
    assert(init.booted, 'init reports booted');
    const entry = table.get(PID_INIT)!;
    assert(entry !== undefined, 'PID 1 exists in the table');
    assert(entry.state === 'running', 'init is RUNNING (hook-driven, never scheduled)');
    assert(entry.ppid === null, 'init has no parent');
    assert(entry.role === 'init', 'init role is "init"');
    assert(unbrand(entry.pgid) === unbrand(PID_INIT), 'init is its own process group');
  });

  await checkAsync('double boot traps EINVAL', async () => {
    const table = await makeTable();
    const { init } = makeKernel(table);
    await init.boot();
    let caught: unknown;
    try {
      await init.boot();
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught), 'second boot throws a CortexError');
    assert(caught.errno === 'EINVAL', `expected EINVAL, got ${caught.errno}`);
  });

  await checkAsync('registerDaemon before boot traps ESTATE', async () => {
    const table = await makeTable();
    const { init } = makeKernel(table);
    let caught: unknown;
    try {
      await init.registerDaemon({ role: 'd', agent });
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught), 'registerDaemon before boot throws');
    assert(caught.errno === 'ESTATE', `expected ESTATE, got ${caught.errno}`);
  });

  // --- daemon registration --------------------------------------------------

  await checkAsync('registerDaemon allocates a READY child of init (daemon + autoReap)', async () => {
    const table = await makeTable();
    const { init } = makeKernel(table);
    await init.boot();
    const spec: DaemonSpec = { role: 'inbox-watcher', agent, restart: { kind: 'on-failure' } };
    const pid = await init.registerDaemon(spec);
    assert(unbrand(pid) !== unbrand(PID_INIT), 'daemon is not PID 1');
    const entry = table.get(pid)!;
    assert(entry.state === 'ready', 'daemon left READY for the scheduler');
    assert(entry.ppid !== null && unbrand(entry.ppid) === unbrand(PID_INIT), 'parent is init');
    assert(entry.daemon === true, 'marked as a daemon');
    assert(entry.autoReap === true, 'init auto-reaps its daemons');
    assert(init.daemonCount === 1, 'one logical daemon registered');
  });

  // --- reaping and reparenting ---------------------------------------------

  await checkAsync('a zombie with a live parent is retained for wait()', async () => {
    const table = await makeTable();
    const { init, signals } = makeKernel(table);
    await init.boot();
    const parent = await alloc(table, { ppid: PID_INIT, role: 'parent' });
    const child = await alloc(table, { ppid: parent, role: 'child' });
    await signals.send(child, 'SIGKILL', PID_KERNEL);
    assert(table.has(child), 'child not reaped — a live parent will wait() for it');
    assert(table.get(child)!.state === 'zombie', 'child is a zombie');
    assert(table.has(parent), 'parent still alive');
  });

  await checkAsync('init reaps an inherited orphan-zombie immediately (no double-zombie)', async () => {
    const table = await makeTable();
    const { init, signals } = makeKernel(table);
    await init.boot();
    const parent = await alloc(table, { ppid: PID_INIT, role: 'parent' });
    const child = await alloc(table, { ppid: parent, role: 'child' });
    await signals.send(child, 'SIGKILL', PID_KERNEL); // child becomes a retained zombie
    assert(table.get(child)!.state === 'zombie', 'child zombied first');
    await signals.send(parent, 'SIGKILL', PID_KERNEL); // parent dies; init inherits child
    assert(!table.has(parent), 'parent reaped (child of init)');
    assert(!table.has(child), 'inherited zombie child reaped immediately by init');
  });

  await checkAsync('init reparents a LIVE orphan to PID 1 when its parent dies', async () => {
    const table = await makeTable();
    const { init, signals } = makeKernel(table);
    await init.boot();
    const parent = await alloc(table, { ppid: PID_INIT, role: 'parent' });
    const child = await alloc(table, { ppid: parent, role: 'child' });
    await signals.send(parent, 'SIGKILL', PID_KERNEL);
    assert(!table.has(parent), 'parent reaped');
    assert(table.has(child), 'live orphan survives');
    const c = table.get(child)!;
    assert(c.ppid !== null && unbrand(c.ppid) === unbrand(PID_INIT), 'orphan reparented to init');
    assert(c.state === 'ready', 'orphan still runnable');
  });

  await checkAsync('SIGCHLD is sent to the parent when a child zombifies', async () => {
    const table = await makeTable();
    const { init, signals } = makeKernel(table);
    await init.boot();
    const sent: Array<{ pid: number; signal: Signal }> = [];
    const origSend = signals.send.bind(signals);
    (signals as { send: typeof signals.send }).send = async (pid, signal, from) => {
      sent.push({ pid: unbrand(pid), signal });
      return origSend(pid, signal, from);
    };
    const parent = await alloc(table, { ppid: PID_INIT, role: 'parent' });
    const child = await alloc(table, { ppid: parent, role: 'child' });
    await signals.send(child, 'SIGKILL', PID_KERNEL);
    assert(
      sent.some((s) => s.signal === 'SIGCHLD' && s.pid === unbrand(parent)),
      'init delivered SIGCHLD to the parent',
    );
  });

  // --- restart policy -------------------------------------------------------

  await checkAsync('restart "always" re-spawns a killed daemon (fresh PID, READY)', async () => {
    const table = await makeTable();
    const { init, signals } = makeKernel(table);
    await init.boot();
    const d1 = await init.registerDaemon({
      role: 'd',
      agent,
      restart: { kind: 'always', backoffMs: 0 },
    });
    await signals.send(d1, 'SIGKILL', PID_KERNEL);
    assert(!table.has(d1), 'old daemon reaped');
    const d2 = onlyChild(table);
    assert(d2 !== undefined, 'exactly one daemon child after restart');
    assert(unbrand(d2!) !== unbrand(d1), 'restart mints a fresh PID');
    const e = table.get(d2!)!;
    assert(e.state === 'ready', 'restarted daemon is READY');
    assert(e.role === 'd', 'restarted daemon keeps its role');
    assert(init.daemonCount === 1, 'still one logical daemon');
  });

  await checkAsync('restart "on-failure" skips clean exit but restarts on error', async () => {
    const table = await makeTable();
    const { init } = makeKernel(table);
    await init.boot();
    const a = await init.registerDaemon({
      role: 'A',
      agent,
      restart: { kind: 'on-failure', backoffMs: 0 },
    });
    const b = await init.registerDaemon({
      role: 'B',
      agent,
      restart: { kind: 'on-failure', backoffMs: 0 },
    });
    await exitWithCode(init, table, a, 0, 'clean'); // success -> no restart
    await exitWithCode(init, table, b, 1, 'boom'); // failure -> restart
    assert(!table.has(a), 'A reaped');
    const kids = table.children(PID_INIT);
    assert(kids.length === 1, `only B restarted (got ${kids.length} children)`);
    assert(table.get(kids[0]!)!.role === 'B', 'the surviving child is B');
    assert(init.daemonCount === 2, 'two logical daemons remain registered');
  });

  await checkAsync('restart "never" does not re-spawn', async () => {
    const table = await makeTable();
    const { init, signals } = makeKernel(table);
    await init.boot();
    const d = await init.registerDaemon({ role: 'd', agent, restart: { kind: 'never' } });
    await signals.send(d, 'SIGKILL', PID_KERNEL);
    assert(!table.has(d), 'daemon reaped');
    assert(table.children(PID_INIT).length === 0, 'no restart under policy "never"');
    assert(init.daemonCount === 1, 'logical daemon record persists');
  });

  await checkAsync('maxRestarts caps total restarts and alarms', async () => {
    const table = await makeTable();
    const alarms: InitAlarm[] = [];
    const { init, signals } = makeKernel(table, { onAlarm: (a) => alarms.push(a) });
    await init.boot();
    let cur = await init.registerDaemon({
      role: 'd',
      agent,
      restart: { kind: 'always', backoffMs: 0, maxRestarts: 2 },
    });
    // Two restarts succeed...
    for (let i = 0; i < 2; i++) {
      await signals.send(cur, 'SIGKILL', PID_KERNEL);
      const next = onlyChild(table);
      assert(next !== undefined, `restart ${i + 1} happened`);
      cur = next!;
    }
    // ...the third death hits the cap.
    await signals.send(cur, 'SIGKILL', PID_KERNEL);
    assert(table.children(PID_INIT).length === 0, 'gave up after maxRestarts');
    const alarm = alarms.find((x) => x.kind === 'max-restarts');
    assert(alarm !== undefined, 'a max-restarts alarm fired');
    assert(
      alarm!.kind === 'max-restarts' && alarm!.restartCount === 2,
      'alarm reports the cap was reached at 2 restarts',
    );
  });

  await checkAsync('restart storm inside the window alarms and gives up', async () => {
    const table = await makeTable();
    const alarms: InitAlarm[] = [];
    const { init, signals } = makeKernel(table, {
      onAlarm: (a) => alarms.push(a),
      restartStormThreshold: 3,
    });
    await init.boot();
    let cur = await init.registerDaemon({
      role: 'd',
      agent,
      restart: { kind: 'always', backoffMs: 0 },
    });
    // Frozen clock: every restart lands in the same window. Threshold 3 means
    // the 4th death (3 already-recorded restarts in-window) trips the storm.
    for (let i = 0; i < 3; i++) {
      await signals.send(cur, 'SIGKILL', PID_KERNEL);
      const next = onlyChild(table);
      assert(next !== undefined, `restart ${i + 1} happened`);
      cur = next!;
    }
    await signals.send(cur, 'SIGKILL', PID_KERNEL);
    assert(table.children(PID_INIT).length === 0, 'storm gave up');
    assert(
      alarms.some((x) => x.kind === 'restart-storm'),
      'a restart-storm alarm fired',
    );
  });

  await checkAsync('storm window prunes old restarts (no false alarm)', async () => {
    const table = await makeTable();
    const alarms: InitAlarm[] = [];
    const { init, signals } = makeKernel(table, {
      onAlarm: (a) => alarms.push(a),
      restartStormThreshold: 3,
    });
    await init.boot();
    let cur = await init.registerDaemon({
      role: 'd',
      agent,
      restart: { kind: 'always', backoffMs: 0, windowMs: 1000 },
    });
    // Advance beyond the 1s window between each death so the sliding window
    // never accumulates 3 restarts.
    for (let i = 0; i < 4; i++) {
      await signals.send(cur, 'SIGKILL', PID_KERNEL);
      const next = onlyChild(table);
      assert(next !== undefined, `restart ${i + 1} happened despite prior deaths`);
      cur = next!;
      advance(2000);
    }
    assert(
      !alarms.some((x) => x.kind === 'restart-storm'),
      'no storm alarm when restarts are spread outside the window',
    );
  });

  await checkAsync('non-zero backoff defers the restart to a timer (exponential)', async () => {
    const table = await makeTable();
    const ft = makeFakeTimers();
    const { init, signals } = makeKernel(table, {
      setTimeoutFn: ft.setTimeoutFn,
      clearTimeoutFn: ft.clearTimeoutFn,
    });
    await init.boot();
    const d1 = await init.registerDaemon({
      role: 'd',
      agent,
      restart: { kind: 'always', backoffMs: 500 },
    });
    await signals.send(d1, 'SIGKILL', PID_KERNEL);
    assert(!table.has(d1), 'old daemon reaped');
    assert(table.children(PID_INIT).length === 0, 'restart not spawned yet (backoff pending)');
    assert(ft.timers.length === 1, 'one backoff timer armed');
    assert(ft.timers[0]!.ms === 500, `first backoff is 500ms (got ${ft.timers[0]!.ms})`);

    ft.fireAll();
    await drain();
    const d2 = onlyChild(table);
    assert(d2 !== undefined, 'daemon respawned after the timer fired');
    assert(table.get(d2!)!.state === 'ready', 'respawned daemon is READY');
    assert(ft.timers.length === 0, 'timer consumed');

    // Second death -> exponential growth: 500 * 2^1 = 1000ms.
    await signals.send(d2!, 'SIGKILL', PID_KERNEL);
    assert(ft.timers.length === 1, 'second backoff timer armed');
    assert(ft.timers[0]!.ms === 1000, `second backoff doubles to 1000ms (got ${ft.timers[0]!.ms})`);
  });

  // --- shutdown -------------------------------------------------------------

  await checkAsync('shutdown terminates living children; init stays RUNNING', async () => {
    const table = await makeTable();
    const { init } = makeKernel(table);
    await init.boot();
    const d = await init.registerDaemon({ role: 'd', agent, restart: { kind: 'never' } });
    const manual = await alloc(table, { ppid: PID_INIT, role: 'manual' });
    const report: ShutdownReport = await init.shutdown();
    assert(init.shuttingDown, 'init reports shutting down');
    assert(report.signalled.includes(unbrand(d)), 'daemon was signalled');
    assert(report.signalled.includes(unbrand(manual)), 'manual child was signalled');
    assert(!table.has(d), 'daemon terminated and reaped');
    assert(!table.has(manual), 'manual child terminated and reaped');
    assert(report.remaining.length === 0, 'no children remain');
    assert(table.get(PID_INIT)!.state === 'running', 'init itself never exits');
  });

  await checkAsync('shutdown cancels a pending restart timer', async () => {
    const table = await makeTable();
    const ft = makeFakeTimers();
    const { init, signals } = makeKernel(table, {
      setTimeoutFn: ft.setTimeoutFn,
      clearTimeoutFn: ft.clearTimeoutFn,
    });
    await init.boot();
    const d = await init.registerDaemon({
      role: 'd',
      agent,
      restart: { kind: 'always', backoffMs: 500 },
    });
    await signals.send(d, 'SIGKILL', PID_KERNEL); // arms a backoff timer
    assert(ft.timers.length === 1, 'a restart timer is pending');
    const report = await init.shutdown();
    assert(report.restartsCancelled === 1, 'shutdown cancelled the pending restart');
    assert(ft.timers.length === 0, 'timer cleared');
  });

  await checkAsync('shutdown is idempotent', async () => {
    const table = await makeTable();
    const { init } = makeKernel(table);
    await init.boot();
    await init.registerDaemon({ role: 'd', agent, restart: { kind: 'never' } });
    await init.shutdown();
    const second = await init.shutdown();
    assert(second.signalled.length === 0, 'second shutdown signals nothing');
    assert(init.shuttingDown, 'still shutting down');
  });

  // --- audit trail ----------------------------------------------------------

  await checkAsync('init writes __init audit records (boot/register/reap/restart)', async () => {
    const sub = join(tmp, 'init-records');
    await mkdir(sub, { recursive: true });
    const table = await makeTable({ record: true, dir: sub });
    const { init, signals } = makeKernel(table);
    await init.boot();
    const d = await init.registerDaemon({
      role: 'd',
      agent,
      restart: { kind: 'always', backoffMs: 0 },
    });
    await signals.send(d, 'SIGKILL', PID_KERNEL);

    const rec = table.recorderFor(PID_INIT)!;
    await rec.flush();
    const records: SyscallRecord[] = [];
    for await (const r of readRecords(rec.path)) records.push(r);
    const initRecs = records.filter((r) => r.syscall === '__init');
    const actions = initRecs.map((r) => (r.args as { action?: string }).action);
    assert(actions.includes('boot'), 'a boot record exists');
    assert(actions.includes('register-daemon'), 'a register-daemon record exists');
    assert(actions.includes('reap'), 'a reap record exists');
    assert(actions.includes('restart'), 'a restart record exists');
    assert(
      initRecs.every((r) => unbrand(r.pid) === unbrand(PID_INIT)),
      'all __init records are on PID 1 log',
    );
  });

  // --- cleanup --------------------------------------------------------------
  for (const t of tables) {
    for (const pid of t.pids()) {
      const rec = t.recorderFor(pid);
      if (rec !== null) await rec.close().catch(() => {});
    }
  }
  await rm(tmp, { recursive: true, force: true });
}

async function runDispatcherChecks(): Promise<void> {
  const { mkdtemp, rm, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const tmp = await mkdtemp(join(tmpdir(), 'cortex-smoke-disp-'));
  const tables: ProcessTable[] = [];

  let fakeNow = Date.UTC(2026, 0, 1, 0, 0, 0);
  const clock = () => new Date(fakeNow).toISOString();
  const advance = (ms = 1000) => {
    fakeNow += ms;
  };

  async function makeTable(opts: { record?: boolean; dir?: string } = {}): Promise<ProcessTable> {
    const dir = opts.dir ?? tmp;
    const record = opts.record ?? false;
    const t = new ProcessTable({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      ...(record ? { recorderFactory: async (pid) => Recorder.open({ pid, dir: join(dir, String(unbrand(pid))) }) } : {}),
    });
    tables.push(t);
    return t;
  }

  const agent = { module: './agents/noop.js' } as const;
  const priv: MemoryRegionPolicy = { kind: 'private', backing: 'inmem' };

  // Fake, manually-driven timers so `sleep` and driver timeouts are testable
  // without real delays.
  interface FakeTimerEntry {
    id: number;
    cb: () => void;
    ms: number;
  }
  function makeFakeTimers(): {
    timers: FakeTimerEntry[];
    setTimeoutFn: (cb: () => void, ms: number) => unknown;
    clearTimeoutFn: (handle: unknown) => void;
    fireAll: () => void;
  } {
    const timers: FakeTimerEntry[] = [];
    let nextId = 1;
    const setTimeoutFn = (cb: () => void, ms: number): unknown => {
      const id = nextId++;
      timers.push({ id, cb, ms });
      return id;
    };
    const clearTimeoutFn = (handle: unknown): void => {
      const id = handle as number;
      const idx = timers.findIndex((t) => t.id === id);
      if (idx >= 0) timers.splice(idx, 1);
    };
    const fireAll = (): void => {
      const pending = timers.splice(0, timers.length);
      for (const t of pending) t.cb();
    };
    return { timers, setTimeoutFn, clearTimeoutFn, fireAll };
  }

  // Let fire-and-forget promises (state recording, SIGXCPU delivery, unpark)
  // settle on the microtask/macrotask queue.
  const drain = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };

  // --- mock drivers ---------------------------------------------------------

  function fakeLLM(
    usage: { inputTokens: number; outputTokens: number; cachedTokens: number; usd: number },
    capture?: { ctx?: DriverContext },
  ): ILLMDriver {
    return {
      name: 'fake-llm',
      version: '0.0.0',
      abiCompat: KERNEL_ABI_VERSION,
      supportedModels: ['fake-model'],
      async call(_req, ctx) {
        if (capture !== undefined) capture.ctx = ctx;
        return {
          text: 'hello',
          toolCalls: [],
          finishReason: 'stop',
          usage,
          model: 'fake-model',
          driverVersion: '0.0.0',
        };
      },
      async close() {
        /* nothing */
      },
    };
  }

  function fakeTool(reversibility: Reversibility, opts: { staged?: boolean } = {}): {
    driver: IToolDriver;
    descriptor: ToolDescriptor;
  } {
    const descriptor: ToolDescriptor = {
      name: 'noop',
      description: 'a no-op tool',
      inputSchema: { type: 'object' },
      reversibility,
    };
    const driver: IToolDriver = {
      name: 'fake-tool',
      version: '0.0.0',
      abiCompat: KERNEL_ABI_VERSION,
      async listTools() {
        return [descriptor];
      },
      async invoke(name, args) {
        return { output: { name, args }, error: null, durationMs: 0, reversibility };
      },
      ...(opts.staged === true
        ? {
            async stage(name: string, args: unknown): Promise<StagedAction> {
              return { id: 'staged-1', tool: name, args, expiresAt: clock() };
            },
          }
        : {}),
      async close() {
        /* nothing */
      },
    };
    return { driver, descriptor };
  }

  // --- kernel wiring --------------------------------------------------------

  interface KernelOpts {
    record?: boolean;
    dir?: string;
    withMemory?: boolean;
    withIpc?: boolean;
    withInit?: boolean;
    withScheduler?: boolean;
    resolveLLM?: ResolveLLMHook;
    resolveTool?: ResolveToolHook;
    setTimeoutFn?: (cb: () => void, ms: number) => unknown;
    clearTimeoutFn?: (handle: unknown) => void;
    onBudgetExhausted?: (pid: ProcessIdAlias, kind: 'tokens' | 'usd' | 'wallTime') => void;
    random?: (opts?: RandomOptions) => number;
  }

  // Wire the kernel the way boot.ts will: signals <-> init via a deferred ref
  // (breaks the cycle), dispatcher on top holding every module.
  async function makeKernel(opts: KernelOpts = {}): Promise<{
    table: ProcessTable;
    signals: SignalManager;
    dispatcher: SyscallDispatcher;
    init: InitProcess | undefined;
    scheduler: Scheduler | undefined;
    memory: MemoryManager | undefined;
    ipc: IpcManager | undefined;
  }> {
    const table = await makeTable({
      ...(opts.record !== undefined ? { record: opts.record } : {}),
      ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
    });

    let initRef: InitProcess | undefined;
    const signals = new SignalManager({
      table,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      ...(opts.withInit === true
        ? { onZombie: (pid, code, reason) => initRef!.handleZombie(pid, code, reason) }
        : {}),
    });
    if (opts.withInit === true) {
      initRef = new InitProcess({
        table,
        signals,
        kernelAbiVersion: KERNEL_ABI_VERSION,
        now: clock,
      });
    }

    const scheduler =
      opts.withScheduler === true
        ? new Scheduler({
            table,
            signals,
            kernelAbiVersion: KERNEL_ABI_VERSION,
            now: clock,
            autoReconcile: false,
          })
        : undefined;

    const memory =
      opts.withMemory === true
        ? new MemoryManager({
            table,
            kernelAbiVersion: KERNEL_ABI_VERSION,
            now: clock,
            drivers: { inmem: new FakeMemoryDriver(clock, KERNEL_ABI_VERSION) },
          })
        : undefined;

    const ipc =
      opts.withIpc === true
        ? new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock, signals })
        : undefined;

    const dispatcher = new SyscallDispatcher({
      table,
      signals,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      ...(initRef !== undefined ? { init: initRef } : {}),
      ...(scheduler !== undefined ? { scheduler } : {}),
      ...(memory !== undefined ? { memory } : {}),
      ...(ipc !== undefined ? { ipc } : {}),
      ...(opts.resolveLLM !== undefined ? { resolveLLM: opts.resolveLLM } : {}),
      ...(opts.resolveTool !== undefined ? { resolveTool: opts.resolveTool } : {}),
      ...(opts.setTimeoutFn !== undefined ? { setTimeoutFn: opts.setTimeoutFn } : {}),
      ...(opts.clearTimeoutFn !== undefined ? { clearTimeoutFn: opts.clearTimeoutFn } : {}),
      ...(opts.onBudgetExhausted !== undefined
        ? { onBudgetExhausted: opts.onBudgetExhausted }
        : {}),
      ...(opts.random !== undefined ? { random: opts.random } : {}),
    });

    return { table, signals, dispatcher, init: initRef, scheduler, memory, ipc };
  }

  // Allocate a process and drive NEW -> READY -> RUNNING.
  async function running(
    table: ProcessTable,
    opts: {
      ppid?: ProcessIdAlias | null;
      role?: string;
      budgets?: Partial<BudgetLimits>;
      memory?: Readonly<Record<string, MemoryRegionPolicy>>;
    } = {},
  ): Promise<ProcessIdAlias> {
    const pid = await table.allocate({
      ppid: opts.ppid === undefined ? null : opts.ppid,
      role: opts.role ?? 'worker',
      agent,
      ...(opts.budgets !== undefined ? { budgets: opts.budgets } : {}),
      ...(opts.memory !== undefined ? { memory: opts.memory } : {}),
    });
    await table.setState(pid, 'ready', { trigger: 'test' });
    await table.setState(pid, 'running', { trigger: 'test' });
    advance();
    return pid;
  }

  // Drive a child to ZOMBIE without reaping (for the synchronous wait path).
  async function makeZombie(
    table: ProcessTable,
    pid: ProcessIdAlias,
    code: number,
    reason: string,
  ): Promise<void> {
    await table.setState(pid, 'ready', { trigger: 'test' });
    await table.setState(pid, 'running', { trigger: 'test' });
    table.setExitInfo(pid, code, reason, asSyscallOffset(0));
    await table.setState(pid, 'exiting', { trigger: 'test-exit' });
    await table.setState(pid, 'zombie', { trigger: 'test-exit' });
  }

  async function readLog(table: ProcessTable, pid: ProcessIdAlias): Promise<SyscallRecord[]> {
    const rec = table.recorderFor(pid);
    if (rec === null) return [];
    await rec.flush();
    const out: SyscallRecord[] = [];
    for await (const r of readRecords(rec.path)) out.push(r);
    return out;
  }

  // --- constants / policy tables -------------------------------------------

  check('dispatcher exports 24 syscall names, no duplicates', () => {
    assert(SYSCALL_NAMES.length === 24, `expected 24 syscalls, got ${SYSCALL_NAMES.length}`);
    const uniq = new Set(SYSCALL_NAMES);
    assert(uniq.size === SYSCALL_NAMES.length, 'duplicate syscall names');
    // The v1 promises from docs/ABI.md §9: capabilities (§9.2) and the
    // explicit channel lifecycle (§9.3).
    for (const s of [
      'acquire',
      'release',
      'caps',
      'channel_open',
      'channel_close',
    ] as const) {
      assert(SYSCALL_NAMES.includes(s), `missing syscall '${s}'`);
    }
  });

  check('policy tables cover every syscall exactly', () => {
    const allowedKeys = Object.keys(SYSCALL_ALLOWED_STATES).sort();
    const revKeys = Object.keys(SYSCALL_REVERSIBILITY).sort();
    const names = [...SYSCALL_NAMES].sort();
    assert(
      JSON.stringify(allowedKeys) === JSON.stringify(names),
      'SYSCALL_ALLOWED_STATES key set != SYSCALL_NAMES',
    );
    assert(
      JSON.stringify(revKeys) === JSON.stringify(names),
      'SYSCALL_REVERSIBILITY key set != SYSCALL_NAMES',
    );
    for (const n of SYSCALL_NAMES) {
      const states = SYSCALL_ALLOWED_STATES[n];
      assert(states.length > 0, `${n} has no allowed states`);
      const rev = SYSCALL_REVERSIBILITY[n];
      assert(
        rev === 'reversible' || rev === 'irreversible' || rev === 'idempotent',
        `${n} bad reversibility ${rev}`,
      );
    }
  });

  check('self-recorded / unrecorded sets are disjoint subsets of syscalls', () => {
    const nameSet = new Set<string>(SYSCALL_NAMES);
    for (const s of SELF_RECORDED_SYSCALLS) assert(nameSet.has(s), `${s} not a syscall`);
    for (const s of UNRECORDED_SYSCALLS) assert(nameSet.has(s), `${s} not a syscall`);
    for (const s of UNRECORDED_SYSCALLS) {
      assert(!SELF_RECORDED_SYSCALLS.has(s), `${s} both self-recorded and unrecorded`);
    }
    assert(UNRECORDED_SYSCALLS.has('budget'), 'budget is unrecorded');
    assert(SELF_RECORDED_SYSCALLS.has('memory_write'), 'memory_write is self-recorded');
  });

  check('killReversibility maps signals correctly', () => {
    assert(killReversibility('SIGKILL') === 'irreversible', 'SIGKILL irreversible');
    assert(killReversibility('SIGTERM') === 'irreversible', 'SIGTERM irreversible');
    assert(killReversibility('SIGSTOP') === 'irreversible', 'SIGSTOP irreversible');
    assert(killReversibility('SIGUSR1') === 'reversible', 'SIGUSR1 reversible');
    assert(killReversibility('SIGUSR2') === 'reversible', 'SIGUSR2 reversible');
    assert(killReversibility('SIGCONT') === 'reversible', 'SIGCONT reversible');
  });

  check('ProcessExitSignal + isProcessExitSignal', () => {
    const sig = new ProcessExitSignal(3, 'bye');
    assert(sig instanceof Error, 'is an Error');
    assert(!(sig instanceof CortexError), 'is NOT a CortexError');
    assert(sig.name === 'ProcessExitSignal', `wrong name ${sig.name}`);
    assert(sig.exitCode === 3, 'exitCode');
    assert(sig.exitReason === 'bye', 'exitReason');
    assert(isProcessExitSignal(sig), 'guard detects it');
    assert(!isProcessExitSignal(new Error('x')), 'guard rejects plain Error');
    assert(!isProcessExitSignal(new CortexError('EINVAL', 'x')), 'guard rejects CortexError');
    assert(!isProcessExitSignal(null), 'guard rejects null');
  });

  check('dispatcher default timeout constants', () => {
    assert(DEFAULT_LLM_TIMEOUT_MS === 60_000, 'llm timeout 60s');
    assert(DEFAULT_TOOL_TIMEOUT_MS === 30_000, 'tool timeout 30s');
  });

  // --- gates ----------------------------------------------------------------

  await checkAsync('invoke on an unknown pid traps ESRCH', async () => {
    const { dispatcher } = await makeKernel();
    let caught: unknown;
    try {
      await dispatcher.invoke(asProcessId(9999), 'now');
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught), 'throws a CortexError');
    assert(caught.errno === 'ESRCH', `expected ESRCH, got ${caught.errno}`);
  });

  await checkAsync('state gate traps ESTATE before any side effect', async () => {
    const { table, dispatcher } = await makeKernel();
    const pid = await table.allocate({ ppid: null, role: 'w', agent }); // NEW
    let caught: unknown;
    try {
      await dispatcher.invoke(pid, 'ps'); // ps requires RUNNING
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught), 'throws a CortexError');
    assert(caught.errno === 'ESTATE', `expected ESTATE, got ${caught.errno}`);
    assert(caught.details?.['currentState'] === 'new', 'details carry the current state');
  });

  await checkAsync('irreversible syscall in a forkable region traps EREVERSIBLE', async () => {
    const { table, dispatcher } = await makeKernel();
    const pid = await running(table);
    let caught: unknown;
    await dispatcher.runForkable(pid, async () => {
      assert(dispatcher.inForkableRegion(pid), 'inside the region');
      try {
        await dispatcher.invoke(pid, 'exit', 0); // exit is irreversible
      } catch (err) {
        caught = err;
      }
    });
    assert(isCortexError(caught), 'throws a CortexError');
    assert(caught.errno === 'EREVERSIBLE', `expected EREVERSIBLE, got ${caught.errno}`);
    const e = table.get(pid);
    assert(e !== undefined && e.state === 'running', 'process untouched (trap precedes routing)');
    assert(!dispatcher.inForkableRegion(pid), 'region closed after runForkable');
  });

  await checkAsync('forkable regions nest and lift only at the outermost close', async () => {
    const { table, dispatcher } = await makeKernel();
    const pid = await running(table);
    assert(!dispatcher.inForkableRegion(pid), 'outside before');
    await dispatcher.runForkable(pid, async () => {
      assert(dispatcher.inForkableRegion(pid), 'depth 1');
      await dispatcher.runForkable(pid, async () => {
        assert(dispatcher.inForkableRegion(pid), 'depth 2');
      });
      assert(dispatcher.inForkableRegion(pid), 'still depth 1');
    });
    assert(!dispatcher.inForkableRegion(pid), 'outside after');
  });

  // --- process control ------------------------------------------------------

  await checkAsync('spawn allocates a READY child parented to the caller', async () => {
    const { table, dispatcher } = await makeKernel();
    const parent = await running(table, { role: 'p' });
    const { pid: child } = await dispatcher.invoke(parent, 'spawn', { role: 'c', agent });
    const ce = table.get(child);
    assert(ce !== undefined, 'child exists');
    assert(ce.state === 'ready', 'child is READY (scheduler adopts it)');
    assert(ce.ppid !== null && unbrand(ce.ppid) === unbrand(parent), 'child ppid is the caller');
    assert(ce.role === 'c', 'child role');
  });

  await checkAsync('spawn enqueues the child when a scheduler is wired', async () => {
    const { table, dispatcher, scheduler } = await makeKernel({ withScheduler: true });
    const parent = await running(table);
    const { pid: child } = await dispatcher.invoke(parent, 'spawn', { role: 'c', agent });
    assert(scheduler !== undefined, 'scheduler wired');
    assert(scheduler.isQueued(child), 'child is on the run queue');
  });

  await checkAsync('spawn without an agent traps EINVAL', async () => {
    const { table, dispatcher } = await makeKernel();
    const parent = await running(table);
    let caught: unknown;
    try {
      await dispatcher.invoke(parent, 'spawn', { role: 'x' } as unknown as SpawnOptions);
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught), 'throws a CortexError');
    assert(caught.errno === 'EINVAL', `expected EINVAL, got ${caught.errno}`);
  });

  await checkAsync('ps lists processes and honours a state filter', async () => {
    const { table, dispatcher } = await makeKernel();
    const a = await running(table, { role: 'a' });
    await table.allocate({ ppid: null, role: 'b', agent }); // stays NEW
    const all = await dispatcher.invoke(a, 'ps');
    assert(all.length >= 2, `ps lists >= 2, got ${all.length}`);
    const news = await dispatcher.invoke(a, 'ps', { state: 'new' });
    assert(news.length >= 1, 'at least one NEW process');
    assert(news.every((p) => p.state === 'new'), 'filter returns only NEW');
  });

  await checkAsync('kill routes to signals (SIGSTOP stops the target)', async () => {
    const { table, dispatcher } = await makeKernel();
    const parent = await running(table, { role: 'p' });
    const child = await running(table, { ppid: parent, role: 'c' });
    await dispatcher.invoke(parent, 'kill', child, 'SIGSTOP');
    await drain();
    const ce = table.get(child);
    assert(ce !== undefined && ce.state === 'stopped', `child stopped, got ${ce?.state}`);
  });

  // --- exit + wait ----------------------------------------------------------

  await checkAsync('exit throws ProcessExitSignal and reaps the process', async () => {
    const { table, dispatcher } = await makeKernel();
    const pid = await running(table);
    let caught: unknown;
    try {
      await dispatcher.invoke(pid, 'exit', 0, 'done');
    } catch (err) {
      caught = err;
    }
    assert(isProcessExitSignal(caught), 'throws the exit sentinel');
    assert(caught.exitCode === 0, 'exit code 0');
    assert(caught.exitReason === 'done', 'exit reason');
    assert(table.get(pid) === undefined, 'process reaped after exit');
  });

  await checkAsync('exit walks NEW/READY up through RUNNING to ZOMBIE', async () => {
    const { table, dispatcher } = await makeKernel();
    const pid = await table.allocate({ ppid: null, role: 'w', agent });
    await table.setState(pid, 'ready', { trigger: 'test' });
    let caught: unknown;
    try {
      await dispatcher.invoke(pid, 'exit', 2, 'bye');
    } catch (err) {
      caught = err;
    }
    assert(isProcessExitSignal(caught), 'sentinel thrown from READY');
    assert(caught.exitCode === 2 && caught.exitReason === 'bye', 'code/reason preserved');
    assert(table.get(pid) === undefined, 'reaped');
  });

  await checkAsync('exit writes an irreversible exit record before teardown', async () => {
    const sub = join(tmp, 'rec-exit');
    await mkdir(sub, { recursive: true });
    const { table, dispatcher } = await makeKernel({ record: true, dir: sub });
    const pid = await running(table);
    const rec = table.recorderFor(pid);
    assert(rec !== null, 'recorder open');
    const path = rec.path;
    let caught: unknown;
    try {
      await dispatcher.invoke(pid, 'exit', 5, 'done');
    } catch (err) {
      caught = err;
    }
    assert(isProcessExitSignal(caught), 'sentinel thrown');
    const records: SyscallRecord[] = [];
    for await (const r of readRecords(path)) records.push(r);
    const exitRec = records.find((r) => r.syscall === 'exit' && r.phase === 'exit');
    assert(exitRec !== undefined, 'an exit record exists');
    assert((exitRec.result as { code: number }).code === 5, 'exit code recorded');
    assert(exitRec.reversibility === 'irreversible', 'exit is irreversible');
  });

  await checkAsync('wait with no children traps ECHILD', async () => {
    const { table, dispatcher } = await makeKernel();
    const pid = await running(table);
    let caught: unknown;
    try {
      await dispatcher.invoke(pid, 'wait');
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught), 'throws a CortexError');
    assert(caught.errno === 'ECHILD', `expected ECHILD, got ${caught.errno}`);
  });

  await checkAsync('wait on a non-child traps ESRCH', async () => {
    const { table, dispatcher } = await makeKernel();
    const a = await running(table, { role: 'a' });
    const b = await running(table, { role: 'b' });
    let caught: unknown;
    try {
      await dispatcher.invoke(a, 'wait', b); // b is not a's child
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught), 'throws a CortexError');
    assert(caught.errno === 'ESRCH', `expected ESRCH, got ${caught.errno}`);
  });

  await checkAsync('wait reaps an already-zombie child synchronously', async () => {
    const { table, dispatcher } = await makeKernel();
    const parent = await running(table, { role: 'p' });
    const child = await table.allocate({ ppid: parent, role: 'c', agent });
    await makeZombie(table, child, 7, 'boom');
    const res = await dispatcher.invoke(parent, 'wait', child);
    assert(res.exitCode === 7, `exit code 7, got ${res.exitCode}`);
    assert(res.exitReason === 'boom', 'exit reason');
    assert(table.get(child) === undefined, 'child reaped by wait');
  });

  await checkAsync('parked wait wakes when the child exits through the dispatcher', async () => {
    const { table, dispatcher } = await makeKernel();
    const parent = await running(table, { role: 'p' });
    const child = await running(table, { ppid: parent, role: 'c' });
    const waitP = dispatcher.invoke(parent, 'wait', child); // parks (not awaited)
    await drain(); // let the enter record land and the waiter register
    let caught: unknown;
    try {
      await dispatcher.invoke(child, 'exit', 3, 'crash');
    } catch (err) {
      caught = err;
    }
    assert(isProcessExitSignal(caught), 'child exit throws the sentinel');
    const res = await waitP;
    assert(res.exitCode === 3, `waited exit code 3, got ${res.exitCode}`);
    await drain();
    const pe = table.get(parent);
    assert(pe !== undefined && pe.state !== 'blocked', 'parent unparked from BLOCKED');
  });

  // --- memory routing -------------------------------------------------------

  await checkAsync('memory_write / memory_read route through the engine', async () => {
    const { table, dispatcher, memory } = await makeKernel({ withMemory: true });
    const pid = await running(table, { memory: { scratch: priv } });
    assert(memory !== undefined, 'memory wired');
    memory.syncFromTable(pid);
    await dispatcher.invoke(pid, 'memory_write', 'scratch', 'k1', { v: 1 });
    const entries = await dispatcher.invoke(pid, 'memory_read', 'scratch', { key: 'k1' });
    assert(entries.length === 1, `one entry, got ${entries.length}`);
    assert((entries[0].value as { v: number }).v === 1, 'value round-trips');
    assert(entries[0].region === 'scratch', 'logical region name preserved');
  });

  await checkAsync('memory_read with no engine traps EDRIVER', async () => {
    const { table, dispatcher } = await makeKernel();
    const pid = await running(table);
    let caught: unknown;
    try {
      await dispatcher.invoke(pid, 'memory_read', 'scratch', { key: 'k' });
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught), 'throws a CortexError');
    assert(caught.errno === 'EDRIVER', `expected EDRIVER, got ${caught.errno}`);
  });

  await checkAsync('self-recorded memory_write is logged exactly once', async () => {
    const sub = join(tmp, 'rec-mem');
    await mkdir(sub, { recursive: true });
    const { table, dispatcher, memory } = await makeKernel({
      withMemory: true,
      record: true,
      dir: sub,
    });
    const pid = await running(table, { memory: { scratch: priv } });
    assert(memory !== undefined, 'memory wired');
    memory.syncFromTable(pid);
    await dispatcher.invoke(pid, 'memory_write', 'scratch', 'k', 1);
    const records = await readLog(table, pid);
    const mw = records.filter((r) => r.syscall === 'memory_write');
    assert(mw.length === 1, `exactly one memory_write record, got ${mw.length}`);
    assert(mw[0].phase === 'exit', 'memory.ts owns the exit-phase record');
  });

  // --- ipc routing ----------------------------------------------------------

  await checkAsync('send / recv route through the ipc engine', async () => {
    const { table, dispatcher } = await makeKernel({ withIpc: true });
    const a = await running(table, { role: 'a' });
    const b = await running(table, { role: 'b' });
    await dispatcher.invoke(a, 'send', b, { hello: 'world' });
    const msg = await dispatcher.invoke(b, 'recv');
    assert((msg.body as { hello: string }).hello === 'world', 'body delivered');
    assert(unbrand(msg.from as ProcessIdAlias) === unbrand(a), 'from is the sender');
  });

  await checkAsync('send with no ipc engine traps EDRIVER', async () => {
    const { table, dispatcher } = await makeKernel();
    const a = await running(table, { role: 'a' });
    const b = await running(table, { role: 'b' });
    let caught: unknown;
    try {
      await dispatcher.invoke(a, 'send', b, { x: 1 });
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught), 'throws a CortexError');
    assert(caught.errno === 'EDRIVER', `expected EDRIVER, got ${caught.errno}`);
  });

  // --- llm_call -------------------------------------------------------------

  await checkAsync('llm_call routes to the resolved driver with a context', async () => {
    const capture: { ctx?: DriverContext } = {};
    const { table, dispatcher } = await makeKernel({
      resolveLLM: () => fakeLLM({ inputTokens: 1, outputTokens: 1, cachedTokens: 0, usd: 0 }, capture),
    });
    const pid = await running(table);
    const res = await dispatcher.invoke(pid, 'llm_call', {
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert(res.text === 'hello', 'response text');
    assert(res.finishReason === 'stop', 'finish reason');
    assert(capture.ctx !== undefined, 'driver received a context');
    assert(unbrand(capture.ctx.pid) === unbrand(pid), 'ctx.pid is the caller');
    assert(typeof capture.ctx.callId === 'string' && capture.ctx.callId.length > 0, 'ctx.callId');
    assert(capture.ctx.abortSignal instanceof AbortSignal, 'ctx.abortSignal');
    assert(capture.ctx.kernelAbiVersion === KERNEL_ABI_VERSION, 'ctx abi version');
  });

  await checkAsync('llm_call with no resolver traps EDRIVER', async () => {
    const { table, dispatcher } = await makeKernel();
    const pid = await running(table);
    let caught: unknown;
    try {
      await dispatcher.invoke(pid, 'llm_call', { messages: [] });
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught), 'throws a CortexError');
    assert(caught.errno === 'EDRIVER', `expected EDRIVER, got ${caught.errno}`);
  });

  // --- tool_call ------------------------------------------------------------

  await checkAsync('tool_call routes to the resolved driver', async () => {
    const { driver, descriptor } = fakeTool('reversible');
    const { table, dispatcher } = await makeKernel({
      resolveTool: (name) => (name === 'noop' ? { driver, descriptor } : undefined),
    });
    const pid = await running(table);
    const res = await dispatcher.invoke(pid, 'tool_call', 'noop', { x: 1 });
    assert(res.error === null, 'no error');
    assert((res.output as { name: string }).name === 'noop', 'tool name echoed');
    assert(res.reversibility === 'reversible', 'reversibility from the driver');
  });

  await checkAsync('tool_call for an unregistered tool traps ENOENT', async () => {
    const { driver, descriptor } = fakeTool('reversible');
    const { table, dispatcher } = await makeKernel({
      resolveTool: (name) => (name === 'noop' ? { driver, descriptor } : undefined),
    });
    const pid = await running(table);
    let caught: unknown;
    try {
      await dispatcher.invoke(pid, 'tool_call', 'missing', {});
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught), 'throws a CortexError');
    assert(caught.errno === 'ENOENT', `expected ENOENT, got ${caught.errno}`);
  });

  await checkAsync('tool_call with no resolver traps EDRIVER', async () => {
    const { table, dispatcher } = await makeKernel();
    const pid = await running(table);
    let caught: unknown;
    try {
      await dispatcher.invoke(pid, 'tool_call', 'noop', {});
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught), 'throws a CortexError');
    assert(caught.errno === 'EDRIVER', `expected EDRIVER, got ${caught.errno}`);
  });

  await checkAsync('irreversible tool_call inside a forkable region traps EREVERSIBLE', async () => {
    const { driver, descriptor } = fakeTool('irreversible');
    const { table, dispatcher } = await makeKernel({ resolveTool: () => ({ driver, descriptor }) });
    const pid = await running(table);
    let caught: unknown;
    await dispatcher.runForkable(pid, async () => {
      try {
        await dispatcher.invoke(pid, 'tool_call', 'noop', {});
      } catch (err) {
        caught = err;
      }
    });
    assert(isCortexError(caught), 'throws a CortexError');
    assert(caught.errno === 'EREVERSIBLE', `expected EREVERSIBLE, got ${caught.errno}`);
  });

  await checkAsync('tool_call stageOnly returns a staged action', async () => {
    const { driver, descriptor } = fakeTool('reversible', { staged: true });
    const { table, dispatcher } = await makeKernel({ resolveTool: () => ({ driver, descriptor }) });
    const pid = await running(table);
    const res = await dispatcher.invoke(pid, 'tool_call', 'noop', { x: 1 }, { stageOnly: true });
    assert((res.output as StagedAction).id === 'staged-1', 'staged action returned');
  });

  await checkAsync('tool_call stageOnly without driver support traps EINVAL', async () => {
    const { driver, descriptor } = fakeTool('reversible'); // no stage()
    const { table, dispatcher } = await makeKernel({ resolveTool: () => ({ driver, descriptor }) });
    const pid = await running(table);
    let caught: unknown;
    try {
      await dispatcher.invoke(pid, 'tool_call', 'noop', {}, { stageOnly: true });
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught), 'throws a CortexError');
    assert(caught.errno === 'EINVAL', `expected EINVAL, got ${caught.errno}`);
  });

  // --- budgets --------------------------------------------------------------

  await checkAsync('llm_call charges tokens and microdollars to the budget', async () => {
    const { table, dispatcher } = await makeKernel({
      resolveLLM: () =>
        fakeLLM({ inputTokens: 11, outputTokens: 22, cachedTokens: 33, usd: 0.5 }),
    });
    const pid = await running(table);
    await dispatcher.invoke(pid, 'llm_call', { messages: [] });
    const b = await dispatcher.invoke(pid, 'budget');
    assert(b.tokensIn === 11, `tokensIn 11, got ${b.tokensIn}`);
    assert(b.tokensOut === 22, `tokensOut 22, got ${b.tokensOut}`);
    assert(b.tokensCached === 33, `tokensCached 33, got ${b.tokensCached}`);
    assert(b.usdSpent === 500_000, `usdSpent 500000 microdollars, got ${b.usdSpent}`);
    // The budget snapshot is read during routing, before this call is accounted.
    assert(b.syscallCount === 1, `syscallCount 1 (the llm_call), got ${b.syscallCount}`);
  });

  await checkAsync('budget exhaustion fires SIGXCPU and the hook', async () => {
    let alarmed: string | null = null;
    const { table, dispatcher } = await makeKernel({
      resolveLLM: () => fakeLLM({ inputTokens: 100, outputTokens: 0, cachedTokens: 0, usd: 0 }),
      onBudgetExhausted: (_pid, kind) => {
        alarmed = kind;
      },
    });
    const pid = await running(table, { budgets: { tokens: 10 } });
    await dispatcher.invoke(pid, 'llm_call', { messages: [] });
    await drain();
    assert(alarmed === 'tokens', `onBudgetExhausted fired with tokens, got ${alarmed}`);
    const e = table.get(pid);
    assert(e !== undefined && e.state === 'stopped', `SIGXCPU stopped the process, got ${e?.state}`);
  });

  // --- time / determinism / signals -----------------------------------------

  await checkAsync('now and random serve the injected sources', async () => {
    const { table, dispatcher } = await makeKernel({ random: () => 0.42 });
    const pid = await running(table);
    const t = await dispatcher.invoke(pid, 'now');
    assert(t === clock(), 'now returns the injected clock');
    const r = await dispatcher.invoke(pid, 'random');
    assert(r === 0.42, `random returns the injected value, got ${r}`);
  });

  await checkAsync('sleep parks on the injected timer and rejects negative ms', async () => {
    const ft = makeFakeTimers();
    const { table, dispatcher } = await makeKernel({
      setTimeoutFn: ft.setTimeoutFn,
      clearTimeoutFn: ft.clearTimeoutFn,
    });
    const pid = await running(table);
    let done = false;
    const p = dispatcher.invoke(pid, 'sleep', 5000).then(() => {
      done = true;
    });
    await drain();
    assert(!done, 'sleep is pending until the timer fires');
    assert(ft.timers.length === 1, `one timer registered, got ${ft.timers.length}`);
    assert(ft.timers[0]?.ms === 5000, 'timer carries the requested ms');
    // The whole point of the fix: a sleeping process is BLOCKED, not RUNNING,
    // and it says what it is blocked on.
    const parked = table.get(pid);
    assert(parked?.state === 'blocked', `sleep parks the process, got ${parked?.state}`);
    assert(
      parked?.blockedOn?.kind === 'sleep',
      `blockedOn reports the timer, got ${parked?.blockedOn?.kind}`,
    );
    ft.fireAll();
    await p;
    assert(done, 'sleep resolved after the timer fired');
    // Waking is a scheduler event, not an inline one: the process comes back
    // READY with blockedOn cleared, and only a re-dispatch makes it RUNNING
    // again (the wake gate releases the body at that moment).
    const woken = table.get(pid);
    assert(woken?.state === 'ready', `a woken sleeper is READY, got ${woken?.state}`);
    assert(woken?.blockedOn === null, 'waking clears blockedOn');
    await table.setState(pid, 'running', { trigger: 'test' });

    let caught: unknown;
    try {
      await dispatcher.invoke(pid, 'sleep', -1);
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught), 'negative sleep throws');
    assert(caught.errno === 'EINVAL', `expected EINVAL, got ${caught.errno}`);
  });

  await checkAsync('on_signal installs ignore / default / handler dispositions', async () => {
    const { table, dispatcher } = await makeKernel();
    const pid = await running(table);
    await dispatcher.invoke(pid, 'on_signal', 'SIGUSR1', 'ignore');
    assert(table.getDisposition(pid, 'SIGUSR1').kind === 'ignore', 'ignore disposition');
    await dispatcher.invoke(pid, 'on_signal', 'SIGUSR1', 'default');
    assert(table.getDisposition(pid, 'SIGUSR1').kind === 'default', 'default disposition');
    const handler: SignalHandler = () => {};
    await dispatcher.invoke(pid, 'on_signal', 'SIGUSR2', handler);
    assert(table.getDisposition(pid, 'SIGUSR2').kind === 'handler', 'handler disposition');
  });

  // --- recording ------------------------------------------------------------

  await checkAsync('dispatcher-recorded syscall writes an enter + exit pair', async () => {
    const sub = join(tmp, 'rec-now');
    await mkdir(sub, { recursive: true });
    const { table, dispatcher } = await makeKernel({ record: true, dir: sub });
    const pid = await running(table);
    await dispatcher.invoke(pid, 'now');
    const records = await readLog(table, pid);
    const nowRecs = records.filter((r) => r.syscall === 'now');
    const phases = nowRecs.map((r) => r.phase);
    assert(phases.includes('enter'), 'an enter record exists');
    assert(phases.includes('exit'), 'an exit record exists');
    const exitRec = nowRecs.find((r) => r.phase === 'exit');
    assert(exitRec !== undefined && exitRec.reversibility === 'idempotent', 'now is idempotent');
  });

  await checkAsync('a routed failure writes a trap record with the errno', async () => {
    const sub = join(tmp, 'rec-trap');
    await mkdir(sub, { recursive: true });
    const { table, dispatcher } = await makeKernel({ record: true, dir: sub }); // no resolveTool
    const pid = await running(table);
    let caught: unknown;
    try {
      await dispatcher.invoke(pid, 'tool_call', 'noop', {});
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught) && caught.errno === 'EDRIVER', 'tool_call traps EDRIVER');
    const records = await readLog(table, pid);
    const tc = records.filter((r) => r.syscall === 'tool_call');
    assert(tc.some((r) => r.phase === 'enter'), 'enter record written before routing');
    const trapRec = tc.find((r) => r.phase === 'trap');
    assert(trapRec !== undefined, 'a trap record exists');
    assert(trapRec.error?.errno === 'EDRIVER', `trap errno EDRIVER, got ${trapRec.error?.errno}`);
  });

  await checkAsync('budget is never recorded', async () => {
    const sub = join(tmp, 'rec-budget');
    await mkdir(sub, { recursive: true });
    const { table, dispatcher } = await makeKernel({ record: true, dir: sub });
    const pid = await running(table);
    await dispatcher.invoke(pid, 'budget');
    const records = await readLog(table, pid);
    assert(!records.some((r) => r.syscall === 'budget'), 'no budget record exists');
  });

  // --- init integration -----------------------------------------------------

  await checkAsync('exit hands off to init.handleZombie without crashing', async () => {
    const { table, dispatcher, init } = await makeKernel({ withInit: true });
    assert(init !== undefined, 'init wired');
    await init.boot();
    const parent = await running(table, { role: 'p' });
    const { pid: child } = await dispatcher.invoke(parent, 'spawn', { role: 'c', agent });
    await table.setState(child, 'running', { trigger: 'test' });
    let caught: unknown;
    try {
      await dispatcher.invoke(child, 'exit', 0, 'done');
    } catch (err) {
      caught = err;
    }
    assert(isProcessExitSignal(caught), 'sentinel thrown');
    await drain();
    assert(table.get(child) === undefined, 'child reaped via the init handoff');
    assert(table.get(parent) !== undefined, 'parent survives');
  });

  // --- cleanup --------------------------------------------------------------
  for (const t of tables) {
    for (const pid of t.pids()) {
      const rec = t.recorderFor(pid);
      if (rec !== null) await rec.close().catch(() => {});
    }
  }
  await rm(tmp, { recursive: true, force: true });
}


async function runDriverRegistryChecks(): Promise<void> {
  // A fixed clock so any timestamp a driver stamps is deterministic.
  const clock = (): string => new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString();

  // --- local fake drivers (configurable names, unlike the module-scope
  //     FakeMemoryDriver which is hard-named 'inmem') -------------------------

  interface FakeLLMOpts {
    abiCompat?: string;
    models?: readonly string[];
    stream?: boolean;
    countTokens?: boolean;
    closeSpy?: { count: number; fail?: boolean };
  }
  function fakeLLM(name: string, opts: FakeLLMOpts = {}): ILLMDriver {
    const closeSpy = opts.closeSpy;
    const driver: ILLMDriver = {
      name,
      version: '1.0.0',
      abiCompat: opts.abiCompat ?? '^1.0.0',
      supportedModels: opts.models ?? ['m1'],
      async call(_req, ctx) {
        return {
          text: `from:${name}:${ctx.callId}`,
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 2, cachedTokens: 0, usd: 0 },
          model: (opts.models ?? ['m1'])[0] ?? 'm1',
          driverVersion: '1.0.0',
        };
      },
      async close() {
        if (closeSpy !== undefined) {
          closeSpy.count++;
          if (closeSpy.fail === true) throw new Error(`${name} close boom`);
        }
      },
    };
    // Optional capabilities must be *present or absent* to exercise listAll().
    if (opts.stream === true) {
      (driver as { stream?: ILLMDriver['stream'] }).stream = async function* () {
        yield { done: true };
      };
    }
    if (opts.countTokens === true) {
      (driver as { countTokens?: ILLMDriver['countTokens'] }).countTokens = async () => 42;
    }
    return driver;
  }

  interface FakeToolOpts {
    abiCompat?: string;
    tools?: readonly ToolDescriptor[];
    listToolsFail?: boolean;
    listToolsNonArray?: boolean;
    forkable?: boolean;
    twoPhase?: boolean;
    closeSpy?: { count: number; fail?: boolean };
  }
  function descriptor(toolName: string, reversibility: Reversibility): ToolDescriptor {
    return {
      name: toolName,
      description: `${toolName} tool`,
      inputSchema: { type: 'object' },
      reversibility,
    };
  }
  function fakeTool(name: string, opts: FakeToolOpts = {}): IToolDriver {
    const closeSpy = opts.closeSpy;
    const tools = opts.tools ?? [descriptor('noop', 'idempotent')];
    const driver: IToolDriver = {
      name,
      version: '1.0.0',
      abiCompat: opts.abiCompat ?? '^1.0.0',
      async listTools() {
        if (opts.listToolsFail === true) throw new Error(`${name} listTools boom`);
        if (opts.listToolsNonArray === true) return undefined as unknown as ToolDescriptor[];
        return tools;
      },
      async invoke(toolName, args) {
        return { output: { toolName, args }, error: null, durationMs: 0, reversibility: 'idempotent' };
      },
      async close() {
        if (closeSpy !== undefined) {
          closeSpy.count++;
          if (closeSpy.fail === true) throw new Error(`${name} close boom`);
        }
      },
    };
    if (opts.forkable === true) (driver as { forkable?: boolean }).forkable = true;
    if (opts.twoPhase === true) {
      (driver as { stage?: IToolDriver['stage'] }).stage = async (toolName, args) => ({
        id: 'staged-1',
        tool: toolName,
        args,
        expiresAt: clock(),
      });
      (driver as { commit?: IToolDriver['commit'] }).commit = async () => ({
        output: null,
        error: null,
        durationMs: 0,
        reversibility: 'idempotent',
      });
    }
    return driver;
  }

  interface FakeMemOpts {
    abiCompat?: string;
    closeSpy?: { count: number; fail?: boolean };
  }
  function fakeMem(name: string, opts: FakeMemOpts = {}): IMemoryDriver {
    const closeSpy = opts.closeSpy;
    const store = new Map<string, unknown>();
    return {
      name,
      version: '1.0.0',
      abiCompat: opts.abiCompat ?? '^1.0.0',
      async read() {
        return [];
      },
      async write(_region, key, value) {
        store.set(key, value);
      },
      async delete(_region, key) {
        store.delete(key);
      },
      async listRegions() {
        return [];
      },
      async snapshotRegion() {
        return new Uint8Array(0);
      },
      async restoreRegion() {
        /* noop */
      },
      async close() {
        if (closeSpy !== undefined) {
          closeSpy.count++;
          if (closeSpy.fail === true) throw new Error(`${name} close boom`);
        }
      },
    };
  }

  function makeRegistry(opts: { defaultLLM?: string; defaultMemory?: string; onCloseError?: (n: string, e: unknown) => void } = {}): DriverRegistry {
    return new DriverRegistry({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      ...(opts.defaultLLM !== undefined ? { defaultLLM: opts.defaultLLM } : {}),
      ...(opts.defaultMemory !== undefined ? { defaultMemory: opts.defaultMemory } : {}),
      ...(opts.onCloseError !== undefined ? { onCloseError: opts.onCloseError } : {}),
    });
  }

  // --- §1 semver subset -----------------------------------------------------

  check('parseSemver parses full / partial / leading-v', () => {
    const a = parseSemver('1.2.3');
    assert(a !== null && a.major === 1 && a.minor === 2 && a.patch === 3, 'full parse');
    const b = parseSemver('1.2');
    assert(b !== null && b.patch === 0, 'partial -> patch 0');
    const c = parseSemver('2');
    assert(c !== null && c.minor === 0 && c.patch === 0, 'major-only');
    const d = parseSemver('v1.0.0');
    assert(d !== null && d.major === 1, 'leading v');
    const e = parseSemver('1.0.0-beta.1');
    assert(e !== null && e.patch === 0, 'prerelease stripped');
  });

  check('parseSemver returns null on garbage', () => {
    assert(parseSemver('nope') === null, 'non-numeric -> null');
    assert(parseSemver('') === null, 'empty -> null');
  });

  check('satisfiesAbi: exact match', () => {
    assert(satisfiesAbi('1.0.0', '1.0.0') === true, 'exact hit');
    assert(satisfiesAbi('1.0.1', '1.0.0') === false, 'exact miss');
    assert(satisfiesAbi('1.0.0', '=1.0.0') === true, 'explicit =');
  });

  check('satisfiesAbi: caret within major', () => {
    assert(satisfiesAbi('1.0.0', '^1.0.0') === true, 'floor');
    assert(satisfiesAbi('1.9.9', '^1.0.0') === true, 'same major');
    assert(satisfiesAbi('2.0.0', '^1.0.0') === false, 'next major rejected');
    assert(satisfiesAbi('0.9.9', '^1.0.0') === false, 'below floor rejected');
  });

  check('satisfiesAbi: caret 0.x uses minor as the breaking axis', () => {
    assert(satisfiesAbi('0.2.3', '^0.2.0') === true, 'same minor');
    assert(satisfiesAbi('0.3.0', '^0.2.0') === false, 'next minor rejected');
  });

  check('satisfiesAbi: caret 0.0.x uses patch as the breaking axis', () => {
    assert(satisfiesAbi('0.0.3', '^0.0.3') === true, 'same patch');
    assert(satisfiesAbi('0.0.4', '^0.0.3') === false, 'next patch rejected');
  });

  check('satisfiesAbi: tilde within minor', () => {
    assert(satisfiesAbi('1.2.3', '~1.2.0') === true, 'same minor');
    assert(satisfiesAbi('1.2.99', '~1.2.0') === true, 'patch floats');
    assert(satisfiesAbi('1.3.0', '~1.2.0') === false, 'next minor rejected');
  });

  check('satisfiesAbi: inequality comparators', () => {
    assert(satisfiesAbi('1.5.0', '>=1.0.0') === true, '>= hit');
    assert(satisfiesAbi('1.0.0', '>1.0.0') === false, '> strict miss');
    assert(satisfiesAbi('1.0.1', '>1.0.0') === true, '> hit');
    assert(satisfiesAbi('1.0.0', '<=1.0.0') === true, '<= hit');
    assert(satisfiesAbi('0.9.0', '<1.0.0') === true, '< hit');
  });

  check('satisfiesAbi: wildcard ranges match anything', () => {
    assert(satisfiesAbi('9.9.9', '*') === true, '* matches');
    assert(satisfiesAbi('9.9.9', 'x') === true, 'x matches');
    assert(satisfiesAbi('9.9.9', '') === true, 'empty matches');
    assert(satisfiesAbi('9.9.9', '   ') === true, 'whitespace matches');
  });

  check('satisfiesAbi: AND (whitespace) intersects comparators', () => {
    assert(satisfiesAbi('1.5.0', '>=1.0.0 <2.0.0') === true, 'inside both');
    assert(satisfiesAbi('2.5.0', '>=1.0.0 <2.0.0') === false, 'outside upper');
  });

  check('satisfiesAbi: a space after a comparator operator is admitted', () => {
    // `>= 1.0.0` is the most standard npm spelling; the range set must not be
    // split into ['>=','1.0.0'] and rejected (which refused legit drivers).
    assert(satisfiesAbi('1.0.0', '>= 1.0.0') === true, 'spaced >= hit');
    assert(satisfiesAbi('1.0.0', '< 2.0.0') === true, 'spaced < hit');
    assert(satisfiesAbi('2.1.0', '^1.0.0 || >= 2.0.0') === true, 'spaced OR second set');
    assert(satisfiesAbi('1.5.0', '>= 1.0.0 < 2.0.0') === true, 'spaced AND inside both');
  });

  check('satisfiesAbi: OR (||) unions range sets', () => {
    assert(satisfiesAbi('1.0.0', '^1.0.0 || ^3.0.0') === true, 'first set');
    assert(satisfiesAbi('3.1.0', '^1.0.0 || ^3.0.0') === true, 'second set');
    assert(satisfiesAbi('2.0.0', '^1.0.0 || ^3.0.0') === false, 'neither set');
  });

  check('satisfiesAbi: unparseable range returns false', () => {
    assert(satisfiesAbi('1.0.0', 'not-a-range') === false, 'garbage range');
    assert(satisfiesAbi('1.0.0', '^') === false, 'operator with no version');
  });

  check('satisfiesAbi admits the live kernel ABI under ^1.0.0', () => {
    assert(satisfiesAbi(KERNEL_ABI_VERSION, '^1.0.0') === true, 'kernel ABI is 1.x');
  });

  // --- §2 construction ------------------------------------------------------

  check('constructor rejects an empty kernelAbiVersion (EINVAL)', () => {
    let caught: unknown;
    try {
      new DriverRegistry({ kernelAbiVersion: '' });
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught) && caught.errno === 'EINVAL', 'expected EINVAL');
  });

  // --- §3 LLM drivers -------------------------------------------------------

  check('registerLLM + resolveLLM by name', () => {
    const reg = makeRegistry();
    reg.registerLLM(fakeLLM('alpha'));
    assert(reg.resolveLLM('alpha').name === 'alpha', 'resolved by name');
    assert(reg.hasLLM('alpha') === true, 'hasLLM true');
    assert(reg.hasLLM('beta') === false, 'hasLLM false');
  });

  check('first registered LLM becomes the default', () => {
    const reg = makeRegistry();
    reg.registerLLM(fakeLLM('alpha'));
    reg.registerLLM(fakeLLM('beta'));
    assert(reg.defaultLLM === 'alpha', 'default is the first');
    assert(reg.resolveLLM().name === 'alpha', 'resolveLLM(undefined) -> default');
  });

  check('explicit defaultLLM option is honored', () => {
    const reg = makeRegistry({ defaultLLM: 'beta' });
    reg.registerLLM(fakeLLM('alpha'));
    reg.registerLLM(fakeLLM('beta'));
    assert(reg.defaultLLM === 'beta', 'configured default kept');
    assert(reg.resolveLLM().name === 'beta', 'resolves configured default');
  });

  check('registerLLM duplicate name traps EINVAL', () => {
    const reg = makeRegistry();
    reg.registerLLM(fakeLLM('alpha'));
    let caught: unknown;
    try {
      reg.registerLLM(fakeLLM('alpha'));
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught) && caught.errno === 'EINVAL', 'expected EINVAL');
  });

  check('registerLLM incompatible abiCompat traps EDRIVER', () => {
    const reg = makeRegistry();
    let caught: unknown;
    try {
      reg.registerLLM(fakeLLM('future', { abiCompat: '^2.0.0' }));
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught) && caught.errno === 'EDRIVER', 'expected EDRIVER');
    assert(reg.hasLLM('future') === false, 'refused driver not registered');
  });

  check('resolveLLM unknown name traps EDRIVER', () => {
    const reg = makeRegistry();
    reg.registerLLM(fakeLLM('alpha'));
    let caught: unknown;
    try {
      reg.resolveLLM('ghost');
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught) && caught.errno === 'EDRIVER', 'expected EDRIVER');
  });

  check('resolveLLM with no default and empty registry traps EDRIVER', () => {
    const reg = makeRegistry();
    let caught: unknown;
    try {
      reg.resolveLLM();
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught) && caught.errno === 'EDRIVER', 'expected EDRIVER');
  });

  check('tryResolveLLM is non-throwing', () => {
    const reg = makeRegistry();
    reg.registerLLM(fakeLLM('alpha'));
    assert(reg.tryResolveLLM('ghost') === undefined, 'unknown -> undefined');
    assert(reg.tryResolveLLM('alpha')?.name === 'alpha', 'known -> driver');
    assert(reg.tryResolveLLM()?.name === 'alpha', 'undefined -> default');
  });

  check('setDefaultLLM validates registration', () => {
    const reg = makeRegistry();
    reg.registerLLM(fakeLLM('alpha'));
    reg.registerLLM(fakeLLM('beta'));
    let caught: unknown;
    try {
      reg.setDefaultLLM('ghost');
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught) && caught.errno === 'EINVAL', 'unregistered default -> EINVAL');
    reg.setDefaultLLM('beta');
    assert(reg.resolveLLM().name === 'beta', 'default switched');
    reg.setDefaultLLM(null);
    assert(reg.defaultLLM === null, 'default cleared');
  });

  check('llmResolver() returns a working ResolveLLMHook', () => {
    const reg = makeRegistry();
    reg.registerLLM(fakeLLM('alpha'));
    const hook = reg.llmResolver();
    assert(typeof hook === 'function', 'hook is a function');
    assert(hook('alpha').name === 'alpha', 'hook resolves by name');
    assert(hook(undefined).name === 'alpha', 'hook resolves default');
  });

  // --- §4 tool drivers ------------------------------------------------------

  await checkAsync('registerTool caches descriptors; resolveTool finds them', async () => {
    const reg = makeRegistry();
    await reg.registerTool(
      fakeTool('fs', { tools: [descriptor('read', 'idempotent'), descriptor('write', 'reversible')] }),
    );
    const r = reg.resolveTool('read');
    assert(r !== undefined, 'read resolved');
    assert(r.driver.name === 'fs', 'owning driver');
    assert(r.descriptor.reversibility === 'idempotent', 'descriptor cached');
    assert(reg.resolveTool('write')?.descriptor.reversibility === 'reversible', 'second tool');
    assert(reg.hasTool('read') && reg.hasToolDriver('fs'), 'introspection');
  });

  await checkAsync('resolveTool unknown -> undefined', async () => {
    const reg = makeRegistry();
    await reg.registerTool(fakeTool('fs'));
    assert(reg.resolveTool('nope') === undefined, 'unknown tool');
  });

  await checkAsync('registerTool duplicate driver name traps EINVAL', async () => {
    const reg = makeRegistry();
    await reg.registerTool(fakeTool('fs'));
    let caught: unknown;
    try {
      await reg.registerTool(fakeTool('fs'));
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught) && caught.errno === 'EINVAL', 'expected EINVAL');
  });

  await checkAsync('registerTool tool-name collision across drivers traps EINVAL', async () => {
    const reg = makeRegistry();
    await reg.registerTool(fakeTool('fs', { tools: [descriptor('read', 'idempotent')] }));
    let caught: unknown;
    try {
      await reg.registerTool(fakeTool('net', { tools: [descriptor('read', 'idempotent')] }));
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught) && caught.errno === 'EINVAL', 'expected EINVAL');
    assert(isCortexError(caught) && caught.details?.['registeredBy'] === 'fs', 'names the owner');
    assert(reg.hasToolDriver('net') === false, 'colliding driver not registered');
  });

  await checkAsync('registerTool same tool twice within one driver traps EINVAL', async () => {
    const reg = makeRegistry();
    let caught: unknown;
    try {
      await reg.registerTool(
        fakeTool('dupe', { tools: [descriptor('x', 'idempotent'), descriptor('x', 'reversible')] }),
      );
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught) && caught.errno === 'EINVAL', 'expected EINVAL');
  });

  await checkAsync('registerTool incompatible abiCompat traps EDRIVER', async () => {
    const reg = makeRegistry();
    let caught: unknown;
    try {
      await reg.registerTool(fakeTool('fs', { abiCompat: '^2.0.0' }));
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught) && caught.errno === 'EDRIVER', 'expected EDRIVER');
  });

  await checkAsync('registerTool listTools() throwing traps EDRIVER', async () => {
    const reg = makeRegistry();
    let caught: unknown;
    try {
      await reg.registerTool(fakeTool('broken', { listToolsFail: true }));
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught) && caught.errno === 'EDRIVER', 'expected EDRIVER');
  });

  await checkAsync('registerTool listTools() non-array traps EDRIVER', async () => {
    const reg = makeRegistry();
    let caught: unknown;
    try {
      await reg.registerTool(fakeTool('broken', { listToolsNonArray: true }));
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught) && caught.errno === 'EDRIVER', 'expected EDRIVER');
  });

  await checkAsync('registerTool malformed descriptor traps EDRIVER', async () => {
    const reg = makeRegistry();
    let caught: unknown;
    try {
      await reg.registerTool(
        fakeTool('broken', { tools: [{ name: '', description: '', inputSchema: { type: 'object' }, reversibility: 'idempotent' }] }),
      );
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught) && caught.errno === 'EDRIVER', 'expected EDRIVER');
  });

  await checkAsync('registerTool is atomic: a collision leaves prior state intact', async () => {
    const reg = makeRegistry();
    await reg.registerTool(fakeTool('fs', { tools: [descriptor('read', 'idempotent')] }));
    try {
      await reg.registerTool(
        fakeTool('mixed', { tools: [descriptor('ok', 'idempotent'), descriptor('read', 'idempotent')] }),
      );
    } catch {
      /* expected */
    }
    assert(reg.hasToolDriver('mixed') === false, 'failed driver absent');
    assert(reg.hasTool('ok') === false, 'no partial tool leaked');
    assert(reg.resolveTool('read')?.driver.name === 'fs', 'pre-existing tool intact');
  });

  await checkAsync('toolResolver() returns a working ResolveToolHook', async () => {
    const reg = makeRegistry();
    await reg.registerTool(fakeTool('fs', { tools: [descriptor('read', 'idempotent')] }));
    const hook = reg.toolResolver();
    assert(typeof hook === 'function', 'hook is a function');
    assert(hook('read')?.driver.name === 'fs', 'hook resolves tool');
    assert(hook('ghost') === undefined, 'hook returns undefined for unknown');
  });

  await checkAsync('toolNames / toolDriverNames list registrations', async () => {
    const reg = makeRegistry();
    await reg.registerTool(fakeTool('fs', { tools: [descriptor('read', 'idempotent'), descriptor('write', 'reversible')] }));
    await reg.registerTool(fakeTool('net', { tools: [descriptor('fetch', 'irreversible')] }));
    const drivers = reg.toolDriverNames();
    assert(drivers.includes('fs') && drivers.includes('net'), 'both drivers listed');
    const tools = reg.toolNames();
    assert(tools.includes('read') && tools.includes('write') && tools.includes('fetch'), 'all tools listed');
  });

  // --- §5 memory drivers ----------------------------------------------------

  check('registerMemory + resolveMemory by name', () => {
    const reg = makeRegistry();
    reg.registerMemory(fakeMem('inmem'));
    assert(reg.resolveMemory('inmem').name === 'inmem', 'resolved by name');
    assert(reg.hasMemory('inmem') === true, 'hasMemory');
  });

  check('first registered memory driver becomes the default', () => {
    const reg = makeRegistry();
    reg.registerMemory(fakeMem('inmem'));
    reg.registerMemory(fakeMem('sqlite'));
    assert(reg.defaultMemory === 'inmem', 'default is the first');
    assert(reg.resolveMemory().name === 'inmem', 'resolveMemory(undefined) -> default');
  });

  check('registerMemory duplicate name traps EINVAL', () => {
    const reg = makeRegistry();
    reg.registerMemory(fakeMem('inmem'));
    let caught: unknown;
    try {
      reg.registerMemory(fakeMem('inmem'));
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught) && caught.errno === 'EINVAL', 'expected EINVAL');
  });

  check('registerMemory incompatible abiCompat traps EDRIVER', () => {
    const reg = makeRegistry();
    let caught: unknown;
    try {
      reg.registerMemory(fakeMem('inmem', { abiCompat: '^2.0.0' }));
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught) && caught.errno === 'EDRIVER', 'expected EDRIVER');
  });

  check('resolveMemory unknown traps EDRIVER; tryResolveMemory is soft', () => {
    const reg = makeRegistry();
    reg.registerMemory(fakeMem('inmem'));
    let caught: unknown;
    try {
      reg.resolveMemory('ghost');
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught) && caught.errno === 'EDRIVER', 'expected EDRIVER');
    assert(reg.tryResolveMemory('ghost') === undefined, 'soft unknown');
    assert(reg.tryResolveMemory('inmem')?.name === 'inmem', 'soft known');
  });

  check('memoryDrivers() exposes all drivers for boot wiring', () => {
    const reg = makeRegistry();
    reg.registerMemory(fakeMem('inmem'));
    reg.registerMemory(fakeMem('sqlite'));
    const names = reg.memoryDrivers().map((d) => d.name);
    assert(names.includes('inmem') && names.includes('sqlite'), 'both returned');
    assert(reg.memoryNames().length === 2, 'memoryNames matches');
  });

  check('setDefaultMemory validates registration', () => {
    const reg = makeRegistry();
    reg.registerMemory(fakeMem('inmem'));
    reg.registerMemory(fakeMem('sqlite'));
    let caught: unknown;
    try {
      reg.setDefaultMemory('ghost');
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught) && caught.errno === 'EINVAL', 'unregistered -> EINVAL');
    reg.setDefaultMemory('sqlite');
    assert(reg.resolveMemory().name === 'sqlite', 'default switched');
  });

  // --- §6 listAll manifest --------------------------------------------------

  await checkAsync('listAll reports drivers with capability flags', async () => {
    const reg = makeRegistry();
    reg.registerLLM(fakeLLM('alpha', { models: ['m1', 'm2'], stream: true }));
    reg.registerLLM(fakeLLM('plain'));
    reg.registerMemory(fakeMem('inmem'));
    await reg.registerTool(fakeTool('fs', { tools: [descriptor('read', 'idempotent')], forkable: true, twoPhase: true }));

    const manifest: DriverManifest = reg.listAll();
    assert(manifest.llm.length === 2, 'two llm drivers');
    const alpha = manifest.llm.find((d) => d.name === 'alpha');
    assert(alpha !== undefined, 'alpha present');
    assert(alpha.isDefault === true, 'first llm is default');
    assert(alpha.supportedModels.includes('m2'), 'models surfaced');
    assert(alpha.streams === true && alpha.countsTokens === false, 'capability flags');
    const plain = manifest.llm.find((d) => d.name === 'plain');
    assert(plain !== undefined && plain.isDefault === false && plain.streams === false, 'plain flags');

    assert(manifest.memory.length === 1 && manifest.memory[0].isDefault === true, 'memory default');

    assert(manifest.tools.length === 1, 'one tool driver');
    const fs = manifest.tools[0];
    assert(fs.name === 'fs' && fs.tools.includes('read'), 'tool grouped under driver');
    assert(fs.forkable === true && fs.twoPhase === true, 'forkable + twoPhase flags');
  });

  await checkAsync('listAll groups tools under their owning driver', async () => {
    const reg = makeRegistry();
    await reg.registerTool(fakeTool('fs', { tools: [descriptor('read', 'idempotent'), descriptor('write', 'reversible')] }));
    await reg.registerTool(fakeTool('net', { tools: [descriptor('fetch', 'irreversible')] }));
    const manifest = reg.listAll();
    const fs = manifest.tools.find((d: ToolDriverInfo) => d.name === 'fs');
    const net = manifest.tools.find((d: ToolDriverInfo) => d.name === 'net');
    assert(fs !== undefined && fs.tools.length === 2, 'fs owns two tools');
    assert(net !== undefined && net.tools.length === 1 && net.tools[0] === 'fetch', 'net owns fetch');
  });

  // --- §7 unregister --------------------------------------------------------

  await checkAsync('unregisterLLM closes + removes + reassigns default', async () => {
    const reg = makeRegistry();
    const spy = { count: 0 };
    reg.registerLLM(fakeLLM('alpha', { closeSpy: spy }));
    reg.registerLLM(fakeLLM('beta'));
    const removed = await reg.unregisterLLM('alpha');
    assert(removed === true, 'removed true');
    assert(spy.count === 1, 'close called once');
    assert(reg.hasLLM('alpha') === false, 'gone');
    assert(reg.defaultLLM === 'beta', 'default reassigned to a survivor');
    assert((await reg.unregisterLLM('ghost')) === false, 'unknown -> false');
  });

  await checkAsync('unregisterTool drops the cached tool descriptors', async () => {
    const reg = makeRegistry();
    await reg.registerTool(fakeTool('fs', { tools: [descriptor('read', 'idempotent')] }));
    assert(reg.resolveTool('read') !== undefined, 'present before');
    const removed = await reg.unregisterTool('fs');
    assert(removed === true, 'removed true');
    assert(reg.resolveTool('read') === undefined, 'tool cache dropped');
    assert(reg.hasToolDriver('fs') === false, 'driver gone');
  });

  await checkAsync('unregisterMemory closes + removes + reassigns default', async () => {
    const reg = makeRegistry();
    const spy = { count: 0 };
    reg.registerMemory(fakeMem('inmem', { closeSpy: spy }));
    reg.registerMemory(fakeMem('sqlite'));
    assert((await reg.unregisterMemory('inmem')) === true, 'removed');
    assert(spy.count === 1, 'close called');
    assert(reg.defaultMemory === 'sqlite', 'default reassigned');
    assert((await reg.unregisterMemory('ghost')) === false, 'unknown -> false');
  });

  // --- §8 closeAll ----------------------------------------------------------

  await checkAsync('closeAll closes every driver and empties the registry', async () => {
    const reg = makeRegistry();
    const llmSpy = { count: 0 };
    const toolSpy = { count: 0 };
    const memSpy = { count: 0 };
    reg.registerLLM(fakeLLM('alpha', { closeSpy: llmSpy }));
    await reg.registerTool(fakeTool('fs', { closeSpy: toolSpy }));
    reg.registerMemory(fakeMem('inmem', { closeSpy: memSpy }));

    await reg.closeAll();
    assert(llmSpy.count === 1 && toolSpy.count === 1 && memSpy.count === 1, 'all closed');
    assert(reg.llmNames().length === 0, 'llm cleared');
    assert(reg.toolDriverNames().length === 0, 'tools cleared');
    assert(reg.memoryNames().length === 0, 'memory cleared');
    assert(reg.toolNames().length === 0, 'tool cache cleared');
    assert(reg.defaultLLM === null && reg.defaultMemory === null, 'defaults cleared');
    assert(reg.closed === true, 'closed flag set');
  });

  await checkAsync('closeAll swallows a throwing close but reports it', async () => {
    const seen: string[] = [];
    const reg = makeRegistry({ onCloseError: (n) => seen.push(n) });
    reg.registerLLM(fakeLLM('bad', { closeSpy: { count: 0, fail: true } }));
    reg.registerLLM(fakeLLM('good'));
    let threw = false;
    try {
      await reg.closeAll();
    } catch {
      threw = true;
    }
    assert(threw === false, 'closeAll does not reject');
    assert(seen.includes('bad'), 'onCloseError fired for the bad driver');
    assert(reg.closed === true, 'still marked closed');
  });

  await checkAsync('closeAll is idempotent', async () => {
    const reg = makeRegistry();
    const spy = { count: 0 };
    reg.registerLLM(fakeLLM('alpha', { closeSpy: spy }));
    await reg.closeAll();
    await reg.closeAll();
    assert(spy.count === 1, 'close called exactly once across two closeAll calls');
  });

  await checkAsync('registering after closeAll traps EDRIVER', async () => {
    const reg = makeRegistry();
    await reg.closeAll();
    let caughtLLM: unknown;
    try {
      reg.registerLLM(fakeLLM('alpha'));
    } catch (err) {
      caughtLLM = err;
    }
    assert(isCortexError(caughtLLM) && caughtLLM.errno === 'EDRIVER', 'llm register -> EDRIVER');
    let caughtMem: unknown;
    try {
      reg.registerMemory(fakeMem('inmem'));
    } catch (err) {
      caughtMem = err;
    }
    assert(isCortexError(caughtMem) && caughtMem.errno === 'EDRIVER', 'memory register -> EDRIVER');
    let caughtTool: unknown;
    try {
      await reg.registerTool(fakeTool('fs'));
    } catch (err) {
      caughtTool = err;
    }
    assert(isCortexError(caughtTool) && caughtTool.errno === 'EDRIVER', 'tool register -> EDRIVER');
  });
}

async function runMockLLMChecks(): Promise<void> {
  const { mkdtemp, rm, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const tmp = await mkdtemp(join(tmpdir(), 'cortex-smoke-mock-'));
  const agent = { module: './agents/noop.js' } as const;

  let fakeNow = Date.UTC(2026, 0, 1, 0, 0, 0);
  const clock = (): string => new Date(fakeNow).toISOString();

  const userMsg = (content: string): Message => ({ role: 'user', content });

  // --- §1 estimation heuristics --------------------------------------------

  check('estimateTextTokens is ceil(len/4), empty -> 0', () => {
    assert(estimateTextTokens('') === 0, 'empty -> 0');
    assert(estimateTextTokens('hi') === 1, '2 chars -> 1');
    assert(estimateTextTokens('abcd') === 1, '4 chars -> 1');
    assert(estimateTextTokens('abcde') === 2, '5 chars -> 2');
    assert(MOCK_CHARS_PER_TOKEN === 4, 'divisor is 4');
  });

  check('estimateMessageTokens adds 1 framing token per message', () => {
    assert(estimateMessageTokens([]) === 0, 'no messages -> 0');
    assert(estimateMessageTokens([userMsg('hi')]) === 2, 'content 1 + framing 1');
    assert(estimateMessageTokens([userMsg(''), userMsg('')]) === 2, 'empty content still 1 each');
  });

  // --- §2 driver identity / defaults ---------------------------------------

  check('MockLLMDriver defaults match MOCK_DEFAULTS', () => {
    const d = new MockLLMDriver();
    assert(d.name === MOCK_DEFAULTS.name, `name ${d.name}`);
    assert(d.version === MOCK_DEFAULTS.version, 'version');
    assert(d.abiCompat === MOCK_DEFAULTS.abiCompat, 'abiCompat');
    assert(d.supportedModels.includes('mock-1'), 'supportedModels');
    assert(d.callCount === 0 && d.closed === false, 'fresh driver state');
  });

  check('mock abiCompat admits the live kernel ABI', () => {
    const d = mockLLM();
    assert(satisfiesAbi(KERNEL_ABI_VERSION, d.abiCompat) === true, 'registry would accept it');
  });

  check('mockLLM() factory honors option overrides', () => {
    const d = mockLLM({ name: 'm2', defaultModel: 'mock-mini', usdPer1kTokens: 0.01 });
    assert(d.name === 'm2', 'name override');
    assert(d.abiCompat === MOCK_DEFAULTS.abiCompat, 'abiCompat default kept');
  });

  // --- §3 pure echo behaviour ----------------------------------------------

  await checkAsync('call() echoes the last user message deterministically', async () => {
    const d = mockLLM();
    const ctx = { pid: asProcessId(2), callId: 'c1', deadline: clock(), abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
    const res = await d.call({ messages: [userMsg('hi')] }, ctx);
    assert(res.text === 'mock reply to: hi', `echo text: ${res.text}`);
    assert(res.finishReason === 'stop', 'stop by default');
    assert(res.toolCalls.length === 0, 'no tool calls');
    assert(res.model === 'mock-1', 'default model');
    assert(res.driverVersion === d.version, 'driverVersion');
  });

  await checkAsync('call() is a pure function of the request (same in -> same out)', async () => {
    const d = mockLLM();
    const ctx = { pid: asProcessId(2), callId: 'c1', deadline: clock(), abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
    const req = { messages: [userMsg('hello world')] };
    const a = await d.call(req, ctx);
    const b = await d.call(req, ctx);
    assert(a.text === b.text, 'text stable');
    assert(JSON.stringify(a.usage) === JSON.stringify(b.usage), 'usage stable');
    assert(a.usage.cachedTokens === 0 && b.usage.cachedTokens === 0, 'no cache by default');
  });

  await checkAsync('call() anchors on the LAST user message', async () => {
    const d = mockLLM();
    const ctx = { pid: asProcessId(2), callId: 'c1', deadline: clock(), abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
    const res = await d.call(
      { messages: [userMsg('first'), { role: 'assistant', content: 'reply' }, userMsg('second')] },
      ctx,
    );
    assert(res.text === 'mock reply to: second', `anchored on last user: ${res.text}`);
  });

  await checkAsync('call() on an empty conversation is still deterministic', async () => {
    const d = mockLLM();
    const ctx = { pid: asProcessId(2), callId: 'c1', deadline: clock(), abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
    const res = await d.call({ messages: [] }, ctx);
    assert(typeof res.text === 'string' && res.text.includes('(empty)'), `empty reply: ${res.text}`);
    assert(res.usage.inputTokens === 0, 'no input tokens');
  });

  await checkAsync('usage heuristics: input/output tokens and zero default usd', async () => {
    const d = mockLLM();
    const ctx = { pid: asProcessId(2), callId: 'c1', deadline: clock(), abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
    const res = await d.call({ messages: [userMsg('hi')] }, ctx);
    assert(res.usage.inputTokens === 2, `input tokens ${res.usage.inputTokens}`);
    assert(res.usage.outputTokens === estimateTextTokens('mock reply to: hi'), 'output = text estimate');
    assert(res.usage.usd === 0, 'free by default');
  });

  await checkAsync('usdPer1kTokens produces a microdollar-clean price', async () => {
    const d = mockLLM({ usdPer1kTokens: 0.001 });
    const ctx = { pid: asProcessId(2), callId: 'c1', deadline: clock(), abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
    const res = await d.call({ messages: [userMsg('hi')] }, ctx);
    const total = res.usage.inputTokens + res.usage.outputTokens;
    assert(res.usage.usd === Math.round((total / 1000) * 0.001 * 1e6) / 1e6, `usd ${res.usage.usd}`);
  });

  await checkAsync('model resolves from req.model, else the default', async () => {
    const d = mockLLM();
    const ctx = { pid: asProcessId(2), callId: 'c1', deadline: clock(), abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
    const res = await d.call({ messages: [userMsg('hi')], model: 'mock-mini' }, ctx);
    assert(res.model === 'mock-mini', 'request model wins');
  });

  // --- §4 scripted mode -----------------------------------------------------

  await checkAsync('scripted turns are consumed in order, then fall back to echo', async () => {
    const script: MockTurn[] = [{ text: 'one' }, { text: 'two' }];
    const d = mockLLM({ script });
    const ctx = { pid: asProcessId(2), callId: 'c1', deadline: clock(), abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
    assert((await d.call({ messages: [userMsg('x')] }, ctx)).text === 'one', 'turn 0');
    assert((await d.call({ messages: [userMsg('x')] }, ctx)).text === 'two', 'turn 1');
    const third = await d.call({ messages: [userMsg('fallback')] }, ctx);
    assert(third.text === 'mock reply to: fallback', `exhausted -> echo: ${third.text}`);
    assert(d.callCount === 3, 'callCount tracks calls');
  });

  await checkAsync('scripted tool_use turn flips finishReason', async () => {
    const calls: ToolCall[] = [{ id: 't1', name: 'grep', arguments: { pattern: 'x' } }];
    const d = mockLLM({ script: [{ text: null, toolCalls: calls }] });
    const ctx = { pid: asProcessId(2), callId: 'c1', deadline: clock(), abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
    const res = await d.call({ messages: [userMsg('search')] }, ctx);
    assert(res.text === null, 'null text');
    assert(res.toolCalls.length === 1 && res.toolCalls[0].name === 'grep', 'tool call surfaced');
    assert(res.finishReason === 'tool_use', `finishReason ${res.finishReason}`);
    assert(res.usage.outputTokens >= 4, 'tool calls add output tokens');
  });

  await checkAsync('scripted usage / model / finishReason overrides merge', async () => {
    const d = mockLLM({ script: [{ text: 't', usage: { inputTokens: 99, usd: 1.5 }, model: 'custom', finishReason: 'length' }] });
    const ctx = { pid: asProcessId(2), callId: 'c1', deadline: clock(), abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
    const res = await d.call({ messages: [userMsg('hi')] }, ctx);
    assert(res.usage.inputTokens === 99, 'input override');
    assert(res.usage.usd === 1.5, 'usd override');
    assert(res.model === 'custom', 'model override');
    assert(res.finishReason === 'length', 'finishReason override');
    assert(res.usage.outputTokens === estimateTextTokens('t'), 'non-overridden field still computed');
  });

  await checkAsync('reset() rewinds script, callCount, and cache', async () => {
    const d = mockLLM({ script: [{ text: 'one' }], cacheRepeated: true });
    const ctx = { pid: asProcessId(2), callId: 'c1', deadline: clock(), abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
    await d.call({ messages: [userMsg('hi')] }, ctx);
    assert(d.callCount === 1, 'one call');
    d.reset();
    assert(d.callCount === 0, 'callCount reset');
    const res = await d.call({ messages: [userMsg('hi')] }, ctx);
    assert(res.text === 'one', 'script rewound to turn 0');
  });

  // --- §5 prompt-cache simulation ------------------------------------------

  await checkAsync('cacheRepeated reports cachedTokens on a repeated prompt', async () => {
    const d = mockLLM({ cacheRepeated: true });
    const ctx = { pid: asProcessId(2), callId: 'c1', deadline: clock(), abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
    const req = { messages: [userMsg('cache me')] };
    const first = await d.call(req, ctx);
    const second = await d.call(req, ctx);
    assert(first.usage.cachedTokens === 0, 'first call not cached');
    assert(second.usage.cachedTokens === second.usage.inputTokens, 'second call fully cached');
  });

  // --- §6 optional capabilities + lifecycle --------------------------------

  await checkAsync('countTokens is present and matches the heuristic', async () => {
    const d = mockLLM();
    assert(typeof d.countTokens === 'function', 'countTokens present');
    const n = await d.countTokens!([userMsg('hi')]);
    assert(n === estimateMessageTokens([userMsg('hi')]), 'count matches estimate');
  });

  await checkAsync('stream is absent in v0 (post-v0 capability)', async () => {
    const d = mockLLM();
    assert(d.stream === undefined, 'no streaming in v0');
  });

  await checkAsync('close() marks closed and further calls reject', async () => {
    const d = mockLLM();
    const ctx = { pid: asProcessId(2), callId: 'c1', deadline: clock(), abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
    await d.close();
    assert(d.closed === true, 'closed flag');
    let caught: unknown;
    try {
      await d.call({ messages: [userMsg('hi')] }, ctx);
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof Error, 'call after close throws');
  });

  await checkAsync('latency + pre-aborted signal rejects', async () => {
    const d = mockLLM({ latencyMs: 1000 });
    const ac = new AbortController();
    ac.abort();
    const ctx = { pid: asProcessId(2), callId: 'c1', deadline: clock(), abortSignal: ac.signal, kernelAbiVersion: KERNEL_ABI_VERSION };
    let caught: unknown;
    try {
      await d.call({ messages: [userMsg('hi')] }, ctx);
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof Error, 'aborted call rejects');
  });

  // --- §7 registry integration ---------------------------------------------

  await checkAsync('mock registers into DriverRegistry and surfaces in listAll', async () => {
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    reg.registerLLM(mockLLM());
    assert(reg.hasLLM('mock'), 'registered');
    assert(reg.resolveLLM().name === 'mock', 'resolves as default');
    const info = reg.listAll().llm.find((d) => d.name === 'mock');
    assert(info !== undefined && info.isDefault === true, 'is default');
    assert(info.countsTokens === true && info.streams === false, 'capability flags');
    await reg.closeAll();
  });

  // --- §8 end-to-end: registry -> dispatcher -> process --------------------

  const tables: ProcessTable[] = [];
  async function makeTable(opts: { record?: boolean; dir?: string } = {}): Promise<ProcessTable> {
    const dir = opts.dir ?? tmp;
    const t = new ProcessTable({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      ...(opts.record === true ? { recorderFactory: async (pid) => Recorder.open({ pid, dir: join(dir, String(unbrand(pid))) }) } : {}),
    });
    tables.push(t);
    return t;
  }
  async function runningPid(table: ProcessTable, opts: { budgets?: Partial<BudgetLimits> } = {}): Promise<ProcessIdAlias> {
    const pid = await table.allocate({
      ppid: null,
      role: 'worker',
      agent,
      ...(opts.budgets !== undefined ? { budgets: opts.budgets } : {}),
    });
    await table.setState(pid, 'ready', { trigger: 'test' });
    await table.setState(pid, 'running', { trigger: 'test' });
    return pid;
  }
  function makeDispatcher(table: ProcessTable, reg: DriverRegistry): SyscallDispatcher {
    const signals = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
    return new SyscallDispatcher({
      table,
      signals,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      resolveLLM: reg.llmResolver(),
      resolveTool: reg.toolResolver(),
    });
  }

  // --- §9 capabilities (docs/ABI.md §4.9) ----------------------------------

  async function runningPidWithCaps(
    table: ProcessTable,
    caps?: readonly Capability[],
    grantable?: readonly Capability[],
  ): Promise<ProcessIdAlias> {
    const pid = await table.allocate({
      ppid: null,
      role: 'worker',
      agent,
      ...(caps !== undefined ? { capabilities: caps } : {}),
      ...(grantable !== undefined ? { grantable } : {}),
    });
    await table.setState(pid, 'ready', { trigger: 'test' });
    await table.setState(pid, 'running', { trigger: 'test' });
    return pid;
  }
  const errnoOf = (e: unknown): string => (e as { errno?: string }).errno ?? '';

  await checkAsync('capabilities: a process nobody narrowed holds everything', async () => {
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    const table = await makeTable();
    const d = makeDispatcher(table, reg);
    const pid = await runningPid(table);
    // The compatibility contract: pre-1.0 agents must not start trapping
    // EPERM just because capabilities now exist.
    assert(
      d.capabilitiesOf(pid).length === CAPABILITIES.length,
      `expected all capabilities, got ${d.capabilitiesOf(pid).length}`,
    );
    assert(d.hasCapability(pid, 'kill') && d.hasCapability(pid, 'spawn'), 'kill + spawn held');
    await reg.closeAll();
  });

  await checkAsync('capabilities: spawn is refused without the spawn capability', async () => {
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    const table = await makeTable();
    const d = makeDispatcher(table, reg);
    const pid = await runningPidWithCaps(table, []);
    let errno = '';
    try {
      await d.invoke(pid, 'spawn', { role: 'child', agent });
    } catch (e) {
      errno = errnoOf(e);
    }
    assert(errno === 'EPERM', `expected EPERM, got ${errno || 'no error'}`);
    await reg.closeAll();
  });

  await checkAsync('capabilities: acquire raises a grantable capability and it then works', async () => {
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    const table = await makeTable();
    const d = makeDispatcher(table, reg);
    const pid = await runningPidWithCaps(table, [], ['spawn']);

    let errno = '';
    try {
      await d.invoke(pid, 'spawn', { role: 'child', agent });
    } catch (e) {
      errno = errnoOf(e);
    }
    assert(errno === 'EPERM', 'narrowed process cannot spawn before acquiring');

    await d.invoke(pid, 'acquire', 'spawn');
    assert(d.hasCapability(pid, 'spawn'), 'acquire granted spawn');
    const res = await d.invoke(pid, 'spawn', { role: 'child', agent });
    assert(res.pid !== undefined, 'spawn succeeded after acquire');
    await reg.closeAll();
  });

  await checkAsync('capabilities: acquire refuses a capability outside the grantable pool', async () => {
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    const table = await makeTable();
    const d = makeDispatcher(table, reg);
    // grantable holds only 'fork', so 'spawn' can never be raised.
    const pid = await runningPidWithCaps(table, [], ['fork']);
    let errno = '';
    try {
      await d.invoke(pid, 'acquire', 'spawn');
    } catch (e) {
      errno = errnoOf(e);
    }
    assert(errno === 'EPERM', `expected EPERM, got ${errno || 'no error'}`);
    assert(!d.hasCapability(pid, 'spawn'), 'still does not hold spawn');
    await reg.closeAll();
  });

  await checkAsync('capabilities: acquire traps EINVAL for a name that is not a capability', async () => {
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    const table = await makeTable();
    const d = makeDispatcher(table, reg);
    const pid = await runningPidWithCaps(table, []);
    let errno = '';
    try {
      await d.invoke(pid, 'acquire', 'superuser' as Capability);
    } catch (e) {
      errno = errnoOf(e);
    }
    assert(errno === 'EINVAL', `expected EINVAL, got ${errno || 'no error'}`);
    await reg.closeAll();
  });

  await checkAsync('capabilities: release drops a capability', async () => {
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    const table = await makeTable();
    const d = makeDispatcher(table, reg);
    const pid = await runningPidWithCaps(table, ['spawn']);
    const first = await d.invoke(pid, 'spawn', { role: 'child', agent });
    assert(first.pid !== undefined, 'spawn works while spawn is held');
    await d.invoke(pid, 'release', 'spawn');
    assert(!d.hasCapability(pid, 'spawn'), 'spawn dropped');
    let errno = '';
    try {
      await d.invoke(pid, 'spawn', { role: 'child2', agent });
    } catch (e) {
      errno = errnoOf(e);
    }
    assert(errno === 'EPERM', `expected EPERM after release, got ${errno || 'no error'}`);
    await reg.closeAll();
  });

  await checkAsync('capabilities: killing your own child needs no kill capability', async () => {
    // The regression that matters most: a supervision tree kills the child
    // that missed its deadline. If that needed `kill`, the capability would
    // be handed out so widely it would stop meaning anything.
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    const table = await makeTable();
    const d = makeDispatcher(table, reg);
    const parent = await runningPidWithCaps(table, ['spawn']);
    const { pid: child } = await d.invoke(parent, 'spawn', { role: 'coder', agent });
    // No EPERM: the child is a descendant.
    await d.invoke(parent, 'kill', child as ProcessIdAlias, 'SIGTERM');
    assert(true, 'killing a descendant succeeded without the kill capability');
    await reg.closeAll();
  });

  await checkAsync('capabilities: killing a stranger needs the kill capability', async () => {
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    const table = await makeTable();
    const d = makeDispatcher(table, reg);
    const attacker = await runningPidWithCaps(table, ['spawn']);
    const stranger = await runningPidWithCaps(table, ['spawn']);

    let errno = '';
    try {
      await d.invoke(attacker, 'kill', stranger as ProcessIdAlias, 'SIGTERM');
    } catch (e) {
      errno = errnoOf(e);
    }
    assert(errno === 'EPERM', `expected EPERM for a stranger, got ${errno || 'no error'}`);

    // Grant it, and the same call is allowed.
    await d.invoke(attacker, 'acquire', 'kill').catch(() => {});
    d.setCapabilities(attacker as ProcessIdAlias, ['spawn', 'kill']);
    await d.invoke(attacker, 'kill', stranger as ProcessIdAlias, 'SIGTERM');
    assert(true, 'killing a stranger succeeds once kill is held');
    await reg.closeAll();
  });

  await checkAsync('capabilities: the required-capability table is keyed to real syscalls', async () => {
    for (const [syscall, cap] of Object.entries(SYSCALL_REQUIRED_CAPABILITY)) {
      assert(
        SYSCALL_NAMES.includes(syscall as never),
        `SYSCALL_REQUIRED_CAPABILITY references unknown syscall '${syscall}'`,
      );
      assert(
        (CAPABILITIES as readonly string[]).includes(cap),
        `SYSCALL_REQUIRED_CAPABILITY['${syscall}'] is not a capability: '${cap}'`,
      );
    }
  });

  // --- §9b explicit channel lifecycle (docs/ABI.md §4.5, §9.3) -------------

  function makeIpcDispatcher(table: ProcessTable, reg: DriverRegistry): {
    d: SyscallDispatcher;
    ipc: IpcManager;
  } {
    const signals = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
    const ipc = new IpcManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
    const d = new SyscallDispatcher({
      table,
      signals,
      ipc,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      resolveLLM: reg.llmResolver(),
      resolveTool: reg.toolResolver(),
    });
    return { d, ipc };
  }

  await checkAsync('channels: channel_open mints a fresh id that exists before any send', async () => {
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    const table = await makeTable();
    const { d, ipc } = makeIpcDispatcher(table, reg);
    const pid = await runningPid(table);
    const { channelId } = await d.invoke(pid, 'channel_open');
    // The whole point of §9.3: the channel is knowable before anyone sends.
    assert(ipc.hasChannel(channelId), 'channel exists immediately after open');
    assert(!ipc.getChannel(channelId)?.closed, 'new channel is not closed');
    await reg.closeAll();
  });

  await checkAsync('channels: a named channel is claimable and duplicate names are refused', async () => {
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    const table = await makeTable();
    const { d } = makeIpcDispatcher(table, reg);
    const pid = await runningPid(table);
    const first = await d.invoke(pid, 'channel_open', { name: 'work-queue' });
    assert(unbrand(first.channelId) === 'work-queue', 'claimed the requested name');
    let errno = '';
    try {
      await d.invoke(pid, 'channel_open', { name: 'work-queue' });
    } catch (e) {
      errno = errnoOf(e);
    }
    assert(errno === 'EINVAL', `expected EINVAL for a duplicate name, got ${errno || 'no error'}`);
    await reg.closeAll();
  });

  await checkAsync('channels: channel_close retires the channel and later send traps EBADF', async () => {
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    const table = await makeTable();
    const { d } = makeIpcDispatcher(table, reg);
    const pid = await runningPid(table);
    const { channelId } = await d.invoke(pid, 'channel_open', { name: 'pipe' });
    // Idempotent: closing twice is not an error.
    await d.invoke(pid, 'channel_close', channelId);
    await d.invoke(pid, 'channel_close', channelId);

    let errno = '';
    try {
      await d.invoke(pid, 'send', channelId, { hello: true });
    } catch (e) {
      errno = errnoOf(e);
    }
    assert(errno === 'EBADF', `expected EBADF on a closed channel, got ${errno || 'no error'}`);
    await reg.closeAll();
  });

  await checkAsync('E2E: llm_call through the registry resolver returns the mock reply', async () => {
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    reg.registerLLM(mockLLM());
    const table = await makeTable();
    const dispatcher = makeDispatcher(table, reg);
    const pid = await runningPid(table);
    const res = await dispatcher.invoke(pid, 'llm_call', { messages: [userMsg('ping')] });
    assert(res.text === 'mock reply to: ping', `mock reply via syscall: ${res.text}`);
    assert(res.usage.inputTokens === 2, 'usage flowed from the driver');
    await reg.closeAll();
  });

  await checkAsync('E2E: mock usage drives budget exhaustion -> SIGXCPU stops the process', async () => {
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    reg.registerLLM(mockLLM());
    const table = await makeTable();
    const dispatcher = makeDispatcher(table, reg);
    const pid = await runningPid(table, { budgets: { tokens: 1 } });
    await dispatcher.invoke(pid, 'llm_call', { messages: [userMsg('hi')] });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const e = table.get(pid);
    assert(e !== undefined && e.state === 'stopped', `SIGXCPU stopped it, got ${e?.state}`);
    await reg.closeAll();
  });

  await checkAsync('E2E: finite wallTime budget drains with real elapsed time -> SIGXCPU', async () => {
    // Regression: `#account` used to charge tokens/usd only. A process's
    // `budgetsRemaining.wallTimeMs` never decremented, so a finite wall-time
    // budget could never trip checkBudget's `kind: 'wallTime'` and the SIGXCPU
    // documented in types.ts ("decrement on every relevant syscall; when one
    // hits zero, SIGXCPU fires") never fired. Fix: table.spend() now accrues
    // elapsed milliseconds since the last accounting pass whenever the wall
    // budget is bounded.
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    reg.registerLLM(mockLLM());
    const table = await makeTable();
    const dispatcher = makeDispatcher(table, reg);
    // Only a wall-time limit is set; tokens/usd stay unlimited so ONLY wall-time
    // exhaustion can trigger SIGXCPU.
    const pid = await runningPid(table, { budgets: { tokens: -1, usd: -1, wallTimeMs: 100 } });
    const e0 = table.get(pid)!;
    assert(e0.budgetsRemaining.wallTimeMs === 100, `initial remaining 100, got ${e0.budgetsRemaining.wallTimeMs}`);
    fakeNow += 250; // real wall time elapses beyond the budget
    await dispatcher.invoke(pid, 'llm_call', { messages: [userMsg('hi')] });
    // The accounting pass has now run once, charging 250ms.
    const e1 = table.get(pid)!;
    assert(e1.budgetsRemaining.wallTimeMs === 0, `remaining clamps to 0, got ${e1.budgetsRemaining.wallTimeMs}`);
    assert(e1.budgetsSpent.wallTimeMs >= 250, `spent accrues, got ${e1.budgetsSpent.wallTimeMs}`);
    // SIGXCPU delivery is async; drain the microtasks.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const e2 = table.get(pid);
    assert(e2 !== undefined && e2.state === 'stopped', `wall-time budget stopped it, got ${e2?.state}`);
    // A further RUNNING-gated syscall now traps at the state gate.
    let caught: unknown = null;
    try { await dispatcher.invoke(pid, 'llm_call', { messages: [userMsg('again')] }); } catch (err) { caught = err; }
    assert(isCortexError(caught) && (caught as CortexError).errno === 'ESTATE',
      `further syscall ESTATE, got ${isCortexError(caught) ? (caught as CortexError).errno : 'no-throw'}`);
    await reg.closeAll();
  });

  await checkAsync('E2E: llm_call writes an enter + exit record pair', async () => {
    const sub = join(tmp, 'rec-mock');
    await mkdir(sub, { recursive: true });
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    reg.registerLLM(mockLLM());
    const table = await makeTable({ record: true, dir: sub });
    const dispatcher = makeDispatcher(table, reg);
    const pid = await runningPid(table);
    await dispatcher.invoke(pid, 'llm_call', { messages: [userMsg('record me')] });
    const rec = table.recorderFor(pid);
    assert(rec !== null, 'recorder open');
    await rec!.flush();
    const records: SyscallRecord[] = [];
    for await (const r of readRecords(rec!.path)) records.push(r);
    const llm = records.filter((r) => r.syscall === 'llm_call');
    assert(llm.some((r) => r.phase === 'enter'), 'enter recorded');
    const exit = llm.find((r) => r.phase === 'exit');
    assert(exit !== undefined, 'exit recorded');
    assert((exit!.result as { text: string }).text === 'mock reply to: record me', 'result carries the reply');
    await reg.closeAll();
  });

  await checkAsync('E2E: full lifecycle spawn -> llm_call -> exit -> reap', async () => {
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    reg.registerLLM(mockLLM());
    const table = await makeTable();
    const dispatcher = makeDispatcher(table, reg);
    const pid = await runningPid(table);
    const res = await dispatcher.invoke(pid, 'llm_call', { messages: [userMsg('think')] });
    assert(res.text === 'mock reply to: think', 'cognition happened');
    let exitSig: unknown;
    try {
      await dispatcher.invoke(pid, 'exit', 0, 'done');
    } catch (err) {
      exitSig = err;
    }
    assert(isProcessExitSignal(exitSig), 'exit throws the sentinel');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert(table.get(pid) === undefined, 'process reaped after exit');
    await reg.closeAll();
  });

  // --- cleanup --------------------------------------------------------------
  for (const t of tables) {
    for (const pid of t.pids()) {
      const rec = t.recorderFor(pid);
      if (rec !== null) await rec.close().catch(() => {});
    }
  }
  await rm(tmp, { recursive: true, force: true });
}

async function runBootChecks(): Promise<void> {
  const { mkdtemp, rm, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  type ProcessIdAlias = ReturnType<typeof asProcessId>;
  type ChainIdAlias = ReturnType<typeof asChainId>;

  const tmp = await mkdtemp(join(tmpdir(), 'cortex-smoke-boot-'));

  const fakeNow = Date.UTC(2026, 0, 1, 0, 0, 0);
  const clock = (): string => new Date(fakeNow).toISOString();
  const userMsg = (content: string): Message => ({ role: 'user', content });

  // Deterministic PRNG so ctx.random() is reproducible across runs.
  let seed = 0x9e3779b9;
  const detRandom = (_o?: RandomOptions): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  // In-memory agent "modules": the default loader's dynamic import is replaced
  // by a map lookup, so no filesystem module resolution happens in the smoke.
  const agentImpls = new Map<string, AgentFn>();
  const importModule = async (specifier: string): Promise<unknown> => {
    const fn = agentImpls.get(specifier);
    if (fn === undefined) throw new Error(`no such agent module: ${specifier}`);
    return { default: fn };
  };

  const kernels: Kernel[] = [];

  async function makeKernel(
    overrides: Partial<KernelOptions> = {},
    opts: { record?: boolean; sub?: string } = {},
  ): Promise<{ k: Kernel; mock: MockLLMDriver; procDir: string | null }> {
    const sub = opts.sub ?? tmp;
    const record = opts.record === true;
    let procDir: string | null = null;
    if (record) {
      procDir = join(sub, 'processes');
      await mkdir(procDir, { recursive: true });
    }
    let mock: MockLLMDriver | null = null;
    const k = new Kernel({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      dir: sub,
      now: clock,
      random: detRandom,
      importModule,
      autoStart: false,
      loadDrivers: (reg) => {
        mock = mockLLM();
        reg.registerLLM(mock);
      },
      ...(record
        ? {
            recorderFactory: async (pid: ProcessIdAlias) =>
              // One directory per process: the log is `<processes>/<pid>/log.crec`.
              Recorder.open({ pid, dir: join(procDir as string, String(unbrand(pid))) }),
          }
        : { recorderFactory: nullRecorderFactory }),
      ...overrides,
    });
    await k.boot();
    kernels.push(k);
    return { k, mock: mock as MockLLMDriver, procDir };
  }

  async function expectErrno(fn: () => Promise<unknown>, errno: string): Promise<void> {
    let caught: unknown;
    try {
      await fn();
    } catch (e) {
      caught = e;
    }
    assert(isCortexError(caught), `expected CortexError(${errno}), got ${String(caught)}`);
    assert((caught as CortexError).errno === errno, `expected ${errno}, got ${(caught as CortexError).errno}`);
  }
  function expectErrnoSync(fn: () => unknown, errno: string): void {
    let caught: unknown;
    try {
      fn();
    } catch (e) {
      caught = e;
    }
    assert(isCortexError(caught), `expected CortexError(${errno}), got ${String(caught)}`);
    assert((caught as CortexError).errno === errno, `expected ${errno}, got ${(caught as CortexError).errno}`);
  }

  // The kernel writes one directory per process: `<procDir>/<pid>/log.crec`.
  async function readExit(procDir: string, pid: ProcessIdAlias): Promise<{ code: number; reason: string } | undefined> {
    const path = join(procDir, String(unbrand(pid)), 'log.crec');
    const records: SyscallRecord[] = [];
    for await (const r of readRecords(path)) records.push(r);
    const rec = records.find((r) => r.syscall === 'exit' && r.phase === 'exit');
    return rec === undefined ? undefined : (rec.result as { code: number; reason: string });
  }

  await checkAsync('synchronous syscalls land in the .crec, in order, before the next syscall', async () => {
    // The gap: ctx.now() / ctx.random() / ctx.on_signal() are synchronous on
    // CortexContext, and the sync fast-path used to skip recording entirely —
    // so a replay had no idea what value the agent actually saw. They are now
    // queued at call time and flushed at the process's next async boundary.
    const sub = join(tmp, 'rec-sync');
    await mkdir(sub, { recursive: true });
    agentImpls.set('./agents/sync.js', async (ctx) => {
      ctx.now();
      ctx.random();
      ctx.on_signal('SIGUSR1', 'ignore');
      ctx.budget(); // unrecorded by policy (ABI 4.8): derivable from other frames
      await ctx.llm_call({ messages: [userMsg('go')] });
    });
    const { k, procDir } = await makeKernel({}, { record: true, sub });
    const pid = await k.spawn({ role: 'sync', agent: { module: './agents/sync.js' } });
    await k.settle();

    const records: SyscallRecord[] = [];
    for await (const r of readRecords(join(procDir as string, String(unbrand(pid)), 'log.crec'))) {
      records.push(r);
    }
    const nowRec = records.find((r) => r.syscall === 'now');
    const randRec = records.find((r) => r.syscall === 'random');
    const sigRec = records.find((r) => r.syscall === 'on_signal');
    assert(nowRec !== undefined, 'ctx.now() is recorded');
    assert(typeof nowRec?.result === 'string', `now records the value served, got ${JSON.stringify(nowRec?.result)}`);
    assert(randRec !== undefined && typeof randRec.result === 'number', 'ctx.random() is recorded with its value');
    assert(sigRec !== undefined, 'ctx.on_signal() is recorded');
    assert(
      (sigRec?.args as { signal?: string } | undefined)?.signal === 'SIGUSR1',
      'on_signal records which signal',
    );
    assert(
      (sigRec?.result as { disposition?: string } | undefined)?.disposition === 'ignore',
      'on_signal records the disposition kind, not the closure',
    );
    assert(!records.some((r) => r.syscall === 'budget'), 'budget stays unrecorded by policy');

    // The ordering guarantee: everything the body did synchronously must be
    // written before the next syscall's own enter frame.
    const idxNow = records.indexOf(nowRec as SyscallRecord);
    const idxEnter = records.findIndex((r) => r.syscall === 'llm_call' && r.phase === 'enter');
    assert(idxEnter >= 0, 'the following async syscall was recorded');
    assert(idxNow < idxEnter, `sync records precede the next syscall, got now@${idxNow} enter@${idxEnter}`);
  });

  // --- §1 assembly + boot ---------------------------------------------------

  await checkAsync('boot() constructs every module and brings init to RUNNING', async () => {
    const { k } = await makeKernel();
    assert(k.booted === true, 'booted flag set');
    const mods: unknown[] = [k.table, k.signals, k.ipc, k.memory, k.checkpoint, k.fork, k.scheduler, k.dispatcher, k.registry, k.init];
    for (const m of mods) assert(m !== undefined && m !== null, 'a kernel module is missing');
    const init = k.table.get(PID_INIT);
    assert(init !== undefined && init.state === 'running', `init should be RUNNING, got ${init?.state}`);
  });

  await checkAsync('a second boot() traps EINVAL', async () => {
    const { k } = await makeKernel();
    await expectErrno(() => k.boot(), 'EINVAL');
  });

  await checkAsync('spawn/start before boot trap ESTATE', async () => {
    const k = new Kernel({ kernelAbiVersion: KERNEL_ABI_VERSION, dir: tmp, recorderFactory: nullRecorderFactory, now: clock, importModule });
    kernels.push(k);
    await expectErrno(() => k.spawn({ role: 'w', agent: { module: './agents/noop.js' } }), 'ESTATE');
    expectErrnoSync(() => k.start(), 'ESTATE');
  });

  check('empty kernelAbiVersion or dir traps EINVAL at construction', () => {
    expectErrnoSync(() => new Kernel({ kernelAbiVersion: '', dir: tmp }), 'EINVAL');
    expectErrnoSync(() => new Kernel({ kernelAbiVersion: KERNEL_ABI_VERSION, dir: '' }), 'EINVAL');
  });

  await checkAsync('bootKernel() returns an already-booted kernel', async () => {
    const k = await bootKernel({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      dir: tmp,
      recorderFactory: nullRecorderFactory,
      now: clock,
      importModule,
      loadDrivers: (reg) => reg.registerLLM(mockLLM()),
    });
    kernels.push(k);
    assert(k.booted === true, 'bootKernel boots');
    assert(k.table.get(PID_INIT)?.state === 'running', 'init running');
  });

  await checkAsync('maxRegionEntries: default unlimited, boot config overrides the manager', async () => {
    const { k: dk } = await makeKernel();
    assert(
      dk.memory.maxRegionEntries === -1,
      `default ceiling should be -1 (unlimited), got ${dk.memory.maxRegionEntries}`,
    );
    const { k } = await makeKernel({ maxRegionEntries: 7 });
    assert(
      k.memory.maxRegionEntries === 7,
      `KernelOptions.maxRegionEntries should reach the manager as 7, got ${k.memory.maxRegionEntries}`,
    );
  });

  await checkAsync('E2E: a spawned process honors the boot maxRegionEntries cap (ENOMEM)', async () => {
    const { k } = await makeKernel({ maxRegionEntries: 2 });
    k.memory.registerDriver(inmemMemory());
    const pid = await k.spawn({
      role: 'hoarder',
      agent: { module: './agents/noop.js' },
      memory: { buf: { kind: 'private', backing: 'inmem' } },
    });
    assert(k.memory.regionInfo(pid, 'buf') !== undefined, 'spawn should attach the buf region');
    await k.memory.write(pid, 'buf', 'a', 1);
    await k.memory.write(pid, 'buf', 'b', 2);
    await expectErrno(() => k.memory.write(pid, 'buf', 'c', 3), 'ENOMEM');
    // The two accepted writes persisted; only the third (which would exceed
    // the cap) was rejected.
    const seen = await k.memory.read(pid, 'buf', {});
    assert(seen.length === 2, `region should hold the 2 accepted entries, got ${seen.length}`);
  });

  await checkAsync('E2E: per-region maxEntries overrides the boot global cap (tighten + opt-out)', async () => {
    const { k } = await makeKernel({ maxRegionEntries: 5 }); // global 5
    k.memory.registerDriver(inmemMemory());
    const pid = await k.spawn({
      role: 'mixed',
      agent: { module: './agents/noop.js' },
      memory: {
        tight: { kind: 'private', backing: 'inmem', maxEntries: 2 }, // tighter than global
        wild: { kind: 'private', backing: 'inmem', maxEntries: -1 }, // opts out entirely
      },
    });
    assert(
      k.memory.regionInfo(pid, 'tight')!.effectiveMaxEntries === 2 &&
        k.memory.regionInfo(pid, 'wild')!.effectiveMaxEntries === -1,
      'per-region caps should be visible via introspection',
    );
    // 'tight' bites at 2, well before the global 5.
    await k.memory.write(pid, 'tight', 'a', 1);
    await k.memory.write(pid, 'tight', 'b', 2);
    await expectErrno(() => k.memory.write(pid, 'tight', 'c', 3), 'ENOMEM');
    // 'wild' survives past the global 5 because it opted out.
    for (let i = 0; i < 6; i++) await k.memory.write(pid, 'wild', `k${i}`, i);
    const wild = await k.memory.read(pid, 'wild', {});
    assert(wild.length === 6, `wild region should hold all 6 writes, got ${wild.length}`);
  });

  // --- §2 the §13 milestone: spawn -> llm_call -> exit -> reap --------------

  await checkAsync('§13 milestone: spawn -> llm_call -> exit -> reap', async () => {
    let reply = '';
    agentImpls.set('./agents/echo.js', async (ctx) => {
      const r = await ctx.llm_call({ messages: [userMsg('think')] });
      reply = r.text ?? '';
    });
    const { k, mock } = await makeKernel();
    const pid = await k.spawn({ role: 'worker', agent: { module: './agents/echo.js' } });
    assert(k.table.get(pid)?.state === 'ready', 'spawned process is READY before its tick');
    // One tick hands the process a quantum; the agent's `await llm_call` then
    // needs the event loop to progress. `settle()` drives it to completion.
    const outcome = await k.scheduler.tick();
    assert(outcome.dispatched !== null && unbrand(outcome.dispatched) === unbrand(pid), 'the right pid was dispatched');
    await k.settle();
    assert(reply === 'mock reply to: think', `agent saw the mock reply, got "${reply}"`);
    assert(mock.callCount === 1, 'exactly one llm_call reached the driver');
    assert(k.table.get(pid) === undefined, 'process reaped after exit');
  });

  await checkAsync('a normal return auto-exits with code 0 / "completed"', async () => {
    agentImpls.set('./agents/ok.js', async () => {
      /* return cleanly */
    });
    const sub = join(tmp, 'rec-ok');
    const { k, procDir } = await makeKernel({}, { record: true, sub });
    const pid = await k.spawn({ role: 'worker', agent: { module: './agents/ok.js' } });
    await k.settle();
    const ex = await readExit(procDir as string, pid);
    assert(ex !== undefined, 'an exit record was written');
    assert(ex!.code === 0 && ex!.reason === 'completed', `expected 0/completed, got ${ex!.code}/${ex!.reason}`);
  });

  await checkAsync('ctx.exit(code, reason) propagates through teardown', async () => {
    agentImpls.set('./agents/quit.js', async (ctx) => {
      ctx.exit(7, 'bye');
    });
    const sub = join(tmp, 'rec-quit');
    const { k, procDir } = await makeKernel({}, { record: true, sub });
    const pid = await k.spawn({ role: 'worker', agent: { module: './agents/quit.js' } });
    await k.settle();
    const ex = await readExit(procDir as string, pid);
    assert(ex !== undefined && ex.code === 7 && ex.reason === 'bye', `expected 7/bye, got ${ex?.code}/${ex?.reason}`);
    assert(k.table.get(pid) === undefined, 'reaped');
  });

  await checkAsync('an uncaught agent error exits with code 1', async () => {
    agentImpls.set('./agents/boom.js', async () => {
      throw new Error('boom');
    });
    const sub = join(tmp, 'rec-boom');
    const { k, procDir } = await makeKernel({}, { record: true, sub });
    const pid = await k.spawn({ role: 'worker', agent: { module: './agents/boom.js' } });
    await k.settle();
    const ex = await readExit(procDir as string, pid);
    assert(ex !== undefined && ex.code === 1, `expected code 1, got ${ex?.code}`);
    assert(ex!.reason.includes('boom'), `reason carries the message, got "${ex!.reason}"`);
  });

  await checkAsync('a missing agent module exits with code 127', async () => {
    const sub = join(tmp, 'rec-missing');
    const { k, procDir } = await makeKernel({}, { record: true, sub });
    const pid = await k.spawn({ role: 'worker', agent: { module: './agents/does-not-exist.js' } });
    await k.settle();
    const ex = await readExit(procDir as string, pid);
    assert(ex !== undefined && ex.code === 127, `expected 127, got ${ex?.code}`);
    assert(ex!.reason.includes('agent load failed'), `reason explains the load failure, got "${ex!.reason}"`);
  });

  // --- §3 the built-in prompt-only agent ------------------------------------

  await checkAsync('a { system } spec runs the built-in prompt agent', async () => {
    const { k, mock } = await makeKernel();
    const pid = await k.spawn({ role: 'prompt', agent: { system: 'you are helpful' } });
    await k.settle();
    assert(mock.callCount === 1, 'the prompt agent called the model once');
    assert(k.table.get(pid) === undefined, 'and exited cleanly');
    assert(PROMPT_AGENT_MAX_TURNS === 8, 'turn cap exported');
  });

  // --- §4 the synchronous syscall seam --------------------------------------

  await checkAsync('ctx.now()/random()/budget() are synchronous and live', async () => {
    let nowVal = '';
    let randVal = -1;
    let budgetIn = -1;
    agentImpls.set('./agents/sync.js', async (ctx) => {
      await ctx.llm_call({ messages: [userMsg('spend')] });
      nowVal = ctx.now();
      randVal = ctx.random();
      budgetIn = ctx.budget().tokensIn;
    });
    const { k } = await makeKernel();
    await k.spawn({ role: 'worker', agent: { module: './agents/sync.js' } });
    await k.settle();
    assert(nowVal === clock(), 'now() returns the injected clock');
    assert(randVal >= 0 && randVal < 1, 'random() in [0,1)');
    assert(budgetIn > 0, 'budget() reflects the llm_call spend');
  });

  await checkAsync('sync syscalls replicate the state gate (ESTATE / ESRCH)', async () => {
    agentImpls.set('./agents/noop.js', async () => {});
    const { k } = await makeKernel();
    const pid = await k.spawn({ role: 'worker', agent: { module: './agents/noop.js' } });
    const ctx = k.context(pid); // READY, not yet dispatched
    assert(ctx.now() === clock(), 'now() is legal in READY (a live state)');
    expectErrnoSync(() => ctx.on_signal('SIGTERM', 'ignore'), 'ESTATE'); // on_signal needs RUNNING
    expectErrnoSync(() => k.context(asProcessId(9999)), 'ESRCH'); // unknown pid
  });

  await checkAsync('ctx.exit() throws ProcessExitSignal synchronously', async () => {
    agentImpls.set('./agents/noop2.js', async () => {});
    const { k } = await makeKernel();
    const pid = await k.spawn({ role: 'w', agent: { module: './agents/noop2.js' } });
    const ctx = k.context(pid);
    let caught: unknown;
    try {
      ctx.exit(3, 'x');
    } catch (e) {
      caught = e;
    }
    assert(isProcessExitSignal(caught), 'exit throws the sentinel');
    assert((caught as ProcessExitSignal).exitCode === 3, 'carries the code');
  });

  // --- §5 round-robin scheduling across ticks -------------------------------

  await checkAsync('two READY processes run round-robin, one per tick', async () => {
    const order: string[] = [];
    agentImpls.set('./agents/A.js', async () => {
      order.push('A');
    });
    agentImpls.set('./agents/B.js', async () => {
      order.push('B');
    });
    const { k } = await makeKernel();
    await k.spawn({ role: 'a', agent: { module: './agents/A.js' } });
    await k.spawn({ role: 'b', agent: { module: './agents/B.js' } });
    // Each tick dispatches ONE process. Its agent body finishes on the event
    // loop afterwards, so yield between ticks to observe the real ordering.
    const t1 = await k.scheduler.tick();
    await yieldOnce();
    const t2 = await k.scheduler.tick();
    await yieldOnce();
    assert(order.join('') === 'AB', `FIFO round-robin, got "${order.join('')}"`);
    assert(t1.dispatched !== null && t2.dispatched !== null, 'both processes got a quantum');
    const t3 = await k.scheduler.tick();
    assert(t3.reason === 'idle', 'nothing left to run');
  });

  // --- §6 checkpoint -> restore through the kernel --------------------------

  await checkAsync('checkpoint then restore mints a NEW pid with budgets + lineage', async () => {
    let chainId: ChainIdAlias | null = null;
    agentImpls.set('./agents/ckpt.js', async (ctx) => {
      await ctx.llm_call({ messages: [userMsg('remember')] }); // spend tokens
      const ref = await ctx.checkpoint({ tag: 'snap' });
      chainId = ref.chainId;
    });
    const { k } = await makeKernel();
    const origPid = await k.spawn({ role: 'worker', agent: { module: './agents/ckpt.js' }, budgets: { tokens: 100000 } });
    await k.settle();
    assert(chainId !== null, 'the agent captured a chainId');
    assert(k.table.get(origPid) === undefined, 'original reaped after exit');

    const restored = await k.dispatcher.invoke(PID_INIT, 'restore', chainId as ChainIdAlias);
    const newPid = restored.pid;
    assert(unbrand(newPid) !== unbrand(origPid), 'restore allocates a fresh pid');
    const e = k.table.get(newPid);
    assert(e !== undefined, 'restored process is in the table');
    // Was a known v0 gap: `restore` handed back a NEW process and the
    // scheduler only adopts READY, so it never ran unless the caller (the CLI,
    // via a stopgap) walked it forward itself. The dispatcher now adopts it.
    assert(e!.state === 'ready', `restore leaves the process READY to run, got ${e!.state}`);
    assert(e!.budgetsSpent.tokensIn > 0, 'spent budget carried across the checkpoint');
    assert(e!.checkpointChain.some((c) => unbrand(c) === unbrand(chainId as ChainIdAlias)), 'lineage continues the chain');

    // And "READY" must mean runnable, not merely labelled: settling the kernel
    // has to actually run the restored agent to completion without any help
    // from outside.
    await k.settle();
    const after = k.table.get(newPid);
    assert(
      after === undefined || after.state === 'zombie' || after.state === 'exiting',
      `a restored process runs on its own, got ${after?.state}`,
    );
  });

  // --- §7 fork through the kernel -------------------------------------------

  await checkAsync('ctx.fork() mints a child; orphan is reparented to init on parent exit', async () => {
    let childPid: ProcessIdAlias | null = null;
    let ppidAtFork: number | null = null;
    let kernelRef: Kernel | null = null;
    agentImpls.set('./agents/forker.js', async (ctx) => {
      const res = await ctx.fork();
      childPid = res.childPid;
      // Read the live table at fork time, before the quantum ends and init
      // reparents the (still-live) orphan.
      const c = kernelRef?.table.get(res.childPid);
      ppidAtFork = c?.ppid === null || c?.ppid === undefined ? null : unbrand(c.ppid);
    });
    const { k } = await makeKernel();
    kernelRef = k;
    const parent = await k.spawn({ role: 'p', agent: { module: './agents/forker.js' } });
    // Deliberately ONE tick, not `settle()`: the fork child inherits the forker's
    // agent, so scheduling it would fork again — and again — until the tick cap.
    // The point of this check is the fork itself plus orphan reparenting, so the
    // child stays READY (never dispatched) and therefore survives its parent.
    await k.scheduler.tick();
    await yieldOnce();
    assert(childPid !== null, 'fork returned a child pid');
    assert(unbrand(childPid as ProcessIdAlias) !== unbrand(parent), 'child has its own pid');
    assert(ppidAtFork === unbrand(parent), `child was parented to the forker at fork time, got ppid ${ppidAtFork} parent=${unbrand(parent)} child=${unbrand(childPid as ProcessIdAlias)} init=${unbrand(PID_INIT)}`);
    const child = k.table.get(childPid as ProcessIdAlias);
    assert(child !== undefined, 'child survives its parent');
    // The forker exited at the end of its quantum, so init reparented the orphan.
    assert(child!.ppid !== null && unbrand(child!.ppid) === unbrand(PID_INIT), 'orphan reparented to init after the parent exited');
  });

  // --- §7b the cooperative continuation (boot.ts "The execution model") ------

  await checkAsync('wait() on a spawned child returns its exit code (no deadlock)', async () => {
    const order: string[] = [];
    let waited: { code: number; reason: string } | null = null;
    agentImpls.set('./agents/leaf.js', async (ctx) => {
      order.push(`child:${unbrand(ctx.pid)}`);
      await ctx.llm_call({ messages: [userMsg('work')] });
      ctx.exit(3, 'leaf done');
    });
    agentImpls.set('./agents/sup.js', async (ctx) => {
      order.push(`parent:${unbrand(ctx.pid)}`);
      const { pid } = await ctx.spawn({ role: 'leaf', agent: { module: './agents/leaf.js' } });
      const res = await ctx.wait(pid);
      waited = { code: res.exitCode, reason: res.exitReason };
      order.push('parent:woke');
    });
    const { k } = await makeKernel();
    await k.spawn({ role: 'sup', agent: { module: './agents/sup.js' } });
    await k.settle();
    // The headline: with the cooperative continuation the child is dispatched
    // *between* the parent's spawn and its wake. Run-to-completion could never
    // produce this interleaving — it deadlocked instead.
    assert(order.join(' > ') === 'parent:2 > child:3 > parent:woke',
      `expected parent > child > parent-woke, got "${order.join(' > ')}"`);
    assert(waited !== null && (waited as { code: number }).code === 3,
      `wait() saw the child's exit code, got ${JSON.stringify(waited)}`);
    assert((waited as { reason: string }).reason === 'leaf done', 'and its exit reason');
  });

  await checkAsync('a woken parent resumes inside a quantum: syscalls after wait() are legal', async () => {
    // The wake-gate guarantee (kernel/wake_gate.ts). Resolving the parked
    // `wait()` inline would let the body run its next syscall while the process
    // is still BLOCKED/READY — and llm_call/tool_call/send are ['running']-only,
    // so it would trap ESTATE.
    let afterWait = '';
    agentImpls.set('./agents/leaf2.js', async (ctx) => {
      await ctx.llm_call({ messages: [userMsg('leaf work')] });
    });
    agentImpls.set('./agents/sup2.js', async (ctx) => {
      const { pid } = await ctx.spawn({ role: 'leaf', agent: { module: './agents/leaf2.js' } });
      await ctx.wait(pid);
      const r = await ctx.llm_call({ messages: [userMsg('after wait')] });
      afterWait = r.content;
    });
    const { k } = await makeKernel();
    await k.spawn({ role: 'sup', agent: { module: './agents/sup2.js' } });
    await k.settle();
    assert(afterWait !== '', 'the parent completed an llm_call after wait() returned');
  });

  await checkAsync('a supervisor waits for several children in sequence', async () => {
    const codes: number[] = [];
    agentImpls.set('./agents/worker.js', async (ctx, args) => {
      await ctx.llm_call({ messages: [userMsg('task')] });
      ctx.exit((args['code'] as number | undefined) ?? 0, 'finished');
    });
    agentImpls.set('./agents/tree.js', async (ctx) => {
      const a = await ctx.spawn({ role: 'w', agent: { module: './agents/worker.js', args: { code: 0 } } });
      const b = await ctx.spawn({ role: 'w', agent: { module: './agents/worker.js', args: { code: 5 } } });
      codes.push((await ctx.wait(a.pid)).exitCode);
      codes.push((await ctx.wait(b.pid)).exitCode);
    });
    const { k } = await makeKernel();
    await k.spawn({ role: 'sup', agent: { module: './agents/tree.js' } });
    await k.settle();
    assert(codes.join(',') === '0,5', `a supervision tree reaps both children, got [${codes.join(',')}]`);
  });

  await checkAsync('wait() cannot collect the same child twice (ESRCH on the second)', async () => {
    // Regression: a completed child's status was retained without being
    // consumed on delivery, so a second wait() for the SAME child handed the
    // status back a second time — impossible under real Unix wait() semantics.
    const log: string[] = [];
    agentImpls.set('./agents/once.js', async (ctx) => {
      await ctx.sleep(5);
    });
    agentImpls.set('./agents/double-wait.js', async (ctx) => {
      const { pid } = await ctx.spawn({ role: 'once', agent: { module: './agents/once.js' } });
      // First wait parks (child is still sleeping), then is woken on exit.
      const r = await ctx.wait(pid);
      log.push(`ok:${r.exitCode}`);
      // The child is gone now — a second collection must fail.
      try {
        await ctx.wait(pid);
        log.push('returned');
      } catch (err) {
        log.push(isCortexError(err) ? (err as CortexError).errno : `other:${String(err)}`);
      }
    });
    const { k } = await makeKernel();
    await k.spawn({ role: 'parent', agent: { module: './agents/double-wait.js' } });
    await k.settle(200, timerYield);
    assert(log.join(',') === 'ok:0,ESRCH',
      `first wait succeeds, second traps ESRCH, got "${log.join(',')}"`);
  });

  await checkAsync('ps() reports a sleeping agent as blocked on its timer, not runnable', async () => {
    // The end-to-end half of the sleep fix: under a real kernel (wake gate +
    // scheduler), a process inside ctx.sleep() must read `blocked` with
    // blockedOn.kind === 'sleep'. Before the fix it stayed RUNNING for the
    // whole nap, so `ps` lied about what the agent was doing.
    const seen: string[] = [];
    agentImpls.set('./agents/sleeper.js', async (ctx) => {
      await ctx.sleep(150);
    });
    agentImpls.set('./agents/watcher.js', async (ctx) => {
      const { pid } = await ctx.spawn({
        role: 'sleeper',
        agent: { module: './agents/sleeper.js' },
      });
      await ctx.sleep(20); // let the child reach its own sleep
      const all = await ctx.ps();
      const info = all.find((p) => p.pid === pid);
      seen.push(info === undefined ? 'missing' : `${info.state}:${info.blockedOn?.kind ?? 'none'}`);
      const r = await ctx.wait(pid);
      seen.push(`exit:${r.exitCode}`);
    });
    const { k } = await makeKernel();
    await k.spawn({ role: 'watcher', agent: { module: './agents/watcher.js' } });
    await k.settle(300, timerYield);
    assert(
      seen.join(',') === 'blocked:sleep,exit:0',
      `a sleeping child reads blocked on its timer, got "${seen.join(',')}"`,
    );
  });

  await checkAsync('wait(pid, { timeoutMs }) traps ETIMEDOUT: a supervisor can bound a child', async () => {
    const log: string[] = [];
    agentImpls.set('./agents/slow.js', async (ctx) => {
      await ctx.sleep(80); // "hung" from the planner's point of view
    });
    agentImpls.set('./agents/quick.js', async (ctx) => {
      await ctx.llm_call({ messages: [userMsg('fast')] });
    });
    agentImpls.set('./agents/planner.js', async (ctx) => {
      const { pid } = await ctx.spawn({ role: 'slow', agent: { module: './agents/slow.js' } });
      try {
        await ctx.wait(pid, { timeoutMs: 10 });
        log.push('returned');
      } catch (err) {
        log.push(isCortexError(err) ? (err as CortexError).errno : `other:${String(err)}`);
      }
      // The timeout deliberately does NOT kill the child — that is the
      // supervisor's decision, and `kill()` is its own syscall.
      await ctx.kill(pid, 'SIGKILL');
      log.push('killed');
      const repl = await ctx.spawn({ role: 'quick', agent: { module: './agents/quick.js' } });
      const res = await ctx.wait(repl.pid);
      log.push(`replacement:${res.exitCode}`);
    });
    const { k } = await makeKernel();
    await k.spawn({ role: 'planner', agent: { module: './agents/planner.js' } });
    await k.settle(200, timerYield);
    assert(log.join(',') === 'ETIMEDOUT,killed,replacement:0',
      `expected timeout → kill → replacement, got "${log.join(',')}"`);
  });

  await checkAsync('wait(pid, { timeoutMs: 0 }) polls instead of parking', async () => {
    let first = '';
    let second = '';
    agentImpls.set('./agents/nap.js', async (ctx) => {
      await ctx.sleep(40);
    });
    agentImpls.set('./agents/poller.js', async (ctx) => {
      const { pid } = await ctx.spawn({ role: 'nap', agent: { module: './agents/nap.js' } });
      try {
        await ctx.wait(pid, { timeoutMs: 0 });
        first = 'returned';
      } catch (err) {
        first = isCortexError(err) ? (err as CortexError).errno : `other:${String(err)}`;
      }
      // Still RUNNING here: a poll never parks, so there was no BLOCKED →
      // wake round trip to come back from.
      second = (await ctx.ps({ pid: ctx.pid }))[0]?.state ?? 'gone';
      await ctx.wait(pid);
    });
    const { k } = await makeKernel();
    await k.spawn({ role: 'poller', agent: { module: './agents/poller.js' } });
    await k.settle(200, timerYield);
    assert(first === 'ETIMEDOUT', `a poll on a live child times out at once, got "${first}"`);
    assert(second === 'running', `the poller never left RUNNING, got "${second}"`);
  });

  await checkAsync('an agent body is never started twice across dispatches', async () => {
    let starts = 0;
    agentImpls.set('./agents/leaf3.js', async (ctx) => {
      starts++;
      await ctx.llm_call({ messages: [userMsg('once')] });
    });
    agentImpls.set('./agents/sup3.js', async (ctx) => {
      const { pid } = await ctx.spawn({ role: 'leaf', agent: { module: './agents/leaf3.js' } });
      await ctx.wait(pid);
    });
    const { k } = await makeKernel();
    await k.spawn({ role: 'sup', agent: { module: './agents/sup3.js' } });
    await k.settle();
    // The child is dispatched once to start its body; every later dispatch of a
    // live process must release its wake, not re-enter the agent.
    assert(starts === 1, `the leaf's body ran exactly once, got ${starts}`);
  });

  // --- §8 shutdown ----------------------------------------------------------

  await checkAsync('shutdown() quiesces children, closes drivers, is idempotent', async () => {
    agentImpls.set('./agents/idle.js', async () => {});
    const { k, mock } = await makeKernel();
    const pid = await k.spawn({ role: 'idle', agent: { module: './agents/idle.js' } });
    assert(k.table.get(pid)?.state === 'ready', 'child parked READY (never ticked)');
    const report = await k.shutdown();
    assert(typeof report.finishedAt === 'string', 'report carries a timestamp');
    assert(Array.isArray(report.signalled) && Array.isArray(report.reaped), 'report shape');
    assert(mock.closed === true, 'the LLM driver was closed');
    const again = await k.shutdown();
    assert(again === report, 'a second shutdown returns the cached report');
  });

  // --- cleanup --------------------------------------------------------------
  for (const k of kernels) {
    try {
      await k.shutdown();
    } catch {
      /* already down */
    }
    for (const pid of k.table.pids()) {
      const rec = k.table.recorderFor(pid);
      if (rec !== null) await rec.close().catch(() => {});
    }
  }
  await rm(tmp, { recursive: true, force: true });
}

async function runDeepseekChecks(): Promise<void> {
  const fakeNow = Date.UTC(2026, 0, 1, 0, 0, 0);
  const clock = (): string => new Date(fakeNow).toISOString();
  const userMsg = (content: string): Message => ({ role: 'user', content });

  const ctx = (over: Record<string, unknown> = {}) => ({
    pid: asProcessId(2),
    callId: 'c1',
    deadline: clock(),
    abortSignal: new AbortController().signal,
    kernelAbiVersion: KERNEL_ABI_VERSION,
    ...over,
  });

  async function expectErrno(fn: () => Promise<unknown>, errno: string): Promise<void> {
    let caught: unknown = null;
    try {
      await fn();
    } catch (e) {
      caught = e;
    }
    assert(isCortexError(caught), `expected a CortexError, got ${String(caught)}`);
    assert(
      (caught as CortexError).errno === errno,
      `expected errno ${errno}, got ${(caught as CortexError).errno}: ${(caught as CortexError).message}`,
    );
  }

  // --- fake transport -------------------------------------------------------

  function jsonResponse(status: number, body: unknown): FetchResponseLike {
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return body;
      },
      async text() {
        return JSON.stringify(body);
      },
    };
  }

  function errorResponse(status: number, text: string): FetchResponseLike {
    return {
      ok: false,
      status,
      async json() {
        throw new Error('body is not JSON');
      },
      async text() {
        return text;
      },
    };
  }

  function makeFetch(
    responder: (url: string, init: RequestInit) => FetchResponseLike | Promise<FetchResponseLike>,
  ): { fn: FetchFn; calls: { url: string; init: RequestInit }[] } {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn: FetchFn = async (url, init) => {
      calls.push({ url, init });
      return responder(url, init);
    };
    return { fn, calls };
  }

  const okBody = {
    model: 'deepseek-chat',
    choices: [{ message: { role: 'assistant', content: 'Hello there!' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } },
  };

  // --- §1 identity / defaults ----------------------------------------------

  check('DeepSeekLLMDriver defaults match DEEPSEEK_DEFAULTS', () => {
    const d = new DeepSeekLLMDriver();
    assert(d.name === DEEPSEEK_DEFAULTS.name, `name ${d.name}`);
    assert(d.version === DEEPSEEK_DEFAULTS.version, 'version');
    assert(d.abiCompat === DEEPSEEK_DEFAULTS.abiCompat, 'abiCompat');
    assert(d.supportedModels.includes('deepseek-chat'), 'chat model claimed');
    assert(d.supportedModels.includes('deepseek-reasoner'), 'reasoner model claimed');
    assert(d.closed === false, 'fresh driver is open');
  });

  check('deepseek abiCompat admits the live kernel ABI', () => {
    assert(satisfiesAbi(KERNEL_ABI_VERSION, deepseekLLM().abiCompat) === true, 'registry would accept it');
  });

  check('deepseekLLM() factory honors option overrides', () => {
    const d = deepseekLLM({ name: 'ds2', defaultModel: 'deepseek-reasoner', baseUrl: 'https://example.test/api/' });
    assert(d.name === 'ds2', 'name override');
    assert(d.abiCompat === DEEPSEEK_DEFAULTS.abiCompat, 'abiCompat default kept');
  });

  // --- §2 errno map ---------------------------------------------------------

  check('errnoForStatus maps HTTP statuses onto stable errnos', () => {
    assert(errnoForStatus(400) === 'EINVAL', '400 -> EINVAL');
    assert(errnoForStatus(401) === 'EPERM', '401 -> EPERM');
    assert(errnoForStatus(403) === 'EPERM', '403 -> EPERM');
    assert(errnoForStatus(404) === 'ENOENT', '404 -> ENOENT');
    assert(errnoForStatus(408) === 'ETIMEDOUT', '408 -> ETIMEDOUT');
    assert(errnoForStatus(429) === 'EAGAIN', '429 -> EAGAIN');
    assert(errnoForStatus(500) === 'EDRIVER', '500 -> EDRIVER');
    assert(errnoForStatus(503) === 'EDRIVER', 'unknown -> EDRIVER');
  });

  // --- §3 token + cost heuristics ------------------------------------------

  check('estimateDeepSeekTokens is CJK-aware', () => {
    assert(DEEPSEEK_CHARS_PER_TOKEN === 4, 'divisor is 4');
    assert(estimateDeepSeekTokens('') === 0, 'empty -> 0');
    assert(estimateDeepSeekTokens('abcd') === 1, '4 latin chars -> 1');
    assert(estimateDeepSeekTokens('abcde') === 2, '5 latin chars -> 2');
    assert(estimateDeepSeekTokens('你好') === 2, '2 CJK chars -> 2 tokens');
    assert(estimateDeepSeekTokens('你好ab') === 3, '2 CJK + ceil(2/4)=1 -> 3');
  });

  check('estimateDeepSeekMessageTokens adds 1 framing token per message', () => {
    assert(estimateDeepSeekMessageTokens([]) === 0, 'no messages -> 0');
    assert(estimateDeepSeekMessageTokens([userMsg('你好')]) === 3, 'content 2 + framing 1');
  });

  check('computeUsd bills cached input at the discount rate', () => {
    assert(computeUsd('deepseek-chat', 1_000_000, 0, 0) === 0.14, '1M fresh input -> $0.14');
    assert(computeUsd('deepseek-chat', 0, 1_000_000, 0) === 0.28, '1M output -> $0.28');
    assert(computeUsd('deepseek-chat', 1_000_000, 0, 1_000_000) === 0.014, '1M cached input -> $0.014');
    assert(computeUsd('deepseek-reasoner', 1_000_000, 0, 0) === 0.55, 'reasoner input rate');
    assert(computeUsd('unknown-model', 1_000_000, 0, 0) === 0.14, 'unknown model falls back to chat rate');
    assert(DEEPSEEK_PRICING['deepseek-chat'] !== undefined, 'chat pricing present');
  });

  // --- §4 request shaping ---------------------------------------------------

  await checkAsync('call() POSTs an OpenAI-compatible body with auth + tools', async () => {
    const { fn, calls } = makeFetch(() => jsonResponse(200, okBody));
    const d = deepseekLLM({ apiKey: 'sk-test', fetchFn: fn });
    const tool = { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
    await d.call(
      { messages: [userMsg('hi')], tools: [tool], temperature: 0.3, maxTokens: 64, seed: 7, model: 'deepseek-chat' },
      ctx(),
    );
    assert(calls.length === 1, 'exactly one HTTP call');
    const c = calls[0]!;
    assert(c.url === 'https://api.deepseek.com/chat/completions', `url ${c.url}`);
    assert(c.init.method === 'POST', 'POST');
    const headers = c.init.headers as Record<string, string>;
    assert(headers['authorization'] === 'Bearer sk-test', 'bearer token sent');
    assert(headers['content-type'] === 'application/json', 'json content type');
    const body = JSON.parse(String(c.init.body)) as Record<string, unknown>;
    assert(body['model'] === 'deepseek-chat', 'model in body');
    assert(body['stream'] === false, 'stream false in v0');
    assert(Array.isArray(body['messages']) && (body['messages'] as unknown[]).length === 1, 'messages forwarded');
    assert(body['temperature'] === 0.3 && body['max_tokens'] === 64 && body['seed'] === 7, 'sampling params forwarded');
    const tools = body['tools'] as Array<Record<string, unknown>>;
    assert(tools.length === 1 && tools[0]!['type'] === 'function', 'tool wrapped as a function');
    const fnShape = tools[0]!['function'] as Record<string, unknown>;
    assert(fnShape['name'] === 'get_weather', 'tool name forwarded');
  });

  await checkAsync('call() trims a trailing slash on baseUrl and merges custom headers', async () => {
    const { fn, calls } = makeFetch(() => jsonResponse(200, okBody));
    const d = deepseekLLM({ apiKey: 'k', baseUrl: 'https://gw.example.com/v1/', headers: { 'x-proxy': 'on' }, fetchFn: fn });
    await d.call({ messages: [userMsg('hi')] }, ctx());
    assert(calls[0]!.url === 'https://gw.example.com/v1/chat/completions', `url ${calls[0]!.url}`);
    assert((calls[0]!.init.headers as Record<string, string>)['x-proxy'] === 'on', 'custom header merged');
  });

  await checkAsync('apiKey resolves from the injected env when not passed', async () => {
    const { fn, calls } = makeFetch(() => jsonResponse(200, okBody));
    const d = deepseekLLM({ env: { DEEPSEEK_API_KEY: 'sk-env' }, fetchFn: fn });
    await d.call({ messages: [userMsg('hi')] }, ctx());
    assert((calls[0]!.init.headers as Record<string, string>)['authorization'] === 'Bearer sk-env', 'env key used');
  });

  // --- §5 response mapping --------------------------------------------------

  await checkAsync('call() maps a successful completion into an LLMResponse', async () => {
    const { fn } = makeFetch(() => jsonResponse(200, okBody));
    const d = deepseekLLM({ apiKey: 'k', fetchFn: fn });
    const res = await d.call({ messages: [userMsg('hi')] }, ctx());
    assert(res.text === 'Hello there!', `text ${res.text}`);
    assert(res.finishReason === 'stop', 'finish stop');
    assert(res.toolCalls.length === 0, 'no tool calls');
    assert(res.usage.inputTokens === 10 && res.usage.outputTokens === 5 && res.usage.cachedTokens === 4, 'usage counters mapped');
    assert(res.usage.usd === computeUsd('deepseek-chat', 10, 5, 4), `usd ${res.usage.usd}`);
    assert(res.model === 'deepseek-chat', 'response model wins');
    assert(res.driverVersion === d.version, 'driverVersion stamped');
  });

  await checkAsync('call() parses tool_calls and maps finish_reason tool_calls -> tool_use', async () => {
    const toolBody = {
      model: 'deepseek-chat',
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Shenzhen"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 20, completion_tokens: 8 },
    };
    const { fn } = makeFetch(() => jsonResponse(200, toolBody));
    const d = deepseekLLM({ apiKey: 'k', fetchFn: fn });
    const res = await d.call({ messages: [userMsg('weather?')] }, ctx());
    assert(res.text === null, 'null text on a tool-only turn');
    assert(res.finishReason === 'tool_use', 'tool_calls -> tool_use');
    assert(res.toolCalls.length === 1, 'one tool call');
    const tc = res.toolCalls[0]!;
    assert(tc.id === 'call_1' && tc.name === 'get_weather', 'tool identity');
    assert(JSON.stringify(tc.arguments) === JSON.stringify({ city: 'Shenzhen' }), 'arguments JSON-parsed');
    assert(res.usage.cachedTokens === 0, 'absent cached_tokens -> 0');
  });

  await checkAsync('call() falls back to the requested model when the body omits one', async () => {
    const body = { choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    const { fn } = makeFetch(() => jsonResponse(200, body));
    const d = deepseekLLM({ apiKey: 'k', fetchFn: fn });
    const res = await d.call({ messages: [userMsg('hi')], model: 'deepseek-reasoner' }, ctx());
    assert(res.model === 'deepseek-reasoner', `model ${res.model}`);
  });

  // --- §6 error translation -------------------------------------------------

  await checkAsync('a missing API key traps EINVAL before any fetch', async () => {
    const { fn, calls } = makeFetch(() => jsonResponse(200, okBody));
    const d = deepseekLLM({ env: {}, fetchFn: fn });
    await expectErrno(() => d.call({ messages: [userMsg('hi')] }, ctx()), 'EINVAL');
    assert(calls.length === 0, 'no HTTP call without a key');
  });

  await checkAsync('HTTP error statuses translate to the mapped errno', async () => {
    const cases: Array<[number, string]> = [[429, 'EAGAIN'], [401, 'EPERM'], [404, 'ENOENT'], [400, 'EINVAL'], [500, 'EDRIVER']];
    for (const [status, errno] of cases) {
      const { fn } = makeFetch(() => errorResponse(status, `vendor says ${status}`));
      const d = deepseekLLM({ apiKey: 'k', fetchFn: fn });
      await expectErrno(() => d.call({ messages: [userMsg('hi')] }, ctx()), errno);
    }
  });

  await checkAsync('an aborted request maps to ETIMEDOUT', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const { fn } = makeFetch(() => {
      throw abortErr;
    });
    const d = deepseekLLM({ apiKey: 'k', fetchFn: fn });
    await expectErrno(() => d.call({ messages: [userMsg('hi')] }, ctx()), 'ETIMEDOUT');
  });

  await checkAsync('a generic transport failure wraps to EDRIVER and preserves cause', async () => {
    const netErr = new Error('ECONNREFUSED');
    const { fn } = makeFetch(() => {
      throw netErr;
    });
    const d = deepseekLLM({ apiKey: 'k', fetchFn: fn });
    let caught: unknown = null;
    try {
      await d.call({ messages: [userMsg('hi')] }, ctx());
    } catch (e) {
      caught = e;
    }
    assert(isCortexError(caught), 'is a CortexError');
    assert((caught as CortexError).errno === 'EDRIVER', `errno ${(caught as CortexError).errno}`);
    assert((caught as CortexError).cause === netErr, 'original error preserved as cause');
  });

  await checkAsync('a non-JSON 200 body traps EDRIVER', async () => {
    const { fn } = makeFetch(() => ({
      ok: true,
      status: 200,
      async json() {
        throw new Error('unexpected token');
      },
      async text() {
        return '<html>oops</html>';
      },
    }));
    const d = deepseekLLM({ apiKey: 'k', fetchFn: fn });
    await expectErrno(() => d.call({ messages: [userMsg('hi')] }, ctx()), 'EDRIVER');
  });

  await checkAsync('a completion with no choices traps EDRIVER', async () => {
    const { fn } = makeFetch(() => jsonResponse(200, { choices: [], usage: {} }));
    const d = deepseekLLM({ apiKey: 'k', fetchFn: fn });
    await expectErrno(() => d.call({ messages: [userMsg('hi')] }, ctx()), 'EDRIVER');
  });

  await checkAsync('a closed driver traps EDRIVER', async () => {
    const { fn } = makeFetch(() => jsonResponse(200, okBody));
    const d = deepseekLLM({ apiKey: 'k', fetchFn: fn });
    await d.close();
    assert(d.closed === true, 'closed flag set');
    await expectErrno(() => d.call({ messages: [userMsg('hi')] }, ctx()), 'EDRIVER');
  });

  // --- §7 optional surface + registry --------------------------------------

  await checkAsync('countTokens uses the CJK-aware heuristic', async () => {
    const d = deepseekLLM({ apiKey: 'k' });
    const n = await d.countTokens([userMsg('你好world')]);
    assert(n === estimateDeepSeekMessageTokens([userMsg('你好world')]), `countTokens ${n}`);
  });

  await checkAsync('deepseek registers into DriverRegistry: streams false, countsTokens true', async () => {
    const { fn } = makeFetch(() => jsonResponse(200, okBody));
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    reg.registerLLM(deepseekLLM({ apiKey: 'k', fetchFn: fn }));
    assert(reg.hasLLM('deepseek'), 'registered');
    assert(reg.resolveLLM().name === 'deepseek', 'resolves as default');
    const info = reg.listAll().llm.find((m) => m.name === 'deepseek');
    assert(info !== undefined, 'surfaced in listAll');
    assert(info!.streams === false, 'no stream() in v0');
    assert(info!.countsTokens === true, 'countTokens present');
    await reg.closeAll();
  });

  await checkAsync('E2E: llm_call through the registry resolver reaches deepseek', async () => {
    const { fn } = makeFetch(() => jsonResponse(200, okBody));
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    reg.registerLLM(deepseekLLM({ apiKey: 'k', fetchFn: fn }));
    const table = new ProcessTable({ kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
    const signals = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
    const dispatcher = new SyscallDispatcher({
      table,
      signals,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      resolveLLM: reg.llmResolver(),
      resolveTool: reg.toolResolver(),
    });
    const pid = await table.allocate({ ppid: null, role: 'worker', agent: { module: './agents/noop.js' } });
    await table.setState(pid, 'ready', { trigger: 'test' });
    await table.setState(pid, 'running', { trigger: 'test' });
    const res = await dispatcher.invoke(pid, 'llm_call', { messages: [userMsg('ping')] });
    assert(res.text === 'Hello there!', `reply via syscall: ${res.text}`);
    assert(res.usage.inputTokens === 10, 'usage flowed from the driver');
    await reg.closeAll();
  });
}

// =============================================================================
// OpenAI LLM driver checks
// =============================================================================

async function runOpenAiChecks(): Promise<void> {
  const userMsg = (content: string): Message => ({ role: 'user', content });
  const ctx = (over: Record<string, unknown> = {}) => ({
    pid: asProcessId(2),
    callId: 'c1',
    deadline: new Date().toISOString(),
    abortSignal: new AbortController().signal,
    kernelAbiVersion: KERNEL_ABI_VERSION,
    ...over,
  });

  function jsonResponse(status: number, body: unknown): OpenAiFetchResponseLike {
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return body; },
      async text() { return JSON.stringify(body); },
    };
  }

  function makeFetch(responder: (url: string, init: RequestInit) => OpenAiFetchResponseLike | Promise<OpenAiFetchResponseLike>): { fn: OpenAiFetchFn; calls: { url: string; init: RequestInit }[] } {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn: OpenAiFetchFn = async (url, init) => { calls.push({ url, init }); return responder(url, init); };
    return { fn, calls };
  }

  const okBody = {
    model: 'gpt-4o-mini',
    choices: [{ message: { role: 'assistant', content: 'Hello from OpenAI!' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } },
  };

  check('OpenAiLLMDriver defaults match OPENAI_DEFAULTS', () => {
    const d = new OpenAiLLMDriver();
    assert(d.name === OPENAI_DEFAULTS.name, `name ${d.name}`);
    assert(d.version === OPENAI_DEFAULTS.version, 'version');
    assert(d.abiCompat === OPENAI_DEFAULTS.abiCompat, 'abiCompat');
    assert(d.supportedModels.includes('gpt-4o-mini'), 'mini model claimed');
    assert(d.supportedModels.includes('o1'), 'o1 model claimed');
    assert(d.closed === false, 'fresh driver is open');
  });

  check('openai abiCompat admits the live kernel ABI', () => {
    assert(satisfiesAbi(KERNEL_ABI_VERSION, openaiLLM().abiCompat) === true, 'registry would accept it');
  });

  check('openaiErrnoForStatus maps HTTP statuses onto stable errnos', () => {
    assert(openaiErrnoForStatus(400) === 'EINVAL', '400 -> EINVAL');
    assert(openaiErrnoForStatus(401) === 'EPERM', '401 -> EPERM');
    assert(openaiErrnoForStatus(404) === 'ENOENT', '404 -> ENOENT');
    assert(openaiErrnoForStatus(429) === 'EAGAIN', '429 -> EAGAIN');
    assert(openaiErrnoForStatus(500) === 'EDRIVER', '500 -> EDRIVER');
  });

  check('estimateOpenAiTokens is CJK-aware', () => {
    assert(estimateOpenAiTokens('') === 0, 'empty -> 0');
    assert(estimateOpenAiTokens('hello') === 2, '5 chars / 4 = ceil 2');
    assert(estimateOpenAiTokens('你好') === 2, '2 CJK chars -> 2 tokens');
    assert(estimateOpenAiTokens('你好ab') === 3, '2 CJK + ceil(2/4)=1 -> 3');
  });

  check('computeOpenAiUsd bills cached input at the discount rate', () => {
    assert(computeOpenAiUsd('gpt-4o-mini', 1_000_000, 0, 0) === 0.15, '1M fresh input -> $0.15');
    assert(computeOpenAiUsd('gpt-4o-mini', 0, 1_000_000, 0) === 0.6, '1M output -> $0.6');
    assert(computeOpenAiUsd('gpt-4o-mini', 1_000_000, 0, 1_000_000) === 0.075, '1M cached input -> $0.075');
    assert(computeOpenAiUsd('gpt-4o', 1_000_000, 0, 0) === 2.5, 'gpt-4o input rate');
    assert(computeOpenAiUsd('unknown-model', 1_000_000, 0, 0) === 0.15, 'unknown falls back to mini rate');
  });

  await checkAsync('call() POSTs to OpenAI endpoint with auth', async () => {
    const { fn, calls } = makeFetch(() => jsonResponse(200, okBody));
    const d = openaiLLM({ apiKey: 'sk-test', fetchFn: fn });
    await d.call({ messages: [userMsg('hi')] }, ctx());
    assert(calls.length === 1, 'exactly one HTTP call');
    const c = calls[0]!;
    assert(c.url === 'https://api.openai.com/v1/chat/completions', `url ${c.url}`);
    assert(c.init.method === 'POST', 'POST');
    const headers = c.init.headers as Record<string, string>;
    assert(headers['authorization'] === 'Bearer sk-test', 'bearer token sent');
    const body = JSON.parse(String(c.init.body)) as Record<string, unknown>;
    assert(body['model'] === 'gpt-4o-mini', 'default model in body');
    assert(body['stream'] === false, 'stream false');
  });

  await checkAsync('call() omits temperature for o1/o3 models', async () => {
    const { fn, calls } = makeFetch(() => jsonResponse(200, { ...okBody, model: 'o1-mini' }));
    const d = openaiLLM({ apiKey: 'k', fetchFn: fn });
    await d.call({ messages: [userMsg('hi')], temperature: 0.3, model: 'o1-mini' }, ctx());
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    assert(body['temperature'] === undefined, 'temperature omitted for o1');
    assert(body['model'] === 'o1-mini', 'model forwarded');
  });

  await checkAsync('call() maps a successful completion into an LLMResponse', async () => {
    const { fn } = makeFetch(() => jsonResponse(200, okBody));
    const d = openaiLLM({ apiKey: 'k', fetchFn: fn });
    const res = await d.call({ messages: [userMsg('hi')] }, ctx());
    assert(res.text === 'Hello from OpenAI!', `text ${res.text}`);
    assert(res.finishReason === 'stop', 'finish stop');
    assert(res.usage.inputTokens === 10 && res.usage.outputTokens === 5 && res.usage.cachedTokens === 3, 'usage counters');
    assert(res.usage.usd === computeOpenAiUsd('gpt-4o-mini', 10, 5, 3), `usd ${res.usage.usd}`);
    assert(res.model === 'gpt-4o-mini', 'response model');
    assert(res.driverVersion === d.version, 'driverVersion stamped');
  });

  await checkAsync('call() parses tool_calls', async () => {
    const toolBody = {
      model: 'gpt-4o-mini',
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 20, completion_tokens: 8 },
    };
    const { fn } = makeFetch(() => jsonResponse(200, toolBody));
    const d = openaiLLM({ apiKey: 'k', fetchFn: fn });
    const res = await d.call({ messages: [userMsg('weather?')] }, ctx());
    assert(res.text === null, 'null text on tool-only turn');
    assert(res.finishReason === 'tool_use', 'tool_calls -> tool_use');
    assert(res.toolCalls.length === 1, 'one tool call');
    assert(res.toolCalls[0]!.name === 'get_weather', 'tool name');
  });

  await checkAsync('a missing API key traps EINVAL before any fetch', async () => {
    const d = openaiLLM({ apiKey: undefined, env: {} });
    let caught: unknown = null;
    try { await d.call({ messages: [userMsg('hi')] }, ctx()); } catch (e) { caught = e; }
    assert(isCortexError(caught), 'CortexError');
    assert((caught as CortexError).errno === 'EINVAL', 'EINVAL');
  });

  await checkAsync('HTTP error statuses translate to mapped errno', async () => {
    const { fn } = makeFetch(() => jsonResponse(429, { error: { message: 'rate limited' } }));
    const d = openaiLLM({ apiKey: 'k', fetchFn: fn });
    let caught: unknown = null;
    try { await d.call({ messages: [userMsg('hi')] }, ctx()); } catch (e) { caught = e; }
    assert(isCortexError(caught), 'CortexError');
    assert((caught as CortexError).errno === 'EAGAIN', '429 -> EAGAIN');
  });

  await checkAsync('a closed driver traps EDRIVER', async () => {
    const d = openaiLLM({ apiKey: 'k' });
    await d.close();
    let caught: unknown = null;
    try { await d.call({ messages: [userMsg('hi')] }, ctx()); } catch (e) { caught = e; }
    assert(isCortexError(caught), 'CortexError');
    assert((caught as CortexError).errno === 'EDRIVER', 'EDRIVER');
  });

  await checkAsync('openai registers into DriverRegistry', async () => {
    const { fn } = makeFetch(() => jsonResponse(200, okBody));
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    reg.registerLLM(openaiLLM({ apiKey: 'k', fetchFn: fn }));
    assert(reg.hasLLM('openai'), 'registered');
    assert(reg.resolveLLM().name === 'openai', 'resolves as default');
    await reg.closeAll();
  });
}

// =============================================================================
// FS tool driver checks
// =============================================================================

async function runFsChecks(): Promise<void> {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-fs-'));
  try {
    mkdirSync(join(tmp, 'sub'), { recursive: true });
    writeFileSync(join(tmp, 'a.txt'), 'hello world');
    writeFileSync(join(tmp, 'sub', 'b.ts'), 'export const x = 1;');

    check('FsToolDriver defaults match FS_DEFAULTS', () => {
      const d = new FsToolDriver();
      assert(d.name === FS_DEFAULTS.name, `name ${d.name}`);
      assert(d.version === FS_DEFAULTS.version, 'version');
      assert(d.abiCompat === FS_DEFAULTS.abiCompat, 'abiCompat');
      assert(d.closed === false, 'fresh driver is open');
      assert(d.forkable === true, 'forkable');
    });

    check('fs abiCompat admits the live kernel ABI', () => {
      assert(satisfiesAbi(KERNEL_ABI_VERSION, fsTool().abiCompat) === true, 'registry would accept it');
    });

    await checkAsync('listTools returns 4 tools', async () => {
      const d = fsTool({ root: tmp });
      const tools = await d.listTools();
      assert(tools.length === 4, `4 tools, got ${tools.length}`);
      assert(tools[0]!.name === 'fs_read', 'first is fs_read');
      assert(tools[1]!.name === 'fs_write', 'second is fs_write');
      assert(tools[2]!.name === 'fs_list', 'third is fs_list');
      assert(tools[3]!.name === 'fs_glob', 'fourth is fs_glob');
    });

    await checkAsync('fs_read reads file content', async () => {
      const d = fsTool({ root: tmp });
      const ctx = { pid: asProcessId(2), callId: 'c1', deadline: '', abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
      const res = await d.invoke('fs_read', { path: join(tmp, 'a.txt') }, ctx);
      const output = res.output as { content: string; size: number };
      assert(output.content === 'hello world', `content: ${output.content}`);
      assert(output.size === 11, `size: ${output.size}`);
      assert(res.error === null, 'no error');
    });

    await checkAsync('fs_write writes content (irreversible)', async () => {
      const d = fsTool({ root: tmp });
      const ctx = { pid: asProcessId(2), callId: 'c1', deadline: '', abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
      const res = await d.invoke('fs_write', { path: join(tmp, 'written.txt'), content: 'written!' }, ctx);
      const output = res.output as { bytes: number };
      assert(output.bytes === 8, `bytes: ${output.bytes}`);
      assert(res.reversibility === 'irreversible', `irreversible, got ${res.reversibility}`);
      // Verify file was written.
      const content = readFileSync(join(tmp, 'written.txt'), 'utf8');
      assert(content === 'written!', 'content matches');
    });

    await checkAsync('fs_list lists directory entries', async () => {
      const d = fsTool({ root: tmp });
      const ctx = { pid: asProcessId(2), callId: 'c1', deadline: '', abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
      const res = await d.invoke('fs_list', { path: tmp }, ctx);
      const output = res.output as { entries: Array<{ name: string; isFile: boolean }> };
      assert(output.entries.length >= 2, `at least 2 entries, got ${output.entries.length}`);
      const names = output.entries.map((e) => e.name);
      assert(names.includes('a.txt'), 'a.txt listed');
      assert(names.includes('sub'), 'sub listed');
    });

    await checkAsync('fs_glob finds matching files', async () => {
      const d = fsTool({ root: tmp });
      const ctx = { pid: asProcessId(2), callId: 'c1', deadline: '', abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
      const res = await d.invoke('fs_glob', { pattern: '**/*.ts', cwd: tmp }, ctx);
      const output = res.output as { matches: string[] };
      assert(output.matches.length >= 1, `at least 1 match, got ${output.matches.length}`);
      assert(output.matches.some((m) => m.includes('b.ts')), 'b.ts matched');
    });

    await checkAsync('fs_read on nonexistent file traps ENOENT', async () => {
      const d = fsTool({ root: tmp });
      const ctx = { pid: asProcessId(2), callId: 'c1', deadline: '', abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
      let caught: unknown = null;
      try { await d.invoke('fs_read', { path: join(tmp, 'nope.txt') }, ctx); } catch (e) { caught = e; }
      assert(isCortexError(caught), 'CortexError');
      assert((caught as CortexError).errno === 'ENOENT', 'ENOENT');
    });

    await checkAsync('path outside sandbox root traps EPERM', async () => {
      const d = fsTool({ root: tmp });
      const ctx = { pid: asProcessId(2), callId: 'c1', deadline: '', abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
      let caught: unknown = null;
      try { await d.invoke('fs_read', { path: '/etc/passwd' }, ctx); } catch (e) { caught = e; }
      assert(isCortexError(caught), 'CortexError');
      assert((caught as CortexError).errno === 'EPERM', 'EPERM');
    });

    await checkAsync('symlink/junction INSIDE the sandbox cannot escape to a target outside', async () => {
      // Regression: containment was checked on the LEXICAL path, so a reparse
      // point planted inside the root (symlink → file, or junction → dir) whose
      // real target lives outside read straight through the guard. The fix
      // canonicalises via realpath before checking.
      const { symlinkSync } = await import('node:fs');
      const outside = mkdtempSync(join(tmpdir(), 'cortex-fs-out-'));
      try {
        writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET');
        const linkFile = join(tmp, 'escape.txt');
        const linkDir = join(tmp, 'escapeDir');
        let targetPath = '';
        try {
          symlinkSync(join(outside, 'secret.txt'), linkFile);
          targetPath = linkFile;
        } catch {
          try {
            symlinkSync(outside, linkDir, 'junction');
            targetPath = join(linkDir, 'secret.txt');
          } catch {
            // No reparse points allowed here — nothing to test. Pass without
            // a false failure; Linux/macOS CI still exercises the real path.
            assert(true, 'skipped: symlinks/junctions not permitted on this platform');
            return;
          }
        }
        const d = fsTool({ root: tmp });
        const ctx = { pid: asProcessId(2), callId: 'c1', deadline: '', abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
        let caught: unknown = null;
        let out: unknown = null;
        try { out = (await d.invoke('fs_read', { path: targetPath }, ctx)).output; }
        catch (e) { caught = e; }
        assert(isCortexError(caught) && (caught as CortexError).errno === 'EPERM',
          `EPERM on symlink escape, got ${caught === null ? `READ OK ${JSON.stringify((out as { content?: string })?.content)}` : (caught as CortexError).errno}`);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    await checkAsync('unknown tool traps ENOENT', async () => {
      const d = fsTool({ root: tmp });
      const ctx = { pid: asProcessId(2), callId: 'c1', deadline: '', abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
      let caught: unknown = null;
      try { await d.invoke('fs_delete', {}, ctx); } catch (e) { caught = e; }
      assert(isCortexError(caught), 'CortexError');
      assert((caught as CortexError).errno === 'ENOENT', 'ENOENT');
    });

    await checkAsync('closed driver traps EDRIVER', async () => {
      const d = fsTool({ root: tmp });
      await d.close();
      const ctx = { pid: asProcessId(2), callId: 'c1', deadline: '', abortSignal: new AbortController().signal, kernelAbiVersion: KERNEL_ABI_VERSION };
      let caught: unknown = null;
      try { await d.invoke('fs_read', { path: join(tmp, 'a.txt') }, ctx); } catch (e) { caught = e; }
      assert(isCortexError(caught), 'CortexError');
      assert((caught as CortexError).errno === 'EDRIVER', 'EDRIVER');
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// =============================================================================
// MCP tool driver checks (#025)
// =============================================================================

interface FakeMcpToolDef {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly call?: (args: unknown) => {
    readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    readonly text?: string;
    readonly isError?: boolean;
    readonly structured?: unknown;
  };
  readonly rpcError?: { readonly code: number; readonly message: string };
}

interface FakeMcpServerOptions {
  readonly initializeError?: { readonly code: number; readonly message: string };
  /** Methods the server accepts and then never answers — drives timeout tests. */
  readonly silence?: readonly string[];
  readonly protocolVersion?: string;
  /** Emit `error: null` alongside a valid result (some lenient servers do). */
  readonly nullError?: boolean;
}

/**
 * An in-memory MCP server implementing the transport seam, so the whole
 * protocol path (handshake → tools/list → tools/call → error mapping) is
 * exercised without spawning a subprocess. Same trick as the injectable
 * `fetchFn` in the deepseek/openai drivers.
 */
class FakeMcpServer implements McpTransport {
  readonly received: JsonRpcMessage[] = [];
  closed = false;
  readonly #tools: readonly FakeMcpToolDef[];
  readonly #opts: FakeMcpServerOptions;
  #client: ((m: JsonRpcMessage) => void) | null = null;

  constructor(tools: readonly FakeMcpToolDef[] = [], opts: FakeMcpServerOptions = {}) {
    this.#tools = tools;
    this.#opts = opts;
  }

  send(msg: JsonRpcRequest | JsonRpcNotification): void {
    this.received.push(msg as JsonRpcMessage);
    if (!('id' in msg)) return;
    const req = msg as JsonRpcRequest;
    if (this.#opts.silence !== undefined && this.#opts.silence.includes(req.method)) {
      return;
    }
    const reply = this.#respond(req);
    // Async delivery: a real server never answers synchronously, and replying
    // inline would let the driver's await resolve before it registered pending.
    setTimeout(() => this.#client?.(reply), 0);
  }

  onMessage(handler: (msg: JsonRpcMessage) => void): void {
    this.#client = handler;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  #respond(req: JsonRpcRequest): JsonRpcMessage {
    if (req.method === 'initialize') {
      if (this.#opts.initializeError !== undefined) {
        return { jsonrpc: '2.0', id: req.id, error: this.#opts.initializeError };
      }
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: this.#opts.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake', version: '1.0.0' },
        },
      };
    }
    if (req.method === 'tools/list') {
      return { jsonrpc: '2.0', id: req.id, result: { tools: this.#tools } };
    }
    if (req.method === 'tools/call') {
      const params = req.params as { name?: string; arguments?: unknown };
      const tool = this.#tools.find((t) => t.name === params?.name);
      if (tool === undefined) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32601, message: `no such tool: ${String(params?.name)}` },
        };
      }
      if (tool.rpcError !== undefined) {
        return { jsonrpc: '2.0', id: req.id, error: tool.rpcError };
      }
      const r = tool.call?.(params?.arguments) ?? {};
      const content =
        r.content ?? (r.text !== undefined ? [{ type: 'text', text: r.text }] : []);
      const success: JsonRpcMessage = {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          content,
          ...(r.structured !== undefined ? { structuredContent: r.structured } : {}),
          ...(r.isError !== undefined ? { isError: r.isError } : {}),
        },
      };
      if (this.#opts.nullError === true) {
        return { ...(success as Record<string, unknown>), error: null } as unknown as JsonRpcMessage;
      }
      return success;
    }
    return {
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32601, message: `method not found: ${req.method}` },
    };
  }
}

function mcpCtx(over: Partial<ToolInvokeContext> = {}): ToolInvokeContext {
  return {
    pid: asProcessId(2),
    callId: 'mcp-1',
    deadline: '',
    abortSignal: new AbortController().signal,
    kernelAbiVersion: KERNEL_ABI_VERSION,
    ...over,
  };
}

/**
 * A minimal real MCP server, run as a subprocess over stdio. Proves the
 * StdioMcpTransport framing (newline-delimited JSON, not LSP headers) actually
 * works — the fake server above cannot cover that.
 */
const MCP_ECHO_SERVER = `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (c) {
  buf += c;
  var i = buf.indexOf('\\n');
  while (i >= 0) {
    var line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    i = buf.indexOf('\\n');
    if (line.length === 0) continue;
    var m; try { m = JSON.parse(line); } catch (e) { continue; }
    handle(m);
  }
});
function send(o) { process.stdout.write(JSON.stringify(o) + '\\n'); }
function handle(m) {
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'echo', version: '1.0.0' } } });
    return;
  }
  if (m.method === 'notifications/initialized') { return; }
  if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Echo a message back.', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }] } });
    return;
  }
  if (m.method === 'tools/call') {
    var msg = (m.params && m.params.arguments && m.params.arguments.message) || '';
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo: ' + String(msg) }], isError: false } });
    return;
  }
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
}
`;

function fakeServer(): FakeMcpServer {
  return new FakeMcpServer(
    [
      {
        name: 'read_file',
        description: 'Read a file.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        call: () => ({ text: 'file contents' }),
      },
      {
        name: 'send_email',
        description: 'Send an email to someone.',
        call: () => ({ text: 'sent' }),
      },
      {
        name: 'boom',
        description: 'Always fails as a tool error.',
        call: () => ({ text: 'it did not work', isError: true }),
      },
      {
        name: 'broken',
        description: 'Fails at the protocol level.',
        rpcError: { code: -32000, message: 'server exploded' },
      },
    ],
    {},
  );
}

async function runMcpChecks(): Promise<void> {
  check('McpToolDriver defaults match MCP_DEFAULTS', () => {
    const d = new McpToolDriver({ transport: fakeServer() });
    assert(d.name === MCP_DEFAULTS.name, `name ${d.name}`);
    assert(d.version === MCP_DEFAULTS.version, 'version');
    assert(d.abiCompat === MCP_DEFAULTS.abiCompat, 'abiCompat');
    assert(d.closed === false, 'fresh driver is open');
  });

  check('mcp abiCompat admits the live kernel ABI', () => {
    assert(satisfiesAbi(KERNEL_ABI_VERSION, mcpTool({ transport: fakeServer() }).abiCompat) === true, 'registry would accept it');
  });

  check('mcpTool() without command or transport traps EINVAL', () => {
    let caught: unknown = null;
    try { mcpTool({}); } catch (e) { caught = e; }
    assert(isCortexError(caught), 'CortexError');
    assert((caught as CortexError).errno === 'EINVAL', `EINVAL, got ${(caught as CortexError).errno}`);
  });

  check('forkable is false — a live subprocess cannot cross a cognitive fork', () => {
    // STATE.md §8.6: the kernel should not trust a driver's fork claim. We do
    // not make one.
    assert(mcpTool({ transport: fakeServer() }).forkable === false, 'forkable must be false');
  });

  await checkAsync('handshake sends initialize then notifications/initialized', async () => {
    const server = fakeServer();
    const d = mcpTool({ transport: server, namespace: 'demo' });
    await d.listTools();
    const methods = server.received.map((m) => m.method);
    assert(methods[0] === 'initialize', `first is initialize, got ${methods[0]}`);
    assert(methods.includes('notifications/initialized'), 'initialized notification sent');
    assert(d.serverProtocolVersion === '2025-06-18', `negotiated version, got ${d.serverProtocolVersion}`);
  });

  await checkAsync('listTools maps MCP tools with a namespace prefix', async () => {
    const d = mcpTool({ transport: fakeServer(), namespace: 'demo' });
    const tools = await d.listTools();
    assert(tools.length === 4, `4 tools, got ${tools.length}`);
    assert(tools[0]!.name === 'demo/read_file', `namespaced, got ${tools[0]!.name}`);
    assert(tools[0]!.description === 'Read a file.', 'description passed through');
    assert(tools[0]!.reversibility === 'irreversible', `untagged defaults to irreversible, got ${tools[0]!.reversibility}`);
  });

  await checkAsync('namespace "" exposes raw MCP tool names', async () => {
    const d = mcpTool({ transport: fakeServer(), namespace: '' });
    const tools = await d.listTools();
    assert(tools[0]!.name === 'read_file', `raw name, got ${tools[0]!.name}`);
  });

  await checkAsync('invoke calls the namespaced tool and unwraps text content', async () => {
    const server = fakeServer();
    const d = mcpTool({ transport: server, namespace: 'demo' });
    await d.listTools();
    const res = await d.invoke('demo/read_file', { path: '/tmp/a' }, mcpCtx());
    const output = res.output as { text: string | null; content: unknown[] };
    assert(output.text === 'file contents', `text: ${output.text}`);
    assert(output.content.length === 1, 'one content block');
    assert(res.error === null, 'no error');
    // The server must see the UN-namespaced name.
    const call = server.received.find((m) => m.method === 'tools/call') as JsonRpcRequest;
    assert((call.params as { name: string }).name === 'read_file', 'server saw raw name');
  });

  await checkAsync('reversibility override applies per server tool name', async () => {
    const d = mcpTool({
      transport: fakeServer(),
      namespace: 'demo',
      defaultReversibility: 'idempotent',
      reversibility: { send_email: 'irreversible', read_file: 'idempotent' },
    });
    const tools = await d.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    assert(byName.get('demo/send_email')!.reversibility === 'irreversible', 'explicit override wins');
    assert(byName.get('demo/read_file')!.reversibility === 'idempotent', 'explicit override wins');
    assert(byName.get('demo/boom')!.reversibility === 'idempotent', 'untagged falls back to defaultReversibility');
  });

  await checkAsync('declaredReversibility distinguishes declared from defaulted', async () => {
    const d = mcpTool({
      transport: fakeServer(),
      namespace: 'demo',
      reversibility: { send_email: 'irreversible' },
    });
    await d.listTools();
    assert(d.declaredReversibility['demo/send_email'] === true, 'send_email was declared');
    assert(d.declaredReversibility['demo/read_file'] === false, 'read_file was defaulted');
    assert(isMcpToolDriver(d) === true, 'type guard recognises the driver');
  });

  await checkAsync('isError:true becomes a return-with-error, not a trap', async () => {
    const d = mcpTool({ transport: fakeServer(), namespace: 'demo' });
    await d.listTools();
    const res = await d.invoke('demo/boom', {}, mcpCtx());
    // Not thrown — per docs/ABI.md §3 the tool RAN and reported failure.
    assert(res.error !== null, 'error is set');
    assert(res.error!.code === 'MCP_TOOL_ERROR', `code, got ${res.error!.code}`);
    assert(res.error!.message === 'it did not work', `message, got ${res.error!.message}`);
    assert(res.reversibility === 'irreversible', 'reversibility still reported');
  });

  await checkAsync('unknown tool traps ENOENT before hitting the server', async () => {
    const server = fakeServer();
    const d = mcpTool({ transport: server, namespace: 'demo' });
    await d.listTools();
    let caught: unknown = null;
    try { await d.invoke('demo/nope', {}, mcpCtx()); } catch (e) { caught = e; }
    assert(isCortexError(caught), 'CortexError');
    assert((caught as CortexError).errno === 'ENOENT', `ENOENT, got ${(caught as CortexError).errno}`);
    assert(server.received.filter((m) => m.method === 'tools/call').length === 0, 'no network round-trip');
  });

  await checkAsync('JSON-RPC errors map to cortex errnos', async () => {
    const d = mcpTool({ transport: fakeServer(), namespace: 'demo' });
    await d.listTools();
    let caught: unknown = null;
    try { await d.invoke('demo/broken', {}, mcpCtx()); } catch (e) { caught = e; }
    assert(isCortexError(caught), 'CortexError');
    assert((caught as CortexError).errno === 'EDRIVER', `-32000 => EDRIVER, got ${(caught as CortexError).errno}`);
  });

  await checkAsync('a lenient server sending `error: null` alongside a result resolves ok', async () => {
    // Regression: the #onMessage guard once treated any non-undefined `error`
    // as a failure, so a server that echoes `error: null` next to a valid
    // result crashed instead of succeeding.
    const server = new FakeMcpServer(
      [{ name: 'ok', description: 'Fine.', call: () => ({ text: 'all good' }) }],
      { nullError: true },
    );
    const d = mcpTool({ transport: server, namespace: 'demo' });
    await d.listTools();
    const res = await d.invoke('demo/ok', {}, mcpCtx());
    assert(res.error === null, `no tool error, got ${res.error === null ? 'null' : 'set'}`);
    const text = JSON.stringify(res.output);
    assert(text.includes('all good'), `output carries text, got ${text}`);
  });

  await checkAsync('a failed initialize handshake traps EDRIVER', async () => {
    const server = new FakeMcpServer([], { initializeError: { code: -32000, message: 'nope' } });
    const d = mcpTool({ transport: server, namespace: 'demo' });
    let caught: unknown = null;
    try { await d.listTools(); } catch (e) { caught = e; }
    assert(isCortexError(caught), 'CortexError');
    assert((caught as CortexError).errno === 'EDRIVER', `EDRIVER, got ${(caught as CortexError).errno}`);
  });

  await checkAsync('an unanswered call traps ETIMEDOUT', async () => {
    const server = new FakeMcpServer(
      [{ name: 'slow', call: () => ({ text: 'too late' }) }],
      { silence: ['tools/call'] },
    );
    const d = mcpTool({ transport: server, namespace: 'demo', timeoutMs: 60 });
    await d.listTools();
    let caught: unknown = null;
    try { await d.invoke('demo/slow', {}, mcpCtx()); } catch (e) { caught = e; }
    assert(isCortexError(caught), 'CortexError');
    assert((caught as CortexError).errno === 'ETIMEDOUT', `ETIMEDOUT, got ${(caught as CortexError).errno}`);
  });

  await checkAsync('an aborted signal traps EINTR', async () => {
    const server = new FakeMcpServer(
      [{ name: 'slow', call: () => ({ text: 'never' }) }],
      { silence: ['tools/call'] },
    );
    const d = mcpTool({ transport: server, namespace: 'demo', timeoutMs: 5000 });
    await d.listTools();
    const ac = new AbortController();
    const pending = d.invoke('demo/slow', {}, mcpCtx({ abortSignal: ac.signal }));
    ac.abort();
    let caught: unknown = null;
    try { await pending; } catch (e) { caught = e; }
    assert(isCortexError(caught), 'CortexError');
    assert((caught as CortexError).errno === 'EINTR', `EINTR, got ${(caught as CortexError).errno}`);
  });

  await checkAsync('closed driver traps EDRIVER', async () => {
    const d = mcpTool({ transport: fakeServer(), namespace: 'demo' });
    await d.listTools();
    await d.close();
    let caught: unknown = null;
    try { await d.invoke('demo/read_file', {}, mcpCtx()); } catch (e) { caught = e; }
    assert(isCortexError(caught), 'CortexError');
    assert((caught as CortexError).errno === 'EDRIVER', `EDRIVER, got ${(caught as CortexError).errno}`);
  });

  await checkAsync('serializeState returns null (subprocess state is not ours)', async () => {
    const d = mcpTool({ transport: fakeServer(), namespace: 'demo' });
    assert((await d.serializeState()) === null, 'null');
  });

  check('mapCallResult joins text blocks and passes structuredContent through', () => {
    const r = mapCallResult({
      content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'image', data: 'x' }],
      structuredContent: { n: 1 },
    });
    const out = r.output as { text: string; content: unknown[]; structured: unknown };
    assert(out.text === 'a\nb', `joined, got ${out.text}`);
    assert(out.content.length === 3, 'all blocks kept');
    assert(r.error === null, 'no error');
  });

  check('mapCallResult on a non-object yields null text and no error', () => {
    const r = mapCallResult('garbage');
    const out = r.output as { text: null };
    assert(out.text === null, 'null text');
    assert(r.error === null, 'no error');
  });

  check('errnoForRpcError maps the codes we care about', () => {
    assert(errnoForRpcError(-32601) === 'ENOENT', 'method not found => ENOENT');
    assert(errnoForRpcError(-32602) === 'EINVAL', 'invalid params => EINVAL');
    assert(errnoForRpcError(-32600) === 'EINVAL', 'invalid request => EINVAL');
    assert(errnoForRpcError(-32000) === 'EDRIVER', 'server error => EDRIVER');
  });

  await checkAsync('registry accepts the MCP driver and resolves namespaced tools', async () => {
    // The load-bearing claim: MCP is a transport detail, not a kernel change.
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    await reg.registerTool(
      mcpTool({ transport: fakeServer(), name: 'demo-mcp', namespace: 'demo' }),
    );
    const resolved = reg.resolveTool('demo/read_file');
    assert(resolved !== undefined, 'tool resolved through the registry');
    assert(resolved!.driver.name === 'demo-mcp', `owner, got ${resolved!.driver.name}`);
    assert(resolved!.descriptor.reversibility === 'irreversible', 'descriptor cached');
    assert(reg.resolveTool('read_file') === undefined, 'raw name is NOT exposed');
  });

  await checkAsync('two MCP servers coexist without a tool-name collision', async () => {
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    await reg.registerTool(
      mcpTool({ transport: fakeServer(), name: 'mcp-a', namespace: 'a' }),
    );
    await reg.registerTool(
      mcpTool({ transport: fakeServer(), name: 'mcp-b', namespace: 'b' }),
    );
    assert(reg.resolveTool('a/read_file') !== undefined, 'namespace a');
    assert(reg.resolveTool('b/read_file') !== undefined, 'namespace b');
  });

  await checkAsync('real stdio MCP server round-trips end to end', async () => {
    const d = mcpTool({
      command: process.execPath,
      args: ['-e', MCP_ECHO_SERVER],
      namespace: 'echo',
      timeoutMs: 10_000,
      handshakeTimeoutMs: 10_000,
    });
    try {
      const tools = await d.listTools();
      assert(tools.length === 1, `1 tool, got ${tools.length}`);
      assert(tools[0]!.name === 'echo/echo', `namespaced, got ${tools[0]!.name}`);
      assert(d.serverProtocolVersion === '2025-06-18', 'handshake negotiated');
      const res = await d.invoke('echo/echo', { message: 'hi' }, mcpCtx());
      const output = res.output as { text: string | null };
      assert(output.text === 'echo: hi', `text: ${output.text}`);
    } finally {
      await d.close();
    }
  });

  await checkAsync('a server that dies on startup fails fast, not at the timeout', async () => {
    const deadline = 5000;
    const d = mcpTool({
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      namespace: 'dead',
      timeoutMs: deadline,
      handshakeTimeoutMs: deadline,
    });
    const start = Date.now();
    let caught: unknown = null;
    try { await d.listTools(); } catch (e) { caught = e; }
    const elapsed = Date.now() - start;
    assert(isCortexError(caught), 'CortexError');
    assert((caught as CortexError).errno === 'EDRIVER', `EDRIVER, got ${(caught as CortexError).errno}`);
    // The whole point of onClose: don't make the operator wait 5s for a server
    // that was never alive.
    assert(elapsed < deadline - 1000, `failed fast in ${elapsed}ms, should not approach the ${deadline}ms timeout`);
    await d.close().catch(() => {});
  });

  await checkAsync('StdioMcpTransport spawns and is closeable', async () => {
    const t = StdioMcpTransport.spawn({
      command: process.execPath,
      args: ['-e', MCP_ECHO_SERVER],
    });
    let got: JsonRpcMessage | null = null;
    await new Promise<void>((resolve) => {
      t.onMessage((m) => { got = m; resolve(); });
      t.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cortex', version: '1.0.0' } } });
    });
    assert(got !== null, 'got a response');
    assert((got as unknown as JsonRpcResponse).id === 1, 'matching id');
    await t.close();
    assert(t.closed === true, 'closed');
  });
}

// =============================================================================
// cortex diff checks (#038)
// =============================================================================

/** Hand one turn to the Node event loop so pending agent Promises progress. */
/**
 * A `settle()` yield that lets real timers fire. The default yield is
 * `setImmediate`, which can burn the whole tick budget before a pending
 * `setTimeout` elapses — see `Kernel.settle()`'s caveat. Tests that park agents
 * on wall-clock time (`sleep`, `wait({ timeoutMs })`) must use this.
 */
const timerYield = (): Promise<void> => new Promise<void>((resolve) => {
  setTimeout(resolve, 5);
});

const yieldOnce = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

let recSeq = 0;

/** Minimal SyscallRecord factory. `n` drives byteOffset so splitAtOffset works. */
function srec(
  n: number,
  syscall: string,
  phase: 'enter' | 'exit' | 'trap',
  extra: Partial<SyscallRecord> = {},
): SyscallRecord {
  recSeq++;
  return {
    byteOffset: asSyscallOffset(n * 100),
    timestamp: `2026-01-01T00:00:0${n % 10}.000Z`,
    pid: asProcessId(2),
    syscall,
    callId: `c${recSeq}`,
    phase,
    stateBefore: 'running',
    stateAfter: 'running',
    reversibility: 'reversible',
    kernelAbiVersion: KERNEL_ABI_VERSION,
    ...extra,
  };
}

async function runDiffChecks(): Promise<void> {
  check('stableJson sorts object keys recursively', () => {
    const a = stableJson({ b: 1, a: { d: 2, c: 3 } });
    const b = stableJson({ a: { c: 3, d: 2 }, b: 1 });
    assert(JSON.stringify(a) === JSON.stringify(b), 'same serialization regardless of insertion order');
  });

  check('recordSignature ignores timestamp, duration and callId', () => {
    // Two branches make the same call at different times, taking different
    // durations. They must compare equal or every line becomes a difference.
    const a = srec(1, 'llm_call', 'exit', {
      timestamp: '2026-01-01T00:00:01.000Z',
      durationMs: 10,
      callId: 'x1',
      result: { text: 'same' },
    });
    const b = srec(2, 'llm_call', 'exit', {
      timestamp: '2026-01-01T00:00:09.000Z',
      durationMs: 900,
      callId: 'x2',
      result: { text: 'same' },
    });
    assert(recordSignature(a) === recordSignature(b), 'identical signatures');
  });

  check('recordSignature distinguishes different results', () => {
    const a = srec(1, 'llm_call', 'exit', { result: { text: 'A' } });
    const b = srec(1, 'llm_call', 'exit', { result: { text: 'B' } });
    assert(recordSignature(a) !== recordSignature(b), 'different signatures');
  });

  check('diffRecords on identical sequences yields all "same"', () => {
    const seq = [srec(1, 'llm_call', 'enter'), srec(2, 'llm_call', 'exit')];
    const { lines, degenerate } = diffRecords(seq, seq);
    assert(degenerate === false, 'not degenerate');
    assert(lines.length === 2, `2 lines, got ${lines.length}`);
    assert(lines.every((l) => l.kind === 'same'), 'all same');
  });

  check('diffRecords reports one insertion, not a cascade', () => {
    // This is why LCS beats a positional compare: B inserts one call in the
    // middle and everything after it still lines up.
    const a = [srec(1, 'x', 'enter'), srec(2, 'y', 'enter'), srec(3, 'z', 'enter')];
    const b = [
      srec(1, 'x', 'enter'),
      srec(2, 'inserted', 'enter'),
      srec(3, 'y', 'enter'),
      srec(4, 'z', 'enter'),
    ];
    const { lines } = diffRecords(a, b);
    const kinds = lines.map((l) => l.kind);
    assert(kinds.filter((k) => k === 'b-only').length === 1, `exactly 1 insertion, got ${kinds.join(',')}`);
    assert(kinds.filter((k) => k === 'same').length === 3, '3 matched through');
    assert(kinds.filter((k) => k === 'a-only').length === 0, 'no deletions');
  });

  check('diffRecords finds re-convergence after divergence', () => {
    // Branches that split and then meet again: both exit the same way.
    const a = [srec(1, 'x', 'enter'), srec(2, 'branchA', 'enter'), srec(3, 'exit', 'exit', { result: { code: 0 } })];
    const b = [srec(1, 'x', 'enter'), srec(2, 'branchB', 'enter'), srec(3, 'exit', 'exit', { result: { code: 0 } })];
    const { lines } = diffRecords(a, b);
    const kinds = lines.map((l) => l.kind);
    assert(kinds[0] === 'same', 'shared head');
    assert(kinds.includes('a-only') && kinds.includes('b-only'), 'one divergent call each');
    assert(kinds[kinds.length - 1] === 'same', 're-converged on exit — a prefix compare would miss this');
  });

  check('diffRecords against an empty log marks everything a-only', () => {
    const { lines } = diffRecords([srec(1, 'x', 'enter')], []);
    assert(lines.length === 1, '1 line');
    assert(lines[0]!.kind === 'a-only', 'a-only');
    assert(lines[0]!.b === null, 'b is null');
  });

  check('diffRecords falls back to a prefix compare on huge logs', () => {
    // Beyond MAX_LCS_CELLS we must not attempt the O(n*m) table.
    const n = 3000;
    const m = Math.ceil((MAX_LCS_CELLS + 10) / n);
    const a: SyscallRecord[] = [];
    const b: SyscallRecord[] = [];
    for (let i = 0; i < n; i++) a.push(srec(i, 'same', 'enter'));
    for (let i = 0; i < m; i++) b.push(srec(i, 'same', 'enter'));
    assert(a.length * b.length > MAX_LCS_CELLS, 'over the threshold');
    const { degenerate } = diffRecords(a, b);
    assert(degenerate === true, 'degenerate flag set so the CLI can say so');
  });

  check('splitAtOffset cuts the shared causal past off the front', () => {
    const logs = [srec(1, 'a', 'enter'), srec(2, 'b', 'enter'), srec(3, 'c', 'enter'), srec(4, 'd', 'enter')];
    const { shared, tail } = splitAtOffset(logs, 250);
    assert(shared.length === 2, `2 before offset 250, got ${shared.length}`);
    assert(tail.length === 2, `2 after, got ${tail.length}`);
    assert(tail[0]!.syscall === 'c', 'tail starts at c');
  });

  check('splitAtOffset at 0 puts everything in the tail', () => {
    const { shared, tail } = splitAtOffset([srec(1, 'a', 'enter')], 0);
    assert(shared.length === 0, 'nothing shared');
    assert(tail.length === 1, 'all tail');
  });

  check('findDivergence reads sharedCausalPast out of the fork record', () => {
    const parent = [
      srec(1, 'llm_call', 'enter'),
      srec(2, 'llm_call', 'exit'),
      srec(3, 'fork', 'exit', {
        result: { childPid: 7, sharedCausalPast: 250, irreversibleInPast: ['fs_write'] },
      }),
    ];
    const child = [srec(1, 'llm_call', 'enter')];
    const d = findDivergence(2, parent, 7, child, 0);
    assert(d.source === 'fork-record', `fork-record, got ${d.source}`);
    assert(d.forkFromPid === 2 && d.forkChildPid === 7, 'parent/child identified');
    assert(d.byteOffset === 250, `offset, got ${d.byteOffset}`);
    assert(d.sharedSyscalls === 2, `2 shared, got ${d.sharedSyscalls}`);
    assert(d.irreversibleInPast.join() === 'fs_write', 'irreversible history surfaced');
  });

  check('findDivergence works when the child is listed first', () => {
    const parent = [srec(3, 'fork', 'exit', { result: { childPid: 7, sharedCausalPast: 150 } })];
    const child = [srec(1, 'x', 'enter')];
    const d = findDivergence(7, child, 2, parent, 0);
    assert(d.source === 'fork-record', 'still found');
    assert(d.forkFromPid === 2, `parent is 2, got ${d.forkFromPid}`);
  });

  check('findDivergence falls back to the LCS count when no fork links them', () => {
    const a = [srec(1, 'x', 'enter')];
    const b = [srec(1, 'x', 'enter'), srec(2, 'y', 'enter')];
    const d = findDivergence(2, a, 3, b, 1);
    assert(d.source === 'inferred', `inferred, got ${d.source}`);
    assert(d.byteOffset === null, 'no authoritative offset');
    assert(d.sharedSyscalls === 1, 'fallback value passed through');
  });

  check('summarize pulls exit code, last llm text and trap count', () => {
    const s = summarize([
      srec(1, 'llm_call', 'exit', { result: { text: 'first' } }),
      srec(2, 'tool_call', 'trap', { error: { errno: 'EPERM', message: 'denied' } }),
      srec(3, 'llm_call', 'exit', { result: { text: 'last' } }),
      srec(4, 'exit', 'exit', { result: { code: 3, reason: 'gave up' } }),
    ]);
    assert(s.exitCode === 3, `exitCode, got ${s.exitCode}`);
    assert(s.exitReason === 'gave up', 'exitReason');
    assert(s.lastText === 'last', `last llm text, got ${s.lastText}`);
    assert(s.traps === 1, `1 trap, got ${s.traps}`);
    assert(s.syscalls === 4, '4 syscalls');
    assert(s.wallMs === 3000, `wall 3000ms, got ${s.wallMs}`);
  });

  check('filterStateRecords drops __state transitions', () => {
    const kept = filterStateRecords([
      srec(1, '__state', 'exit'),
      srec(2, 'llm_call', 'enter'),
      srec(3, '__state', 'exit'),
    ]);
    assert(kept.length === 1, `1 kept, got ${kept.length}`);
    assert(kept[0]!.syscall === 'llm_call', 'llm_call kept');
  });

  check('recordDetail renders traps, args and results distinctly', () => {
    assert(recordDetail(srec(1, 'x', 'trap', { error: { errno: 'EPERM', message: 'denied' } })).startsWith('trap EPERM'), 'trap');
    assert(recordDetail(srec(1, 'x', 'enter', { args: { a: 1 } })).startsWith('in '), 'enter');
    assert(recordDetail(srec(1, 'x', 'exit', { result: { a: 1 } })).startsWith('out '), 'exit');
  });

  check('formatMs and clockOf match the trace command', () => {
    assert(formatMs(500) === '500ms', 'ms');
    assert(formatMs(3200) === '3.2s', 'seconds');
    assert(formatMs(null) === '-', 'null');
    assert(clockOf('2026-01-01T14:23:01.409Z') === '14:23:01.409', 'clock');
  });

  await checkAsync('cortex diff end to end over two real .crec files', async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'cortex-diff-'));
    mkdirSync(join(tmp, 'processes'), { recursive: true });

    const prevHome = process.env['CORTEX_HOME'];
    const prevLog = console.log;
    const prevErr = console.error;
    try {
      const parent = await Recorder.open({ pid: asProcessId(2), dir: join(tmp, 'processes', '2') });
      await parent.append({
        timestamp: '2026-01-01T00:00:01.000Z', pid: asProcessId(2), syscall: 'llm_call',
        callId: 'p1', phase: 'exit', result: { text: 'shared thought' },
        stateBefore: 'running', stateAfter: 'running', reversibility: 'reversible',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await parent.append({
        timestamp: '2026-01-01T00:00:02.000Z', pid: asProcessId(2), syscall: 'fork',
        callId: 'p2', phase: 'exit', args: { kind: 'cognitive' },
        result: { childPid: 3, childChainId: 'cccc', sharedCausalPast: 0, irreversibleInPast: ['fs_write'] },
        stateBefore: 'running', stateAfter: 'running', reversibility: 'reversible',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await parent.append({
        timestamp: '2026-01-01T00:00:03.000Z', pid: asProcessId(2), syscall: 'llm_call',
        callId: 'p3', phase: 'exit', result: { text: 'branch A answer' },
        stateBefore: 'running', stateAfter: 'running', reversibility: 'reversible',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await parent.append({
        timestamp: '2026-01-01T00:00:04.000Z', pid: asProcessId(2), syscall: 'exit',
        callId: 'p4', phase: 'exit', result: { code: 0, reason: 'branch A complete' },
        stateBefore: 'running', stateAfter: 'exiting', reversibility: 'irreversible',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await parent.flush();
      await parent.close();

      const child = await Recorder.open({ pid: asProcessId(3), dir: join(tmp, 'processes', '3') });
      await child.append({
        timestamp: '2026-01-01T00:00:05.000Z', pid: asProcessId(3), syscall: 'llm_call',
        callId: 'c1', phase: 'exit', result: { text: 'branch B answer' },
        stateBefore: 'running', stateAfter: 'running', reversibility: 'reversible',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await child.append({
        timestamp: '2026-01-01T00:00:06.000Z', pid: asProcessId(3), syscall: 'exit',
        callId: 'c2', phase: 'exit', result: { code: 1, reason: 'branch B gave up' },
        stateBefore: 'running', stateAfter: 'exiting', reversibility: 'irreversible',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await child.flush();
      await child.close();

      process.env['CORTEX_HOME'] = tmp;
      let out = '';
      console.log = (...parts: unknown[]): void => {
        out += parts.map((p) => String(p)).join(' ') + '\n';
      };
      console.error = (): void => {};
      const code = await cmdDiff(['2', '3']);

      assert(code === 0, `exit 0, got ${code}`);
      assert(out.includes('fork recorded in pid 2'), 'the fork record was found');
      assert(out.includes('branch A answer'), 'branch A output surfaced');
      assert(out.includes('branch B answer'), 'branch B output surfaced');
      assert(out.includes('fs_write'), 'irreversible-before-fork surfaced');
      assert(out.includes('branch A complete'), 'A exit reason');
      assert(out.includes('branch B gave up'), 'B exit reason');
    } finally {
      console.log = prevLog;
      console.error = prevErr;
      if (prevHome === undefined) delete process.env['CORTEX_HOME'];
      else process.env['CORTEX_HOME'] = prevHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('cortex diff with one argument prints help and fails', async () => {
    const prevLog = console.log;
    try {
      let out = '';
      console.log = (...parts: unknown[]): void => {
        out += parts.map((p) => String(p)).join(' ') + '\n';
      };
      const code = await cmdDiff(['2']);
      assert(code === 1, `exit 1, got ${code}`);
      assert(out.includes('USAGE'), 'prints usage');
    } finally {
      console.log = prevLog;
    }
  });

  // ---- cortex attach (#031) ----------------------------------------------

  /** Lines that look like syscall-record rows (start with HH:MM:SS.mmm). */
  function recordLines(out: string): string[] {
    return out
      .split('\n')
      .filter((l) => /^\d{2}:\d{2}:\d{2}\.\d{3}/.test(l));
  }

  await checkAsync('cortex attach --once prints the same rows as cortex trace', async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'cortex-attach-'));
    mkdirSync(join(tmp, 'processes'), { recursive: true });

    const prevHome = process.env['CORTEX_HOME'];
    const prevLog = console.log;
    const prevErr = console.error;
    try {
      const rec = await Recorder.open({ pid: asProcessId(2), dir: join(tmp, 'processes', '2') });
      for (let i = 0; i < 3; i++) {
        await rec.append({
          timestamp: `2026-01-01T00:00:0${i}.000Z`, pid: asProcessId(2), syscall: 'llm_call',
          callId: `p${i}`, phase: 'exit', result: { text: `thought ${i}` },
          stateBefore: 'running', stateAfter: 'running', reversibility: 'reversible',
          kernelAbiVersion: KERNEL_ABI_VERSION,
        });
      }
      await rec.flush();
      await rec.close();

      process.env['CORTEX_HOME'] = tmp;
      const capture = async (fn: () => Promise<number>): Promise<{ code: number; out: string }> => {
        let out = '';
        console.log = (...parts: unknown[]): void => {
          out += parts.map((p) => String(p)).join(' ') + '\n';
        };
        console.error = (): void => {};
        const code = await fn();
        return { code, out };
      };

      const a = await capture(() => cmdAttach(['2', '--once']));
      const t = await capture(() => cmdTrace(['2']));

      assert(a.code === 0, `attach exit 0, got ${a.code}`);
      assert(t.code === 0, `trace exit 0, got ${t.code}`);
      const attachRows = recordLines(a.out);
      const traceRows = recordLines(t.out);
      assert(attachRows.length === 3, `3 rows from attach, got ${attachRows.length}`);
      assert(
        attachRows.join('\n') === traceRows.join('\n'),
        'attach --once renders identical syscall rows to trace',
      );
    } finally {
      console.log = prevLog;
      console.error = prevErr;
      if (prevHome === undefined) delete process.env['CORTEX_HOME'];
      else process.env['CORTEX_HOME'] = prevHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('cortex attach follow-mode picks up frames appended mid-window', async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'cortex-attach-follow-'));
    mkdirSync(join(tmp, 'processes'), { recursive: true });

    const prevHome = process.env['CORTEX_HOME'];
    const prevLog = console.log;
    const prevErr = console.error;
    try {
      process.env['CORTEX_HOME'] = tmp;
      const rec = await Recorder.open({ pid: asProcessId(5), dir: join(tmp, 'processes', '5') });
      await rec.append({
        timestamp: '2026-01-01T00:00:00.000Z', pid: asProcessId(5), syscall: 'llm_call',
        callId: 'p0', phase: 'exit', result: { text: 'seed' },
        stateBefore: 'running', stateAfter: 'running', reversibility: 'reversible',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await rec.flush();

      let out = '';
      console.log = (...parts: unknown[]): void => {
        out += parts.map((p) => String(p)).join(' ') + '\n';
      };
      console.error = (): void => {};

      // Attach streams for 1500ms; append two more frames during the window.
      const promise = cmdAttach(['5', '--timeout-ms', '1500']);
      const appendAt = async (ms: number, text: string): Promise<void> => {
        await new Promise<void>((r) => setTimeout(r, ms));
        await rec.append({
          timestamp: '2026-01-01T00:00:01.000Z', pid: asProcessId(5), syscall: 'llm_call',
          callId: text, phase: 'exit', result: { text },
          stateBefore: 'running', stateAfter: 'running', reversibility: 'reversible',
          kernelAbiVersion: KERNEL_ABI_VERSION,
        });
        await rec.flush();
      };
      const w1 = appendAt(350, 'mid-a');
      const w2 = appendAt(700, 'mid-b');
      const code = await promise;
      await w1;
      await w2;
      await rec.close();

      assert(code === 0, `follow exit 0, got ${code}`);
      const rows = recordLines(out);
      assert(rows.length === 3, `3 rows streamed (seed + 2 mid), got ${rows.length}`);
      // formatRecordLine emits time/pid/syscall/phase/duration/reversibility only,
      // so the only field that distinguishes the mid-window frames is their
      // timestamp (00:00:01.000), which the seed row (00:00:00.000) lacks.
      assert(out.includes('00:00:00.000'), 'seed row present');
      assert(out.includes('00:00:01.000'), 'mid-window frames surfaced (by timestamp)');
      assert(out.includes('detached'), 'prints the detached footer');
    } finally {
      console.log = prevLog;
      console.error = prevErr;
      if (prevHome === undefined) delete process.env['CORTEX_HOME'];
      else process.env['CORTEX_HOME'] = prevHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('cortex attach on a missing pid fails with a clear error', async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'cortex-attach-missing-'));
    mkdirSync(join(tmp, 'processes'), { recursive: true });

    const prevHome = process.env['CORTEX_HOME'];
    const prevLog = console.log;
    const prevErr = console.error;
    try {
      process.env['CORTEX_HOME'] = tmp;
      let out = '';
      console.log = (...parts: unknown[]): void => { out += parts.map((p) => String(p)).join(' ') + '\n'; };
      console.error = (...parts: unknown[]): void => { out += parts.map((p) => String(p)).join(' ') + '\n'; };

      const code = await cmdAttach(['99']);
      assert(code === 1, `exit 1, got ${code}`);
      assert(out.includes('no .crec file'), 'explains the missing log');

      const codeBad = await cmdAttach(['not-a-pid']);
      assert(codeBad === 1, `invalid pid exit 1, got ${codeBad}`);
    } finally {
      console.log = prevLog;
      console.error = prevErr;
      if (prevHome === undefined) delete process.env['CORTEX_HOME'];
      else process.env['CORTEX_HOME'] = prevHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('cortex attach with no argument prints help and fails', async () => {
    const prevLog = console.log;
    try {
      let out = '';
      console.log = (...parts: unknown[]): void => { out += parts.map((p) => String(p)).join(' ') + '\n'; };
      const code = await cmdAttach([]);
      assert(code === 1, `exit 1, got ${code}`);
      assert(out.includes('USAGE'), 'prints usage');
    } finally {
      console.log = prevLog;
    }
  });
}


async function runInMemChecks(): Promise<void> {
  check('InMemMemoryDriver defaults', () => {
    const d = new InMemMemoryDriver();
    assert(d.name === 'inmem', `name ${d.name}`);
    assert(d.version === '1.0.0', 'version');
    assert(d.abiCompat === '^1.0.0', 'abiCompat');
    assert(d.closed === false, 'fresh driver is open');
  });

  check('inmem abiCompat admits the live kernel ABI', () => {
    assert(satisfiesAbi(KERNEL_ABI_VERSION, inmemMemory().abiCompat) === true, 'registry would accept it');
  });

  await checkAsync('write then read round-trips', async () => {
    const d = inmemMemory();
    await d.write('episodic', 'key1', { value: 42 });
    const entries = await d.read('episodic', { key: 'key1' });
    assert(entries.length === 1, `1 entry, got ${entries.length}`);
    assert(entries[0]!.key === 'key1', 'key');
    assert(JSON.stringify(entries[0]!.value) === JSON.stringify({ value: 42 }), 'value');
    await d.close();
  });

  await checkAsync('read with prefix returns matching entries', async () => {
    const d = inmemMemory();
    await d.write('episodic', 'user:1', { a: 1 });
    await d.write('episodic', 'user:2', { a: 2 });
    await d.write('episodic', 'other', { a: 3 });
    const entries = await d.read('episodic', { prefix: 'user:' });
    assert(entries.length === 2, `2 entries, got ${entries.length}`);
    await d.close();
  });

  await checkAsync('read with limit narrows results', async () => {
    const d = inmemMemory();
    await d.write('episodic', 'a', 1);
    await d.write('episodic', 'b', 2);
    await d.write('episodic', 'c', 3);
    const entries = await d.read('episodic', { limit: 2 });
    assert(entries.length === 2, `2 entries, got ${entries.length}`);
    await d.close();
  });

  await checkAsync('delete removes an entry', async () => {
    const d = inmemMemory();
    await d.write('episodic', 'key', 'val');
    await d.delete('episodic', 'key');
    const entries = await d.read('episodic', { key: 'key' });
    assert(entries.length === 0, 'entry deleted');
    await d.close();
  });

  await checkAsync('listRegions returns non-empty regions', async () => {
    const d = inmemMemory();
    await d.write('episodic', 'k', 'v');
    await d.write('semantic', 'k2', 'v2');
    const regions = await d.listRegions();
    assert(regions.length === 2, `2 regions, got ${regions.length}`);
    assert(regions.includes('episodic'), 'episodic listed');
    assert(regions.includes('semantic'), 'semantic listed');
    await d.close();
  });

  await checkAsync('snapshotRegion + restoreRegion round-trips', async () => {
    const d = inmemMemory();
    await d.write('episodic', 'k1', 'v1');
    await d.write('episodic', 'k2', 'v2');
    const blob = await d.snapshotRegion('episodic');
    assert(blob.length > 0, 'blob non-empty');
    // Clear and restore.
    const d2 = inmemMemory();
    await d2.restoreRegion('episodic', blob);
    const entries = await d2.read('episodic', {});
    assert(entries.length === 2, `2 entries after restore, got ${entries.length}`);
    await d.close();
    await d2.close();
  });

  await checkAsync('TTL expires entries', async () => {
    const d = inmemMemory();
    await d.write('episodic', 'temp', 'v', { ttlMs: 1 });
    // Wait for TTL to expire.
    await new Promise((r) => setTimeout(r, 10));
    const entries = await d.read('episodic', { key: 'temp' });
    assert(entries.length === 0, 'TTL entry expired');
    await d.close();
  });

  await checkAsync('closed driver traps EDRIVER', async () => {
    const d = inmemMemory();
    await d.close();
    let caught: unknown = null;
    try { await d.read('episodic', {}); } catch (e) { caught = e; }
    assert(isCortexError(caught), 'CortexError');
    assert((caught as CortexError).errno === 'EDRIVER', 'EDRIVER');
  });
}

// =============================================================================
// SQLite memory driver checks
// =============================================================================

async function runSqliteChecks(): Promise<void> {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-sqlite-'));
  try {
    check('SqliteMemoryDriver defaults match SQLITE_DEFAULTS', () => {
      const d = new SqliteMemoryDriver();
      assert(d.name === SQLITE_DEFAULTS.name, `name ${d.name}`);
      assert(d.version === SQLITE_DEFAULTS.version, 'version');
      assert(d.abiCompat === SQLITE_DEFAULTS.abiCompat, 'abiCompat');
      assert(d.closed === false, 'fresh driver is open');
    });

    check('sqlite abiCompat admits the live kernel ABI', () => {
      assert(satisfiesAbi(KERNEL_ABI_VERSION, sqliteMemory().abiCompat) === true, 'registry would accept it');
    });

    await checkAsync('write then read round-trips', async () => {
      const d = sqliteMemory({ dir: tmp });
      await d.write('episodic', 'key1', { value: 42 });
      const entries = await d.read('episodic', { key: 'key1' });
      assert(entries.length === 1, `1 entry, got ${entries.length}`);
      assert(entries[0]!.key === 'key1', 'key');
      assert(JSON.stringify(entries[0]!.value) === JSON.stringify({ value: 42 }), 'value');
      await d.close();
    });

    await checkAsync('read with prefix returns matching entries', async () => {
      const d = sqliteMemory({ dir: join(tmp, 'sub1') });
      await d.write('episodic', 'user:1', { a: 1 });
      await d.write('episodic', 'user:2', { a: 2 });
      await d.write('episodic', 'other', { a: 3 });
      const entries = await d.read('episodic', { prefix: 'user:' });
      assert(entries.length === 2, `2 entries, got ${entries.length}`);
      await d.close();
    });

    await checkAsync('delete removes an entry', async () => {
      const d = sqliteMemory({ dir: join(tmp, 'sub2') });
      await d.write('episodic', 'key', 'val');
      await d.delete('episodic', 'key');
      const entries = await d.read('episodic', { key: 'key' });
      assert(entries.length === 0, 'entry deleted');
      await d.close();
    });

    await checkAsync('listRegions returns non-empty regions', async () => {
      const d = sqliteMemory({ dir: join(tmp, 'sub3') });
      await d.write('episodic', 'k', 'v');
      await d.write('semantic', 'k2', 'v2');
      const regions = await d.listRegions();
    assert(regions.length >= 2, `at least 2 regions, got ${regions.length}`);
    assert(regions.includes('episodic'), 'episodic listed');
    assert(regions.includes('semantic'), 'semantic listed');
    await d.close();
    });

    await checkAsync('region names differing only by a special char do not share a table', async () => {
      // Regression: #tableName replaced every non-alphanumeric char with '_',
      // so `mem-1` and `mem_1` (and any name differing only in separators)
      // collapsed onto one table and silently overwrote each other's entries.
      const d = sqliteMemory({ dir: join(tmp, 'sub-nocollide') });
      await d.write('mem-1', 'shared-key', 'DASH-VALUE');
      await d.write('mem_1', 'shared-key', 'UNDER-VALUE');
      const fromDash = await d.read('mem-1', { key: 'shared-key' });
      const fromUnder = await d.read('mem_1', { key: 'shared-key' });
      assert(fromDash[0]?.value === 'DASH-VALUE', `mem-1 keeps its value, got ${fromDash[0]?.value}`);
      assert(fromUnder[0]?.value === 'UNDER-VALUE', `mem_1 keeps its value, got ${fromUnder[0]?.value}`);
      const regions = await d.listRegions();
      assert(regions.includes('mem-1') && regions.includes('mem_1'),
        `both distinct names listed, got ${JSON.stringify(regions)}`);
      // A special-character name must also survive a snapshot/restore round-trip.
      const blob = await d.snapshotRegion('mem-1');
      const d2 = sqliteMemory({ dir: join(tmp, 'sub-nocollide-r') });
      await d2.restoreRegion('mem-1', blob);
      const restored = await d2.read('mem-1', { key: 'shared-key' });
      assert(restored[0]?.value === 'DASH-VALUE' && restored[0]?.region === 'mem-1',
        'special-char region round-trips with its logical name intact');
      await d.close();
      await d2.close();
    });

    await checkAsync('oddly-named regions round-trip through listRegions exactly', async () => {
      // The reversible identifier encoding must recover names with dashes,
      // colons and literal underscores — and never merge two of them.
      const names = ['a-b', 'a_b', 'a:b', 'weird$name', 'user:1:session', '__'];
      const d = sqliteMemory({ dir: join(tmp, 'sub-exact') });
      for (const n of names) await d.write(n, 'x', n);
      const listed = [...(await d.listRegions())].sort();
      const wanted = [...names].sort();
      assert(JSON.stringify(listed) === JSON.stringify(wanted),
        `exact round-trip, got ${JSON.stringify(listed)}`);
      for (const n of names) {
        const got = await d.read(n, { key: 'x' });
        assert(got[0]?.value === n, `${n} reads back its own value, got ${got[0]?.value}`);
      }
      await d.close();
    });

    await checkAsync('snapshotRegion + restoreRegion round-trips', async () => {
      const d = sqliteMemory({ dir: join(tmp, 'sub4') });
      await d.write('episodic', 'k1', 'v1');
      await d.write('episodic', 'k2', 'v2');
      const blob = await d.snapshotRegion('episodic');
      assert(blob.length > 0, 'blob non-empty');
      const d2 = sqliteMemory({ dir: join(tmp, 'sub4b') });
      await d2.restoreRegion('episodic', blob);
      const entries = await d2.read('episodic', {});
      assert(entries.length === 2, `2 entries after restore, got ${entries.length}`);
      await d.close();
      await d2.close();
    });

    await checkAsync('closed driver traps EDRIVER', async () => {
      const d = sqliteMemory({ dir: join(tmp, 'sub5') });
      await d.close();
      let caught: unknown = null;
      try { await d.read('episodic', {}); } catch (e) { caught = e; }
      assert(isCortexError(caught), 'CortexError');
      assert((caught as CortexError).errno === 'EDRIVER', 'EDRIVER');
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// =============================================================================
// CLI `--memory` region-policy parsing checks
// =============================================================================

function runRegionsChecks(): void {
  check('parseMemoryArg accepts valid policies (incl readOnly + maxEntries variants)', () => {
    const parsed = parseMemoryArg(
      '{"a":{"kind":"cow","backing":"inmem"},"b":{"kind":"private","backing":"sqlite","readOnly":true,"maxEntries":-1},"c":{"kind":"shared","backing":"inmem","maxEntries":0},"d":{"kind":"private","backing":"inmem","maxEntries":5}}',
    );
    assert(parsed.a !== undefined && parsed.a.kind === 'cow' && parsed.a.backing === 'inmem', 'a ok');
    assert(!('maxEntries' in parsed.a), 'a omits absent maxEntries');
    assert(parsed.b.readOnly === true && parsed.b.maxEntries === -1, 'b readOnly + -1');
    assert(parsed.c.maxEntries === 0, 'c 0 is a valid hard cap (rejects every write)');
    assert(parsed.d.maxEntries === 5, 'd positive cap');
    assert(!('readOnly' in parsed.d), 'd omits absent readOnly');
  });

  check('parseMemoryArg rejects malformed JSON / non-objects', () => {
    const bad = ['{', '[]', 'null', '"str"', '42'];
    for (const raw of bad) {
      let threw = false;
      try { parseMemoryArg(raw); } catch (e) { threw = e instanceof MemoryArgError; }
      assert(threw, `should reject ${raw}`);
    }
    // empty object is a legal no-op
    assert(Object.keys(parseMemoryArg('{}')).length === 0, 'empty object ok');
  });

  check('parseMemoryArg rejects bad policy shapes', () => {
    const cases: readonly string[] = [
      '{"x":{}}',                                   // missing kind + backing
      '{"x":{"kind":"nope","backing":"inmem"}}',   // bad kind
      '{"x":{"kind":"cow"}}',                       // missing backing
      '{"x":{"kind":"cow","backing":"  "}}',        // blank backing
      '{"x":{"kind":"cow","backing":"inmem","readOnly":"yes"}}', // readOnly non-bool
      '{"x":{"kind":"cow","backing":"inmem","maxEntries":1.5}}', // non-integer
      '{"x":{"kind":"cow","backing":"inmem","maxEntries":-2}}',  // < -1
      '{"x":{"kind":"cow","backing":"inmem","oops":1}}',          // unknown field
      '{"x":"notanobject"}',                        // region value not an object
    ];
    for (const raw of cases) {
      let threw = false;
      try { parseMemoryArg(raw); } catch (e) { threw = e instanceof MemoryArgError; }
      assert(threw, `should reject ${raw}`);
    }
  });

  check('validateRegionPolicy omits undefined optional fields', () => {
    const p = validateRegionPolicy('r', { kind: 'private', backing: 'inmem' });
    assert(p.kind === 'private' && p.backing === 'inmem', 'required fields present');
    assert(!('readOnly' in p) && !('maxEntries' in p), 'no undefined optionals leaked');
  });

  check('mergeRegionPolicies overrides-by-name, adds-new, keeps-untouched', () => {
    const base = { ...DEFAULT_MEMORY_REGIONS };
    const overrides = {
      episodic: { kind: 'cow', backing: 'sqlite', maxEntries: 10 } as const,
      scratch: { kind: 'private', backing: 'inmem' } as const,
    };
    const merged = mergeRegionPolicies(base, overrides);
    assert(merged.episodic.backing === 'sqlite' && merged.episodic.maxEntries === 10, 'episodic overridden');
    assert(merged.scratch !== undefined, 'scratch added');
    assert(merged.semantic.kind === 'shared' && merged.procedural.kind === 'private', 'untouched defaults kept');
    assert(base.episodic.backing === DEFAULT_MEMORY_REGIONS.episodic.backing, 'base not mutated');
  });
}

// =============================================================================
// CLI process_store + disk-truth model checks
// =============================================================================

async function runCliChecks(): Promise<void> {
  const { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, unlinkSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-cli-'));
  try {
    // Create processes dir.
    mkdirSync(join(tmp, 'processes'), { recursive: true });

    check('metaPath produces the per-process layout', () => {
      const p = metaPath(tmp, asProcessId(7));
      assert(p === join(tmp, 'processes', '7', 'meta.json'), `path: ${p}`);
      assert(
        legacyMetaPath(tmp, asProcessId(7)) === join(tmp, 'processes', '7.meta.json'),
        'legacy meta path helper still resolves the old layout',
      );
    });

    check('readMeta reads a pre-0.2.1 flat meta.json', () => {
      // An upgrade must not make old processes invisible: write the legacy
      // file, then read it back through the normal reader.
      const legacy = legacyMetaPath(tmp, asProcessId(91));
      writeFileSync(
        legacy,
        JSON.stringify({
          pid: 91,
          ppid: 1,
          pgid: 91,
          role: 'legacy',
          state: 'zombie',
          exitCode: 0,
          exitReason: 'completed',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastTransitionAt: '2026-01-01T00:00:00.000Z',
          budgetsSpent: { tokensIn: 0, tokensOut: 0, tokensCached: 0, usdSpent: 0, wallTimeMs: 0, syscallCount: 0 },
          budgetsRemaining: { tokens: -1, usd: -1, wallTimeMs: -1 },
          agent: { system: 'old' },
          kernelAbiVersion: KERNEL_ABI_VERSION,
        }),
        'utf8',
      );
      const back = readMeta(tmp, asProcessId(91));
      assert(back !== undefined && back.role === 'legacy', 'a flat legacy meta is still readable');
      assert(readAllMetas(tmp).some((m) => m.pid === 91), 'and it shows up in readAllMetas');
      assert(maxPidOnDisk(tmp) >= 91, 'and it seeds the PID counter');
      // Remove the synthetic legacy file so it does not pollute the later
      // `maxPidOnDisk returns highest PID` check (which expects the highest
      // meta PID written below, not this synthetic 91).
      try { if (existsSync(legacy)) unlinkSync(legacy); } catch { /* ignore */ }
    });

    check('writeMeta + readMeta round-trips', () => {
      const meta: ProcessMeta = {
        pid: 2,
        ppid: 1,
        pgid: 2,
        role: 'coder',
        state: 'zombie',
        exitCode: 0,
        exitReason: 'completed',
        startedAt: '2026-01-01T00:00:00.000Z',
        lastTransitionAt: '2026-01-01T00:00:01.000Z',
        budgetsSpent: { tokensIn: 100, tokensOut: 50, tokensCached: 0, usdSpent: 0, wallTimeMs: 1000, syscallCount: 5 },
        budgetsRemaining: { tokens: 10000, usd: 100, wallTimeMs: 30000 },
        agent: { system: 'test' },
        kernelAbiVersion: KERNEL_ABI_VERSION,
      };
      writeMeta(tmp, meta);
      const loaded = readMeta(tmp, asProcessId(2));
      assert(loaded !== undefined, 'meta loaded');
      assert(loaded!.pid === 2, 'pid');
      assert(loaded!.role === 'coder', 'role');
      assert(loaded!.state === 'zombie', 'state');
      assert(loaded!.exitCode === 0, 'exitCode');
    });

    check('writeMeta + readMeta round-trips the optional memory policies', () => {
      const meta: ProcessMeta = {
        pid: 4,
        ppid: 1,
        pgid: 4,
        role: 'hoarder',
        state: 'zombie',
        exitCode: 0,
        exitReason: 'completed',
        startedAt: '2026-01-01T00:00:00.000Z',
        lastTransitionAt: '2026-01-01T00:00:01.000Z',
        budgetsSpent: { tokensIn: 0, tokensOut: 0, tokensCached: 0, usdSpent: 0, wallTimeMs: 1, syscallCount: 0 },
        budgetsRemaining: { tokens: -1, usd: -1, wallTimeMs: -1 },
        agent: { system: 'test' },
        memory: {
          episodic: { kind: 'cow', backing: 'inmem', maxEntries: 50 },
          semantic: { kind: 'shared', backing: 'inmem', readOnly: true },
          scratch: { kind: 'private', backing: 'inmem' },
        },
        kernelAbiVersion: KERNEL_ABI_VERSION,
      };
      writeMeta(tmp, meta);
      const loaded = readMeta(tmp, asProcessId(4));
      assert(loaded?.memory?.episodic.maxEntries === 50, 'episodic maxEntries survives round-trip');
      assert(loaded?.memory?.semantic.readOnly === true, 'readOnly survives');
      assert(loaded?.memory?.scratch !== undefined && !('maxEntries' in loaded.memory.scratch), 'plain policy survives');
    });

    check('readMeta omits memory when it was never persisted', () => {
      const loaded = readMeta(tmp, asProcessId(2));
      assert(loaded !== undefined && !('memory' in loaded), 'no memory key on a plain meta');
    });

    check('readMeta on missing pid returns undefined', () => {
      const loaded = readMeta(tmp, asProcessId(999));
      assert(loaded === undefined, 'undefined for missing');
    });

    check('readAllMetas returns sorted by PID', () => {
      // Write PID 5 then PID 3 to test sorting.
      writeMeta(tmp, { pid: 5, ppid: 1, pgid: 5, role: 'r5', state: 'running', exitCode: null, exitReason: null, startedAt: '', lastTransitionAt: '', budgetsSpent: { tokensIn: 0, tokensOut: 0, tokensCached: 0, usdSpent: 0, wallTimeMs: 0, syscallCount: 0 }, budgetsRemaining: { tokens: -1, usd: -1, wallTimeMs: -1 }, agent: { system: '' }, kernelAbiVersion: KERNEL_ABI_VERSION });
      writeMeta(tmp, { pid: 3, ppid: 1, pgid: 3, role: 'r3', state: 'running', exitCode: null, exitReason: null, startedAt: '', lastTransitionAt: '', budgetsSpent: { tokensIn: 0, tokensOut: 0, tokensCached: 0, usdSpent: 0, wallTimeMs: 0, syscallCount: 0 }, budgetsRemaining: { tokens: -1, usd: -1, wallTimeMs: -1 }, agent: { system: '' }, kernelAbiVersion: KERNEL_ABI_VERSION });
      const all = readAllMetas(tmp);
      assert(all.length >= 3, `at least 3, got ${all.length}`);
      // Verify sorted: PID 2 before 3 before 5.
      const pids = all.map((m) => m.pid);
      const idx2 = pids.indexOf(2);
      const idx3 = pids.indexOf(3);
      const idx5 = pids.indexOf(5);
      assert(idx2 < idx3 && idx3 < idx5, 'sorted by PID');
    });

    check('maxPidOnDisk returns highest PID', () => {
      const max = maxPidOnDisk(tmp);
      assert(max === 5, `max PID 5, got ${max}`);
    });

    await checkAsync('maxPidOnDisk counts .crec-only PIDs (forked children have no meta)', async () => {
      // Regression: the old scanner only read *.meta.json. A forked child has
      // a <pid>.crec but no meta, so it was invisible and its PID could be
      // handed out again — silently merging two logs into one file.
      const { writeFileSync, unlinkSync } = await import('node:fs');
      const crecOnly = join(tmp, 'processes', '9.crec');
      writeFileSync(crecOnly, Buffer.alloc(0));
      try {
        const max = maxPidOnDisk(tmp);
        assert(max === 9, `.crec-only PID 9 counted, got ${max}`);
      } finally {
        unlinkSync(crecOnly);
      }
      // After removal we fall back to the highest meta PID, proving the file mattered.
      assert(maxPidOnDisk(tmp) === 5, 'falls back to meta PID once .crec removed');
    });

    check('maxPidOnDisk on empty dir returns 1', () => {
      const empty = mkdtempSync(join(tmpdir(), 'cortex-empty-'));
      try {
        const max = maxPidOnDisk(empty);
        assert(max === 1, `max PID 1, got ${max}`);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });

    check('crecPath uses processes/<pid>/ not a flat processes/', () => {
      const p = crecPath(tmp, asProcessId(42));
      assert(p === join(tmp, 'processes', '42', 'log.crec'), `path: ${p}`);
      assert(!p.includes('proc/'), 'still not the stale proc/ path');
    });

    check('advancePidCounterTo prevents PID reuse across invocations', () => {
      const clock = (): Timestamp => '2026-01-01T00:00:00.000Z';
      const table = new ProcessTable({
        kernelAbiVersion: KERNEL_ABI_VERSION,
        now: clock,
        recorderFactory: nullRecorderFactory,
      });
      // A fresh table starts at PID_FIRST_USER (2).
      assert(unbrand(table.pidCounter) === 2, `fresh counter should be 2, got ${unbrand(table.pidCounter)}`);
      // Seeding past an on-disk max of 7 must push the next allocation to 8.
      table.advancePidCounterTo(8);
      assert(unbrand(table.pidCounter) === 8, `counter should be 8 after advance, got ${unbrand(table.pidCounter)}`);
      // A lower value is a no-op (never rewinds the counter).
      table.advancePidCounterTo(3);
      assert(unbrand(table.pidCounter) === 8, `counter must not rewind, got ${unbrand(table.pidCounter)}`);
    });

    await checkAsync('readExitRecord recovers the real exit code from .crec', async () => {
      const rec = await Recorder.open({ pid: asProcessId(501), dir: join(tmp, 'processes', '501') });
      await rec.append({
        timestamp: '2026-01-01T00:00:00.000Z',
        pid: asProcessId(501),
        syscall: 'exit',
        callId: 'exit-1',
        phase: 'exit',
        result: { code: 3, reason: 'agent decided to fail' },
        stateBefore: 'running',
        stateAfter: 'exiting',
        reversibility: 'irreversible',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await rec.flush();
      await rec.close();
      const exit = await readExitRecord(tmp, asProcessId(501));
      assert(exit !== undefined, 'exit record should be found');
      assert(exit!.code === 3, `real code 3, got ${exit!.code}`);
      assert(exit!.reason === 'agent decided to fail', `real reason, got ${exit!.reason}`);
    });

    await checkAsync('readExitRecord returns undefined when no exit was recorded', async () => {
      const rec = await Recorder.open({ pid: asProcessId(502), dir: join(tmp, 'processes', '502') });
      await rec.append({
        timestamp: '2026-01-01T00:00:00.000Z',
        pid: asProcessId(502),
        syscall: 'llm_call',
        callId: 'c-1',
        phase: 'trap',
        error: { errno: 'EDRIVER', message: 'boom' },
        stateBefore: 'running',
        stateAfter: 'running',
        reversibility: 'reversible',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await rec.flush();
      await rec.close();
      const exit = await readExitRecord(tmp, asProcessId(502));
      assert(exit === undefined, 'no exit record => undefined (must NOT be treated as success)');
    });

    await checkAsync('findCheckpointByTag resolves tag -> chainId from .crec', async () => {
      const rec = await Recorder.open({ pid: asProcessId(503), dir: join(tmp, 'processes', '503') });
      await rec.append({
        timestamp: '2026-01-01T00:00:00.000Z',
        pid: asProcessId(503),
        syscall: 'checkpoint',
        callId: 'ckpt-1',
        phase: 'exit',
        args: { tag: 'before-risky', detach: true },
        result: { chainId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', byteSize: 128 },
        stateBefore: 'checkpointing',
        stateAfter: 'suspended',
        reversibility: 'idempotent',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await rec.flush();
      await rec.close();
      const chain = await findCheckpointByTag(tmp, 'before-risky');
      assert(chain === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', `resolved chainId, got ${chain}`);
      const missing = await findCheckpointByTag(tmp, 'no-such-tag');
      assert(missing === undefined, 'unknown tag => undefined');
    });

    // cmdSpawn `--memory` validation path.
    const prevHome = process.env['CORTEX_HOME'];
    const prevLog = console.log;
    const prevErr = console.error;
    process.env['CORTEX_HOME'] = tmp;
    try {
      await checkAsync('cortex spawn rejects a malformed --memory before booting', async () => {
        console.log = () => {};
        console.error = () => {};
        const code = await cmdSpawn(['--role', 'x', '--memory', 'not-json']);
        assert(code === 1, `exit 1 for malformed JSON, got ${code}`);
      });

      await checkAsync('cortex spawn rejects a bad --memory policy shape', async () => {
        console.log = () => {};
        console.error = () => {};
        const code = await cmdSpawn([
          '--role', 'x',
          '--memory', '{"a":{"kind":"nope","backing":"inmem"}}',
        ]);
        assert(code === 1, `exit 1 for invalid kind, got ${code}`);
      });

      await checkAsync('cortex spawn accepts a valid --memory and runs the prompt agent', async () => {
        console.log = () => {};
        console.error = () => {};
        const code = await cmdSpawn([
          '--role', 'x',
          '--task', 'noop',
          '--memory', '{"scratch":{"kind":"private","backing":"inmem","maxEntries":3}}',
          '-t', '2000',
        ]);
        assert(typeof code === 'number', 'spawn returns a numeric exit code when --memory validates');
      });
    } finally {
      console.log = prevLog;
      console.error = prevErr;
      if (prevHome === undefined) delete process.env['CORTEX_HOME'];
      else process.env['CORTEX_HOME'] = prevHome;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// =============================================================================
// CLI daemon checks (#039)
// =============================================================================

async function runDaemonChecks(): Promise<void> {
  const { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-daemon-'));
  mkdirSync(join(tmp, 'processes'), { recursive: true });

  const prevHome = process.env['CORTEX_HOME'];
  const prevLog = console.log;
  const prevErr = console.error;

  try {
    process.env['CORTEX_HOME'] = tmp;

    await checkAsync('cortex daemon install persists a DaemonSpec to daemons.json', async () => {
      const modulePath = join(tmp, 'crash-agent.ts');
      writeFileSync(modulePath, `export default async function crashAgent(ctx: any): Promise<void> { ctx.exit(1, 'boom'); }\n`);
      console.log = prevLog; console.error = prevErr;
      const code = await cmdDaemon(['install', 'watcher', '--role', 'inbox-watcher', '--module', modulePath, '--restart', 'on-failure', '--max-restarts', '5', '--backoff-ms', '10']);
      assert(code === 0, `exit 0, got ${code}`);
      const stored = readDaemon(tmp, 'watcher');
      assert(stored !== undefined, 'daemon registered');
      assert(stored!.spec.role === 'inbox-watcher', `role, got ${stored!.spec.role}`);
      assert(stored!.spec.restart?.kind === 'on-failure', 'restart kind');
      assert(stored!.spec.restart?.maxRestarts === 5, 'maxRestarts');
      assert(stored!.spec.restart?.backoffMs === 10, 'backoffMs');
      assert('module' in stored!.spec.agent, 'agent is a module spec');
      assert(existsSync(join(tmp, 'daemons.json')), 'daemons.json written');
    });

    await checkAsync('cortex daemon install rejects a bad name and a bad restart kind', async () => {
      console.log = prevLog; console.error = prevErr;
      const badName = await cmdDaemon(['install', 'has space', '--role', 'x', '--system', 'y']);
      assert(badName === 1, `bad name exit 1, got ${badName}`);
      const badRestart = await cmdDaemon(['install', 'ok', '--role', 'x', '--system', 'y', '--restart', 'sometimes']);
      assert(badRestart === 1, `bad restart exit 1, got ${badRestart}`);
    });

    await checkAsync('cortex daemon list shows the registered daemon', async () => {
      console.log = prevLog; console.error = prevErr;
      let out = '';
      console.log = (...parts: unknown[]): void => { out += parts.map((p) => String(p)).join(' ') + '\n'; };
      const code = await cmdDaemon(['list']);
      console.log = prevLog;
      assert(code === 0, `exit 0, got ${code}`);
      assert(out.includes('watcher'), 'name listed');
      assert(out.includes('inbox-watcher'), 'role listed');
      assert(out.includes('on-failure'), 'restart policy listed');
    });

    await checkAsync('cortex daemon uninstall removes the spec (and the unit file)', async () => {
      console.log = prevLog; console.error = prevErr;
      // Create the unit at the path uninstall will look for (platform-dependent;
      // on win32 this is undefined and there is no unit file to remove).
      const unit = unitPathFor(process.platform, 'watcher', tmp);
      if (unit !== undefined) {
        mkdirSync(join(tmp, 'units'), { recursive: true });
        writeFileSync(unit, '[Unit]\n');
        assert(existsSync(unit), 'unit pre-existing');
      }
      const code = await cmdDaemon(['uninstall', 'watcher']);
      assert(code === 0, `exit 0, got ${code}`);
      assert(readDaemon(tmp, 'watcher') === undefined, 'spec removed');
      if (unit !== undefined) assert(!existsSync(unit), 'unit file removed');
    });

    await checkAsync('generateServiceUnit renders linux + darwin units; win32 has no file', () => {
      const linux = generateServiceUnit('linux', 'watcher', 'node /x/cli/index.ts', tmp, 'on-failure');
      assert(linux.path.includes('units') && linux.path.includes('cortex-watcher.service'), `linux path, got ${linux.path}`);
      assert(linux.contents.includes('[Unit]'), 'has [Unit]');
      assert(linux.contents.includes('ExecStart=node /x/cli/index.ts daemon run watcher'), 'exec start');
      assert(linux.contents.includes('Restart=on-failure'), 'restart kind');
      const darwin = generateServiceUnit('darwin', 'watcher', 'node /x/cli/index.ts', tmp, 'always');
      assert(darwin.path.includes('units') && darwin.path.includes('sh.cortex.daemon.watcher.plist'), 'darwin path');
      assert(darwin.contents.includes('<plist'), 'plist');
      assert(darwin.contents.includes('<string>daemon</string>'), 'argv has daemon');
      assert(darwin.contents.includes('<string>run</string>'), 'argv has run');
      assert(darwin.contents.includes('RestartSec') === false, 'launchd uses KeepAlive not RestartSec');
      assert(unitPathFor('win32', 'watcher', tmp) === undefined, 'win32 has no unit file path');
    });

    await checkAsync('enableCommand is correct per platform', () => {
      assert(enableCommand('linux', 'watcher', '/u/cortex-watcher.service') === 'systemctl --user enable --now cortex-watcher.service', 'linux');
      assert(enableCommand('darwin', 'watcher', '/u/sh.cortex.daemon.watcher.plist') === 'launchctl load "/u/sh.cortex.daemon.watcher.plist"', 'darwin');
      assert(enableCommand('win32', 'watcher', '').includes('schtasks'), 'windows schtasks');
    });

    await checkAsync('cortex daemon run supervises a crashing agent (restart policy fires)', async () => {
      // Re-register the crash agent with a tiny backoff so restarts are visible
      // within a short --max-runtime-ms window.
      const modulePath = join(tmp, 'crash-agent.ts');
      writeFileSync(modulePath, `export default async function crashAgent(ctx: any): Promise<void> { ctx.exit(1, 'boom'); }\n`);
      console.log = prevLog; console.error = prevErr;
      writeDaemon(tmp, {
        name: 'crasher',
        spec: {
          role: 'crasher',
          agent: { module: `file://${modulePath}` },
          restart: { kind: 'on-failure', maxRestarts: 50, backoffMs: 10 },
          memory: undefined,
        },
        installedAt: new Date().toISOString(),
      });
      const code = await cmdDaemon(['run', 'crasher', '--max-runtime-ms', '500']);
      assert(code === 0, `run exit 0, got ${code}`);
      // Logs now live at processes/<pid>/log.crec, one directory per process.
      const procRoot = join(tmp, 'processes');
      const crecs = existsSync(procRoot)
        ? readdirSync(procRoot).filter(
            (name) => /^\d+$/.test(name) && existsSync(join(procRoot, name, 'log.crec')),
          )
        : [];
      assert(crecs.length >= 2, `restart produced >= 2 process logs (got ${crecs.length})`);
    });

    await checkAsync('cortex daemon run with an unknown name fails', async () => {
      console.log = prevLog; console.error = prevErr;
      const code = await cmdDaemon(['run', 'ghost', '--max-runtime-ms', '100']);
      assert(code === 1, `exit 1, got ${code}`);
    });
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    if (prevHome === undefined) delete process.env['CORTEX_HOME'];
    else process.env['CORTEX_HOME'] = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  }
}
await runMemoryChecks();
await runCheckpointChecks();
await runForkChecks();
await runSchedulerChecks();
await runInitChecks();
await runDispatcherChecks();
await runDriverRegistryChecks();
await runMockLLMChecks();
await runDeepseekChecks();
await runOpenAiChecks();
await runFsChecks();
await runMcpChecks();
await runDiffChecks();
await runInMemChecks();
await runSqliteChecks();
runRegionsChecks();
await runCliChecks();
await runDaemonChecks();
await runBootChecks();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
