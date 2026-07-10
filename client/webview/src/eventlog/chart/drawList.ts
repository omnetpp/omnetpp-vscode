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

import { TimelineMode, type AxisVectorStrip, type RenderDependency, type RenderMethodCall, type TimelineEvent } from '@omnetpp/shared/elog-protocol';
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
import { AXIS_VECTOR_STRIP_HEIGHT, type AxisInfo, type AxesLayout } from './axes';
import { clipCoordinate, tcToPixel } from './coords';
import { DEFAULT_DISPLAY_FLAGS, type ChartDisplayFlags } from './displayFlags';
import type { Tick } from './ticks';
import { computeZeroSimTimeRegions } from './zeroSimTimeRegions';
import { contentWidth, GUTTER_LEFT_WIDTH, GUTTER_TOP_HEIGHT, type ViewportState } from './viewportState';

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
  | { kind: 'methodCall'; eventNumber: number; sourceModuleId: number; targetModuleId: number; tc: number; entryIndex: number; methodName: string };

export type DrawPrimitive =
  | { kind: 'gutter'; part: 'top' | 'left'; x: number; y: number; w: number; h: number; color: string }
  | { kind: 'regionBand'; x: number; y: number; w: number; h: number; color: string }
  | { kind: 'axisLine'; moduleId: number; x1: number; x2: number; y: number; lineHeight: number; color: string }
  /** Axis vector-data strip (Eclipse `AxisVectorBarRenderer`): a horizontal multi-color step bar centered on the axis line, one colored segment per held value, with top/bottom borders. Replaces the plain axis line for that module while shown. */
  | { kind: 'axisVectorStrip'; moduleId: number; y: number; height: number; borderColor: string; labelColor: string; canvasWidth: number; segments: { x1: number; x2: number; color: string; value: number; valueText: string }[] }
  | { kind: 'axisLabel'; moduleId: number; x: number; y: number; text: string; color: string; bold?: boolean }
  /** Phase U11 — a selected/hovered axis's Eclipse selection mark: two thin colored lines just above and below the axis line, spanning the full canvas width (and thus visible under the transparent left module hierarchy band) (`drawAxisMark()`, SequenceChart.java:3668-3680). */
  | { kind: 'axisSelectionMark'; x1: number; x2: number; y: number; lineHeight: number; color: string }
  | { kind: 'axisHeaderBox'; x: number; y0: number; y1: number; label: string; color: string; textColor: string }
  | { kind: 'tick'; x: number; y0: number; y1: number; color: string }
  | { kind: 'eventMark'; eventNumber: number; moduleId: number; x: number; xEnd: number; y: number; radius: number; color: string }
  | { kind: 'selfEventMark'; eventNumber: number; moduleId: number; x: number; xEnd: number; y: number; radius: number; color: string }
  | { kind: 'eventDensityLine'; x: number; y0: number; y1: number; color: string }
  | { kind: 'arrow'; arrowKind: ArrowKind; x1: number; y1: number; x2: number; y2: number; color: string; dash?: number[]; ref?: ArrowRef; width?: number }
  | { kind: 'arrowHead'; x: number; y: number; angle: number; color: string; length: number; width: number }
  | { kind: 'ellipseArc'; x1: number; x2: number; y: number; height: number; quarter: 0 | 1 | -1; color: string; ref?: ArrowRef; width?: number; dash?: number[] }
  | { kind: 'parallelogram'; points: [[number, number], [number, number], [number, number], [number, number]]; color: string; borderColor?: string }
  | { kind: 'zigzag'; segments: LineSegment[]; color: string }
  | { kind: 'label'; x: number; y: number; text: string; color: string; align?: 'left' | 'center' | 'right'; rotateDeg?: number }
  | { kind: 'timeDifferenceLabel'; x: number; y: number; text: string; color: string }
  /** Phase U11 — the position/range (top) and eventlog-info (bottom) overlay boxes, right-aligned. Sized to its measured text at draw time (Java measures `getTextExtent`), so `rightX`/`anchorY`/`edge` describe placement and the renderer computes the box. */
  | { kind: 'infoPanel'; lines: string[]; rightX: number; anchorY: number; edge: 'top' | 'bottom'; background: string; color: string }
  /** Phase U4 — a selection ring around a selected event; a stadium outline (not a circle) when the event has a nonzero timeline width (`xEnd > x`), matching the pill event mark and Java's `drawEventMark()`. */
  | { kind: 'selectionMark'; x: number; xEnd: number; y: number; radius: number; color: string }
  /** Phase U11 — a selected timeline coordinate (a background click): a vertical line spanning the content height (Java `drawTimelineMark()`). */
  | { kind: 'timelineMark'; x: number; y0: number; y1: number; color: string }
  /** Phase U11 — the live "tick under the mouse" (Java `drawTickUnderMouse()`): a vertical hairline following the cursor plus a small labelled box, in the top gutter, showing the exact simulation time under the pointer. */
  | { kind: 'mouseTick'; x: number; y0: number; y1: number; label: string; lineColor: string; textColor: string; bgColor: string }
  /** Java `drawTickPrefix()`: the shared time offset ("+ 1s"), boxed in the TOP gutter's right corner, so tick/hairline labels can be drawn relative to it. `rightX` is the box's right edge (canvas width); the renderer measures the text and grows leftward. */
  | { kind: 'tickPrefixBox'; label: string; rightX: number; color: string; textColor: string; bgColor: string }
  /**
   * Phase U6 — a bookmark mark: a small filled "flag" glyph, port of Eclipse's
   * bookmark ring/flag decoration on the event mark (`IMarker.BOOKMARK`'s default
   * annotation, ported loosely -- the exact Eclipse ruler icon isn't reproduced, just a
   * small, consistently-colored flag shape). Reused verbatim for event/axis/
   * dependency bookmarks -- only the `(x, y)` anchor differs per caller (see
   * `buildDrawList()`'s three call sites below).
   */
  | { kind: 'bookmarkMark'; x: number; y: number; color: string }
  /**
   * Phase U8 — an inline axis-management glyph hotspot (Java's `ModuleAction`, laid
   * out in `layoutAxis()`/`layoutAxisHeader()` and dispatched in `mouseUp()`'s
   * highest-priority cascade level): a small `size`×`size` box at `(x, y)` (top-left)
   * drawn as a vector expand(+)/collapse(−)/close(×) icon. `scope` decides the close
   * glyph's semantics (Java: close on an Axis removes ONE module; close on an
   * AxisHeader removes the whole subtree via `visitItems`). DEVIATION (documented):
   * Java paints the close glyph only while the mouse hovers its bounds (though the
   * bounds are always hit-testable); this port draws it always — a persistent
   * affordance instead of hover-tracked repaints.
   */
  | { kind: 'moduleAction'; action: 'expand' | 'collapse' | 'close'; moduleId: number; scope: 'axis' | 'header'; x: number; y: number; size: number; color: string };

/** Phase U8 — glyph box edge length (Java uses the 16px `expand.png`/`collapse.png`/`close.png` images; a slightly smaller vector glyph fits this port's tighter axis labels). */
export const MODULE_ACTION_SIZE = 11;

