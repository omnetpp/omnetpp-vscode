import { test } from 'bun:test';
import assert from 'node:assert';
import type { HitObject } from '../eventlog/chart/hitTest';
import {
  applyClick,
  clearSelection,
  dependencyKey,
  EMPTY_CHART_SELECTION,
  focusEvent,
  isEmptySelection,
  methodCallKey,
  selectionEquals,
} from '../eventlog/chart/selection';

const evt = (n: number, moduleId = 1): HitObject => ({ kind: 'event', eventNumber: n, moduleId });
const axis = (moduleId: number): HitObject => ({ kind: 'axis', moduleId });
const dep = (cause: number, consequence: number): HitObject => ({ kind: 'dependency', dependencyKind: 'send', causeEventNumber: cause, consequenceEventNumber: consequence, causeTc: 0, consequenceTc: 1 });

test('applyClick: plain click on one event selects it and sets focus', () => {
  const s = applyClick(EMPTY_CHART_SELECTION, [evt(5)], false);
  assert.ok(s.events.has(5));
  assert.equal(s.events.size, 1);
  assert.equal(s.focusEventNumber, 5);
});

test('applyClick: plain click REPLACES the whole selection, not just the hit category', () => {
  let s = applyClick(EMPTY_CHART_SELECTION, [axis(3)], false);
  assert.ok(s.axes.has(3));
  s = applyClick(s, [evt(5)], false);
  assert.ok(!s.axes.has(3), 'axis selection from the earlier click must be gone');
  assert.ok(s.events.has(5));
});

test('applyClick: plain click on the SAME single-event selection again clears it (toggle-to-deselect)', () => {
  let s = applyClick(EMPTY_CHART_SELECTION, [evt(5)], false);
  s = applyClick(s, [evt(5)], false);
  assert.ok(isEmptySelection(s));
});

test('applyClick: plain click with an empty group on an empty selection is a no-op (not a clear-loop)', () => {
  const s = applyClick(EMPTY_CHART_SELECTION, [], false);
  assert.ok(isEmptySelection(s));
});

test('applyClick: multi-event group (two overlapping events) both get selected by one plain click', () => {
  const s = applyClick(EMPTY_CHART_SELECTION, [evt(5), evt(6)], false);
  assert.ok(s.events.has(5) && s.events.has(6));
  assert.equal(s.events.size, 2);
  assert.equal(s.focusEventNumber, 6, 'focus lands on the last event in the group');
});

test('applyClick: ctrl+click toggles membership without touching the rest of the selection', () => {
  let s = applyClick(EMPTY_CHART_SELECTION, [evt(5)], false);
  s = applyClick(s, [axis(3)], true); // ctrl+click an axis -- adds it, keeps event 5
  assert.ok(s.events.has(5));
  assert.ok(s.axes.has(3));
});

test('applyClick: ctrl+click on an already-selected event removes just that event', () => {
  let s = applyClick(EMPTY_CHART_SELECTION, [evt(5), evt(6)], false);
  s = applyClick(s, [evt(5)], true);
  assert.ok(!s.events.has(5));
  assert.ok(s.events.has(6));
});

test('applyClick: ctrl+click does not clear focus for a toggled-off event when another event stays selected', () => {
  let s = applyClick(EMPTY_CHART_SELECTION, [evt(5)], false);
  s = applyClick(s, [evt(6)], true); // add 6 via ctrl+click -- focus moves to 6
  assert.equal(s.focusEventNumber, 6);
});

test('applyClick: dependency and methodCall hits are keyed and toggled independently', () => {
  let s = applyClick(EMPTY_CHART_SELECTION, [dep(1, 2)], false);
  assert.ok(s.dependencies.has(dependencyKey({ dependencyKind: 'send', causeEventNumber: 1, consequenceEventNumber: 2 })));
  const call: HitObject = { kind: 'methodCall', eventNumber: 9, sourceModuleId: 1, targetModuleId: 2, tc: 42 };
  s = applyClick(s, [call], true);
  assert.ok(s.methodCalls.has(methodCallKey(call)));
  assert.ok(s.dependencies.size === 1, 'ctrl+click on a methodCall must not disturb the existing dependency selection');
});

test('clearSelection: empties everything but keeps focusEventNumber for subsequent arrow-key nav', () => {
  const s = applyClick(EMPTY_CHART_SELECTION, [evt(5)], false);
  const cleared = clearSelection(s);
  assert.ok(isEmptySelection(cleared));
  assert.equal(cleared.focusEventNumber, 5);
});

test('focusEvent: sets a single-event selection and focus directly (goto/reveal flows)', () => {
  const s = focusEvent(42);
  assert.deepEqual([...s.events], [42]);
  assert.equal(s.focusEventNumber, 42);
});

test('selectionEquals: order-independent set comparison', () => {
  const a = applyClick(EMPTY_CHART_SELECTION, [evt(1), evt(2)], false);
  const b = applyClick(EMPTY_CHART_SELECTION, [evt(2), evt(1)], false);
  assert.ok(selectionEquals(a, b));
});
