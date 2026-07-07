import {
  ElogMethods,
  MatchKind,
  TimelineMode,
  type ElogModule,
  type EventDetail,
  type FindTextParams,
  type FindTextResult,
  type GotoResult,
  type LogSummary,
  type MapCoordsResult,
  type RenderDependency,
  type RenderMethodCall,
  type RowRef,
  type ScSetTimelineModeParams,
  type ScState,
  type TimelineEvent,
  type ViewportModel,
  type ViewportParams,
} from '@omnetpp/shared/elog-protocol';
import type { Bookmark, BookmarkCandidate, HostToWebviewMessage, RevealTarget, WebviewToHostMessage } from '@omnetpp/shared/ui-protocol';
import { EngineRpc } from '../common/rpc';
import { buildToolbar, type ToolbarHandle } from '../common/toolbar';
import { renderSummaryStrip } from '../common/summary';
import { readPalette, watchThemeChange, type EventLogPalette } from '../common/theme';
import { showContextMenu } from '../common/contextMenu';
import { DEFAULT_FIND_TEXT_STATE, openFindTextDialog, openGotoEventDialog, openGotoSimTimeDialog, type FindTextState } from '../common/dialogs';
import { deriveAxes, findModuleIdByFullName, findModuleNode, maxVerticalScroll, type AxesLayout } from './axes';
import { calculateAxisHeaders } from './axisHeaders';
import { buildChartContextMenu, type ChartMenuActions } from './chartContextMenu';
import { buildSampleTable, pixelToTc, tcToSimTimeApprox, type TcSimSample } from './coords';
import { mergeDisplayFlags, toggleFlag, type ChartDisplayFlags } from './displayFlags';
import { bookmarkDependencyKey, buildDrawList, type DrawPrimitive, type InfoPanelText } from './drawList';
import { calculateTicks, formatTickLabel } from './ticks';
import { ANTIALIAS_TURN_OFF_AT_MSEC, ANTIALIAS_TURN_ON_AT_MSEC, createCanvasStack, type CanvasStackHandle } from './canvasStack';
import { hitTest, pickDoubleClickTarget, pickPrimary, pickPrimaryGroup, type HitObject } from './hitTest';
import { attachInteractions } from './interactions';
import { buildDependencyLabel, buildTooltipHtml, findNeighborEvents, type LabelProviderContext, type ResolvedHit } from './labelProvider';
import { applyClick, clearSelection, dependencyKey, EMPTY_CHART_SELECTION, focusEvent, methodCallKey, type ChartSelectionState } from './selection';
import { attachTooltip } from './tooltip';
import { RenderModelCache, type EngineViewportSource } from './renderModelCache';
import {
  contentHeight,
  contentWidth,
  createViewportState,
  DEFAULT_PIXELS_PER_TC,
  GUTTER_LEFT_WIDTH,
  gotoBeginAt,
  gotoEndAt,
  panTo,
  resize as resizeViewport,
  revealAt,
  scrollVerticalTo,
  visibleTcRange,
  zoomAtCenter,
  zoomToFit,
  type ViewportState,
} from './viewportState';

/**
 * Bootstrap for the Sequence Chart webview app (bundled to
 * `dist/webview/sequenceChart.js`). U1 built the toolbar shell/status strip/empty
 * placeholder; this phase (U3) replaces the empty canvas with the real living chart:
 * module axes, event marks, straight message-dependency arrows, a simtime gutter
 * with smart ticks, pan (drag + wheel), zoom (ctrl+wheel + toolbar, center-stable),
 * timeline-mode switching, goto/reveal, followEnd-on-append, and an h-scrollbar over
 * the (potentially huge) virtual timeline width.
 */

interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
  getState(): PersistedChartState | undefined;
  setState(state: PersistedChartState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface PersistedChartState {
  timelineMode?: string;
  /** Phase U5 -- the ~25 Show/Hide toggles (`displayFlags.ts`), persisted both locally (`vscode.setState`, survives a webview reload) AND host-side (`stateChanged`/`persistedState`, survives a full window reload -- see `sequenceChartEditor.ts`'s per-uri `workspaceState` blob). Partial (not all 25 keys) so an older/newer persisted blob still round-trips via `mergeDisplayFlags()`. */
  displayFlags?: Partial<ChartDisplayFlags>;
}

const vscode = acquireVsCodeApi();
const rpc = new EngineRpc(vscode);
let state: PersistedChartState = vscode.getState() ?? {};
let fileUri = '';
let summary: LogSummary | null = null;
let toolbar: ToolbarHandle;

let currentTimelineMode: TimelineMode = (state.timelineMode as TimelineMode) ?? TimelineMode.SIMULATION_TIME;
let viewport: ViewportState = createViewportState();
let palette: EventLogPalette = readPalette();
let moduleTree: ElogModule | null = null;
const knownModuleIds = new Set<number>();
let lastModel: ViewportModel | null = null;
let sampleTable: TcSimSample[] = [];
let beginTc: number | null = null;
let endTc: number | null = null;
let hasInitializedViewport = false;
/** The exact primitive list the last frame was drawn from -- fed to `hitTest.ts` (click/dblclick/context-menu/tooltip all hit-test against WHAT'S ON SCREEN, never a re-derived geometry). */
let lastPrimitives: DrawPrimitive[] = [];
/** Phase U4 selection state (events/dependencies/methodCalls/axes/timelineCoords + focus) -- see `selection.ts`. */
let selection: ChartSelectionState = EMPTY_CHART_SELECTION;
/** Phase U5 -- the ~25 Show/Hide toggles (`displayFlags.ts`), including `showTimeDifferences` (Tab toggle, port of `SequenceChart.java`'s `setShowTimeDifferences`). */
let displayFlags: ChartDisplayFlags = mergeDisplayFlags(state.displayFlags);
/**
 * Antialias auto-toggle state (port of `SequenceChart.java`'s `drawWithAntialias`
 * hysteresis, `SequenceChart.java:3466-3470`) -- see `canvasStack.ts`'s
 * `CanvasStackHandle.render()` doc for the honest mapping onto what this canvas can
 * actually cheapen (`skipLabelsForPerf` is the real lever; `antialiasEnabled` is still
 * threaded through + surfaced in the status strip).
 */
let antialiasEnabled = true;
/** Last "Find Text" params, for "Find Next" (F3-equivalent, wired to the `omnetpp.eventlog.findNext` command + the context menu's "Find Next" item) to repeat without re-prompting. */
let findTextState: FindTextState = DEFAULT_FIND_TEXT_STATE;
/** Anchor row of the last successful find, so "Find Next" continues from there instead of restarting at the beginning/end. `null` before any search (or after the file changes underneath it). */
let lastFindRef: RowRef | null = null;
/** Phase U6 -- the session's current bookmark list (`init`/`bookmarksChanged`); `recomputeBookmarkIndexes()` derives the three render-ready sets below from it (+ `moduleTree`, for Axis bookmarks' `modulePath` -> `moduleId` resolution). */
let bookmarks: Bookmark[] = [];
let bookmarkedEventNumbers = new Set<number>();
let bookmarkedDependencyKeys = new Set<string>();
let bookmarkedModuleIds = new Set<number>();

/** Re-derives the three render-ready bookmark index sets `drawList.ts` consumes from `bookmarks`/`moduleTree` -- call after either changes (a fresh `init`/`bookmarksChanged`, or the module tree finishing its first `elog/getModuleTree` load). Does NOT itself schedule a render (callers already do, alongside whatever else they're updating). */
function recomputeBookmarkIndexes(): void {
  bookmarkedEventNumbers = new Set(bookmarks.filter((b) => b.kind === 'Event').map((b) => b.eventNumber!));
  bookmarkedDependencyKeys = new Set(bookmarks.filter((b) => b.kind === 'MessageDependency').map((b) => bookmarkDependencyKey(b.eventNumber!, b.consequenceEventNumber, b.messageId)));
  bookmarkedModuleIds = new Set(
    bookmarks
      .filter((b) => b.kind === 'Axis' && b.modulePath)
      .map((b) => findModuleIdByFullName(b.modulePath!, moduleTree))
      .filter((id): id is number => id !== null),
  );
}
/** Mutable view onto `moduleTree` for `labelProvider.ts`'s tooltip builders -- a getter (not a snapshot) so it always reflects the latest `elog/getModuleTree` result even though it's captured once by `attachTooltip()` below. */
const labelProviderCtx: LabelProviderContext = {
  get moduleTree() {
    return moduleTree;
  },
};

/**
 * Persists `state` both locally (`vscode.setState` -- survives a webview reload/hide,
 * e.g. tab switch) and host-side (`stateChanged` -- survives a full window reload; see
 * `sequenceChartEditor.ts`'s per-uri `workspaceState` blob, mirroring `eventLogTableView.
 * ts`'s `TABLE_STATE_KEY` pattern). Call after any mutation to `state`.
 */
function persistState(): void {
  vscode.setState(state);
  vscode.postMessage({ type: 'stateChanged', state });
}

/** Phase U5 -- flips one Show/Hide toggle (Show/Hide submenu item, or the Tab key for `showTimeDifferences`), persists, and re-renders. */
function setDisplayFlags(next: ChartDisplayFlags): void {
  displayFlags = next;
  state = { ...state, displayFlags };
  persistState();
  scheduleRender();
}

const TIMELINE_MODE_OPTIONS = [
  { value: TimelineMode.SIMULATION_TIME, label: 'Simulation Time' },
  { value: TimelineMode.EVENT_NUMBER, label: 'Event Number' },
  { value: TimelineMode.STEP, label: 'Step' },
  { value: TimelineMode.NONLINEAR, label: 'Nonlinear' },
];

const engineSource: EngineViewportSource = {
  getViewport: (params: ViewportParams) => rpc.requestCancelable<ViewportModel>(ElogMethods.scGetViewport, params),
};
const renderModelCache = new RenderModelCache(engineSource);

document.getElementById('root')!.innerHTML = `
  <div id="toolbar"></div>
  <div id="status"></div>
  <div class="elog-body" id="body">
    <div id="chartCanvasContainer" role="application" aria-label="Sequence Chart" style="position:absolute;inset:0;overflow:hidden;"></div>
    <div class="elog-empty" id="empty">Open a Sequence Chart to see events here.</div>
  </div>
  <div id="hscroll"></div>
`;

const canvasContainer = document.getElementById('chartCanvasContainer')!;
const canvasStack: CanvasStackHandle = createCanvasStack(canvasContainer);

const hscrollEl = document.getElementById('hscroll')!;
hscrollEl.style.cssText = 'position:relative;height:12px;flex:0 0 auto;background:var(--vscode-scrollbarSlider-background,rgba(121,121,121,0.2));cursor:pointer;';
const hscrollThumbEl = document.createElement('div');
hscrollThumbEl.style.cssText = 'position:absolute;top:1px;bottom:1px;background:var(--vscode-scrollbarSlider-hoverBackground,rgba(100,100,100,0.6));border-radius:2px;min-width:16px;';
hscrollEl.appendChild(hscrollThumbEl);

function fileName(): string {
  if (!fileUri) return '';
  try {
    return decodeURIComponent(fileUri.split(/[\\/]/).pop() ?? fileUri);
  } catch {
    return fileUri;
  }
}

// ---------------------------------------------------------------------------------
// render loop
// ---------------------------------------------------------------------------------

let rafScheduled = false;
function scheduleRender(): void {
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(() => {
    rafScheduled = false;
    renderFrame();
  });
}

function applyModel(model: ViewportModel): void {
  lastModel = model;
  for (const id of model.moduleIds) knownModuleIds.add(id);
  sampleTable = buildSampleTable(model.events);
}

function simTimeAt(tc: number): number | null {
  return tcToSimTimeApprox(tc, sampleTable);
}

function renderFrame(): void {
  const empty = document.getElementById('empty')!;
  empty.style.display = summary && !summary.isEmpty ? 'none' : 'flex';
  if (!summary || summary.isEmpty) {
    lastPrimitives = [];
    canvasStack.render([], true);
    renderStatus();
    updateHScrollbar();
    return;
  }

  const range = visibleTcRange(viewport);
  const model = renderModelCache.request(
    { leftTc: range.leftTc, rightTc: range.rightTc, timelineMode: currentTimelineMode, coordinateSystemVersion: viewport.coordinateSystemVersion },
    (m) => {
      applyModel(m);
      scheduleRender();
    },
  );
  if (model) applyModel(model);

  const axesLayout: AxesLayout = deriveAxes(knownModuleIds, moduleTree, contentHeight(viewport), displayFlags.showEmptyAxes);
  const lastSimTime = summary.lastSimulationTime !== null ? Number(summary.lastSimulationTime) : 0;
  const tickResult = calculateTicks(currentTimelineMode, viewport.leftTc, range.rightTc, viewport.pixelsPerTc, lastSimTime, simTimeAt);
  const axisHeaderRoot = displayFlags.showAxisHeaders
    ? calculateAxisHeaders(
        axesLayout.axes.map((a) => a.moduleId),
        (moduleId) => findModuleNode(moduleId, moduleTree)?.fullName ?? `Module #${moduleId}`,
      )
    : null;

  const t0 = performance.now();
  const primitives = buildDrawList({
    timelineMode: currentTimelineMode,
    viewport,
    events: lastModel?.events ?? [],
    dependencies: lastModel?.dependencies ?? [],
    methodCalls: lastModel?.methodCalls ?? [],
    axesLayout,
    ticks: tickResult.ticks,
    theme: palette,
    selectedEventNumbers: selection.events,
    bookmarkedEventNumbers,
    bookmarkedModuleIds,
    bookmarkedDependencyKeys,
    displayFlags,
    axisHeaderRoot,
    infoPanelText: computeInfoPanelText(),
    skipLabelsForPerf: !antialiasEnabled,
  });
  lastPrimitives = primitives;
  canvasStack.render(primitives, antialiasEnabled);
  const elapsedMs = performance.now() - t0;
  // Antialias auto-toggle hysteresis -- port of SequenceChart.java's drawWithAntialias
  // state machine (see canvasStack.ts's ANTIALIAS_* constants + CanvasStackHandle.render()'s doc).
  if (antialiasEnabled && elapsedMs > ANTIALIAS_TURN_OFF_AT_MSEC) antialiasEnabled = false;
  else if (!antialiasEnabled && elapsedMs < ANTIALIAS_TURN_ON_AT_MSEC) antialiasEnabled = true;
  renderStatus();
  updateHScrollbar();
}

/** Phase U5 -- `showPositionAndRange`/`showEventLogInfo` panel text (`drawList.ts`'s `InfoPanelText`). Port of `drawPositionAndRange()`/`drawEventLogInfo()` (`SequenceChart.java:3338-3403`), approximated from `LogSummary` + the currently-loaded viewport model rather than the live parse-progress counters Java's second `eventLogInfo` line reads (`getNumParsedEvents()`/`FileReader.getNumReadLines/Bytes()` have no protocol exposure yet) -- documented simplification. */
function computeInfoPanelText(): InfoPanelText | undefined {
  if (!summary || summary.isEmpty) return undefined;
  const range = visibleTcRange(viewport);
  const visible = (lastModel?.events ?? []).filter((e) => e.tcBegin >= viewport.leftTc && e.tcBegin <= range.rightTc);
  const startEventNumber = visible.length > 0 ? Math.min(...visible.map((e) => e.eventNumber)) : summary.firstEventNumber;
  const endEventNumber = visible.length > 0 ? Math.max(...visible.map((e) => e.eventNumber)) : startEventNumber;
  const leftSim = simTimeAt(viewport.leftTc);
  const rightSim = simTimeAt(range.rightTc);
  const positionAndRange: [string, string] = [`Position: #${startEventNumber}, ${leftSim !== null ? formatTickLabel(leftSim) : '?'}`, `Range: #${endEventNumber - startEventNumber + 1}, ${leftSim !== null && rightSim !== null ? formatTickLabel(rightSim - leftSim) : '?'}`];
  const eventLogInfo: [string, string] = [
    `File: ${summary.fileSize} bytes, ~${summary.approximateNumberOfEvents} events (#${summary.firstEventNumber} .. #${summary.lastEventNumber}), ${summary.lastSimulationTime ?? '0'} s`,
    `Coordinate system version: ${summary.coordinateSystemVersion}${summary.filtered ? ' (filtered)' : ''}`,
  ];
  return { positionAndRange, eventLogInfo };
}

function renderStatus(): void {
  const statusEl = document.getElementById('status')!;
  renderSummaryStrip(statusEl, fileName(), summary);
  if (summary && !summary.isEmpty) {
    const range = visibleTcRange(viewport);
    const leftSim = simTimeAt(viewport.leftTc);
    const rightSim = simTimeAt(range.rightTc);
    const span = document.createElement('span');
    const leftLabel = leftSim !== null ? formatTickLabel(leftSim) : '?';
    const rightLabel = rightSim !== null ? formatTickLabel(rightSim) : '?';
    span.textContent = `View: ${leftLabel} – ${rightLabel}  (${viewport.pixelsPerTc.toPrecision(3)} px/tc)${viewport.followEnd ? '  •  following end' : ''}${antialiasEnabled ? '' : '  •  perf: reduced detail'}`;
    statusEl.appendChild(span);
  }
}

function updateHScrollbar(): void {
  if (beginTc === null || endTc === null || endTc <= beginTc) {
    hscrollThumbEl.style.width = '100%';
    hscrollThumbEl.style.left = '0';
    return;
  }
  const totalTc = endTc - beginTc;
  const visibleTc = contentWidth(viewport) / viewport.pixelsPerTc;
  const widthPct = Math.min(100, Math.max(2, (visibleTc / totalTc) * 100));
  const leftPct = Math.min(100 - widthPct, Math.max(0, ((viewport.leftTc - beginTc) / totalTc) * 100));
  hscrollThumbEl.style.width = `${widthPct}%`;
  hscrollThumbEl.style.left = `${leftPct}%`;
}

function jumpToHScrollFraction(fraction: number): void {
  if (beginTc === null || endTc === null) return;
  const totalTc = endTc - beginTc;
  const targetTc = beginTc + Math.min(1, Math.max(0, fraction)) * totalTc;
  viewport = panTo(viewport, targetTc - contentWidth(viewport) / 2 / viewport.pixelsPerTc);
  scheduleRender();
}

let hscrollDragging = false;
hscrollThumbEl.addEventListener('mousedown', (e) => {
  hscrollDragging = true;
  e.stopPropagation();
});
hscrollEl.addEventListener('mousedown', (e) => {
  if (e.target === hscrollThumbEl) return;
  const rect = hscrollEl.getBoundingClientRect();
  jumpToHScrollFraction((e.clientX - rect.left) / rect.width);
});
window.addEventListener('mousemove', (e) => {
  if (!hscrollDragging) return;
  const rect = hscrollEl.getBoundingClientRect();
  jumpToHScrollFraction((e.clientX - rect.left) / rect.width);
});
window.addEventListener('mouseup', () => {
  hscrollDragging = false;
});

// ---------------------------------------------------------------------------------
// engine round trips
// ---------------------------------------------------------------------------------

async function refreshEndpointsTc(): Promise<void> {
  if (!summary || summary.isEmpty) {
    beginTc = endTc = null;
    return;
  }
  try {
    const [b, e] = await Promise.all([
      rpc.request<MapCoordsResult>(ElogMethods.scMapCoords, { kind: 'eventToTc', eventNumber: summary.firstEventNumber }),
      rpc.request<MapCoordsResult>(ElogMethods.scMapCoords, { kind: 'eventToTc', eventNumber: summary.lastEventNumber }),
    ]);
    beginTc = b.tc;
    endTc = e.tc;
  } catch {
    beginTc = endTc = null;
  }
}

async function goToEnd(): Promise<void> {
  if (!summary || summary.isEmpty) return;
  await refreshEndpointsTc();
  if (endTc === null) return;
  viewport = gotoEndAt(viewport, endTc);
  scheduleRender();
}

async function goToBegin(): Promise<void> {
  if (!summary || summary.isEmpty) return;
  await refreshEndpointsTc();
  if (beginTc === null) return;
  viewport = gotoBeginAt(viewport, beginTc);
  scheduleRender();
}

/**
 * Relocates the engine's coordinate-system origin to `eventNumber` and centers the
 * viewport on it. Used both by `applyTimelineMode` (mode switch: "keep the event
 * under viewport center stable" per this phase's brief) and by inbound `reveal`
 * messages (goto/find results). Does NOT clear `knownModuleIds`/the module tree --
 * axes are keyed by module id, which relocation never changes; only the render-model
 * cache (whose windows are keyed by tc, meaningless across a coordinate-system
 * version bump) and the last-drawn model are dropped.
 */
async function relocateAndCenter(eventNumber: number, center = true): Promise<void> {
  const scState = await rpc.request<ScState>(ElogMethods.scRelocateOrigin, { eventNumber });
  renderModelCache.bumpGeneration();
  renderModelCache.invalidateAll();
  lastModel = null;
  viewport = { ...viewport, coordinateSystemVersion: scState.coordinateSystemVersion };
  viewport = center ? revealAt(viewport, 0) : gotoBeginAt(viewport, 0);
}

async function applyTimelineMode(mode: string, isInitial: boolean): Promise<void> {
  state = { ...state, timelineMode: mode };
  persistState();
  toolbar.setButtonState('refresh', { disabled: true });
  try {
    let anchorEventNumber: number | null = null;
    if (!isInitial && summary && !summary.isEmpty) {
      const centerTc = viewport.leftTc + contentWidth(viewport) / 2 / viewport.pixelsPerTc;
      try {
        const mapped = await rpc.request<MapCoordsResult>(ElogMethods.scMapCoords, { kind: 'tcToEventNumber', tc: centerTc });
        anchorEventNumber = mapped.eventNumber;
      } catch {
        anchorEventNumber = null;
      }
    }

    const params: ScSetTimelineModeParams = { timelineMode: mode as TimelineMode };
    const scState = await rpc.request<ScState>(ElogMethods.scSetTimelineMode, params);
    currentTimelineMode = scState.timelineMode;
    toolbar.setDropdownValue('timelineMode', scState.timelineMode);

    if (summary && !summary.isEmpty) {
      const target = anchorEventNumber ?? summary.firstEventNumber;
      await relocateAndCenter(target, anchorEventNumber !== null);
    } else {
      viewport = { ...viewport, coordinateSystemVersion: scState.coordinateSystemVersion };
    }
    hasInitializedViewport = true;
    await refreshEndpointsTc();
    scheduleRender();
  } finally {
    toolbar.setButtonState('refresh', { disabled: false });
  }
}

async function handleRevealTarget(target: RevealTarget): Promise<void> {
  if (!summary || summary.isEmpty) return;
  const eventNumber = target.kind === 'event' ? target.eventNumber : (target.ref?.eventNumber ?? null);
  if (eventNumber === null) return;
  try {
    // Any reveal (goto/find dialogs, cause/consequence/same-module keyboard nav, the
    // toolbar's Home/End buttons) also selects+focuses the resolved event -- matches
    // Java's goto* methods, which select the destination event too, not just scroll to it.
    selection = focusEvent(eventNumber);
    broadcastSelection();
    await relocateAndCenter(eventNumber, true);
    if (eventNumber === summary.lastEventNumber) viewport = { ...viewport, followEnd: true };
    await refreshEndpointsTc();
    scheduleRender();
  } catch {
    // engine busy/request superseded -- a later reveal (or the user's own navigation) will retry
  }
}

function refresh(): void {
  void rpc.request(ElogMethods.checkChanges, undefined);
}

// ---------------------------------------------------------------------------------
// U4: hit-testing / selection / tooltip / context menu / dialogs / keyboard nav
// ---------------------------------------------------------------------------------

/** Broadcasts the local selection to the host (`session.setSelection()` fans it out to every OTHER attached webview, per the re-entry guard -- see `uiProtocol.ts`'s header). `EventLogSelection` only carries `eventNumbers` today (dependency/axis/timelineCoord selection stays chart-local until a later phase grows the shared shape). */
function broadcastSelection(): void {
  vscode.postMessage({ type: 'selectionChanged', selection: { eventNumbers: [...selection.events], originId: 'chart' } });
}

/**
 * "Select in Event Log Table" (chart context menu, per-event section) -- explicitly
 * asks the table to reveal `eventNumber` without waiting for a passive cross-view
 * `setSelection` reveal-if-off-screen. Reuses the same engine `gotoEvent` round trip
 * `doGotoEvent()` already does for goto/cause/consequence navigation (which selects +
 * recenters THIS chart too, via the `reveal` the host's `session.gotoEvent()`
 * broadcasts to every attachment) -- a documented simplification: Java's own
 * chart-only "Select in table"-equivalent has no engine round trip and only reveals
 * the OTHER view, but re-centering the chart on an event the user just right-clicked
 * (already near the viewport center) is harmless, and this avoids inventing a second,
 * narrower reveal pathway for one context-menu item.
 */
function selectInTable(eventNumber: number): void {
  void doGotoEvent(eventNumber);
}

// ---- bookmarks (phase U6) ------------------------------------------------------------

function postToggleBookmark(candidate: BookmarkCandidate): void {
  vscode.postMessage({ type: 'toggleBookmark', candidate });
}

function toggleEventBookmark(eventNumber: number): void {
  postToggleBookmark({ kind: 'Event', eventNumber });
}

function toggleAxisBookmark(moduleId: number): void {
  const modulePath = findModuleNode(moduleId, moduleTree)?.fullName;
  if (modulePath) postToggleBookmark({ kind: 'Axis', modulePath });
}

function toggleDependencyBookmark(dep: RenderDependency): void {
  postToggleBookmark({ kind: 'MessageDependency', eventNumber: dep.causeEventNumber, consequenceEventNumber: dep.consequenceEventNumber, messageId: dep.messageId ?? undefined });
}

/**
 * Ctrl/Cmd+D (`interactions.ts`'s `onToggleBookmark`) -- toggles a bookmark for every
 * currently selected event/dependency/axis (port of `SequenceChartContributor.java`'s
 * "Toggle bookmark" action operating on the whole `IEventLogSelection`, one marker per
 * selected item). Method-call selections are NOT included: `RenderMethodCall` (the
 * viewport DTO) has no `entryIndex`/`EventLogEntryIndex` field the way Java's
 * `ComponentMethodBeginEntry` does, so this port cannot build a well-formed
 * `ComponentMethodCall` bookmark candidate from client-side data alone -- a documented
 * gap (the data MODEL/store fully supports the kind; only this one creation path is
 * missing, tracked as a follow-up rather than blocking the other 3 kinds).
 */
function toggleBookmarkForSelection(): void {
  for (const eventNumber of selection.events) toggleEventBookmark(eventNumber);
  for (const key of selection.dependencies) {
    const dep = dependencyForKey(key);
    if (dep) toggleDependencyBookmark(dep);
  }
  for (const moduleId of selection.axes) toggleAxisBookmark(moduleId);
}

function findEvent(eventNumber: number): TimelineEvent | null {
  return lastModel?.events.find((e) => e.eventNumber === eventNumber) ?? null;
}

/** Looks up a loaded `RenderDependency` by its `dependencyKey()`-shaped identity string -- shared by `findDependency()` (from a hit-test result) and the bookmark toggle path (from a `selection.dependencies` set member, which only carries the key, not the object). */
function dependencyForKey(key: string): RenderDependency | null {
  if (!lastModel) return null;
  return lastModel.dependencies.find((d) => dependencyKey({ dependencyKind: d.kind, causeEventNumber: d.causeEventNumber, consequenceEventNumber: d.consequenceEventNumber }) === key) ?? null;
}

function findDependency(hit: Extract<HitObject, { kind: 'dependency' }>): RenderDependency | null {
  return dependencyForKey(dependencyKey(hit));
}

function findMethodCall(hit: Extract<HitObject, { kind: 'methodCall' }>): RenderMethodCall | null {
  if (!lastModel) return null;
  const key = methodCallKey(hit);
  return lastModel.methodCalls.find((c) => methodCallKey(c) === key) ?? null;
}

/** The `RenderDependency` whose consequence is `eventNumber` (the "causing message" clause in `buildEventTooltip()`) -- looked up from the currently-loaded viewport model only (no extra round trip; a documented approximation, same class as `onGotoConsequence`/`onSameModuleNeighbor` below). */
function findCauseDependencyFor(eventNumber: number): RenderDependency | null {
  return lastModel?.dependencies.find((d) => d.consequenceEventNumber === eventNumber) ?? null;
}

/**
 * `eventNumber`'s cause event number (`TimelineEvent.causeEventNumber` if the event is
 * already loaded, else one `elog/getEventDetail` round trip) -- `null` for "no cause"
 * (engine sentinel `-1`, e.g. the initialization event) or if genuinely unresolvable.
 */
async function resolveCauseEventNumber(eventNumber: number): Promise<number | null> {
  const loaded = findEvent(eventNumber);
  if (loaded) return loaded.causeEventNumber >= 0 ? loaded.causeEventNumber : null;
  try {
    const detail = await rpc.request<EventDetail | null>(ElogMethods.getEventDetail, { eventNumber });
    return detail && detail.causeEventNumber >= 0 ? detail.causeEventNumber : null;
  } catch {
    return null;
  }
}

/**
 * Approximates "the first consequence of `eventNumber`" (Java: `event.getConsequences().
 * get(0).getConsequenceEvent()`) from the currently-loaded viewport model's
 * dependencies -- DOCUMENTED APPROXIMATION (no `elog/*` RPC exposes "list this event's
 * consequences" directly; the engine already supports everything this phase wires, and
 * adding a new protocol method is out of scope here). `null` if no dependency in the
 * loaded window has `causeEventNumber === eventNumber`.
 */
function findFirstConsequenceEventNumber(eventNumber: number): number | null {
  if (!lastModel) return null;
  const candidates = lastModel.dependencies.filter((d) => d.causeEventNumber === eventNumber).map((d) => d.consequenceEventNumber);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

/** Resolves `eventNumber` through the engine (validating it exists) and selects it; centering happens via the `reveal` broadcast the host sends after a successful `session.gotoEvent()` (see `handleRevealTarget` above) -- this function does NOT relocate/center itself, avoiding a double navigation. */
async function doGotoEvent(eventNumber: number, matchKind: MatchKind = MatchKind.EXACT): Promise<void> {
  try {
    await rpc.request<GotoResult>(ElogMethods.gotoEvent, { eventNumber, matchKind });
    // selection/centering: see handleRevealTarget -- the host's session.gotoEvent() broadcasts a
    // 'reveal' back to this same webview once the engine resolves the request.
  } catch {
    // engine busy/request superseded -- ignore, matches every other best-effort nav call in this file
  }
}

async function doGotoSimTime(simulationTime: string): Promise<void> {
  try {
    await rpc.request<GotoResult>(ElogMethods.gotoSimTime, { simulationTime, matchKind: MatchKind.FIRST_OR_PREVIOUS });
  } catch {
    // ignore -- see doGotoEvent
  }
}

async function performFind(state: FindTextState, continueFromLast: boolean): Promise<void> {
  findTextState = state;
  try {
    const params: FindTextParams = { start: continueFromLast ? lastFindRef : null, search: state.search, forward: !state.backward, caseSensitive: state.caseSensitive };
    const result = await rpc.request<FindTextResult>(ElogMethods.findText, params);
    if (result.found && result.ref) {
      lastFindRef = result.ref;
      // already-resolved reveal -- the host just re-broadcasts it (same path the toolbar's Home/End
      // buttons use), which drives selection+centering via handleRevealTarget above.
      vscode.postMessage({ type: 'revealRequest', target: { kind: 'event', eventNumber: result.ref.eventNumber, ref: result.ref } });
    }
  } catch {
    // engine busy/superseded -- ignore
  }
}

function showGotoEventDialog(): void {
  if (!summary || summary.isEmpty) return;
  openGotoEventDialog({ firstEventNumber: summary.firstEventNumber, lastEventNumber: summary.lastEventNumber }, (eventNumber) => void doGotoEvent(eventNumber));
}

function showGotoSimTimeDialog(): void {
  if (!summary || summary.isEmpty) return;
  const base = String(simTimeAt(viewport.leftTc) ?? summary.firstSimulationTime ?? 0);
  openGotoSimTimeDialog(base, summary.lastSimulationTime, (simulationTime) => void doGotoSimTime(simulationTime));
}

function showFindTextDialog(): void {
  openFindTextDialog(findTextState, (state) => {
    lastFindRef = null;
    void performFind(state, false);
  });
}

function repeatFind(): void {
  if (findTextState.search.length === 0) {
    showFindTextDialog();
    return;
  }
  void performFind(findTextState, true);
}

/** Vertically scrolls (only) so `moduleId`'s axis is centered in the content area -- "Center" on an axis, and the vertical half of "Center"/"Select Modules" navigation on an event (see `centerOnEvent` below). No-op if the module has no axis yet. */
function centerOnAxis(moduleId: number): void {
  const axesLayout = deriveAxes(knownModuleIds, moduleTree, contentHeight(viewport), displayFlags.showEmptyAxes);
  const axis = axesLayout.axes.find((a) => a.moduleId === moduleId);
  if (!axis) return;
  viewport = scrollVerticalTo(viewport, axis.y - contentHeight(viewport) / 2, maxVerticalScroll(axesLayout, contentHeight(viewport)));
  scheduleRender();
}

/** `true` iff `tc` already falls within the currently-visible horizontal range -- the visibility gate `setSelection`'s handler (phase U6) uses to decide whether an incoming cross-view selection needs to actually scroll, vs. just re-render in place (mirrors `tableView.ts`'s `revealRef()`, which gates its own scroll the same way). */
function isTcVisible(tc: number): boolean {
  const range = visibleTcRange(viewport);
  return tc >= range.leftTc && tc <= range.rightTc;
}

/** "Center" on an event: horizontally reveals its tc, vertically centers its axis. Falls back to `relocateAndCenter` (an origin relocation + engine round trip) if the event isn't in the currently-loaded viewport model. */
function centerOnEvent(eventNumber: number): void {
  const event = findEvent(eventNumber);
  if (event) {
    viewport = revealAt(viewport, event.tcBegin);
    centerOnAxis(event.moduleId); // also schedules the render
  } else {
    void relocateAndCenter(eventNumber, true).then(() => scheduleRender());
  }
}

/** Full-canvas-space (gutters baked in, same space `hitTest.ts`'s primitives use) pixel x -> timeline coordinate, or `null` if not zoomed in at all (`pixelsPerTc <= 0`) -- Java only appends its "timestamp" hit "if zoomed in". */
function fullCanvasPxToTc(px: number, v: ViewportState): number | null {
  return v.pixelsPerTc > 0 ? pixelToTc(px - GUTTER_LEFT_WIDTH, v) : null;
}

/** The exact primitive list the last frame drew, hit-tested at content-space `(px, py)` -- fed to `interactions.ts`'s click/dblclick/context-menu/tooltip handlers. */
function hitTestAt(px: number, py: number): HitObject[] {
  return hitTest({ primitives: lastPrimitives, px, py, pointerTc: fullCanvasPxToTc(px, viewport) });
}

async function resolveHitForTooltip(px: number, py: number): Promise<ResolvedHit | null> {
  const hits = hitTest({ primitives: lastPrimitives, px, py, pointerTc: fullCanvasPxToTc(px, viewport) });
  const primary = pickPrimary(hits);
  if (!primary) return null;

  switch (primary.kind) {
    case 'event': {
      const event = findEvent(primary.eventNumber);
      if (!event) return null;
      const causeDependency = findCauseDependencyFor(primary.eventNumber);
      let detail: EventDetail | null = null;
      try {
        detail = await rpc.request<EventDetail | null>(ElogMethods.getEventDetail, { eventNumber: primary.eventNumber });
      } catch {
        detail = null;
      }
      return { kind: 'event', event, causeDependency, detail };
    }
    case 'dependency': {
      const dependency = findDependency(primary);
      return dependency ? { kind: 'dependency', dependency } : null;
    }
    case 'methodCall': {
      const call = findMethodCall(primary);
      return call ? { kind: 'methodCall', call } : null;
    }
    case 'axis':
      return { kind: 'axis', moduleId: primary.moduleId };
    case 'timestamp': {
      const neighbors = findNeighborEvents(primary.tc, lastModel?.events ?? []);
      return { kind: 'timestamp', simTime: simTimeAt(primary.tc), beforeEventNumber: neighbors.before, afterEventNumber: neighbors.after };
    }
  }
}

function handleClick(hits: HitObject[], ctrl: boolean): void {
  const group = pickPrimaryGroup(hits);
  selection = applyClick(selection, group, ctrl);
  broadcastSelection();
  scheduleRender();
}

/** Double-click: zoom-to-message (fit a dependency's cause/consequence span) or the axis/open-module case, which is a documented STUB (U8 owns module-open navigation; this port has nowhere to navigate to yet). */
function handleDoubleClick(hits: HitObject[]): void {
  const target = pickDoubleClickTarget(hits);
  if (!target) return;
  if (target.kind === 'dependency') {
    viewport = zoomToFit(viewport, Math.min(target.causeTc, target.consequenceTc), Math.max(target.causeTc, target.consequenceTc));
    scheduleRender();
  }
  // target.kind === 'axis' -- open-module stub (U8), deliberately a no-op for now.
}

function openChartContextMenu(clientX: number, clientY: number, hits: HitObject[]): void {
  const actions: ChartMenuActions = {
    selectEvent: (eventNumber) => {
      selection = focusEvent(eventNumber);
      broadcastSelection();
      scheduleRender();
    },
    centerOnEvent,
    selectInTable,
    goToCauseEvent: (eventNumber) => void doGotoEvent(eventNumber),
    goToConsequenceEvent: (eventNumber) => void doGotoEvent(eventNumber),
    zoomToDependency: (causeTc, consequenceTc) => {
      viewport = zoomToFit(viewport, Math.min(causeTc, consequenceTc), Math.max(causeTc, consequenceTc));
      scheduleRender();
    },
    toggleEventBookmark,
    toggleDependencyBookmark: (hit) => {
      const dep = findDependency(hit);
      if (dep) toggleDependencyBookmark(dep);
    },
    toggleAxisBookmark,
    centerOnAxis,
    setTimelineMode: (mode) => void applyTimelineMode(mode, false),
    zoomIn: () => {
      viewport = zoomAtCenter(viewport, 1.5);
      scheduleRender();
    },
    zoomOut: () => {
      viewport = zoomAtCenter(viewport, 1 / 1.5);
      scheduleRender();
    },
    defaultZoom: () => {
      viewport = { ...viewport, pixelsPerTc: DEFAULT_PIXELS_PER_TC };
      scheduleRender();
    },
    zoomToFitAll: () => {
      if (beginTc !== null && endTc !== null) {
        viewport = zoomToFit(viewport, beginTc, endTc, 0.02);
        scheduleRender();
      }
    },
    openGotoEventDialog: showGotoEventDialog,
    openGotoSimTimeDialog: showGotoSimTimeDialog,
    gotoBegin: () => void goToBegin(),
    gotoEnd: () => void goToEnd(),
    openFindTextDialog: showFindTextDialog,
    findNext: repeatFind,
    refresh,
    toggleDisplayFlag: (key) => setDisplayFlags(toggleFlag(displayFlags, key)),
  };
  const entries = buildChartContextMenu({
    hits,
    resolveDependencyLabel: (hit) => {
      const dep = findDependency(hit);
      return dep ? buildDependencyLabel(dep) : null;
    },
    currentTimelineMode,
    actions,
    displayFlags,
  });
  showContextMenu(clientX, clientY, entries);
}

/** Plain ArrowLeft/ArrowRight -- move focus to the previous/next existing event (an exact-arithmetic neighbor may not exist, e.g. a filtered/gapped log, so this asks the engine for the nearest existing one via `MatchKind.FIRST_OR_PREVIOUS`/`FIRST_OR_NEXT`). Starts from the log's last/first event if nothing is focused yet. */
async function onMoveFocus(direction: -1 | 1): Promise<void> {
  if (!summary || summary.isEmpty) return;
  const focus = selection.focusEventNumber;
  const target = focus === null ? (direction < 0 ? summary.lastEventNumber : summary.firstEventNumber) : focus + direction;
  await doGotoEvent(target, direction < 0 ? MatchKind.FIRST_OR_PREVIOUS : MatchKind.FIRST_OR_NEXT);
}

/** Ctrl/Cmd+ArrowLeft -- go to the focused event's cause event. */
async function onGotoCause(): Promise<void> {
  const focus = selection.focusEventNumber;
  if (focus === null) return;
  const causeEventNumber = await resolveCauseEventNumber(focus);
  if (causeEventNumber !== null) await doGotoEvent(causeEventNumber);
}

/** Ctrl/Cmd+ArrowRight -- go to the focused event's (approximated) first consequence event. */
async function onGotoConsequence(): Promise<void> {
  const focus = selection.focusEventNumber;
  if (focus === null) return;
  const consequenceEventNumber = findFirstConsequenceEventNumber(focus);
  if (consequenceEventNumber !== null) await doGotoEvent(consequenceEventNumber);
}

/**
 * Shift+ArrowLeft/Right -- nearest previous/next event on the SAME module as the
 * focused event. DOCUMENTED APPROXIMATION: scans only the currently-loaded viewport
 * model's events (no "next event on this module" RPC exists) -- a no-op if the
 * neighbor isn't in the currently-fetched window (a later pan bringing it into view
 * would let the same keypress succeed).
 */
function onSameModuleNeighbor(direction: -1 | 1): void {
  const focus = selection.focusEventNumber;
  if (focus === null || !lastModel) return;
  const focusEventData = findEvent(focus);
  if (!focusEventData) return;
  const candidates = lastModel.events.filter((e) => e.moduleId === focusEventData.moduleId && (direction < 0 ? e.eventNumber < focus : e.eventNumber > focus)).map((e) => e.eventNumber);
  if (candidates.length === 0) return;
  void doGotoEvent(direction < 0 ? Math.max(...candidates) : Math.min(...candidates));
}

// ---------------------------------------------------------------------------------
// toolbar / theme / resize / interactions
// ---------------------------------------------------------------------------------

toolbar = buildToolbar(document.getElementById('toolbar')!, [
  { kind: 'button', button: { id: 'home', icon: 'home', title: 'Go to start', onClick: () => vscode.postMessage({ type: 'revealRequest', target: { kind: 'event', eventNumber: summary?.firstEventNumber ?? 0, ref: null } }) } },
  { kind: 'button', button: { id: 'gotoEnd', icon: 'arrow-right', title: 'Go to end', onClick: () => vscode.postMessage({ type: 'revealRequest', target: { kind: 'event', eventNumber: summary?.lastEventNumber ?? 0, ref: null } }) } },
  { kind: 'separator' },
  { kind: 'button', button: { id: 'zoomOut', icon: 'zoom-out', title: 'Zoom out', onClick: () => { viewport = zoomAtCenter(viewport, 1 / 1.5); scheduleRender(); } } },
  { kind: 'button', button: { id: 'zoomIn', icon: 'zoom-in', title: 'Zoom in', onClick: () => { viewport = zoomAtCenter(viewport, 1.5); scheduleRender(); } } },
  { kind: 'separator' },
  {
    kind: 'button',
    button: {
      id: 'followEnd',
      icon: 'pin',
      title: 'Follow end (auto-scroll on new data)',
      toggled: false,
      onClick: () => {
        if (viewport.followEnd) {
          viewport = { ...viewport, followEnd: false };
          toolbar.setButtonState('followEnd', { toggled: false });
          scheduleRender();
        } else {
          void goToEnd().then(() => toolbar.setButtonState('followEnd', { toggled: true }));
        }
      },
    },
  },
  { kind: 'button', button: { id: 'refresh', icon: 'refresh', title: 'Refresh', onClick: refresh } },
  { kind: 'spacer' },
  { kind: 'dropdown', dropdown: { id: 'timelineMode', title: 'Timeline Mode', options: TIMELINE_MODE_OPTIONS, value: currentTimelineMode, onChange: (v) => void applyTimelineMode(v, false) } },
]);

watchThemeChange((p) => {
  palette = p;
  scheduleRender();
});

attachInteractions(canvasContainer, {
  getViewport: () => viewport,
  setViewport: (v) => {
    viewport = v;
    toolbar.setButtonState('followEnd', { toggled: v.followEnd });
  },
  getAxesLayout: () => deriveAxes(knownModuleIds, moduleTree, contentHeight(viewport), displayFlags.showEmptyAxes),
  getBeginTc: () => beginTc,
  getEndTc: () => endTc,
  onChanged: () => scheduleRender(),

  getPrimitives: () => lastPrimitives,
  hitTestAt,
  onClick: handleClick,
  onDoubleClick: handleDoubleClick,
  onContextMenu: openChartContextMenu,
  onEscape: () => {
    selection = clearSelection(selection);
    broadcastSelection();
    scheduleRender();
  },
  onRefresh: refresh,
  onToggleTimeDifferences: () => setDisplayFlags(toggleFlag(displayFlags, 'showTimeDifferences')),
  onDeleteExclude: () => {
    // STUB (phase U7 owns the Filter UI this needs -- "Del-exclude shortcut" is
    // explicitly one of U7's own listed deliverables, not this phase's).
  },
  onMoveFocus: (direction) => void onMoveFocus(direction),
  onGotoCause: () => void onGotoCause(),
  onGotoConsequence: () => void onGotoConsequence(),
  onSameModuleNeighbor,
  onDefaultZoom: () => {
    viewport = { ...viewport, pixelsPerTc: DEFAULT_PIXELS_PER_TC };
    scheduleRender();
  },
  onToggleBookmark: toggleBookmarkForSelection,
});

attachTooltip({
  hostElement: canvasContainer,
  resolveHit: resolveHitForTooltip,
  ctx: labelProviderCtx,
});

const resizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const { width, height } = entry.contentRect;
    viewport = resizeViewport(viewport, width, height);
    canvasStack.resize(width, height);
    scheduleRender();
  }
});
resizeObserver.observe(canvasContainer);

