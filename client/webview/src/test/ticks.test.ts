import { test } from 'bun:test';
import assert from 'node:assert';
import { TimelineMode } from '@omnetpp/shared/elog-protocol';
import { adaptiveTimeFractionDigits, calculateTicks, formatMouseTime, formatTickLabel, formatTickTime, timeCommonPrefix } from '../eventlog/chart/ticks';

// A simple affine simtime<->tc mapping (as if TimelineMode.SIMULATION_TIME, where tc IS simtime).
function identitySimTimeAt(tc: number): number | null {
  return tc;
}

test('SIMULATION_TIME mode: ticks land on nice 1/2/5x10^k values, ascending, within the visible range', () => {
  // visible range [0, 1000], pixelsPerTc chosen so TICK_SPACING_PX(100) / pixelsPerTc gives a
  // few-hundred-unit step -- expect a "nice" round-number tick sequence.
  const result = calculateTicks(TimelineMode.SIMULATION_TIME, 0, 1000, 1, 1000, identitySimTimeAt);
  assert.ok(result.ticks.length >= 2, 'produces at least a couple of ticks');
  for (let i = 1; i < result.ticks.length; i++) assert.ok(result.ticks[i].simTime > result.ticks[i - 1].simTime, 'ticks strictly ascending');
  for (const t of result.ticks) assert.ok(t.simTime >= 0 && t.simTime <= 1000, `tick ${t.simTime} within range`);
  // step between consecutive ticks should be constant (a hallmark of "nice" spacing)
  if (result.ticks.length >= 3) {
    const step0 = result.ticks[1].simTime - result.ticks[0].simTime;
    const step1 = result.ticks[2].simTime - result.ticks[1].simTime;
    assert.ok(Math.abs(step0 - step1) < 1e-6, `constant step: ${step0} vs ${step1}`);
  }
});

test('SIMULATION_TIME mode: a finer zoom level produces a smaller (or equal) tick step than a coarser one', () => {
  const coarse = calculateTicks(TimelineMode.SIMULATION_TIME, 0, 1000, 1, 1000, identitySimTimeAt);
  const fine = calculateTicks(TimelineMode.SIMULATION_TIME, 0, 1000, 20, 1000, identitySimTimeAt);
  const stepOf = (r: typeof coarse) => (r.ticks.length >= 2 ? r.ticks[1].simTime - r.ticks[0].simTime : Infinity);
  assert.ok(stepOf(fine) <= stepOf(coarse));
});

test('SIMULATION_TIME mode: zero-width range (empty log, lastSimTime=0) produces no ticks without throwing', () => {
  const result = calculateTicks(TimelineMode.SIMULATION_TIME, 0, 0, 50, 0, identitySimTimeAt);
  assert.deepStrictEqual(result.ticks, []);
});

test('EVENT_NUMBER-like mode: ticks are placed at constant pixel spacing (tc step = TICK_SPACING_PX / pixelsPerTc)', () => {
  const pixelsPerTc = 10;
  const result = calculateTicks(TimelineMode.EVENT_NUMBER, 0, 200, pixelsPerTc, 1000, identitySimTimeAt);
  assert.ok(result.ticks.length >= 2);
  for (let i = 1; i < result.ticks.length; i++) {
    const tcStep = result.ticks[i].tc - result.ticks[i - 1].tc;
    assert.ok(Math.abs(tcStep - 100 / pixelsPerTc) < 1e-6, `tc step ${tcStep}`);
  }
});

test('EVENT_NUMBER-like mode: ticks outside [0, lastSimTime] are excluded', () => {
  // simTimeAt returns tc itself, and lastSimTime is small -- most candidate ticks should be filtered out
  const result = calculateTicks(TimelineMode.EVENT_NUMBER, -500, 500, 5, 10, identitySimTimeAt);
  for (const t of result.ticks) assert.ok(t.simTime >= 0 && t.simTime <= 10);
});

test('formatTickLabel renders nice numbers without floating-point noise or scientific notation', () => {
  assert.strictEqual(formatTickLabel(0), '0');
  assert.strictEqual(formatTickLabel(1), '1');
  assert.strictEqual(formatTickLabel(2.5), '2.5');
  assert.strictEqual(formatTickLabel(100), '100');
});

