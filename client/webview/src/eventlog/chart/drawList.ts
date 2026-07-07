/**
 * drawList.ts (PURE) — `(events, dependencies, methodCalls, axesLayout, ticks,
 * viewport, theme) -> DrawPrimitive[]`, in absolute CANVAS px (gutters already
 * baked in) so `canvasStack.ts` is a dumb executor with no layout knowledge of its
 * own. This is the only place that knows the two-gutter layout (top: simtime ruler,
 * left: axis labels — see viewportState.ts's `GUTTER_LEFT_WIDTH`/`GUTTER_TOP_HEIGHT`).
 *
 * Fidelity notes (per this phase's report):
 *  - Arrows are always straight lines with a triangular arrowhead at the consequence
 *    end (`SequenceChartStyleProvider`: `arrowheadLength=10`, `arrowheadWidth=7`).
 *    Java's full arrow taxonomy (self-message half-ellipses, long-arrow ellipses,
 *    split offscreen arrows, reuse/mixed zigzags, transmission-duration
 *    parallelograms) is phase U5 — explicitly deferred.
 *  - A dependency whose `causeModuleId === consequenceModuleId` (a self-message) is
 *    drawn as a simple vertical "hairpin"/staple shape (`'hairpin'` primitive) rather
 *    than Java's half-ellipse — per this phase's brief ("self-message arcs DEFERRED
 *    to U5, draw self-deps as simple vertical hairpin placeholders").
 *  - `dependencies`/`methodCalls` whose cause or consequence side has a `null` tc
 *    (protocol: "outside currently-parsed range") or an unresolvable module id (not
 *    in `axesLayout`) are silently skipped — a later render pass with a wider fetch
 *    window will include them once resolvable.
 *  - `VLineBuffer` port: two independent dedupe passes over near-vertical geometry,
 *    both keyed by a rounded-to-1px x "column" (Java keys by exact SWT integer
 *    pixel; a rounding bucket is the closest continuous-coordinate equivalent):
 *      1. Near-vertical arrow segments (`|x1-x2| < 1px`, e.g. a send/reuse dependency
 *         whose two endpoints round to the same simtime): exact interval-containment
 *         dedupe, faithful to `VLineBuffer.vlineContainsNewPixel()`
 *         (`SequenceChart.java:6415-6487`) — SIMPLIFICATION: Java only tracks the
 *         single MOST RECENT x column (a `currentX` pointer + reset-on-change),
 *         relying on same-x calls being naturally consecutive because arrows are
 *         drawn in a single left-to-right pass; this port's primitives are built in
 *         EVENT-NUMBER order (not x order), so same-x items are not guaranteed
 *         adjacent — a persistent `Map<xKey, intervals[]>` is used instead. Same
 *         dedup RESULT, just without Java's single-slot memory optimization.
 *      2. Dense event-mark columns (NOT a real `VLineBuffer` use in Java — an
 *         extension in the spirit of "dedupe near-vertical hairlines at the same x"
 *         applied to marks instead of arrows, since a dense log can put hundreds of
 *         events at pixel-identical x): once a column exceeds
 *         `MAX_EVENT_MARKS_PER_COLUMN`, further individual `eventMark`/
 *         `selfEventMark` primitives at that column are dropped and replaced by one
 *         `eventDensityLine` primitive spanning the column's observed y-range.
 */

import { TimelineMode, type RenderDependency, type RenderMethodCall, type TimelineEvent } from '@omnetpp/shared/elog-protocol';
import type { EventLogPalette } from '../common/theme';
import type { AxesLayout } from './axes';
import { clipCoordinate, tcToPixel } from './coords';
import type { Tick } from './ticks';
import { GUTTER_LEFT_WIDTH, GUTTER_TOP_HEIGHT, type ViewportState } from './viewportState';

export const EVENT_RADIUS = 3;
export const ARROWHEAD_LENGTH = 10;
export const ARROWHEAD_WIDTH = 7;
export const HAIRPIN_HEIGHT = 10;
export const MAX_EVENT_MARKS_PER_COLUMN = 20;

export type ArrowKind = 'send' | 'reuse' | 'filtered' | 'method';

/**
 * Stable identity carried by arrow/hairpin primitives so `hitTest.ts` (phase U4) can
 * report WHAT was hit without re-deriving it from pixel geometry. A message
 * dependency's identity is its `(kind, causeEventNumber, consequenceEventNumber)`
 * triple (the protocol has no separate dependency id); a method call's is
 * `(eventNumber, sourceModuleId, targetModuleId, tc)` (`RenderMethodCall` has no id
 * either, but this tuple is unique per the engine's own one-call-per-event-pair-per-tc
 * invariant). `causeTc`/`consequenceTc` ride along so a hit result (or a "zoom to
 * message" double-click, U4) never needs a second round trip just to re-learn the tc
 * span it already had at draw time.
 */
