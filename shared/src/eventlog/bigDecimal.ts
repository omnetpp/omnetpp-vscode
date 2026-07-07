/**
 * BigDecimal — exact-precision simulation-time arithmetic for the eventlog port.
 *
 * Ported from two sources that must agree in behavior (see the eventlog port plan,
 * risk #7):
 *   - omnetpp-dev/src/common/bigdecimal.{h,cc} — the C++ engine's `BigDecimal`:
 *     an int64 unscaled value + a scale, clamped to at most 18 significant decimal
 *     digits. Its special sentinel values (Zero/One/MinusOne/NaN/PositiveInfinity/
 *     NegativeInfinity/Nil), normalize() rules, ttoa()/parse() string format, and
 *     the operator< special-case branching are ported faithfully here.
 *   - omnetpp-dev/ui/org.omnetpp.common.core/src/org/omnetpp/common/util/BigDecimal.java
 *     — the pure-Java port used by the eventlog UI code, which is really just
 *     `java.math.BigDecimal` (arbitrary-precision unscaled BigInteger + scale) with
 *     `equals()` overridden to mean numeric equality after normalization, plus
 *     `less`/`lessOrEqual`/`greater`/`greaterOrEqual` helpers and `ZERO`/`MINUS_ONE`
 *     constants. This is the porting source for the day-to-day API surface used by
 *     the rest of the eventlog code (EventLogIndex.java etc. only ever compare
 *     against `BigDecimal.ZERO` / `BigDecimal.MINUS_ONE` — the C++ NaN/Infinity/Nil
 *     sentinels are not used by the eventlog library itself, but are ported anyway
 *     for completeness and fidelity with the C++ engine that produces the values).
 *
 * DEVIATION (deliberate, matches the Java side): unlike the C++ class, this port
 * is **arbitrary precision** — the unscaled value is a native `bigint`, not an
 * int64, so there is no 18-digit cap and no arithmetic-overflow exception. This
 * means `add`/`subtract` never fall back to lossy double arithmetic for two
 * finite operands (the C++ class does, to dodge int64 overflow); the only lossy
 * path here is when one operand is a NaN/Infinity/Nil sentinel, which is
 * inherently representable only as a double.
 */

export type BigDecimalSpecial = 'NaN' | 'PositiveInfinity' | 'NegativeInfinity' | 'Nil';

function normalizeUnscaled(unscaled: bigint, scale: number): { unscaled: bigint; scale: number } {
  // "0.0 always has scale=0" (bigdecimal.h comment).
  if (unscaled === 0n) return { unscaled: 0n, scale: 0 };
  // Strip trailing zeros while there is still a fractional part (scale<0),
  // exactly like BigDecimal::normalize()'s "while ((intVal % 10 == 0) && scale < maxScale)".
  // maxScale is always 0 here (arbitrary precision removes the need for a minScale bound).
  while (scale < 0 && unscaled % 10n === 0n) {
    unscaled /= 10n;
    scale++;
  }
  // Never store a positive scale (maxScale=0 invariant): fold it into the unscaled value.
  while (scale > 0) {
    unscaled *= 10n;
    scale--;
  }
  return { unscaled, scale };
}

/** Exact decomposition of a finite non-zero double into sign * significand * 2^exp2 (significand is an integer bigint). */
function decomposeFiniteDouble(d: number): { sign: 1 | -1; significand: bigint; exp2: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, d);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const sign: 1 | -1 = hi >>> 31 ? -1 : 1;
  const biasedExponent = (hi >>> 20) & 0x7ff;
  const fractionHi = hi & 0xfffff; // top 20 bits of the 52-bit fraction
  const fraction = (BigInt(fractionHi) << 32n) | BigInt(lo);

  let significand: bigint;
  let exp2: number;
  if (biasedExponent === 0) {
    // zero or subnormal: value = fraction * 2^-1074
    significand = fraction;
    exp2 = -1074;
  } else {
    // normal: value = (2^52 + fraction) * 2^(biasedExponent-1075)
    significand = (1n << 52n) | fraction;
    exp2 = biasedExponent - 1075;
  }
  // Cosmetic: strip trailing binary zeros so later bigint powers stay smaller.
  while (significand !== 0n && significand % 2n === 0n) {
    significand /= 2n;
    exp2++;
  }
  return { sign, significand, exp2 };
}

function isAsciiSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

function isAsciiDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

export class BigDecimal {
  private constructor(
    private readonly special: BigDecimalSpecial | undefined,
    private readonly unscaled: bigint,
    private readonly scale: number,
  ) {}

  // ---- Constants (bigdecimal.h: Zero/One/MinusOne/NaN/PositiveInfinity/NegativeInfinity/Nil) ----

  static readonly ZERO = new BigDecimal(undefined, 0n, 0);
  static readonly ONE = new BigDecimal(undefined, 1n, 0);
  static readonly MINUS_ONE = new BigDecimal(undefined, -1n, 0);
  static readonly NAN = new BigDecimal('NaN', 0n, 0);
  static readonly POSITIVE_INFINITY = new BigDecimal('PositiveInfinity', 0n, 0);
  static readonly NEGATIVE_INFINITY = new BigDecimal('NegativeInfinity', 0n, 0);
  /** The default/"uninitialized" value (`BigDecimal()` in C++), distinct from NaN. */
  static readonly NIL = new BigDecimal('Nil', 0n, 0);