test('formatTickTime renders short unit-bearing ruler labels like Eclipse (0s / 130ms / 50ns), not raw decimals', () => {
  assert.strictEqual(formatTickTime(0), '0s');
  assert.strictEqual(formatTickTime(0.13), '130ms');
  assert.strictEqual(formatTickTime(0.26), '260ms');
  assert.strictEqual(formatTickTime(1.79), '1s 790ms');
  assert.strictEqual(formatTickTime(5e-8), '50ns');
  // a non-linear tick's noisy interpolated time rounds to a clean single unit
  assert.strictEqual(formatTickTime(0.130189758243495), '130ms');
});

test('adaptiveTimeFractionDigits: coarsest digit count so a 1px move still changes the display', () => {
  assert.strictEqual(adaptiveTimeFractionDigits(1), 0); // 1s/px -> whole seconds
  assert.strictEqual(adaptiveTimeFractionDigits(0.01), 2); // 10ms/px -> 2 digits
  assert.strictEqual(adaptiveTimeFractionDigits(0.001), 3); // 1ms/px -> 3 digits
  assert.strictEqual(adaptiveTimeFractionDigits(1e-6), 6); // 1us/px -> 6 digits
  assert.strictEqual(adaptiveTimeFractionDigits(10), 0); // >1s/px never negative
  assert.strictEqual(adaptiveTimeFractionDigits(0), 3); // frozen zero-time region -> fallback
});

test('formatMouseTime: precision adapts to zoom, not to the magnitude (the >1s "rounds to 10ms" bug)', () => {
  // Same time, different zooms -> different precision (short as possible, still changes per px).
  assert.strictEqual(formatMouseTime(3.774, 0.001, null), '3s 774ms'); // 1ms/px keeps the ms digit even above 1s
  assert.strictEqual(formatMouseTime(3.77, 1, null), '4s'); // 1s/px -> whole seconds
  assert.strictEqual(formatMouseTime(3.774, 1e-6, null), '3s 774ms'); // trailing zero us chunk dropped -> still short
  // Time Accuracy cap wins when it is coarser than the adaptive precision.
  assert.strictEqual(formatMouseTime(0.13, 1e-9, 3), '130ms');
});

test('timeCommonPrefix mirrors Java TimeUtils.commonPrefix (shared round offset of two times)', () => {
  assert.strictEqual(timeCommonPrefix(1.15, 1.5), 1); // "1s" shared, factor it out
  assert.strictEqual(timeCommonPrefix(1.15, 1.16), 1.1); // shared "1.1"
  assert.strictEqual(timeCommonPrefix(0.15, 0.5), 0); // fractional diverges immediately -> nothing shared
  assert.strictEqual(timeCommonPrefix(12.3, 15.6), 10); // differing integer digit masked to 0
});

test('calculateTicks factors out the common prefix: tickPrefix set + labels drawn relative ("+200ms")', () => {
  // SIMULATION_TIME so tc == simtime; view spans 1.10s..1.30s -> prefix 1s; zoom gives 0.1s ticks.
  const r = calculateTicks(TimelineMode.SIMULATION_TIME, 1.1, 1.3, 2000, 10, (tc) => tc);
  assert.strictEqual(r.tickPrefix, 1, 'prefix factored out to 1s');
  assert.ok(r.ticks.length >= 2);
  assert.ok(
    r.ticks.every((t) => t.label.startsWith('+')),
    'every tick label is relative ("+…")',
  );
  // a tick at 1.2s reads "+200ms", not "1s 200ms"
  const t12 = r.ticks.find((t) => Math.abs(t.simTime - 1.2) < 1e-9);
  assert.ok(t12 && t12.label === '+200ms', `expected +200ms, got ${t12?.label}`);
});

test('calculateTicks: no shared prefix (view spans 0..end) -> tickPrefix 0, full labels (no "+")', () => {
  const r = calculateTicks(TimelineMode.SIMULATION_TIME, 0, 0.5, 500, 10, (tc) => tc);
  assert.strictEqual(r.tickPrefix, 0);
  assert.ok(r.ticks.some((t) => !t.label.startsWith('+')));
});

test('calculateTicks tolerates a simTimeAt that returns null (unresolvable tc) without throwing', () => {
  const result = calculateTicks(TimelineMode.STEP, 0, 100, 1, 100, () => null);
  assert.deepStrictEqual(result.ticks, []);
});
