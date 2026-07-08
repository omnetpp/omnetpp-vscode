/**
 * svgExport.ts (PURE) -- Sequence Chart "Export to SVG..." (phase U9), port of
 * `SequenceChartContributor.createExportToSVGAction()`
 * (`SequenceChartContributor.java:2196-2405`, read in full): lets the user pick which
 * part of the chart to export (a range between two selected events / the currently
 * visible area / the whole event log, plus symmetric "extra space" padding in px --
 * `ExportToSVGDialog`'s three radios + its "extra space" field, ported exactly), then
 * serializes the SAME `DrawPrimitive[]` list (`drawList.ts`) the on-screen canvas
 * renderer already draws from -- through `SvgBuilder` (`@omnetpp/shared/preview`,
 * browser-safe, string-based, no DOM) -- into a standalone SVG document string.
 * `chartMain.ts`/`exportDialog.ts` own the DOM (the range-choice dialog, the engine
 * round trip for the export range's own viewport, building a throwaway "export
 * viewport" fed through the EXACT SAME `buildDrawList()` the live chart uses) and post
 * the result as a `{type:'export', format:'svg', ...}` `uiProtocol` message -- the
 * host-side save-dialog/write-file flow already exists (`sequenceChartEditor.ts`'s
 * `handleExport()`, added forward-looking in phase U1), unchanged.
 *
 * FIDELITY -- every `DrawPrimitive` kind the on-screen renderer draws is vectorized
 * here EXCEPT `'moduleAction'` (the axis expand/collapse/close hotspot glyphs -- pure
 * interactive chart chrome with no meaning in a static export; Java's own export never
 * draws its equivalent `ModuleAction` icons into the SVG either). Self-message ellipse
 * arcs (`'ellipseArc'`) are emitted as short polyline approximations (a handful of
 * straight segments sampled through the arc's own angle range) rather than a true SVG
 * elliptical-arc (`A`) command -- DOCUMENTED SIMPLIFICATION: correctly disambiguating
 * an `A` command's large-arc/sweep flags for an ARBITRARY start/end angle pair (this
 * port's arcs span anywhere from a small hump to a full 180° half-ellipse) is fiddly to
 * get provably right without a live renderer to visually verify against; a 24-segment
 * polyline is unambiguous by construction and, at the ~20px radii these humps are drawn
 * at, visually indistinguishable from a true arc. UNLIKE Java (which explicitly
 * disables axis headers for SVG export -- `SequenceChart.java`'s own comment "NOTE: SVG
 * graphics doesn't support text rotation", because its `GraphicsSVG` backend cannot
 * rotate text), rotated labels (axis header text, method-call names) DO render
 * correctly here via SVG's native `transform="rotate(...)"` support, so headers stay ON
 * during this port's export -- a fidelity IMPROVEMENT over the Java original, not a gap.
 * Dash arrays, per-primitive stroke/fill colors, and font family/size all round-trip
 * exactly as drawn on screen.
 */

import { SvgBuilder, fmt } from '@omnetpp/shared/preview';
import type { DrawPrimitive } from './drawList';
import type { LineSegment } from './arrowGeometry';

// ---------------------------------------------------------------------------------
// Export range resolution (`ExportToSVGDialog`'s three radios + extra-space field)
// ---------------------------------------------------------------------------------

/** The three range choices `ExportToSVGDialog` offers, in the SAME order Java lists its radio buttons. */
export type ExportRangeKind = 'selected' | 'visible' | 'whole';

export interface ExportRangeContext {
  /** The currently visible tc range (`viewportState.ts`'s `visibleTcRange()`). */
  visibleLeftTc: number;
  visibleRightTc: number;
  /** The whole event log's tc span, or `null` if unknown/empty (disables `'whole'`). */
  wholeBeginTc: number | null;
  wholeEndTc: number | null;
  /**
   * The two currently-selected events' tc, ascending -- Java's `case 0` requires
   * `sequenceChart.getSelectedEvents().size() == 2` (`ExportToSVGDialog`'s "Range of
   * two selected events" radio is disabled otherwise, `SequenceChartContributor.
   * java:2357`); `undefined` here means the same thing (disables `'selected'`).
   */
  selectedTcs?: [number, number];
  /** Current zoom, for converting the extra-space px padding to a tc delta. */
  pixelsPerTc: number;
  /** `ExportToSVGDialog`'s "Extra space in pixels around both ends" field. */
  extraSpacePx: number;
}

