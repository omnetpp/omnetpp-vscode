import { test } from 'bun:test';
import assert from 'node:assert';
import type { ArrowRef, DrawPrimitive } from '../eventlog/chart/drawList';
import {
  EVENT_HIT_TOLERANCE,
  eventSymbolContainsPoint,
  HIT_TOLERANCE,
  halfEllipseContainsPoint,
  hitTest,
  lineContainsPoint,
  pickDoubleClickTarget,
  pickPrimary,
  pickPrimaryGroup,
} from '../eventlog/chart/hitTest';

// ---------------------------------------------------------------------------------
// lineContainsPoint -- squared-perpendicular-distance test + bbox pre-check
// ---------------------------------------------------------------------------------

test('lineContainsPoint: exact hit on a diagonal segment', () => {
  assert.ok(lineContainsPoint(0, 0, 10, 10, 5, 5));
});

test('lineContainsPoint: within tolerance of a diagonal segment', () => {
  assert.ok(lineContainsPoint(0, 0, 10, 10, 5, 5 + HIT_TOLERANCE - 1));
});

test('lineContainsPoint: outside tolerance of a diagonal segment', () => {
  assert.ok(!lineContainsPoint(0, 0, 10, 10, 5, 5 + HIT_TOLERANCE + 5));
});

test('lineContainsPoint: horizontal segment -- bbox governs entirely (y1===y2 keeps result=0)', () => {
  assert.ok(lineContainsPoint(0, 10, 20, 10, 10, 10 + HIT_TOLERANCE));
  assert.ok(!lineContainsPoint(0, 10, 20, 10, 10, 10 + HIT_TOLERANCE + 1));
  // outside the x-span entirely, even within y-tolerance
  assert.ok(!lineContainsPoint(0, 10, 20, 10, -HIT_TOLERANCE - 1, 10));
});

test('lineContainsPoint: vertical segment -- bbox governs entirely (x1===x2 keeps result=0)', () => {
  assert.ok(lineContainsPoint(10, 0, 10, 20, 10 + HIT_TOLERANCE, 10));
  assert.ok(!lineContainsPoint(10, 0, 10, 20, 10 + HIT_TOLERANCE + 1, 10));
});

test('lineContainsPoint: point far beyond the segment endpoints (perpendicular to the infinite line only) rejected by bbox', () => {
  // On the infinite line through (0,0)-(10,10) extended, but way outside the segment's own bbox.
  assert.ok(!lineContainsPoint(0, 0, 10, 10, 1000, 1000));
});

// ---------------------------------------------------------------------------------
// eventSymbolContainsPoint -- axis-aligned box, wider tolerance
// ---------------------------------------------------------------------------------

test('eventSymbolContainsPoint: hit at the exact mark position', () => {
  assert.ok(eventSymbolContainsPoint(100, 50, 100, 100, 50));
});

test('eventSymbolContainsPoint: hit within the wider EVENT_HIT_TOLERANCE', () => {
  assert.ok(eventSymbolContainsPoint(100 + EVENT_HIT_TOLERANCE, 50, 100, 100, 50));
  assert.ok(eventSymbolContainsPoint(100, 50 + EVENT_HIT_TOLERANCE, 100, 100, 50));
});

test('eventSymbolContainsPoint: miss just beyond tolerance', () => {
  assert.ok(!eventSymbolContainsPoint(100 + EVENT_HIT_TOLERANCE + 1, 50, 100, 100, 50));
  assert.ok(!eventSymbolContainsPoint(100, 50 + EVENT_HIT_TOLERANCE + 1, 100, 100, 50));
});

// ---------------------------------------------------------------------------------
// halfEllipseContainsPoint -- ported for U5, ring test (not filled)
// ---------------------------------------------------------------------------------

