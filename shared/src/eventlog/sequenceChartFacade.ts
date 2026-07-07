/**
 * SequenceChartFacade — the timeline coordinate system the Sequence Chart (U-track
 * phases) renders against. Ported from:
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/SequenceChartFacade.java
 *
 * Per the plan's Architecture section ("compute split: facades return zoom-independent
 * TIMELINE COORDINATES; pixel mapping happens in the webview"), every coordinate this
 * file computes or returns is a plain `number` in an abstract, zoom-independent unit
 * space -- never a pixel. The four `TimelineMode`s (SIMULATION_TIME, EVENT_NUMBER, STEP,
 * NONLINEAR) are four different mappings from "which event" to "where on that abstract
 * axis", chosen by the user; a `timelineCoordinateSystemVersion` counter plus a
 * "coordinate system origin" (an event number + its simulation time) let the UI relocate
 * the whole coordinate system (e.g. "recenter on the selected event") cheaply, without
 * recomputing every event's coordinate up front.
 *
 * MANDATED DEVIATION (plan's "Memory bounding" section, called out explicitly in the E6
 * task): Java caches each event's computed timeline coordinates (begin/end + the
 * coordinate-system version they were computed under) as three fields directly on the
 * `IEvent`/`Event` object itself (`setCachedTimelineCoordinateBegin()` etc., ported in
 * event.ts's `EventBase` for interface fidelity, but deliberately UNUSED by this file).
 * Storing the cache there is exactly the kind of long-lived per-event state phase E7's
 * bounded event LRU cannot tolerate (an evicted-then-refetched `Event` for the same event
 * number would come back with the cache fields reset to their construction-time
 * defaults, silently "forgetting" coordinates that are still logically valid). Instead,
 * this facade keeps its own side table, `timelineCoordinateCache: Map<eventNumber,
 * {begin, end, version}>`, keyed by `getEventNumber()` (not by object identity) --
 * exactly the shape the plan calls for ("cached per-event timeline coordinates go in a
 * facade-side Map... survive event eviction; trim contiguously"). All public method
 * NAMES are kept identical to the Java source (`getTimelineCoordinateBegin`,
 * `getCachedTimelineCoordinateBegin`, `relocateTimelineCoordinateSystem`, ...) -- only
 * the internal storage differs.
 *
 * BOUNDING (phase E7, `coordCacheLimit`, default 500_000): the coordinate cache is
 * capped in two ways:
 *  1. Every relocation (`relocateTimelineCoordinateSystem()`/`undefineTimelineCoordinateSystem()`)
 *     bumps `timelineCoordinateSystemVersion`, which permanently invalidates every
 *     existing cache entry (`getCachedVersion(event) < timelineCoordinateSystemVersion`
 *     forever after). Since those entries can never be read again, both methods clear
 *     the whole map outright -- a strict improvement over "just let it become unbounded
 *     dead weight".
 *  2. Within one coordinate-system version, `getTimelineCoordinateBegin()`'s STEP/
 *     NONLINEAR branch extends `[timelineCoordinateRangeStartEventNumber,
 *     timelineCoordinateRangeEndEventNumber]` one real event at a time (via
 *     `getNextEvent()`/`getPreviousEvent()`), caching every event it steps over -- so
 *     the cache is always exactly the (possibly non-contiguous-in-event-NUMBER, but
 *     contiguous-in-event-SEQUENCE) set of events between those two markers. Once the
 *     cache exceeds `coordCacheLimit`, `trimTimelineCoordinateCacheAfterExtension()`
 *     removes entries from the FAR end of that range (opposite whichever end this call
 *     just extended -- the near end is where the current and likely-next queries are),
 *     walking inward one real event at a time (not "eventNumber +- 1": event numbers
 *     are not guaranteed contiguous integers, see eventLogIndex.ts's `CacheEntry`
 *     header) and shrinking the corresponding range marker to match, so the invariant
 *     "the range markers always point at actually-cached events" is preserved and a
 *     later query can always resume extending from wherever the range now ends. This
 *     is safe for correctness because the STEP/NONLINEAR coordinate at any event is
 *     computed purely from a chain of adjacent-event deltas relative to the fixed
 *     `timelineCoordinateSystemOriginEventNumber`/`OriginSimulationTime` scalars (not
 *     from any other cached value) -- if a query later needs a since-trimmed event's
 *     coordinate again, re-extending the range from the current boundary reproduces
 *     the exact same numbers.
 *
 * Object-identity caveats (port plan risk #3, same convention as event.ts/eventLog.ts):
 * every loop below that walks forward/backward comparing "have I reached the target
 * event yet" compares `getEventNumber()`, not `===`/`==` -- each site carries its own
 * comment. Two RefObject-style Java out-parameter patterns (`getEventForNonLinearTimelineCoordinate`'s
 * `forward` flag, `extractSimulationTimesAndTimelineCoordinates`'s nine out-parameters)
 * are collapsed into a single returned object each, following the same convention
 * ieventlog.ts's `ReadToEventLineResult` and filteredEventLog.ts's `getEntryAndDistance`
 * already established in earlier phases.
 *
 * Java interpretation call (reported per the phase task): `getTimelineCoordinateForSimulationTimeAndEventInModule()`
 * compares `event.getSimulationTime() == simulationTime` -- reference equality on two
 * independently constructed `BigDecimal`s, which is essentially always false and would
 * silently disable the "is there an event for this exact simulation time in this
 * module" loop. This is the same class of bug FilteredEventLog.java has (see
 * filteredEventLog.ts's header, deviation #2) and is ported the same way: as `.equals()`.
 *
 * The "viewport-supporting" methods (`getComponentMethodBeginEntries`,
 * `getIntersectingMessageDependencies`, the message-dependency adjacency-matrix family)
 * are ported here too -- they live on `SequenceChartFacade.java` itself (not on the SWT
 * `SequenceChart` widget), have no UI dependency, and E8's viewport model / U8's
 * minimize-crossings axis ordering will need them. Everything genuinely SWT/UI-side
 * (hit-testing, drawing, widget event handling) stays out, deferred to the U-track.
 */

import { BigDecimal } from './bigDecimal';
import { FileChange, MatchKind, TimelineMode } from './enums';
import { BeginSendEntry, ComponentMethodBeginEntry, ComponentMethodEndEntry } from './entries';
import type { EventLogEntry } from './eventLogEntry';
import { EventLogFacade } from './facade';
import type { IEvent, IEventLog, IMessageDependency } from './ieventlog';
import { MessageReuseDependency, MessageSendDependency } from './messageDependency';

