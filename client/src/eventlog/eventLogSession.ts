/**
 * EventLogSession -- the per-`.elog`-file session object the port plan's
 * "New code layout" describes: "per-document: owns a WorkerClient... refcount
 * chart-editor + table-view attachments; fans engineNotify to attached
 * webviews; holds selection state placeholder for U6".
 *
 * Deliberately kept free of `vscode` imports (mirrors `workerClient.ts`'s own
 * header: "so it is testable headless") -- everything it needs from a webview is
 * captured by the tiny structural `MessageSink` interface below, which
 * `vscode.Webview`/`vscode.WebviewView['webview']` satisfy without a wrapper (both
 * expose a `postMessage(message: any): Thenable<boolean>`, and TS's "void
 * context ignores the return value" rule makes that assignable to
 * `postMessage(message): void`). `client/src/eventlog/eventLogController.ts`
 * (which *does* import `vscode`) owns the registry of sessions keyed by file
 * URI and the context-key bookkeeping; this class only knows about one file.
 *
 * `client/worker/src/test/eventLogSession.test.ts` exercises this class headless
 * (real worker bundle, fake `MessageSink`) -- see that file for the full
 * round-trip test the U1 phase report references.
 */

import * as path from 'node:path';
import type { CancellationToken } from 'vscode-jsonrpc/node';
import {
  ElogMethods,
  type AdjacencyParams,
  type CheckChangesResult,
  type ElogChangedParams,
  type ElogOpenOptions,
  type EventDetailParams,
  type FilterHints,
  type FilterParams,
  type FindTextParams,
  type GotoEventParams,
  type GotoResult,
  type GotoSimTimeParams,
  type LogSummary,
  type MapCoordsParams,
  type ReleaseMemoryResult,
  type RowWindowParams,
  type ScRelocateOriginParams,
  type ScSetTimelineModeParams,
  type TableGotoRelatedParams,
  type TableNavigateParams,
  type TablePositionParams,
  type ViewportParams,
} from '@omnetpp/shared/elog-protocol';
import type { EventLogSelection, HostToWebviewMessage, RevealTarget } from '@omnetpp/shared/ui-protocol';
import { WorkerClient, type RestartedEvent, type WorkerClientOptions } from './workerClient';

/** The minimal shape a webview needs to expose to receive session broadcasts --
 *  satisfied structurally by `vscode.Webview` (see this file's header). */
export interface MessageSink {
  postMessage(message: HostToWebviewMessage): void;
}

/** Which kind of view is attached, for the refcount described in the port plan. */
export type AttachmentKind = 'chart' | 'table';

export interface EventLogSessionOptions {
  /** Extra `child_process.spawn` options forwarded to `WorkerClient`. */
  workerOptions?: WorkerClientOptions;
  /** Called once every chart AND table sink has detached (the session is now idle) -- the owner (controller) should drop this session from its registry at that point. `dispose()` has already been called on the worker by then. */
  onIdle?: () => void;
  /**
   * ADDITIVE (phase U7): a filter persisted from a PREVIOUS session for this same file
   * (`EventLogController`'s per-uri `workspaceState` blob) -- re-applied right after
   * `initialize()` opens the file, so a filter set before a window reload / editor
   * close is transparently back in place the next time this file is opened (port plan
   * decision record: "filter state persisted per file and re-applied on reopen").
   * `undefined`/`null` = nothing to rehydrate.
   */
  initialFilterParams?: FilterParams | null;
  /**
   * ADDITIVE (phase U7): fired every time this session's active filter changes
   * (`setFilter()` below, including the initial rehydrate) -- the owner (controller)
   * uses this to keep its per-uri persisted-filter blob in sync, mirroring
   * `sequenceChartEditor.ts`'s `stateChanged`-driven `workspaceState` persistence but
   * at the session/controller layer (this state is shared by chart AND table, not
   * owned by either webview -- see `setFilter()`'s own doc comment).
   */
  onFilterChanged?: (params: FilterParams | null) => void;
  /**
   * Phase U10 -- `elog/open`'s engine-side options (poll interval, cache caps), read
   * from `omnetpp.eventlog.pollIntervalMs`/`.maxEngineMemoryMB` by the controller
   * (`eventLogController.ts`'s `openNewSession()`) and passed straight through here.
   * `undefined` = engine defaults (matches every field's own optionality in
   * `ElogOpenOptions`).
   */
  openOptions?: ElogOpenOptions;
}