test('halfEllipseContainsPoint: point on the ellipse ring is contained', () => {
  // full ellipse (quarter=-1) centered at x=50 (x1=0,x2=100), ry=height=20; top-center point is on the ring.
  assert.ok(halfEllipseContainsPoint(-1, 0, 100, 100, 20, 50, 100 - 20));
});

test('halfEllipseContainsPoint: point at the ellipse center is NOT contained (ring test, not filled)', () => {
  assert.ok(!halfEllipseContainsPoint(-1, 0, 100, 100, 20, 50, 100));
});

test('halfEllipseContainsPoint: point far outside the bounding box rejected up front', () => {
  assert.ok(!halfEllipseContainsPoint(-1, 0, 100, 100, 20, 5000, 5000));
});

// ---------------------------------------------------------------------------------
// hitTest() -- scanning a synthetic draw list
// ---------------------------------------------------------------------------------

const depRef = (over: Partial<Extract<ArrowRef, { kind: 'dependency' }>> = {}): ArrowRef => ({
  kind: 'dependency',
  dependencyKind: 'send',
  causeEventNumber: 1,
  consequenceEventNumber: 2,
  causeTc: 10,
  consequenceTc: 20,
  ...over,
});

test('hitTest: event mark hit at its exact position', () => {
  const primitives: DrawPrimitive[] = [{ kind: 'eventMark', eventNumber: 7, moduleId: 3, x: 100, y: 50, radius: 3, color: '#000' }];
  const hits = hitTest({ primitives, px: 100, py: 50, pointerTc: null });
  assert.deepEqual(hits, [{ kind: 'event', eventNumber: 7, moduleId: 3 }]);
});

test('hitTest: event mark miss outside tolerance', () => {
  const primitives: DrawPrimitive[] = [{ kind: 'eventMark', eventNumber: 7, moduleId: 3, x: 100, y: 50, radius: 3, color: '#000' }];
  const hits = hitTest({ primitives, px: 100 + EVENT_HIT_TOLERANCE + 10, py: 50, pointerTc: null });
  assert.equal(hits.length, 0);
});

test('hitTest: arrow (message dependency) hit reports the dependency ref', () => {
  const ref = depRef();
  const primitives: DrawPrimitive[] = [{ kind: 'arrow', arrowKind: 'send', x1: 0, y1: 0, x2: 100, y2: 0, color: '#000', ref }];
  const hits = hitTest({ primitives, px: 50, py: 0, pointerTc: null });
  assert.deepEqual(hits, [{ kind: 'dependency', dependencyKind: 'send', causeEventNumber: 1, consequenceEventNumber: 2, causeTc: 10, consequenceTc: 20 }]);
});

test('hitTest: arrow without a ref (defensive -- should not happen in practice) is never hit-testable', () => {
  const primitives: DrawPrimitive[] = [{ kind: 'arrow', arrowKind: 'send', x1: 0, y1: 0, x2: 100, y2: 0, color: '#000' }];
  const hits = hitTest({ primitives, px: 50, py: 0, pointerTc: null });
  assert.equal(hits.length, 0);
});

test('hitTest: method-call arrow hit reports a methodCall hit', () => {
  const ref: ArrowRef = { kind: 'methodCall', eventNumber: 9, sourceModuleId: 1, targetModuleId: 2, tc: 42 };
  const primitives: DrawPrimitive[] = [{ kind: 'arrow', arrowKind: 'method', x1: 30, y1: 0, x2: 30, y2: 50, color: '#000', ref }];
  const hits = hitTest({ primitives, px: 30, py: 25, pointerTc: null });
  assert.deepEqual(hits, [{ kind: 'methodCall', eventNumber: 9, sourceModuleId: 1, targetModuleId: 2, tc: 42 }]);
});

// ---------------------------------------------------------------------------------
// ellipseArc (phase U5 -- self-message half/quarter ellipse, replaces the pre-U5
// "hairpin" placeholder) -- real halfEllipseContainsPoint hits.
// ---------------------------------------------------------------------------------

