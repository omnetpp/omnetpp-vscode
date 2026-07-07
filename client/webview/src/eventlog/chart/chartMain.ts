import { ElogMethods, TimelineMode, type LogSummary, type ScSetTimelineModeParams, type ScState } from '@omnetpp/shared/elog-protocol';
import type { HostToWebviewMessage, WebviewToHostMessage } from '@omnetpp/shared/ui-protocol';
import { EngineRpc } from '../common/rpc';
import { buildToolbar, type ToolbarHandle } from '../common/toolbar';
import { renderSummaryStrip } from '../common/summary';
import { readPalette, watchThemeChange } from '../common/theme';

/**
 * Bootstrap for the Sequence Chart webview app (bundled to
 * `dist/webview/sequenceChart.js`, loaded by `sequenceChartEditor.ts`'s
 * `buildEventLogWebviewHtml()`). U1 scope only: a toolbar shell (Home/Zoom
 * In/Zoom Out/Refresh + a Timeline Mode dropdown that is functionally wired to
 * `elog/sc/setTimelineMode`), a status strip with real `LogSummary` data, and
 * an empty canvas placeholder -- chart drawing itself is U3.
 */

interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
  getState(): PersistedChartState | undefined;
  setState(state: PersistedChartState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

/** Placeholder shape -- the full `SequenceChartState` port (timeline mode, ordering,
 *  spacing, 25 show* toggles, zoom, ...) is a later phase; U1 only persists what it
 *  itself reads/writes (the timeline mode dropdown), so later phases can extend this
 *  object without U1 needing to change. */
interface PersistedChartState {
  timelineMode?: string;
}

const vscode = acquireVsCodeApi();
const rpc = new EngineRpc(vscode);
let state: PersistedChartState = vscode.getState() ?? {};
let fileUri = '';
let summary: LogSummary | null = null;
let toolbar: ToolbarHandle;

const TIMELINE_MODE_OPTIONS = [
  { value: TimelineMode.SIMULATION_TIME, label: 'Simulation Time' },
  { value: TimelineMode.EVENT_NUMBER, label: 'Event Number' },
  { value: TimelineMode.STEP, label: 'Step' },
  { value: TimelineMode.NONLINEAR, label: 'Nonlinear' },
];

document.getElementById('root')!.innerHTML = `
  <div id="toolbar"></div>
  <div id="status"></div>
  <div class="elog-body" id="body">
    <canvas id="canvas" style="display:block;width:100%;height:100%;"></canvas>
    <div class="elog-empty" id="empty">Open a Sequence Chart to see events here.</div>
  </div>
`;

function fileName(): string {
  if (!fileUri) return '';
  try {
    return decodeURIComponent(fileUri.split(/[\\/]/).pop() ?? fileUri);
  } catch {
    return fileUri;
  }
}

function render(): void {
  renderSummaryStrip(document.getElementById('status')!, fileName(), summary);
  const empty = document.getElementById('empty')!;
  empty.style.display = summary && !summary.isEmpty ? 'none' : 'flex';
  document.title = fileName() ? `${fileName()} — Sequence Chart` : 'Sequence Chart';
}

async function setTimelineMode(mode: string): Promise<void> {
  state = { ...state, timelineMode: mode };
  vscode.setState(state);
  toolbar.setButtonState('refresh', { disabled: true });
  try {
    const params: ScSetTimelineModeParams = { timelineMode: mode as TimelineMode };
    const scState = await rpc.request<ScState>(ElogMethods.scSetTimelineMode, params);
    toolbar.setDropdownValue('timelineMode', scState.timelineMode);
  } finally {
    toolbar.setButtonState('refresh', { disabled: false });
  }
}

function refresh(): void {
  // The result itself is unused here -- `EventLogSession.refresh()` (host side)
  // already broadcasts the fresh summary as an `engineNotify` to every attached
  // webview (including this one), which the `'engineNotify'` case below re-renders on.
  void rpc.request(ElogMethods.checkChanges, undefined);
}

toolbar = buildToolbar(document.getElementById('toolbar')!, [
  { kind: 'button', button: { id: 'home', icon: 'home', title: 'Go to start', onClick: () => vscode.postMessage({ type: 'revealRequest', target: { kind: 'event', eventNumber: summary?.firstEventNumber ?? 0, ref: null } }) } },
  { kind: 'separator' },
  { kind: 'button', button: { id: 'zoomOut', icon: 'zoom-out', title: 'Zoom out', onClick: () => {} } },
  { kind: 'button', button: { id: 'zoomIn', icon: 'zoom-in', title: 'Zoom in', onClick: () => {} } },
  { kind: 'separator' },
  { kind: 'button', button: { id: 'refresh', icon: 'refresh', title: 'Refresh', onClick: refresh } },
  { kind: 'spacer' },
  { kind: 'dropdown', dropdown: { id: 'timelineMode', title: 'Timeline Mode', options: TIMELINE_MODE_OPTIONS, value: state.timelineMode ?? TimelineMode.SIMULATION_TIME, onChange: (v) => void setTimelineMode(v) } },
]);

watchThemeChange(() => {
  // U3 will additionally flush a cached canvas tile here; U1 has nothing cached yet.
  readPalette();
});

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      fileUri = message.fileUri;
      summary = message.summary;
      if (message.persistedState && typeof message.persistedState === 'object') {
        state = { ...state, ...(message.persistedState as PersistedChartState) };
        toolbar.setDropdownValue('timelineMode', state.timelineMode ?? TimelineMode.SIMULATION_TIME);
      }
      render();
      // Apply the persisted (or default) timeline mode against the freshly (re)opened engine.
      if (fileUri) void setTimelineMode(state.timelineMode ?? TimelineMode.SIMULATION_TIME);
      break;
    case 'engineResponse':
      rpc.handleResponse(message);
      break;
    case 'engineNotify':
      if (message.event === 'elog/changed' || message.event === 'elog/refreshed' || message.event === 'restarted') {
        const payload = message.payload as { summary?: LogSummary };
        if (payload?.summary) summary = payload.summary;
        render();
      }
      break;
    case 'reveal':
      // U3/U4 will actually scroll the canvas to `message.target`; U1 just
      // structurally accepts the message so goto/find never errors.
      break;
    case 'setSelection':
    case 'command':
      break;
  }
});

vscode.postMessage({ type: 'ready' });
render();
