/**
 * WorkerClient -- the extension-host-side typed wrapper around one spawned
 * `dist/eventlogWorker.js` process (one instance per open `.elog`, per the port
 * plan's "dedicated worker child process per open .elog"). Deliberately `vscode`-
 * import-free (per the E8 task list: "keep vscode OUT of this file... so it is
 * testable headless") -- the bundle path and any extra spawn options are
 * constructor arguments, so `client/worker/src/test/`-style headless tests (and
 * `scripts/elog-worker-smoke.mjs`, which drives the same bundle directly over
 * `vscode-jsonrpc` without going through this class at all) can exercise the real
 * child-process/JSON-RPC path with no VS Code process around.
 *
 * `client/src/eventlog/eventLogController.ts`/`eventLogSession.ts` (later phases,
 * U1+) own the `vscode.workspace`/webview-facing glue and construct this class with
 * `context.asAbsolutePath(path.join('dist', 'eventlogWorker.js'))`.
 *
 * Crash recovery: on an unexpected exit (not triggered by `dispose()`), the worker
 * is respawned with a small backoff, and the *last known* `open`/`setFilter` state
 * is re-applied (open the same file again, then reinstall the last filter, if any)
 * -- deliberately kept simple per the E8 task list ("keep it simple"); it does not
 * attempt to restore in-flight requests (those reject) or exact viewport/table
 * scroll position (that's the session/webview's job to re-request once the
 * `restarted` event fires).
 *
 * Live follow (phase E9): `rawRequest()` (every typed method below funnels through
 * it) automatically retries a request ONCE if it fails with `ContentChanged` (the
 * file changed mid-request -- see elogProtocol.ts's `CONTENT_CHANGED_ERROR_CODE` doc
 * comment) -- by the time that error surfaces, the worker's engine has already
 * synchronized, so the retry runs against fresh state. `onChanged()` fires for BOTH
 * how a change can be learned about: the worker's own fs.watch/poll-timer hybrid
 * noticing it while otherwise idle, or a request hitting `ContentChanged` mid-flight
 * (the engine broadcasts the same notification either way -- see engineThread.ts).
 */

import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createMessageConnection, ResponseError, StreamMessageReader, StreamMessageWriter, type CancellationToken, type Disposable, type MessageConnection } from 'vscode-jsonrpc/node';
import {
  CONTENT_CHANGED_ERROR_CODE,
  ElogMethods,
  ElogNotifications,
  type AdjacencyParams,
  type AdjacencyResult,
  type CheckChangesResult,
  type ContentChangedErrorData,
  type ElogChangedParams,
  type ElogModule,
  type ElogProgressParams,
  type EventDetail,
  type EventDetailParams,
  type FilterHints,
  type FilterParams,
  type FindTextParams,
  type FindTextResult,
  type GotoEventParams,
  type GotoResult,
  type GotoSimTimeParams,
  type LogSummary,
  type MapCoordsParams,
  type MapCoordsResult,
  type ScListVectorsParams,
  type ScListVectorsResult,
  type ScAttachVectorParams,
  type ScDetachVectorParams,
  type OpenParams,
  type ReleaseMemoryResult,
  type RowWindow,
  type RowWindowParams,
  type RowRef,
  type ScRelocateOriginParams,
  type ScSetTimelineModeParams,
  type ScState,
  type TableGotoRelatedParams,
  type TableNavigateParams,
  type TablePositionParams,
  type TablePositionResult,
  type ViewportModel,
  type ViewportParams,
} from '@omnetpp/shared/elog-protocol';

/** True iff `err` is the JSON-RPC error response for `CONTENT_CHANGED_ERROR_CODE` (`ElogMethods`'s doc comment, `-32010 ContentChanged`), narrowing `err.data` to `ContentChangedErrorData`. */
function isContentChangedError(err: unknown): err is ResponseError<ContentChangedErrorData> {
  return err instanceof ResponseError && err.code === CONTENT_CHANGED_ERROR_CODE;
}

export interface WorkerClientOptions {
  /** Extra `child_process.spawn` options (cwd/env/etc.) -- `args`/`stdio` are always the worker's own. */
  spawnOptions?: SpawnOptions;
  /** Backoff schedule (ms) for automatic restart after an unexpected crash; the last entry repeats. Default `[200, 1000, 5000]`. */
  restartBackoffMs?: number[];
}

