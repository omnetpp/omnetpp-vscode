import { test } from 'bun:test';
import assert from 'node:assert';
import { buildSampleTable, clipCoordinate, pixelToTc, simTimeToTcApprox, tcToPixel, tcToSimTimeApprox, type TcSimSource } from '../eventlog/chart/coords';

// ---------------------------------------------------------------------------------
// tc <-> pixel round trips at extreme zooms
// ---------------------------------------------------------------------------------

test('tcToPixel/pixelToTc round-trip at a normal zoom level', () => {
  const v = { leftTc: 100, pixelsPerTc: 50 };
  for (const tc of [100, 150, 237.5, 1000]) {
    const px = tcToPixel(tc, v);
    assert.ok(Math.abs(pixelToTc(px, v) - tc) < 1e-9, `tc=${tc}`);
  }
});

test('tcToPixel/pixelToTc round-trip at an extremely zoomed-in level (huge pixelsPerTc)', () => {
  const v = { leftTc: 0, pixelsPerTc: 1e8 };
  const px = tcToPixel(1e-6, v);
  assert.ok(Math.abs(pixelToTc(px, v) - 1e-6) < 1e-9);
});

test('tcToPixel/pixelToTc round-trip at an extremely zoomed-out level (tiny pixelsPerTc)', () => {
  const v = { leftTc: 0, pixelsPerTc: 1e-6 };
  const px = tcToPixel(1e9, v);
  assert.ok(Math.abs(pixelToTc(px, v) - 1e9) < 1);
});

test('clipCoordinate clamps to a canvas-safe range and passes through normal values', () => {
  assert.strictEqual(clipCoordinate(100), 100);
  assert.strictEqual(clipCoordinate(1e20), 8_388_608);
  assert.strictEqual(clipCoordinate(-1e20), -8_388_608);
  assert.strictEqual(clipCoordinate(NaN), 0);
});

// ---------------------------------------------------------------------------------
// simtime <-> tc interpolation
// ---------------------------------------------------------------------------------

function src(tcBegin: number, simulationTime: string): TcSimSource {
  return { tcBegin, simulationTime };
}

test('buildSampleTable sorts ascending by tc', () => {
  const table = buildSampleTable([src(30, '3'), src(10, '1'), src(20, '2')]);
  assert.deepStrictEqual(
    table.map((s) => s.tc),
    [10, 20, 30],
  );
});

test('tcToSimTimeApprox interpolates linearly between two bracketing samples', () => {
  const table = buildSampleTable([src(0, '0'), src(10, '100')]);
  assert.strictEqual(tcToSimTimeApprox(5, table), 50);
  assert.strictEqual(tcToSimTimeApprox(0, table), 0);
  assert.strictEqual(tcToSimTimeApprox(10, table), 100);
});

test('simTimeToTcApprox is the inverse mapping of tcToSimTimeApprox in the affine (SIMULATION_TIME-like) case', () => {
  const table = buildSampleTable([src(0, '0'), src(10, '100'), src(20, '300')]);
  for (const tc of [2, 5, 12, 18]) {
    const simTime = tcToSimTimeApprox(tc, table)!;
    const backToTc = simTimeToTcApprox(simTime, table)!;
    assert.ok(Math.abs(backToTc - tc) < 1e-9, `tc=${tc} simTime=${simTime} backToTc=${backToTc}`);
  }
});

test('duplicate-tc samples: a zero-width bracket falls back to one endpoint, chosen by upperLimit', () => {
  // two events at the exact same tc (e.g. two zero-duration events at the same instant)
  const table = buildSampleTable([src(0, '0'), src(10, '10'), src(10, '20'), src(20, '30')]);
  const lower = tcToSimTimeApprox(10, table, false);
  const upper = tcToSimTimeApprox(10, table, true);
  assert.ok(lower === 10 || lower === 20);
  assert.ok(upper === 10 || upper === 20);
});

test('extrapolation beyond the fetched sample window uses the nearest edge slope', () => {
  const table = buildSampleTable([src(0, '0'), src(10, '100'), src(20, '200')]);
  // slope near the left edge is 10 simtime-units per tc -- extrapolating below 0 should follow it
  assert.strictEqual(tcToSimTimeApprox(-5, table), -50);
  // slope near the right edge is 10 simtime-units per tc -- extrapolating beyond 20 should follow it
  assert.strictEqual(tcToSimTimeApprox(25, table), 250);
});

test('a single-sample table returns a flat (non-extrapolated) value everywhere', () => {
  const table = buildSampleTable([src(5, '50')]);
  assert.strictEqual(tcToSimTimeApprox(0, table), 50);
  assert.strictEqual(tcToSimTimeApprox(100, table), 50);
});

test('an empty sample table returns null, not a crash', () => {
  assert.strictEqual(tcToSimTimeApprox(0, []), null);
  assert.strictEqual(simTimeToTcApprox(0, []), null);
});

test('simTimeToTcApprox handles duplicate simulation times across distinct events (EVENT_NUMBER/STEP/NONLINEAR-like)', () => {
  // three events share simTime=5 but have distinct, increasing tc (event order)
  const table = buildSampleTable([src(0, '0'), src(1, '5'), src(2, '5'), src(3, '5'), src(4, '10')]);
  const lower = simTimeToTcApprox(5, table, false);
  const upper = simTimeToTcApprox(5, table, true);
  assert.ok(lower! <= upper!);
});
