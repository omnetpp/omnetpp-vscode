import {
  ElogMethods,
  MatchKind,
  TimelineMode,
  type AdjacencyParams,
  type AdjacencyResult,
  type ElogModule,
  type EventDetail,
  type FilterHints,
  type FilterParams,
  type FindTextParams,
  type FindTextResult,
  type GotoResult,
  type LogSummary,
  type MapCoordsResult,
  type ReleaseMemoryResult,
  type RenderDependency,
  type RenderMethodCall,
  type RowRef,
  type ScSetTimelineModeParams,
  type ScState,
  type TimelineEvent,
  type VectorIdentity,
  type ViewportModel,
  type ViewportParams,
} from '@omnetpp/shared/elog-protocol';
import type { Bookmark, BookmarkCandidate, EventLogUiSettings, HostToWebviewMessage, RevealTarget, WebviewToHostMessage } from '@omnetpp/shared/ui-protocol';
import { EngineRpc, RequestCancelledError } from '../common/rpc';
import { loadPersistedBlob, withVersion } from '../common/persistedState';
import { buildToolbar, type ToolbarHandle } from '../common/toolbar';
import { renderSummaryStrip } from '../common/summary';
import { setTimeDisplayAccuracy } from '../common/decimalTime';
import { readPalette, watchThemeChange, type EventLogPalette } from '../common/theme';
import { showContextMenu } from '../common/contextMenu';
import { DEFAULT_FIND_TEXT_STATE, openFindTextDialog, openGotoEventDialog, openGotoSimTimeDialog, type FindTextState } from '../common/dialogs';
import { classifyEngineError, mountNotificationOverlay, type NotificationOverlayHandle } from '../common/notificationOverlay';
import { AUTO_AXIS_SPACING, clampAxisSpacing, DENSE_AXIS_SPACING, deriveAxes, findModuleFullPath, findModuleIdByFullName, findModuleIdByFullPath, findModuleNode, layoutAxes, maxVerticalScroll, type AxesLayout, type AxisSpacingSpec } from './axes';
import { calculateAxisHeaders, flattenDrawableAxisHeaders, type AxisHeaderNode } from './axisHeaders';
import {
  applyOrdering,
  calculateManualOrdering,
  calculateOrderingByMinimizingCost,
  calculateOrderingByModuleId,
  calculateOrderingByModuleName,
  currentManualOrder,
  ensureInManualOrder,
  MINIMIZE_CROSSINGS_SAMPLE_COUNT,
  updateManualOrder,
  type AxisOrderingMode,
} from './axisOrder';
import {
  buildNodeMap,
  buildParentMap,
  collapseOpenAxisModule,
  collapseOpenAxisModuleSubmodules,
  collectActiveModuleIds,
  computeVisibleAxisModuleIds,
  defaultOpenAxisModules,
  expandOpenAxisModule,
  expandOpenAxisModuleRecursively,
  moduleGlyphInfo,
  moduleIdsToPaths,
  moduleIdToAxisModuleIdMap,
  openModule,
  openModuleRecursively,
  pathsToModuleIds,
  removeOpenAxisModule,
  removeOpenAxisModuleSubtree,
} from './openAxisModules';
import { buildChartContextMenu, buildShowHideEntries, type AxisModuleMenuInfo, type ChartMenuActions, type PresetConfiguration } from './chartContextMenu';
import { buildSampleTable, pixelToTc, tcToSimTimeApprox, type TcSimSample } from './coords';
import { mergeDisplayFlags, presetDefaultFlags, presetNetworkCommunicationFlags, showAllFlags, toggleFlag, type ChartDisplayFlags } from './displayFlags';
import { bookmarkDependencyKey, buildDrawList, type DrawPrimitive, type InfoPanelText } from './drawList';
import { openSelectModulesDialog } from './selectModulesDialog';
import { openListReorderDialog } from './reorderDialog';
import { calculateTicks, formatMouseTime, formatTickLabel, formatTickTime } from './ticks';
import { ANTIALIAS_TURN_OFF_AT_MSEC, ANTIALIAS_TURN_ON_AT_MSEC, createCanvasStack, DEFAULT_CHART_FONT_SIZE_PX, renderPrimitivesToCanvas, type CanvasStackHandle } from './canvasStack';
import { openExportRangeDialog, type ExportDialogResult } from './exportDialog';
import { buildChartSvg, computeExportWidthPx, resolveExportRange, type ExportRangeContext } from './svgExport';
import { buildFilterPanel, type FilterPanelHandle } from './filterPanel';
import {
  applyExcludedEventNumbersToState,
  buildFilterParams,
  mergeExcludedEventNumbers,
  mergeFilterPanelState,
  prefillCauseConsequenceFilter,
  prefillMessageFilter,
  type FilterPanelState,
} from './filterPanelState';
import { hitTest, pickDoubleClickTarget, pickPrimary, pickPrimaryGroup, type HitObject } from './hitTest';
import { attachInteractions } from './interactions';
import { buildAxisTooltip, buildDependencyLabel, buildDependencyTooltip, buildEventTooltip, buildMethodCallTooltip, buildTimestampTooltip, type LabelProviderContext } from './labelProvider';
import { applyClick, clearSelection, dependencyKey, EMPTY_CHART_SELECTION, focusEvent, methodCallKey, type ChartSelectionState } from './selection';
import { attachTooltip } from './tooltip';
import { RenderModelCache, type EngineViewportSource } from './renderModelCache';
import {
  contentHeight,
  contentWidth,
  createViewportState,
  DEFAULT_PIXELS_PER_TC,
  GUTTER_LEFT_WIDTH,
  GUTTER_TOP_HEIGHT,
  gotoBeginAt,
  gotoEndAt,
  MAX_PIXELS_PER_TC,
  MIN_PIXELS_PER_TC,
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
  /**
   * Phase U7 -- the filter PANEL's own UI state (every field + section-enabled flag,
   * `filterPanelState.ts`), persisted the same way `displayFlags` is above. NOTE this
   * is distinct from the session's actually-APPLIED `FilterParams` (persisted
   * separately, host-side, keyed by file uri -- `eventLogController.ts`'s
   * `FILTER_PARAMS_KEY` -- so it survives even while no webview is open at all): this
   * blob only remembers what the PANEL WIDGETS were showing, so reopening the panel
   * looks the same as when the user last left it, independent of whether "Apply" was
   * ever clicked (Java's dialog is modal and always starts from the last-applied
   * params; this port's panel is a persistent sidebar, so it gets to remember more).
   */
  filterPanel?: Partial<FilterPanelState>;
  /**
   * Phase U8 -- the open axis modules, as module FULL PATHS (see `openAxisModules.
   * ts`'s header for the ids-in-memory/paths-persisted decision). `undefined` = the
   * user never touched axis management for this file (first tree load applies Java's
   * default, `openModuleRecursively(root)`); an EMPTY array is a real state (the
   * "Empty" preset) and must round-trip as such.
   */
  openAxisModulePaths?: string[];
  /**
   * Axis vector-data attachments, keyed by module FULL PATH (same ids-in-memory /
   * paths-persisted rule as `openAxisModulePaths` -- module ids aren't stable across worker
   * reloads). Only the vector's identity + file uri is stored (never sample data); on load
   * the host re-reads the `.vec` and re-loads the vector (Eclipse persists the identity and
   * reloads too).
   */
  axisVectorAttachments?: { modulePath: string; fileUri: string; vector: VectorIdentity }[];
  /** Phase U8 -- `SequenceChart.AxisOrderingMode`, persisted like `timelineMode`. */
  axisOrderingMode?: AxisOrderingMode;
  /** Phase U8 -- `ManualAxisOrder.lastAxisModuleOrder` as module full paths (the persistent TOTAL order over every module ever seen -- both the Manual mode and Minimize Crossings' re-basing read it). */
  manualAxisOrderPaths?: string[];
  /** Phase U8 -- `AxisSpacingMode` (`'auto'` = Balanced, `'manual'` = Dense/Increase/Decrease territory) + the manual spacing value (Java persists both, `SequenceChartSettings.axisSpacingMode`/`.axisSpacing`). */
  axisSpacingMode?: 'auto' | 'manual';
  axisSpacing?: number;
  /**
   * Phase U10 -- the horizontal viewport (as an origin EVENT + zoom, not a raw timeline
   * coordinate -- tc is meaningless across a coordinate-system version bump, e.g. after
   * a reopen) plus vertical scroll, debounced-persisted on every settled pan/zoom/
   * vscroll (`noteViewportActivity()`/`persistViewportNow()`, ~400ms after the last
   * mutation -- never mid-gesture). `undefined` = never persisted yet (a fresh file, or
   * an older blob) -- the 'init' handler then falls back to `omnetpp.eventlog.
   * followEndOnAppend` (goto-end) or the plain default (goto-begin). Deliberately does
   * NOT carry `followEnd`: a restored viewport is always a specific FIXED position,
   * never "keep following" -- re-establishing `followEnd` from a stale blob could
   * silently start auto-scrolling a file the user had deliberately scrolled away from
   * the end of.
   */
  viewport?: { originEventNumber: number; pixelsPerTc: number; vscroll: number };
  /** The "Time Accuracy" selection: max fractional-seconds digits to display, or `null`/absent = full precision. Rounds every displayed time (hovers, deltas, ruler, info panels, hairline). */
  timeAccuracy?: number | null;
}

/** Phase U10 -- bump whenever `PersistedChartState`'s shape changes in a way older code could misinterpret; see `persistedState.ts`'s header for the tolerant-load policy this gates. */
const CHART_STATE_VERSION = 2;

const vscode = acquireVsCodeApi();
const rpc = new EngineRpc(vscode);
let state: PersistedChartState = loadPersistedBlob<PersistedChartState>(vscode.getState(), CHART_STATE_VERSION);
let fileUri = '';
let summary: LogSummary | null = null;
let toolbar: ToolbarHandle;
/** Phase U10 -- the `init` message's `EventLogUiSettings` DTO (`omnetpp.sequenceChart.*`/`omnetpp.eventlog.*`), re-sent fresh on every webview `ready` handshake (see `sequenceChartEditor.ts`'s `readEventLogUiSettings()`) -- `undefined` only for the instant between this webview's bootstrap and its first `init` reply. */
let uiSettings: EventLogUiSettings | undefined;

/** Phase U10 (cheap-gap closure) -- resolves `omnetpp.sequenceChart.fontSize` (`0`/unset = follow `canvasStack.ts`'s own DEFAULT_CHART_FONT_SIZE_PX) into the base px `canvasStack.render()`/`renderPrimitivesToCanvas()` scale their hardcoded label fonts from. Re-read on every call (not cached) so a live settings change (`onDidChangeConfiguration` -> a fresh `init`) takes effect on the very next frame. */
function currentChartFontSizePx(): number {
  const configured = uiSettings?.sequenceChart?.fontSize;
  return configured && configured > 0 ? configured : DEFAULT_CHART_FONT_SIZE_PX;
}
/** Phase U9 -- the shared error/canceled/out-of-sync overlay (`common/notificationOverlay.ts`), mounted once `body`'s DOM exists (below). */
let notificationOverlay: NotificationOverlayHandle;

let currentTimelineMode: TimelineMode = (state.timelineMode as TimelineMode) ?? TimelineMode.SIMULATION_TIME;
/** The "Time Accuracy" selection (max fractional-seconds digits, or `null` = full). Applied globally to `decimalTime`'s formatters so every displayed time rounds to it. */
let timeAccuracy: number | null = state.timeAccuracy ?? null;
setTimeDisplayAccuracy(timeAccuracy);
let viewport: ViewportState = createViewportState();
let palette: EventLogPalette = readPalette();
let moduleTree: ElogModule | null = null;
const knownModuleIds = new Set<number>();
let lastModel: ViewportModel | null = null;
let sampleTable: TcSimSample[] = [];
let beginTc: number | null = null;
let endTc: number | null = null;
/** `beginTc`, adjusted for `firstNavigableEventNumber()` -- see that function's doc. Used by "go to start" navigation only (the Home key/button, "Go to Begin"); everything else (scrollbar position, "whole chart" export, zoom-to-fit) intentionally keeps using the TRUE `beginTc`. */
let navigableBeginTc: number | null = null;
let hasInitializedViewport = false;
/** The engine's current timeline-coordinate-system origin event (last value reported by `relocateOrigin`/`setTimelineMode`). Anchors the data-driven default zoom (`computeDefaultPixelsPerTc()`), matching Java's `setDefaultPixelPerTimelineUnit()`, which measures the tc span starting at the origin event. */
let coordinateSystemOriginEventNumber = 0;
/**
 * Phase U10 -- `omnetpp.eventlog.followEndOnAppend`'s "or first append arrives" clause:
 * set (in the 'init' handler) when this is a genuinely fresh file (no persisted
 * viewport) and the setting is on; consumed either right there (if the file already has
 * content) or later, the first time an `elog/changed` notification's summary goes from
 * empty to non-empty (a live run whose file existed but had nothing recorded yet at
 * open time) -- either way, exactly once, then behaves like the ordinary `followEnd`
 * toggle from then on.
 */
let followEndOnOpenPending = false;
/** The exact primitive list the last frame was drawn from -- fed to `hitTest.ts` (click/dblclick/context-menu/tooltip all hit-test against WHAT'S ON SCREEN, never a re-derived geometry). */
let lastPrimitives: DrawPrimitive[] = [];
/** Phase U4 selection state (events/dependencies/methodCalls/axes/timelineCoords + focus) -- see `selection.ts`. */
let selection: ChartSelectionState = EMPTY_CHART_SELECTION;
/** Phase U11 -- the object(s) currently under the cursor, highlighted "bold red" on hover (Java `highlightedObjects`). `hoverSignature` guards re-renders so a hover that doesn't change the target is a no-op. */
let hovered: { events: Set<number>; dependencyKeys: Set<string>; axisModuleIds: Set<number>; methodCallKeys: Set<string> } = { events: new Set(), dependencyKeys: new Set(), axisModuleIds: new Set(), methodCallKeys: new Set() };
let hoverSignature = '';
/** Phase U11 -- the content-area canvas x of the cursor, for the live "tick under the mouse" hairline (`drawTickUnderMouse()`); `null` when the pointer is off the content area. */
let mouseContentX: number | null = null;
/** The current tick prefix (Java `tickPrefix`) computed by the last `calculateTicks`; the hairline shows its time relative to this ("+340ms") when non-zero. */
let currentTickPrefix = 0;