/** One event's cached timeline coordinates -- see this file's header for why this lives in a facade-side map instead of on the `Event` object. */
interface TimelineCoordinateCacheEntry {
  begin: number;
  end: number;
  version: number;
}

/** Result of `extractSimulationTimesAndTimelineCoordinates()`, replacing Java's nine `RefObject` out-parameters. */
interface ExtractedTimelineInfo {
  nextEvent: IEvent | null;
  eventSimulationTime: BigDecimal;
  eventTimelineCoordinateBegin: number;
  eventTimelineCoordinateEnd: number;
  nextEventSimulationTime: BigDecimal;
  nextEventTimelineCoordinateBegin: number;
  nextEventTimelineCoordinateEnd: number;
  simulationTimeDelta: BigDecimal;
  timelineCoordinateDelta: number;
}

/** Constructor options for `SequenceChartFacade` -- see this file's header, "BOUNDING". */
export interface SequenceChartFacadeOptions {
  /**
   * Max number of events with cached timeline coordinates before the FAR end of the
   * contiguous computed range is trimmed (relative to whichever end was most recently
   * extended). Default 500_000.
   */
  coordCacheLimit?: number;
}

/** Port of `SequenceChartFacade`. */
export class SequenceChartFacade extends EventLogFacade {
  protected separateEventLogEntries = false; // separate entries within events
  protected timelineCoordinateSystemVersion = -1; // a counter incremented each time the timeline coordinate system is relocated
  protected timelineCoordinateSystemOriginEventNumber = -1; // -1 means undefined, otherwise the event number of the timeline coordinate system origin
  protected timelineCoordinateSystemOriginSimulationTime: BigDecimal = BigDecimal.MINUS_ONE; // undefined until the first relocate
  protected timelineCoordinateRangeStartEventNumber = -1; // -1 means undefined, the beginning of the continuous event range which has timeline coordinates assigned
  protected timelineCoordinateRangeEndEventNumber = -1; // -1 means undefined, the end of the continuous event range which has timeline coordinates assigned
  protected timelineMode: TimelineMode = TimelineMode.NONLINEAR;
  protected nonLinearFocus = -1; // a useful constant for the nonlinear transformation between simulation time and timeline coordinate
  protected nonLinearMinimumTimelineCoordinateDelta = 0.1; // minimum timeline coordinate difference between two events

  /** MANDATED DEVIATION -- see this file's header. Keyed by `getEventNumber()`, not object identity. */
  private readonly timelineCoordinateCache = new Map<number, TimelineCoordinateCacheEntry>();
  private readonly coordCacheLimit: number;

  constructor(eventLog: IEventLog, options: SequenceChartFacadeOptions = {}) {
    super(eventLog);
    this.coordCacheLimit = options.coordCacheLimit ?? 500_000;
    this.clearInternalState();
    this.setTimelineMode(TimelineMode.NONLINEAR);
  }

  /** Number of events with cached timeline coordinates -- exposed for tests/instrumentation (phase E7). */
  getTimelineCoordinateCacheSize(): number {
    return this.timelineCoordinateCache.size;
  }

  calculateNonLinearFocus(): number {
    if (!this.eventLog.isEmpty()) {
      const lastEventSimulationTime = this.eventLog.getLastEvent()!.getSimulationTime().doubleValue();
      const firstEventSimulationTime = this.eventLog.getFirstEvent()!.getSimulationTime().doubleValue();
      let totalSimulationTimeDelta = lastEventSimulationTime - firstEventSimulationTime;
      if (totalSimulationTimeDelta === 0) totalSimulationTimeDelta = firstEventSimulationTime;
      if (totalSimulationTimeDelta === 0) return 1;
      else return totalSimulationTimeDelta / this.eventLog.getApproximateNumberOfEvents() / 10;
    } else return 1;
  }

  override synchronize(change: FileChange): void {
    if (change !== FileChange.UNCHANGED) {
      switch (change) {
        case FileChange.OVERWRITTEN:
          super.synchronize(change);
          this.clearInternalState();
          break;
        case FileChange.APPENDED: {
          super.synchronize(change);
          const event = this.timelineCoordinateSystemOriginEventNumber !== -1 ? this.eventLog.getEventForEventNumber(this.timelineCoordinateSystemOriginEventNumber, MatchKind.EXACT, true) : null;
          if (event !== null) this.relocateTimelineCoordinateSystem(event);
          else this.undefineTimelineCoordinateSystem();
          break;
        }
        default:
          throw new Error('SequenceChartFacade.synchronize: unknown file change');
      }
    }
  }

  getTimelineMode(): TimelineMode {
    return this.timelineMode;
  }

  setTimelineMode(timelineMode: TimelineMode): void {
    this.timelineMode = timelineMode;
    if (this.timelineCoordinateSystemOriginEventNumber !== -1) this.relocateTimelineCoordinateSystem(this.eventLog.getEventForEventNumber(this.timelineCoordinateSystemOriginEventNumber)!);
  }

  getSeparateEventLogEntries(): boolean {
    return this.separateEventLogEntries;
  }

  setSeparateEventLogEntries(separateEventLogEntries: boolean): void {
    this.separateEventLogEntries = separateEventLogEntries;
  }

  getNonLinearMinimumTimelineCoordinateDelta(): number {
    return this.nonLinearMinimumTimelineCoordinateDelta;
  }

  setNonLinearMinimumTimelineCoordinateDelta(value: number): void {
    if (!(value >= 0)) throw new Error('SequenceChartFacade.setNonLinearMinimumTimelineCoordinateDelta: value must be >= 0');
    this.nonLinearMinimumTimelineCoordinateDelta = value;
  }

  getNonLinearFocus(): number {
    if (this.nonLinearFocus === -1) this.nonLinearFocus = this.calculateNonLinearFocus();
    return this.nonLinearFocus;
  }

  setNonLinearFocus(nonLinearFocus: number): void {
    if (!(nonLinearFocus >= 0)) throw new Error('SequenceChartFacade.setNonLinearFocus: nonLinearFocus must be >= 0');
    this.nonLinearFocus = nonLinearFocus;
  }

  getTimelineCoordinateSystemOriginEvent(): IEvent | null {
    return this.eventLog.getEventForEventNumber(this.timelineCoordinateSystemOriginEventNumber);
  }

