import { test } from 'bun:test';
import assert from 'node:assert';
import {
  adjustEndpointsForEventRadius,
  buildFilteredSignSegments,
  computeArrowhead,
  computeLineArrowGeometry,
  computeSelfArrowGeometry,
  computeTransmissionParallelogram,
  lineArrowGeometryContainsPoint,
  selfArrowGeometryContainsPoint,
  selfMessageEllipseHeight,
} from '../eventlog/chart/arrowGeometry';

// ---------------------------------------------------------------------------------
// selfMessageEllipseHeight -- SequenceChart.java:4604-4605
// ---------------------------------------------------------------------------------

test('selfMessageEllipseHeight: caps at the minimum height when axisSpacing is small', () => {
  assert.strictEqual(selfMessageEllipseHeight(0, 10, 14, 15), 15);
});

test('selfMessageEllipseHeight: with room to spare, height grows with axisSpacing and the delta bucket', () => {
  // fontHeight=14, axisSpacing=100 -> numberOfPossibleEllipseHeights = round((100-14)/24) = round(3.58) = 4
  const h0 = selfMessageEllipseHeight(0, 100, 14, 15); // bucket 0 -> 100*1/5=20
  const h1 = selfMessageEllipseHeight(1, 100, 14, 15); // bucket 1 -> 100*2/5=40
  assert.strictEqual(h0, 20);
  assert.strictEqual(h1, 40);
  assert.ok(h1 > h0, 'a larger event-number delta bucket yields a taller ellipse (varies repeated same-pair self-messages)');
});

test('selfMessageEllipseHeight: negative delta wraps into a valid positive bucket (proper modulo, not JS truncating %)', () => {
  const h = selfMessageEllipseHeight(-1, 100, 14, 15);
  assert.ok(h >= 15, 'never below the minimum height even for a negative delta');
});

// ---------------------------------------------------------------------------------
// adjustEndpointsForEventRadius -- SequenceChart.java:4498-4511
// ---------------------------------------------------------------------------------

test('adjustEndpointsForEventRadius: pulls endpoints toward each other when y1 > y2', () => {
  assert.deepEqual(adjustEndpointsForEventRadius(100, 50, 3, true), [97, 53]);
});

test('adjustEndpointsForEventRadius: pulls endpoints toward each other when y1 < y2', () => {
  assert.deepEqual(adjustEndpointsForEventRadius(50, 100, 3, true), [53, 97]);
});

test('adjustEndpointsForEventRadius: equal y1/y2 (self-arrow row) both shift up by radius', () => {
  assert.deepEqual(adjustEndpointsForEventRadius(60, 60, 3, true), [57, 57]);
});

test('adjustEndpointsForEventRadius: no-op when showEventMarks is off', () => {
  assert.deepEqual(adjustEndpointsForEventRadius(100, 50, 3, false), [100, 50]);
});

// ---------------------------------------------------------------------------------
// computeArrowhead -- orientation
// ---------------------------------------------------------------------------------

test('computeArrowhead: angle matches atan2(dy,dx); rightward arrow has angle 0', () => {
  const head = computeArrowhead(100, 50, 10, 0);
  assert.strictEqual(head.angle, 0);
  assert.strictEqual(head.long, false);
});

test('computeArrowhead: downward arrow (dx=0,dy=1) has angle PI/2', () => {
  const head = computeArrowhead(100, 50, 0, 1);
  assert.ok(Math.abs(head.angle - Math.PI / 2) < 1e-9);
});

// ---------------------------------------------------------------------------------
// computeLineArrowGeometry -- straight cross-module arrows (both in range)
// ---------------------------------------------------------------------------------

