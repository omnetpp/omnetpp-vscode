/**
 * arrowGeometry.ts (PURE) — the message-dependency/method-call drawing math, ported
 * from `SequenceChart.java`'s `drawOrFitMessageDependency()` (`SequenceChart.java:
 * 4439-4855`, verified by reading the source in full) and its helpers
 * `drawTransmissionDuration` (4861), `drawFilteredMessageDependencySign` (4984),
 * `drawArrowHead` (5034), plus the ellipse hit-test `halfEllipseContainsPoint`
 * (5259, already ported in `hitTest.ts`, reused here rather than re-derived).
 *
 * Deliberately engine/DOM-free: every function takes already-resolved PIXEL endpoint
 * coordinates (the caller, `drawList.ts`, does tc->px and axis->y lookups) and returns
 * a small geometry description consumed by BOTH the renderer (`canvasStack.ts`) and the
 * hit-tester (`hitTest.ts`'s `containsPoint` helpers below) — "fit mode = same code
 * path evaluating containment", per this phase's brief.
 *
 * ============================= FIDELITY NOTES ==============================
 *  - Self-message half-ellipse height: `selfMessageEllipseHeight()` below is a
 *    verbatim port of `SequenceChart.java:4604-4605`'s
 *    `numberOfPossibleEllipseHeights`/`halfEllipseHeight` formula (including the
 *    `messageId + consequenceEventNumber - causeEventNumber` "delta" that varies the
 *    height among repeated same-pair self-messages), with one difference: Java's `%`
 *    is Java's (truncating, can be negative for a negative delta); this port floors
 *    to a proper mathematical modulo (`((x % n) + n) % n`) so a negative delta still
 *    lands in `[0, numberOfPossibleEllipseHeights)` instead of a JS `%`-truncation
 *    negative bucket — a strictly-positive-bucket count is what the height formula
 *    assumes, so this is a bug-preserving-INTENT fix, not a behavior deviation Java
 *    itself would disagree with for delta >= 0 (the overwhelmingly common case, since
 *    `consequenceEventNumber > causeEventNumber` always holds for a well-formed log).
 *  - The three self-arrow rendering cases (both-in-range half ellipse / cause-too-far
 *    quarter-ellipse+dotted-tail / consequence-too-far quarter-ellipse+dotted-tail) are
 *    ported per `SequenceChart.java:4624-4718`, including the exact quarter/bbox
 *    parameterization `halfEllipseContainsPoint()` already expects (`hitTest.ts`).
 *  - Arrowhead ORIENTATION at an ellipse endpoint: Java solves an ellipse/circle
 *    intersection (`SequenceChart.java:4694-4712`) so the arrowhead's rear corners sit
 *    exactly ON the curve rather than only matching the endpoint's local tangent.
 *    DOCUMENTED SIMPLIFICATION: this port uses the endpoint's exact tangent instead
 *    (provably `(0, ±1)` — vertical — at BOTH ends of any half-ellipse regardless of
 *    its radii, since `d/dt(cx + rx·cos t, cy + ry·sin t) = (-rx·sin t, ry·cos t)` is
 *    `(0, ±ry)` at `t ∈ {0, π}`), which is visually correct (the arrowhead still
 *    points squarely into the endpoint) but does not replicate Java's tiny "hug the
 *    curve" corner adjustment.
 *  - `computeLineArrowGeometry()` (and, for self-messages, `computeSelfArrowGeometry()`)
 *    ports the non-self, both-in-range and single-side-offscreen ("split arrow") cases
 *    (`SequenceChart.java:4719-4805`) — dashed continuation toward the offscreen side,
 *    `EVENT_RADIUS`-aware endpoint shrink (`adjustEndpointsForEventRadius()`, port of
 *    `SequenceChart.java:4498-4511`). The "both events resolvable but the pixel distance
 *    between them exceeds a display-width cap, so one side is elided based on which is
 *    farther from the viewport" case (`SequenceChart.java:4553-4560`,
 *    `getMaximumMessageDependencyDisplayWidth() = 3 * viewport width`) IS ported, but one
 *    layer up in `drawList.ts`'s `pushDependency()` (not here): it nulls out the farther
 *    endpoint's already-computed pixel x BEFORE calling into this file, so the resulting
 *    split-arrow rendering is 100% the same code path as a genuinely-offscreen endpoint —
 *    no separate "too long" geometry needed in this module.
 *  - Transmission-duration parallelogram (`computeTransmissionParallelogram()`):
 *    DOCUMENTED SIMPLIFICATION of `drawTransmissionDuration()` (4861-4957). Java
 *    remaps the absolute transmission/remaining-duration `BigDecimal`s through a
 *    per-module, non-affine tc mapping to get 4 independent corner x-coordinates (and
 *    a 4-strip "broken" fill pattern when the duration's far edge itself needs
 *    splitting). This port instead scales the arrow's own already-computed pixel span
 *    by `RenderDependency.transmissionDurationFraction` (see that field's own doc in
 *    `elogProtocol.ts` for the exact math) into a single non-striped translucent
 *    quadrilateral, and skips the decoration entirely for a split (offscreen-endpoint)
 *    arrow (a narrower scope cut than Java, which still draws one there).
 *  - Filtered-dependency zigzag sign: `buildFilteredSignSegments()` is a verbatim port
 *    of `drawFilteredMessageDependencySign()` (4984-5023) — same `size`/`spacing`/
 *    `count` constants, same rotate+translate transform (in radians here instead of
 *    degrees, since this port's angles are already radians throughout).
 *  - Message-dependency label placement: Java runs a greedy collision-avoiding search
 *    over a quadtree of already-placed labels (`SequenceChart.java:4802-4848`).
 *    DOCUMENTED SIMPLIFICATION (matches this codebase's existing method-call label
 *    placement, `drawList.ts`'s pre-U5 code): a single fixed offset near the arrow's
 *    midpoint, no collision search.
 */