  getTimelineCoordinateSystemOriginEventNumber(): number {
    return this.timelineCoordinateSystemOriginEventNumber;
  }

  undefineTimelineCoordinateSystem(): void {
    this.timelineCoordinateSystemVersion++;
    this.timelineCoordinateSystemOriginEventNumber = this.timelineCoordinateRangeStartEventNumber = this.timelineCoordinateRangeEndEventNumber = -1;
    this.timelineCoordinateSystemOriginSimulationTime = BigDecimal.MINUS_ONE;
    // phase E7: bumping the version permanently invalidates every existing cache entry -- see this file's header, "BOUNDING" item 1.
    this.timelineCoordinateCache.clear();
  }

  relocateTimelineCoordinateSystem(event: IEvent): void {
    if (event === null) throw new Error('SequenceChartFacade.relocateTimelineCoordinateSystem: event must not be null');
    this.timelineCoordinateSystemVersion++;
    this.timelineCoordinateSystemOriginEventNumber = this.timelineCoordinateRangeStartEventNumber = this.timelineCoordinateRangeEndEventNumber = event.getEventNumber();
    this.timelineCoordinateSystemOriginSimulationTime = event.getSimulationTime();
    // phase E7: bumping the version permanently invalidates every existing cache entry -- see this file's header, "BOUNDING" item 1.
    this.timelineCoordinateCache.clear();
    this.setCachedTimelineCoordinate(event, 0, this.getTimelineCoordinateDelta(event));
  }

  /**
   * Calculates the timeline coordinate delta for the given simulation-time difference
   * or event (Java overload, kept as one name with two signatures per the phase's
   * "keep method names" rule).
   */
  getTimelineCoordinateDelta(simulationTimeDelta: number): number;
  getTimelineCoordinateDelta(event: IEvent): number;
  getTimelineCoordinateDelta(arg: number | IEvent): number {
    if (typeof arg === 'number') {
      if (!(this.getNonLinearFocus() > 0)) throw new Error('SequenceChartFacade.getTimelineCoordinateDelta: nonLinearFocus must be > 0');
      if (this.timelineMode === TimelineMode.STEP) return 1;
      else return this.nonLinearMinimumTimelineCoordinateDelta + (1 - this.nonLinearMinimumTimelineCoordinateDelta) * Math.atan(Math.abs(arg / this.getNonLinearFocus())) / Math.PI * 2;
    }
    const event = arg;
    if (!this.separateEventLogEntries || this.timelineMode === TimelineMode.SIMULATION_TIME || this.timelineMode === TimelineMode.EVENT_NUMBER) return 0;
    else if (this.timelineMode === TimelineMode.STEP || this.timelineMode === TimelineMode.NONLINEAR) {
      let timelineCoordinateDelta = 0;
      for (let i = 0; i < event.getNumEventLogEntries(); i++) {
        const eventLogEntry = event.getEventLogEntry(i);
        if (eventLogEntry instanceof ComponentMethodBeginEntry) timelineCoordinateDelta += this.timelineMode === TimelineMode.STEP ? 1 : this.nonLinearMinimumTimelineCoordinateDelta;
        else if (eventLogEntry instanceof ComponentMethodEndEntry) timelineCoordinateDelta += this.timelineMode === TimelineMode.STEP ? 1 : this.nonLinearMinimumTimelineCoordinateDelta;
        else if (eventLogEntry instanceof BeginSendEntry) timelineCoordinateDelta += this.timelineMode === TimelineMode.STEP ? 1 : this.nonLinearMinimumTimelineCoordinateDelta;
      }
      return timelineCoordinateDelta;
    } else throw new Error('SequenceChartFacade.getTimelineCoordinateDelta: unknown timeline mode');
  }

  getTimelineCoordinateBegin(event: IEvent, lowerTimelineCoordinateCalculationLimit = -Number.MAX_VALUE, upperTimelineCoordinateCalculationLimit = Number.MAX_VALUE): number {
    if (event === null) throw new Error('SequenceChartFacade.getTimelineCoordinateBegin: event must not be null');
    if (event.getEventLog() !== this.eventLog) throw new Error("SequenceChartFacade.getTimelineCoordinateBegin: event does not belong to this facade's eventLog");
    if (this.timelineCoordinateSystemVersion === -1) throw new Error('SequenceChartFacade.getTimelineCoordinateBegin: timeline coordinate system version is undefined');
    if (this.timelineCoordinateSystemOriginEventNumber === -1) throw new Error('SequenceChartFacade.getTimelineCoordinateBegin: timeline coordinate system origin is undefined');

    if (this.timelineCoordinateSystemVersion > this.getCachedVersion(event)) {
      let timelineCoordinateBegin: number;
      let extendedForward: boolean | undefined; // phase E7: set only by the STEP/NONLINEAR branch below, which is the only one that grows the cached range
      switch (this.timelineMode) {
        case TimelineMode.SIMULATION_TIME:
          timelineCoordinateBegin = event.getSimulationTime().subtract(this.timelineCoordinateSystemOriginSimulationTime).doubleValue();
          break;
        case TimelineMode.EVENT_NUMBER:
          timelineCoordinateBegin = event.getEventNumber() - this.timelineCoordinateSystemOriginEventNumber;
          break;
        case TimelineMode.STEP:
        case TimelineMode.NONLINEAR: {
          // do we go forward from end or backward from start of known range
          const forward = event.getEventNumber() > this.timelineCoordinateRangeEndEventNumber;
          let currentEvent: IEvent | null = this.eventLog.getEventForEventNumber(forward ? this.timelineCoordinateRangeEndEventNumber : this.timelineCoordinateRangeStartEventNumber);
          if (!(event.getEventNumber() < this.timelineCoordinateRangeStartEventNumber || this.timelineCoordinateRangeEndEventNumber < event.getEventNumber()))
            throw new Error('SequenceChartFacade.getTimelineCoordinateBegin: event is already within the known timeline coordinate range');
          // LONG RUNNING OPERATION
          // does a linear search towards the event to calculate the non linear timeline coordinate
          do {
            this.eventLog.progress();
            if (currentEvent === null) throw new Error('SequenceChartFacade.getTimelineCoordinateBegin: unexpected end of eventlog while extending the timeline coordinate range');
            const previousEvent: IEvent = currentEvent;
            currentEvent = forward ? currentEvent.getNextEvent() : currentEvent.getPreviousEvent();
            if (currentEvent === null) throw new Error('SequenceChartFacade.getTimelineCoordinateBegin: unexpected end of eventlog while extending the timeline coordinate range');

            const previousSimulationTime = previousEvent.getSimulationTime();
            const previousTimelineCoordinateBegin = this.getRawCachedBegin(previousEvent);
            const simulationTime = currentEvent.getSimulationTime();
            const timelineCoordinateDelta = this.getTimelineCoordinateDelta(simulationTime.subtract(previousSimulationTime).doubleValue()) + this.getTimelineCoordinateDelta(forward ? previousEvent : currentEvent);

            if (forward) {
              timelineCoordinateBegin = previousTimelineCoordinateBegin + timelineCoordinateDelta;
              if (timelineCoordinateBegin > upperTimelineCoordinateCalculationLimit) return NaN;
            } else {
              timelineCoordinateBegin = previousTimelineCoordinateBegin - timelineCoordinateDelta;
              if (timelineCoordinateBegin < lowerTimelineCoordinateCalculationLimit) return NaN;
            }
            this.setCachedTimelineCoordinate(currentEvent, timelineCoordinateBegin, timelineCoordinateBegin + this.getTimelineCoordinateDelta(currentEvent));
            // event-number identity comparison (risk #3): Java compares `currentEvent != event`
          } while (currentEvent.getEventNumber() !== event.getEventNumber());
          if (forward) this.timelineCoordinateRangeEndEventNumber = event.getEventNumber();
          else this.timelineCoordinateRangeStartEventNumber = event.getEventNumber();
          extendedForward = forward;
          break;
        }
        default:
          throw new Error('SequenceChartFacade.getTimelineCoordinateBegin: unknown timeline mode');
      }
      this.setCachedTimelineCoordinate(event, timelineCoordinateBegin, timelineCoordinateBegin + this.getTimelineCoordinateDelta(event));
      // phase E7: bound the cache once the extension (if any) has settled -- see this file's header, "BOUNDING" item 2.
      if (extendedForward !== undefined) this.trimTimelineCoordinateCacheAfterExtension(extendedForward);
    }
    return this.getRawCachedBegin(event);
  }