test('computeLineArrowGeometry: both endpoints in range -> a single solid segment + arrowhead oriented along it', () => {
  const geom = computeLineArrowGeometry({ cause: { axisY: 0, x: 0 }, consequence: { axisY: 100, x: 200 }, showArrowHeads: true, isFiltered: false });
  assert.ok(geom);
  assert.strictEqual(geom!.segments.length, 1);
  assert.deepEqual(geom!.segments[0], { x1: 0, y1: 0, x2: 200, y2: 100, dashed: false });
  assert.ok(geom!.arrowhead);
  assert.ok(Math.abs(geom!.arrowhead!.angle - Math.atan2(100, 200)) < 1e-9);
  assert.strictEqual(geom!.arrowhead!.long, false);
});

test('computeLineArrowGeometry: both endpoints offscreen -> null (nothing to draw)', () => {
  const geom = computeLineArrowGeometry({ cause: { axisY: 0, x: null }, consequence: { axisY: 100, x: null }, showArrowHeads: true, isFiltered: false });
  assert.strictEqual(geom, null);
});

test('computeLineArrowGeometry: cause offscreen -> a dashed segment (from a synthetic far point) followed by a solid segment ending at the real consequence; arrowhead NOT long', () => {
  const geom = computeLineArrowGeometry({ cause: { axisY: 0, x: null }, consequence: { axisY: 0, x: 500 }, showArrowHeads: true, isFiltered: false, longArrowWidth: 80 });
  assert.ok(geom);
  assert.strictEqual(geom!.segments.length, 2);
  assert.strictEqual(geom!.segments[0].dashed, true);
  assert.strictEqual(geom!.segments[1].dashed, false);
  assert.strictEqual(geom!.segments[1].x2, 500, 'the solid segment ends at the real (known) consequence x');
  assert.strictEqual(geom!.arrowhead!.long, false, 'the real endpoint is known, so no "long/synthetic-marker" arrowhead color');
});

test('computeLineArrowGeometry: consequence offscreen -> solid segment near the real cause, dashed continuation beyond it; arrowhead IS long (marks the synthetic edge)', () => {
  const geom = computeLineArrowGeometry({ cause: { axisY: 0, x: 100 }, consequence: { axisY: 0, x: null }, showArrowHeads: true, isFiltered: false, longArrowWidth: 80 });
  assert.ok(geom);
  assert.strictEqual(geom!.segments.length, 2);
  assert.strictEqual(geom!.segments[0].dashed, false);
  assert.strictEqual(geom!.segments[0].x1, 100, 'the solid segment starts at the real (known) cause x');
  assert.strictEqual(geom!.segments[1].dashed, true);
  assert.strictEqual(geom!.arrowhead!.long, true);
});

test('computeLineArrowGeometry: containment hits either segment of a split arrow', () => {
  const geom = computeLineArrowGeometry({ cause: { axisY: 0, x: null }, consequence: { axisY: 0, x: 500 }, showArrowHeads: false, isFiltered: false })!;
  // a point on the dashed (offscreen) segment
  const dashedMidX = (geom.segments[0].x1 + geom.segments[0].x2) / 2;
  assert.ok(lineArrowGeometryContainsPoint(geom, dashedMidX, 0));
  // a point far off the line entirely
  assert.ok(!lineArrowGeometryContainsPoint(geom, dashedMidX, 500));
});

test('computeLineArrowGeometry: filtered dependency gets a signAnchor at the segment midpoint, oriented along the line', () => {
  const geom = computeLineArrowGeometry({ cause: { axisY: 0, x: 0 }, consequence: { axisY: 0, x: 100 }, showArrowHeads: false, isFiltered: true })!;
  assert.ok(geom.signAnchor);
  assert.strictEqual(geom.signAnchor!.x, 50);
  assert.strictEqual(geom.signAnchor!.y, 0);
  assert.strictEqual(geom.signAnchor!.angle, 0);
});

test('computeLineArrowGeometry: non-filtered dependency has no signAnchor', () => {
  const geom = computeLineArrowGeometry({ cause: { axisY: 0, x: 0 }, consequence: { axisY: 0, x: 100 }, showArrowHeads: false, isFiltered: false })!;
  assert.strictEqual(geom.signAnchor, null);
});

