/**
 * EngineSession -- the stateful eventlog engine instance one worker process serves
 * (one per open `.elog` file). Deliberately free of `node:worker_threads`/
 * `postMessage` concerns: it is a plain, synchronous class over the `shared/src/
 * eventlog/` engine (FileReader/EventLog/FilteredEventLog/SequenceChartFacade/
 * EventLogTableFacade/buildModuleTree), so it can be unit-tested in-process
 * (`client/worker/src/test/handlers.test.ts`) without spawning a real worker thread.
 * `engineThread.ts` is the only caller that wraps this in worker_thread message
 * plumbing; `handlers.ts` is the dispatch table from `ElogMethods` names to this
 * class's methods (kept separate per the E8 task list, "so server-glue-style tests
 * can run it in-process without spawning").
 *
 * Long-running-operation cancellation/progress (port plan risk #5, "every long
 * engine loop must call progress()"): every engine entry point that can run long
 * (setFilter, sc/getViewport, sc/adjacencyMatrix, findText) is wrapped in
 * `runJob()`, which installs a `{ cancelFlag, notify }` context that the single
 * `EventLogOptions.onProgress` callback (wired once, at `open()` time, onto the root
 * `EventLog`) reads on every `eventLog.progress()` call -- and every facade/
 * FilteredEventLog in this port funnels `progress()` back to that same root
 * `EventLog` (checked: `FilteredEventLog.progress()`/`EventLogFacade` both forward to
 * `this.eventLog.progress()`), so one wiring point covers the whole call graph.
 *
 * FileChangedError handling (E8's "basic version"; E9 completes live-follow): any
 * `runJob()`-wrapped call that throws `FileChangedError` is caught here,
 * synchronized once, and re-thrown as `ContentChangedError` (this file, below) --
 * `engineThread.ts` maps that to the `-32010 ContentChanged` JSON-RPC error.
 */

import {
  BeginSendEntry,
  BigDecimal,
  buildFilterHints,
  buildModuleTree,
  EventLog,
  type EventLogEntry,
  EventLogMessageEntry,
  EventLogTableFacade,
  type EventLogOptions,
  FileChange,
  FileChangedError,
  FileReader,
  FilteredEventLog,
  FilteredMessageDependency,
  FilteredMessageDependencyKind,
  type IEvent,
  type IEventLog,
  type IMessageDependency,
  MessageReuseDependency,
  renderTableRow,
  SequenceChartFacade,
  type TableRowRenderContext,
} from '@omnetpp/shared/eventlog';
import { NodeRandomAccessFile } from '@omnetpp/shared/node';
import type {
  AdjacencyParams,
  AdjacencyResult,
  CheckChangesResult,
  ElogModule,
  ElogOpenOptions,
  EventDetail,
  EventDetailParams,
  FilterHints,
  FilterParams,
  FindTextParams,
  FindTextResult,
  GotoEventParams,
  GotoResult,
  GotoSimTimeParams,
  LogSummary,
  MapCoordsParams,
  MapCoordsResult,
  OpenParams,
  RowAnchor,
  RowRef,
  RowWindow,
  RowWindowParams,
  ScRelocateOriginParams,
  ScSetTimelineModeParams,
  ScState,
  TableGotoRelatedParams,
  TableNavigateParams,
  TablePositionParams,
  TablePositionResult,
  TableRow,
  TimelineEvent,
  ViewportModel,
  ViewportParams,
  RenderDependency,
  RenderMethodCall,
  ReleaseMemoryResult,
  AxisVectorStrip,
  AxisVectorSegment,
  ScListVectorsParams,
  ScListVectorsResult,
  ScAttachVectorParams,
  ScDetachVectorParams,
} from '@omnetpp/shared/elog-protocol';
import { listVectors, readVector, vectorValueIndex, vectorValueText, type VecSample, type VecVectorInfo } from './vectorFileReader';

/** Thrown by `runJob()` when the job's cancel flag is observed set (see engineThread.ts). Mapped to `ErrorCodes.RequestCancelled` there. */
export class RequestCancelledError extends Error {
  constructor() {
    super('request cancelled');
    this.name = 'RequestCancelledError';
  }
}

/** Thrown by `runJob()` when a `FileChangedError` interrupts an operation (see this file's header). Mapped to `CONTENT_CHANGED_ERROR_CODE` in engineThread.ts. */
export class ContentChangedError extends Error {
  constructor(
    public readonly change: 'appended' | 'overwritten',
    public readonly summary: LogSummary,
  ) {
    super(`eventlog file changed (${change})`);
    this.name = 'ContentChangedError';
  }
}

/** Structural type covering the E7 pin API both `EventLog` and `FilteredEventLog` expose (not part of the shared `IEventLog` interface -- see eventLog.ts's header for why it's a bolt-on, not a Java-ported member). */
interface Pinnable {
  pinEvent(eventNumber: number): void;
  unpinEvent(eventNumber: number): void;
}

const DEFAULT_MAX_VIEWPORT_EVENTS = 20_000;

export class EngineSession {
  private path: string | null = null;
  private reader: FileReader | null = null;
  private eventLog: EventLog | null = null;
  private filteredEventLog: FilteredEventLog | null = null;
  private sequenceChartFacade: SequenceChartFacade | null = null;
  private tableFacade: EventLogTableFacade | null = null;

  /** Bumped on open()/setFilter() -- a coarser version than the facade's own `getTimelineCoordinateSystemVersion()` (see elogProtocol.ts's LogSummary field doc). */
  private logVersion = 0;

  private pinnedViewportEventNumbers: number[] = [];

  /**
   * Axis vector-data attachments (Eclipse's `moduleIdToAxisRendererMap` for
   * `AxisVectorBarRenderer`s): module id → the fully-loaded vector. Each `scGetViewport`
   * emits the visible value-step segments for these. Survives a filter change (like Java,
   * which does not clear the map on filter); dropped on `close()`.
   */
  private attachedVectors = new Map<number, { info: VecVectorInfo; samples: VecSample[] }>();

  /**
   * Phase E9 (live follow): the event number of the last event as of the most recent
   * open()/synchronize(), kept pinned (see `pinFirstEvent()`/`repinLastEvent()` below)
   * so it survives eviction across the moment between an APPENDED synchronize and the
   * next request that actually looks at the new tail (e.g. a "goto end"/follow-end
   * jump the UI issues right after an `elog/changed` notification). `null` before the
   * first open() completes, or for an empty log. Note this is purely an *additional*
   * pin on top of `EventLog`/`FilteredEventLog`'s own automatic first/last-event
   * eviction protection (`isEventEvictable()`, phase E7) -- belt and suspenders, not a
   * substitute for it.
   */
  private pinnedLastEventNumber: number | null = null;

  private activeJob: { cancelFlag: Int32Array; notify: () => void } | null = null;

  // ---- job/progress plumbing (see this file's header) ------------------------------

  /** Wraps one request's execution: installs the cancel/notify context the `onProgress` hook reads, and turns `FileChangedError` into `ContentChangedError`. */
  runJob<T>(cancelFlag: Int32Array, notify: () => void, fn: () => T): T {
    this.activeJob = { cancelFlag, notify };
    try {
      return fn();
    } catch (err) {
      if (err instanceof FileChangedError) throw this.handleFileChanged();
      throw err;
    } finally {
      this.activeJob = null;
    }
  }

  private readonly onProgress = (): void => {
    const job = this.activeJob;
    if (job === null) return;
    if (Atomics.load(job.cancelFlag, 0) === 1) throw new RequestCancelledError();
    job.notify();
  };

  private handleFileChanged(): ContentChangedError {
    const { change, summary } = this.synchronizeToCurrentFileState(this.reader!.getFileChange());
    return new ContentChangedError(change, summary);
  }