/** Axis vector-data attachments (module id → the vector's file + identity), mirrored from the host's worker state via `axisVectorAttachmentChanged`. Drives the Attach/Detach menu state and is persisted (by module full path). */
const axisVectorAttachments = new Map<number, { fileUri: string; vector: VectorIdentity }>();
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
/** Phase U7 -- the session's currently-applied filter (`null` = unfiltered), seeded from `init`'s `filterParams` and kept in sync by every successful `elog/setFilter` call THIS webview makes (the chart is always the sole initiator of filter changes -- see `applyFilterParamsAndReanchor()`'s own doc comment for why: `sequenceChartEditor.ts`'s `supportsMultipleEditorsPerDocument: false` guarantees at most one chart webview per session). Read by the Del-exclude merge (`mergeExcludedEventNumbers()`) so it can build on top of whatever is ALREADY active, even a filter this webview never itself applied (rehydrated from a previous session). */
let currentFilterParams: FilterParams | null = null;
let filterPanel: FilterPanelHandle;
let filterHintsLoaded = false;

// ---------------------------------------------------------------------------------
// Phase U8 -- axis management state (open axis modules / ordering / spacing).
// See `openAxisModules.ts` + `axisOrder.ts` for the ported semantics.
// ---------------------------------------------------------------------------------

/** The open axis modules (module ids, insertion-ordered like Java's ArrayList). `null` until the module tree loads and `initializeOpenAxisModules()` resolves the persisted paths / applies the default -- `currentAxesLayout()` falls back to the pre-U8 all-known-modules derivation meanwhile. */
let openAxisModuleIds: number[] | null = null;
let axisOrderingMode: AxisOrderingMode = state.axisOrderingMode ?? 'moduleId';
/** `ManualAxisOrder.lastAxisModuleOrder`, as full paths. Grown in-memory by `ensureInManualOrder()` during ordering (deterministic re-append, so per-frame growth is deliberately NOT persisted -- only explicit reorder-dialog commits are). */
let manualOrderPaths: string[] = state.manualAxisOrderPaths ?? [];
let axisSpacingMode: 'auto' | 'manual' = state.axisSpacingMode ?? 'auto';
let axisSpacingManual: number = state.axisSpacing !== undefined ? clampAxisSpacing(state.axisSpacing) : DENSE_AXIS_SPACING;
/** Minimize-crossings result cache, keyed by the visible axis-module id list -- the bubble sort needs an engine round trip (`elog/sc/adjacencyMatrix`) so it cannot run inside the synchronous layout pass; until the async job lands, layout uses the manual-order re-base (Java's own starting order for this mode). */
let crossingsOrderCache: { key: string; orderedIds: number[] } | null = null;
let crossingsInFlightKey: string | null = null;
/** Transient status-strip note (e.g. a preset's degradation message); cleared by a timer. */
let statusNote: string | null = null;
let statusNoteTimer: ReturnType<typeof setTimeout> | undefined;

function showStatusNote(text: string): void {
  statusNote = text;
  clearTimeout(statusNoteTimer);
  statusNoteTimer = setTimeout(() => {
    statusNote = null;
    renderStatus();
  }, 8000);
  renderStatus();
}

function fullPathOf(moduleId: number): string {
  return findModuleNode(moduleId, moduleTree)?.fullName ?? `Module #${moduleId}`;
}

/** Applies the current ordering mode to the visible axis-module id list (Java `calculateAxisModulePositions()`'s switch). */
function orderVisibleAxes(visible: readonly number[]): number[] {
  switch (axisOrderingMode) {
    case 'moduleId':
      return applyOrdering(visible, calculateOrderingByModuleId(visible));
    case 'moduleFullPath':
      return applyOrdering(visible, calculateOrderingByModuleName(visible.map(fullPathOf)));
    case 'manual': {
      const paths = visible.map(fullPathOf);
      manualOrderPaths = ensureInManualOrder(manualOrderPaths, paths);
      return applyOrdering(visible, calculateManualOrdering(manualOrderPaths, paths));
    }
    case 'minimizeCrossings': {
      const key = visible.join(',');
      if (crossingsOrderCache?.key === key) return crossingsOrderCache.orderedIds;
      void requestCrossingsOrdering([...visible], key);
      // until the engine round trip lands: the manual-order re-base, which is ALSO the
      // exact starting order Java feeds the bubble sort (`manualAxisOrder.
      // getCurrentAxisModuleOrder()` re-base in `calculateAxisModulePositions()`)
      const paths = visible.map(fullPathOf);
      manualOrderPaths = ensureInManualOrder(manualOrderPaths, paths);
      return applyOrdering(visible, calculateManualOrdering(manualOrderPaths, paths));
    }
  }
}

/**
 * Fetches the adjacency matrix and runs the ported bubble sort (`axisOrder.ts`).
 * Weights/sampling per `FlatAxisOrderByMinimizingCost.java`: send=1, reuse=0, 1000
 * samples -- SIMPLIFICATION (documented): Java uses an EXACT event-range matrix when
 * the visible range spans <1000 events and sampling otherwise; this port always
 * samples (the engine supports both, but the chart would need an extra
 * viewport-to-event-range round trip to know the span -- the sampled matrix is what
 * Java uses for every non-trivial log anyway). Also passes the full
 * descendant->axis mapping so collapsed-subtree traffic counts (see
 * `AdjacencyParams.moduleIdToAxisIndex`).
 */
async function requestCrossingsOrdering(visible: number[], key: string): Promise<void> {
  if (crossingsInFlightKey === key || visible.length === 0) return;
  crossingsInFlightKey = key;
  try {
    const paths = visible.map(fullPathOf);
    manualOrderPaths = ensureInManualOrder(manualOrderPaths, paths);
    const base = applyOrdering(visible, calculateManualOrdering(manualOrderPaths, paths));
    const indexOf = new Map(base.map((id, i) => [id, i]));
    const moduleIdToAxisIndex: Record<string, number> = {};
    for (const [id, axisModuleId] of moduleIdToAxisModuleIdMap(base, moduleTree, knownModuleIds)) {
      if (!indexOf.has(id)) {
        const index = indexOf.get(axisModuleId);
        if (index !== undefined) moduleIdToAxisIndex[String(id)] = index;
      }
    }
    const params: AdjacencyParams = { moduleIds: base, moduleIdToAxisIndex, numberOfSamples: MINIMIZE_CROSSINGS_SAMPLE_COUNT, messageSendWeight: 1, messageReuseWeight: 0 };
    const result = await rpc.request<AdjacencyResult>(ElogMethods.scAdjacencyMatrix, params);
    const positions = calculateOrderingByMinimizingCost(result.matrix, result.numberOfAxes);
    crossingsOrderCache = { key, orderedIds: applyOrdering(base, positions) };
    scheduleRender();
  } catch {
    // engine busy/superseded -- the next layout invalidation retries
  } finally {
    if (crossingsInFlightKey === key) crossingsInFlightKey = null;
  }
}

/** The full U8 axes pipeline: visible set (open modules × activity) -> ordering -> vertical layout. Falls back to the pre-U8 derivation while the module tree / open set aren't initialized yet. */
/** Module ids currently showing a vector-data strip (so their axis rows reserve the taller strip height in the layout). Empty unless the flag is on and the last viewport carried strips. */
function strippedModuleIds(): ReadonlySet<number> | undefined {
  if (!displayFlags.showAxisVectorData || !lastModel?.axisVectorStrips?.length) return undefined;
  return new Set(lastModel.axisVectorStrips.map((s) => s.moduleId));
}

function currentAxesLayout(): AxesLayout {
  const spacing: AxisSpacingSpec = axisSpacingMode === 'manual' ? { mode: 'manual', manualSpacing: axisSpacingManual } : AUTO_AXIS_SPACING;
  const strips = strippedModuleIds();
  // "Active" modules, for the Empty-Axes-off axis-visibility decision: re-derived from the
  // CURRENT viewport's actual events/dependencies/methodCalls, filtered by the SAME display
  // flags that decide what actually draws (collectActiveModuleIds() shares its dependency
  // rule with pushDependency() so a module hidden only behind e.g. showMessageReuses/
  // showInitializationEvent never gets a spuriously "empty" axis). Falls back to the
  // accumulated knownModuleIds only before any viewport has loaded.
  const activeIds = lastModel ? collectActiveModuleIds(lastModel, displayFlags) : knownModuleIds;
  if (moduleTree === null || openAxisModuleIds === null) {
    if (spacing.mode === 'manual') return layoutAxes([...activeIds].sort((a, b) => a - b), moduleTree, contentHeight(viewport), spacing, strips);
    return deriveAxes(activeIds, moduleTree, contentHeight(viewport), displayFlags.showEmptyAxes);
  }
  const visible = computeVisibleAxisModuleIds(openAxisModuleIds, activeIds, moduleTree, displayFlags.showEmptyAxes);
  return layoutAxes(orderVisibleAxes(visible), moduleTree, contentHeight(viewport), spacing, strips);
}

/** REPLACE the open set (all mutation paths funnel through here -- Java's `setOpenAxisModules()` + invalidation), persisting as full paths. */
function setOpenAxisModules(ids: number[]): void {
  openAxisModuleIds = ids;
  crossingsOrderCache = null;
  // Persist only when the module tree is available: `moduleIdsToPaths(ids, null)` maps
  // EVERY id to nothing, so persisting here without a tree would silently overwrite a
  // real remembered open set with [] -- which restore then honored as "intentionally
  // empty", bricking the chart to zero axes on every future open (seen in the wild when
  // early sessions ran with a dead worker and no tree ever loaded).
  if (moduleTree !== null) {
    state = { ...state, openAxisModulePaths: moduleIdsToPaths(ids, moduleTree) };
    persistState();
  }
  scheduleRender();
}

/** Serializes the runtime axis-vector-attachment map to persisted state, keyed by module full path (see `PersistedChartState.axisVectorAttachments`). No-op without a tree (can't resolve paths). */
function syncVectorAttachmentsToState(): void {
  if (moduleTree === null) return;
  const entries: NonNullable<PersistedChartState['axisVectorAttachments']> = [];
  for (const [moduleId, att] of axisVectorAttachments) {
    const modulePath = findModuleFullPath(moduleId, moduleTree);
    if (modulePath !== null) entries.push({ modulePath, fileUri: att.fileUri, vector: att.vector });
  }
  state = { ...state, axisVectorAttachments: entries };
  persistState();
}

/** Guards `maybeAutoAttachVectors()` so `@defaultStatistic` auto-attach is attempted once per session (not re-run on every tree reload, which would re-attach vectors the user detached). */
let autoAttachAttempted = false;

/**
 * `@defaultStatistic` auto-attach (Eclipse `calculateModuleIdToAxisRendererMap`): once, on
 * first tree load, hand the host every visible axis that has a NED type and neither a live
 * nor a persisted attachment; the host checks each type's `@defaultStatistic` and attaches a
 * matching sibling-`.vec` vector. Best-effort -- most axes have no `@defaultStatistic` and
 * are simply skipped host-side.
 */
function maybeAutoAttachVectors(): void {
  if (autoAttachAttempted || moduleTree === null) return;
  autoAttachAttempted = true;
  const persistedPaths = new Set((state.axisVectorAttachments ?? []).map((a) => a.modulePath));
  const candidates: { moduleId: number; moduleFullPath: string; nedTypeName: string }[] = [];
  for (const axis of currentAxesLayout().axes) {
    if (axisVectorAttachments.has(axis.moduleId)) continue;
    const node = findModuleNode(axis.moduleId, moduleTree);
    const path = findModuleFullPath(axis.moduleId, moduleTree);
    if (!node || !node.nedTypeName || path === null || persistedPaths.has(path)) continue;
    candidates.push({ moduleId: axis.moduleId, moduleFullPath: path, nedTypeName: node.nedTypeName });
  }
  if (candidates.length > 0) vscode.postMessage({ type: 'autoAttachAxisVectors', candidates });
}

/**
 * After the module tree loads, ask the host to re-attach any persisted vectors (resolving
 * module path → id against the CURRENT tree; the host re-reads each `.vec`). Posts for every
 * resolvable persisted entry (not gated on the current map) so an `overwritten` reload -- in
 * which the worker dropped its attachments on close -- restores them too; the host re-attach
 * is idempotent and tree (re)loads are infrequent.
 */
function reattachPersistedVectors(): void {
  if (moduleTree === null || !state.axisVectorAttachments) return;
  for (const att of state.axisVectorAttachments) {
    const moduleId = findModuleIdByFullPath(att.modulePath, moduleTree);
    if (moduleId !== null) vscode.postMessage({ type: 'reattachAxisVector', moduleId, fileUri: att.fileUri, vector: att.vector });
  }
}

/** Resolves the persisted open set (or applies Java's default, `openModuleRecursively(root)`) once the module tree is available. Also re-run after an `overwritten` change re-fetches the tree (paths re-resolve against the NEW tree; ids would not). */
function initializeOpenAxisModules(): void {
  if (moduleTree === null) return;
  // Re-attach persisted axis vectors now the tree (and thus module paths) resolve; also
  // covers an `overwritten` reload, where the worker dropped its attachments on close.
  reattachPersistedVectors();
  const persisted = state.openAxisModulePaths;
  if (persisted === undefined) {
    openAxisModuleIds = defaultOpenAxisModules(moduleTree);
    return;
  }
  const resolved = pathsToModuleIds(persisted, moduleTree);
  // An empty RESOLVED set always falls back to the default open set, whether the
  // persisted paths no longer resolve (file replaced by a run with a different module
  // structure) or the persisted set itself was empty. The latter deliberately does NOT
  // round-trip the Empty preset across a reopen anymore: a chart that comes up
  // permanently axis-less looks exactly like a rendering bug (and past versions could
  // write a poisoned [] when the module tree never loaded), so "reopen shows the
  // default axes" is the safer restore semantics. Within a session the Empty preset
  // behaves unchanged.
  openAxisModuleIds = resolved.length === 0 ? defaultOpenAxisModules(moduleTree) : resolved;
}

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
  const versioned = withVersion(state, CHART_STATE_VERSION);
  vscode.setState(versioned);
  vscode.postMessage({ type: 'stateChanged', state: versioned });
}

