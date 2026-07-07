/**
 * ticks.ts (PURE) — port of `SequenceChart.java`'s `calculateTicks`/`calculateTick`/
 * `calculateTickBestLastDigit` (simtime gutter tick generation), verified by reading
 * `SequenceChart.java:5489-5648`.
 *
 * Two tick-placement strategies, chosen by `TimelineMode` (matches Java exactly):
 *  - `SIMULATION_TIME`: tc IS simulation time (an affine shift), so ticks are placed
 *    at constant *timeline-unit* (== simtime) spacing, snapped to "nice" powers of
 *    ten refined to a 1/2/5x10^k step pattern (`tickIntvl` selection).
 *  - `EVENT_NUMBER`/`STEP`/`NONLINEAR`: tc is NOT simtime-proportional, so ticks are
 *    placed at constant *pixel* spacing (`TICK_SPACING_PX`, pinned to tc=0 so they
 *    don't jitter while panning — Java: `fixPointViewportCoordinate % tickSpacing`,
 *    reparametrized here as "multiples of `TICK_SPACING_PX/pixelsPerTc` measured
 *    from tc=0", since tc=0 is this port's coordinate-system origin, same role Java's
 *    fix point plays), and the actual LABEL VALUE at each pixel position is chosen by
 *    `calculateTick`'s "best last digit" rounding so labels are short/round even
 *    though their pixel positions are exactly evenly spaced.
 *
 * PRECISION NOTE (deviation from Java, documented): Java performs this rounding with
 * exact-decimal `BigDecimal`/`MathContext` arithmetic (exact significant-digit
 * counting and floor/ceiling-to-N-digits). This port receives simulation times as
 * plain `number` (via coords.ts's already-approximate interpolation) and reimplements
 * "significant digit" counting/rounding using `toPrecision()`-based string
 * manipulation, which is only reliable to IEEE double precision (~15-17 significant
 * decimal digits) and can occasionally mis-count a digit for values that don't have
 * an exact binary representation (e.g. 0.1). This never matters in practice for tick
 * labels (which are deliberately short, low-precision numbers by construction), but
 * is a real, intentional precision reduction from the engine's arbitrary-precision
 * `BigDecimal` — noted per this phase's "tick-algorithm precision notes" deliverable.
 */

import { TimelineMode } from '@omnetpp/shared/elog-protocol';

/** `SequenceChartStyleProvider.getTickSpacing()` default. */
export const TICK_SPACING_PX = 100;

export interface Tick {
  /** Timeline coordinate this tick's label should be drawn at. */
  tc: number;
  /** The (rounded, "nice") simulation-time value to display. */
  simTime: number;
  label: string;
}

export interface TickResult {
  ticks: Tick[];
  /** Shared decimal prefix common to the leftmost/rightmost visible simulation time (Java: `tickPrefix`, shown once instead of repeating on every label). Empty string if not worth factoring out. */
  commonPrefix: string;
}

// ---------------------------------------------------------------------------------
// double-precision "significant digits" helpers (see this file's header, PRECISION NOTE)
// ---------------------------------------------------------------------------------

/** Number of significant decimal digits in `x`'s shortest reasonable representation (trailing zeros stripped), approximated via `toPrecision`. */
function significantDigits(x: number): number {
  if (x === 0) return 1;
  const s = Math.abs(x).toPrecision(15);
  const digitsOnly = s.replace(/[eE][+-]?\d+$/, '').replace('.', '').replace(/^0+/, '') || '0';
  const trimmed = digitsOnly.replace(/0+$/, '') || '0';
  return Math.max(1, trimmed.length);
}

/** Rounds `x` (>= 0) to `digits` significant decimal digits, flooring or ceiling. */
function roundToSignificantDigits(x: number, digits: number, mode: 'floor' | 'ceil'): number {
  if (x === 0) return 0;
  const magnitude = Math.floor(Math.log10(x));
  const scale = Math.pow(10, digits - 1 - magnitude);
  const scaled = x * scale;
  const rounded = mode === 'floor' ? Math.floor(scaled + 1e-9) : Math.ceil(scaled - 1e-9);
  return rounded / scale;
}

