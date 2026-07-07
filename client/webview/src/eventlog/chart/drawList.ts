/**
 * drawList.ts (PURE) — `(events, dependencies, methodCalls, axesLayout, ticks,
 * viewport, theme, displayFlags) -> DrawPrimitive[]`, in absolute CANVAS px (gutters
 * already baked in) so `canvasStack.ts` is a dumb executor with no layout knowledge of
 * its own. This is the only place that knows the two-gutter layout (top: simtime
 * ruler, left: axis labels/headers — see `viewportState.ts`'s `GUTTER_LEFT_WIDTH`/
 * `GUTTER_TOP_HEIGHT`).
 *
 * Phase U5 fully replaces phase U3/U4's straight-line-only / hairpin-placeholder
 * arrows with `arrowGeometry.ts`'s ported shapes — see that file's header for the
 * exact Java line references and per-shape fidelity notes (self-message half-ellipses,
 * long-arrow ellipses, split offscreen arrows, transmission-duration parallelograms,
 * filtered zigzag signs). This file's own job is purely the PER-DEPENDENCY WIRING:
 * resolving pixel endpoints/axis rows, gating by `ChartDisplayFlags`, and turning
 * `arrowGeometry.ts`'s geometry description into `DrawPrimitive`s.
 *
 * `VLineBuffer` port: two independent dedupe passes over near-vertical geometry, both
 * keyed by a rounded-to-1px x "column" (Java keys by exact SWT integer pixel; a
 * rounding bucket is the closest continuous-coordinate equivalent):
 *  1. Near-vertical arrow segments (`|x1-x2| < 1px`): exact interval-containment
 *     dedupe, faithful to `VLineBuffer.vlineContainsNewPixel()`
 *     (`SequenceChart.java:6415-6487`) — SIMPLIFICATION: Java only tracks the single
 *     MOST RECENT x column (a `currentX` pointer + reset-on-change), relying on
 *     same-x calls being naturally consecutive because arrows are drawn in a single
 *     left-to-right pass; this port's primitives are built in EVENT-NUMBER order (not
 *     x order), so same-x items are not guaranteed adjacent — a persistent
 *     `Map<xKey, intervals[]>` is used instead. Same dedup RESULT, just without Java's
 *     single-slot memory optimization. Applies to plain vertical arrows AND method
 *     calls (both are near-vertical geometry Java itself runs through the same
 *     `VLineBuffer`).
 *  2. Dense event-mark columns (an extension in the spirit of "dedupe near-vertical
 *     hairlines at the same x", applied to marks instead of arrows): once a column
 *     exceeds `MAX_EVENT_MARKS_PER_COLUMN`, further individual `eventMark`/
 *     `selfEventMark` primitives at that column are dropped and replaced by one
 *     `eventDensityLine` primitive spanning the column's observed y-range.
 */

import { TimelineMode, type RenderDependency, type RenderMethodCall, type TimelineEvent } from '@omnetpp/shared/elog-protocol';
import {
  adjustEndpointsForEventRadius,
  ARROWHEAD_LENGTH,
  ARROWHEAD_WIDTH,
  buildFilteredSignSegments,
  computeLineArrowGeometry,
  computeSelfArrowGeometry,
  EVENT_RADIUS,
  type LineEndpoint,
  type LineSegment,
} from './arrowGeometry';
import type { AxisHeaderNode } from './axisHeaders';
import { flattenDrawableAxisHeaders } from './axisHeaders';
import { subtractDecimalStrings, formatSimulationTime, isNegativeDecimal } from '../common/decimalTime';
import type { EventLogPalette } from '../common/theme';
import type { AxisInfo, AxesLayout } from './axes';
import { clipCoordinate, tcToPixel } from './coords';
import { DEFAULT_DISPLAY_FLAGS, type ChartDisplayFlags } from './displayFlags';
import type { Tick } from './ticks';
import { computeZeroSimTimeRegions } from './zeroSimTimeRegions';
import { GUTTER_LEFT_WIDTH, GUTTER_TOP_HEIGHT, type ViewportState } from './viewportState';

export { EVENT_RADIUS };
export const HEADER_LEVEL_WIDTH = 10;
export const MAX_HEADER_LEVELS_SHOWN = 4;
export const MAX_EVENT_MARKS_PER_COLUMN = 20;

export type ArrowKind = 'send' | 'reuse' | 'filtered' | 'method';