/** Phase U5 -- flips one Show/Hide toggle (Show/Hide submenu item, or the Tab key for `showTimeDifferences`), persists, and re-renders. */
function setDisplayFlags(next: ChartDisplayFlags): void {
  // Toggling "Method Call Arrows" also flips the engine's `separateEventLogEntries` (Java
  // ties them in `setShowComponentMethodCalls()`), which changes every event's timeline
  // WIDTH -- so it needs an engine round trip, not just a client repaint.
  const separateChanged = next.showComponentMethodCalls !== displayFlags.showComponentMethodCalls;
  // `navigableBeginTc` (the Home key/button's target) depends on showInitializationEvent --
  // keep it fresh so a Home press right after toggling doesn't use a stale target.
  const initToggled = next.showInitializationEvent !== displayFlags.showInitializationEvent;
  displayFlags = next;
  state = { ...state, displayFlags };
  persistState();
  if (separateChanged) void resyncSeparateEntries();
  if (initToggled) void refreshEndpointsTc();
  scheduleRender();
}

/**
 * Re-applies the current timeline mode with the current `showComponentMethodCalls` as the
 * engine's `separateEventLogEntries`, then invalidates the render cache so events refetch
 * with their new widths. Keeps the SAME origin (so the view neither jumps nor rescales --
 * only the pill/dot shape of each mark changes); best-effort like the other engine round
 * trips here.
 */
async function resyncSeparateEntries(): Promise<void> {
  if (!summary || summary.isEmpty) return;
  try {
    const scState = await rpc.request<ScState>(ElogMethods.scSetTimelineMode, { timelineMode: currentTimelineMode, separateEventLogEntries: displayFlags.showComponentMethodCalls });
    coordinateSystemOriginEventNumber = scState.originEventNumber ?? coordinateSystemOriginEventNumber;
    renderModelCache.bumpGeneration();
    renderModelCache.invalidateAll();
    lastModel = null;
    viewport = { ...viewport, coordinateSystemVersion: scState.coordinateSystemVersion };
    scheduleRender();
  } catch {
    // ignore -- a failed re-sync just leaves the previous (correct-for-old-flag) widths
  }
}

const TIMELINE_MODE_OPTIONS = [
  { value: TimelineMode.SIMULATION_TIME, label: 'Simulation Time' },
  { value: TimelineMode.EVENT_NUMBER, label: 'Event Number' },
  { value: TimelineMode.STEP, label: 'Step' },
  { value: TimelineMode.NONLINEAR, label: 'Nonlinear' },
];

/**
 * Phase U9 -- "Refresh" action for the shared notification overlay (port plan: "Refresh
 * = full re-init"): forces an immediate file-change check (picks up a real change, if
 * that's what actually happened) AND unconditionally invalidates/re-fetches the render
 * model cache (retries whatever failed, even when the file itself hadn't changed --
 * e.g. a transient engine error) -- `elog/checkChanges`'s own `elog/refreshed`
 * broadcast (handled below in the message pump) additionally refreshes `summary`/the
 * module tree if THAT changed too.
 */
function refreshFromOverlay(): void {
  refresh();
  renderModelCache.invalidateAll();
  scheduleRender();
}

const engineSource: EngineViewportSource = {
  getViewport: (params: ViewportParams) => rpc.requestCancelable<ViewportModel>(ElogMethods.scGetViewport, params),
};
const renderModelCache = new RenderModelCache(engineSource, {
  // Phase U9: a genuine (non-cancel) viewport-fetch failure surfaces via the shared
  // overlay instead of leaving the chart silently stuck on stale data -- see
  // `renderModelCache.ts`'s `RenderModelCacheOptions.onError` doc comment for why
  // cancellations (routine during pan/zoom churn) never reach here.
  onError: (err) => notificationOverlay.show(classifyEngineError(err)!),
});

document.getElementById('root')!.innerHTML = `
  <div id="toolbar"></div>
  <div class="elog-body" id="body">
    <div id="chartCanvasContainer" class="elog-chart-canvas-container" role="application" aria-label="Sequence Chart"></div>
    <div class="elog-empty" id="empty">Open a Sequence Chart to see events here.</div>
    <div id="filterPanelHost"></div>
    <div id="notificationHost"></div>
  </div>
  <div id="hscroll"></div>
`;

const canvasContainer = document.getElementById('chartCanvasContainer')!;
const canvasStack: CanvasStackHandle = createCanvasStack(canvasContainer);
// Phase U11 -- the Ctrl-drag rubber-band marquee, a DOM overlay (styled via CSSOM, since
// the webview CSP blocks inline style attributes) so it follows the mouse without a
// per-move canvas rebuild. Positioned relative to the (absolute) canvas container, whose
// top-left is the content-area canvas origin the rect coordinates use.
const marqueeEl = document.createElement('div');
marqueeEl.style.position = 'absolute';
marqueeEl.style.border = '1px dashed var(--vscode-focusBorder, #007fd4)';
marqueeEl.style.background = 'var(--vscode-focusBorder, #007fd4)';
marqueeEl.style.opacity = '0.18';
marqueeEl.style.pointerEvents = 'none';
marqueeEl.style.display = 'none';
marqueeEl.style.zIndex = '5';
canvasContainer.appendChild(marqueeEl);
notificationOverlay = mountNotificationOverlay(document.getElementById('notificationHost')!, refreshFromOverlay);

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
  // Phase U10 -- `scheduleRender()` is (by inspection) the one call every viewport-
  // mutating code path in this file already makes right after touching `viewport`
  // (drag/wheel/keyboard pan-zoom via interactions.ts's `onChanged`, goto/reveal/
  // filter-reanchor's `relocateAndCenter`, double-click zoom-to-fit, the toolbar zoom
  // buttons, the h-scrollbar drag, ...) -- piggybacking the viewport-persist debounce
  // here (rather than threading a second call through every one of those sites)
  // guarantees no mutation is ever missed, at the cost of also re-arming the timer on
  // purely-cosmetic renders (selection clicks, theme flips) that don't actually move
  // the viewport; `persistViewportNow()` below no-ops a write when the resolved
  // viewport is unchanged from what's already persisted, so that slop costs an idle
  // RPC round trip at most, never a spurious `workspaceState` write.
  noteViewportActivity();
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(() => {
    rafScheduled = false;
    renderFrame();
  });
}

// ---------------------------------------------------------------------------------
// Phase U10 -- viewport persistence (origin event + zoom + vertical scroll)
// ---------------------------------------------------------------------------------

/** Debounce window: only persist once pan/zoom/vscroll activity has SETTLED (port plan: "do NOT persist mid-gesture") -- a drag/wheel gesture keeps calling `scheduleRender()` continuously, which keeps pushing this timer back out, so the actual write only fires this long after the LAST mutation. */
const VIEWPORT_PERSIST_DEBOUNCE_MS = 400;
let viewportPersistTimer: ReturnType<typeof setTimeout> | undefined;

function noteViewportActivity(): void {
  clearTimeout(viewportPersistTimer);
  viewportPersistTimer = setTimeout(() => void persistViewportNow(), VIEWPORT_PERSIST_DEBOUNCE_MS);
}

/**
 * Resolves the event number nearest the viewport's current horizontal center (the same
 * `elog/sc/mapCoords` `tcToEventNumber` kind `applyTimelineMode()` already uses for its
 * own re-anchor) and persists `{originEventNumber, pixelsPerTc, vscroll}` -- best-effort,
 * matching every other engine round trip in this file: a busy/superseded mapping request
 * just skips this persist cycle, the next settle retries. No-op before a file is open, or
 * if the resolved position is identical to what's already persisted (avoids a redundant
 * `workspaceState`/`vscode.setState` write on every idle re-render).
 */
async function persistViewportNow(): Promise<void> {
  if (!summary || summary.isEmpty) return;
  const centerTc = viewport.leftTc + contentWidth(viewport) / 2 / viewport.pixelsPerTc;
  let originEventNumber: number;
  try {
    const mapped = await rpc.request<MapCoordsResult>(ElogMethods.scMapCoords, { kind: 'tcToEventNumber', tc: centerTc });
    if (mapped.eventNumber === null) return; // no event at/near this tc (e.g. an empty visible range) -- nothing meaningful to remember
    originEventNumber = mapped.eventNumber;
  } catch {
    return;
  }
  const next = { originEventNumber, pixelsPerTc: viewport.pixelsPerTc, vscroll: viewport.vscroll };
  const prev = state.viewport;
  if (prev && prev.originEventNumber === next.originEventNumber && prev.pixelsPerTc === next.pixelsPerTc && prev.vscroll === next.vscroll) return;
  state = { ...state, viewport: next };
  persistState();
}

function applyModel(model: ViewportModel): void {
  lastModel = model;
  for (const id of model.moduleIds) knownModuleIds.add(id);
  sampleTable = buildSampleTable(model.events);
}

function simTimeAt(tc: number): number | null {
  return tcToSimTimeApprox(tc, sampleTable);
}

/**
 * The live "time under the cursor" label for the hairline. Precision adapts to the current
 * zoom (`formatMouseTime`): we measure how much simulation time ONE pixel spans right here
 * (`simTimeAt` at the cursor vs one pixel over) and show just enough digits that a
 * one-pixel move changes the value -- no more. Capped by the Time Accuracy setting.
 */
/**
 * "Zoom to Value" (Eclipse `zoomToAxisValue`): zoom the viewport to the time span of the
 * vector-strip sample under the cursor (the last hovered content-x), with 10% margins.
 */
function zoomToAxisVectorValue(moduleId: number): void {
  const strip = lastModel?.axisVectorStrips?.find((s) => s.moduleId === moduleId);
  if (!strip || strip.segments.length === 0 || mouseContentX === null) return;
  const tc = fullCanvasPxToTc(mouseContentX, viewport);
  if (tc === null) return;
  const seg = strip.segments.find((s) => tc >= s.tcBegin && tc < s.tcEnd) ?? [...strip.segments].reverse().find((s) => tc >= s.tcBegin) ?? strip.segments[0];
  const end = seg.tcEnd > seg.tcBegin ? seg.tcEnd : seg.tcBegin + 1 / viewport.pixelsPerTc;
  viewport = zoomToFit(viewport, seg.tcBegin, end, 0.1);
  scheduleRender();
}

function mouseTickLabel(px: number): string {
  const sim = simTimeAt(fullCanvasPxToTc(px, viewport) ?? viewport.leftTc) ?? 0;
  const simNext = simTimeAt(fullCanvasPxToTc(px + 1, viewport) ?? viewport.leftTc) ?? sim;
  // Relative to the shared tick prefix (Java `drawTick` subtracts `tickPrefix` and prepends
  // "+"), so the hairline reads "+340ms" against the "+ 1s" corner box instead of "1s 340ms".
  const spp = Math.abs(simNext - sim);
  return currentTickPrefix !== 0 ? '+' + formatMouseTime(sim - currentTickPrefix, spp, timeAccuracy) : formatMouseTime(sim, spp, timeAccuracy);
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

  const axesLayout: AxesLayout = currentAxesLayout();
  const lastSimTime = summary.lastSimulationTime !== null ? Number(summary.lastSimulationTime) : 0;
  const tickResult = calculateTicks(currentTimelineMode, viewport.leftTc, range.rightTc, viewport.pixelsPerTc, lastSimTime, simTimeAt);
  currentTickPrefix = tickResult.tickPrefix;
  const axisHeaderRoot = displayFlags.showAxisHeaders
    ? calculateAxisHeaders(
        axesLayout.axes.map((a) => a.moduleId),
        (moduleId) => findModuleFullPath(moduleId, moduleTree) ?? findModuleNode(moduleId, moduleTree)?.fullName ?? `Module #${moduleId}`,
      )
    : null;

  // Phase U8 -- glyph visibility + closed-submodule->axis attribution, only once the
  // open-module model is live (no tree = nothing to expand/collapse/remap).
  const axisManagementLive = moduleTree !== null && openAxisModuleIds !== null;
  const moduleIdToAxisModuleId = axisManagementLive ? moduleIdToAxisModuleIdMap(axesLayout.axes.map((a) => a.moduleId), moduleTree, knownModuleIds) : undefined;
  const treeNodeMap = axisManagementLive ? buildNodeMap(moduleTree) : undefined;
  const axisGlyphs = axisManagementLive ? new Map(axesLayout.axes.map((a) => [a.moduleId, moduleGlyphInfo(a.moduleId, openAxisModuleIds!, moduleTree, treeNodeMap)])) : undefined;
  const headerGlyphs = axisManagementLive ? buildHeaderGlyphs(axisHeaderRoot, treeNodeMap) : undefined;

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
    axisVectorStrips: lastModel?.axisVectorStrips,
    selectedEventNumbers: selection.events,
    selectedDependencyKeys: selection.dependencies,
    selectedAxisModuleIds: selection.axes,
    selectedMethodCallKeys: selection.methodCalls,
    selectedTimelineCoords: [...selection.timelineCoords].map((tc) => ({ tc, simulationTime: String(simTimeAt(tc) ?? 0) })),
    hovered,
    mouseTick: mouseContentX !== null ? { x: mouseContentX, label: mouseTickLabel(mouseContentX) } : undefined,
    tickPrefixLabel: currentTickPrefix !== 0 ? '+ ' + formatTickTime(currentTickPrefix) : undefined,
    bookmarkedEventNumbers,
    bookmarkedModuleIds,
    bookmarkedDependencyKeys,
    displayFlags,
    axisHeaderRoot,
    infoPanelText: computeInfoPanelText(),
    skipLabelsForPerf: !antialiasEnabled,
    moduleIdToAxisModuleId,
    axisGlyphs,
    headerGlyphs,
  });
  lastPrimitives = primitives;
  canvasStack.render(primitives, antialiasEnabled, currentChartFontSizePx());
  const elapsedMs = performance.now() - t0;
  // Antialias auto-toggle hysteresis -- port of SequenceChart.java's drawWithAntialias
  // state machine (see canvasStack.ts's ANTIALIAS_* constants + CanvasStackHandle.render()'s doc).
  if (antialiasEnabled && elapsedMs > ANTIALIAS_TURN_OFF_AT_MSEC) antialiasEnabled = false;
  else if (!antialiasEnabled && elapsedMs < ANTIALIAS_TURN_ON_AT_MSEC) antialiasEnabled = true;
  renderStatus();
  updateHScrollbar();
}

