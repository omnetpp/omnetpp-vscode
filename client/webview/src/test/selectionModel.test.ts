import { test } from 'bun:test';
import assert from 'node:assert';
import type { RowRef } from '@omnetpp/shared/elog-protocol';
import { compareRowRef, EMPTY_SELECTION, gotoElement, isSelected, moveFocusTo } from '../eventlog/table/selectionModel';

function ref(eventNumber: number, entryIndex = 0): RowRef {
  return { eventNumber, entryIndex };
}

// ---------------------------------------------------------------------------------
// compareRowRef() -- total order matching on-screen row order
// ---------------------------------------------------------------------------------

test('compareRowRef: orders by eventNumber first, then entryIndex', () => {
  assert.ok(compareRowRef(ref(1, 5), ref(2, 0)) < 0);
  assert.ok(compareRowRef(ref(2, 0), ref(1, 5)) > 0);
  assert.ok(compareRowRef(ref(3, 0), ref(3, 2)) < 0);
  assert.equal(compareRowRef(ref(3, 2), ref(3, 2)), 0);
});

// ---------------------------------------------------------------------------------
// moveFocusTo() -- port of VirtualTable.moveFocusTo()'s branch table (~line 897-942)
// ---------------------------------------------------------------------------------

test('moveFocusTo: plain click (no shift, no ctrl) overwrites selection and anchor to a single element', () => {
  const s0 = moveFocusTo(EMPTY_SELECTION, ref(5), { shift: false, ctrl: false, click: true });
  assert.equal(s0.anchor, s0.focus);
  assert.deepEqual(s0.focus, ref(5));
  assert.ok(isSelected(s0, ref(5)));
  assert.ok(!isSelected(s0, ref(4)));

  // A second plain click elsewhere replaces the selection entirely (no accumulation).
  const s1 = moveFocusTo(s0, ref(9), { shift: false, ctrl: false, click: true });
  assert.ok(!isSelected(s1, ref(5)));
  assert.ok(isSelected(s1, ref(9)));
  assert.deepEqual(s1.anchor, ref(9));
});

test('moveFocusTo: keyboard arrow move (no shift, no ctrl, no click) behaves the same as a click for selection purposes', () => {
  const s0 = moveFocusTo(EMPTY_SELECTION, ref(3), { shift: false, ctrl: false, click: false });
  assert.deepEqual(s0.anchor, ref(3));
  assert.ok(isSelected(s0, ref(3)));
});

test('moveFocusTo: shift-only replaces the selection with the anchor..element range (order-independent)', () => {
  const anchored = moveFocusTo(EMPTY_SELECTION, ref(5), { shift: false, ctrl: false, click: true });
  const extended = moveFocusTo(anchored, ref(10), { shift: true, ctrl: false, click: false });
  for (let n = 5; n <= 10; n++) assert.ok(isSelected(extended, ref(n)), `expected ${n} selected`);
  assert.ok(!isSelected(extended, ref(4)));
  assert.ok(!isSelected(extended, ref(11)));
  assert.deepEqual(extended.anchor, ref(5), 'anchor stays put across a shift-extend');
  assert.deepEqual(extended.focus, ref(10));

  // Shift-selecting backward past the anchor still produces the correct [target, anchor] range.
  const back = moveFocusTo(anchored, ref(2), { shift: true, ctrl: false, click: false });
  for (let n = 2; n <= 5; n++) assert.ok(isSelected(back, ref(n)), `expected ${n} selected`);
  assert.ok(!isSelected(back, ref(6)));
});

test('moveFocusTo: repeated shift-clicks replace (not accumulate) the range, anchored at the same anchor', () => {
  const anchored = moveFocusTo(EMPTY_SELECTION, ref(5), { shift: false, ctrl: false, click: true });
  const first = moveFocusTo(anchored, ref(8), { shift: true, ctrl: false, click: false });
  const second = moveFocusTo(first, ref(6), { shift: true, ctrl: false, click: false });
  assert.ok(!isSelected(second, ref(7)), 'row 7 was in the first shift-range but must not survive the second');
  assert.ok(isSelected(second, ref(6)));
  assert.ok(isSelected(second, ref(5)));
});