/**
 * Stable identity carried by arrow primitives so `hitTest.ts` can report WHAT was hit
 * without re-deriving it from pixel geometry. A message dependency's identity is its
 * `(kind, causeEventNumber, consequenceEventNumber)` triple (the protocol has no
 * separate dependency id); a method call's is `(eventNumber, sourceModuleId,
 * targetModuleId, tc)`.
 */
export type ArrowRef =
  | { kind: 'dependency'; dependencyKind: ArrowKind & ('send' | 'reuse' | 'filtered'); causeEventNumber: number; consequenceEventNumber: number; causeTc: number; consequenceTc: number }
  | { kind: 'methodCall'; eventNumber: number; sourceModuleId: number; targetModuleId: number; tc: number };

export type DrawPrimitive =
  | { kind: 'gutter'; part: 'top' | 'left'; x: number; y: number; w: number; h: number; color: string }
  | { kind: 'regionBand'; x: number; y: number; w: number; h: number; color: string }
  | { kind: 'axisLine'; moduleId: number; x1: number; x2: number; y: number; lineHeight: number; color: string }
  | { kind: 'axisLabel'; moduleId: number; x: number; y: number; text: string; color: string }
  | { kind: 'axisHeaderBox'; x: number; y0: number; y1: number; label: string; color: string }
  | { kind: 'tick'; x: number; y0: number; y1: number; color: string }
  | { kind: 'eventMark'; eventNumber: number; moduleId: number; x: number; y: number; radius: number; color: string }
  | { kind: 'selfEventMark'; eventNumber: number; moduleId: number; x: number; y: number; radius: number; color: string }
  | { kind: 'eventDensityLine'; x: number; y0: number; y1: number; color: string }
  | { kind: 'arrow'; arrowKind: ArrowKind; x1: number; y1: number; x2: number; y2: number; color: string; dash?: number[]; ref?: ArrowRef }
  | { kind: 'arrowHead'; x: number; y: number; angle: number; color: string; length: number; width: number }
  | { kind: 'ellipseArc'; x1: number; x2: number; y: number; height: number; quarter: 0 | 1 | -1; color: string; ref?: ArrowRef }
  | { kind: 'parallelogram'; points: [[number, number], [number, number], [number, number], [number, number]]; color: string }
  | { kind: 'zigzag'; segments: LineSegment[]; color: string }
  | { kind: 'label'; x: number; y: number; text: string; color: string; align?: 'left' | 'center' | 'right'; rotateDeg?: number }
  | { kind: 'timeDifferenceLabel'; x: number; y: number; text: string; color: string }
  | { kind: 'infoPanel'; x: number; y: number; w: number; h: number; lines: string[]; background: string; color: string; align: 'right' }
  /** Phase U4 — a selection ring around a selected event. */
  | { kind: 'selectionMark'; x: number; y: number; radius: number; color: string }
  /**
   * Phase U6 — a bookmark mark: a small filled "flag" glyph, port of Eclipse's
   * bookmark ring/flag decoration on the event mark (`IMarker.BOOKMARK`'s default
   * annotation, ported loosely -- the exact Eclipse ruler icon isn't reproduced, just a
   * small, consistently-colored flag shape). Reused verbatim for event/axis/
   * dependency bookmarks -- only the `(x, y)` anchor differs per caller (see
   * `buildDrawList()`'s three call sites below).
   */
  | { kind: 'bookmarkMark'; x: number; y: number; color: string };

/** Colors this module needs beyond `EventLogPalette` (reuse/filtered-dependency dash colors, the "long" arrowhead color) — derived locally from the imported palette rather than editing `common/theme.ts` (out of this phase's file ownership). */
export function deriveArrowColors(theme: EventLogPalette): Record<ArrowKind, string> {
  return {
    send: theme.arrowColor,
    reuse: theme.isDark ? '#6fcf6f' : '#008b00',
    filtered: theme.isDark ? '#5fd0d0' : '#008b8b',
    method: theme.methodCallColor,
  };
}

/** Per-`FilteredDependencyKind` line color/dash — port of `SequenceChartStyleProvider.getMessageDependencyColor()`/`getMessageDependencyLineDash()` (verified: `sends`=solid/send-color, `reuses`=dotted `[2,2]`/reuse-color, `mixed`=dashed `[4,4]`/a distinct cyan). */
function filteredColorAndDash(arrowColors: Record<ArrowKind, string>, filteredKind: RenderDependency['filteredKind']): { color: string; dash: number[] | undefined } {
  switch (filteredKind) {
    case 'sends':
      return { color: arrowColors.send, dash: undefined };
    case 'reuses':
      return { color: arrowColors.reuse, dash: [2, 2] };
    case 'mixed':
    default:
      return { color: arrowColors.filtered, dash: [4, 4] };
  }
}