/** The `'bookmarkMark'` flag glyph's drawn size (pole height / pennant width) -- exported so both `canvasStack.ts`'s renderer and this file's axis-label slot-reservation math (see the axis loop's `bookmarkSlot`) share one source of truth instead of the renderer hardcoding its own copy. */
export const BOOKMARK_FLAG_HEIGHT = 8;
export const BOOKMARK_FLAG_WIDTH = 6;

/**
 * Eclipse `ColorFactory.getGoodLightColor(i)` — the "reversed Tableau-20 light half" palette
 * (`ColorFactory.java`), cycled by index. Used to color axis vector-strip segments by value
 * (equal values → same color). Fixed light colors regardless of theme, matching Java's strip.
 */
const GOOD_LIGHT_COLORS = ['#aec7e8', '#ffbb78', '#98df8a', '#ff9896', '#c5b0d5', '#c49c94', '#f7b6d2', '#c7c7c7', '#dbdb8d', '#9edae9'];
export function getGoodLightColor(index: number): string {
  const n = GOOD_LIGHT_COLORS.length;
  return GOOD_LIGHT_COLORS[(((index % n) + n) % n) | 0];
}

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

/**
 * Java `getMaximumMessageDependencyDisplayWidth()`: a dependency whose two endpoints would
 * be more than this many pixels apart is drawn as a SPLIT arrow (a short stub near each
 * visible-ish endpoint + a dashed continuation, exactly like the already-offscreen/
 * unresolvable-endpoint case below) instead of one long line -- avoids a giant diagonal
 * cluttering the view for cause/consequence pairs that are simply far apart in time, even
 * when BOTH endpoints happen to be individually resolvable.
 */
const MAX_DEPENDENCY_ARROW_WIDTH_FACTOR = 3;

/** Distance (px) of `x` outside `[GUTTER_LEFT_WIDTH, viewport.canvasWidth]` -- 0 when already within the visible content area. Used to decide which endpoint of an over-long dependency arrow to keep real (the one nearer the view) vs. stub (the farther one), matching Java's "elide whichever side is out of the drawn range" choice. */
function distanceFromContentArea(x: number, viewport: ViewportState): number {
  if (x < GUTTER_LEFT_WIDTH) return GUTTER_LEFT_WIDTH - x;
  if (x > viewport.canvasWidth) return x - viewport.canvasWidth;
  return 0;
}

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

/**
 * Phase U9 (high-contrast pass): under `theme.isHighContrast`, canvas-drawn selection
 * rings switch from the fixed `SELECTION_MARK_COLOR` literal to `theme.focusBorder` --
 * a color VS Code itself guarantees stays visible against every other high-contrast
 * chrome color, unlike an arbitrary literal red (which an HC theme author could
 * legitimately also use for something else, or which could sit too close to the HC
 * background/foreground pair to read as a distinct accent). Non-HC themes are
 * unaffected (still the literal, matching every prior phase's rendering exactly).
 */
export function selectionMarkColor(theme: EventLogPalette): string {
  return theme.isHighContrast ? theme.focusBorder : SELECTION_MARK_COLOR;
}

/**
 * The bookmark flag glyph's color -- a deliberately eye-catching, theme-aware amber/gold
 * (`theme.bookmarkColor`, dark/light-tuned in `theme.ts`) so a bookmark stands out from
 * every other chart color at a glance. Under `theme.isHighContrast` this still defers to
 * `theme.focusBorder`, same rationale as `selectionMarkColor()` above (a color VS Code
 * itself guarantees stays visible against every HC theme's own chrome, unlike a fixed
 * literal).
 */
export function bookmarkMarkColor(theme: EventLogPalette): string {
  return theme.isHighContrast ? theme.focusBorder : theme.bookmarkColor;
}

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

/**
 * Identity key for a `ComponentMethodCall`-kind bookmark, matching `bookmarkStore.ts`'s
 * `bookmarkMatches()` field set exactly `(eventNumber, entryIndex)` -- see
 * `bookmarkDependencyKey()` above for why this is exported (one definition, used both by
 * `chartMain.ts`'s toggle-candidate builder and this module's `bookmarkedMethodCallKeys`).
 */
export function bookmarkMethodCallKey(eventNumber: number, entryIndex: number): string {
  return `${eventNumber}:${entryIndex}`;
}