  getTimelineCoordinateEnd(event: IEvent, lowerTimelineCoordinateCalculationLimit = -Number.MAX_VALUE, upperTimelineCoordinateCalculationLimit = Number.MAX_VALUE): number {
    return this.getTimelineCoordinateDelta(event) + this.getTimelineCoordinateBegin(event, lowerTimelineCoordinateCalculationLimit, upperTimelineCoordinateCalculationLimit);
  }

  /** Port of `getCachedTimelineCoordinateBegin()` -- a PEEK, not a compute: returns -1 if the cached value (if any) predates the current coordinate-system version, without triggering a recompute (unlike `getTimelineCoordinateBegin()` above). */
  getCachedTimelineCoordinateBegin(event: IEvent): number {
    if (event === null) throw new Error('SequenceChartFacade.getCachedTimelineCoordinateBegin: event must not be null');
    if (this.timelineCoordinateSystemVersion === -1) throw new Error('SequenceChartFacade.getCachedTimelineCoordinateBegin: timeline coordinate system version is undefined');
    if (this.timelineCoordinateSystemOriginEventNumber === -1) throw new Error('SequenceChartFacade.getCachedTimelineCoordinateBegin: timeline coordinate system origin is undefined');
    if (this.timelineCoordinateSystemVersion > this.getCachedVersion(event)) return -1;
    else return this.getRawCachedBegin(event);
  }

  /** Port of `getCachedTimelineCoordinateEnd()` (see `getCachedTimelineCoordinateBegin()`'s note). */
  getCachedTimelineCoordinateEnd(event: IEvent): number {
    if (event === null) throw new Error('SequenceChartFacade.getCachedTimelineCoordinateEnd: event must not be null');
    if (this.timelineCoordinateSystemVersion === -1) throw new Error('SequenceChartFacade.getCachedTimelineCoordinateEnd: timeline coordinate system version is undefined');
    if (this.timelineCoordinateSystemOriginEventNumber === -1) throw new Error('SequenceChartFacade.getCachedTimelineCoordinateEnd: timeline coordinate system origin is undefined');
    if (this.timelineCoordinateSystemVersion > this.getCachedVersion(event)) return -1;
    else return this.getRawCachedEnd(event);
  }

  EventLogEntry_getTimelineCoordinate(eventLogEntry: EventLogEntry): number {
    let event = eventLogEntry.getEvent();
    if (event === null) throw new Error('SequenceChartFacade.EventLogEntry_getTimelineCoordinate: eventLogEntry does not belong to an event');
    if (event.getEventLog() !== this.eventLog) {
      // TODO: this may be slow
      const found = this.eventLog.getEventForEventNumber(event.getEventNumber());
      if (found === null) throw new Error('SequenceChartFacade.EventLogEntry_getTimelineCoordinate: event not found in this facade\'s eventLog');
      event = found;
    }
    if (!this.separateEventLogEntries || this.timelineMode === TimelineMode.SIMULATION_TIME || this.timelineMode === TimelineMode.EVENT_NUMBER) return this.getTimelineCoordinateBegin(event);
    else if (this.timelineMode === TimelineMode.STEP || this.timelineMode === TimelineMode.NONLINEAR) {
      let timelineCoordinateDelta = this.timelineMode === TimelineMode.STEP ? 1 : this.nonLinearMinimumTimelineCoordinateDelta;
      for (let i = 0; i < event.getNumEventLogEntries(); i++) {
        const currentEventLogEntry = event.getEventLogEntry(i);
        // TODO: factor with getTimelineCoordinateDelta
        if (eventLogEntry === currentEventLogEntry) return this.getTimelineCoordinateBegin(event) + timelineCoordinateDelta;
        else if (currentEventLogEntry instanceof ComponentMethodBeginEntry) timelineCoordinateDelta += this.timelineMode === TimelineMode.STEP ? 1 : this.nonLinearMinimumTimelineCoordinateDelta;
        else if (currentEventLogEntry instanceof ComponentMethodEndEntry) timelineCoordinateDelta += this.timelineMode === TimelineMode.STEP ? 1 : this.nonLinearMinimumTimelineCoordinateDelta;
        else if (currentEventLogEntry instanceof BeginSendEntry) timelineCoordinateDelta += this.timelineMode === TimelineMode.STEP ? 1 : this.nonLinearMinimumTimelineCoordinateDelta;
      }
      throw new Error('SequenceChartFacade.EventLogEntry_getTimelineCoordinate: EventLogEntry not found');
    } else throw new Error('SequenceChartFacade.EventLogEntry_getTimelineCoordinate: unknown timeline mode');
  }