export interface ResolvedExportRange {
  tcBegin: number;
  tcEnd: number;
}

/** `true` iff `kind` has the data it needs available (drives the export dialog's radio-button `disabled` state). */
export function isExportRangeAvailable(kind: ExportRangeKind, ctx: Pick<ExportRangeContext, 'selectedTcs' | 'wholeBeginTc' | 'wholeEndTc'>): boolean {
  switch (kind) {
    case 'selected':
      return ctx.selectedTcs !== undefined;
    case 'whole':
      return ctx.wholeBeginTc !== null && ctx.wholeEndTc !== null;
    case 'visible':
      return true;
  }
}

/**
 * Resolves `kind` to an absolute tc range, extra-space-padded (Java: `exportBeginX -
 * extraSpace` / `exportEndX + extraSpace`, in viewport PIXELS -- here expressed in tc,
 * since this port's export builds its own throwaway viewport rather than temporarily
 * scrolling the live one, so pixel deltas must be converted via the current zoom
 * first). Returns `null` iff `kind` is unavailable (see `isExportRangeAvailable()`) --
 * callers should have already disabled that choice in the UI, but this stays a total
 * function regardless (never throws on a stale/rebuilt-menu selection).
 */
export function resolveExportRange(kind: ExportRangeKind, ctx: ExportRangeContext): ResolvedExportRange | null {
  if (!isExportRangeAvailable(kind, ctx)) return null;
  const extraTc = ctx.pixelsPerTc > 0 ? ctx.extraSpacePx / ctx.pixelsPerTc : 0;
  let begin: number;
  let end: number;
  if (kind === 'selected') {
    [begin, end] = ctx.selectedTcs!;
  } else if (kind === 'whole') {
    begin = ctx.wholeBeginTc!;
    end = ctx.wholeEndTc!;
  } else {
    begin = ctx.visibleLeftTc;
    end = ctx.visibleRightTc;
  }
  return { tcBegin: begin - extraTc, tcEnd: Math.max(begin - extraTc, end + extraTc) };
}

/** Port plan U9 row: "a pixel cap with a warning" for the whole-chart choice on a huge log. Applies to any range choice (a wide "visible area" zoomed far out, or two very-far-apart selected events, could exceed it too). */
export const EXPORT_WIDTH_CAP_PX = 50_000;

export function computeExportWidthPx(range: ResolvedExportRange, pixelsPerTc: number): number {
  return Math.max(1, Math.round((range.tcEnd - range.tcBegin) * pixelsPerTc));
}

/** Whether `range` at `pixelsPerTc` needs the "this export is very wide, continue anyway?" confirmation before proceeding. */
export function exceedsExportWidthCap(range: ResolvedExportRange, pixelsPerTc: number): boolean {
  return computeExportWidthPx(range, pixelsPerTc) > EXPORT_WIDTH_CAP_PX;
}

// ---------------------------------------------------------------------------------
// SVG serialization
// ---------------------------------------------------------------------------------

export interface SvgExportParams {
  /** The already-built (for the export range/size) draw list -- see this file's header. */
  primitives: readonly DrawPrimitive[];
  widthPx: number;
  heightPx: number;
  backgroundColor: string;
  /** Resolved once by the caller (`getComputedStyle(document.body).fontFamily` or similar) -- this module is DOM-free/pure. */
  fontFamily: string;
}

function textAnchor(align: 'left' | 'center' | 'right' | undefined): string {
  switch (align) {
    case 'center':
      return 'middle';
    case 'right':
      return 'end';
    default:
      return 'start';
  }
}

