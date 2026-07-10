import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import type { EventLogUiSettings, WebviewToHostMessage } from '@omnetpp/shared/ui-protocol';
import { handleToggleBookmarkMessage } from './bookmarks';
import type { EventLogController } from './eventLogController';
import { openFilterPanelForSession } from './eventLogDialogs';
import type { EventLogSession } from './eventLogSession';
import { gotoNedDeclaration } from './nedNavigation';
import { handleWebviewMessage } from './sequenceChartEditor';
import { buildEventLogWebviewHtml } from './webviewHtml';

export const EVENT_LOG_TABLE_VIEW_ID = 'omnetppEventLogTable';

/** Context key mirroring the pin toggle's own state -- gates which view/title icon (pin vs. unpin) is shown. */
const CONTEXT_TABLE_PINNED = 'omnetpp.eventlogTablePinned';

/**
 * Phase U2: `workspaceState` key for the table's persisted UI state (Line Filter/Name/
 * Type/Display mode dropdowns), keyed by file URI string -- a plain `Record<string,
 * unknown>` blob per uri, matching uiProtocol.ts's `stateChanged`/`persistedState`
 * contract ("opaque per-webview UI state to persist"). Kept local to this file
 * (not shared with the Sequence Chart editor, which has no comparable per-uri state
 * yet) so this phase does not need to touch `sequenceChartEditor.ts`.
 */
export const TABLE_STATE_KEY = 'omnetpp.eventlog.tableState';

/**
 * Duplicates `sequenceChartEditor.ts`'s private `readEventLogUiSettings()` (a handful
 * of `omnetpp.*` config reads) rather than exporting/importing it -- this phase's
 * concurrency contract keeps `sequenceChartEditor.ts` untouched (a concurrent agent may
 * be editing chart-side files), and the duplication is a few lines of pure config
 * reads, not worth a shared-module edit to save.
 */