export class EventLogSession {
  private readonly workerClientInstance: WorkerClient;
  private readonly chartSinks = new Set<MessageSink>();
  private readonly tableSinks = new Set<MessageSink>();
  private lastSummary: LogSummary | null = null;
  private disposed = false;

  /** Selection placeholder for U6 ("Sync, bookmarks, goto") -- not yet applied to any rendering, just held and echoed. */
  private selection: EventLogSelection = { eventNumbers: [] };

  /** Phase U7 -- the session's currently-active filter (`null` = unfiltered), mirrored from `WorkerClient.getCurrentFilterParams()` so a webview attaching later (or the controller persisting it) doesn't need a round trip to learn it. Kept in sync by `setFilter()` (every call, including `initialize()`'s rehydrate) -- a crash-restart re-applies the SAME params (`workerClient.ts`'s own `lastFilterParams` replay), so this needs no adjustment there. */
  private currentFilterParams: FilterParams | null = null;
  /** Phase U7 -- one-shot flag set by `omnetpp.eventlog.openFilter`/the table's "Filter…" item when NO Sequence Chart webview is attached yet (so there is nowhere to `sendCommand()` to): `sequenceChartEditor.ts`'s `ready` handler consumes it via `consumeOpenFilterOnAttach()` right after sending `init`, so the freshly-opened chart's filter panel pops open without a race against the webview's own bootstrap. */
  private openFilterOnAttach = false;

  constructor(
    /** The elog file's VS Code URI, as a string (the controller's registry key). */
    public readonly uriString: string,
    /** Absolute filesystem path of the `.elog` file (what actually gets opened). */
    public readonly filePath: string,
    /** Absolute path to the bundled `dist/eventlogWorker.js` (constructor arg per `workerClient.ts`'s header: no implicit `context.asAbsolutePath` here, so this stays testable with any bundle path). */
    bundlePath: string,
    private readonly options: EventLogSessionOptions = {},
  ) {
    this.workerClientInstance = new WorkerClient(bundlePath, options.workerOptions);
    this.workerClientInstance.onProgress((p) => this.broadcast({ type: 'engineNotify', event: 'elog/progress', payload: p }));
    this.workerClientInstance.onChanged((p) => this.handleChanged(p));
    this.workerClientInstance.onRestarted((e) => this.handleRestarted(e));
  }

  /** Direct access to the underlying `WorkerClient`, for callers that want a
   *  typed one-off request without going through the generic `engineRequest`
   *  dispatch below (goto/find dialogs, "refresh" command). */
  get workerClient(): WorkerClient {
    return this.workerClientInstance;
  }

  /**
   * Opens the file this session was constructed for; the resolved summary is
   * cached (`lastSummary`) for `init` messages sent to webviews that attach later.
   *
   * Phase U7: if `options.initialFilterParams` was supplied (a filter persisted from a
   * previous session for this same file), re-applies it right away -- best-effort: a
   * failure here (e.g. the persisted params no longer make sense against a since-
   * changed file) does NOT fail the whole open, it just leaves the log unfiltered,
   * matching `WorkerClient`'s own "keep it simple" crash-restart re-apply philosophy
   * (`workerClient.ts`'s header). No `onFilterChanged` callback fires for this initial
   * rehydrate (the value came FROM that same persisted store; re-writing it back
   * would be a redundant, no-op `workspaceState.update()`).
   */
  async initialize(): Promise<LogSummary> {
    const summary = await this.workerClientInstance.open({ path: this.filePath, options: this.options.openOptions });
    this.lastSummary = summary;
    if (this.options.initialFilterParams) {
      try {
        this.lastSummary = await this.workerClientInstance.setFilter(this.options.initialFilterParams);
        this.currentFilterParams = this.options.initialFilterParams;
      } catch {
        // best-effort rehydrate -- see this method's doc comment
      }
    }
    return this.lastSummary;
  }

  /** The last summary this session has seen (from `initialize()`, `refresh()`, or a `elog/changed`/restart notification) -- `null` before the first successful open. */
  get summary(): LogSummary | null {
    return this.lastSummary;
  }

  // ---- attachment refcounting --------------------------------------------------------