  /**
   * Phase E9 ("live follow"): a side-effect-free-unless-changed poll, driven by the
   * `elog/checkChanges` job (both the manual/UI-refresh request and the internal one
   * `client/worker/src/watcher.ts`'s fs.watch/poll-timer hybrid posts -- see
   * `checkChanges()` below and engineThread.ts's job handling). Returns `null` if
   * nothing changed, else the same `{change, summary}` shape `ContentChangedError`
   * carries (which engineThread.ts also forwards as an unsolicited `elog/changed`
   * notification in both cases -- see this file's header and engineThread.ts).
   */
  checkForChanges(): { change: 'appended' | 'overwritten'; summary: LogSummary } | null {
    if (this.reader === null) return null;
    const rawChange = this.reader.getFileChange();
    if (rawChange === FileChange.UNCHANGED) return null;
    return this.synchronizeToCurrentFileState(rawChange);
  }

  /** `elog/checkChanges`'s handler (see elogProtocol.ts's `ElogMethods.checkChanges` doc comment) -- same underlying check as `checkForChanges()`, wrapped into the RPC-facing result shape (always returns a summary, whether or not anything changed). */
  checkChanges(): CheckChangesResult {
    const result = this.checkForChanges();
    if (result === null) return { changed: false, summary: this.getSummary() };
    return { changed: true, change: result.change, summary: result.summary };
  }

  /**
   * Runs the Java `EventLogInput.doSynchronize()` orchestration verbatim (source:
   * `omnetpp-dev/ui/.../common/eventlog/EventLogInput.java`): `eventLog.synchronize()`
   * (whichever of the raw `EventLog`/`FilteredEventLog` is currently active -- Java's
   * single `eventLog` field plays both roles, see this class's `log` getter), THEN
   * `getEventLogTableFacade().synchronize()`, THEN `getSequenceChartFacade().synchronize()`
   * -- in that order (verified: Java calls the table facade before the sequence chart
   * facade). Both facades' own `synchronize()` only re-derive/re-anchor their *own*
   * state (timeline coordinate system, filter-mode caches) from the already-synchronized
   * log, so the two calls are independent of each other, but the order is kept faithful
   * to the source rather than relying on that independence.
   */
  private synchronizeToCurrentFileState(rawChange: FileChange): { change: 'appended' | 'overwritten'; summary: LogSummary } {
    if (this.reader === null || this.eventLog === null) throw new Error('EngineSession.synchronizeToCurrentFileState: no file open');
    const change: 'appended' | 'overwritten' = rawChange === FileChange.APPENDED ? 'appended' : 'overwritten';
    const engineChange = rawChange === FileChange.APPENDED ? FileChange.APPENDED : FileChange.OVERWRITTEN;

    this.log.synchronize(engineChange);
    this.tableFacade?.synchronize(engineChange);
    this.sequenceChartFacade?.synchronize(engineChange);

    if (engineChange === FileChange.OVERWRITTEN) {
      // OVERWRITTEN's synchronize() path is a full reset (EventLog/FilteredEventLog's
      // own `clearInternalState()` -- see their `synchronize()` methods): every pin
      // (including first/last) is wiped along with the rest of the caches, and the
      // sequence chart facade's timeline coordinate system is left undefined (its
      // `clearInternalState()` doesn't re-establish one -- there is no Java-side
      // equivalent of an EngineSession to make that call, since the Eclipse IDE's
      // SequenceChart widget re-anchors lazily on its own). Any retained FilterParams
      // are untouched (they live as plain fields on the same `FilteredEventLog`
      // instance, which OVERWRITTEN never replaces -- only its caches are cleared), so
      // "re-apply retained FilterParams" falls out for free here; re-establish a sane
      // default anchor the same way open() does.
      this.pinnedViewportEventNumbers = [];
      this.pinnedLastEventNumber = null;
      this.pinFirstEvent();
    }
    this.repinLastEvent();

    this.logVersion++;
    return { change, summary: this.getSummary() };
  }

  /** Pins the current first event and relocates the sequence chart's timeline coordinate system origin to it (a sane default anchor) -- shared by `open()` and the OVERWRITTEN synchronize path (see this file's header on both). No-op on an empty log. */
  private pinFirstEvent(): void {
    const first = this.log.getFirstEvent();
    if (first === null) return;
    this.pinnable.pinEvent(first.getEventNumber());
    this.sc.relocateTimelineCoordinateSystem(first);
  }

  /**
   * Moves the "pin the last event" protection (see `pinnedLastEventNumber`'s doc
   * comment) to whatever the current last event is: unpins the previously-pinned
   * event number (if it's no longer the last one), then pins the new last event.
   * Called after every open()/synchronize() -- a no-op churn-wise on an unchanged log
   * (same event number in, same event number out).
   */
  private repinLastEvent(): void {
    const last = this.log.getLastEvent();
    const lastEventNumber = last !== null ? last.getEventNumber() : null;
    if (this.pinnedLastEventNumber !== null && this.pinnedLastEventNumber !== lastEventNumber) {
      this.pinnable.unpinEvent(this.pinnedLastEventNumber);
    }
    if (last !== null) this.pinnable.pinEvent(last.getEventNumber());
    this.pinnedLastEventNumber = lastEventNumber;
  }

  // ---- the active log (raw or filtered) + facades -----------------------------------

  private get log(): IEventLog {
    if (this.filteredEventLog !== null) return this.filteredEventLog;
    if (this.eventLog !== null) return this.eventLog;
    throw new Error('EngineSession: no file open');
  }

  private get pinnable(): Pinnable {
    return (this.filteredEventLog ?? this.eventLog) as unknown as Pinnable;
  }

  private get sc(): SequenceChartFacade {
    if (this.sequenceChartFacade === null) throw new Error('EngineSession: no file open');
    return this.sequenceChartFacade;
  }

  private get table(): EventLogTableFacade {
    if (this.tableFacade === null) throw new Error('EngineSession: no file open');
    return this.tableFacade;
  }

  // ---- elog/open, elog/getSummary ---------------------------------------------------

  open(params: OpenParams): LogSummary {
    this.closeInternal();
    this.path = params.path;
    const raf = new NodeRandomAccessFile(params.path);
    this.reader = new FileReader(raf);
    const options: EventLogOptions = { ...toEventLogOptions(params.options), onProgress: this.onProgress };
    this.eventLog = new EventLog(this.reader, options);
    this.filteredEventLog = null;
    this.rebuildFacades(this.eventLog);
    this.logVersion++;
    // pin the origin (first event) so relocate-to-start stays cheap and the initial
    // timeline coordinate system has a stable anchor across subsequent viewport pins;
    // also pin the last event (phase E9 -- see `pinnedLastEventNumber`'s doc comment).
    // `closeInternal()` above already reset `pinnedLastEventNumber` to null.
    this.pinFirstEvent();
    this.repinLastEvent();
    return this.getSummary();
  }

  /**
   * `elog/releaseMemory`'s handler -- see `elogProtocol.ts`'s `ElogMethods.
   * releaseMemory`/`ReleaseMemoryResult` doc comments for the exact Java precedent and
   * what is/isn't reported. Reuses the SAME reset path an actually-detected OVERWRITTEN
   * file change runs (`synchronizeToCurrentFileState()`) -- the only difference is that
   * nothing on disk actually changed, so `FileReader`'s own tail-compare would report
   * UNCHANGED if asked; this action forces the reset unconditionally instead of asking.
   */
  releaseMemory(): ReleaseMemoryResult {
    if (this.eventLog === null) throw new Error('EngineSession.releaseMemory: no file open');
    const eventCacheLimit = this.eventLog.getEventCacheLimit();
    const eventCacheSizeBefore = this.eventLog.getEventCacheSize();
    const { summary } = this.synchronizeToCurrentFileState(FileChange.OVERWRITTEN);
    const eventCacheSizeAfter = this.eventLog.getEventCacheSize();
    return { summary, eventCacheSizeBefore, eventCacheSizeAfter, eventCacheLimit };
  }

