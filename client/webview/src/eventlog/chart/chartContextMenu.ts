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
 *    Select, Center. "Filter Causes/Consequences..." (phase U7): opens the filter
 *    panel pre-filled with a trace section for this event (both directions) --
 *    `chartMain.ts`'s `filterCausesConsequencesFor()`.
 *  - Per-dependency section (one submenu per distinct hit dependency, title = the
 *    message name via `buildDependencyLabel`): Go to Cause Event, Go to Consequence
 *    Event, Zoom to Message. "Filter Message..." (phase U7): opens the filter panel
 *    pre-filled with this dependency's message ID + a narrow event-number range --
 *    `chartMain.ts`'s `filterMessageFor()`; DISABLED when the dependency has no
 *    `messageId` (e.g. a `'filtered'`-kind gap arrow, which represents zero or more
 *    already-collapsed dependencies, not one real message).
 *  - Per-axis section (one submenu per distinct hit axis; phase U8 wires the full
 *    Java action set, `SequenceChartContributor.java:610-636`'s order): Center,
 *    Toggle Bookmark, then Remove Axis Module / Open Compound Module / Open Parent
 *    Module (disabled when the module has no parent), then Expand Axis Module /
 *    Expand Axis Module Recursively / Collapse Axis Module / Collapse Axis Module
 *    Submodules (expand items disabled when there is nothing left to expand,
 *    collapse items when nothing is open below -- Java greys via the same
 *    allSubmodulesOpen/noSubmodulesOpen booleans the glyphs use). Java's "Attach/
 *    Detach Vector to Axis" is out of scope for the whole port (.vec axis data
 *    strips, per the plan's decision record) and "Zoom to Value" with it (needs the
 *    vector data); both are omitted rather than shown disabled.
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
 *  - Phase U8 ADDS the axis-management static sections (`SequenceChartContributor.
 *    java`'s menu order): Select Modules..., Preset Configuration (Network Node /
 *    Network Interface / separator / Full Detail / Default / Empty), Axis Ordering
 *    Mode (Module Id / Module Path / Minimize Crossings / Manual... radios), Spacing
 *    (Balanced Axes / Dense Axes / Increase Spacing / Decrease Spacing).
 *  - Phase U9 ADDS (port plan's "U9: Export + polish" row): Release Memory, Copy
 *    Image to Clipboard, Export to SVG... -- in the same relative order as Java's
 *    `menuManager` (`SequenceChartContributor.java` lines ~718-727).
 *  - STILL OMITTED (not even as disabled placeholders — genuinely later-phase
 *    ownership, or out of this port's scope entirely per the port plan's phase
 *    table): Filter (dropdown -- superseded by the in-webview filter panel, U7),
 *    Configure Style, Change Font..., Pin, Self Test (an Eclipse-internal
 *    correctness self-check, not a user-facing feature), Show In.
 */

import { TimelineMode } from '@omnetpp/shared/elog-protocol';
import type { MenuEntry } from '../common/contextMenu';
import type { AxisOrderingMode } from './axisOrder';
import type { ChartDisplayFlags } from './displayFlags';
import { TOGGLE_ORDER } from './displayFlags';
import { formatEventLabel } from './labelProvider';
import type { HitObject } from './hitTest';

/** The Preset Configuration entries (`SequenceChartContributor.java:380-427` — see `chartMain.ts`'s `applyPreset()` for what each one does). */
export type PresetConfiguration = 'networkNode' | 'networkInterface' | 'fullDetail' | 'default' | 'empty';

/** Per-axis menu enablement info, resolved by `chartMain.ts` from the module tree + open-set (`openAxisModules.ts`'s `moduleGlyphInfo()` and friends). `null` when the module tree hasn't loaded yet (all axis-management items disabled). */
export interface AxisModuleMenuInfo {
  /** The axis submenu title -- Java labels dynamic per-object submenus with the object's own text; `"<fullPath> (id = <n>)"` like the manual-order dialog rows. */
  label: string;
  hasParent: boolean;
  canExpand: boolean;
  canCollapse: boolean;
}

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
  /** Phase U7 -- "Filter Causes/Consequences..." (per-event section). */
  filterCausesConsequences(eventNumber: number): void;
  /** Phase U7 -- "Filter Message..." (per-dependency section); only invoked when the hit resolves to a `RenderDependency` with a non-null `messageId` (see `resolveDependencyLabel`'s sibling `resolveDependencyMessageId` below). */
  filterMessage(hit: Extract<HitObject, { kind: 'dependency' }>): void;
  // ---- phase U8: axis management (per-axis incremental + whole-set operations) ----
  /** `removeOpenAxisModule()` -- delete this one module from the open set. */
  removeAxisModule(moduleId: number): void;
  /** `openModule(module)` -- REPLACE the open set with the module + its direct submodules. */
  openCompoundModule(moduleId: number): void;
  /** `openModule(module.getParentModule())` -- REPLACE with the parent + its direct submodules. */
  openParentModule(moduleId: number): void;
  /** `expandOpenAxisModule()` -- append the module's direct submodules. */
  expandAxisModule(moduleId: number): void;
  /** The contributor's "Expand Axis Module Recursively" -- append every descendant. */
  expandAxisModuleRecursively(moduleId: number): void;
  /** `collapseOpenAxisModule()` -- prune every open strict descendant. */
  collapseAxisModule(moduleId: number): void;
  /** The contributor's "Collapse Axis Module Submodules" -- prune below the direct submodules. */
  collapseAxisModuleSubmodules(moduleId: number): void;
  openSelectModulesDialog(): void;
  applyPreset(preset: PresetConfiguration): void;
  /** Selecting `'manual'` must open the reorder dialog first and only commit the mode on OK (`SequenceChartContributor`'s "Manual..." radio: `Window.CANCEL` leaves the mode unchanged) -- `chartMain.ts` owns that flow. */
  setAxisOrderingMode(mode: AxisOrderingMode): void;
  /** Spacing submenu (contributor lines 670-674/1657-1748): Balanced = AUTO; Dense = MANUAL at `fontHeight + 1`; Increase/Decrease = MANUAL ±5 px. */
  spacingBalanced(): void;
  spacingDense(): void;
  spacingIncrease(): void;
  spacingDecrease(): void;
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
  /** Phase U9 -- "Release Memory" (`SequenceChartContributor.createReleaseMemoryAction()`). */
  releaseMemory(): void;
  /** Phase U9 -- "Copy Image to Clipboard" (`SequenceChartContributor.createCopyToClipboardAction()` / `CachingCanvas.copyImageToClipboard()`). */
  copyImage(): void;
  /** Phase U9 -- "Export to SVG..." (`SequenceChartContributor.createExportToSVGAction()`). */
  exportSvg(): void;
}