  EventLogEntry_getNextComponentMethodEntry(eventLogEntry: EventLogEntry): EventLogEntry | null {
    const event = eventLogEntry.getEvent();
    if (event === null) throw new Error('SequenceChartFacade.EventLogEntry_getNextComponentMethodEntry: eventLogEntry does not belong to an event');
    for (let i = eventLogEntry.getEntryIndex() + 1; i < event.getNumEventLogEntries(); i++) {
      const currentEventLogEntry = event.getEventLogEntry(i);
      if (currentEventLogEntry instanceof ComponentMethodBeginEntry || currentEventLogEntry instanceof ComponentMethodEndEntry) return currentEventLogEntry;
    }
    return null;
  }

  /** Port of `getEventForNonLinearTimelineCoordinate()`. Java's `RefObject<Boolean> forward` out-parameter is folded into the returned object (see this file's header). */
  getEventForNonLinearTimelineCoordinate(timelineCoordinate: number): { event: IEvent | null; forward: boolean } {
    if (this.timelineCoordinateSystemOriginEventNumber === -1) throw new Error('SequenceChartFacade.getEventForNonLinearTimelineCoordinate: timeline coordinate system origin is undefined');
    const timelineCoordinateRangeStartEvent = this.eventLog.getEventForEventNumber(this.timelineCoordinateRangeStartEventNumber);
    const timelineCoordinateRangeEndEvent = this.eventLog.getEventForEventNumber(this.timelineCoordinateRangeEndEventNumber);
    if (!(timelineCoordinateRangeStartEvent !== null && timelineCoordinateRangeEndEvent !== null))
      throw new Error('SequenceChartFacade.getEventForNonLinearTimelineCoordinate: timeline coordinate range events not found');
    let currentEvent: IEvent | null;
    let forward: boolean;
    if (timelineCoordinate <= this.getTimelineCoordinateBegin(timelineCoordinateRangeStartEvent)) {
      forward = false;
      currentEvent = timelineCoordinateRangeStartEvent;
    } else if (this.getTimelineCoordinateBegin(timelineCoordinateRangeEndEvent) <= timelineCoordinate) {
      forward = true;
      currentEvent = timelineCoordinateRangeEndEvent;
    } else {
      forward = true;
      currentEvent = timelineCoordinateRangeStartEvent;
    }
    // LONG RUNNING OPERATION
    // does a linear search towards requested non linear timeline coordinate
    while (currentEvent !== null && (forward ? this.getTimelineCoordinateBegin(currentEvent) < timelineCoordinate : timelineCoordinate <= this.getTimelineCoordinateBegin(currentEvent))) {
      this.eventLog.progress();
      currentEvent = forward ? currentEvent.getNextEvent() : currentEvent.getPreviousEvent();
    }
    return { event: currentEvent, forward };
  }

  getLastEventNotAfterTimelineCoordinate(timelineCoordinate: number): IEvent | null {
    if (this.eventLog.isEmpty()) return null;
    switch (this.timelineMode) {
      case TimelineMode.SIMULATION_TIME:
        return this.eventLog.getLastEventNotAfterSimulationTime(this.getSimulationTimeForTimelineCoordinate(timelineCoordinate));
      case TimelineMode.EVENT_NUMBER: {
        const eventNumber = Math.floor(timelineCoordinate) + this.timelineCoordinateSystemOriginEventNumber;
        if (eventNumber < 0) return null;
        else if (eventNumber <= this.eventLog.getLastEventNumber()) return this.eventLog.getLastEventNotAfterEventNumber(eventNumber);
        else return this.eventLog.getLastEvent();
      }
      case TimelineMode.STEP:
      case TimelineMode.NONLINEAR: {
        const { event, forward } = this.getEventForNonLinearTimelineCoordinate(timelineCoordinate);
        const currentEvent = forward ? (event !== null ? event.getPreviousEvent() : this.eventLog.getLastEvent()) : event;
        if (!(currentEvent === null || this.getTimelineCoordinateBegin(currentEvent) <= timelineCoordinate))
          throw new Error('SequenceChartFacade.getLastEventNotAfterTimelineCoordinate: assertion failed');
        return currentEvent;
      }
      default:
        throw new Error('SequenceChartFacade.getLastEventNotAfterTimelineCoordinate: unknown timeline mode');
    }
  }

  getFirstEventNotBeforeTimelineCoordinate(timelineCoordinate: number): IEvent | null {
    if (this.eventLog.isEmpty()) return null;
    switch (this.timelineMode) {
      case TimelineMode.SIMULATION_TIME:
        return this.eventLog.getFirstEventNotBeforeSimulationTime(this.getSimulationTimeForTimelineCoordinate(timelineCoordinate));
      case TimelineMode.EVENT_NUMBER: {
        const eventNumber = Math.floor(timelineCoordinate) + this.timelineCoordinateSystemOriginEventNumber;
        if (eventNumber < 0) return this.eventLog.getFirstEvent();
        else if (eventNumber <= this.eventLog.getLastEventNumber()) return this.eventLog.getFirstEventNotBeforeEventNumber(eventNumber);
        else return null;
      }
      case TimelineMode.STEP:
      case TimelineMode.NONLINEAR: {
        const { event, forward } = this.getEventForNonLinearTimelineCoordinate(timelineCoordinate);
        const currentEvent = forward ? event : event !== null ? event.getNextEvent() : this.eventLog.getFirstEvent();
        if (!(currentEvent === null || this.getTimelineCoordinateBegin(currentEvent) >= timelineCoordinate))
          throw new Error('SequenceChartFacade.getFirstEventNotBeforeTimelineCoordinate: assertion failed');
        return currentEvent;
      }
      default:
        throw new Error('SequenceChartFacade.getFirstEventNotBeforeTimelineCoordinate: unknown timeline mode');
    }
  }

