/**
 * Fixed-height DOM row pool for the Event Log table -- never one node per log line
 * (millions of rows must never touch the DOM at once). `resize(count)` grows/shrinks a
 * flat array of absolutely-positioned `<div class="elog-row">`s to exactly `count`
 * elements and repositions them by index (`top: index * rowHeight`); callers then fill
 * in each row's content and reuse the pool across scrolls/re-renders instead of
 * recreating nodes.
 *
 * `computeTopIndex()` is the pure part of the windowing math (extracted so it is
 * unit-testable without a DOM): given a fetched `RowWindow`-shaped array and the index
 * of its resolved anchor entry, decide which array index should land on screen row 0 so
 * that (a) the anchor entry appears at its requested on-screen `distance`, and (b) the
 * displayed window never runs past the start/end of the fetched rows when there is nothing
 * more before/after to show (Java's `relocateFixPoint()` "always keep the first/last
 * visible row displaying an element" invariant, ~VirtualTable.java line 995-1030,
 * ported as a clamp rather than the original's edge-snap-and-refetch dance -- see
 * `tableView.ts`'s header for why this port always re-anchors at the resulting top row
 * afterward instead of tracking a persistently-drifting fix point).
 */

export interface RowPool {
  /** Ensures the pool has exactly `count` rows, positioned in order; returns them (index 0 = screen row 0). */
  resize(count: number): HTMLDivElement[];
  /** Removes every pooled row (equivalent to `resize(0)`). */
  clear(): void;
}

export function createRowPool(container: HTMLElement, rowHeightPx: number): RowPool {
  const rows: HTMLDivElement[] = [];

  function resize(count: number): HTMLDivElement[] {
    while (rows.length < count) {
      const el = document.createElement('div');
      el.className = 'elog-row';
      el.style.position = 'absolute';
      el.style.left = '0';
      el.style.right = '0';
      el.style.height = `${rowHeightPx}px`;
      container.appendChild(el);
      rows.push(el);
    }
    while (rows.length > count) rows.pop()!.remove();
    for (let i = 0; i < rows.length; i++) rows[i].style.top = `${i * rowHeightPx}px`;
    return rows;
  }

  return {
    resize,
    clear: () => resize(0),
  };
}

/**
 * Pure windowing math: given `rowsLength` fetched rows (the anchor entry resolved at
 * `anchorIndex` within them), `desiredDistance` (the on-screen row the anchor entry
 * should ideally occupy), `viewportRowCount` (fully-visible rows), and whether more
 * rows exist beyond what was fetched in each direction, returns the index (into the
 * fetched array) that should be displayed at screen row 0. Screen row `i` then shows
 * `rows[topIndex + i]` (or nothing, if that index is out of bounds -- only possible
 * when the whole log has fewer entries than `viewportRowCount`).
 */
export function computeTopIndex(
  anchorIndex: number,
  desiredDistance: number,
  rowsLength: number,
  viewportRowCount: number,
  hasMoreBefore: boolean,
  hasMoreAfter: boolean,
): number {
  let topIndex = anchorIndex - desiredDistance;
  // Never scroll past the start of what was fetched when nothing more precedes it.
  if (!hasMoreBefore) topIndex = Math.max(topIndex, 0);
  // Never leave a gap at the bottom when nothing more follows what was fetched.
  if (!hasMoreAfter) topIndex = Math.min(topIndex, Math.max(0, rowsLength - viewportRowCount));
  return Math.max(0, Math.min(topIndex, Math.max(0, rowsLength - 1)));
}