/** Fired after a crash-triggered restart has finished re-establishing state (see this file's header). `summary` is `null` if there was nothing to reopen (the worker had never successfully opened a file) or the reopen itself failed. */
export interface RestartedEvent {
  summary: LogSummary | null;
}

export class WorkerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: MessageConnection | null = null;
  private disposed = false;
  private restartAttempt = 0;

  private lastOpenParams: OpenParams | null = null;
  private lastFilterParams: FilterParams | null = null;

  private readonly progressListeners = new Set<(p: ElogProgressParams) => void>();
  private readonly changedListeners = new Set<(p: ElogChangedParams) => void>();
  private readonly stderrListeners = new Set<(chunk: string) => void>();
  private readonly restartedListeners = new Set<(e: RestartedEvent) => void>();

  constructor(
    private readonly bundlePath: string,
    private readonly options: WorkerClientOptions = {},
  ) {
    this.spawnAndConnect();
  }

  // ---- lifecycle ---------------------------------------------------------------------

  private spawnAndConnect(): void {
    // Inside a VS Code extension host, `process.execPath` is the *Electron* binary, not
    // node: without ELECTRON_RUN_AS_NODE=1 the child boots as a VS Code instance (which
    // under the single-instance lock just forwards its argv to the running window and
    // exits) instead of running the worker bundle -- the JSON-RPC connection then never
    // answers and every view stays empty. Under bun/node (tests, smoke scripts,
    // `process.versions.electron` unset) the variable is harmless but skipped anyway.
    const spawnEnv = process.versions.electron
      ? { ...process.env, ...this.options.spawnOptions?.env, ELECTRON_RUN_AS_NODE: '1' }
      : this.options.spawnOptions?.env;
    const child = spawn(process.execPath, [this.bundlePath], {
      ...this.options.spawnOptions,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const listener of this.stderrListeners) listener(text);
    });

    const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    connection.onNotification(ElogNotifications.progress, (params: ElogProgressParams) => {
      for (const listener of this.progressListeners) listener(params);
    });
    connection.onNotification(ElogNotifications.changed, (params: ElogChangedParams) => {
      for (const listener of this.changedListeners) listener(params);
    });
    connection.listen();
    this.connection = connection;

    child.on('exit', () => this.handleUnexpectedExit());
  }

  private handleUnexpectedExit(): void {
    if (this.disposed) return;
    this.connection?.dispose();
    this.connection = null;
    this.child = null;

    const backoff = this.options.restartBackoffMs ?? [200, 1000, 5000];
    const delay = backoff[Math.min(this.restartAttempt, backoff.length - 1)];
    this.restartAttempt++;
    setTimeout(() => {
      if (this.disposed) return;
      this.spawnAndConnect();
      void this.reestablishState();
    }, delay);
  }

  private async reestablishState(): Promise<void> {
    if (this.lastOpenParams === null) {
      for (const listener of this.restartedListeners) listener({ summary: null });
      return;
    }
    try {
      const summary = await this.rawRequest<OpenParams, LogSummary>(ElogMethods.open, this.lastOpenParams);
      if (this.lastFilterParams !== null) await this.rawRequest<FilterParams | null, LogSummary>(ElogMethods.setFilter, this.lastFilterParams);
      for (const listener of this.restartedListeners) listener({ summary });
    } catch {
      for (const listener of this.restartedListeners) listener({ summary: null });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.connection?.dispose();
    this.child?.kill();
    this.connection = null;
    this.child = null;
  }

  // ---- event hooks --------------------------------------------------------------------

  onProgress(listener: (p: ElogProgressParams) => void): Disposable {
    this.progressListeners.add(listener);
    return { dispose: () => this.progressListeners.delete(listener) };
  }

  onChanged(listener: (p: ElogChangedParams) => void): Disposable {
    this.changedListeners.add(listener);
    return { dispose: () => this.changedListeners.delete(listener) };
  }

  onStderr(listener: (chunk: string) => void): Disposable {
    this.stderrListeners.add(listener);
    return { dispose: () => this.stderrListeners.delete(listener) };
  }

  /** Fires once a crash-triggered restart has re-established state (see this file's header) -- lets the session re-request whatever viewport/rows it had before the crash. */
  onRestarted(listener: (e: RestartedEvent) => void): Disposable {
    this.restartedListeners.add(listener);
    return { dispose: () => this.restartedListeners.delete(listener) };
  }

  // ---- typed request wrappers -----------------------------------------------------------

  /**
   * Phase E9 ("live follow"): on a `ContentChanged` error (the worker's engine
   * synchronized to a file change mid-request, per `ElogMethods`'s doc comment on
   * `CONTENT_CHANGED_ERROR_CODE`), automatically replays the exact same request ONCE.
   * By the time that error was thrown, the engine has already synchronized to the new
   * file state (see `engineSession.ts`'s `runJob()`), so the retry runs against fresh
   * state and normally just succeeds outright. If the retry itself also hits
   * `ContentChanged` (the file is changing unusually fast), that second error is
   * propagated as-is -- exactly one automatic retry, never a loop.
   *
   * This method does not itself notify `changedListeners` with the fresh summary
   * carried on the error (`err.data`): the worker's engine thread already broadcasts
   * the matching `elog/changed` notification for this exact case (see
   * engineThread.ts's `pump()`), which reaches `changedListeners` via the ordinary
   * `onChanged()` wiring below -- adding a second, client-side firing here would just
   * double the notification.
   *
   * BUGFIX (found while writing phase U1's `eventLogSession.test.ts`, the
   * first real caller to exercise the common no-token path end-to-end):
   * `vscode-jsonrpc`'s `sendRequest()` picks its (params) vs. (params, token)
   * overload by *argument count*, not by whether the token is `undefined` --
   * calling it with 3 arguments where the 3rd is `undefined` (exactly what
   * every caller below does when it omits its own optional `token` parameter)
   * crashes the request server-side (`"null is not an object (evaluating
   * 'token.onCancellationRequested')"`), as opposed to omitting the argument
   * entirely. `sendRequestSafely()` below only forwards a 3rd argument when a
   * real token was actually supplied.
   */
  private sendRequestSafely<R>(method: string, params: unknown, token: CancellationToken | undefined): Promise<R> {
    const connection = this.connection;
    if (connection === null) return Promise.reject(new Error(`WorkerClient: not connected (worker restarting after a crash?), method=${method}`));
    return token === undefined ? connection.sendRequest<R>(method, params) : connection.sendRequest<R>(method, params, token);
  }

  private rawRequest<P, R>(method: string, params: P, token?: CancellationToken): Promise<R> {
    if (this.connection === null) return Promise.reject(new Error(`WorkerClient: not connected (worker restarting after a crash?), method=${method}`));
    return this.sendRequestSafely<R>(method, params, token).catch((err: unknown) => {
      if (!isContentChangedError(err)) throw err;
      if (this.connection === null) throw err; // disconnected between the failed attempt and this retry (e.g. a crash) -- nothing sensible to retry against
      return this.sendRequestSafely<R>(method, params, token);
    });
  }

  async open(params: OpenParams, token?: CancellationToken): Promise<LogSummary> {
    const summary = await this.rawRequest<OpenParams, LogSummary>(ElogMethods.open, params, token);
    this.lastOpenParams = params;
    this.lastFilterParams = null;
    this.restartAttempt = 0; // a successful request means the worker is healthy again
    return summary;
  }

  getSummary(token?: CancellationToken): Promise<LogSummary> {
    return this.rawRequest(ElogMethods.getSummary, undefined, token);
  }

  /** Phase E9 ("live follow"): forces an immediate check against the underlying file -- for a UI "refresh" button. See `ElogMethods.checkChanges`'s doc comment. */
  checkChanges(token?: CancellationToken): Promise<CheckChangesResult> {
    return this.rawRequest(ElogMethods.checkChanges, undefined, token);
  }

  getModuleTree(token?: CancellationToken): Promise<ElogModule | null> {
    return this.rawRequest(ElogMethods.getModuleTree, undefined, token);
  }

  /** ADDITIVE (phase U7): filter-panel autocompletion data -- see `elogProtocol.ts`'s `FilterHints` doc. */
  getFilterHints(token?: CancellationToken): Promise<FilterHints> {
    return this.rawRequest(ElogMethods.getFilterHints, undefined, token);
  }

  async setFilter(params: FilterParams | null, token?: CancellationToken): Promise<LogSummary> {
    const summary = await this.rawRequest<FilterParams | null, LogSummary>(ElogMethods.setFilter, params, token);
    this.lastFilterParams = params;
    return summary;
  }

  /** The most recently applied filter (`null` = unfiltered), for a host-side session that wants to persist/rehydrate it -- see `eventLogSession.ts`'s `getCurrentFilterParams()`. */
  getCurrentFilterParams(): FilterParams | null {
    return this.lastFilterParams;
  }

  scSetTimelineMode(params: ScSetTimelineModeParams, token?: CancellationToken): Promise<ScState> {
    return this.rawRequest(ElogMethods.scSetTimelineMode, params, token);
  }

  scRelocateOrigin(params: ScRelocateOriginParams, token?: CancellationToken): Promise<ScState> {
    return this.rawRequest(ElogMethods.scRelocateOrigin, params, token);
  }

  scGetViewport(params: ViewportParams, token?: CancellationToken): Promise<ViewportModel> {
    return this.rawRequest(ElogMethods.scGetViewport, params, token);
  }

  scMapCoords(params: MapCoordsParams, token?: CancellationToken): Promise<MapCoordsResult> {
    return this.rawRequest(ElogMethods.scMapCoords, params, token);
  }

  scListVectors(params: ScListVectorsParams, token?: CancellationToken): Promise<ScListVectorsResult> {
    return this.rawRequest(ElogMethods.scListVectors, params, token);
  }

  scAttachVector(params: ScAttachVectorParams, token?: CancellationToken): Promise<void> {
    return this.rawRequest(ElogMethods.scAttachVector, params, token);
  }

  scDetachVector(params: ScDetachVectorParams, token?: CancellationToken): Promise<void> {
    return this.rawRequest(ElogMethods.scDetachVector, params, token);
  }

  scAdjacencyMatrix(params: AdjacencyParams, token?: CancellationToken): Promise<AdjacencyResult> {
    return this.rawRequest(ElogMethods.scAdjacencyMatrix, params, token);
  }

  tableGetRows(params: RowWindowParams, token?: CancellationToken): Promise<RowWindow> {
    return this.rawRequest(ElogMethods.tableGetRows, params, token);
  }

  tableNavigate(params: TableNavigateParams, token?: CancellationToken): Promise<RowRef | null> {
    return this.rawRequest(ElogMethods.tableNavigate, params, token);
  }

  tablePosition(params: TablePositionParams, token?: CancellationToken): Promise<TablePositionResult> {
    return this.rawRequest(ElogMethods.tablePosition, params, token);
  }

  tableGotoRelated(params: TableGotoRelatedParams, token?: CancellationToken): Promise<RowRef | null> {
    return this.rawRequest(ElogMethods.tableGotoRelated, params, token);
  }

  gotoEvent(params: GotoEventParams, token?: CancellationToken): Promise<GotoResult> {
    return this.rawRequest(ElogMethods.gotoEvent, params, token);
  }

  gotoSimTime(params: GotoSimTimeParams, token?: CancellationToken): Promise<GotoResult> {
    return this.rawRequest(ElogMethods.gotoSimTime, params, token);
  }

  findText(params: FindTextParams, token?: CancellationToken): Promise<FindTextResult> {
    return this.rawRequest(ElogMethods.findText, params, token);
  }

  getEventDetail(params: EventDetailParams, token?: CancellationToken): Promise<EventDetail | null> {
    return this.rawRequest(ElogMethods.getEventDetail, params, token);
  }

  close(token?: CancellationToken): Promise<void> {
    this.lastOpenParams = null;
    this.lastFilterParams = null;
    return this.rawRequest(ElogMethods.close, undefined, token);
  }

  /** Phase U9 -- "Release Memory": see `ElogMethods.releaseMemory`'s doc comment. */
  releaseMemory(token?: CancellationToken): Promise<ReleaseMemoryResult> {
    return this.rawRequest(ElogMethods.releaseMemory, undefined, token);
  }
}