  getSummary(): LogSummary {
    const log = this.log;
    const isEmpty = log.isEmpty();
    return {
      path: this.path!,
      fileSize: this.reader!.getFileSize(),
      isEmpty,
      firstEventNumber: log.getFirstEventNumber(),
      lastEventNumber: log.getLastEventNumber(),
      firstSimulationTime: isEmpty ? null : log.getFirstSimulationTime().toString(),
      lastSimulationTime: isEmpty ? null : log.getLastSimulationTime().toString(),
      approximateNumberOfEvents: log.getApproximateNumberOfEvents(),
      coordinateSystemVersion: this.logVersion,
      filtered: this.filteredEventLog !== null,
    };
  }

  close(): void {
    this.closeInternal();
  }

  private closeInternal(): void {
    this.reader?.close();
    this.path = null;
    this.reader = null;
    this.eventLog = null;
    this.filteredEventLog = null;
    this.sequenceChartFacade = null;
    this.tableFacade = null;
    this.pinnedViewportEventNumbers = [];
    this.pinnedLastEventNumber = null;
    this.attachedVectors.clear();
  }

  private rebuildFacades(log: IEventLog): void {
    // Facades have no `onProgress` option of their own: `progress()` calls anywhere in
    // the facade/FilteredEventLog call graph forward to the root `EventLog.progress()`
    // (checked: `EventLogFacade`/`FilteredEventLog` both implement `progress()` as
    // `this.eventLog.progress()`), which already carries the single `onProgress` hook
    // wired at `open()` time -- see this file's header.
    this.sequenceChartFacade = new SequenceChartFacade(log);
    this.tableFacade = new EventLogTableFacade(log);
  }

  // ---- elog/getModuleTree ------------------------------------------------------------

  getModuleTree(): ElogModule | null {
    return buildModuleTree(this.log);
  }

  /** ADDITIVE (phase U7): filter-panel autocompletion data -- see `filterHints.ts`'s header. Cheap (bounded scan), not routed through `runJob()`/progress like `setFilter`. */
  getFilterHints(): FilterHints {
    return buildFilterHints(this.log);
  }

  // ---- elog/setFilter ------------------------------------------------------------------

  setFilter(params: FilterParams | null): LogSummary {
    if (this.eventLog === null) throw new Error('EngineSession.setFilter: no file open');
    if (params === null) {
      this.filteredEventLog = null;
    } else {
      const filtered = new FilteredEventLog(this.eventLog, {});
      applyFilterParams(filtered, params);
      this.filteredEventLog = filtered;
    }
    this.rebuildFacades(this.log);
    this.pinnedViewportEventNumbers = [];
    // The previously-pinned last-event number (if any) was pinned on whichever log
    // object was active before this call (the raw `EventLog`, or a now-discarded
    // `FilteredEventLog`) -- not on the newly-active `this.log`/`this.pinnable`. Rather
    // than unpin it on the wrong object, just drop the bookkeeping: the next
    // synchronize() (`repinLastEvent()`) re-populates it fresh against whichever log
    // is active then, and in the meantime the current last event stays protected
    // regardless via `EventLog`/`FilteredEventLog`'s own automatic first/last-event
    // eviction guard (phase E7).
    this.pinnedLastEventNumber = null;
    this.logVersion++;
    return this.getSummary();
  }

  // ---- Sequence Chart: timeline mode / origin ---------------------------------------

  scSetTimelineMode(params: ScSetTimelineModeParams): ScState {
    const facade = this.sc;
    facade.setTimelineMode(params.timelineMode);
    if (params.separateEventLogEntries !== undefined) facade.setSeparateEventLogEntries(params.separateEventLogEntries);
    if (params.nonLinearMinimumTimelineCoordinateDelta !== undefined) facade.setNonLinearMinimumTimelineCoordinateDelta(params.nonLinearMinimumTimelineCoordinateDelta);
    if (params.nonLinearFocus !== undefined) facade.setNonLinearFocus(params.nonLinearFocus);
    return this.getScState();
  }

  scRelocateOrigin(params: ScRelocateOriginParams): ScState {
    const facade = this.sc;
    if (params.eventNumber === null) {
      facade.undefineTimelineCoordinateSystem();
    } else {
      const event = this.log.getEventForEventNumber(params.eventNumber);
      if (event === null) throw new Error(`EngineSession.scRelocateOrigin: no event #${params.eventNumber}`);
      facade.relocateTimelineCoordinateSystem(event);
    }
    return this.getScState();
  }

  private getScState(): ScState {
    const facade = this.sc;
    const originEventNumber = facade.getTimelineCoordinateSystemOriginEventNumber();
    return {
      timelineMode: facade.getTimelineMode(),
      separateEventLogEntries: facade.getSeparateEventLogEntries(),
      nonLinearMinimumTimelineCoordinateDelta: facade.getNonLinearMinimumTimelineCoordinateDelta(),
      nonLinearFocus: facade.getNonLinearFocus(),
      originEventNumber: originEventNumber < 0 ? null : originEventNumber,
      coordinateSystemVersion: facade.getTimelineCoordinateSystemVersion(),
    };
  }

  // ---- elog/sc/getViewport -----------------------------------------------------------

  scGetViewport(params: ViewportParams): ViewportModel {
    const facade = this.sc;
    const log = this.log;
    const maxEvents = params.maxEvents ?? DEFAULT_MAX_VIEWPORT_EVENTS;

    const { startEvent, endEvent } = this.resolveViewportRange(params.range, params.marginTc ?? 0);
    // unpin the previous viewport's events before pinning the new range (see this
    // file's header on pinning) -- prevents the pinned set from growing unbounded as
    // the user pans/zooms.
    for (const n of this.pinnedViewportEventNumbers) this.pinnable.unpinEvent(n);
    this.pinnedViewportEventNumbers = [];

    const events: TimelineEvent[] = [];
    const moduleIds = new Set<number>();
    let truncated = false;

    if (startEvent !== null && endEvent !== null) {
      let event: IEvent | null = startEvent;
      let count = 0;
      for (;;) {
        log.progress();
        if (event === null) break;
        if (count >= maxEvents) {
          truncated = true;
          break;
        }
        this.pinnable.pinEvent(event.getEventNumber());
        this.pinnedViewportEventNumbers.push(event.getEventNumber());
        const moduleId = event.getModuleId();
        if (params.includeModuleIds === undefined || params.includeModuleIds.includes(moduleId)) {
          events.push({
            eventNumber: event.getEventNumber(),
            moduleId,
            simulationTime: event.getSimulationTime().toString(),
            tcBegin: facade.getTimelineCoordinateBegin(event),
            tcEnd: facade.getTimelineCoordinateEnd(event),
            causeEventNumber: event.getCauseEventNumber(),
            isSelfMessageProcessingEvent: event.isSelfMessageProcessingEvent(),
          });
          moduleIds.add(moduleId);
        }
        count++;
        if (event.getEventNumber() === endEvent.getEventNumber()) break;
        event = event.getNextEvent();
      }
    }

    const dependencies: RenderDependency[] = [];
    if ((params.includeDependencies ?? true) && startEvent !== null && endEvent !== null) {
      for (const dep of facade.getIntersectingMessageDependencies(startEvent, endEvent)) {
        const rendered = this.renderDependency(dep, facade);
        dependencies.push(rendered);
        if (rendered.causeModuleId !== null) moduleIds.add(rendered.causeModuleId);
        if (rendered.consequenceModuleId !== null) moduleIds.add(rendered.consequenceModuleId);
      }
    }

    const methodCalls: RenderMethodCall[] = [];
    if ((params.includeMethodCalls ?? true) && startEvent !== null && endEvent !== null) {
      for (const entry of facade.getComponentMethodBeginEntries(startEvent, endEvent)) {
        const event = entry.getEvent();
        const tc = facade.EventLogEntry_getTimelineCoordinate(entry);
        // The call spans [begin entry, matching end entry] -- Java draws a faint bar over
        // that width (`getComponentMethodEndEntry` + `EventLogEntry_getTimelineCoordinate`).
        // `getComponentMethodEndEntry` lives on the concrete Event (not IEvent), so access
        // it defensively; fall back to a zero-width call if unavailable.
        const endEntry = (event as unknown as { getComponentMethodEndEntry?(b: typeof entry): EventLogEntry | null } | null)?.getComponentMethodEndEntry?.(entry) ?? null;
        let tcEnd = tc;
        if (endEntry !== null) {
          try {
            tcEnd = facade.EventLogEntry_getTimelineCoordinate(endEntry);
          } catch {
            tcEnd = tc;
          }
        }
        methodCalls.push({
          eventNumber: event!.getEventNumber(),
          tc,
          tcEnd,
          sourceModuleId: entry.sourceComponentId,
          targetModuleId: entry.targetComponentId,
          methodName: entry.methodName,
        });
        moduleIds.add(entry.sourceComponentId);
        moduleIds.add(entry.targetComponentId);
      }
    }

    const axisVectorStrips = this.attachedVectors.size > 0 ? this.buildAxisVectorStrips(startEvent, endEvent) : undefined;

    return {
      coordinateSystemVersion: facade.getTimelineCoordinateSystemVersion(),
      events,
      dependencies,
      methodCalls,
      moduleIds: [...moduleIds],
      truncated,
      axisVectorStrips,
    };
  }