// ---------------------------------------------------------------------------------
// Transmission-duration parallelogram
// ---------------------------------------------------------------------------------

test('computeTransmissionParallelogram: 50% fraction produces a quad half as wide as the arrow span at each row', () => {
  const geom = computeLineArrowGeometry({ cause: { axisY: 0, x: 0 }, consequence: { axisY: 100, x: 200 }, showArrowHeads: false, isFiltered: false, transmissionDurationFraction: 0.5 });
  assert.ok(geom!.parallelogram);
  const [p1, p2, p3, p4] = geom!.parallelogram!.points;
  assert.deepEqual(p1, [0, 0]);
  assert.deepEqual(p2, [100, 0]);
  assert.deepEqual(p3, [200, 100]);
  assert.deepEqual(p4, [100, 100]);
});

test('computeTransmissionParallelogram: fraction <= 0 -> no parallelogram', () => {
  assert.strictEqual(computeTransmissionParallelogram(0, 0, 100, 0, 0), null);
  const geom = computeLineArrowGeometry({ cause: { axisY: 0, x: 0 }, consequence: { axisY: 0, x: 100 }, showArrowHeads: false, isFiltered: false, transmissionDurationFraction: 0 });
  assert.strictEqual(geom!.parallelogram, null);
});

test('computeTransmissionParallelogram: skipped for a split (offscreen-endpoint) arrow (documented scope cut)', () => {
  const geom = computeLineArrowGeometry({ cause: { axisY: 0, x: null }, consequence: { axisY: 0, x: 500 }, showArrowHeads: false, isFiltered: false, transmissionDurationFraction: 0.5 });
  assert.strictEqual(geom!.parallelogram, null);
});

// ---------------------------------------------------------------------------------
// computeSelfArrowGeometry -- half-ellipse / vertical / split quarter-ellipse
// ---------------------------------------------------------------------------------

test('computeSelfArrowGeometry: both endpoints offscreen -> null', () => {
  assert.strictEqual(computeSelfArrowGeometry({ cause: { x: null }, consequence: { x: null }, y: 100, eventNumberDelta: 0, axisSpacing: 50, showArrowHeads: true, isFiltered: false }), null);
});

test('computeSelfArrowGeometry: identical x (vertical zero-width case) -> a single vertical segment, no ellipse, arrowhead pointing down (dy=1)', () => {
  const geom = computeSelfArrowGeometry({ cause: { x: 100 }, consequence: { x: 100 }, y: 200, eventNumberDelta: 0, axisSpacing: 50, showArrowHeads: true, isFiltered: false, minHalfEllipseHeight: 15 })!;
  assert.strictEqual(geom.ellipse, null);
  assert.strictEqual(geom.segments.length, 1);
  assert.strictEqual(geom.segments[0].x1, 100);
  assert.strictEqual(geom.segments[0].x2, 100);
  assert.strictEqual(geom.segments[0].y1, 200);
  assert.ok(geom.segments[0].y2 < 200, 'the loop rises above the axis row');
  assert.ok(Math.abs(geom.arrowhead!.angle - Math.PI / 2) < 1e-9);
});

test('computeSelfArrowGeometry: both endpoints known and distinct -> a full half ellipse (quarter=-1), height from selfMessageEllipseHeight, no straight segments', () => {
  const geom = computeSelfArrowGeometry({ cause: { x: 50 }, consequence: { x: 150 }, y: 200, eventNumberDelta: 0, axisSpacing: 100, showArrowHeads: true, isFiltered: false, minHalfEllipseHeight: 15, fontHeight: 14 })!;
  assert.strictEqual(geom.segments.length, 0);
  assert.ok(geom.ellipse);
  assert.strictEqual(geom.ellipse!.quarter, -1);
  assert.strictEqual(geom.ellipse!.x1, 50);
  assert.strictEqual(geom.ellipse!.x2, 150);
  assert.strictEqual(geom.ellipse!.y, 200);
  const expectedHeight = selfMessageEllipseHeight(0, 100, 14, 15);
  assert.strictEqual(geom.ellipse!.height, expectedHeight);
  // arrowhead follows the ellipse tangent at the (right) consequence endpoint, NOT straight
  // down: it should point down-AND-to-the-right (angle strictly between 0 and PI/2), not PI/2.
  assert.ok(geom.arrowhead);
  const angle = geom.arrowhead!.angle;
  assert.ok(angle > 0 && angle < Math.PI / 2, `self-arc arrowhead should be diagonal (0 < ${angle} < PI/2), not straight down`);
});