const LONG_ARROWHEAD_COLOR = '#ffffff';
/** Java's `SWT.LINE_DOT` override for a split arrow's offscreen-continuation segment (`SequenceChart.java`'s several `graphics.setLineStyle(SWT.LINE_DOT)` calls) — distinct from any message-kind dash so a split arrow always reads as "continues off-window" regardless of send/reuse/filtered styling. */
const OFFSCREEN_DASH = [1, 2];

function axisRowY(axisY: number, viewport: ViewportState): number {
  return axisY - viewport.vscroll + GUTTER_TOP_HEIGHT;
}

function contentX(tc: number, viewport: ViewportState): number {
  return clipCoordinate(tcToPixel(tc, viewport) + GUTTER_LEFT_WIDTH);
}

/** Per-column near-vertical-segment dedupe — see this file's header, VLineBuffer port note. */
class VLineBuffer {
  private readonly columns = new Map<number, [number, number][]>();

  /** Returns `true` if `[y1,y2]` at `x` is new information worth drawing. */
  addAndCheck(x: number, y1: number, y2: number): boolean {
    const key = Math.round(x);
    const lo = Math.min(y1, y2);
    const hi = Math.max(y1, y2);
    let regions = this.columns.get(key);
    if (!regions) {
      regions = [];
      this.columns.set(key, regions);
    }
    for (let i = 0; i < regions.length; i++) {
      const [ry1, ry2] = regions[i];
      if (ry1 < hi && ry2 > lo) {
        if (ry1 <= lo && ry2 >= hi) return false; // fully contained already
        regions[i] = [Math.min(ry1, lo), Math.max(ry2, hi)];
        return true;
      }
    }
    regions.push([lo, hi]);
    return true;
  }
}

export const SELECTION_MARK_COLOR = '#ff3b30';
/** Eclipse's default `IMarker.BOOKMARK` ruler-annotation color (a muted blue) -- kept as a literal like the other Eclipse semantic data colors (see this port's Theming section). */
export const BOOKMARK_MARK_COLOR = '#4a90d9';

/**
 * Identity key for a `MessageDependency`-kind bookmark, matching `bookmarkStore.ts`'s
 * `bookmarkMatches()` field set exactly `(eventNumber [= cause], consequenceEventNumber,
 * messageId)` -- NOT `dependencyKey()` from `selection.ts` (which keys on `kind` instead
 * of `messageId`, a different identity notion used only for selection membership).
 * Exported so `chartMain.ts` builds the SAME key both when constructing a
 * `toggleBookmark` candidate and when computing `bookmarkedDependencyKeys` for this
 * module -- one definition, used both places, never drifting apart.
 */
export function bookmarkDependencyKey(eventNumber: number, consequenceEventNumber: number | undefined, messageId: number | null | undefined): string {
  return `${eventNumber}:${consequenceEventNumber ?? -1}:${messageId ?? -1}`;
}

export interface InfoPanelText {
  positionAndRange?: [string, string];
  eventLogInfo?: [string, string];
}

export interface BuildDrawListParams {
  timelineMode: TimelineMode;
  viewport: ViewportState;
  events: TimelineEvent[];
  dependencies: RenderDependency[];
  methodCalls: RenderMethodCall[];
  axesLayout: AxesLayout;
  ticks: Tick[];
  theme: EventLogPalette;
  /** Phase U4 — event numbers currently selected; each gets a `'selectionMark'` ring around its event mark, and (if `displayFlags.showTimeDifferences`) participates in the time-differences polyline. */
  selectedEventNumbers?: ReadonlySet<number>;
  /** Phase U6 — event numbers with an `'Event'`-kind bookmark; each gets a `'bookmarkMark'` flag near its event mark. */
  bookmarkedEventNumbers?: ReadonlySet<number>;
  /** Phase U6 — module ids with an `'Axis'`-kind bookmark (already resolved from the bookmark's stored `modulePath` -- see `chartMain.ts`'s `recomputeBookmarkIndexes()`); each gets a `'bookmarkMark'` at the start of its axis line. */
  bookmarkedModuleIds?: ReadonlySet<number>;
  /** Phase U6 — `MessageDependency`-kind bookmark identity keys (`${causeEventNumber}:${consequenceEventNumber}:${messageId}` -- see `chartMain.ts`'s `bookmarkDepKey()`, which both this and the toggle-candidate builder use so the two stay in sync); a matching dependency gets a `'bookmarkMark'` at its arrow's midpoint. */
  bookmarkedDependencyKeys?: ReadonlySet<string>;
  /** Phase U5 — the ~25 Show/Hide toggles (`displayFlags.ts`); defaults to `DEFAULT_DISPLAY_FLAGS` when omitted. */
  displayFlags?: ChartDisplayFlags;
  /** Phase U5 — merged axis-header tree (`axisHeaders.ts`'s `calculateAxisHeaders()`), or `null`/omitted for no headers (e.g. module tree not loaded yet). */
  axisHeaderRoot?: AxisHeaderNode | null;
  /** Phase U5 — `showPositionAndRange`/`showEventLogInfo` panel text, precomputed by the caller (needs `LogSummary`, which this pure module doesn't otherwise touch) — see this file's header. `undefined` = flag has nothing to show yet (panel simply omitted, not an error). */
  infoPanelText?: InfoPanelText;
  /** Phase U5 antialias auto-toggle perf gate ("drop labels first" — see this phase's report for the exact mapping): when `true`, message/method/event-number labels are skipped (arrows/marks/axes still draw in full). */
  skipLabelsForPerf?: boolean;
}