  /**
   * Attaches `sink`; if this session already has a non-empty selection (e.g. a pinned
   * Event Log table rebinding to a different session, or a webview reload reattaching
   * to a session another still-open webview already drove), pushes it immediately so
   * the newly attached view renders the right highlight/reveal without waiting for the
   * OTHER view to change something first (the `init` message built by
   * `sequenceChartEditor.ts`/`eventLogTableView.ts` also carries `getSelection()` for
   * the same reason -- belt and suspenders, since `init`'s construction lives one layer
   * up, outside this `vscode`-free class).
   */
  attach(kind: AttachmentKind, sink: MessageSink): void {
    (kind === 'chart' ? this.chartSinks : this.tableSinks).add(sink);
    if (this.selection.eventNumbers.length > 0) sink.postMessage({ type: 'setSelection', selection: this.selection });
  }

  /** Detach one sink; once both chart and table sinks are empty, disposes the worker and fires `onIdle`. */
  detach(kind: AttachmentKind, sink: MessageSink): void {
    (kind === 'chart' ? this.chartSinks : this.tableSinks).delete(sink);
    if (this.isIdle()) this.disposeNow();
  }

  isIdle(): boolean {
    return this.chartSinks.size === 0 && this.tableSinks.size === 0;
  }

  /** `true` iff at least one Sequence Chart webview is currently attached -- used by `eventLogDialogs.ts` (phase U4) to decide whether the native goto/find commands should forward into the webview's own in-webview dialogs instead of showing a native input box (see that file's header). */
  hasChartAttachment(): boolean {
    return this.chartSinks.size > 0;
  }

  private disposeNow(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.workerClientInstance.dispose();
    this.options.onIdle?.();
  }

  /** Force-dispose regardless of attachment count (e.g. the controller shutting down). */
  dispose(): void {
    this.disposeNow();
  }

  // ---- broadcasting -------------------------------------------------------------------

  private broadcast(message: HostToWebviewMessage): void {
    for (const sink of this.chartSinks) sink.postMessage(message);
    for (const sink of this.tableSinks) sink.postMessage(message);
  }

  /**
   * Public passthrough for callers outside this class that need to fan a message out to
   * every attached webview unconditionally (currently: `bookmarksChanged`, after
   * `client/src/eventlog/bookmarks.ts`'s `BookmarkStore` mutates -- bookmark storage
   * needs `vscode.Memento`/`showInputBox`, so it lives one layer up in
   * `eventLogController.ts`/the two webview providers, not on this `vscode`-free class,
   * but still needs a way to reach every sink this session owns).
   */
  postToAll(message: HostToWebviewMessage): void {
    this.broadcast(message);
  }

  private handleChanged(p: ElogChangedParams): void {
    this.lastSummary = p.summary;
    this.broadcast({ type: 'engineNotify', event: 'elog/changed', payload: p });
  }

  private handleRestarted(e: RestartedEvent): void {
    if (e.summary) this.lastSummary = e.summary;
    this.broadcast({ type: 'engineNotify', event: 'restarted', payload: e });
  }

  /** "Refresh" command (editor/title + view/title): forces an immediate
   *  check against the underlying file and broadcasts the (possibly
   *  unchanged) fresh summary so status strips can re-render. */
  async refresh(): Promise<CheckChangesResult> {
    const result = await this.workerClientInstance.checkChanges();
    this.lastSummary = result.summary;
    // checkChanges() only emits `elog/changed` (via onChanged) when something
    // actually changed; broadcast an explicit "refreshed" event unconditionally
    // so a manual refresh always visibly updates the UI, even on a no-op check.
    this.broadcast({ type: 'engineNotify', event: 'elog/refreshed', payload: result });
    return result;
  }

  /**
   * "Release Memory" command/context-menu item (phase U9): forces the engine to drop
   * its parsed-event cache (keeping pins -- first/last/origin/current viewport, see
   * `EngineSession.releaseMemory()`) and broadcasts the result to every attached
   * webview as `elog/memoryReleased`, so both the chart and table refetch their
   * current windows against the (now cache-cold, but content-identical) engine state.
   */
  async releaseMemory(token?: CancellationToken): Promise<ReleaseMemoryResult> {
    const result = await this.workerClientInstance.releaseMemory(token);
    this.lastSummary = result.summary;
    this.broadcast({ type: 'engineNotify', event: 'elog/memoryReleased', payload: result });
    return result;
  }

  // ---- selection (U6: canonical, session-mediated chart<->table sync) -----------------

