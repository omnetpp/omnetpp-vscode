import * as vscode from 'vscode';
import type { WebviewToHostMessage } from '@omnetpp/shared/ui-protocol';
import type { EventLogController } from './eventLogController';
import type { EventLogSession } from './eventLogSession';
import { handleWebviewMessage } from './sequenceChartEditor';
import { buildEventLogWebviewHtml } from './webviewHtml';

export const EVENT_LOG_TABLE_VIEW_ID = 'omnetppEventLogTable';

/** Context key mirroring the pin toggle's own state -- gates which view/title icon (pin vs. unpin) is shown. */
const CONTEXT_TABLE_PINNED = 'omnetpp.eventlogTablePinned';

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

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: EventLogController,
  ) {
    controller.onDidChangeActiveSession((session) => {
      if (!this.pinned) this.rebind(session ? vscode.Uri.parse(session.uriString) : undefined);
    });
  }

  static register(context: vscode.ExtensionContext, controller: EventLogController): { provider: EventLogTableViewProvider; disposable: vscode.Disposable } {
    const provider = new EventLogTableViewProvider(context.extensionUri, controller);
    const disposable = vscode.window.registerWebviewViewProvider(EVENT_LOG_TABLE_VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    });
    return { provider, disposable };
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };
    webviewView.webview.html = buildEventLogWebviewHtml(webviewView.webview, this.extensionUri, 'eventLogTable.js', 'OMNeT++ Event Log');

    webviewView.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
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
    });
  }

  private boundUriFor(session: EventLogSession): vscode.Uri {
    return vscode.Uri.parse(session.uriString);
  }

  private currentSession(): EventLogSession | undefined {
    return this.boundUri ? this.controller.getSession(this.boundUri) : undefined;
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
      void this.view.webview.postMessage({ type: 'init', fileUri: '', persistedState: undefined, settings: {}, summary: null });
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
      persistedState: undefined,
      settings: {},
      summary: session.summary,
    });
  }

  // ---- pin/unpin (omnetpp.eventlog.pinEventLogTable) -----------------------------------

  isPinned(): boolean {
    return this.pinned;
  }

  togglePin(): void {
    this.pinned = !this.pinned;
    void vscode.commands.executeCommand('setContext', CONTEXT_TABLE_PINNED, this.pinned);
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
