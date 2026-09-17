/**
 * Phase 1 smoke check — types.ts + errors.ts runtime sanity.
 *
 * Not a real test (no test framework yet, that lands with #012+). This is
 * a "does the module load and do the runtime bits behave" check, run via
 * `npx tsx scripts/smoke.ts`. Once Phase 1 has a test runner, this gets
 * absorbed into tests/ and deleted.
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
