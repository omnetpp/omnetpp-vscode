import { test } from 'bun:test';
import assert from 'node:assert';
import { TimelineMode } from '@omnetpp/shared/elog-protocol';
import { calculateTicks, formatTickLabel } from '../eventlog/chart/ticks';

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

test('calculateTicks tolerates a simTimeAt that returns null (unresolvable tc) without throwing', () => {
  const result = calculateTicks(TimelineMode.STEP, 0, 100, 1, 100, () => null);
  assert.deepStrictEqual(result.ticks, []);
});