  /**
   * Timeline coordinate can be given in the range (-infinity, +infinity).
   * Simulation time will be in the range [0, lastEventSimulationTime].
   */
  getSimulationTimeForTimelineCoordinate(timelineCoordinate: number, upperLimit = false): BigDecimal {
    if (Number.isNaN(timelineCoordinate)) throw new Error('SequenceChartFacade.getSimulationTimeForTimelineCoordinate: timelineCoordinate must not be NaN');
    if (this.eventLog.isEmpty()) return BigDecimal.ZERO;
    let simulationTime: BigDecimal;
    switch (this.timelineMode) {
      case TimelineMode.SIMULATION_TIME: {
        const lastEventSimulationTime = this.eventLog.getLastEvent()!.getSimulationTime();
        simulationTime = BigDecimal.max(BigDecimal.ZERO, BigDecimal.min(lastEventSimulationTime, BigDecimal.fromDouble(timelineCoordinate).add(this.timelineCoordinateSystemOriginSimulationTime)));
        break;
      }
      case TimelineMode.EVENT_NUMBER:
      case TimelineMode.STEP:
      case TimelineMode.NONLINEAR: {
        const event = this.getLastEventNotAfterTimelineCoordinate(timelineCoordinate);
        const extracted = this.extractSimulationTimesAndTimelineCoordinates(event);
        if (extracted.nextEvent !== null) {
          if (extracted.timelineCoordinateDelta === 0) {
            // IMPORTANT NOTE: this is just an approximation
            simulationTime = upperLimit ? extracted.nextEventSimulationTime : extracted.eventSimulationTime;
          } else {
            const clampedTimelineCoordinate = Math.max(extracted.eventTimelineCoordinateEnd, Math.min(extracted.nextEventTimelineCoordinateBegin, timelineCoordinate));
            simulationTime = extracted.eventSimulationTime.add(
              BigDecimal.fromDouble((extracted.simulationTimeDelta.doubleValue() * (clampedTimelineCoordinate - extracted.eventTimelineCoordinateEnd)) / extracted.timelineCoordinateDelta),
            );
            simulationTime = BigDecimal.max(extracted.eventSimulationTime, BigDecimal.min(extracted.nextEventSimulationTime, simulationTime));
          }
        } else simulationTime = extracted.eventSimulationTime;
        break;
      }
      default:
        throw new Error('SequenceChartFacade.getSimulationTimeForTimelineCoordinate: unknown timeline mode');
    }
    if (!simulationTime.greaterOrEqual(BigDecimal.ZERO)) throw new Error('SequenceChartFacade.getSimulationTimeForTimelineCoordinate: assertion failed (simulationTime < 0)');
    if (!simulationTime.lessOrEqual(this.eventLog.getLastEvent()!.getSimulationTime())) throw new Error('SequenceChartFacade.getSimulationTimeForTimelineCoordinate: assertion failed (simulationTime > last event)');
    return simulationTime;
  }

  /**
   * Simulation time must be in the range [0, lastEventSimulationTime].
   * Timeline coordinate will be in the range [0, lastEventTimelineCoordinate] if the
   * timeline origin is at the first event.
   */
  getTimelineCoordinateForSimulationTime(simulationTime: BigDecimal, upperLimit = false): number {
    if (this.eventLog.isEmpty()) return 0;
    if (!simulationTime.greaterOrEqual(BigDecimal.ZERO)) throw new Error('SequenceChartFacade.getTimelineCoordinateForSimulationTime: simulationTime must be >= 0');
    let timelineCoordinate: number;
    switch (this.timelineMode) {
      case TimelineMode.SIMULATION_TIME:
        timelineCoordinate = simulationTime.subtract(this.timelineCoordinateSystemOriginSimulationTime).doubleValue();
        break;
      case TimelineMode.EVENT_NUMBER:
      case TimelineMode.STEP:
      case TimelineMode.NONLINEAR: {
        const event = this.eventLog.getLastEventNotAfterSimulationTime(simulationTime);
        const extracted = this.extractSimulationTimesAndTimelineCoordinates(event);
        if (extracted.nextEvent !== null) {
          if (extracted.simulationTimeDelta.equals(BigDecimal.ZERO)) {
            // IMPORTANT NOTE: this is just an approximation
            timelineCoordinate = upperLimit ? extracted.nextEventTimelineCoordinateBegin : extracted.eventTimelineCoordinateEnd;
          } else {
            const clampedSimulationTime = BigDecimal.max(extracted.eventSimulationTime, BigDecimal.min(extracted.nextEventSimulationTime, simulationTime));
            timelineCoordinate = extracted.eventTimelineCoordinateEnd + (extracted.timelineCoordinateDelta * clampedSimulationTime.subtract(extracted.eventSimulationTime).doubleValue()) / extracted.simulationTimeDelta.doubleValue();
            timelineCoordinate = Math.max(extracted.eventTimelineCoordinateEnd, Math.min(extracted.nextEventTimelineCoordinateBegin, timelineCoordinate));
          }
        } else timelineCoordinate = extracted.eventTimelineCoordinateBegin;
        break;
      }
      default:
        throw new Error('SequenceChartFacade.getTimelineCoordinateForSimulationTime: unknown timeline mode');
    }
    if (Number.isNaN(timelineCoordinate)) throw new Error('SequenceChartFacade.getTimelineCoordinateForSimulationTime: assertion failed (NaN result)');
    return timelineCoordinate;
  }

  /**
   * Port of `getTimelineCoordinateForSimulationTimeAndEventInModule()`. Java compares
   * `event.getSimulationTime() == simulationTime` -- see this file's header ("Java
   * interpretation call") for why this is ported as `.equals()` instead.
   */
  getTimelineCoordinateForSimulationTimeAndEventInModule(simulationTime: BigDecimal, moduleId: number): number {
    let event = this.eventLog.getLastEventNotAfterSimulationTime(simulationTime);
    while (event !== null && event.getSimulationTime().equals(simulationTime)) {
      if (event.getModuleId() === moduleId) return this.getTimelineCoordinateBegin(event);
      event = event.getNextEvent();
    }
    return this.getTimelineCoordinateForSimulationTime(simulationTime);
  }

  getComponentMethodBeginEntries(startEvent: IEvent, endEvent: IEvent): ComponentMethodBeginEntry[] {
    if (startEvent === null) throw new Error('SequenceChartFacade.getComponentMethodBeginEntries: startEvent must not be null');
    if (endEvent === null) throw new Error('SequenceChartFacade.getComponentMethodBeginEntries: endEvent must not be null');
    const componentMethodBeginEntries: ComponentMethodBeginEntry[] = [];
    for (let event: IEvent | null = startEvent; ; event = event.getNextEvent()) {
      this.eventLog.progress();
      if (event === null) throw new Error('SequenceChartFacade.getComponentMethodBeginEntries: reached the end of the eventlog before endEvent');
      for (let i = 0; i < event.getNumEventLogEntries(); i++) {
        const eventLogEntry = event.getEventLogEntry(i);
        if (eventLogEntry instanceof ComponentMethodBeginEntry) componentMethodBeginEntries.push(eventLogEntry);
      }
      // event-number identity comparison (risk #3): Java compares `event == endEvent`
      if (event.getEventNumber() === endEvent.getEventNumber()) break;
    }
    return componentMethodBeginEntries;
  }