import { HIT_TOLERANCE, halfEllipseContainsPoint, lineContainsPoint } from './hitTest';

export const ARROWHEAD_LENGTH = 10;
export const ARROWHEAD_WIDTH = 7;
export const MIN_HALF_ELLIPSE_HEIGHT = 15;
export const LONG_MESSAGE_ARROW_WIDTH = 80;
export const EVENT_RADIUS = 3;
export const DEFAULT_FONT_HEIGHT = 14;

export interface LineSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  dashed: boolean;
}

/** Parameters `halfEllipseContainsPoint()` (`hitTest.ts`) already expects — reused verbatim so hit-testing never re-derives the ellipse shape. */
export interface EllipseGeom {
  x1: number;
  x2: number;
  y: number;
  height: number;
  quarter: 0 | 1 | -1;
}

export interface ArrowHeadGeom {
  x: number;
  y: number;
  angle: number;
  /** `true` = Java's `getLongArrowheadColor()` (white) — the split/offscreen arrowhead marking a synthetic (not-the-real-event) endpoint. */
  long: boolean;
  length: number;
  width: number;
}

export interface SignAnchor {
  x: number;
  y: number;
  angle: number;
}

export interface ParallelogramGeom {
  points: [[number, number], [number, number], [number, number], [number, number]];
}

// ---------------------------------------------------------------------------------
// Self-message half-ellipse height (SequenceChart.java:4604-4605)
// ---------------------------------------------------------------------------------

/** See this file's header — `eventNumberDelta = messageId + consequenceEventNumber - causeEventNumber`. */
export function selfMessageEllipseHeight(eventNumberDelta: number, axisSpacing: number, fontHeight = DEFAULT_FONT_HEIGHT, minHeight = MIN_HALF_ELLIPSE_HEIGHT): number {
  const numberOfPossibleEllipseHeights = Math.max(1, Math.round((axisSpacing - fontHeight) / (fontHeight + 10)));
  const bucket = (((eventNumberDelta % numberOfPossibleEllipseHeights) + numberOfPossibleEllipseHeights) % numberOfPossibleEllipseHeights);
  return Math.max((axisSpacing * (bucket + 1)) / (numberOfPossibleEllipseHeights + 1), minHeight);
}