test('moveFocusTo: ctrl-only keyboard move (no click) moves focus without touching selection or anchor', () => {
  const anchored = moveFocusTo(EMPTY_SELECTION, ref(5), { shift: false, ctrl: false, click: true });
  const moved = moveFocusTo(anchored, ref(9), { shift: false, ctrl: true, click: false });
  assert.deepEqual(moved.focus, ref(9));
  assert.deepEqual(moved.anchor, ref(5), 'anchor unchanged');
  assert.ok(isSelected(moved, ref(5)), 'original selection preserved');
  assert.ok(!isSelected(moved, ref(9)), 'focus alone does not select');
});

test('moveFocusTo: ctrl+click toggles membership of the clicked element and moves the anchor there', () => {
  const anchored = moveFocusTo(EMPTY_SELECTION, ref(5), { shift: false, ctrl: false, click: true });
  const toggledOn = moveFocusTo(anchored, ref(9), { shift: false, ctrl: true, click: true });
  assert.ok(isSelected(toggledOn, ref(5)), 'original selection kept');
  assert.ok(isSelected(toggledOn, ref(9)), 'newly ctrl-clicked element added');
  assert.deepEqual(toggledOn.anchor, ref(9), 'anchor moves to the ctrl-clicked element');

  // Ctrl+clicking an already-selected element removes just that element.
  const toggledOff = moveFocusTo(toggledOn, ref(9), { shift: false, ctrl: true, click: true });
  assert.ok(!isSelected(toggledOff, ref(9)));
  assert.ok(isSelected(toggledOff, ref(5)), 'other selected rows untouched');
});

test('moveFocusTo: ctrl+click toggle-off on a row inside a shift-selected range only removes that one row (splits the range)', () => {
  const anchored = moveFocusTo(EMPTY_SELECTION, ref(1), { shift: false, ctrl: false, click: true });
  const ranged = moveFocusTo(anchored, ref(10), { shift: true, ctrl: false, click: false });
  const split = moveFocusTo(ranged, ref(5), { shift: false, ctrl: true, click: true });
  assert.ok(!isSelected(split, ref(5)), 'row 5 removed');
  for (const n of [1, 2, 3, 4, 6, 7, 8, 9, 10]) assert.ok(isSelected(split, ref(n)), `row ${n} should remain selected`);
});

test('moveFocusTo: ctrl+shift adds a new range to the existing selection (does not replace it)', () => {
  const anchored = moveFocusTo(EMPTY_SELECTION, ref(1), { shift: false, ctrl: false, click: true });
  const firstRange = moveFocusTo(anchored, ref(3), { shift: true, ctrl: false, click: false });
  // Re-anchor via a plain ctrl+click somewhere else, then ctrl+shift-extend from there --
  // this must ADD a second, disjoint range rather than replacing the first.
  const reAnchored = moveFocusTo(firstRange, ref(8), { shift: false, ctrl: true, click: true });
  const secondRange = moveFocusTo(reAnchored, ref(10), { shift: true, ctrl: true, click: false });
  for (const n of [1, 2, 3]) assert.ok(isSelected(secondRange, n === 0 ? ref(0) : ref(n)), `row ${n} from the first range must survive`);
  for (const n of [8, 9, 10]) assert.ok(isSelected(secondRange, ref(n)), `row ${n} from the second range must be selected`);
  assert.ok(!isSelected(secondRange, ref(5)), 'the gap between the two ranges must not be selected');
});

// ---------------------------------------------------------------------------------
// gotoElement() -- port of doGotoElement() (goto/find results: plain single selection)
// ---------------------------------------------------------------------------------

test('gotoElement: selects exactly the target element, anchor === focus', () => {
  const s = gotoElement(ref(42));
  assert.deepEqual(s.anchor, ref(42));
  assert.deepEqual(s.focus, ref(42));
  assert.ok(isSelected(s, ref(42)));
  assert.equal(s.ranges.length, 1);
});

test('isSelected: EMPTY_SELECTION never reports anything selected', () => {
  assert.ok(!isSelected(EMPTY_SELECTION, ref(0)));
  assert.ok(!isSelected(EMPTY_SELECTION, ref(123)));
});
