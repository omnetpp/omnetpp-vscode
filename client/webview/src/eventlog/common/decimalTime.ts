/**
 * decimalTime.ts (PURE) — arbitrary-precision decimal-STRING arithmetic for
 * simulation-time values, shared by `chart/labelProvider.ts` (tooltip formatting/`dt`
 * subtraction) and `common/dialogs.ts` (Go to Simulation Time's relative `+`/`-` input
 * and time-unit suffixes, U4). Operates on the protocol's own decimal-string
 * representation directly (never round-tripped through a `number`), so this is exact,
 * not an approximation — see `chart/labelProvider.ts`'s header for why this exists
 * instead of importing `@omnetpp/shared`'s `BigDecimal` (keeping this lean browser
 * bundle from pulling in the whole host-agnostic engine for one arithmetic helper).
 */

export interface ParsedDecimal {
  negative: boolean;
  intDigits: string;
  fracDigits: string;
}

export function parseDecimalString(s: string): ParsedDecimal {
  let str = s.trim();
  let negative = false;
  if (str.startsWith('-')) {
    negative = true;
    str = str.slice(1);
  } else if (str.startsWith('+')) {
    str = str.slice(1);
  }
  const dot = str.indexOf('.');
  const intDigits = (dot < 0 ? str : str.slice(0, dot)) || '0';
  const fracDigits = dot < 0 ? '' : str.slice(dot + 1);
  return { negative, intDigits, fracDigits };
}

function stripLeadingZeros(digits: string): string {
  return digits.replace(/^0+(?=\d)/, '') || '0';
}

function toUnscaledBigInt(d: ParsedDecimal, scale: number): bigint {
  const digits = d.intDigits + d.fracDigits.padEnd(scale, '0');
  return BigInt(digits) * (d.negative ? -1n : 1n);
}

function formatFromUnscaled(unscaled: bigint, scale: number): string {
  const negative = unscaled < 0n;
  const abs = negative ? -unscaled : unscaled;
  const digits = abs.toString().padStart(scale + 1, '0');
  const intLen = digits.length - scale;
  const intPart = stripLeadingZeros(digits.slice(0, intLen)) || '0';
  const fracPartRaw = scale > 0 ? digits.slice(intLen) : '';
  const fracPart = fracPartRaw.replace(/0+$/, '');
  const result = fracPart ? `${intPart}.${fracPart}` : intPart;
  return (negative && result !== '0' ? '-' : '') + result;
}

/** Exact `a - b`. */
export function subtractDecimalStrings(aStr: string, bStr: string): string {
  const a = parseDecimalString(aStr);
  const b = parseDecimalString(bStr);
  const scale = Math.max(a.fracDigits.length, b.fracDigits.length);
  return formatFromUnscaled(toUnscaledBigInt(a, scale) - toUnscaledBigInt(b, scale), scale);
}

/** Exact `a + b`. */
export function addDecimalStrings(aStr: string, bStr: string): string {
  const a = parseDecimalString(aStr);
  const b = parseDecimalString(bStr);
  const scale = Math.max(a.fracDigits.length, b.fracDigits.length);
  return formatFromUnscaled(toUnscaledBigInt(a, scale) + toUnscaledBigInt(b, scale), scale);
}

/** Exact `value * 10^exponent` (exponent may be negative -- shifts the decimal point without any rounding). */
export function scaleDecimalStringByPow10(valueStr: string, exponent: number): string {
  const v = parseDecimalString(valueStr);
  // Represent as unscaled-bigint * 10^(-fracDigits.length), then adjust the exponent and reformat.
  const scale = v.fracDigits.length - exponent;
  const unscaled = BigInt(v.intDigits + v.fracDigits) * (v.negative ? -1n : 1n);
  return scale >= 0 ? formatFromUnscaled(unscaled, scale) : formatFromUnscaled(unscaled * 10n ** BigInt(-scale), 0);
}

/** Exact `value * n` for a small non-negative integer multiplier (used for min/h/d unit suffixes, which aren't powers of ten). */
export function multiplyDecimalStringByInt(valueStr: string, n: number): string {
  const v = parseDecimalString(valueStr);
  const scale = v.fracDigits.length;
  const unscaled = BigInt(v.intDigits + v.fracDigits) * (v.negative ? -1n : 1n) * BigInt(n);
  return formatFromUnscaled(unscaled, scale);
}

/**
 * The webview-global "maximum time display accuracy": the number of fractional decimal
 * digits (of a value in SECONDS) to keep when formatting any displayed simulation time.
 * `null` = full precision. Set from the chart's "Time Accuracy" context-menu selector;
 * every time string (hovers, marker deltas, info panels, ruler, hairline) rounds to it.
 * The SI units map to fractional digits: s=0, ms=3, us=6, ns=9, ps=12, fs=15, as=18.
 */
let displayAccuracyFractionDigits: number | null = null;

export function setTimeDisplayAccuracy(fractionDigits: number | null): void {
  displayAccuracyFractionDigits = fractionDigits;
}

export function getTimeDisplayAccuracy(): number | null {
  return displayAccuracyFractionDigits;
}

/** Rounds a decimal string to at most `maxFractionDigits` fractional digits (round-half-away-from-zero), exactly, via BigInt. Returns the input unchanged when it already has few enough fractional digits. */
export function roundDecimalString(decimalString: string, maxFractionDigits: number): string {
  const v = parseDecimalString(decimalString);
  if (v.fracDigits.length <= maxFractionDigits) return decimalString;
  const drop = v.fracDigits.length - maxFractionDigits;
  const divisor = 10n ** BigInt(drop);
  const magnitude = BigInt(v.intDigits + v.fracDigits);
  const rounded = (magnitude + divisor / 2n) / divisor; // round half up on the magnitude
  return formatFromUnscaled(v.negative ? -rounded : rounded, maxFractionDigits);
}

/**
 * Port of `TimeUtils.secondsToTimeString(BigDecimal)`, operating on the decimal string
 * directly (exact). `maxFractionDigits` (defaulting to the global display accuracy)
 * rounds the value first, so e.g. an "us" accuracy turns "159ms 174us 900ns 913ps" into
 * "159ms 175us".
 */
export function formatSimulationTime(decimalString: string, maxFractionDigits: number | null = displayAccuracyFractionDigits): string {
  if (maxFractionDigits != null) decimalString = roundDecimalString(decimalString, maxFractionDigits);
  const parsed = parseDecimalString(decimalString);
  let intPart = stripLeadingZeros(parsed.intDigits);
  let frac = parsed.fracDigits;
  let out = '';
  for (const unit of ['s ', 'ms ', 'us ', 'ns ', 'ps ', 'fs ', 'as ']) {
    if (intPart !== '0') out += `${BigInt(intPart)}${unit}`;
    const chunk = (frac + '000').slice(0, 3);
    frac = frac.length > 3 ? frac.slice(3) : '';
    intPart = stripLeadingZeros(chunk);
  }
  if (out.length === 0) out = '0s';
  return (parsed.negative ? '-' : '') + out.trim();
}

/** `true` iff `decimalString` represents a value `< 0`. */
export function isNegativeDecimal(decimalString: string): boolean {
  const d = parseDecimalString(decimalString);
  return d.negative && /[1-9]/.test(d.intDigits + d.fracDigits);
}

/** Compares two decimal strings; returns `<0`/`0`/`>0` like `Array.prototype.sort`'s comparator. */
export function compareDecimalStrings(aStr: string, bStr: string): number {
  const diff = subtractDecimalStrings(aStr, bStr);
  if (diff === '0') return 0;
  return isNegativeDecimal(diff) ? -1 : 1;
}