  // ---- axis vector data (Eclipse AxisVectorBarRenderer) ------------------------------

  /** `elog/sc/listVectors` -- parse a `.vec` file's declarations for the attach picker. */
  scListVectors(params: ScListVectorsParams): ScListVectorsResult {
    const { runs, vectors } = listVectors(params.content);
    return {
      runs,
      vectors: vectors.map((v) => ({ run: runs[0] ?? '', vectorModule: v.module, vectorName: v.name, columns: v.columns.spec, type: v.type })),
    };
  }

  /** `elog/sc/attachVector` -- load the chosen vector's samples and attach it to a module axis. */
  scAttachVector(params: ScAttachVectorParams): void {
    const { vectors } = listVectors(params.content);
    const decl = vectors.find((v) => v.module === params.vector.vectorModule && v.name === params.vector.vectorName);
    if (!decl) throw new Error(`attachVector: vector ${params.vector.vectorModule}:${params.vector.vectorName} not found`);
    const data = readVector(params.content, decl.id);
    if (!data) throw new Error(`attachVector: could not read vector id ${decl.id}`);
    this.attachedVectors.set(params.moduleId, data);
  }

  /** `elog/sc/detachVector` -- drop a module axis's attached vector. */
  scDetachVector(params: ScDetachVectorParams): void {
    this.attachedVectors.delete(params.moduleId);
  }

  /**
   * Builds the per-axis value-step segments for every attached vector that overlaps the
   * `[startEvent, endEvent]` window (Eclipse `AxisVectorBarRenderer.drawAxis`): each sample
   * holds its value from its own event to the next sample's event; the segment's `[tcBegin,
   * tcEnd]` comes from mapping those event numbers to timeline coordinates (falling back to
   * the sample's simulation time when the event is filtered out / unknown).
   */
  private buildAxisVectorStrips(startEvent: IEvent | null, endEvent: IEvent | null): AxisVectorStrip[] {
    const facade = this.sc;
    const startNo = startEvent?.getEventNumber() ?? 0;
    const endNo = endEvent?.getEventNumber() ?? Number.MAX_SAFE_INTEGER;
    const strips: AxisVectorStrip[] = [];
    for (const [moduleId, data] of this.attachedVectors) {
      const segments: AxisVectorSegment[] = [];
      const s = data.samples;
      for (let i = 0; i < s.length; i++) {
        const next = s[i + 1];
        // The segment spans this sample's event .. the next sample's event (or +inf for the
        // last one). Cull segments entirely outside the visible event window (a coarse but
        // cheap bound; the client clips to pixels).
        const segEndNo = next ? next.eventNumber ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
        const segStartNo = s[i].eventNumber ?? 0;
        if (segEndNo < startNo || segStartNo > endNo) continue;
        const tcBegin = this.vectorSampleTc(facade, s[i]);
        const tcEnd = next ? this.vectorSampleTc(facade, next) : tcBegin;
        if (tcBegin === null) continue;
        segments.push({
          tcBegin,
          tcEnd: tcEnd ?? tcBegin,
          colorIndex: vectorValueIndex(s[i].value, data.info, i),
          value: s[i].value,
          valueText: vectorValueText(s[i].value, data.info),
        });
      }
      if (segments.length > 0) strips.push({ moduleId, segments });
    }
    return strips;
  }

  /** Maps a vector sample to a timeline coordinate: by its event number when present/known, else by its simulation time (Eclipse's filtered-event fallback). */
  private vectorSampleTc(facade: SequenceChartFacade, sample: VecSample): number | null {
    if (sample.eventNumber !== null) {
      const event = this.log.getEventForEventNumber(sample.eventNumber);
      if (event !== null) return facade.getTimelineCoordinateBegin(event);
    }
    try {
      return facade.getTimelineCoordinateForSimulationTime(BigDecimal.parse(String(sample.simtime)));
    } catch {
      return null;
    }
  }

  private resolveViewportRange(range: ViewportParams['range'], marginTc: number): { startEvent: IEvent | null; endEvent: IEvent | null } {
    const facade = this.sc;
    const log = this.log;
    if (range.kind === 'event') {
      return { startEvent: log.getEventForEventNumber(range.startEventNumber), endEvent: log.getEventForEventNumber(range.endEventNumber) };
    }
    const tcBegin = range.tcBegin - marginTc;
    const tcEnd = range.tcEnd + marginTc;
    const startEvent = facade.getFirstEventNotBeforeTimelineCoordinate(tcBegin);
    const endEvent = facade.getLastEventNotAfterTimelineCoordinate(tcEnd);
    return { startEvent, endEvent };
  }

