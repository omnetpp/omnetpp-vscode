/**
 * viewportState.ts — the chart's local, purely client-side view-transform state
 * (horizontal pan/zoom + vertical axis scroll) plus the `followEnd` flag.
 *
 * Port intent: SequenceChart.java keeps `fixPointViewportCoordinate` (a pixel x) +
 * `pixelPerTimelineUnit` (a scale) and derives the visible timeline-coordinate range
 * from those two plus the viewport width. This module keeps the algebraically
 * equivalent (and simpler to reason about) `leftTc` (the timeline coordinate at the
 * left edge of the *content* area) + `pixelsPerTc` instead of a "fix point" — every
 * place Java recomputes `fixPointViewportCoordinate` on a pan/zoom, this recomputes
 * `leftTc`. All actual pixel<->tc/simtime math is pure and lives in coords.ts; this
 * module only owns the state + the small set of state-transition operations a caller
 * (chartMain.ts/interactions.ts) drives.
 *
 * `followEnd` semantics (SequenceChart.java, verified by reading the source):
 *  - set to `true` **only** by `scrollToEnd()`/`gotoEnd()` (`gotoEnd()` in this port).
 *  - set to `false` by any manual/programmatic scroll: `scrollHorizontalTo`
 *    (drag pan), `horizontalScrollBarChanged` (scrollbar drag/click), and
 *    `scrollToEvent` (any reveal/goto, including the one `scrollToEnd()` itself
 *    calls internally *before* re-setting `followEnd = true` at the very end — so
 *    the net effect of `gotoEnd()` is still `followEnd = true`).
 *  - zoom (`zoomBy`) is NOT mentioned as touching `followEnd` in the Java source —
 *    ported as "zoom preserves followEnd".
 *  - on `elog/changed`(appended): if `followEnd`, re-run gotoEnd(); otherwise leave
 *    the viewport alone (Java: `eventLogChanged()`).
 */

/** CSS px reserved on the left for axis labels — pinned, does not pan horizontally (Java: axis header column). */
export const GUTTER_LEFT_WIDTH = 160;
/** CSS px reserved at the top for the simtime ruler — pans horizontally with content, fixed vertically (Java: `drawGutters`). */
export const GUTTER_TOP_HEIGHT = 24;
/** Java `SequenceChartStyleProvider.axisOffset` — px gap before the first axis and reserved below the last. */
export const AXIS_OFFSET = 20;
/** Approximation of the label font's line height (Java uses the actual font metrics; we don't have those synchronously in a worker-free pure module). */
export const FONT_HEIGHT_PX = 14;

export const DEFAULT_PIXELS_PER_TC = 50;
export const MIN_PIXELS_PER_TC = 1e-9;
export const MAX_PIXELS_PER_TC = 1e9;

export interface ViewportState {
  /** Timeline coordinate at the left edge of the content area (i.e. excluding GUTTER_LEFT_WIDTH). */
  leftTc: number;
  /** CSS pixels per timeline-coordinate unit (horizontal zoom level). */
  pixelsPerTc: number;
  /** Full canvas size in CSS px (including both gutters). */
  canvasWidth: number;
  canvasHeight: number;
  /** Vertical scroll offset, in CSS px, of the axis stack (0 = first axis flush with the top of the content area). */
  vscroll: number;
  /** See this file's header. */
  followEnd: boolean;
  /** Last coordinate-system version this viewport was computed against — shared stale-response guard with renderModelCache.ts. */
  coordinateSystemVersion: number;
}

export function createViewportState(): ViewportState {
  return {
    leftTc: 0,
    pixelsPerTc: DEFAULT_PIXELS_PER_TC,
    canvasWidth: 0,
    canvasHeight: 0,
    vscroll: 0,
    followEnd: false,
    coordinateSystemVersion: -1,
  };
}

/** Width of the content (pannable) area, in CSS px — the canvas minus the left gutter. */
export function contentWidth(v: ViewportState): number {
  return Math.max(0, v.canvasWidth - GUTTER_LEFT_WIDTH);
}

/** Height of the content (axis-stack) area, in CSS px — the canvas minus the top gutter. */
export function contentHeight(v: ViewportState): number {
  return Math.max(0, v.canvasHeight - GUTTER_TOP_HEIGHT);
}