export interface ChartMenuBuildParams {
  /** Every hit at the click point (unfiltered — this menu shows a section per distinct object, not just the top-priority one; see this file's header). */
  hits: HitObject[];
  /** Resolves a dependency hit's message name for its submenu title; `null` if not resolvable (falls back to a generic title). */
  resolveDependencyLabel(hit: Extract<HitObject, { kind: 'dependency' }>): string | null;
  /** Phase U7 -- resolves a dependency hit's `messageId` (`RenderDependency.messageId`), for gating "Filter Message..."; `null` if unresolvable/absent (disables the item -- see `ChartMenuActions.filterMessage`'s doc comment). */
  resolveDependencyMessageId(hit: Extract<HitObject, { kind: 'dependency' }>): number | null;
  currentTimelineMode: TimelineMode;
  /** Phase U8 -- for the Axis Ordering Mode radios' checkmarks. */
  currentAxisOrderingMode: AxisOrderingMode;
  /** Phase U8 -- per-axis enablement/label info; `null` = module tree not loaded yet (axis-management items disabled). */
  resolveAxisInfo(moduleId: number): AxisModuleMenuInfo | null;
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
      { id: 'filter', label: 'Filter Causes/Consequences...', onSelect: () => actions.filterCausesConsequences(hit.eventNumber) },
    ],
  };
}

