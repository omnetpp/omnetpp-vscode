/**
 * Pure math for the Event Log table's approximate custom scrollbar. Ported from
 * `VirtualTable.java` (omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/common/
 * virtualtable/VirtualTable.java):
 *  - `configureVerticalScrollBar()` (~line 829) -- thumb sizing, `1e6`-capped max.
 *  - `updateVerticalBarPosition()` (~line 851) -- the weighted blend of the top/bottom
 *    visible row's percentage.
 *  - `EventLogTable.EventLogEntryReferenceEnumerator.getApproximateDelta()`
 *    (omnetpp-dev/ui/org.omnetpp.eventlogtable/src/org/omnetpp/eventlogtable/widgets/
 *    EventLogTable.java, ~line 97) -- the percentage-based distance fallback for
 *    entries more than 100 apart.
 *
 * No DOM/engine access here -- every function takes plain numbers (percentages,
 * counts) already resolved by the caller (`tableView.ts`, which gets them from
 * `RowWindow`/`TablePositionResult`'s `approximatePercentage`/`approximateNumberOfEntries`
 * fields, per elogProtocol.ts).
 */

/** Java's `ScrollBar` state: `verticalBar.setMaximum(...)`/`setThumb(...)` (min is always 0). */
export interface ScrollbarGeometry {
  max: number;
  thumb: number;
}

/**
 * Port of `configureVerticalScrollBar()`. `approximateNumberOfElements` is
 * `RowWindow.approximateNumberOfEntries`; `visibleElementCount` is the table's current
 * fully-visible row count (`getVisibleElementCount()`-equivalent). Returns `{max: 0,
 * thumb: 0}` for an empty/unknown table, matching Java's `else` branch (no
 * `contentProvider`).
 */
export function computeScrollbarGeometry(approximateNumberOfElements: number, visibleElementCount: number): ScrollbarGeometry {
  if (approximateNumberOfElements <= 0) return { max: 0, thumb: 0 };
  const max = Math.min(approximateNumberOfElements, 1_000_000);
  const thumb = Math.floor((max * visibleElementCount) / approximateNumberOfElements);
  return { max, thumb };
}

/**
 * Port of `updateVerticalBarPosition()`'s weighted blend. `topPercentage`/
 * `bottomPercentage` are `getApproximatePercentageForElement()`-equivalent values (in
 * `[0,1]`) for the top visible and bottom fully-visible row; pass `0`/`1` when there is
 * no such row (Java: `topVisibleElement == null ? 0 : ...` / `bottomFullyVisibleElement
 * == null ? 1 : ...`). Relies on IEEE double semantics for `1/0 === Infinity` exactly
 * like the Java original (`1 / topPercentage` when `topPercentage === 0`), so the
 * branch structure is preserved verbatim rather than special-cased.
 */
export function computeScrollbarPercentage(topPercentage: number, bottomPercentage: number): number {
  const topWeight = 1 / topPercentage;
  const bottomWeight = 1 / (1 - bottomPercentage);
  if (!Number.isFinite(topWeight)) return topPercentage;
  if (!Number.isFinite(bottomWeight)) return bottomPercentage;
  return (topPercentage * topWeight + bottomPercentage * bottomWeight) / (topWeight + bottomWeight);
}

/** Port of `verticalBar.setSelection((int)((max - thumb) * percentage))`. */
export function percentageToScrollbarSelection(percentage: number, geometry: ScrollbarGeometry): number {
  return Math.round((geometry.max - geometry.thumb) * percentage);
}

/** Inverse of `percentageToScrollbarSelection()` -- for mapping a scrollbar-drag position back to a percentage (not literally in VirtualTable.java, which reads `ScrollBar.getSelection()` from the SWT widget directly; the webview has no such widget, so this is the DOM-drag equivalent). Returns `0` when `max === thumb` (nothing to drag -- whole log fits on screen). */
export function scrollbarSelectionToPercentage(selection: number, geometry: ScrollbarGeometry): number {
  const range = geometry.max - geometry.thumb;
  if (range <= 0) return 0;
  return Math.min(1, Math.max(0, selection / range));
}

/**
 * Port of `EventLogEntryReferenceEnumerator.getApproximateDelta()`'s percentage-based
 * fallback (the exact-within-100 branch is the engine's job -- `EventLogTableFacade.
 * getEntryAndDistance()`/`getNeighbourEntry()` -- not this pure module's; a caller that
 * already has an exact distance should just use it directly instead of calling this).
 * `percentage1 <= percentage2` is assumed (Java: only called when the two elements are
 * given in log order); the truncation matches Java's `(int)` cast (`Math.trunc`, not
 * `Math.floor` -- rounds toward zero).
 */
export function approximateDelta(approximateNumberOfElements: number, percentage1: number, percentage2: number): number {
  return Math.trunc(approximateNumberOfElements * (percentage2 - percentage1));
}