  /** The session's current canonical selection (empty `{eventNumbers: []}` before anything has ever been selected) -- also pushed in every `init` message (`sequenceChartEditor.ts`/`eventLogTableView.ts`) so a freshly (re)attached webview (a reload, or a pinned table rebinding to a different session) picks it up immediately without waiting on the other view to re-broadcast. */
  getSelection(): EventLogSelection {
    return this.selection;
  }

  /**
   * Canonicalizes (`originId` stripped -- it is meaningful only for the re-entry guard
   * below, never part of the durable session state; event numbers deduplicated and
   * sorted so two logically-identical selections compare equal regardless of click
   * order) and records `selection`, then re-broadcasts a `setSelection` to every OTHER
   * attached sink -- NOT the originator (Eclipse's `isSelectionChangeInProgress` re-
   * entry guard, `EventLogSelection.ts`'s header). Called both from a webview's own
   * `selectionChanged` message (`originSink` = that webview) and, in principle, by any
   * future host-driven selection change (`originSink` omitted = broadcast to everyone).
   */
  setSelection(selection: EventLogSelection, originSink?: MessageSink): void {
    const eventNumbers = [...new Set(selection.eventNumbers)].sort((a, b) => a - b);
    this.selection = { eventNumbers };
    const message: HostToWebviewMessage = { type: 'setSelection', selection: this.selection };
    for (const sink of this.chartSinks) if (sink !== originSink) sink.postMessage(message);
    for (const sink of this.tableSinks) if (sink !== originSink) sink.postMessage(message);
  }

  /** Broadcasts a resolved reveal target (goto/find result) to every attached webview. */
  reveal(target: RevealTarget): void {
    this.broadcast({ type: 'reveal', target });
  }

  /** Forwards an arbitrary host command (editor/title, view/title) to every attached webview -- mirrors `NedPreviewPanel.sendCommand()`. */
  sendCommand(command: string, args?: unknown): void {
    this.broadcast({ type: 'command', command, args });
  }

  // ---- open-filter-on-attach (phase U7: "if no chart editor visible, open one") -------

  /** Records that the filter panel should pop open the moment a Sequence Chart webview next attaches (`eventLogDialogs.ts`'s `openFilterPanelForSession()`, used when `hasChartAttachment()` is currently `false`). */
  requestOpenFilterOnAttach(): void {
    this.openFilterOnAttach = true;
  }

  /** Consumes (clears) the flag set by `requestOpenFilterOnAttach()` -- called once, by `sequenceChartEditor.ts`'s `ready` handler, right after it sends `init`. */
  consumeOpenFilterOnAttach(): boolean {
    const value = this.openFilterOnAttach;
    this.openFilterOnAttach = false;
    return value;
  }

  // ---- generic engine-request proxy (webview `engineRequest` -> WorkerClient) ------------

  /**
   * Dispatches one proxied `elogProtocol.ts` request by method name (an
   * `ElogMethods` value) to the matching typed `WorkerClient` method. This is
   * the "proxying engineRequest -> session.workerClient" the port plan's
   * `sequenceChartEditor.ts`/`eventLogTableView.ts` entries describe --
   * centralized here so both webviews share one dispatch table.
   *
   * `token` (phase U4, real RPC cancellation -- see `common/rpc.ts`'s header and the
   * "Known follow-up" in the U3 commit message): threaded through to every
   * `WorkerClient` call unchanged; `sequenceChartEditor.ts`'s message pump supplies a
   * fresh `vscode.CancellationTokenSource` per `engineRequest` and cancels it when a
   * matching `cancelRequest` arrives, which `vscode-jsonrpc` turns into a real
   * `$/cancelRequest` to the worker.
   */
  async handleEngineRequest(method: string, params: unknown, token?: CancellationToken): Promise<unknown> {
    const wc = this.workerClientInstance;
    switch (method) {
      case ElogMethods.open:
        // Re-opening through the generic proxy is intentionally unsupported: the
        // session already owns exactly one open file (this.filePath), opened by
        // `initialize()`. A webview has no legitimate reason to request a
        // different path through this channel.
        throw new Error('EventLogSession: elog/open must not be proxied from a webview; the session already owns its file.');
      case ElogMethods.getSummary:
        return wc.getSummary(token);
      case ElogMethods.checkChanges:
        return this.refresh();
      case ElogMethods.getModuleTree:
        return wc.getModuleTree(token);
      case ElogMethods.getFilterHints:
        return wc.getFilterHints(token);
      case ElogMethods.setFilter:
        return this.setFilter(params as FilterParams | null, token);
      case ElogMethods.scSetTimelineMode:
        return wc.scSetTimelineMode(params as ScSetTimelineModeParams, token);
      case ElogMethods.scRelocateOrigin:
        return wc.scRelocateOrigin(params as ScRelocateOriginParams, token);
      case ElogMethods.scGetViewport:
        return wc.scGetViewport(params as ViewportParams, token);
      case ElogMethods.scMapCoords:
        return wc.scMapCoords(params as MapCoordsParams, token);
      case ElogMethods.scAdjacencyMatrix:
        return wc.scAdjacencyMatrix(params as AdjacencyParams, token);
      case ElogMethods.tableGetRows:
        return wc.tableGetRows(params as RowWindowParams, token);
      case ElogMethods.tableNavigate:
        return wc.tableNavigate(params as TableNavigateParams, token);
      case ElogMethods.tablePosition:
        return wc.tablePosition(params as TablePositionParams, token);
      case ElogMethods.tableGotoRelated:
        return wc.tableGotoRelated(params as TableGotoRelatedParams, token);
      case ElogMethods.gotoEvent:
        return this.gotoEvent(params as GotoEventParams, token);
      case ElogMethods.gotoSimTime:
        return this.gotoSimTime(params as GotoSimTimeParams, token);
      case ElogMethods.findText:
        return wc.findText(params as FindTextParams, token);
      case ElogMethods.getEventDetail:
        return wc.getEventDetail(params as EventDetailParams, token);
      case ElogMethods.close:
        return wc.close(token);
      case ElogMethods.releaseMemory:
        return this.releaseMemory(token);
      default:
        throw new Error(`EventLogSession: unknown engine method "${method}"`);
    }
  }

