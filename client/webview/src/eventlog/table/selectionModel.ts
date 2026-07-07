/**
 * Pure selection-state reducer for the Event Log table. Ported from
 * `VirtualTable.java`'s `moveFocusTo()`/`doGotoElement()`
 * (omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/common/virtualtable/
 * VirtualTable.java, ~lines 802-942): focus/anchor bookkeeping + a `RangeSet<T>`
 * membership set, driven by the same "no shift/ctrl", "shift only", "ctrl only
 * (click)", "ctrl+shift" branch structure Java uses.
 *
 * `RowRef` (elogProtocol.ts: `{eventNumber, entryIndex}`) has a well-defined total
 * order that matches on-screen row order regardless of the current line-filter mode
 * (filtering only ever removes rows, never reorders them: entries within one event
 * keep ascending `entryIndex`, and events strictly increase by `eventNumber`) -- see
 * `compareRowRef()`. That lets a whole "select rows A..B" range be represented as just
 * `{from: A, to: B}` (two refs), the same way Java's `RangeSet` never needs to
 * enumerate a huge range's members either.
 *
 * Deliberate deviation from Java's `RangeSet<T>`: this port keeps ranges as a flat,
 * non-canonicalized array (`SelectionRange[]`) instead of a self-merging/self-splitting
 * interval set. `addRange()`/`addPoint()` simply append; `removePoint()` splits any
 * range that contains the point. This means `ranges.length` can grow with the number of
 * ctrl+click/ctrl+shift-click actions a user performs in one sitting (bounded by human
 * interaction, not by log size) -- `isSelected()` is a linear scan over that list, which
 * is the only thing that ever needs to be fast (called once per visible row per
 * repaint), never over the full (possibly huge) selected range itself.
 */

import type { RowRef } from '@omnetpp/shared/elog-protocol';

/** Total order matching on-screen row order (see this file's header). */
export function compareRowRef(a: RowRef, b: RowRef): number {
  return a.eventNumber - b.eventNumber || a.entryIndex - b.entryIndex;
}

export function refEquals(a: RowRef, b: RowRef): boolean {
  return a.eventNumber === b.eventNumber && a.entryIndex === b.entryIndex;
}

export interface SelectionRange {
  /** `from <= to` per `compareRowRef()` -- normalized on construction. */
  from: RowRef;
  to: RowRef;
}

export interface SelectionState {
  anchor: RowRef | null;
  focus: RowRef | null;
  ranges: SelectionRange[];
}

export const EMPTY_SELECTION: SelectionState = { anchor: null, focus: null, ranges: [] };

function normalizeRange(a: RowRef, b: RowRef): SelectionRange {
  return compareRowRef(a, b) <= 0 ? { from: a, to: b } : { from: b, to: a };
}

function rangeContains(range: SelectionRange, ref: RowRef): boolean {
  return compareRowRef(range.from, ref) <= 0 && compareRowRef(ref, range.to) <= 0;
}

export function isSelected(state: SelectionState, ref: RowRef): boolean {
  return state.ranges.some((r) => rangeContains(r, ref));
}

/** Port of `RangeSet.add()` restricted to a single point -- appends a new 1-element range unless already covered. */
function addPoint(ranges: SelectionRange[], ref: RowRef): SelectionRange[] {
  if (ranges.some((r) => rangeContains(r, ref))) return ranges;
  return [...ranges, { from: ref, to: ref }];
}

/** Port of `RangeSet.remove()` restricted to a single point -- splits any range containing it into up to two sub-ranges. */
function removePoint(ranges: SelectionRange[], ref: RowRef): SelectionRange[] {
  const result: SelectionRange[] = [];
  for (const range of ranges) {
    if (!rangeContains(range, ref)) {
      result.push(range);
      continue;
    }
    if (compareRowRef(range.from, ref) < 0) result.push({ from: range.from, to: prevRef(ref) });
    if (compareRowRef(ref, range.to) < 0) result.push({ from: nextRef(ref), to: range.to });
  }
  return result;
}

// `RowRef` has no dense "previous/next" of its own (entryIndex gaps depend on the
// filter mode) -- these synthetic boundary refs only need to compare correctly against
// real refs via `compareRowRef()` (never resolved against the engine), so an
// entryIndex offset of +/-1 is enough to exclude exactly the split point.
function prevRef(ref: RowRef): RowRef {
  return { eventNumber: ref.eventNumber, entryIndex: ref.entryIndex - 1 };
}
function nextRef(ref: RowRef): RowRef {
  return { eventNumber: ref.eventNumber, entryIndex: ref.entryIndex + 1 };
}

export interface MoveFocusOptions {
  shift: boolean;
  ctrl: boolean;
  /** `true` for a mouse click (Java's `click` flag) -- a ctrl-only *keyboard* move (arrow keys held with ctrl) leaves selection/anchor untouched, matching `moveFocusTo()`'s "ctrl only, by keyboard: move focus without affecting selection" branch. */
  click: boolean;
}

/**
 * Port of `moveFocusTo()`. `element` becomes the new focus unconditionally; the
 * shift/ctrl/click combination then decides what happens to `anchor`/`ranges`, exactly
 * matching Java's branch structure (see this file's header).
 */
export function moveFocusTo(state: SelectionState, element: RowRef, options: MoveFocusOptions): SelectionState {
  const { shift, ctrl, click } = options;
  const focus = element;

  if (!ctrl) {
    if (!shift) {
      // no shift or ctrl: overwrite selection and anchor
      return { anchor: element, focus, ranges: [{ from: element, to: element }] };
    }
    // shift only: overwrite selection with the anchor..element range
    const anchor = state.anchor ?? element;
    return { anchor, focus, ranges: [normalizeRange(anchor, element)] };
  }

  if (!shift) {
    if (!click) {
      // ctrl only, by keyboard: move focus without affecting selection or anchor
      return { ...state, focus };
    }
    // ctrl only, by mouse: toggle membership of `element`, anchor becomes the new focus
    const ranges = isSelected(state, element) ? removePoint(state.ranges, element) : addPoint(state.ranges, element);
    return { anchor: focus, focus, ranges };
  }

  // ctrl+shift: add the anchor..element range to the current selection
  const anchor = state.anchor ?? element;
  return { anchor, focus, ranges: [...state.ranges, normalizeRange(anchor, element)] };
}

/** Port of `doGotoElement()` -- a plain single-element selection with no shift/ctrl semantics (goto/find results). */
export function gotoElement(element: RowRef): SelectionState {
  return { anchor: element, focus: element, ranges: [{ from: element, to: element }] };
}

/**
 * Phase U10 (cheap gap) -- Ctrl+A "select all". Ranges are ref pairs (see this file's
 * header), so the whole table is exactly one range from its first to its last row --
 * nothing in between needs to be fetched/materialized. Focus moves to `last` (mirroring
 * `gotoElement()`'s "focus follows the operation" convention); `first` becomes the new
 * anchor, so a subsequent Shift+click/arrow extends/shrinks from the top, matching how
 * every other whole-range selection in this reducer anchors at its start.
 */
export function selectAll(first: RowRef, last: RowRef): SelectionState {
  return { anchor: first, focus: last, ranges: [normalizeRange(first, last)] };
}
