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
  type EventDetailParams,
  type FilterParams,
  type FindTextParams,
  type GotoEventParams,
  type GotoResult,
  type GotoSimTimeParams,
  type LogSummary,
  type MapCoordsParams,
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
}

export class EventLogSession {
  private readonly workerClientInstance: WorkerClient;
  private readonly chartSinks = new Set<MessageSink>();
  private readonly tableSinks = new Set<MessageSink>();
  private lastSummary: LogSummary | null = null;
  private disposed = false;

  /** Selection placeholder for U6 ("Sync, bookmarks, goto") -- not yet applied to any rendering, just held and echoed. */
  private selection: EventLogSelection = { eventNumbers: [] };

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

  /** Opens the file this session was constructed for; the resolved summary is
   *  cached (`lastSummary`) for `init` messages sent to webviews that attach later. */
  async initialize(): Promise<LogSummary> {
    const summary = await this.workerClientInstance.open({ path: this.filePath });
    this.lastSummary = summary;
    return summary;
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
      case ElogMethods.setFilter:
        return wc.setFilter(params as FilterParams | null, token);
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
      default:
        throw new Error(`EventLogSession: unknown engine method "${method}"`);
    }
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
