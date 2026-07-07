/**
 * chartContextMenu.ts (PURE) — decides WHAT appears in the Sequence Chart's context
 * menu for a given set of hits + application state, per `SequenceChartContributor.
 * java`'s `contributeToPopupMenu()` (read in full). Returns a `MenuEntry[]`
 * (`common/contextMenu.ts`'s generic DOM framework renders it) — no DOM, fully
 * unit-testable (call `.onSelect()` directly and assert the injected action fired).
 *
 * SCOPE (per this phase's own brief: "wire everything the engine already supports";
 * everything else explicitly deferred, listed below and in the phase report):
 *  - Per-event section (one submenu per distinct hit event, title `"Event #<n>"`):
 *    Select, Center. "Filter Causes/Consequences..." shown DISABLED (needs the
 *    Filter UI, phase U7).
 *  - Per-dependency section (one submenu per distinct hit dependency, title = the
 *    message name via `buildDependencyLabel`): Go to Cause Event, Go to Consequence
 *    Event, Zoom to Message. "Filter Message..." DISABLED (U7).
 *  - Per-axis section (one submenu per distinct hit axis): Center. "Open Module"
 *    DISABLED (U8 -- module-open navigation isn't built yet, matches this phase's
 *    "double-click axis stub" decision) and a single DISABLED placeholder summarizing
 *    the rest of Java's per-axis actions (Attach Vector to Axis, Expand/Collapse
 *    Axis Module [x4], Remove/Open Compound/Open Parent Module) as "More axis
 *    actions… (axis management, phase U8)".
 *  - Method calls: Java's own `contributeToPopupMenu()` has NO per-method-call
 *    section (verified — only Event/MessageDependency/ModuleTreeItem get dynamic
 *    submenus), so this port doesn't add one either, even though method calls DO
 *    participate in click/hover priority (`hitTest.ts`).
 *  - Static tail: Timeline Mode (4 real radios + a disabled "Custom nonlinear..."),
 *    Zoom (Default Zoom/Zoom to Fit/Zoom In/Zoom Out — all wired), Find Text.../Find
 *    Next, Go to (Event.../Simulation Time.../Begin/End), Refresh.
 *  - Phase U5 ADDS: a "Show/Hide" submenu with all ~25 `displayFlags.ts` toggles
 *    (`TOGGLE_ORDER`, each a checkable item — no disabled placeholders here, every one
 *    is fully wired into `drawList.ts`).
 *  - EXPLICITLY OMITTED (not even as disabled placeholders — genuinely later-phase
 *    ownership per the port plan's phase table, listed in the phase report rather
 *    than cluttering the menu): Select Modules..., Preset Configuration, Axis
 *    Ordering Mode, Filter (dropdown), Configure Style, Spacing, Change Font..., Toggle
 *    bookmark, Pin, Release Memory, Self Test, Copy to Clipboard, Export to SVG...,
 *    Show In.
 */

import { TimelineMode } from '@omnetpp/shared/elog-protocol';
import type { MenuEntry } from '../common/contextMenu';
import type { ChartDisplayFlags } from './displayFlags';
import { TOGGLE_ORDER } from './displayFlags';
import { formatEventLabel } from './labelProvider';
import type { HitObject } from './hitTest';

