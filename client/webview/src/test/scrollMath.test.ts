import { test } from 'bun:test';
import assert from 'node:assert';
import {
  approximateDelta,
  computeScrollbarGeometry,
  computeScrollbarPercentage,
  percentageToScrollbarSelection,
  scrollbarSelectionToPercentage,
} from '../eventlog/table/scrollMath';

// ---------------------------------------------------------------------------------
// computeScrollbarGeometry() -- port of VirtualTable.configureVerticalScrollBar()
// ---------------------------------------------------------------------------------

test('computeScrollbarGeometry: max is capped at 1e6, thumb scales with the visible/total ratio', () => {
  assert.deepEqual(computeScrollbarGeometry(1000, 20), { max: 1000, thumb: 20 });
  assert.deepEqual(computeScrollbarGeometry(2_000_000, 20), { max: 1_000_000, thumb: 10 }); // thumb = 1e6*20/2e6 = 10
  assert.deepEqual(computeScrollbarGeometry(100, 100), { max: 100, thumb: 100 }); // whole log fits on screen
});

test('computeScrollbarGeometry: empty/unknown table returns {max:0, thumb:0} (Java\'s "no contentProvider" branch)', () => {
  assert.deepEqual(computeScrollbarGeometry(0, 20), { max: 0, thumb: 0 });
  assert.deepEqual(computeScrollbarGeometry(-1, 20), { max: 0, thumb: 0 });
});

// ---------------------------------------------------------------------------------
// computeScrollbarPercentage() -- port of updateVerticalBarPosition()'s weighted blend
// ---------------------------------------------------------------------------------

test('computeScrollbarPercentage: p->0 extreme (top row is the very first entry) returns exactly 0 (topWeight infinite)', () => {
  assert.equal(computeScrollbarPercentage(0, 0.5), 0);
});

test('computeScrollbarPercentage: p->1 extreme (bottom row is the very last entry) returns exactly 1 (bottomWeight infinite)', () => {
  assert.equal(computeScrollbarPercentage(0.5, 1), 1);
});

test('computeScrollbarPercentage: both extremes at once (whole log fits on screen) -- topWeight wins per Java\'s branch order', () => {
  // Java checks `Double.isInfinite(topWeight)` first, so when both topPercentage===0
  // and bottomPercentage===1 (both weights infinite), the result is topPercentage (0),
  // not bottomPercentage (1) -- ported verbatim, not "fixed" to average them.
  assert.equal(computeScrollbarPercentage(0, 1), 0);
});

test('computeScrollbarPercentage: symmetric middle window blends to the arithmetic mean when weights are equal', () => {
  // topPercentage=0.4, bottomPercentage=0.6: topWeight=1/0.4=2.5, bottomWeight=1/0.4=2.5
  // (equal weights) -> plain average of 0.4 and 0.6.
  const pct = computeScrollbarPercentage(0.4, 0.6);
  assert.ok(Math.abs(pct - 0.5) < 1e-12, `expected ~0.5, got ${pct}`);
});

test('computeScrollbarPercentage: hand-computed asymmetric case matches the weighted-blend formula exactly', () => {
  // topPercentage=0.1 (topWeight=10), bottomPercentage=0.8 (bottomWeight=1/0.2=5)
  // percentage = (0.1*10 + 0.8*5) / (10+5) = (1 + 4) / 15 = 1/3
  const pct = computeScrollbarPercentage(0.1, 0.8);
  assert.ok(Math.abs(pct - 1 / 3) < 1e-12, `expected ${1 / 3}, got ${pct}`);
});

test('computeScrollbarPercentage: near-start window (small but nonzero top percentage) stays close to 0, not exactly 0', () => {
  const pct = computeScrollbarPercentage(0.001, 0.05);
  assert.ok(pct > 0 && pct < 0.01, `expected a small positive percentage, got ${pct}`);
});

// ---------------------------------------------------------------------------------
// percentageToScrollbarSelection() / scrollbarSelectionToPercentage() -- round trip
// ---------------------------------------------------------------------------------

test('percentageToScrollbarSelection: matches Java\'s (int)((max-thumb)*percentage) formula', () => {
  const geometry = { max: 1000, thumb: 20 };
  assert.equal(percentageToScrollbarSelection(0, geometry), 0);
  assert.equal(percentageToScrollbarSelection(1, geometry), 980);
  assert.equal(percentageToScrollbarSelection(0.5, geometry), 490);
});

test('percentageToScrollbarSelection/scrollbarSelectionToPercentage: round trip within rounding tolerance', () => {
  const geometry = { max: 100_000, thumb: 50 };
  for (const pct of [0, 0.1, 0.33, 0.5, 0.75, 1]) {
    const selection = percentageToScrollbarSelection(pct, geometry);
    const back = scrollbarSelectionToPercentage(selection, geometry);
    assert.ok(Math.abs(back - pct) < 1e-3, `pct=${pct} round-tripped to ${back}`);
  }
});

test('scrollbarSelectionToPercentage: max===thumb (whole log fits on screen) returns 0 rather than dividing by zero', () => {
  assert.equal(scrollbarSelectionToPercentage(0, { max: 50, thumb: 50 }), 0);
});

test('scrollbarSelectionToPercentage: clamps out-of-range selections into [0,1]', () => {
  const geometry = { max: 1000, thumb: 20 };
  assert.equal(scrollbarSelectionToPercentage(-10, geometry), 0);
  assert.equal(scrollbarSelectionToPercentage(100_000, geometry), 1);
});

// ---------------------------------------------------------------------------------
// approximateDelta() -- port of EventLogEntryReferenceEnumerator.getApproximateDelta()'s
// percentage-based fallback (used for entries known to be > ~100 apart).
// ---------------------------------------------------------------------------------

test('approximateDelta: proportional estimate from percentages and total count', () => {
  // 1000 total entries, moving from 10% to 60% of the log ~= 500 entries forward.
  assert.equal(approximateDelta(1000, 0.1, 0.6), 500);
});

test('approximateDelta: truncates toward zero like Java\'s (int) cast, not Math.floor', () => {
  // 1000 * (0.1234 - 0.1) = 23.4 -> truncates to 23, not 24.
  assert.equal(approximateDelta(1000, 0.1, 0.1234), 23);
});

test('approximateDelta: zero distance for identical percentages', () => {
  assert.equal(approximateDelta(1000, 0.5, 0.5), 0);
});