test('computeSelfArrowGeometry: the arrowhead angle tracks the ellipse shape -- a taller ellipse arrives steeper (nearer PI/2) than a flat wide one', () => {
  const tall = computeSelfArrowGeometry({ cause: { x: 60 }, consequence: { x: 140 }, y: 200, eventNumberDelta: 5, axisSpacing: 100, showArrowHeads: true, isFiltered: false, minHalfEllipseHeight: 60 })!;
  const flat = computeSelfArrowGeometry({ cause: { x: 0 }, consequence: { x: 400 }, y: 200, eventNumberDelta: 0, axisSpacing: 100, showArrowHeads: true, isFiltered: false, minHalfEllipseHeight: 2 })!;
  assert.ok(Number.isFinite(tall.arrowhead!.angle) && Number.isFinite(flat.arrowhead!.angle));
  assert.ok(tall.arrowhead!.angle > flat.arrowhead!.angle, `taller ellipse should arrive steeper (${tall.arrowhead!.angle} > ${flat.arrowhead!.angle})`);
  assert.ok(tall.arrowhead!.angle <= Math.PI / 2 + 1e-9 && flat.arrowhead!.angle >= -1e-9);
});

test('computeSelfArrowGeometry: cause offscreen -> quarter=1 (right quarter, near the real consequence) + a dashed tail', () => {
  const geom = computeSelfArrowGeometry({ cause: { x: null }, consequence: { x: 300 }, y: 200, eventNumberDelta: 0, axisSpacing: 100, showArrowHeads: true, isFiltered: false, longArrowWidth: 80 })!;
  assert.ok(geom.ellipse);
  assert.strictEqual(geom.ellipse!.quarter, 1);
  assert.strictEqual(geom.ellipse!.x2, 300, 'the ellipse touches the real consequence x');
  assert.strictEqual(geom.segments.length, 1);
  assert.strictEqual(geom.segments[0].dashed, true);
});

test('computeSelfArrowGeometry: consequence offscreen -> quarter=0 (left quarter, near the real cause) + a dashed tail + a LONG arrowhead', () => {
  const geom = computeSelfArrowGeometry({ cause: { x: 100 }, consequence: { x: null }, y: 200, eventNumberDelta: 0, axisSpacing: 100, showArrowHeads: true, isFiltered: false, longArrowWidth: 80 })!;
  assert.ok(geom.ellipse);
  assert.strictEqual(geom.ellipse!.quarter, 0);
  assert.strictEqual(geom.ellipse!.x1, 100, 'the ellipse touches the real cause x');
  assert.strictEqual(geom.segments.length, 1);
  assert.strictEqual(geom.segments[0].dashed, true);
  assert.strictEqual(geom.arrowhead!.long, true);
});

test('computeSelfArrowGeometry: filtered self-dependency (both known) gets a horizontal signAnchor; vertical zero-width case gets none (matches Java)', () => {
  const both = computeSelfArrowGeometry({ cause: { x: 50 }, consequence: { x: 150 }, y: 200, eventNumberDelta: 0, axisSpacing: 100, showArrowHeads: false, isFiltered: true })!;
  assert.ok(both.signAnchor);
  assert.strictEqual(both.signAnchor!.angle, 0);
  const vertical = computeSelfArrowGeometry({ cause: { x: 100 }, consequence: { x: 100 }, y: 200, eventNumberDelta: 0, axisSpacing: 100, showArrowHeads: false, isFiltered: true })!;
  assert.strictEqual(vertical.signAnchor, null);
});