  /**
   * Port of `getIntersectingMessageDependencies()`. Java dedups through a
   * `HashSet<IMessageDependency>`; neither `MessageSendDependency` nor
   * `MessageReuseDependency` override `hashCode()` in the Java sources (checked), so
   * that `HashSet` is, in practice, reference-identity deduplication despite the
   * `equals()` override existing -- a plain JS `Set` (also reference identity) is a
   * faithful port, not a simplification.
   */
  getIntersectingMessageDependencies(startEvent: IEvent, endEvent: IEvent): IMessageDependency[] {
    if (startEvent === null) throw new Error('SequenceChartFacade.getIntersectingMessageDependencies: startEvent must not be null');
    if (endEvent === null) throw new Error('SequenceChartFacade.getIntersectingMessageDependencies: endEvent must not be null');
    const messageDependencies = new Set<IMessageDependency>();
    const startEventNumber = startEvent.getEventNumber();
    // LONG RUNNING OPERATION
    // this might take a while if start and end events are far away from each other
    // if not completed then some dependencies will not be included
    for (let event: IEvent | null = startEvent; ; event = event.getNextEvent()) {
      this.eventLog.progress();
      if (event === null) throw new Error('SequenceChartFacade.getIntersectingMessageDependencies: reached the end of the eventlog before endEvent');
      for (const messageDependency of event.getCauses()) if (messageDependency.getCauseEventNumber() < startEventNumber) messageDependencies.add(messageDependency);
      for (const consequence of event.getConsequences()) messageDependencies.add(consequence);
      // event-number identity comparison (risk #3): Java compares `event == endEvent`
      if (event.getEventNumber() === endEvent.getEventNumber()) break;
    }
    return [...messageDependencies];
  }

  getMessageDependencyCountAdjacencyMatrix(moduleIdToAxisIndexMap: Map<number, number>, eventNumberToEventMap: Map<number, IEvent>, messageSendWeight?: number, messageReuseWeight?: number): number[];
  getMessageDependencyCountAdjacencyMatrix(moduleIdToAxisIndexMap: Map<number, number>, startEvent: IEvent, endEvent: IEvent, messageSendWeight?: number, messageReuseWeight?: number): number[];
  getMessageDependencyCountAdjacencyMatrix(
    moduleIdToAxisIndexMap: Map<number, number>,
    eventNumberToEventMapOrStartEvent: Map<number, IEvent> | IEvent,
    endEventOrMessageSendWeight?: IEvent | number,
    messageSendWeightOrMessageReuseWeight?: number,
    messageReuseWeightMaybe?: number,
  ): number[] {
    let eventNumberToEventMap: Map<number, IEvent>;
    let messageSendWeight: number;
    let messageReuseWeight: number;
    if (eventNumberToEventMapOrStartEvent instanceof Map) {
      eventNumberToEventMap = eventNumberToEventMapOrStartEvent;
      messageSendWeight = (endEventOrMessageSendWeight as number | undefined) ?? 1;
      messageReuseWeight = messageSendWeightOrMessageReuseWeight ?? 1;
    } else {
      const startEvent = eventNumberToEventMapOrStartEvent;
      const endEvent = endEventOrMessageSendWeight as IEvent;
      messageSendWeight = messageSendWeightOrMessageReuseWeight ?? 1;
      messageReuseWeight = messageReuseWeightMaybe ?? 1;
      eventNumberToEventMap = new Map<number, IEvent>();
      for (let event: IEvent | null = startEvent; ; event = event.getNextEvent()) {
        this.eventLog.progress();
        if (event !== null) eventNumberToEventMap.set(event.getEventNumber(), event);
        // event-number identity comparison (risk #3): Java compares `event == endEvent`
        if (event !== null && event.getEventNumber() === endEvent.getEventNumber()) break;
        if (event === null) throw new Error('SequenceChartFacade.getMessageDependencyCountAdjacencyMatrix: reached the end of the eventlog before endEvent');
      }
    }

    const numberOfAxes = new Set(moduleIdToAxisIndexMap.values()).size;
    const adjacencyMatrix = new Array<number>(numberOfAxes * numberOfAxes).fill(0);
    for (const event of eventNumberToEventMap.values()) {
      for (const messageDependency of event.getCauses()) {
        const causeEvent = messageDependency.getCauseEvent();
        const consequenceEvent = messageDependency.getConsequenceEvent();
        let weight = 0;
        if (messageDependency instanceof MessageSendDependency) weight = messageSendWeight;
        else if (messageDependency instanceof MessageReuseDependency) weight = messageReuseWeight;
        if (causeEvent !== null && consequenceEvent !== null && weight !== 0) {
          const causeAxisIndex = moduleIdToAxisIndexMap.get(causeEvent.getModuleId());
          const consequenceAxisIndex = moduleIdToAxisIndexMap.get(consequenceEvent.getModuleId());
          if (causeAxisIndex !== undefined && consequenceAxisIndex !== undefined) {
            const index = causeAxisIndex * numberOfAxes + consequenceAxisIndex;
            adjacencyMatrix[index] += weight;
          }
        }
      }
    }
    return adjacencyMatrix;
  }

  getApproximateMessageDependencyCountAdjacencyMatrix(moduleIdToAxisIndexMap: Map<number, number>, numberOfSamples: number, messageSendWeight = 1, messageReuseWeight = 1): number[] {
    const eventNumberToEventMap = new Map<number, IEvent>();
    for (let i = 0; i < numberOfSamples; i++) {
      this.eventLog.progress();
      // draw random
      const percentage = Math.random();
      const event = this.eventLog.getApproximateEventAt(percentage);
      if (event === null) throw new Error('SequenceChartFacade.getApproximateMessageDependencyCountAdjacencyMatrix: getApproximateEventAt returned null on a non-empty eventlog');
      eventNumberToEventMap.set(event.getEventNumber(), event);
      // look before origin
      if (this.timelineCoordinateSystemOriginEventNumber !== -1) {
        if (this.timelineCoordinateSystemOriginEventNumber - i >= 0) {
          const before = this.eventLog.getEventForEventNumber(this.timelineCoordinateSystemOriginEventNumber - i);
          if (before !== null) eventNumberToEventMap.set(before.getEventNumber(), before);
        }
        // look after origin
        const after = this.eventLog.getEventForEventNumber(this.timelineCoordinateSystemOriginEventNumber + i);
        if (after !== null) eventNumberToEventMap.set(after.getEventNumber(), after);
      }
    }
    return this.getMessageDependencyCountAdjacencyMatrix(moduleIdToAxisIndexMap, eventNumberToEventMap, messageSendWeight, messageReuseWeight);
  }

