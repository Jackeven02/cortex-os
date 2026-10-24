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
  type DaemonDecision,
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
  type SendOptions,
  type ChannelId,
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
  type KernelEvent,
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

import { CortexLangChainCallbackHandler } from '../src/integrations/langchain.js';
import {
  tapFetch,
  llmTapStats,
  isLLMUrl,
  installTapFromEnv,
  readTapSpend,
  __resetLLMTapForTests,
  ENV_TAP_DIR,
  ENV_TAP_PID,
  ENV_TAP_TOKEN_BUDGET,
  ENV_TAP_REQUIRED,
  type TapCallInfo,
} from '../src/integrations/llm_tap.js';
import { startDashboard } from '../src/dashboard/server.js';
import { ActivityStore, toActivityEvent } from '../src/dashboard/event_store.js';
import { writeMeta, readMeta, writeExitRecord, writeProcessView, type ProcessMeta } from '../src/cli/process_store.js';
import { formatDollars, usdToDollars } from '../src/money.js';

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
import { cmdTrace, TRACE_SYSCALL_WIDTH, TRACE_HEADER } from '../src/cli/commands/trace.js';
import { cmdLogs, alreadyShown } from '../src/cli/commands/logs.js';
import { cmdMemory } from '../src/cli/commands/memory.js';
import { formatAccess, formatPeers } from '../src/cli/memory_view.js';
import { cmdWait } from '../src/cli/commands/wait.js';
import { cmdWatch } from '../src/cli/commands/watch.js';
import { cmdSupervise, decideAuthority, nextDeadline } from '../src/cli/commands/supervise.js';
import { cmdAttach } from '../src/cli/commands/attach.js';
import { cmdPs } from '../src/cli/commands/ps.js';
import { cmdLimit } from '../src/cli/commands/limit.js';
import { formatCaps } from '../src/cli/process_view.js';
import { readOpenCall, readOpenCallsFromKernel, isDeclaredWait } from '../src/cli/open_call.js';
import { cmdTop } from '../src/cli/commands/top.js';
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
  readSpec,
  writeSpec,
  specPath,
  outputPath,
  readOutput,
  writeMeta,
  type ProcessMeta,
  type ProcessSpec,
} from '../src/cli/process_store.js';

import {
  parseMemoryArg,
  mergeRegionPolicies,
  validateRegionPolicy,
  MemoryArgError,
} from '../src/cli/regions.js';
import { cmdSpawn } from '../src/cli/commands/spawn.js';
import { cmdRestore } from '../src/cli/commands/restore.js';
import { cmdReplay } from '../src/cli/commands/replay.js';
import { LogRecording, ReplayRecordings, type ReplayMode, type ReplaySource } from '../src/kernel/replay.js';
import {
  compareCalls,
  extractCalls,
  firstDifference,
  formatDivergence,
  type ComparedCall,
} from '../src/cli/replay_core.js';
import { processOutcome, formatOutcomeCode, describeOutcome } from '../src/cli/process_outcome.js';
import { formatTokenUsage, formatTokens, tokenUsage, callUsage } from '../src/token_usage.js';
import { formatTokenBudget, formatUsdBudget } from '../src/cli/process_budget.js';
import type { CortexContext, LLMResponse, Timestamp } from '../src/kernel/types.js';
import { OutputCapture } from '../src/cli/output_capture.js';
import { bootCliKernel } from '../src/cli/index.js';
import { pathToFileURL } from 'node:url';
import { resolveModule } from '../src/module_spec.js';
import { DEFAULT_MEMORY_REGIONS } from '../src/cli/index.js';
import {
  writeEndpoint,
  readEndpoint,
  clearEndpoint,
} from '../src/cli/kernel_endpoint.js';
import { startKernelServer } from '../src/cli/kernel_server.js';
import { probeKernel, KernelClient } from '../src/cli/kernel_client.js';

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
      table.setExitOutcome(pid, 0, 'normal');
      table.setFinalLogOffset(pid, asSyscallOffset(0));
      tick();
      await table.setState(pid, 'exiting', { trigger: 'exit-syscall' });
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
      // The outcome is decided before the process starts leaving — the same
      // order the kernel uses, so a zombie always knows how it ended.
      table.setExitOutcome(pid, 42, 'test-exit');
      table.setFinalLogOffset(pid, asSyscallOffset(123));
      await table.setState(pid, 'exiting');
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
          action === 'stop' || action === 'continue' || action === 'checkpoint',
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
   * `IpcManager.send` is now `prepareSend` + `commit`: the module prepares the
   * send, the *dispatcher* writes the record, and the message only becomes
   * real once that record has landed (docs/ABI.md §11 — the atomicity
   * window). The checks below are about IPC semantics, so they drive the
   * module directly and commit by hand; the recording path is exercised
   * separately, through the dispatcher.
   */
  let sendSeq = 0;
  async function doSend(
    mgr: IpcManager,
    from: ProcessIdAlias,
    to: ProcessIdAlias | ChannelId,
    body: unknown,
    opts: SendOptions = {},
  ): Promise<void> {
    const prepared = await mgr.prepareSend(from, to, body, opts, `test-send-${++sendSeq}`);
    prepared.commit();
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
      await doSend(mgr, a, chan, { hello: 'world' });
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
      await doSend(mgr, a, b, { ping: true });
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
        await doSend(mgr, a, asProcessId(9999), 'nope');
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
      await doSend(mgr, a, b, { toInbox: 1 });
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
      await doSend(mgr, a, chan, { woke: true });
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
      await doSend(mgr, a, chan, 1);
      await doSend(mgr, a, chan, 2);
      await doSend(mgr, a, chan, 3);
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
      await doSend(mgr, a, chan, { direct: true });
      await recvPromise;

      const info = mgr.getChannel(chan)!;
      assert(info.queueDepth === 0, `queue should be empty after handoff, got ${info.queueDepth}`);
      assert(info.totalSent === 1 && info.totalRecv === 1, 'counters should both be 1');
    });

    await checkAsync('send rolls back the enqueue when the record fails (ERECORD)', async () => {
      // The record is the dispatcher's now, but the message must not become
      // real until that record has landed (docs/ABI.md §11). So the *exit*
      // frame's write is the commit point: if it fails, the send is undone.
      // The enter frame is written before the route, so it must still land —
      // otherwise the send would never even be prepared and the rollback
      // would prove nothing.
      let failExit = false;
      const fake = {
        append: async (rec: { phase?: string }) => {
          if (failExit && rec.phase === 'exit') throw new Error('disk on fire');
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
      const signals = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const dispatcher = new SyscallDispatcher({
        table,
        signals,
        kernelAbiVersion: KERNEL_ABI_VERSION,
        now: clock,
        ipc: mgr,
      });
      const chan = asChannelId('rollback-enqueue');

      failExit = true;
      let caught: unknown;
      try {
        await dispatcher.invoke(a, 'send', chan, 'nope');
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
      failExit = false;
      await dispatcher.invoke(a, 'send', chan, 'ok');
      assert(mgr.getChannel(chan)!.queueDepth === 1, 'healthy send should enqueue');
      assert(mgr.getChannel(chan)!.totalSent === 1, 'totalSent should be 1 after healthy send');
    });

    await checkAsync('send rolls back a failed direct handoff, leaving the waiter parked', async () => {
      let failExit = false;
      const fake = {
        append: async (rec: { phase?: string }) => {
          if (failExit && rec.phase === 'exit') throw new Error('disk on fire');
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
      const signals = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const dispatcher = new SyscallDispatcher({
        table,
        signals,
        kernelAbiVersion: KERNEL_ABI_VERSION,
        now: clock,
        ipc: mgr,
      });
      const chan = asChannelId('rollback-handoff');

      const recvPromise = mgr.recv(b, chan);
      await waitFor(() => mgr.getChannel(chan)?.waiterCount === 1, 'waiter registered');

      failExit = true;
      let caught: unknown;
      try {
        await dispatcher.invoke(a, 'send', chan, 'lost');
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
      failExit = false;
      await dispatcher.invoke(a, 'send', chan, 'served');
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
      await doSend(mgr, a, chan, 'msg1');
      await doSend(mgr, a, chan, 'msg2');
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
        await doSend(mgr, a, chan, 'too late');
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
      await doSend(mgr, a, chan, 'one');
      await doSend(mgr, a, chan, 'two');
      let caught: unknown;
      try {
        await doSend(mgr, a, chan, 'three');
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
      await doSend(mgr, a, chan, 'hi');
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
      // Both `send` and `recv` record through the dispatcher now, so both go
      // through it.
      const signals = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const dispatcher = new SyscallDispatcher({
        table,
        signals,
        kernelAbiVersion: KERNEL_ABI_VERSION,
        now: clock,
        ipc: mgr,
      });

      await dispatcher.invoke(a, 'send', chan, { recorded: true });
      // Walk b to RUNNING (it already is) and recv.
      const msg = await dispatcher.invoke(b, 'recv', chan, { blocking: false });
      assert((msg.body as { recorded: boolean }).recorded === true, 'body mismatch');

      const recA = table.recorderFor(a)!;
      const recB = table.recorderFor(b)!;
      await recA.flush();
      await recB.flush();

      const sendRecords: SyscallRecord[] = [];
      for await (const r of readRecords(recA.path)) {
        if (r.syscall === 'send') sendRecords.push(r);
      }
      assert(sendRecords.length === 2, `expected send enter+exit, got ${sendRecords.length}`);
      assert(sendRecords[0]!.phase === 'enter', 'send enter frame first');
      assert(sendRecords[1]!.phase === 'exit', 'send exit frame last');
      assert(sendRecords[0]!.reversibility === 'idempotent', 'send should be idempotent');
      assert(sendRecords[1]!.reversibility === 'idempotent', 'send should be idempotent');
      assert(
        sendRecords[0]!.callId === sendRecords[1]!.callId,
        'send enter and exit must share one callId',
      );
      // The delivery facts ride in the exit frame; the body rides in the
      // enter frame's arguments, like every other syscall's arguments.
      const sendResult = sendRecords[1]!.result as {
        target: string;
        toPid: number | null;
        queueDepth: number;
        handedOff: boolean;
      };
      assert(sendResult.target === 'recorded', `send target should be the channel, got ${sendResult.target}`);
      assert(sendResult.handedOff === false, 'an empty channel means no handoff');
      assert(sendResult.queueDepth === 0, 'queue depth before the send was 0');

      const recvRecords: SyscallRecord[] = [];
      for await (const r of readRecords(recB.path)) {
        if (r.syscall === 'recv') recvRecords.push(r);
      }
      assert(recvRecords.length === 2, `expected recv enter+exit, got ${recvRecords.length}`);
      assert(recvRecords[0]!.phase === 'enter', 'recv enter frame first');
      assert(recvRecords[1]!.phase === 'exit', 'recv exit frame last');
      assert(recvRecords[1]!.reversibility === 'irreversible', 'recv should be irreversible');
      const result = recvRecords[1]!.result as { body: { recorded: boolean } };
      assert(result.body.recorded === true, 'recv record should capture the message body');
    });

    await checkAsync('a failed recv writes exactly one enter+trap pair under one callId', async () => {
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
      const signals = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
      const dispatcher = new SyscallDispatcher({
        table,
        signals,
        kernelAbiVersion: KERNEL_ABI_VERSION,
        now: clock,
        ipc: mgr,
      });

      // The dispatcher owns the `recv` record (docs/ABI.md §9). While ipc.ts
      // still wrote a trap frame of its own, one failed recv produced *two*
      // trap frames — and the module's one carried a callId that paired with
      // no `enter` frame, so replay could not line them up.
      try {
        await dispatcher.invoke(b, 'recv', asChannelId('trap-chan'), { blocking: false });
      } catch {
        /* expected: EAGAIN */
      }

      const recB = table.recorderFor(b)!;
      await recB.flush();
      const recvRecords: SyscallRecord[] = [];
      for await (const r of readRecords(recB.path)) {
        if (r.syscall === 'recv') recvRecords.push(r);
      }
      assert(recvRecords.length === 2, `expected enter+trap only, got ${recvRecords.length} frames`);
      assert(recvRecords[0]!.phase === 'enter', 'first recv frame should be enter');
      assert(recvRecords[1]!.phase === 'trap', 'second recv frame should be trap');
      assert(
        recvRecords[1]!.error?.errno === 'EAGAIN',
        `trap errno should be EAGAIN, got ${recvRecords[1]!.error?.errno}`,
      );
      assert(
        recvRecords[0]!.callId === recvRecords[1]!.callId,
        'enter and trap must share one callId so replay can pair them',
      );
      assert(
        recvRecords[1]!.reversibility === 'irreversible',
        'recv trap must keep the irreversible tag, not a guessed one',
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
    mgr.syncFromTable(pid);
    mgr.attachRegion(pid, 'episodic', priv);
    // Recording now belongs to the dispatcher's single path, so these memory
    // syscalls are driven through it exactly like every other syscall.
    const signals = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
    const dispatcher = new SyscallDispatcher({
      table,
      signals,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      memory: mgr,
    });
    await dispatcher.invoke(pid, 'memory_write', 'episodic', 'k', { small: true });
    await dispatcher.invoke(pid, 'memory_read', 'episodic', { key: 'k' });

    const rec = table.recorderFor(pid)!;
    await rec.flush();
    const records: SyscallRecord[] = [];
    for await (const r of readRecords(rec.path)) records.push(r);

    const writes = records.filter((r) => r.syscall === 'memory_write');
    const reads = records.filter((r) => r.syscall === 'memory_read');
    // Uniform with every dispatcher-owned syscall: one enter + one exit.
    assert(writes.length === 2, `expected enter+exit write frames, got ${writes.length}`);
    assert(reads.length === 2, `expected enter+exit read frames, got ${reads.length}`);
    assert(writes[0]!.phase === 'enter' && writes[1]!.phase === 'exit', 'write frames are enter then exit');

    assert(writes[1]!.reversibility === 'reversible', 'memory_write is reversible');
    const wArgs = writes[0]!.args as { region: string; key: string; policyKind: string; value: unknown };
    assert(wArgs.region === 'episodic' && wArgs.key === 'k', 'write args capture region+key');
    assert(wArgs.policyKind === 'private', 'write args capture policy kind');
    assert((wArgs.value as { small: boolean }).small === true, 'small value recorded inline');

    assert(reads[1]!.reversibility === 'idempotent', 'memory_read is idempotent');
    const rResult = reads[1]!.result as { count: number; valuesHash: string };
    assert(rResult.count === 1, 'read result captures count');
    assert(typeof rResult.valuesHash === 'string' && rResult.valuesHash.length === 64, 'read result hashes values');
    // The only copy of the small value is the write's enter frame; the read
    // never echoes values back into the log (ABI.md §4.4).
    const valueMentions = records.filter((r) => JSON.stringify(r).includes('{"small":true}'));
    assert(valueMentions.length === 1, `value recorded once, got ${valueMentions.length}`);
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
    mgr.syncFromTable(pid);
    mgr.attachRegion(pid, 'big', priv);
    const signals = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
    const dispatcher = new SyscallDispatcher({
      table,
      signals,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      memory: mgr,
    });
    await dispatcher.invoke(pid, 'memory_write', 'big', 'huge', 'this value is definitely larger than eight bytes');
    await dispatcher.invoke(pid, 'memory_write', 'big', 'small', 1, { recordHashOnly: true });

    const rec = table.recorderFor(pid)!;
    await rec.flush();
    const writes: SyscallRecord[] = [];
    for await (const r of readRecords(rec.path)) {
      // Only the enter frames carry args; each write produces enter + exit.
      if (r.syscall === 'memory_write' && r.phase === 'enter') writes.push(r);
    }
    assert(writes.length === 2, `expected 2 write enter frames, got ${writes.length}`);
    for (const w of writes) {
      const a = w.args as Record<string, unknown>;
      assert(a.value === undefined, 'hashed write must not record the raw value');
      assert(typeof a.valueHash === 'string', 'hashed write records a valueHash');
      assert(typeof a.valueBytes === 'number' && (a.valueBytes as number) > 0, 'hashed write records byte size');
    }
    // The large payload must not appear anywhere in the log.
    const raw = JSON.stringify(writes);
    assert(!raw.includes('larger than eight bytes'), 'large value never reaches the log');
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
    mgr.syncFromTable(pid);
    const signals = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
    const dispatcher = new SyscallDispatcher({
      table,
      signals,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      memory: mgr,
    });
    try {
      await dispatcher.invoke(pid, 'memory_write', 'ghost', 'k', 1);
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

  await checkAsync('take from RUNNING returns to RUNNING and writes a .csnap file', async () => {
    const table = await makeTable();
    const pid = await spawnRunning(table);
    assert(table.get(pid)!.state === 'running', 'starts running');
    const { ckpt, dir } = makeCkpt(table);
    const { chainId, path } = await ckpt.take(pid);
    tick();
    // RUNNING, not READY: docs/ABI.md §4.2 says the process "returns to
    // RUNNING", and the agent body resumes inline — leaving it READY would
    // make its next syscall trap ESTATE. (Regression test for the C1 report.)
    assert(table.get(pid)!.state === 'running', 'back to RUNNING after take');
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
      table.get(pid)!.state === 'running',
      'recovered to RUNNING, never stranded in CHECKPOINTING',
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
    assert(table.get(pid)!.state === 'running', 'source process is unaffected');
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

  await checkAsync('checkpoint records enter+exit through the dispatcher, still idempotent', async () => {
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
    // The module no longer records; the dispatcher does, so drive it there.
    const signals = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
    const dispatcher = new SyscallDispatcher({
      table,
      signals,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      checkpoint: ckpt,
    });
    const returned = await dispatcher.invoke(pid, 'checkpoint', { tag: 'pre-deploy' });
    const rec = table.recorderFor(pid)!;
    await rec.flush();
    const records: SyscallRecord[] = [];
    for await (const r of readRecords(rec.path)) records.push(r);
    const ck = records.filter((r) => r.syscall === 'checkpoint');
    assert(ck.length === 2, `expected checkpoint enter+exit, got ${ck.length}`);
    assert(ck[0]!.phase === 'enter' && ck[1]!.phase === 'exit', 'enter then exit');
    assert(ck[1]!.reversibility === 'idempotent', 'checkpoint is idempotent');
    // Boundary semantics: the states either side of the syscall, the same
    // vantage point every other syscall records.
    assert(ck[0]!.stateBefore === 'running', `stateBefore ${String(ck[0]!.stateBefore)}`);
    const res = ck[1]!.result as { chainId: string; byteSize: number; syscallLogOffset: number };
    assert(res.chainId === unbrand(returned.chainId), 'result carries the returned chainId');
    assert(typeof res.byteSize === 'number' && res.byteSize > 0, 'result carries byteSize');
    assert(typeof res.syscallLogOffset === 'number', 'result carries the snapshot log offset');
    // The ABI return stays narrow even though the record is wide.
    assert(Object.keys(returned as object).length === 1, 'agent receives only { chainId }');
    const args = ck[0]!.args as { tag?: string; detach?: boolean };
    assert(args.tag === 'pre-deploy', 'tag captured in args');
    assert(args.detach !== true, 'detach flag captured');
  });

  await checkAsync('a checkpoint that fails inside the module writes one trap frame', async () => {
    const sub = join(tmp, 'ckpt-trap');
    await mkdir(sub, { recursive: true });
    const table = new ProcessTable({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      recorderFactory: async (pid) => Recorder.open({ pid, dir: join(sub, String(unbrand(pid))) }),
    });
    tables.push(table);
    const pid = await spawnRunning(table);
    // A cognitive source that throws is the in-module failure path: the
    // state gate has already passed, so the module reaches its own catch —
    // the branch that used to write a second, mismatched trap frame.
    const { ckpt } = makeCkpt(table, {
      cognitiveSource: () => {
        throw new Error('cognitive snapshot unavailable');
      },
    });
    const signals = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
    const dispatcher = new SyscallDispatcher({
      table,
      signals,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      checkpoint: ckpt,
    });

    let caught: unknown = null;
    try {
      await dispatcher.invoke(pid, 'checkpoint', { tag: 'doomed' });
    } catch (err) {
      caught = err;
    }
    assert(isCortexError(caught), 'checkpoint should trap a CortexError');
    assert((caught as CortexError).errno === 'EDRIVER', `expected EDRIVER, got ${(caught as CortexError).errno}`);

    const rec = table.recorderFor(pid)!;
    await rec.flush();
    const records: SyscallRecord[] = [];
    for await (const r of readRecords(rec.path)) records.push(r);
    const ck = records.filter((r) => r.syscall === 'checkpoint');
    assert(ck.length === 2, `expected checkpoint enter+trap, got ${ck.length}`);
    assert(ck[0]!.phase === 'enter', 'first checkpoint frame should be enter');
    assert(ck[1]!.phase === 'trap', 'second checkpoint frame should be trap');
    assert(
      ck[0]!.callId === ck[1]!.callId,
      'enter and trap must share one callId so replay can pair them',
    );
    assert(ck[1]!.reversibility === 'idempotent', 'checkpoint keeps its idempotent tag');
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

  await checkAsync("the caller's log records the restore it asked for", async () => {
    const sub = join(tmp, 'restore-caller');
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
    const signals = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
    const dispatcher = new SyscallDispatcher({
      table,
      signals,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      checkpoint: ckpt,
    });

    const returned = (await dispatcher.invoke(pid, 'restore', chainId)) as { pid: ProcessIdAlias };
    const rec = table.recorderFor(pid)!;
    await rec.flush();
    const records: SyscallRecord[] = [];
    for await (const r of readRecords(rec.path)) records.push(r);
    const rs = records.filter((r) => r.syscall === 'restore');
    assert(rs.length === 2, `expected restore enter+exit, got ${rs.length}`);
    assert(rs[0]!.phase === 'enter', 'enter frame first');
    assert(rs[1]!.phase === 'exit', 'exit frame last');
    assert(rs[0]!.callId === rs[1]!.callId, 'enter and exit share one callId');
    assert(rs[1]!.reversibility === 'reversible', 'restore is reversible');
    const res = rs[1]!.result as { pid: number };
    assert(res.pid === unbrand(returned.pid), 'the exit frame carries the new pid');
    // The ABI return stays narrow even though the record is wide.
    assert(Object.keys(returned as object).length === 1, 'agent receives only { pid }');
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
    // The caller's frames are the dispatcher's now; the fork module writes
    // only the child's birth record.
    const signals = new SignalManager({ table, kernelAbiVersion: KERNEL_ABI_VERSION, now: clock });
    const dispatcher = new SyscallDispatcher({
      table,
      signals,
      kernelAbiVersion: KERNEL_ABI_VERSION,
      now: clock,
      fork,
    });
    const res = (await dispatcher.invoke(pid, 'fork', { tag: 'explore-alt' })) as ForkResult;

    const parentRec = table.recorderFor(pid)!;
    await parentRec.flush();
    const parentRecords: SyscallRecord[] = [];
    for await (const r of readRecords(parentRec.path)) parentRecords.push(r);
    const pf = parentRecords.filter((r) => r.syscall === 'fork');
    assert(pf.length === 2, `parent log has fork enter+exit, got ${pf.length}`);
    assert(pf[0]!.phase === 'enter', 'enter frame first');
    assert(pf[1]!.phase === 'exit', 'exit frame last');
    assert(pf[0]!.reversibility === 'reversible', 'fork is reversible');
    assert(pf[1]!.reversibility === 'reversible', 'fork is reversible');
    assert(pf[0]!.callId === pf[1]!.callId, 'enter and exit share one callId');
    const pArgs = pf[0]!.args as { tag?: string };
    assert(pArgs.tag === 'explore-alt', 'tag captured in the enter frame');
    const pRes = pf[1]!.result as {
      childPid: number;
      childChainId: string;
      sharedCausalPast: number;
      irreversibleInPast: string[];
    };
    assert(pRes.childPid === unbrand(res.childPid), 'parent record carries child pid');
    assert(pRes.childChainId === unbrand(res.childChainId), 'parent record carries the child chain id');
    assert(Array.isArray(pRes.irreversibleInPast), 'parent record carries the irreversible history');
    // The shared causal past must point at the fork *itself* — the byte
    // offset where the enter frame landed — so `cortex diff` cuts the
    // parent's log there and the fork call counts as the divergence rather
    // than as shared history.
    assert(
      pRes.sharedCausalPast === unbrand(pf[0]!.byteOffset),
      `shared causal past (${pRes.sharedCausalPast}) should be the enter frame's offset (${unbrand(pf[0]!.byteOffset)})`,
    );

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
    onDecision?: (decision: DaemonDecision) => void;
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
    table.setExitOutcome(pid, code, reason);
    table.setFinalLogOffset(pid, off);
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

  await checkAsync('the supervisor tells the host what it decided', async () => {
    // The decisions were always made, and always recorded in init's own log.
    // What was missing was a way for the *operator* to hear them: a daemon
    // that crashed three times and was given up on printed nothing at all,
    // and for a daemon stdout is the log.
    const table = await makeTable();
    const decisions: DaemonDecision[] = [];
    const { init, signals } = makeKernel(table, { onDecision: (d) => decisions.push(d) });
    await init.boot();
    const first = await init.registerDaemon({
      role: 'd',
      agent,
      restart: { kind: 'on-failure', backoffMs: 0, maxRestarts: 1 },
    });

    // It fails: a new attempt starts, and the host is told about it.
    await exitWithCode(init, table, first, 3, 'boom');
    const restart = decisions.find((d) => d.kind === 'restart');
    assert(restart !== undefined, 'the restart was not reported');
    assert(restart!.kind === 'restart', 'the decision was not a restart');
    assert(
      restart!.kind === 'restart' && restart!.attempt === 1,
      `the decision named the wrong attempt: ${restart!.kind === 'restart' ? restart!.attempt : '?'}`,
    );
    assert(
      restart!.kind === 'restart' && restart!.previousExitCode === 3,
      `the decision lost the exit code: ${restart!.kind === 'restart' ? String(restart!.previousExitCode) : '?'}`,
    );
    assert(
      restart!.kind === 'restart' && restart!.previousExitReason === 'boom',
      `the decision lost the reason: ${restart!.kind === 'restart' ? restart!.previousExitReason : '?'}`,
    );
    const second = onlyChild(table);
    assert(second !== undefined, 'the replacement did not start');
    assert(
      restart!.kind === 'restart' && restart!.pid === unbrand(second!),
      'the decision named a different pid than the one that started',
    );

    // It fails again: the cap is reached, and the host is told that too.
    await exitWithCode(init, table, second!, 3, 'boom again');
    const stop = decisions.find((d) => d.kind === 'no-restart');
    assert(stop !== undefined, 'the give-up was not reported');
    assert(
      stop!.kind === 'no-restart' && stop!.detail.includes('max-restarts'),
      `the give-up did not say why: ${stop!.kind === 'no-restart' ? stop!.detail : '?'}`,
    );
    assert(
      stop!.kind === 'no-restart' && stop!.previousExitReason === 'boom again',
      `the give-up lost the reason: ${stop!.kind === 'no-restart' ? stop!.previousExitReason : '?'}`,
    );
  });

  await checkAsync('a daemon that is not restarted says so', async () => {
    // The policy said "never". That is a decision like any other, and the
    // operator has to hear it: the agent is gone for good.
    const table = await makeTable();
    const decisions: DaemonDecision[] = [];
    const { init, signals } = makeKernel(table, { onDecision: (d) => decisions.push(d) });
    await init.boot();
    const d = await init.registerDaemon({ role: 'd', agent, restart: { kind: 'never' } });
    await signals.send(d, 'SIGKILL', PID_KERNEL);
    const stop = decisions.find((x) => x.kind === 'no-restart');
    assert(stop !== undefined, 'the decision not to restart was not reported');
    assert(
      stop!.kind === 'no-restart' && stop!.detail.includes('never'),
      `the decision did not say the policy: ${stop!.kind === 'no-restart' ? stop!.detail : '?'}`,
    );
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
    table.setExitOutcome(pid, code, reason);
    table.setFinalLogOffset(pid, asSyscallOffset(0));
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
    // Every syscall the dispatcher routes is now recorded by the dispatcher:
    // the seven that used to write their own frames (memory_read,
    // memory_write, send, recv, fork, checkpoint, restore) have all been
    // collapsed onto its single path (ABI.md section 11).
    assert(SELF_RECORDED_SYSCALLS.size === 0, `no syscall is self-recorded any more, got ${[...SELF_RECORDED_SYSCALLS].join(', ')}`);
    for (const s of ['memory_read', 'memory_write', 'send', 'recv', 'fork', 'checkpoint', 'restore'] as const) {
      assert(!SELF_RECORDED_SYSCALLS.has(s), `${s} records through the dispatcher`);
    }
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
    // Uniform with every other dispatcher-owned syscall: enter + exit.
    assert(mw.length === 2, `enter + exit frames, got ${mw.length}`);
    assert(mw[0]!.phase === 'enter', 'enter frame first');
    assert(mw[1]!.phase === 'exit', 'exit frame last');
    // …and the value is recorded once, in the enter frame's args. The exit
    // frame carries no args at all, so it cannot duplicate them.
    assert(mw[1]!.args === undefined, 'exit frame carries no args');
    const enterArgs = mw[0]!.args as { region: string; key: string; value: unknown };
    assert(enterArgs.region === 'scratch' && enterArgs.key === 'k', 'enter args capture region+key');
    assert(enterArgs.value === 1, 'small value recorded inline');
    const valueMentions = (JSON.stringify(records).match(/"value":1/g) ?? []).length;
    assert(valueMentions === 1, `value recorded exactly once, got ${valueMentions}`);
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

  await checkAsync('a wall-clock budget drains while the agent does nothing', async () => {
    // The wall clock is a ceiling on how long a process may **live**, so it
    // has to be charged by time passing — not by the process doing something.
    //
    // It used to be charged only at an `llm_call`, so an agent that sat in
    // `recv()` never drained it: a 1000ms ceiling and an agent that did
    // nothing at all for 1500ms came out with the full 1000ms still in hand.
    // A budget that an agent can outlast by doing nothing is not a ceiling.
    //
    // The kernel's heartbeat charges the clock now (the scheduler's tick), so
    // the ceiling is a ceiling.
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    reg.registerLLM(mockLLM());
    const table = await makeTable();
    const pid = await runningPid(table, { budgets: { tokens: -1, usd: -1, wallTimeMs: 1000 } });

    fakeNow += 1500; // the agent does nothing at all
    table.chargeWallClock(); // ...and the heartbeat notices

    const e = table.get(pid)!;
    assert(
      e.budgetsRemaining.wallTimeMs === 0,
      `the ceiling was reached, got ${e.budgetsRemaining.wallTimeMs}`,
    );
    assert(
      e.budgetsSpent.wallTimeMs >= 1500,
      `the time is on the record, got ${e.budgetsSpent.wallTimeMs}`,
    );
    await reg.closeAll();
  });

  await checkAsync('the wall clock of an unlimited budget is still counted', async () => {
    // An unlimited budget stays unlimited (`-1` is not a number that drains),
    // but the time the process lived is still a fact — and it used to be
    // reported as `0ms` for every agent that had no wall budget at all. The
    // views print that number (`cortex limit` says "wall time: spent 0ms"),
    // so it has to be the truth.
    const reg = new DriverRegistry({ kernelAbiVersion: KERNEL_ABI_VERSION });
    reg.registerLLM(mockLLM());
    const table = await makeTable();
    const dispatcher = makeDispatcher(table, reg);
    const pid = await runningPid(table, { budgets: { tokens: -1, usd: -1, wallTimeMs: -1 } });

    fakeNow += 2500;
    await dispatcher.invoke(pid, 'llm_call', { messages: [userMsg('hi')] });

    const e = table.get(pid)!;
    assert(e.budgetsRemaining.wallTimeMs === -1, 'an unlimited budget stays unlimited');
    assert(
      e.budgetsSpent.wallTimeMs >= 2500,
      `the time is on the record, got ${e.budgetsSpent.wallTimeMs}`,
    );
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
  const { mkdtemp, rm, mkdir, writeFile, readFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
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

  // --- §4.5 the default loader, on real files -------------------------------
  //
  // The kernel's default loader used to hand `spec.module` straight to
  // `import()`, which only understands *import specifiers*. On Windows an
  // absolute path died with "Only URLs with a scheme in: file, data, and
  // node are supported…", and a relative path was resolved against the
  // kernel's own source directory instead of the caller's working directory.
  // The ABI documents `module` as "path or import specifier" and shows
  // `agent: { module: './agents/researcher.js' }` — so the loader has to
  // mean it.
  //
  // These checks use the REAL loader (no injected importer) and real files
  // on disk, because the bug is about the filesystem.

  /** A kernel with the real module loader — no injected importer. */
  async function makeRealKernel(sub: string, cwd: string): Promise<Kernel> {
    const k = new Kernel({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      dir: join(sub, 'kernel'),
      cwd,
      now: clock,
      random: detRandom,
      recorderFactory: nullRecorderFactory,
      autoStart: false,
      loadDrivers: (reg) => {
        reg.registerLLM(mockLLM());
      },
    });
    await k.boot();
    kernels.push(k);
    return k;
  }

  /**
   * A child agent module that writes a marker file and exits with code 7.
   * The marker is the proof that the module was *loaded and run*, not merely
   * resolved.
   */
  const childModuleSource = (marker: string): string => `
import { writeFileSync } from 'node:fs';
export default async (ctx) => {
  writeFileSync(${JSON.stringify(marker)}, 'ran');
  ctx.exit(7, 'child ran');
};
`;

  /**
   * A parent agent module that spawns a child by `childSpec` and writes the
   * child's exit code to `codeFile`. The code file is the proof that the
   * parent saw the child's *real* outcome.
   */
  const parentModuleSource = (childSpec: string, codeFile: string): string => `
import { writeFileSync } from 'node:fs';
export default async (ctx) => {
  const { pid } = await ctx.spawn({ role: 'child', agent: { module: ${JSON.stringify(childSpec)} } });
  const res = await ctx.wait(pid);
  writeFileSync(${JSON.stringify(codeFile)}, String(res.exitCode));
  ctx.exit(0, 'parent done');
};
`;

  await checkAsync('ctx.spawn loads a child agent module named by an absolute path', async () => {
    const sub = join(tmp, 'mod-abs');
    await mkdir(sub, { recursive: true });
    const marker = join(sub, 'child-ran.txt');
    const codeFile = join(sub, 'child-code.txt');
    const child = join(sub, 'child.mjs');
    const parent = join(sub, 'parent.mjs');
    await writeFile(child, childModuleSource(marker), 'utf8');
    await writeFile(parent, parentModuleSource(child, codeFile), 'utf8');

    const k = await makeRealKernel(sub, sub);
    await k.spawn({ role: 'parent', agent: { module: parent } });
    await k.settle();

    assert(existsSync(marker), 'the child module was loaded and run');
    assert(
      (await readFile(codeFile, 'utf8')) === '7',
      'the parent saw the child\'s real exit code',
    );
  });

  await checkAsync('a relative module path resolves against the working directory', async () => {
    const sub = join(tmp, 'mod-rel');
    await mkdir(sub, { recursive: true });
    const marker = join(sub, 'child-ran.txt');
    const codeFile = join(sub, 'child-code.txt');
    await writeFile(join(sub, 'child.mjs'), childModuleSource(marker), 'utf8');
    await writeFile(join(sub, 'parent.mjs'), parentModuleSource('./child.mjs', codeFile), 'utf8');

    // Both the parent and the child are named relatively. Neither may be
    // resolved against the kernel's own source directory — an installed
    // package has no agent modules next to its internals.
    const k = await makeRealKernel(sub, sub);
    await k.spawn({ role: 'parent', agent: { module: './parent.mjs' } });
    await k.settle();

    assert(existsSync(marker), 'the child module was loaded and run');
    assert(
      (await readFile(codeFile, 'utf8')) === '7',
      'the parent saw the child\'s real exit code',
    );
  });

  await checkAsync('a file:// module URL is used exactly as it is', async () => {
    const sub = join(tmp, 'mod-url');
    await mkdir(sub, { recursive: true });
    const marker = join(sub, 'child-ran.txt');
    const codeFile = join(sub, 'child-code.txt');
    const child = join(sub, 'child.mjs');
    await writeFile(child, childModuleSource(marker), 'utf8');
    const childUrl = pathToFileURL(child).href;
    await writeFile(join(sub, 'parent.mjs'), parentModuleSource(childUrl, codeFile), 'utf8');

    const k = await makeRealKernel(sub, sub);
    await k.spawn({ role: 'parent', agent: { module: pathToFileURL(join(sub, 'parent.mjs')).href } });
    await k.settle();

    assert(existsSync(marker), 'the child module was loaded and run');
    assert(
      (await readFile(codeFile, 'utf8')) === '7',
      'the parent saw the child\'s real exit code',
    );
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
// LangChain integration checks
// =============================================================================

async function runLangchainChecks(): Promise<void> {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const tmp = await mkdtemp(join(tmpdir(), 'cortex-smoke-lc-'));
  try {
    const handler = new CortexLangChainCallbackHandler({ dir: tmp });

    await checkAsync('llm start/end round-trips metadata-only events to disk', async () => {
      await handler.handleLLMStart({}, ['secret prompt text'], 'run-1', undefined, undefined, undefined, { cortexPid: 7 }, 'ChatOpenAI');
      await handler.handleLLMEnd({ usage_metadata: { input_tokens: 5, output_tokens: 3 } }, 'run-1');
      await handler.flush();
      const lines = (await readFile(join(tmp, 'integrations', 'langchain', 'events.jsonl'), 'utf8')).trim().split('\n');
      assert(lines.length === 2, `expected 2 events, got ${lines.length}`);
      const start = JSON.parse(lines[0]!) as Record<string, unknown>;
      const end = JSON.parse(lines[1]!) as Record<string, unknown>;
      assert(start['type'] === 'llm.start' && start['pid'] === 7 && start['name'] === 'ChatOpenAI', 'start event fields');
      assert(!JSON.stringify(start).includes('secret prompt text'), 'prompt text must not be recorded');
      assert(end['type'] === 'llm.end' && end['inputTokens'] === 5 && end['outputTokens'] === 3, 'usage extracted');
      assert(typeof end['durationMs'] === 'number' && (end['durationMs'] as number) >= 0, 'duration measured');
    });

    await checkAsync('llm error path records the error name, not the message', async () => {
      await handler.handleLLMError(new Error('secret failure detail'), 'run-2');
      await handler.flush();
      const lines = (await readFile(join(tmp, 'integrations', 'langchain', 'events.jsonl'), 'utf8')).trim().split('\n');
      const evt = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
      assert(evt['type'] === 'llm.error' && evt['error'] === 'Error', 'error name only');
      assert(!JSON.stringify(evt).includes('secret failure detail'), 'error message must not be recorded');
    });

    await checkAsync('concurrent events serialize (one JSON object per line)', async () => {
      const parallel = new CortexLangChainCallbackHandler({ dir: tmp });
      await Promise.all(
        Array.from({ length: 20 }, (_, i) => parallel.handleChainStart({}, null, `chain-${i}`)),
      );
      await parallel.flush();
      const lines = (await readFile(join(tmp, 'integrations', 'langchain', 'events.jsonl'), 'utf8')).trim().split('\n');
      assert(lines.length === 23, `expected 23 total lines, got ${lines.length}`);
      for (const line of lines) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        assert(typeof parsed['type'] === 'string', 'every line is a valid event');
      }
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------------
  // crec sink: the point of this mode is that `cortex trace` can read an
  // external agent. Assert the frames decode back through the real reader.
  // ---------------------------------------------------------------------------
  const crecTmp = await mkdtemp(join(tmpdir(), 'cortex-smoke-lc-crec-'));
  try {
    const { readRecords } = await import('../src/kernel/recorder.js');
    const { existingCrecPath } = await import('../src/index.js');
    const { asProcessId } = await import('../src/kernel/types.js');

    const handler = new CortexLangChainCallbackHandler({ dir: crecTmp, pid: 4242 });
    assert(handler.crecProcessDir().endsWith(join('processes', '4242')), 'crec dir follows ARCHITECTURE §7 layout');

    await checkAsync('crec sink writes enter+exit frames readable by cortex trace', async () => {
      await handler.handleChatModelStart({}, [{ content: 'secret prompt' }], 'run-a', undefined, undefined, undefined, undefined, 'ChatOpenAI');
      await handler.handleLLMEnd({ usage_metadata: { input_tokens: 11, output_tokens: 4 } }, 'run-a');
      await handler.flush();

      const records = [];
      for await (const rec of readRecords(existingCrecPath(crecTmp, asProcessId(4242)))) records.push(rec);
      assert(records.length === 2, `expected 2 frames, got ${records.length}`);
      const [enter, exit] = records;
      assert(enter!.phase === 'enter' && exit!.phase === 'exit', 'phases are enter then exit');
      assert(enter!.callId === 'run-a' && exit!.callId === 'run-a', 'frames pair by callId so trace can match them');
      assert(enter!.pid === 4242, 'frames carry the handler pid');
      assert(enter!.args !== undefined && (enter!.args as Record<string, unknown>)['name'] === 'ChatOpenAI', 'enter records the run name');
      const result = exit!.result as Record<string, unknown>;
      assert(result['inputTokens'] === 11 && result['outputTokens'] === 4, 'token usage lands in the exit result');
      assert(typeof exit!.durationMs === 'number', 'duration recorded');
      assert(!JSON.stringify(records).includes('secret prompt'), 'prompt text still never recorded');
    });

    await checkAsync('crec frames carry a reversibility tag, tools are irreversible', async () => {
      await handler.handleToolStart({ name: 'create_order' }, 'secret-arg', 'run-t');
      await handler.handleToolEnd('secret-output', 'run-t');
      await handler.flush();
      const records = [];
      for await (const rec of readRecords(existingCrecPath(crecTmp, asProcessId(4242)))) records.push(rec);
      const toolFrames = records.filter((r) => r.callId === 'run-t');
      assert(toolFrames.length === 2, 'tool start/end produced two frames');
      assert(toolFrames[0]!.reversibility === 'irreversible', 'a tool call is tagged irreversible');
      assert(!JSON.stringify(toolFrames).includes('secret-arg'), 'tool input never recorded');
      assert(!JSON.stringify(toolFrames).includes('secret-output'), 'tool output never recorded');
    });

    await checkAsync('an error becomes an exit-trap pair, not a silent success', async () => {
      await handler.handleLLMError(new Error('secret failure detail'), 'run-e');
      await handler.flush();
      const records = [];
      for await (const rec of readRecords(existingCrecPath(crecTmp, asProcessId(4242)))) records.push(rec);
      const frames = records.filter((r) => r.callId === 'run-e');
      assert(frames.length === 1 && frames[0]!.phase === 'trap', 'an unpaired error records a trap frame');
      assert(frames[0]!.error !== undefined, 'error field present');
      assert(!JSON.stringify(frames).includes('secret failure detail'), 'error message body never recorded');
    });

    await checkAsync('crec sink still writes jsonl, and close() releases the fd', async () => {
      const both = new CortexLangChainCallbackHandler({ dir: crecTmp, pid: 4242 });
      await both.handleChainStart({}, null, 'run-c');
      await both.handleChainEnd('ok', 'run-c');
      await both.close();
      const lines = (await readFile(join(crecTmp, 'integrations', 'langchain', 'events.jsonl'), 'utf8')).trim().split('\n');
      assert(lines.length > 0, 'jsonl still written when crec is on');
    });

    await checkAsync('crecProcessDir throws without a pid rather than writing a stray log', () => {
      const noPid = new CortexLangChainCallbackHandler({ dir: crecTmp });
      let threw = false;
      try {
        noPid.crecProcessDir();
      } catch {
        threw = true;
      }
      assert(threw, 'no pid means no process dir — fail loudly');
    });

    await handler.close();
  } finally {
    await rm(crecTmp, { recursive: true, force: true });
  }
}

// =============================================================================
// fetch tap checks — the zero-code path for any OpenAI-compatible client
// =============================================================================

async function runLLMTapChecks(): Promise<void> {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readRecords } = await import('../src/kernel/recorder.js');
  const { existingCrecPath } = await import('../src/index.js');
  const { asProcessId } = await import('../src/kernel/types.js');

  const readTap = async (dir: string, pid: number) => {
    const out = [];
    for await (const r of readRecords(existingCrecPath(dir, asProcessId(pid)))) out.push(r);
    return out;
  };

  const tmp = await mkdtemp(join(tmpdir(), 'cortex-smoke-tap-'));
  const realFetch = globalThis.fetch;
  try {
    await checkAsync('isLLMUrl recognises OpenAI-compatible endpoints and rejects others', () => {
      assert(isLLMUrl('https://api.openai.com/v1/chat/completions'), 'openai chat');
      assert(isLLMUrl('https://openrouter.ai/api/v1/chat/completions'), 'openrouter');
      assert(isLLMUrl('http://localhost:11434/api/chat'), 'ollama');
      assert(isLLMUrl('https://api.openai.com/v1/embeddings'), 'embeddings');
      assert(!isLLMUrl('https://api.github.com/user'), 'a REST endpoint is not an LLM');
      assert(!isLLMUrl('not a url'), 'garbage is not a url');
    });

    await checkAsync('tap counts tokens and writes an llm_call pair with no prompt text', async () => {
      const seen: TapCallInfo[] = [];
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            model: 'gpt-4o-mini',
            usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 8 } },
            choices: [{ message: { content: 'SECRET COMPLETION TEXT' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof globalThis.fetch;

      const uninstall = await tapFetch({ dir: tmp, pid: 7001, onCall: (i) => void seen.push(i) });
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'SECRET PROMPT' }] }),
      });
      // The host must still get its body back intact — the tap is a meter, not
      // a proxy. If this fails, the tap broke the host it was meant to observe.
      const echoed = (await (res as unknown as Response).json()) as Record<string, unknown>;
      assert((echoed['choices'] as unknown[]).length === 1, 'caller still receives the untouched body');
      await uninstall();

      const frames = await readTap(tmp, 7001);
      assert(frames.length === 2, `expected enter+exit, got ${frames.length}`);
      assert(frames[0]!.phase === 'enter' && frames[1]!.phase === 'exit', 'phases pair up');
      assert(frames[0]!.syscall === 'llm_call', 'recorded under the llm_call name');
      const result = frames[1]!.result as Record<string, unknown>;
      assert(result['inputTokens'] === 100 && result['outputTokens'] === 20, 'token usage extracted');
      assert(result['cachedTokens'] === 8, 'cached prefix tokens found in prompt_tokens_details');
      assert(typeof result['usd'] === 'number' && (result['usd'] as number) > 0, 'usd priced from the driver table');
      const raw = JSON.stringify(frames);
      assert(!raw.includes('SECRET PROMPT'), 'request body text never recorded');
      assert(!raw.includes('SECRET COMPLETION'), 'response text never recorded');
      assert(seen.length === 1 && seen[0]!.inputTokens === 100, 'onCall fired once with the usage');
    });

    await checkAsync('tap leaves non-LLM requests completely alone', async () => {
      let passthrough = 0;
      globalThis.fetch = (async () => {
        passthrough += 1;
        return new Response('{"ok":true}', { status: 200 });
      }) as unknown as typeof globalThis.fetch;
      const uninstall = await tapFetch({ dir: tmp, pid: 7002 });
      await fetch('https://api.github.com/user');
      await uninstall();
      assert(passthrough === 1, 'request still went through');
      const frames = await readTap(tmp, 7002);
      assert(frames.length === 0, 'a non-LLM request records nothing');
    });

    await checkAsync('a non-2xx response becomes a trap frame carrying the status', async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof globalThis.fetch;
      const uninstall = await tapFetch({ dir: tmp, pid: 7003 });
      const res = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' });
      await uninstall();
      assert(res.status === 429, 'caller still sees the real status');
      const frames = await readTap(tmp, 7003);
      assert(frames.length === 2, 'enter plus trap');
      assert(frames[1]!.phase === 'trap', 'a failed call is a trap, not an exit');
      assert(frames[1]!.error !== undefined && frames[1]!.error.message.includes('429'), 'status is in the error');
    });

    await checkAsync('a network throw records a trap and rethrows to the caller', async () => {
      globalThis.fetch = (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof globalThis.fetch;
      const uninstall = await tapFetch({ dir: tmp, pid: 7004 });
      let caught: unknown;
      try {
        await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' });
      } catch (err) {
        caught = err;
      }
      await uninstall();
      assert(caught instanceof TypeError, 'the original error reaches the host untouched');
      const frames = await readTap(tmp, 7004);
      assert(frames.length === 2 && frames[1]!.phase === 'trap', 'enter plus trap');
    });

    await checkAsync('a token ceiling is recorded as an overrun, not silently ignored', async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ model: 'gpt-4o-mini', usage: { prompt_tokens: 100, completion_tokens: 50 } }), {
          status: 200,
        })) as unknown as typeof globalThis.fetch;
      const seen: TapCallInfo[] = [];
      // Budget below the first call's usage, so the very call crosses it.
      const uninstall = await tapFetch({ dir: tmp, pid: 7005, tokenBudget: 100, onCall: (i) => void seen.push(i) });
      await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' });
      await uninstall();
      const frames = await readTap(tmp, 7005);
      const result = frames[1]!.result as Record<string, unknown>;
      assert(result['budget'] === 'exceeded', 'the overrun is visible in the record');
      assert(seen[0]!.budget === 'record', 'default action is record, not throw');
      assert(llmTapStats().inputTokens === 100, 'running totals are readable without parsing the log');
    });

    await checkAsync("onBudget 'throw' aborts the call but keeps the record", async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ model: 'gpt-4o-mini', usage: { prompt_tokens: 100, completion_tokens: 50 } }), {
          status: 200,
        })) as unknown as typeof globalThis.fetch;
      const uninstall = await tapFetch({ dir: tmp, pid: 7006, tokenBudget: 10, onBudget: 'throw' });
      let caught: Error | undefined;
      try {
        await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' });
      } catch (err) {
        caught = err as Error;
      }
      await uninstall();
      assert(caught !== undefined && caught.message.includes('budget exceeded'), 'the host is told why it stopped');
      const frames = await readTap(tmp, 7006);
      assert(frames.length === 2, 'the spend is still auditable after the abort');
      assert((frames[1]!.result as Record<string, unknown>)['budget'] === 'exceeded', 'and still marked as an overrun');
    });

    await checkAsync('a custom match narrows the tap to one provider', async () => {
      let other = 0;
      globalThis.fetch = (async () => {
        other += 1;
        return new Response('{"ok":true}', { status: 200 });
      }) as unknown as typeof globalThis.fetch;
      const uninstall = await tapFetch({ dir: tmp, pid: 7007, match: (u) => u.includes('openai.com') });
      await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' });
      await uninstall();
      assert(other === 1, 'the unmatched request still went through');
      assert((await readTap(tmp, 7007)).length === 0, 'and was not recorded');
    });

    await checkAsync('a second tap returns the first uninstaller instead of double-counting', async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ model: 'gpt-4o-mini', usage: { prompt_tokens: 7, completion_tokens: 3 } }), {
          status: 200,
        })) as unknown as typeof globalThis.fetch;
      const first = await tapFetch({ dir: tmp, pid: 7008 });
      // The second call must be a no-op returning the first uninstaller. Its
      // own pid must be ignored entirely — otherwise every request would be
      // counted twice, once per wrapper, and the budget would be nonsense.
      const second = await tapFetch({ dir: tmp, pid: 7009 });
      await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' });
      await second();
      const frames = await readTap(tmp, 7008);
      assert(frames.length === 2, `exactly one pair recorded, got ${frames.length}`);
      const result = frames[1]!.result as Record<string, unknown>;
      assert(result['inputTokens'] === 7, 'counted once, not twice');
      await first();
    });

    await checkAsync('uninstall restores the original fetch', async () => {
      const before = globalThis.fetch;
      const uninstall = await tapFetch({ dir: tmp, pid: 7010 });
      assert(globalThis.fetch !== before, 'fetch is wrapped while installed');
      await uninstall();
      assert(globalThis.fetch === before, 'fetch is put back on uninstall');
    });

    // --- installTapFromEnv: the channel `cortex wrap --tap` actually uses -----
    //
    // These matter more than they look. The `--tap` flag's whole contract is
    // "the parent writes env vars, the child reads them". If this half of the
    // channel silently does nothing, `cortex wrap --tap` reports a supervised
    // run that recorded nothing — the exact failure this project refuses to
    // ship. So the no-op path, the strict path, and the real path all get
    // asserted.

    await checkAsync('installTapFromEnv does nothing when no tap was requested', async () => {
      const before = globalThis.fetch;
      const uninstall = await installTapFromEnv({});
      assert(uninstall === undefined, 'a bare project gets no tap and no uninstaller');
      assert(globalThis.fetch === before, 'and its fetch is left completely alone');
    });

    await checkAsync('installTapFromEnv installs a working tap from env alone', async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ model: 'gpt-4o-mini', usage: { prompt_tokens: 11, completion_tokens: 4 } }), {
          status: 200,
        })) as unknown as typeof globalThis.fetch;
      // Exactly the four variables `cortex wrap --tap` writes, nothing else.
      // No options object, no import of internal state: the child only ever
      // sees strings.
      const uninstall = await installTapFromEnv({
        [ENV_TAP_DIR]: tmp,
        [ENV_TAP_PID]: '7011',
        [ENV_TAP_REQUIRED]: '1',
      });
      assert(uninstall !== undefined, 'the tap is installed');
      await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' });
      await uninstall();
      const frames = await readTap(tmp, 7011);
      assert(frames.length === 2, `the env-installed tap records a pair, got ${frames.length}`);
      const result = frames[1]!.result as Record<string, unknown>;
      assert(result['inputTokens'] === 11, 'and counts the same tokens as an in-process tap');
    });

    await checkAsync('installTapFromEnv reads the token budget and the abort action', async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ model: 'gpt-4o-mini', usage: { prompt_tokens: 100, completion_tokens: 5 } }), {
          status: 200,
        })) as unknown as typeof globalThis.fetch;
      const uninstall = await installTapFromEnv({
        [ENV_TAP_DIR]: tmp,
        [ENV_TAP_PID]: '7012',
        [ENV_TAP_REQUIRED]: '1',
        [ENV_TAP_TOKEN_BUDGET]: '50',
        CORTEX_TAP_BUDGET_ACTION: 'throw',
      });
      assert(uninstall !== undefined, 'the ceiling and the action both arrived from the environment');
      let caught: Error | undefined;
      try {
        await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' });
      } catch (err) {
        caught = err as Error;
      }
      await uninstall();
      assert(caught !== undefined && caught.message.includes('budget exceeded'), 'the child is stopped by its own ceiling');
      const frames = await readTap(tmp, 7012);
      assert((frames[1]!.result as Record<string, unknown>)['budget'] === 'exceeded', 'and the overrun is still on record');
    });

    await checkAsync('installTapFromEnv throws on malformed config when the host required a tap', async () => {
      const before = globalThis.fetch;
      // Local helper rather than a shared one: this is the only place in the
      // file that needs "did it throw, and did the message say why".
      const throwsWith = async (env: NodeJS.ProcessEnv, needle: string, why: string) => {
        let caught: Error | undefined;
        try {
          await installTapFromEnv(env);
        } catch (err) {
          caught = err as Error;
        }
        assert(caught !== undefined, why);
        assert(caught!.message.includes(needle), `the error names ${needle}: ${caught!.message}`);
      };
      // A bad pid. Silently skipping here would hand back a run that looks
      // supervised and is not — so `cortex wrap --tap` sets CORTEX_TAP_REQUIRED
      // precisely to turn this from a shrug into a failure. The literal
      // '@PID@' is the unsubstituted placeholder, which is exactly the shape of
      // bug this guards: parent forgot to substitute, child must not go quiet.
      await throwsWith(
        { [ENV_TAP_DIR]: tmp, [ENV_TAP_PID]: '@PID@', [ENV_TAP_REQUIRED]: '1' },
        ENV_TAP_PID,
        'an unsubstituted pid placeholder is rejected, not ignored',
      );
      await throwsWith(
        { [ENV_TAP_DIR]: tmp, [ENV_TAP_PID]: '7013', [ENV_TAP_REQUIRED]: '1', [ENV_TAP_TOKEN_BUDGET]: 'lots' },
        ENV_TAP_TOKEN_BUDGET,
        'an unparseable budget is rejected, not ignored',
      );
      await throwsWith(
        { [ENV_TAP_DIR]: tmp, [ENV_TAP_PID]: '7013', [ENV_TAP_REQUIRED]: '1', CORTEX_TAP_BUDGET_ACTION: 'explode' },
        'CORTEX_TAP_BUDGET_ACTION',
        'an unknown budget action is rejected, not ignored',
      );
      assert(globalThis.fetch === before, 'and no half-installed tap is left behind');
    });

    await checkAsync('installTapFromEnv ignores malformed config when no tap was required', async () => {
      // Same inputs, no CORTEX_TAP_REQUIRED: a typo in someone's .env must not
      // take down a production run. The pid is still unusable, so there is no
      // tap — but the failure is not an exception either.
      const uninstall = await installTapFromEnv({ [ENV_TAP_DIR]: tmp, [ENV_TAP_PID]: 'not-a-pid' });
      assert(uninstall === undefined, 'it declines quietly instead of throwing');
    });

    // --- readTapSpend: the other direction ------------------------------------
    //
    // The tap writes; something has to read. Without a reader the frames sit in
    // the log and every summary reports zero for a run that spent real money.

    await checkAsync('readTapSpend sums the frames a tap wrote', async () => {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            model: 'gpt-4o-mini',
            usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 8 } },
            choices: [{ message: { content: 'x' } }],
          }),
          { status: 200 },
        )) as unknown as typeof globalThis.fetch;
      const uninstall = await tapFetch({ dir: tmp, pid: 7020 });
      await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' });
      await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' });
      await uninstall();

      const spend = await readTapSpend(tmp, 7020);
      // Two calls, not four: the `enter` frames carry no usage and must not be
      // counted, which is the mistake a naive "sum every llm_call frame" makes.
      assert(spend.calls === 2, `two calls, got ${spend.calls}`);
      assert(spend.inputTokens === 200, `200 in, got ${spend.inputTokens}`);
      assert(spend.outputTokens === 40, `40 out, got ${spend.outputTokens}`);
      assert(spend.cachedTokens === 16, `16 cached, got ${spend.cachedTokens}`);
      assert(spend.usd > 0, 'and a non-zero price');
    });

    await checkAsync("a tapped call is recorded in the ABI's shape", async () => {
      // ABI.md §4.3: the result of an `llm_call` is an `LLMResponse`, and its
      // usage lives under `usage`. The tap wrote it flat — so every reader
      // that follows the ABI (the dashboard's event table, the trace view)
      // saw a tapped call with a model and nothing else, while the same
      // frames read by `readTapSpend` had the tokens and the price. One
      // call, two answers.
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            model: 'gpt-4o-mini',
            usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 8 } },
            choices: [{ message: { content: 'x' } }],
          }),
          { status: 200 },
        )) as unknown as typeof globalThis.fetch;
      const uninstall = await tapFetch({ dir: tmp, pid: 7022 });
      await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' });
      await uninstall();

      const frames = await readTap(tmp, 7022);
      const exit = frames.find((f) => f.phase === 'exit');
      assert(exit !== undefined, 'the call was recorded');
      const result = exit!.result as
        | { usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; usd?: number } }
        | undefined;
      assert(result?.usage !== undefined, "the frame carries the ABI's usage");
      assert(result?.usage?.inputTokens === 100, `100 in, got ${String(result?.usage?.inputTokens)}`);
      assert(result?.usage?.outputTokens === 20, `20 out, got ${String(result?.usage?.outputTokens)}`);
      assert(result?.usage?.cachedTokens === 8, `8 cached, got ${String(result?.usage?.cachedTokens)}`);
      assert((result?.usage?.usd ?? 0) > 0, 'and a price');
    });

    await checkAsync('readTapSpend still adds up a log written before the ABI shape', async () => {
      // The `.crec` format is frozen, and a log written by an older build is
      // still on disk with its usage flat. The reader has to take both
      // shapes, or every log already on a disk stops adding up.
      const rec = await Recorder.open({ pid: asProcessId(7023), dir: join(tmp, 'processes', '7023') });
      await rec.append({
        timestamp: '2026-09-28T00:00:02.000Z' as never,
        pid: asProcessId(7023),
        syscall: 'llm_call',
        callId: 'old-1',
        phase: 'exit',
        stateBefore: 'running',
        stateAfter: 'running',
        reversibility: 'reversible',
        kernelAbiVersion: KERNEL_ABI_VERSION,
        result: { model: 'gpt-4o-mini', inputTokens: 100, outputTokens: 20, cachedTokens: 5, usd: 0.000026625 },
      });
      await rec.close();

      const spend = await readTapSpend(tmp, 7023);
      assert(spend.calls === 1, `one call, got ${spend.calls}`);
      assert(spend.inputTokens === 100, `100 in, got ${spend.inputTokens}`);
      assert(spend.outputTokens === 20, `20 out, got ${spend.outputTokens}`);
      assert(spend.cachedTokens === 5, `5 cached, got ${spend.cachedTokens}`);
      assert(spend.usd > 0, 'and a price');
    });

    await checkAsync('readTapSpend counts a failed call separately and still bills it', async () => {
      globalThis.fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof globalThis.fetch;
      const uninstall = await tapFetch({ dir: tmp, pid: 7021 });
      await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' });
      await uninstall();
      const spend = await readTapSpend(tmp, 7021);
      // A 500 is not a success, but the provider charged for it. Reporting it
      // as neither success nor cost would make the failure free.
      assert(spend.calls === 0, `no completed calls, got ${spend.calls}`);
      assert(spend.failedCalls === 1, `one failed call, got ${spend.failedCalls}`);
    });

    await checkAsync('readTapSpend returns zeros for a pid with no log', async () => {
      // A summary line that throws because a log is missing is worse than one
      // that honestly says zero.
      const spend = await readTapSpend(tmp, 7099);
      assert(spend.calls === 0 && spend.inputTokens === 0, 'zeros, not an exception');
    });
  } finally {
    await __resetLLMTapForTests();
    globalThis.fetch = realFetch;
    await rm(tmp, { recursive: true, force: true });
  }
}

// =============================================================================
// cortex wrap checks — an unmodified command under kernel supervision
// =============================================================================

async function runWrapChecks(): Promise<void> {
  const { mkdtemp, rm, readFile, writeFile } = await import('node:fs/promises');
  const { existsSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { cmdWrap, attemptFinished, wrapOutcome } = await import('../src/cli/commands/wrap.js');
  const { readMeta } = await import('../src/cli/process_store.js');
  const { defaultKernelDir } = await import('../src/index.js');
  const { asProcessId: asPid } = await import('../src/kernel/types.js');

  // `cortex wrap` resolves the state directory the same way every other
  // command does, so the test drives it through the environment rather than
  // an option. Each case gets a fresh directory; a leftover meta.json from a
  // previous run would make the assertions pass for the wrong reason.
  const tmp = await mkdtemp(join(tmpdir(), 'cortex-smoke-wrapall-'));
  const realHome = process.env['CORTEX_HOME'];
  try {
    // --- argument validation -------------------------------------------------
    await checkAsync('wrap refuses to run without --role', async () => {
      const home = await mkdtemp(join(tmpdir(), 'cortex-smoke-wrap-'));
      process.env['CORTEX_HOME'] = home;
      const code = await cmdWrap(['--', 'echo', 'hi']);
      assert(code === 1, `expected exit 1, got ${code}`);
      await rm(home, { recursive: true, force: true });
    });

    await checkAsync('wrap refuses to run without a command after --', async () => {
      const home = await mkdtemp(join(tmpdir(), 'cortex-smoke-wrap-'));
      process.env['CORTEX_HOME'] = home;
      const code = await cmdWrap(['--role', 'demo']);
      assert(code === 1, `expected exit 1, got ${code}`);
      await rm(home, { recursive: true, force: true });
    });

    await checkAsync('wrap rejects an unknown --restart instead of defaulting to never', async () => {
      const home = await mkdtemp(join(tmpdir(), 'cortex-smoke-wrap-'));
      process.env['CORTEX_HOME'] = home;
      // A typo must not silently disable supervision; that is the one failure
      // mode where the command looks like it worked.
      const code = await cmdWrap(['--role', 'demo', '--restart', 'on-falure', '--', 'echo', 'hi']);
      assert(code === 1, `expected exit 1, got ${code}`);
      await rm(home, { recursive: true, force: true });
    });

    await checkAsync('wrap rejects --tap-token-budget without --tap', async () => {
      const home = await mkdtemp(join(tmpdir(), 'cortex-smoke-wrap-'));
      process.env['CORTEX_HOME'] = home;
      // A ceiling on a tap that was never requested is a no-op the user
      // believes in. Better to say so than to run without the budget they
      // asked for.
      const code = await cmdWrap(['--role', 'demo', '--tap-token-budget', '1000', '--', 'echo', 'hi']);
      assert(code === 1, `expected exit 1, got ${code}`);
      await rm(home, { recursive: true, force: true });
    });

    await checkAsync('wrap rejects a non-numeric --tap-token-budget', async () => {
      const home = await mkdtemp(join(tmpdir(), 'cortex-smoke-wrap-'));
      process.env['CORTEX_HOME'] = home;
      const code = await cmdWrap(['--role', 'demo', '--tap', '--tap-token-budget', 'many', '--', 'echo', 'hi']);
      assert(code === 1, `expected exit 1, got ${code}`);
      await rm(home, { recursive: true, force: true });
    });

    await checkAsync('wrap --tap tells the user the one line their project is missing', async () => {
      const home = await mkdtemp(join(tmpdir(), 'cortex-smoke-wrap-'));
      process.env['CORTEX_HOME'] = home;
      // The env-var channel is a cooperation channel, not magic: the child has
      // to import and call installTapFromEnv(). If the user never learns that,
      // `--tap` silently records nothing. So the reminder is part of the
      // feature, and the run must still succeed meanwhile.
      //
      // The reminder goes to stdout, not stderr: it is guidance for a run that
      // is working, not a diagnostic about one that is not.
      const lines: string[] = [];
      const realLog = console.log;
      console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
      try {
        const code = await cmdWrap([
          '--role',
          'demo',
          '--tap',
          '--',
          process.execPath,
          '-e',
          'process.exit(0)',
        ]);
        assert(code === 0, `the run still succeeds, got ${code}`);
      } finally {
        console.log = realLog;
      }
      const said = lines.join('\n');
      assert(said.includes('installTapFromEnv'), `the child is told what to import: ${said}`);
      await rm(home, { recursive: true, force: true });
    });

    // --- the real thing ------------------------------------------------------
    await checkAsync('wrap runs an unmodified command and reports its exit code', async () => {
      const home = await mkdtemp(join(tmpdir(), 'cortex-smoke-wrap-'));
      process.env['CORTEX_HOME'] = home;
      const code = await cmdWrap([
        '--role',
        'demo',
        '--',
        process.execPath,
        '-e',
        'console.log("wrapped hello"); process.exit(0)',
      ]);
      assert(code === 0, `expected 0, got ${code}`);

      // The run must be visible to `cortex ps` afterwards, which is the whole
      // point: a project that never heard of cortex now has a PID and a log.
      // Look the process up by its meta.json rather than by counting
      // directories — init (PID 1) has one too, and a test that asserted a
      // count would break the day init started persisting its own metadata.
      const procsDir = join(home, 'processes');
      const withMeta = existsSync(procsDir)
        ? (readdirSync(procsDir) as string[]).filter((d) => existsSync(join(procsDir, d, 'meta.json')))
        : [];
      assert(withMeta.length === 1, `expected one persisted process, got ${withMeta.length}`);
      const pid = Number(withMeta[0]) as never;
      const meta = readMeta(home, pid);
      assert(meta !== undefined, 'meta.json is readable back');
      assert(meta.role === 'demo', `role recorded, got ${meta.role}`);
      assert(meta.exitCode === 0, `exit code recorded, got ${String(meta.exitCode)}`);
      assert(
        meta.agent.module !== undefined && String(meta.agent.module).includes('wrap_agent'),
        'meta records the wrapper module, so restore knows what to re-run',
      );
      // And the syscall log must exist, or `cortex trace` has nothing to show.
      assert(existsSync(join(procsDir, String(pid), 'log.crec')), 'a .crec was written for the run');
      await rm(home, { recursive: true, force: true });
    });

    await checkAsync('wrap propagates a non-zero exit code to the caller', async () => {
      const home = await mkdtemp(join(tmpdir(), 'cortex-smoke-wrap-'));
      process.env['CORTEX_HOME'] = home;
      const code = await cmdWrap(['--role', 'failing', '--', process.execPath, '-e', 'process.exit(42)']);
      // A supervisor that reported success for a failed run would be worse
      // than useless in CI.
      assert(code === 42, `expected 42, got ${code}`);
      await rm(home, { recursive: true, force: true });
    });

    await checkAsync('--restart on-failure actually retries the command', async () => {
      const home = await mkdtemp(join(tmpdir(), 'cortex-smoke-wrap-'));
      process.env['CORTEX_HOME'] = home;
      // This flag used to be accepted, stored on the process entry, and read by
      // nobody: the whole restart mechanism lives in InitProcess behind
      // `registerDaemon`, so `kernel.spawn({ restart })` configured nothing. The
      // command ran exactly once. A test that only checked "the flag parses"
      // would never have caught it, which is why the count is checked here.
      const counter = join(home, 'attempts.txt');
      const childFile = join(home, 'child.mjs');
      // A file rather than `node -e`: `-e` refuses top-level await under ESM,
      // and the tap install is exactly that.
      await writeFile(
        childFile,
        [
          "import fs from 'node:fs';",
          `const p = ${JSON.stringify(counter)};`,
          'let n = 0;',
          "try { n = fs.readFileSync(p, 'utf8').length; } catch {}",
          "fs.appendFileSync(p, 'x');",
          'process.exit(n === 0 ? 1 : 0);',
        ].join('\n'),
        'utf8',
      );

      const realLog = console.log;
      console.log = () => undefined;
      let code = 0;
      try {
        code = await cmdWrap([
          '--role',
          'flaky',
          '--restart',
          'on-failure',
          '--max-restarts',
          '3',
          '--timeout',
          '15000',
          '--',
          process.execPath,
          childFile,
        ]);
      } finally {
        console.log = realLog;
      }
      assert(code === 0, `the second attempt succeeded, got ${code}`);

      const attempts = existsSync(counter) ? (await readFile(counter, 'utf8')).length : 0;
      assert(attempts === 2, `the command ran twice (fail then succeed), got ${attempts}`);

      // Each attempt is a fresh process with its own directory, so the retries
      // are individually auditable rather than one merged blob.
      const procsDir = join(home, 'processes');
      const logged = existsSync(procsDir)
        ? (readdirSync(procsDir) as string[]).filter((d) => existsSync(join(procsDir, d, 'log.crec')))
        : [];
      assert(logged.length >= 2, `each attempt kept its own log, got ${logged.length}`);
      await rm(home, { recursive: true, force: true });
    });

    await checkAsync('--restart never leaves a failing command running forever', async () => {
      const home = await mkdtemp(join(tmpdir(), 'cortex-smoke-wrap-'));
      process.env['CORTEX_HOME'] = home;
      const counter = join(home, 'attempts.txt');
      const childFile = join(home, 'always-fails.mjs');
      await writeFile(
        childFile,
        [
          "import fs from 'node:fs';",
          `const p = ${JSON.stringify(counter)};`,
          "fs.appendFileSync(p, 'x');",
          'process.exit(3);',
        ].join('\n'),
        'utf8',
      );
      const realLog = console.log;
      console.log = () => undefined;
      let code = 0;
      try {
        code = await cmdWrap([
          '--role',
          'doomed',
          '--restart',
          'on-failure',
          '--max-restarts',
          '2',
          '--timeout',
          '20000',
          '--',
          process.execPath,
          childFile,
        ]);
      } finally {
        console.log = realLog;
      }
      assert(code === 3, `the command's own failure code comes back, got ${code}`);
      // The name says "restarts" but the implemented cap is on *runs*: init
      // gives up when `restartCount >= maxRestarts`, and `restartCount` is
      // incremented at the moment the restart is decided, so `maxRestarts: 2`
      // yields two runs and one restart. Renaming the field or changing the
      // arithmetic would break the frozen 1.0 ABI, so the behaviour stands and
      // is documented instead. The daemon smoke check ("maxRestarts caps total
      // restarts") pins the same rule from the other side.
      const attempts = existsSync(counter) ? (await readFile(counter, 'utf8')).length : 0;
      assert(attempts === 2, `the cap is two runs, got ${attempts}`);
      await rm(home, { recursive: true, force: true });
    });

    // The tapped run's record outlives the check that produced it: the next
    // one reads the same money back through `cortex limit`.
    let tapHome = '';

    await checkAsync('the tap spend is folded back into the recorded budgets', async () => {      const home = await mkdtemp(join(tmpdir(), 'cortex-smoke-wrap-'));
      // The record outlives this check: the next one reads the same money
      // back through `cortex limit`.
      tapHome = home;
      process.env['CORTEX_HOME'] = home;
      // The child's LLM calls never went through the dispatcher, so the
      // kernel's own counters read zero for a run that spent real tokens. If
      // they are not read back off the log, `meta.json` persists zeros and
      // every read-only view — `cortex ps`, the dashboard, `cortex audit` —
      // reports a spending run as free. A number that looks measured but is
      // not is worse than no number at all.
      const { createServer } = await import('node:http');
      const server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              model: 'gpt-4o-mini',
              usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 5 } },
              choices: [{ message: { content: 'ok' } }],
            }),
          );
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as { port: number }).port;

      // The child installs the tap the way `cortex wrap --tap` tells it to, and
      // makes two calls. Written as a real module import so the env channel is
      // exercised end to end rather than stubbed.
      const tapModule = new URL('../src/integrations/llm_tap.ts', import.meta.url).href;
      const child = [
        `const { installTapFromEnv } = await import(${JSON.stringify(tapModule)});`,
        'const uninstall = await installTapFromEnv();',
        'const call = () => fetch("http://127.0.0.1:' + port + '/v1/chat/completions", {',
        '  method: "POST", headers: { "content-type": "application/json" },',
        '  body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "q" }] }),',
        '}).then((r) => r.json());',
        'await call();',
        'await call();',
        'await uninstall();',
      ].join('\n');

      let wrapOut = '';
      const prevLog = console.log;
      console.log = (...parts: unknown[]): void => {
        wrapOut += parts.map((p) => String(p)).join(' ') + '\n';
      };
      let code: number;
      try {
        code = await cmdWrap([
          '--role',
          'tapped',
          '--tap',
          '--',
          process.execPath,
          '--import',
          'tsx',
          '-e',
          child,
        ]);
      } finally {
        console.log = prevLog;
      }
      server.close();
      assert(code === 0, `the child should succeed, got ${code}`);

      const pid = asPid(2);
      const spend = await readTapSpend(home, pid);
      assert(spend.calls === 2, `two completed calls, got ${spend.calls}`);
      assert(spend.inputTokens === 200, `200 in, got ${spend.inputTokens}`);
      assert(spend.outputTokens === 40, `40 out, got ${spend.outputTokens}`);
      assert(spend.cachedTokens === 10, `10 cached, got ${spend.cachedTokens}`);
      assert(spend.failedCalls === 0, 'no failures');

      // The summary line the operator reads is in **dollars**, like the tap's
      // own price. It used to print the budget's counter, which is
      // microdollars — the same number in a millionth of the size.
      const tapLine = wrapOut.split('\n').find((l) => l.startsWith('tap:')) ?? '';
      assert(tapLine !== '', `the tap summary line is printed, got: ${wrapOut}`);
      assert(
        tapLine.includes(`$${spend.usd.toFixed(6)}`),
        `the summary line is in dollars, got "${tapLine}" for ${spend.usd} dollars`,
      );

      // And the same numbers must be what a read-only view reports, or the
      // summary line and `cortex ps` would disagree with `cortex trace`.
      const meta = readMeta(home, pid);
      assert(meta !== undefined, 'meta.json was written');
      assert(meta.budgetsSpent.tokensIn === 200, `meta tokensIn, got ${meta.budgetsSpent.tokensIn}`);
      assert(meta.budgetsSpent.tokensOut === 40, `meta tokensOut, got ${meta.budgetsSpent.tokensOut}`);
      // The budget counts **microdollars** — an integer, 1 USD = 1_000_000
      // (docs/STATE.md §2.4). The tap prices its calls in *dollars*, and the
      // fold used to add the two together without converting: `meta.json`
      // ended up holding 0.00005325 (dollars) in a field that means 53
      // (microdollars), so every other view — `cortex top`, `cortex limit` —
      // read a run that had spent money as a run that had spent nothing.
      assert(
        meta.budgetsSpent.usdSpent === Math.round(spend.usd * 1_000_000),
        `meta usdSpent is in microdollars, got ${meta.budgetsSpent.usdSpent} for ${spend.usd} dollars`,
      );
      assert(
        Number.isInteger(meta.budgetsSpent.usdSpent),
        `the counter stays an integer, got ${meta.budgetsSpent.usdSpent}`,
      );
      // The record outlives this check: the next one reads the same money
      // back through `cortex limit`.
    });

    await checkAsync('a tapped run reports the money it spent', async () => {
      // The last mile. `meta.json` holds the spend in microdollars; `cortex
      // limit` is what an operator actually types. If the two units drift
      // apart, the run looks free — a $0.000053 spend reads as $0.000000,
      // and a budget that should have stopped it looks untouched.
      assert(tapHome !== '', 'the tapped run left a record to read');
      process.env['CORTEX_HOME'] = tapHome;
      const meta = readMeta(tapHome, asPid(2));
      assert(meta !== undefined, 'meta.json was written');
      const expected = `$${(meta.budgetsSpent.usdSpent / 1_000_000).toFixed(6)}`;
      assert(expected !== '$0.000000', 'the run is not free');

      let out = '';
      const prevLog = console.log;
      console.log = (...parts: unknown[]): void => {
        out += parts.map((p) => String(p)).join(' ') + '\n';
      };
      try {
        await cmdLimit([String(asPid(2))]);
      } finally {
        console.log = prevLog;
      }
      assert(out.includes(expected), `cortex limit shows ${expected}, got: ${out}`);
    });

    await checkAsync('the dashboard shows what a tapped call cost', async () => {
      // The same frames, read by the operator's window. A tapped call used
      // to show its model and nothing else — no tokens, no cost — because
      // the tap wrote its usage in a shape the ABI-shaped readers did not
      // look in. The summary line knew what it cost; the window did not.
      assert(tapHome !== '', 'the tapped run left a record to read');
      const dash = await startDashboard({ dir: tapHome, port: 0 });
      try {
        const res = await fetch(`${dash.url}/api/events?limit=50`);
        const events = (await res.json()) as Array<Record<string, unknown>>;
        // The event table is a per-call feed: two calls, two events.
        const calls = events.filter((e) => e['type'] === 'llm.call');
        assert(calls.length === 2, `two tapped calls in the event table, got ${calls.length}`);
        const tokensIn = calls.reduce((n, e) => n + Number(e['tokensIn'] ?? 0), 0);
        const tokensOut = calls.reduce((n, e) => n + Number(e['tokensOut'] ?? 0), 0);
        const usd = calls.reduce((n, e) => n + Number(e['usd'] ?? 0), 0);
        assert(tokensIn === 200, `200 in, got ${tokensIn}`);
        assert(tokensOut === 40, `40 out, got ${tokensOut}`);
        assert(usd > 0, `and a price, got ${usd}`);
        // And every one of them carries its own numbers — a call with a model
        // and nothing else is the bug.
        assert(calls.every((e) => e['tokensIn'] !== undefined && e['usd'] !== undefined), 'each call shows its own usage');
      } finally {
        await dash.close();
      }
      await rm(tapHome, { recursive: true, force: true });
    });

    await checkAsync('a cancelled run still leaves its token spend on record', async () => {
      const home = await mkdtemp(join(tmpdir(), 'cortex-smoke-wrap-'));
      process.env['CORTEX_HOME'] = home;
      // The question you actually have when something hangs and you kill it is
      // "what did that cost before it died". The frames are already on disk by
      // the time the child is stopped, so the answer is available — but only if
      // the summary is read back off the log rather than from a counter the
      // wrapper kept (it kept none; the child made the calls).
      const { createServer } = await import('node:http');
      const server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              model: 'gpt-4o-mini',
              usage: { prompt_tokens: 100, completion_tokens: 20 },
              choices: [{ message: { content: 'ok' } }],
            }),
          );
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as { port: number }).port;

      const tapModule = new URL('../src/integrations/llm_tap.ts', import.meta.url).href;
      const child = [
        `const { installTapFromEnv } = await import(${JSON.stringify(tapModule)});`,
        'const uninstall = await installTapFromEnv();',
        'const call = () => fetch("http://127.0.0.1:' + port + '/v1/chat/completions", {',
        '  method: "POST", headers: { "content-type": "application/json" },',
        '  body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "q" }] }),',
        '}).then((r) => r.json());',
        'await call();',
        'await uninstall();',
        // Stay alive so --timeout is what ends this run, rather than Node
        // exiting on an unsettled await all by itself.
        'setInterval(() => {}, 1000);',
      ].join('\n');

      const realLog = console.log;
      const realError = console.error;
      console.log = () => undefined;
      console.error = () => undefined;
      let code = 0;
      try {
        code = await cmdWrap([
          '--role',
          'cancelled',
          '--tap',
          '--timeout',
          '900',
          '--kill-grace-ms',
          '200',
          '--',
          process.execPath,
          '--import',
          'tsx',
          '-e',
          child,
        ]);
      } finally {
        console.log = realLog;
        console.error = realError;
        server.close();
      }
      assert(code === 137, `the run was killed, so 137 — got ${code}`);

      const meta = readMeta(home, asPid(2));
      assert(meta !== undefined, 'meta.json was written even for a killed run');
      assert(String(meta.exitReason).includes('timed out'), `reason records the timeout, got ${meta.exitReason}`);
      // The run was killed, so the record says so — with the code the command
      // returned, and the state the process is really in. The kernel only saw
      // a signal, and its own account of the wrapper process ("exited 1
      // (cancelled)") is not what an operator needs to read afterwards.
      assert(meta.exitCode === 137, `the record says the run exited ${String(meta.exitCode)}, expected 137`);
      assert(meta.state === 'zombie', `the record says the process is ${meta.state}`);
      assert(
        meta.budgetsSpent.tokensIn === 100 && meta.budgetsSpent.tokensOut === 20,
        `the spend before the kill survives it: ${meta.budgetsSpent.tokensIn}/${meta.budgetsSpent.tokensOut}`,
      );
      await rm(home, { recursive: true, force: true });
    });

    await checkAsync('wrap reports 127 and says so when the command does not exist', async () => {
      // Run it a few times: the failure this pins was a race, and a race
      // that only shows up under load is exactly the kind that survives a
      // test suite and shows up in somebody's CI.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const home = await mkdtemp(join(tmpdir(), 'cortex-smoke-wrap-'));
        process.env['CORTEX_HOME'] = home;
        const realErr = console.error;
        const lines: string[] = [];
        console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
        let code = 0;
        try {
          code = await cmdWrap(['--role', 'missing', '--', 'cortex-no-such-binary-xyz']);
        } finally {
          console.error = realErr;
        }
        assert(
          code === 127,
          `expected 127, got ${code}; the wrapper said: ${lines.join(' | ') || '(nothing)'}`,
        );
        assert(
          lines.join('\n').includes('command not found'),
          `the user is told why, got: ${lines.join(' | ')}`,
        );
        await rm(home, { recursive: true, force: true });
      }
    });

    await checkAsync('the wrapper waits for an ending it can trust', async () => {
      // EXITING is not an ending. The kernel records the exit code *after*
      // the process gets there — two disk writes sit between the two — and
      // the wrapper used to read that window as "no code" and default it to
      // zero. So a command that failed with 127 was sometimes reported as a
      // successful run, which is the one thing a wrapper must never do.
      assert(attemptFinished('exiting') === false, 'a process that is exiting has not finished');
      assert(attemptFinished('zombie') === true, 'a zombie has finished');
      assert(attemptFinished('suspended') === true, 'a suspended attempt has finished');
      assert(attemptFinished(undefined) === true, 'a reaped attempt has finished');
      assert(attemptFinished('running') === false, 'a running attempt has not finished');

      // And the outcome never invents a success.
      const exiting = wrapOutcome({ state: 'exiting', exitCode: null, exitReason: null }, undefined);
      assert(
        exiting.exitCode !== 0,
        `an exit code that was never seen must not be reported as success, got ${exiting.exitCode}`,
      );
      assert(
        exiting.exitCode === null,
        `an exit code that was never seen stays unknown, got ${exiting.exitCode}`,
      );
      const reapedUnknown = wrapOutcome(undefined, undefined);
      assert(
        reapedUnknown.exitCode !== 0,
        `an unknown ending must not be reported as success, got ${reapedUnknown.exitCode}`,
      );

      // A code that *was* seen is reported as it is.
      const zombie = wrapOutcome({ state: 'zombie', exitCode: 127, exitReason: 'x' }, undefined);
      assert(zombie.exitCode === 127, `a known exit code is reported as it is, got ${zombie.exitCode}`);
      const reaped = wrapOutcome(undefined, { code: 5, reason: 'y' });
      assert(reaped.exitCode === 5, `a reaped process reports its exit record, got ${reaped.exitCode}`);
    });

    await checkAsync('wrap stops a long-running command at the timeout instead of leaking it', async () => {
      const home = await mkdtemp(join(tmpdir(), 'cortex-smoke-wrap-'));
      process.env['CORTEX_HOME'] = home;
      const marker = join(home, 'heartbeat.txt');
      const realLog = console.log;
      const realError = console.error;
      console.log = () => undefined;
      console.error = () => undefined;
      let code = 0;
      try {
        code = await cmdWrap([
          '--role',
          'longrun',
          '--timeout',
          '900',
          '--',
          process.execPath,
          '-e',
          `const fs=require('fs');setInterval(()=>{try{fs.appendFileSync(${JSON.stringify(marker)},'x')}catch{}},50)`,
        ]);
      } finally {
        console.log = realLog;
        console.error = realError;
      }
      // A run cortex killed is not a run that succeeded. This line used to
      // assert `code === 0` on the theory that stopping the child was "not a
      // failure" — which made `cortex wrap --timeout 60 -- pytest` exit 0 on a
      // hung suite. The heartbeat checks below are the point of this test; the
      // exit code is asserted here because it is the same fact seen from the
      // caller's side.
      assert(code === 137, `a killed run must report 128+SIGKILL, got ${code}`);
      const sizeAtExit = existsSync(marker) ? (await readFile(marker, 'utf8')).length : 0;
      assert(sizeAtExit > 0, 'the child actually ran, so this is a real test');
      // The decisive check: an orphaned child would keep writing here after
      // the CLI exited. A supervisor that leaks its child is not a supervisor.
      await new Promise((r) => setTimeout(r, 700));
      const sizeLater = existsSync(marker) ? (await readFile(marker, 'utf8')).length : 0;
      assert(sizeLater === sizeAtExit, `child kept running after exit: ${sizeAtExit} -> ${sizeLater}`);
      await rm(home, { recursive: true, force: true });
    });
  } finally {
    if (realHome === undefined) delete process.env['CORTEX_HOME'];
    else process.env['CORTEX_HOME'] = realHome;
    await rm(tmp, { recursive: true, force: true });
  }
}


// =============================================================================
// Dashboard server checks
// =============================================================================

type PageFn = (...args: unknown[]) => unknown;

/**
 * One of the dashboard page's own helpers, pulled out of the served asset
 * and evaluated. The page is one file of inline script; a check that wants
 * to exercise *it* has to take the code from the page, not from a copy
 * that can drift away from what ships.
 */
function pageFunction(
  html: string,
  name: 'esc' | 'fmtUsd' | 'eventLabel' | 'fmtLocal' | 'callSummary' | 'traceItem',
  deps?: Readonly<Record<string, PageFn>>,
): PageFn {
  const isConst = name === 'esc' || name === 'fmtUsd';
  const header = isConst ? `const ${name} = ` : `function ${name}(`;
  const at = html.indexOf(header);
  assert(at >= 0, `the page still defines ${name}`);
  let src: string;
  if (isConst) {
    const tail = /;\s*\n/.exec(html.slice(at));
    assert(tail !== null, `the page still defines ${name}`);
    src = html.slice(at, at + tail.index + 1);
  } else {
    const open = html.indexOf('{', at);
    let depth = 0;
    let close = -1;
    for (let i = open; i < html.length; i += 1) {
      if (html[i] === '{') depth += 1;
      else if (html[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    assert(close > open, `the page's ${name}() never closes`);
    src = html.slice(at, close + 1);
  }
  // A helper may need the page's other helpers — the timeline row needs `esc`
  // and `fmtUsd` — so they are handed to it the way the page hands them over.
  const names = Object.keys(deps ?? {});
  const values = names.map((key) => (deps as Record<string, PageFn>)[key]!);
  return new Function(...names, src + '\nreturn ' + name + ';')(...values) as PageFn;
}

/** Render one event row the way the dashboard page renders it. */
function renderDashboardEventRow(html: string, event: Record<string, unknown>): string {
  const esc = pageFunction(html, 'esc');
  const fmtUsd = pageFunction(html, 'fmtUsd');
  const eventLabel = pageFunction(html, 'eventLabel');
  const fmtLocal = pageFunction(html, 'fmtLocal');
  const at = html.indexOf('rows.map((event) => {');
  assert(at >= 0, 'the page still renders event rows');
  const open = html.indexOf('{', at);
  let depth = 0;
  let close = -1;
  for (let i = open; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    else if (html[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  assert(close > open, "the page's event row template never closes");
  const body = html.slice(open + 1, close);
  const callSummary = pageFunction(html, 'callSummary');
  const fn = new Function('event', 'esc', 'fmtUsd', 'eventLabel', 'fmtLocal', 'callSummary', body) as (
    e: Record<string, unknown>,
    escFn: PageFn,
    usdFn: PageFn,
    labelFn: PageFn,
    timeFn: PageFn,
    summaryFn: PageFn,
  ) => string;
  return fn(event, esc, fmtUsd, eventLabel, fmtLocal, callSummary);
}

/** Render one row of the dashboard's syscall timeline, the way the page does. */
function renderDashboardTraceRow(html: string, record: Record<string, unknown>): string {
  const esc = pageFunction(html, 'esc');
  const fmtUsd = pageFunction(html, 'fmtUsd');
  const callSummary = pageFunction(html, 'callSummary');
  // The row is a named function on the page (`traceItem`), so the check
  // exercises the page's own code rather than a copy of it. It asks the
  // page's own `callSummary` for the tokens, so the two views of a frame
  // cannot drift apart in the check either.
  const traceItem = pageFunction(html, 'traceItem', { esc, fmtUsd, callSummary });
  return String(traceItem(record));
}

async function runDashboardChecks(): Promise<void> {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const tmp = await mkdtemp(join(tmpdir(), 'cortex-smoke-dash-'));
  try {
    // Seed one real syscall log (enter + exit + tool exit) via the Recorder.
    const rec = await Recorder.open({ pid: asProcessId(2), dir: join(tmp, 'processes', '2') });
    const base = {
      pid: asProcessId(2),
      stateBefore: 'running' as const,
      stateAfter: 'running' as const,
      reversibility: 'reversible' as const,
      kernelAbiVersion: KERNEL_ABI_VERSION,
    };
    await rec.append({ ...base, timestamp: '2026-09-28T00:00:01.000Z', syscall: 'llm_call', callId: 'c1', phase: 'enter', args: {} });
    await rec.append({
      ...base,
      timestamp: '2026-09-28T00:00:02.000Z',
      syscall: 'llm_call',
      callId: 'c1',
      phase: 'exit',
      durationMs: 12,
      result: { text: 'hi', model: 'gpt-test', usage: { inputTokens: 7, outputTokens: 3, cachedTokens: 5, usd: 0.001 } },
    });
    // A trapped syscall whose error message leaks an API key: the dashboard
    // must surface a sanitized errorMessage, never the raw secret.
    await rec.append({
      ...base,
      timestamp: '2026-09-28T00:00:03.500Z',
      syscall: 'llm_call',
      callId: 'c3',
      phase: 'trap',
      error: { errno: 'EHTTP', message: 'auth failed for key sk-livekey123456789' },
    });
    // A tool_call whose structured output carries a domain-specific audit
    // object: the dashboard must pass it through generically, without
    // hard-coding any of the domain's field names.
    await rec.append({
      ...base,
      timestamp: '2026-09-28T00:00:03.000Z',
      syscall: 'tool_call',
      callId: 'c2',
      phase: 'exit',
      result: { output: { structured: { audit: { correlation_id: 'abc', product_count: 3 } } } },
    });
    await rec.close();

    // Seed a persisted meta so the events scan finds the .crec, and a
    // LangChain callback event so both sources merge.
    writeMeta(tmp, {
      pid: 2, ppid: 1, pgid: 2, role: 'hello', state: 'zombie',
      exitCode: 0, exitReason: 'done',
      startedAt: '2026-09-28T00:00:00.000Z', lastTransitionAt: '2026-09-28T00:00:03.000Z',
      budgetsSpent: { tokensIn: 1, tokensOut: 1, tokensCached: 0, usdSpent: 3400, wallTimeMs: 10, syscallCount: 3 },
      budgetsRemaining: { tokens: -1, usd: -1, wallTimeMs: -1 },
      agent: { module: './agents/noop.js' } as ProcessMeta['agent'],
      kernelAbiVersion: KERNEL_ABI_VERSION,
    });
    await mkdir(join(tmp, 'integrations', 'langchain'), { recursive: true });
    await writeFile(
      join(tmp, 'integrations', 'langchain', 'events.jsonl'),
      `${JSON.stringify({ type: 'llm.end', at: '2026-09-28T00:00:04.000Z', runId: 'lc-1', name: 'ChatOpenAI', pid: 2, durationMs: 50 })}\n`,
      'utf8',
    );
    // Seed one checkpoint file named like the kernel writes them:
    // `<safeTimestamp>_<chainId>.csnap` under processes/<pid>/checkpoints/.
    await mkdir(join(tmp, 'processes', '2', 'checkpoints'), { recursive: true });
    await writeFile(join(tmp, 'processes', '2', 'checkpoints', '2026-09-28T00-00-05-000Z_550e8400-e29b-41d4-a716-446655440000.csnap'), 'CRTX-fake-snapshot-bytes');

    const dash = await startDashboard({ dir: tmp, port: 0 });
    try {
      await checkAsync('dashboard /api/events merges .crec and LangChain events', async () => {
        const res = await fetch(`${dash.url}/api/events?limit=50`);
        assert(res.status === 200, `status ${res.status}`);
        const events = (await res.json()) as Array<Record<string, unknown>>;
        assert(events.some((e) => e['type'] === 'llm.call'), 'syscall-derived llm.call present');
        assert(events.some((e) => e['type'] === 'llm.end'), 'LangChain llm.end present');
        assert(events.some((e) => e['type'] === 'tool.call'), 'tool.call present');
        const tool = events.find((e) => e['type'] === 'tool.call')!;
        const audit = tool['audit'] as Record<string, unknown> | undefined;
        assert(audit !== undefined && audit['correlation_id'] === 'abc', 'audit passed through generically');
        const raw = JSON.stringify(events);
        assert(!raw.includes('commercePid') && !raw.includes('evidenceCount'), 'no domain-specific field names leak');
        // LLM calls surface model + usage; trapped syscalls surface a
        // sanitized errorMessage with secrets stripped.
        const llm = events.find((e) => e['type'] === 'llm.call' && e['model'] !== undefined)!;
        assert(llm['model'] === 'gpt-test', `model surfaced, got ${String(llm['model'])}`);
        assert(llm['tokensIn'] === 7 && llm['tokensOut'] === 3 && llm['usd'] === 0.001, 'usage surfaced verbatim');
        const trapped = events.find((e) => e['error'] !== undefined);
        assert(trapped !== undefined && trapped['error'] === 'EHTTP', 'trap errno surfaced');
        assert(trapped['errorMessage'] === 'auth failed for key [REDACTED]', `sanitized errorMessage, got ${String(trapped['errorMessage'])}`);
        assert(!raw.includes('sk-livekey123456789'), 'raw secret never leaves the API');
      });

      await checkAsync('dashboard /api/trace/:pid returns the syscall timeline', async () => {
        const res = await fetch(`${dash.url}/api/trace/2`);
        assert(res.status === 200, `status ${res.status}`);
        const rows = (await res.json()) as Array<Record<string, unknown>>;
        assert(rows.length === 4, `expected 4 records, got ${rows.length}`);
        assert(rows[0]!['syscall'] === 'tool_call', 'newest first');
        const trap = rows.find((r) => r['phase'] === 'trap')!;
        assert(trap['errorMessage'] === 'auth failed for key [REDACTED]', `trace sanitizes secrets, got ${String(trap['errorMessage'])}`);
        const exit = rows.find((r) => r['phase'] === 'exit' && r['syscall'] === 'llm_call')!;
        assert(exit['model'] === 'gpt-test' && exit['tokensIn'] === 7, 'trace surfaces model and usage');
      });

      await checkAsync('the dashboard and cortex trace name a frame the same way', async () => {
        // The dashboard's timeline printed the **recorded** syscall name, so a
        // kernel frame read as the bare placeholder `__state` — while
        // `cortex trace` printed `__state:running->blocked(recv)` for the same
        // frame. Two views of one log, and the operator's window was the one
        // that said nothing at all.
        //
        // The cause was in the recording the whole time; the view dropped it.
        // Now both views ask the same function for the name.
        const rec = await Recorder.open({ pid: asProcessId(2), dir: join(tmp, 'processes', '2') });
        await rec.append({
          timestamp: '2026-09-28T00:00:05.000Z', pid: asProcessId(2), syscall: '__state',
          callId: 'named-1', phase: 'exit',
          args: { from: 'running', to: 'blocked', trigger: 'recv' },
          stateBefore: 'running', stateAfter: 'blocked', reversibility: 'idempotent',
          kernelAbiVersion: KERNEL_ABI_VERSION,
        });
        await rec.append({
          timestamp: '2026-09-28T00:00:05.100Z', pid: asProcessId(2), syscall: '__sched',
          callId: 'named-2', phase: 'exit',
          args: { action: 'sigxcpu', budgetKind: 'tokens' },
          stateBefore: 'running', stateAfter: 'stopped', reversibility: 'idempotent',
          kernelAbiVersion: KERNEL_ABI_VERSION,
        });
        await rec.flush();
        await rec.close();

        const res = await fetch(`${dash.url}/api/trace/2`);
        const rows = (await res.json()) as Array<Record<string, unknown>>;
        const state = rows.find((r) => r['callId'] === 'named-1')!;
        const sched = rows.find((r) => r['callId'] === 'named-2')!;
        assert(
          state['frame'] === '__state:running->blocked(recv)',
          `the dashboard names the transition: ${String(state['frame'])}`,
        );
        assert(
          sched['frame'] === '__sched:sigxcpu(tokens)',
          `the dashboard names the budget: ${String(sched['frame'])}`,
        );
        // The recorded name is still there, unchanged — the format is frozen.
        assert(state['syscall'] === '__state', `the recorded name is untouched: ${String(state['syscall'])}`);

        // ...and the CLI says the same thing about the same frame.
        const prevHome = process.env['CORTEX_HOME'];
        const prevLog = console.log;
        process.env['CORTEX_HOME'] = tmp;
        let out = '';
        console.log = (...parts: unknown[]): void => {
          out += parts.map((p) => String(p)).join(' ') + '\n';
        };
        try {
          await cmdTrace(['2']);
        } finally {
          console.log = prevLog;
          if (prevHome === undefined) delete process.env['CORTEX_HOME'];
          else process.env['CORTEX_HOME'] = prevHome;
        }
        assert(
          out.includes('__state:running->blocked(recv)'),
          `cortex trace names it the same way: ${out}`,
        );
        assert(
          out.includes('__sched:sigxcpu(tokens)'),
          `cortex trace names the budget the same way: ${out}`,
        );
      });

      await checkAsync('the dashboard page shows the frame, not the placeholder', async () => {
        // The page reads the named frame, so the window says what the
        // terminal says — and the check renders a row with the page's own
        // code, because a page that mentions the field is not a page that
        // shows it.
        const res = await fetch(`${dash.url}/`);
        const html = await res.text();
        assert(html.includes('record.frame'), 'the timeline reads the named frame');

        const row = renderDashboardTraceRow(html, {
          timestamp: '2026-09-28T00:00:05.000Z',
          syscall: '__state',
          frame: '__state:running->blocked(recv)',
          phase: 'exit',
        });
        // The page escapes what it renders, so the expectation is escaped the
        // same way — by the page's own escaper.
        const esc = pageFunction(html, 'esc') as (value: unknown) => string;
        assert(
          row.includes(esc('__state:running->blocked(recv)')),
          `the row shows the named frame, got: ${row}`,
        );
        assert(
          !row.includes('>__state<'),
          `the row does not show the bare placeholder, got: ${row}`,
        );
      });

      await checkAsync('the dashboard timeline says what a call spent', async () => {
        // The timeline read the usage with its own inline shape — and that
        // shape had no `cachedTokens` in it, so a call the provider served
        // out of its cache read as a call that was not. The server now reads
        // the frame with the same function the CLI's trace reads it with
        // (`callUsage`), and says what it found.
        const res = await fetch(`${dash.url}/api/trace/2`);
        const rows = (await res.json()) as Array<Record<string, unknown>>;
        const call = rows.find((r) => r['phase'] === 'exit' && r['syscall'] === 'llm_call');
        assert(call !== undefined, 'the call is in the timeline');
        assert(
          call!['tokensIn'] === 7 && call!['tokensOut'] === 3,
          `the tokens are surfaced, got: ${String(call!['tokensIn'])}`,
        );
        assert(
          call!['tokensCached'] === 5,
          `the cached part is surfaced, got: ${String(call!['tokensCached'])}`,
        );
        assert(call!['usd'] === 0.001, `the price is surfaced, got: ${String(call!['usd'])}`);
      });

      await checkAsync("the window's two views of a frame say the same thing", async () => {
        // The window has two views of the same frame — the event table and the
        // syscall timeline — and they used to disagree about it: the timeline
        // printed the tokens raw ("1200" beside the event table's "1,200"), it
        // had no cached part, it dropped the price the server had already sent
        // it, and it printed "0 out" for a call that never reported how many
        // tokens it wrote.
        const res = await fetch(`${dash.url}/`);
        const html = await res.text();
        const record = {
          timestamp: '2026-09-28T00:00:05.000Z',
          syscall: 'llm_call',
          frame: 'llm_call',
          phase: 'exit',
          durationMs: 12,
          model: 'gpt-test',
          tokensIn: 1200,
          tokensOut: 80,
          tokensCached: 900,
          usd: 0.001,
        };
        const timeline = renderDashboardTraceRow(html, record);
        const event = renderDashboardEventRow(html, record);
        // The expectation comes from the page's own helper, so the check holds
        // the two views to the *same words* — including the way a number is
        // written. The timeline used to print the tokens raw ("1200") beside
        // the event table's "1,200".
        const summary = String(pageFunction(html, 'callSummary')(record));
        assert(summary.includes('in /'), `the summary says what it read and wrote: ${summary}`);
        assert(summary.includes('(900 cached)'), `the summary says what was cached: ${summary}`);
        assert(timeline.includes(summary), `the timeline says it the same way: ${summary}`);
        assert(event.includes(summary), `the event row says it the same way: ${summary}`);
        // The price: the server has always sent it, and the timeline used to
        // drop it on the floor.
        assert(
          timeline.includes('$0.001000'),
          `the timeline says what it cost, got: ${timeline}`,
        );
        // And a counter the frame never reported is not a counter of zero.
        const partial = { ...record, tokensOut: undefined, tokensCached: undefined };
        const partialTimeline = renderDashboardTraceRow(html, partial);
        const partialSummary = String(pageFunction(html, 'callSummary')(partial));
        assert(
          partialTimeline.includes(partialSummary),
          `the timeline says what was reported, got: ${partialTimeline}`,
        );
        assert(
          !partialTimeline.includes('0 out'),
          `an unreported counter is not a zero: ${partialTimeline}`,
        );
        const partialEvent = renderDashboardEventRow(html, partial);
        assert(
          !partialEvent.includes('0 out'),
          `an unreported counter is not a zero: ${partialEvent}`,
        );
      });

      await checkAsync('dashboard trace for an unknown pid is 404', async () => {
        const res = await fetch(`${dash.url}/api/trace/999`);
        assert(res.status === 404, `status ${res.status}`);
      });

      await checkAsync('dashboard serves processes, rejects mutations', async () => {
        const res = await fetch(`${dash.url}/api/processes`);
        assert(res.status === 200, `GET status ${res.status}`);
        const metas = (await res.json()) as Array<Record<string, unknown>>;
        // The same view `cortex ps` shows: the recorded process, plus the
        // synthetic init that gives the tree a root.
        assert(metas.length === 2, `expected 2 rows, got ${metas.length}`);
        assert(metas.some((m) => m['role'] === 'hello'), 'persisted meta served');
        const post = await fetch(`${dash.url}/api/processes`, { method: 'POST' });
        assert(post.status === 405, `POST status ${post.status}`);
      });

      await checkAsync('the dashboard and cortex top say the same cost', async () => {
        // `budgetsSpent.usdSpent` is in **microdollars** — an integer count,
        // 1 USD = 1_000_000 (docs/STATE.md §2.4). The dashboard used to add
        // those numbers up and print them as dollars, so the process that had
        // spent $0.0034 was shown in the operator's window as having spent
        // **$3400.0000**: a thousand times the money, which is the kind of
        // number that gets a budget cut. Two views of one process's cost have
        // to be the same number.
        const prevHome = process.env['CORTEX_HOME'];
        process.env['CORTEX_HOME'] = tmp;
        try {
          const res = await fetch(`${dash.url}/api/processes`);
          const rows = (await res.json()) as Array<Record<string, unknown>>;
          const row = rows.find((r) => r['pid'] === 2);
          assert(row !== undefined, 'the process is in the list');

          const dollars = Number(row!['usdSpentDollars']);
          assert(
            Math.abs(dollars - 0.0034) < 1e-12,
            `the dashboard reports dollars, got ${dollars}`,
          );
          // The counter the kernel owns is untouched — still microdollars.
          const raw = (row!['budgetsSpent'] as Record<string, unknown> | undefined)?.['usdSpent'];
          assert(raw === 3400, `the raw counter stays in microdollars, got ${String(raw)}`);

          // ...and the CLI says the same thing about the same record.
          let out = '';
          const prevLog = console.log;
          console.log = (...parts: unknown[]): void => {
            out += parts.map((p) => String(p)).join(' ') + '\n';
          };
          try {
            await cmdTop([]);
          } finally {
            console.log = prevLog;
          }
          assert(out.includes('$0.003400'), `cortex top reports the same cost, got: ${out}`);
        } finally {
          if (prevHome === undefined) delete process.env['CORTEX_HOME'];
          else process.env['CORTEX_HOME'] = prevHome;
        }
      });

      await checkAsync('the dashboard page adds up dollars, not microdollars', async () => {
        // The page used to read `budgetsSpent.usdSpent` and add it up as if it
        // were dollars. The server converts once now and hands the page
        // dollars, so the page must not be doing the arithmetic on the raw
        // counter — that arithmetic is where the million-fold error lived.
        const res = await fetch(`${dash.url}/`);
        const html = await res.text();
        assert(html.includes('usdSpentDollars'), 'the page reads the dollar value');
        assert(!html.includes('spent.usdSpent'), 'the page never adds up the raw microdollars');
      });

      await checkAsync('the event row keeps the shape of the table', async () => {
        // The row template built the "Token / 模型" cell's tooltip with a
        // nested template literal — `title="${event.usd === undefined ? '' :
        // `$${…}`}"`. The stray quote made the HTML parser read the rest of
        // the row as that attribute's value: the browser showed six cells
        // where the header has seven, every cell after it was shifted a
        // column left, and the "Token / 模型" column showed the *time*.
        // The facts were on the page. They were not on the screen.
        const res = await fetch(`${dash.url}/`);
        const html = await res.text();

        // The header is the contract: one cell per column, in order.
        const tableAt = html.indexOf('<table class="event-table">');
        assert(tableAt >= 0, 'the event table is still there');
        const headRow = html.slice(tableAt, html.indexOf('</tr>', tableAt));
        const columns = (headRow.match(/<th\b/g) ?? []).length;
        assert(columns === 7, `the event table has seven columns, got ${columns}`);

        // Render one row with the page's own code.
        const row = renderDashboardEventRow(html, {
          type: 'llm.call',
          name: 'llm_call',
          pid: 2,
          durationMs: 34,
          model: 'gpt-4o-mini',
          tokensIn: 100,
          tokensOut: 20,
          usd: 0.000026625,
          at: '2026-10-24T11:19:05.171Z',
        });

        // Every tag closes its own quotes. A stray quote inside an attribute
        // is exactly what makes the HTML parser swallow the rest of the row.
        for (const tag of row.match(/<[^>]*>/g) ?? []) {
          const quotes = (tag.match(/"/g) ?? []).length;
          assert(quotes % 2 === 0, `every tag closes its own quotes: ${tag}`);
        }

        // One cell per column.
        const cells = (row.match(/<td\b/g) ?? []).length;
        assert(cells === columns, `the row has ${columns} cells, got ${cells}`);

        // And the fact the column exists for is on it: the tokens, the model,
        // the price.
        assert(row.includes('100 in / 20 out'), `the row shows its tokens, got: ${row}`);
        assert(row.includes('gpt-4o-mini'), `the row shows its model, got: ${row}`);
        assert(row.includes('$0.000027'), `the row shows its cost, got: ${row}`);
      });

      await checkAsync('the dashboard and the CLI print money the same way', async () => {
        // The page is a static file served over HTTP, so it cannot import
        // `formatDollars` — it keeps its own copy of the rule. Two copies of a
        // rule about money is one copy too many, so this check holds the two
        // to the same string.
        //
        // The rule is six decimals, because the kernel counts in microdollars
        // and one model call costs about $0.000027. The panel used to print
        // four: a run that had spent real money read as a run that had spent
        // nothing, while `cortex limit` and the event row said $0.000027.
        const res = await fetch(`${dash.url}/`);
        const html = await res.text();
        const fmtUsd = pageFunction(html, 'fmtUsd') as (usd: number) => string;
        for (const usd of [0, 0.000027, 0.0034, 12.345678]) {
          assert(
            fmtUsd(usd) === formatDollars(usd),
            `the page and the CLI say the same money: ${fmtUsd(usd)} vs ${formatDollars(usd)}`,
          );
        }
        // And a cost that was really spent never reads as nothing.
        assert(
          fmtUsd(0.000027) === '$0.000027',
          `a real cost is not rounded away, got ${fmtUsd(0.000027)}`,
        );
        // ...and the server still hands the page dollars, not microdollars.
        assert(usdToDollars(27) === 0.000027, 'the conversion is still the kernel\'s unit');
      });

      await checkAsync('dashboard serves the supervision tree and budget panels', async () => {
        const res = await fetch(`${dash.url}/`);
        assert(res.status === 200, `status ${res.status}`);
        const html = await res.text();
        assert(html.includes('processTreeWrap') && html.includes('viewTree'), 'supervision tree panel present');
        assert(html.includes('budgetRows') && html.includes('budgetsPanel'), 'budget rollup panel present');
        assert(html.includes('checkpointRows'), 'checkpoints panel present');
      });

      await checkAsync('dashboard /api/checkpoints lists seeded snapshots', async () => {
        const res = await fetch(`${dash.url}/api/checkpoints`);
        assert(res.status === 200, `status ${res.status}`);
        const list = (await res.json()) as Array<Record<string, unknown>>;
        assert(list.length === 1, `expected 1 checkpoint, got ${list.length}`);
        assert(list[0]!['pid'] === 2, 'pid parsed from directory');
        assert(list[0]!['chainId'] === '550e8400-e29b-41d4-a716-446655440000', 'chainId parsed from filename');
        assert(String(list[0]!['createdAt']) === '2026-09-28T00-00-05-000Z', 'createdAt parsed from filename');
        assert((list[0]!['sizeBytes'] as number) > 0, 'size from stat');
      });

      await checkAsync('dashboard ops are disabled by default', async () => {
        const meta = (await (await fetch(`${dash.url}/api/ops`)).json()) as { allowOps?: boolean };
        assert(meta.allowOps === false, 'allowOps defaults to false');
        const post = await fetch(`${dash.url}/api/ops/restore`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chain: '550e8400-e29b-41d4-a716-446655440000' }),
        });
        assert(post.status === 403, `status ${post.status}`);
      });

      await checkAsync('dashboard /api/events supports time filtering, offset, and total count', async () => {
        const all = await fetch(`${dash.url}/api/events?limit=50`);
        assert((all.headers.get('x-total-count') ?? '') === '4', `total header, got ${all.headers.get('x-total-count')}`);
        const win = await fetch(`${dash.url}/api/events?from=${encodeURIComponent('2026-09-28T00:00:03.000Z')}&limit=50`);
        const list = (await win.json()) as unknown[];
        assert(list.length === 3, `expected 3 events from 00:00:03, got ${list.length}`);
        const p1 = (await (await fetch(`${dash.url}/api/events?limit=1`)).json()) as Array<{ runId: string }>;
        const p2 = (await (await fetch(`${dash.url}/api/events?limit=1&offset=1`)).json()) as Array<{ runId: string }>;
        assert(p1.length === 1 && p2.length === 1 && p1[0]!.runId !== p2[0]!.runId, 'offset paginates distinct events');
      });

      await checkAsync('dashboard --allow-ops runs restore and surfaces CLI output', async () => {
        const opsDash = await startDashboard({ dir: tmp, port: 0, allowOps: true });
        try {
          const meta = (await (await fetch(`${opsDash.url}/api/ops`)).json()) as { allowOps?: boolean };
          assert(meta.allowOps === true, 'allowOps on');
          const res = await fetch(`${opsDash.url}/api/ops/restore`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chain: '550e8400-e29b-41d4-a716-446655440000' }),
          });
          assert(res.status === 200, `status ${res.status}`);
          const data = (await res.json()) as { ok?: boolean; output?: string };
          assert(data.ok === false, `fake snapshot must fail restore, got ok=${String(data.ok)}`);
          assert((data.output ?? '').length > 0, 'CLI output surfaced to the caller');
        } finally {
          await opsDash.close();
        }
      });

      await checkAsync('dashboard ops are fine-grained via allowOps list', async () => {
        const opsDash = await startDashboard({ dir: tmp, port: 0, allowOps: ['kill', 'spawn'] });
        try {
          const meta = (await (await fetch(`${opsDash.url}/api/ops`)).json()) as { allowOps?: boolean; ops?: string[] };
          assert(meta.allowOps === true, 'allowOps true when list non-empty');
          assert(
            Array.isArray(meta.ops) && meta.ops.includes('kill') && meta.ops.includes('spawn') && !meta.ops.includes('restore'),
            `ops list respected, got ${JSON.stringify(meta.ops)}`,
          );
          const post = await fetch(`${opsDash.url}/api/ops/restore`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chain: '550e8400-e29b-41d4-a716-446655440000' }),
          });
          assert(post.status === 403, `restore not in list must 403, got ${post.status}`);
        } finally {
          await opsDash.close();
        }
      });

      await checkAsync('dashboard kill marks a running process zombie via CLI semantics', async () => {
        writeMeta(tmp, {
          pid: 7, ppid: 1, pgid: 7, role: 'victim', state: 'running',
          exitCode: null, exitReason: null,
          startedAt: '2026-09-28T00:00:06.000Z', lastTransitionAt: '2026-09-28T00:00:06.000Z',
          budgetsSpent: { tokensIn: 0, tokensOut: 0, tokensCached: 0, usdSpent: 0, wallTimeMs: 5, syscallCount: 1 },
          budgetsRemaining: { tokens: -1, usd: -1, wallTimeMs: -1 },
          agent: { module: './agents/noop.js' } as ProcessMeta['agent'],
          kernelAbiVersion: KERNEL_ABI_VERSION,
        });
        const killDash = await startDashboard({ dir: tmp, port: 0, allowOps: ['kill'] });
        try {
          const res = await fetch(`${killDash.url}/api/ops/kill`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pid: 7 }),
          });
          assert(res.status === 200, `status ${res.status}`);
          const data = (await res.json()) as { ok?: boolean; output?: string };
          assert(data.ok === true, `kill must succeed, got ${JSON.stringify(data)}`);
          assert((data.output ?? '').includes('SIGTERM'), 'CLI output mentions SIGTERM');
          const meta = readMeta(tmp, asProcessId(7));
          assert(meta?.state === 'zombie', `meta state ${String(meta?.state)}`);
          assert(String(meta?.exitReason).includes('killed'), 'exitReason notes the kill');
        } finally {
          await killDash.close();
        }
      });

      await checkAsync('dashboard spawn runs a mock agent end-to-end', async () => {
        const spawnDash = await startDashboard({ dir: tmp, port: 0, allowOps: ['spawn'] });
        try {
          const bad = await fetch(`${spawnDash.url}/api/ops/spawn`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ task: 'no role given' }),
          });
          assert(bad.status === 400, `missing role must 400, got ${bad.status}`);
          const res = await fetch(`${spawnDash.url}/api/ops/spawn`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ role: 'greeter', task: 'greet briefly', driver: 'mock', timeoutMs: 15000 }),
          });
          assert(res.status === 200, `status ${res.status}`);
          const data = (await res.json()) as { ok?: boolean; output?: string };
          assert(data.ok === true, `spawn must succeed, got ${data.output ?? ''}`);
          assert(/\[pid \d+\]/.test(data.output ?? ''), 'output includes the pid line');
        } finally {
          await spawnDash.close();
        }
      });

      await checkAsync('dashboard /api/stream pushes initial snapshot and reacts to changes', async () => {
        const res = await fetch(`${dash.url}/api/stream?limit=10`);
        assert(res.ok, `status ${res.status}`);
        assert((res.headers.get('content-type') ?? '').includes('text/event-stream'), 'sse content-type');
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        const readChunk = async (ms: number): Promise<void> => {
          const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms));
          const chunk = await Promise.race([reader.read(), timeout]);
          if (chunk?.value !== undefined) buf += decoder.decode(chunk.value, { stream: true });
        };
        await readChunk(1500);
        assert(buf.includes('event: processes'), `initial push missing, got: ${buf.slice(0, 120)}`);
        // Touch the state directory: the watcher should trigger a fresh push.
        await writeFile(join(tmp, 'processes', '2', 'checkpoints', '2026-09-28T00-00-09-000Z_00000000-0000-4000-8000-000000000000.csnap'), 'x');
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline) {
          await readChunk(400);
          if ((buf.match(/event: processes/g) ?? []).length >= 2) break;
        }
        assert(
          (buf.match(/event: processes/g) ?? []).length >= 2,
          `watcher-driven push missing after change (received ${buf.length} bytes)`,
        );
        await reader.cancel().catch(() => {});
      });
    } finally {
      await dash.close();
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// =============================================================================
// Dashboard activity-store checks (#071)
// =============================================================================

/**
 * The activity feed is read once and then followed.
 *
 * It used to be rebuilt from the disk on every change: every `.crec` of every
 * process was read from byte 0, every frame decoded, and the newest few
 * kept. That is O(the whole history) per change, and the history of a
 * long-lived agent is the thing that grows — measured on a real directory, a
 * 3 MB log cost 154 ms per read and a 6 MB one cost 301 ms.
 *
 * So the feed follows the logs instead. The checks below pin three things:
 * the events it shows are the events the log holds, it does not read the same
 * bytes twice, and it does not keep a history the disk has erased.
 */
async function runDashboardStoreChecks(): Promise<void> {
  const { mkdtempSync, rmSync, existsSync, statSync, copyFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-dashstore-'));

  const base = {
    pid: asProcessId(2),
    stateBefore: 'running' as const,
    stateAfter: 'running' as const,
    reversibility: 'reversible' as const,
    kernelAbiVersion: KERNEL_ABI_VERSION,
  };

  /** Write one frame into a log under `root`, and return the recorder. */
  const writeFrame = async (
    root: string,
    syscall: string,
    callId: string,
    phase: 'enter' | 'exit' | 'trap',
    at: string,
    extra: Record<string, unknown> = {},
  ): Promise<Recorder> => {
    const dir = join(root, 'processes', '2');
    mkdirSync(dir, { recursive: true });
    const rec = await Recorder.open({ pid: asProcessId(2), dir });
    await rec.append({
      ...base,
      timestamp: at,
      syscall,
      callId,
      phase,
      ...(phase === 'enter' ? { args: {} } : {}),
      ...extra,
    } as never);
    return rec;
  };

  try {
    // --- the reference: what a full scan of the log says -------------------
    const fullScan = async (root: string): Promise<unknown[]> => {
      const events: unknown[] = [];
      for await (const record of readRecords(join(root, 'processes', '2', 'log.crec'))) {
        const event = toActivityEvent(record, 2);
        if (event !== undefined) events.push(event);
      }
      return events.sort((a, b) =>
        Date.parse(String((b as { at?: string }).at)) - Date.parse(String((a as { at?: string }).at)),
      );
    };

    await checkAsync('the activity feed shows the same events whether it was read all at once or followed', async () => {
      const root = join(tmp, 'same');
      const rec = await writeFrame(root, 'llm_call', 'c1', 'enter', '2026-09-28T00:00:01.000Z');
      await rec.append({
        ...base,
        timestamp: '2026-09-28T00:00:02.000Z',
        syscall: 'llm_call',
        callId: 'c1',
        phase: 'exit',
        durationMs: 12,
        result: { text: 'hi', model: 'gpt-test', usage: { inputTokens: 7, outputTokens: 3, cachedTokens: 0, usd: 0.001 } },
      } as never);
      await rec.append({
        ...base,
        timestamp: '2026-09-28T00:00:03.000Z',
        syscall: 'tool_call',
        callId: 'c2',
        phase: 'exit',
        result: { output: { structured: { audit: { correlation_id: 'abc' } } } },
      } as never);
      await rec.close();

      const store = new ActivityStore();
      await store.refresh(root);

      const followed = store.read({}).events;
      const scanned = await fullScan(root);
      assert(scanned.length > 0, 'the log holds events to show');
      assert(
        JSON.stringify(followed) === JSON.stringify(scanned),
        `the same events, followed=${JSON.stringify(followed)} scanned=${JSON.stringify(scanned)}`,
      );
    });

    await checkAsync('the activity feed does not read the same bytes twice', async () => {
      const root = join(tmp, 'bytes');
      const logPath = join(root, 'processes', '2', 'log.crec');
      const rec = await writeFrame(root, 'llm_call', 'c1', 'exit', '2026-09-28T00:00:02.000Z', {
        durationMs: 12,
        result: { text: 'hi' },
      });
      // A log worth reading twice: one frame is not a history.
      for (let i = 0; i < 40; i += 1) {
        await rec.append({
          ...base,
          timestamp: `2026-09-28T00:00:${String(3 + i).padStart(2, '0')}.000Z`,
          syscall: 'memory_read',
          callId: `m${i}`,
          phase: 'exit',
          durationMs: 1,
        } as never);
      }

      const store = new ActivityStore();
      await store.refresh(root);
      const afterFirst = store.bytesRead;
      const size = statSync(logPath).size;
      assert(afterFirst >= size, `the first read reads the whole log, got ${afterFirst} of ${size}`);

      // Nothing changed: the second read must not pay for the history again.
      await store.refresh(root);
      assert(
        store.bytesRead === afterFirst,
        `a second read with nothing new read ${store.bytesRead - afterFirst} bytes`,
      );

      // One more frame: the read must cost the frame, not the log.
      await rec.append({
        ...base,
        timestamp: '2026-09-28T00:01:00.000Z',
        syscall: 'llm_call',
        callId: 'c3',
        phase: 'exit',
        durationMs: 3,
      } as never);
      await store.refresh(root);
      const growth = store.bytesRead - afterFirst;
      assert(growth > 0, `the new frame was read, grew ${growth} bytes`);
      assert(growth < size / 2, `reading one frame cost ${growth} bytes of a ${size} byte log`);
      await rec.close();
    });

    await checkAsync('a frame written after the feed read the log shows up exactly once', async () => {
      const root = join(tmp, 'newframe');
      const rec = await writeFrame(root, 'llm_call', 'c1', 'exit', '2026-09-28T00:00:02.000Z');

      const store = new ActivityStore();
      await store.refresh(root);
      await rec.append({
        ...base,
        timestamp: '2026-09-28T00:00:05.000Z',
        syscall: 'llm_call',
        callId: 'c4',
        phase: 'exit',
        durationMs: 4,
      } as never);
      await store.refresh(root);

      const events = store.read({}).events as Array<{ runId?: string }>;
      const seen = events.filter((e) => e.runId === 'c4');
      assert(seen.length === 1, `the new frame is shown once, got ${seen.length}`);
      await rec.close();
    });

    await checkAsync('a log that was replaced does not leave the old history behind', async () => {
      const root = join(tmp, 'replaced');
      const rec = await writeFrame(root, 'llm_call', 'c1', 'exit', '2026-09-28T00:00:02.000Z');
      await rec.close();

      const store = new ActivityStore();
      await store.refresh(root);
      const before = store.read({}).events as Array<{ runId?: string }>;
      assert(before.length === 1 && before[0]!.runId === 'c1', 'the feed holds the old history');

      // A different log at the same path, with a frame the old one never had.
      // The feed has to show the new history, not both.
      const other = join(tmp, 'other');
      const otherRec = await writeFrame(other, 'memory_read', 'new-1', 'exit', '2026-09-28T01:00:00.000Z', {
        durationMs: 1,
      });
      await otherRec.close();
      copyFileSync(
        join(other, 'processes', '2', 'log.crec'),
        join(root, 'processes', '2', 'log.crec'),
      );

      await store.refresh(root);
      const after = store.read({}).events as Array<{ runId?: string }>;
      assert(
        after.length === 1 && after[0]!.runId === 'new-1',
        `only the new history is shown, got ${JSON.stringify(after.map((e) => e.runId))}`,
      );
    });

    await checkAsync('the dashboard does not re-read the logs it has already read', async () => {
      const root = join(tmp, 'dashboard');
      const rec = await writeFrame(root, 'llm_call', 'c1', 'exit', '2026-09-28T00:00:02.000Z', {
        durationMs: 12,
      });
      for (let i = 0; i < 40; i += 1) {
        await rec.append({
          ...base,
          timestamp: `2026-09-28T00:00:${String(3 + i).padStart(2, '0')}.000Z`,
          syscall: 'memory_read',
          callId: `m${i}`,
          phase: 'exit',
          durationMs: 1,
        } as never);
      }
      await rec.close();
      const size = statSync(join(root, 'processes', '2', 'log.crec')).size;

      const dash = await startDashboard({ dir: root, port: 0 });
      try {
        await fetch(`${dash.url}/api/events?limit=50`);
        const afterFirst = dash.activity.bytesRead;
        assert(afterFirst >= size, `the first request reads the log, got ${afterFirst} of ${size}`);

        await fetch(`${dash.url}/api/events?limit=50`);
        assert(
          dash.activity.bytesRead === afterFirst,
          `the second request re-read the log: ${dash.activity.bytesRead - afterFirst} bytes`,
        );
      } finally {
        await dash.close();
      }
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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

  await checkAsync("the trace names the kernel's own frames", async () => {
    // Every internal frame used to print as the same anonymous word, so a log
    // full of them said nothing at all: ten rows reading `__init` told an
    // operator that ten things happened and not what they were. That mattered
    // most for init's log, which is the supervision journal — the durable
    // record of every restart decision the kernel made.
    const { mkdtempSync, rmSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'cortex-trace-names-'));
    mkdirSync(join(tmp, 'processes'), { recursive: true });

    const prevHome = process.env['CORTEX_HOME'];
    const prevLog = console.log;
    const prevErr = console.error;
    try {
      const rec = await Recorder.open({ pid: asProcessId(2), dir: join(tmp, 'processes', '2') });
      await rec.append({
        timestamp: '2026-01-01T00:00:00.000Z', pid: asProcessId(2), syscall: '__init',
        callId: 'i1', phase: 'exit', args: { action: 'register-daemon', daemonId: 2 },
        stateBefore: 'running', stateAfter: 'running', reversibility: 'idempotent',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await rec.append({
        timestamp: '2026-01-01T00:00:01.000Z', pid: asProcessId(2), syscall: '__state',
        callId: 's1', phase: 'exit', args: { from: 'new', to: 'ready', trigger: 'spawn' },
        stateBefore: 'new', stateAfter: 'ready', reversibility: 'idempotent',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await rec.append({
        timestamp: '2026-01-01T00:00:02.000Z', pid: asProcessId(2), syscall: '__signal',
        callId: 'g1', phase: 'exit', args: { signal: 'SIGTERM', outcome: 'queued' },
        stateBefore: 'running', stateAfter: 'running', reversibility: 'idempotent',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await rec.flush();
      await rec.close();

      process.env['CORTEX_HOME'] = tmp;
      let out = '';
      console.log = (...parts: unknown[]): void => {
        out += parts.map((p) => String(p)).join(' ') + '\n';
      };
      console.error = (): void => {};
      try {
        const code = await cmdTrace(['2']);
        assert(code === 0, `trace exit 0, got ${code}`);
      } finally {
        console.log = prevLog;
        console.error = prevErr;
      }

      assert(
        out.includes('__init:register-daemon'),
        `the journal frame lost its action: ${out}`,
      );
      assert(out.includes('__state:new->ready'), `the transition was lost: ${out}`);
      assert(
        out.includes('__signal:SIGTERM(queued)'),
        `the signal lost its outcome: ${out}`,
      );
    } finally {
      if (prevHome === undefined) delete process.env['CORTEX_HOME'];
      else process.env['CORTEX_HOME'] = prevHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('the trace says why a process changed state', async () => {
    // A transition without a cause is a fact without an explanation. The log
    // said the process went from `running` to `blocked`, and not whether it
    // was waiting on a channel, on a timer, on a child, or on a signal — so
    // the reader had to guess from the transition pair. The cause was in the
    // frame the whole time (ABI.md §6.1); the view dropped it.
    const { mkdtempSync, rmSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'cortex-trace-cause-'));
    mkdirSync(join(tmp, 'processes'), { recursive: true });

    const prevHome = process.env['CORTEX_HOME'];
    const prevLog = console.log;
    const prevErr = console.error;
    try {
      const rec = await Recorder.open({ pid: asProcessId(2), dir: join(tmp, 'processes', '2') });
      await rec.append({
        timestamp: '2026-01-01T00:00:00.000Z', pid: asProcessId(2), syscall: '__state',
        callId: 's1', phase: 'exit',
        args: { from: 'running', to: 'blocked', trigger: 'recv' },
        stateBefore: 'running', stateAfter: 'blocked', reversibility: 'idempotent',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await rec.append({
        timestamp: '2026-01-01T00:00:01.000Z', pid: asProcessId(2), syscall: '__state',
        callId: 's2', phase: 'exit',
        args: { from: 'running', to: 'exiting', trigger: 'signal', signal: 'SIGTERM' },
        stateBefore: 'running', stateAfter: 'exiting', reversibility: 'idempotent',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await rec.flush();
      await rec.close();

      process.env['CORTEX_HOME'] = tmp;
      let out = '';
      console.log = (...parts: unknown[]): void => {
        out += parts.map((p) => String(p)).join(' ') + '\n';
      };
      console.error = (): void => {};
      try {
        const code = await cmdTrace(['2']);
        assert(code === 0, `trace exit 0, got ${code}`);
      } finally {
        console.log = prevLog;
        console.error = prevErr;
      }

      assert(
        out.includes('__state:running->blocked(recv)'),
        `the transition lost its cause: ${out}`,
      );
      assert(
        out.includes('__state:running->exiting(SIGTERM)'),
        `a signal is named by the signal, not by the word "signal": ${out}`,
      );
    } finally {
      if (prevHome === undefined) delete process.env['CORTEX_HOME'];
      else process.env['CORTEX_HOME'] = prevHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('the trace says which budget ran out', async () => {
    // "Your agent was stopped" and "your agent ran out of tokens" are
    // different facts, and only one of them tells the operator what to
    // change. The scheduler recorded which budget fired — the frame said
    // `sigxcpu` and the view dropped the rest, so the log said "sigxcpu" and
    // the reader had to guess between tokens, money and wall time.
    const { mkdtempSync, rmSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'cortex-trace-budget-'));
    mkdirSync(join(tmp, 'processes'), { recursive: true });

    const prevHome = process.env['CORTEX_HOME'];
    const prevLog = console.log;
    const prevErr = console.error;
    try {
      const rec = await Recorder.open({ pid: asProcessId(2), dir: join(tmp, 'processes', '2') });
      await rec.append({
        timestamp: '2026-01-01T00:00:00.000Z', pid: asProcessId(2), syscall: '__sched',
        callId: 'sched-2-sigxcpu-1', phase: 'exit',
        args: { action: 'sigxcpu', budgetKind: 'tokens', phase: 'post-quantum' },
        stateBefore: 'running', stateAfter: 'stopped', reversibility: 'idempotent',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      // A frame with no cause at all — what an older kernel wrote, and what
      // the scheduler writes for an action that has no explanation.
      await rec.append({
        timestamp: '2026-01-01T00:00:01.000Z', pid: asProcessId(2), syscall: '__sched',
        callId: 'sched-2-yielded-1', phase: 'exit',
        args: { action: 'yielded', nice: 0 },
        stateBefore: 'running', stateAfter: 'ready', reversibility: 'idempotent',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await rec.flush();
      await rec.close();

      process.env['CORTEX_HOME'] = tmp;
      let out = '';
      console.log = (...parts: unknown[]): void => {
        out += parts.map((p) => String(p)).join(' ') + '\n';
      };
      console.error = (): void => {};
      try {
        const code = await cmdTrace(['2']);
        assert(code === 0, `trace exit 0, got ${code}`);
      } finally {
        console.log = prevLog;
        console.error = prevErr;
      }

      assert(
        out.includes('__sched:sigxcpu(tokens)'),
        `the frame lost the budget that ran out: ${out}`,
      );
      // A frame with no cause says no cause — it does not grow one.
      assert(out.includes('__sched:yielded'), `the plain frame is still there: ${out}`);
      assert(
        !out.includes('__sched:yielded('),
        `a frame without a cause does not grow one: ${out}`,
      );
    } finally {
      if (prevHome === undefined) delete process.env['CORTEX_HOME'];
      else process.env['CORTEX_HOME'] = prevHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('the trace says what the process was waiting on', async () => {
    // The same rule for the other scheduler frames: the frame recorded what
    // the process was waiting on, and the view dropped it. The channel id and
    // the call id stay in the frame — a column of ids is a column of noise —
    // but the *kind* is the fact an operator reads.
    const { mkdtempSync, rmSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'cortex-trace-blocked-'));
    mkdirSync(join(tmp, 'processes'), { recursive: true });

    const prevHome = process.env['CORTEX_HOME'];
    const prevLog = console.log;
    const prevErr = console.error;
    try {
      const rec = await Recorder.open({ pid: asProcessId(2), dir: join(tmp, 'processes', '2') });
      await rec.append({
        timestamp: '2026-01-01T00:00:00.000Z', pid: asProcessId(2), syscall: '__sched',
        callId: 'sched-2-blocked-1', phase: 'exit',
        args: { action: 'blocked', blockedOn: { kind: 'recv', channel: 3 } },
        stateBefore: 'running', stateAfter: 'blocked', reversibility: 'idempotent',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await rec.append({
        timestamp: '2026-01-01T00:00:01.000Z', pid: asProcessId(2), syscall: '__sched',
        callId: 'sched-2-parked-1', phase: 'exit',
        args: { action: 'parked', nice: 0, blockedOn: { kind: 'sleep', until: '2026-01-01T00:00:05.000Z' } },
        stateBefore: 'running', stateAfter: 'running', reversibility: 'idempotent',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await rec.flush();
      await rec.close();

      process.env['CORTEX_HOME'] = tmp;
      let out = '';
      console.log = (...parts: unknown[]): void => {
        out += parts.map((p) => String(p)).join(' ') + '\n';
      };
      console.error = (): void => {};
      try {
        const code = await cmdTrace(['2']);
        assert(code === 0, `trace exit 0, got ${code}`);
      } finally {
        console.log = prevLog;
        console.error = prevErr;
      }

      assert(
        out.includes('__sched:blocked(recv)'),
        `the frame lost what it was waiting on: ${out}`,
      );
      assert(
        out.includes('__sched:parked(sleep)'),
        `the frame lost what it was waiting on: ${out}`,
      );
    } finally {
      if (prevHome === undefined) delete process.env['CORTEX_HOME'];
      else process.env['CORTEX_HOME'] = prevHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('the trace table lines up', async () => {
    // The header used to be a hand-typed string, and it had drifted: its
    // "phase" sat five columns to the right of where the rows printed theirs,
    // and the rule under it was longer than the header it ruled. Reading a
    // row meant counting characters. Now both come from one column list.
    const { mkdtempSync, rmSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'cortex-trace-cols-'));
    mkdirSync(join(tmp, 'processes'), { recursive: true });

    const prevHome = process.env['CORTEX_HOME'];
    const prevLog = console.log;
    const prevErr = console.error;
    try {
      const rec = await Recorder.open({ pid: asProcessId(2), dir: join(tmp, 'processes', '2') });
      await rec.append({
        timestamp: '2026-01-01T00:00:00.000Z', pid: asProcessId(2), syscall: 'now',
        callId: 'n1', phase: 'exit', result: 1,
        stateBefore: 'running', stateAfter: 'running', reversibility: 'idempotent',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await rec.flush();
      await rec.close();

      process.env['CORTEX_HOME'] = tmp;
      let out = '';
      console.log = (...parts: unknown[]): void => {
        out += parts.map((p) => String(p)).join(' ') + '\n';
      };
      console.error = (): void => {};
      try {
        const code = await cmdTrace(['2']);
        assert(code === 0, `trace exit 0, got ${code}`);
      } finally {
        console.log = prevLog;
        console.error = prevErr;
      }

      const lines = out.split('\n');
      const header = lines.find((l) => l.startsWith('time'));
      const row = recordLines(out)[0];
      assert(header !== undefined, `no header row: ${out}`);
      assert(row !== undefined, `no record rows: ${out}`);
      assert(
        header!.indexOf('phase') === row!.indexOf('exit'),
        `the phase column is off: header ${header!.indexOf('phase')}, row ${row!.indexOf('exit')}`,
      );
      assert(
        header!.indexOf('reversibility') === row!.indexOf('idempotent'),
        `the reversibility column is off: header ${header!.indexOf('reversibility')}, row ${row!.indexOf('idempotent')}`,
      );
      const rule = lines.find((l) => /^-+$/.test(l));
      assert(rule !== undefined, 'no rule under the header');
      assert(
        rule!.length === header!.length,
        `the rule is ${rule!.length} wide and the header is ${header!.length}`,
      );
    } finally {
      if (prevHome === undefined) delete process.env['CORTEX_HOME'];
      else process.env['CORTEX_HOME'] = prevHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('the trace table holds its widest frame', async () => {
    // A column width that is a guess is a width that is wrong eventually. The
    // widest name the kernel can produce is
    // `__state:checkpointing->checkpointing(init-register-daemon)` — the two
    // longest states and the longest cause, which is 58 characters; one
    // character more and every column after it slides right, so the row stops
    // lining up with the heading above it and the reader cannot tell which
    // column they are looking at.
    //
    // The width is derived from the kernel's own value domains, so this check
    // is really checking that the derivation is still true — and that a name
    // that *cannot* fit (a driver with a very long syscall name) is cut and
    // marked rather than silently dropping its tail.
    const { mkdtempSync, rmSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'cortex-trace-wide-'));
    mkdirSync(join(tmp, 'processes'), { recursive: true });

    const prevHome = process.env['CORTEX_HOME'];
    const prevLog = console.log;
    const prevErr = console.error;
    try {
      const rec = await Recorder.open({ pid: asProcessId(2), dir: join(tmp, 'processes', '2') });
      await rec.append({
        timestamp: '2026-01-01T00:00:00.000Z', pid: asProcessId(2), syscall: '__state',
        callId: 'w1', phase: 'exit',
        args: { from: 'checkpointing', to: 'checkpointing', trigger: 'checkpoint' },
        stateBefore: 'checkpointing', stateAfter: 'checkpointing', reversibility: 'idempotent',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await rec.append({
        timestamp: '2026-01-01T00:00:01.000Z', pid: asProcessId(2), syscall: '__signal',
        callId: 'w2', phase: 'exit', args: { signal: 'SIGTERM', outcome: 'delivered' },
        stateBefore: 'running', stateAfter: 'running', reversibility: 'idempotent',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await rec.append({
        timestamp: '2026-01-01T00:00:02.000Z', pid: asProcessId(2),
        syscall: 'acme_extremely_long_driver_syscall_name_that_cannot_possibly_fit',
        callId: 'w3', phase: 'exit', result: 1,
        stateBefore: 'running', stateAfter: 'running', reversibility: 'idempotent',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      // The widest name a scheduler frame can produce: the longest action and
      // the longest reason.
      await rec.append({
        timestamp: '2026-01-01T00:00:03.000Z', pid: asProcessId(2), syscall: '__sched',
        callId: 'w4', phase: 'exit',
        args: { action: 'exited', reason: 'reaped-during-quantum' },
        stateBefore: 'running', stateAfter: 'running', reversibility: 'idempotent',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await rec.flush();
      await rec.close();

      process.env['CORTEX_HOME'] = tmp;
      let out = '';
      console.log = (...parts: unknown[]): void => {
        out += parts.map((p) => String(p)).join(' ') + '\n';
      };
      console.error = (): void => {};
      try {
        const code = await cmdTrace(['2']);
        assert(code === 0, `trace exit 0, got ${code}`);
      } finally {
        console.log = prevLog;
        console.error = prevErr;
      }

      const lines = out.split('\n');
      const header = lines.find((l) => l.startsWith('time'));
      const rows = recordLines(out);
      assert(header !== undefined, `no header row: ${out}`);
      assert(rows.length === 4, `expected 4 record rows, got ${rows.length}: ${out}`);

      // The widest name the kernel can produce still fits.
      const widestFrame = '__state:checkpointing->checkpointing(init-register-daemon)';
      assert(
        TRACE_SYSCALL_WIDTH >= widestFrame.length,
        `the syscall column is ${TRACE_SYSCALL_WIDTH} wide and the widest frame name is ` +
          `${widestFrame.length}`,
      );
      // ...and so does the widest scheduler frame.
      const widestSchedFrame = '__sched:exited(reaped-during-quantum)';
      assert(
        TRACE_SYSCALL_WIDTH >= widestSchedFrame.length,
        `the syscall column is ${TRACE_SYSCALL_WIDTH} wide and the widest scheduler frame is ` +
          `${widestSchedFrame.length}`,
      );

      // Every row lines up with the header — including the widest frame, and
      // including the name that had to be cut.
      //
      // The column is found by **position**, not by looking for the word: a
      // frame's own name can contain the phase's name (`__sched:exited(…)`
      // contains "exit"), and a row that says "exit" in its syscall column
      // was never misaligned — it just made the check look in the wrong place.
      const phaseAt = header!.indexOf('phase');
      const reversibilityAt = header!.indexOf('reversibility');
      for (const row of rows) {
        assert(
          row.slice(phaseAt).trimStart().startsWith('exit'),
          `the phase column is off: header ${phaseAt}, row ${row} — ${row}`,
        );
        assert(
          row.slice(reversibilityAt).trimStart().startsWith('idempotent'),
          `the reversibility column is off in: ${row}`,
        );
      }

      // The widest frame is shown whole — cause and all.
      assert(
        out.includes('__state:checkpointing->checkpointing(checkpoint)'),
        `the widest frame was cut: ${out}`,
      );
      assert(
        out.includes('__sched:exited(reaped-during-quantum)'),
        `the widest scheduler frame was cut: ${out}`,
      );

      // A name that cannot fit is cut *and marked* — a fact that does not fit
      // must not lose its tail silently.
      const longName = 'acme_extremely_long_driver_syscall_name_that_cannot_possibly_fit';
      const expectedCut = `${longName.slice(0, TRACE_SYSCALL_WIDTH - 1)}…`;
      assert(
        out.includes(expectedCut),
        `the long name was not marked as cut: expected '${expectedCut}' in ${out}`,
      );
    } finally {
      if (prevHome === undefined) delete process.env['CORTEX_HOME'];
      else process.env['CORTEX_HOME'] = prevHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('the trace says what a model call spent', async () => {
    // The kernel records the usage of a model call in the frame's result — the
    // tokens it read and wrote, the part of the input the provider served out
    // of its cache, and the price. The dashboard's event table said so; the
    // CLI's deepest view said nothing at all, so the operator had to leave the
    // trace to find out what an agent's calls had cost.
    const { mkdtempSync, rmSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'cortex-trace-cost-'));
    mkdirSync(join(tmp, 'processes'), { recursive: true });

    const prevHome = process.env['CORTEX_HOME'];
    const prevLog = console.log;
    const prevErr = console.error;
    try {
      const rec = await Recorder.open({ pid: asProcessId(2), dir: join(tmp, 'processes', '2') });
      // A frame that spent nothing.
      await rec.append({
        timestamp: '2026-01-01T00:00:00.000Z', pid: asProcessId(2), syscall: '__state',
        callId: 's1', phase: 'exit',
        args: { from: 'new', to: 'ready', trigger: 'spawn' },
        stateBefore: 'new', stateAfter: 'ready', reversibility: 'idempotent',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      // A frame that spent something.
      await rec.append({
        timestamp: '2026-01-01T00:00:01.000Z', pid: asProcessId(2), syscall: 'llm_call',
        callId: 'c1', phase: 'exit',
        result: {
          text: 'an answer',
          model: 'gpt-4o-mini',
          usage: { inputTokens: 1200, outputTokens: 80, cachedTokens: 900, usd: 0.000161 },
        },
        stateBefore: 'running', stateAfter: 'running', reversibility: 'reversible',
        durationMs: 18,
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      // A frame that reported only part of its usage: the input it read, and
      // nothing else. No price, no output count.
      await rec.append({
        timestamp: '2026-01-01T00:00:02.000Z', pid: asProcessId(2), syscall: 'llm_call',
        callId: 'c2', phase: 'exit',
        result: { text: 'a partial answer', model: 'gpt-4o-mini', usage: { inputTokens: 500 } },
        stateBefore: 'running', stateAfter: 'running', reversibility: 'reversible',
        durationMs: 7,
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      // A frame that names the model and says nothing about what it cost.
      await rec.append({
        timestamp: '2026-01-01T00:00:03.000Z', pid: asProcessId(2), syscall: 'llm_call',
        callId: 'c3', phase: 'exit',
        result: { text: 'an answer', model: 'gpt-4o-mini' },
        stateBefore: 'running', stateAfter: 'running', reversibility: 'reversible',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      await rec.flush();
      await rec.close();

      process.env['CORTEX_HOME'] = tmp;
      let out = '';
      console.log = (...parts: unknown[]): void => {
        out += parts.map((p) => String(p)).join(' ') + '\n';
      };
      console.error = (): void => {};
      try {
        const code = await cmdTrace(['2']);
        assert(code === 0, `trace exit 0, got ${code}`);
      } finally {
        console.log = prevLog;
        console.error = prevErr;
      }

      const rows = recordLines(out);
      assert(rows.length === 4, `expected 4 record rows, got ${rows.length}: ${out}`);
      const calls = rows.filter((r) => r.includes('llm_call'));
      assert(calls.length === 3, `expected 3 model calls, got ${calls.length}: ${out}`);
      const [call, partial, bare] = calls as [string, string, string];

      assert(call.includes('$0.000161'), `the row says what it cost, got: ${call}`);
      assert(call.includes('1.2k in / 80 out'), `the row says what it spent, got: ${call}`);
      assert(call.includes('(900 cached)'), `the row says what was cached, got: ${call}`);

      // The spend column is a column like any other: the heading and the row
      // have to line up, or the reader cannot tell which column they are
      // looking at. Position, not word-search.
      const header = out.split('\n').find((l) => l.startsWith('time'));
      assert(header !== undefined, `no header row: ${out}`);
      assert(
        header!.indexOf('spend') === call.indexOf('$0.000161'),
        `the spend column is off: header ${header!.indexOf('spend')}, row ${call.indexOf('$0.000161')}`,
      );

      // A frame that reported part of its usage says that part — and says
      // nothing about the rest. "500 in" is what the frame said; "500 in / 0
      // out" would be a claim about a number nobody reported.
      assert(partial.includes('500 in'), `the partial call says what it reported, got: ${partial}`);
      assert(!partial.includes('out'), `an unreported counter is not a zero: ${partial}`);
      assert(!partial.includes('$'), `an unreported price is not a zero: ${partial}`);

      // A frame that names the model and reports no usage at all spent
      // nothing that can be told about — so the cell is empty, and the row
      // ends where its own content ends.
      assert(
        bare.trimEnd().endsWith('reversible'),
        `...and it ends where its own content ends, got: ${bare}`,
      );

      // And a frame that spent nothing says nothing about a cost. A state
      // transition costs nothing, and "$0.000000" would be a claim about a
      // number nobody spent.
      const state = rows.find((r) => r.includes('__state'));
      assert(state !== undefined, `the transition is in the trace: ${out}`);
      assert(!state!.includes('$'), `a frame that spent nothing has no cost, got: ${state}`);
      assert(
        state!.trimEnd().endsWith('idempotent'),
        `...and it ends where its own content ends, got: ${state}`,
      );
    } finally {
      if (prevHome === undefined) delete process.env['CORTEX_HOME'];
      else process.env['CORTEX_HOME'] = prevHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('cortex trace --help names the columns it prints', async () => {
    // A help text that names a column nobody can see is a help text that
    // lies about the command — and one that fails to name a column the
    // operator needs is a help text that leaves them guessing. The list of
    // columns is taken from the header the table really prints, so a new
    // column that nobody documents fails this check.
    const prevLog = console.log;
    let out = '';
    try {
      console.log = (...parts: unknown[]): void => {
        out += parts.map((p) => String(p)).join(' ') + '\n';
      };
      const code = await cmdTrace(['--help']);
      assert(code === 0, `exit 0, got ${code}`);
    } finally {
      console.log = prevLog;
    }
    const printed = TRACE_HEADER.trim().split(/\s+/);
    const section = out.slice(out.indexOf('COLUMNS'), out.indexOf('EXAMPLES'));
    const named = [...section.matchAll(/^ {2}(\S+)\s{2,}/gm)].map((m) => m[1]!);
    assert(named.length > 0, `the help has a columns section: ${out}`);
    for (const name of named) {
      assert(
        printed.includes(name),
        `the help describes a column the table does not have: ${name}`,
      );
    }
    for (const name of printed) {
      assert(
        named.includes(name),
        `the help does not describe the ${name} column, got: ${out}`,
      );
    }
  });

  await checkAsync('the trace and the dashboard read a call the same way', async () => {
    // One frame, two views: the CLI's trace and the dashboard's event table.
    // They must not be able to disagree about what a call spent — so they read
    // it with the same function, and this holds them to it.
    const frame = {
      timestamp: '2026-01-01T00:00:01.000Z',
      pid: asProcessId(2),
      syscall: 'llm_call',
      callId: 'c1',
      phase: 'exit',
      result: {
        text: 'an answer',
        model: 'gpt-4o-mini',
        usage: { inputTokens: 1200, outputTokens: 80, cachedTokens: 900, usd: 0.000161 },
      },
      stateBefore: 'running',
      stateAfter: 'running',
      reversibility: 'reversible',
      kernelAbiVersion: KERNEL_ABI_VERSION,
    } as unknown as SyscallRecord;

    const usage = callUsage(frame.syscall, frame.result);
    assert(usage !== undefined, 'the frame carries a usage');
    assert(usage!.inputTokens === 1200 && usage!.outputTokens === 80, 'the tokens are read');
    assert(usage!.cachedTokens === 900, 'the cached part is read');
    assert(usage!.usd === 0.000161, 'the price is read');
    assert(usage!.model === 'gpt-4o-mini', 'the model is read');

    const event = toActivityEvent(frame, 2);
    assert(event !== undefined, 'the dashboard makes an event of the frame');
    assert(event!.tokensIn === usage!.inputTokens, 'the dashboard and the trace read the same input');
    assert(event!.tokensOut === usage!.outputTokens, '...the same output');
    assert(event!.tokensCached === usage!.cachedTokens, '...the same cached part');
    assert(event!.usd === usage!.usd, '...and the same price');

    // A frame that is not a model call spent nothing, and a frame that
    // carries no usage did not report one — neither is a cost of zero.
    assert(callUsage('memory_read', { count: 1 }) === undefined, 'a non-model call spent nothing');
    assert(callUsage('llm_call', { text: 'no usage here' }) === undefined, 'a frame with no usage is not a cost');

    // A frame that reports part of its usage reports *that* part. The
    // dashboard must not fill in the rest either: an absent counter is
    // absent, and the two views must not disagree about what was said.
    const partial = callUsage('llm_call', { model: 'gpt-4o-mini', usage: { inputTokens: 500 } });
    assert(partial !== undefined, 'a partial usage is still a usage');
    assert(partial!.inputTokens === 500, 'the reported counter is read');
    assert(partial!.outputTokens === undefined, 'an unreported counter stays unreported');
    assert(partial!.usd === undefined, '...and so does an unreported price');

    const partialEvent = toActivityEvent(
      {
        ...frame,
        result: { text: 'an answer', model: 'gpt-4o-mini', usage: { inputTokens: 500 } },
      } as unknown as SyscallRecord,
      2,
    );
    assert(partialEvent !== undefined, 'the dashboard makes an event of the partial frame');
    assert(partialEvent!.tokensIn === 500, 'the dashboard keeps the reported counter');
    assert(partialEvent!.tokensOut === undefined, '...and invents none');
    assert(partialEvent!.usd === undefined, '...and no price either');

    // A frame that names the model and says nothing about what it cost still
    // says which model answered — that is a fact, and the dashboard has
    // always shown it.
    const bare = callUsage('llm_call', { model: 'gpt-4o-mini', text: 'an answer' });
    assert(bare !== undefined, 'a frame that names a model says something');
    assert(bare!.model === 'gpt-4o-mini', 'the model is read');
    assert(bare!.inputTokens === undefined, 'and nothing else is invented');

    const bareEvent = toActivityEvent(
      { ...frame, result: { text: 'an answer', model: 'gpt-4o-mini' } } as unknown as SyscallRecord,
      2,
    );
    assert(bareEvent !== undefined, 'the dashboard makes an event of the bare frame');
    assert(bareEvent!.model === 'gpt-4o-mini', 'the dashboard still shows the model');
    assert(bareEvent!.tokensIn === undefined, '...and no tokens that were never reported');
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
    // --- --module resolution ------------------------------------------------
    // The documented form is `--module ./examples/<name>.ts`, and an installed
    // package has no `examples/` folder in the user's cwd. So the resolution
    // has to reach into the package — which is only observable from a cwd
    // that does *not* contain it.
    await checkAsync('a bundled example resolves inside the package, not the cwd', async () => {
      const here = process.cwd();
      const elsewhere = mkdtempSync(join(tmpdir(), 'cortex-elsewhere-'));
      try {
        process.chdir(elsewhere);
        const resolved = resolveModule('./examples/checkpoint-agent.ts', elsewhere);
        assert(resolved.path !== null, 'the bundled example should name a file');
        assert(
          existsSync(resolved.path),
          `the bundled example should resolve to a real file, got ${resolved.path}`,
        );
        assert(
          !resolved.path.startsWith(elsewhere),
          `it should not resolve inside the cwd, got ${resolved.path}`,
        );
        assert(
          resolved.path.includes('checkpoint-agent'),
          `it should be the checkpoint agent, got ${resolved.path}`,
        );
      } finally {
        process.chdir(here);
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    check('a path that exists in the cwd wins over the package', () => {
      const resolved = resolveModule('./examples/checkpoint-agent.ts', process.cwd());
      assert(resolved.path !== null, 'it names a file');
      assert(
        resolved.path.endsWith('checkpoint-agent.ts'),
        `expected the .ts source from the cwd, got ${resolved.path}`,
      );
    });

    check('an unresolvable path falls back to the cwd-relative resolution', () => {
      const resolved = resolveModule('./definitely-not-here.ts', process.cwd());
      assert(resolved.path !== null, 'a missing path is still a path');
      assert(
        resolved.path.endsWith('definitely-not-here.ts'),
        `expected the cwd-relative path, got ${resolved.path}`,
      );
      assert(!existsSync(resolved.path), 'and it should not exist');
    });

    check('a bare name that is not a file stays an import specifier', () => {
      const resolved = resolveModule('some-agent-package', process.cwd());
      assert(
        resolved.specifier === 'some-agent-package',
        `expected the package name untouched, got ${resolved.specifier}`,
      );
      assert(resolved.isPath === false, 'a package is not a path');
      assert(resolved.path === null, 'and there is no file to look for');
    });

    check('a file URL is used exactly as it is', () => {
      const url = 'file:///F:/agents/child.js';
      const resolved = resolveModule(url, process.cwd());
      assert(resolved.specifier === url, `expected the URL unchanged, got ${resolved.specifier}`);
      assert(resolved.isPath === false, 'a URL is not looked up on disk');
    });

    check('a Windows drive path is a path, not a URL scheme', () => {
      // `C:` is a drive letter. Read as a scheme it asks Node for a protocol
      // it has never heard of — which is how `import('C:\\x.js')` used to die.
      const resolved = resolveModule('C:\\agents\\child.js', process.cwd());
      assert(resolved.isPath === true, 'a drive letter is a path');
      assert(
        resolved.path !== null && resolved.path.endsWith('child.js'),
        `expected the file path, got ${resolved.path}`,
      );
      assert(
        resolved.specifier.startsWith('file:///'),
        `expected a file URL, got ${resolved.specifier}`,
      );
    });

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
      await checkAsync('cortex restore --live says plainly that there is no live kernel', async () => {
        // Nothing is serving this directory, so there is nothing to restore
        // into. The command must say *that* — not fall back to a kernel of its
        // own (which would restore the agent and then take it away again when
        // the command exits), and not complain about the tag.
        let err = '';
        console.log = () => {};
        console.error = (...parts: unknown[]): void => { err += parts.map((p) => String(p)).join(' ') + '\n'; };
        const code = await cmdRestore(['--live', '--tag', 'whatever']);
        console.log = prevLog;
        console.error = prevErr;
        assert(code === 1, `exit 1, got ${code}`);
        assert(err.includes('no live kernel'), `the reason is reported, got: ${err.trim()}`);
        assert(!err.includes('no checkpoint found'), 'the tag is not what it complains about');
      });

      await checkAsync('a process keeps its spec while it runs, so its snapshot outlives its kernel', async () => {
        // The `.csnap` body deliberately omits the agent spec, and the
        // `meta.json` carries it only once the process *exits* — so a snapshot
        // of an agent that was still running had no spec anywhere on disk,
        // and could not be restored once its kernel was gone. The spec is
        // written when the process is created instead.
        const modulePath = join(tmp, 'self-checkpoint-agent.ts');
        writeFileSync(
          modulePath,
          'export default async function selfCheckpointAgent(ctx: any): Promise<void> {\n' +
            "  await ctx.checkpoint({ tag: 'before-crash', detach: true });\n" +
            '}\n',
        );

        const first = await bootCliKernel(tmp);
        let chainId: string | undefined;
        try {
          const pid = await first.spawn({
            role: 'self-check',
            agent: { module: pathToFileURL(modulePath).href },
          });

          // The spec is there from the moment the process exists.
          const spec = readSpec(tmp, pid);
          assert(spec !== undefined, 'the spec was written at creation');
          assert(spec!.role === 'self-check', `the role is recorded, got ${spec!.role}`);
          assert('module' in spec!.agent, 'the agent spec is recorded');
          assert(!existsSync(metaPath(tmp, pid)), 'no meta yet — the process has not exited');

          // The agent checkpoints itself and detaches: the snapshot exists and
          // the process is suspended (not exited), so nothing wrote a meta.
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline && chainId === undefined) {
            chainId = await findCheckpointByTag(tmp, 'before-crash');
            if (chainId === undefined) await new Promise((r) => setTimeout(r, 20));
          }
          assert(chainId !== undefined, 'the agent checkpointed itself');
          assert(
            !existsSync(metaPath(tmp, pid)),
            'still no meta — a suspended process never exits, so nothing wrote one',
          );
        } finally {
          await first.shutdown();
        }

        // A later session — one that never saw the process — restores it.
        // This is the "the laptop rebooted" case: the snapshot and the spec
        // are on disk, and nothing else is.
        const second = await bootCliKernel(tmp);
        try {
          const restored = await second.dispatcher.invoke(
            asProcessId(1),
            'restore',
            asChainId(chainId!),
            {},
          );
          const entry = second.table.get(restored.pid);
          assert(entry !== undefined, 'the restored process exists');
          assert(entry!.role === 'self-check', `the role survived, got ${entry!.role}`);
        } finally {
          await second.shutdown();
        }
      });

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
// Per-process output capture checks
// =============================================================================

/**
 * An agent prints. Until now that print went to the daemon's stdout and
 * nowhere else — one anonymous stream shared by everything in the kernel,
 * so "what did that process say?" had no answer.
 *
 * These checks go after the whole chain: the kernel tells the CLI which
 * process a body belongs to, the CLI scopes the body, and the scope decides
 * that a printed line belongs to that process and goes to that process's
 * `output.log`.
 */
async function runOutputCaptureChecks(): Promise<void> {
  const { mkdtempSync, rmSync, writeFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-output-'));

  const modulePath = join(tmp, 'printer-agent.ts');
  writeFileSync(
    modulePath,
    'export default async function printerAgent(ctx: any, args: Record<string, unknown> = {}): Promise<void> {\n' +
      "  const tag = String(args['tag'] ?? 'agent');\n" +
      '  console.log(`[${tag}] hello`);\n' +
      '  console.error(`[${tag}] trouble`);\n' +
      '  console.log(`[${tag}] two`);\n' +
      '}\n',
    'utf8',
  );

  const prevHome = process.env['CORTEX_HOME'];
  const prevWrite = process.stdout.write;

  /** Wait until the process's output file contains `needle`. */
  async function waitForOutput(pid: number, needle: string, timeoutMs = 5000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const text = readOutput(tmp, asProcessId(pid));
      if (text !== undefined && text.includes(needle)) return text;
      if (Date.now() > deadline) {
        return text ?? '';
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  try {
    await checkAsync('a process keeps what it printed, in its own log', async () => {
      const kernel = await bootCliKernel(tmp);
      let pid: number | undefined;
      try {
        pid = unbrand(
          await kernel.spawn({
            role: 'printer',
            agent: { module: pathToFileURL(modulePath).href, args: { tag: 'alpha' } },
          }),
        );
        const text = await waitForOutput(pid, '[alpha] two');
        assert(text.includes('[alpha] hello'), `the printed line was kept, got: ${text}`);
        assert(text.includes('[alpha] trouble'), `the stderr line was kept, got: ${text}`);
        assert(text.includes('| out |'), `stdout lines are tagged, got: ${text}`);
        assert(text.includes('| err |'), `stderr lines are tagged, got: ${text}`);
        // The init process printed nothing, so it has no output log at all:
        // the lines above belong to the agent, not to the kernel.
        assert(
          !existsSync(outputPath(tmp, asProcessId(1))),
          'init printed nothing, so it has no output log',
        );
      } finally {
        await kernel.shutdown();
      }
    });

    await checkAsync("two processes' output does not mix", async () => {
      const kernel = await bootCliKernel(tmp);
      try {
        const alpha = unbrand(
          await kernel.spawn({
            role: 'alpha',
            agent: { module: pathToFileURL(modulePath).href, args: { tag: 'alpha' } },
          }),
        );
        const beta = unbrand(
          await kernel.spawn({
            role: 'beta',
            agent: { module: pathToFileURL(modulePath).href, args: { tag: 'beta' } },
          }),
        );
        const a = await waitForOutput(alpha, '[alpha] two');
        const b = await waitForOutput(beta, '[beta] two');
        assert(a.includes('[alpha] hello') && !a.includes('[beta]'), `alpha's log is its own, got: ${a}`);
        assert(b.includes('[beta] hello') && !b.includes('[alpha]'), `beta's log is its own, got: ${b}`);
      } finally {
        await kernel.shutdown();
      }
    });

    await checkAsync('cortex logs reads the captured output back', async () => {
      process.env['CORTEX_HOME'] = tmp;
      const pid = 2;
      let out = '';
      // `cortex logs` writes the captured lines to stdout, so stdout is what
      // we read. The tap lives on the same function, so it is restored the
      // moment the command returns.
      process.stdout.write = ((chunk: unknown): boolean => {
        out += String(chunk);
        return true;
      }) as unknown as typeof process.stdout.write;
      let code: number;
      try {
        code = await cmdLogs([String(pid)]);
      } finally {
        process.stdout.write = prevWrite;
      }
      assert(code === 0, `exit 0, got ${code}`);
      assert(out.includes('| out |'), `the captured lines are printed, got: ${out}`);
      assert(out.includes('[alpha] hello') || out.includes('[beta] hello'), `the content is there, got: ${out}`);
    });

    await checkAsync('cortex logs says plainly when a process printed nothing', async () => {
      process.env['CORTEX_HOME'] = tmp;
      let err = '';
      const prevErr = console.error;
      console.error = (...parts: unknown[]): void => {
        err += parts.map((p) => String(p)).join(' ') + '\n';
      };
      let code: number;
      try {
        code = await cmdLogs(['1']);
      } finally {
        console.error = prevErr;
      }
      assert(code === 1, `exit 1, got ${code}`);
      assert(err.includes('no captured output'), `the reason is reported, got: ${err.trim()}`);
    });
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env['CORTEX_HOME'];
    else process.env['CORTEX_HOME'] = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  }
}

// =============================================================================
// Live output by push checks
// =============================================================================

/**
 * `cortex logs --follow` used to be the last poller in the CLI.
 *
 * The file it tails is written by the *host* — the kernel does not know what
 * a process said — so there was nothing for the kernel to push, and the
 * command read the file every 250 ms. That is a latency tax (measured: a
 * median of 155 ms behind the line, and two seconds in the worst case) and
 * it never ends: the follow ran until the operator interrupted it, long
 * after the agent it was watching had finished.
 *
 * The kernel now relays what a process printed — the same shape as a
 * `record` event: a fact about a process, reported the moment it happens —
 * and the command stitches the file and the stream by the line's byte
 * offset, exactly as `cortex attach` stitches the syscall log and its
 * stream.
 */
async function runOutputPushChecks(): Promise<void> {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-outputpush-'));
  const servers: { close: () => Promise<void> }[] = [];

  const prevHome = process.env['CORTEX_HOME'];
  const prevLog = console.log;
  const prevErr = console.error;

  // An agent that prints a few lines and then ends on its own.
  //
  // It waits before its **first** line on purpose. A follower that is attached
  // only after the agent started would see the early lines in the file and
  // could not tell them apart from the ones that arrived by push — so the
  // delay makes the difference observable: every line this agent prints is
  // printed after the follower is watching, and can only have reached it
  // through the push.
  const modulePath = join(tmp, 'chatty-agent.ts');
  writeFileSync(
    modulePath,
    'export default async function chattyAgent(ctx: any): Promise<void> {\n' +
      '  await ctx.sleep(500);\n' +
      '  for (let i = 0; i < 8; i += 1) {\n' +
      '    console.log(`chat ${i}`);\n' +
      '    await ctx.sleep(100);\n' +
      '  }\n' +
      "  ctx.exit(7, 'done on purpose');\n" +
      '}\n',
    'utf8',
  );

  /**
   * Capture what a command writes to stdout and stderr.
   *
   * The agent lives in this same process, so its own `console.log` also goes
   * to stdout — and a follower that printed nothing would still look like one
   * that printed everything. The checks below therefore count the *formatted*
   * line (the follower prints `<time> | out | chat 3`) and never the bare
   * text, which only the agent writes.
   */
  const captureStdout = async (
    run: () => Promise<number>,
  ): Promise<{ code: number; out: string; err: string }> => {
    let out = '';
    let err = '';
    const prevWrite = process.stdout.write;
    const prevErrWrite = process.stderr.write;
    process.stdout.write = ((chunk: unknown): boolean => {
      out += String(chunk);
      return true;
    }) as unknown as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown): boolean => {
      err += String(chunk);
      return true;
    }) as unknown as typeof process.stderr.write;
    try {
      const code = await run();
      return { code, out, err };
    } finally {
      process.stdout.write = prevWrite;
      process.stderr.write = prevErrWrite;
    }
  };

  try {
    await checkAsync('a live kernel pushes the lines a process printed', async () => {
      const kernel = await bootCliKernel(tmp);
      const server = await startKernelServer(kernel, { log: () => {} });
      servers.push(server);
      writeEndpoint(tmp, server.endpoint);
      process.env['CORTEX_HOME'] = tmp;

      const pid = unbrand(
        await kernel.spawn({
          role: 'chatty',
          agent: { module: pathToFileURL(modulePath).href },
        }),
      );

      const probe = await probeKernel(tmp);
      assert(probe.kind === 'live', `the kernel is reachable, got ${probe.kind}`);
      const client = probe.kind === 'live' ? probe.client : undefined;

      const pushed: { text: string; offset: number }[] = [];
      const unsubscribe = await client!.subscribe((raw) => {
        const event = raw as {
          kind?: string;
          pid?: number;
          byteOffset?: number;
          line?: { text?: string };
        };
        if (event.kind !== 'output' || event.pid !== pid) return;
        pushed.push({ text: event.line?.text ?? '', offset: event.byteOffset ?? -1 });
      }, { pid, kinds: ['output'] });

      const deadline = Date.now() + 5000;
      while (pushed.length < 8 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      unsubscribe();
      client!.close();

      assert(pushed.length === 8, `every printed line was pushed, got ${pushed.length}`);
      assert(pushed[0]!.text === 'chat 0', `the first line is the first line, got: ${pushed[0]!.text}`);
      // The offset is where the *entry* sits in the output file — the
      // timestamp first, then the stream, then the text. That is what lets a
      // follower join the file and the stream without showing a line twice,
      // so it has to be the real offset.
      const file = readOutput(tmp, asProcessId(pid)) ?? '';
      const firstLine = file.split('\n')[0] ?? '';
      assert(
        pushed[0]!.offset === 0,
        `the first entry starts at the beginning of the file, got ${pushed[0]!.offset}`,
      );
      assert(
        pushed[1]!.offset === Buffer.byteLength(firstLine) + 1,
        `the second entry starts where the first one ends, got ${pushed[1]!.offset}`,
      );
      await kernel.shutdown();
    });

    await checkAsync('cortex logs --follow streams the lines and ends when the process ends', async () => {
      const kernel = await bootCliKernel(tmp);
      const server = await startKernelServer(kernel, { log: () => {} });
      servers.push(server);
      writeEndpoint(tmp, server.endpoint);
      process.env['CORTEX_HOME'] = tmp;

      const pid = unbrand(
        await kernel.spawn({
          role: 'chatty',
          agent: { module: pathToFileURL(modulePath).href },
        }),
      );
      // The agent keeps printing while the follow runs — those lines can
      // only reach the follower by push.

      const started = Date.now();
      const result = await captureStdout(() =>
        cmdLogs([String(pid), '--follow', '--timeout-ms', '10000']),
      );
      const elapsed = Date.now() - started;

      assert(result.code === 0, `the follow ended cleanly, got ${result.code}`);
      // The follower took the push path — it says so, and it must not have
      // silently fallen back to polling the file.
      assert(
        result.err.includes('push'),
        `the follow announced that the lines come by push, got: ${result.err}`,
      );
      // Every line exactly once: the history read and the stream overlap,
      // and the byte offset is what keeps them from being shown twice.
      // The marker is the *formatted* line, so the agent's own printing (which
      // goes to the same stdout) cannot be mistaken for the follower's work.
      for (let i = 0; i < 8; i += 1) {
        const marker = `| out | chat ${i}`;
        const occurrences = result.out.split(marker).length - 1;
        assert(occurrences === 1, `chat ${i} was shown ${occurrences} times, got: ${result.out}`);
      }
      // The follow ends **by itself** — the agent exits after its lines, and
      // the follow must end with it rather than waiting for a Ctrl-C that
      // never comes. (The timeout is ten seconds; ending well inside it is
      // the proof.) And it reports *how* the process ended.
      assert(elapsed < 5000, `the follow ended with the process, took ${elapsed}ms`);
      assert(
        result.err.includes(`# pid ${pid} exited with code 7`),
        `the follow reported the real exit code, got: ${result.err}`,
      );
      await kernel.shutdown();
    });

    await checkAsync('a pushed line the file already showed is not shown again', async () => {
      // The rule that joins the file and the stream: a line that *starts*
      // before the read position was in the file when it was read, so it was
      // already shown. The window where the two overlap is narrow by nature,
      // so the rule is pinned here rather than left to a race.
      assert(alreadyShown(0, 100), 'a line at the very start was already shown');
      assert(alreadyShown(99, 100), 'a line just before the read position was already shown');
      assert(!alreadyShown(100, 100), 'a line exactly at the read position is new');
      assert(!alreadyShown(101, 100), 'a line after the read position is new');
      assert(!alreadyShown(-1, 100), 'a line with no offset is not silently dropped');
    });

    await checkAsync('cortex logs --follow still works without a live kernel', async () => {
      // Its own home, with no kernel endpoint published in it — so there is
      // nothing to push from and the file follower takes over.
      const soloDir = join(tmp, 'solo');
      const kernel = await bootCliKernel(soloDir);
      try {
        const pid = unbrand(
          await kernel.spawn({
            role: 'chatty',
            agent: { module: pathToFileURL(modulePath).href },
          }),
        );
        // Let it print and end, with no kernel to push anything. The agent
        // waits half a second before its first line, so this has to outlast
        // that or there is nothing to show.
        await new Promise((r) => setTimeout(r, 1500));
        process.env['CORTEX_HOME'] = soloDir;
        const result = await captureStdout(() =>
          cmdLogs([String(pid), '--follow', '--timeout-ms', '300']),
        );
        process.env['CORTEX_HOME'] = tmp;
        assert(result.code === 0, `the follow detached cleanly, got ${result.code}`);
        // The formatted line — the agent's own stdout would not carry the
        // stream tag, so this can only be the follower's work.
        assert(
          result.out.includes('| out | chat 0'),
          `the lines were still shown, got: ${result.out}`,
        );
      } finally {
        await kernel.shutdown();
      }
    });

    await checkAsync('the capture survives someone else replacing stdout.write', async () => {
      // Anything that installs its own writer — a logger, a reporter, a test
      // harness — must not switch the capture off. The failure it prevents is
      // the silent kind: the agent keeps printing to the terminal, the log
      // stops growing, and `cortex logs` answers with a file that is missing
      // exactly the lines that mattered.
      const captureDir = join(tmp, 'tap');
      const capture = new OutputCapture(captureDir);
      const pid = asProcessId(4242);

      const prevWrite = process.stdout.write;
      // A third party takes the stream over. It does not call the old writer
      // back — it simply owns the stream now.
      process.stdout.write = ((chunk: unknown): boolean => {
        void chunk;
        return true;
      }) as unknown as typeof process.stdout.write;
      try {
        await capture.scope(pid, async () => {
          console.log('a line that must be recorded');
        });
      } finally {
        process.stdout.write = prevWrite;
      }

      const text = readOutput(captureDir, pid) ?? '';
      assert(
        text.includes('a line that must be recorded'),
        `the line was still recorded, got: ${text}`,
      );
    });
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    for (const server of servers) {
      try {
        await server.close();
      } catch {
        /* teardown is best-effort */
      }
    }
    if (prevHome === undefined) delete process.env['CORTEX_HOME'];
    else process.env['CORTEX_HOME'] = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  }
}

// =============================================================================
// Live-process memory inspection checks
// =============================================================================

/**
 * An agent's memory is its knowledge. The syscall log deliberately stores a
 * *hash* of a memory value rather than the value (ABI.md §4.4 — "full values
 * would bloat the log"), so the causal history can say that an agent wrote
 * something down and never what. These checks cover the two halves of
 * closing that gap:
 *
 *   - the kernel binds a daemon's declared regions. It used to not, and a
 *     daemon whose agent touched memory died on its first `memory_read` with
 *     ENOENT — while the same agent under `cortex spawn` worked, because the
 *     `spawn` syscall path did the sync.
 *   - the transport can read a live process's regions and their entries.
 */
async function runMemoryInspectChecks(): Promise<void> {
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-meminspect-'));
  const kernels: Kernel[] = [];
  const servers: { close: () => Promise<void> }[] = [];

  const prevHome = process.env['CORTEX_HOME'];

  try {
    let daemonPid: number | undefined;
    let readerPid: number | undefined;

    // Run `cortex memory` and capture what it printed. The command writes to
    // stdout, so a check has to stand in for it.
    const memoryOutput = async (args: string[]): Promise<string> => {
      process.env['CORTEX_HOME'] = tmp;
      let out = '';
      const prevWrite = process.stdout.write;
      process.stdout.write = ((chunk: unknown): boolean => {
        out += String(chunk);
        return true;
      }) as unknown as typeof process.stdout.write;
      try {
        const code = await cmdMemory(args);
        assert(code === 0, `exit 0, got ${code}`);
      } finally {
        process.stdout.write = prevWrite;
      }
      return out;
    };

    await checkAsync('a daemon-registered agent gets its memory regions bound', async () => {
      const kernel = await bootKernel({
        kernelAbiVersion: KERNEL_ABI_VERSION,
        dir: tmp,
        autoStart: true,
        loadDrivers: (reg) => {
          reg.registerMemory(inmemMemory());
        },
        agentLoader: async () => async (ctx) => {
          // This used to trap ENOENT: the regions were declared in the
          // process table but never bound in the memory engine, because the
          // daemon birth path did not sync them.
          //
          // The same agent runs for both processes — the one that may write
          // and the one whose binding is read-only — so the write has to
          // tolerate the EPERM the read-only one traps. It must not kill the
          // agent: the point of the check is that the region is still there
          // to be looked at.
          const write = async (): Promise<void> => {
            try {
              await ctx.memory_write('semantic', 'note', { hello: 'world' });
            } catch (err) {
              if ((err as { errno?: string }).errno !== 'EPERM') throw err;
            }
          };
          await write();
          // …and again, with the same key: the region holds **one** entry and
          // has made **two** writes, and it is the second number the write
          // ceiling is measured against. A view that showed the entry count
          // where the write count belongs would not be able to tell the two
          // apart.
          await write();
          for (;;) {
            try {
              await ctx.recv(undefined, { timeoutMs: 50 });
            } catch (err) {
              if ((err as { errno?: string }).errno !== 'ETIMEDOUT') throw err;
            }
          }
        },
      });
      kernels.push(kernel);

      const pid = await kernel.registerDaemon({
        role: 'rememberer',
        agent: { module: 'test:rememberer' },
        memory: {
          // One region with a ceiling of its own, one without — so the view
          // has both a bounded ceiling and an unbounded one to say.
          episodic: { kind: 'private', backing: 'inmem', maxEntries: 5 },
          semantic: { kind: 'shared', backing: 'inmem' },
        },
      });
      daemonPid = unbrand(pid);

      // A second process bound to the **same physical region** with a
      // read-only binding of its own. It can read everything the first one
      // writes and cannot add a byte to it — its `memory_write` traps `EPERM`.
      // Sharing is not writing, and the views have to tell those apart.
      const reader = await kernel.registerDaemon({
        role: 'reader',
        agent: { module: 'test:reader' },
        memory: {
          semantic: { kind: 'shared', backing: 'inmem', readOnly: true },
        },
      });
      readerPid = unbrand(reader);

      // The read-only binding is not a label: the kernel really refuses the
      // write, with the errno the ABI names (ABI.md §4.4).
      let refused = '';
      try {
        await kernel.memory.write(reader, 'semantic', 'note', { hello: 'world' });
      } catch (err) {
        refused = (err as { errno?: string }).errno ?? '';
      }
      assert(refused === 'EPERM', `the read-only binding refuses the write, got ${refused}`);

      // The regions are *bound*, not merely declared.
      const regions = kernel.memory.regionsOf(pid);
      assert(regions.length === 2, `both regions are bound, got ${regions.length}`);
      assert(
        regions.some((r) => r.region === 'semantic' && r.kind === 'shared'),
        'the shared region kept its declared kind',
      );

      // And the daemon's agent can actually use them.
      const deadline = Date.now() + 5000;
      let entries: readonly { key: string; value: unknown }[] = [];
      while (Date.now() < deadline && entries.length === 0) {
        entries = await kernel.memory.read(pid, 'semantic', {});
        if (entries.length === 0) await new Promise((r) => setTimeout(r, 20));
      }
      assert(entries.length === 1, `the daemon wrote one note, got ${entries.length}`);
      assert(
        JSON.stringify(entries[0]!.value) === '{"hello":"world"}',
        `the note is what it wrote, got ${JSON.stringify(entries[0]!.value)}`,
      );
    });

    await checkAsync("the transport's memory command reads a live process's regions", async () => {
      const kernel = kernels[0]!;
      const pid = daemonPid!;
      const server = await startKernelServer(kernel, { log: () => {} });
      servers.push(server);
      writeEndpoint(tmp, server.endpoint);

      const probe = await probeKernel(tmp);
      assert(probe.kind === 'live', `probe finds the kernel, got ${probe.kind}`);
      const client = probe.kind === 'live' ? probe.client : undefined;

      const listed = await client!.request<{
        regions: readonly {
          region: string;
          kind: string;
          entries: number;
          writes: number;
          readOnly: boolean;
          sharedWith: readonly number[];
          readOnlyPeers?: readonly number[];
          effectiveMaxEntries?: number;
        }[];
      }>('memory', { pid });
      assert(listed.regions.length === 2, `both regions are reported, got ${listed.regions.length}`);
      const semantic = listed.regions.find((r) => r.region === 'semantic');
      assert(semantic !== undefined, 'the semantic region is reported');
      assert(semantic!.kind === 'shared', `its kind is shared, got ${semantic!.kind}`);
      assert(semantic!.entries === 1, `it holds one entry, got ${semantic!.entries}`);
      // The ceiling travels with the region: the region's own `maxEntries`
      // when it declared one, and `-1` for the unbounded one.
      const episodic = listed.regions.find((r) => r.region === 'episodic');
      assert(episodic !== undefined, 'the episodic region is reported');
      assert(
        episodic!.effectiveMaxEntries === 5,
        `the bounded region's ceiling is reported, got ${String(episodic!.effectiveMaxEntries)}`,
      );
      assert(
        semantic!.effectiveMaxEntries === -1,
        `the unbounded region says so, got ${String(semantic!.effectiveMaxEntries)}`,
      );
      assert(semantic!.writes === 2, `the write count is reported, got ${semantic!.writes}`);

      // The access mode travels with it too — both this process's own and
      // the peers'. The writer may write; the peer that shares the same
      // physical region may only read it.
      assert(semantic!.readOnly === false, `the writer may write, got ${String(semantic!.readOnly)}`);
      assert(
        semantic!.sharedWith.includes(readerPid!),
        `the reader shares the region, got ${JSON.stringify(semantic!.sharedWith)}`,
      );
      assert(
        semantic!.readOnlyPeers?.includes(readerPid!) === true,
        `the reader may only read it, got ${JSON.stringify(semantic!.readOnlyPeers)}`,
      );

      // And the other side of the same region: the reader's own view says
      // the opposite, about the same physical region.
      const readerView = await client!.request<{
        regions: readonly {
          region: string;
          readOnly: boolean;
          sharedWith: readonly number[];
          readOnlyPeers?: readonly number[];
        }[];
      }>('memory', { pid: readerPid });
      const readerSemantic = readerView.regions.find((r) => r.region === 'semantic');
      assert(readerSemantic !== undefined, 'the reader sees the same region');
      assert(
        readerSemantic!.readOnly === true,
        `the reader may not write, got ${String(readerSemantic!.readOnly)}`,
      );
      assert(
        readerSemantic!.sharedWith.includes(pid),
        `the writer shares it too, got ${JSON.stringify(readerSemantic!.sharedWith)}`,
      );
      assert(
        readerSemantic!.readOnlyPeers?.includes(pid) !== true,
        `the writer is not read-only, got ${JSON.stringify(readerSemantic!.readOnlyPeers)}`,
      );

      const dumped = await client!.request<{
        entries: readonly { key: string; value: unknown }[];
      }>('memory', { pid, region: 'semantic' });
      assert(dumped.entries.length === 1, `one entry dumped, got ${dumped.entries.length}`);
      assert(dumped.entries[0]!.key === 'note', `the key, got ${dumped.entries[0]!.key}`);
      assert(
        JSON.stringify(dumped.entries[0]!.value) === '{"hello":"world"}',
        `the value the agent actually wrote, got ${JSON.stringify(dumped.entries[0]!.value)}`,
      );

      // A pid the kernel does not know is ESRCH, not an empty answer.
      const missing = await client!.requestRaw('memory', { pid: 999999 });
      assert(!missing.ok, 'an unknown pid is refused');
      assert(
        missing.ok === false && missing.error.errno === 'ESRCH',
        `the refusal is ESRCH, got ${missing.ok === false ? missing.error.errno : 'ok'}`,
      );

      client!.close();
    });

    await checkAsync('the transport read does not write a frame into the log', async () => {
      // A read is a read: the operator looking at a process's memory is not
      // something the process did, so it must not grow the causal history.
      const kernel = kernels[0]!;
      const pid = daemonPid!;
      const logPath = existingCrecPath(tmp, asProcessId(pid));
      assert(existsSync(logPath), 'the daemon has a log');

      // The agent behind this process is alive and busy: it retries its `recv`
      // every 50 ms, and each attempt is a frame of its own. So the log grows
      // on its own, and "the log did not grow" was a coin flip — the check
      // fired on its own while this round was being written. What the *read*
      // must not add is a memory frame: the operator's read is not the
      // process's doing, and a `memory_read` frame is what it would look like
      // if it were recorded (ABI.md §4.4).
      const syscalls = async (): Promise<readonly string[]> => {
        const seen: string[] = [];
        for await (const rec of readRecords(logPath)) seen.push(rec.syscall);
        return seen;
      };

      const before = await syscalls();
      const probe = await probeKernel(tmp);
      const client = probe.kind === 'live' ? probe.client : undefined;
      await client!.request('memory', { pid });
      await client!.request('memory', { pid, region: 'semantic' });
      client!.close();
      const after = await syscalls();
      const added = after.slice(before.length);
      assert(
        added.every((syscall) => syscall !== 'memory_read' && syscall !== 'memory_write'),
        `the read recorded no memory frame, got: ${added.join(', ')}`,
      );
      assert(kernel.table.get(asProcessId(pid)) !== undefined, 'the process is still there');
    });

    await checkAsync('cortex memory prints the regions of a live process', async () => {
      const out = await memoryOutput([String(daemonPid!)]);
      assert(out.includes('semantic'), `the region is listed, got: ${out}`);
      assert(out.includes('episodic'), `the other region is listed, got: ${out}`);
      assert(out.includes('SHARED WITH'), `the sharing column is there, got: ${out}`);
    });

    await checkAsync('cortex memory says how much a region may hold', async () => {
      // The kernel knows each region's write-count ceiling — the number the
      // `ENOMEM` check is measured against — and no view said so. The operator
      // could see how many entries a region held and had no way to tell that
      // the next write would trap.
      const out = await memoryOutput([String(daemonPid!)]);

      const lines = out.split('\n');
      const header = lines.find((l) => l.startsWith('REGION'));
      const episodic = lines.find((l) => l.startsWith('episodic'));
      const semantic = lines.find((l) => l.startsWith('semantic'));
      assert(header !== undefined, `the region table has a header, got: ${out}`);
      assert(episodic !== undefined && semantic !== undefined, `both regions are listed, got: ${out}`);
      // By position, not by word-search: the columns come from the header the
      // table really printed.
      const limitAt = header!.indexOf('LIMIT');
      const writesAt = header!.indexOf('WRITES');
      const limitWidth = header!.indexOf('SHARED WITH') - limitAt;
      assert(limitAt > writesAt, `the columns are in order, got: ${header}`);
      assert(
        episodic!.slice(limitAt, limitAt + limitWidth).trim() === '5',
        `the bounded region says its ceiling, got: ${episodic}`,
      );
      assert(
        semantic!.slice(limitAt, limitAt + limitWidth).trim() === '∞',
        `the unbounded region says so, got: ${semantic}`,
      );
      // And the write count the ceiling is measured against is there too —
      // without it, a ceiling beside an entry count would be a comparison the
      // kernel never makes. This region holds **one** entry and has made
      // **two** writes, so the two columns cannot be the same number.
      assert(
        semantic!.slice(writesAt, limitAt).trim() === '2',
        `the write count is there, got: ${semantic}`,
      );
    });

    await checkAsync('cortex memory dumps a region', async () => {
      process.env['CORTEX_HOME'] = tmp;
      const pid = daemonPid!;
      const out = await memoryOutput([String(pid), 'semantic']);
      assert(out.includes('note'), `the entry is printed, got: ${out}`);
      assert(out.includes('hello'), `the value is printed, got: ${out}`);
    });

    await checkAsync('cortex memory says who may write to a region', async () => {
      // The kernel knows two different things about a shared region: whether
      // THIS process may write to it, and whether the peers that share it may.
      // A region table that said neither left the operator with an `EPERM`
      // and no way to know it was not a bug.
      const writerOut = await memoryOutput([String(daemonPid!)]);
      const readerOut = await memoryOutput([String(readerPid!)]);

      const header = writerOut.split('\n').find((l) => l.startsWith('REGION'));
      assert(header !== undefined, `the region table has a header, got: ${writerOut}`);
      // By position, not by word-search: the columns come from the header the
      // table really printed.
      const accessAt = header!.indexOf('ACCESS');
      const entriesAt = header!.indexOf('ENTRIES');
      const sharedAt = header!.indexOf('SHARED WITH');
      assert(
        accessAt > 0 && entriesAt > accessAt && sharedAt > entriesAt,
        `the columns are in order, got: ${header}`,
      );

      const row = (out: string, name: string): string => {
        const line = out.split('\n').find((l) => l.startsWith(name));
        assert(line !== undefined, `${name} is listed, got: ${out}`);
        return line!;
      };
      const writerRow = row(writerOut, 'semantic');
      const readerRow = row(readerOut, 'semantic');

      assert(
        writerRow.slice(accessAt, entriesAt).trim() === 'read-write',
        `the writer may write, got: ${writerRow}`,
      );
      assert(
        readerRow.slice(accessAt, entriesAt).trim() === 'read-only',
        `the reader may not, got: ${readerRow}`,
      );

      // And the peer list says the same about the other side of the same
      // region: sharing is not writing.
      const writerPeers = writerRow.slice(sharedAt).trim();
      assert(
        writerPeers === `${readerPid} (read-only)`,
        `the writer sees a read-only peer, got: ${writerPeers}`,
      );
      const readerPeers = readerRow.slice(sharedAt).trim();
      assert(
        readerPeers === `${daemonPid} (read-write)`,
        `the reader sees a writable peer, got: ${readerPeers}`,
      );
    });

    await checkAsync('an access mode nobody reported is not a writable one', async () => {
      // The kernel can be older than this view. A region whose access mode it
      // did not report prints `?` — never `read-write`: that would be a claim
      // about a permission nobody stated.
      assert(
        formatAccess(undefined) === '?',
        `the unknown mode is ?, got ${formatAccess(undefined)}`,
      );
      assert(
        formatAccess(true) === 'read-only',
        `the read-only mode is named, got ${formatAccess(true)}`,
      );
      assert(
        formatAccess(false) === 'read-write',
        `the writable mode is named, got ${formatAccess(false)}`,
      );
      assert(
        formatPeers([3], [3]) === '3 (read-only)',
        `a read-only peer is marked, got ${formatPeers([3], [3])}`,
      );
      assert(
        formatPeers([3], []) === '3 (read-write)',
        `a writable peer is marked, got ${formatPeers([3], [])}`,
      );
      assert(
        formatPeers([3], undefined) === '3 (?)',
        `an unknown peer mode is ?, got ${formatPeers([3], undefined)}`,
      );
      assert(formatPeers([], []) === '-', `no peers is -, got ${formatPeers([], [])}`);
    });

    await checkAsync('cortex memory names the access mode when it dumps a region', async () => {
      // The region table and the region dump are two views of one region, so
      // they say the same thing about it.
      const writerOut = await memoryOutput([String(daemonPid!), 'semantic']);
      const readerOut = await memoryOutput([String(readerPid!), 'semantic']);
      assert(
        writerOut.startsWith(
          `# memory of pid ${daemonPid} (rememberer) — region 'semantic' (read-write)`,
        ),
        `the writer's dump names it, got: ${writerOut}`,
      );
      assert(
        readerOut.startsWith(`# memory of pid ${readerPid} (reader) — region 'semantic' (read-only)`),
        `the reader's dump names it, got: ${readerOut}`,
      );
    });

    await checkAsync('the dashboard says what a process knows', async () => {
      // The window could show what an agent **did** — the event table, the
      // syscall timeline — and nothing about what it **knows**. For an agent
      // the knowledge is the point.
      const probe = await probeKernel(tmp);
      const client = probe.kind === 'live' ? probe.client : undefined;
      const dash = await startDashboard({ dir: tmp, port: 0, kernel: client! });
      try {
        const res = await fetch(`${dash.url}/api/memory/${daemonPid}`);
        assert(res.status === 200, `status ${res.status}`);
        const body = (await res.json()) as {
          regions: readonly {
            region: string;
            access: string;
            entries: number;
            writes: number;
            limit: string;
            sharedWith: string;
          }[];
        };
        const semantic = body.regions.find((r) => r.region === 'semantic');
        assert(semantic !== undefined, `the region is listed, got: ${JSON.stringify(body.regions)}`);
        assert(semantic!.access === 'read-write', `the writer may write, got ${semantic!.access}`);
        assert(semantic!.limit === '∞', `the unbounded region says so, got ${semantic!.limit}`);
        assert(
          semantic!.sharedWith === `${readerPid} (read-only)`,
          `the read-only peer is marked, got ${semantic!.sharedWith}`,
        );

        // And the window says it in the **same words** the CLI does: one
        // rule, two views.
        const out = await memoryOutput([String(daemonPid!)]);
        const row = out.split('\n').find((l) => l.startsWith('semantic'));
        assert(row !== undefined, `the CLI's row is there, got: ${out}`);
        assert(row!.includes('read-write'), `the CLI says the same, got: ${row}`);
        assert(row!.includes('∞'), `the CLI says the same ceiling, got: ${row}`);
        assert(
          row!.includes(`${readerPid} (read-only)`),
          `the CLI marks the peer the same way, got: ${row}`,
        );
      } finally {
        await dash.close();
        client!.close();
      }
    });

    await checkAsync('the dashboard shows what is in a region', async () => {
      const probe = await probeKernel(tmp);
      const client = probe.kind === 'live' ? probe.client : undefined;
      const dash = await startDashboard({ dir: tmp, port: 0, kernel: client! });
      try {
        const res = await fetch(`${dash.url}/api/memory/${daemonPid}/semantic`);
        assert(res.status === 200, `status ${res.status}`);
        const body = (await res.json()) as {
          region: string;
          access: string;
          entries: readonly { key: string; value: unknown }[];
        };
        assert(body.region === 'semantic', `the region is named, got ${body.region}`);
        assert(body.access === 'read-write', `the access mode is named, got ${body.access}`);
        assert(body.entries.length === 1, `the note is there, got ${JSON.stringify(body.entries)}`);
        assert(
          JSON.stringify(body.entries[0]!.value) === '{"hello":"world"}',
          `the note is what it wrote, got ${JSON.stringify(body.entries[0]!.value)}`,
        );
      } finally {
        await dash.close();
        client!.close();
      }
    });

    await checkAsync('the page has a memory view of a process', async () => {
      const probe = await probeKernel(tmp);
      const client = probe.kind === 'live' ? probe.client : undefined;
      const dash = await startDashboard({ dir: tmp, port: 0, kernel: client! });
      try {
        const html = await (await fetch(`${dash.url}/`)).text();
        // Which endpoints the page actually fetches — not merely whether the
        // string `/api/memory/` appears somewhere, because the *region*
        // endpoint contains it as a prefix. The page must ask for **both**:
        // the list of regions, and one region's entries.
        const fetched = [...html.matchAll(/fetch\(`([^`]+)`\)/g)].map((m) => m[1]!);
        assert(
          fetched.some((u) => /^\/api\/memory\/\$\{encodeURIComponent\(pid\)\}$/.test(u)),
          `the page asks the kernel for the regions, got: ${JSON.stringify(fetched)}`,
        );
        assert(
          fetched.some((u) =>
            /^\/api\/memory\/\$\{encodeURIComponent\(pid\)\}\/\$\{encodeURIComponent\(region\)\}$/.test(u),
          ),
          `the page asks the kernel for the entries, got: ${JSON.stringify(fetched)}`,
        );
        assert(html.includes('showMemory'), 'the page has a memory view');
        assert(html.includes('记忆'), 'the memory view has a name');
      } finally {
        await dash.close();
        client!.close();
      }
    });

    await checkAsync('cortex memory says plainly that it needs a live kernel', async () => {
      const empty = mkdtempSync(join(tmpdir(), 'cortex-nokernel-'));
      process.env['CORTEX_HOME'] = empty;
      let err = '';
      const prevErr = console.error;
      console.error = (...parts: unknown[]): void => {
        err += parts.map((p) => String(p)).join(' ') + '\n';
      };
      let code: number;
      try {
        code = await cmdMemory(['2']);
      } finally {
        console.error = prevErr;
        rmSync(empty, { recursive: true, force: true });
      }
      assert(code === 1, `exit 1, got ${code}`);
      assert(err.includes('no live kernel'), `the reason is reported, got: ${err.trim()}`);
    });
  } finally {
    process.stdout.write = process.stdout.write;
    for (const server of servers) {
      try {
        await server.close();
      } catch {
        /* teardown is best-effort */
      }
    }
    for (const k of kernels) {
      try {
        await k.shutdown();
      } catch {
        /* teardown is best-effort */
      }
    }
    if (prevHome === undefined) delete process.env['CORTEX_HOME'];
    else process.env['CORTEX_HOME'] = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  }
}

// =============================================================================
// Host-facing wait checks
// =============================================================================

/**
 * A host — a program that boots a kernel — is not in the process tree: the
 * processes it spawns are children of init. So it cannot use the `wait`
 * *syscall* to wait for them (that syscall is parent-child, and its wake-up
 * is enqueued into the parent's run queue, which a host does not have).
 *
 * `Kernel.awaitExit` is the supported way to do it, and these checks pin the
 * three properties that make it usable: it resolves with the *real* exit code
 * (not a default), it still answers after the table entry has been reaped,
 * and it fails loudly on a PID the kernel never knew.
 */
async function runHostWaitChecks(): Promise<void> {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-wait-'));
  const kernels: Kernel[] = [];
  const servers: { close: () => Promise<void> }[] = [];

  const prevHome = process.env['CORTEX_HOME'];

  try {
    await checkAsync('awaitExit resolves with the real exit code of a process', async () => {
      const kernel = await bootKernel({
        kernelAbiVersion: KERNEL_ABI_VERSION,
        dir: tmp,
        autoStart: true,
        loadDrivers: (reg) => {
          reg.registerMemory(inmemMemory());
        },
        agentLoader: async () => async (ctx, args) => {
          const code = typeof args['code'] === 'number' ? args['code'] : undefined;
          if (code !== undefined) {
            ctx.exit(code, 'probe finished');
            return;
          }
          // No exit code asked for: park, so a wait on this one can time out.
          for (;;) {
            try {
              await ctx.recv(undefined, { timeoutMs: 50 });
            } catch (err) {
              if ((err as { errno?: string }).errno !== 'ETIMEDOUT') throw err;
            }
          }
        },
      });
      kernels.push(kernel);

      const pid = await kernel.spawn({
        role: 'probe',
        agent: { module: 'test:probe', args: { code: 3 } },
        memory: { semantic: { kind: 'shared', backing: 'inmem' } },
      });

      const exit = await kernel.awaitExit(pid);
      assert(exit !== undefined, 'the wait resolved');
      assert(exit!.exitCode === 3, `the exit code is 3, got ${String(exit!.exitCode)}`);
      assert(exit!.exitReason === 'probe finished', `the reason, got ${String(exit!.exitReason)}`);
    });

    await checkAsync('awaitExit still answers after the entry has been reaped', async () => {
      const kernel = kernels[0]!;
      const pid = await kernel.spawn({
        role: 'probe2',
        agent: { module: 'test:probe', args: { code: 7 } },
      });
      await kernel.awaitExit(pid);
      // init reaps a process whose parent is init, so the table entry is
      // gone by now — but the *facts* of the exit outlive it. A host that
      // asked a moment too late must still get the real code, not a default.
      const again = await kernel.awaitExit(pid);
      assert(again !== undefined, 'the second wait resolved');
      assert(again!.exitCode === 7, `the same exit code, got ${String(again!.exitCode)}`);
    });

    await checkAsync('awaitExit on a pid the kernel never knew is ESRCH', async () => {
      const kernel = kernels[0]!;
      let caught: unknown = null;
      try {
        await kernel.awaitExit(asProcessId(999999));
      } catch (err) {
        caught = err;
      }
      assert(isCortexError(caught) && caught.errno === 'ESRCH', `expected ESRCH, got ${String(caught)}`);
    });

    await checkAsync('awaitExit gives up when the timeout elapses', async () => {
      const kernel = kernels[0]!;
      const pid = await kernel.spawn({ role: 'sleeper', agent: { module: 'test:sleeper' } });
      const exit = await kernel.awaitExit(pid, { timeoutMs: 50 });
      assert(exit === undefined, 'the wait timed out with nothing to report');
    });

    await checkAsync("the transport's wait command blocks until the process ends", async () => {
      const kernel = kernels[0]!;
      const server = await startKernelServer(kernel, { log: () => {} });
      servers.push(server);
      writeEndpoint(tmp, server.endpoint);

      const probe = await probeKernel(tmp);
      assert(probe.kind === 'live', `probe finds the kernel, got ${probe.kind}`);
      const client = probe.kind === 'live' ? probe.client : undefined;

      const pid = await kernel.spawn({
        role: 'slow',
        agent: { module: 'test:probe', args: { code: 5 } },
      });

      const result = await client!.request<{
        exited: boolean;
        exitCode?: number | null;
        exitReason?: string | null;
      }>('wait', { pid: unbrand(pid) });
      assert(result.exited, 'the process had exited');
      assert(result.exitCode === 5, `the exit code came back, got ${String(result.exitCode)}`);

      // A PID the kernel never knew is refused, not silently "not exited".
      const missing = await client!.requestRaw('wait', { pid: 999999 });
      assert(!missing.ok, 'an unknown pid is refused');
      assert(
        missing.ok === false && missing.error.errno === 'ESRCH',
        `the refusal is ESRCH, got ${missing.ok === false ? missing.error.errno : 'ok'}`,
      );

      client!.close();
    });

    await checkAsync('cortex wait reports the exit code and returns it', async () => {
      process.env['CORTEX_HOME'] = tmp;
      const kernel = kernels[0]!;
      const pid = await kernel.spawn({
        role: 'cli-waited',
        agent: { module: 'test:probe', args: { code: 4 } },
      });

      let out = '';
      const prevWrite = process.stdout.write;
      process.stdout.write = ((chunk: unknown): boolean => {
        out += String(chunk);
        return true;
      }) as unknown as typeof process.stdout.write;
      let code: number;
      try {
        code = await cmdWait([String(unbrand(pid))]);
      } finally {
        process.stdout.write = prevWrite;
      }
      assert(code === 4, `the child's exit code is this command's exit code, got ${code}`);
      assert(out.includes('exited with code 4'), `the exit is reported, got: ${out}`);
    });

    await checkAsync('cortex wait answers for a process that already ended', async () => {
      // No live kernel involved on this path: the exit code was persisted to
      // meta.json when the process died, and that is the answer.
      const done = mkdtempSync(join(tmpdir(), 'cortex-waitdisk-'));
      process.env['CORTEX_HOME'] = done;
      try {
        writeMeta(done, {
          pid: 42,
          ppid: 1,
          pgid: 42,
          role: 'old',
          state: 'zombie',
          exitCode: 9,
          exitReason: 'finished long ago',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastTransitionAt: '2026-01-01T00:00:01.000Z',
          budgetsSpent: { tokensIn: 0, tokensOut: 0, tokensCached: 0, usdSpent: 0, wallTimeMs: 0, syscallCount: 0 },
          budgetsRemaining: { tokens: -1, usd: -1, wallTimeMs: -1 },
          agent: { system: 'old' },
          kernelAbiVersion: KERNEL_ABI_VERSION,
        });

        let out = '';
        const prevWrite = process.stdout.write;
        process.stdout.write = ((chunk: unknown): boolean => {
          out += String(chunk);
          return true;
        }) as unknown as typeof process.stdout.write;
        let code: number;
        try {
          code = await cmdWait(['42']);
        } finally {
          process.stdout.write = prevWrite;
        }
        assert(code === 9, `the recorded exit code, got ${code}`);
        assert(out.includes('exited with code 9'), `the exit is reported, got: ${out}`);
      } finally {
        rmSync(done, { recursive: true, force: true });
      }
    });

    await checkAsync('cortex wait says plainly that it needs a live kernel', async () => {
      const empty = mkdtempSync(join(tmpdir(), 'cortex-waitnokernel-'));
      process.env['CORTEX_HOME'] = empty;
      let err = '';
      const prevErr = console.error;
      console.error = (...parts: unknown[]): void => {
        err += parts.map((p) => String(p)).join(' ') + '\n';
      };
      let code: number;
      try {
        code = await cmdWait(['2']);
      } finally {
        console.error = prevErr;
        rmSync(empty, { recursive: true, force: true });
      }
      assert(code === 1, `exit 1, got ${code}`);
      assert(err.includes('no live kernel'), `the reason is reported, got: ${err.trim()}`);
      assert(!err.includes('exited with code 0'), 'it is not reported as a success');
    });
  } finally {
    for (const server of servers) {
      try {
        await server.close();
      } catch {
        /* teardown is best-effort */
      }
    }
    for (const k of kernels) {
      try {
        await k.shutdown();
      } catch {
        /* teardown is best-effort */
      }
    }
    if (prevHome === undefined) delete process.env['CORTEX_HOME'];
    else process.env['CORTEX_HOME'] = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  }
}

// =============================================================================
// Event-stream checks (the transport carries streams)
// =============================================================================

/**
 * The kernel reports facts as they happen, and a host may watch them.
 *
 * These checks pin the properties that make the stream trustworthy:
 *
 *   - a `record` event is the frame that is **on disk**, at the same
 *     `byteOffset` — a subscriber must not see a different history than
 *     `cortex trace` would read back;
 *   - a `process-exit` event carries the **real** exit code, not a default;
 *   - unsubscribing stops delivery, and a listener that throws cannot break
 *     the kernel (a watcher is a guest);
 *   - the transport pushes those events to a client that asked for them.
 */
async function runEventStreamChecks(): Promise<void> {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-events-'));
  const kernels: Kernel[] = [];
  const servers: { close: () => Promise<void> }[] = [];

  const prevHome = process.env['CORTEX_HOME'];

  try {
    await checkAsync('a subscriber sees a process being born and ending', async () => {
      const kernel = await bootKernel({
        kernelAbiVersion: KERNEL_ABI_VERSION,
        dir: tmp,
        autoStart: true,
        loadDrivers: (reg) => {
          reg.registerMemory(inmemMemory());
        },
        agentLoader: async () => async (ctx, args) => {
          ctx.exit(typeof args['code'] === 'number' ? args['code'] : 0, 'probe finished');
        },
      });
      kernels.push(kernel);

      const events: KernelEvent[] = [];
      kernel.subscribe((event) => {
        events.push(event);
      });

      const pid = await kernel.spawn({
        role: 'watched',
        agent: { module: 'test:probe', args: { code: 6 } },
      });
      await kernel.awaitExit(pid);

      const start = events.find((e) => e.kind === 'process-start' && e.pid === unbrand(pid));
      assert(start !== undefined, 'the birth was reported');
      assert(
        start!.kind === 'process-start' && start!.role === 'watched',
        `the role came with it, got ${JSON.stringify(start)}`,
      );
      assert(
        start!.kind === 'process-start' && start!.ppid === 1,
        `the parent came with it, got ${JSON.stringify(start)}`,
      );

      const exit = events.find((e) => e.kind === 'process-exit' && e.pid === unbrand(pid));
      assert(exit !== undefined, 'the exit was reported');
      assert(
        exit!.kind === 'process-exit' && exit!.exitCode === 6,
        `the REAL exit code came with it, got ${JSON.stringify(exit)}`,
      );
      assert(
        exit!.kind === 'process-exit' && exit!.exitReason === 'probe finished',
        `the reason came with it, got ${JSON.stringify(exit)}`,
      );

      // The event and `awaitExit` are two views of one fact. They must not
      // disagree — and neither of them may invent a zero for an exit code it
      // does not have.
      const awaited = await kernel.awaitExit(pid);
      assert(awaited !== undefined, 'awaitExit answered');
      assert(
        exit!.kind === 'process-exit' && exit!.exitCode === awaited!.exitCode,
        `the event and awaitExit agree on the exit code: ${JSON.stringify(exit)} vs ${JSON.stringify(awaited)}`,
      );
    });

    await checkAsync('a record event is the frame that is on disk, at the same offset', async () => {
      const kernel = kernels[0]!;
      const events: KernelEvent[] = [];
      kernel.subscribe((event) => {
        events.push(event);
      });

      const pid = await kernel.spawn({
        role: 'recorded',
        agent: { module: 'test:probe', args: { code: 0 } },
      });
      await kernel.awaitExit(pid);

      const records = events.filter((e): e is Extract<KernelEvent, { kind: 'record' }> =>
        e.kind === 'record' && e.pid === unbrand(pid),
      );
      assert(records.length > 0, `the syscall frames were reported, got ${records.length}`);

      // The log on disk must contain exactly the frames the subscriber saw,
      // with the same offsets. If these two ever disagree, a live watcher and
      // `cortex trace` are telling different stories.
      const onDisk = await readRecords(join(tmp, 'processes', String(unbrand(pid)), 'log.crec'));
      const fromDisk: SyscallRecord[] = [];
      for await (const rec of onDisk) fromDisk.push(rec);

      assert(
        fromDisk.length === records.length,
        `the same number of frames: ${records.length} pushed, ${fromDisk.length} on disk`,
      );
      const first = records[0]!;
      const diskFirst = fromDisk[0]!;
      assert(
        first.record.byteOffset === diskFirst.byteOffset,
        `the same byte offset: pushed ${first.record.byteOffset}, on disk ${diskFirst.byteOffset}`,
      );
      assert(
        first.record.syscall === diskFirst.syscall && first.record.phase === diskFirst.phase,
        'the same frame',
      );
    });

    await checkAsync('unsubscribing stops delivery', async () => {
      const kernel = kernels[0]!;
      const seen: KernelEvent[] = [];
      const stop = kernel.subscribe((event) => {
        seen.push(event);
      });
      const before = seen.length;
      stop();
      await kernel.spawn({
        role: 'after-unsubscribe',
        agent: { module: 'test:probe', args: { code: 0 } },
      });
      assert(seen.length === before, `no further events arrived, got ${seen.length - before}`);
    });

    await checkAsync('a listener that throws cannot break the kernel', async () => {
      const kernel = kernels[0]!;
      const seen: KernelEvent[] = [];
      kernel.subscribe(() => {
        throw new Error('this watcher is broken');
      });
      kernel.subscribe((event) => {
        seen.push(event);
      });

      const pid = await kernel.spawn({
        role: 'resilient',
        agent: { module: 'test:probe', args: { code: 0 } },
      });
      const exit = await kernel.awaitExit(pid);
      assert(exit !== undefined, 'the process still ran to completion');
      assert(
        seen.some((e) => e.kind === 'process-exit' && e.pid === unbrand(pid)),
        'the other subscriber still got its events',
      );
    });

    await checkAsync('the transport pushes events to a subscribed client', async () => {
      const kernel = kernels[0]!;
      const server = await startKernelServer(kernel, { log: () => {} });
      servers.push(server);
      writeEndpoint(tmp, server.endpoint);

      const probe = await probeKernel(tmp);
      assert(probe.kind === 'live', `probe finds the kernel, got ${probe.kind}`);
      const client = probe.kind === 'live' ? probe.client : undefined;

      const received: unknown[] = [];
      await client!.subscribe((event) => {
        received.push(event);
      });

      const pid = await kernel.spawn({
        role: 'streamed',
        agent: { module: 'test:probe', args: { code: 2 } },
      });
      await kernel.awaitExit(pid);
      // Give the pushed frames a moment to land on the socket.
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert(received.length > 0, `events arrived over the wire, got ${received.length}`);
      const kinds = received.map((e) => (e as { kind?: string }).kind);
      assert(
        kinds.includes('process-exit'),
        `the exit was pushed, got ${JSON.stringify(kinds)}`,
      );
      assert(
        kinds.includes('record'),
        `the syscall frames were pushed, got ${JSON.stringify(kinds)}`,
      );

      const exitEvent = received.find(
        (e) => (e as { kind?: string }).kind === 'process-exit',
      ) as { pid?: number; exitCode?: number | null } | undefined;
      assert(
        exitEvent !== undefined && exitEvent.exitCode === 2,
        `the real exit code crossed the wire, got ${JSON.stringify(exitEvent)}`,
      );

      // A subscriber that asks for a kind that does not exist is refused
      // rather than left waiting for something that can never arrive.
      const bad = await client!.requestRaw('subscribe', { kinds: ['not-a-kind'] });
      assert(!bad.ok, 'an unknown event kind is refused');
      assert(
        bad.ok === false && bad.error.errno === 'EINVAL',
        `the refusal is EINVAL, got ${bad.ok === false ? bad.error.errno : 'ok'}`,
      );

      client!.close();
    });

    await checkAsync('cortex watch prints the events it is given', async () => {
      process.env['CORTEX_HOME'] = tmp;
      const kernel = kernels[0]!;

      let out = '';
      const prevWrite = process.stdout.write;
      process.stdout.write = ((chunk: unknown): boolean => {
        out += String(chunk);
        return true;
      }) as unknown as typeof process.stdout.write;

      // Subscribe first, so the spawn below lands inside the watch window.
      const probe = await probeKernel(tmp);
      const client = probe.kind === 'live' ? probe.client : undefined;
      const received: string[] = [];
      await client!.subscribe((event) => {
        received.push((event as { kind?: string }).kind ?? '?');
      });

      const pid = await kernel.spawn({
        role: 'watched-cli',
        agent: { module: 'test:probe', args: { code: 0 } },
      });
      await kernel.awaitExit(pid);
      await new Promise((resolve) => setTimeout(resolve, 50));
      client!.close();

      // Now the command itself, with a bounded window.
      const code = await cmdWatch(['--timeout-ms', '150']);
      process.stdout.write = prevWrite;

      assert(code === 0, `watch exited cleanly, got ${code}`);
      assert(out.includes('watching the kernel event stream'), `it announced itself, got: ${out}`);
    });

    await checkAsync('cortex watch says plainly that it needs a live kernel', async () => {
      const empty = mkdtempSync(join(tmpdir(), 'cortex-watchnokernel-'));
      process.env['CORTEX_HOME'] = empty;
      let err = '';
      const prevErr = console.error;
      console.error = (...parts: unknown[]): void => {
        err += parts.map((p) => String(p)).join(' ') + '\n';
      };
      let code: number;
      try {
        code = await cmdWatch([]);
      } finally {
        console.error = prevErr;
        rmSync(empty, { recursive: true, force: true });
      }
      assert(code === 1, `exit 1, got ${code}`);
      assert(err.includes('no live kernel'), `the reason is reported, got: ${err.trim()}`);
    });
  } finally {
    for (const server of servers) {
      try {
        await server.close();
      } catch {
        /* teardown is best-effort */
      }
    }
    for (const k of kernels) {
      try {
        await k.shutdown();
      } catch {
        /* teardown is best-effort */
      }
    }
    if (prevHome === undefined) delete process.env['CORTEX_HOME'];
    else process.env['CORTEX_HOME'] = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  }
}

// =============================================================================
// Supervision checks (cortex supervise)
// =============================================================================

/**
 * The shell supervising a live agent.
 *
 * The interesting property here is **how a stall is detected**. Not by
 * silence — an agent parked in `recv()`, or one deep in a long LLM call, is
 * quiet but not stuck. The syscall log knows the difference: every syscall is
 * an `enter` frame and an `exit`/`trap` frame with the same `callId`, so a
 * process that entered a syscall and never came out of it is *inside* that
 * syscall, and has been for exactly as long as the gap.
 *
 * These checks pin the three things that have to be true for the supervisor
 * to be worth having: it kills a process that is genuinely stuck, it leaves a
 * process that is legitimately waiting alone, and it reports a normal ending
 * with the process's own exit code.
 */
async function runSuperviseChecks(): Promise<void> {
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-supervise-'));
  const kernels: Kernel[] = [];
  const servers: { close: () => Promise<void> }[] = [];

  const prevHome = process.env['CORTEX_HOME'];
  const prevLog = console.log;
  const prevErr = console.error;

  try {
    const kernel = await bootKernel({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      dir: tmp,
      autoStart: true,
      loadDrivers: (reg) => {
        reg.registerMemory(inmemMemory());
      },
      agentLoader: async () => async (ctx, args) => {
        const mode = typeof args['mode'] === 'string' ? args['mode'] : 'ok';
        if (mode === 'stuck') {
          // Blocks forever. The `enter` frame is written; the matching exit
          // never is — which is exactly what a stall looks like in the log.
          await ctx.recv();
          return;
        }
        if (mode === 'spawner') {
          // Spawns a child that gets stuck, kills it, and stays alive.
          //
          // Two things make this the scenario it is:
          //
          //   - a **live parent** means the child's zombie is not reaped (the
          //     kernel does not reap a zombie somebody may still wait() for),
          //     so its ending is still a fact the table holds;
          //   - it is killed with a **signal**, not an exit: a process that
          //     exits is reaped from the table by the dispatcher right away
          //     (its status is retained for the parent's wait()), so only a
          //     signalled death leaves a zombie behind.
          const child = await ctx.spawn({
            role: 'doomed',
            agent: { module: 'test:stuck', args: { mode: 'stuck' } },
          });
          await ctx.kill(child.pid, 'SIGKILL');
          await ctx.sleep(30000);
          return;
        }
        if (mode === 'sleeper') {
          // A declared wait. Long, but not stuck.
          await ctx.sleep(900);
          ctx.exit(0, 'slept');
          return;
        }
        if (mode === 'quiet') {
          // One ordinary call, then a long stretch of pure JavaScript with
          // no syscall at all. The call *closed*, so the process is not inside
          // anything — a supervisor that could not pair the `enter` and the
          // `trap` would still think it was stuck inside that call.
          try {
            await ctx.recv(undefined, { timeoutMs: 50 });
          } catch (err) {
            if ((err as { errno?: string }).errno !== 'ETIMEDOUT') throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, 1200));
          ctx.exit(0, 'quiet but fine');
          return;
        }
        if (mode === 'busy') {
          // Busy, but making progress: a `recv` that times out every 100 ms.
          // Each one opens a call and closes it again, so the process is
          // never *inside* one syscall for long — and must never be killed.
          for (let i = 0; i < 12; i += 1) {
            try {
              await ctx.recv(undefined, { timeoutMs: 100 });
            } catch (err) {
              if ((err as { errno?: string }).errno !== 'ETIMEDOUT') throw err;
            }
          }
          ctx.exit(0, 'busy but fine');
          return;
        }
        if (mode === 'fail') {
          ctx.exit(1, 'failed on purpose');
          return;
        }
        ctx.exit(0, 'all good');
      },
    });
    kernels.push(kernel);

    const server = await startKernelServer(kernel, { log: () => {} });
    servers.push(server);
    writeEndpoint(tmp, server.endpoint);
    process.env['CORTEX_HOME'] = tmp;

    const capture = async (
      run: () => Promise<number>,
    ): Promise<{
      code: number;
      out: string;
      err: string;
      /** Each write, with the moment it happened. */
      marks: { at: number; text: string }[];
    }> => {
      let out = '';
      let err = '';
      const marks: { at: number; text: string }[] = [];
      const prevWrite = process.stdout.write;
      process.stdout.write = ((chunk: unknown): boolean => {
        const text = String(chunk);
        out += text;
        marks.push({ at: Date.now(), text });
        return true;
      }) as unknown as typeof process.stdout.write;
      console.error = (...parts: unknown[]): void => {
        err += parts.map((p) => String(p)).join(' ') + '\n';
      };
      try {
        const code = await run();
        return { code, out, err, marks };
      } finally {
        process.stdout.write = prevWrite;
        console.error = prevErr;
      }
    };

    await checkAsync('cortex supervise kills a process that is genuinely stuck', async () => {
      const pid = await kernel.spawn({
        role: 'stuck',
        agent: { module: 'test:stuck', args: { mode: 'stuck' } },
      });

      const result = await capture(() =>
        cmdSupervise([String(unbrand(pid)), '--kill-after', '300']),
      );

      assert(
        result.out.includes('has been inside recv'),
        `the stall was noticed, got: ${result.out}`,
      );
      assert(
        result.out.includes(`pid ${unbrand(pid)} exited`),
        `the ending was reported, got: ${result.out}`,
      );
      assert(
        result.code === 124,
        `the supervisor reports that it intervened (124), got ${result.code}`,
      );

      // And the process really is gone — the supervisor did not just report.
      const stillThere = kernel.table.get(pid);
      assert(
        stillThere === undefined || stillThere.state === 'zombie',
        `the stuck process is not running, got ${stillThere?.state ?? 'gone'}`,
      );
    });

    await checkAsync('cortex supervise notices a process that was already stuck', async () => {
      const pid = await kernel.spawn({
        role: 'stuck-early',
        agent: { module: 'test:stuck', args: { mode: 'stuck' } },
      });

      // Let it get properly stuck *before* the supervisor starts. The
      // `recv`'s `enter` frame is now in the past — the stream cannot tell
      // the supervisor about it, so the kernel has to: it is the one that
      // wrote the frame and knows which pairs are still open.
      await new Promise((resolve) => setTimeout(resolve, 400));

      const result = await capture(() =>
        cmdSupervise([String(unbrand(pid)), '--kill-after', '300', '--timeout-ms', '15000']),
      );

      assert(
        result.out.includes('is already inside recv'),
        `the supervisor found the call the process was already in, got: ${result.out}`,
      );
      assert(
        result.out.includes('has been inside recv'),
        `the stall was noticed, got: ${result.out}`,
      );
      assert(
        result.code === 124,
        `the supervisor reports that it intervened (124), got ${result.code}`,
      );
    });

    await checkAsync('cortex supervise finds the call even when the log says nothing', async () => {
      const pid = await kernel.spawn({
        role: 'stuck-mute',
        agent: { module: 'test:stuck', args: { mode: 'stuck' } },
      });

      // Let it get properly stuck, then empty the log under it. The `enter`
      // frame the answer used to be read from is gone, and the stream has
      // nothing to say (the frame predates the subscription) — so the kernel
      // is the only place left that can answer.
      await new Promise((resolve) => setTimeout(resolve, 400));

      const result = await withEmptiedLog(tmp, unbrand(pid), () =>
        capture(() =>
          cmdSupervise([String(unbrand(pid)), '--kill-after', '999999999', '--timeout-ms', '300']),
        ),
      );

      assert(
        result.out.includes('is already inside recv'),
        `the supervisor found the call the process was already in, got: ${result.out}`,
      );
      assert(
        result.code === 1,
        `the supervisor gives up at its own bound, got ${result.code}`,
      );
    });

    await checkAsync('cortex supervise leaves a process that is legitimately waiting alone', async () => {
      const pid = await kernel.spawn({
        role: 'sleeper',
        agent: { module: 'test:sleeper', args: { mode: 'sleeper' } },
      });

      // The sleeper waits 900ms; the threshold is 300ms. A sleep is a
      // declared wait, so the supervisor must not call it a stall.
      const result = await capture(() =>
        cmdSupervise([String(unbrand(pid)), '--kill-after', '300']),
      );

      assert(
        !result.out.includes('has been inside sleep'),
        `the sleep was not called a stall, got: ${result.out}`,
      );
      assert(
        result.out.includes(`pid ${unbrand(pid)} exited with code 0`),
        `the normal ending was reported, got: ${result.out}`,
      );
      assert(
        result.code === 0,
        `the supervisor returns the process's own exit code, got ${result.code}`,
      );
    });

    await checkAsync('cortex supervise leaves a process that is making progress alone', async () => {
      const pid = await kernel.spawn({
        role: 'busy',
        agent: { module: 'test:busy', args: { mode: 'busy' } },
      });

      // The agent does a `recv` that times out every 100 ms. Each call opens
      // and closes, so it is never inside one syscall for long — a supervisor
      // that could not pair the `enter` and `trap` frames would call this a
      // stall and kill a process that was working fine.
      const result = await capture(() =>
        cmdSupervise([String(unbrand(pid)), '--kill-after', '300']),
      );

      assert(
        !result.out.includes('has been inside'),
        `the busy process was not called a stall, got: ${result.out}`,
      );
      assert(
        result.out.includes(`pid ${unbrand(pid)} exited with code 0`),
        `it was left to finish, got: ${result.out}`,
      );
      assert(result.code === 0, `exit 0, got ${result.code}`);
    });

    await checkAsync('cortex supervise leaves a process that is making progress alone', async () => {
      const pid = await kernel.spawn({
        role: 'quiet',
        agent: { module: 'test:quiet', args: { mode: 'quiet' } },
      });

      // The agent makes one call, then computes in pure JavaScript for well
      // over the threshold. The call *closed*, so the process is not inside
      // anything — a supervisor that kept the call open after its closing
      // frame would kill a process that was working fine.
      const result = await capture(() =>
        cmdSupervise([String(unbrand(pid)), '--kill-after', '300']),
      );

      assert(
        !result.out.includes('has been inside'),
        `the quiet process was not called a stall, got: ${result.out}`,
      );
      assert(
        result.out.includes(`pid ${unbrand(pid)} exited with code 0`),
        `it was left to finish, got: ${result.out}`,
      );
      assert(result.code === 0, `exit 0, got ${result.code}`);
    });

    await checkAsync('cortex supervise reports the exit code of a process that failed', async () => {
      const pid = await kernel.spawn({
        role: 'failing',
        agent: { module: 'test:fail', args: { mode: 'fail' } },
      });

      const result = await capture(() =>
        cmdSupervise([String(unbrand(pid)), '--kill-after', '5000']),
      );

      assert(
        result.out.includes(`pid ${unbrand(pid)} exited with code 1`),
        `the failure was reported, got: ${result.out}`,
      );
      assert(
        result.code === 1,
        `the supervisor returns the process's own exit code, got ${result.code}`,
      );
    });

    await checkAsync('cortex supervise --restart puts a fresh process in place', async () => {
      const pid = await kernel.spawn({
        role: 'restartable',
        agent: { module: 'test:fail', args: { mode: 'fail' } },
      });

      // The supervisor restarts from the spec that was persisted when the
      // process was created (the CLI writes it; a host kernel does not).
      writeSpec(tmp, {
        pid: unbrand(pid),
        ppid: 1,
        role: 'restartable',
        agent: { module: 'test:fail', args: { mode: 'fail' } },
        memory: {},
        startedAt: '2026-01-01T00:00:00.000Z',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });

      const result = await capture(() =>
        cmdSupervise([
          String(unbrand(pid)),
          '--restart',
          '--max-restarts',
          '1',
          '--backoff-ms',
          '10',
          '--kill-after',
          '5000',
        ]),
      );

      assert(
        result.out.includes('restarted as pid'),
        `a fresh process was started, got: ${result.out}`,
      );
      const restarted = /restarted as pid (\d+)/.exec(result.out);
      assert(restarted !== null, `the new pid is reported, got: ${result.out}`);
      const newPid = Number(restarted![1]);
      assert(newPid !== unbrand(pid), 'the new process has a new pid');
      // The fresh process fails immediately, so it is already gone by now —
      // init reaps it. What proves it *ran* is its own log on disk.
      const newLog = join(tmp, 'processes', String(newPid), 'log.crec');
      assert(
        existsSync(newLog),
        `the new process really ran (its log is at ${newLog})`,
      );
      assert(
        result.code === 1,
        `the supervisor returns the last exit code, got ${result.code}`,
      );
    });

    await checkAsync('cortex supervise refuses a pid the kernel does not have', async () => {
      const result = await capture(() => cmdSupervise(['999999', '--kill-after', '300']));
      assert(result.code === 1, `exit 1, got ${result.code}`);
      assert(
        result.err.includes('no such process'),
        `the reason is reported, got: ${result.err.trim()}`,
      );
    });

    await checkAsync('cortex supervise reacts to the ending as it happens', async () => {
      // The supervisor's whole job is to answer "what happened to this
      // agent" — and the kernel answers it the moment it happens. A
      // supervisor that decides on a timer is late by up to a tick, and a
      // tick is a quarter of a second of the agent's life nobody was
      // watching.
      // The subscription opens **before** the process is spawned: the kernel
      // pushes an event to the subscribers it has *now*, and this agent fails
      // immediately — a subscription that opened after the spawn could miss the
      // very event it is waiting for, and the check would then be reporting on
      // its own timing rather than on the behaviour. (It is the same rule the
      // supervisor itself follows: subscribe first, then read the state.)
      const exits = new Map<number, number>();
      const off = kernel.subscribe((event) => {
        if (event.kind === 'process-exit') exits.set(event.pid, Date.now());
      });

      const pid = await kernel.spawn({
        role: 'reactor',
        agent: { module: 'test:fail', args: { mode: 'fail' } },
      });

      const result = await capture(() =>
        cmdSupervise([String(unbrand(pid)), '--kill-after', '5000']),
      );
      off();

      assert(
        result.out.includes(`pid ${unbrand(pid)} exited with code 1`),
        `the ending was reported, got: ${result.out}`,
      );
      const exitedAt = exits.get(unbrand(pid));
      assert(exitedAt !== undefined, 'the kernel reported the ending');
      const reactedAt = result.marks.find((m) => m.text.includes('exited with code'))?.at;
      assert(reactedAt !== undefined, `the supervisor's line was written, got: ${result.out}`);
      assert(
        reactedAt - exitedAt! < 150,
        `the supervisor reacted in ${reactedAt - exitedAt!}ms — it must not wait for a tick`,
      );
    });

    await checkAsync('cortex supervise kills at the threshold, not a tick later', async () => {
      const pid = await kernel.spawn({
        role: 'stuck-threshold',
        agent: { module: 'test:stuck', args: { mode: 'stuck' } },
      });

      const result = await capture(() =>
        cmdSupervise([String(unbrand(pid)), '--kill-after', '300']),
      );

      const killed = /has been inside recv for (\d+)ms/.exec(result.out);
      assert(killed !== null, `the stall was noticed, got: ${result.out}`);
      const stuckMs = Number(killed![1]);
      // The threshold is 300 ms. A supervisor that decides on a tick kills it
      // up to a tick late; one that decides on the deadline kills it at the
      // threshold. The number it prints is the difference.
      assert(
        stuckMs <= 400,
        `it was killed at ${stuckMs}ms — the threshold is 300ms, and a tick later is not the threshold`,
      );
    });

    await checkAsync('cortex supervise reports an ending that has already happened', async () => {
      // A process whose parent is still alive stays a **zombie**: the kernel
      // does not reap a zombie somebody may still wait() for. Its
      // `process-exit` event has been and gone, so a supervisor that waits
      // for that event waits for something that will never arrive. It has to
      // read the ending out of the table instead.
      await kernel.spawn({
        role: 'spawner',
        agent: { module: 'test:spawner', args: { mode: 'spawner' } },
      });

      let doomed: number | undefined;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        for (const entry of kernel.table.list()) {
          if (entry.role === 'doomed') {
            doomed = unbrand(entry.pid);
            break;
          }
        }
        if (doomed !== undefined) {
          const state = kernel.table.get(asProcessId(doomed))?.state;
          if (state === 'zombie') break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      assert(
        doomed !== undefined,
        `the child was spawned; table=${kernel.table.list().map((e) => `${e.pid}:${e.role}:${e.state}`).join(',')}`,
      );
      assert(
        kernel.table.get(asProcessId(doomed))?.state === 'zombie',
        `the child is a zombie, got ${kernel.table.get(asProcessId(doomed))?.state ?? 'gone'}`,
      );

      const result = await capture(() =>
        cmdSupervise([String(doomed), '--kill-after', '5000', '--timeout-ms', '5000']),
      );

      assert(
        result.out.includes(`pid ${doomed} exited with code 137`),
        `the ending was reported, got: ${result.out}`,
      );
      assert(
        result.code === 137,
        `the supervisor returns the process's own exit code, got ${result.code}`,
      );
    });

    await checkAsync('the supervisor knows when it next has to look', async () => {
      // The rule, pinned on its own: the timing of a supervisor's decisions
      // is not something an end-to-end test can be relied on to land in.
      const base = {
        openCall: undefined,
        killAfterMs: null,
        terminating: false,
        terminateDeadline: 0,
        timeoutMs: null,
        startedAt: 1000,
      };
      assert(
        nextDeadline(base) === undefined,
        'with nothing that can change, the supervisor sleeps until the kernel says something',
      );
      const call = { callId: 'c1', syscall: 'recv', since: 5000 };
      assert(
        nextDeadline({ ...base, openCall: call, killAfterMs: 300 }) === 5300,
        `the stall threshold is the deadline, got ${nextDeadline({ ...base, openCall: call, killAfterMs: 300 })}`,
      );
      const sleeping = { callId: 'c2', syscall: 'sleep', since: 5000 };
      assert(
        nextDeadline({ ...base, openCall: sleeping, killAfterMs: 300 }) === undefined,
        'a sleep is a declared wait, so it has no deadline',
      );
      assert(
        nextDeadline({ ...base, timeoutMs: 500 }) === 1500,
        `the operator's timeout is a deadline, got ${nextDeadline({ ...base, timeoutMs: 500 })}`,
      );
      assert(
        nextDeadline({ ...base, terminating: true, terminateDeadline: 7000, timeoutMs: 500 }) ===
          7000,
        'a termination in flight is not cut short by the operator timeout',
      );
    });

    await checkAsync('cortex supervise says plainly that it needs a live kernel', async () => {
      const empty = mkdtempSync(join(tmpdir(), 'cortex-supervisenokernel-'));
      process.env['CORTEX_HOME'] = empty;
      const result = await capture(() => cmdSupervise(['2', '--kill-after', '300']));
      rmSync(empty, { recursive: true, force: true });
      assert(result.code === 1, `exit 1, got ${result.code}`);
      assert(
        result.err.includes('no live kernel'),
        `the reason is reported, got: ${result.err.trim()}`,
      );
    });

    await checkAsync('cortex supervise refuses an option it cannot make sense of', async () => {
      const result = await capture(() => cmdSupervise(['2', '--kill-after', 'soon']));
      assert(result.code === 1, `exit 1, got ${result.code}`);
      assert(
        result.err.includes('invalid --kill-after'),
        `the reason is reported, got: ${result.err.trim()}`,
      );
    });
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    for (const server of servers) {
      try {
        await server.close();
      } catch {
        /* teardown is best-effort */
      }
    }
    for (const k of kernels) {
      try {
        await k.shutdown();
      } catch {
        /* teardown is best-effort */
      }
    }
    if (prevHome === undefined) delete process.env['CORTEX_HOME'];
    else process.env['CORTEX_HOME'] = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  }
}

// =============================================================================
// Capability inheritance checks (#063)
// =============================================================================

/**
 * A replacement must be the *same* agent.
 *
 * `cortex supervise --restart` rebuilds a dead agent from the spec that was
 * persisted when it was born. That spec used to carry only the role, the
 * module and the memory policies — so a restricted agent came back holding
 * **every** capability, and the supervisor said nothing about it: "the same
 * agent, restarted" quietly became "a stronger agent".
 *
 * These checks pin the whole chain: the host persists the authority, the
 * spec reads it back, the exit record says what the agent could do, the
 * supervisor's replacement is no stronger than the one it replaces — and a
 * spec that *cannot* say is refused rather than guessed at.
 */
async function runCapabilityInheritanceChecks(): Promise<void> {
  const { mkdtempSync, rmSync, writeFileSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-caps-'));

  const prevHome = process.env['CORTEX_HOME'];
  const prevLog = console.log;
  const prevErr = console.error;

  // An agent that ends on its own, so a supervisor has something to replace.
  // It also says what it holds — the agent's own view of its authority.
  const modulePath = join(tmp, 'short-agent.ts');
  writeFileSync(
    modulePath,
    'export default async function shortAgent(ctx: any): Promise<void> {\n' +
      "  console.log(`I hold [${ctx.caps().join(',')}]`);\n" +
      '  await ctx.sleep(150);\n' +
      "  ctx.exit(7, 'done on purpose');\n" +
      '}\n',
    'utf8',
  );

  /** Run a command with its stdout and stderr captured. */
  const capture = async (
    run: () => Promise<number>,
  ): Promise<{ code: number; out: string; err: string }> => {
    let out = '';
    let err = '';
    const prevWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown): boolean => {
      out += String(chunk);
      return true;
    }) as unknown as typeof process.stdout.write;
    console.error = (...parts: unknown[]): void => {
      err += parts.map((p) => String(p)).join(' ') + '\n';
    };
    try {
      const code = await run();
      return { code, out, err };
    } finally {
      process.stdout.write = prevWrite;
      console.error = prevErr;
    }
  };

  /** Wait until a process's exit record lands on disk. */
  const waitForMeta = async (
    pid: number,
    timeoutMs = 5000,
  ): Promise<ProcessMeta | undefined> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const meta = readMeta(tmp, asProcessId(pid));
      if (meta !== undefined) return meta;
      if (Date.now() > deadline) return undefined;
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  try {
    await checkAsync("a process's spec remembers the authority it was born with", async () => {
      const kernel = await bootCliKernel(tmp);
      try {
        const pid = unbrand(
          await kernel.spawn({
            role: 'limited',
            agent: { module: pathToFileURL(modulePath).href },
            capabilities: ['spawn'],
          }),
        );
        const spec = readSpec(tmp, asProcessId(pid));
        assert(spec !== undefined, 'the spec was persisted when the process was born');
        const caps = spec!.capabilities;
        assert(
          caps !== undefined && caps !== null && caps.length === 1 && caps[0] === 'spawn',
          `the spec records the narrowed capability set, got: ${JSON.stringify(caps)}`,
        );
        assert(
          spec!.grantable !== undefined && spec!.grantable.length === 0,
          `the spec records the escalation pool, got: ${JSON.stringify(spec!.grantable)}`,
        );
        assert(
          spec!.budgets !== undefined,
          'the spec records the budget ceiling it was born with',
        );
        // The file itself, not just the reader: a spec that cannot say what
        // the process could do is a spec that cannot replace it.
        const raw = JSON.parse(readFileSync(specPath(tmp, asProcessId(pid)), 'utf8'));
        assert(
          Array.isArray(raw.capabilities) && raw.capabilities[0] === 'spawn',
          `the spec on disk carries the capability set, got: ${JSON.stringify(raw.capabilities)}`,
        );
      } finally {
        await kernel.shutdown();
      }
    });

    await checkAsync('the exit record says what the agent was allowed to do', async () => {
      const kernel = await bootCliKernel(tmp);
      try {
        const pid = unbrand(
          await kernel.spawn({
            role: 'limited',
            agent: { module: pathToFileURL(modulePath).href },
            capabilities: ['spawn'],
          }),
        );
        const meta = await waitForMeta(pid);
        assert(meta !== undefined, 'the exit record was written');
        assert(
          meta!.capabilities !== undefined &&
            meta!.capabilities.length === 1 &&
            meta!.capabilities[0] === 'spawn',
          `the exit record carries the capability set, got: ${JSON.stringify(meta!.capabilities)}`,
        );
      } finally {
        await kernel.shutdown();
      }
    });

    await checkAsync('a replacement is the same agent, not a stronger one', async () => {
      const kernel = await bootCliKernel(tmp);
      const server = await startKernelServer(kernel, { log: () => {} });
      try {
        writeEndpoint(tmp, server.endpoint);
        process.env['CORTEX_HOME'] = tmp;
        const probe = await probeKernel(tmp);
        assert(probe.kind === 'live', `the kernel is reachable, got ${probe.kind}`);
        const client = probe.kind === 'live' ? probe.client : undefined;

        const spawned = await client!.request<{ pid: number }>('spawn', {
          role: 'limited',
          agent: { module: pathToFileURL(modulePath).href },
          capabilities: ['spawn'],
        });
        const originalPid = spawned.pid;

        const result = await capture(() =>
          cmdSupervise([
            String(originalPid),
            '--restart',
            '--max-restarts',
            '1',
            '--backoff-ms',
            '0',
          ]),
        );
        assert(
          result.out.includes('caps=spawn'),
          `the supervisor said what the replacement may do, got: ${result.out}`,
        );
        const restarted = /# restarted as pid (\d+)/.exec(result.out);
        assert(restarted !== null, `the supervisor replaced the agent, got: ${result.out}`);
        const newPid = Number(restarted![1]);

        // The kernel's own record of the replacement says what it held. (The
        // process table cannot answer this: a short agent is reaped and gone
        // from the table by the time the supervisor is finished, and the
        // record that outlives it is the one written on the way out.)
        const meta = await waitForMeta(newPid);
        assert(meta !== undefined, 'the replacement wrote its exit record');
        assert(
          meta!.capabilities !== undefined &&
            meta!.capabilities.length === 1 &&
            meta!.capabilities[0] === 'spawn',
          `the replacement held exactly what the original held, got: ${JSON.stringify(meta!.capabilities)}`,
        );
        // And the spec it was born with says so too — that is what the *next*
        // replacement will be built from.
        const spec = readSpec(tmp, asProcessId(newPid));
        assert(spec !== undefined, 'the replacement has a spec of its own');
        const caps = spec!.capabilities;
        assert(
          caps !== undefined && caps !== null && caps.length === 1 && caps[0] === 'spawn',
          `the replacement's spec records the same authority, got: ${JSON.stringify(caps)}`,
        );
        client!.close();
      } finally {
        await server.close();
        await kernel.shutdown();
      }
    });

    await checkAsync('the operator can hold the replacement to less', async () => {
      const kernel = await bootCliKernel(tmp);
      const server = await startKernelServer(kernel, { log: () => {} });
      try {
        writeEndpoint(tmp, server.endpoint);
        process.env['CORTEX_HOME'] = tmp;
        const probe = await probeKernel(tmp);
        assert(probe.kind === 'live', `the kernel is reachable, got ${probe.kind}`);
        const client = probe.kind === 'live' ? probe.client : undefined;

        const spawned = await client!.request<{ pid: number }>('spawn', {
          role: 'limited',
          agent: { module: pathToFileURL(modulePath).href },
          capabilities: ['spawn'],
        });

        const result = await capture(() =>
          cmdSupervise([
            String(spawned.pid),
            '--restart',
            '--restart-as',
            'none',
            '--max-restarts',
            '1',
            '--backoff-ms',
            '0',
          ]),
        );
        assert(
          result.out.includes('caps=no capability'),
          `the supervisor said what it did, got: ${result.out}`,
        );
        const restarted = /# restarted as pid (\d+)/.exec(result.out);
        assert(restarted !== null, `the agent was replaced, got: ${result.out}`);
        const meta = await waitForMeta(Number(restarted![1]));
        assert(meta !== undefined, 'the replacement wrote its exit record');
        assert(
          meta!.capabilities !== undefined && meta!.capabilities.length === 0,
          `the replacement holds nothing, got: ${JSON.stringify(meta!.capabilities)}`,
        );
        client!.close();
      } finally {
        await server.close();
        await kernel.shutdown();
      }
    });

    await checkAsync('the supervisor says so when it has to assume the authority', async () => {
      // A spec written by a build that did not record capabilities, and no
      // exit record to fall back on. Nothing can say what the agent was
      // allowed to do — so the replacement gets the documented default, and
      // the supervisor says that it had to assume.
      const spec: ProcessSpec = {
        pid: 2,
        ppid: 1,
        role: 'limited',
        agent: { module: 'file:///nowhere.ts' },
        startedAt: '2026-01-01T00:00:00.000Z',
        kernelAbiVersion: KERNEL_ABI_VERSION,
      };
      const assumed = decideAuthority(spec, undefined, 'same');
      assert(
        assumed.assumed === true,
        'the decision is marked as an assumption, not a fact',
      );
      assert(
        assumed.capabilities === undefined,
        'the replacement is unnarrowed — the documented default',
      );
      assert(
        decideAuthority(spec, undefined, 'full')?.assumed !== true,
        'the operator can still insist on full privileges',
      );
      assert(
        decideAuthority(spec, undefined, 'none')?.capabilities?.length === 0,
        'the operator can still insist on no privileges',
      );

      // The kernel's exit record is the fallback for a spec that cannot say.
      const meta = {
        pid: 2,
        ppid: 1,
        pgid: 1,
        role: 'limited',
        state: 'zombie',
        exitCode: 7,
        exitReason: 'done',
        startedAt: '2026-01-01T00:00:00.000Z',
        lastTransitionAt: '2026-01-01T00:00:01.000Z',
        budgetsSpent: {
          tokensIn: 0,
          tokensOut: 0,
          tokensCached: 0,
          usdSpent: 0,
          wallTimeMs: 0,
          syscallCount: 0,
        },
        budgetsRemaining: { tokens: -1, usd: -1, wallTimeMs: -1 },
        agent: { module: 'file:///nowhere.ts' },
        capabilities: ['spawn'],
        kernelAbiVersion: KERNEL_ABI_VERSION,
      } as unknown as ProcessMeta;
      const fromRecord = decideAuthority(spec, meta, 'same');
      assert(
        fromRecord.assumed !== true &&
          fromRecord.capabilities?.length === 1 &&
          fromRecord.capabilities[0] === 'spawn',
        `the kernel's exit record answers what the spec cannot, got: ${JSON.stringify(fromRecord.capabilities)}`,
      );

      // And a spec that *can* say wins over the exit record: it remembers
      // whether the process was unnarrowed, which the record cannot.
      const withCaps: ProcessSpec = { ...spec, capabilities: ['kill'] };
      const decided = decideAuthority(withCaps, meta, 'same');
      assert(
        decided.capabilities?.length === 1 && decided.capabilities[0] === 'kill',
        `the spec is the recipe, got: ${JSON.stringify(decided.capabilities)}`,
      );
      const unnarrowed: ProcessSpec = { ...spec, capabilities: null };
      assert(
        decideAuthority(unnarrowed, meta, 'same').capabilities === undefined,
        'an unnarrowed process stays unnarrowed',
      );
    });
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    if (prevHome === undefined) delete process.env['CORTEX_HOME'];
    else process.env['CORTEX_HOME'] = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  }
}

// =============================================================================
// `cortex top` checks (#059)
// =============================================================================

/**
 * The row a process is on, in `cortex top`'s output.
 *
 * The tree markers are not word characters, so "starts with non-words, then
 * the pid" finds the row and not the header or the summary line.
 */
function topRow(out: string, pid: number): string {
  const re = new RegExp(`^[^\\w]*${pid}\\s`);
  return out.split('\n').find((line) => re.test(line)) ?? '';
}

/**
 * The cell in one column of one row of `cortex top`'s tree.
 *
 * The column is found by its **position** in the header — the header and the
 * rows are rendered from one column list, so their offsets line up — and the
 * cell is the text at that offset. Looking the column up by name in the row
 * would find a *value* that happens to be spelled like the header, and a row
 * whose value is `41s` would answer a question about a column called `41s`.
 */
function topCell(out: string, pid: number, column: string): string {
  const header = out.split('\n').find((l) => l.includes('PID') && l.includes('ROLE'));
  if (header === undefined) return '';
  const at = header.indexOf(column);
  if (at < 0) return '';
  const row = topRow(out, pid);
  if (row === '') return '';
  return row.slice(at).trim().split(/\s{2,}/)[0] ?? '';
}

/**
 * The row a process is on, in `cortex ps`'s output.
 *
 * The table is indented by nothing and starts with the pid, so the first
 * number on the line is the pid.
 */
function psRow(out: string, pid: number): string {
  const re = new RegExp(`^\\s*${pid}\\s`);
  return out.split('\n').find((line) => re.test(line)) ?? '';
}

/**
 * Empty a process's log for the duration of one call, and put it back after.
 *
 * The point is to ask the kernel a question the log used to answer. With the
 * log emptied, the only thing that can still say "this process is inside
 * `recv`" is the kernel itself — which is where the answer comes from now.
 *
 * The recorder holds the file open in append mode, and libuv opens with
 * `FILE_SHARE_WRITE`, so truncating it from here is allowed; the processes
 * these fixtures park are stuck inside a syscall and write nothing more, so
 * nothing lands in the hole.
 */
async function withEmptiedLog<T>(dir: string, pid: number, run: () => Promise<T>): Promise<T> {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const path = existingCrecPath(dir, asProcessId(pid));
  const original = readFileSync(path);
  try {
    writeFileSync(path, Buffer.alloc(0));
    return await run();
  } finally {
    writeFileSync(path, original);
  }
}

/**
 * `cortex top` — the view that tells the operator what is stuck.
 *
 * The process table cannot answer this. A listener parked on a channel and an
 * agent that will never be answered both read as `blocked`, both read as
 * "waiting on a channel"; the difference is how long, and the difference is
 * only in the log. So `top` reads the same log `cortex supervise` reads.
 */
async function runTopChecks(): Promise<void> {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-top-'));
  const kernels: Kernel[] = [];
  const servers: { close: () => Promise<void> }[] = [];

  const prevHome = process.env['CORTEX_HOME'];
  const prevLog = console.log;
  const prevErr = console.error;

  try {
    const kernel = await bootKernel({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      dir: tmp,
      autoStart: true,
      loadDrivers: (reg) => {
        reg.registerMemory(inmemMemory());
        // A model call that takes half a minute. The driver is the point: a
        // process inside one is **not** blocked — the kernel does not park a
        // process while a driver call is in flight — so the process table
        // alone can only say `running`.
        reg.registerLLM(mockLLM({ latencyMs: 30_000 }));
      },
      agentLoader: async () => async (ctx, args) => {
        const mode = typeof args['mode'] === 'string' ? args['mode'] : 'ok';
        if (mode === 'wedged') {
          // A `recv` with no timeout: the call opens and never closes. This
          // is what a stall looks like in the log — an `enter` frame with no
          // partner.
          await ctx.recv();
          return;
        }
        if (mode === 'listener') {
          // A `recv` that times out every 100ms. Each call opens and closes,
          // so the process is never inside one call for long — it is waiting,
          // but it is making progress, and must never be called stuck.
          for (let i = 0; i < 40; i += 1) {
            try {
              await ctx.recv(undefined, { timeoutMs: 100 });
            } catch (err) {
              if ((err as { errno?: string }).errno !== 'ETIMEDOUT') throw err;
            }
          }
          ctx.exit(0, 'listened');
          return;
        }
        if (mode === 'parallel') {
          // Two syscalls in flight at once. The second is handed to the
          // dispatcher before the first has parked the process, so both are
          // admitted; the second then traps (the process is no longer
          // RUNNING) and the catch swallows it. What is left is a process
          // inside one call, with the *other* call's frame already closed —
          // which is the case a one-slot-per-process bookkeeping gets wrong.
          await Promise.all([ctx.sleep(5000), ctx.recv().catch(() => undefined)]);
          return;
        }
        if (mode === 'thinking') {
          // A model call that takes half a minute. The process is *running*
          // the whole time — not blocked — so nothing in the process table
          // says what it is doing. This is the case BACKLOG #060 is about.
          await ctx.llm_call({ messages: [{ role: 'user', content: 'think' }] });
          return;
        }
        if (mode === 'waiter') {
          // A planner waiting on a child, with a deadline. The wait is a
          // *declared* wait — it ends whether or not the child does — so a
          // supervisor that called it stuck would be killing the supervisor.
          const child = await ctx.spawn({
            role: 'child',
            agent: { module: 'test:wedged', args: { mode: 'wedged' } },
          });
          try {
            await ctx.wait(child.pid, { timeoutMs: 5000 });
          } catch {
            // ETIMEDOUT: the child never finished. That is the point.
          }
          ctx.exit(0, 'waited');
          return;
        }
        if (mode === 'killed') {
          // A process that dies by signal. Its zombie stays in the table —
          // init only reaps a zombie whose parent is gone or is init — so the
          // live views have a finished process to show, with a code and a
          // reason the kernel knows.
          await ctx.kill(ctx.pid, 'SIGKILL');
          return;
        }
        if (mode === 'leaver') {
          // A parent that spawns a child which dies and **never waits for it**,
          // so the dead child stays in the table.
          await ctx.spawn({ role: 'dead', agent: { module: 'test:dead', args: { mode: 'killed' } } });
          await ctx.recv();
          return;
        }
        ctx.exit(0, 'all good');
      },
    });
    kernels.push(kernel);

    const server = await startKernelServer(kernel, { log: () => {} });
    servers.push(server);
    writeEndpoint(tmp, server.endpoint);
    process.env['CORTEX_HOME'] = tmp;

    const capture = async (
      run: () => Promise<number>,
    ): Promise<{ code: number; out: string; err: string }> => {
      let out = '';
      let err = '';
      const prevWrite = process.stdout.write;
      process.stdout.write = ((chunk: unknown): boolean => {
        out += String(chunk);
        return true;
      }) as unknown as typeof process.stdout.write;
      console.error = (...parts: unknown[]): void => {
        err += parts.map((p) => String(p)).join(' ') + '\n';
      };
      try {
        const code = await run();
        return { code, out, err };
      } finally {
        process.stdout.write = prevWrite;
        console.error = prevErr;
      }
    };

    // A process wedged in a `recv` that never returns.
    const wedged = await kernel.spawn({
      role: 'wedged',
      agent: { module: 'test:wedged', args: { mode: 'wedged' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    await checkAsync('cortex top says what a process is waiting for, and for how long', async () => {
      const result = await capture(() => cmdTop([]));

      assert(result.code === 0, `exit 0, got ${result.code}`);
      const row = topRow(result.out, unbrand(wedged));
      assert(row !== '', `the process is in the tree, got: ${result.out}`);
      assert(
        /waiting on a channel for \d/.test(row),
        `it says what it is waiting for and for how long, got: ${row}`,
      );
    });

    await checkAsync('the kernel and the log say the same thing about an open call', async () => {
      // Two readings of one fact. The kernel keeps its own pairing of the
      // `enter` frames it writes; the log is the same pairing written down.
      // If they ever disagreed, the operator would be shown a stall that is
      // not there — or miss one that is.
      const probe = await probeKernel(tmp);
      assert(probe.kind === 'live', `probe finds the kernel, got ${probe.kind}`);
      const client = probe.kind === 'live' ? probe.client : undefined;
      try {
        const fromKernel = await readOpenCallsFromKernel(client);
        assert(fromKernel !== undefined, 'the kernel answers the question');
        const kernelCall = fromKernel!.get(unbrand(wedged));
        assert(kernelCall !== undefined, 'the kernel says what the process is inside');

        const fromLog = await readOpenCall(tmp, unbrand(wedged));
        assert(fromLog !== undefined, 'the log says it too');

        assert(
          kernelCall!.syscall === fromLog!.syscall,
          `the same syscall, kernel=${kernelCall!.syscall} log=${fromLog!.syscall}`,
        );
        assert(
          kernelCall!.callId === fromLog!.callId,
          `the same call id, kernel=${kernelCall!.callId} log=${fromLog!.callId}`,
        );
        assert(
          kernelCall!.since === fromLog!.since,
          `the same moment, kernel=${kernelCall!.since} log=${fromLog!.since}`,
        );
      } finally {
        client?.close();
      }
    });

    await checkAsync('a process with two calls in flight still reports the one it is inside', async () => {
      // A process is normally inside one call at a time, but nothing forbids
      // an agent from awaiting two: the second is handed to the dispatcher
      // before the first has parked the process, so both are admitted, and
      // the second then traps.
      //
      // That is the case a one-slot-per-process bookkeeping gets wrong: when
      // the second call closes, the first is still open — and a bookkeeping
      // that kept one slot would report "nothing" for a process that is
      // demonstrably still inside its `sleep`.
      const parallel = await kernel.spawn({
        role: 'parallel',
        agent: { module: 'test:parallel', args: { mode: 'parallel' } },
      });
      await new Promise((resolve) => setTimeout(resolve, 400));

      const probe = await probeKernel(tmp);
      assert(probe.kind === 'live', `probe finds the kernel, got ${probe.kind}`);
      const client = probe.kind === 'live' ? probe.client : undefined;
      try {
        const fromKernel = await readOpenCallsFromKernel(client);
        assert(fromKernel !== undefined, 'the kernel answers the question');
        const kernelCall = fromKernel!.get(unbrand(parallel));
        assert(
          kernelCall !== undefined,
          'the kernel still says what the process is inside, even though another call closed',
        );

        const fromLog = await readOpenCall(tmp, unbrand(parallel));
        assert(fromLog !== undefined, 'the log says it too');
        assert(
          kernelCall!.syscall === fromLog!.syscall &&
            kernelCall!.callId === fromLog!.callId &&
            kernelCall!.since === fromLog!.since,
          `the same call, kernel=${kernelCall!.syscall}/${kernelCall!.callId} ` +
            `log=${fromLog!.syscall}/${fromLog!.callId}`,
        );
      } finally {
        client?.close();
      }
    });

    await checkAsync('cortex top still knows what a process is inside when the log says nothing', async () => {
      // The log is emptied under the kernel's feet: the `enter` frame the
      // answer used to be read from is gone. Only the kernel can still say it.
      const result = await withEmptiedLog(tmp, unbrand(wedged), () => capture(() => cmdTop([])));

      assert(result.code === 0, `exit 0, got ${result.code}`);
      const row = topRow(result.out, unbrand(wedged));
      assert(row !== '', `the process is still in the tree, got: ${result.out}`);
      assert(
        /waiting on a channel for \d/.test(row),
        `it still says what it is waiting for, got: ${row}`,
      );
    });

    await checkAsync('cortex top --stall-after marks the wedged one and hands over the command', async () => {
      const result = await capture(() => cmdTop(['--stall-after', '300']));

      assert(result.code === 0, `exit 0, got ${result.code}`);
      const row = topRow(result.out, unbrand(wedged));
      assert(row.includes('— stuck'), `the row is marked, got: ${row}`);
      assert(result.out.includes('1 stuck'), `the header counts it, got: ${result.out}`);
      assert(
        result.out.includes(`cortex supervise ${unbrand(wedged)} --kill-after 300`),
        `the command to act on it is handed over, got: ${result.out}`,
      );
    });

    await checkAsync('cortex ps says what each agent is waiting on', async () => {
      // The flat table had the state and nothing else: "blocked", with no
      // word about *what* the process was blocked on. The kernel knows both
      // the reason and the call, so the table can say both.
      const result = await capture(() => cmdPs([]));
      assert(result.code === 0, `exit 0, got ${result.code}`);
      const line = psRow(result.out, unbrand(wedged));
      assert(line !== '', `the wedged process is listed, got: ${result.out}`);
      assert(line.includes('a channel'), `it says what it is waiting on, got: ${line}`);
    });

    await checkAsync('cortex ps says how a finished process ended', async () => {
      // A run that finished and a run that died read as the same word —
      // `zombie` — in the table an operator reads first. So "did it finish,
      // or did it crash?" needed a second command to answer, and the answer
      // was in the row the whole time: the kernel knows the code and the
      // reason, and `ProcessRow` has carried both from the start.
      await kernel.spawn({
        role: 'leaver',
        agent: { module: 'test:leaver', args: { mode: 'leaver' } },
      });
      await new Promise((resolve) => setTimeout(resolve, 600));

      const dead = kernel.table.list().find((info) => info.role === 'dead');
      assert(dead !== undefined, 'the child died and is still in the table');
      assert(
        dead!.exitCode === 137,
        `the kernel knows the exit code, got ${String(dead!.exitCode)}`,
      );

      const result = await capture(() => cmdPs([]));
      assert(result.code === 0, `exit 0, got ${result.code}`);
      const line = psRow(result.out, unbrand(dead!.pid));
      assert(line !== '', `the process is listed, got: ${result.out}`);
      assert(
        line.includes('exit 137 (signal:SIGKILL)'),
        `it says how it ended, got: ${line}`,
      );
    });

    await checkAsync('cortex ps says how a process from an earlier run ended', async () => {
      // The other half of the same fact: a process that finished in an
      // earlier run left a `meta.json` behind, and that file carries the code
      // and the reason. The table says them the same way.
      writeMeta(tmp, {
        pid: 99,
        ppid: 1,
        pgid: 99,
        role: 'finished',
        state: 'zombie',
        exitCode: 3,
        exitReason: 'boom',
        startedAt: '2026-01-01T00:00:00.000Z',
        lastTransitionAt: '2026-01-01T00:00:01.000Z',
        budgetsSpent: {
          tokensIn: 0,
          tokensOut: 0,
          tokensCached: 0,
          usdSpent: 0,
          wallTimeMs: 0,
          syscallCount: 0,
        },
        budgetsRemaining: { tokens: -1, usd: -1, wallTimeMs: -1 },
        agent: { module: 'file:///nowhere.ts' },
        capabilities: [],
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });

      const result = await capture(() => cmdPs([]));
      assert(result.code === 0, `exit 0, got ${result.code}`);
      const line = psRow(result.out, 99);
      assert(line !== '', `the process is listed, got: ${result.out}`);
      assert(line.includes('exit 3 (boom)'), `it says how it ended, got: ${line}`);
    });

    await checkAsync('the two process views say the same ending', async () => {
      // One rule, two views. `cortex top` said how a process ended and `cortex
      // ps` did not; now both say it, in the same words — an operator who
      // reads "exit 1 (boom)" in one and something else in the other has to
      // work out whether those are the same thing.
      const dead = kernel.table.list().find((info) => info.role === 'dead');
      assert(dead !== undefined, 'the dead child is still in the table');

      const ps = await capture(() => cmdPs([]));
      const top = await capture(() => cmdTop([]));
      const psLine = psRow(ps.out, unbrand(dead!.pid));
      const topLine = topRow(top.out, unbrand(dead!.pid));
      assert(psLine !== '' && topLine !== '', `both views list it: ${ps.out} / ${top.out}`);

      const ending = /exit \d+ \([^)]*\)/.exec(psLine)?.[0] ?? '';
      const topEnding = /exit \d+ \([^)]*\)/.exec(topLine)?.[0] ?? '';
      assert(ending !== '', `cortex ps says the ending, got: ${psLine}`);
      assert(
        topEnding === ending,
        `the two views use the same words, ps="${ending}" top="${topEnding}"\n--- top ---\n${top.out}\n--- ps ---\n${ps.out}`,
      );
    });

    await checkAsync('cortex ps shows a finished process its lifetime, not an age that keeps growing', async () => {
      // A finished process is not aging: it lived for a while and then it was
      // over. The AGE column used to keep counting from its start, so a
      // process that died 41 seconds in read as "7100.0h" the next day — a
      // number about the record, not about the process. The kernel records
      // the time a process lived (the wall clock), so the table can say it.
      writeMeta(tmp, {
        pid: 98,
        ppid: 1,
        pgid: 98,
        role: 'done',
        state: 'zombie',
        exitCode: 0,
        exitReason: 'completed',
        startedAt: '2026-01-01T00:00:00.000Z',
        lastTransitionAt: '2026-01-01T00:00:41.000Z',
        budgetsSpent: {
          tokensIn: 0,
          tokensOut: 0,
          tokensCached: 0,
          usdSpent: 0,
          wallTimeMs: 41000,
          syscallCount: 3,
        },
        budgetsRemaining: { tokens: -1, usd: -1, wallTimeMs: -1 },
        agent: { module: 'file:///nowhere.ts' },
        capabilities: [],
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });

      const result = await capture(() => cmdPs([]));
      assert(result.code === 0, `exit 0, got ${result.code}`);
      const line = psRow(result.out, 98);
      assert(line !== '', `the process is listed, got: ${result.out}`);
      assert(line.includes('41s'), `it shows the lifetime, got: ${line}`);
    });

    await checkAsync('cortex top says how long a process lived', async () => {
      // The tree said what a process was *doing* and never how long it had
      // been doing it. `cortex ps` had an AGE column; the tree — the view an
      // operator watches — did not, and a view that cannot say how long a
      // thing has been going cannot answer "is it stuck?".
      const result = await capture(() => cmdTop([]));
      assert(result.code === 0, `exit 0, got ${result.code}`);
      const row = topRow(result.out, unbrand(wedged));
      assert(row !== '', `the process is in the tree, got: ${result.out}`);
      const age = topCell(result.out, unbrand(wedged), 'AGE');
      assert(age !== '', `the tree has an AGE column, got: ${result.out}`);
      assert(
        /^\d+(?:\.\d+)?(?:ms|s|m|h)$/.test(age),
        `the age is a duration, got: ${age}`,
      );
    });

    await checkAsync('cortex top shows a finished process its lifetime, not an age that keeps growing', async () => {
      // The same rule `cortex ps` follows, in the tree: a finished process is
      // not aging, it is over. The number the kernel recorded for it is how
      // long it really lived, and it stops growing there — a row that counted
      // from its start would read "7100.0h" the next day, which is a number
      // about the record and not about the process.
      writeMeta(tmp, {
        pid: 97,
        ppid: 1,
        pgid: 97,
        role: 'over',
        state: 'zombie',
        exitCode: 0,
        exitReason: 'completed',
        startedAt: '2026-01-01T00:00:00.000Z',
        lastTransitionAt: '2026-01-01T00:00:41.000Z',
        budgetsSpent: {
          tokensIn: 0,
          tokensOut: 0,
          tokensCached: 0,
          usdSpent: 0,
          wallTimeMs: 41000,
          syscallCount: 3,
        },
        budgetsRemaining: { tokens: -1, usd: -1, wallTimeMs: -1 },
        agent: { module: 'file:///nowhere.ts' },
        capabilities: [],
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });

      const result = await capture(() => cmdTop([]));
      assert(result.code === 0, `exit 0, got ${result.code}`);
      const age = topCell(result.out, 97, 'AGE');
      assert(age === '41s', `it shows the lifetime, got: ${age}`);
    });

    await checkAsync('the dashboard says how long each process lived', async () => {
      // The window showed the *start time* and nothing else — and a start time
      // is not a duration. For a process that died an hour ago it says nothing
      // at all about how long it lived, and the start time keeps saying
      // "yesterday" for as long as the record is on disk.
      //
      // The process is the one the check above wrote: a finished one, with a
      // lifetime the kernel recorded.
      const dash = await startDashboard({ dir: tmp, port: 0 });
      try {
        const res = await fetch(`${dash.url}/api/processes`);
        assert(res.status === 200, `status ${res.status}`);
        const rows = (await res.json()) as { pid: number; ageLabel?: string }[];
        const row = rows.find((r) => r.pid === 97);
        assert(row !== undefined, `the process is listed, got: ${JSON.stringify(rows)}`);
        assert(
          row!.ageLabel === '41s',
          `the row says the lifetime, got ${row!.ageLabel}`,
        );
      } finally {
        await dash.close();
      }
    });

    await checkAsync('the page has a column for how long a process lived', async () => {
      // The label travels with the row so the page never re-implements the
      // rule — the page is a static file and cannot import it.
      const dash = await startDashboard({ dir: tmp, port: 0 });
      try {
        const html = await (await fetch(`${dash.url}/`)).text();
        assert(html.includes('存活时长'), 'the page names the column');
        assert(html.includes('ageLabel'), 'the page reads the label the server sent');
        // And the column is not empty: the **cell** renders it. The tree puts
        // the same label in a span, so only the cell says that the *table*
        // has it — a page that named the column and never filled it would pass
        // a check that only looked for the name.
        assert(
          /<td[^>]*>\$\{esc\(processAgeLabel\(process\)\)\}<\/td>/.test(html),
          'the process table renders the age',
        );
      } finally {
        await dash.close();
      }
    });

    await checkAsync('cortex ps says when a process has run out of budget', async () => {
      // A process whose ceiling has been reached cannot go on — and nothing in
      // the row said so. The wall clock runs on the kernel's heartbeat now, so
      // an agent that is parked can run out of wall time while it waits, and
      // a `ready` row that will never run again looked exactly like one that
      // was merely waiting.
      await kernel.spawn({
        role: 'dry',
        agent: { module: 'test:dry', args: { mode: 'ok' } },
        budgets: { tokens: -1, usd: -1, wallTimeMs: 0 },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const dry = kernel.table.list().find((info) => info.role === 'dry');
      assert(dry !== undefined, 'the process is in the table');

      const result = await capture(() => cmdPs([]));
      assert(result.code === 0, `exit 0, got ${result.code}`);
      const line = psRow(result.out, unbrand(dry!.pid));
      assert(line !== '', `the process is listed, got: ${result.out}`);
      assert(
        line.includes('out of wallTime'),
        `it says the budget is gone, got: ${line}`,
      );
    });

    await checkAsync('cortex ps says which signals are queued for a process', async () => {
      // A signal aimed at a process that is not running does not arrive: it
      // waits in the process's pending queue until the process runs again
      // (docs/PROCESS.md §7.2). The kernel knows this — it owns the queue,
      // and it sends the list in every process record — and the views used to
      // drop it. So `cortex ps` printed the *same row* before and after a
      // `cortex kill` on a blocked agent: the operator asked a wedged process
      // to die, and the process list said nothing about it.
      //
      // A second wedged process, so this does not disturb the one the other
      // checks are about.
      const doomed = await kernel.spawn({
        role: 'doomed',
        agent: { module: 'test:wedged', args: { mode: 'wedged' } },
      });
      await new Promise((resolve) => setTimeout(resolve, 400));

      const before = await capture(() => cmdPs([]));
      assert(
        !psRow(before.out, unbrand(doomed)).includes('queued'),
        `nothing is queued to begin with, got: ${before.out}`,
      );

      // The same path `cortex kill` takes: init signals the process, and
      // because it is blocked rather than running, the signal waits.
      await kernel.dispatcher.invoke(asProcessId(1), 'kill', doomed, 'SIGTERM');

      const result = await capture(() => cmdPs([]));
      assert(result.code === 0, `exit 0, got ${result.code}`);
      const line = psRow(result.out, unbrand(doomed));
      assert(line !== '', `the process is listed, got: ${result.out}`);
      assert(
        line.includes('SIGTERM queued'),
        `the queued signal is said out loud, got: ${line}`,
      );

      // And the tree says it in the same words — one rule, two views.
      const top = await capture(() => cmdTop([]));
      const topLine = topRow(top.out, unbrand(doomed));
      assert(topLine !== '', `cortex top shows the process, got: ${top.out}`);
      assert(
        topLine.includes('SIGTERM queued'),
        `cortex top says it too, got: ${topLine}`,
      );
    });

    await checkAsync('cortex limit says what an agent may spend in total, and can change it', async () => {
      // Two faults in one command, both of them found by running it.
      //
      // It could not reach a live kernel: it booted a kernel of its own,
      // looked in it, and found nothing but init — so it answered "no such
      // process" for an agent `cortex ps` was showing as running, and no
      // budget could ever be set on anything at all.
      //
      // And it printed the *remainder* under the label "limit", so the ceiling
      // was nowhere to be seen: an agent spawned with `--token-budget 1000`
      // that had spent 42 tokens read as "limit 958".
      const pid = await kernel.spawn({
        role: 'budgeted',
        agent: { module: 'test:wedged', args: { mode: 'wedged' } },
      });
      await new Promise((resolve) => setTimeout(resolve, 400));

      const unlimited = await capture(() => cmdLimit([String(unbrand(pid))]));
      assert(unlimited.code === 0, `exit 0, got ${unlimited.code}: ${unlimited.err}`);
      assert(
        unlimited.out.includes('limit ∞'),
        `an unlimited budget says so, got: ${unlimited.out}`,
      );

      // The kernel's own accounting: this agent has already spent 100 tokens.
      kernel.table.spend(pid, { tokensIn: 100 });

      const set = await capture(() => cmdLimit([String(unbrand(pid)), '--tokens', '1000']));
      assert(set.code === 0, `exit 0, got ${set.code}: ${set.err}`);
      assert(set.out.includes('limit 1000'), `the ceiling is the total, got: ${set.out}`);

      const shown = await capture(() => cmdLimit([String(unbrand(pid))]));
      assert(shown.code === 0, `exit 0, got ${shown.code}: ${shown.err}`);
      assert(
        shown.out.includes('limit 1000'),
        `the ceiling is what it says — not the remainder, which moves — got: ${shown.out}`,
      );
      assert(
        shown.out.includes('900 left'),
        `what is left of the ceiling is said too, got: ${shown.out}`,
      );
    });

    await checkAsync('a finished process refuses to have its budget rewritten', async () => {
      // A budget is a thing a running process has. What a finished process
      // spent is the kernel's record, written down when the process ended —
      // so the command says no rather than pretending it can rewrite the
      // past. (It used to boot a kernel of its own and answer "no such
      // process" for everything, which was a different lie: not "no", but
      // "this does not exist".)
      const pid = await kernel.spawn({
        role: 'finished',
        agent: { module: 'test:ok', args: { mode: 'ok' } },
      });

      // Wait for it to end and for init to reap it. Once the kernel no longer
      // holds the entry, the process *is* finished — that is the condition
      // the refusal is about. (The scheduler dispatches on its own clock, so
      // this waits on wall time rather than on a tick count.)
      const deadline = Date.now() + 5000;
      let gone = false;
      while (Date.now() < deadline && !gone) {
        gone = kernel.table.get(pid) === undefined;
        if (!gone) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(gone, 'the process has been reaped');

      const refused = await capture(() => cmdLimit([String(unbrand(pid)), '--tokens', '500']));
      assert(refused.code === 1, `exit 1, got ${refused.code}: ${refused.out}`);
      assert(
        refused.err.includes('not running'),
        `it says the process is not running, got: ${refused.err}`,
      );
      assert(
        refused.err.includes('a budget is a thing a running process has'),
        `it says why, got: ${refused.err}`,
      );
    });

    await checkAsync('cortex ps and cortex top use the same words for the same wait', async () => {
      // One rule, two views. `ps` prints the noun ("a model call"); `top`
      // prints the sentence ("waiting on a model call for 12.3s"). Phrased
      // separately they would drift, and the operator would have to work out
      // whether the table and the tree were talking about the same thing.
      //
      // The process is one inside a model call on purpose: it is the one
      // whose waiting is described by the *call's name* and not by a blocked
      // reason. A blocked reason comes from the kernel, and both views would
      // read the same field — which would prove nothing about the shared
      // wording.
      const thinker = await kernel.spawn({
        role: 'thinker-w',
        agent: { module: 'test:thinking', args: { mode: 'thinking' } },
      });
      await new Promise((resolve) => setTimeout(resolve, 400));

      const ps = await capture(() => cmdPs([]));
      const psLine = psRow(ps.out, unbrand(thinker));
      assert(psLine !== '', `cortex ps lists the process, got: ${ps.out}`);
      const waiting = psLine.split(/\s{2,}/).filter(Boolean).at(-1) ?? '';
      assert(waiting !== '', `ps says what it is waiting on, got: ${psLine}`);

      const top = await capture(() => cmdTop([]));
      const topLine = topRow(top.out, unbrand(thinker));
      assert(topLine !== '', `cortex top shows the process, got: ${top.out}`);
      assert(
        topLine.includes(waiting),
        `the two views use the same words, ps="${waiting}" top="${topLine.trim()}"`,
      );
    });

    await checkAsync('cortex ps says what an agent inside a model call is doing', async () => {
      // The hard case, and the one BACKLOG #060 is about: the kernel does not
      // park a process while its model call is in flight, so the *state* says
      // `running` — and only the call itself says what the agent is doing.
      // A table that says `running` and stops there is not wrong, but it is
      // not what the operator needs.
      const thinker = await kernel.spawn({
        role: 'thinker',
        agent: { module: 'test:thinking', args: { mode: 'thinking' } },
      });
      await new Promise((resolve) => setTimeout(resolve, 400));

      const result = await capture(() => cmdPs([]));
      assert(result.code === 0, `exit 0, got ${result.code}`);
      const line = psRow(result.out, unbrand(thinker));
      assert(line !== '', `the process is listed, got: ${result.out}`);
      assert(
        line.includes('a model call'),
        `it says what the agent is inside, got: ${line}`,
      );
      assert(
        line.includes('running'),
        `and the state still says running — the kernel does not park it, got: ${line}`,
      );

      // And the tree says the same words about the same call. `ps` prints
      // the noun, `top` the sentence — but the noun has to be the same noun.
      const top = await capture(() => cmdTop([]));
      const topLine = topRow(top.out, unbrand(thinker));
      assert(topLine !== '', `cortex top shows the process, got: ${top.out}`);
      assert(
        topLine.includes('a model call'),
        `the two views use the same words, got: ${topLine.trim()}`,
      );
    });

    await checkAsync('cortex ps still says what a process is waiting on when the kernel is too old', async () => {
      // A daemon from before the `openCalls` command existed: the method is
      // simply not there, so the server cannot answer the question.
      //
      // The view has to fall back to the log then. A table that goes silent
      // when the kernel is behind is a table that says "nothing is wrong" —
      // and the operator has no way to tell that from the truth.
      //
      // The process that makes this bite is the one inside a *model call*:
      // a blocked reason cannot explain it (the kernel does not park a
      // process while its model call is in flight), so the log is the only
      // thing that can still say what it is doing.
      const thinker = await kernel.spawn({
        role: 'thinker-old',
        agent: { module: 'test:thinking', args: { mode: 'thinking' } },
      });
      await new Promise((resolve) => setTimeout(resolve, 400));

      const oldKernel = Object.create(kernel) as Kernel;
      (oldKernel as { openCalls?: unknown }).openCalls = undefined;
      const oldServer = await startKernelServer(oldKernel, { log: () => {} });
      servers.push(oldServer);

      const real = readEndpoint(tmp);
      try {
        writeEndpoint(tmp, oldServer.endpoint);
        const result = await capture(() => cmdPs([]));
        assert(result.code === 0, `exit 0, got ${result.code}`);

        const line = psRow(result.out, unbrand(wedged));
        assert(line !== '', `the wedged process is listed, got: ${result.out}`);
        assert(
          line.includes('a channel'),
          `it still says what it is waiting on, got: ${line}`,
        );

        const thinkerLine = psRow(result.out, unbrand(thinker));
        assert(thinkerLine !== '', `the thinker is listed, got: ${result.out}`);
        assert(
          thinkerLine.includes('a model call'),
          `even the call the kernel cannot account for, got: ${thinkerLine}`,
        );

        // And the tree says the same thing about the same kernel. The two
        // views read the same fact, so they must not be able to differ on
        // what to do when the kernel cannot answer.
        const top = await capture(() => cmdTop([]));
        const topLine = topRow(top.out, unbrand(thinker));
        assert(topLine !== '', `cortex top shows the process, got: ${top.out}`);
        assert(
          topLine.includes('a model call'),
          `the tree says it too, got: ${topLine.trim()}`,
        );
      } finally {
        if (real !== undefined) writeEndpoint(tmp, real);
      }
    });

    await checkAsync('cortex top does not call a process that is making progress stuck', async () => {
      const listener = await kernel.spawn({
        role: 'listener',
        agent: { module: 'test:listener', args: { mode: 'listener' } },
      });
      await new Promise((resolve) => setTimeout(resolve, 300));

      const result = await capture(() => cmdTop(['--stall-after', '1000']));

      assert(result.code === 0, `exit 0, got ${result.code}`);
      const row = topRow(result.out, unbrand(listener));
      assert(row !== '', `the listener is in the tree, got: ${result.out}`);
      assert(
        !row.includes('— stuck'),
        `a process that keeps making progress is not called stuck, got: ${row}`,
      );
    });

    // A planner waiting on a child, with a deadline of its own. It is
    // hoisted out of the checks below because two of them look at it: what
    // the view says about it, and what the kernel says about it.
    const planner = await kernel.spawn({
      role: 'planner',
      agent: { module: 'test:waiter', args: { mode: 'waiter' } },
    });
    // Let it get to the `wait` and stay there.
    await new Promise((resolve) => setTimeout(resolve, 500));

    await checkAsync('cortex top does not call a bounded wait stuck', async () => {
      const result = await capture(() => cmdTop(['--stall-after', '200']));

      assert(result.code === 0, `exit 0, got ${result.code}`);
      const row = topRow(result.out, unbrand(planner));
      assert(row !== '', `the planner is in the tree, got: ${result.out}`);
      assert(
        row.includes('waiting on child'),
        `it says what it is waiting for, got: ${row}`,
      );
      assert(
        !row.includes('— stuck'),
        `a wait that carries its own deadline is a declared wait, not a stall, got: ${row}`,
      );
    });

    await checkAsync('the kernel and the log agree about a declared wait', async () => {
      // The arguments are part of the answer, not decoration: a `wait` that
      // carries its own deadline is a *declared* wait, and a supervisor that
      // cannot see the deadline kills a planner for keeping its word. So the
      // kernel has to hand over the arguments, not just the syscall's name.
      const probe = await probeKernel(tmp);
      assert(probe.kind === 'live', `probe finds the kernel, got ${probe.kind}`);
      const client = probe.kind === 'live' ? probe.client : undefined;
      try {
        const fromKernel = await readOpenCallsFromKernel(client);
        assert(fromKernel !== undefined, 'the kernel answers the question');
        const kernelCall = fromKernel!.get(unbrand(planner));
        assert(kernelCall !== undefined, 'the kernel says what the planner is inside');
        assert(
          kernelCall!.syscall === 'wait',
          `it is inside a wait, got ${kernelCall!.syscall}`,
        );
        assert(
          isDeclaredWait(kernelCall!),
          'the kernel-side call is a declared wait — it carries its own deadline',
        );

        const fromLog = await readOpenCall(tmp, unbrand(planner));
        assert(fromLog !== undefined, 'the log says it too');
        assert(
          JSON.stringify(kernelCall!.args) === JSON.stringify(fromLog!.args),
          `the same arguments, kernel=${JSON.stringify(kernelCall!.args)} ` +
            `log=${JSON.stringify(fromLog!.args)}`,
        );
      } finally {
        client?.close();
      }
    });

    await checkAsync("cortex top's tree lines its columns up", async () => {
      const result = await capture(() => cmdTop([]));

      const header = result.out.split('\n').find((l) => l.includes('PID') && l.includes('ROLE'));
      assert(header !== undefined, `the columns are named, got: ${result.out}`);
      const column = header!.indexOf('PID');

      // Every row puts its pid in the column the header names. A tree whose
      // numbers do not line up is a tree nobody can read. (The pid column is
      // padded, so a row has at least two spaces after its number — which is
      // what keeps the summary line, "0 tokens · …", out of the set.)
      const rows = result.out.split('\n').filter((l) => /^[^\w]*\d+\s{2,}/.test(l));
      assert(rows.length > 0, `there are rows, got: ${result.out}`);
      for (const row of rows) {
        assert(
          row.search(/\d/) === column,
          `every row's pid lines up with the header, got: ${row}`,
        );
      }
    });

    // -----------------------------------------------------------------------
    // The shape of the table — the same fact in three commands
    // -----------------------------------------------------------------------

    /**
     * A home with one process whose **role** is longer than any sensible
     * column and whose **capabilities** are a narrowed set.
     *
     * Both used to break the table: `padEnd` does not cut, so the role ran
     * straight into the state column and the capability list straight into
     * the age column — two fields reading as one word.
     */
    const wideHome = mkdtempSync(join(tmpdir(), 'cortex-wide-table-'));
    writeMeta(wideHome, {
      pid: 2,
      ppid: 1,
      pgid: 2,
      role: 'researcher:deep-dive-agent-with-a-very-long-name',
      state: 'zombie',
      exitCode: 0,
      exitReason: 'done',
      startedAt: '2026-01-01T00:00:00.000Z',
      lastTransitionAt: '2026-01-01T00:00:10.000Z',
      // 999 tokens: the number the two views used to disagree about.
      budgetsSpent: {
        tokensIn: 999,
        tokensOut: 0,
        tokensCached: 0,
        usdSpent: 0,
        wallTimeMs: 10,
        syscallCount: 1,
      },
      budgetsRemaining: { tokens: -1, usd: -1, wallTimeMs: -1 },
      agent: { module: './agents/noop.js' } as ProcessMeta['agent'],
      capabilities: ['spawn', 'kill', 'fork', 'tool:dangerous', 'ipc:any'],
      kernelAbiVersion: KERNEL_ABI_VERSION,
    });

    /** Every state the kernel knows — a state column that says one of these is aligned. */
    const states = [
      'new',
      'ready',
      'running',
      'blocked',
      'stopped',
      'suspended',
      'checkpointing',
      'exiting',
      'zombie',
    ];

    /** The line of a table that carries the given pid. */
    const rowOf = (out: string, pid: number): string =>
      out.split('\n').find((l) => new RegExp(`^[\\s│├└─]*${pid}\\s`).test(l)) ?? '';

    await checkAsync('cortex ps keeps its columns when a value is wider than them', async () => {
      const prevHome = process.env['CORTEX_HOME'];
      process.env['CORTEX_HOME'] = wideHome;
      try {
        const result = await capture(() => cmdPs([]));
        assert(result.code === 0, `exit 0, got ${result.code}: ${result.err}`);

        const lines = result.out.split('\n');
        const header = lines.find((l) => l.includes('PID') && l.includes('ROLE'));
        assert(header !== undefined, `the columns are named, got: ${result.out}`);
        const stateAt = header!.indexOf('STATE');
        const capsAt = header!.indexOf('CAPS');

        // The row that used to break: the role is longer than its column, and
        // the capability list is longer than any sensible one.
        const row = rowOf(result.out, 2);
        assert(row !== '', `the process is listed, got: ${result.out}`);
        assert(
          !row.includes('agentzombie') && !row.includes('ipc:any7'),
          `no two fields are glued into one word, got: ${row}`,
        );
        assert(
          states.some((state) => row.slice(stateAt).startsWith(state)),
          `the state is its own word, in the column the header names, got: ${row}`,
        );
        assert(
          row.slice(capsAt).startsWith('spawn'),
          `the capabilities are their own word too, got: ${row}`,
        );
        assert(
          row.includes('spawn,kill,fork,tool:dangerous,ipc:any'),
          `the capability list is shown in full — the column grew to fit it, got: ${row}`,
        );
        assert(row.includes('…'), `the cut value says it was cut, got: ${row}`);

        // And every other row lines up under the same header.
        for (const line of lines) {
          if (!/^\d+\s/.test(line)) continue;
          assert(
            states.some((state) => line.slice(stateAt).startsWith(state)),
            `every row's state is in the header's column, got: ${line}`,
          );
        }
      } finally {
        if (prevHome === undefined) delete process.env['CORTEX_HOME'];
        else process.env['CORTEX_HOME'] = prevHome;
      }
    });

    await checkAsync('cortex top keeps its columns when a value is wider than them', async () => {
      const prevHome = process.env['CORTEX_HOME'];
      process.env['CORTEX_HOME'] = wideHome;
      try {
        const result = await capture(() => cmdTop([]));
        assert(result.code === 0, `exit 0, got ${result.code}: ${result.err}`);

        const lines = result.out.split('\n');
        const header = lines.find((l) => l.includes('PID') && l.includes('ROLE'));
        assert(header !== undefined, `the columns are named, got: ${result.out}`);
        const stateAt = header!.indexOf('STATE');

        const row = rowOf(result.out, 2);
        assert(row !== '', `the process is in the tree, got: ${result.out}`);
        assert(
          !row.includes('agentzombie'),
          `no two fields are glued into one word, got: ${row}`,
        );
        assert(
          states.some((state) => row.slice(stateAt).startsWith(state)),
          `the state is its own word, in the column the header names, got: ${row}`,
        );
        assert(row.includes('…'), `the cut value says it was cut, got: ${row}`);
      } finally {
        if (prevHome === undefined) delete process.env['CORTEX_HOME'];
        else process.env['CORTEX_HOME'] = prevHome;
      }
    });

    await checkAsync('the two process views say the same number for the same spend', async () => {
      // `cortex ps` had its own token rule and `cortex top` had another, so
      // the same process read as `1.0k` in one view and `999` in the other —
      // two views of one number, and no way to tell which was the truth.
      const prevHome = process.env['CORTEX_HOME'];
      process.env['CORTEX_HOME'] = wideHome;
      try {
        const ps = await capture(() => cmdPs([]));
        const top = await capture(() => cmdTop([]));

        const psHeader = ps.out.split('\n').find((l) => l.includes('PID') && l.includes('ROLE'));
        const topHeader = top.out.split('\n').find((l) => l.includes('PID') && l.includes('ROLE'));
        assert(psHeader !== undefined && topHeader !== undefined, 'both views have a header');

        const psTokens = psHeader!.indexOf('TOKENS');
        const topTokens = topHeader!.indexOf('TOKENS');
        const psRow = rowOf(ps.out, 2);
        const topRow = rowOf(top.out, 2);
        assert(psRow !== '' && topRow !== '', `both views list the process: ${ps.out} / ${top.out}`);

        assert(
          psRow.slice(psTokens).trimStart().startsWith('999'),
          `cortex ps says the exact number, got: ${psRow}`,
        );
        assert(
          topRow.slice(topTokens).trimStart().startsWith('999'),
          `cortex top says the same number, got: ${topRow}`,
        );
      } finally {
        if (prevHome === undefined) delete process.env['CORTEX_HOME'];
        else process.env['CORTEX_HOME'] = prevHome;
      }
    });

    rmSync(wideHome, { recursive: true, force: true });

    await checkAsync('cortex top says the money at the resolution the kernel counts it', async () => {
      // One model call costs about **$0.000027**. Printed to four decimals that
      // is `$0.0000`, so `cortex top` used to say **$0.0000 spent** for a run
      // that had spent real money — while `cortex limit`, reading the same
      // record, said `$0.000027`. The kernel counts in microdollars; six
      // decimals is what it can say exactly, and a cost that rounds away is
      // not a small cost, it is no cost.
      const home = mkdtempSync(join(tmpdir(), 'cortex-money-'));
      writeMeta(home, {
        pid: 2,
        ppid: 1,
        pgid: 2,
        role: 'tapped',
        state: 'zombie',
        exitCode: 0,
        exitReason: 'done',
        startedAt: '2026-01-01T00:00:00.000Z',
        lastTransitionAt: '2026-01-01T00:00:10.000Z',
        // 27 microdollars: one model call.
        budgetsSpent: {
          tokensIn: 100,
          tokensOut: 20,
          tokensCached: 0,
          usdSpent: 27,
          wallTimeMs: 10,
          syscallCount: 1,
        },
        budgetsRemaining: { tokens: -1, usd: -1, wallTimeMs: -1 },
        agent: { module: './agents/noop.js' } as ProcessMeta['agent'],
        kernelAbiVersion: KERNEL_ABI_VERSION,
      });
      const prevHome = process.env['CORTEX_HOME'];
      process.env['CORTEX_HOME'] = home;
      try {
        const result = await capture(() => cmdTop([]));
        assert(result.code === 0, `exit 0, got ${result.code}: ${result.err}`);
        // The summary line says it...
        assert(
          result.out.includes('$0.000027'),
          `the summary says what it cost, got: ${result.out}`,
        );
        // ...and so does the row.
        const row = rowOf(result.out, 2);
        assert(row.includes('$0.000027'), `the row says what it cost, got: ${row}`);
        // The rounded-away version is nowhere to be seen. (Zero is printed as
        // $0.000000, which is not the same string.)
        assert(
          !result.out.includes('$0.0000 '),
          `the cost was not rounded away, got: ${result.out}`,
        );
      } finally {
        if (prevHome === undefined) delete process.env['CORTEX_HOME'];
        else process.env['CORTEX_HOME'] = prevHome;
        rmSync(home, { recursive: true, force: true });
      }
    });

    await checkAsync('cortex top --help names the columns it prints', async () => {
      // The help used to describe two columns the table does not have — it
      // still called them `WAITING` and `SPEND` — and never mentioned the two
      // it does have. A help text that names a column nobody can see is a
      // help text that lies about the command, and the operator who reads it
      // goes looking for a column that is not there.
      const result = await capture(() => cmdTop(['--help']));
      assert(result.code === 0, `exit 0, got ${result.code}`);
      // The labels the help describes, taken from the text itself.
      const named = [...result.out.matchAll(/^ {2}([A-Z][A-Z]+)\s{2,}/gm)].map((m) => m[1]!);
      const real = ['PID', 'ROLE', 'STATE', 'TOKENS', 'USD', 'AGE', 'NOTE'];
      for (const name of named) {
        assert(
          real.includes(name),
          `the help describes a column the table does not have: ${name}`,
        );
      }
      for (const name of ['STATE', 'TOKENS', 'USD', 'AGE', 'NOTE']) {
        assert(
          named.includes(name),
          `the help does not describe the ${name} column, got: ${result.out}`,
        );
      }
    });

    await checkAsync('cortex top refuses a --stall-after it cannot make sense of', async () => {
      const result = await capture(() => cmdTop(['--stall-after', 'soon']));
      assert(result.code === 1, `exit 1, got ${result.code}`);
      assert(
        result.err.includes('invalid --stall-after'),
        `the reason is reported, got: ${result.err.trim()}`,
      );
    });
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    for (const server of servers) {
      try {
        await server.close();
      } catch {
        /* teardown is best-effort */
      }
    }
    for (const k of kernels) {
      try {
        await k.shutdown();
      } catch {
        /* teardown is best-effort */
      }
    }
    if (prevHome === undefined) delete process.env['CORTEX_HOME'];
    else process.env['CORTEX_HOME'] = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  }
}

// =============================================================================
// Dashboard-with-a-live-kernel checks (#061)
// =============================================================================

/**
 * The dashboard watching a live kernel.
 *
 * Without a kernel the dashboard can only show *finished* processes: a
 * process that has not exited has no `meta.json` yet, so the disk is a
 * directory of corpses and the agent that is actually working is missing.
 * With one, the dashboard reads the kernel's own process table and takes
 * the event stream by push.
 */
/**
 * The `lastTransitionAt` the dashboard's pushed tables reported for a pid.
 *
 * The tables arrive as SSE frames (`event: processes` and a JSON row array).
 * The question the table has to answer is not "does it have a row" but "does
 * the row move": a table that reports the same transition time forever is a
 * snapshot, whatever the page calls it.
 */
function transitionsOf(sse: string, pid: number): string[] {
  const out: string[] = [];
  for (const frame of sse.split('\n\n')) {
    const lines = frame.split('\n');
    if (!lines.some((line) => line === 'event: processes')) continue;
    const data = lines
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .join('');
    if (data.length === 0) continue;
    let rows: Array<Record<string, unknown>>;
    try {
      rows = JSON.parse(data) as Array<Record<string, unknown>>;
    } catch {
      continue;
    }
    const row = rows.find((r) => r['pid'] === pid);
    const at = row?.['lastTransitionAt'];
    if (typeof at === 'string') out.push(at);
  }
  return out;
}

function firstTransitionOf(sse: string, pid: number): string | undefined {
  return transitionsOf(sse, pid)[0];
}

function lastTransitionOf(sse: string, pid: number): string | undefined {
  const all = transitionsOf(sse, pid);
  return all[all.length - 1];
}

async function runDashboardLiveChecks(): Promise<void> {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-dashlive-'));
  const kernels: Kernel[] = [];
  const servers: { close: () => Promise<void> }[] = [];

  const prevHome = process.env['CORTEX_HOME'];
  const prevLog = console.log;
  const prevErr = console.error;

  try {
    const kernel = await bootKernel({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      dir: tmp,
      autoStart: true,
      loadDrivers: (reg) => {
        reg.registerMemory(inmemMemory());
      },
      agentLoader: async () => async (ctx, args) => {
        const mode = typeof args['mode'] === 'string' ? args['mode'] : 'push';
        if (mode === 'push') {
          // One ordinary call, so the kernel has a frame to push — and then
          // it stays alive, because a process that has exited is reaped and
          // (in this harness) leaves no record behind.
          await ctx.memory_write('semantic', 'live-key', 'live-value');
          await ctx.recv();
          return;
        }
        if (mode === 'busy') {
          // Keeps changing state: a sleep parks the process on its timer
          // and waking it puts it back in the run queue, so the kernel
          // keeps saying what state it is in. A table that only refreshes
          // when a process starts or ends would show one snapshot of all
          // of that.
          for (let i = 0; i < 40; i += 1) {
            await ctx.sleep(50);
          }
          await ctx.recv();
          return;
        }
        if (mode === 'killed') {
          // A process that dies by signal: its zombie stays in the table (init
          // only reaps a zombie whose parent is gone or is init), so the
          // operator's window has a finished process to show.
          await ctx.kill(ctx.pid, 'SIGKILL');
          return;
        }
        if (mode === 'leaver') {
          // A parent that spawns a child which dies and never waits for it:
          // the dead child stays in the table, so the window has a finished
          // process to show.
          await ctx.spawn({ role: 'dead', agent: { module: 'test:dead', args: { mode: 'killed' } } });
          await ctx.recv();
          return;
        }
        // Alive and doing nothing: the dashboard must still show it.
        await ctx.recv();
        return;
      },
    });
    kernels.push(kernel);

    const server = await startKernelServer(kernel, { log: () => {} });
    servers.push(server);
    writeEndpoint(tmp, server.endpoint);
    process.env['CORTEX_HOME'] = tmp;

    const probe = await probeKernel(tmp);
    assert(probe.kind === 'live', `probe finds the kernel, got ${probe.kind}`);
    const client = probe.kind === 'live' ? probe.client : undefined;

    const dash = await startDashboard({ dir: tmp, port: 0, kernel: client! });
    try {
      /** Run a command with its stdout captured. */
      const capture = async (
        run: () => Promise<number>,
      ): Promise<{ code: number; out: string }> => {
        let out = '';
        const prevWrite = process.stdout.write;
        process.stdout.write = ((chunk: unknown): boolean => {
          out += String(chunk);
          return true;
        }) as unknown as typeof process.stdout.write;
        try {
          const code = await run();
          return { code, out };
        } finally {
          process.stdout.write = prevWrite;
        }
      };

      await checkAsync('the dashboard shows the processes that are running', async () => {
        const pid = await kernel.spawn({
          role: 'live-one',
          agent: { module: 'test:live', args: { mode: 'alive' } },
        });
        // Let it be running (and not yet finished) when the dashboard reads.
        await new Promise((resolve) => setTimeout(resolve, 50));

        const res = await fetch(`${dash.url}/api/processes`);
        assert(res.status === 200, `status ${res.status}`);
        const rows = (await res.json()) as Array<Record<string, unknown>>;

        const row = rows.find((r) => r['pid'] === unbrand(pid));
        assert(row !== undefined, `the running process is in the list, got: ${JSON.stringify(rows.map((r) => r['pid']))}`);
        assert(row!['role'] === 'live-one', `it is the process we spawned, got ${String(row!['role'])}`);
        assert(row!['live'] === true, `it is marked live, got ${String(row!['live'])}`);
      });

      await checkAsync('the dashboard says what each agent is inside', async () => {
        // The operator's window used to say "blocked" and nothing else — and a
        // process inside a model call is not even blocked, so the window said
        // "running" for an agent that had been in the same call for four
        // minutes. The kernel knows; the dashboard asks.
        const pid = await kernel.spawn({
          role: 'inside-one',
          agent: { module: 'test:live', args: { mode: 'alive' } },
        });
        // Let it get inside its `recv` before the dashboard reads.
        await new Promise((resolve) => setTimeout(resolve, 80));

        const res = await fetch(`${dash.url}/api/processes`);
        assert(res.status === 200, `status ${res.status}`);
        const rows = (await res.json()) as Array<Record<string, unknown>>;
        const row = rows.find((r) => r['pid'] === unbrand(pid));
        assert(row !== undefined, 'the process is in the list');

        const label = row!['insideLabel'];
        assert(
          typeof label === 'string',
          `the row says what the agent is inside, got ${String(label)}`,
        );
        assert(
          label.includes('waiting on a channel'),
          `it says the agent is waiting on a channel, got ${label}`,
        );
        assert(
          / for \d/.test(label),
          `it says for how long, got ${label}`,
        );
      });

      await checkAsync('the dashboard and cortex top phrase the wait the same way', async () => {
        // Two views, one rule. An operator who reads "waiting on a channel" in
        // one and something else in the other has to work out whether those
        // are the same thing — so the wording comes from one function, and
        // the two views must not drift apart.
        //
        // Only the *wording* is compared: the age is a reading of the clock,
        // and the two views read it a moment apart.
        const pid = await kernel.spawn({
          role: 'inside-two',
          agent: { module: 'test:live', args: { mode: 'alive' } },
        });
        await new Promise((resolve) => setTimeout(resolve, 80));

        const res = await fetch(`${dash.url}/api/processes`);
        const rows = (await res.json()) as Array<Record<string, unknown>>;
        const row = rows.find((r) => r['pid'] === unbrand(pid));
        const label = String(row?.['insideLabel'] ?? '');
        assert(label !== '', `the dashboard has a label, got ${JSON.stringify(row)}`);
        const phrase = label.split(' for ')[0] ?? '';

        const top = await capture(() => cmdTop([]));
        const line =
          top.out.split('\n').find((l) => new RegExp(`^[^\\w]*${unbrand(pid)}\\s`).test(l)) ?? '';
        assert(line !== '', `cortex top shows the process, got: ${top.out}`);
        assert(
          line.includes(phrase),
          `the two views say the same thing, dashboard="${label}" top="${line.trim()}"`,
        );
      });

      await checkAsync('the dashboard says which signals are queued for a process', async () => {
        // A signal aimed at a process that is not running waits in its queue
        // until the process runs again (docs/PROCESS.md §7.2). The kernel owns
        // that queue and sends it in every process record — and the window
        // used to drop it, so a row said "blocked" and nothing about the
        // SIGTERM sitting in the queue, waiting for a wake-up that may never
        // come.
        const pid = await kernel.spawn({
          role: 'doomed-one',
          agent: { module: 'test:live', args: { mode: 'alive' } },
        });
        await new Promise((resolve) => setTimeout(resolve, 80));

        // The same path `cortex kill` takes: init signals the process, and
        // because it is blocked rather than running, the signal waits.
        await kernel.dispatcher.invoke(asProcessId(1), 'kill', pid, 'SIGTERM');

        const res = await fetch(`${dash.url}/api/processes`);
        const rows = (await res.json()) as Array<Record<string, unknown>>;
        const row = rows.find((r) => r['pid'] === unbrand(pid));
        assert(row !== undefined, 'the process is in the list');
        const label = String(row!['pendingLabel'] ?? '');
        assert(
          label.includes('SIGTERM queued'),
          `the queued signal is said out loud, got ${JSON.stringify(row)}`,
        );
      });

      await checkAsync('the dashboard pushes live events instead of re-reading', async () => {
        const res = await fetch(`${dash.url}/api/stream?limit=50`);
        assert(res.status === 200, `status ${res.status}`);
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let text = '';        try {
          // The stream opens with the history; the *push* is what we are
          // testing, so the frame we look for is one that does not exist yet.
          //
          // The wait is bounded on its own: a read on an idle stream blocks
          // until the next frame (the server pings every 15s), which would
          // sail straight past the deadline.
          const readUntil = async (needle: string, ms: number): Promise<boolean> => {
            const deadline = Date.now() + ms;
            for (;;) {
              const left = deadline - Date.now();
              if (left <= 0) return false;
              let timer: ReturnType<typeof setTimeout> | undefined;
              const expiry = new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), left);
              });
              const chunk = await Promise.race([reader.read(), expiry]);
              if (timer !== undefined) clearTimeout(timer);
              if (chunk === null) return false;
              const { value, done } = chunk;
              if (done) return false;
              text += decoder.decode(value, { stream: true });
              if (text.includes(needle)) return true;
            }
          };

          const opened = await readUntil('event: events', 3000);
          assert(opened, `the stream opened, got: ${text.slice(0, 300)}`);

          const before = text.length;
          // Now the kernel does something, and the frame must arrive by push.
          const pid = await kernel.spawn({
            role: 'pushed',
            agent: { module: 'test:live', args: { mode: 'push' } },
            memory: { semantic: { kind: 'shared', backing: 'inmem' } },
          });
          assert(pid !== undefined, 'the process was spawned');

          const pushed = await readUntil('kernel.memory_write', 5000);
          assert(pushed, `the frame was pushed, got: ${text.slice(before, before + 400)}`);
        } finally {
          // Always drop the stream: an open one keeps the server's `close`
          // waiting, and a failed assertion must not hang the smoke run.
          await reader.cancel().catch(() => undefined);
        }
      });

      await checkAsync('the dashboard shows the history of a process that is still running', async () => {
        const pid = await kernel.spawn({
          role: 'historian',
          agent: { module: 'test:live', args: { mode: 'push' } },
        });
        assert(pid !== undefined, 'the process was spawned');

        // The agent is still running, so it has no `meta.json` yet — the
        // file the kernel writes when a process exits. Its log is on disk
        // all the same, and the dashboard has to be able to read it: the
        // agent that is working is the one whose history matters.
        const deadline = Date.now() + 5000;
        let seen = false;
        while (Date.now() < deadline && !seen) {
          const res = await fetch(`${dash.url}/api/events?limit=50`);
          const rows = (await res.json()) as Array<Record<string, unknown>>;
          seen = rows.some((r) => r['pid'] === unbrand(pid) && r['name'] === 'memory_write');
          if (!seen) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert(seen, "the running process's memory_write is in the event feed");
      });

      // --- the operator's window has to say what is true ------------------
      await checkAsync('the dashboard says what each agent was allowed to do', async () => {
        // Three agents, three authorities. The cases are chosen so that a
        // *second* rule cannot pass them: an empty set and the full set are
        // exactly where "join the list" and "say what it means" disagree.
        const cases = [
          { role: 'capped', capabilities: ['spawn'] as Capability[], label: 'spawn' },
          { role: 'powerless', capabilities: [] as Capability[], label: 'none' },
          { role: 'omnipotent', capabilities: [...CAPABILITIES], label: 'all' },
        ];
        const spawned: Array<{ pid: number; label: string }> = [];
        for (const c of cases) {
          const pid = await kernel.spawn({
            role: c.role,
            agent: { module: 'test:live', args: { mode: 'alive' } },
            capabilities: c.capabilities,
          });
          spawned.push({ pid: unbrand(pid), label: c.label });
        }
        await new Promise((resolve) => setTimeout(resolve, 50));

        const res = await fetch(`${dash.url}/api/processes`);
        const rows = (await res.json()) as Array<Record<string, unknown>>;
        for (const c of spawned) {
          const row = rows.find((r) => r['pid'] === c.pid);
          assert(row !== undefined, `the agent is in the list, got: ${JSON.stringify(rows.map((r) => r['pid']))}`);
          assert(
            row!['capsLabel'] === c.label,
            `pid ${c.pid} holds "${c.label}", got ${String(row!['capsLabel'])}`,
          );
          // One rule, two views: the label is the one the shared rule prints.
          assert(
            row!['capsLabel'] === formatCaps(row!['capabilities'] as Capability[]),
            `pid ${c.pid} follows the shared rule, got ${String(row!['capsLabel'])}`,
          );
        }

        // And the CLI says the same thing about the same agent.
        const prevLog = console.log;
        let psOut = '';
        console.log = (...parts: unknown[]): void => {
          psOut += `${parts.map((p) => String(p)).join(' ')}\n`;
        };
        try {
          await cmdPs([]);
        } finally {
          console.log = prevLog;
        }
        const psLine = psOut.split('\n').find((line) => line.trim().startsWith(`${spawned[0]!.pid} `));
        assert(psLine !== undefined, `cortex ps lists the agent, got: ${psOut}`);
        assert(
          psLine!.includes('spawn'),
          `cortex ps prints the same authority, got: ${psLine}`,
        );
      });

      await checkAsync('the dashboard says how a finished process ended', async () => {
        // The operator's window showed a finished run and a crashed one with
        // the same word — `zombie` — so "did it finish, or did it die?"
        // needed the trace view to answer. The kernel knows the code and the
        // reason; the row carries them, in the same words `cortex ps` and
        // `cortex top` print.
        await kernel.spawn({
          role: 'leaver',
          agent: { module: 'test:leaver', args: { mode: 'leaver' } },
        });
        await new Promise((resolve) => setTimeout(resolve, 600));

        const dead = kernel.table.list().find((info) => info.role === 'dead');
        assert(dead !== undefined, 'the child died and is still in the table');

        const res = await fetch(`${dash.url}/api/processes`);
        assert(res.status === 200, `status ${res.status}`);
        const rows = (await res.json()) as Array<Record<string, unknown>>;
        const row = rows.find((r) => r['pid'] === unbrand(dead!.pid));
        assert(row !== undefined, 'the dead process is in the list');
        assert(
          row!['outcomeLabel'] === 'exit 137 (signal:SIGKILL)',
          `the row carries the ending, got ${String(row!['outcomeLabel'])}`,
        );
        // One rule, three views: the label is the one the shared rule prints.
        assert(
          row!['outcomeLabel'] === describeOutcome({
            state: 'zombie',
            exitCode: dead!.exitCode,
            exitReason: dead!.exitReason,
          }),
          'the label follows the shared rule',
        );

        // And the page shows it — the label travels with the row, and the page
        // prints what it is given.
        const html = await (await fetch(`${dash.url}/`)).text();
        assert(html.includes('outcomeLabel'), 'the page prints the label it is given');
        assert(
          !html.includes('exitReason'),
          'the page does not work the ending out for itself',
        );
      });

      await checkAsync('the dashboard says when a process has run out of budget', async () => {
        // The operator's window: a process that has run out of budget cannot
        // go on, and nothing else in the row said so — a `ready` row that will
        // never run again looked exactly like one that was merely waiting. The
        // label comes from the server, which uses the same rule `cortex ps`
        // and `cortex top` print.
        await kernel.spawn({
          role: 'dry',
          agent: { module: 'test:dry', args: { mode: 'ok' } },
          budgets: { tokens: -1, usd: -1, wallTimeMs: 0 },
        });
        await new Promise((resolve) => setTimeout(resolve, 100));

        const dry = kernel.table.list().find((info) => info.role === 'dry');
        assert(dry !== undefined, 'the process is in the table');

        const res = await fetch(`${dash.url}/api/processes`);
        assert(res.status === 200, `status ${res.status}`);
        const rows = (await res.json()) as Array<Record<string, unknown>>;
        const row = rows.find((r) => r['pid'] === unbrand(dry!.pid));
        assert(row !== undefined, 'the process is in the list');
        assert(
          row!['budgetLabel'] === 'out of wallTime',
          `the row carries the budget, got ${String(row!['budgetLabel'])}`,
        );

        // And the page shows it — the label travels with the row, and the page
        // prints what it is given.
        const html = await (await fetch(`${dash.url}/`)).text();
        assert(html.includes('budgetLabel'), 'the page prints the label it is given');
      });

      await checkAsync('the process table follows what the kernel says happened', async () => {
        // The table used to be re-read only when a process started or ended.
        // An agent that works for a minute was shown as it was when it
        // started — its state frozen, its spend frozen — while the page
        // said "live connection".
        const pid = await kernel.spawn({
          role: 'mover',
          agent: { module: 'test:live', args: { mode: 'busy' } },
        });
        await new Promise((resolve) => setTimeout(resolve, 50));

        const res = await fetch(`${dash.url}/api/stream?limit=50`);
        assert(res.status === 200, `status ${res.status}`);
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        try {
          let text = '';
          const countOf = (needle: string): number => text.split(needle).length - 1;
          const readProcesses = async (want: number, ms: number): Promise<boolean> => {
            const deadline = Date.now() + ms;
            for (;;) {
              if (countOf('event: processes') >= want) return true;
              const left = deadline - Date.now();
              if (left <= 0) return false;
              let timer: ReturnType<typeof setTimeout> | undefined;
              const expiry = new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), left);
              });
              const chunk = await Promise.race([reader.read(), expiry]);
              if (timer !== undefined) clearTimeout(timer);
              if (chunk === null) return false;
              if (chunk.done) return false;
              text += decoder.decode(chunk.value, { stream: true });
            }
          };

          assert(await readProcesses(1, 3000), `the stream opened, got: ${text.slice(0, 300)}`);
          const firstAt = firstTransitionOf(text, unbrand(pid));

          // The agent keeps moving; nothing starts and nothing ends. The
          // table has to keep up — not once, but *continuously*. A throttle
          // that waited for the silence would freeze the table through
          // exactly the busy period it exists for, which is what a real
          // run caught: two tables in fifteen seconds.
          assert(
            await readProcesses(4, 4000),
            `the table kept coming, got ${countOf('event: processes')} tables`,
          );
          const secondAt = lastTransitionOf(text, unbrand(pid));

          assert(firstAt !== undefined, `the first table carries the agent, got: ${text.slice(0, 600)}`);
          assert(secondAt !== undefined, `the second table carries the agent, got: ${text.slice(0, 600)}`);
          assert(
            secondAt! > firstAt!,
            `the table is not a frozen snapshot — it showed ${firstAt} and then ${secondAt}`,
          );
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      });

      await checkAsync('the page does not re-implement what it is shown', async () => {
        const html = await (await fetch(`${dash.url}/`)).text();
        // The capability column comes from the server, which uses the same
        // rule `cortex ps` prints. A page that re-implemented the rule
        // would be a second rule — and the two would drift.
        assert(html.includes('capsLabel'), 'the page prints the label it is given');
        assert(
          !html.includes('capabilities.join'),
          'the page does not format capabilities itself',
        );
        // The "inside" column is the same story: the server asks the kernel
        // which call each agent is in, and the page prints what it is given.
        // A page that worked the wording out for itself would be a second
        // rule — and the two would drift.
        assert(html.includes('insideLabel'), 'the page prints the inside label it is given');
        assert(html.includes('insideHead'), 'the page has a column to put it in');
        assert(
          !html.includes('waiting on a channel'),
          'the page does not phrase the wait itself',
        );
        // The queued signals are the same story: the server owns the wording
        // (it is the same function `cortex ps` and `cortex top` use), and the
        // page prints what it is given.
        assert(html.includes('pendingLabel'), 'the page prints the pending-signal label it is given');
        assert(
          !html.includes('SIGTERM queued'),
          'the page does not phrase the queued signal itself',
        );
        // The footer says which way the page is being refreshed.
        assert(html.includes('实时推送'), 'the footer names the live mode');
        assert(html.includes('每 3 秒轮询'), 'the footer names the polling fallback');
        assert(
          !html.includes('自动刷新 · 每 3 秒'),
          'the page does not claim a 3-second refresh it is not doing',
        );
      });

      // Last, because it closes the dashboard: an open event stream is a
      // connection that never ends by itself, and `server.close()` waits for
      // it. The dashboard's own UI holds one open from the moment it loads,
      // so without a fix this is where Ctrl+C would hang the dashboard
      // instead of stopping it.
      await checkAsync('the dashboard stops even with a stream still open', async () => {
        const res = await fetch(`${dash.url}/api/stream?limit=5`);
        assert(res.status === 200, `status ${res.status}`);
        const reader = res.body!.getReader();
        try {
          const first = await reader.read();
          assert(first.done !== true, 'the stream is open');

          const outcome = await Promise.race([
            dash.close().then(() => 'closed'),
            new Promise((resolve) => setTimeout(() => resolve('still open'), 3000)),
          ]);
          assert(outcome === 'closed', `the dashboard did not close while a stream was attached (${outcome})`);
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      });
    } finally {
      await dash.close();
      client?.close();
    }
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    for (const server of servers) {
      try {
        await server.close();
      } catch {
        /* teardown is best-effort */
      }
    }
    for (const k of kernels) {
      try {
        await k.shutdown();
      } catch {
        /* teardown is best-effort */
      }
    }
    if (prevHome === undefined) delete process.env['CORTEX_HOME'];
    else process.env['CORTEX_HOME'] = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  }
}

// =============================================================================
// Attach-by-push checks (#062)
// =============================================================================
/**
 * `cortex attach <pid>` — following one agent, live.
 *
 * The command used to follow the process's `.crec` **file**: it polled it
 * every 250 ms and re-read the whole thing each time, so a frame arrived up
 * to a poll interval late and a long-running agent's log was read over and
 * over. With a live kernel the frames can come by push instead, and the
 * follow can end by itself — because the kernel says when the process ends,
 * and says how it ended.
 */
async function runAttachPushChecks(): Promise<void> {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { format } = await import('node:util');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-attachpush-'));
  const kernels: Kernel[] = [];
  const servers: { close: () => Promise<void> }[] = [];

  const prevHome = process.env['CORTEX_HOME'];
  const prevLog = console.log;
  const prevErr = console.error;

  try {
    const kernel = await bootKernel({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      dir: tmp,
      autoStart: true,
      loadDrivers: (reg) => {
        reg.registerMemory(inmemMemory());
      },
      agentLoader: async () => async (ctx, args) => {
        const mode = typeof args['mode'] === 'string' ? args['mode'] : 'wait';
        if (mode === 'write-on-message') {
          // One message in, one memory_write out, then the agent ends.
          await ctx.recv();
          await ctx.memory_write('semantic', 'attach-key', 'attach-value');
          return;
        }
        if (mode === 'exit-on-message') {
          await ctx.recv();
          ctx.exit(7, 'done on purpose');
          return;
        }
        await ctx.recv();
        return;
      },
    });
    kernels.push(kernel);

    const server = await startKernelServer(kernel, { log: () => {} });
    servers.push(server);
    writeEndpoint(tmp, server.endpoint);
    process.env['CORTEX_HOME'] = tmp;

    const probe = await probeKernel(tmp);
    assert(probe.kind === 'live', `probe finds the kernel, got ${probe.kind}`);
    const client = probe.kind === 'live' ? probe.client : undefined;

    // Run `cortex attach` in-process and capture what it prints.
    const runAttach = async (
      pid: number,
      timeoutMs: number,
    ): Promise<{ code: number; out: string }> => {
      const lines: string[] = [];
      const origLog = console.log;
      const origErr = console.error;
      console.log = (...args: unknown[]) => { lines.push(format(...args)); };
      console.error = (...args: unknown[]) => { lines.push(format(...args)); };
      try {
        const code = await cmdAttach([String(pid), '--follow', '--timeout-ms', String(timeoutMs)]);
        return { code, out: lines.join('\n') };
      } finally {
        console.log = origLog;
        console.error = origErr;
      }
    };

    try {
      await checkAsync('attach takes the frames by push when the kernel holds the process', async () => {
        const pid = await kernel.spawn({
          role: 'watched',
          agent: { module: 'test:live', args: { mode: 'write-on-message' } },
          // The CLI declares the standard regions for every process; the
          // kernel API does not, so the write below needs one to exist.
          memory: { semantic: { kind: 'shared', backing: 'inmem' } },
        });
        assert(pid !== undefined, 'the process was spawned');

        const attach = runAttach(unbrand(pid), 3000);
        // Give the attach a moment to open its subscription, then let the
        // agent do something: the frame it produces must reach the operator.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await client!.request('send', { pid: unbrand(pid), message: 'go' });

        const { code, out } = await attach;
        assert(out.includes('frames by push from the kernel'), `the follow says how it gets its frames, got:\n${out.slice(0, 400)}`);
        assert(out.includes('memory_write'), `the frame the agent produced is shown, got:\n${out.slice(0, 600)}`);
        assert(code === 0, `the follow ended cleanly, got ${code}`);
      });

      await checkAsync('attach shows a frame exactly once', async () => {
        const pid = await kernel.spawn({
          role: 'once',
          agent: { module: 'test:live', args: { mode: 'write-on-message' } },
          memory: { semantic: { kind: 'shared', backing: 'inmem' } },
        });
        assert(pid !== undefined, 'the process was spawned');

        const attach = runAttach(unbrand(pid), 3000);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await client!.request('send', { pid: unbrand(pid), message: 'go' });
        const { out } = await attach;

        // The history comes from the file and the live frames come from the
        // kernel, so the two overlap — the frame the agent just wrote is in
        // both. The byteOffset is what keeps it from being printed twice.
        // (A call is two frames — enter and exit — so the exit phase is what
        // is counted.)
        const writes = out.split('\n').filter((line) => /memory_write\s+exit\b/.test(line));
        assert(writes.length === 1, `the frame is printed once, got ${writes.length} copies:\n${writes.join('\n')}`);
      });

      await checkAsync('attach ends when the process ends, and says how it ended', async () => {
        const pid = await kernel.spawn({
          role: 'ending',
          agent: { module: 'test:live', args: { mode: 'exit-on-message' } },
        });
        assert(pid !== undefined, 'the process was spawned');

        const started = Date.now();
        const attach = runAttach(unbrand(pid), 8000);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await client!.request('send', { pid: unbrand(pid), message: 'go' });

        const { code, out } = await attach;
        const elapsed = Date.now() - started;
        // The follow ended because the process ended, not because the
        // timeout ran out — that is the difference between "I saw it finish"
        // and "I stopped looking".
        assert(elapsed < 8000, `the follow ended when the process did (took ${elapsed}ms)`);
        assert(out.includes('exited with code 7'), `the real exit code is reported, got:\n${out.slice(-400)}`);
        assert(code === 0, `a finished follow is a successful follow, got ${code}`);
      });
    } finally {
      client?.close();
    }
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    for (const server of servers) {
      try {
        await server.close();
      } catch {
        /* teardown is best-effort */
      }
    }
    for (const k of kernels) {
      try {
        await k.shutdown();
      } catch {
        /* teardown is best-effort */
      }
    }
    if (prevHome === undefined) delete process.env['CORTEX_HOME'];
    else process.env['CORTEX_HOME'] = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The cached tokens reach the operator.
 *
 * The kernel records three token counters (docs/STATE.md §2.4): the tokens a
 * model read, the tokens it wrote, and the part of the input the provider
 * served out of its cache. The cached part is **inside** the input — the
 * provider reports the whole prompt and says how much of it it did not have
 * to read again — and it is billed at the cache price.
 *
 * So an operator could see 1,000 tokens and a dollar bill that did not match
 * them, with nothing in any view to explain it: `cortex ps` and `cortex top`
 * printed the total alone, `cortex limit` printed the total alone, and the
 * dashboard had a column of totals and no column of cache.
 *
 * This group runs a real kernel with a real driver, makes a real cache hit,
 * and checks that the cached part reaches every view that shows tokens.
 */
async function runTokenUsageChecks(): Promise<void> {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-tokens-'));
  const kernels: Kernel[] = [];
  const servers: { close: () => Promise<void> }[] = [];

  const prevHome = process.env['CORTEX_HOME'];
  const prevLog = console.log;
  const prevErr = console.error;

  // --- §1 the rule, on its own -------------------------------------------

  check('a token count is the input and the output, with the cached part inside the input', () => {
    const usage = tokenUsage({ tokensIn: 1000, tokensOut: 200, tokensCached: 400 });
    assert(usage.total === 1200, `the total is the input and the output, got ${usage.total}`);
    assert(usage.cached === 400, `the cached part is counted, got ${usage.cached}`);
    assert(usage.fresh === 600, `the fresh part is the input minus the cached, got ${usage.fresh}`);
  });

  check('the cached part is counted once, not twice', () => {
    // A total that added the cached part on top of the input would drain the
    // token ceiling twice as fast as the work actually did.
    const spent = { tokensIn: 1000, tokensOut: 200, tokensCached: 400 };
    const total = tokenUsage(spent).total;
    assert(total === 1200, `the cached tokens are inside the input, got ${total}`);
    assert(
      total !== spent.tokensIn + spent.tokensOut + spent.tokensCached,
      'the cached part is not added on top of the input',
    );
  });

  check('a token cell says which part was cached — and only when there is one', () => {
    const withCache = formatTokenUsage({ tokensIn: 1000, tokensOut: 200, tokensCached: 400 });
    const withoutCache = formatTokenUsage({ tokensIn: 1000, tokensOut: 200, tokensCached: 0 });
    assert(withCache === '1.2k (400 cached)', `the cell names the cached part, got ${withCache}`);
    assert(withoutCache === '1.2k', `a process with no cached tokens says nothing about it, got ${withoutCache}`);
  });

  check('a budget cell says the spend and the ceiling it is measured against', () => {
    // The spend on its own is 12% of one budget and 99% of another, and the
    // two need very different answers. So the ceiling stands beside the
    // spend — and a budget with no ceiling says so rather than saying
    // nothing.
    const spent = {
      tokensIn: 1000,
      tokensOut: 200,
      tokensCached: 400,
      usdSpent: 0,
      wallTimeMs: 0,
      syscallCount: 0,
    };
    const bounded = formatTokenBudget({
      spent,
      remaining: { tokens: 8800, usd: -1, wallTimeMs: -1 },
    });
    assert(
      bounded === '1.2k (400 cached) of 10.0k',
      `the cell names the ceiling, got ${bounded}`,
    );
    const unbounded = formatTokenBudget({
      spent,
      remaining: { tokens: -1, usd: -1, wallTimeMs: -1 },
    });
    assert(
      unbounded === '1.2k (400 cached) of ∞',
      `a budget with no ceiling says so, got ${unbounded}`,
    );
    const money = formatUsdBudget({
      spent: { ...spent, usdSpent: 161 },
      // The remainder is what the process has LEFT, so the ceiling — the
      // spend plus the remainder — is the $1.00 it was granted.
      remaining: { tokens: -1, usd: 999_839, wallTimeMs: -1 },
    });
    assert(money === '$0.000161 of $1.000000', `the money cell names the ceiling, got ${money}`);
  });

  try {
    // --- §2 a real kernel, a real driver, a real cache hit ----------------

    const kernel = await bootKernel({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      dir: tmp,
      autoStart: true,
      loadDrivers: (reg) => {
        reg.registerMemory(inmemMemory());
        // A driver that serves a repeated prompt out of its cache — the way
        // a real provider does, and the only way the kernel ever learns that
        // a prompt was cached at all.
        reg.registerLLM(mockLLM({ cacheRepeated: true }));
      },
      agentLoader: async () => async (ctx) => {
        // The same prompt, twice: the second call is served out of the cache.
        const messages = [{ role: 'user' as const, content: CACHED_PROMPT }];
        await ctx.llm_call({ messages });
        await ctx.llm_call({ messages });
        // Stay alive. A process that has exited leaves no record behind in
        // this harness, and the views have to be able to show a live one.
        await ctx.recv();
      },
    });
    kernels.push(kernel);

    const server = await startKernelServer(kernel, { log: () => {} });
    servers.push(server);
    writeEndpoint(tmp, server.endpoint);
    process.env['CORTEX_HOME'] = tmp;

    // A budget, so the views have a ceiling to say: a spend on its own is 12%
    // of one budget and 99% of another.
    const pid = await kernel.spawn({
      role: 'cached',
      agent: { module: 'test:cached' },
      budgets: { tokens: 10_000, usd: 1_000_000, wallTimeMs: -1 },
    });

    // Wait for the second call to land: the cached count is only there once
    // the driver has answered twice.
    let inTokens = 0;
    let outTokens = 0;
    let cached = 0;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const entry = kernel.table.get(pid);
      if (entry !== undefined && entry.budgetsSpent.tokensCached > 0) {
        inTokens = entry.budgetsSpent.tokensIn;
        outTokens = entry.budgetsSpent.tokensOut;
        cached = entry.budgetsSpent.tokensCached;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const capture = async (
      run: () => Promise<number>,
    ): Promise<{ code: number; out: string; err: string }> => {
      let out = '';
      let err = '';
      const prevWrite = process.stdout.write;
      process.stdout.write = ((chunk: unknown): boolean => {
        out += String(chunk);
        return true;
      }) as unknown as typeof process.stdout.write;
      console.error = (...parts: unknown[]): void => {
        err += parts.map((p) => String(p)).join(' ') + '\n';
      };
      try {
        const code = await run();
        return { code, out, err };
      } finally {
        process.stdout.write = prevWrite;
        console.error = prevErr;
      }
    };

    await checkAsync('the kernel records the cached tokens the driver reported', async () => {
      assert(cached > 0, 'the driver served the second prompt out of its cache');
      assert(
        inTokens >= cached,
        `the cached part is inside the input, got in=${inTokens} cached=${cached}`,
      );
    });

    await checkAsync('the total a process spent counts the cached tokens once', async () => {
      const usage = tokenUsage({ tokensIn: inTokens, tokensOut: outTokens, tokensCached: cached });
      assert(
        usage.total === inTokens + outTokens,
        `the total is the input and the output, got ${usage.total}`,
      );
      assert(
        usage.fresh + usage.cached === inTokens,
        'the input splits into the fresh part and the cached part',
      );
    });

    await checkAsync('cortex ps says which part of a process\'s tokens was cached', async () => {
      const result = await capture(() => cmdPs([]));
      assert(result.code === 0, `exit 0, got ${result.code}: ${result.err}`);
      const row = psRow(result.out, unbrand(pid));
      assert(row !== '', `the process is in the table, got: ${result.out}`);
      assert(
        row.includes(`(${formatTokens(cached)} cached)`),
        `the row names the cached part, got: ${row}`,
      );
    });

    await checkAsync('cortex top says which part of a process\'s tokens was cached', async () => {
      const result = await capture(() => cmdTop([]));
      assert(result.code === 0, `exit 0, got ${result.code}: ${result.err}`);
      const row = topRow(result.out, unbrand(pid));
      assert(row !== '', `the process is in the tree, got: ${result.out}`);
      assert(
        row.includes(`(${formatTokens(cached)} cached)`),
        `the row names the cached part, got: ${row}`,
      );
      assert(
        result.out.includes(`tokens (${formatTokens(cached)} cached)`),
        `the summary names it too, got: ${result.out}`,
      );
    });

    await checkAsync('cortex limit says which part of the spend was cached', async () => {
      const result = await capture(() => cmdLimit([String(unbrand(pid))]));
      assert(result.code === 0, `exit 0, got ${result.code}: ${result.err}`);
      assert(
        result.out.includes(`(${cached} cached)`),
        `the tokens line names the cached part, got: ${result.out}`,
      );
    });

    await checkAsync('cortex ps says the ceiling the spend is measured against', async () => {
      const result = await capture(() => cmdPs([]));
      assert(result.code === 0, `exit 0, got ${result.code}: ${result.err}`);
      const row = psRow(result.out, unbrand(pid));
      assert(row !== '', `the process is in the table, got: ${result.out}`);
      // The spend, and the total it is measured against: '… of 10.0k'. A spend
      // on its own is 12% of one budget and 99% of another, and the two need
      // very different answers.
      assert(
        row.includes(`of ${formatTokens(10_000)}`),
        `the row names the ceiling, got: ${row}`,
      );
    });

    await checkAsync('cortex top says the ceiling too', async () => {
      const result = await capture(() => cmdTop([]));
      assert(result.code === 0, `exit 0, got ${result.code}: ${result.err}`);
      const row = topRow(result.out, unbrand(pid));
      assert(row !== '', `the process is in the tree, got: ${result.out}`);
      assert(
        row.includes(`of ${formatTokens(10_000)}`),
        `the token cell names the ceiling, got: ${row}`,
      );
      assert(
        row.includes(`of ${formatDollars(1)}`),
        `the money cell names the ceiling, got: ${row}`,
      );
    });

    await checkAsync('cortex limit and the tables agree about the ceiling', async () => {
      const result = await capture(() => cmdLimit([String(unbrand(pid))]));
      assert(result.code === 0, `exit 0, got ${result.code}: ${result.err}`);
      assert(
        result.out.includes(`limit ${10_000}`),
        `the report names the same ceiling, got: ${result.out}`,
      );
    });

    const probe = await probeKernel(tmp);
    assert(probe.kind === 'live', `probe finds the kernel, got ${probe.kind}`);
    const client = probe.kind === 'live' ? probe.client : undefined;
    const dash = await startDashboard({ dir: tmp, port: 0, kernel: client! });
    try {
      await checkAsync('the dashboard says which part of a process\'s tokens was cached', async () => {
        const res = await fetch(`${dash.url}/api/processes`);
        assert(res.status === 200, `status ${res.status}`);
        const rows = (await res.json()) as Array<Record<string, unknown>>;
        const row = rows.find((r) => r['pid'] === unbrand(pid));
        assert(
          row !== undefined,
          `the process is in the list, got: ${JSON.stringify(rows.map((r) => r['pid']))}`,
        );
        const label = String(row!['tokenLabel'] ?? '');
        assert(
          label.includes(`(${cached.toLocaleString()} cached)`),
          `the row names the cached part, got: ${label}`,
        );
      });

      await checkAsync('the dashboard page prints the token label it is given', async () => {
        const html = await (await fetch(`${dash.url}/`)).text();
        assert(html.includes('tokenLabel'), 'the page prints the label it is given');
        assert(html.includes('budgetCached'), 'the budget panel has a place for the cached total');
        assert(html.includes('<th>缓存</th>'), 'the budget table has a column for the cached part');
      });

      await checkAsync('the dashboard says the ceiling too', async () => {
        const res = await fetch(`${dash.url}/api/processes`);
        assert(res.status === 200, `status ${res.status}`);
        const rows = (await res.json()) as Array<Record<string, unknown>>;
        const row = rows.find((r) => r['pid'] === unbrand(pid));
        assert(
          row !== undefined,
          `the process is in the list, got: ${JSON.stringify(rows.map((r) => r['pid']))}`,
        );
        const label = String(row!['tokenLabel'] ?? '');
        assert(
          label.includes(`of ${(10_000).toLocaleString()}`),
          `the label names the ceiling, got: ${label}`,
        );
      });
    } finally {
      await dash.close();
    }
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    for (const server of servers) {
      try {
        await server.close();
      } catch {
        /* teardown is best-effort */
      }
    }
    for (const k of kernels) {
      try {
        await k.shutdown();
      } catch {
        /* teardown is best-effort */
      }
    }
    if (prevHome === undefined) delete process.env['CORTEX_HOME'];
    else process.env['CORTEX_HOME'] = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * A prompt long enough that the cached part is worth reading.
 *
 * A cache hit of two tokens is not something an operator would ever notice,
 * and a view that only showed the number would not be worth reading either.
 */
const CACHED_PROMPT =
  'The same prompt, sent twice, so that the second one is served out of the cache. ' +
  'It is deliberately long: a cache hit of two tokens is not something an operator would ' +
  'ever notice, and a view that only showed the number would not be worth reading either.';


/**
 * A promise that must finish before a deadline.
 *
 * The failure this guards against is a *hang*, so the deadline has to be
 * part of the test: without it, a command that never returns would take the
 * whole smoke run with it.
 */
async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} did not finish within ${ms}ms`));
        }, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * What happens when the kernel goes away under a command that is watching it.
 *
 * The failure is not a crash — it is a **lie**. A watch that ends quietly
 * reads as "the watch finished"; a supervisor that keeps running reads as
 * "the process is still supervised"; a wait that prints a raw socket error
 * says nothing an operator can act on. Each of them has to end, say what
 * happened, and refuse to report a success it did not have.
 */
async function runKernelGoneChecks(): Promise<void> {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-kernelgone-'));
  const kernels: Kernel[] = [];
  const servers: { close: () => Promise<void> }[] = [];

  const prevHome = process.env['CORTEX_HOME'];
  const prevLog = console.log;
  const prevErr = console.error;

  try {
    const kernel = await bootKernel({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      dir: tmp,
      autoStart: true,
      loadDrivers: (reg) => {
        reg.registerMemory(inmemMemory());
      },
      agentLoader: async () => async (ctx, args) => {
        const mode = typeof args['mode'] === 'string' ? args['mode'] : 'ok';
        if (mode === 'stuck') {
          // Blocks forever, inside a call. There is something to watch, and
          // something to wait for.
          await ctx.recv();
          return;
        }
        ctx.exit(0, 'all good');
      },
    });
    kernels.push(kernel);
    process.env['CORTEX_HOME'] = tmp;

    const capture = async (
      run: () => Promise<number>,
    ): Promise<{ code: number; out: string; err: string }> => {
      let out = '';
      let err = '';
      const prevWrite = process.stdout.write;
      process.stdout.write = ((chunk: unknown): boolean => {
        out += String(chunk);
        return true;
      }) as unknown as typeof process.stdout.write;
      console.error = (...parts: unknown[]): void => {
        err += parts.map((p) => String(p)).join(' ') + '\n';
      };
      try {
        const code = await run();
        return { code, out, err };
      } finally {
        process.stdout.write = prevWrite;
        console.error = prevErr;
      }
    };

    // One server per test: closing it *is* the kernel going away. The
    // descriptor stays on disk, so the directory can tell "shut down" from
    // "died" — which is exactly the diagnosis the command has to give.
    const startServer = async (): Promise<{ close: () => Promise<void> }> => {
      const server = await startKernelServer(kernel, { log: () => {} });
      servers.push(server);
      writeEndpoint(tmp, server.endpoint);
      return server;
    };

    await checkAsync('cortex watch says the kernel went away instead of exiting quietly', async () => {
      const server = await startServer();

      // No timeout: the watch waits for the operator. The only thing that
      // can end it is the kernel going away.
      const watching = capture(() => cmdWatch([]));

      // Let it subscribe before pulling the kernel out from under it.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await server.close();

      const result = await withDeadline(watching, 5000, 'the watch');
      assert(result.code === 1, `the watch reports the failure, got ${result.code}`);
      assert(
        result.err.includes('the watch did not finish'),
        `the watch says it did not finish, got: ${result.err.trim()}`,
      );
      assert(
        result.err.includes('kernel'),
        `the diagnosis names the kernel, got: ${result.err.trim()}`,
      );
      assert(
        !result.out.includes('# detached'),
        `the watch did not claim a clean detach, got: ${result.out}`,
      );
    });

    await checkAsync('cortex wait says the kernel went away instead of printing a socket error', async () => {
      const server = await startServer();
      const pid = await kernel.spawn({
        role: 'stuck',
        agent: { module: 'test:stuck', args: { mode: 'stuck' } },
      });

      const waiting = capture(() => cmdWait([String(unbrand(pid))]));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await server.close();

      const result = await withDeadline(waiting, 5000, 'the wait');
      assert(result.code === 1, `the wait reports the failure, got ${result.code}`);
      assert(
        result.err.includes('did not report an exit'),
        `the wait says the exit is unknown, got: ${result.err.trim()}`,
      );
      assert(
        !result.err.includes('ECONNRESET'),
        `the raw socket error is not what the operator sees, got: ${result.err.trim()}`,
      );
    });

    await checkAsync('cortex supervise stops when the kernel goes away instead of hanging', async () => {
      const server = await startServer();
      const pid = await kernel.spawn({
        role: 'stuck',
        agent: { module: 'test:stuck', args: { mode: 'stuck' } },
      });

      // A threshold far beyond the test: the supervisor must not kill
      // anything — the kernel is what goes away.
      const supervising = capture(() =>
        cmdSupervise([String(unbrand(pid)), '--kill-after', '30000']),
      );

      // Let the supervisor attach before the kernel disappears.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await server.close();

      const outcome = await Promise.race([
        supervising.then((result) => ({ kind: 'done' as const, result })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          const timer = setTimeout(() => resolve({ kind: 'timeout' }), 5000);
          timer.unref?.();
        }),
      ]);

      if (outcome.kind === 'timeout') {
        // A supervisor that is still running when the deadline hits is the
        // failure being tested for. Let it wind down *first*: it is still
        // holding the console, and a failure that swallows its own report
        // is no report at all.
        process.emit('SIGINT');
        await supervising.catch(() => undefined);
        assert(false, 'the supervisor did not stop when the kernel went away');
      }

      const result = outcome.result;
      assert(result.code === 1, `the supervisor reports the failure, got ${result.code}`);
      assert(
        result.err.includes('the fate of pid'),
        `the supervisor says the process's fate is unknown, got: ${result.err.trim()}`,
      );
      assert(
        !result.out.includes('exited'),
        `the supervisor did not invent an ending, got: ${result.out}`,
      );
    });

    await checkAsync('a client knows when the kernel has gone', async () => {
      const server = await startServer();
      const probe = await probeKernel(tmp);
      assert(probe.kind === 'live', `probe finds the kernel, got ${probe.kind}`);
      const client = probe.kind === 'live' ? probe.client : undefined;

      let closed = false;
      let told = false;
      client!.onClose(() => {
        told = true;
      });

      await server.close();
      await new Promise((resolve) => setTimeout(resolve, 100));

      closed = client!.closed;
      assert(closed, 'the client knows the connection is gone');
      assert(told, 'the client told the listener the connection is gone');

      // And a listener that arrives late is told at once.
      let late = false;
      client!.onClose(() => {
        late = true;
      });
      assert(late, 'a late listener is told the connection is already gone');
    });
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    for (const server of servers) {
      try {
        await server.close();
      } catch {
        /* teardown is best-effort */
      }
    }
    for (const k of kernels) {
      try {
        await k.shutdown();
      } catch {
        /* teardown is best-effort */
      }
    }
    if (prevHome === undefined) delete process.env['CORTEX_HOME'];
    else process.env['CORTEX_HOME'] = prevHome;
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

    await checkAsync('cortex daemon stop says plainly that there is nothing to stop', async () => {
      // No kernel is serving this directory, so there is nothing to stop.
      // The command must say that rather than pretend it stopped something.
      let err = '';
      console.log = () => {};
      console.error = (...parts: unknown[]): void => { err += parts.map((p) => String(p)).join(' ') + '\n'; };
      const code = await cmdDaemon(['stop']);
      console.log = prevLog;
      console.error = prevErr;
      assert(code === 1, `exit 1, got ${code}`);
      assert(err.includes('no daemon is running'), `the reason is reported, got: ${err.trim()}`);
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

    await checkAsync('the daemon says what its supervisor did', async () => {
      // A daemon's stdout is its log — systemd's journal and launchd's log
      // collect it. So the supervisor's decisions have to be *there*: a daemon
      // that crashed three times and was given up on printed "running" and
      // nothing else, and the terminal said so while the agent was dead and
      // never coming back.
      const home = mkdtempSync(join(tmpdir(), 'cortex-smoke-daemonsay-'));
      const prevHomeDaemon = process.env['CORTEX_HOME'];
      process.env['CORTEX_HOME'] = home;
      const modulePath = join(home, 'crash-agent.ts');
      writeFileSync(
        modulePath,
        `export default async function crashAgent(ctx: any): Promise<void> { ctx.exit(1, 'boom'); }\n`,
      );
      writeDaemon(home, {
        name: 'crasher',
        spec: {
          role: 'crasher',
          agent: { module: `file://${modulePath}` },
          restart: { kind: 'on-failure', maxRestarts: 1, backoffMs: 10 },
          memory: undefined,
        },
        installedAt: new Date().toISOString(),
      });

      const lines: string[] = [];
      const realLog = console.log;
      console.log = (...parts: unknown[]) => {
        lines.push(parts.map((p) => String(p)).join(' '));
      };
      try {
        await cmdDaemon(['run', 'crasher', '--max-runtime-ms', '400']);
      } finally {
        console.log = realLog;
        if (prevHomeDaemon === undefined) delete process.env['CORTEX_HOME'];
        else process.env['CORTEX_HOME'] = prevHomeDaemon;
      }
      const said = lines.join('\n');
      assert(
        said.includes('attempt 1 exited (code 1: boom)'),
        `the daemon did not say how its first attempt ended: ${said}`,
      );
      assert(
        said.includes('restarting as pid'),
        `the daemon did not say that it restarted: ${said}`,
      );
      assert(
        said.includes('not restarting: gave up after 1 restart(s)'),
        `the daemon did not say that it gave up: ${said}`,
      );
      await rmSync(home, { recursive: true, force: true });
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
// =============================================================================
// Kernel hardening checks — the two bugs the live-kernel transport exposed
// =============================================================================

/**
 * Both of these were invisible while the CLI could not deliver a real signal
 * or run two kernels in one directory. They are checked here, directly
 * against the kernel API, so they do not depend on the transport.
 */
async function runKernelHardeningChecks(): Promise<void> {
  const { mkdtempSync, rmSync, readdirSync, mkdirSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-hardening-'));

  const kernels: Kernel[] = [];

  async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return fn();
  }

  try {
    await checkAsync('a process killed by a signal persists its exit metadata', async () => {
      // The `exit` syscall persisted the meta; a signal death used to skip
      // that path entirely, so a killed agent vanished from `ps` instead of
      // showing up as a zombie with its exit code.
      const exits: { pid: number; exitCode: number | null; exitReason: string | null }[] = [];
      const k = await bootKernel({
        kernelAbiVersion: KERNEL_ABI_VERSION,
        dir: tmp,
        autoStart: true,
        loadDrivers: (reg) => reg.registerLLM(mockLLM()),
        agentLoader: async () => async (ctx) => {
          // Park on a long recv, so the kill lands on a BLOCKED process.
          try {
            await ctx.recv(undefined, { timeoutMs: 60_000 });
          } catch {
            /* the process is going away */
          }
        },
        onProcessExit: (meta) => {
          exits.push({ pid: meta.pid, exitCode: meta.exitCode, exitReason: meta.exitReason });
        },
      });
      kernels.push(k);

      const pid = await k.spawn({ role: 'victim', agent: { module: 'test:victim' } });
      assert(await waitFor(() => k.table.get(pid)?.state === 'blocked'), 'the victim parked');

      await k.signals.send(pid, 'SIGKILL');
      assert(await waitFor(() => exits.length > 0), 'the exit hook fired for the signal death');

      const meta = exits[0]!;
      assert(meta.pid === unbrand(pid), `the meta names the right pid, got ${meta.pid}`);
      assert(meta.exitReason === 'signal:SIGKILL', `exit reason, got ${meta.exitReason}`);
      assert(meta.exitCode === 137, `exit code, got ${meta.exitCode}`);
    });

    await checkAsync('a state frame records the state it came from, not the sender', async () => {
      // ABI.md §6.1 says the `__state` frame carries `from`, `to` and the
      // trigger that caused the transition. The signal path passed the
      // *sender's* pid in the transition's own metadata, and that metadata
      // used to be spread over the transition — so the frame recorded a pid
      // (or null) where the state belonged. The log said a process came
      // "from null", which is not a state at all.
      const k = await bootKernel({
        kernelAbiVersion: KERNEL_ABI_VERSION,
        dir: tmp,
        autoStart: true,
        loadDrivers: (reg) => reg.registerLLM(mockLLM()),
        agentLoader: async () => async (ctx) => {
          try {
            await ctx.recv(undefined, { timeoutMs: 60_000 });
          } catch {
            /* the process is going away */
          }
        },
      });
      kernels.push(k);

      const pid = await k.spawn({ role: 'signalled', agent: { module: 'test:signalled' } });
      assert(await waitFor(() => k.table.get(pid)?.state === 'blocked'), 'the agent parked');
      await k.signals.send(pid, 'SIGKILL');
      assert(
        await waitFor(() => k.table.get(pid)?.state === 'zombie' || k.table.get(pid) === undefined),
        'the agent died of the signal',
      );

      const frames: { args?: unknown }[] = [];
      for await (const rec of readRecords(existingCrecPath(tmp, pid))) {
        if (rec.syscall === '__state') frames.push(rec);
      }
      assert(frames.length > 0, 'the transitions were recorded');
      for (const frame of frames) {
        const args = (frame.args ?? {}) as Record<string, unknown>;
        assert(
          typeof args['from'] === 'string',
          `the frame records the state it came from, got ${JSON.stringify(args['from'])}`,
        );
        assert(
          typeof args['to'] === 'string',
          `the frame records the state it went to, got ${JSON.stringify(args['to'])}`,
        );
      }
    });

    await checkAsync('a second kernel in the same directory does not reuse a PID', async () => {
      // A state directory can host more than one kernel — a daemon plus a
      // short-lived CLI invocation. Each counts PIDs up from its own seed, so
      // without a claim the two walk into each other and the loser appends
      // to the winner's `log.crec`: two processes sharing one syscall log,
      // silently.
      const claimedBefore = new Set(
        readdirSync(join(tmp, 'processes')).filter((d) => /^\d+$/.test(d)),
      );
      const second = await bootKernel({
        kernelAbiVersion: KERNEL_ABI_VERSION,
        dir: tmp,
        autoStart: false,
        loadDrivers: (reg) => reg.registerLLM(mockLLM()),
        agentLoader: async () => async () => {},
      });
      kernels.push(second);
      const pid = unbrand(await second.spawn({ role: 'other', agent: { module: 'test:other' } }));
      assert(
        !claimedBefore.has(String(pid)),
        `the new pid ${pid} was already claimed by the first kernel`,
      );
      assert(claimedBefore.size >= 1, `the first kernel claimed a pid, got ${claimedBefore.size}`);
    });

    await checkAsync('SIGUSR2 takes a snapshot of the target', async () => {
      // `SIGUSR2` means "checkpoint now" (docs/PROCESS.md §7). The action was
      // documented, wired into the transition table, and named in three places
      // in the source — but nothing implemented it: the signal was delivered,
      // recorded, and dropped on the floor as "default action is ignore".
      const dir = join(tmp, 'sigusr2');
      mkdirSync(dir, { recursive: true });
      const k = await bootKernel({
        kernelAbiVersion: KERNEL_ABI_VERSION,
        dir,
        autoStart: true,
        loadDrivers: (reg) => reg.registerLLM(mockLLM()),
        agentLoader: async () => async () => {},
      });
      kernels.push(k);

      // Init lives in RUNNING, so the signal is delivered rather than queued.
      const outcome = await k.signals.send(asProcessId(1), 'SIGUSR2', asProcessId(1));
      assert(outcome === 'delivered', `the signal was delivered, got ${outcome}`);

      const snaps = existsSync(join(dir, 'processes', '1', 'checkpoints'))
        ? readdirSync(join(dir, 'processes', '1', 'checkpoints')).filter((f) => f.endsWith('.csnap'))
        : [];
      assert(snaps.length === 1, `exactly one snapshot was written, got ${snaps.length}`);

      // The cause is in the log: the `__signal` frame says SIGUSR2 arrived and
      // which snapshot it produced, right next to the `checkpoint` frames.
      const records: SyscallRecord[] = [];
      for await (const r of readRecords(existingCrecPath(dir, PID_INIT))) records.push(r);
      const sig = records.find((r) => r.syscall === '__signal');
      assert(sig !== undefined, 'the signal was recorded');
      const args = (sig!.args ?? {}) as { signal?: string; action?: string; chainId?: string };
      assert(args.signal === 'SIGUSR2', `the signal is SIGUSR2, got ${String(args.signal)}`);
      assert(args.action === 'checkpoint', `the action is checkpoint, got ${String(args.action)}`);
      assert(typeof args.chainId === 'string', 'the signal record names the snapshot');
      assert(
        snaps[0]!.includes(args.chainId!),
        `the snapshot file matches the recorded chain id (${snaps[0]} vs ${args.chainId})`,
      );

      const frames = records.filter((r) => r.syscall === 'checkpoint');
      assert(frames.length >= 2, `the checkpoint syscall was recorded, got ${frames.length} frames`);
      assert(
        frames.some((r) => r.phase === 'enter') && frames.some((r) => r.phase === 'exit'),
        'the checkpoint has an enter/exit pair',
      );
    });
  } finally {
    for (const k of kernels) {
      try {
        await k.shutdown();
      } catch {
        /* teardown is best-effort */
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

// =============================================================================
// CLI ↔ live-kernel transport checks
// =============================================================================

/**
 * The transport is the piece that makes a *running* kernel reachable from
 * another process, so these checks exercise the whole path: a real kernel on
 * a real directory, a real TCP server on loopback, a real client, and the
 * real syscall log afterwards.
 */
async function runTransportChecks(): Promise<void> {
  const { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-transport-'));

  const kernels: Kernel[] = [];

  /** Poll until `fn()` is true, or give up. */
  async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return fn();
  }

  try {
    // --- the endpoint descriptor -------------------------------------------
    await checkAsync('the endpoint descriptor round-trips through kernel.json', async () => {
      const endpoint = {
        host: '127.0.0.1',
        port: 4242,
        pid: 1234,
        token: 'secret-token',
        startedAt: '2026-01-01T00:00:00.000Z',
        abiVersion: KERNEL_ABI_VERSION,
        dir: tmp,
      };
      writeEndpoint(tmp, endpoint);
      assert(existsSync(join(tmp, 'kernel.json')), 'kernel.json written');
      const read = readEndpoint(tmp);
      assert(read !== undefined, 'descriptor reads back');
      assert(read!.port === 4242, `port round-trips, got ${read!.port}`);
      assert(read!.token === 'secret-token', 'token round-trips');
      assert(read!.abiVersion === KERNEL_ABI_VERSION, 'abi version round-trips');

      // Clearing is conditional on the descriptor still naming this kernel.
      assert(clearEndpoint(tmp, { ...endpoint, port: 9999 }) === false, 'a foreign descriptor is not cleared');
      assert(existsSync(join(tmp, 'kernel.json')), 'descriptor survives a mismatched clear');
      assert(clearEndpoint(tmp, endpoint) === true, 'the matching descriptor is cleared');
      assert(!existsSync(join(tmp, 'kernel.json')), 'kernel.json removed');
    });

    await checkAsync('a corrupt endpoint descriptor reads as "no endpoint"', async () => {
      writeFileSync(join(tmp, 'kernel.json'), '{not json', 'utf8');
      assert(readEndpoint(tmp) === undefined, 'corrupt descriptor is ignored');
      writeFileSync(join(tmp, 'kernel.json'), '{"host":"127.0.0.1"}', 'utf8');
      assert(readEndpoint(tmp) === undefined, 'incomplete descriptor is ignored');
    });

    // --- a live kernel, reached over the wire ------------------------------
    const received: string[] = [];
    const exits: { pid: number; exitCode: number | null; exitReason: string | null }[] = [];
    let agentStarted = false;

    const kernel = await bootKernel({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      dir: tmp,
      autoStart: true,
      loadDrivers: (reg) => reg.registerLLM(mockLLM()),
      agentLoader: async () => async (ctx, args) => {
        // A listener: park on recv until something is delivered. Only a
        // timeout is the idle case — anything else means the process is
        // going away, and swallowing that would spin the body forever.
        agentStarted = true;
        const timeoutMs = typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : 50;
        for (;;) {
          try {
            const msg = await ctx.recv(undefined, { timeoutMs });
            received.push(String(msg.body));
          } catch (err) {
            const errno = (err as { errno?: string }).errno;
            if (errno !== 'ETIMEDOUT') throw err;
          }
        }
      },
      onProcessExit: (meta) => {
        exits.push({
          pid: meta.pid,
          exitCode: meta.exitCode,
          exitReason: meta.exitReason,
        });
      },
    });
    kernels.push(kernel);

    // The received array collects every agent's inbox, so a check that needs
    // "did this agent hear anything" compares its length before and after.
    let shutdownRequested = false;
    const server = await startKernelServer(kernel, {
      log: () => {},
      // The hook deliberately does NOT stop the kernel: the check below
      // asserts that the request reached it, and the rest of the suite still
      // needs a live kernel.
      onShutdown: () => {
        shutdownRequested = true;
      },
    });
    writeEndpoint(tmp, server.endpoint);

    try {
      const probe = await probeKernel(tmp);
      assert(probe.kind === 'live', `probe finds the live kernel, got ${probe.kind}`);

      const client = probe.kind === 'live' ? probe.client : undefined;
      assert(client !== undefined, 'client exists');

      // The chain id of the last checkpoint taken over the wire. The tag
      // lookup check below reads it back out of the log by tag — which is the
      // path `cortex restore --tag` takes.
      let midFlightChainId: string | undefined;

      await checkAsync('a remote send delivers into a live agent\'s inbox', async () => {
        const pid = await kernel.spawn({ role: 'listener', agent: { module: 'test:listener' } });
        assert(await waitFor(() => agentStarted), 'the agent started');
        assert(
          await waitFor(() => kernel.table.get(pid)?.state === 'blocked'),
          'the agent parked on recv',
        );

        await client!.request('send', { pid: unbrand(pid), message: 'hello over the wire' });
        assert(await waitFor(() => received.length > 0), 'the agent received the message');
        assert(received[0] === 'hello over the wire', `message body, got ${received[0]}`);
      });

      await checkAsync('a remote send is recorded as a send syscall in the caller\'s log', async () => {
        const sends: SyscallRecord[] = [];
        for await (const r of readRecords(existingCrecPath(tmp, PID_INIT))) {
          if (r.syscall === 'send') sends.push(r);
        }
        assert(sends.length > 0, 'init logged the remote send');
        const phases = sends.map((r) => r.phase).sort();
        assert(
          phases.includes('enter') && phases.includes('exit'),
          `the send has an enter/exit pair, got ${phases.join(',')}`,
        );
      });

      await checkAsync('a remote send to an unknown pid is refused with ESRCH', async () => {
        const response = await client!.requestRaw('send', { pid: 9999, message: 'nobody home' });
        assert(response.ok === false, 'the send is refused');
        if (!response.ok) {
          assert(response.error.errno === 'ESRCH', `errno ESRCH, got ${response.error.errno}`);
        }
      });

      await checkAsync('a request with the wrong token is refused', async () => {
        const { connect } = await import('node:net');
        const socket = connect({
          host: server.endpoint.host,
          port: server.endpoint.port,
        });
        const rogue = new KernelClient({ ...server.endpoint, token: 'not-the-token' }, socket);
        const response = await rogue.requestRaw('ps');
        rogue.close();
        assert(response.ok === false, 'the rogue request is refused');
        if (!response.ok) {
          assert(response.error.errno === 'EPERM', `errno EPERM, got ${response.error.errno}`);
        }
      });

      await checkAsync('a remote kill delivers a real signal to the live agent', async () => {
        const pid = await kernel.spawn({ role: 'victim', agent: { module: 'test:listener' } });
        assert(await waitFor(() => kernel.table.get(pid)?.state !== undefined), 'the victim exists');

        const response = await client!.requestRaw('kill', { pid: unbrand(pid), signal: 'SIGKILL' });
        assert(response.ok === true, `the kill is accepted, got ${JSON.stringify(response)}`);
        // Init reaps its own children, so the entry is gone by the time we
        // look — the exit metadata is the durable evidence.
        assert(
          await waitFor(() => exits.some((m) => m.pid === unbrand(pid))),
          'the agent died of the signal',
        );
        const meta = exits.find((m) => m.pid === unbrand(pid));
        assert(meta?.exitReason === 'signal:SIGKILL', `exit reason, got ${meta?.exitReason}`);
        assert(meta?.exitCode === 137, `exit code, got ${meta?.exitCode}`);
      });

      await checkAsync('a process killed by a signal still gets its exit metadata', async () => {
        // The `exit` syscall persisted the meta; a signal death used to skip
        // that path entirely, so a killed agent vanished from `ps` instead of
        // showing up as a zombie with its exit code.
        assert(exits.length > 0, 'the exit hook fired for the signal death');
      });

      await checkAsync('the live kernel reports its process table over the wire', async () => {
        const response = await client!.requestRaw('ps');
        assert(response.ok === true, `ps succeeds, got ${JSON.stringify(response)}`);
        if (!response.ok) return;
        const processes = (response.result as { processes: readonly { pid: number }[] }).processes;
        assert(Array.isArray(processes), 'ps returns a list');
        assert(
          processes.some((p) => p.pid === 1),
          'the live table contains init',
        );
      });

      await checkAsync('a remote limit reads and sets a live agent\'s budget', async () => {
        // A budget is a thing a running process has, and a running process has
        // no `meta.json` yet (the kernel writes that when it exits). So
        // without a way to reach the live kernel, the ceiling of a running
        // agent was unreachable from the shell at all.
        const pid = await kernel.spawn({ role: 'budgeted', agent: { module: 'test:listener' } });
        assert(await waitFor(() => kernel.table.get(pid)?.state === 'blocked'), 'the agent parked');

        const before = await client!.request<{ remaining: { tokens: number } }>('limit', {
          pid: unbrand(pid),
        });
        assert(
          before.remaining.tokens === -1,
          `the agent starts unlimited, got ${before.remaining.tokens}`,
        );

        // The kernel's own accounting: it has spent 100 tokens already.
        kernel.table.spend(pid, { tokensIn: 100 });

        await client!.request('limit', { pid: unbrand(pid), tokens: 1000 });
        const after = await client!.request<{
          spent: { tokensIn: number };
          remaining: { tokens: number };
        }>('limit', { pid: unbrand(pid) });

        // The ceiling is the **total**, not a top-up: 1000, of which 100 is
        // already spent. A top-up would have made the ceiling 1100.
        assert(
          after.remaining.tokens === 900,
          `the ceiling is the total, got ${after.remaining.tokens} left`,
        );
        assert(after.spent.tokensIn === 100, 'the spend is untouched');
      });

      await checkAsync('a remote ps leaves no trace in the kernel\'s log', async () => {
        // The transport's `ps` is the operator *looking* at the process table,
        // not an agent doing something — so it must not write a frame into
        // init's log. It used to: every poll went through `dispatcher.invoke`,
        // so a monitoring loop grew the supervisor's causal history without
        // doing any work.
        const countPsFrames = async (): Promise<number> => {
          let n = 0;
          for await (const r of readRecords(existingCrecPath(tmp, PID_INIT))) {
            if (r.syscall === 'ps') n += 1;
          }
          return n;
        };
        const before = await countPsFrames();
        for (let i = 0; i < 5; i += 1) {
          const response = await client!.requestRaw('ps');
          assert(response.ok === true, `ps ${i} succeeds, got ${JSON.stringify(response)}`);
        }
        const after = await countPsFrames();
        assert(after === before, `no ps frames were written, got ${after - before}`);
      });

      await checkAsync('a remote checkpoint snapshots a live agent', async () => {
        // The whole point of the transport: a process that is *running* can be
        // snapshotted from another process. Before the transport existed this
        // was impossible — the CLI booted a fresh kernel whose process table
        // held only init, so the PID it was asked about was never there.
        const pid = await kernel.spawn({
          role: 'snapshot-me',
          agent: { module: 'test:listener', args: { timeoutMs: 5000 } },
        });
        assert(await waitFor(() => kernel.table.get(pid)?.state !== undefined), 'the agent exists');
        // Park it first: a checkpoint of a BLOCKED agent is the interesting
        // case, because the process is taken out of BLOCKED while its `recv`
        // waiter is still pending. A long recv timeout keeps that waiter
        // pending for the whole check — with a short one the timeout may fire
        // while the process is still READY, and the wake would then be
        // released by the next dispatch, hiding the bug.
        assert(
          await waitFor(() => kernel.table.get(pid)?.state === 'blocked'),
          'the agent parked on recv',
        );

        const response = await client!.requestRaw('checkpoint', {
          pid: unbrand(pid),
          tag: 'mid-flight',
        });
        assert(response.ok === true, `the checkpoint is accepted, got ${JSON.stringify(response)}`);
        if (!response.ok) return;
        const result = response.result as { chainId: string; path: string | null; state: string | null };
        assert(typeof result.chainId === 'string' && result.chainId.length > 0, 'a chain id came back');
        midFlightChainId = result.chainId;
        assert(result.path !== null, 'the snapshot path came back');
        assert(existsSync(result.path!), `the snapshot exists at ${String(result.path)}`);
        assert(result.path!.endsWith('.csnap'), 'the snapshot is a .csnap');

        // The snapshot is recorded in the *target's* log, like any checkpoint,
        // and it carries the tag — which is how `cortex restore --tag` finds it.
        const frames: SyscallRecord[] = [];
        for await (const r of readRecords(existingCrecPath(tmp, pid))) frames.push(r);
        const cps = frames.filter((r) => r.syscall === 'checkpoint');
        assert(cps.length >= 2, `the checkpoint frames landed, got ${cps.length}`);
        const enter = cps.find((r) => r.phase === 'enter');
        const enterArgs = (enter?.args ?? {}) as { tag?: string };
        assert(enterArgs.tag === 'mid-flight', `the tag is recorded, got ${String(enterArgs.tag)}`);

        // A checkpoint is not a kill.
        assert(kernel.table.get(pid) !== undefined, 'the agent survived the checkpoint');

        // And it is not a hang either. A checkpoint of a BLOCKED agent takes
        // it out of BLOCKED while its `recv` waiter is still pending, so the
        // wake that settles that waiter has no dispatch to wait for — the
        // agent used to hang there forever, with no further syscall frames.
        // Wait until the scheduler has really dispatched it (RUNNING), so the
        // wake really has nowhere to go.
        assert(
          await waitFor(() => kernel.table.get(pid)?.state === 'running'),
          'the scheduler dispatched the checkpointed agent',
        );
        const before = received.length;
        await client!.request('send', { pid: unbrand(pid), message: 'still there?' });
        assert(
          await waitFor(() => received.length > before),
          'the agent still receives messages after the checkpoint',
        );
      });

      await checkAsync('a checkpoint tag resolves back to its chain id', async () => {
        // The tag is an *argument* and the chain id is a *result*, so since
        // the checkpoint moved onto the dispatcher's recording path they live
        // in different frames of the same call — the `enter` frame carries
        // `{tag, detach}` and the `exit` frame carries `{chainId, …}`. The
        // reader has to pair them.
        //
        // It did not, for a while. The old checkpoint module wrote ONE frame
        // with both, so a reader that looked for a single frame carrying
        // `args.tag` *and* `result.chainId` worked — and when the frames
        // split, that reader quietly stopped finding anything. The symptom was
        // `cortex restore --tag X` answering "no checkpoint found with tag X"
        // for a checkpoint that was sitting on disk. The old check wrote a
        // hand-made frame with both facts in it, so it kept passing.
        assert(midFlightChainId !== undefined, 'the checkpoint above produced a chain id');
        const resolved = await findCheckpointByTag(tmp, 'mid-flight');
        assert(
          resolved === midFlightChainId,
          `the tag resolved to the chain id, got ${String(resolved)} (expected ${String(midFlightChainId)})`,
        );
        const unknown = await findCheckpointByTag(tmp, 'no-such-tag-anywhere');
        assert(unknown === undefined, 'an unknown tag resolves to nothing');
      });

      await checkAsync('a remote restore revives a checkpointed agent in the live kernel', async () => {
        // `cortex restore` normally boots a kernel of its own, runs the
        // restored agent to completion, and exits — so the restored agent's
        // life is bounded by the command. That is the wrong shape for the
        // promise a checkpoint makes: *pause, and come back to work*.
        //
        // Asking the live kernel instead leaves the restored process running
        // there, with a new PID, its role intact, and reachable by every other
        // transport command.
        const pid = await kernel.spawn({
          role: 'restore-me',
          agent: { module: 'test:listener', args: { timeoutMs: 5000 } },
        });
        assert(await waitFor(() => kernel.table.get(pid)?.state !== undefined), 'the agent exists');
        assert(
          await waitFor(() => kernel.table.get(pid)?.state === 'blocked'),
          'the agent parked on recv',
        );

        const snap = await client!.requestRaw('checkpoint', { pid: unbrand(pid), tag: 'to-restore' });
        assert(snap.ok === true, `the checkpoint is accepted, got ${JSON.stringify(snap)}`);
        if (!snap.ok) return;
        const chainId = (snap.result as { chainId: string }).chainId;

        const response = await client!.requestRaw('restore', { chainId });
        assert(response.ok === true, `the restore is accepted, got ${JSON.stringify(response)}`);
        if (!response.ok) return;
        const result = response.result as { pid: number };
        assert(Number.isInteger(result.pid), `a pid came back, got ${String(result.pid)}`);
        assert(result.pid !== unbrand(pid), 'the restored process has a new pid');

        const entry = kernel.table.get(asProcessId(result.pid));
        assert(entry !== undefined, 'the restored agent is in the live kernel');
        assert(entry!.role === 'restore-me', `the role survived the restore, got ${entry!.role}`);

        // It keeps running — that is the whole point of restoring into a live
        // kernel rather than one of the command's own.
        assert(
          await waitFor(() => kernel.table.get(asProcessId(result.pid))?.state !== undefined),
          'the restored agent is still there a moment later',
        );
        assert(
          await waitFor(() => kernel.table.get(asProcessId(result.pid))?.state === 'blocked'),
          'the restored agent parked on recv',
        );

        // And it is reachable like any other live agent.
        const before = received.length;
        await client!.request('send', { pid: result.pid, message: 'hello, restored agent' });
        assert(
          await waitFor(() => received.length > before),
          'the restored agent receives messages',
        );
      });

      await checkAsync('a remote spawn starts an agent in the live kernel', async () => {
        // `cortex spawn` boots a kernel of its own, runs the agent to
        // completion and exits — the agent's life is bounded by the command.
        // Asking a live kernel instead gives an agent that keeps running, and
        // that every other transport command (send, checkpoint, kill) can
        // then reach.
        const response = await client!.requestRaw('spawn', {
          role: 'spawned',
          agent: { module: 'test:listener' },
        });
        assert(response.ok === true, `the spawn is accepted, got ${JSON.stringify(response)}`);
        if (!response.ok) return;
        const result = response.result as { pid: number };
        assert(Number.isInteger(result.pid), `a pid came back, got ${String(result.pid)}`);

        const entry = kernel.table.get(asProcessId(result.pid));
        assert(entry !== undefined, 'the agent is in the live kernel');
        assert(entry!.role === 'spawned', `the role is spawned, got ${entry!.role}`);
        assert(entry!.ppid === 1, `init is its parent, got ${String(entry!.ppid)}`);

        // It keeps running — that is the whole point of the live kernel.
        assert(
          await waitFor(() => kernel.table.get(asProcessId(result.pid))?.state !== undefined),
          'the agent is still there a moment later',
        );
        assert(
          await waitFor(() => kernel.table.get(asProcessId(result.pid))?.state === 'blocked'),
          'the spawned agent parked on recv',
        );

        // And it is reachable like any other live agent.
        const before = received.length;
        await client!.request('send', { pid: result.pid, message: 'hello, spawned agent' });
        assert(
          await waitFor(() => received.length > before),
          'the spawned agent receives messages',
        );
      });

      await checkAsync('a remote fork clones a live agent', async () => {
        // `cortex fork` used to be a command that could not succeed: it
        // booted a kernel of its own, looked the PID up in *that* kernel's
        // table, and answered "no such process" for a process that was very
        // much alive somewhere else. A fork snapshots a *running* process, so
        // it has to ask the kernel that has one.
        const pid = await kernel.spawn({
          role: 'fork-me',
          agent: { module: 'test:listener', args: { timeoutMs: 5000 } },
        });
        assert(await waitFor(() => kernel.table.get(pid)?.state !== undefined), 'the agent exists');
        assert(
          await waitFor(() => kernel.table.get(pid)?.state === 'blocked'),
          'the agent parked on recv',
        );

        const response = await client!.requestRaw('fork', {
          pid: unbrand(pid),
          tag: 'branch-b',
        });
        assert(response.ok === true, `the fork is accepted, got ${JSON.stringify(response)}`);
        if (!response.ok) return;
        const result = response.result as {
          childPid: number;
          childChainId: string;
          sharedCausalPast: number;
        };
        assert(Number.isInteger(result.childPid), `a child pid came back, got ${String(result.childPid)}`);
        assert(result.childPid !== unbrand(pid), 'the child has its own pid');

        const child = kernel.table.get(asProcessId(result.childPid));
        assert(child !== undefined, 'the child is in the live kernel');
        assert(child!.ppid === pid, `the forked process is its parent, got ${String(child!.ppid)}`);
        assert(child!.role === 'fork-me', `the role is inherited, got ${child!.role}`);

        // The fork is recorded in the *parent's* log — that frame carries the
        // shared causal past, which is where `cortex diff` cuts the two
        // branches apart.
        const frames: SyscallRecord[] = [];
        for await (const r of readRecords(existingCrecPath(tmp, pid))) frames.push(r);
        const forkFrames = frames.filter((r) => r.syscall === 'fork');
        assert(forkFrames.length >= 2, `the fork frames landed, got ${forkFrames.length}`);
        const exitFrame = forkFrames.find((r) => r.phase === 'exit');
        const forkResult = (exitFrame?.result ?? {}) as { childPid?: unknown };
        assert(forkResult.childPid === result.childPid, 'the record names the child');

        // And the child keeps running — a branch, not a snapshot.
        assert(
          await waitFor(() => kernel.table.get(asProcessId(result.childPid))?.state === 'blocked'),
          'the child parked on recv',
        );

        // Leave the kernel as we found it: the branch is still running, and
        // the checks after this one share the same kernel.
        await client!.requestRaw('kill', { pid: result.childPid, signal: 'SIGKILL' });
      });

      await checkAsync('a remote shutdown asks the kernel to stop', async () => {
        const response = await client!.requestRaw('shutdown');
        assert(response.ok === true, `the shutdown is accepted, got ${JSON.stringify(response)}`);
        assert(await waitFor(() => shutdownRequested), 'the kernel was asked to stop');
      });

      await checkAsync('a remote SIGUSR2 checkpoints the target', async () => {
        // The other route to the same snapshot: `SIGUSR2` means "checkpoint
        // now" (docs/PROCESS.md §7), and the kernel mediates it.
        const pid = await kernel.spawn({ role: 'signalled', agent: { module: 'test:listener' } });
        assert(await waitFor(() => kernel.table.get(pid)?.state !== undefined), 'the agent exists');

        const response = await client!.requestRaw('kill', { pid: unbrand(pid), signal: 'SIGUSR2' });
        assert(response.ok === true, `the signal is accepted, got ${JSON.stringify(response)}`);
        if (!response.ok) return;
        const result = response.result as { outcome: string };
        assert(
          result.outcome === 'delivered' || result.outcome === 'queued',
          `the signal was delivered or queued, got ${result.outcome}`,
        );

        // A signal to a parked process is queued, not delivered
        // (docs/PROCESS.md §7.2), so the snapshot lands on the agent's next
        // turn — the wait is the point.
        const dir = join(tmp, 'processes', String(unbrand(pid)), 'checkpoints');
        const written = await waitFor(
          () => existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.csnap')),
          5000,
        );
        assert(written, 'the signal produced a snapshot');

        // The cause is recorded: a `__signal` frame saying SIGUSR2 arrived and
        // which snapshot it produced. The signal is queued first and delivered
        // later, so the frame that carries the snapshot is the delivered one —
        // and it lands just after the snapshot file does, so wait for it.
        const isDelivered = (r: SyscallRecord): boolean => {
          if (r.syscall !== '__signal') return false;
          const a = (r.args ?? {}) as { signal?: string; outcome?: string };
          return a.signal === 'SIGUSR2' && a.outcome === 'delivered';
        };
        let sig: SyscallRecord | undefined;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && sig === undefined) {
          for await (const r of readRecords(existingCrecPath(tmp, pid))) {
            if (isDelivered(r)) {
              sig = r;
              break;
            }
          }
          if (sig === undefined) await new Promise((r) => setTimeout(r, 20));
        }
        assert(sig !== undefined, 'the delivery was recorded');
        const args = (sig!.args ?? {}) as { action?: string; chainId?: string };
        assert(args.action === 'checkpoint', `the action is checkpoint, got ${String(args.action)}`);
        assert(typeof args.chainId === 'string', 'the signal record names the snapshot');
      });
    } finally {
      await server.close();
      clearEndpoint(tmp, server.endpoint);
    }
  } finally {
    for (const k of kernels) {
      try {
        await k.shutdown();
      } catch {
        /* teardown is best-effort */
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

// =============================================================================
// Replay — STATE.md §5.5: "you can always replay an agent's reasoning
// deterministically"
// =============================================================================

/**
 * The replay engine, made falsifiable.
 *
 * The claim is not "a replay exists" — it is four specific things:
 *
 *  1. the model's answer comes from the **recording**, not from the world;
 *  2. so do the clock and the RNG, which are the two things that would
 *     otherwise make two runs of the same code incomparable;
 *  3. a replay does **not** need the model provider the original run used —
 *     which is what makes a recording worth keeping;
 *  4. and a replay that cannot answer says so, instead of quietly reaching
 *     for the real world and pretending to be a faithful reproduction.
 */
async function runReplayChecks(): Promise<void> {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-replay-'));
  const kernels: Kernel[] = [];
  const prevHome = process.env['CORTEX_HOME'];

  /**
   * A driver that always answers with the same text — so a replay's answer
   * can be told apart from a live one.
   */
  const fixedDriver = (text: string): ILLMDriver => ({
    name: 'fixed',
    version: '1.0.0',
    abiCompat: '*',
    supportedModels: [],
    call: async (): Promise<LLMResponse> => ({
      text,
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, usd: 0 },
      model: 'fixed',
      driverVersion: '1.0.0',
    }),
    close: async () => {},
  });

  /**
   * A tool driver that answers with a fixed output — and counts how often it
   * was actually run, because "a replay does not repeat a side effect" is a
   * claim about the counter, not about the answer.
   */
  const fixedTool = (output: string, counter: { count: number }): IToolDriver => ({
    name: 'fixed-tool',
    version: '1.0.0',
    abiCompat: '*',
    listTools: async () => [
      {
        name: 'probe_tool',
        description: 'a probe tool',
        inputSchema: { type: 'object' },
        reversibility: 'reversible',
      },
    ],
    invoke: async () => {
      counter.count += 1;
      return { output, error: null, durationMs: 0, reversibility: 'reversible' };
    },
    close: async () => {},
  });

  /**
   * The pids the tree agents started, so a check can find a child's log.
   */
  const treeChildren: number[] = [];

  /**
   * The agent every replay check runs: the clock, the RNG, the model.
   *
   * `mode: 'twice'` asks for a second model call — more than the recording
   * holds — which is how "the recording ran out" is provoked.
   * `mode: 'tool'` calls a tool, which is how "a replay does not repeat a
   * side effect" is provoked.
   *
   * `mode: 'tree'` is a **supervision tree**: the parent starts a child,
   * waits for it, and then talks to the model itself. Both processes call
   * the model, which is what makes "each process answers from its own
   * recording" observable — with one shared recording the child would be
   * handed the parent's answer.
   */
  const agentLoader = async () =>
    async (ctx: CortexContext, args: Record<string, unknown>): Promise<void> => {
      const mode = typeof args['mode'] === 'string' ? args['mode'] : 'once';

      if (mode === 'tree') {
        const child = await ctx.spawn({
          role: 'leaf',
          agent: { module: 'test:probe', args: { mode: 'child' } },
        });
        treeChildren.push(unbrand(child.pid));
        await ctx.wait(child.pid);
        await ctx.llm_call({ messages: [{ role: 'user', content: 'PARENT-PROMPT' }] });
        ctx.exit(0, 'tree done');
        return;
      }
      if (mode === 'child') {
        await ctx.llm_call({ messages: [{ role: 'user', content: 'CHILD-PROMPT' }] });
        ctx.exit(0, 'child done');
        return;
      }

      ctx.now();
      ctx.random();
      await ctx.llm_call({ messages: [{ role: 'user', content: 'PROMPT' }] });
      if (mode === 'twice') {
        await ctx.llm_call({ messages: [{ role: 'user', content: 'PROMPT' }] });
      }
      if (mode === 'tool') {
        await ctx.tool_call('probe_tool', { probe: true });
      }
      ctx.exit(0, 'done');
    };

  /**
   * One recorded frame — the shape a `.crec` file holds.
   *
   * Hand-made frames are how a check builds a recording it can reason
   * about: a tree that was never run, a call that never happened.
   */
  const frame = (pid: number, syscall: string, result: unknown): SyscallRecord => ({
    byteOffset: asSyscallOffset(8),
    timestamp: '2026-01-01T00:00:00.000Z' as Timestamp,
    pid: asProcessId(pid),
    syscall,
    callId: `${syscall}-${pid}`,
    phase: 'exit',
    result,
    stateBefore: 'running',
    stateAfter: 'running',
    reversibility: 'reversible',
    kernelAbiVersion: KERNEL_ABI_VERSION,
  });

  /** A recorded model answer. */
  const llmAnswer = (text: string): unknown => ({
    text,
    toolCalls: [],
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, usd: 0 },
    model: 'recorded',
    driverVersion: '1.0.0',
  });

  /** The calls a `.crec` file holds. */
  const readCalls = async (path: string): Promise<ComparedCall[]> => {
    const records: SyscallRecord[] = [];
    for await (const r of readRecords(path)) records.push(r);
    return extractCalls(records);
  };

  /**
   * Boot a kernel, run the agent in it, and read back the calls it made.
   */
  const run = async (
    dir: string,
    opts: {
      readonly mode?: string;
      readonly answer?: string;
      readonly withLLM?: boolean;
      readonly replay?: {
        readonly recordings: ReplayRecordings;
        readonly mode?: ReplayMode;
        /**
         * The pid the replayed process gets — the original's.
         *
         * A pid that differs is a real difference in the shape of the run
         * (a child's pid is in its parent's `spawn` result), so the replay
         * is given the original's pid.
         */
        readonly rootPid?: number;
      };
      readonly now?: () => Timestamp;
      readonly random?: () => number;
    },
  ): Promise<{
    readonly pid: number;
    readonly calls: readonly ComparedCall[];
    readonly toolCalls: number;
  }> => {
    const toolCounter = { count: 0 };
    const kernel = await bootKernel({
      kernelAbiVersion: KERNEL_ABI_VERSION,
      dir,
      autoStart: true,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      ...(opts.random !== undefined ? { random: opts.random } : {}),
      ...(opts.replay !== undefined
        ? {
            replay: {
              recordings: opts.replay.recordings,
              mode: opts.replay.mode ?? 'strict',
            },
          }
        : {}),
      loadDrivers: async (reg) => {
        if (opts.withLLM !== false) reg.registerLLM(fixedDriver(opts.answer ?? 'LIVE-ANSWER'));
        await reg.registerTool(fixedTool('TOOL-OUTPUT', toolCounter));
        reg.registerMemory(inmemMemory());
      },
      agentLoader,
    });
    kernels.push(kernel);
    if (opts.replay?.rootPid !== undefined) {
      kernel.table.advancePidCounterTo(opts.replay.rootPid);
    }
    const pid = await kernel.spawn({
      role: 'probe',
      agent: { module: 'test:probe', args: { mode: opts.mode ?? 'once' } },
    });
    for (let i = 0; i < 500; i++) {
      const entry = kernel.table.get(pid);
      if (entry === undefined || entry.state === 'zombie' || entry.state === 'exiting') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const records: SyscallRecord[] = [];
    for await (const r of readRecords(crecPath(dir, pid))) records.push(r);
    return { pid: unbrand(pid), calls: extractCalls(records), toolCalls: toolCounter.count };
  };

  /** The text a call's `llm_call` answer carries. */
  const answeredWith = (call: ComparedCall | undefined): unknown =>
    (call?.result as { text?: unknown } | undefined)?.text;

  try {
    // A live run, recorded.
    const liveDir = join(tmp, 'live');
    const live = await run(liveDir, { answer: 'LIVE-ANSWER' });

    /**
     * A fresh copy of the recording.
     *
     * A recording is consumed as it is served — the cursor never goes back —
     * so every replay gets its own copy. (This is the `reset()` case: the
     * engine offers it, and the checks here would rather read the file
     * again, because that is what a second process would do.)
     */
    const recording = async (): Promise<LogRecording> =>
      LogRecording.fromFile(crecPath(liveDir, asProcessId(live.pid)));

    /**
     * A replay of one process's recording.
     *
     * The recordings are keyed by pid: a run of N processes is N recordings,
     * and a replay has to know *which* process a recording belongs to —
     * otherwise a child answers from its parent's history, and the replay
     * "works" and is wrong.
     */
    const replayOf = (
      pid: number,
      source: ReplaySource,
      mode: ReplayMode = 'strict',
    ): {
      readonly recordings: ReplayRecordings;
      readonly mode: ReplayMode;
      readonly rootPid: number;
    } => ({
      recordings: ReplayRecordings.of(new Map([[pid, source]])),
      mode,
      rootPid: pid,
    });

    await checkAsync('a replay serves the model answer from the recording', async () => {
      const replay = await run(join(tmp, 'replay-answer'), {
        answer: 'WORLD-ANSWER',
        replay: replayOf(live.pid, await recording()),
      });
      const call = replay.calls.find((c) => c.syscall === 'llm_call');
      assert(call !== undefined, 'the replay made no llm_call');
      assert(
        answeredWith(call) === 'LIVE-ANSWER',
        `the replay answered from the world: ${String(answeredWith(call))}`,
      );
    });

    await checkAsync('a replay reproduces the recording it was given', async () => {
      const replay = await run(join(tmp, 'replay-same'), {
        answer: 'WORLD-ANSWER',
        replay: replayOf(live.pid, await recording()),
      });
      const comparison = compareCalls(live.calls, replay.calls);
      assert(
        comparison.reproduced,
        `the replay diverged at #${(comparison.divergence?.index ?? 0) + 1}`,
      );
      assert(comparison.originalCalls === comparison.replayCalls, 'the call counts differ');
    });

    await checkAsync('a replay serves the clock and the RNG from the recording', async () => {
      const replay = await run(join(tmp, 'replay-clock'), {
        answer: 'WORLD-ANSWER',
        now: () => '2030-01-01T00:00:00.000Z' as Timestamp,
        random: () => 0.5,
        replay: replayOf(live.pid, await recording()),
      });
      const clock = replay.calls.find((c) => c.syscall === 'now');
      const roll = replay.calls.find((c) => c.syscall === 'random');
      assert(clock !== undefined, 'the replay made no now() call');
      assert(roll !== undefined, 'the replay made no random() call');
      assert(clock.result !== '2030-01-01T00:00:00.000Z', 'the replay read the real clock');
      assert(roll.result !== 0.5, 'the replay drew from the real RNG');
      const recordedClock = live.calls.find((c) => c.syscall === 'now');
      assert(clock.result === recordedClock?.result, 'the clock is not the recorded one');
    });

    await checkAsync('a strict replay refuses to answer from the world', async () => {
      const replay = await run(join(tmp, 'replay-strict'), {
        mode: 'twice',
        answer: 'WORLD-ANSWER',
        replay: replayOf(live.pid, await recording()),
      });
      const trapped = replay.calls.find((c) => c.error !== undefined);
      assert(trapped !== undefined, 'the strict replay did not fail');
      assert(trapped.error?.errno === 'ERECORD', `wrong errno: ${trapped.error?.errno}`);
      assert(trapped.syscall === 'llm_call', `wrong syscall: ${trapped.syscall}`);
    });

    await checkAsync('a cached replay falls through to the world', async () => {
      const replay = await run(join(tmp, 'replay-cached'), {
        mode: 'twice',
        answer: 'WORLD-ANSWER',
        replay: replayOf(live.pid, await recording(), 'cached'),
      });
      const calls = replay.calls.filter((c) => c.syscall === 'llm_call');
      assert(calls.length === 2, `expected 2 llm_calls, got ${calls.length}`);
      const second = calls[1]!;
      assert(second.error === undefined, 'the cached replay still failed');
      assert(
        answeredWith(second) === 'WORLD-ANSWER',
        `the cached replay did not reach the world: ${String(answeredWith(second))}`,
      );
    });

    await checkAsync('a live replay ignores the recording', async () => {
      const replay = await run(join(tmp, 'replay-live'), {
        answer: 'WORLD-ANSWER',
        replay: replayOf(live.pid, await recording(), 'live'),
      });
      const call = replay.calls.find((c) => c.syscall === 'llm_call');
      assert(
        answeredWith(call) === 'WORLD-ANSWER',
        `a live replay still used the recording: ${String(answeredWith(call))}`,
      );
    });

    await checkAsync('a replay needs no model provider', async () => {
      const replay = await run(join(tmp, 'replay-nodriver'), {
        withLLM: false,
        replay: replayOf(live.pid, await recording()),
      });
      const call = replay.calls.find((c) => c.syscall === 'llm_call');
      assert(
        answeredWith(call) === 'LIVE-ANSWER',
        `the replay needed a driver it does not have: ${String(answeredWith(call))}`,
      );
    });

    await checkAsync('a replay does not repeat a side effect', async () => {
      // A live run that really calls the tool.
      const toolDir = join(tmp, 'live-tool');
      const liveTool = await run(toolDir, { mode: 'tool', answer: 'LIVE-ANSWER' });
      assert(liveTool.toolCalls === 1, `the live run called the tool ${liveTool.toolCalls} times`);
      const toolRecording = await LogRecording.fromFile(crecPath(toolDir, asProcessId(liveTool.pid)));

      // The replay: the tool's answer comes from the recording, and the tool
      // itself is never run again.
      const replay = await run(join(tmp, 'replay-tool'), {
        mode: 'tool',
        answer: 'WORLD-ANSWER',
        replay: replayOf(liveTool.pid, toolRecording),
      });
      assert(replay.toolCalls === 0, `the replay ran the tool ${replay.toolCalls} times`);
      const call = replay.calls.find((c) => c.syscall === 'tool_call');
      assert(call !== undefined, 'the replay made no tool_call');
      const output = (call.result as { output?: unknown } | undefined)?.output;
      assert(output === 'TOOL-OUTPUT', `the replay did not serve the recorded tool result: ${String(output)}`);
    });

    await checkAsync('a recording can be replayed more than once', async () => {
      const source = await recording();
      const first = await run(join(tmp, 'replay-twice-a'), {
        answer: 'WORLD-ANSWER',
        replay: replayOf(live.pid, source),
      });
      const second = await run(join(tmp, 'replay-twice-b'), {
        answer: 'WORLD-ANSWER',
        replay: replayOf(live.pid, source),
      });
      assert(
        answeredWith(first.calls.find((c) => c.syscall === 'llm_call')) === 'LIVE-ANSWER',
        'the first replay did not use the recording',
      );
      assert(
        answeredWith(second.calls.find((c) => c.syscall === 'llm_call')) === undefined,
        'the second replay reused a spent recording',
      );
      source.reset();
      const third = await run(join(tmp, 'replay-twice-c'), {
        answer: 'WORLD-ANSWER',
        replay: replayOf(live.pid, source),
      });
      assert(
        answeredWith(third.calls.find((c) => c.syscall === 'llm_call')) === 'LIVE-ANSWER',
        'a rewound recording did not answer again',
      );
    });

    await checkAsync('the comparison ignores the run-specific bookkeeping', async () => {
      const a: ComparedCall[] = [
        { syscall: 'now', result: 'T' },
        { syscall: 'checkpoint', result: { chainId: 'a', byteSize: 10, syscallLogOffset: 100 } },
        { syscall: 'recv', result: { from: 2, to: 2, body: 'hi', sentAt: 'T1' } },
      ];
      const b: ComparedCall[] = [
        { syscall: 'now', result: 'T' },
        { syscall: 'checkpoint', result: { chainId: 'b', byteSize: 99, syscallLogOffset: 400 } },
        { syscall: 'recv', result: { from: 2, to: 2, body: 'hi', sentAt: 'T2' } },
      ];
      const comparison = compareCalls(a, b);
      assert(comparison.reproduced, 'the bookkeeping was treated as a divergence');
    });

    await checkAsync('the comparison names the first divergence', async () => {
      const a: ComparedCall[] = [
        { syscall: 'now', result: 'T' },
        {
          syscall: 'llm_call',
          args: { messages: [{ role: 'user', content: 'V1' }] },
          result: { text: 'x' },
        },
      ];
      const b: ComparedCall[] = [
        { syscall: 'now', result: 'T' },
        {
          syscall: 'llm_call',
          args: { messages: [{ role: 'user', content: 'V2' }] },
          result: { text: 'x' },
        },
      ];
      const comparison = compareCalls(a, b);
      assert(!comparison.reproduced, 'the divergence was not found');
      assert(comparison.divergence?.index === 1, `wrong index: ${comparison.divergence?.index}`);
      const report = formatDivergence(comparison.divergence!);
      assert(report.includes('messages[0].content'), `the report does not name the path: ${report}`);
      assert(
        report.includes('V1') && report.includes('V2'),
        `the report does not show both values: ${report}`,
      );
    });

    // --- the tree -----------------------------------------------------------

    await checkAsync('a recording knows the processes it started', async () => {
      // `spawn` names its child in `pid`; `fork` names it in `childPid`.
      // Those two links are the only place the shape of a run is written
      // down — so they are how the tree is discovered.
      const recording = LogRecording.fromRecords([
        frame(2, 'spawn', { pid: 3 }),
        frame(2, 'fork', { childPid: 4, childChainId: 'c1', sharedCausalPast: 12, irreversibleInPast: false }),
      ]);
      const children = recording.childPids();
      assert(children.length === 2, `expected 2 children, got ${children.length}`);
      assert(children[0] === 3, `wrong first child: ${children[0]}`);
      assert(children[1] === 4, `wrong second child: ${children[1]}`);
    });

    await checkAsync('a replay serves each process from its own recording', async () => {
      // Two recordings, one per process. The world would answer something
      // else entirely — a replay that answers from the world is not a
      // replay.
      const parent = LogRecording.fromRecords([frame(2, 'llm_call', llmAnswer('PARENT-ANSWER'))]);
      const child = LogRecording.fromRecords([frame(3, 'llm_call', llmAnswer('CHILD-ANSWER'))]);
      const treeDir = join(tmp, 'replay-tree');
      await run(treeDir, {
        mode: 'tree',
        answer: 'WORLD-ANSWER',
        replay: {
          recordings: ReplayRecordings.of(new Map([[2, parent], [3, child]])),
          mode: 'strict',
          rootPid: 2,
        },
      });

      const childPid = treeChildren[treeChildren.length - 1]!;
      assert(childPid === 3, `the child got pid ${childPid}, expected 3`);
      const childCalls = await readCalls(crecPath(treeDir, asProcessId(childPid)));
      const childAnswer = (
        childCalls.find((c) => c.syscall === 'llm_call')?.result as { text?: unknown } | undefined
      )?.text;
      assert(
        childAnswer === 'CHILD-ANSWER',
        `the child answered ${String(childAnswer)} — it did not answer from its own recording`,
      );
    });

    await checkAsync("the comparison ignores the replay's own clock", async () => {
      // A `wait` reports three things that are the replay's own: when the
      // child was reaped, where its log sat, and how long it took. None of
      // them is the child's behaviour — and all three differ every run.
      const waited = (reapedAt: string, wallTimeMs: number, range: readonly number[]) => ({
        syscall: 'wait',
        result: {
          pid: 3,
          exitCode: 0,
          reapedAt,
          exitReason: 'done',
          budgetsSpent: {
            tokensIn: 10,
            tokensOut: 5,
            tokensCached: 0,
            usdSpent: 0.01,
            wallTimeMs,
            syscallCount: 4,
          },
          syscallLogRange: range,
        },
      });
      const comparison = compareCalls(
        [waited('2026-01-01T00:00:00.000Z', 120, [0, 100])],
        [waited('2026-06-01T00:00:00.000Z', 9876, [0, 250])],
      );
      assert(comparison.reproduced, "the replay's own clock was treated as a divergence");
    });

    await checkAsync('the report does not name a difference the comparison ignored', async () => {
      // Only the ignored field differs: there is no difference to report.
      assert(
        firstDifference(
          { exitCode: 0, reapedAt: 'T1' },
          { exitCode: 0, reapedAt: 'T2' },
          'outcome',
          ['reapedAt'],
        ) === null,
        'the ignored field was named as a difference',
      );

      // A real difference is still found — and it is not the ignored one.
      const recorded = { exitCode: 0, reapedAt: 'T1', budgetsSpent: { tokensIn: 10, wallTimeMs: 120 } };
      const replay = { exitCode: 0, reapedAt: 'T2', budgetsSpent: { tokensIn: 10, wallTimeMs: 9876 } };
      const real = firstDifference(recorded, replay, 'outcome', ['reapedAt']);
      assert(real !== null, 'the real difference was missed');
      assert(real.path === 'outcome.budgetsSpent.wallTimeMs', `wrong path: ${real.path}`);

      // The nested ignore works the same way.
      assert(
        firstDifference(
          { exitCode: 0, budgetsSpent: { tokensIn: 10, wallTimeMs: 120 } },
          { exitCode: 0, budgetsSpent: { tokensIn: 10, wallTimeMs: 9876 } },
          'outcome',
          ['budgetsSpent.wallTimeMs'],
        ) === null,
        'the ignored nested field was named as a difference',
      );
    });

    await checkAsync('the replay engine is part of the public surface', async () => {
      // HACKING.md tells a host to `import { LogRecording, ReplayRecordings }
      // from 'cortex-agent-os'`. If the kernel's public surface stops
      // exporting them, that example becomes a lie — and a compile error for
      // the person who follows it.
      //
      // The import is dynamic on purpose: a static one would fail to load
      // the whole suite when the export went missing, and a suite that
      // cannot start is not a check that failed.
      const publicSurface = await import('../src/index.js');
      assert(
        typeof publicSurface.LogRecording === 'function',
        'LogRecording is not exported from the public surface',
      );
      assert(
        typeof publicSurface.ReplayRecordings === 'function',
        'ReplayRecordings is not exported from the public surface',
      );
    });

    // --- the command --------------------------------------------------------

    const home = join(tmp, 'home');
    process.env['CORTEX_HOME'] = home;

    const moduleV1 = join(tmp, 'agent-v1.ts');
    const moduleV2 = join(tmp, 'agent-v2.ts');
    const writeModule = (path: string, prompt: string): void => {
      writeFileSync(
        path,
        `export default async function agent(ctx) {
  ctx.now();
  ctx.random();
  await ctx.llm_call({ messages: [{ role: 'user', content: '${prompt}' }] });
  ctx.exit(0, 'done');
}
`,
        'utf8',
      );
    };
    writeModule(moduleV1, 'PROMPT-V1');
    writeModule(moduleV2, 'PROMPT-V2');

    const capture = async (
      runCommand: () => Promise<number>,
    ): Promise<{ code: number; out: string; err: string }> => {
      let out = '';
      let err = '';
      const prevWrite = process.stdout.write;
      const prevErr = console.error;
      process.stdout.write = ((chunk: unknown): boolean => {
        out += String(chunk);
        return true;
      }) as unknown as typeof process.stdout.write;
      console.error = (...parts: unknown[]): void => {
        err += parts.map((p) => String(p)).join(' ') + '\n';
      };
      try {
        const code = await runCommand();
        return { code, out, err };
      } finally {
        process.stdout.write = prevWrite;
        console.error = prevErr;
      }
    };

    let spawnedPid = 0;

    await checkAsync('cortex replay reproduces a recorded run', async () => {
      const spawned = await capture(() => cmdSpawn(['--role', 'probe', '--module', moduleV1]));
      assert(spawned.code === 0, `spawn failed: ${spawned.out}${spawned.err}`);
      const m = /\[pid (\d+)\]/.exec(spawned.out);
      assert(m !== null, `no pid in the spawn output: ${spawned.out}`);
      spawnedPid = Number(m![1]);
      const replayed = await capture(() => cmdReplay([String(spawnedPid)]));
      assert(replayed.code === 0, `the replay failed: ${replayed.out}${replayed.err}`);
      assert(replayed.out.includes('REPRODUCED'), `the replay did not reproduce: ${replayed.out}`);
    });

    await checkAsync('cortex replay names the first divergence', async () => {
      const spec = readSpec(home, asProcessId(spawnedPid));
      assert(spec !== undefined, 'the spawned process has no spec');
      // The agent's code changed: the spec now names a different module.
      writeSpec(home, { ...spec, agent: { module: pathToFileURL(moduleV2).href } });
      const replayed = await capture(() => cmdReplay([String(spawnedPid)]));
      assert(replayed.code === 1, `the replay did not report a divergence: ${replayed.out}`);
      assert(replayed.out.includes('DIVERGED'), `the replay did not say DIVERGED: ${replayed.out}`);
      assert(replayed.out.includes('PROMPT-V2'), `the replay did not name the change: ${replayed.out}`);
      assert(
        replayed.out.includes('messages[0].content'),
        `the replay did not say WHERE the change is: ${replayed.out}`,
      );
    });

    await checkAsync('cortex replay refuses a process with no recording', async () => {
      const replayed = await capture(() => cmdReplay(['999999']));
      assert(replayed.code === 1, 'the replay accepted a process with no recording');
      assert(replayed.err.includes('no recording'), `the message does not say so: ${replayed.err}`);
    });

    // --- the command, on a tree ---------------------------------------------
    //
    // A real run is a tree: a supervisor starts children, and every process
    // has its own recording. So the command has to replay the whole tree,
    // each process from its OWN history, and say which process diverged.
    //
    // The child's prompt is read from a file at *call* time. The module
    // loader caches modules, so a prompt written into the module would be
    // the same in the recording and in the replay — and the divergence
    // would never happen.

    const treePromptFile = join(tmp, 'tree-prompt.txt');
    const treeChildModule = join(tmp, 'tree-child.ts');
    const treeParentModule = join(tmp, 'tree-parent.ts');

    writeFileSync(
      treeChildModule,
      `import { readFileSync } from 'node:fs';

export default async function agent(ctx) {
  const prompt = readFileSync(${JSON.stringify(treePromptFile)}, 'utf8').trim();
  await ctx.llm_call({ messages: [{ role: 'user', content: prompt }] });
  ctx.exit(0, 'child done');
}
`,
      'utf8',
    );

    writeFileSync(
      treeParentModule,
      `export default async function agent(ctx) {
  const child = await ctx.spawn({
    role: 'leaf',
    agent: { module: ${JSON.stringify(pathToFileURL(treeChildModule).href)} },
  });
  await ctx.wait(child.pid);
  await ctx.llm_call({ messages: [{ role: 'user', content: 'PARENT-PROMPT' }] });
  ctx.exit(0, 'parent done');
}
`,
      'utf8',
    );

    writeFileSync(treePromptFile, 'CHILD-PROMPT-V1\n', 'utf8');

    let treeRoot = 0;

    await checkAsync('cortex replay reproduces a supervision tree', async () => {
      const spawned = await capture(() => cmdSpawn(['--role', 'sup', '--module', treeParentModule]));
      assert(spawned.code === 0, `spawn failed: ${spawned.out}${spawned.err}`);
      const m = /\[pid (\d+)\]/.exec(spawned.out);
      assert(m !== null, `no pid in the spawn output: ${spawned.out}`);
      treeRoot = Number(m![1]);
      const replayed = await capture(() => cmdReplay([String(treeRoot)]));
      assert(replayed.code === 0, `the replay failed: ${replayed.out}${replayed.err}`);
      assert(replayed.out.includes('REPRODUCED'), `the replay did not reproduce: ${replayed.out}`);
      assert(
        replayed.out.includes(`pid ${treeRoot + 1}`),
        `the child was not replayed: ${replayed.out}`,
      );
    });

    await checkAsync('cortex replay says which process diverged', async () => {
      // The child's prompt changed. The module is cached, so the change has
      // to live in something read at call time.
      writeFileSync(treePromptFile, 'CHILD-PROMPT-V2\n', 'utf8');
      const replayed = await capture(() => cmdReplay([String(treeRoot)]));
      assert(replayed.code === 1, `the replay did not report a divergence: ${replayed.out}`);
      assert(replayed.out.includes('DIVERGED'), `the replay did not say DIVERGED: ${replayed.out}`);
      assert(
        replayed.out.includes(`pid ${treeRoot + 1}`),
        `the report does not name the child: ${replayed.out}`,
      );
      assert(replayed.out.includes('CHILD-PROMPT-V2'), `the report does not name the change: ${replayed.out}`);
      assert(
        !replayed.out.includes(`pid ${treeRoot} did not reproduce`),
        `the parent was blamed for the child's change: ${replayed.out}`,
      );
    });
  } finally {
    if (prevHome === undefined) delete process.env['CORTEX_HOME'];
    else process.env['CORTEX_HOME'] = prevHome;
    for (const k of kernels) {
      try {
        await k.shutdown();
      } catch {
        /* teardown is best-effort */
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * How a process ended — and the rule that an unknown ending is not a success.
 *
 * The bug this group pins down was found by running it: an agent that threw
 * a `TypeError` was reported by `cortex spawn` as `code 0: completed`, and
 * the command exited 0. The kernel knew the truth the whole time — the
 * process's meta said `exitCode: 1` with the reason — but the CLI read the
 * process table in the moment between the process becoming EXITING and its
 * exit code being written, found nothing, and turned "nothing" into zero.
 *
 * Two fixes, checked here: the kernel publishes the outcome when it is
 * *decided* (so there is no window), and the CLI has one rule for "what do
 * I know" that an unknown ending never reads as success.
 */
async function runOutcomeChecks(): Promise<void> {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-outcome-'));
  const kernels: Kernel[] = [];
  const prevHome = process.env['CORTEX_HOME'];

  /** Run a command with its stdout and stderr captured. */
  const capture = async (
    run: () => Promise<number>,
  ): Promise<{ code: number; out: string; err: string }> => {
    let out = '';
    let err = '';
    const prevWrite = process.stdout.write;
    const prevErr = console.error;
    process.stdout.write = ((chunk: unknown): boolean => {
      out += String(chunk);
      return true;
    }) as unknown as typeof process.stdout.write;
    console.error = (...parts: unknown[]): void => {
      err += parts.map((p) => String(p)).join(' ') + '\n';
    };
    try {
      const code = await run();
      return { code, out, err };
    } finally {
      process.stdout.write = prevWrite;
      console.error = prevErr;
    }
  };

  try {
    await checkAsync('a process knows how it will end before it is gone', async () => {
      // The exit path walks to EXITING and *then* writes the exit frame, and
      // that write awaits the disk. A host that read the table in that
      // window found no exit code — and the honest reaction to "no exit
      // code" is "it failed", not "it succeeded".
      //
      // The window is made deterministic here: the recorder holds the exit
      // frame until the test has looked at the table.
      let releaseExit: (() => void) | undefined;
      const exitHeld = new Promise<void>((resolve) => {
        releaseExit = resolve;
      });
      let exitSeen: (() => void) | undefined;
      const exitStarted = new Promise<void>((resolve) => {
        exitSeen = resolve;
      });

      const recorderFactory: NonNullable<KernelOptions['recorderFactory']> = async (pid) => {
        const rec = await Recorder.open({ pid, dir: join(tmp, 'window', String(unbrand(pid))) });
        type AppendFn = typeof rec.append;
        const append: AppendFn = rec.append.bind(rec);
        (rec as unknown as { append: AppendFn }).append = async (input) => {
          // The *outcome* frame — the one the exit path writes after it has
          // walked to EXITING. The `enter` frame of the same syscall is
          // written before that, and blocking it would catch the process
          // still running.
          if (input.syscall === 'exit' && input.phase === 'exit') {
            exitSeen?.();
            await exitHeld;
          }
          return append(input);
        };
        return rec;
      };

      const kernel = await bootKernel({
        kernelAbiVersion: KERNEL_ABI_VERSION,
        dir: join(tmp, 'window'),
        autoStart: true,
        recorderFactory,
        loadDrivers: async (reg) => {
          reg.registerLLM(new MockLLMDriver());
          reg.registerMemory(inmemMemory());
        },
        agentLoader: async () => async (ctx) => {
          ctx.exit(7, 'leaving on purpose');
        },
      });
      kernels.push(kernel);
      const pid = await kernel.spawn({ role: 'leaver', agent: { module: 'test:leaver' } });

      await exitStarted;
      const entry = kernel.table.get(pid);
      assert(entry !== undefined, 'the process was gone before it could be read');
      assert(entry.state === 'exiting', `expected EXITING, got ${entry.state}`);
      assert(
        entry.exitCode === 7,
        `the exit code was not known while exiting: ${String(entry.exitCode)}`,
      );
      assert(
        entry.exitReason === 'leaving on purpose',
        `the exit reason was not known while exiting: ${String(entry.exitReason)}`,
      );
      releaseExit?.();
    });

    await checkAsync('a missing exit code is never a success', async () => {
      // Reaped, with no exit record to fall back on: the ending is unknown,
      // and unknown is not success.
      const reaped = processOutcome(undefined, undefined);
      assert(
        reaped.exitCode !== 0,
        `an unknown ending was reported as success: ${String(reaped.exitCode)}`,
      );
      assert(
        reaped.exitCode === 1,
        `an unknown ending should read as a failure, got ${String(reaped.exitCode)}`,
      );

      // The exit record is the durable answer, and it survives the reap.
      const recorded = processOutcome(undefined, { code: 5, reason: 'boom' });
      assert(recorded.exitCode === 5, `the exit record was not used: ${String(recorded.exitCode)}`);

      // A zombie knows how it ended.
      const zombie = processOutcome(
        { state: 'zombie', exitCode: 3, exitReason: 'bad' },
        undefined,
      );
      assert(zombie.exitCode === 3, `the zombie's code was lost: ${String(zombie.exitCode)}`);

      // A zombie that somehow carries none is not a success either.
      const bare = processOutcome({ state: 'zombie', exitCode: null, exitReason: null }, undefined);
      assert(bare.exitCode !== 0, `a code-less zombie was reported as success: ${String(bare.exitCode)}`);

      // A process on its way out whose outcome nobody has seen stays
      // **unknown** — a null code is "never finished", not "succeeded".
      const exiting = processOutcome(
        { state: 'exiting', exitCode: null, exitReason: null },
        undefined,
      );
      assert(exiting.exitCode === null, `an unknown ending became a code: ${String(exiting.exitCode)}`);
      assert(exiting.exitCode !== 0, 'an unknown ending was reported as success');

      // A suspended process paused; it did not fail.
      const suspended = processOutcome(
        { state: 'suspended', exitCode: null, exitReason: null },
        undefined,
      );
      assert(suspended.exitCode === 0, `a pause was reported as a failure: ${String(suspended.exitCode)}`);

      // And an unknown code prints as a question, because `?` is a question
      // and `0` is an answer.
      assert(formatOutcomeCode(null) === '?', 'an unknown code did not print as a question');
      assert(formatOutcomeCode(0) === '0', 'a known code did not print as itself');
    });

    await checkAsync('cortex spawn reports a crash as a crash', async () => {
      const home = join(tmp, 'home-crash');
      process.env['CORTEX_HOME'] = home;
      const module = join(tmp, 'crash-agent.ts');
      writeFileSync(
        module,
        `export default async function agent(ctx) {
  ctx.now();
  throw new TypeError("cannot read properties of undefined (reading 'id')");
}
`,
        'utf8',
      );

      const spawned = await capture(() => cmdSpawn(['--role', 'crasher', '--module', module]));
      assert(
        spawned.code !== 0,
        `a crashed agent was reported as a success: ${spawned.out}${spawned.err}`,
      );
      assert(spawned.out.includes('code 1'), `the crash was not reported: ${spawned.out}`);
      assert(
        spawned.out.includes("reading 'id'"),
        `the reason for the crash was not reported: ${spawned.out}`,
      );
    });

    await checkAsync('cortex spawn says the ceiling the spend is measured against', async () => {
      const home = join(tmp, 'home-budget');
      process.env['CORTEX_HOME'] = home;
      const module = join(tmp, 'quiet-agent.ts');
      writeFileSync(
        module,
        `export default async function agent(ctx) {
  ctx.now();
}
`,
        'utf8',
      );

      const spawned = await capture(() =>
        cmdSpawn(['--role', 'quiet', '--module', module, '--token-budget', '1000']),
      );
      assert(spawned.code === 0, `the agent ran: ${spawned.out}${spawned.err}`);
      // The spend on its own is 12% of one budget and 99% of another, and the
      // two need very different answers — so the summary says the ceiling too.
      assert(
        spawned.out.includes('tokens: 0 of 1000'),
        `the summary names the ceiling, got: ${spawned.out}`,
      );
    });
  } finally {
    if (prevHome === undefined) delete process.env['CORTEX_HOME'];
    else process.env['CORTEX_HOME'] = prevHome;
    for (const k of kernels) {
      try {
        await k.shutdown();
      } catch {
        /* teardown is best-effort */
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function runRecordChecks(): Promise<void> {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'cortex-record-'));
  const prevHome = process.env['CORTEX_HOME'];

  /** Run a command with its stdout and stderr captured. */
  const capture = async (
    run: () => Promise<number>,
  ): Promise<{ code: number; out: string; err: string }> => {
    let out = '';
    let err = '';
    const prevWrite = process.stdout.write;
    const prevErr = console.error;
    process.stdout.write = ((chunk: unknown): boolean => {
      out += String(chunk);
      return true;
    }) as unknown as typeof process.stdout.write;
    console.error = (...parts: unknown[]): void => {
      err += parts.map((p) => String(p)).join(' ') + '\n';
    };
    try {
      const code = await run();
      return { code, out, err };
    } finally {
      process.stdout.write = prevWrite;
      console.error = prevErr;
    }
  };

  /** A minimal record, so a test can say exactly one thing about it. */
  const record = (over: Partial<ProcessMeta> = {}): ProcessMeta => ({
    pid: 2,
    ppid: 1,
    pgid: 2,
    role: 'coder',
    state: 'zombie',
    exitCode: 1,
    exitReason: 'boom',
    startedAt: '2026-10-24T00:00:00.000Z',
    lastTransitionAt: '2026-10-24T00:00:01.000Z',
    budgetsSpent: { tokensIn: 3, tokensOut: 5, tokensCached: 0, usdSpent: 0, wallTimeMs: 100, syscallCount: 2 },
    budgetsRemaining: { tokens: -1, usd: -1, wallTimeMs: -1 },
    agent: { system: 'test' },
    kernelAbiVersion: KERNEL_ABI_VERSION,
    ...over,
  });

  try {
    await checkAsync('cortex spawn does not erase what the process held', async () => {
      // The kernel writes the exit record when a process dies: its own account
      // of what the process was allowed to do (docs/ABI.md §4.9). The CLI
      // wrote a record of its own afterwards, without that field, and it won —
      // so a process that held every capability was recorded as holding none,
      // and `cortex ps` printed `-` for it.
      //
      // `-` is not "everything". It is the absence of an answer.
      const home = join(tmp, 'home-crash');
      process.env['CORTEX_HOME'] = home;
      const module = join(tmp, 'crash-agent.ts');
      writeFileSync(
        module,
        `export default async function agent(ctx) {
  ctx.now();
  throw new TypeError("cannot read properties of undefined (reading 'id')");
}
`,
        'utf8',
      );

      const spawned = await capture(() => cmdSpawn(['--role', 'crasher', '--module', module]));
      const pidMatch = /\[pid (\d+)\]/.exec(spawned.out);
      assert(pidMatch !== null, `the spawn did not report a pid: ${spawned.out}${spawned.err}`);
      const pid = asProcessId(Number(pidMatch![1]));

      const meta = readMeta(home, pid);
      assert(meta !== undefined, 'the crashed agent left no record at all');
      assert(
        meta.capabilities !== undefined,
        'the record lost the capabilities the process held',
      );
      assert(
        meta.capabilities.length === CAPABILITIES.length,
        `the record says the process held ${meta.capabilities.length} capabilities, expected ${CAPABILITIES.length}`,
      );
      // Which process group it was in: a child joins its parent's group
      // (init's, here), and the CLI used to write the process's own pid there
      // — a group the process was never in.
      assert(
        meta.pgid === 1,
        `the record says the process was in group ${meta.pgid}, expected init's group (1)`,
      );
      // And the kernel's account of the ending is the one that is kept.
      assert(meta.state === 'zombie', `the record says the process is ${meta.state}`);
      assert(meta.exitCode === 1, `the record says the process exited ${String(meta.exitCode)}`);
      assert(
        meta.exitReason !== null && meta.exitReason.includes("reading 'id'"),
        `the record lost the reason: ${String(meta.exitReason)}`,
      );
    });

    await checkAsync('a view cannot rewrite the account of an ending', async () => {
      // The CLI reads the process table at the end of a command — after the
      // process is gone and reaped. What it has then is a guess, and a guess
      // that overwrites a fact is worse than no fact.
      const dir = join(tmp, 'view-cannot-rewrite');
      writeExitRecord(dir, record({ capabilities: [...CAPABILITIES] }));

      // A view that claims the run finished cleanly, and knows nothing about
      // what the process was allowed to do.
      writeProcessView(
        dir,
        record({
          state: 'running',
          exitCode: 0,
          exitReason: 'completed',
          capabilities: undefined,
        }),
      );

      const meta = readMeta(dir, asProcessId(2));
      assert(meta !== undefined, 'the record disappeared');
      assert(meta.state === 'zombie', `the view rewrote the state: ${meta.state}`);
      assert(meta.exitCode === 1, `the view rewrote the exit code: ${String(meta.exitCode)}`);
      assert(
        meta.exitReason === 'boom',
        `the view rewrote the reason: ${String(meta.exitReason)}`,
      );
      assert(
        meta.capabilities !== undefined && meta.capabilities.length === CAPABILITIES.length,
        'the view erased the capabilities the kernel had recorded',
      );
    });

    await checkAsync('the exit record keeps the declaration', async () => {
      // The memory policies are the CLI's to know: the kernel is told about
      // them, but it does not persist them. So the kernel's exit record must
      // not drop them — a restore has to be able to re-declare the same
      // regions (docs/ARCHITECTURE.md §4.2).
      const dir = join(tmp, 'declaration');
      writeProcessView(
        dir,
        record({
          memory: {
            episodic: { kind: 'cow', backing: 'inmem', maxEntries: 50 },
            semantic: { kind: 'shared', backing: 'inmem', readOnly: true },
          },
        }),
      );
      writeExitRecord(dir, record({ capabilities: [...CAPABILITIES] }));

      const meta = readMeta(dir, asProcessId(2));
      assert(meta !== undefined, 'the record disappeared');
      assert(meta.memory !== undefined, 'the exit record dropped the declaration');
      assert(
        meta.memory.episodic.maxEntries === 50,
        `the declaration was altered: ${String(meta.memory.episodic.maxEntries)}`,
      );
      assert(meta.memory.semantic.readOnly === true, 'the read-only region was lost');
    });

    await checkAsync('money only grows', async () => {
      // `cortex wrap`'s tap sees LLM calls that never went through the kernel,
      // so the CLI knows spend the kernel does not. Adding it is right; making
      // a process look like it spent *less* than the kernel recorded is not.
      const dir = join(tmp, 'money');
      writeExitRecord(dir, record({ budgetsSpent: { tokensIn: 10, tokensOut: 0, tokensCached: 0, usdSpent: 0, wallTimeMs: 100, syscallCount: 2 } }));

      // The tap's money: the view knows more, so the record grows.
      writeProcessView(
        dir,
        record({ budgetsSpent: { tokensIn: 160, tokensOut: 0, tokensCached: 0, usdSpent: 0, wallTimeMs: 100, syscallCount: 2 } }),
      );
      const grown = readMeta(dir, asProcessId(2));
      assert(
        grown?.budgetsSpent.tokensIn === 160,
        `the tap's spend was lost: ${String(grown?.budgetsSpent.tokensIn)}`,
      );

      // A view that knows less must not shrink the record.
      writeProcessView(
        dir,
        record({ budgetsSpent: { tokensIn: 0, tokensOut: 0, tokensCached: 0, usdSpent: 0, wallTimeMs: 0, syscallCount: 0 } }),
      );
      const shrunk = readMeta(dir, asProcessId(2));
      assert(
        shrunk?.budgetsSpent.tokensIn === 160,
        `a process was made to look like it spent less: ${String(shrunk?.budgetsSpent.tokensIn)}`,
      );
    });

    await checkAsync('the ending belongs to whoever decided it', async () => {
      // When the process ends itself, the kernel's exit record is the account
      // of it and the CLI only reports it. When the **CLI** stops a run — a
      // timeout — the kernel only saw a signal, and its account of the
      // wrapper process ("exited 1 (cancelled)") is not the truth an operator
      // needs. So the CLI says that it decided, and its account stands.
      const dir = join(tmp, 'ending');
      writeExitRecord(dir, record({ exitCode: 1, exitReason: 'node.exe exited 1 (cancelled)' }));

      // A view that only reports: the record keeps the ending.
      writeProcessView(dir, record({ exitCode: null, exitReason: 'unknown ending' }));
      const reported = readMeta(dir, asProcessId(2));
      assert(
        reported?.exitCode === 1,
        `the reported ending was rewritten: ${String(reported?.exitCode)}`,
      );
      assert(
        reported?.exitReason === 'node.exe exited 1 (cancelled)',
        `the reported reason was rewritten: ${String(reported?.exitReason)}`,
      );

      // A view that decided: its account stands.
      writeProcessView(
        dir,
        record({ exitCode: 137, exitReason: 'timed out after 900ms' }),
        { ownsEnding: true },
      );
      const decided = readMeta(dir, asProcessId(2));
      assert(decided?.exitCode === 137, `the decided ending was lost: ${String(decided?.exitCode)}`);
      assert(
        decided?.exitReason === 'timed out after 900ms',
        `the decided reason was lost: ${String(decided?.exitReason)}`,
      );
    });
  } finally {
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
await runLangchainChecks();
await runLLMTapChecks();
await runWrapChecks();
await runDashboardChecks();
await runDashboardStoreChecks();
await runDashboardLiveChecks();
await runAttachPushChecks();
await runFsChecks();
await runMcpChecks();
await runDiffChecks();
await runInMemChecks();
await runSqliteChecks();
runRegionsChecks();
await runCliChecks();
await runOutputCaptureChecks();
await runOutputPushChecks();
await runMemoryInspectChecks();
await runHostWaitChecks();
await runEventStreamChecks();
await runSuperviseChecks();
await runCapabilityInheritanceChecks();
await runTopChecks();
await runTokenUsageChecks();
await runKernelGoneChecks();
await runDaemonChecks();
await runKernelHardeningChecks();
await runTransportChecks();
await runBootChecks();
await runReplayChecks();
await runOutcomeChecks();
await runRecordChecks();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