test('hitTest: ellipseArc hit on the ring (full half ellipse, quarter=-1)', () => {
  const ref = depRef({ causeEventNumber: 5, consequenceEventNumber: 5 });
  const primitives: DrawPrimitive[] = [{ kind: 'ellipseArc', x1: 0, x2: 100, y: 100, height: 20, quarter: -1, color: '#000', ref }];
  // top-center of the ellipse ring
  const hits = hitTest({ primitives, px: 50, py: 80, pointerTc: null });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'dependency');
});

test('hitTest: ellipseArc miss at the ellipse center (ring test, not filled)', () => {
  const ref = depRef();
  const primitives: DrawPrimitive[] = [{ kind: 'ellipseArc', x1: 0, x2: 100, y: 100, height: 20, quarter: -1, color: '#000', ref }];
  const hits = hitTest({ primitives, px: 50, py: 100, pointerTc: null });
  assert.equal(hits.length, 0);
});

test('hitTest: ellipseArc with no ref is never hit-testable (defensive)', () => {
  const primitives: DrawPrimitive[] = [{ kind: 'ellipseArc', x1: 0, x2: 100, y: 100, height: 20, quarter: -1, color: '#000' }];
  const hits = hitTest({ primitives, px: 50, py: 80, pointerTc: null });
  assert.equal(hits.length, 0);
});

// ---------------------------------------------------------------------------------
// Split (offscreen-endpoint) arrows -- rendered as ordinary 'arrow' primitives sharing
// the same ref, so hit-testing needs no separate code path (see hitTest.ts's header).
// ---------------------------------------------------------------------------------

test('hitTest: split arrow -- a hit on EITHER segment (dashed offscreen tail or solid real portion) resolves to the same dependency, collapsed to one hit', () => {
  const ref = depRef({ causeEventNumber: 4, consequenceEventNumber: 5 });
  const primitives: DrawPrimitive[] = [
    { kind: 'arrow', arrowKind: 'send', x1: 0, y1: 0, x2: 50, y2: 0, color: '#000', dash: [1, 2], ref },
    { kind: 'arrow', arrowKind: 'send', x1: 50, y1: 0, x2: 100, y2: 0, color: '#000', ref },
  ];
  const onDashed = hitTest({ primitives, px: 20, py: 0, pointerTc: null });
  const onSolid = hitTest({ primitives, px: 80, py: 0, pointerTc: null });
  assert.equal(onDashed.length, 1);
  assert.equal(onSolid.length, 1);
  assert.deepEqual(onDashed[0], onSolid[0]);
});

test('hitTest: axis line hit within its band', () => {
  const primitives: DrawPrimitive[] = [{ kind: 'axisLine', moduleId: 4, x1: 0, x2: 500, y: 60, lineHeight: 3, color: '#000' }];
  const hits = hitTest({ primitives, px: 250, py: 61, pointerTc: null });
  assert.deepEqual(hits, [{ kind: 'axis', moduleId: 4 }]);
});

test('hitTest: axis label hit (pinned column, independent of axis line x-span)', () => {
  const primitives: DrawPrimitive[] = [{ kind: 'axisLabel', moduleId: 4, x: 4, y: 60, text: 'Net.host', color: '#000' }];
  const hits = hitTest({ primitives, px: 4, py: 60, pointerTc: null });
  assert.deepEqual(hits, [{ kind: 'axis', moduleId: 4 }]);
});

test('hitTest: timestamp fallback included only when pointerTc is provided', () => {
  const withTc = hitTest({ primitives: [], px: 10, py: 10, pointerTc: 123 });
  assert.deepEqual(withTc, [{ kind: 'timestamp', tc: 123 }]);
  const withoutTc = hitTest({ primitives: [], px: 10, py: 10, pointerTc: null });
  assert.equal(withoutTc.length, 0);
});

