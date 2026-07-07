import { ElogMethods, type LogSummary } from '@omnetpp/shared/elog-protocol';
import type { HostToWebviewMessage, WebviewToHostMessage } from '@omnetpp/shared/ui-protocol';
import { EngineRpc } from '../common/rpc';
import { buildToolbar } from '../common/toolbar';
import { renderSummaryStrip } from '../common/summary';
import { readPalette, watchThemeChange } from '../common/theme';

/**
 * Bootstrap for the Event Log table webview view (bundled to
 * `dist/webview/eventLogTable.js`, hosted by the `omnetppEventLogTable`
 * webview view, `eventLogTableView.ts`). U1 scope only: a toolbar shell
 * (Refresh, plus disabled Filter/Find placeholders for U7/U4 to enable), a
 * summary line with real `LogSummary` data, and an empty virtual-scroll
 * container -- the row pool itself is U2.
 */

interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const rpc = new EngineRpc(vscode);
let fileUri = '';
let summary: LogSummary | null = null;

document.getElementById('root')!.innerHTML = `
  <div id="toolbar"></div>
  <div id="status"></div>
  <div class="elog-body" id="body">
    <div id="rows"></div>
    <div class="elog-empty" id="empty">No event log open. Open an .elog file's Sequence Chart to populate this view, or pin it to a specific file.</div>
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
  if (summary && !summary.isEmpty) {
    empty.textContent = 'Table rows are not implemented yet (coming in a later phase).';
    empty.style.display = 'flex';
  }
}

buildToolbar(document.getElementById('toolbar')!, [
  { kind: 'button', button: { id: 'refresh', icon: 'refresh', title: 'Refresh', onClick: () => void rpc.request(ElogMethods.checkChanges, undefined) } },
  { kind: 'separator' },
  { kind: 'button', button: { id: 'filter', icon: 'filter', title: 'Filter (not yet implemented)', onClick: () => vscode.postMessage({ type: 'contextValue', key: 'omnetpp.eventlog.tableRequestsFilter', value: true }), disabled: true } },
  { kind: 'button', button: { id: 'find', icon: 'search', title: 'Find (not yet implemented)', onClick: () => {}, disabled: true } },
]);

watchThemeChange(() => {
  readPalette();
});

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      fileUri = message.fileUri;
      summary = message.summary;
      render();
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
    case 'setSelection':
    case 'command':
      // U2/U6 will scroll the row pool / apply selection highlighting; U1 just
      // accepts these structurally so the message pump never errors.
      break;
  }
});

vscode.postMessage({ type: 'ready' });
render();
