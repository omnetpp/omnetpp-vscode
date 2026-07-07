import { test } from 'bun:test';
import assert from 'node:assert';
import {
  applyOrdering,
  calculateManualOrdering,
  calculateOrderingByMinimizingCost,
  calculateOrderingByModuleId,
  calculateOrderingByModuleName,
  currentManualOrder,
  dictionaryCompare,
  ensureInManualOrder,
  updateManualOrder,
} from '../eventlog/chart/axisOrder';

// ---------------------------------------------------------------------------------
// dictionaryCompare (opp_strdictcmp port)
// ---------------------------------------------------------------------------------

test('dictionaryCompare: embedded digit runs compare numerically (mod2 < mod10)', () => {
  assert.ok(dictionaryCompare('mod2', 'mod10') < 0);
  assert.ok(dictionaryCompare('mod10', 'mod2') > 0);
  assert.ok(dictionaryCompare('net.host[9].app', 'net.host[10].app') < 0);
});

test('dictionaryCompare: case-insensitive first, lowercase-in-first-string wins ties', () => {
  assert.equal(dictionaryCompare('abc', 'abc'), 0);
  assert.ok(dictionaryCompare('abc', 'ABD') < 0); // c < d case-insensitively
  // equal case-insensitively -> tiebreak by the FIRST case-differing alpha pair:
  // opp_strdictcmp returns isupper(c2) ? -1 : 1 -- s2 uppercase means s1 (lowercase) first
  assert.ok(dictionaryCompare('abc', 'aBc') < 0);
  assert.ok(dictionaryCompare('aBc', 'abc') > 0);
});

test('dictionaryCompare: prefixes sort first; equal-value different-length digit runs tiebreak char-wise', () => {
  assert.ok(dictionaryCompare('mod', 'mod1') < 0);
  assert.ok(dictionaryCompare('mod1', 'mod') > 0);
  // same numeric value 7 -- opp_strdictcmp tiebreaks by strncasecmp over the run TEXT
  // ('0' < '7'), so the zero-padded form sorts FIRST (verified against the C source)
  assert.ok(dictionaryCompare('a007b', 'a7b') < 0);
  assert.ok(dictionaryCompare('a7b', 'a007b') > 0);
  // equal text prefix, different run length ('12' vs '123' at value inequality is the
  // numeric case; '12' vs '012' exercises the equal-value shorter-run branch)
  assert.ok(dictionaryCompare('a12b', 'a012b') > 0);
});

// ---------------------------------------------------------------------------------
// module id / module name orderings (positions-array contract)
// ---------------------------------------------------------------------------------

test('calculateOrderingByModuleId: positions after a stable sort by id', () => {
  // ids [30, 10, 20] -> sorted order [10, 20, 30] -> positions: 30->2, 10->0, 20->1
  assert.deepEqual(calculateOrderingByModuleId([30, 10, 20]), [2, 0, 1]);
  assert.deepEqual(applyOrdering([30, 10, 20], [2, 0, 1]), [10, 20, 30]);
});

test('calculateOrderingByModuleName: dictionary order over full paths', () => {
  const paths = ['net.host[10]', 'net.gen', 'net.host[2]'];
  const positions = calculateOrderingByModuleName(paths);
  assert.deepEqual(applyOrdering(paths, positions), ['net.gen', 'net.host[2]', 'net.host[10]']);
});

// ---------------------------------------------------------------------------------
// minimize crossings -- FlatAxisOrderByMinimizingCost's exact bubble sort
// ---------------------------------------------------------------------------------

/** Row-major helper: w[cause][consequence] weights for `n` axes. */
function matrixOf(n: number, entries: [number, number, number][]): number[] {
  const m = new Array<number>(n * n).fill(0);
  for (const [i, j, w] of entries) m[n * i + j] = w;
  return m;
}