export interface ChartMenuActions {
  selectEvent(eventNumber: number): void;
  centerOnEvent(eventNumber: number): void;
  /** Phase U6 -- explicitly reveals `eventNumber` in the Event Log table (see `chartMain.ts`'s `selectInTable()`). */
  selectInTable(eventNumber: number): void;
  goToCauseEvent(eventNumber: number): void;
  goToConsequenceEvent(eventNumber: number): void;
  zoomToDependency(causeTc: number, consequenceTc: number): void;
  /** Phase U6 -- "Toggle Bookmark" per object kind (Event/MessageDependency/Axis -- see `bookmarks.ts`'s header for why ComponentMethodCall has no per-object menu entry). */
  toggleEventBookmark(eventNumber: number): void;
  toggleDependencyBookmark(hit: Extract<HitObject, { kind: 'dependency' }>): void;
  toggleAxisBookmark(moduleId: number): void;
  centerOnAxis(moduleId: number): void;
  setTimelineMode(mode: TimelineMode): void;
  zoomIn(): void;
  zoomOut(): void;
  defaultZoom(): void;
  zoomToFitAll(): void;
  openGotoEventDialog(): void;
  openGotoSimTimeDialog(): void;
  gotoBegin(): void;
  gotoEnd(): void;
  openFindTextDialog(): void;
  findNext(): void;
  refresh(): void;
  /** Phase U5 — flips one `ChartDisplayFlags` key (`displayFlags.ts`'s `toggleFlag()`); the caller re-renders and persists. */
  toggleDisplayFlag(key: keyof ChartDisplayFlags): void;
}

export interface ChartMenuBuildParams {
  /** Every hit at the click point (unfiltered — this menu shows a section per distinct object, not just the top-priority one; see this file's header). */
  hits: HitObject[];
  /** Resolves a dependency hit's message name for its submenu title; `null` if not resolvable (falls back to a generic title). */
  resolveDependencyLabel(hit: Extract<HitObject, { kind: 'dependency' }>): string | null;
  currentTimelineMode: TimelineMode;
  actions: ChartMenuActions;
  /** Phase U5 — current toggle state, for the Show/Hide submenu's checkmarks. */
  displayFlags: ChartDisplayFlags;
}

const TIMELINE_MODE_LABELS: [TimelineMode, string][] = [
  [TimelineMode.SIMULATION_TIME, 'Linear'],
  [TimelineMode.EVENT_NUMBER, 'Event Number'],
  [TimelineMode.STEP, 'Step'],
  [TimelineMode.NONLINEAR, 'Nonlinear'],
];

function eventSection(hit: Extract<HitObject, { kind: 'event' }>, actions: ChartMenuActions): MenuEntry {
  return {
    id: `event-${hit.eventNumber}`,
    label: formatEventLabel(hit.eventNumber),
    submenu: [
      { id: 'select', label: 'Select', onSelect: () => actions.selectEvent(hit.eventNumber) },
      { id: 'center', label: 'Center', onSelect: () => actions.centerOnEvent(hit.eventNumber) },
      { id: 'selectInTable', label: 'Select in Event Log Table', onSelect: () => actions.selectInTable(hit.eventNumber) },
      { id: 'toggleBookmark', label: 'Toggle Bookmark', onSelect: () => actions.toggleEventBookmark(hit.eventNumber) },
      { id: 'filter', label: 'Filter Causes/Consequences...', disabled: true },
    ],
  };
}

function dependencySection(hit: Extract<HitObject, { kind: 'dependency' }>, label: string, actions: ChartMenuActions): MenuEntry {
  return {
    id: `dep-${hit.causeEventNumber}-${hit.consequenceEventNumber}`,
    label,
    submenu: [
      { id: 'gotoCause', label: 'Go to Cause Event', onSelect: () => actions.goToCauseEvent(hit.causeEventNumber) },
      { id: 'gotoConsequence', label: 'Go to Consequence Event', onSelect: () => actions.goToConsequenceEvent(hit.consequenceEventNumber) },
      { id: 'zoomToMessage', label: 'Zoom to Message', onSelect: () => actions.zoomToDependency(hit.causeTc, hit.consequenceTc) },
      { id: 'toggleBookmark', label: 'Toggle Bookmark', onSelect: () => actions.toggleDependencyBookmark(hit) },
      { id: 'filterMessage', label: 'Filter Message...', disabled: true },
    ],
  };
}

