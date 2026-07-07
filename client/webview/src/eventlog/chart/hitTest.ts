/**
 * hitTest.ts (PURE) — port of `SequenceChart.java`'s hit-testing geometry
 * (`collectVisibleObjectsAtPosition` re-running the draw pass "in fit mode",
 * `lineContainsPoint`/`eventSymbolContainsPoint`/`halfEllipseContainsPoint`,
 * `SequenceChart.java:5087-5340`, verified by reading the source).
 *
 * DEVIATION (documented, deliberate): Java re-runs the ENTIRE draw pass at hit-test
 * time ("fit mode" — the same draw code, told to test-and-collect instead of
 * paint). This port instead scans the CURRENT frame's already-built `DrawPrimitive[]`
 * (`drawList.ts`'s output, which already carries the exact same geometry Java would
 * recompute) — cheaper (no second draw-list build) and exactly equivalent as long as
 * the caller passes the same primitives it just rendered, which `chartMain.ts` always
 * does (hit-testing only ever happens against the frame currently on screen).
 *
 * Tolerances (`SequenceChart.java` constants, verified):
 *  - `MOUSE_TOLERANCE = 3` px — lines, axis bands.
 *  - Event symbols use `MOUSE_TOLERANCE + 3 = 6` px (a wider, easier-to-hit target).
 *
 * Priority order (mouseUp's cascade, `SequenceChart.java:6009-6021`, verified): a
 * `ModuleAction` (axis-header expand/collapse/close icon) would be first, but this
 * port's axis rendering has no header icons yet (U8 territory — axis management) so
 * that level never applies and is omitted. The remaining cascade, exactly as ported:
 * event > message dependency > component method call > axis > timestamp.
 *
 * Phase U5: self-message arrows are now real half/quarter ellipses (`arrowGeometry.ts`'s
 * `computeSelfArrowGeometry()`, `drawList.ts`'s `'ellipseArc'` primitive) instead of the
 * pre-U5 vertical/horizontal "hairpin" placeholder — `halfEllipseContainsPoint` below
 * (previously ported but unused) is now live, reused as-is (no reason to re-derive it;
 * `arrowGeometry.ts` computes ellipse parameters in EXACTLY the `(quarter, x1, x2, y,
 * height)` shape this function already expected). Split/offscreen arrows (both the
 * self-ellipse quarter-arc case and the regular cross-module case) hit-test via their
 * `LineSegment`s, which `drawList.ts` emits as ordinary `'arrow'` primitives sharing the
 * dependency's ref — no separate hit-test code path needed for "split" at all.
 */

import type { ArrowRef, DrawPrimitive } from './drawList';

export const HIT_TOLERANCE = 3;
/** Event symbols get an easier-to-hit target — `MOUSE_TOLERANCE + 3` in Java. */
export const EVENT_HIT_TOLERANCE = HIT_TOLERANCE + 3;

export type HitObject =
  | { kind: 'event'; eventNumber: number; moduleId: number }
  | { kind: 'dependency'; dependencyKind: 'send' | 'reuse' | 'filtered'; causeEventNumber: number; consequenceEventNumber: number; causeTc: number; consequenceTc: number }
  | { kind: 'methodCall'; eventNumber: number; sourceModuleId: number; targetModuleId: number; tc: number }
  | { kind: 'axis'; moduleId: number }
  | { kind: 'timestamp'; tc: number };

/** Priority cascade for a plain/ctrl click and for tooltip primary selection — first non-empty category wins. `ModuleAction` (see this file's header) is omitted (not yet applicable). */
const PRIORITY_ORDER: HitObject['kind'][] = ['event', 'dependency', 'methodCall', 'axis', 'timestamp'];

// ---------------------------------------------------------------------------------
// Ported geometry primitives (SequenceChart.java, verified line numbers in header)
// ---------------------------------------------------------------------------------

/**
 * Port of `lineContainsPoint()` ("copied from org.eclipse.draw2d.Polyline",
 * `SequenceChart.java:5305`): bounding-box pre-check (segment rect expanded by
 * `tolerance`), then squared-perpendicular-distance-to-the-infinite-line test
 * (integer `floor` division in Java; this port keeps the same truncating-floor
 * semantics via `Math.floor` even though JS numbers aren't integers, so behavior at
 * an exact tolerance boundary matches Java bit-for-bit for integer-valued inputs).
 */