function readEventLogUiSettingsForTable(): EventLogUiSettings {
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

/**
 * Row-icon map (Event Log table icons, see `RenderedTableRow.iconId`/`uiProtocol.ts`'s
 * `iconMap` doc comment): resolves every `dist/icons/_internal/eventlog/*.png` bundled by
 * `scripts/gen-icons.mjs` to a webview URI, keyed by icon id (e.g. `"ModuleCreated"`).
 * Computed once per `webviewView.webview` (an `asWebviewUri()` result is only valid for
 * the webview instance it was resolved against) rather than per request -- this set is
 * small (~32 entries) and entirely static, unlike the NED preview's dynamic
 * display-string icon ids (`nedPreviewPanel.ts`'s `resolveIcons()`). Returns an empty map
 * (table degrades to no row icons) if the directory is missing, e.g.
 * `scripts/gen-icons.mjs` was never run against an OMNeT++ source tree.
 */
function buildEventLogTableIconMap(webview: vscode.Webview, extensionUri: vscode.Uri): Record<string, string> {
  const dirUri = vscode.Uri.joinPath(extensionUri, 'dist', 'icons', '_internal', 'eventlog');
  const map: Record<string, string> = {};
  try {
    for (const entry of fs.readdirSync(dirUri.fsPath)) {
      if (!entry.endsWith('.png')) continue;
      map[entry.slice(0, -'.png'.length)] = webview.asWebviewUri(vscode.Uri.joinPath(dirUri, entry)).toString();
    }
  } catch {
    // dist/icons/_internal/eventlog missing -- degrade gracefully, no row icons.
  }
  return map;
}

/**
 * The "OMNeT++ Event Log" panel's table webview view. Per the port plan: "binds
 * to the active session unless pinned" -- when unpinned it follows
 * `EventLogController.onDidChangeActiveSession`; `pin()`/`unpin()` (the
 * `omnetpp.eventlog.pinEventLogTable` command) freezes it on whichever session
 * is bound at the time.
 *
 * Row rendering (virtual scroll, U2) is out of scope here: this phase only
 * needs the view to exist, receive `init`/`engineNotify` for a real summary,
 * and structurally support rebinding -- so U2 can drop the row pool in without
 * touching this file's plumbing.
 */
export class EventLogTableViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private boundUri: vscode.Uri | undefined;
  private pinned = false;
  /**
   * Table find parity gap-closure -- mirrors `sequenceChartEditor.ts`'s
   * `webviewPanel.active` tracking, but `vscode.WebviewView` (this view's host) has no
   * built-in focus/active event the way `vscode.WebviewPanel.onDidChangeViewState`
   * does, so the webview reports its own DOM focus state explicitly via the
   * `tableFocusChanged` message (see `uiProtocol.ts`'s doc comment on that message and
   * `tableView.ts`'s `root`-level `focusin`/`focusout` delegation). Read by
   * `eventLogDialogs.ts`'s `findTextCommand`/`findNextCommand` to decide whether
   * `omnetpp.eventlog.findText`/`.findNext` should route into this view's own inline
   * find bar instead of the Sequence Chart's dialog.
   */
  private focused = false;
  /** Row-icon id -> webview URI map for the currently-resolved `view`; see `buildEventLogTableIconMap()`. Recomputed each time `resolveWebviewView()` runs (a fresh webview instance needs its own `asWebviewUri()` resolution). Empty until the view is first resolved. */
  private iconMap: Record<string, string> = {};

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: EventLogController,
    private readonly workspaceState: vscode.Memento,
    /** Phase U10 -- for `gotoNedDeclaration` messages (`nedNavigation.ts`), same role `SequenceChartEditorProvider`'s own field plays; `undefined` degrades to a status message. */
    private readonly languageClient?: LanguageClient,
  ) {
    controller.onDidChangeActiveSession((session) => {
      if (!this.pinned) this.rebind(session ? vscode.Uri.parse(session.uriString) : undefined);
    });
  }

  static register(context: vscode.ExtensionContext, controller: EventLogController, languageClient?: LanguageClient): { provider: EventLogTableViewProvider; disposable: vscode.Disposable } {
    const provider = new EventLogTableViewProvider(context.extensionUri, controller, context.workspaceState, languageClient);
    const disposable = vscode.window.registerWebviewViewProvider(EVENT_LOG_TABLE_VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    });
    return { provider, disposable };
  }

  // ---- persisted table UI state (phase U2) -------------------------------------------

  private getPersistedState(uriString: string): unknown {
    return this.workspaceState.get<Record<string, unknown>>(TABLE_STATE_KEY, {})[uriString];
  }

  private async setPersistedState(uriString: string, state: unknown): Promise<void> {
    const all = this.workspaceState.get<Record<string, unknown>>(TABLE_STATE_KEY, {});
    await this.workspaceState.update(TABLE_STATE_KEY, { ...all, [uriString]: state });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'), vscode.Uri.joinPath(this.extensionUri, 'dist', 'icons')],
    };
    webviewView.webview.html = buildEventLogWebviewHtml(webviewView.webview, this.extensionUri, 'eventLogTable.js', 'OMNeT++ Event Log');
    this.iconMap = buildEventLogTableIconMap(webviewView.webview, this.extensionUri);

    webviewView.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      // Phase U2: 'copyText' (Ctrl+C) and 'stateChanged' (mode-dropdown persistence)
      // are table-specific enough to handle right here rather than growing the
      // chart/table-shared `handleWebviewMessage()` -- see this file's header on why
      // `sequenceChartEditor.ts` stays untouched this phase.
      if (message.type === 'copyText') {
        void vscode.env.clipboard.writeText(message.text);
        return;
      }
      if (message.type === 'stateChanged') {
        if (this.boundUri) void this.setPersistedState(this.boundUri.toString(), message.state);
        return;
      }
      // Table find parity gap-closure -- see `focused`'s own doc comment above.
      if (message.type === 'tableFocusChanged') {
        this.focused = message.focused;
        return;
      }
      // Table popup Pin entry gap-closure -- the webview's own context menu's
      // "Pin"/"Unpin" item; reuses the exact same `togglePin()` the native
      // `omnetpp.eventlog.pinEventLogTable`/`.unpinEventLogTable` commands already call
      // (see that method's own doc comment for why a single toggle, not a pin/unpin
      // pair).
      if (message.type === 'togglePin') {
        this.togglePin();
        return;
      }
      if (message.type === 'ready') {
        const boundKey = this.boundUri?.toString();
        const persistedForLog = boundKey ? this.getPersistedState(boundKey) : undefined;
        this.controller.log(`table init for ${boundKey ?? '(unbound)'}: persistedState=${persistedForLog === undefined ? '(none)' : JSON.stringify(persistedForLog).slice(0, 400)}`);
        // Bypass handleWebviewMessage()'s generic 'ready' case (which always sends
        // `persistedState: undefined` -- U1 had no persistence matrix yet) so a fresh
        // webview reload picks the table's own remembered modes back up immediately.
        const session = this.currentSession();
        void webviewView.webview.postMessage({
          type: 'init',
          fileUri: this.boundUri?.toString() ?? '',
          persistedState: this.boundUri ? this.getPersistedState(this.boundUri.toString()) : undefined,
          settings: readEventLogUiSettingsForTable(),
          summary: session?.summary ?? null,
          selection: session?.getSelection() ?? { eventNumbers: [] },
          bookmarks: this.boundUri ? this.controller.getBookmarkStore(this.boundUri).list() : [],
          filterParams: session?.getCurrentFilterParams() ?? null,
          pinned: this.pinned,
          iconMap: this.iconMap,
        });
        return;
      }
      // Phase U6: needs the controller's per-uri BookmarkStore, which
      // handleWebviewMessage() below doesn't have access to (same "intercept before
      // the shared function" pattern as 'copyText'/'stateChanged'/'ready' above).
      if (message.type === 'toggleBookmark') {
        const session = this.currentSession();
        if (this.boundUri && session) void handleToggleBookmarkMessage(this.controller.getBookmarkStore(this.boundUri), session, message.candidate);
        return;
      }
      // Phase U7: the table has no filter panel of its own -- forward to whichever
      // session this view is currently bound to (see `uiProtocol.ts`'s
      // `requestFilterPanel` doc comment).
      if (message.type === 'requestFilterPanel') {
        const session = this.currentSession();
        if (session) void openFilterPanelForSession(session);
        return;
      }
      // Phase U10: "Go to NED Declaration" -- needs the LanguageClient, same
      // "intercept before the shared function" pattern as the cases above (mirrors
      // `sequenceChartEditor.ts`'s own `nedTypeQuery`/`gotoNedDeclaration` handling).
      if (message.type === 'gotoNedDeclaration') {
        void gotoNedDeclaration(this.languageClient, message.typeName);
        return;
      }
      const session = this.currentSession();
      if (!session) return;
      void handleWebviewMessage(session, webviewView.webview, this.boundUri!, message);
    });

    // (Re-)attach to whatever session is currently the target, e.g. the view
    // was hidden and is only now being resolved for the first time since a
    // session became active.
    if (!this.pinned) this.rebind(this.controller.getActiveSession() ? this.boundUriFor(this.controller.getActiveSession()!) : undefined);
    else if (this.boundUri) this.attachToCurrent();

    webviewView.onDidDispose(() => {
      if (this.boundUri) this.currentSession()?.detach('table', webviewView.webview);
      this.view = undefined;
      this.focused = false; // Table find parity gap-closure -- a disposed view can't be focused
    });
    // Table find parity gap-closure -- safety net alongside the webview's own
    // `tableFocusChanged` message: if the panel is hidden (e.g. the user switched to a
    // different sidebar view) it cannot possibly have DOM focus either, even on the
    // off chance the webview's own focusout never fires (e.g. hidden while a dialog/
    // devtools had stolen focus).
    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) this.focused = false;
    });
  }

  private boundUriFor(session: EventLogSession): vscode.Uri {
    return vscode.Uri.parse(session.uriString);
  }

  private currentSession(): EventLogSession | undefined {
    return this.boundUri ? this.controller.getSession(this.boundUri) : undefined;
  }

  /** Public accessor for whichever session this panel is currently bound to (pinned or following the active chart editor) -- used by `bookmarks.ts`'s `showBookmarksCommand()` as a fallback when no Sequence Chart editor happens to be focused (e.g. invoked from THIS panel's own view/title, per package.json). */
  getBoundSession(): EventLogSession | undefined {
    return this.currentSession();
  }

  /** Table find parity gap-closure -- see `focused`'s own doc comment; used by `eventLogDialogs.ts`'s `findTextCommand`/`findNextCommand` to decide whether to route into this view's inline find bar instead of the Sequence Chart's dialog. */
  hasFocus(): boolean {
    return this.focused;
  }

  /** Detach from the old session (if any) and attach to `uri`'s session (if any); pushes a fresh `init` so the view re-renders immediately with the new summary. */
  private rebind(uri: vscode.Uri | undefined): void {
    if (this.boundUri?.toString() === uri?.toString()) return;
    if (this.view && this.boundUri) this.currentSession()?.detach('table', this.view.webview);
    this.boundUri = uri;
    if (this.view && uri) this.attachToCurrent();
    else if (this.view) {
      // No active session anymore (e.g. all chart editors closed while unpinned) --
      // let the webview fall back to its own empty state.
      void this.view.webview.postMessage({ type: 'init', fileUri: '', persistedState: undefined, settings: readEventLogUiSettingsForTable(), summary: null, selection: { eventNumbers: [] }, bookmarks: [], filterParams: null, pinned: this.pinned, iconMap: this.iconMap });
    }
  }

  private attachToCurrent(): void {
    if (!this.view || !this.boundUri) return;
    const session = this.currentSession();
    if (!session) return;
    session.attach('table', this.view.webview);
    void this.view.webview.postMessage({
      type: 'init',
      fileUri: this.boundUri.toString(),
      persistedState: this.getPersistedState(this.boundUri.toString()),
      settings: readEventLogUiSettingsForTable(),
      summary: session.summary,
      selection: session.getSelection(),
      bookmarks: this.controller.getBookmarkStore(this.boundUri).list(),
      filterParams: session.getCurrentFilterParams(),
      pinned: this.pinned,
      iconMap: this.iconMap,
    });
  }

  // ---- pin/unpin (omnetpp.eventlog.pinEventLogTable) -----------------------------------

  isPinned(): boolean {
    return this.pinned;
  }

  togglePin(): void {
    this.pinned = !this.pinned;
    void vscode.commands.executeCommand('setContext', CONTEXT_TABLE_PINNED, this.pinned);
    // Table popup Pin entry gap-closure -- keep the webview's own context-menu
    // checkmark/label in sync whether the toggle came from the native view-title
    // commands or the webview's own menu item (which already knows locally, but this
    // keeps a single source of truth rather than the webview optimistically flipping
    // its own state before the host confirms).
    if (this.view) void this.view.webview.postMessage({ type: 'pinnedChanged', pinned: this.pinned });
    if (!this.pinned) this.rebind(this.controller.getActiveSession() ? this.boundUriFor(this.controller.getActiveSession()!) : undefined);
  }

  /** "Refresh" (view/title) -- refreshes whichever session the table is currently bound to (independent of which chart editor is active, so a pinned table refreshes the pinned file). */
  async refresh(): Promise<void> {
    await this.currentSession()?.refresh();
  }

  reveal(): void {
    void vscode.commands.executeCommand(`${EVENT_LOG_TABLE_VIEW_ID}.focus`);
  }
}