/** Identity key for a rendered dependency, matching `selection.ts`'s `dependencyKey()` (`kind:cause:consequence`), so `buildDrawList` can test a dependency against the selected/hovered key sets the reducer produced. */
export function dependencyEmphasisKey(dep: RenderDependency): string {
  const arrowKind = dep.kind === 'send' ? 'send' : dep.kind === 'reuse' ? 'reuse' : 'filtered';
  return `${arrowKind}:${dep.causeEventNumber}:${dep.consequenceEventNumber}`;
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
  /** Per-axis vector-data strips (from `ViewportModel.axisVectorStrips`); rendered instead of the plain axis line for those modules when `displayFlags.showAxisVectorData` is on. */
  axisVectorStrips?: AxisVectorStrip[];
  /** Phase U4 — event numbers currently selected; each gets a `'selectionMark'` ring around its event mark, and (if `displayFlags.showTimeDifferences`) participates in the time-differences polyline. */
  selectedEventNumbers?: ReadonlySet<number>;
  /** Phase U11 — selected message-dependency keys (`selection.ts`'s `dependencyKey()` = `kind:cause:consequence`); each selected arrow is redrawn thicker in the selection color (Java `drawMessageDependencySelectionMarks()`). */
  selectedDependencyKeys?: ReadonlySet<string>;
  /** Phase U11 — selected axis module ids; each gets an `'axisSelectionMark'` (Java `drawAxisSelectionMarks()`). */
  selectedAxisModuleIds?: ReadonlySet<number>;
  /** Selected component-method-call keys (`selection.ts`'s `methodCallKey()`); each selected call is redrawn red, hovered ones thicker. */
  selectedMethodCallKeys?: ReadonlySet<string>;
  /** Phase U11 — selected timeline coordinates (background clicks): each draws a vertical `'timelineMark'` line AND participates in the time-difference measurement. The caller resolves each tc's simulation time (this pure module has no simtime<->tc table). */
  selectedTimelineCoords?: ReadonlyArray<{ tc: number; simulationTime: string }>;
  /** Phase U11 — the live tick under the mouse (`drawTickUnderMouse()`): a vertical hairline + a top-gutter time box following the cursor. `x` is the content-area canvas x; `label` the formatted simulation time. Omitted when the pointer is off the content area. */
  mouseTick?: { x: number; label: string };
  /** Java `tickPrefix` shown as "+ <offset>" in the top gutter's right corner (`drawTickPrefix()`); omitted/empty when there is no shared prefix to factor out. */
  tickPrefixLabel?: string;
  /** Phase U11 — the object(s) under the cursor (hover), redrawn "bold" in the highlight color (Java `drawHightlightedObjects()`, `highlightedObjects` populated on mouseMove). Usually holds the single hit group at the pointer. */
  hovered?: { events?: ReadonlySet<number>; dependencyKeys?: ReadonlySet<string>; axisModuleIds?: ReadonlySet<number>; methodCallKeys?: ReadonlySet<string> };
  /** Phase U6 — event numbers with an `'Event'`-kind bookmark; each gets a `'bookmarkMark'` flag near its event mark. */
  bookmarkedEventNumbers?: ReadonlySet<number>;
  /** Phase U6 — module ids with an `'Axis'`-kind bookmark (already resolved from the bookmark's stored `modulePath` -- see `chartMain.ts`'s `recomputeBookmarkIndexes()`); each gets a `'bookmarkMark'` at the start of its axis line. */
  bookmarkedModuleIds?: ReadonlySet<number>;
  /** Phase U6 — `MessageDependency`-kind bookmark identity keys (`${causeEventNumber}:${consequenceEventNumber}:${messageId}` -- see `chartMain.ts`'s `bookmarkDepKey()`, which both this and the toggle-candidate builder use so the two stay in sync); a matching dependency gets a `'bookmarkMark'` at its arrow's midpoint. */
  bookmarkedDependencyKeys?: ReadonlySet<string>;
  /** `'ComponentMethodCall'`-kind bookmark identity keys (`bookmarkMethodCallKey()` above); a matching method call gets a `'bookmarkMark'` at its begin edge. */
  bookmarkedMethodCallKeys?: ReadonlySet<string>;
  /** `'Position'`-kind bookmarks' resolved timeline coordinates (`chartMain.ts`'s `refreshPositionBookmarkTcs()`); each gets a `'bookmarkMark'` near the top ruler at its tc. */
  positionBookmarkTcs?: readonly number[];
  /** Phase U5 — the ~25 Show/Hide toggles (`displayFlags.ts`); defaults to `DEFAULT_DISPLAY_FLAGS` when omitted. */
  displayFlags?: ChartDisplayFlags;
  /** Phase U5 — merged axis-header tree (`axisHeaders.ts`'s `calculateAxisHeaders()`), or `null`/omitted for no headers (e.g. module tree not loaded yet). */
  axisHeaderRoot?: AxisHeaderNode | null;
  /** Phase U5 — `showPositionAndRange`/`showEventLogInfo` panel text, precomputed by the caller (needs `LogSummary`, which this pure module doesn't otherwise touch) — see this file's header. `undefined` = flag has nothing to show yet (panel simply omitted, not an error). */
  infoPanelText?: InfoPanelText;
  /** Phase U5 antialias auto-toggle perf gate ("drop labels first" — see this phase's report for the exact mapping): when `true`, message/method/event-number labels are skipped (arrows/marks/axes still draw in full). */
  skipLabelsForPerf?: boolean;
  /**
   * Phase U8 — `openAxisModules.ts`'s `moduleIdToAxisModuleIdMap()`: maps a module id
   * WITHOUT its own axis to the module id of the nearest open-ancestor axis, so a
   * collapsed compound module's inner events/dependencies/method calls draw on the
   * ancestor's axis (Java's `calculateModuleIdToAxisModuleIndexMap()`). Omitted =
   * pre-U8 behavior (only modules with their own axis draw anything).
   */
  moduleIdToAxisModuleId?: ReadonlyMap<number, number>;
  /** Phase U8 — per-axis expand/collapse glyph visibility (`openAxisModules.ts`'s `moduleGlyphInfo()`), keyed by axis module id. Omitted = no axis glyphs at all (e.g. module tree not loaded yet, so there is no open-module model to act on). The close glyph is emitted for every axis whenever this map is present (its visibility is unconditional in Java). */
  axisGlyphs?: ReadonlyMap<number, { expand: boolean; collapse: boolean }>;
  /** Phase U8 — per-header glyphs, keyed by the header's `fullPath` (`DrawableAxisHeader.fullPath`); a header whose path resolves to no real module has no entry and draws no glyphs. */
  headerGlyphs?: ReadonlyMap<string, { moduleId: number; expand: boolean; collapse: boolean }>;
}