// ---------------------------------------------------------------------------------
// Event-radius endpoint shrink (SequenceChart.java:4498-4511)
// ---------------------------------------------------------------------------------

/** Pulls `y1`/`y2` toward each other by `eventRadius` so the arrow touches the event mark's EDGE, not its center (no-op if `showEventMarks` is off). */
export function adjustEndpointsForEventRadius(y1: number, y2: number, eventRadius: number, showEventMarks: boolean): [number, number] {
  if (!showEventMarks) return [y1, y2];
  if (y1 > y2) return [y1 - eventRadius, y2 + eventRadius];
  if (y1 < y2) return [y1 + eventRadius, y2 - eventRadius];
  return [y1 - eventRadius, y2 - eventRadius];
}

// ---------------------------------------------------------------------------------
// Arrowhead
// ---------------------------------------------------------------------------------

export function computeArrowhead(x: number, y: number, dx: number, dy: number, long = false, length = ARROWHEAD_LENGTH, width = ARROWHEAD_WIDTH): ArrowHeadGeom {
  return { x, y, angle: Math.atan2(dy, dx), long, length, width };
}

/**
 * Port of `SequenceChart.java:4691-4712`: the arrowhead at a self-message half-ellipse's
 * (consequence) endpoint must follow the ELLIPSE TANGENT there, not point straight down.
 * The tangent chord is found by intersecting the ellipse with a circle of the arrowhead
 * length centered at the endpoint (the endpoint is at `(+a, 0)` in center-relative
 * coords; the intersection lands on the top-right quarter). Falls back to straight-down
 * `(0, 1)` when the ellipse is too flat for a valid top-quarter solution (Java's `x < 0`
 * guard), which is exactly the old behavior for those degenerate cases.
 */
export function computeSelfEllipseArrowhead(x1: number, x2: number, y: number, halfEllipseHeight: number, length = ARROWHEAD_LENGTH, width = ARROWHEAD_WIDTH): ArrowHeadGeom {
  const a = Math.abs(x2 - x1) / 2;
  const b = halfEllipseHeight;
  const a2 = a * a;
  const b2 = b * b;
  const r2 = length * length;
  // mupad: solve([x^2/a^2 + (r^2-(x-a)^2)/b^2 = 1], x)
  const xs = a === b ? (2 * a2 - r2) / 2 / a : (a * (-Math.sqrt(a2 * r2 + b2 * b2 - b2 * r2) + a2)) / (a2 - b2);
  const ys = -Math.sqrt(r2 - (xs - a) * (xs - a));
  if (!(xs >= 0) || Number.isNaN(ys)) return computeArrowhead(x2, y, 0, 1, false, length, width);
  const cx = (x1 + x2) / 2;
  const dir = x2 >= x1 ? 1 : -1; // which side the endpoint (x2) is on
  const px = cx + dir * xs;
  const py = y + ys;
  return computeArrowhead(x2, y, x2 - px, y - py, false, length, width);
}

// ---------------------------------------------------------------------------------
// Cross-module ("regular") arrow — SequenceChart.java:4719-4805
// ---------------------------------------------------------------------------------

export interface LineEndpoint {
  /** Pixel y of this side's axis row (post `adjustEndpointsForEventRadius`, if desired). */
  axisY: number;
  /** Pixel x of this side's event, or `null` if this side's tc falls outside the currently-known/computed range ("offscreen" per this file's header — protocol: `causeTc`/`consequenceTc === null`). */
  x: number | null;
}

export interface LineArrowGeometry {
  segments: LineSegment[];
  arrowhead: ArrowHeadGeom | null;
  labelAnchor: { x: number; y: number };
  signAnchor: SignAnchor | null;
  parallelogram: ParallelogramGeom | null;
}