export function buildDrawList(params: BuildDrawListParams): DrawPrimitive[] {
  const { viewport, events, dependencies, methodCalls, axesLayout, ticks, theme, selectedEventNumbers, bookmarkedEventNumbers, bookmarkedModuleIds, bookmarkedDependencyKeys, axisHeaderRoot, infoPanelText, skipLabelsForPerf } = params;
  const flags = params.displayFlags ?? DEFAULT_DISPLAY_FLAGS;
  const primitives: DrawPrimitive[] = [];
  const arrowColors = deriveArrowColors(theme);
  const axisByModuleId = new Map(axesLayout.axes.map((a) => [a.moduleId, a]));
  const showLabels = !skipLabelsForPerf;

  // ---- zero-simulation-time regions (background bands, drawn first so everything else layers on top) ----
  if (flags.showZeroSimulationTimeRegions) {
    for (const region of computeZeroSimTimeRegions(events)) {
      const x0 = contentX(region.tcBegin, viewport);
      const x1 = contentX(region.tcEnd, viewport);
      if (x1 < GUTTER_LEFT_WIDTH || x0 > viewport.canvasWidth) continue;
      primitives.push({ kind: 'regionBand', x: Math.max(GUTTER_LEFT_WIDTH, x0), y: GUTTER_TOP_HEIGHT, w: Math.max(0, Math.min(viewport.canvasWidth, x1) - Math.max(GUTTER_LEFT_WIDTH, x0)), h: viewport.canvasHeight - GUTTER_TOP_HEIGHT, color: theme.isDark ? '#2a2a2a' : '#f0f0f0' });
    }
  }

  // ---- gutter backgrounds (drawn first, everything else on top) ----
  primitives.push({ kind: 'gutter', part: 'top', x: 0, y: 0, w: viewport.canvasWidth, h: GUTTER_TOP_HEIGHT, color: theme.background });
  primitives.push({ kind: 'gutter', part: 'left', x: 0, y: 0, w: GUTTER_LEFT_WIDTH, h: viewport.canvasHeight, color: theme.background });

  // ---- simtime ruler ticks (vertical hairlines spanning the content height; labels drawn separately as 'label') ----
  for (const tick of ticks) {
    const x = contentX(tick.tc, viewport);
    if (x < GUTTER_LEFT_WIDTH || x > viewport.canvasWidth) continue;
    primitives.push({ kind: 'tick', x, y0: GUTTER_TOP_HEIGHT, y1: viewport.canvasHeight, color: theme.border });
    primitives.push({ kind: 'label', x: x + 2, y: GUTTER_TOP_HEIGHT - 4, text: tick.label, color: theme.descriptionForeground, align: 'left' });
  }

  // ---- axis lines + pinned labels + merged headers ----
  const headerNodes = flags.showAxisHeaders ? flattenDrawableAxisHeaders(axisHeaderRoot ?? null) : [];
  const maxHeaderLevel = headerNodes.reduce((m, h) => Math.max(m, h.level), -1);
  const labelIndent = Math.min(maxHeaderLevel + 1, MAX_HEADER_LEVELS_SHOWN) * HEADER_LEVEL_WIDTH;

  if (flags.showAxes) {
    for (const axis of axesLayout.axes) {
      const y = axisRowY(axis.y, viewport);
      if (y < GUTTER_TOP_HEIGHT - axis.lineHeight || y > viewport.canvasHeight + axis.lineHeight) continue;
      primitives.push({ kind: 'axisLine', moduleId: axis.moduleId, x1: GUTTER_LEFT_WIDTH, x2: viewport.canvasWidth, y, lineHeight: axis.lineHeight, color: theme.foreground });
      if (flags.showAxisLabels) primitives.push({ kind: 'axisLabel', moduleId: axis.moduleId, x: 4 + labelIndent, y, text: axis.label, color: theme.foreground });
      if (bookmarkedModuleIds?.has(axis.moduleId)) primitives.push({ kind: 'bookmarkMark', x: GUTTER_LEFT_WIDTH - 6, y, color: BOOKMARK_MARK_COLOR });
    }
  }

  if (flags.showAxisHeaders && headerNodes.length > 0) {
    for (const header of headerNodes) {
      const level = Math.min(header.level, MAX_HEADER_LEVELS_SHOWN - 1);
      const firstAxis = axesLayout.axes[header.axisIndexStart];
      const lastAxis = axesLayout.axes[header.axisIndexStart + header.axisCount - 1];
      if (!firstAxis || !lastAxis) continue;
      const y0 = axisRowY(firstAxis.y, viewport) - firstAxis.lineHeight;
      const y1 = axisRowY(lastAxis.y, viewport) + lastAxis.lineHeight;
      if (y1 < GUTTER_TOP_HEIGHT || y0 > viewport.canvasHeight) continue;
      primitives.push({ kind: 'axisHeaderBox', x: 2 + level * HEADER_LEVEL_WIDTH, y0, y1, label: header.label, color: theme.isDark ? '#2f5060' : '#d7f2f2' });
    }
  }

  // ---- events (with dense-column capping) ----
  const columnDensity = new Map<number, { count: number; y0: number; y1: number }>();
  if (flags.showEventMarks) {
    for (const event of events) {
      const axis = axisByModuleId.get(event.moduleId);
      if (!axis) continue;
      if (!flags.showInitializationEvent && event.eventNumber === 0) continue;
      const y = axisRowY(axis.y, viewport);
      if (y < GUTTER_TOP_HEIGHT - EVENT_RADIUS || y > viewport.canvasHeight + EVENT_RADIUS) continue;
      const x = contentX(event.tcBegin, viewport);
      if (x < GUTTER_LEFT_WIDTH - EVENT_RADIUS || x > viewport.canvasWidth + EVENT_RADIUS) continue;

      const xKey = Math.round(x);
      let col = columnDensity.get(xKey);
      if (!col) {
        col = { count: 0, y0: y, y1: y };
        columnDensity.set(xKey, col);
      }
      col.count++;
      col.y0 = Math.min(col.y0, y);
      col.y1 = Math.max(col.y1, y);

      if (col.count <= MAX_EVENT_MARKS_PER_COLUMN) {
        primitives.push(
          event.isSelfMessageProcessingEvent
            ? { kind: 'selfEventMark', eventNumber: event.eventNumber, moduleId: event.moduleId, x, y, radius: EVENT_RADIUS, color: theme.isDark ? '#6fcf6f' : '#00ee00' }
            : { kind: 'eventMark', eventNumber: event.eventNumber, moduleId: event.moduleId, x, y, radius: EVENT_RADIUS, color: theme.eventColor },
        );
        if (flags.showEventNumbers && showLabels) primitives.push({ kind: 'label', x: x + 2, y: y + 10, text: `#${event.eventNumber}`, color: theme.descriptionForeground, align: 'left' });
        if (selectedEventNumbers?.has(event.eventNumber)) primitives.push({ kind: 'selectionMark', x, y, radius: EVENT_RADIUS + 3, color: SELECTION_MARK_COLOR });
        if (bookmarkedEventNumbers?.has(event.eventNumber)) primitives.push({ kind: 'bookmarkMark', x: x - EVENT_RADIUS - 3, y: y - EVENT_RADIUS - 3, color: BOOKMARK_MARK_COLOR });
      }
    }
    for (const [xKey, col] of columnDensity) {
      if (col.count > MAX_EVENT_MARKS_PER_COLUMN) primitives.push({ kind: 'eventDensityLine', x: xKey, y0: col.y0 - EVENT_RADIUS, y1: col.y1 + EVENT_RADIUS, color: theme.descriptionForeground });
    }
  }

  // ---- message dependencies (arrows / self-message ellipses) ----
  const vlineBuffer = new VLineBuffer();
  const axisSpacing = Math.max(axesLayout.spacing, 1);
  for (const dep of dependencies) {
    pushDependency(primitives, dep, { axisByModuleId, viewport, theme, arrowColors, flags, axisSpacing, vlineBuffer, showLabels, bookmarkedDependencyKeys });
  }

  // ---- method calls ----
  for (const call of flags.showComponentMethodCalls ? methodCalls : []) {
    if (!flags.showInitializationEvent && call.eventNumber === 0) continue;
    const sourceAxis = axisByModuleId.get(call.sourceModuleId);
    const targetAxis = axisByModuleId.get(call.targetModuleId);
    if (!sourceAxis || !targetAxis) continue;
    const x = contentX(call.tc, viewport);
    let y1 = axisRowY(sourceAxis.y, viewport);
    let y2 = axisRowY(targetAxis.y, viewport);
    [y1, y2] = adjustEndpointsForEventRadius(y1, y2, EVENT_RADIUS, flags.showEventMarks);
    const color = arrowColors.method;
    // method calls are drawn between two axes at the same tc -- a vertical arrow, still deduped like any other near-vertical segment
    if (!vlineBuffer.addAndCheck(x, y1, y2)) continue;
    const callRef: ArrowRef = { kind: 'methodCall', eventNumber: call.eventNumber, sourceModuleId: call.sourceModuleId, targetModuleId: call.targetModuleId, tc: call.tc };
    primitives.push({ kind: 'arrow', arrowKind: 'method', x1: x, y1, x2: x, y2, color, ref: callRef });
    if (flags.showArrowHeads && y1 !== y2) {
      primitives.push({ kind: 'arrowHead', x, y: y2, angle: Math.atan2(y2 - y1, 0), color, length: ARROWHEAD_LENGTH, width: ARROWHEAD_WIDTH });
      primitives.push({ kind: 'arrowHead', x, y: y1, angle: Math.atan2(y1 - y2, 0), color, length: ARROWHEAD_LENGTH, width: ARROWHEAD_WIDTH });
    }
    // method-name label rotated -90 (Java: drawn along the call's left/begin edge, SequenceChart.java:3770-3781)
    if (flags.showMethodNames && showLabels) {
      const name = call.methodName.includes('(') ? call.methodName.slice(0, call.methodName.indexOf('(')) : call.methodName;
      primitives.push({ kind: 'label', x, y: (y1 + y2) / 2, text: name, color, align: 'center', rotateDeg: -90 });
    }
  }

  // ---- time differences (Tab toggle) -- dashed polyline through selected events, sorted by tc, labeled with the pairwise simtime delta ----
  if (flags.showTimeDifferences && selectedEventNumbers && selectedEventNumbers.size >= 2) {
    const selected = events
      .filter((e) => selectedEventNumbers.has(e.eventNumber))
      .map((e) => ({ tc: (e.tcBegin + e.tcEnd) / 2, simulationTime: e.simulationTime, moduleId: e.moduleId }))
      .sort((a, b) => a.tc - b.tc);
    for (let i = 1; i < selected.length; i++) {
      const prev = selected[i - 1];
      const cur = selected[i];
      const prevAxis = axisByModuleId.get(prev.moduleId);
      const curAxis = axisByModuleId.get(cur.moduleId);
      if (!prevAxis || !curAxis) continue;
      const x1 = contentX(prev.tc, viewport);
      const y1 = axisRowY(prevAxis.y, viewport);
      const x2 = contentX(cur.tc, viewport);
      const y2 = axisRowY(curAxis.y, viewport);
      primitives.push({ kind: 'arrow', arrowKind: 'send', x1, y1, x2, y2, color: SELECTION_MARK_COLOR, dash: [3, 2] });
      if (showLabels) {
        const delta = subtractDecimalStrings(cur.simulationTime, prev.simulationTime);
        const text = (isNegativeDecimal(delta) ? '-' : '') + formatSimulationTime(delta.replace(/^-/, ''));
        primitives.push({ kind: 'timeDifferenceLabel', x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 12, text, color: SELECTION_MARK_COLOR });
      }
    }
  }

  // ---- info panels (overlay) ----
  if (flags.showPositionAndRange && infoPanelText?.positionAndRange) {
    pushInfoPanel(primitives, theme, infoPanelText.positionAndRange, viewport.canvasWidth, GUTTER_TOP_HEIGHT, 'top');
  }
  if (flags.showEventLogInfo && infoPanelText?.eventLogInfo) {
    pushInfoPanel(primitives, theme, infoPanelText.eventLogInfo, viewport.canvasWidth, viewport.canvasHeight, 'bottom');
  }

  return primitives;
}