// ---------------------------------------------------------------------------------
// host <-> webview message pump
// ---------------------------------------------------------------------------------

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'init': {
      fileUri = message.fileUri;
      summary = message.summary;
      bookmarks = message.bookmarks;
      recomputeBookmarkIndexes();
      if (message.selection.eventNumbers.length > 0) {
        // Phase U6: seed the session's current selection right away (repaints with the
        // right highlight even before data loads) -- a proper reveal (centering on it)
        // happens below once the initial timeline-mode setup/relocate-to-start settles,
        // so a webview reattaching to an already-selected session (a pinned table
        // rebind, or this very chart reloading) still ends up looking at the right event.
        const eventNumbers = message.selection.eventNumbers;
        selection = { ...EMPTY_CHART_SELECTION, events: new Set(eventNumbers), focusEventNumber: eventNumbers[eventNumbers.length - 1] };
      }
      if (message.persistedState && typeof message.persistedState === 'object') {
        state = { ...state, ...(message.persistedState as PersistedChartState) };
        toolbar.setDropdownValue('timelineMode', state.timelineMode ?? TimelineMode.SIMULATION_TIME);
        displayFlags = mergeDisplayFlags(state.displayFlags);
      }
      renderFrame();
      if (fileUri) {
        void rpc.request<ElogModule | null>(ElogMethods.getModuleTree, undefined).then((tree) => {
          moduleTree = tree;
          recomputeBookmarkIndexes();
          scheduleRender();
        });
        void applyTimelineMode(state.timelineMode ?? TimelineMode.SIMULATION_TIME, !hasInitializedViewport).then(() => {
          if (selection.focusEventNumber !== null) centerOnEvent(selection.focusEventNumber);
        });
      }
      break;
    }
    case 'engineResponse':
      rpc.handleResponse(message);
      break;
    case 'engineNotify': {
      if (message.event === 'elog/changed' || message.event === 'elog/refreshed' || message.event === 'restarted') {
        const payload = message.payload as { summary?: LogSummary; change?: 'appended' | 'overwritten' };
        if (payload?.summary) {
          const versionChanged = summary?.coordinateSystemVersion !== payload.summary.coordinateSystemVersion;
          summary = payload.summary;
          renderModelCache.bumpGeneration();
          renderModelCache.invalidateAll();
          if (versionChanged || payload.change === 'overwritten') {
            knownModuleIds.clear();
            lastModel = null;
          }
          void refreshEndpointsTc().then(() => {
            if (viewport.followEnd) void goToEnd();
            else scheduleRender();
          });
        }
        renderFrame();
      }
      break;
    }
    case 'reveal':
      void handleRevealTarget(message.target);
      break;
    case 'setSelection': {
      // The OTHER view's (table's, or a rebind/late-attach push -- see uiProtocol.ts's
      // header + eventLogSession.ts's `attach()`/`setSelection()`) selection changed --
      // apply it locally WITHOUT re-broadcasting (the session's own re-entry guard
      // already keeps this from echoing, but this handler must not call
      // `broadcastSelection()` regardless, since it isn't a new user gesture).
      // Phase U6: receiving a selection from elsewhere both selects AND reveals it if
      // it isn't already on screen (the researched Eclipse semantics -- see
      // `EventLogSelection`'s doc in uiProtocol.ts: a LOCAL click only selects since the
      // clicked thing is already visible, but an incoming selection might not be).
      const eventNumbers = message.selection.eventNumbers;
      selection = { ...EMPTY_CHART_SELECTION, events: new Set(eventNumbers), focusEventNumber: eventNumbers.length > 0 ? eventNumbers[eventNumbers.length - 1] : selection.focusEventNumber };
      const focus = selection.focusEventNumber;
      const loaded = focus !== null ? findEvent(focus) : null;
      if (focus !== null && (!loaded || !isTcVisible(loaded.tcBegin))) centerOnEvent(focus);
      else scheduleRender();
      break;
    }
    case 'bookmarksChanged':
      bookmarks = message.bookmarks;
      recomputeBookmarkIndexes();
      scheduleRender();
      break;
    case 'command':
      // Forwarded from `eventLogDialogs.ts`'s native commands when this webview is
      // attached (see that file's header) -- opens the corresponding in-webview dialog.
      switch (message.command) {
        case 'openGotoEventDialog':
          showGotoEventDialog();
          break;
        case 'openGotoSimTimeDialog':
          showGotoSimTimeDialog();
          break;
        case 'openFindTextDialog':
          showFindTextDialog();
          break;
        case 'findNext':
          repeatFind();
          break;
        case 'centerOnAxisBookmark': {
          // Phase U6 -- "Show Bookmarks" QuickPick reveal for an Axis-kind bookmark
          // (`bookmarks.ts`'s `revealBookmark()`): no event number to goto, so the host
          // sends the stored `modulePath` directly for this webview to resolve.
          const args = message.args as { modulePath?: string } | undefined;
          const moduleId = args?.modulePath ? findModuleIdByFullName(args.modulePath, moduleTree) : null;
          if (moduleId !== null) centerOnAxis(moduleId);
          break;
        }
      }
      break;
  }
});

vscode.postMessage({ type: 'ready' });
renderFrame();