  private renderDependency(dep: IMessageDependency, facade: SequenceChartFacade): RenderDependency {
    const kind: RenderDependency['kind'] = dep instanceof MessageReuseDependency ? 'reuse' : dep instanceof FilteredMessageDependency ? 'filtered' : 'send';
    const causeEvent = dep.getCauseEvent();
    const consequenceEvent = dep.getConsequenceEvent();
    const beginMessage = dep.getBeginMessageDescriptionEntry();
    // The cause MODULE is normally the cause event's module, but for a plain send the true
    // sender is the module CONTEXT at the send entry: a message scheduled inside a method
    // call (e.g. a self-message sent from within `initialize()`) is attributed to the
    // CALLED module, not the event's own (compound/system) module -- so the arrow leaves
    // the right axis and a self-scheduled message reads as a self-message. Only for `send`
    // (the begin entry lives in the cause event), and only when the context is a real module.
    let causeModuleId = causeEvent?.getModuleId() ?? null;
    if (kind === 'send' && beginMessage !== null && beginMessage.contextModuleId >= 0 && beginMessage.getEvent()?.getEventNumber() === causeEvent?.getEventNumber()) {
      causeModuleId = beginMessage.contextModuleId;
    }
    const result: RenderDependency = {
      kind,
      causeEventNumber: dep.getCauseEventNumber(),
      causeModuleId,
      // Java `drawMessageDependency()` (SequenceChart.java:4540-4548): the cause endpoint is
      // the cause event's END (right edge of the pill), or -- for a non-reuse (send)
      // dependency -- the specific send entry's timeline coordinate, which SPREADS several
      // outgoing arrows across the cause pill instead of stacking them on one point.
      causeTc: this.dependencyCauseTc(facade, causeEvent, dep.getCauseSimulationTime(), kind === 'send' ? beginMessage : null),
      causeSimulationTime: dep.getCauseSimulationTime().toString(),
      consequenceEventNumber: dep.getConsequenceEventNumber(),
      consequenceModuleId: consequenceEvent?.getModuleId() ?? null,
      // Consequence endpoint: the consequence event's BEGIN (left edge), or -- for a reuse
      // dependency -- the reused entry's coordinate (spread across the consequence pill).
      consequenceTc: this.dependencyConsequenceTc(facade, consequenceEvent, dep.getConsequenceSimulationTime(), kind === 'reuse' ? beginMessage : null),
      consequenceSimulationTime: dep.getConsequenceSimulationTime().toString(),
      messageName: beginMessage?.messageName ?? null,
      messageClassName: beginMessage?.messageClassName ?? null,
      messageId: beginMessage?.messageId ?? null,
    };
    if (dep instanceof FilteredMessageDependency) {
      switch (dep.getKind()) {
        case FilteredMessageDependencyKind.SENDS:
          result.filteredKind = 'sends';
          break;
        case FilteredMessageDependencyKind.REUSES:
          result.filteredKind = 'reuses';
          break;
        case FilteredMessageDependencyKind.MIXED:
          result.filteredKind = 'mixed';
          break;
      }
    } else if (kind === 'send') {
      this.fillTransmissionDuration(result, dep, causeEvent, beginMessage, facade);
    }
    return result;
  }

  /**
   * Populates `transmissionDurationFraction`/`isReceptionStart` for a plain (non-reuse,
   * non-filtered) send dependency -- see `RenderDependency`'s own doc for the
   * fraction-of-arrow-span simplification. `getEndSendEntry`/`getTransmissionDelay`/
   * `getRemainingDuration` live only on the concrete `Event`/`FilteredEvent` classes
   * (not the `IEvent` interface, matching Java's `Event`-only placement) -- accessed via
   * a narrow duck-typed check so a hypothetical future `IEvent` implementor lacking them
   * just yields "no transmission-duration decoration" instead of a crash.
   */
  private fillTransmissionDuration(result: RenderDependency, dep: IMessageDependency, causeEvent: IEvent | null, beginMessage: ReturnType<IMessageDependency['getBeginMessageDescriptionEntry']>, facade: SequenceChartFacade): void {
    if (causeEvent === null || !(beginMessage instanceof BeginSendEntry)) return;
    // NOTE: the generated entry classes (entries.ts) expose plain FIELDS, not Java-style
    // getters -- `isDeliveredImmediately`, not `getIsDeliveredImmediately()`. Calling the
    // Java getter name here crashed every viewport fetch on logs whose sends carry
    // transmission durations (e.g. PureAloha), leaving the chart permanently blank.
    const withSend = causeEvent as unknown as { getEndSendEntry?(b: BeginSendEntry): { isDeliveredImmediately: boolean } | null; getTransmissionDelay?(b: BeginSendEntry): BigDecimal; getRemainingDuration?(b: BeginSendEntry): BigDecimal };
    if (typeof withSend.getEndSendEntry !== 'function' || typeof withSend.getTransmissionDelay !== 'function' || typeof withSend.getRemainingDuration !== 'function') return;
    const endSendEntry = withSend.getEndSendEntry(beginMessage);
    if (endSendEntry === null) return;
    const remainingDuration = withSend.getRemainingDuration(beginMessage);
    if (remainingDuration.equals(BigDecimal.ZERO)) return;
    const transmissionDelay = withSend.getTransmissionDelay(beginMessage);
    const span = dep.getConsequenceSimulationTime().subtract(dep.getCauseSimulationTime());
    if (span.lessOrEqual(BigDecimal.ZERO)) return;
    const fraction = Number(transmissionDelay.toString()) / Number(span.toString());
    if (!Number.isFinite(fraction)) return;
    result.transmissionDurationFraction = Math.max(0, fraction);
    result.isReceptionStart = endSendEntry.isDeliveredImmediately;

    if (result.causeTc === null || result.consequenceTc === null) return;
    const consequenceEvent = dep.getConsequenceEvent();
    if (consequenceEvent === null) return;

    const causeSimulationTime = causeEvent.getSimulationTime();
    const consequenceSimulationTime = dep.getConsequenceSimulationTime();

    let causeModuleId = causeEvent.getModuleId();
    if (beginMessage.contextModuleId >= 0 && beginMessage.getEvent()?.getEventNumber() === causeEvent.getEventNumber()) {
      causeModuleId = beginMessage.contextModuleId;
    }
    const consequenceModuleId = consequenceEvent.getModuleId();

    const t3 = causeSimulationTime.add(remainingDuration);
    const isReceptionStart = endSendEntry.isDeliveredImmediately;
    const t4 = isReceptionStart ? consequenceSimulationTime.add(remainingDuration) : consequenceSimulationTime;

    const tc1 = result.causeTc;
    const tc2 = isReceptionStart ? result.consequenceTc : Math.max(tc1, facade.getTimelineCoordinateForSimulationTimeAndEventInModule(consequenceSimulationTime.subtract(transmissionDelay), consequenceModuleId));
    const tc3 = this.getTimelineCoordinateEndForSimulationTimeAndEventInModule(facade, t3, causeModuleId);
    const tc4 = !isReceptionStart ? facade.getTimelineCoordinateEnd(consequenceEvent) : Math.max(tc3, this.getTimelineCoordinateEndForSimulationTimeAndEventInModule(facade, t4, consequenceModuleId));

    result.transmissionDurationTc1 = tc1;
    result.transmissionDurationTc2 = tc2;
    result.transmissionDurationTc3 = tc3;
    result.transmissionDurationTc4 = tc4;
  }

  private getTimelineCoordinateEndForSimulationTimeAndEventInModule(facade: SequenceChartFacade, simulationTime: BigDecimal, moduleId: number): number {
    const eventLog = this.eventLog!;
    let event = eventLog.getLastEventNotAfterSimulationTime(simulationTime);
    while (event !== null && event.getSimulationTime().equals(simulationTime)) {
      if (event.getModuleId() === moduleId) return facade.getTimelineCoordinateEnd(event);
      event = event.getNextEvent();
    }
    return facade.getTimelineCoordinateForSimulationTime(simulationTime);
  }

