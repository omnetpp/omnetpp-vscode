import { ElogMethods, type ElogChangedParams, type CheckChangesResult, type LogSummary } from '@omnetpp/shared/elog-protocol';
import type { HostToWebviewMessage, WebviewToHostMessage } from '@omnetpp/shared/ui-protocol';
import { EngineRpc } from '../common/rpc';
import { renderSummaryStrip } from '../common/summary';
import { readPalette, watchThemeChange } from '../common/theme';
import { createTableView, type TableViewHandle } from './tableView';

/**
 * Bootstrap for the Event Log table webview view (bundled to
 * `dist/webview/eventLogTable.js`, hosted by the `omnetppEventLogTable`
 * webview view, `eventLogTableView.ts`). Phase U2 replaces U1's placeholder
 * empty-scroll-container with the real virtual table (`tableView.ts`): row
 * pool, custom scrollbar, selection, styled rows, and the Line Filter/Name/
 * Type/Display toolbar (built by `tableView.ts` itself into `#toolbar`, once
 * a table is actually mounted -- see this file's `mountTableIfNeeded()`).
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
let persistedState: unknown;
let table: TableViewHandle | null = null;

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
  const hasData = !!summary && !summary.isEmpty;
  empty.style.display = hasData ? 'none' : 'flex';
  if (summary && summary.isEmpty) empty.textContent = 'This event log is empty.';
  mountTableIfNeeded();
}

/** Creates the real `tableView.ts` instance the first time a non-empty summary is seen (it owns `#rows`' contents and the toolbar from then on). Rebuilding on every `render()` call would refetch/repaint for no reason -- only (re)created when the underlying file identity actually changes (a rebind to a different session). */
function mountTableIfNeeded(): void {
  if (!summary || summary.isEmpty) return;
  if (table) return;
  const root = document.getElementById('rows')!;
  table = createTableView({ root, rpc, postToHost: (m) => vscode.postMessage(m), persistedState });
  table.start();
}

function unmountTable(): void {
  table?.dispose();
  table = null;
  document.getElementById('rows')!.innerHTML = '';
  buildFallbackToolbar();
}

/**
 * A plain Refresh button, shown until a table is mounted (empty/no-summary state --
 * see `mountTableIfNeeded()`). `tableView.ts`'s own `buildToolbar()` call always clears
 * `#toolbar` first, so it cleanly replaces this the moment real data shows up.
 */
function buildFallbackToolbar(): void {
  const container = document.getElementById('toolbar')!;
  container.innerHTML = '';
  container.classList.add('elog-toolbar');
  const refreshBtn = document.createElement('button');
  refreshBtn.title = 'Refresh';
  refreshBtn.setAttribute('aria-label', 'Refresh');
  refreshBtn.innerHTML = '<span class="codicon codicon-refresh"></span>';
  refreshBtn.addEventListener('click', () => void rpc.request(ElogMethods.checkChanges, undefined));
  container.appendChild(refreshBtn);
}
buildFallbackToolbar();

watchThemeChange(() => {
  readPalette();
});

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'init': {
      const fileChanged = fileUri !== message.fileUri;
      fileUri = message.fileUri;
      summary = message.summary;
      persistedState = message.persistedState;
      if (fileChanged) unmountTable();
      render();
      break;
    }
    case 'engineResponse':
      rpc.handleResponse(message);
      break;
    case 'engineNotify': {
      if (message.event === 'elog/changed') {
        const payload = message.payload as ElogChangedParams;
        summary = payload.summary;
        render();
        table?.onEngineChanged(payload.change);
      } else if (message.event === 'elog/refreshed') {
        const payload = message.payload as CheckChangesResult;
        summary = payload.summary;
        render();
        if (payload.changed && payload.change) table?.onEngineChanged(payload.change);
      } else if (message.event === 'restarted') {
        const payload = message.payload as { summary?: LogSummary };
        if (payload?.summary) summary = payload.summary;
        unmountTable();
        render();
      }
      break;
    }
    case 'reveal':
      table?.applyReveal(message.target);
      break;
    case 'setSelection':
      table?.applySetSelection(message.selection);
      break;
    case 'command':
      // No table-specific commands yet (U1 accepted-and-dropped this too).
      break;
  }
});

vscode.postMessage({ type: 'ready' });
render();
