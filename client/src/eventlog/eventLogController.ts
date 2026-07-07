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
import type { ElogOpenOptions, FilterParams, LogSummary } from '@omnetpp/shared/elog-protocol';
import { BookmarkStore } from './bookmarks';
import { CHART_STATE_KEY } from './sequenceChartEditor';
import { TABLE_STATE_KEY } from './eventLogTableView';
import { EventLogSession, eventlogWorkerBundlePath, type AttachmentKind, type MessageSink } from './eventLogSession';

/**
 * Phase U10 -- `omnetpp.eventlog.maxEngineMemoryMB` -> `ElogOpenOptions.eventCacheLimit`
 * (an EVENT COUNT, the only cache-cap knob the phase-E7 in-memory `EventLog` LRU
 * exposes -- see `shared/src/eventlog/eventLog.ts`'s header, default 50_000 events). No
 * API reports actual per-event heap size, so this is a documented ROUGH heuristic
 * (~2 KB/cached `Event`, covering its parsed entries + strings for a typical log) rather
 * than a measured conversion -- the setting is an order-of-magnitude control, not a hard
 * memory ceiling. Clamped to a sane floor so a tiny MB value can't starve the viewport
 * (which pins its own visible window regardless of the LRU cap).
 */
const BYTES_PER_CACHED_EVENT = 2000;
const MIN_EVENT_CACHE_LIMIT = 1000;
function mbToEventCacheLimit(maxEngineMemoryMB: number): number {
  return Math.max(MIN_EVENT_CACHE_LIMIT, Math.round((maxEngineMemoryMB * 1_000_000) / BYTES_PER_CACHED_EVENT));
}

/** Phase U10 -- builds `elog/open`'s options from the live `omnetpp.eventlog.*` settings at the moment a session is opened (settings changes apply on the FILE's next open, not live -- unlike the webview-side `EventLogUiSettings`, these bake into the worker's already-open engine). */
function readOpenOptions(): ElogOpenOptions {
  const config = vscode.workspace.getConfiguration('omnetpp');
  const options: ElogOpenOptions = { pollIntervalMs: config.get<number>('eventlog.pollIntervalMs', 3000) };
  const maxEngineMemoryMB = config.get<number>('eventlog.maxEngineMemoryMB', 0);
  if (maxEngineMemoryMB > 0) options.eventCacheLimit = mbToEventCacheLimit(maxEngineMemoryMB);
  return options;
}

/** Context key kept true while at least one `.elog` session is open -- gates the panel's webview view (`when: omnetpp.eventlogOpen`, package.json). */
const CONTEXT_EVENTLOG_OPEN = 'omnetpp.eventlogOpen';

/**
 * Phase U7: `workspaceState` key for each file's persisted `elog/setFilter` params
 * (`null` = explicitly unfiltered; ABSENT key = "never touched, nothing to rehydrate"),
 * keyed by file URI string -- same per-uri blob pattern as `sequenceChartEditor.ts`'s
 * `CHART_STATE_KEY`/`eventLogTableView.ts`'s `TABLE_STATE_KEY`, but held at the
 * CONTROLLER layer (like `bookmarkStores`) rather than by either webview provider,
 * since the filter is `EventLogSession`-owned state shared by chart AND table, not a
 * per-webview-kind UI preference (port plan decision record: "filter state persisted
 * per file and re-applied on reopen").
 */
const FILTER_PARAMS_KEY = 'omnetpp.eventlog.filterParams';

export class EventLogController {
  private readonly sessions = new Map<string, EventLogSession>();
  private readonly pendingOpens = new Map<string, Promise<EventLogSession>>();
  /** One `BookmarkStore` per file uri (phase U6) -- created lazily, on first access, and kept for the lifetime of the extension host (bookmarks must remain reachable -- e.g. for "Show Bookmarks" -- even while no session/webview for that file happens to be open). */
  private readonly bookmarkStores = new Map<string, BookmarkStore>();
  private activeUri: string | undefined;

  private readonly activeChangedEmitter = new vscode.EventEmitter<EventLogSession | undefined>();
  /** Fires whenever the "active" session (the one behind the focused Sequence Chart editor tab) changes -- the Event Log table view rebinds to this unless pinned. */
  readonly onDidChangeActiveSession = this.activeChangedEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    /** Diagnostics sink -- the "OMNeT++ Event Log" output channel (see index.ts); a no-op default keeps headless tests unchanged. */
    readonly log: (line: string) => void = () => {},
  ) {}

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

  /**
   * "OMNeT++: Reset Event Log View State" -- wipes every per-file persisted view blob
   * for `uriString` (chart state, table state, filter params) so a state poisoned by an
   * older/buggier build cannot keep a view broken across reopens. The in-webview reset
   * (the 'resetViewState' command each webview handles) is dispatched by the caller.
   */
  async clearPersistedViewState(uriString: string): Promise<void> {
    for (const storeKey of [CHART_STATE_KEY, TABLE_STATE_KEY]) {
      const all = this.context.workspaceState.get<Record<string, unknown>>(storeKey, {});
      if (uriString in all) {
        const { [uriString]: _dropped, ...rest } = all;
        await this.context.workspaceState.update(storeKey, rest);
      }
    }
    await this.setPersistedFilterParams(uriString, null);
    this.log(`cleared persisted view state for ${uriString}`);
  }

  private async openNewSession(uri: vscode.Uri, key: string): Promise<EventLogSession> {
    const bundlePath = eventlogWorkerBundlePath(this.context.extensionUri.fsPath);
    this.log(`opening ${uri.fsPath} (worker: ${bundlePath}, electron=${process.versions.electron ?? 'no'})`);
    const session = new EventLogSession(key, uri.fsPath, bundlePath, {
      onIdle: () => this.removeSession(key),
      initialFilterParams: this.getPersistedFilterParams(key),
      onFilterChanged: (params) => void this.setPersistedFilterParams(key, params),
      openOptions: readOpenOptions(),
      onLog: this.log,
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

  // ---- persisted filter (phase U7) -----------------------------------------------------

  /** `undefined` key entry (never persisted before) reads back as `null` (same as "explicitly unfiltered") -- harmless: `EventLogSession.initialize()` only re-applies a filter when this is a real (non-null) `FilterParams` object, so an absent/`null` entry both mean "nothing to rehydrate". */
  private getPersistedFilterParams(key: string): FilterParams | null {
    return this.context.workspaceState.get<Record<string, FilterParams | null>>(FILTER_PARAMS_KEY, {})[key] ?? null;
  }

  private async setPersistedFilterParams(key: string, params: FilterParams | null): Promise<void> {
    const all = this.context.workspaceState.get<Record<string, FilterParams | null>>(FILTER_PARAMS_KEY, {});
    await this.context.workspaceState.update(FILTER_PARAMS_KEY, { ...all, [key]: params });
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