  /**
   * A dependency's cause/consequence side can legitimately fall outside the currently
   * known event range: message-reuse dependencies report `causeEventNumber === -1`
   * ("no cause", `EventNumberKind.NO_SUCH_EVENT`-style sentinel) for a message that was
   * scheduled from `initialize()`, and a still-in-flight message at the very end of a
   * (possibly still-running) log reports `consequenceEventNumber` as an
   * `EventNumberKind.EVENT_NOT_YET_REACHED`-derived sentinel with a real but
   * *future* (beyond `getLastSimulationTime()`) `getConsequenceSimulationTime()`.
   * `SequenceChartFacade.getTimelineCoordinateForSimulationTime()` asserts its input is
   * within `[getFirstSimulationTime(), getLastSimulationTime()]` (an engine
   * precondition, not an E8 bug -- see eventLogIndex.test.ts's documented behavior for
   * `EventLogIndex.searchForOffset()`), so this checks the bound first and reports
   * `null` (a valid `RenderDependency` field, per elogProtocol.ts) instead of letting
   * that assertion throw and fail the whole viewport. When the event object itself
   * already resolved (in range), its cached coordinate is used directly instead --
   * cheaper, and correct even for a duplicate simulation time.
   */
  private simTimeToTcOrNull(facade: SequenceChartFacade, event: IEvent | null, simTime: BigDecimal): number | null {
    if (event !== null) return facade.getTimelineCoordinateBegin(event);
    const log = this.log;
    if (log.isEmpty()) return null;
    if (simTime.less(log.getFirstSimulationTime()) || simTime.greater(log.getLastSimulationTime())) return null;
    return facade.getTimelineCoordinateForSimulationTime(simTime);
  }

  /**
   * Coordinate for a `RenderDependency`'s CAUSE endpoint (Java `getEventXViewportCoordinate*`
   * for the cause side). Defaults to the cause event's END (the pill's right edge); if a
   * spread `entry` is given (the send entry of a non-reuse dependency, living in the cause
   * event), uses that entry's own timeline coordinate so multiple sends fan out across the
   * pill. Falls back to the simulation-time mapping when the cause event is off the parsed
   * range (a split/offscreen arrow). Zero-width events (SIMULATION_TIME/EVENT_NUMBER, or no
   * entry separation) collapse begin==end, so this is unchanged there.
   */
  private dependencyCauseTc(facade: SequenceChartFacade, event: IEvent | null, simTime: BigDecimal, entry: EventLogEntry | null): number | null {
    if (event === null) return this.offscreenTc(facade, simTime);
    let tc = facade.getTimelineCoordinateEnd(event);
    if (entry !== null) {
      try {
        if (entry.getEvent()?.getEventNumber() === event.getEventNumber()) tc = facade.EventLogEntry_getTimelineCoordinate(entry);
      } catch {
        /* keep the default end-of-pill coordinate */
      }
    }
    return tc;
  }

  /** Consequence endpoint: the consequence event's BEGIN (pill's left edge), or the reused entry's coordinate (spread) when `entry` is given. See `dependencyCauseTc()`. */
  private dependencyConsequenceTc(facade: SequenceChartFacade, event: IEvent | null, simTime: BigDecimal, entry: EventLogEntry | null): number | null {
    if (event === null) return this.offscreenTc(facade, simTime);
    let tc = facade.getTimelineCoordinateBegin(event);
    if (entry !== null) {
      try {
        if (entry.getEvent()?.getEventNumber() === event.getEventNumber()) tc = facade.EventLogEntry_getTimelineCoordinate(entry);
      } catch {
        /* keep the default begin-of-pill coordinate */
      }
    }
    return tc;
  }

  private offscreenTc(facade: SequenceChartFacade, simTime: BigDecimal): number | null {
    const log = this.log;
    if (log.isEmpty()) return null;
    if (simTime.less(log.getFirstSimulationTime()) || simTime.greater(log.getLastSimulationTime())) return null;
    return facade.getTimelineCoordinateForSimulationTime(simTime);
  }

  // ---- elog/sc/mapCoords ---------------------------------------------------------------

  scMapCoords(params: MapCoordsParams): MapCoordsResult {
    const facade = this.sc;
    const version = facade.getTimelineCoordinateSystemVersion();
    switch (params.kind) {
      case 'tcToSimTime':
        return { tc: params.tc, simulationTime: facade.getSimulationTimeForTimelineCoordinate(params.tc, params.upperLimit ?? false).toString(), eventNumber: null, coordinateSystemVersion: version };
      case 'simTimeToTc': {
        const tc = facade.getTimelineCoordinateForSimulationTime(BigDecimal.parse(params.simulationTime), params.upperLimit ?? false);
        return { tc, simulationTime: params.simulationTime, eventNumber: null, coordinateSystemVersion: version };
      }
      case 'eventToTc': {
        const event = this.log.getEventForEventNumber(params.eventNumber);
        return { tc: event !== null ? facade.getTimelineCoordinateBegin(event) : null, simulationTime: event?.getSimulationTime().toString() ?? null, eventNumber: params.eventNumber, coordinateSystemVersion: version };
      }
      case 'tcToEventNumber': {
        const event = facade.getLastEventNotAfterTimelineCoordinate(params.tc) ?? facade.getFirstEventNotBeforeTimelineCoordinate(params.tc);
        return { tc: params.tc, simulationTime: event?.getSimulationTime().toString() ?? null, eventNumber: event?.getEventNumber() ?? null, coordinateSystemVersion: version };
      }
    }
  }

  // ---- elog/sc/adjacencyMatrix ---------------------------------------------------------

  scAdjacencyMatrix(params: AdjacencyParams): AdjacencyResult {
    const facade = this.sc;
    const moduleIdToAxisIndexMap = new Map<number, number>();
    // Phase U8 (additive): descendant-module -> ancestor-axis mappings first, so the
    // positional `moduleIds` seeding below wins for any id present in both (see
    // `AdjacencyParams.moduleIdToAxisIndex`'s doc comment in elogProtocol.ts).
    if (params.moduleIdToAxisIndex) {
      for (const [idString, axisIndex] of Object.entries(params.moduleIdToAxisIndex)) {
        const id = Number(idString);
        if (Number.isSafeInteger(id) && axisIndex >= 0 && axisIndex < params.moduleIds.length) moduleIdToAxisIndexMap.set(id, axisIndex);
      }
    }
    params.moduleIds.forEach((id, index) => moduleIdToAxisIndexMap.set(id, index));
    let matrix: number[];
    if (params.numberOfSamples !== undefined) {
      matrix = facade.getApproximateMessageDependencyCountAdjacencyMatrix(moduleIdToAxisIndexMap, params.numberOfSamples, params.messageSendWeight, params.messageReuseWeight);
    } else {
      const startEvent = this.log.getEventForEventNumber(params.startEventNumber ?? this.log.getFirstEventNumber());
      const endEvent = this.log.getEventForEventNumber(params.endEventNumber ?? this.log.getLastEventNumber());
      if (startEvent === null || endEvent === null) throw new Error('EngineSession.scAdjacencyMatrix: start/end event not found');
      matrix = facade.getMessageDependencyCountAdjacencyMatrix(moduleIdToAxisIndexMap, startEvent, endEvent, params.messageSendWeight, params.messageReuseWeight);
    }
    return { numberOfAxes: params.moduleIds.length, matrix };
  }

  // ---- Event Log table -----------------------------------------------------------------

  private resolveRef(ref: RowRef): EventLogEntry | null {
    const event = this.log.getEventForEventNumber(ref.eventNumber);
    if (event === null) return null;
    if (ref.entryIndex < 0 || ref.entryIndex >= event.getNumEventLogEntries()) return null;
    return event.getEventLogEntry(ref.entryIndex);
  }

  private resolveAnchor(anchor: RowAnchor): EventLogEntry | null {
    const table = this.table;
    switch (anchor.kind) {
      case 'first':
        return table.getFirstEntry();
      case 'last':
        return table.getLastEntry();
      case 'percentage':
        return table.getApproximateEventLogEntryAt(anchor.percentage);
      case 'ref': {
        const entry = this.resolveRef(anchor.ref);
        if (entry === null) return null;
        return table.matchesFilter(entry) ? entry : table.getClosestEntryInEvent(entry);
      }
      case 'event': {
        // Same resolution `gotoEvent`'s `GotoResult.ref` uses (see
        // `eventToGotoResult()`): the first (index 0) matching entry of the event,
        // under the table's *current* filter mode -- always resolvable (the "E" line
        // always passes every filter) as long as the event itself exists.
        const event = this.log.getEventForEventNumber(anchor.eventNumber);
        if (event === null) return null;
        return table.getEntryInEvent(event, 0);
      }
    }
  }