/** Visible timeline-coordinate range of the content area (`[leftTc, rightTc]`). */
export function visibleTcRange(v: ViewportState): { leftTc: number; rightTc: number } {
  return { leftTc: v.leftTc, rightTc: v.leftTc + contentWidth(v) / v.pixelsPerTc };
}

/** Pan so `leftTc` becomes the new left edge. Clears `followEnd` (any manual scroll does, per this file's header) unless `preserveFollowEnd` is passed (used internally by `gotoEnd`/zoom). */
export function panTo(v: ViewportState, leftTc: number, preserveFollowEnd = false): ViewportState {
  return { ...v, leftTc, followEnd: preserveFollowEnd ? v.followEnd : false };
}

/** Pan by a timeline-coordinate delta (drag pan / arrow keys / PgUp-PgDn). Clears `followEnd`. */
export function panBy(v: ViewportState, deltaTc: number): ViewportState {
  return panTo(v, v.leftTc + deltaTc);
}

function clampScale(pixelsPerTc: number): number {
  return Math.min(MAX_PIXELS_PER_TC, Math.max(MIN_PIXELS_PER_TC, pixelsPerTc));
}

/**
 * Zoom so `anchorTc` (a timeline coordinate) stays under the same CSS-px content-area
 * x-offset (`anchorContentX`) after rescaling by `factor`. Port of `zoomBy()`'s
 * "recompute the center's simtime, rescale, then re-pin it" dance, generalized to an
 * arbitrary anchor point (Java's `zoomIn`/`zoomOut` always anchor at viewport center;
 * this port's ctrl+wheel handler additionally anchors at the cursor — a deliberate,
 * documented UX improvement over Java, which only ever zooms around center).
 * Preserves `followEnd` (Java's `zoomBy` never touches it).
 */
export function zoomAt(v: ViewportState, anchorContentX: number, factor: number): ViewportState {
  const pixelsPerTc = clampScale(v.pixelsPerTc * factor);
  const anchorTc = v.leftTc + anchorContentX / v.pixelsPerTc;
  const leftTc = anchorTc - anchorContentX / pixelsPerTc;
  return { ...v, leftTc, pixelsPerTc, followEnd: v.followEnd };
}

/** Zoom around the content-area center (toolbar zoom buttons / `+`/`-` keys — matches Java's `zoomIn`/`zoomOut` exactly). */
export function zoomAtCenter(v: ViewportState, factor: number): ViewportState {
  return zoomAt(v, contentWidth(v) / 2, factor);
}

/** Vertical axis-stack scroll, clamped to `[0, maxScroll]` (caller computes `maxScroll` from the axis layout — see axes.ts). Does not touch `followEnd` (Java's vertical scroll is orthogonal to the horizontal-only `followEnd` flag). */
export function scrollVerticalTo(v: ViewportState, vscroll: number, maxScroll: number): ViewportState {
  return { ...v, vscroll: Math.min(Math.max(0, maxScroll), Math.max(0, vscroll)) };
}

export function resize(v: ViewportState, canvasWidth: number, canvasHeight: number): ViewportState {
  return { ...v, canvasWidth, canvasHeight };
}

/**
 * `gotoEnd()`: pan so `endTc` sits at the right edge of the content area, and set
 * `followEnd = true` (port of `scrollToEnd()` — internally Java calls `scrollToEvent`,
 * which clears `followEnd`, and then sets it back to `true` itself; here we just set
 * it directly since there is no intermediate observable state in a pure function).
 */
export function gotoEndAt(v: ViewportState, endTc: number): ViewportState {
  const leftTc = endTc - contentWidth(v) / v.pixelsPerTc;
  return { ...v, leftTc, followEnd: true };
}

/** `gotoBegin()`/Home: pan so `beginTc` sits at the left edge. Clears `followEnd`. */
export function gotoBeginAt(v: ViewportState, beginTc: number): ViewportState {
  return panTo(v, beginTc);
}

/**
 * `scrollToEvent`/reveal: pan so `targetTc` sits at content-area x `atContentX`
 * (default: centered). Clears `followEnd` (Java: `scrollToEvent` always does, even
 * when reached via a "goto end" flow — see `gotoEndAt` above for the one case that
 * re-sets it after).
 */
export function revealAt(v: ViewportState, targetTc: number, atContentX?: number): ViewportState {
  const x = atContentX ?? contentWidth(v) / 2;
  return panTo(v, targetTc - x / v.pixelsPerTc);
}