test('hitTest: duplicate hits on the same object (e.g. an arrow drawn as two primitives sharing a ref) collapse to one', () => {
  const ref = depRef();
  const primitives: DrawPrimitive[] = [
    { kind: 'arrow', arrowKind: 'send', x1: 0, y1: 0, x2: 100, y2: 0, color: '#000', ref },
    { kind: 'arrow', arrowKind: 'send', x1: 0, y1: 0, x2: 100, y2: 0, color: '#000', ref },
  ];
  const hits = hitTest({ primitives, px: 50, py: 0, pointerTc: null });
  assert.equal(hits.length, 1);
});

test('hitTest: overlapping event + axis + timestamp -- priority order picks the event', () => {
  const primitives: DrawPrimitive[] = [
    { kind: 'eventMark', eventNumber: 1, moduleId: 1, x: 50, y: 50, radius: 3, color: '#000' },
    { kind: 'axisLine', moduleId: 1, x1: 0, x2: 500, y: 50, lineHeight: 1, color: '#000' },
  ];
  const hits = hitTest({ primitives, px: 50, py: 50, pointerTc: 999 });
  assert.equal(hits.length, 3); // event, axis, timestamp all technically hit
  assert.deepEqual(pickPrimary(hits), { kind: 'event', eventNumber: 1, moduleId: 1 });
});

// ---------------------------------------------------------------------------------
// pickPrimary / pickPrimaryGroup -- the full priority cascade (verified against
// SequenceChart.java's mouseUp: event > dependency > methodCall > axis > timestamp)
// ---------------------------------------------------------------------------------

test('pickPrimary: dependency beats methodCall/axis/timestamp when no event is present', () => {
  const hits = [{ kind: 'axis', moduleId: 1 } as const, { kind: 'dependency', dependencyKind: 'send', causeEventNumber: 1, consequenceEventNumber: 2, causeTc: 0, consequenceTc: 1 } as const, { kind: 'timestamp', tc: 5 } as const];
  assert.equal(pickPrimary(hits)?.kind, 'dependency');
});

test('pickPrimaryGroup: returns ALL hits of the top-priority kind (two overlapping events)', () => {
  const hits = [
    { kind: 'event', eventNumber: 1, moduleId: 1 } as const,
    { kind: 'event', eventNumber: 2, moduleId: 2 } as const,
    { kind: 'axis', moduleId: 1 } as const,
  ];
  const group = pickPrimaryGroup(hits);
  assert.equal(group.length, 2);
  assert.ok(group.every((h) => h.kind === 'event'));
});

test('pickPrimaryGroup: empty input yields an empty group', () => {
  assert.deepEqual(pickPrimaryGroup([]), []);
});

// ---------------------------------------------------------------------------------
// pickDoubleClickTarget -- shorter, DIFFERENT-order cascade (dependency, then axis)
// ---------------------------------------------------------------------------------

test('pickDoubleClickTarget: dependency wins over axis even if axis appears first in the array', () => {
  const hits = [
    { kind: 'axis', moduleId: 1 } as const,
    { kind: 'dependency', dependencyKind: 'send', causeEventNumber: 1, consequenceEventNumber: 2, causeTc: 0, consequenceTc: 1 } as const,
  ];
  assert.equal(pickDoubleClickTarget(hits)?.kind, 'dependency');
});

test('pickDoubleClickTarget: falls back to axis when no dependency is hit', () => {
  const hits = [{ kind: 'axis', moduleId: 1 } as const];
  assert.equal(pickDoubleClickTarget(hits)?.kind, 'axis');
});

test('pickDoubleClickTarget: event/methodCall hits are not double-click targets (no Java-side action)', () => {
  const hits = [{ kind: 'event', eventNumber: 1, moduleId: 1 } as const, { kind: 'methodCall', eventNumber: 1, sourceModuleId: 1, targetModuleId: 2, tc: 5 } as const];
  assert.equal(pickDoubleClickTarget(hits), undefined);
});