  tableGetRows(params: RowWindowParams): RowWindow {
    const table = this.table;
    if (params.filterMode !== undefined) table.setFilterMode(params.filterMode);
    if (params.customFilterPattern !== undefined) table.setCustomFilter(params.customFilterPattern);

    const anchor = this.resolveAnchor(params.anchor);
    if (anchor === null) {
      return { rows: [], anchorIndex: -1, approximatePercentage: 0, approximateNumberOfEntries: table.getApproximateNumberOfEntries(), hasMoreBefore: false, hasMoreAfter: false };
    }

    // Phase U2: build the row-rendering context/modes once per call (not per row) --
    // see toTableRow()/tableRowRenderer.ts. `undefined` when the caller didn't ask for
    // `render` (e.g. tableNavigate/tablePosition's internal bookkeeping fetches).
    const render = params.render;

    const before: TableRow[] = [];
    let cursor: EventLogEntry | null = anchor;
    for (let i = 0; i < params.before; i++) {
      cursor = table.getNeighbourEntry(cursor, -1);
      if (cursor === null) break;
      before.unshift(this.toTableRow(cursor, render));
    }
    const hasMoreBefore = cursor !== null && table.getNeighbourEntry(cursor, -1) !== null;

    const after: TableRow[] = [this.toTableRow(anchor, render)];
    cursor = anchor;
    for (let i = 1; i < params.after; i++) {
      cursor = table.getNeighbourEntry(cursor, 1);
      if (cursor === null) break;
      after.push(this.toTableRow(cursor, render));
    }
    const hasMoreAfter = cursor !== null && table.getNeighbourEntry(cursor, 1) !== null;

    return {
      rows: [...before, ...after],
      anchorIndex: before.length,
      approximatePercentage: table.getApproximatePercentageForEntry(anchor),
      approximateNumberOfEntries: table.getApproximateNumberOfEntries(),
      hasMoreBefore,
      hasMoreAfter,
    };
  }

  /** Phase U2: `toTableRow()` plus, when `render` is given, a populated `TableRow.rendered` (see tableRowRenderer.ts). */
  private toTableRow(entry: EventLogEntry, render: RowWindowParams['render']): TableRow {
    const row = toTableRow(entry);
    if (render === undefined) return row;
    const table = this.table;
    const ctx: TableRowRenderContext = {
      getModuleDescriptionEntry: (moduleId) => this.log.getEventLogEntryCache().getModuleDescriptionEntry(moduleId),
      getGateDescriptionEntry: (moduleId, gateId) => this.log.getEventLogEntryCache().getGateDescriptionEntry(moduleId, gateId),
      getModuleFullPath: (moduleDescriptionEntry) => table.ModuleDescriptionEntry_getModuleFullPath(moduleDescriptionEntry),
      getEventForEventNumber: (eventNumber) => this.log.getEventForEventNumber(eventNumber),
    };
    row.rendered = renderTableRow(entry, ctx, render);
    return row;
  }

  tableNavigate(params: TableNavigateParams): RowRef | null {
    const entry = this.resolveRef(params.ref);
    if (entry === null) return null;
    const target = this.table.getNeighbourEntry(entry, params.distance);
    return target === null ? null : toRowRef(target);
  }

  tablePosition(params: TablePositionParams): TablePositionResult {
    const entry = this.resolveRef(params.ref);
    const table = this.table;
    return {
      approximatePercentage: entry !== null ? table.getApproximatePercentageForEntry(entry) : 0,
      approximateNumberOfEntries: table.getApproximateNumberOfEntries(),
    };
  }

  /** `elog/table/gotoRelated` -- port of `EventLogTableContributor.java`'s "Go To" family (see `TableGotoRelation`'s doc in elogProtocol.ts for the exact per-relation algorithm/citations). */
  tableGotoRelated(params: TableGotoRelatedParams): RowRef | null {
    const log = this.log;
    const table = this.table;
    const event = log.getEventForEventNumber(params.from.eventNumber);
    if (event === null) return null;
    const focusedEntry = params.from.entryIndex >= 0 && params.from.entryIndex < event.getNumEventLogEntries() ? event.getEventLogEntry(params.from.entryIndex) : null;

    let targetEntry: EventLogEntry | null = null;
    let gotoClosest = false;

    switch (params.relation) {
      case 'cause': {
        const cause = event.getCause();
        targetEntry = cause?.getBeginMessageDescriptionEntry() ?? null;
        gotoClosest = true;
        break;
      }
      case 'arrival': {
        const consequences = event.getConsequences().filter((c) => !(c instanceof MessageReuseDependency));
        if (consequences.length === 1) {
          targetEntry = consequences[0].getConsequenceEvent()?.getEventEntry() ?? null;
        } else if (focusedEntry !== null) {
          for (const consequence of event.getConsequences()) {
            if (consequence instanceof MessageReuseDependency) continue;
            const beginEntry = consequence.getBeginMessageDescriptionEntry();
            if (beginEntry !== null && sameEntry(beginEntry, focusedEntry)) {
              targetEntry = consequence.getConsequenceEvent()?.getEventEntry() ?? null;
              break;
            }
          }
        }
        break;
      }
      case 'origin': {
        if (focusedEntry !== null) {
          for (const cause of event.getCauses()) {
            if (!(cause instanceof MessageReuseDependency)) continue;
            const beginEntry = cause.getBeginMessageDescriptionEntry();
            if (beginEntry !== null && sameEntry(beginEntry, focusedEntry)) {
              targetEntry = cause.getCauseEvent()?.getEventEntry() ?? null;
              break;
            }
          }
        }
        break;
      }
      case 'reuse': {
        for (const consequence of event.getConsequences()) {
          if (consequence instanceof MessageReuseDependency) {
            targetEntry = consequence.getBeginMessageDescriptionEntry();
            break;
          }
        }
        gotoClosest = true;
        break;
      }
      case 'prevEvent':
        targetEntry = event.getPreviousEvent()?.getEventEntry() ?? null;
        break;
      case 'nextEvent':
        targetEntry = event.getNextEvent()?.getEventEntry() ?? null;
        break;
      case 'prevModuleEvent': {
        const moduleId = event.getModuleId();
        let cur: IEvent | null = event;
        while (cur !== null) {
          log.progress();
          cur = cur.getPreviousEvent();
          if (cur !== null && cur.getModuleId() === moduleId) {
            targetEntry = cur.getEventEntry();
            break;
          }
        }
        break;
      }
      case 'nextModuleEvent': {
        const moduleId = event.getModuleId();
        let cur: IEvent | null = event;
        while (cur !== null) {
          log.progress();
          cur = cur.getNextEvent();
          if (cur !== null && cur.getModuleId() === moduleId) {
            targetEntry = cur.getEventEntry();
            break;
          }
        }
        break;
      }
    }

    if (targetEntry === null) return null;
    const resolved = gotoClosest && !table.matchesFilter(targetEntry) ? table.getClosestEntryInEvent(targetEntry) : targetEntry;
    return toRowRef(resolved);
  }

  // ---- elog/gotoEvent, elog/gotoSimTime ------------------------------------------------

  gotoEvent(params: GotoEventParams): GotoResult {
    const event = this.log.getEventForEventNumber(params.eventNumber, params.matchKind);
    return this.eventToGotoResult(event);
  }