  // ---- Construction ----

  /** Builds a normalized BigDecimal equal to `unscaled * 10^scale`. */
  static fromUnscaled(unscaled: bigint, scale: number): BigDecimal {
    const n = normalizeUnscaled(unscaled, scale);
    return new BigDecimal(undefined, n.unscaled, n.scale);
  }

  /**
   * Exact conversion from a JS double (port of `BigDecimal::operator=(double)`).
   * Because the unscaled value is an arbitrary-precision bigint, this is a lossless,
   * exact conversion of the double's dyadic value (not an approximation, unlike the
   * int64-bounded C++ version).
   */
  static fromDouble(d: number): BigDecimal {
    if (Number.isNaN(d)) return BigDecimal.NAN;
    if (d === Infinity) return BigDecimal.POSITIVE_INFINITY;
    if (d === -Infinity) return BigDecimal.NEGATIVE_INFINITY;
    if (d === 0) return BigDecimal.ZERO;
    const { sign, significand, exp2 } = decomposeFiniteDouble(d);
    if (significand === 0n) return BigDecimal.ZERO;
    const signBig = BigInt(sign);
    if (exp2 < 0) return BigDecimal.fromUnscaled(signBig * significand * 5n ** BigInt(-exp2), exp2);
    return BigDecimal.fromUnscaled(signBig * significand * 2n ** BigInt(exp2), 0);
  }

  /**
   * Parses a decimal string, requiring the entire string to be consumed.
   * Accepts an optional sign, digits, an optional fractional part, and the
   * case-insensitive special tokens "nan", "inf"/"infinity" (matching
   * `BigDecimal::parse`). Exponent notation ("1e5") is rejected, as is any
   * other trailing garbage or an empty/all-whitespace string.
   */
  static parse(s: string): BigDecimal {
    const { value, end } = BigDecimal.parsePrefix(s, 0);
    if (end !== s.length) throw new Error(`BigDecimal: Invalid number syntax '${s}'`);
    return value;
  }

  private static parsePrefix(s: string, start: number): { value: BigDecimal; end: number } {
    let p = start;
    const n = s.length;

    while (p < n && isAsciiSpace(s[p])) p++;

    let sign = 1;
    if (s[p] === '-') {
      sign = -1;
      p++;
    } else if (s[p] === '+') {
      p++;
    }

    const rest = s.slice(p).toLowerCase();
    if (rest.startsWith('nan')) return { value: BigDecimal.NAN, end: p + 3 };
    if (rest.startsWith('infinity'))
      return { value: sign > 0 ? BigDecimal.POSITIVE_INFINITY : BigDecimal.NEGATIVE_INFINITY, end: p + 8 };
    if (rest.startsWith('inf'))
      return { value: sign > 0 ? BigDecimal.POSITIVE_INFINITY : BigDecimal.NEGATIVE_INFINITY, end: p + 3 };

    let intDigits = '';
    while (isAsciiDigit(s[p])) {
      intDigits += s[p];
      p++;
    }

    let fracDigits = '';
    if (s[p] === '.') {
      p++;
      while (isAsciiDigit(s[p])) {
        fracDigits += s[p];
        p++;
      }
    }

    if (intDigits.length === 0 && fracDigits.length === 0)
      throw new Error(`BigDecimal: Invalid number syntax '${s}'`);

    const digits = intDigits + fracDigits || '0';
    const unscaled = BigInt(sign) * BigInt(digits);
    const scale = -fracDigits.length;
    return { value: BigDecimal.fromUnscaled(unscaled, scale), end: p };
  }

  // ---- Testing for special values ----

  isNaN(): boolean {
    return this.special === 'NaN';
  }
  isNil(): boolean {
    return this.special === 'Nil';
  }
  isPositiveInfinity(): boolean {
    return this.special === 'PositiveInfinity';
  }
  isNegativeInfinity(): boolean {
    return this.special === 'NegativeInfinity';
  }
  isInfinity(): boolean {
    return this.isPositiveInfinity() || this.isNegativeInfinity();
  }
  isSpecial(): boolean {
    return this.special !== undefined;
  }
  isZero(): boolean {
    return this.special === undefined && this.unscaled === 0n;
  }

  // ---- Raw accessors ----

  getUnscaledValue(): bigint {
    if (this.isSpecial()) throw new Error('BigDecimal: cannot get unscaled value of a special value');
    return this.unscaled;
  }
  getScale(): number {
    if (this.isSpecial()) throw new Error('BigDecimal: cannot get scale of a special value');
    return this.scale;
  }

  // ---- Comparisons (port of operator==/!=/</>/<=/>=) ----