  /** Port of `extractSimulationTimesAndTimelineCoordinates()` (see this file's header for the RefObject-collapsing convention). */
  private extractSimulationTimesAndTimelineCoordinates(event: IEvent | null): ExtractedTimelineInfo {
    let eventSimulationTime: BigDecimal;
    let eventTimelineCoordinateBegin: number;
    let eventTimelineCoordinateEnd: number;
    let nextEventSimulationTime = BigDecimal.MINUS_ONE;
    let nextEventTimelineCoordinateBegin = NaN;
    let nextEventTimelineCoordinateEnd = NaN;
    let simulationTimeDelta = BigDecimal.ZERO;
    let timelineCoordinateDelta = NaN;

    // if before the first event
    if (event !== null) {
      eventSimulationTime = event.getSimulationTime();
      eventTimelineCoordinateBegin = this.getTimelineCoordinateBegin(event);
      eventTimelineCoordinateEnd = this.getTimelineCoordinateEnd(event);
    } else {
      eventSimulationTime = BigDecimal.ZERO;
      const firstEvent = this.eventLog.getFirstEvent();
      if (firstEvent === null) throw new Error('SequenceChartFacade.extractSimulationTimesAndTimelineCoordinates: eventLog has no first event');
      eventTimelineCoordinateBegin = this.getTimelineCoordinateBegin(firstEvent);
      eventTimelineCoordinateEnd = this.getTimelineCoordinateEnd(firstEvent);

      if (this.timelineMode === TimelineMode.EVENT_NUMBER) {
        eventTimelineCoordinateBegin -= 1;
        eventTimelineCoordinateEnd -= 1;
      } else {
        const delta = this.getTimelineCoordinateDelta(firstEvent.getSimulationTime().doubleValue());
        eventTimelineCoordinateBegin -= delta;
        eventTimelineCoordinateEnd -= delta;
      }
    }
    // linear approximation between two enclosing events
    const nextEvent = event !== null ? event.getNextEvent() : this.eventLog.getFirstEvent();
    if (nextEvent !== null) {
      nextEventSimulationTime = nextEvent.getSimulationTime();
      nextEventTimelineCoordinateBegin = this.getTimelineCoordinateBegin(nextEvent);
      nextEventTimelineCoordinateEnd = this.getTimelineCoordinateEnd(nextEvent);

      simulationTimeDelta = nextEventSimulationTime.subtract(eventSimulationTime);
      timelineCoordinateDelta = nextEventTimelineCoordinateBegin - eventTimelineCoordinateEnd;
    }

    return {
      nextEvent,
      eventSimulationTime,
      eventTimelineCoordinateBegin,
      eventTimelineCoordinateEnd,
      nextEventSimulationTime,
      nextEventTimelineCoordinateBegin,
      nextEventTimelineCoordinateEnd,
      simulationTimeDelta,
      timelineCoordinateDelta,
    };
  }

  protected clearInternalState(): void {
    this.nonLinearFocus = -1;
    this.nonLinearMinimumTimelineCoordinateDelta = 0.1;
    this.undefineTimelineCoordinateSystem();
  }

  // ---- timeline coordinate side-cache helpers (see this file's header) ----

  private getCachedVersion(event: IEvent): number {
    return this.timelineCoordinateCache.get(event.getEventNumber())?.version ?? 0;
  }

  private getRawCachedBegin(event: IEvent): number {
    return this.timelineCoordinateCache.get(event.getEventNumber())?.begin ?? 0;
  }

  private getRawCachedEnd(event: IEvent): number {
    return this.timelineCoordinateCache.get(event.getEventNumber())?.end ?? 0;
  }

  private setCachedTimelineCoordinate(event: IEvent, begin: number, end: number): void {
    this.timelineCoordinateCache.set(event.getEventNumber(), { begin, end, version: this.timelineCoordinateSystemVersion });
  }

  /**
   * Phase E7 memory bounding -- see this file's header, "BOUNDING" item 2. Trims from
   * the FAR end of the contiguous computed range (opposite whichever end `extension`
   * just grew), walking via real `getNextEvent()`/`getPreviousEvent()` (not
   * "eventNumber +- 1": event numbers are not guaranteed contiguous, see
   * eventLogIndex.ts's `CacheEntry` header) so the range markers always keep pointing
   * at an actually-cached event. Stops once the range would collapse to a single
   * event (never trims the last remaining cached event out from under the caller) or
   * if a boundary event turns out unreachable (defensive; should not happen given the
   * class's own invariants).
   */
  private trimTimelineCoordinateCacheAfterExtension(extendedForward: boolean): void {
    while (this.timelineCoordinateCache.size > this.coordCacheLimit && this.timelineCoordinateRangeStartEventNumber !== this.timelineCoordinateRangeEndEventNumber) {
      if (extendedForward) {
        // just grew the end -> the far end is the start; shrink it inward
        const boundaryEvent = this.eventLog.getEventForEventNumber(this.timelineCoordinateRangeStartEventNumber);
        if (boundaryEvent === null) break;
        const next = boundaryEvent.getNextEvent();
        if (next === null) break;
        this.timelineCoordinateCache.delete(boundaryEvent.getEventNumber());
        this.timelineCoordinateRangeStartEventNumber = next.getEventNumber();
      } else {
        // just grew the start -> the far end is the end; shrink it inward
        const boundaryEvent = this.eventLog.getEventForEventNumber(this.timelineCoordinateRangeEndEventNumber);
        if (boundaryEvent === null) break;
        const previous = boundaryEvent.getPreviousEvent();
        if (previous === null) break;
        this.timelineCoordinateCache.delete(boundaryEvent.getEventNumber());
        this.timelineCoordinateRangeEndEventNumber = previous.getEventNumber();
      }
    }
  }
}