function dashArray(dash: number[] | undefined): string | undefined {
  return dash && dash.length > 0 ? dash.join(',') : undefined;
}

/** Polyline approximation of an ellipse arc from `startAngle` to `endAngle` (canvas/SVG's shared y-down, clockwise-increasing angle convention) -- see this file's header for why a true SVG `A` command is deliberately avoided here. */
function ellipseArcPolylinePath(cx: number, cy: number, rx: number, ry: number, startAngle: number, endAngle: number, segments = 24): string {
  const parts: string[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = startAngle + ((endAngle - startAngle) * i) / segments;
    const x = cx + rx * Math.cos(t);
    const y = cy + ry * Math.sin(t);
    parts.push(`${i === 0 ? 'M' : 'L'} ${fmt(x)} ${fmt(y)}`);
  }
  return parts.join(' ');
}

/** One `<path>` `d` string covering every (independent, possibly-disjoint) segment of a filtered-dependency "zigzag" sign -- each segment is its own `M...L...` subpath. */
function zigzagPath(segments: readonly LineSegment[]): string {
  return segments.map((s) => `M ${fmt(s.x1)} ${fmt(s.y1)} L ${fmt(s.x2)} ${fmt(s.y2)}`).join(' ');
}

/** Java's `HEADER_BOX_WIDTH`-equivalent constant (mirrors `canvasStack.ts`'s own, kept in sync by hand since this module must stay DOM/canvas-import-free). */
const HEADER_BOX_WIDTH = 9;