/** Phase U8 -- resolves each drawable axis header's `fullPath` back to a real module and computes its glyph visibility (`layoutAxisHeader()`'s conditions); headers whose merged path resolves to no module (or the synthetic empty-label root) get no glyphs. */
function buildHeaderGlyphs(axisHeaderRoot: AxisHeaderNode | null, nodeMap?: Map<number, ElogModule>): Map<string, { moduleId: number; expand: boolean; collapse: boolean }> {
  const result = new Map<string, { moduleId: number; expand: boolean; collapse: boolean }>();
  if (axisHeaderRoot === null || moduleTree === null || openAxisModuleIds === null) return result;
  for (const header of flattenDrawableAxisHeaders(axisHeaderRoot)) {
    if (header.fullPath === '') continue;
    const moduleId = header.moduleId ?? findModuleIdByFullPath(header.fullPath, moduleTree);
    if (moduleId === null) continue;
    const info = moduleGlyphInfo(moduleId, openAxisModuleIds, moduleTree, nodeMap);
    result.set(header.fullPath, { moduleId, expand: info.expand, collapse: info.collapse });
  }
  return result;
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
  // Position/Range times use unit formatting (Java: `TimeUtils.secondsToTimeString`).
  const positionAndRange: [string, string] = [`Position: #${startEventNumber}, ${leftSim !== null ? formatTickTime(leftSim) : '?'}`, `Range: #${endEventNumber - startEventNumber + 1}, ${leftSim !== null && rightSim !== null ? formatTickTime(rightSim - leftSim) : '?'}`];
  const eventLogInfo: [string, string] = [
    // Java `drawEventLogInfo()` line 1 verbatim (raw simulation time + " seconds").
    `File: ${summary.fileSize} bytes, ~${summary.approximateNumberOfEvents} events (#${summary.firstEventNumber} .. #${summary.lastEventNumber}), ${summary.lastSimulationTime ?? '0'} seconds`,
    // Java's line 2 ("Read: N modules, N events, N lines, N bytes") reads live parse
    // counters (`getNumParsedEvents()`/`FileReader.getNumRead*()`) not yet exposed over
    // the protocol -- documented simplification, shows the coordinate-system version.
    `Coordinate system version: ${summary.coordinateSystemVersion}${summary.filtered ? ' (filtered)' : ''}`,
  ];
  return { positionAndRange, eventLogInfo };
}

/**
 * The chart no longer shows a top status strip (file / event range / simulation time /
 * view) -- that information is available in the ruler, the info-panel overlays, and
 * hovers, and the strip only ate vertical space. Kept as a guarded no-op so its many call
 * sites need no change; it does nothing when the `#status` element is absent.
 */