function dependencySection(hit: Extract<HitObject, { kind: 'dependency' }>, label: string, messageId: number | null, actions: ChartMenuActions): MenuEntry {
  return {
    id: `dep-${hit.causeEventNumber}-${hit.consequenceEventNumber}`,
    label,
    submenu: [
      { id: 'gotoCause', label: 'Go to Cause Event', onSelect: () => actions.goToCauseEvent(hit.causeEventNumber) },
      { id: 'gotoConsequence', label: 'Go to Consequence Event', onSelect: () => actions.goToConsequenceEvent(hit.consequenceEventNumber) },
      { id: 'zoomToMessage', label: 'Zoom to Message', onSelect: () => actions.zoomToDependency(hit.causeTc, hit.consequenceTc) },
      { id: 'toggleBookmark', label: 'Toggle Bookmark', onSelect: () => actions.toggleDependencyBookmark(hit) },
      { id: 'filterMessage', label: 'Filter Message...', disabled: messageId === null, onSelect: () => actions.filterMessage(hit) },
    ],
  };
}

function axisSection(hit: Extract<HitObject, { kind: 'axis' }>, info: AxisModuleMenuInfo | null, actions: ChartMenuActions): MenuEntry {
  const noTree = info === null;
  return {
    id: `axis-${hit.moduleId}`,
    label: info?.label ?? `Axis (id = ${hit.moduleId})`,
    submenu: [
      { id: 'center', label: 'Center', onSelect: () => actions.centerOnAxis(hit.moduleId) },
      { id: 'toggleBookmark', label: 'Toggle Bookmark', onSelect: () => actions.toggleAxisBookmark(hit.moduleId) },
      { separator: true },
      { id: 'removeAxisModule', label: 'Remove Axis Module', disabled: noTree, onSelect: () => actions.removeAxisModule(hit.moduleId) },
      { id: 'openCompoundModule', label: 'Open Compound Module', disabled: noTree, onSelect: () => actions.openCompoundModule(hit.moduleId) },
      { id: 'openParentModule', label: 'Open Parent Module', disabled: noTree || !info.hasParent, onSelect: () => actions.openParentModule(hit.moduleId) },
      { separator: true },
      { id: 'expandAxisModule', label: 'Expand Axis Module', disabled: noTree || !info.canExpand, onSelect: () => actions.expandAxisModule(hit.moduleId) },
      { id: 'expandAxisModuleRecursively', label: 'Expand Axis Module Recursively', disabled: noTree || !info.canExpand, onSelect: () => actions.expandAxisModuleRecursively(hit.moduleId) },
      { id: 'collapseAxisModule', label: 'Collapse Axis Module', disabled: noTree || !info.canCollapse, onSelect: () => actions.collapseAxisModule(hit.moduleId) },
      { id: 'collapseAxisModuleSubmodules', label: 'Collapse Axis Module Submodules', disabled: noTree || !info.canCollapse, onSelect: () => actions.collapseAxisModuleSubmodules(hit.moduleId) },
    ],
  };
}

/** Phase U8 -- the Preset Configuration submenu (`SequenceChartContributor.java:380-427`'s exact names/order, incl. the separator between the NED-property presets and the structural ones). */
function presetSection(actions: ChartMenuActions): MenuEntry {
  return {
    id: 'presetConfiguration',
    label: 'Preset Configuration',
    submenu: [
      { id: 'preset-networkNode', label: 'Network Node', onSelect: () => actions.applyPreset('networkNode') },
      { id: 'preset-networkInterface', label: 'Network Interface', onSelect: () => actions.applyPreset('networkInterface') },
      { separator: true },
      { id: 'preset-fullDetail', label: 'Full Detail', onSelect: () => actions.applyPreset('fullDetail') },
      { id: 'preset-default', label: 'Default', onSelect: () => actions.applyPreset('default') },
      { id: 'preset-empty', label: 'Empty', onSelect: () => actions.applyPreset('empty') },
    ],
  };
}