  /**
   * NOTE for callers: `params.matchKind` defaults to `MatchKind.EXACT` (mirroring
   * `IEventLog.getEventForSimulationTime()`'s own default) -- an EXACT query for a
   * simulation time shared by more than one event is a documented engine precondition
   * violation (throws), not a "not found" result. Multiple events commonly share a
   * simulation time (e.g. several immediately-scheduled self-messages), so a "go to
   * time" UI should generally pass a tolerant `MatchKind` (e.g. `FIRST_OR_PREVIOUS`)
   * rather than rely on the default.
   */
  gotoSimTime(params: GotoSimTimeParams): GotoResult {
    const event = this.log.getEventForSimulationTime(BigDecimal.parse(params.simulationTime), params.matchKind);
    return this.eventToGotoResult(event);
  }

  private eventToGotoResult(event: IEvent | null): GotoResult {
    if (event === null) return { found: false, eventNumber: null, simulationTime: null, ref: null };
    const firstEntry = this.table.getEntryInEvent(event, 0);
    return { found: true, eventNumber: event.getEventNumber(), simulationTime: event.getSimulationTime().toString(), ref: toRowRef(firstEntry) };
  }

  // ---- elog/findText --------------------------------------------------------------------

  findText(params: FindTextParams): FindTextResult {
    const start = params.start === null ? null : this.resolveRef(params.start);
    const found = this.log.findEventLogEntry(start, params.search, params.forward, params.caseSensitive);
    return { found: found !== null, ref: found === null ? null : toRowRef(found) };
  }

  // ---- elog/getEventDetail --------------------------------------------------------------

  getEventDetail(params: EventDetailParams): EventDetail | null {
    const event = this.log.getEventForEventNumber(params.eventNumber);
    if (event === null) return null;
    const entries: TableRow[] = [];
    for (let i = 0; i < event.getNumEventLogEntries(); i++) entries.push(toTableRow(event.getEventLogEntry(i)));
    return {
      eventNumber: event.getEventNumber(),
      simulationTime: event.getSimulationTime().toString(),
      moduleId: event.getModuleId(),
      causeEventNumber: event.getCauseEventNumber(),
      messageId: event.getMessageId(),
      entries,
    };
  }
}

// ---------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------

function toEventLogOptions(options: ElogOpenOptions | undefined): EventLogOptions {
  if (options === undefined) return {};
  return {
    eventCacheLimit: options.eventCacheLimit,
    offsetCacheLimit: options.offsetCacheLimit,
    smallFileThresholdBytes: options.smallFileThresholdBytes,
    parseBeginEndBytes: options.parseBeginEndBytes,
  };
}

function toRowRef(entry: EventLogEntry): RowRef {
  return { eventNumber: entry.getEventNumber(), entryIndex: entry.getEntryIndex() };
}

/**
 * Compound-key entry-identity comparison (port plan risk #3's established convention --
 * same rationale as `eventLogTableFacade.ts`'s `entryKey()`: a bounded LRU can evict and
 * later re-parse an `Event`, so a fresh `EventLogEntry` object can come back for the same
 * logical `(eventNumber, entryIndex)`; comparing by that compound key instead of object
 * identity/`===` survives that). Java's `EventLogEntry.equals(other)` (the literal
 * comparison `EventLogTableContributor.java`'s "Go To" handlers use) has no override of
 * its own, so it is reference equality there -- safe in Java only because nothing evicts
 * mid-session; this port's engine deliberately does evict, so the compound key is the
 * correct comparison here even though it is a documented deviation from a literal `===`
 * port.
 */
function sameEntry(a: EventLogEntry, b: EventLogEntry): boolean {
  return a.getEntryIndex() === b.getEntryIndex() && a.getEventNumber() === b.getEventNumber();
}

function toTableRow(entry: EventLogEntry): TableRow {
  const fields: Record<string, string | null> = {};
  for (const name of entry.getAttributeNames()) fields[name] = entry.getAsString(name);
  return {
    ref: toRowRef(entry),
    entryClassCode: entry.getAsString() ?? '',
    entryClassName: entry.getClassName(),
    level: entry.getLevel(),
    contextModuleId: entry.getContextModuleId(),
    simulationTime: entry.getSimulationTime().toString(),
    eventNumber: entry.getEventNumber(),
    fields,
    text: entry instanceof EventLogMessageEntry ? entry.text : null,
  };
}

function applyFilterParams(filtered: FilteredEventLog, params: FilterParams): void {
  if (params.firstConsideredEventNumber !== undefined) filtered.setFirstConsideredEventNumber(params.firstConsideredEventNumber);
  if (params.lastConsideredEventNumber !== undefined) filtered.setLastConsideredEventNumber(params.lastConsideredEventNumber);
  if (params.excludedEventNumbers !== undefined) filtered.setExcludedEventNumbers(params.excludedEventNumbers);
  if (params.collectMessageReuses !== undefined) filtered.setCollectMessageReuses(params.collectMessageReuses);

  if (params.enableModuleFilter !== undefined) filtered.setEnableModuleFilter(params.enableModuleFilter);
  if (params.moduleExpression !== undefined) filtered.setModuleExpression(params.moduleExpression);
  if (params.moduleNames !== undefined) filtered.setModuleNames(params.moduleNames);
  if (params.moduleClassNames !== undefined) filtered.setModuleClassNames(params.moduleClassNames);
  if (params.moduleNedTypeNames !== undefined) filtered.setModuleNedTypeNames(params.moduleNedTypeNames);
  if (params.moduleIds !== undefined) filtered.setModuleIds(params.moduleIds);

  if (params.enableMessageFilter !== undefined) filtered.setEnableMessageFilter(params.enableMessageFilter);
  if (params.messageExpression !== undefined) filtered.setMessageExpression(params.messageExpression);
  if (params.messageNames !== undefined) filtered.setMessageNames(params.messageNames);
  if (params.messageClassNames !== undefined) filtered.setMessageClassNames(params.messageClassNames);
  if (params.messageIds !== undefined) filtered.setMessageIds(params.messageIds);
  if (params.messageTreeIds !== undefined) filtered.setMessageTreeIds(params.messageTreeIds);
  if (params.messageEncapsulationIds !== undefined) filtered.setMessageEncapsulationIds(params.messageEncapsulationIds);
  if (params.messageEncapsulationTreeIds !== undefined) filtered.setMessageEncapsulationTreeIds(params.messageEncapsulationTreeIds);

  if (params.tracedEventNumber !== undefined) filtered.setTracedEventNumber(params.tracedEventNumber);
  if (params.traceCauses !== undefined) filtered.setTraceCauses(params.traceCauses);
  if (params.traceConsequences !== undefined) filtered.setTraceConsequences(params.traceConsequences);
  if (params.traceSelfMessages !== undefined) filtered.setTraceSelfMessages(params.traceSelfMessages);
  if (params.traceMessageReuses !== undefined) filtered.setTraceMessageReuses(params.traceMessageReuses);
  if (params.maximumCauseDepth !== undefined) filtered.setMaximumCauseDepth(params.maximumCauseDepth);
  if (params.maximumNumberOfCauses !== undefined) filtered.setMaximumNumberOfCauses(params.maximumNumberOfCauses);
  if (params.maximumCauseCollectionTime !== undefined) filtered.setMaximumCauseCollectionTime(params.maximumCauseCollectionTime);
  if (params.maximumConsequenceDepth !== undefined) filtered.setMaximumConsequenceDepth(params.maximumConsequenceDepth);
  if (params.maximumNumberOfConsequences !== undefined) filtered.setMaximumNumberOfConsequences(params.maximumNumberOfConsequences);
  if (params.maximumConsequenceCollectionTime !== undefined) filtered.setMaximumConsequenceCollectionTime(params.maximumConsequenceCollectionTime);
}