function renderStatus(): void {
  const statusEl = document.getElementById('status');
  if (!statusEl) return;
  renderSummaryStrip(statusEl, fileName(), summary);
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

/**
 * The event number "Go to Begin"/the toolbar's Home button/the Home key should navigate
 * to: the log's first event, EXCEPT when that's the initialization event (#0, essentially
 * always the case for a real simulation log) AND it's currently hidden
 * (`showInitializationEvent` off, the default). Panning/centering on a hidden event's
 * position leaves a long stretch of empty, all-"0s" viewport before the first VISIBLE
 * event -- which then lands crammed near the far edge instead of at the start, matching
 * the report ("initial position [has] quite a long [stretch] of empty space on the
 * left... first event is almost at the right side edge"). OMNeT++ event numbers are
 * contiguous, so "the event right after #0" is always exactly 1 -- no round trip needed to
 * find it. Falls back to the true first event when the log has only that one event
 * (nothing else to navigate to).
 */
function firstNavigableEventNumber(): number {
  if (!summary) return 0;
  const first = summary.firstEventNumber;
  if (first === 0 && !displayFlags.showInitializationEvent && summary.lastEventNumber > 0) return 1;
  return first;
}

async function refreshEndpointsTc(): Promise<void> {
  if (!summary || summary.isEmpty) {
    beginTc = endTc = navigableBeginTc = null;
    return;
  }
  const navEventNumber = firstNavigableEventNumber();
  try {
    const [b, e, nb] = await Promise.all([
      rpc.request<MapCoordsResult>(ElogMethods.scMapCoords, { kind: 'eventToTc', eventNumber: summary.firstEventNumber }),
      rpc.request<MapCoordsResult>(ElogMethods.scMapCoords, { kind: 'eventToTc', eventNumber: summary.lastEventNumber }),
      navEventNumber === summary.firstEventNumber ? Promise.resolve(null) : rpc.request<MapCoordsResult>(ElogMethods.scMapCoords, { kind: 'eventToTc', eventNumber: navEventNumber }),
    ]);
    beginTc = b.tc;
    endTc = e.tc;
    navigableBeginTc = nb ? nb.tc : beginTc;
  } catch {
    beginTc = endTc = navigableBeginTc = null;
  }
}

/**
 * "Go to End" -- both the toolbar's End button and the context menu's "Go to End" item
 * call this (a single shared implementation, so the two can never drift the way they
 * used to: the toolbar round-tripped through the host's `revealRequest`/`reveal`
 * relocate-and-center flow while the context menu only panned the viewport, and only
 * the former actually selected anything). Matches Java's `SequenceChart.gotoEnd()`:
 * select the last event AND scroll to it.
 */
async function goToEnd(): Promise<void> {
  if (!summary || summary.isEmpty) return;
  await refreshEndpointsTc();
  if (endTc === null) return;
  selection = focusEvent(summary.lastEventNumber);
  broadcastSelection();
  viewport = { ...gotoEndAt(viewport, endTc), followEnd: true };
  scheduleRender();
}

/** "Go to Begin" -- see `goToEnd()`'s doc comment; selects `firstNavigableEventNumber()` (the log's first event, or the one right after a hidden #0) and scrolls to it. */
async function goToBegin(): Promise<void> {
  if (!summary || summary.isEmpty) return;
  await refreshEndpointsTc();
  if (navigableBeginTc === null) return;
  selection = focusEvent(firstNavigableEventNumber());
  broadcastSelection();
  viewport = gotoBeginAt(viewport, navigableBeginTc);
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
  coordinateSystemOriginEventNumber = scState.originEventNumber ?? eventNumber;
  renderModelCache.bumpGeneration();
  renderModelCache.invalidateAll();
  lastModel = null;
  viewport = { ...viewport, coordinateSystemVersion: scState.coordinateSystemVersion };
  viewport = center ? revealAt(viewport, 0) : gotoBeginAt(viewport, 0);
}

/**
 * Port of Java's `setDefaultPixelPerTimelineUnit()` (SequenceChart.java:2997-3033): pick a
 * horizontal zoom so the origin event plus up to ~10 following events fill the content
 * width, instead of the fixed `DEFAULT_PIXELS_PER_TC` -- which collapses a whole
 * small-tc-range log (e.g. simulation-time mode over a sub-millisecond run) onto a single
 * pixel column that renders as one vertical line, and conversely spreads a huge-range log
 * far too thin. Measures the tc span from an actual small viewport fetch (so it reflects
 * the current `separateEventLogEntries`/mode), clamped to the scale limits; falls back to
 * `DEFAULT_PIXELS_PER_TC` when the span is degenerate (all sampled events share one tc) or
 * the round trip fails.
 */
async function computeDefaultPixelsPerTc(): Promise<number> {
  if (!summary || summary.isEmpty) return DEFAULT_PIXELS_PER_TC;
  const cw = contentWidth(viewport);
  if (cw <= 0) return DEFAULT_PIXELS_PER_TC;
  const startEventNumber = coordinateSystemOriginEventNumber;
  const endEventNumber = Math.min(summary.lastEventNumber, startEventNumber + 10);
  try {
    const vp = await rpc.request<ViewportModel>(ElogMethods.scGetViewport, {
      range: { kind: 'event', startEventNumber, endEventNumber },
      includeDependencies: false,
      includeMethodCalls: false,
    });
    if (vp.events.length < 2) return DEFAULT_PIXELS_PER_TC;
    let minTc = Infinity;
    let maxTc = -Infinity;
    for (const e of vp.events) {
      if (e.tcBegin < minTc) minTc = e.tcBegin;
      if (e.tcEnd > maxTc) maxTc = e.tcEnd;
    }
    const delta = maxTc - minTc;
    if (!(delta > 0)) return DEFAULT_PIXELS_PER_TC;
    return Math.min(MAX_PIXELS_PER_TC, Math.max(MIN_PIXELS_PER_TC, cw / delta));
  } catch {
    return DEFAULT_PIXELS_PER_TC;
  }
}

/**
 * Applies `computeDefaultPixelsPerTc()` to the live viewport, then repaints. `reAnchor`
 * re-centers the origin (tc=0) under the viewport center -- used after a live timeline-mode
 * switch, whose `relocateAndCenter()` centered the origin at the OLD scale so it must be
 * re-centered at the new one. Without it, the current left edge is kept and only the scale
 * changes (the toolbar/context-menu "Default Zoom", and the initial open where the origin
 * already sits at the left edge) -- matching Java's `defaultZoom()`, which rescales in
 * place rather than jumping the view.
 */
async function applyDefaultZoom(reAnchor: boolean): Promise<void> {
  const px = await computeDefaultPixelsPerTc();
  viewport = { ...viewport, pixelsPerTc: px };
  if (reAnchor) viewport = revealAt(viewport, 0);
  scheduleRender();
}

/**
 * Phase U10 -- a persisted viewport (GAP 1) to restore instead of the plain "goto begin"
 * `applyTimelineMode()` otherwise applies on its very first (`isInitial`) call. Ignored
 * on any later call (a live mode switch always re-anchors on the CURRENT viewport
 * center, per this function's own long-standing behavior).
 */
interface RestoreViewportHint {
  originEventNumber: number;
  pixelsPerTc: number;
  vscroll: number;
}

async function applyTimelineMode(mode: string, isInitial: boolean, restoreViewport?: RestoreViewportHint): Promise<void> {
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

    // `separateEventLogEntries` follows `showComponentMethodCalls` (Java wires the two
    // together in `setShowComponentMethodCalls()`): it makes the engine give each event a
    // nonzero timeline WIDTH in STEP/NONLINEAR modes (one unit per method-call/send log
    // entry), which is what turns event marks from dots into "pill" shapes -- without it
    // the engine always returns `tcEnd === tcBegin` and every event draws as a dot.
    const params: ScSetTimelineModeParams = { timelineMode: mode as TimelineMode, separateEventLogEntries: displayFlags.showComponentMethodCalls };
    const scState = await rpc.request<ScState>(ElogMethods.scSetTimelineMode, params);
    currentTimelineMode = scState.timelineMode;
    toolbar.setDropdownValue('timelineMode', scState.timelineMode);

    if (summary && !summary.isEmpty) {
      // Phase U10 -- `isInitial` restore priority: a live re-anchor (`anchorEventNumber`)
      // always wins (this isn't the first load at all); otherwise a persisted viewport
      // (GAP 1) restores its remembered origin+zoom+vscroll; only with NEITHER does this
      // fall back to the original "goto begin" default (the 'init' handler's own
      // followEndOnAppend fallback, if any, runs AFTER this resolves -- see its call site).
      const target = anchorEventNumber ?? restoreViewport?.originEventNumber ?? summary.firstEventNumber;
      const center = anchorEventNumber !== null || restoreViewport !== undefined;
      await relocateAndCenter(target, center);
      if (isInitial && restoreViewport && anchorEventNumber === null) {
        viewport = { ...viewport, pixelsPerTc: restoreViewport.pixelsPerTc, vscroll: restoreViewport.vscroll };
      } else {
        // No persisted zoom to honor -> pick a data-driven default so events span the
        // content width instead of collapsing onto one column (Java's
        // `setDefaultPixelPerTimelineUnit()`). Re-anchor only when the origin was centered
        // at the old scale (a live mode switch); the initial open already sits at tc=0.
        await applyDefaultZoom(center);
      }
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
    // Any reveal (goto/find dialogs, cause/consequence/same-module keyboard nav) also
    // selects+focuses the resolved event -- matches Java's goto* methods, which select
    // the destination event too, not just scroll to it. (The toolbar's Home/End buttons
    // no longer go through this path -- see goToBegin()/goToEnd()'s own doc comment.)
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
// Phase U9 -- export/polish: SVG export, copy image to clipboard, release memory
// ---------------------------------------------------------------------------------

/** Resolves `eventNumber`'s tc for the export range dialog's "selected events" choice -- prefers the already-loaded viewport model (`findEvent()`), falling back to an `elog/sc/mapCoords` round trip for an event that isn't currently in view (e.g. selected, then panned away before opening the dialog). `null` if it can't be resolved at all. */
async function tcForEventNumber(eventNumber: number): Promise<number | null> {
  const loaded = findEvent(eventNumber);
  if (loaded) return loaded.tcBegin;
  try {
    const result = await rpc.request<MapCoordsResult>(ElogMethods.scMapCoords, { kind: 'eventToTc', eventNumber });
    return result.tc;
  } catch {
    return null;
  }
}

/** Java's `ExportToSVGDialog`'s "Range of two selected events" choice needs EXACTLY two selected events (`createButton(..., 0).setEnabled(sequenceChart.getSelectedEvents().size() == 2)`) -- `undefined` (unavailable) otherwise, or if either event's tc can't be resolved. */
async function selectedEventsTcRange(): Promise<[number, number] | undefined> {
  if (selection.events.size !== 2) return undefined;
  const [a, b] = [...selection.events];
  const [tcA, tcB] = await Promise.all([tcForEventNumber(a), tcForEventNumber(b)]);
  if (tcA === null || tcB === null) return undefined;
  return tcA <= tcB ? [tcA, tcB] : [tcB, tcA];
}

function suggestedExportBaseName(): string {
  const base = fileName().replace(/\.[^./\\]+$/, '');
  return base.length > 0 ? base : 'sequencechart';
}

/**
 * "Export to SVG..." -- opens the range dialog (`exportDialog.ts`), then builds the
 * export's own throwaway draw list via a FRESH `elog/sc/getViewport` covering exactly
 * the chosen range (NOT the live render cache's margined/prefetch-tuned one -- an
 * export needs everything in range, once, not a panning-optimized window) and posts
 * the result to the host as an `export` message. The host-side save-dialog/write-file
 * flow (`sequenceChartEditor.ts`'s `handleExport()`) already exists since phase U1's
 * forward-looking `uiProtocol.ts` sketch -- unchanged here.
 */
async function doExportSvg(): Promise<void> {
  if (!summary || summary.isEmpty) return;
  const selectedTcs = await selectedEventsTcRange();
  const visible = visibleTcRange(viewport);
  const ctx: ExportRangeContext = {
    visibleLeftTc: visible.leftTc,
    visibleRightTc: visible.rightTc,
    wholeBeginTc: beginTc,
    wholeEndTc: endTc,
    selectedTcs,
    pixelsPerTc: viewport.pixelsPerTc,
    extraSpacePx: 10,
  };
  openExportRangeDialog(ctx, (result) => void performExportSvg(result, ctx));
}

async function performExportSvg(result: ExportDialogResult, ctxBase: ExportRangeContext): Promise<void> {
  if (!summary) return;
  const range = resolveExportRange(result.kind, { ...ctxBase, extraSpacePx: result.extraSpacePx });
  if (!range) return;
  const widthPx = computeExportWidthPx(range, viewport.pixelsPerTc);
  showStatusNote('Exporting to SVG…');
  try {
    const model = await rpc.request<ViewportModel>(ElogMethods.scGetViewport, {
      range: { kind: 'tc', tcBegin: range.tcBegin, tcEnd: range.tcEnd },
      marginTc: 0,
      maxEvents: 100_000,
    });
    const axesLayout = currentAxesLayout();
    const exportViewport: ViewportState = {
      leftTc: range.tcBegin,
      pixelsPerTc: viewport.pixelsPerTc,
      canvasWidth: GUTTER_LEFT_WIDTH + widthPx,
      // `axesLayout.totalHeight` already includes BOTH the top and bottom axis-offset
      // margins (axes.ts's layoutAxes()), so no extra fudge factor is needed here to fit
      // every axis without clipping -- a prior `+ 40` (== 2*AXIS_OFFSET) was compensating
      // for that margin being missing from `totalHeight`; now redundant.
      canvasHeight: GUTTER_TOP_HEIGHT + axesLayout.totalHeight,
      vscroll: 0,
      followEnd: false,
      coordinateSystemVersion: model.coordinateSystemVersion,
    };
    const lastSimTime = summary.lastSimulationTime !== null ? Number(summary.lastSimulationTime) : 0;
    const tickResult = calculateTicks(currentTimelineMode, exportViewport.leftTc, range.tcEnd, exportViewport.pixelsPerTc, lastSimTime, simTimeAt);
    // UNLIKE Java (which disables axis headers for SVG export -- its GraphicsSVG can't
    // rotate text, see svgExport.ts's header), this port's SVG serializer CAN rotate
    // text, so headers stay on when the live chart has them on (a fidelity improvement,
    // not a gap).
    const axisHeaderRoot = displayFlags.showAxisHeaders
      ? calculateAxisHeaders(
          axesLayout.axes.map((a) => a.moduleId),
          (moduleId) => findModuleFullPath(moduleId, moduleTree) ?? findModuleNode(moduleId, moduleTree)?.fullName ?? `Module #${moduleId}`,
        )
      : null;
    const axisManagementLive = moduleTree !== null && openAxisModuleIds !== null;
    const moduleIdToAxisModuleId = axisManagementLive ? moduleIdToAxisModuleIdMap(axesLayout.axes.map((a) => a.moduleId), moduleTree, knownModuleIds) : undefined;
    const primitives = buildDrawList({
      timelineMode: currentTimelineMode,
      viewport: exportViewport,
      events: model.events,
      dependencies: model.dependencies,
      methodCalls: model.methodCalls,
      axesLayout,
      ticks: tickResult.ticks,
      theme: palette,
      axisVectorStrips: model.axisVectorStrips,
      selectedEventNumbers: selection.events,
      bookmarkedEventNumbers,
      bookmarkedModuleIds,
      bookmarkedDependencyKeys,
      displayFlags,
      axisHeaderRoot,
      // No live status/info overlays in a static export -- they're screen-only conveniences.
      infoPanelText: undefined,
      tickPrefixLabel: tickResult.tickPrefix !== 0 ? '+ ' + formatTickTime(tickResult.tickPrefix) : undefined,
      skipLabelsForPerf: false,
      moduleIdToAxisModuleId,
    });
    const fontFamily = getComputedStyle(document.body).fontFamily || 'sans-serif';
    const svg = buildChartSvg({ primitives, widthPx: exportViewport.canvasWidth, heightPx: exportViewport.canvasHeight, backgroundColor: palette.background, fontFamily });
    vscode.postMessage({ type: 'export', format: 'svg', data: svg, suggestedName: `${suggestedExportBaseName()}.svg` });
    showStatusNote(model.truncated ? 'Exported to SVG (truncated: too many events in the chosen range).' : 'Exported to SVG.');
  } catch (err) {
    if (!(err instanceof RequestCancelledError)) showStatusNote(`Export to SVG failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * "Copy Image to Clipboard" -- port of `CachingCanvas.copyImageToClipboard()`:
 * rasterizes exactly the CURRENTLY VISIBLE chart (no range dialog, matching Java) at
 * `devicePixelRatio` for a crisp bitmap, then tries the webview's own async Clipboard
 * API (`navigator.clipboard.write` with a `ClipboardItem`) -- VS Code's OWN
 * `vscode.env.clipboard` host API is text-only (no image counterpart), but a webview's
 * embedding iframe grants `clipboard-write` (verified: no CSP directive here blocks
 * it), so the browser API itself is reachable from webview script. If it throws for
 * any reason (an older VS Code build without the permission, a user-gesture
 * requirement not satisfied, ...), falls back to a file save via the SAME `export`
 * message PNG export would use -- identical fallback shape to the NED preview's own
 * `doExportPng()` (`client/webview/src/main.ts`).
 */
function doCopyImage(): void {
  if (!summary || summary.isEmpty || lastPrimitives.length === 0) return;
  const scale = window.devicePixelRatio || 1;
  const canvas = renderPrimitivesToCanvas(viewport.canvasWidth, viewport.canvasHeight, lastPrimitives, palette.background, scale, currentChartFontSizePx());
  canvas.toBlob((blob) => {
    if (blob) void copyBlobToClipboardOrSave(blob);
  }, 'image/png');
}

async function copyBlobToClipboardOrSave(blob: Blob): Promise<void> {
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.write !== 'function') {
      throw new Error('Clipboard image API unavailable in this webview');
    }
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    showStatusNote('Image copied to clipboard.');
  } catch {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    vscode.postMessage({ type: 'export', format: 'png', data: base64, suggestedName: `${suggestedExportBaseName()}.png` });
    showStatusNote('Clipboard image API unavailable here -- saved as a PNG file instead.');
  }
}

/** "Release Memory" -- see `elogProtocol.ts`'s `ElogMethods.releaseMemory` doc comment. This webview issues the request directly (like `setFilter`), so the session's `elog/memoryReleased` broadcast (handled below in the message pump) reaches every attachment, including this one. */
async function doReleaseMemory(): Promise<void> {
  try {
    const result = await rpc.request<ReleaseMemoryResult>(ElogMethods.releaseMemory, undefined);
    showStatusNote(`Memory released: cached events ${result.eventCacheSizeBefore.toLocaleString()} → ${result.eventCacheSizeAfter.toLocaleString()} (limit ${result.eventCacheLimit.toLocaleString()}).`);
  } catch (err) {
    if (!(err instanceof RequestCancelledError)) showStatusNote(`Release Memory failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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
    } else {
      // Phase U9 (loose end, U2's find was minimal): a miss used to be entirely
      // silent -- surface it as a transient status-strip note so the user knows the
      // search actually ran and simply found nothing, rather than wondering whether
      // Find Next did anything at all.
      showStatusNote(`"${state.search}" not found.`);
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
  const axesLayout = currentAxesLayout();
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

/** Phase U11 -- hover highlight: the top-priority hit group at the pointer becomes the highlighted object set (event/dependency/axis only). Guarded by a signature so an unchanged target never triggers a repaint. */
function updateHover(px: number, py: number): void {
  const group = pickPrimaryGroup(hitTestAt(px, py));
  const events = new Set<number>();
  const dependencyKeys = new Set<string>();
  const axisModuleIds = new Set<number>();
  const methodCallKeys = new Set<string>();
  for (const hit of group) {
    if (hit.kind === 'event') events.add(hit.eventNumber);
    else if (hit.kind === 'dependency') dependencyKeys.add(dependencyKey(hit));
    else if (hit.kind === 'methodCall') methodCallKeys.add(methodCallKey(hit));
    else if (hit.kind === 'axis') axisModuleIds.add(hit.moduleId);
  }
  // Live mouse-time hairline follows the cursor, so a plain move (no target change) must
  // still repaint. Track the content-area x here and repaint if EITHER it or the hover
  // target changed. rAF-coalesced by scheduleRender(), same cost profile as a drag.
  const newMouseX = px >= GUTTER_LEFT_WIDTH && px <= viewport.canvasWidth ? px : null;
  const sig = `e:${[...events].sort((a, b) => a - b).join(',')}|d:${[...dependencyKeys].sort().join(',')}|m:${[...methodCallKeys].sort().join(',')}|a:${[...axisModuleIds].sort((a, b) => a - b).join(',')}`;
  if (sig === hoverSignature && newMouseX === mouseContentX) return;
  hoverSignature = sig;
  hovered = { events, dependencyKeys, axisModuleIds, methodCallKeys };
  mouseContentX = newMouseX;
  scheduleRender();
}

function clearHover(): void {
  if (hoverSignature === '' && mouseContentX === null) return;
  hoverSignature = '';
  hovered = { events: new Set(), dependencyKeys: new Set(), axisModuleIds: new Set(), methodCallKeys: new Set() };
  mouseContentX = null;
  scheduleRender();
}

/**
 * Builds the hover tooltip's HTML the way Java's `SequenceChartLabelProvider.
 * getDescriptiveText()` does: concatenate the descriptive text of EVERY object under the
 * cursor (event + its message lines + any dependency/method-call/axis), in hit-priority
 * order, deduplicated. The "At t = ..." timestamp line is appended ONLY as a suffix when
 * there is already other content (Java's `result.length() != 0` guard) -- on empty
 * background the mouse-time hairline shows the time instead. The event's message-line dump
 * is fetched (one `getEventDetail` round trip) only when a SINGLE event is under the
 * cursor, matching Java.
 */
async function resolveHitForTooltip(px: number, py: number): Promise<string | null> {
  const hits = hitTest({ primitives: lastPrimitives, px, py, pointerTc: fullCanvasPxToTc(px, viewport) });
  if (hits.length === 0) return null;

  // Deduplicate while preserving hit priority (event > dependency > methodCall > axis > timestamp).
  const seen = new Set<string>();
  const ordered: HitObject[] = [];
  for (const kind of ['event', 'dependency', 'methodCall', 'axis', 'timestamp'] as const) {
    for (const h of hits) {
      if (h.kind !== kind) continue;
      const key = h.kind === 'event' ? `e${h.eventNumber}` : h.kind === 'dependency' ? `d${dependencyKey(h)}` : h.kind === 'methodCall' ? `m${methodCallKey(h)}` : h.kind === 'axis' ? `a${h.moduleId}` : h.kind === 'timestamp' ? `t${h.tc}` : '';
      if (!key || seen.has(key)) continue;
      seen.add(key);
      ordered.push(h);
    }
  }

  const eventCount = ordered.filter((h) => h.kind === 'event').length;
  const parts: string[] = [];
  for (const h of ordered) {
    if (h.kind === 'event') {
      const event = findEvent(h.eventNumber);
      if (!event) continue;
      const causeDependency = findCauseDependencyFor(h.eventNumber);
      let detail: EventDetail | null = null;
      if (eventCount === 1) {
        try {
          detail = await rpc.request<EventDetail | null>(ElogMethods.getEventDetail, { eventNumber: h.eventNumber });
        } catch {
          detail = null;
        }
      }
      parts.push(buildEventTooltip(event, labelProviderCtx, { causeDependency, detail }));
    } else if (h.kind === 'dependency') {
      const dependency = findDependency(h);
      if (dependency) parts.push(buildDependencyTooltip(dependency));
    } else if (h.kind === 'methodCall') {
      const call = findMethodCall(h);
      if (call) parts.push(buildMethodCallTooltip(call, labelProviderCtx));
    } else if (h.kind === 'axis') {
      parts.push(buildAxisTooltip(h.moduleId, labelProviderCtx));
    } else if (h.kind === 'timestamp' && parts.length > 0) {
      parts.push(buildTimestampTooltip(simTimeAt(h.tc)));
    }
    // moduleAction glyphs have no tooltip in Java either.
  }
  return parts.length > 0 ? parts.join('<br/>') : null;
}

function handleClick(hits: HitObject[], ctrl: boolean): void {
  // Phase U8 -- ModuleAction glyphs take the whole click (Java mouseUp's FIRST cascade
  // level), but only for a PLAIN click: MOD1+click takes the selection-toggle path and
  // ignores glyphs entirely (SequenceChart.java:6023, verified).
  if (!ctrl) {
    const action = hits.find((h): h is Extract<HitObject, { kind: 'moduleAction' }> => h.kind === 'moduleAction');
    if (action) {
      performModuleAction(action);
      return;
    }
  }
  const group = pickPrimaryGroup(hits);
  selection = applyClick(selection, group, ctrl);
  broadcastSelection();
  scheduleRender();
}

/** Phase U8 -- glyph dispatch, port of `mouseUp`'s ModuleAction branch (`SequenceChart.java:6054-6075`): expand appends direct submodules; collapse prunes the subtree; close on an AXIS removes one module, close on a HEADER removes the whole subtree (`visitItems`). */
function performModuleAction(action: Extract<HitObject, { kind: 'moduleAction' }>): void {
  if (openAxisModuleIds === null || moduleTree === null) return;
  switch (action.action) {
    case 'expand':
      setOpenAxisModules(expandOpenAxisModule(openAxisModuleIds, action.moduleId, moduleTree));
      break;
    case 'collapse':
      setOpenAxisModules(collapseOpenAxisModule(openAxisModuleIds, action.moduleId, moduleTree));
      break;
    case 'close':
      setOpenAxisModules(action.scope === 'header' ? removeOpenAxisModuleSubtree(openAxisModuleIds, action.moduleId, moduleTree) : removeOpenAxisModule(openAxisModuleIds, action.moduleId));
      break;
  }
}

/** Double-click: zoom-to-message (fit a dependency's cause/consequence span), or open-module on an axis (phase U8, port of `mouseDoubleClick` `SequenceChart.java:5954-5986`: plain = `openModule` one level, Ctrl/Cmd = `openModuleRecursively` -- both whole-set REPLACEs). */
function handleDoubleClick(hits: HitObject[], ctrl: boolean): void {
  const target = pickDoubleClickTarget(hits);
  if (!target) return;
  if (target.kind === 'dependency') {
    viewport = zoomToFit(viewport, Math.min(target.causeTc, target.consequenceTc), Math.max(target.causeTc, target.consequenceTc));
    scheduleRender();
  } else if (target.kind === 'axis' && moduleTree !== null && openAxisModuleIds !== null) {
    setOpenAxisModules(ctrl ? openModuleRecursively(target.moduleId, moduleTree) : openModule(target.moduleId, moduleTree));
  }
}

// ---------------------------------------------------------------------------------
// Phase U8 -- axis-management actions: dialogs, presets, ordering mode, spacing
// ---------------------------------------------------------------------------------

/** "Select Modules…" -- see `selectModulesDialog.ts` (port of the contributor's inline TitleAreaDialog; OK = whole-set replace). */
function showSelectModulesDialog(): void {
  if (moduleTree === null || openAxisModuleIds === null) return;
  openSelectModulesDialog(moduleTree, openAxisModuleIds, (ids) => setOpenAxisModules(ids));
}

/**
 * "Manual..." ordering -- opens the reorder dialog over the CURRENT visible axes;
 * OK splices the new order into the persistent total order (`updateManualOrder()`),
 * commits mode `'manual'`, and persists. Cancel = nothing changes (the contributor's
 * `Window.CANCEL` branch), including the ordering mode.
 */
function showManualOrderingDialog(): void {
  if (moduleTree === null || openAxisModuleIds === null) return;
  const visible = computeVisibleAxisModuleIds(openAxisModuleIds, knownModuleIds, moduleTree, displayFlags.showEmptyAxes);
  if (visible.length === 0) return;
  const paths = visible.map(fullPathOf);
  manualOrderPaths = ensureInManualOrder(manualOrderPaths, paths);
  const current = currentManualOrder(manualOrderPaths, paths);
  const idByPath = new Map(visible.map((id) => [fullPathOf(id), id]));
  const items = current.map((path) => ({ id: idByPath.get(path)!, label: `${path} (id = ${idByPath.get(path)})` }));
  openListReorderDialog('Manual Axis Ordering', 'Reorder chart axes:', items, (orderedIds) => {
    const updatedCurrent = orderedIds.map((id) => fullPathOf(id));
    manualOrderPaths = updateManualOrder(manualOrderPaths, current, updatedCurrent);
    commitAxisOrderingMode('manual');
  });
}

function commitAxisOrderingMode(mode: AxisOrderingMode): void {
  axisOrderingMode = mode;
  crossingsOrderCache = null;
  state = { ...state, axisOrderingMode: mode, manualAxisOrderPaths: manualOrderPaths };
  persistState();
  toolbar.setDropdownValue('axisOrdering', mode);
  scheduleRender();
}

/** Ordering-mode selection (menu radio or toolbar dropdown). `'manual'` routes through the dialog and only commits on OK (see `showManualOrderingDialog()`); the toolbar dropdown is reset to the current mode first so a cancel leaves it truthful. */
function selectAxisOrderingMode(mode: AxisOrderingMode): void {
  if (mode === 'manual') {
    toolbar.setDropdownValue('axisOrdering', axisOrderingMode);
    showManualOrderingDialog();
    return;
  }
  commitAxisOrderingMode(mode);
}

function setAxisSpacingState(mode: 'auto' | 'manual', manualSpacing?: number): void {
  axisSpacingMode = mode;
  if (manualSpacing !== undefined) axisSpacingManual = clampAxisSpacing(manualSpacing);
  state = { ...state, axisSpacingMode, axisSpacing: axisSpacingManual };
  persistState();
  scheduleRender();
}

/** Spacing actions -- `SequenceChartContributor.java:1657-1748`: Balanced = AUTO; Dense = MANUAL at `fontHeight + 1`; Increase/Decrease = MANUAL at current effective spacing ±5 (Java reads `getAxisSpacing()`, the last COMPUTED value, so ±5 from an AUTO layout works too). */
const spacingActions = {
  balanced: () => setAxisSpacingState('auto'),
  dense: () => setAxisSpacingState('manual', DENSE_AXIS_SPACING),
  increase: () => setAxisSpacingState('manual', currentAxesLayout().spacing + 5),
  decrease: () => setAxisSpacingState('manual', currentAxesLayout().spacing - 5),
};

// ---- NED type-property lookup (webview -> host -> language server) ----------------

let nedQuerySeq = 1;
const pendingNedQueries = new Map<number, (properties: Record<string, string[] | null>) => void>();

/** One `nedTypeQuery` round trip (see `uiProtocol.ts`); resolves `{}` after a 15s timeout so a preset never hangs on a missing language server. */
function queryNedTypeProperties(typeNames: string[]): Promise<Record<string, string[] | null>> {
  return new Promise((resolve) => {
    const id = nedQuerySeq++;
    const timer = setTimeout(() => {
      if (pendingNedQueries.delete(id)) resolve({});
    }, 15000);
    pendingNedQueries.set(id, (properties) => {
      clearTimeout(timer);
      resolve(properties);
    });
    vscode.postMessage({ type: 'nedTypeQuery', id, typeNames });
  });
}

/**
 * Port of `SequenceChartContributor.collectAxisModules(property)`: every module whose
 * NED type carries ANY of `properties` (matched items only, not their subtrees).
 * Returns `null` when NO queried type resolved at all (no NED index/installDir/open
 * workspace with the types) -- callers degrade; a resolved-but-empty match returns [].
 */
async function collectAxisModulesByNedProperty(properties: string[]): Promise<number[] | null> {
  if (moduleTree === null) return null;
  const typeNames = new Set<string>();
  const stack: ElogModule[] = [moduleTree];
  const modules: ElogModule[] = [];
  while (stack.length > 0) {
    const node = stack.pop()!;
    modules.push(node);
    if (node.nedTypeName) typeNames.add(node.nedTypeName);
    stack.push(...node.children);
  }
  const resolved = await queryNedTypeProperties([...typeNames].sort());
  const anyResolved = Object.values(resolved).some((props) => props !== null);
  if (!anyResolved) return null;
  const matching = new Set(Object.entries(resolved).filter(([, props]) => props !== null && properties.some((p) => props.includes(p))).map(([name]) => name));
  return modules.filter((m) => matching.has(m.nedTypeName)).map((m) => m.moduleId);
}

/**
 * Preset Configuration dispatch -- port of `SequenceChartContributor.java:380-427`
 * (see `chartContextMenu.ts`'s `presetSection()` for names/order and
 * `displayFlags.ts` for the three flag profiles). DEGRADATION (documented): Network
 * Node / Network Interface need NED `@networkNode`/`@networkInterface`/
 * `@wireJunction` property lookups through the language server; when nothing
 * resolves (no NED index) or nothing matches, this falls back to Full Detail and
 * says so in the status strip rather than silently emptying the chart.
 */
async function applyPresetConfiguration(preset: PresetConfiguration): Promise<void> {
  if (moduleTree === null || openAxisModuleIds === null) return;
  switch (preset) {
    case 'fullDetail':
      setOpenAxisModules(openModuleRecursively(moduleTree.moduleId, moduleTree));
      setDisplayFlags(showAllFlags(true));
      break;
    case 'default':
      setOpenAxisModules(openModule(moduleTree.moduleId, moduleTree));
      setDisplayFlags(presetDefaultFlags());
      break;
    case 'empty':
      setOpenAxisModules([]);
      setDisplayFlags(showAllFlags(false));
      break;
    case 'networkNode':
    case 'networkInterface': {
      const property = preset === 'networkNode' ? 'networkNode' : 'networkInterface';
      const matched = await collectAxisModulesByNedProperty([property, 'wireJunction']);
      if (matched === null || matched.length === 0) {
        showStatusNote(matched === null ? `NED index unavailable for @${property} lookup — applied Full Detail instead` : `no modules with @${property} found — applied Full Detail instead`);
        setOpenAxisModules(openModuleRecursively(moduleTree.moduleId, moduleTree));
        setDisplayFlags(showAllFlags(true));
      } else {
        setOpenAxisModules(matched);
        setDisplayFlags(presetNetworkCommunicationFlags());
      }
      break;
    }
  }
}

/** Per-axis context-menu info (`chartContextMenu.ts`'s `resolveAxisInfo`) -- `null` while the open-module model isn't live (items disabled). */
function resolveAxisMenuInfo(moduleId: number): AxisModuleMenuInfo | null {
  if (moduleTree === null || openAxisModuleIds === null) return null;
  const node = findModuleNode(moduleId, moduleTree);
  if (!node) return null;
  const glyphs = moduleGlyphInfo(moduleId, openAxisModuleIds, moduleTree);
  const parentId = buildParentMap(moduleTree).get(moduleId);
  return {
    label: `${node.fullName} (id = ${moduleId})`,
    hasParent: parentId !== null && parentId !== undefined,
    canExpand: glyphs.expand,
    canCollapse: glyphs.collapse,
    // Phase U10 -- "Go to NED Declaration"; `nedTypeName` defaults to '' when the log never recorded one, treated as unresolvable.
    nedTypeName: node.nedTypeName || null,
    hasVectorAttached: axisVectorAttachments.has(moduleId),
  };
}

/** "Open Parent Module" -- `openModule(module.getParentModule())`, a whole-set replace on the parent. */
function openParentModuleAction(moduleId: number): void {
  if (moduleTree === null) return;
  const parentId = buildParentMap(moduleTree).get(moduleId);
  if (parentId === null || parentId === undefined) return;
  setOpenAxisModules(openModule(parentId, moduleTree));
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
    // Phase U10 -- "Go to NED Declaration": re-resolves the module node rather than
    // threading a value through, since the menu item itself already disabled the entry
    // when `resolveAxisMenuInfo()` found nothing resolvable (see `chartContextMenu.ts`'s
    // `axisSection()`).
    gotoNedDeclaration: (moduleId) => {
      const typeName = resolveAxisMenuInfo(moduleId)?.nedTypeName;
      if (typeName) vscode.postMessage({ type: 'gotoNedDeclaration', typeName });
    },
    attachVectorToAxis: (moduleId) => {
      const path = findModuleFullPath(moduleId, moduleTree) ?? findModuleNode(moduleId, moduleTree)?.fullName ?? '';
      vscode.postMessage({ type: 'attachAxisVector', moduleId, moduleFullPath: path });
    },
    detachVectorFromAxis: (moduleId) => vscode.postMessage({ type: 'detachAxisVector', moduleId }),
    zoomToAxisVectorValue: (moduleId) => zoomToAxisVectorValue(moduleId),
    filterCausesConsequences: filterCausesConsequencesFor,
    filterMessage: (hit) => {
      const dep = findDependency(hit);
      if (dep) filterMessageFor(dep);
    },
    // ---- phase U8: axis management ----
    removeAxisModule: (moduleId) => {
      if (openAxisModuleIds !== null) setOpenAxisModules(removeOpenAxisModule(openAxisModuleIds, moduleId));
    },
    openCompoundModule: (moduleId) => {
      if (moduleTree !== null) setOpenAxisModules(openModule(moduleId, moduleTree));
    },
    openParentModule: openParentModuleAction,
    expandAxisModule: (moduleId) => {
      if (openAxisModuleIds !== null && moduleTree !== null) setOpenAxisModules(expandOpenAxisModule(openAxisModuleIds, moduleId, moduleTree));
    },
    expandAxisModuleRecursively: (moduleId) => {
      if (openAxisModuleIds !== null && moduleTree !== null) setOpenAxisModules(expandOpenAxisModuleRecursively(openAxisModuleIds, moduleId, moduleTree));
    },
    collapseAxisModule: (moduleId) => {
      if (openAxisModuleIds !== null && moduleTree !== null) setOpenAxisModules(collapseOpenAxisModule(openAxisModuleIds, moduleId, moduleTree));
    },
    collapseAxisModuleSubmodules: (moduleId) => {
      if (openAxisModuleIds !== null && moduleTree !== null) setOpenAxisModules(collapseOpenAxisModuleSubmodules(openAxisModuleIds, moduleId, moduleTree));
    },
    openSelectModulesDialog: showSelectModulesDialog,
    applyPreset: (preset) => void applyPresetConfiguration(preset),
    setAxisOrderingMode: selectAxisOrderingMode,
    spacingBalanced: spacingActions.balanced,
    spacingDense: spacingActions.dense,
    spacingIncrease: spacingActions.increase,
    spacingDecrease: spacingActions.decrease,
    setTimelineMode: (mode) => void applyTimelineMode(mode, false),
    setTimeAccuracy: (fractionDigits) => {
      timeAccuracy = fractionDigits;
      setTimeDisplayAccuracy(fractionDigits);
      state = { ...state, timeAccuracy: fractionDigits };
      persistState();
      scheduleRender();
    },
    zoomIn: () => {
      viewport = zoomAtCenter(viewport, 1.5);
      scheduleRender();
    },
    zoomOut: () => {
      viewport = zoomAtCenter(viewport, 1 / 1.5);
      scheduleRender();
    },
    defaultZoom: () => void applyDefaultZoom(false),
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
    releaseMemory: () => void doReleaseMemory(),
    copyImage: doCopyImage,
    exportSvg: () => void doExportSvg(),
  };
  const entries = buildChartContextMenu({
    hits,
    resolveDependencyLabel: (hit) => {
      const dep = findDependency(hit);
      return dep ? buildDependencyLabel(dep) : null;
    },
    resolveDependencyMessageId: (hit) => {
      const dep = findDependency(hit);
      return dep?.messageId ?? null;
    },
    currentTimelineMode,
    currentAxisOrderingMode: axisOrderingMode,
    resolveAxisInfo: resolveAxisMenuInfo,
    actions,
    displayFlags,
    currentTimeAccuracy: timeAccuracy,
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
  { kind: 'button', button: { id: 'home', icon: 'home', title: 'Go to start', onClick: () => void goToBegin() } },
  { kind: 'button', button: { id: 'gotoEnd', icon: 'arrow-right', title: 'Go to end', onClick: () => void goToEnd() } },
  { kind: 'separator' },
  { kind: 'button', button: { id: 'zoomOut', icon: 'zoom-out', title: 'Zoom out', onClick: () => { viewport = zoomAtCenter(viewport, 1 / 1.5); scheduleRender(); } } },
  { kind: 'button', button: { id: 'zoomIn', icon: 'zoom-in', title: 'Zoom in', onClick: () => { viewport = zoomAtCenter(viewport, 1.5); scheduleRender(); } } },
  { kind: 'button', button: { id: 'zoomToFit', icon: 'screen-full', title: 'Zoom to fit', onClick: () => { if (beginTc !== null && endTc !== null) { viewport = zoomToFit(viewport, beginTc, endTc, 0.02); scheduleRender(); } } } },
  { kind: 'button', button: { id: 'defaultZoom', icon: 'screen-normal', title: 'Default zoom', onClick: () => void applyDefaultZoom(false) } },
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
  { kind: 'separator' },
  { kind: 'button', button: { id: 'filterPanel', icon: 'filter', title: 'Filter Event Log…', toggled: false, onClick: () => toggleFilterPanel() } },
  { kind: 'separator' },
  // ---- phase U8: axis management (Eclipse toolbar: select-modules, preset dropdown, ordering cycle, increase/decrease spacing) ----
  { kind: 'button', button: { id: 'selectModules', icon: 'list-tree', title: 'Select Modules…', onClick: () => showSelectModulesDialog() } },
  { kind: 'button', button: { id: 'spacingIncrease', icon: 'unfold', title: 'Increase Spacing', onClick: () => spacingActions.increase() } },
  { kind: 'button', button: { id: 'spacingDecrease', icon: 'fold', title: 'Decrease Spacing', onClick: () => spacingActions.decrease() } },
  { kind: 'spacer' },
  {
    kind: 'dropdown',
    dropdown: {
      id: 'presetConfiguration',
      title: 'Preset Configuration',
      // an ACTION dropdown (Eclipse: a drop-down toolbar action): the placeholder row is re-selected after each apply
      options: [
        { value: '', label: 'Preset…' },
        { value: 'networkNode', label: 'Network Node' },
        { value: 'networkInterface', label: 'Network Interface' },
        { value: 'fullDetail', label: 'Full Detail' },
        { value: 'default', label: 'Default' },
        { value: 'empty', label: 'Empty' },
      ],
      value: '',
      onChange: (v) => {
        if (v !== '') void applyPresetConfiguration(v as PresetConfiguration);
        toolbar.setDropdownValue('presetConfiguration', '');
      },
    },
  },
  {
    kind: 'dropdown',
    dropdown: {
      id: 'axisOrdering',
      title: 'Axis Ordering Mode',
      options: [
        { value: 'moduleId', label: 'Order: Module Id' },
        { value: 'moduleFullPath', label: 'Order: Module Path' },
        { value: 'minimizeCrossings', label: 'Order: Minimize Crossings' },
        { value: 'manual', label: 'Order: Manual…' },
      ],
      value: axisOrderingMode,
      onChange: (v) => selectAxisOrderingMode(v as AxisOrderingMode),
    },
  },
  { kind: 'dropdown', dropdown: { id: 'timelineMode', title: 'Timeline Mode', options: TIMELINE_MODE_OPTIONS, value: currentTimelineMode, onChange: (v) => void applyTimelineMode(v, false) } },
  { kind: 'separator' },
  // Phase U10 (cheap gap) -- Eclipse's toolbar ends with a `showHideAction` drop-down
  // (`contributeToToolBar()`); this port had the ~25 toggles context-menu-only until
  // now. `common/toolbar.ts` has no "checkable dropdown menu" item kind (only a plain
  // HTML `<select>`, a single-value picker unsuited to 25 independent booleans) -- the
  // cheapest faithful equivalent is a plain button that opens the SAME `MenuEntry[]`
  // the context menu's Show/Hide submenu uses (`buildShowHideEntries()`), anchored at
  // this button via `common/contextMenu.ts`'s `showContextMenu()` (which only needs an
  // (x, y), not a real mouse event -- see that function's signature).
  {
    kind: 'button',
    button: {
      id: 'showHide',
      icon: 'eye',
      title: 'Show/Hide…',
      onClick: () => {
        const rect = document.getElementById('showHide')!.getBoundingClientRect();
        showContextMenu(rect.left, rect.bottom, buildShowHideEntries(displayFlags, { toggleDisplayFlag: (key) => setDisplayFlags(toggleFlag(displayFlags, key)) }));
      },
    },
  },
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
  getAxesLayout: () => currentAxesLayout(),
  getBeginTc: () => navigableBeginTc,
  getEndTc: () => endTc,
  onChanged: () => scheduleRender(),

  getPrimitives: () => lastPrimitives,
  hitTestAt,
  // pointer cursor over an axis-management glyph (phase U8; Eclipse shows the hand cursor over ModuleActions)
  getCursorAt: (px, py) => (hitTestAt(px, py).some((h) => h.kind === 'moduleAction') ? 'pointer' : null),
  onHover: updateHover,
  onHoverEnd: clearHover,
  onRubberBand: (rect) => {
    if (!rect) {
      marqueeEl.style.display = 'none';
      return;
    }
    marqueeEl.style.left = `${Math.min(rect.x0, rect.x1)}px`;
    marqueeEl.style.top = `${Math.min(rect.y0, rect.y1)}px`;
    marqueeEl.style.width = `${Math.abs(rect.x1 - rect.x0)}px`;
    marqueeEl.style.height = `${Math.abs(rect.y1 - rect.y0)}px`;
    marqueeEl.style.display = 'block';
  },
  onZoomToRect: (rect) => {
    marqueeEl.style.display = 'none';
    // Horizontal: zoom-to-fit the rectangle's tc span (mapped from screen px with the
    // pre-zoom viewport). Vertical: the port has no vertical zoom, so scroll the axis
    // stack to bring the rectangle's top into view.
    const tc0 = fullCanvasPxToTc(rect.x0, viewport);
    const tc1 = fullCanvasPxToTc(rect.x1, viewport);
    const ryTop = Math.min(rect.y0, rect.y1);
    const axesLayout = currentAxesLayout();
    const targetVscroll = ryTop - GUTTER_TOP_HEIGHT + viewport.vscroll;
    if (tc0 !== null && tc1 !== null && Math.abs(tc1 - tc0) > 1e-12) {
      viewport = zoomToFit(viewport, Math.min(tc0, tc1), Math.max(tc0, tc1), 0);
    }
    viewport = scrollVerticalTo(viewport, targetVscroll, maxVerticalScroll(axesLayout, contentHeight(viewport)));
    scheduleRender();
  },
  onClick: handleClick,
  onDoubleClick: handleDoubleClick,
  onContextMenu: openChartContextMenu,
  onEscape: () => {
    // Phase U7: closing an open filter panel takes priority over clearing the
    // selection (the panel brief's own "Keyboard: Esc closes" -- the panel's own
    // keydown listener only fires while focus is inside it, e.g. a text field; this
    // covers Esc pressed while the canvas itself has focus, which is the common case
    // right after opening the panel and clicking back into the chart).
    if (filterPanel.isOpen()) {
      filterPanel.close();
      toolbar.setButtonState('filterPanel', { toggled: false });
      return;
    }
    selection = clearSelection(selection);
    broadcastSelection();
    scheduleRender();
  },
  onRefresh: refresh,
  onToggleTimeDifferences: () => setDisplayFlags(toggleFlag(displayFlags, 'showTimeDifferences')),
  onDeleteExclude: () => void deleteExcludeSelection(),
  onMoveFocus: (direction) => void onMoveFocus(direction),
  onGotoCause: () => void onGotoCause(),
  onGotoConsequence: () => void onGotoConsequence(),
  onSameModuleNeighbor,
  onDefaultZoom: () => void applyDefaultZoom(false),
  onToggleBookmark: toggleBookmarkForSelection,
});

attachTooltip({
  hostElement: canvasContainer,
  resolveHit: resolveHitForTooltip,
  ctx: labelProviderCtx,
});

// ---------------------------------------------------------------------------------
// Phase U7: Filter panel -- apply/remove with progress+cancel, re-anchor, Del-exclude,
// context-menu prefill shortcuts. See filterPanel.ts/filterPanelState.ts's own headers
// for the pure logic; everything below is the RPC/viewport-mutation glue only a
// stateful bootstrap module like this one can own.
// ---------------------------------------------------------------------------------

filterPanel = buildFilterPanel(document.getElementById('filterPanelHost')!, {
  onApply: () => {
    const params = buildFilterParams(filterPanel.getState());
    if (params !== null) void applyFilterParamsAndReanchor(params);
  },
  onRemove: () => void applyFilterParamsAndReanchor(null),
  onClose: () => toolbar.setButtonState('filterPanel', { toggled: false }),
  onStateChange: (next) => {
    state = { ...state, filterPanel: next };
    persistState();
  },
  requestData: () => {
    filterPanel.setModuleTree(moduleTree);
    if (filterHintsLoaded) return;
    void rpc
      .request<FilterHints>(ElogMethods.getFilterHints, undefined)
      .then((hints) => {
        filterHintsLoaded = true;
        filterPanel.setFilterHints(hints);
      })
      .catch(() => {
        // best effort -- the panel's multi-select lists just stay empty until the next open
      });
  },
});

function toggleFilterPanel(): void {
  filterPanel.toggle();
  toolbar.setButtonState('filterPanel', { toggled: filterPanel.isOpen() });
}

/**
 * Applies (`params !== null`) or removes (`params === null`) a filter, showing the
 * panel's busy/Cancel affordance while `elog/setFilter` is in flight (long-running,
 * cancellable -- `elogProtocol.ts`'s `ElogMethods.setFilter` doc comment), then
 * re-anchors the chart -- port of `SequenceChartContributor.filter()`/`removeFilter()`
 * (verified by reading the source): capture the viewport-center event number BEFORE
 * the coordinate system changes (same "anchor" trick `applyTimelineMode()` already
 * uses for a timeline-mode switch, since a filter change resets the engine's
 * coordinate-system version exactly the same way), then relocate+center on it and
 * reset to the default zoom level afterward (Java: `scrollToSimulationTime(center)` +
 * `defaultZoom()`). This chart webview is always the sole INITIATOR of `elog/setFilter`
 * (the Event Log table has no filter panel of its own, and
 * `sequenceChartEditor.ts`'s `supportsMultipleEditorsPerDocument: false` guarantees at
 * most one chart webview per session) -- the table's own re-anchor (independently,
 * off the session's `elog/filterChanged` broadcast) lives in `tableView.ts`'s
 * `onFilterChanged()`.
 */
async function applyFilterParamsAndReanchor(params: FilterParams | null): Promise<void> {
  let anchorEventNumber: number | null = null;
  if (summary && !summary.isEmpty) {
    const centerTc = viewport.leftTc + contentWidth(viewport) / 2 / viewport.pixelsPerTc;
    try {
      const mapped = await rpc.request<MapCoordsResult>(ElogMethods.scMapCoords, { kind: 'tcToEventNumber', tc: centerTc });
      anchorEventNumber = mapped.eventNumber;
    } catch {
      anchorEventNumber = null;
    }
  }

  filterPanel.setBusy(true);
  const { promise, cancel } = rpc.requestCancelable<LogSummary>(ElogMethods.setFilter, params);
  filterPanel.setBusy(true, cancel);
  try {
    const newSummary = await promise;
    currentFilterParams = params;
    summary = newSummary;
    renderModelCache.bumpGeneration();
    renderModelCache.invalidateAll();
    knownModuleIds.clear();
    lastModel = null;
    crossingsOrderCache = null; // filtered log = different dependency statistics

    if (!newSummary.isEmpty) {
      if (anchorEventNumber !== null) await relocateAndCenter(anchorEventNumber, true);
      else await relocateAndCenter(newSummary.firstEventNumber, false);
      await applyDefaultZoom(anchorEventNumber !== null); // Java's defaultZoom(), after scrollToSimulationTime(center)
    } else {
      viewport = { ...viewport, coordinateSystemVersion: newSummary.coordinateSystemVersion };
    }
    await refreshEndpointsTc();
    filterPanel.setFiltered(newSummary.filtered);
    scheduleRender();
  } catch (err) {
    if (!(err instanceof RequestCancelledError)) {
      // best-effort -- matches every other engine round trip in this file (doGotoEvent/
      // doGotoSimTime/performFind), no error dialog, the panel/chart just stay as they were
    }
  } finally {
    filterPanel.setBusy(false);
  }
}

/**
 * Del/Backspace on the current chart selection -- port of `SequenceChart.java`'s
 * `SWT.DEL` key handler (`~line 5736`, verified by reading the source): merges the
 * selected event numbers into whichever filter is currently active (creating a
 * range-only... exclusion-only filter if none is), then re-applies. Re-anchor strategy
 * is DIFFERENT from `applyFilterParamsAndReanchor()`'s Apply/Remove flow on purpose
 * (matches Java exactly): restores the SAME visible simulation-time window
 * (`zoomToSimulationTimeRange(oldLeft, oldRight)`) rather than centering on one event
 * and resetting zoom -- excluding a handful of selected events shouldn't jerk the
 * viewport away from where the user was just looking.
 */
async function deleteExcludeSelection(): Promise<void> {
  if (selection.events.size === 0 || !summary || summary.isEmpty) return;
  const eventNumbers = [...selection.events];
  const range = visibleTcRange(viewport);
  const leftSim = simTimeAt(viewport.leftTc);
  const rightSim = simTimeAt(range.rightTc);
  const merged = mergeExcludedEventNumbers(currentFilterParams, eventNumbers);

  filterPanel.setBusy(true);
  const { promise, cancel } = rpc.requestCancelable<LogSummary>(ElogMethods.setFilter, merged);
  filterPanel.setBusy(true, cancel);
  try {
    const newSummary = await promise;
    currentFilterParams = merged;
    filterPanel.setState(applyExcludedEventNumbersToState(filterPanel.getState(), eventNumbers));
    summary = newSummary;
    renderModelCache.bumpGeneration();
    renderModelCache.invalidateAll();
    knownModuleIds.clear();
    lastModel = null;
    crossingsOrderCache = null; // filtered log = different dependency statistics
    selection = clearSelection(selection); // Java: the excluded events are dropped from selectedObjects
    broadcastSelection();

    if (!newSummary.isEmpty) {
      await relocateAndCenter(newSummary.firstEventNumber, false); // establishes a fresh coordinate system baseline; the range restore below overrides its viewport
      if (leftSim !== null && rightSim !== null) {
        try {
          const [left, right] = await Promise.all([
            rpc.request<MapCoordsResult>(ElogMethods.scMapCoords, { kind: 'simTimeToTc', simulationTime: String(leftSim) }),
            rpc.request<MapCoordsResult>(ElogMethods.scMapCoords, { kind: 'simTimeToTc', simulationTime: String(rightSim) }),
          ]);
          if (left.tc !== null && right.tc !== null && right.tc > left.tc) {
            viewport = { ...viewport, leftTc: left.tc, pixelsPerTc: contentWidth(viewport) / (right.tc - left.tc) };
          }
        } catch {
          // best effort -- fall back to whatever relocateAndCenter already set up
        }
      }
    } else {
      viewport = { ...viewport, coordinateSystemVersion: newSummary.coordinateSystemVersion };
    }
    await refreshEndpointsTc();
    filterPanel.setFiltered(newSummary.filtered);
    scheduleRender();
  } catch (err) {
    if (!(err instanceof RequestCancelledError)) {
      // best-effort, matches applyFilterParamsAndReanchor()'s own catch
    }
  } finally {
    filterPanel.setBusy(false);
  }
}

/** "Filter Causes/Consequences..." (per-event chart context-menu item) -- pre-fills the panel's trace section and opens it; Apply is still a separate, explicit user action (see `chartContextMenu.ts`'s header). */
function filterCausesConsequencesFor(eventNumber: number): void {
  filterPanel.prefillAndOpen((s) => prefillCauseConsequenceFilter(s, eventNumber));
  toolbar.setButtonState('filterPanel', { toggled: true });
}

/** "Filter Message..." (per-dependency chart context-menu item) -- pre-fills the panel's message-ID + a narrow event-number range around the dependency's cause event and opens it (see `filterPanelState.ts`'s `prefillMessageFilter()` doc comment for the simplification vs. Java). */
function filterMessageFor(dep: RenderDependency): void {
  const messageId = dep.messageId ?? null;
  if (messageId === null || !summary) return;
  filterPanel.prefillAndOpen((s) => prefillMessageFilter(s, messageId, dep.causeEventNumber, summary!.lastEventNumber));
  toolbar.setButtonState('filterPanel', { toggled: true });
}

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
      uiSettings = message.settings; // Phase U10 -- see this file's `uiSettings` doc comment
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
      if (message.persistedState !== undefined) {
        state = { ...state, ...loadPersistedBlob<PersistedChartState>(message.persistedState, CHART_STATE_VERSION) };
        displayFlags = mergeDisplayFlags(state.displayFlags);
        timeAccuracy = state.timeAccuracy ?? null;
        setTimeDisplayAccuracy(timeAccuracy);
        filterPanel.setState(mergeFilterPanelState(state.filterPanel));
        // phase U8 -- axis management state (open set itself resolves from paths once
        // the module tree arrives below, initializeOpenAxisModules())
        axisOrderingMode = state.axisOrderingMode ?? 'moduleId';
        manualOrderPaths = state.manualAxisOrderPaths ?? [];
        axisSpacingMode = state.axisSpacingMode ?? 'auto';
        if (state.axisSpacing !== undefined) axisSpacingManual = clampAxisSpacing(state.axisSpacing);
        toolbar.setDropdownValue('axisOrdering', axisOrderingMode);
      }
      // Phase U10 -- `omnetpp.sequenceChart.defaultTimelineMode`: a per-file persisted
      // mode always wins (the user's own last choice for THIS file); with none, the
      // setting is the fallback, and only with NEITHER does this drop to the original
      // hardcoded default. Applied unconditionally (not just inside the persistedState
      // branch above) so the setting still takes effect on a genuinely fresh file, which
      // has no persisted blob to merge at all.
      const initialTimelineMode = state.timelineMode ?? uiSettings?.sequenceChart?.defaultTimelineMode ?? TimelineMode.SIMULATION_TIME;
      toolbar.setDropdownValue('timelineMode', initialTimelineMode);
      // Phase U7: seed the chart's mirror of the session's currently-active filter (may
      // be non-null even on THIS webview's very first `init` -- a filter persisted by a
      // previous session and rehydrated on file reopen, see
      // `eventLogController.ts`'s `FILTER_PARAMS_KEY`) and reflect it in the panel/
      // toolbar right away, without waiting for the user to ever open the panel.
      currentFilterParams = message.filterParams;
      filterPanel.setFiltered(summary?.filtered ?? false);
      renderFrame();
      if (fileUri) {
        void rpc.request<ElogModule | null>(ElogMethods.getModuleTree, undefined).then((tree) => {
          moduleTree = tree;
          initializeOpenAxisModules(); // phase U8 -- resolve persisted paths / apply the default open set
          maybeAutoAttachVectors(); // @defaultStatistic auto-attach (once, first tree load)
          filterPanel.setModuleTree(tree);
          recomputeBookmarkIndexes();
          scheduleRender();
        });
        const isInitialLoad = !hasInitializedViewport;
        // Phase U10 -- `omnetpp.eventlog.followEndOnAppend`'s "no persisted viewport at
        // all" gate: armed only on a genuinely fresh file (GAP 1's restore always takes
        // priority when there IS a remembered position). Consumed either right below (if
        // the file already has content) or later, on the first `elog/changed` that takes
        // it from empty to non-empty (see the `engineNotify` handler).
        if (isInitialLoad) followEndOnOpenPending = !state.viewport && uiSettings?.eventlog?.followEndOnAppend === true;
        void applyTimelineMode(initialTimelineMode, isInitialLoad, state.viewport).then(async () => {
          if (selection.focusEventNumber !== null) {
            centerOnEvent(selection.focusEventNumber);
          } else if (followEndOnOpenPending && summary && !summary.isEmpty) {
            // Phase U10 -- INITIAL semantics: the file already has content right at open
            // time, so the "as if End had just been pressed" behavior applies immediately
            // (an inbound selection focus, handled above, takes priority instead).
            followEndOnOpenPending = false;
            await goToEnd();
            scheduleRender();
          }
        });
      }
      break;
    }
    case 'engineResponse':
      rpc.handleResponse(message);
      break;
    case 'engineNotify': {
      if (message.event === 'elog/progress') {
        // ADDITIVE (phase U7): previously silently dropped entirely. `ElogProgressParams`
        // carries only a `requestId` correlator, no percentage/message -- with the
        // engine's single-job serial queue, any progress notification arriving while the
        // filter panel is busy can only be about that in-flight `elog/setFilter`
        // (`applyFilterParamsAndReanchor()`/`deleteExcludeSelection()`); tick the busy
        // label so a long filter operation visibly shows liveness rather than looking hung.
        filterPanel.tickBusy();
        break;
      }
      // Phase U9: `elog/memoryReleased` (from THIS webview's own "Release Memory" item,
      // the OTHER Event Log table's, or the native `omnetpp.eventlog.releaseMemory`
      // command) reuses the exact same invalidate-and-refetch path as a real
      // `elog/changed`/`elog/refreshed` -- the engine's parsed-event cache was
      // dropped, so every cached render window is just as stale as after a real
      // file change, even though the file's actual CONTENT didn't change (only its
      // `coordinateSystemVersion` bumped, which the `versionChanged` check below
      // already treats as "re-fetch everything", including the module tree -- a
      // little more work than strictly necessary, but simple and correct).
      if (message.event === 'elog/changed' || message.event === 'elog/refreshed' || message.event === 'elog/memoryReleased' || message.event === 'restarted') {
        const payload = message.payload as { summary?: LogSummary; change?: 'appended' | 'overwritten' };
        if (payload?.summary) {
          const versionChanged = summary?.coordinateSystemVersion !== payload.summary.coordinateSystemVersion;
          summary = payload.summary;
          renderModelCache.bumpGeneration();
          renderModelCache.invalidateAll();
          crossingsOrderCache = null; // new/changed data invalidates the sampled weight matrix
          if (versionChanged || payload.change === 'overwritten') {
            knownModuleIds.clear();
            lastModel = null;
            // phase U8 -- an overwritten file may have a different module structure:
            // re-fetch the tree and re-resolve the persisted open-module PATHS against
            // it (ids may have shifted; paths are the durable identity).
            openAxisModuleIds = null;
            void rpc.request<ElogModule | null>(ElogMethods.getModuleTree, undefined).then((tree) => {
              moduleTree = tree;
              initializeOpenAxisModules();
              filterPanel.setModuleTree(tree);
              recomputeBookmarkIndexes();
              scheduleRender();
            });
          }
          void refreshEndpointsTc().then(async () => {
            if (followEndOnOpenPending && !payload.summary!.isEmpty) {
              // Phase U10 -- `followEndOnAppend`'s "or first append arrives" clause: the
              // file was empty at open time (nothing to follow to yet), and this is the
              // very first notification that gives it real content -- treat it exactly
              // like the initial-open case (see the 'init' handler's own comment).
              followEndOnOpenPending = false;
              await goToEnd();
            } else if (viewport.followEnd) {
              void goToEnd();
            } else {
              scheduleRender();
            }
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
    case 'nedTypeQueryResult': {
      // phase U8 -- preset configuration's NED-property lookup reply (see
      // `queryNedTypeProperties()`'s correlator).
      const resolve = pendingNedQueries.get(message.id);
      if (resolve) {
        pendingNedQueries.delete(message.id);
        resolve(message.properties);
      }
      break;
    }
    case 'axisVectorAttachmentChanged': {
      // The host attached/detached a vector on this axis (in the worker). Mirror it for the
      // menu Attach/Detach state + persistence, then force a fresh viewport (the cache is
      // keyed by range/version, which don't change when only the attachment set does).
      if (message.attachment) axisVectorAttachments.set(message.moduleId, message.attachment);
      else axisVectorAttachments.delete(message.moduleId);
      syncVectorAttachmentsToState();
      renderModelCache.invalidateAll();
      scheduleRender();
      break;
    }
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
        // Phase U9 -- forwarded from `omnetpp.eventlog.exportSvg`/`.copyImage`/`.releaseMemory`
        // (`eventLogDialogs.ts`) when this webview is the attached chart.
        case 'exportSvg':
          void doExportSvg();
          break;
        case 'copyImage':
          doCopyImage();
          break;
        case 'releaseMemory':
          void doReleaseMemory();
          break;
        case 'toggleFilterPanel':
          // From `omnetpp.eventlog.openFilter`/the table's "Filter…" item (see
          // `eventLogDialogs.ts`'s `openFilterPanelForSession()` and
          // `sequenceChartEditor.ts`'s `ready` handler's `consumeOpenFilterOnAttach()`).
          toggleFilterPanel();
          break;
        case 'resetViewState': {
          // "OMNeT++: Reset Event Log View State" -- the host has already wiped the
          // workspaceState blobs; discard the webview-local persisted + in-memory view
          // state too and repaint from first principles (default axes/flags/zoom,
          // goto begin). The escape hatch for state poisoned by an older build.
          state = {};
          displayFlags = mergeDisplayFlags(undefined);
          timeAccuracy = null;
          setTimeDisplayAccuracy(null);
          axisOrderingMode = 'moduleId';
          manualOrderPaths = [];
          axisSpacingMode = 'auto';
          axisSpacingManual = DENSE_AXIS_SPACING;
          crossingsOrderCache = null;
          toolbar.setDropdownValue('axisOrdering', axisOrderingMode);
          openAxisModuleIds = moduleTree !== null ? defaultOpenAxisModules(moduleTree) : null;
          filterPanel.setState(mergeFilterPanelState(undefined));
          selection = EMPTY_CHART_SELECTION;
          viewport = { ...viewport, pixelsPerTc: DEFAULT_PIXELS_PER_TC, vscroll: 0 };
          persistState();
          void applyTimelineMode(TimelineMode.SIMULATION_TIME, true, undefined);
          break;
        }
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