function emitPrimitive(b: SvgBuilder, p: DrawPrimitive, fontFamily: string): void {
  switch (p.kind) {
    case 'gutter':
    case 'regionBand':
      b.el('rect', { x: p.x, y: p.y, width: p.w, height: p.h, fill: p.color });
      return;
    case 'axisLine':
      b.el('line', { x1: p.x1, y1: p.y, x2: p.x2, y2: p.y, stroke: p.color, 'stroke-width': p.lineHeight });
      return;
    case 'axisVectorStrip': {
      // Multi-color step bar centered on the axis line (see canvasStack.ts).
      const top = p.y - p.height / 2;
      const bot = top + p.height;
      for (const seg of p.segments) {
        const w = Math.max(1, seg.x2 - seg.x1);
        b.el('rect', { x: seg.x1, y: top, width: w, height: p.height, fill: seg.color });
        b.el('line', { x1: seg.x1, y1: top, x2: seg.x1, y2: bot, stroke: p.borderColor, 'stroke-width': 1 });
      }
      const first = p.segments[0];
      const last = p.segments[p.segments.length - 1];
      if (first && last) {
        b.el('line', { x1: first.x1, y1: top, x2: last.x2, y2: top, stroke: p.borderColor, 'stroke-width': 1 });
        b.el('line', { x1: first.x1, y1: bot, x2: last.x2, y2: bot, stroke: p.borderColor, 'stroke-width': 1 });
      }
      return;
    }
    case 'axisSelectionMark':
      b.el('line', { x1: p.x1, y1: p.y - 1, x2: p.x2, y2: p.y - 1, stroke: p.color, 'stroke-width': 1.5 });
      b.el('line', { x1: p.x1, y1: p.y + p.lineHeight, x2: p.x2, y2: p.y + p.lineHeight, stroke: p.color, 'stroke-width': 1.5 });
      return;
    case 'axisLabel':
      // Above the line (baseline 2px above), matching the canvas -- see canvasStack.ts.
      b.el('text', { x: p.x, y: p.y - 2, fill: p.color, 'font-size': 12, 'font-weight': p.bold ? 'bold' : 'normal', 'font-family': fontFamily, 'text-anchor': 'start', 'dominant-baseline': 'text-after-edge' }, p.text);
      return;
    case 'axisHeaderBox': {
      // Opaque compound-module band (p.color fill) with the rotated name.
      const h = Math.max(1, p.y1 - p.y0);
      b.el('rect', { x: p.x, y: p.y0, width: HEADER_BOX_WIDTH, height: h, fill: p.color, stroke: 'rgba(0,0,0,0.3)' });
      if (h > 20) {
        const cx = p.x + HEADER_BOX_WIDTH / 2;
        const cy = (p.y0 + p.y1) / 2;
        b.el(
          'text',
          { x: 0, y: 0, fill: p.textColor, 'font-size': 10, 'font-family': fontFamily, 'text-anchor': 'middle', 'dominant-baseline': 'middle', transform: `translate(${fmt(cx)} ${fmt(cy)}) rotate(-90)` },
          p.label,
        );
      }
      return;
    }
    case 'tick':
    case 'eventDensityLine':
      b.el('line', { x1: p.x, y1: p.y0, x2: p.x, y2: p.y1, stroke: p.color, 'stroke-width': 1 });
      return;
    case 'timelineMark':
      b.el('line', { x1: p.x, y1: p.y0, x2: p.x, y2: p.y1, stroke: p.color, 'stroke-width': 1.5 });
      return;
    case 'eventMark':
    case 'selfEventMark':
      // A rounded rect with rx=ry=radius is a stadium when wider than tall, a circle when
      // square -- so one element covers both the pill (begin!=end) and disc (begin==end)
      // cases (mirrors canvasStack.ts's `roundRect`/`arc` split).
      b.el('rect', { x: p.x - p.radius, y: p.y - p.radius, width: p.xEnd - p.x + 2 * p.radius, height: 2 * p.radius, rx: p.radius, ry: p.radius, fill: p.color });
      return;
    case 'arrow':
      b.el('line', { x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, stroke: p.color, 'stroke-width': p.width ?? 1, 'stroke-dasharray': dashArray(p.dash) });
      return;
    case 'arrowHead': {
      const backX = p.x - p.length * Math.cos(p.angle);
      const backY = p.y - p.length * Math.sin(p.angle);
      const perpX = (-Math.sin(p.angle) * p.width) / 2;
      const perpY = (Math.cos(p.angle) * p.width) / 2;
      const points = `${fmt(p.x)},${fmt(p.y)} ${fmt(backX + perpX)},${fmt(backY + perpY)} ${fmt(backX - perpX)},${fmt(backY - perpY)}`;
      b.el('polygon', { points, fill: p.color });
      return;
    }
    case 'ellipseArc': {
      const cx = (p.x1 + p.x2) / 2;
      const rx = Math.abs(p.x2 - p.x1) / 2;
      const ry = p.height;
      const dashAttr = p.dash ? { 'stroke-dasharray': p.dash.join(',') } : {};
      if (rx <= 0) {
        b.el('line', { x1: cx, y1: p.y - ry, x2: cx, y2: p.y, stroke: p.color, 'stroke-width': p.width ?? 1, ...dashAttr });
        return;
      }
      const [startAngle, endAngle] = p.quarter === 0 ? [Math.PI, 1.5 * Math.PI] : p.quarter === 1 ? [1.5 * Math.PI, 2 * Math.PI] : [Math.PI, 2 * Math.PI];
      b.el('path', { d: ellipseArcPolylinePath(cx, p.y, rx, ry, startAngle, endAngle), stroke: p.color, fill: 'none', 'stroke-width': p.width ?? 1, ...dashAttr });
      return;
    }
    case 'parallelogram': {
      const points = p.points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' ');
      b.el('polygon', { points, fill: p.color, 'fill-opacity': 0.25 });
      return;
    }
    case 'zigzag':
      b.el('path', { d: zigzagPath(p.segments), stroke: p.color, fill: 'none', 'stroke-width': 1 });
      return;
    case 'label':
      if (p.rotateDeg) {
        b.el(
          'text',
          { x: 0, y: 0, fill: p.color, 'font-size': 12, 'font-family': fontFamily, 'text-anchor': textAnchor(p.align), 'dominant-baseline': 'middle', transform: `translate(${fmt(p.x)} ${fmt(p.y)}) rotate(${fmt(p.rotateDeg)})` },
          p.text,
        );
      } else {
        b.el('text', { x: p.x, y: p.y, fill: p.color, 'font-size': 12, 'font-family': fontFamily, 'text-anchor': textAnchor(p.align), 'dominant-baseline': 'middle' }, p.text);
      }
      return;
    case 'timeDifferenceLabel':
      b.el('text', { x: p.x, y: p.y, fill: p.color, 'font-size': 11, 'font-family': fontFamily, 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, p.text);
      return;
    case 'infoPanel': {
      // No canvas to measure with here (export path); estimate the width from the longest
      // line at ~6px/char -- exact pixel width only matters for the live canvas overlay.
      const lineH = 15;
      const textW = Math.max(0, ...p.lines.map((l) => l.length * 6));
      const w = textW + 12;
      const h = p.lines.length * lineH + 6;
      const x = p.rightX - w - 4;
      const y = p.edge === 'top' ? p.anchorY + 2 : p.anchorY - h - 2;
      b.el('rect', { x, y, width: w, height: h, fill: p.background, stroke: p.color });
      for (let i = 0; i < p.lines.length; i++) {
        b.el('text', { x: x + 6, y: y + 3 + i * lineH, fill: p.color, 'font-size': 11, 'font-family': fontFamily, 'text-anchor': 'start', 'dominant-baseline': 'hanging' }, p.lines[i]);
      }
      return;
    }
    case 'selectionMark':
      b.el('rect', { x: p.x - p.radius, y: p.y - p.radius, width: p.xEnd - p.x + 2 * p.radius, height: 2 * p.radius, rx: p.radius, ry: p.radius, stroke: p.color, fill: 'none', 'stroke-width': 2 });
      return;
    case 'bookmarkMark': {
      const poleHeight = 8;
      const flagWidth = 6;
      b.el('line', { x1: p.x, y1: p.y - poleHeight, x2: p.x, y2: p.y, stroke: p.color, 'stroke-width': 1 });
      const points = `${fmt(p.x)},${fmt(p.y - poleHeight)} ${fmt(p.x + flagWidth)},${fmt(p.y - poleHeight + flagWidth / 2)} ${fmt(p.x)},${fmt(p.y - poleHeight + flagWidth)}`;
      b.el('polygon', { points, fill: p.color });
      return;
    }
    case 'tickPrefixBox': {
      // The shared time offset ("+ 1s"); exported so the relative ("+150ms") tick labels
      // have context. Width estimated at ~6px/char (no canvas to measure with here).
      const boxW = p.label.length * 6 + 8;
      const boxH = 15;
      const x = p.rightX - boxW - 1;
      b.el('rect', { x, y: 3, width: boxW, height: boxH, fill: p.bgColor, stroke: p.color });
      b.el('text', { x: x + boxW / 2, y: 3 + boxH / 2, fill: p.textColor, 'font-size': 11, 'font-weight': 'bold', 'font-family': fontFamily, 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, p.label);
      return;
    }
    case 'moduleAction':
    case 'mouseTick':
      // Interactive-only chart chrome (glyph hotspots / the live mouse-time hairline) --
      // not exported, see this file's header.
      return;
  }
}

/** Builds a standalone SVG document string from `params.primitives` -- see this file's header for the fidelity notes. */
export function buildChartSvg(params: SvgExportParams): string {
  const { primitives, widthPx, heightPx, backgroundColor, fontFamily } = params;
  const b = new SvgBuilder();
  b.open('svg', { xmlns: 'http://www.w3.org/2000/svg', width: widthPx, height: heightPx, viewBox: `0 0 ${fmt(widthPx)} ${fmt(heightPx)}` });
  b.el('rect', { x: 0, y: 0, width: widthPx, height: heightPx, fill: backgroundColor });
  for (const p of primitives) emitPrimitive(b, p, fontFamily);
  b.close();
  return b.toString();
}