  // ---- filter (phase U7: session-mediated so chart + table share one filter state) ----

  /** The session's currently-active filter (`null` = unfiltered) -- see `currentFilterParams`'s own doc comment. */
  getCurrentFilterParams(): FilterParams | null {
    return this.currentFilterParams;
  }

  /**
   * Applies (or, with `null`, removes) a filter and broadcasts the change to EVERY
   * attached webview (chart AND table, origin included) as `engineNotify` event
   * `elog/filterChanged` -- unlike selection, filtering has no "echo" concern (it isn't
   * a continuously-driven local gesture), and BOTH views need to independently re-
   * anchor themselves afterward (the chart re-centers + resets zoom; the table
   * re-resolves its own fix-point row), so every attachment -- not just whichever
   * webview happened to call this -- needs the fresh `LogSummary` up front. Also
   * updates `currentFilterParams` (for later-attaching webviews' `init` messages) and
   * fires `options.onFilterChanged` (the controller's per-uri persistence hook).
   */
  async setFilter(params: FilterParams | null, token?: CancellationToken): Promise<LogSummary> {
    const summary = await this.workerClientInstance.setFilter(params, token);
    this.lastSummary = summary;
    this.currentFilterParams = params;
    this.options.onFilterChanged?.(params);
    this.broadcast({ type: 'engineNotify', event: 'elog/filterChanged', payload: { summary, params } });
    return summary;
  }

  // ---- goto (wired end-to-end this phase; also called directly by eventLogDialogs.ts) ----

  /** Resolves a goto-event request AND reveals it in every attached webview (dialogs call this directly; the generic proxy above routes here too so a webview-initiated goto behaves identically). */
  async gotoEvent(params: GotoEventParams, token?: CancellationToken): Promise<GotoResult> {
    const result = await this.workerClientInstance.gotoEvent(params, token);
    if (result.found) this.reveal({ kind: 'event', eventNumber: result.eventNumber!, ref: result.ref });
    return result;
  }

  /** Same as `gotoEvent()` for simulation-time targets. */
  async gotoSimTime(params: GotoSimTimeParams, token?: CancellationToken): Promise<GotoResult> {
    const result = await this.workerClientInstance.gotoSimTime(params, token);
    if (result.found) this.reveal({ kind: 'simTime', simulationTime: params.simulationTime, ref: result.ref });
    return result;
  }
}

/** Convenience for controllers: the standard bundle-relative path to the worker, given an extension root. Kept here (not in eventLogController.ts) purely so this stays a `node:path`-only helper with no `vscode.ExtensionContext` dependency -- callers pass whatever root they have. */
export function eventlogWorkerBundlePath(extensionRoot: string): string {
  return path.join(extensionRoot, 'dist', 'eventlogWorker.js');
}