export interface LineArrowParams {
  cause: LineEndpoint;
  consequence: LineEndpoint;
  showArrowHeads: boolean;
  isFiltered: boolean;
  fontHeight?: number;
  longArrowWidth?: number;
  arrowheadLength?: number;
  arrowheadWidth?: number;
  /** `RenderDependency.transmissionDurationFraction` — see `elogProtocol.ts`'s doc. `null`/`undefined`/`<=0` = no parallelogram. Only applied when BOTH endpoints are in range (see this file's header's transmission-duration fidelity note). */
  transmissionDurationFraction?: number | null;
  isReceptionStart?: boolean | null;
  transmissionDurationX1?: number | null;
  transmissionDurationX2?: number | null;
  transmissionDurationX3?: number | null;
  transmissionDurationX4?: number | null;
}

/** `null` when both endpoints are offscreen (nothing to draw at all — matches Java's `if (x1 == invalid && x2 == invalid) return false;`). */
export function computeLineArrowGeometry(params: LineArrowParams): LineArrowGeometry | null {
  const { cause, consequence, showArrowHeads, isFiltered, fontHeight = DEFAULT_FONT_HEIGHT, longArrowWidth = LONG_MESSAGE_ARROW_WIDTH, arrowheadLength = ARROWHEAD_LENGTH, arrowheadWidth = ARROWHEAD_WIDTH, transmissionDurationFraction, isReceptionStart, transmissionDurationX1, transmissionDurationX2, transmissionDurationX3, transmissionDurationX4 } = params;
  if (cause.x === null && consequence.x === null) return null;

  let x1: number;
  let x2: number;
  let arrowheadLong = false;
  const y1 = cause.axisY;
  const y2 = consequence.axisY;
  const causeOffscreen = cause.x === null;
  const consequenceOffscreen = consequence.x === null;

  if (causeOffscreen) {
    x2 = consequence.x!;
    x1 = x2 - longArrowWidth * 2;
  } else if (consequenceOffscreen) {
    x1 = cause.x!;
    x2 = x1 + longArrowWidth * 2;
    arrowheadLong = true;
  } else {
    x1 = cause.x!;
    x2 = consequence.x!;
  }

  const xm = (x1 + x2) / 2;
  const ym = (y1 + y2) / 2;
  const segments: LineSegment[] = [];
  if (causeOffscreen) {
    segments.push({ x1, y1, x2: xm, y2: ym, dashed: true });
    segments.push({ x1: xm, y1: ym, x2, y2, dashed: false });
  } else if (consequenceOffscreen) {
    segments.push({ x1, y1, x2: xm, y2: ym, dashed: false });
    segments.push({ x1: xm, y1: ym, x2, y2, dashed: true });
  } else {
    segments.push({ x1, y1, x2, y2, dashed: false });
  }

  const arrowhead = showArrowHeads ? computeArrowhead(x2, y2, x2 - x1, y2 - y1, arrowheadLong, arrowheadLength, arrowheadWidth) : null;
  const labelAnchor = { x: xm + 3, y: ym - (y1 < y2 ? fontHeight : 0) };
  const signAnchor: SignAnchor | null = isFiltered ? { x: xm, y: ym, angle: Math.atan2(y2 - y1, x2 - x1) } : null;
  const parallelogram = !causeOffscreen && !consequenceOffscreen && ((transmissionDurationFraction && transmissionDurationFraction > 0) || (transmissionDurationX1 !== undefined && transmissionDurationX1 !== null)) ? computeTransmissionParallelogram(x1, y1, x2, y2, transmissionDurationFraction ?? 0, isReceptionStart, transmissionDurationX1, transmissionDurationX2, transmissionDurationX3, transmissionDurationX4) : null;

  return { segments, arrowhead, labelAnchor, signAnchor, parallelogram };
}

export function lineArrowGeometryContainsPoint(geom: LineArrowGeometry, px: number, py: number, tolerance?: number): boolean {
  return geom.segments.some((s) => lineContainsPoint(s.x1, s.y1, s.x2, s.y2, px, py, tolerance));
}

// ---------------------------------------------------------------------------------
// Self-message arrow (half-ellipse / vertical / split quarter-ellipse) --
// SequenceChart.java:4602-4718
// ---------------------------------------------------------------------------------

