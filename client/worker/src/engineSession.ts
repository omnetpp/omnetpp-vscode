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
  BigDecimal,
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
  type IEvent,
  type IEventLog,
  type IMessageDependency,
  MessageReuseDependency,
  SequenceChartFacade,
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
  TableNavigateParams,
  TablePositionParams,
  TablePositionResult,
  TableRow,
  TimelineEvent,
  ViewportModel,
  ViewportParams,
  RenderDependency,
  RenderMethodCall,
} from '@omnetpp/shared/elog-protocol';

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
        methodCalls.push({
          eventNumber: entry.getEvent()!.getEventNumber(),
          tc: facade.EventLogEntry_getTimelineCoordinate(entry),
          sourceModuleId: entry.sourceComponentId,
          targetModuleId: entry.targetComponentId,
          methodName: entry.methodName,
        });
        moduleIds.add(entry.sourceComponentId);
        moduleIds.add(entry.targetComponentId);
      }
    }

    return {
      coordinateSystemVersion: facade.getTimelineCoordinateSystemVersion(),
      events,
      dependencies,
      methodCalls,
      moduleIds: [...moduleIds],
      truncated,
    };
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
    return {
      kind,
      causeEventNumber: dep.getCauseEventNumber(),
      causeModuleId: causeEvent?.getModuleId() ?? null,
      causeTc: this.simTimeToTcOrNull(facade, causeEvent, dep.getCauseSimulationTime()),
      causeSimulationTime: dep.getCauseSimulationTime().toString(),
      consequenceEventNumber: dep.getConsequenceEventNumber(),
      consequenceModuleId: consequenceEvent?.getModuleId() ?? null,
      consequenceTc: this.simTimeToTcOrNull(facade, consequenceEvent, dep.getConsequenceSimulationTime()),
      consequenceSimulationTime: dep.getConsequenceSimulationTime().toString(),
      messageName: beginMessage?.messageName ?? null,
      messageClassName: beginMessage?.messageClassName ?? null,
    };
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

    const before: TableRow[] = [];
    let cursor: EventLogEntry | null = anchor;
    for (let i = 0; i < params.before; i++) {
      cursor = table.getNeighbourEntry(cursor, -1);
      if (cursor === null) break;
      before.unshift(toTableRow(cursor));
    }
    const hasMoreBefore = cursor !== null && table.getNeighbourEntry(cursor, -1) !== null;

    const after: TableRow[] = [toTableRow(anchor)];
    cursor = anchor;
    for (let i = 1; i < params.after; i++) {
      cursor = table.getNeighbourEntry(cursor, 1);
      if (cursor === null) break;
      after.push(toTableRow(cursor));
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
