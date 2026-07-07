/**
 * EventLogController -- the session registry keyed by file URI, plus the
 * "which chart editor is currently active" tracking the port plan's U1 row
 * asks for ("active-editor tracking via editor webview panel
 * onDidChangeViewState + tabGroups close detection; sets context keys").
 *
 * This is the one `vscode`-importing piece of the trio (`eventLogSession.ts`
 * stays vscode-free); `sequenceChartEditor.ts` and `eventLogTableView.ts` both
 * go through this to acquire/release sessions and to find "the active one".
 */

import * as vscode from 'vscode';
import type { LogSummary } from '@omnetpp/shared/elog-protocol';
import { BookmarkStore } from './bookmarks';
import { EventLogSession, eventlogWorkerBundlePath, type AttachmentKind, type MessageSink } from './eventLogSession';

/** Context key kept true while at least one `.elog` session is open -- gates the panel's webview view (`when: omnetpp.eventlogOpen`, package.json). */
const CONTEXT_EVENTLOG_OPEN = 'omnetpp.eventlogOpen';

export class EventLogController {
  private readonly sessions = new Map<string, EventLogSession>();
  private readonly pendingOpens = new Map<string, Promise<EventLogSession>>();
  /** One `BookmarkStore` per file uri (phase U6) -- created lazily, on first access, and kept for the lifetime of the extension host (bookmarks must remain reachable -- e.g. for "Show Bookmarks" -- even while no session/webview for that file happens to be open). */
  private readonly bookmarkStores = new Map<string, BookmarkStore>();
  private activeUri: string | undefined;

  private readonly activeChangedEmitter = new vscode.EventEmitter<EventLogSession | undefined>();
  /** Fires whenever the "active" session (the one behind the focused Sequence Chart editor tab) changes -- the Event Log table view rebinds to this unless pinned. */
  readonly onDidChangeActiveSession = this.activeChangedEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Every currently open session (for bulk operations, e.g. `deactivate()`). */
  allSessions(): EventLogSession[] {
    return [...this.sessions.values()];
  }

  getSession(uri: vscode.Uri): EventLogSession | undefined {
    return this.sessions.get(uri.toString());
  }

  /** The session behind the currently focused Sequence Chart editor tab, if any. */
  getActiveSession(): EventLogSession | undefined {
    return this.activeUri ? this.sessions.get(this.activeUri) : undefined;
  }

  /**
   * Returns the existing session for `uri`, or spawns a worker and opens the
   * file for the first time. Concurrent calls for the same not-yet-open uri
   * (e.g. two split editors resolving in quick succession) share one
   * in-flight open via `pendingOpens`, so the worker is spawned exactly once.
   */
  async acquireSession(uri: vscode.Uri): Promise<EventLogSession> {
    const key = uri.toString();
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const pending = this.pendingOpens.get(key);
    if (pending) return pending;

    const promise = this.openNewSession(uri, key);
    this.pendingOpens.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pendingOpens.delete(key);
    }
  }

  private async openNewSession(uri: vscode.Uri, key: string): Promise<EventLogSession> {
    const bundlePath = eventlogWorkerBundlePath(this.context.extensionUri.fsPath);
    const session = new EventLogSession(key, uri.fsPath, bundlePath, {
      onIdle: () => this.removeSession(key),
    });
    this.sessions.set(key, session);
    this.syncOpenContext();
    try {
      await session.initialize();
    } catch (err) {
      // Opening failed (bad file, worker crashed before responding, ...) -- do
      // not leave a half-dead session registered; surface the error to the caller
      // (openCustomDocument()/resolveWebviewView() will show it).
      session.dispose();
      this.sessions.delete(key);
      this.syncOpenContext();
      throw err;
    }
    return session;
  }

  private removeSession(key: string): void {
    this.sessions.delete(key);
    if (this.activeUri === key) this.setActiveUri(undefined);
    this.syncOpenContext();
  }

  private syncOpenContext(): void {
    void vscode.commands.executeCommand('setContext', CONTEXT_EVENTLOG_OPEN, this.sessions.size > 0);
  }

  /** Called by `sequenceChartEditor.ts` when a chart webview panel gains/loses focus (`onDidChangeViewState`) or is disposed. */
  setActiveUri(uriString: string | undefined): void {
    if (this.activeUri === uriString) return;
    this.activeUri = uriString;
    this.activeChangedEmitter.fire(this.getActiveSession());
  }

  // ---- convenience wrappers used by command handlers -----------------------------------

  attach(uri: vscode.Uri, kind: AttachmentKind, sink: MessageSink): void {
    this.sessions.get(uri.toString())?.attach(kind, sink);
  }

  detach(uri: vscode.Uri, kind: AttachmentKind, sink: MessageSink): void {
    this.sessions.get(uri.toString())?.detach(kind, sink);
  }

  /** The bookmark store for `uri`'s file, created on first access and reused thereafter. */
  getBookmarkStore(uri: vscode.Uri): BookmarkStore {
    const key = uri.toString();
    let store = this.bookmarkStores.get(key);
    if (!store) {
      store = new BookmarkStore(this.context.workspaceState, key);
      this.bookmarkStores.set(key, store);
    }
    return store;
  }

  async refreshActive(): Promise<LogSummary | undefined> {
    const session = this.getActiveSession();
    if (!session) return undefined;
    const result = await session.refresh();
    return result.summary;
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    this.activeChangedEmitter.dispose();
  }
}