export interface SelfArrowGeometry {
  segments: LineSegment[];
  ellipse: EllipseGeom | null;
  arrowhead: ArrowHeadGeom | null;
  labelAnchor: { x: number; y: number };
  signAnchor: SignAnchor | null;
}

export interface SelfArrowParams {
  cause: { x: number | null };
  consequence: { x: number | null };
  /** Shared axis row (both sides of a self-message resolve to the same module/row) — already event-radius-adjusted by the caller if desired (`adjustEndpointsForEventRadius(y, y, ...)` collapses to `y - eventRadius` either way). */
  y: number;
  eventNumberDelta: number;
  axisSpacing: number;
  showArrowHeads: boolean;
  isFiltered: boolean;
  fontHeight?: number;
  minHalfEllipseHeight?: number;
  longArrowWidth?: number;
  arrowheadLength?: number;
  arrowheadWidth?: number;
}

/** `null` when both endpoints are offscreen. */
export function computeSelfArrowGeometry(params: SelfArrowParams): SelfArrowGeometry | null {
  const { cause, consequence, y, eventNumberDelta, axisSpacing, showArrowHeads, isFiltered, fontHeight = DEFAULT_FONT_HEIGHT, minHalfEllipseHeight = MIN_HALF_ELLIPSE_HEIGHT, longArrowWidth = LONG_MESSAGE_ARROW_WIDTH, arrowheadLength = ARROWHEAD_LENGTH, arrowheadWidth = ARROWHEAD_WIDTH } = params;
  if (cause.x === null && consequence.x === null) return null;
  const halfEllipseHeight = selfMessageEllipseHeight(eventNumberDelta, axisSpacing, fontHeight, minHalfEllipseHeight);

  if (cause.x !== null && consequence.x !== null && cause.x === consequence.x) {
    // vertical zero-width self-arrow (SequenceChart.java:4608-4623) -- no filtered sign in Java here either.
    const yTop = y - halfEllipseHeight;
    return {
      segments: [{ x1: cause.x, y1: y, x2: cause.x, y2: yTop, dashed: false }],
      ellipse: null,
      arrowhead: showArrowHeads ? computeArrowhead(cause.x, y, 0, 1, false, arrowheadLength, arrowheadWidth) : null,
      labelAnchor: { x: cause.x + 2, y: yTop - fontHeight },
      signAnchor: null,
    };
  }

  const ym = y - halfEllipseHeight;
  if (cause.x === null) {
    // cause too far -- quarter ellipse near the (real) consequence side, dotted tail to the left.
    const x2 = consequence.x!;
    const x1 = x2 - longArrowWidth;
    const xm = x1 + longArrowWidth / 2;
    return {
      segments: [{ x1, y1: ym, x2: xm, y2: ym, dashed: true }],
      ellipse: { x1, x2, y, height: halfEllipseHeight, quarter: 1 },
      arrowhead: showArrowHeads ? computeArrowhead(x2, y, 0, 1, false, arrowheadLength, arrowheadWidth) : null,
      labelAnchor: { x: (x1 + x2) / 2, y: ym - fontHeight },
      signAnchor: isFiltered ? { x: (x1 + x2) / 2, y: ym, angle: 0 } : null,
    };
  }
  if (consequence.x === null) {
    // consequence too far -- quarter ellipse near the (real) cause side, dotted tail to the right; the
    // arrowhead marks the synthetic edge (long/white color), pointing away (matches Java's fixed (1,0)).
    const x1 = cause.x!;
    const x2 = x1 + longArrowWidth;
    const xm = x1 + longArrowWidth / 2;
    return {
      segments: [{ x1: xm, y1: ym, x2, y2: ym, dashed: true }],
      ellipse: { x1, x2, y, height: halfEllipseHeight, quarter: 0 },
      arrowhead: showArrowHeads ? computeArrowhead(x2, ym, 1, 0, true, arrowheadLength, arrowheadWidth) : null,
      labelAnchor: { x: (x1 + x2) / 2, y: ym - fontHeight },
      signAnchor: isFiltered ? { x: (x1 + x2) / 2, y: ym, angle: 0 } : null,
    };
  }

  // both endpoints in range -- full half ellipse.
  const x1 = cause.x;
  const x2 = consequence.x;
  return {
    segments: [],
    ellipse: { x1, x2, y, height: halfEllipseHeight, quarter: -1 },
    arrowhead: showArrowHeads ? computeSelfEllipseArrowhead(x1, x2, y, halfEllipseHeight, arrowheadLength, arrowheadWidth) : null,
    labelAnchor: { x: (x1 + x2) / 2, y: ym - fontHeight },
    signAnchor: isFiltered ? { x: (x1 + x2) / 2, y: ym, angle: 0 } : null,
  };
}

