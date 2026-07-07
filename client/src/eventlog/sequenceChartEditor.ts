import * as path from 'node:path';
import * as vscode from 'vscode';
import type { EventLogUiSettings, HostToWebviewMessage, WebviewToHostMessage } from '@omnetpp/shared/ui-protocol';
import { handleToggleBookmarkMessage } from './bookmarks';
import type { EventLogController } from './eventLogController';
import type { EventLogSession } from './eventLogSession';
import { buildEventLogWebviewHtml } from './webviewHtml';

const VIEW_TYPE = 'omnetpp.sequenceChart';
/** Exported for `eventLogDialogs.ts`'s `openFilterPanelForSession()` (phase U7 -- "if no chart editor visible, open one"), so it doesn't need to duplicate/guess this string. */
export const SEQUENCE_CHART_VIEW_TYPE = VIEW_TYPE;

/**
 * Phase U5: `workspaceState` key for the chart's persisted UI state (currently:
 * timeline mode + the ~25 Show/Hide toggles, `client/webview/src/eventlog/chart/
 * displayFlags.ts`), keyed by file URI string -- a plain `Record<string, unknown>` blob
 * per uri, mirroring `eventLogTableView.ts`'s `TABLE_STATE_KEY` pattern exactly (that
 * file's own header previously noted the chart editor "has no comparable per-uri state
 * yet" -- this phase adds it, since the Show/Hide toggles are meant to survive a full
 * window reload, not just a webview hide/show).
 */
const CHART_STATE_KEY = 'omnetpp.eventlog.chartState';

/**
 * The `CustomDocument` VS Code hands back from `openCustomDocument()`. It has
 * (deliberately) no state of its own beyond the uri -- the session registry in
 * `EventLogController` is the durable owner (port plan: "session host-side is
 * the durable owner"). `dispose()` is called by VS Code once every editor
 * showing this document has closed (the built-in "tabGroups close detection"
 * hook for custom editors -- there is no need to also listen on
 * `vscode.window.tabGroups` directly, `CustomDocument.dispose()` already IS
 * that signal, scoped correctly per-document).
 */
class SequenceChartDocument implements vscode.CustomDocument {
  constructor(
    readonly uri: vscode.Uri,
    private readonly onDispose: () => void,
  ) {}
  dispose(): void {
    this.onDispose();
  }
}

/**
 * The Sequence Chart custom editor (`*.elog`, read-only -- a viewer, never an
 * editable document, hence `CustomReadonlyEditorProvider`). Per-webview it:
 *  1. builds the CSP'd HTML shell (chart.js script + codicons),
 *  2. attaches the webview to the file's `EventLogSession` as a `MessageSink`,
 *  3. runs the message pump: `ready` -> push `init`; `engineRequest` -> proxy
 *     through `session.handleEngineRequest()` and reply with `engineResponse`.
 *
 * No `WebviewPanelSerializer` is registered (and none is needed): custom
 * editors persist and restore themselves automatically through
 * `openCustomDocument()`/`resolveCustomEditor()` -- VS Code remembers the
 * `viewType` + resource URI across window reloads and simply re-invokes the
 * same provider, the same way `openCustomDocument` is invoked on first open.
 * (Verified against `vscode.d.ts`: `registerCustomEditorProvider()` takes no
 * serializer option at all -- unlike `registerWebviewPanelSerializer()`, which
 * is a *different*, `createWebviewPanel()`-only API this provider never uses.)
 */