/** Place-value (10^k) of `v`'s last significant digit, e.g. `unitForValue(1.25) === 0.01`. Used to pick apart/reconstruct a value's last decimal digit without string parsing. */
function unitForValue(v: number): number {
  if (v === 0) return 1;
  return Math.pow(10, Math.floor(Math.log10(v)) - significantDigits(v) + 1);
}

/** `v`'s last significant decimal digit (0-9), e.g. `lastDigitOf(1.25) === 5`. */
function lastDigitOf(v: number): number {
  const unit = unitForValue(v);
  return Math.round(v / unit) % 10;
}

/**
 * Port of `calculateTick()` (`SequenceChart.java:5539-5630`): given the simulation
 * time at a tc and the range of simulation times still "close enough" (`tMin`/
 * `tMax`), find the shortest-decimal value in `[tMin, tMax]` (rounding both from
 * below and from above, keeping whichever needs fewer significant digits; ties
 * broken by preferring a trailing 5, then a trailing even digit).
 */
function calculateTick(simulationTime: number, tMinIn: number, tMaxIn: number): number {
  const tMin = Math.min(tMinIn, simulationTime);
  const tMax = Math.max(tMaxIn, simulationTime);
  if (simulationTime === 0) return 0;

  const tMinDigits = significantDigits(tMin);
  const tMaxDigits = significantDigits(tMax);
  const tDeltaDigits = significantDigits(Math.max(1e-300, tMax - tMin));
  const precision = Math.max(1, 1 + Math.max(tMinDigits - tDeltaDigits, tMaxDigits - tDeltaDigits));

  let bestFromBelow = simulationTime;
  let bestFromAbove = simulationTime;
  for (let p = precision; p >= 1; p--) {
    const roundedDown = roundToSignificantDigits(simulationTime, p, 'floor');
    if (roundedDown > tMin) bestFromBelow = roundedDown;
    const roundedUp = roundToSignificantDigits(simulationTime, p, 'ceil');
    if (roundedUp < tMax) bestFromAbove = roundedUp;
  }

  bestFromBelow = tickBestLastDigit(bestFromBelow, tMin, tMax);
  bestFromAbove = tickBestLastDigit(bestFromAbove, tMin, tMax);

  const digitsBelow = significantDigits(bestFromBelow);
  const digitsAbove = significantDigits(bestFromAbove);
  if (digitsBelow < digitsAbove) return bestFromBelow;
  if (digitsBelow > digitsAbove) return bestFromAbove;

  const dBelow = lastDigitOf(bestFromBelow);
  const dAbove = lastDigitOf(bestFromAbove);
  if (dBelow === 5) return bestFromBelow;
  if (dAbove === 5) return bestFromAbove;
  if (dBelow % 2 === 0) return bestFromBelow;
  if (dAbove % 2 === 0) return bestFromAbove;
  return bestFromBelow;
}

/**
 * Port of `calculateTickBestLastDigit()`: try replacing `value`'s last significant
 * digit with 5, then with the nearest even digit, keeping the change only if the
 * result stays strictly inside `(min, max)`. Assumes `value >= 0` (simulation times
 * are always non-negative, matching Java's own `tick >= 0` filter upstream).
 */
function tickBestLastDigit(value: number, min: number, max: number): number {
  if (value === 0) return value;
  const unit = unitForValue(value);
  const base = Math.floor(value / (unit * 10) + 1e-9) * (unit * 10);

  let candidate = base + 5 * unit;
  if (min < candidate && candidate < max) return candidate;

  const digit = Math.round((value - base) / unit);
  const evenDigit = digit - (digit % 2);
  candidate = base + evenDigit * unit;
  if (min < candidate && candidate < max) return candidate;

  return value;
}

// ---------------------------------------------------------------------------------
// nice-number formatting
// ---------------------------------------------------------------------------------