export function selfArrowGeometryContainsPoint(geom: SelfArrowGeometry, px: number, py: number, tolerance = HIT_TOLERANCE): boolean {
  if (geom.segments.some((s) => lineContainsPoint(s.x1, s.y1, s.x2, s.y2, px, py, tolerance))) return true;
  if (geom.ellipse) return halfEllipseContainsPoint(geom.ellipse.quarter, geom.ellipse.x1, geom.ellipse.x2, geom.ellipse.y, geom.ellipse.height, px, py, tolerance);
  return false;
}

// ---------------------------------------------------------------------------------
// Transmission-duration parallelogram -- see this file's header's fidelity note
// ---------------------------------------------------------------------------------

/** `null` when `fraction <= 0` (no decoration). */
export function computeTransmissionParallelogram(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  fraction: number,
  isReceptionStart?: boolean | null,
  px1?: number | null,
  px2?: number | null,
  px3?: number | null,
  px4?: number | null
): ParallelogramGeom | null {
  if (px1 !== undefined && px1 !== null && px2 !== undefined && px2 !== null && px3 !== undefined && px3 !== null && px4 !== undefined && px4 !== null) {
    return { points: [[px1, y1], [px3, y1], [px4, y2], [px2, y2]] };
  }
  if (fraction <= 0) return null;
  const widthPx = fraction * Math.abs(x2 - x1);
  if (isReceptionStart) {
    return { points: [[x1, y1], [x1 + widthPx, y1], [x2 + widthPx, y2], [x2, y2]] };
  } else {
    return { points: [[x1, y1], [x1 + widthPx, y1], [x2, y2], [x2 - widthPx, y2]] };
  }
}

// ---------------------------------------------------------------------------------
// Filtered-dependency zigzag sign -- SequenceChart.java:4984-5023 (decoration only,
// not separately hit-tested -- Java draws it ON TOP of the already-hit-testable line/
// ellipse, never as its own collectVisibleObjectsAtPosition entry).
// ---------------------------------------------------------------------------------

export function buildFilteredSignSegments(anchor: SignAnchor, size = 5, spacing = 4, count = 2): LineSegment[] {
  const { x, y, angle } = anchor;
  const halfSize = size / 2;
  const halfSpacing = spacing / 2;
  const yy1 = -size - halfSize;
  const yy2 = yy1 + size;
  const yy3 = yy2 + size;
  const yy4 = yy3 + size;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const tf = (px: number, py: number): [number, number] => [x + px * cos - py * sin, y + px * sin + py * cos];

  const segments: LineSegment[] = [];
  for (let i = 0; i < count; i++) {
    const xx1 = -halfSize - halfSpacing + i * spacing;
    const xx2 = xx1 + size;
    const [x1a, y1a] = tf(xx1, yy1);
    const [x2a, y2a] = tf(xx2, yy2);
    const [x3a, y3a] = tf(xx1, yy3);
    const [x4a, y4a] = tf(xx2, yy4);
    segments.push({ x1: x1a, y1: y1a, x2: x2a, y2: y2a, dashed: false });
    segments.push({ x1: x2a, y1: y2a, x2: x3a, y2: y3a, dashed: false });
    segments.push({ x1: x3a, y1: y3a, x2: x4a, y2: y4a, dashed: false });
  }
  return segments;
}