export function lineContainsPoint(x1: number, y1: number, x2: number, y2: number, px: number, py: number, tolerance = HIT_TOLERANCE): boolean {
  const minX = Math.min(x1, x2) - tolerance;
  const maxX = Math.max(x1, x2) + tolerance;
  const minY = Math.min(y1, y2) - tolerance;
  const maxY = Math.max(y1, y2) + tolerance;
  if (px < minX || px > maxX || py < minY || py > maxY) return false;

  let result = 0;
  if (x1 !== x2 && y1 !== y2) {
    const v1x = x2 - x1;
    const v1y = y2 - y1;
    const v2x = px - x1;
    const v2y = py - y1;
    const numerator = v2x * v1y - v1x * v2y; // 2D cross product (z component)
    const denominator = v1x * v1x + v1y * v1y; // |v1|^2
    result = Math.floor((numerator * numerator) / denominator);
  }
  return result <= tolerance * tolerance;
}

/** Port of `eventSymbolContainsPoint()` (`SequenceChart.java:5252`): axis-aligned box test around a (possibly zero-width) event-mark span. */
export function eventSymbolContainsPoint(px: number, py: number, xBegin: number, xEnd: number, y: number, tolerance = EVENT_HIT_TOLERANCE): boolean {
  return px >= xBegin - tolerance && px <= xEnd + tolerance && Math.abs(py - y) <= tolerance;
}

/**
 * Port of `halfEllipseContainsPoint()` (`SequenceChart.java:5259`) — kept for U5 (see
 * this file's header); NOT used by `hitTest()` below yet. `quarter`: `0` = left half,
 * `1` = right half, anything else = full ellipse width (bounding-box only; the ring
 * test always uses the full ellipse regardless of `quarter`, faithfully matching Java).
 */
export function halfEllipseContainsPoint(quarter: number, x1: number, x2: number, y: number, height: number, px: number, py: number, tolerance = HIT_TOLERANCE): boolean {
  const tol = tolerance + 1;
  const xm = (x1 + x2) / 2;
  let x: number;
  let width: number;
  if (quarter === 0) {
    x = x1;
    width = (x2 - x1) / 2;
  } else if (quarter === 1) {
    x = xm;
    width = (x2 - x1) / 2;
  } else {
    x = x1;
    width = x2 - x1;
  }

  const rectX0 = Math.min(x, x + width) - tol;
  const rectX1 = Math.max(x, x + width) + tol;
  const rectY0 = y - height - tol;
  const rectY1 = y + tol;
  if (px < rectX0 || px > rectX1 || py < rectY0 || py > rectY1) return false;

  const rx = Math.abs(x1 - x2) / 2;
  const ry = height;
  if (rx === 0) return true;
  const dxNorm = ((xm - px) * ry) / rx;
  const dy = y - py;
  const distSquare = dxNorm * dxNorm + dy * dy;
  return distSquare < (ry + tol) * (ry + tol) && distSquare > (ry - tol) * (ry - tol);
}

// ---------------------------------------------------------------------------------
// hitTest() -- scans a rendered DrawPrimitive[] (see this file's DEVIATION note)
// ---------------------------------------------------------------------------------

function arrowRefToHit(ref: ArrowRef): HitObject {
  return ref.kind === 'dependency'
    ? { kind: 'dependency', dependencyKind: ref.dependencyKind, causeEventNumber: ref.causeEventNumber, consequenceEventNumber: ref.consequenceEventNumber, causeTc: ref.causeTc, consequenceTc: ref.consequenceTc }
    : { kind: 'methodCall', eventNumber: ref.eventNumber, sourceModuleId: ref.sourceModuleId, targetModuleId: ref.targetModuleId, tc: ref.tc };
}

function hitKey(hit: HitObject): string {
  switch (hit.kind) {
    case 'event':
      return `event:${hit.eventNumber}`;
    case 'dependency':
      return `dep:${hit.dependencyKind}:${hit.causeEventNumber}:${hit.consequenceEventNumber}`;
    case 'methodCall':
      return `call:${hit.eventNumber}:${hit.sourceModuleId}:${hit.targetModuleId}:${hit.tc}`;
    case 'axis':
      return `axis:${hit.moduleId}`;
    case 'timestamp':
      return `ts:${hit.tc}`;
  }
}

