import { test } from 'bun:test';
import assert from 'node:assert';
import { calculateAxisHeaders, flattenDrawableAxisHeaders } from '../eventlog/chart/axisHeaders';

function pathsOf(paths: string[]): (moduleId: number) => string {
  return (moduleId: number) => paths[moduleId];
}

// ---------------------------------------------------------------------------------
// Scenario 1: nested merge -- "Net.host[0].app"/"Net.host[0].nic"/"Net.router" ->
// a "Net" header spanning all 3, and a nested "host[0]" header spanning the first 2.
// ---------------------------------------------------------------------------------

test('calculateAxisHeaders: nested contiguous merge produces a "Net" span and a nested "host[0]" span', () => {
  const paths = ['Net.host[0].app', 'Net.host[0].nic', 'Net.router'];
  const root = calculateAxisHeaders([0, 1, 2], pathsOf(paths));
  assert.ok(root);
  const drawable = flattenDrawableAxisHeaders(root);
  assert.strictEqual(drawable.length, 2);

  const netHeader = drawable.find((h) => h.label === 'Net')!;
  assert.ok(netHeader);
  assert.strictEqual(netHeader.level, 0);
  assert.strictEqual(netHeader.axisIndexStart, 0);
  assert.strictEqual(netHeader.axisCount, 3);

  const hostHeader = drawable.find((h) => h.label === 'host[0]')!;
  assert.ok(hostHeader);
  assert.strictEqual(hostHeader.level, 1);
  assert.strictEqual(hostHeader.axisIndexStart, 0);
  assert.strictEqual(hostHeader.axisCount, 2);
});

// ---------------------------------------------------------------------------------
// Scenario 2: non-contiguous axes of ONE compound module never merge with each other
// (only adjacent axes merge) -- "Net.host[0]", "Net.other", "Net.host[1]".
// ---------------------------------------------------------------------------------

test('calculateAxisHeaders: non-contiguous axes of the same compound module do NOT merge with each other', () => {
  const paths = ['Net.host[0]', 'Net.other', 'Net.host[1]'];
  const root = calculateAxisHeaders([0, 1, 2], pathsOf(paths));
  const drawable = flattenDrawableAxisHeaders(root);
  // Only the top-level "Net" span (all 3 axes share that first component) -- no
  // separate header groups either "host[0]" or "host[1]" (each is a lone leaf, and
  // they are not adjacent so mergeSiblings never accumulates them into one run).
  assert.strictEqual(drawable.length, 1);
  assert.strictEqual(drawable[0].label, 'Net');
  assert.strictEqual(drawable[0].axisIndexStart, 0);
  assert.strictEqual(drawable[0].axisCount, 3);
});

// ---------------------------------------------------------------------------------
// Scenario 3: a single axis never gets a drawn header (Java: children.length===0 for
// a lone unmerged leaf, even after the root collapses onto it via mergeDescendants).
// ---------------------------------------------------------------------------------

test('calculateAxisHeaders: a single axis produces no drawable header at all', () => {
  const root = calculateAxisHeaders([0], pathsOf(['Net.host']));
  assert.ok(root);
  assert.strictEqual(root.label, 'Net.host', 'the root collapses onto the lone leaf, absorbing its full path');
  assert.strictEqual(root.children.length, 0);
  assert.deepEqual(flattenDrawableAxisHeaders(root), []);
});

test('calculateAxisHeaders: empty axis list -> null', () => {
  assert.strictEqual(calculateAxisHeaders([], pathsOf([])), null);
});

test('calculateAxisHeaders: completely unrelated top-level names still merge into one root span (every OMNeT++ module tree shares a single top network ancestor in practice, but the algorithm itself does not require it -- any shared first component merges)', () => {
  // Here "A"/"B"/"C" (no dots, no shared prefix at all) each form their OWN
  // singleton run -- so the synthetic root ends up with 3 children and (since 3 != 1)
  // does NOT collapse; it is itself drawable (empty label) spanning all 3, per Java's
  // own `drawAxisHeaders` filter (children.size() != 0 -- it doesn't special-case an
  // empty label). Documented rather than special-cased away, since real module trees
  // never hit this (OMNeT++ requires a single top-level network module).
  const root = calculateAxisHeaders([0, 1, 2], pathsOf(['A', 'B', 'C']));
  const drawable = flattenDrawableAxisHeaders(root);
  assert.strictEqual(drawable.length, 1);
  assert.strictEqual(drawable[0].label, '');
  assert.strictEqual(drawable[0].axisCount, 3);
});