export class SequenceChartEditorProvider implements vscode.CustomReadonlyEditorProvider<SequenceChartDocument> {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: EventLogController,
    private readonly workspaceState: vscode.Memento,
  ) {}

  static register(context: vscode.ExtensionContext, controller: EventLogController): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      new SequenceChartEditorProvider(context.extensionUri, controller, context.workspaceState),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false },
    );
  }

  // ---- persisted chart UI state (phase U5) -------------------------------------------

  private getPersistedState(uriString: string): unknown {
    return this.workspaceState.get<Record<string, unknown>>(CHART_STATE_KEY, {})[uriString];
  }

  private async setPersistedState(uriString: string, state: unknown): Promise<void> {
    const all = this.workspaceState.get<Record<string, unknown>>(CHART_STATE_KEY, {});
    await this.workspaceState.update(CHART_STATE_KEY, { ...all, [uriString]: state });
  }

  async openCustomDocument(uri: vscode.Uri): Promise<SequenceChartDocument> {
    // Acquire (spawn + open, or reuse) the session BEFORE returning the
    // document, so resolveCustomEditor() below can always find it synchronously.
    await this.controller.acquireSession(uri);
    return new SequenceChartDocument(uri, () => {
      if (this.controller.getActiveSession()?.uriString === uri.toString()) this.controller.setActiveUri(undefined);
    });
  }

  resolveCustomEditor(document: SequenceChartDocument, webviewPanel: vscode.WebviewPanel): void {
    const session = this.controller.getSession(document.uri);
    if (!session) {
      // Should not happen (openCustomDocument always acquires first), but fail
      // visibly rather than silently showing a blank panel.
      webviewPanel.webview.html = `<html><body>OMNeT++: failed to open event log session for ${document.uri.fsPath}</body></html>`;
      return;
    }

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };
    webviewPanel.webview.html = buildEventLogWebviewHtml(webviewPanel.webview, this.extensionUri, 'sequenceChart.js', 'OMNeT++ Sequence Chart');
    webviewPanel.title = `${basename(document.uri)} — Sequence Chart`;

    const sink = webviewPanel.webview;
    session.attach('chart', sink);

    if (webviewPanel.active) this.controller.setActiveUri(document.uri.toString());
    webviewPanel.onDidChangeViewState((e) => {
      this.controller.setActiveUri(e.webviewPanel.active ? document.uri.toString() : undefined);
    });
    webviewPanel.onDidDispose(() => {
      session.detach('chart', sink);
      if (this.controller.getActiveSession()?.uriString === document.uri.toString()) this.controller.setActiveUri(undefined);
    });

    webviewPanel.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      const uriString = document.uri.toString();
      // Phase U5: intercept 'ready'/'stateChanged' before the chart/table-shared
      // handleWebviewMessage() (whose generic 'ready' always sends `persistedState:
      // undefined` and whose 'stateChanged' is a no-op stub) -- same pattern
      // eventLogTableView.ts already uses for its own per-uri table state.
      if (message.type === 'ready') {
        const settings = readEventLogUiSettings();
        sink.postMessage({
          type: 'init',
          fileUri: uriString,
          persistedState: this.getPersistedState(uriString),
          settings,
          summary: session.summary,
          selection: session.getSelection(),
          bookmarks: this.controller.getBookmarkStore(document.uri).list(),
          filterParams: session.getCurrentFilterParams(),
        });
        // Phase U7: "if no chart editor visible, open one" -- `openFilterPanelForSession()`
        // set this flag because no chart webview was attached yet to `sendCommand()` to;
        // now that one just sent `init`, pop the filter panel open immediately.
        if (session.consumeOpenFilterOnAttach()) sink.postMessage({ type: 'command', command: 'toggleFilterPanel' });
        return;
      }
      if (message.type === 'stateChanged') {
        void this.setPersistedState(uriString, message.state);
        return;
      }
      // Phase U6: bookmarks need the controller (for its per-uri BookmarkStore), which
      // the chart/table-shared handleWebviewMessage() below doesn't have access to --
      // same "intercept before the shared function" pattern as 'ready'/'stateChanged'.
      if (message.type === 'toggleBookmark') {
        void handleToggleBookmarkMessage(this.controller.getBookmarkStore(document.uri), session, message.candidate);
        return;
      }
      void handleWebviewMessage(session, sink, document.uri, message);
    });
  }
}

function basename(uri: vscode.Uri): string {
  return uri.fsPath.split(/[\\/]/).pop() ?? uri.fsPath;
}

/**
 * Per-sink table of `CancellationTokenSource`s for currently-in-flight `engineRequest`
 * ids (phase U4, real RPC cancellation -- see `common/rpc.ts`'s header). Keyed by
 * `sink` (each webview's own `EngineRpc` numbers its requests independently starting
 * at 1, so two different webviews' ids collide; a `WeakMap` scopes the id table to the
 * sink it belongs to, and lets an unreferenced sink's table be GC'd once the webview is
 * disposed without any explicit cleanup code needed here).
 */
const cancellationSources = new WeakMap<object, Map<number, vscode.CancellationTokenSource>>();

function sourcesFor(sink: object): Map<number, vscode.CancellationTokenSource> {
  let map = cancellationSources.get(sink);
  if (!map) {
    map = new Map();
    cancellationSources.set(sink, map);
  }
  return map;
}

/**
 * Shared message-pump body (used verbatim by `eventLogTableView.ts` too): the
 * `ready`/`engineRequest`/`selectionChanged`/`stateChanged` handling is
 * identical regardless of which webview (chart or table) sent it -- only the
 * `AttachmentKind` used for `session.attach()`/`detach()` differs, and that's
 * already baked into the caller by the time this runs.
 */
