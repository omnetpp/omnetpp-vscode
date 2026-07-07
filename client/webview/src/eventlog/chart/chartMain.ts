import {
  ElogMethods,
  TimelineMode,
  type ElogModule,
  type LogSummary,
  type MapCoordsResult,
  type ScSetTimelineModeParams,
  type ScState,
  type ViewportModel,
  type ViewportParams,
} from '@omnetpp/shared/elog-protocol';
import type { HostToWebviewMessage, RevealTarget, WebviewToHostMessage } from '@omnetpp/shared/ui-protocol';
import { EngineRpc } from '../common/rpc';
import { buildToolbar, type ToolbarHandle } from '../common/toolbar';
import { renderSummaryStrip } from '../common/summary';
import { readPalette, watchThemeChange, type EventLogPalette } from '../common/theme';
import { deriveAxes, maxVerticalScroll, type AxesLayout } from './axes';
import { buildSampleTable, tcToSimTimeApprox, type TcSimSample } from './coords';
import { buildDrawList } from './drawList';
import { calculateTicks, formatTickLabel } from './ticks';
import { createCanvasStack, type CanvasStackHandle } from './canvasStack';
import { attachInteractions } from './interactions';
import { RenderModelCache, type EngineViewportSource } from './renderModelCache';
import {
  contentHeight,
  contentWidth,
  createViewportState,
  gotoBeginAt,
  gotoEndAt,
  panTo,
  resize as resizeViewport,
  revealAt,
  visibleTcRange,
  zoomAtCenter,
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

const TIMELINE_MODE_OPTIONS = [
  { value: TimelineMode.SIMULATION_TIME, label: 'Simulation Time' },
  { value: TimelineMode.EVENT_NUMBER, label: 'Event Number' },
  { value: TimelineMode.STEP, label: 'Step' },
  { value: TimelineMode.NONLINEAR, label: 'Nonlinear' },
];

const engineSource: EngineViewportSource = {
  getViewport: (params: ViewportParams) => rpc.request<ViewportModel>(ElogMethods.scGetViewport, params),
};
const renderModelCache = new RenderModelCache(engineSource);

document.getElementById('root')!.innerHTML = `
  <div id="toolbar"></div>
  <div id="status"></div>
  <div class="elog-body" id="body">
    <div id="chartCanvasContainer" style="position:absolute;inset:0;overflow:hidden;"></div>
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

  const axesLayout: AxesLayout = deriveAxes(knownModuleIds, moduleTree, contentHeight(viewport));
  const lastSimTime = summary.lastSimulationTime !== null ? Number(summary.lastSimulationTime) : 0;
  const tickResult = calculateTicks(currentTimelineMode, viewport.leftTc, range.rightTc, viewport.pixelsPerTc, lastSimTime, simTimeAt);
  const primitives = buildDrawList({
    timelineMode: currentTimelineMode,
    viewport,
    events: lastModel?.events ?? [],
    dependencies: lastModel?.dependencies ?? [],
    methodCalls: lastModel?.methodCalls ?? [],
    axesLayout,
    ticks: tickResult.ticks,
    theme: palette,
  });
  canvasStack.render(primitives, true);
  renderStatus();
  updateHScrollbar();
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
    span.textContent = `View: ${leftLabel} – ${rightLabel}  (${viewport.pixelsPerTc.toPrecision(3)} px/tc)${viewport.followEnd ? '  •  following end' : ''}`;
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
  vscode.setState(state);
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
  getAxesLayout: () => deriveAxes(knownModuleIds, moduleTree, contentHeight(viewport)),
  getBeginTc: () => beginTc,
  getEndTc: () => endTc,
  onChanged: () => scheduleRender(),
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
      if (message.persistedState && typeof message.persistedState === 'object') {
        state = { ...state, ...(message.persistedState as PersistedChartState) };
        toolbar.setDropdownValue('timelineMode', state.timelineMode ?? TimelineMode.SIMULATION_TIME);
      }
      renderFrame();
      if (fileUri) {
        void rpc.request<ElogModule | null>(ElogMethods.getModuleTree, undefined).then((tree) => {
          moduleTree = tree;
          scheduleRender();
        });
        void applyTimelineMode(state.timelineMode ?? TimelineMode.SIMULATION_TIME, !hasInitializedViewport);
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
    case 'setSelection':
    case 'command':
      break;
  }
});

vscode.postMessage({ type: 'ready' });
renderFrame();