export type ArrowRef =
  | { kind: 'dependency'; dependencyKind: ArrowKind & ('send' | 'reuse' | 'filtered'); causeEventNumber: number; consequenceEventNumber: number; causeTc: number; consequenceTc: number }
  | { kind: 'methodCall'; eventNumber: number; sourceModuleId: number; targetModuleId: number; tc: number };

export type DrawPrimitive =
  | { kind: 'gutter'; part: 'top' | 'left'; x: number; y: number; w: number; h: number; color: string }
  | { kind: 'axisLine'; moduleId: number; x1: number; x2: number; y: number; lineHeight: number; color: string }
  | { kind: 'axisLabel'; moduleId: number; x: number; y: number; text: string; color: string }
  | { kind: 'tick'; x: number; y0: number; y1: number; color: string }
  | { kind: 'eventMark'; eventNumber: number; moduleId: number; x: number; y: number; radius: number; color: string }
  | { kind: 'selfEventMark'; eventNumber: number; moduleId: number; x: number; y: number; radius: number; color: string }
  | { kind: 'eventDensityLine'; x: number; y0: number; y1: number; color: string }
  | { kind: 'arrow'; arrowKind: ArrowKind; x1: number; y1: number; x2: number; y2: number; color: string; dash?: number[]; ref?: ArrowRef }
  | { kind: 'arrowHead'; x: number; y: number; angle: number; color: string; length: number; width: number }
  | { kind: 'hairpin'; x1: number; x2: number; y: number; height: number; color: string; ref?: ArrowRef }
  | { kind: 'label'; x: number; y: number; text: string; color: string; align?: 'left' | 'center' | 'right' }
  /** Phase U4 — a selection ring around a selected event (Eclipse's `drawSelectionMarks`, ported as a fixed red ring rather than reading a style-provider color, since this port has no separate style-provider config yet). */
  | { kind: 'selectionMark'; x: number; y: number; radius: number; color: string };

/** Colors this module needs beyond `EventLogPalette` (reuse/filtered-dependency dash colors) — derived locally from the imported palette rather than editing `common/theme.ts` (out of this phase's file ownership). */
export function deriveArrowColors(theme: EventLogPalette): Record<ArrowKind, string> {
  return {
    send: theme.arrowColor,
    reuse: theme.isDark ? '#6fcf6f' : '#008b00',
    filtered: theme.isDark ? '#5fd0d0' : '#008b8b',
    method: theme.methodCallColor,
  };
}

const ARROW_DASH: Record<ArrowKind, number[] | undefined> = {
  send: undefined,
  reuse: [2, 2],
  filtered: [4, 4],
  method: undefined,
};

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

export interface BuildDrawListParams {
  timelineMode: TimelineMode;
  viewport: ViewportState;
  events: TimelineEvent[];
  dependencies: RenderDependency[];
  methodCalls: RenderMethodCall[];
  axesLayout: AxesLayout;
  ticks: Tick[];
  theme: EventLogPalette;
  /** Phase U4 — event numbers currently selected (`selection.ts`'s `ChartSelectionState.events`); each gets a `'selectionMark'` ring around its event mark. Omitted/undefined = no selection marks (e.g. a caller that doesn't track selection yet). */
  selectedEventNumbers?: ReadonlySet<number>;
}

