/**
 * selection.ts (PURE) — chart selection state + reducer. Port of
 * `SequenceChart.java`'s `selectedObjects` bag (a heterogeneous list of `IEvent`s
 * collapsed into an `EventNumberRangeSet`, `IMessageDependency`, `ComponentMethodBeginEntry`,
 * `ModuleTreeItem`, `Double`) and its `mouseUp` mutation logic
 * (`SequenceChart.java:6009-6117`, verified by reading the source — see `hitTest.ts`'s
 * header for the same citation).
 *
 * Ported semantics (both driven by `pickPrimaryGroup()` from `hitTest.ts` — Java's
 * mouseUp filters `collectVisibleObjectsAtPosition()`'s result down to just the
 * TOP-PRIORITY category before mutating selection, so a click never mixes e.g. an
 * event and an axis into one selection-changing gesture):
 *  - Ctrl/Cmd+click: TOGGLES membership of every hit in the group (add if absent,
 *    remove if present) — does not touch anything outside the group.
 *  - Plain click: REPLACES the entire selection with just the group's members
 *    (Java: `newSelectedObjects` built fresh from the group only) — UNLESS the
 *    resulting selection is deep-equal to the CURRENT one (and non-empty), in which
 *    case it clears instead ("click again on the same thing to deselect").
 *  - Esc: clears everything (`clearSelection()`).
 *
 * `focusEventNumber` is this port's addition (not a literal Java field): Java's arrow-
 * key navigation (`moveFocus`/Ctrl+Left-Right/Shift+Left-Right, `SequenceChart.java`
 * keyboard handling) operates off "the currently selected event," which this state
 * tracks explicitly as a single number so `interactions.ts`'s keyboard handlers don't
 * need to re-derive "the" selected event from a set every keystroke. Set whenever a
 * click/ctrl-click/reveal resolves to exactly one event (or the last one in a
 * multi-event group); left unchanged by axis/dependency/timestamp-only selections.
 */

import type { HitObject } from './hitTest';

export interface ChartSelectionState {
  events: ReadonlySet<number>;
  /** Keyed by `dependencyKey()` below (the protocol has no dependency id). */
  dependencies: ReadonlySet<string>;
  /** Keyed by `methodCallKey()` below (the protocol has no method-call id). */
  methodCalls: ReadonlySet<string>;
  axes: ReadonlySet<number>;
  timelineCoords: ReadonlySet<number>;
  /** See this file's header. `null` if no single event is currently focused. */
  focusEventNumber: number | null;
}

export const EMPTY_CHART_SELECTION: ChartSelectionState = {
  events: new Set(),
  dependencies: new Set(),
  methodCalls: new Set(),
  axes: new Set(),
  timelineCoords: new Set(),
  focusEventNumber: null,
};

export function dependencyKey(dep: { dependencyKind: string; causeEventNumber: number; consequenceEventNumber: number }): string {
  return `${dep.dependencyKind}:${dep.causeEventNumber}:${dep.consequenceEventNumber}`;
}

export function methodCallKey(call: { eventNumber: number; sourceModuleId: number; targetModuleId: number; tc: number }): string {
  return `${call.eventNumber}:${call.sourceModuleId}:${call.targetModuleId}:${call.tc}`;
}

export function isEmptySelection(s: ChartSelectionState): boolean {
  return s.events.size === 0 && s.dependencies.size === 0 && s.methodCalls.size === 0 && s.axes.size === 0 && s.timelineCoords.size === 0;
}

function setEquals<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export function selectionEquals(a: ChartSelectionState, b: ChartSelectionState): boolean {
  return setEquals(a.events, b.events) && setEquals(a.dependencies, b.dependencies) && setEquals(a.methodCalls, b.methodCalls) && setEquals(a.axes, b.axes) && setEquals(a.timelineCoords, b.timelineCoords);
}