function axisSection(hit: Extract<HitObject, { kind: 'axis' }>, actions: ChartMenuActions): MenuEntry {
  return {
    id: `axis-${hit.moduleId}`,
    label: `Axis (id = ${hit.moduleId})`,
    submenu: [
      { id: 'center', label: 'Center', onSelect: () => actions.centerOnAxis(hit.moduleId) },
      { id: 'toggleBookmark', label: 'Toggle Bookmark', onSelect: () => actions.toggleAxisBookmark(hit.moduleId) },
      { id: 'openModule', label: 'Open Module', disabled: true },
      { id: 'more', label: 'More axis actions… (axis management, phase U8)', disabled: true },
    ],
  };
}

/** Phase U5 — the Show/Hide submenu, one checkable item per `TOGGLE_ORDER` entry. */
function showHideSection(displayFlags: ChartDisplayFlags, actions: ChartMenuActions): MenuEntry {
  return {
    id: 'showHide',
    label: 'Show/Hide',
    submenu: TOGGLE_ORDER.map(([key, label]): MenuEntry => ({ id: `flag-${key}`, label, checked: displayFlags[key], onSelect: () => actions.toggleDisplayFlag(key) })),
  };
}

export function buildChartContextMenu(params: ChartMenuBuildParams): MenuEntry[] {
  const { hits, resolveDependencyLabel, currentTimelineMode, actions, displayFlags } = params;
  const entries: MenuEntry[] = [];

  const events = hits.filter((h): h is Extract<HitObject, { kind: 'event' }> => h.kind === 'event');
  const dependencies = hits.filter((h): h is Extract<HitObject, { kind: 'dependency' }> => h.kind === 'dependency');
  const axes = hits.filter((h): h is Extract<HitObject, { kind: 'axis' }> => h.kind === 'axis');

  for (const hit of events) entries.push(eventSection(hit, actions));
  if (events.length > 0) entries.push({ separator: true });

  for (const hit of dependencies) entries.push(dependencySection(hit, resolveDependencyLabel(hit) ?? '(message)', actions));
  if (dependencies.length > 0) entries.push({ separator: true });

  for (const hit of axes) entries.push(axisSection(hit, actions));
  if (axes.length > 0) entries.push({ separator: true });

  entries.push({
    id: 'timelineMode',
    label: 'Timeline Mode',
    submenu: [
      ...TIMELINE_MODE_LABELS.map(([mode, label]): MenuEntry => ({ id: `tm-${mode}`, label, checked: mode === currentTimelineMode, onSelect: () => actions.setTimelineMode(mode) })),
      { id: 'tm-custom', label: 'Custom nonlinear...', disabled: true },
    ],
  });

  entries.push(showHideSection(displayFlags, actions));

  entries.push({
    id: 'zoom',
    label: 'Zoom',
    submenu: [
      { id: 'defaultZoom', label: 'Default Zoom', onSelect: actions.defaultZoom },
      { id: 'zoomToFit', label: 'Zoom to Fit', onSelect: actions.zoomToFitAll },
      { id: 'zoomIn', label: 'Zoom In', icon: 'zoom-in', onSelect: actions.zoomIn },
      { id: 'zoomOut', label: 'Zoom Out', icon: 'zoom-out', onSelect: actions.zoomOut },
    ],
  });

  entries.push({ separator: true });
  entries.push({ id: 'findText', label: 'Find Text...', onSelect: actions.openFindTextDialog });
  entries.push({ id: 'findNext', label: 'Find Next', onSelect: actions.findNext });
  entries.push({
    id: 'gotoMenu',
    label: 'Go to',
    submenu: [
      { id: 'gotoEvent', label: 'Go to Event...', onSelect: actions.openGotoEventDialog },
      { id: 'gotoSimTime', label: 'Go to Simulation Time...', onSelect: actions.openGotoSimTimeDialog },
      { separator: true },
      { id: 'gotoBegin', label: 'Go to Begin', onSelect: actions.gotoBegin },
      { id: 'gotoEnd', label: 'Go to End', onSelect: actions.gotoEnd },
    ],
  });

  entries.push({ separator: true });
  entries.push({ id: 'refresh', label: 'Refresh', icon: 'refresh', onSelect: actions.refresh });

  return entries;
}
