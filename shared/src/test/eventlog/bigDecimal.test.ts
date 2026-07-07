import { test } from 'bun:test';
import assert from 'node:assert';
import { BigDecimal } from '../../eventlog/bigDecimal';

// ---- parse / toString round trips -------------------------------------------------

test('bigDecimal: round-trips plain decimal strings', () => {
  for (const s of ['1.018454036455', '0', '123', '-45', '-0.001', '0.5', '1', '-1', '3.14159265358979']) {
    assert.equal(BigDecimal.parse(s).toString(), s);
  }
});

test('bigDecimal: round-trips many-decimal strings exactly', () => {
  const s = '1.018454036455';
  assert.equal(BigDecimal.parse(s).toString(), s);
});

test('bigDecimal: round-trips negative numbers', () => {
  assert.equal(BigDecimal.parse('-45').toString(), '-45');
  assert.equal(BigDecimal.parse('-0.5').toString(), '-0.5');
});

test('bigDecimal: round-trips zero and integers', () => {
  assert.equal(BigDecimal.parse('0').toString(), '0');
  assert.equal(BigDecimal.parse('42').toString(), '42');
  assert.equal(BigDecimal.parse('100').toString(), '100'); // trailing zeros of an integer are NOT stripped
});

test('bigDecimal: -0 collapses to 0 (sign has no meaning for zero)', () => {
  assert.equal(BigDecimal.parse('-0').toString(), '0');
  assert.equal(BigDecimal.parse('-0.0').toString(), '0');
});

// ---- normalization / structural equality -------------------------------------------

test('bigDecimal: normalization makes different-scale representations of the same value equal', () => {
  assert.ok(BigDecimal.parse('1.50').equals(BigDecimal.parse('1.5')));
  assert.ok(BigDecimal.parse('1.500000').equals(BigDecimal.parse('1.5')));
  assert.ok(BigDecimal.parse('0.10').equals(BigDecimal.parse('0.1')));
  assert.equal(BigDecimal.parse('1.50').toString(), BigDecimal.parse('1.5').toString());
});

test('bigDecimal: normalization does not strip zeros from a whole-number scale', () => {
  assert.ok(!BigDecimal.parse('100').equals(BigDecimal.parse('1')));
  assert.equal(BigDecimal.parse('100').toString(), '100');
});

test('bigDecimal: equals is false for different values', () => {
  assert.ok(!BigDecimal.parse('1.5').equals(BigDecimal.parse('1.6')));
  assert.ok(!BigDecimal.parse('1').equals(BigDecimal.parse('-1')));
});

// ---- comparisons --------------------------------------------------------------------

test('bigDecimal: less/greater/compareTo vectors', () => {
  const vectors: Array<[string, string]> = [
    ['0', '1'],
    ['-1', '0'],
    ['1.1', '1.2'],
    ['-1.2', '-1.1'],
    ['0.001', '0.01'],
    ['1', '1.0000001'],
    ['-5', '5'],
    ['2.5', '2.50001'],
  ];
  for (const [a, b] of vectors) {
    const x = BigDecimal.parse(a);
    const y = BigDecimal.parse(b);
    assert.ok(x.less(y), `expected ${a} < ${b}`);
    assert.ok(!y.less(x), `expected !(${b} < ${a})`);
    assert.ok(y.greater(x), `expected ${b} > ${a}`);
    assert.equal(x.compareTo(y), -1);
    assert.equal(y.compareTo(x), 1);
    assert.ok(x.lessOrEqual(y));
    assert.ok(y.greaterOrEqual(x));
  }
});

test('bigDecimal: equal values compare as 0 and are lessOrEqual/greaterOrEqual to each other', () => {
  const a = BigDecimal.parse('1.50');
  const b = BigDecimal.parse('1.5');
  assert.equal(a.compareTo(b), 0);
  assert.ok(a.lessOrEqual(b) && a.greaterOrEqual(b));
  assert.ok(!a.less(b) && !a.greater(b));
});

// ---- add / subtract (exactness) -----------------------------------------------------

test('bigDecimal: add/subtract are exact (no floating point drift)', () => {
  const a = BigDecimal.parse('0.1');
  const b = BigDecimal.parse('0.2');
  assert.equal(a.add(b).toString(), '0.3'); // 0.1+0.2 !== 0.3 in plain doubles
  assert.equal(BigDecimal.parse('1.018454036455').add(BigDecimal.ZERO).toString(), '1.018454036455');
  assert.equal(BigDecimal.parse('10').subtract(BigDecimal.parse('0.001')).toString(), '9.999');
  assert.equal(BigDecimal.parse('-1.5').add(BigDecimal.parse('1.5')).toString(), '0');
});

test('bigDecimal: add/subtract handle differing scales', () => {
  const a = BigDecimal.parse('1');
  const b = BigDecimal.parse('0.0001');
  assert.equal(a.add(b).toString(), '1.0001');
  assert.equal(a.subtract(b).toString(), '0.9999');
});

test('bigDecimal: subtract is the inverse of add', () => {
  const a = BigDecimal.parse('123.456');
  const b = BigDecimal.parse('78.9');
  assert.ok(a.add(b).subtract(b).equals(a));
});

// ---- doubleValue ---------------------------------------------------------------------

test('bigDecimal: doubleValue converts back to the expected double', () => {
  assert.equal(BigDecimal.parse('1.5').doubleValue(), 1.5);
  assert.equal(BigDecimal.parse('-2.25').doubleValue(), -2.25);
  assert.equal(BigDecimal.parse('0').doubleValue(), 0);
});

