import { test } from 'bun:test';
import assert from 'node:assert';
import {
  addDecimalStrings,
  compareDecimalStrings,
  formatSimulationTime,
  isNegativeDecimal,
  multiplyDecimalStringByInt,
  scaleDecimalStringByPow10,
  subtractDecimalStrings,
} from '../eventlog/common/decimalTime';

test('addDecimalStrings: exact addition beyond double precision', () => {
  assert.equal(addDecimalStrings('1', '0.000000001'), '1.000000001');
});

test('addDecimalStrings: negative + positive', () => {
  assert.equal(addDecimalStrings('-1.5', '2'), '0.5');
});

test('subtractDecimalStrings: exact subtraction', () => {
  assert.equal(subtractDecimalStrings('1.000000001', '1'), '0.000000001');
});

test('subtractDecimalStrings: result is negative', () => {
  assert.equal(subtractDecimalStrings('1', '1.5'), '-0.5');
});

test('scaleDecimalStringByPow10: milliseconds to seconds (negative exponent)', () => {
  assert.equal(scaleDecimalStringByPow10('500', -3), '0.5');
});

test('scaleDecimalStringByPow10: seconds to milliseconds (positive exponent)', () => {
  assert.equal(scaleDecimalStringByPow10('0.5', 3), '500');
});

test('scaleDecimalStringByPow10: zero exponent is a passthrough (normalized)', () => {
  assert.equal(scaleDecimalStringByPow10('1.50', 0), '1.5');
});

test('multiplyDecimalStringByInt: minutes to seconds', () => {
  assert.equal(multiplyDecimalStringByInt('2', 60), '120');
  assert.equal(multiplyDecimalStringByInt('1.5', 60), '90');
});

test('formatSimulationTime: matches labelProvider.ts\'s re-export', () => {
  assert.equal(formatSimulationTime('1.5'), '1s 500ms');
});

test('isNegativeDecimal: sign detection ignores a bare "-0"', () => {
  assert.ok(isNegativeDecimal('-1'));
  assert.ok(!isNegativeDecimal('-0'));
  assert.ok(!isNegativeDecimal('0'));
  assert.ok(!isNegativeDecimal('1'));
});

test('compareDecimalStrings: orders like Array.prototype.sort comparators', () => {
  assert.ok(compareDecimalStrings('1', '2') < 0);
  assert.ok(compareDecimalStrings('2', '1') > 0);
  assert.equal(compareDecimalStrings('1.50', '1.5'), 0);
});