/** Builds a fresh selection containing exactly `group`'s members (plain-click replacement). `focusEventNumber` becomes the last event in the group, if any (unchanged — `null` — otherwise). */
function selectionFromGroup(group: HitObject[]): ChartSelectionState {
  const events = new Set<number>();
  const dependencies = new Set<string>();
  const methodCalls = new Set<string>();
  const axes = new Set<number>();
  const timelineCoords = new Set<number>();
  let focusEventNumber: number | null = null;

  for (const hit of group) {
    switch (hit.kind) {
      case 'event':
        events.add(hit.eventNumber);
        focusEventNumber = hit.eventNumber;
        break;
      case 'dependency':
        dependencies.add(dependencyKey(hit));
        break;
      case 'methodCall':
        methodCalls.add(methodCallKey(hit));
        break;
      case 'axis':
        axes.add(hit.moduleId);
        break;
      case 'timestamp':
        timelineCoords.add(hit.tc);
        break;
    }
  }
  return { events, dependencies, methodCalls, axes, timelineCoords, focusEventNumber };
}

function toggleOne(state: ChartSelectionState, hit: HitObject): ChartSelectionState {
  switch (hit.kind) {
    case 'moduleAction':
      // Phase U8 -- glyphs are ACTIONS, never selection members (Java's MOD1+click
      // path skips ModuleActions entirely; chartMain.ts's plain-click path consumes
      // them before selection is ever consulted). Toggling one is a no-op.
      return state;
    case 'event': {
      const events = new Set(state.events);
      const wasPresent = events.has(hit.eventNumber);
      wasPresent ? events.delete(hit.eventNumber) : events.add(hit.eventNumber);
      return { ...state, events, focusEventNumber: wasPresent ? state.focusEventNumber : hit.eventNumber };
    }
    case 'dependency': {
      const dependencies = new Set(state.dependencies);
      const key = dependencyKey(hit);
      dependencies.has(key) ? dependencies.delete(key) : dependencies.add(key);
      return { ...state, dependencies };
    }
    case 'methodCall': {
      const methodCalls = new Set(state.methodCalls);
      const key = methodCallKey(hit);
      methodCalls.has(key) ? methodCalls.delete(key) : methodCalls.add(key);
      return { ...state, methodCalls };
    }
    case 'axis': {
      const axes = new Set(state.axes);
      axes.has(hit.moduleId) ? axes.delete(hit.moduleId) : axes.add(hit.moduleId);
      return { ...state, axes };
    }
    case 'timestamp': {
      const timelineCoords = new Set(state.timelineCoords);
      timelineCoords.has(hit.tc) ? timelineCoords.delete(hit.tc) : timelineCoords.add(hit.tc);
      return { ...state, timelineCoords };
    }
  }
}

/**
 * Applies one click gesture's already-priority-filtered hit group (see this file's
 * header — callers pass `pickPrimaryGroup(hitTest(...))`, never raw `hitTest()`
 * output) to `state`. `group` empty + `ctrl` false mirrors a plain click on empty
 * background: replaces with an empty selection (a no-op if already empty; clears
 * otherwise, matching Java's "identical to current -> clear" rule with the empty
 * selection as the trivial identical case only when nothing was already selected —
 * see `isEmptySelection` guard below for the exact tie-break).
 */
export function applyClick(state: ChartSelectionState, group: HitObject[], ctrl: boolean): ChartSelectionState {
  if (ctrl) {
    let next = state;
    for (const hit of group) next = toggleOne(next, hit);
    return next;
  }
  const fresh = selectionFromGroup(group);
  if (!isEmptySelection(fresh) && selectionEquals(fresh, state)) return { ...EMPTY_CHART_SELECTION, focusEventNumber: state.focusEventNumber };
  return { ...fresh, focusEventNumber: fresh.focusEventNumber ?? state.focusEventNumber };
}

/** Esc — `clearSelection()`. Keeps `focusEventNumber` (Java's clear only empties `selectedObjects`; arrow-key navigation should still resume from wherever focus was). */
export function clearSelection(state: ChartSelectionState): ChartSelectionState {
  return { ...EMPTY_CHART_SELECTION, focusEventNumber: state.focusEventNumber };
}

/** Sets focus (and, as a single-event selection) to exactly `eventNumber` — used by arrow-key navigation and by goto/reveal flows once they resolve an event. */
export function focusEvent(eventNumber: number): ChartSelectionState {
  return { ...EMPTY_CHART_SELECTION, events: new Set([eventNumber]), focusEventNumber: eventNumber };
}