test('bigDecimal: fromDouble is exact for dyadic (binary-representable) doubles', () => {
  assert.ok(BigDecimal.fromDouble(1.5).equals(BigDecimal.parse('1.5')));
  assert.ok(BigDecimal.fromDouble(0.25).equals(BigDecimal.parse('0.25')));
  assert.ok(BigDecimal.fromDouble(-8).equals(BigDecimal.parse('-8')));
  assert.ok(BigDecimal.fromDouble(0).equals(BigDecimal.ZERO));
  // fromDouble(x).doubleValue() must round-trip for any double
  for (const d of [1.5, 0.1, 123.456, -99.99, 1e10, 1e-10, 3.14159265358979]) {
    assert.equal(BigDecimal.fromDouble(d).doubleValue(), d);
  }
});

// ---- sentinel statics ----------------------------------------------------------------

test('bigDecimal: sentinel statics', () => {
  assert.ok(BigDecimal.ZERO.isZero());
  assert.ok(BigDecimal.ZERO.equals(BigDecimal.parse('0')));
  assert.ok(BigDecimal.ONE.equals(BigDecimal.parse('1')));
  assert.ok(BigDecimal.MINUS_ONE.equals(BigDecimal.parse('-1')));

  assert.ok(BigDecimal.NAN.isNaN());
  assert.ok(BigDecimal.NAN.isSpecial());
  assert.ok(!BigDecimal.NAN.equals(BigDecimal.NAN)); // NaN never equals anything, not even itself
  assert.equal(BigDecimal.NAN.toString(), 'NaN');
  assert.ok(Number.isNaN(BigDecimal.NAN.doubleValue()));

  assert.ok(BigDecimal.POSITIVE_INFINITY.isPositiveInfinity());
  assert.ok(BigDecimal.POSITIVE_INFINITY.isInfinity());
  assert.equal(BigDecimal.POSITIVE_INFINITY.doubleValue(), Infinity);
  assert.equal(BigDecimal.POSITIVE_INFINITY.toString(), '+Inf');

  assert.ok(BigDecimal.NEGATIVE_INFINITY.isNegativeInfinity());
  assert.equal(BigDecimal.NEGATIVE_INFINITY.doubleValue(), -Infinity);
  assert.equal(BigDecimal.NEGATIVE_INFINITY.toString(), '-Inf');

  assert.ok(BigDecimal.NIL.isNil());
  assert.ok(BigDecimal.NIL.isSpecial());
  assert.equal(BigDecimal.NIL.toString(), 'Nil');
  assert.ok(BigDecimal.NIL.equals(BigDecimal.NIL));
  assert.ok(!BigDecimal.NIL.equals(BigDecimal.ZERO));
});

test('bigDecimal: comparisons against infinities behave like unbounded extremes', () => {
  const five = BigDecimal.parse('5');
  assert.ok(five.less(BigDecimal.POSITIVE_INFINITY));
  assert.ok(!BigDecimal.POSITIVE_INFINITY.less(five));
  assert.ok(BigDecimal.NEGATIVE_INFINITY.less(five));
  assert.ok(!five.less(BigDecimal.NEGATIVE_INFINITY));
  assert.ok(BigDecimal.NEGATIVE_INFINITY.less(BigDecimal.POSITIVE_INFINITY));
  assert.ok(!BigDecimal.POSITIVE_INFINITY.less(BigDecimal.POSITIVE_INFINITY));
});

test('bigDecimal: comparisons involving NaN are always false; less()/greater() throw on Nil', () => {
  const five = BigDecimal.parse('5');
  assert.ok(!five.less(BigDecimal.NAN));
  assert.ok(!BigDecimal.NAN.less(five));
  assert.ok(!BigDecimal.NAN.greater(five));
  assert.throws(() => five.less(BigDecimal.NIL));
  assert.throws(() => BigDecimal.NIL.less(five));
  assert.throws(() => five.compareTo(BigDecimal.NIL));
});

test('bigDecimal: min/max helpers', () => {
  const a = BigDecimal.parse('1.5');
  const b = BigDecimal.parse('2.5');
  assert.ok(BigDecimal.min(a, b).equals(a));
  assert.ok(BigDecimal.max(a, b).equals(b));
});

// ---- rejection of exponent notation --------------------------------------------------

test('bigDecimal: rejects exponent notation and other malformed input', () => {
  assert.throws(() => BigDecimal.parse('1e5'));
  assert.throws(() => BigDecimal.parse('1E5'));
  assert.throws(() => BigDecimal.parse('1.5e-3'));
  assert.throws(() => BigDecimal.parse(''));
  assert.throws(() => BigDecimal.parse('abc'));
  assert.throws(() => BigDecimal.parse('1.2.3'));
  assert.throws(() => BigDecimal.parse('1 2'));
});

test('bigDecimal: parses signed numbers and leading whitespace', () => {
  assert.ok(BigDecimal.parse('+5').equals(BigDecimal.parse('5')));
  // Leading whitespace is skipped (like the C++ parser); trailing whitespace is
  // not, since parse() requires the entire string to be consumed.
  assert.ok(BigDecimal.parse('  5').equals(BigDecimal.parse('5')));
  assert.throws(() => BigDecimal.parse('5  '));
});

test('bigDecimal: parses special tokens case-insensitively', () => {
  assert.ok(BigDecimal.parse('nan').isNaN());
  assert.ok(BigDecimal.parse('NaN').isNaN());
  assert.ok(BigDecimal.parse('inf').isPositiveInfinity());
  assert.ok(BigDecimal.parse('-inf').isNegativeInfinity());
  assert.ok(BigDecimal.parse('Infinity').isPositiveInfinity());
  assert.ok(BigDecimal.parse('-Infinity').isNegativeInfinity());
});