export async function handleWebviewMessage(
  session: EventLogSession,
  sink: { postMessage(message: HostToWebviewMessage): void },
  uri: vscode.Uri,
  message: WebviewToHostMessage,
): Promise<void> {
  switch (message.type) {
    case 'ready': {
      // Dead in practice: both `sequenceChartEditor.ts` and `eventLogTableView.ts`
      // intercept 'ready' themselves (to send a per-uri `persistedState`/bookmark list
      // this generic fallback has no access to -- no `controller` reference here) --
      // kept only so this shared function stays a complete, correctly-typed handler in
      // its own right.
      const settings = readEventLogUiSettings();
      const init: HostToWebviewMessage = {
        type: 'init',
        fileUri: uri.toString(),
        persistedState: undefined,
        settings,
        summary: session.summary,
        selection: session.getSelection(),
        bookmarks: [],
        filterParams: session.getCurrentFilterParams(),
      };
      sink.postMessage(init);
      break;
    }
    case 'engineRequest': {
      const sources = sourcesFor(sink);
      const cts = new vscode.CancellationTokenSource();
      sources.set(message.id, cts);
      try {
        const result = await session.handleEngineRequest(message.method, message.params, cts.token);
        sink.postMessage({ type: 'engineResponse', id: message.id, result });
      } catch (err) {
        sink.postMessage({
          type: 'engineResponse',
          id: message.id,
          error: { message: err instanceof Error ? err.message : String(err) },
        });
      } finally {
        sources.delete(message.id);
        cts.dispose();
      }
      break;
    }
    case 'cancelRequest': {
      const cts = sourcesFor(sink).get(message.id);
      cts?.cancel(); // no-op if the id already finished/was never issued (see the WeakMap's own doc comment)
      break;
    }
    case 'selectionChanged':
      session.setSelection(message.selection, sink);
      break;
    case 'revealRequest':
      session.reveal(message.target);
      break;
    case 'stateChanged':
      // U1: no persistence matrix yet (that's a later phase's job per the port
      // plan's "State persistence" section) -- accepted and dropped for now so
      // the webview's `stateChanged` postMessage never errors.
      break;
    case 'export':
      await handleExport(message, uri);
      break;
    case 'contextValue':
      void vscode.commands.executeCommand('setContext', message.key, message.value);
      break;
    case 'toggleBookmark':
      // Always intercepted before reaching here (needs the controller's per-uri
      // BookmarkStore -- see both callers' own 'toggleBookmark' handling) -- present
      // only so this switch stays a complete, self-documenting map of every message
      // type, matching this function's own "shared message-pump body" header.
      break;
    case 'requestFilterPanel':
      // Only ever sent by the Event Log table webview (the chart toggles its own panel
      // locally, no host round trip needed) -- intercepted before this shared function
      // in `eventLogTableView.ts` (needs the controller to resolve/open a chart
      // editor). Present here only so this switch stays a complete map of every
      // message type.
      break;
  }
}

async function handleExport(message: Extract<WebviewToHostMessage, { type: 'export' }>, uri: vscode.Uri): Promise<void> {
  const filters: Record<string, string[]> = message.format === 'svg' ? { 'SVG image': ['svg'] } : { 'PNG image': ['png'] };
  const dir = uri.scheme === 'file' ? path.dirname(uri.fsPath) : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '');
  const target = await vscode.window.showSaveDialog({ filters, defaultUri: vscode.Uri.file(path.join(dir, message.suggestedName)) });
  if (!target) return;
  const bytes = message.format === 'svg' ? Buffer.from(message.data, 'utf8') : Buffer.from(message.data, 'base64');
  await vscode.workspace.fs.writeFile(target, bytes);
  void vscode.window.showInformationMessage(`OMNeT++: exported to ${target.fsPath}`);
}

/** Reads the `omnetpp.sequenceChart.*`/`omnetpp.eventlog.*` settings into the `init` message's `settings` field. */
function readEventLogUiSettings(): EventLogUiSettings {
  const config = vscode.workspace.getConfiguration('omnetpp');
  return {
    sequenceChart: {
      defaultTimelineMode: config.get<string>('sequenceChart.defaultTimelineMode', 'SIMULATION_TIME'),
      fontSize: config.get<number>('sequenceChart.fontSize', 0) || undefined,
    },
    eventlog: {
      followEndOnAppend: config.get<boolean>('eventlog.followEndOnAppend', true),
      maxEngineMemoryMB: config.get<number>('eventlog.maxEngineMemoryMB', 0) || undefined,
    },
  };
}
