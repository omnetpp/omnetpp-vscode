import { test } from 'bun:test';
import assert from 'node:assert';
import { parseGotoSimTimeExpr, validateGotoEventInput } from '../eventlog/common/dialogs';

const RANGE = { firstEventNumber: 0, lastEventNumber: 1000 };

// ---------------------------------------------------------------------------------
// validateGotoEventInput
// ---------------------------------------------------------------------------------

test('validateGotoEventInput: accepts an in-range integer', () => {
  assert.equal(validateGotoEventInput('500', RANGE), null);
});

test('validateGotoEventInput: rejects non-numeric input', () => {
  assert.ok(validateGotoEventInput('abc', RANGE) !== null);
});

test('validateGotoEventInput: rejects a negative number', () => {
  assert.ok(validateGotoEventInput('-1', RANGE) !== null);
});

test('validateGotoEventInput: rejects out-of-range (below first / above last)', () => {
  assert.ok(validateGotoEventInput('2000', RANGE) !== null);
  assert.ok(validateGotoEventInput('500', { firstEventNumber: 600, lastEventNumber: 1000 }) !== null);
});

test('validateGotoEventInput: trims whitespace', () => {
  assert.equal(validateGotoEventInput('  500  ', RANGE), null);
});

// ---------------------------------------------------------------------------------
// parseGotoSimTimeExpr -- port of GotoSimulationTimeDialog (see dialogs.ts's header)
// ---------------------------------------------------------------------------------

test('parseGotoSimTimeExpr: plain absolute number, no unit -- treated as seconds', () => {
  const r = parseGotoSimTimeExpr('1.5', '10', null);
  assert.ok(r.ok);
  assert.equal(r.value, '1.5');
});

test('parseGotoSimTimeExpr: absolute value ignores baseSimulationTime entirely', () => {
  const r = parseGotoSimTimeExpr('5', '999', null);
  assert.ok(r.ok);
  assert.equal(r.value, '5');
});

test('parseGotoSimTimeExpr: "+" prefix is relative -- base + delta', () => {
  const r = parseGotoSimTimeExpr('+0.5', '1', null);
  assert.ok(r.ok);
  assert.equal(r.value, '1.5');
});

test('parseGotoSimTimeExpr: "-" prefix is relative too, but the sign stays part of the parsed number (base + (-delta))', () => {
  const r = parseGotoSimTimeExpr('-0.5', '2', null);
  assert.ok(r.ok);
  assert.equal(r.value, '1.5');
});

test('parseGotoSimTimeExpr: time-unit suffixes -- ms/us/ns/min/h/d', () => {
  assert.equal(parseGotoSimTimeExpr('500ms', '0', null).value, '0.5');
  assert.equal(parseGotoSimTimeExpr('100us', '0', null).value, '0.0001');
  assert.equal(parseGotoSimTimeExpr('1ns', '0', null).value, '0.000000001');
  assert.equal(parseGotoSimTimeExpr('2min', '0', null).value, '120');
  assert.equal(parseGotoSimTimeExpr('1h', '0', null).value, '3600');
});

test('parseGotoSimTimeExpr: relative with a unit suffix', () => {
  const r = parseGotoSimTimeExpr('+100ms', '1', null);
  assert.ok(r.ok);
  assert.equal(r.value, '1.1');
});

test('parseGotoSimTimeExpr: malformed expression -> "Error in expression"', () => {
  const r = parseGotoSimTimeExpr('not a number', '0', null);
  assert.ok(!r.ok);
  assert.equal(r.error, 'Error in expression');
});

test('parseGotoSimTimeExpr: empty/whitespace-only expression -> "Error in expression"', () => {
  assert.equal(parseGotoSimTimeExpr('', '0', null).error, 'Error in expression');
  assert.equal(parseGotoSimTimeExpr('   ', '0', null).error, 'Error in expression');
});

test('parseGotoSimTimeExpr: negative absolute result -> negative-time error', () => {
  const r = parseGotoSimTimeExpr('-5', '0', null); // absolute (no base yet at time 0) but "-" is relative per Java semantics -- base(0) + (-5) = -5
  assert.ok(!r.ok);
  assert.ok(r.error?.includes('negative'));
});

test('parseGotoSimTimeExpr: result beyond the last known simulation time -> beyond-the-end error', () => {
  const r = parseGotoSimTimeExpr('100', '0', '50');
  assert.ok(!r.ok);
  assert.ok(r.error?.includes('beyond the end'));
});

test('parseGotoSimTimeExpr: lastSimulationTime null skips the beyond-the-end check', () => {
  const r = parseGotoSimTimeExpr('1e9'.replace('e9', '000000000'), '0', null);
  assert.ok(r.ok);
});