export function buildDrawList(params: BuildDrawListParams): DrawPrimitive[] {
  const { viewport, events, dependencies, methodCalls, axesLayout, ticks, theme, selectedEventNumbers, selectedDependencyKeys, selectedAxisModuleIds, selectedMethodCallKeys, selectedTimelineCoords, hovered, bookmarkedEventNumbers, bookmarkedModuleIds, bookmarkedDependencyKeys, bookmarkedMethodCallKeys, positionBookmarkTcs, axisHeaderRoot, infoPanelText, skipLabelsForPerf } = params;
  const flags = params.displayFlags ?? DEFAULT_DISPLAY_FLAGS;
  const primitives: DrawPrimitive[] = [];
  // Phase U11 — selection/hover emphasis (thicker arrows, axis brackets, bold-red hovered
  // objects) is collected separately and appended LAST so it layers on top of the whole
  // scene, matching Java's `drawMessageDependencySelectionMarks()`/`drawAxisSelectionMarks()`/
  // `drawHightlightedObjects()`, which run after the base drawing pass.
  const emphasis: DrawPrimitive[] = [];
  const emphasisColor = selectionMarkColor(theme);
  const arrowColors = deriveArrowColors(theme);
  const axisByModuleId = new Map(axesLayout.axes.map((a) => [a.moduleId, a]));
  // Phase U8: expand the lookup so a module without its own axis resolves to its
  // nearest open-ancestor's axis (see BuildDrawListParams.moduleIdToAxisModuleId) --
  // every downstream `axisByModuleId.get(...)` (events, dependencies, method calls,
  // time differences) then attributes activity to the right row with no other change.
  if (params.moduleIdToAxisModuleId) {
    for (const [id, axisModuleId] of params.moduleIdToAxisModuleId) {
      if (!axisByModuleId.has(id)) {
        const axis = axisByModuleId.get(axisModuleId);
        if (axis) axisByModuleId.set(id, axis);
      }
    }
  }
  const showLabels = !skipLabelsForPerf;

  // ---- zero-simulation-time regions (background bands, drawn first so everything else layers on top) ----
  if (flags.showZeroSimulationTimeRegions) {
    // The initialization event's own [tcBegin,tcEnd] span (all its initialize() calls,
    // spread out on the timeline in NONLINEAR/STEP mode) is a zero-simulation-time region by
    // definition -- but when showInitializationEvent is off, event #0's pill/axis itself is
    // hidden (see the events loop below), so counting its span here would leave a wide gray
    // band with nothing visibly causing it: exactly the same "hidden thing leaves a visible
    // trace" bug already fixed for its outgoing dependencies (see pushDependency above).
    const zeroTimeEvents = flags.showInitializationEvent ? events : events.filter((e) => e.eventNumber !== 0);
    for (const region of computeZeroSimTimeRegions(zeroTimeEvents)) {
      const x0 = contentX(region.tcBegin, viewport);
      const x1 = contentX(region.tcEnd, viewport);
      // Extend into the (transparent) left label column, down to x=0 -- the module names /
      // hierarchy band overlay it transparently, so zero-simtime regions stay visible there.
      if (x1 < 0 || x0 > viewport.canvasWidth) continue;
      primitives.push({ kind: 'regionBand', x: Math.max(0, x0), y: GUTTER_TOP_HEIGHT, w: Math.max(0, Math.min(viewport.canvasWidth, x1) - Math.max(0, x0)), h: viewport.canvasHeight - GUTTER_TOP_HEIGHT, color: theme.regionBandColor });
    }
  }

  // ---- gutter backgrounds (drawn first, everything else on top) ----
  // Only the TOP (ruler) gutter gets an opaque background. The LEFT (axis-label) gutter is
  // intentionally transparent so the axis lines / chart show through the leaf-label strip
  // (the compound-module band draws its own opaque background); this keeps the left column
  // from covering the sequence chart. (No 'left' gutter fill is pushed.)
  primitives.push({ kind: 'gutter', part: 'top', x: 0, y: 0, w: viewport.canvasWidth, h: GUTTER_TOP_HEIGHT, color: theme.background });

  // ---- simtime ruler ticks (vertical hairlines spanning the content height; labels drawn separately as 'label') ----
  // Phase U10 (cheap-gap fix): the hairline itself (`showHairlines`, Java's `drawGutters()`
  // `SequenceChart.java:3939`) is gated separately from the tick LABEL, which is not a
  // hairline and has no Java flag of its own -- it is the ruler text drawn regardless.
  for (const tick of ticks) {
    const x = contentX(tick.tc, viewport);
    // Ruler hairlines run all the way to the left canvas edge (x=0), through the transparent
    // label column, so the timeline grid is visible behind the module names.
    if (x < 0 || x > viewport.canvasWidth) continue;
    if (flags.showHairlines) primitives.push({ kind: 'tick', x, y0: GUTTER_TOP_HEIGHT, y1: viewport.canvasHeight, color: theme.border });
    primitives.push({ kind: 'label', x: x + 2, y: GUTTER_TOP_HEIGHT - 4, text: tick.label, color: theme.descriptionForeground, align: 'left' });
  }

  // ---- Position-kind bookmarks (bare timeline positions, no event/module) ----
  // Placed just below the ruler (not overlapping its tick labels) -- `bookmarkMark` is
  // always drawn in the top gutter-chrome overlay pass regardless of (x,y) (canvasStack.ts's
  // `isGutterChrome()`), same as the other 3 bookmark kinds' marks.
  for (const tc of positionBookmarkTcs ?? []) {
    const x = contentX(tc, viewport);
    if (x < 0 || x > viewport.canvasWidth) continue;
    primitives.push({ kind: 'bookmarkMark', x, y: GUTTER_TOP_HEIGHT + 8, color: bookmarkMarkColor(theme) });
  }

  // ---- axis lines + pinned labels + merged headers ----
  const headerNodes = flags.showAxisHeaders ? flattenDrawableAxisHeaders(axisHeaderRoot ?? null) : [];
  const maxHeaderLevel = headerNodes.reduce((m, h) => Math.max(m, h.level), -1);
  const labelIndent = Math.min(maxHeaderLevel + 1, MAX_HEADER_LEVELS_SHOWN) * HEADER_LEVEL_WIDTH;

  // Axis vector-data strips replace the plain line for their module (Eclipse's
  // AxisMultiRenderer shows the bar instead of the line while `showAxisVectorData` is on).
  const stripByModuleId = new Map<number, AxisVectorStrip>();
  if (flags.showAxisVectorData && params.axisVectorStrips) for (const s of params.axisVectorStrips) stripByModuleId.set(s.moduleId, s);

  // A vector strip's sample timestamps come straight from the engine's coordinate mapping,
  // which (in NONLINEAR/STEP mode) still allocates the initialization event its own tc
  // range even when showInitializationEvent is off -- so a strip whose earliest sample(s)
  // were recorded during initialize() would otherwise still anchor its first segment(s) to
  // that now-invisible range, re-reserving exactly the "0s area" the zero-simtime-region and
  // Home-navigation fixes already stopped reserving elsewhere. Clamp every strip segment to
  // start no earlier than the first VISIBLE event's own tc, so a strip starts exactly where
  // that area now ends, not where the hidden #0 would have.
  let stripClampTc: number | null = null;
  if (!flags.showInitializationEvent) {
    for (const event of events) {
      if (event.eventNumber === 0) continue;
      if (stripClampTc === null || event.tcBegin < stripClampTc) stripClampTc = event.tcBegin;
    }
  }

  if (flags.showAxes) {
    for (const axis of axesLayout.axes) {
      const y = axisRowY(axis.y, viewport);
      if (y < GUTTER_TOP_HEIGHT - axis.lineHeight || y > viewport.canvasHeight + axis.lineHeight) continue;
      // The plain axis line is ALWAYS drawn (full width, from x=0, so it runs under the
      // transparent leaf-label strip too) -- a vector-data strip is an OVERLAY on top of it,
      // not a replacement, since the vector's samples rarely cover the module's entire
      // lifetime; outside the strip's covered range the plain line keeps the axis visible
      // (e.g. before the vector's first sample, or after its last one -- a fixed-width "last
      // segment" would misrepresent an unknown value as held forever). Uses the traditional
      // compound(3px)/simple(1px) thickness, NOT `axis.lineHeight` (which is the taller
      // strip row-height reservation for layout purposes when a strip is shown).
      primitives.push({ kind: 'axisLine', moduleId: axis.moduleId, x1: 0, x2: viewport.canvasWidth, y, lineHeight: axis.compound ? 3 : 1, color: theme.foreground });
      const strip = stripByModuleId.get(axis.moduleId);
      if (strip) {
        // Multi-color step bar centered on the axis line, drawn on top. Segments are culled
        // to the canvas; contentX maps each held-value span's tc edges to pixels.
        const segments: { x1: number; x2: number; color: string; value: number; valueText: string }[] = [];
        for (const seg of strip.segments) {
          // Segment entirely within the hidden init-event gap -- superseded by whichever
          // segment straddles (or follows) the clamp boundary; its own history isn't
          // independently visible anyway, since the timeline that would show WHEN it
          // changed is itself hidden.
          if (stripClampTc !== null && seg.tcEnd <= stripClampTc) continue;
          const tcBegin = stripClampTc !== null && seg.tcBegin < stripClampTc ? stripClampTc : seg.tcBegin;
          const x1 = contentX(tcBegin, viewport);
          const x2 = seg.tcEnd > tcBegin ? contentX(seg.tcEnd, viewport) : x1;
          if (x2 < 0 || x1 > viewport.canvasWidth) continue;
          segments.push({ x1, x2, color: getGoodLightColor(seg.colorIndex), value: seg.value, valueText: seg.valueText });
        }
        if (segments.length > 0) primitives.push({ kind: 'axisVectorStrip', moduleId: axis.moduleId, y, height: AXIS_VECTOR_STRIP_HEIGHT, borderColor: theme.foreground, labelColor: '#000000', canvasWidth: viewport.canvasWidth, segments });
      }
      const axisHovered = hovered?.axisModuleIds?.has(axis.moduleId) ?? false;
      const axisSelected = selectedAxisModuleIds?.has(axis.moduleId) ?? false;
      // The expand/collapse glyph and the bookmark flag each sit in their own reserved slot
      // immediately BEFORE the module name (glyph, then bookmark flag, then the label) rather
      // than right-aligned across the gutter, so a collapsible+bookmarked module reads as
      // "[−][flag] name". Both slots are reserved for EVERY axis, whether or not that axis
      // actually has a glyph/bookmark, so all names stay left-aligned in a column regardless.
      const glyphSlot = MODULE_ACTION_SIZE + 3;
      const bookmarkSlot = BOOKMARK_FLAG_WIDTH + 3;
      const glyphX = 4 + labelIndent;
      const bookmarkX = glyphX + glyphSlot;
      const labelX = bookmarkX + bookmarkSlot;
      // Hover only makes the label BOLD (same color); selection turns it red.
      if (flags.showAxisLabels) primitives.push({ kind: 'axisLabel', moduleId: axis.moduleId, x: labelX, y, text: axis.label, color: axisSelected ? emphasisColor : theme.foreground, bold: axisHovered });
      // Phase U11 -- selected axis: two thin red lines just above/below the axis line,
      // running the full canvas width so they're visible under the left module hierarchy band.
      if (axisSelected) emphasis.push({ kind: 'axisSelectionMark', x1: 0, x2: viewport.canvasWidth, y, lineHeight: axis.lineHeight, color: emphasisColor });
      if (bookmarkedModuleIds?.has(axis.moduleId)) primitives.push({ kind: 'bookmarkMark', x: bookmarkX, y, color: bookmarkMarkColor(theme) });
      // Expand/collapse glyph in the reserved slot before the name (the "close"/remove-X is
      // intentionally omitted -- filtering / Select Modules removes axes). A module offers
      // at most one of the two in practice; prefer collapse if somehow both.
      if (params.axisGlyphs) {
        const info = params.axisGlyphs.get(axis.moduleId);
        // Sit the glyph ABOVE the axis line, aligned with the name text (its bottom at the
        // label's baseline, y-2) rather than centered on the line.
        const gy = y - MODULE_ACTION_SIZE - 2;
        if (info?.collapse) primitives.push({ kind: 'moduleAction', action: 'collapse', moduleId: axis.moduleId, scope: 'axis', x: glyphX, y: gy, size: MODULE_ACTION_SIZE, color: theme.descriptionForeground });
        else if (info?.expand) primitives.push({ kind: 'moduleAction', action: 'expand', moduleId: axis.moduleId, scope: 'axis', x: glyphX, y: gy, size: MODULE_ACTION_SIZE, color: theme.descriptionForeground });
      }
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
      const x = 2 + level * HEADER_LEVEL_WIDTH;
      // The compound-module band keeps an OPAQUE background (only the leaf-label strip and
      // the rest of the left column are transparent) -- `color` is the fill, `textColor` the
      // rotated name.
      primitives.push({ kind: 'axisHeaderBox', x, y0, y1, label: header.label, color: theme.isDark ? '#2f5060' : '#d7f2f2', textColor: theme.isDark ? '#e0f0f0' : '#000000' });
      // Expand/collapse glyph pinned at the TOP of the band -- "before" the vertically-
      // written name, mirroring the axis row's glyph-before-name placement. A header can
      // exist WITHOUT a matching axis row of its own (its children are open but the
      // compound itself isn't), so it can't always rely on an axis-row glyph to control it;
      // this is the only way to collapse/expand such a group. At most one of the two
      // applies at once (matching the axis-row glyph); prefer collapse if somehow both.
      const headerInfo = params.headerGlyphs?.get(header.fullPath);
      if (headerInfo) {
        const gy = Math.max(y0, GUTTER_TOP_HEIGHT) + 2;
        if (headerInfo.collapse) primitives.push({ kind: 'moduleAction', action: 'collapse', moduleId: headerInfo.moduleId, scope: 'header', x: x - 1, y: gy, size: MODULE_ACTION_SIZE, color: theme.descriptionForeground });
        else if (headerInfo.expand) primitives.push({ kind: 'moduleAction', action: 'expand', moduleId: headerInfo.moduleId, scope: 'header', x: x - 1, y: gy, size: MODULE_ACTION_SIZE, color: theme.descriptionForeground });
      }
    }
  }

  // ---- events (with dense-column capping) ----
  const columnDensity = new Map<number, { count: number; y0: number; y1: number }>();
  if (flags.showEventMarks) {
    for (const event of events) {
      const axis = axisByModuleId.get(event.moduleId);
      if (!axis) continue;
      // The initialization event (#0) is drawn on its OWN module axis (the network/system
      // compound), at its full `[xBegin, xEnd]` width -- the width spreads its initialize()
      // method calls and its initial send across the pill. Its outgoing dependency
      // (#0 -> #1) therefore stays a proper CROSS-module arrow (mod1 -> source), not a
      // source self-message. Hidden unless `showInitializationEvent`.
      if (!flags.showInitializationEvent && event.eventNumber === 0) continue;
      const y = axisRowY(axis.y, viewport);
      if (y < GUTTER_TOP_HEIGHT - EVENT_RADIUS || y > viewport.canvasHeight + EVENT_RADIUS) continue;
      const x = contentX(event.tcBegin, viewport);
      // Java `drawEvent()` (SequenceChart.java:3892-3913): an event spans `[xBegin, xEnd]`
      // and is drawn as a stadium/"pill" (two half-discs + connecting rectangle) whenever
      // xBegin != xEnd, or a plain disc when equal. The span is nonzero only in
      // STEP/NONLINEAR modes with `separateEventLogEntries` on (the engine returns
      // `tcEnd === tcBegin` otherwise -- see SequenceChartFacade.getTimelineCoordinateDelta).
      const xEnd = event.tcEnd === event.tcBegin ? x : contentX(event.tcEnd, viewport);
      // Cull only against the CANVAS edges, not the left gutter: the leaf-label strip is
      // transparent and the axis lines run under it, so events whose x lands there (e.g. the
      // init event #0 at t=0, right at the left edge) must still be drawn -- they were
      // vanishing when clipped at GUTTER_LEFT_WIDTH. The opaque compound band (overlay, on
      // top) naturally covers the tiny slice behind it.
      if (xEnd < -EVENT_RADIUS || x > viewport.canvasWidth + EVENT_RADIUS) continue;

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
        const markKind = event.isSelfMessageProcessingEvent ? 'selfEventMark' : 'eventMark';
        const baseMarkColor = event.isSelfMessageProcessingEvent ? (theme.isDark ? '#6fcf6f' : '#00ee00') : theme.eventColor;
        primitives.push({ kind: markKind, eventNumber: event.eventNumber, moduleId: event.moduleId, x, xEnd, y, radius: EVENT_RADIUS, color: baseMarkColor });
        if (flags.showEventNumbers && showLabels) primitives.push({ kind: 'label', x: x + 2, y: y + 10, text: `#${event.eventNumber}`, color: theme.descriptionForeground, align: 'left' });
        const evSelected = selectedEventNumbers?.has(event.eventNumber) ?? false;
        const evHovered = hovered?.events?.has(event.eventNumber) ?? false;
        if (evSelected) primitives.push({ kind: 'selectionMark', x, xEnd, y, radius: EVENT_RADIUS + 3, color: emphasisColor });
        // Phase U11 -- emphasis (redrawn on top): hover makes the mark BIGGER but keeps its
        // own color; selection recolors it RED (bigger too if also hovered). Java's
        // `drawHightlightedObjects()`/`drawEventSelectionMarks()` combined.
        if (evSelected || evHovered) emphasis.push({ kind: markKind, eventNumber: event.eventNumber, moduleId: event.moduleId, x, xEnd, y, radius: evHovered ? EVENT_RADIUS + 2 : EVENT_RADIUS, color: evSelected ? emphasisColor : baseMarkColor });
        if (bookmarkedEventNumbers?.has(event.eventNumber)) primitives.push({ kind: 'bookmarkMark', x: x - EVENT_RADIUS - 3, y: y - EVENT_RADIUS - 3, color: bookmarkMarkColor(theme) });
      }
    }
    for (const [xKey, col] of columnDensity) {
      if (col.count > MAX_EVENT_MARKS_PER_COLUMN) primitives.push({ kind: 'eventDensityLine', x: xKey, y0: col.y0 - EVENT_RADIUS, y1: col.y1 + EVENT_RADIUS, color: theme.descriptionForeground });
    }
  }

  // ---- message dependencies (arrows / self-message ellipses) ----
  const vlineBuffer = new VLineBuffer();
  const axisSpacing = Math.max(axesLayout.spacing, 1);
  const depCtx = { axisByModuleId, viewport, theme, arrowColors, flags, axisSpacing, vlineBuffer, showLabels, bookmarkedDependencyKeys };
  for (const dep of dependencies) {
    pushDependency(primitives, dep, depCtx);
  }
  // Phase U11 -- selection/hover emphasis for arrows: redraw a selected/hovered dependency
  // thicker in the highlight color, on top (Java `drawMessageDependencySelectionMarks()` /
  // the arrow branch of `drawHightlightedObjects()`). A FRESH VLineBuffer so the shared
  // one's earlier dedupe doesn't suppress this second, emphasized pass.
  if (selectedDependencyKeys?.size || hovered?.dependencyKeys?.size) {
    for (const dep of dependencies) {
      const key = dependencyEmphasisKey(dep);
      const isSel = selectedDependencyKeys?.has(key) ?? false;
      const isHov = hovered?.dependencyKeys?.has(key) ?? false;
      if (!isSel && !isHov) continue;
      pushDependency(emphasis, dep, { ...depCtx, vlineBuffer: new VLineBuffer(), showLabels: false, override: { emphasisColor, selected: isSel, hovered: isHov } });
    }
  }

  // ---- method calls ----
  // Java `drawOrFitComponentMethodCall()`: a call spans [xBegin, xEnd] (begin entry ->
  // matching end entry) between the source and target axes -- drawn as a faint filled bar
  // (its "length"/duration within the event pill), a solid CALL line at xBegin, a dashed
  // RETURN line at xEnd, and arrowheads. This replaces the previous single zero-width line.
  for (const call of flags.showComponentMethodCalls ? methodCalls : []) {
    if (!flags.showInitializationEvent && call.eventNumber === 0) continue;
    const sourceAxis = axisByModuleId.get(call.sourceModuleId);
    const targetAxis = axisByModuleId.get(call.targetModuleId);
    if (!sourceAxis || !targetAxis) continue;
    const xBegin = contentX(call.tc, viewport);
    const xEnd = call.tcEnd !== undefined && call.tcEnd !== call.tc ? contentX(call.tcEnd, viewport) : xBegin;
    let y1 = axisRowY(sourceAxis.y, viewport);
    let y2 = axisRowY(targetAxis.y, viewport);
    [y1, y2] = adjustEndpointsForEventRadius(y1, y2, EVENT_RADIUS, flags.showEventMarks);
    const color = arrowColors.method;
    const callRef: ArrowRef = { kind: 'methodCall', eventNumber: call.eventNumber, sourceModuleId: call.sourceModuleId, targetModuleId: call.targetModuleId, tc: call.tc, entryIndex: call.entryIndex, methodName: call.methodName };
    const hasWidth = xEnd > xBegin + 0.5;
    if (bookmarkedMethodCallKeys?.has(bookmarkMethodCallKey(call.eventNumber, call.entryIndex))) primitives.push({ kind: 'bookmarkMark', x: xBegin, y: y1, color: bookmarkMarkColor(theme) });
    // faint bar over the call's duration (Java's alpha-24 fillRectangle)
    if (hasWidth && y1 !== y2) primitives.push({ kind: 'parallelogram', points: [[xBegin, y1], [xEnd, y1], [xEnd, y2], [xBegin, y2]], color });
    // solid call line at xBegin (deduped against other near-vertical geometry)
    if (vlineBuffer.addAndCheck(xBegin, y1, y2)) {
      primitives.push({ kind: 'arrow', arrowKind: 'method', x1: xBegin, y1, x2: xBegin, y2, color, ref: callRef });
      if (flags.showArrowHeads && y1 !== y2) primitives.push({ kind: 'arrowHead', x: xBegin, y: y2, angle: Math.atan2(y2 - y1, 0), color, length: ARROWHEAD_LENGTH, width: ARROWHEAD_WIDTH });
    }
    // dashed return line at xEnd
    if (hasWidth && vlineBuffer.addAndCheck(xEnd, y1, y2)) {
      primitives.push({ kind: 'arrow', arrowKind: 'method', x1: xEnd, y1, x2: xEnd, y2, color, dash: [2, 2], ref: callRef });
      if (flags.showArrowHeads && y1 !== y2) primitives.push({ kind: 'arrowHead', x: xEnd, y: y1, angle: Math.atan2(y1 - y2, 0), color, length: ARROWHEAD_LENGTH, width: ARROWHEAD_WIDTH });
    }
    // method-name label rotated -90 along the call's begin edge
    if (flags.showMethodNames && showLabels) {
      const name = call.methodName.includes('(') ? call.methodName.slice(0, call.methodName.indexOf('(')) : call.methodName;
      primitives.push({ kind: 'label', x: xBegin, y: (y1 + y2) / 2, text: name, color, align: 'center', rotateDeg: -90 });
    }
    // selection/hover emphasis: redraw the call/return lines thicker (hover) / red (selected)
    // on top -- makes method calls hoverable+selectable like message arrows.
    const mcKey = `${call.eventNumber}:${call.sourceModuleId}:${call.targetModuleId}:${call.tc}`;
    const mcSelected = selectedMethodCallKeys?.has(mcKey) ?? false;
    const mcHovered = hovered?.methodCallKeys?.has(mcKey) ?? false;
    if (mcSelected || mcHovered) {
      const ecolor = mcSelected ? emphasisColor : color;
      const ewidth = mcHovered ? 3 : 1.5;
      emphasis.push({ kind: 'arrow', arrowKind: 'method', x1: xBegin, y1, x2: xBegin, y2, color: ecolor, width: ewidth, ref: callRef });
      if (hasWidth) emphasis.push({ kind: 'arrow', arrowKind: 'method', x1: xEnd, y1, x2: xEnd, y2, color: ecolor, width: ewidth, dash: [2, 2], ref: callRef });
    }
  }

  // ---- selected timeline coordinates (background clicks) -- a vertical red line per
  // selected time (Java `drawTimelineSelectionMarks()`), on top of the scene. ----
  for (const coord of selectedTimelineCoords ?? []) {
    const cx = contentX(coord.tc, viewport);
    // The red time-selection line runs to the left canvas edge too, visible through the band.
    if (cx < 0 || cx > viewport.canvasWidth) continue;
    emphasis.push({ kind: 'timelineMark', x: cx, y0: GUTTER_TOP_HEIGHT, y1: viewport.canvasHeight, color: emphasisColor });
  }

  // ---- time differences (Java `drawTimeDifferences()`, gated by `showTimeDifferences`,
  // default on) -- a dashed red polyline through EVERY selected event AND selected
  // timeline coordinate, ordered by timeline coordinate, each segment labeled with the
  // pairwise simulation-time delta. This is the Eclipse "measure the time between things
  // you click / ctrl-click" mechanic. ----
  if (flags.showTimeDifferences) {
    const contentMidY = (GUTTER_TOP_HEIGHT + viewport.canvasHeight) / 2;
    const diffPoints: { tc: number; simulationTime: string; x: number; y: number }[] = [];
    if (selectedEventNumbers) {
      for (const e of events) {
        if (!selectedEventNumbers.has(e.eventNumber)) continue;
        const axis = axisByModuleId.get(e.moduleId);
        if (!axis) continue;
        const tc = (e.tcBegin + e.tcEnd) / 2;
        diffPoints.push({ tc, simulationTime: e.simulationTime, x: contentX(tc, viewport), y: axisRowY(axis.y, viewport) });
      }
    }
    for (const coord of selectedTimelineCoords ?? []) {
      diffPoints.push({ tc: coord.tc, simulationTime: coord.simulationTime, x: contentX(coord.tc, viewport), y: contentMidY });
    }
    diffPoints.sort((a, b) => a.tc - b.tc);
    for (let i = 1; i < diffPoints.length; i++) {
      const prev = diffPoints[i - 1];
      const cur = diffPoints[i];
      primitives.push({ kind: 'arrow', arrowKind: 'send', x1: prev.x, y1: prev.y, x2: cur.x, y2: cur.y, color: emphasisColor, dash: [3, 2] });
      if (showLabels) {
        const delta = subtractDecimalStrings(cur.simulationTime, prev.simulationTime);
        const text = (isNegativeDecimal(delta) ? '-' : '') + formatSimulationTime(delta.replace(/^-/, ''));
        primitives.push({ kind: 'timeDifferenceLabel', x: (prev.x + cur.x) / 2, y: (prev.y + cur.y) / 2 - 12, text, color: emphasisColor });
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

  // Phase U11 -- selection/hover emphasis last, so it layers on top of the base scene.
  for (const p of emphasis) primitives.push(p);

  // Phase U11 -- the live "tick under the mouse": a vertical hairline + a top-gutter time
  // box, drawn on the very top so it tracks the cursor over everything else.
  if (params.mouseTick && params.mouseTick.x >= GUTTER_LEFT_WIDTH && params.mouseTick.x <= viewport.canvasWidth) {
    primitives.push({ kind: 'mouseTick', x: params.mouseTick.x, y0: GUTTER_TOP_HEIGHT, y1: viewport.canvasHeight, label: params.mouseTick.label, lineColor: theme.descriptionForeground, textColor: theme.isDark ? theme.foreground : '#000000', bgColor: theme.isDark ? '#264f4f' : '#e0ffff' });
  }
  // Java `drawTickPrefix()`: the shared time offset boxed in the top gutter's right corner.
  if (params.tickPrefixLabel) {
    primitives.push({ kind: 'tickPrefixBox', label: params.tickPrefixLabel, rightX: viewport.canvasWidth, color: theme.descriptionForeground, textColor: theme.isDark ? theme.foreground : '#000000', bgColor: theme.isDark ? '#264f4f' : '#e0ffff' });
  }
  return primitives;
}

function pushInfoPanel(primitives: DrawPrimitive[], theme: EventLogPalette, lines: [string, string], canvasWidth: number, anchorY: number, edge: 'top' | 'bottom'): void {
  primitives.push({ kind: 'infoPanel', lines: [lines[0], lines[1]], rightX: canvasWidth, anchorY, edge, background: theme.isDark ? '#264f4f' : '#e0ffff', color: theme.isDark ? theme.foreground : '#000000' });
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
  /** Phase U11 -- the selection/hover emphasis pass. Hover keeps the dependency's own color but draws it WIDER; selection recolors it to `emphasisColor` (red). Either way it's solid (no message dash) and drawn on top of the base scene. */
  override?: { emphasisColor: string; selected: boolean; hovered: boolean };
}

/**
 * Whether `dep` would be drawn at all under the current display flags -- Java's per-kind/
 * self `showMessage*`/`showMixed*` checks (`drawOrFitMessageDependency()`'s early exits)
 * plus the `showInitializationEvent` cause-is-init-event exclusion
 * (`drawMessageDependencies()`). Independent of axis/module resolution (a dependency can
 * pass this and still not draw if its module has no axis -- that's a separate concern).
 * Exported so `collectActiveModuleIds()` (openAxisModules.ts) can use the EXACT same rule
 * to decide whether a dependency counts as "activity" justifying an axis for its endpoint
 * modules when Empty Axes is off -- a single source of truth prevents the two from drifting
 * apart (which is exactly what let empty-looking axes appear: a module whose only
 * connection was a currently-hidden dependency still counted as "active").
 */
export function dependencyPassesDisplayFlags(dep: Pick<RenderDependency, 'kind' | 'filteredKind' | 'causeModuleId' | 'consequenceModuleId' | 'causeEventNumber'>, flags: ChartDisplayFlags): boolean {
  if (!flags.showInitializationEvent && dep.causeEventNumber === 0) return false;
  const isSelf = dep.causeModuleId !== null && dep.causeModuleId === dep.consequenceModuleId;
  const isFiltered = dep.kind === 'filtered';
  const isReuse = dep.kind === 'reuse';
  if (isFiltered) {
    return isSelf
      ? dep.filteredKind === 'reuses'
        ? flags.showSelfMessageReuses
        : dep.filteredKind === 'sends'
          ? flags.showSelfMessageSends
          : flags.showMixedSelfMessageDependencies
      : dep.filteredKind === 'reuses'
        ? flags.showMessageReuses
        : dep.filteredKind === 'sends'
          ? flags.showMessageSends
          : flags.showMixedMessageDependencies;
  }
  if (isReuse) return isSelf ? flags.showSelfMessageReuses : flags.showMessageReuses;
  return isSelf ? flags.showSelfMessageSends : flags.showMessageSends;
}

function pushDependency(primitives: DrawPrimitive[], dep: RenderDependency, ctx: DependencyDrawContext): void {
  const { axisByModuleId, viewport, theme, arrowColors, flags, axisSpacing, vlineBuffer, showLabels, bookmarkedDependencyKeys, override } = ctx;
  if (!dependencyPassesDisplayFlags(dep, flags)) return;
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

  const arrowKind: ArrowKind = dep.kind === 'send' ? 'send' : dep.kind === 'reuse' ? 'reuse' : 'filtered';
  let { color, dash } = isFiltered ? filteredColorAndDash(arrowColors, dep.filteredKind) : { color: arrowColors[arrowKind], dash: arrowKind === 'reuse' ? [2, 2] : undefined };
  // Hover = same color, wider (3px); selection = red, Eclipse's 1.5px selection width.
  const arrowWidth = override ? (override.hovered ? 3 : 1.5) : undefined;
  if (override) {
    if (override.selected) color = override.emphasisColor;
    dash = undefined; // emphasis is solid
  }
  // A split arrow's offscreen side has no real tc -- fall back to the KNOWN side so a
  // double-click "zoom to message" (which does `Math.min(causeTc, consequenceTc)`/`max`)
  // still zooms somewhere sensible instead of producing a `NaN` range.
  const depRef: ArrowRef = { kind: 'dependency', dependencyKind: arrowKind as 'send' | 'reuse' | 'filtered', causeEventNumber: dep.causeEventNumber, consequenceEventNumber: dep.consequenceEventNumber, causeTc: dep.causeTc ?? dep.consequenceTc ?? 0, consequenceTc: dep.consequenceTc ?? dep.causeTc ?? 0 };

  const causeAxis = axisByModuleId.get(dep.causeModuleId)!;
  const consequenceAxis = axisByModuleId.get(dep.consequenceModuleId)!;
  let causeX = dep.causeTc === null ? null : contentX(dep.causeTc, viewport);
  let consequenceX = dep.consequenceTc === null ? null : contentX(dep.consequenceTc, viewport);
  // Both endpoints resolved, but too far apart to draw as one line without cluttering the
  // view -- elide whichever side is farther from the visible content area (matches Java's
  // eventNumber-out-of-drawn-range choice closely enough: the near side stays real, the far
  // side is treated exactly like an unresolvable/offscreen endpoint below).
  if (causeX !== null && consequenceX !== null && Math.abs(consequenceX - causeX) > MAX_DEPENDENCY_ARROW_WIDTH_FACTOR * contentWidth(viewport)) {
    if (distanceFromContentArea(causeX, viewport) <= distanceFromContentArea(consequenceX, viewport)) consequenceX = null;
    else causeX = null;
  }

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
      primitives.push({ kind: 'arrow', arrowKind, x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2, color, dash: seg.dashed ? OFFSCREEN_DASH : dash, ref: depRef, width: arrowWidth });
    }
    // The arc follows the dependency's own dash: REUSE arcs are dotted (Java + this port),
    // self-message SENDS stay solid. (`dash` is [2,2] for reuse, undefined for send.)
    if (geom.ellipse) primitives.push({ kind: 'ellipseArc', ...geom.ellipse, color, ref: depRef, width: arrowWidth, dash });
    if (geom.arrowhead) primitives.push({ kind: 'arrowHead', x: geom.arrowhead.x, y: geom.arrowhead.y, angle: geom.arrowhead.angle, color: geom.arrowhead.long ? LONG_ARROWHEAD_COLOR : color, length: geom.arrowhead.length, width: geom.arrowhead.width });
    if (isFiltered && geom.signAnchor) primitives.push({ kind: 'zigzag', segments: buildFilteredSignSegments(geom.signAnchor), color });
    if (flags.showMessageNames && showLabels && dep.messageName) primitives.push({ kind: 'label', x: geom.labelAnchor.x + (isFiltered ? 7 : 0), y: geom.labelAnchor.y, text: dep.messageName, color, align: 'left' });
    if (isBookmarked) primitives.push({ kind: 'bookmarkMark', x: geom.labelAnchor.x, y: geom.labelAnchor.y, color: bookmarkMarkColor(theme) });
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
    isReceptionStart: flags.showTransmissionDurations ? dep.isReceptionStart : undefined,
    transmissionDurationX1: flags.showTransmissionDurations && dep.transmissionDurationTc1 !== undefined && dep.transmissionDurationTc1 !== null ? contentX(dep.transmissionDurationTc1, viewport) : null,
    transmissionDurationX2: flags.showTransmissionDurations && dep.transmissionDurationTc2 !== undefined && dep.transmissionDurationTc2 !== null ? contentX(dep.transmissionDurationTc2, viewport) : null,
    transmissionDurationX3: flags.showTransmissionDurations && dep.transmissionDurationTc3 !== undefined && dep.transmissionDurationTc3 !== null ? contentX(dep.transmissionDurationTc3, viewport) : null,
    transmissionDurationX4: flags.showTransmissionDurations && dep.transmissionDurationTc4 !== undefined && dep.transmissionDurationTc4 !== null ? contentX(dep.transmissionDurationTc4, viewport) : null,
  });
  if (!geom) return;

  if (geom.parallelogram) primitives.push({ kind: 'parallelogram', points: geom.parallelogram.points, color, borderColor: theme.isDark ? '#ffffff' : '#000000' });
  for (const seg of geom.segments) {
    if (Math.abs(seg.x2 - seg.x1) < 1 && !vlineBuffer.addAndCheck((seg.x1 + seg.x2) / 2, seg.y1, seg.y2)) continue;
    primitives.push({ kind: 'arrow', arrowKind, x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2, color, dash: seg.dashed ? OFFSCREEN_DASH : dash, ref: depRef, width: arrowWidth });
  }
  if (geom.arrowhead) primitives.push({ kind: 'arrowHead', x: geom.arrowhead.x, y: geom.arrowhead.y, angle: geom.arrowhead.angle, color: geom.arrowhead.long ? LONG_ARROWHEAD_COLOR : color, length: geom.arrowhead.length, width: geom.arrowhead.width });
  if (isFiltered && geom.signAnchor) primitives.push({ kind: 'zigzag', segments: buildFilteredSignSegments(geom.signAnchor), color });
  if (flags.showMessageNames && showLabels && dep.messageName) primitives.push({ kind: 'label', x: geom.labelAnchor.x + (isFiltered ? 7 : 0), y: geom.labelAnchor.y, text: dep.messageName, color, align: 'left' });
  if (isBookmarked) primitives.push({ kind: 'bookmarkMark', x: geom.labelAnchor.x, y: geom.labelAnchor.y, color: bookmarkMarkColor(theme) });
}