// ---------------------------------------------------------------------------------
// Containment (fit-mode) checks -- on/off each shape, tolerance 3
// ---------------------------------------------------------------------------------

test('selfArrowGeometryContainsPoint: point exactly on top of the half-ellipse ring is contained', () => {
  const geom = computeSelfArrowGeometry({ cause: { x: 0 }, consequence: { x: 100 }, y: 100, eventNumberDelta: 0, axisSpacing: 100, showArrowHeads: false, isFiltered: false, minHalfEllipseHeight: 20 })!;
  // top-center of the ellipse: cx=50, ring point straight up by `height`
  assert.ok(selfArrowGeometryContainsPoint(geom, 50, 100 - geom.ellipse!.height, 3));
});

test('selfArrowGeometryContainsPoint: point at the ellipse center (inside the ring, not ON it) is NOT contained', () => {
  const geom = computeSelfArrowGeometry({ cause: { x: 0 }, consequence: { x: 100 }, y: 100, eventNumberDelta: 0, axisSpacing: 100, showArrowHeads: false, isFiltered: false, minHalfEllipseHeight: 20 })!;
  assert.ok(!selfArrowGeometryContainsPoint(geom, 50, 100, 3));
});

test('selfArrowGeometryContainsPoint: point far outside the whole shape is rejected', () => {
  const geom = computeSelfArrowGeometry({ cause: { x: 0 }, consequence: { x: 100 }, y: 100, eventNumberDelta: 0, axisSpacing: 100, showArrowHeads: false, isFiltered: false, minHalfEllipseHeight: 20 })!;
  assert.ok(!selfArrowGeometryContainsPoint(geom, 5000, 5000, 3));
});

test('selfArrowGeometryContainsPoint: vertical zero-width case hits along its single segment', () => {
  const geom = computeSelfArrowGeometry({ cause: { x: 100 }, consequence: { x: 100 }, y: 200, eventNumberDelta: 0, axisSpacing: 50, showArrowHeads: false, isFiltered: false, minHalfEllipseHeight: 15 })!;
  assert.ok(selfArrowGeometryContainsPoint(geom, 100, 190, 3));
  assert.ok(!selfArrowGeometryContainsPoint(geom, 200, 190, 3));
});

test('lineArrowGeometryContainsPoint: on/off tolerance for a plain straight arrow', () => {
  const geom = computeLineArrowGeometry({ cause: { axisY: 0, x: 0 }, consequence: { axisY: 0, x: 100 }, showArrowHeads: false, isFiltered: false })!;
  assert.ok(lineArrowGeometryContainsPoint(geom, 50, 0, 3));
  assert.ok(lineArrowGeometryContainsPoint(geom, 50, 2.9, 3));
  assert.ok(!lineArrowGeometryContainsPoint(geom, 50, 10, 3));
});

// ---------------------------------------------------------------------------------
// Filtered zigzag sign segments -- shape sanity (decoration only, not hit-tested)
// ---------------------------------------------------------------------------------

test('buildFilteredSignSegments: count=2 produces 6 segments (2 polylines of 3 segments), centered at the anchor', () => {
  const segments = buildFilteredSignSegments({ x: 100, y: 50, angle: 0 });
  assert.strictEqual(segments.length, 6);
  for (const seg of segments) {
    assert.ok(Math.abs((seg.x1 + seg.x2) / 2 - 100) < 20, 'segments stay near the anchor x');
  }
});

test('buildFilteredSignSegments: rotating the anchor angle rotates the segments (not identical to angle=0)', () => {
  const flat = buildFilteredSignSegments({ x: 0, y: 0, angle: 0 });
  const rotated = buildFilteredSignSegments({ x: 0, y: 0, angle: Math.PI / 2 });
  assert.notDeepEqual(flat, rotated);
});