test('minimize crossings: pulls the heavy pair adjacent -- hand-traced 4-axis case', () => {
  // Axes 0..3 in input order. Only A0->A3 talk (weight 10), plus a light A1->A2 (weight 1).
  //
  // cost(p) = sum_{i!=p} (w[p][i]+w[i][p]) * ((p-i)^2 - 1); distance 1 costs 0.
  //
  // Hand trace of the exact Java sweep (i ascending, j from i+1 ascending; a swap is
  // kept iff cost(i)+cost(j) got STRICTLY smaller; matrix rows+columns swap along):
  //  pass 1:
  //   (0,1): before cost(0)+cost(1) = 80+0 (A0-A3 at distance 3: 10*8). Swap ->
  //          [A1,A0,A2,A3]: cost(0)=3 (A1-A2 d2), cost(1)=30 (A0-A3 d2); 33<80 KEEP.
  //   (0,2): [A2,A0,A1,A3] would leave 3+3 = before 3+3 -- not strictly less, revert.
  //   (0,3): before cost(0)+cost(3) = 3+30. Swap -> [A3,A0,A2,A1]: cost(0)=0 (A3-A0
  //          d1), cost(3)=0 (A1-A2 d1); 0<33 KEEP.
  //   (1,2),(1,3),(2,3): every candidate breaks an adjacent pair -- all revert.
  //  pass 2: no strict improvement anywhere (the (0,1)/(2,3) re-swaps are cost-equal,
  //          strict < rejects them) -> converged: [A3, A0, A2, A1].
  const matrix = matrixOf(4, [
    [0, 3, 10],
    [1, 2, 1],
  ]);
  const positions = calculateOrderingByMinimizingCost(matrix, 4);
  // positions[i] = new position of input axis i: A0->1, A1->3, A2->2, A3->0
  assert.deepEqual(positions, [1, 3, 2, 0]);
  assert.deepEqual(applyOrdering(['A0', 'A1', 'A2', 'A3'], positions), ['A3', 'A0', 'A2', 'A1']);
  // and the heavy pair really is adjacent
  const ordered = applyOrdering([0, 1, 2, 3], positions);
  assert.equal(Math.abs(ordered.indexOf(0) - ordered.indexOf(3)), 1);
  assert.equal(Math.abs(ordered.indexOf(1) - ordered.indexOf(2)), 1);
});

test('minimize crossings: equal cost never swaps (strict < like Java), so a symmetric matrix keeps input order', () => {
  // every pair communicates equally -- all candidate swaps are cost-neutral
  const n = 4;
  const entries: [number, number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) entries.push([i, j, 5]);
  const positions = calculateOrderingByMinimizingCost(matrixOf(n, entries), n);
  assert.deepEqual(positions, [0, 1, 2, 3]);
});

test('minimize crossings: zero matrix / empty input are no-ops', () => {
  assert.deepEqual(calculateOrderingByMinimizingCost(matrixOf(3, []), 3), [0, 1, 2]);
  assert.deepEqual(calculateOrderingByMinimizingCost([], 0), []);
});

test('minimize crossings: the wall-clock budget stops iteration (injectable clock)', () => {
  // a clock that expires immediately -> the while loop body never runs -> input order
  let t = 0;
  const now = () => (t += 2000);
  const matrix = matrixOf(4, [[0, 3, 10]]);
  assert.deepEqual(calculateOrderingByMinimizingCost(matrix, 4, 1000, now), [0, 1, 2, 3]);
});

// ---------------------------------------------------------------------------------
// manual order (ManualAxisOrder port, path-keyed)
// ---------------------------------------------------------------------------------

test('manual order: unknown modules append at the end in input order', () => {
  const last = ensureInManualOrder(['a', 'b'], ['c', 'a', 'd']);
  assert.deepEqual(last, ['a', 'b', 'c', 'd']);
});

test('manual order: currentManualOrder stable-filters the total order to the selection', () => {
  assert.deepEqual(currentManualOrder(['a', 'b', 'c', 'd'], ['d', 'b']), ['b', 'd']);
});

test('manual order: calculateManualOrdering positions per the remembered order', () => {
  const last = ['x', 'a', 'y', 'b'];
  // selection [b, a]: currentManualOrder = [a, b] -> positions: b->1, a->0
  assert.deepEqual(calculateManualOrdering(last, ['b', 'a']), [1, 0]);
  assert.deepEqual(applyOrdering(['b', 'a'], [1, 0]), ['a', 'b']);
});

test('manual order: unknown-module fallback keeps relative input order at the end', () => {
  // 'z' is (defensively) not in the remembered order at all
  const positions = calculateManualOrdering(['a', 'b'], ['z', 'b', 'a']);
  assert.deepEqual(applyOrdering(['z', 'b', 'a'], positions), ['a', 'b', 'z']);
});

test('manual order: updateManualOrder splices the reordered visible subset back, fixed slots preserved', () => {
  // total order [a, b, c, d, e]; visible subset (in current order) [b, d]; user
  // reverses it to [d, b] -> d takes b's old slot, b takes d's -> [a, d, c, b, e]
  const updated = updateManualOrder(['a', 'b', 'c', 'd', 'e'], ['b', 'd'], ['d', 'b']);
  assert.deepEqual(updated, ['a', 'd', 'c', 'b', 'e']);
});

test('manual order: updateManualOrder with an unchanged dialog order is the identity', () => {
  assert.deepEqual(updateManualOrder(['a', 'b', 'c'], ['a', 'c'], ['a', 'c']), ['a', 'b', 'c']);
});