  /**
   * Structural equality after normalization. Like the C++ `operator==`, any
   * comparison against a NaN (even NaN vs. NaN) is `false`.
   */
  equals(other: BigDecimal): boolean {
    if (this.isNaN() || other.isNaN()) return false;
    if (this.isSpecial() || other.isSpecial()) return this.special === other.special;
    return this.unscaled === other.unscaled && this.scale === other.scale;
  }

  /** Port of `BigDecimal::operator<`. Throws if either operand is Nil; false if either is NaN. */
  less(other: BigDecimal): boolean {
    if (this.isSpecial() || other.isSpecial()) {
      if (this.isNil() || other.isNil()) throw new Error('BigDecimal: less() received Nil');
      if (this.isNaN() || other.isNaN()) return false;
      if (other.isPositiveInfinity()) return !this.isPositiveInfinity();
      if (this.isNegativeInfinity()) return !other.isNegativeInfinity();
      return false;
    }
    if (this.scale === other.scale) return this.unscaled < other.unscaled;
    const minScale = Math.min(this.scale, other.scale);
    const a = this.unscaled * 10n ** BigInt(this.scale - minScale);
    const b = other.unscaled * 10n ** BigInt(other.scale - minScale);
    return a < b;
  }

  greater(other: BigDecimal): boolean {
    return other.less(this);
  }
  lessOrEqual(other: BigDecimal): boolean {
    return this.equals(other) || this.less(other);
  }
  greaterOrEqual(other: BigDecimal): boolean {
    return this.equals(other) || this.greater(other);
  }

  /**
   * Total-order three-way comparison for use as a sort/SortedMap comparator.
   * Not a literal port (the C++/Java sources never compare against Nil or sort
   * NaNs) — throws on Nil like `less()`/`greater()` do, and defines NaN to
   * compare greater than every non-NaN value (and equal to other NaNs) so that
   * arrays containing them still sort into a well-defined total order.
   */
  compareTo(other: BigDecimal): number {
    if (this.isNil() || other.isNil()) throw new Error('BigDecimal: compareTo() received Nil');
    const aNaN = this.isNaN();
    const bNaN = other.isNaN();
    if (aNaN && bNaN) return 0;
    if (aNaN) return 1;
    if (bNaN) return -1;
    if (this.less(other)) return -1;
    if (other.less(this)) return 1;
    return 0;
  }

  // ---- Arithmetic (port of operator+/-) ----

  add(other: BigDecimal): BigDecimal {
    if (this.isSpecial() || other.isSpecial()) return BigDecimal.fromDouble(this.doubleValue() + other.doubleValue());
    const scale = Math.min(this.scale, other.scale);
    const a = this.unscaled * 10n ** BigInt(this.scale - scale);
    const b = other.unscaled * 10n ** BigInt(other.scale - scale);
    return BigDecimal.fromUnscaled(a + b, scale);
  }

  subtract(other: BigDecimal): BigDecimal {
    if (this.isSpecial() || other.isSpecial()) return BigDecimal.fromDouble(this.doubleValue() - other.doubleValue());
    const scale = Math.min(this.scale, other.scale);
    const a = this.unscaled * 10n ** BigInt(this.scale - scale);
    const b = other.unscaled * 10n ** BigInt(other.scale - scale);
    return BigDecimal.fromUnscaled(a - b, scale);
  }

  negate(): BigDecimal {
    if (this.isNaN()) return BigDecimal.NAN;
    if (this.isPositiveInfinity()) return BigDecimal.NEGATIVE_INFINITY;
    if (this.isNegativeInfinity()) return BigDecimal.POSITIVE_INFINITY;
    if (this.isNil()) return BigDecimal.NIL;
    return BigDecimal.fromUnscaled(-this.unscaled, this.scale);
  }

  static min(a: BigDecimal, b: BigDecimal): BigDecimal {
    return a.less(b) ? a : b;
  }
  static max(a: BigDecimal, b: BigDecimal): BigDecimal {
    return a.greater(b) ? a : b;
  }

  // ---- Conversions ----

  /** Port of `BigDecimal::dbl()`. Conversion may lose precision, like the C++/Java originals. */
  doubleValue(): number {
    if (this.isNaN() || this.isNil()) return NaN;
    if (this.isPositiveInfinity()) return Infinity;
    if (this.isNegativeInfinity()) return -Infinity;
    return Number(this.toString());
  }

  /** Port of `BigDecimal::ttoa()` / `str()`. */
  toString(): string {
    switch (this.special) {
      case 'NaN':
        return 'NaN';
      case 'PositiveInfinity':
        return '+Inf';
      case 'NegativeInfinity':
        return '-Inf';
      case 'Nil':
        return 'Nil';
      default:
        break;
    }
    const negative = this.unscaled < 0n;
    const digits = (negative ? -this.unscaled : this.unscaled).toString();
    if (this.scale === 0) return (negative ? '-' : '') + digits;
    const fracLen = -this.scale;
    const body =
      digits.length > fracLen
        ? digits.slice(0, digits.length - fracLen) + '.' + digits.slice(digits.length - fracLen)
        : '0.' + '0'.repeat(fracLen - digits.length) + digits;
    return (negative ? '-' : '') + body;
  }
}