/** Formats a tick value without floating-point noise or scientific notation, for the magnitudes ticks realistically take. */
export function formatTickLabel(value: number): string {
  if (value === 0) return '0';
  const digits = significantDigits(value);
  const magnitude = Math.floor(Math.log10(value));
  const decimals = Math.max(0, digits - 1 - magnitude);
  return value.toFixed(Math.min(20, decimals)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  // only worth factoring out a shared prefix of at least 3 chars ending before the last couple digits
  return i >= 3 ? a.slice(0, i) : '';
}

// ---------------------------------------------------------------------------------
// public entry point
// ---------------------------------------------------------------------------------

/**
 * Port of `calculateTicks(viewportWidth)`. `simTimeAt(tc)` is the caller's
 * (approximate) tc->simtime mapping (coords.ts's `tcToSimTimeApprox`, composed with
 * the caller's sample table) — kept as an injected function so this module stays
 * pure/independently testable with hand-built mappings.
 */
export function calculateTicks(
  timelineMode: TimelineMode,
  leftTc: number,
  rightTc: number,
  pixelsPerTc: number,
  lastSimTime: number,
  simTimeAt: (tc: number) => number | null,
): TickResult {
  const ticks: Tick[] = [];
  if (pixelsPerTc <= 0 || lastSimTime < 0) return { ticks, commonPrefix: '' };

  const leftSimTime = simTimeAt(leftTc) ?? 0;
  const rightSimTime = simTimeAt(rightTc) ?? leftSimTime;

  if (timelineMode === TimelineMode.SIMULATION_TIME) {
    const tickSpacingInUnits = TICK_SPACING_PX / pixelsPerTc;
    if (tickSpacingInUnits <= 0 || !Number.isFinite(tickSpacingInUnits)) return { ticks, commonPrefix: '' };
    const tickScale = Math.ceil(Math.log10(tickSpacingInUnits));
    const unit = Math.pow(10, tickScale);
    let tickIntvl = unit;
    if (unit / 5 > tickSpacingInUnits) tickIntvl = unit / 5;
    else if (unit / 2 > tickSpacingInUnits) tickIntvl = unit / 2;

    const tickStart = Math.floor(Math.max(0, leftSimTime) / unit) * unit;
    const tickEnd = Math.ceil(Math.max(0, rightSimTime) / unit) * unit;
    const maxTicks = 10_000; // defensive cap against pathological (near-zero) tickIntvl
    let count = 0;
    for (let t = tickStart; t < tickEnd && count < maxTicks; t += tickIntvl, count++) {
      if (t < 0) continue;
      // tc is an affine function of simtime in this mode -- linear interpolation between the two
      // simtimes we already sampled (left/right) recovers it without a further engine round trip.
      const tc = rightSimTime === leftSimTime ? leftTc : leftTc + ((t - leftSimTime) * (rightTc - leftTc)) / (rightSimTime - leftSimTime);
      ticks.push({ tc, simTime: t, label: formatTickLabel(t) });
    }
  } else {
    const tcStep = TICK_SPACING_PX / pixelsPerTc;
    if (tcStep <= 0 || !Number.isFinite(tcStep)) return { ticks, commonPrefix: '' };
    const kStart = Math.floor(leftTc / tcStep) - 1;
    const kEnd = Math.ceil(rightTc / tcStep) + 1;
    const maxTicks = 10_000;
    for (let k = kStart, count = 0; k <= kEnd && count < maxTicks; k++, count++) {
      const tc = k * tcStep;
      const simulationTime = simTimeAt(tc);
      if (simulationTime === null) continue;
      const tMin = simTimeAt(tc - tcStep / 2) ?? simulationTime;
      const tMax = simTimeAt(tc + tcStep / 2) ?? simulationTime;
      const tick = calculateTick(simulationTime, tMin, tMax);
      if (tick >= 0 && tick <= lastSimTime) ticks.push({ tc, simTime: tick, label: formatTickLabel(tick) });
    }
  }

  const prefix = ticks.length >= 2 ? commonPrefix(formatTickLabel(leftSimTime), formatTickLabel(rightSimTime)) : '';
  return { ticks, commonPrefix: prefix };
}