const AXIS_ORDERING_LABELS: [AxisOrderingMode, string][] = [
  ['moduleId', 'Module Id'],
  ['moduleFullPath', 'Module Path'],
  ['minimizeCrossings', 'Minimize Crossings'],
  ['manual', 'Manual...'],
];

/** Phase U8 -- the Axis Ordering Mode radio submenu (contributor lines 987-1036). */
function axisOrderingSection(current: AxisOrderingMode, actions: ChartMenuActions): MenuEntry {
  return {
    id: 'axisOrderingMode',
    label: 'Axis Ordering Mode',
    submenu: AXIS_ORDERING_LABELS.map(([mode, label]): MenuEntry => ({ id: `order-${mode}`, label, checked: mode === current, onSelect: () => actions.setAxisOrderingMode(mode) })),
  };
}

/** Phase U8 -- the Spacing submenu (contributor lines 670-674). */
function spacingSection(actions: ChartMenuActions): MenuEntry {
  return {
    id: 'spacing',
    label: 'Spacing',
    submenu: [
      { id: 'spacing-balanced', label: 'Balanced Axes', onSelect: actions.spacingBalanced },
      { id: 'spacing-dense', label: 'Dense Axes', onSelect: actions.spacingDense },
      { id: 'spacing-increase', label: 'Increase Spacing', onSelect: actions.spacingIncrease },
      { id: 'spacing-decrease', label: 'Decrease Spacing', onSelect: actions.spacingDecrease },
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
  const { hits, resolveDependencyLabel, resolveDependencyMessageId, currentTimelineMode, currentAxisOrderingMode, resolveAxisInfo, actions, displayFlags } = params;
  const entries: MenuEntry[] = [];

  const events = hits.filter((h): h is Extract<HitObject, { kind: 'event' }> => h.kind === 'event');
  const dependencies = hits.filter((h): h is Extract<HitObject, { kind: 'dependency' }> => h.kind === 'dependency');
  const axes = hits.filter((h): h is Extract<HitObject, { kind: 'axis' }> => h.kind === 'axis');

  for (const hit of events) entries.push(eventSection(hit, actions));
  if (events.length > 0) entries.push({ separator: true });

  for (const hit of dependencies) entries.push(dependencySection(hit, resolveDependencyLabel(hit) ?? '(message)', resolveDependencyMessageId(hit), actions));
  if (dependencies.length > 0) entries.push({ separator: true });

  for (const hit of axes) entries.push(axisSection(hit, resolveAxisInfo(hit.moduleId), actions));
  if (axes.length > 0) entries.push({ separator: true });

  // ---- phase U8: axis-management static sections (contributor's menu order) ----
  entries.push({ id: 'selectModules', label: 'Select Modules...', onSelect: actions.openSelectModulesDialog });
  entries.push(presetSection(actions));
  entries.push(axisOrderingSection(currentAxisOrderingMode, actions));
  entries.push(spacingSection(actions));
  entries.push({ separator: true });

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
  // Phase U9 -- "Release Memory"/"Copy Image to Clipboard"/"Export to SVG..." (Java's
  // `menuManager` order: refresh, releaseMemory, [selfTest -- out of scope], separator,
  // copyToClipboard, exportToSVG, separator, [showIn -- out of scope]).
  entries.push({ id: 'releaseMemory', label: 'Release Memory', onSelect: actions.releaseMemory });
  entries.push({ separator: true });
  entries.push({ id: 'copyImage', label: 'Copy Image to Clipboard', onSelect: actions.copyImage });
  entries.push({ id: 'exportSvg', label: 'Export to SVG...', onSelect: actions.exportSvg });

  return entries;
}
