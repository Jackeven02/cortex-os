import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMcpDefaultReversibility, parseMcpReversibilityMap } from '../src/drivers/tool/mcp.js';

test('MCP reversibility defaults to conservative irreversible', () => {
  assert.equal(parseMcpDefaultReversibility(undefined), 'irreversible');
  assert.equal(parseMcpDefaultReversibility('  '), 'irreversible');
  assert.equal(parseMcpDefaultReversibility('reversible'), 'reversible');
});

test('MCP reversibility map validates values and safely accepts special keys', () => {
  const values = parseMcpReversibilityMap('{"lookup":"idempotent","__proto__":"reversible"}');
  assert.equal(values.lookup, 'idempotent');
  assert.equal(values.__proto__, 'reversible');
  assert.equal(Object.getPrototypeOf(values), null);
  assert.throws(() => parseMcpReversibilityMap('[]'), /JSON object/);
  assert.throws(() => parseMcpReversibilityMap('{bad'), /JSON object/);
  assert.throws(() => parseMcpReversibilityMap('{"write":"safe"}'), /valid reversibility/);
  assert.throws(() => parseMcpDefaultReversibility('safe'), /must be idempotent/);
});