export interface HitTestParams {
  /** The exact primitive list the current frame was drawn from (`drawList.ts`'s output). */
  primitives: DrawPrimitive[];
  /** Query point, in the SAME coordinate space as the primitives (canvas CSS px, gutters already baked in — see `drawList.ts`'s header). */
  px: number;
  py: number;
  /**
   * Timeline coordinate under `px` (caller's `pixelToTc(px - GUTTER_LEFT_WIDTH, viewport)`),
   * or `null` to suppress the `'timestamp'` fallback entirely (Java: only appended "if
   * zoomed in", i.e. `pixelsPerTc !== 0` — a caller with a degenerate/zero scale passes
   * `null`). When provided, a `'timestamp'` hit is always included (Java appends it
   * unconditionally otherwise, regardless of x — it's the lowest-priority catch-all).
   */
  pointerTc: number | null;
}

/** Every object under `(px, py)`, in no particular order (duplicates by identity collapsed — see `hitKey()`). Use `pickPrimary`/`pickPrimaryGroup` for click/tooltip semantics. */
export function hitTest(params: HitTestParams): HitObject[] {
  const { primitives, px, py, pointerTc } = params;
  const hits: HitObject[] = [];
  const seen = new Set<string>();
  const push = (hit: HitObject): void => {
    const key = hitKey(hit);
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(hit);
  };

  for (const p of primitives) {
    switch (p.kind) {
      case 'eventMark':
      case 'selfEventMark':
        if (eventSymbolContainsPoint(px, py, p.x, p.x, p.y)) push({ kind: 'event', eventNumber: p.eventNumber, moduleId: p.moduleId });
        break;
      case 'arrow':
        if (p.ref && lineContainsPoint(p.x1, p.y1, p.x2, p.y2, px, py)) push(arrowRefToHit(p.ref));
        break;
      case 'ellipseArc':
        // Phase U5: self-message half/quarter ellipse -- the real `halfEllipseContainsPoint()` port
        // (this file's header used to note it was ported-but-unused; it is now live).
        if (p.ref && halfEllipseContainsPoint(p.quarter, p.x1, p.x2, p.y, p.height, px, py)) push(arrowRefToHit(p.ref));
        break;
      case 'axisLine':
        if (py >= p.y - HIT_TOLERANCE && py <= p.y + p.lineHeight + HIT_TOLERANCE) push({ kind: 'axis', moduleId: p.moduleId });
        break;
      case 'axisLabel':
        // the pinned label is also clickable for its axis, independent of the (possibly scrolled-off) axis line itself
        if (Math.abs(py - p.y) <= EVENT_HIT_TOLERANCE) push({ kind: 'axis', moduleId: p.moduleId });
        break;
      default:
        break;
    }
  }

  if (pointerTc !== null) push({ kind: 'timestamp', tc: pointerTc });
  return hits;
}

/** First hit of the top-priority category present (see `PRIORITY_ORDER`). Used for tooltips, double-click, and as the basis of click-group selection. */
export function pickPrimary(hits: HitObject[]): HitObject | undefined {
  for (const kind of PRIORITY_ORDER) {
    const hit = hits.find((h) => h.kind === kind);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * ALL hits sharing the top-priority category (Java's mouseUp operates on this whole
 * group, not just the first match — e.g. two overlapping events both get
 * selected/toggled by one click). Empty if `hits` is empty.
 */
export function pickPrimaryGroup(hits: HitObject[]): HitObject[] {
  for (const kind of PRIORITY_ORDER) {
    const group = hits.filter((h) => h.kind === kind);
    if (group.length > 0) return group;
  }
  return [];
}

/**
 * Double-click cascade (`SequenceChart.java:5954`, verified — deliberately SHORTER
 * and in a DIFFERENT order than the click cascade above): dependency (zoom-to-message)
 * first, then axis (open-module, U8 stub — see `chartMain.ts`). Event/method-call
 * double-clicks have no Java-side action and are simply no-ops here.
 */
export function pickDoubleClickTarget(hits: HitObject[]): HitObject | undefined {
  return hits.find((h) => h.kind === 'dependency') ?? hits.find((h) => h.kind === 'axis');
}