function pushInfoPanel(primitives: DrawPrimitive[], theme: EventLogPalette, lines: [string, string], canvasWidth: number, anchorY: number, edge: 'top' | 'bottom'): void {
  const approxCharWidth = 7;
  const w = Math.max(lines[0].length, lines[1].length) * approxCharWidth + 12;
  const h = 2 * 16 + 6;
  const x = canvasWidth - w - 4;
  const y = edge === 'top' ? anchorY + 2 : anchorY - h - 2;
  primitives.push({ kind: 'infoPanel', x, y, w, h, lines: [lines[0], lines[1]], background: theme.isDark ? '#264f4f' : '#e0ffff', color: theme.isDark ? theme.foreground : '#000000', align: 'right' });
}

interface DependencyDrawContext {
  axisByModuleId: Map<number, AxisInfo>;
  viewport: ViewportState;
  theme: EventLogPalette;
  arrowColors: Record<ArrowKind, string>;
  flags: ChartDisplayFlags;
  axisSpacing: number;
  vlineBuffer: VLineBuffer;
  showLabels: boolean;
  /** Phase U6 -- see `bookmarkDependencyKey()`'s doc. */
  bookmarkedDependencyKeys?: ReadonlySet<string>;
}

function pushDependency(primitives: DrawPrimitive[], dep: RenderDependency, ctx: DependencyDrawContext): void {
  const { axisByModuleId, viewport, theme, arrowColors, flags, axisSpacing, vlineBuffer, showLabels, bookmarkedDependencyKeys } = ctx;
  const isBookmarked = bookmarkedDependencyKeys?.has(bookmarkDependencyKey(dep.causeEventNumber, dep.consequenceEventNumber, dep.messageId)) ?? false;
  if (dep.causeModuleId === null && dep.consequenceModuleId === null) return;
  // Both sides need a resolvable axis to be placed at all -- an event whose module was
  // never seen in any fetched viewport has nowhere to draw a row for (matches the U3/U4
  // behavior this phase preserves for that specific case; a null TC alone, by contrast,
  // is now handled as a split/offscreen arrow below, not skipped).
  if ((dep.causeModuleId !== null && !axisByModuleId.has(dep.causeModuleId)) || (dep.consequenceModuleId !== null && !axisByModuleId.has(dep.consequenceModuleId))) return;
  if (dep.causeModuleId === null || dep.consequenceModuleId === null) return;

  const isSelf = dep.causeModuleId === dep.consequenceModuleId;
  const isFiltered = dep.kind === 'filtered';
  const isReuse = dep.kind === 'reuse';
  if (isFiltered) {
    const showIt = isSelf ? (dep.filteredKind === 'reuses' ? flags.showSelfMessageReuses : dep.filteredKind === 'sends' ? flags.showSelfMessageSends : flags.showMixedSelfMessageDependencies) : dep.filteredKind === 'reuses' ? flags.showMessageReuses : dep.filteredKind === 'sends' ? flags.showMessageSends : flags.showMixedMessageDependencies;
    if (!showIt) return;
  } else if (isReuse) {
    if (isSelf ? !flags.showSelfMessageReuses : !flags.showMessageReuses) return;
  } else {
    if (isSelf ? !flags.showSelfMessageSends : !flags.showMessageSends) return;
  }

  const arrowKind: ArrowKind = dep.kind === 'send' ? 'send' : dep.kind === 'reuse' ? 'reuse' : 'filtered';
  const { color, dash } = isFiltered ? filteredColorAndDash(arrowColors, dep.filteredKind) : { color: arrowColors[arrowKind], dash: arrowKind === 'reuse' ? [2, 2] : undefined };
  // A split arrow's offscreen side has no real tc -- fall back to the KNOWN side so a
  // double-click "zoom to message" (which does `Math.min(causeTc, consequenceTc)`/`max`)
  // still zooms somewhere sensible instead of producing a `NaN` range.
  const depRef: ArrowRef = { kind: 'dependency', dependencyKind: arrowKind as 'send' | 'reuse' | 'filtered', causeEventNumber: dep.causeEventNumber, consequenceEventNumber: dep.consequenceEventNumber, causeTc: dep.causeTc ?? dep.consequenceTc ?? 0, consequenceTc: dep.consequenceTc ?? dep.causeTc ?? 0 };

  const causeAxis = axisByModuleId.get(dep.causeModuleId)!;
  const consequenceAxis = axisByModuleId.get(dep.consequenceModuleId)!;
  const causeX = dep.causeTc === null ? null : contentX(dep.causeTc, viewport);
  const consequenceX = dep.consequenceTc === null ? null : contentX(dep.consequenceTc, viewport);

  if (isSelf) {
    let y = axisRowY(causeAxis.y, viewport);
    [y] = adjustEndpointsForEventRadius(y, y, EVENT_RADIUS, flags.showEventMarks);
    const geom = computeSelfArrowGeometry({
      cause: { x: causeX },
      consequence: { x: consequenceX },
      y,
      eventNumberDelta: (dep.messageId ?? 0) + dep.consequenceEventNumber - dep.causeEventNumber,
      axisSpacing,
      showArrowHeads: flags.showArrowHeads,
      isFiltered,
    });
    if (!geom) return;
    for (const seg of geom.segments) {
      if (Math.abs(seg.x2 - seg.x1) < 1 && !vlineBuffer.addAndCheck((seg.x1 + seg.x2) / 2, seg.y1, seg.y2)) continue;
      primitives.push({ kind: 'arrow', arrowKind, x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2, color, dash: seg.dashed ? OFFSCREEN_DASH : dash, ref: depRef });
    }
    if (geom.ellipse) primitives.push({ kind: 'ellipseArc', ...geom.ellipse, color, ref: depRef });
    if (geom.arrowhead) primitives.push({ kind: 'arrowHead', x: geom.arrowhead.x, y: geom.arrowhead.y, angle: geom.arrowhead.angle, color: geom.arrowhead.long ? LONG_ARROWHEAD_COLOR : color, length: geom.arrowhead.length, width: geom.arrowhead.width });
    if (isFiltered && geom.signAnchor) primitives.push({ kind: 'zigzag', segments: buildFilteredSignSegments(geom.signAnchor), color });
    if (flags.showMessageNames && showLabels && dep.messageName) primitives.push({ kind: 'label', x: geom.labelAnchor.x + (isFiltered ? 7 : 0), y: geom.labelAnchor.y, text: dep.messageName, color, align: 'left' });
    if (isBookmarked) primitives.push({ kind: 'bookmarkMark', x: geom.labelAnchor.x, y: geom.labelAnchor.y, color: BOOKMARK_MARK_COLOR });
    return;
  }

  let y1 = axisRowY(causeAxis.y, viewport);
  let y2 = axisRowY(consequenceAxis.y, viewport);
  [y1, y2] = adjustEndpointsForEventRadius(y1, y2, EVENT_RADIUS, flags.showEventMarks);
  const causeEndpoint: LineEndpoint = { axisY: y1, x: causeX };
  const consequenceEndpoint: LineEndpoint = { axisY: y2, x: consequenceX };
  const geom = computeLineArrowGeometry({
    cause: causeEndpoint,
    consequence: consequenceEndpoint,
    showArrowHeads: flags.showArrowHeads,
    isFiltered,
    transmissionDurationFraction: flags.showTransmissionDurations ? dep.transmissionDurationFraction : null,
  });
  if (!geom) return;

  if (geom.parallelogram) primitives.push({ kind: 'parallelogram', points: geom.parallelogram.points, color: theme.isDark ? '#888888' : '#333333' });
  for (const seg of geom.segments) {
    if (Math.abs(seg.x2 - seg.x1) < 1 && !vlineBuffer.addAndCheck((seg.x1 + seg.x2) / 2, seg.y1, seg.y2)) continue;
    primitives.push({ kind: 'arrow', arrowKind, x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2, color, dash: seg.dashed ? OFFSCREEN_DASH : dash, ref: depRef });
  }
  if (geom.arrowhead) primitives.push({ kind: 'arrowHead', x: geom.arrowhead.x, y: geom.arrowhead.y, angle: geom.arrowhead.angle, color: geom.arrowhead.long ? LONG_ARROWHEAD_COLOR : color, length: geom.arrowhead.length, width: geom.arrowhead.width });
  if (isFiltered && geom.signAnchor) primitives.push({ kind: 'zigzag', segments: buildFilteredSignSegments(geom.signAnchor), color });
  if (flags.showMessageNames && showLabels && dep.messageName) primitives.push({ kind: 'label', x: geom.labelAnchor.x + (isFiltered ? 7 : 0), y: geom.labelAnchor.y, text: dep.messageName, color, align: 'left' });
  if (isBookmarked) primitives.push({ kind: 'bookmarkMark', x: geom.labelAnchor.x, y: geom.labelAnchor.y, color: BOOKMARK_MARK_COLOR });
}