export function buildDrawList(params: BuildDrawListParams): DrawPrimitive[] {
  const { viewport, events, dependencies, methodCalls, axesLayout, ticks, theme, selectedEventNumbers } = params;
  const primitives: DrawPrimitive[] = [];
  const arrowColors = deriveArrowColors(theme);
  const axisByModuleId = new Map(axesLayout.axes.map((a) => [a.moduleId, a]));

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

  // ---- axis lines + pinned labels ----
  for (const axis of axesLayout.axes) {
    const y = axisRowY(axis.y, viewport);
    if (y < GUTTER_TOP_HEIGHT - axis.lineHeight || y > viewport.canvasHeight + axis.lineHeight) continue;
    primitives.push({ kind: 'axisLine', moduleId: axis.moduleId, x1: GUTTER_LEFT_WIDTH, x2: viewport.canvasWidth, y, lineHeight: axis.lineHeight, color: theme.foreground });
    primitives.push({ kind: 'axisLabel', moduleId: axis.moduleId, x: 4, y, text: axis.label, color: theme.foreground });
  }

  // ---- events (with dense-column capping) ----
  const columnDensity = new Map<number, { count: number; y0: number; y1: number }>();
  for (const event of events) {
    const axis = axisByModuleId.get(event.moduleId);
    if (!axis) continue;
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
      if (selectedEventNumbers?.has(event.eventNumber)) primitives.push({ kind: 'selectionMark', x, y, radius: EVENT_RADIUS + 3, color: SELECTION_MARK_COLOR });
    }
  }
  for (const [xKey, col] of columnDensity) {
    if (col.count > MAX_EVENT_MARKS_PER_COLUMN) primitives.push({ kind: 'eventDensityLine', x: xKey, y0: col.y0 - EVENT_RADIUS, y1: col.y1 + EVENT_RADIUS, color: theme.descriptionForeground });
  }

  // ---- message dependencies (arrows) ----
  const vlineBuffer = new VLineBuffer();
  for (const dep of dependencies) {
    if (dep.causeTc === null || dep.consequenceTc === null) continue;
    if (dep.causeModuleId === null || dep.consequenceModuleId === null) continue;
    const causeAxis = axisByModuleId.get(dep.causeModuleId);
    const consequenceAxis = axisByModuleId.get(dep.consequenceModuleId);
    if (!causeAxis || !consequenceAxis) continue;

    const arrowKind: ArrowKind = dep.kind === 'send' ? 'send' : dep.kind === 'reuse' ? 'reuse' : 'filtered';
    const color = arrowColors[arrowKind];
    const x1 = contentX(dep.causeTc, viewport);
    const y1 = axisRowY(causeAxis.y, viewport);
    const x2 = contentX(dep.consequenceTc, viewport);
    const y2 = axisRowY(consequenceAxis.y, viewport);

    const depRef: ArrowRef = { kind: 'dependency', dependencyKind: arrowKind as 'send' | 'reuse' | 'filtered', causeEventNumber: dep.causeEventNumber, consequenceEventNumber: dep.consequenceEventNumber, causeTc: dep.causeTc, consequenceTc: dep.consequenceTc };

    if (dep.causeModuleId === dep.consequenceModuleId) {
      // self-message -- simple hairpin placeholder (see this file's header)
      primitives.push({ kind: 'hairpin', x1, x2, y: y1, height: HAIRPIN_HEIGHT, color, ref: depRef });
      continue;
    }

    if (Math.abs(x2 - x1) < 1 && !vlineBuffer.addAndCheck((x1 + x2) / 2, y1, y2)) continue;

    primitives.push({ kind: 'arrow', arrowKind, x1, y1, x2, y2, color, dash: ARROW_DASH[arrowKind], ref: depRef });
    const angle = Math.atan2(y2 - y1, x2 - x1);
    primitives.push({ kind: 'arrowHead', x: x2, y: y2, angle, color, length: ARROWHEAD_LENGTH, width: ARROWHEAD_WIDTH });
  }

  // ---- method calls ----
  for (const call of methodCalls) {
    const sourceAxis = axisByModuleId.get(call.sourceModuleId);
    const targetAxis = axisByModuleId.get(call.targetModuleId);
    if (!sourceAxis || !targetAxis) continue;
    const x = contentX(call.tc, viewport);
    const y1 = axisRowY(sourceAxis.y, viewport);
    const y2 = axisRowY(targetAxis.y, viewport);
    const color = arrowColors.method;
    // method calls are drawn between two axes at the same tc -- a vertical arrow, still deduped like any other near-vertical segment
    if (!vlineBuffer.addAndCheck(x, y1, y2)) continue;
    const callRef: ArrowRef = { kind: 'methodCall', eventNumber: call.eventNumber, sourceModuleId: call.sourceModuleId, targetModuleId: call.targetModuleId, tc: call.tc };
    primitives.push({ kind: 'arrow', arrowKind: 'method', x1: x, y1, x2: x, y2, color, ref: callRef });
    const angle = Math.atan2(y2 - y1, 0);
    primitives.push({ kind: 'arrowHead', x, y: y2, angle, color, length: ARROWHEAD_LENGTH, width: ARROWHEAD_WIDTH });
    primitives.push({ kind: 'label', x: x + 4, y: (y1 + y2) / 2, text: call.methodName, color, align: 'left' });
  }

  return primitives;
}
