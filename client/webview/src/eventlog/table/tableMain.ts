import { ElogMethods, type ElogChangedParams, type CheckChangesResult, type LogSummary } from '@omnetpp/shared/elog-protocol';
import type { Bookmark, HostToWebviewMessage, WebviewToHostMessage } from '@omnetpp/shared/ui-protocol';
import { EngineRpc } from '../common/rpc';
import { classifyEngineError, mountNotificationOverlay } from '../common/notificationOverlay';
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
/** Phase U6 -- the session's current bookmark list, kept even while no table is mounted yet (an empty/not-yet-loaded summary) so `mountTableIfNeeded()` can seed a fresh `TableViewHandle` with it immediately. */
let latestBookmarks: Bookmark[] = [];
/** Table popup Pin entry gap-closure -- the table's current pinned state, kept even while no table is mounted yet, same reasoning as `latestBookmarks` above. */
let pinned = false;
/** Event Log table row icons -- icon id -> webview URI, precomputed host-side (`eventLogTableView.ts`'s `buildEventLogTableIconMap()`) and threaded straight through to `createTableView()`; kept even while no table is mounted yet, same reasoning as `latestBookmarks`/`pinned` above. */
let iconMap: Record<string, string> = {};

document.getElementById('root')!.innerHTML = `
  <div id="toolbar"></div>
  <div id="status"></div>
  <div class="elog-body" id="body">
    <div id="rows"></div>
    <div class="elog-empty" id="empty">No event log open. Open an .elog file's Sequence Chart to populate this view, or pin it to a specific file.</div>
    <div id="notificationHost"></div>
  </div>
`;

/**
 * Phase U9 -- the shared error/canceled/out-of-sync overlay (`common/
 * notificationOverlay.ts`). "Refresh" forces an immediate file-change check AND
 * unconditionally retries the table's current window (`refreshCurrentWindow()`),
 * exactly like `chartMain.ts`'s own `refreshFromOverlay()`.
 */
const notificationOverlay = mountNotificationOverlay(document.getElementById('notificationHost')!, () => {
  void rpc.request(ElogMethods.checkChanges, undefined);
  table?.refreshCurrentWindow();
});

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
  table = createTableView({
    root,
    rpc,
    postToHost: (m) => vscode.postMessage(m),
    persistedState,
    initialBookmarks: latestBookmarks,
    initialPinned: pinned,
    iconMap,
    onError: (err) => notificationOverlay.show(classifyEngineError(err)!),
  });
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
      latestBookmarks = message.bookmarks;
      pinned = message.pinned;
      iconMap = message.iconMap ?? {};
      if (fileChanged) unmountTable();
      render();
      // Phase U6: seed the (possibly freshly (re)mounted) table with the session's
      // current selection/bookmarks -- covers both "table created just now" (start()
      // already ran inside render()/mountTableIfNeeded(), applySetSelection below then
      // overrides its default first-row anchor) and "table already existed, session
      // rebound underneath it" (a pinned table switching sessions -- see
      // `eventLogTableView.ts`'s `attachToCurrent()`).
      table?.applySetSelection(message.selection);
      table?.setBookmarks(message.bookmarks);
      table?.setPinned(message.pinned);
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
      } else if (message.event === 'elog/filterChanged') {
        // ADDITIVE (phase U7): always triggered by the Sequence Chart's filter panel
        // (the table has no filter panel of its own) -- see `tableView.ts`'s
        // `onFilterChanged()` doc comment for the re-anchor semantics this ports.
        const payload = message.payload as { summary: LogSummary };
        summary = payload.summary;
        render();
        table?.onFilterChanged();
      } else if (message.event === 'elog/memoryReleased') {
        // ADDITIVE (phase U9) -- "Release Memory" (triggered from the Sequence Chart,
        // the native command, or this table itself has no menu item of its own): the
        // engine's parsed-event cache was dropped, so re-resolve the SAME window this
        // table was showing (content is unchanged, only re-parsed) -- same re-anchor
        // semantics as `onFilterChanged()`, not a reset to the first row.
        const payload = message.payload as { summary: LogSummary };
        summary = payload.summary;
        render();
        table?.onFilterChanged();
      }
      break;
    }
    case 'reveal':
      table?.applyReveal(message.target);
      break;
    case 'setSelection':
      table?.applySetSelection(message.selection);
      break;
    case 'bookmarksChanged':
      latestBookmarks = message.bookmarks;
      table?.setBookmarks(message.bookmarks);
      break;
    case 'pinnedChanged':
      // Table popup Pin entry gap-closure -- the host's `togglePin()` confirmed a new
      // state (either from this webview's own menu item or the native view-title
      // commands); keep `pinned` current even while no table is mounted, same reasoning
      // as `latestBookmarks` above.
      pinned = message.pinned;
      table?.setPinned(message.pinned);
      break;
    case 'command':
      if (message.command === 'resetViewState') {
        // "OMNeT++: Reset Event Log View State": the host wiped the persisted blob;
        // remount the table with defaults (the table has no webview-local state of its
        // own -- everything flows from `persistedState`, see `render()`).
        persistedState = undefined;
        unmountTable();
        render();
      } else if (message.command === 'openFindTextDialog') {
        // Table find parity gap-closure -- `omnetpp.eventlog.findText` routed here
        // (`eventLogDialogs.ts`) because this table currently has focus; unlike the
        // chart, the table has no modal dialog, so this just opens/focuses the
        // existing inline find bar (`tableView.ts`'s `openFindBar()`).
        table?.openFindBar();
      } else if (message.command === 'findNext') {
        // Table find parity gap-closure -- `omnetpp.eventlog.findNext` routed here.
        table?.repeatFind();
      }
      break;
  }
});

vscode.postMessage({ type: 'ready' });
render();
