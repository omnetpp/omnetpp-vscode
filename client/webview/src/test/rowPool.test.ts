import { test } from 'bun:test';
import assert from 'node:assert';
import { computeTopIndex } from '../eventlog/table/rowPool';

// computeTopIndex() -- the pure windowing-clamp part of tableView.ts's fix-point model
// (see rowPool.ts's header: a port of VirtualTable.relocateFixPoint()'s "always keep
// the first/last visible row displaying an element" invariant).

test('computeTopIndex: plenty of margin on both sides -- anchor lands exactly at the requested distance', () => {
  // anchorIndex=50 (out of 200 fetched rows), want it displayed at screen row 5, so
  // screen row 0 should show fetched-array index 45.
  assert.equal(computeTopIndex(50, 5, 200, 20, true, true), 45);
});

test('computeTopIndex: clamps to 0 when there is nothing more before and the request would go negative', () => {
  // anchorIndex=2, desiredDistance=10 -> would want topIndex=-8, but hasMoreBefore=false
  // means index 0 in the fetched array really is the first entry in the whole log.
  assert.equal(computeTopIndex(2, 10, 50, 20, false, true), 0);
});

test('computeTopIndex: clamps so the last fetched row lands on the last screen row when nothing more follows', () => {
  // 30 rows fetched, viewport shows 20, anchor near the end with hasMoreAfter=false --
  // topIndex must not exceed rowsLength - viewportRowCount (10) even if the naive
  // anchorIndex-desiredDistance would ask for more.
  assert.equal(computeTopIndex(29, 0, 30, 20, true, false), 10);
});

test('computeTopIndex: both edges constrained at once (whole log fits within one fetched window)', () => {
  // 15 rows total, viewport 20 rows (log shorter than the viewport) -- topIndex must be 0.
  assert.equal(computeTopIndex(7, 7, 15, 20, false, false), 0);
});

test('computeTopIndex: result is always within [0, rowsLength-1] even for a degenerate 1-row window', () => {
  assert.equal(computeTopIndex(0, 0, 1, 20, false, false), 0);
});

test('computeTopIndex: hasMoreBefore=true still allows a negative-leaning request as long as it stays within the fetched array bounds', () => {
  // anchorIndex=50, desiredDistance=60 -> naive topIndex=-10, but hasMoreBefore=true
  // means the caller should have over-fetched further -- computeTopIndex still clamps
  // the *returned* index into [0, rowsLength-1] defensively (never returns a negative
  // index into the actual array, even though the ideal fix point could not be honored).
  const result = computeTopIndex(50, 60, 200, 20, true, true);
  assert.ok(result >= 0 && result < 200);
});
