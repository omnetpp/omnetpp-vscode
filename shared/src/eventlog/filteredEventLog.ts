/**
 * A filtering "view" of an `IEventLog`: includes only a subset of events (and their
 * dependencies), by delegation, so multiple filtered views can share the same
 * underlying `IEventLog`. Ported from:
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/FilteredEventLog.java
 *
 * Filter dimensions (see the setters below for the exact fields):
 *  - event range (`firstConsideredEventNumber`/`lastConsideredEventNumber`) + an
 *    explicit exclusion set;
 *  - module filter: a match expression over `ModuleDescriptionEntry` (which already
 *    implements `Matchable` structurally -- see entries.ts), plus name/class-name/
 *    NED-type-name pattern lists and an explicit module-id allowlist; matching walks
 *    up the module's parent chain (so a match on a compound module ancestor also
 *    admits its descendants' events -- unless the event's causes/consequences point
 *    *outside* that ancestor, in which case the whole chain walk aborts);
 *  - message filter: same shape, over each event's `BeginSendEntry`s;
 *  - trace filter: given a `tracedEventNumber`, admit only its causes and/or
 *    consequences (with depth/count/time-budget limits, self-message and
 *    message-reuse toggles) -- see `isCauseOfTracedEvent()`/`isConsequenceOfTracedEvent()`.
 *
 * Two behavioral deviations from the literal Java source (both NOT reproduced,
 * following the same policy as eventLogEntryCache.ts's documented boxed-type-mismatch
 * note -- these are latent upstream bugs that would either crash or silently disable
 * an entire branch, not intentional quirks worth preserving):
 *
 *  1. `isCauseOfTracedEvent()`/`isConsequenceOfTracedEvent()` end with
 *     `return eventNumberToTraceableEventFlagMap.put(eventNumber, false);` -- but
 *     `Map.put()` (Java's `TreeMap` included) returns the *previous* value associated
 *     with the key, not the one just inserted. For an event number not already in the
 *     map (the common case: most events are not causes/consequences of the traced
 *     event, so this exact fallthrough is the typical path for a "no" answer), that
 *     previous value is `null`, and unboxing a `null` `Boolean` to the method's
 *     primitive `boolean` return type throws `NullPointerException` in Java. The
 *     clearly-intended behavior -- cache `false` for this event number, return `false`
 *     -- is what this port does (`.set(eventNumber, false); return false;`).
 *  2. `getEventForSimulationTime()`'s FIRST_OR_PREVIOUS/LAST_OR_NEXT branches compare
 *     `event.getSimulationTime() == simulationTime` -- reference equality on
 *     `BigDecimal` objects that (barring incidental identity) are two independently
 *     constructed values, so this comparison is essentially always `false`, silently
 *     disabling the "landed exactly on a duplicate-simulation-time run" special case
 *     it guards (the surrounding code, and the mirrored EXACT/duplicate-simtime
 *     handling in eventLogIndex.ts's `EventLogIndex.searchForOffset()`, make the
 *     intent unambiguous: a *value* comparison). Ported here as `.equals()`.
 *
 * `setPatternMatchers()`/`setExcludedEventNumbers()` (module/message name-pattern
 * lists, the excluded-event-number set) are, however, ported with their literal
 * "accumulates across repeated calls, does not clear first" behavior intact -- that
 * one is harmless (never crashes, never silently disables anything) as long as each
 * setter is called at most once per instance, which is how `FilteredEventLog` is
 * actually used (one filter application = one fresh instance).
 *
 * A third, genuinely surprising control-flow quirk in `matchesEvent()`'s
 * module-ancestor-chain walk IS preserved (unlike the two numbered above): reaching a
 * compound ancestor that matches the module filter does NOT by itself stop the walk /
 * admit the event -- the `while` loop only stops (leaving `moduleDescriptionEntry`
 * non-null, i.e. "admitted") via (a) matching the event's OWN module directly, or (b)
 * finding that some cause/consequence of the event escapes *outside* the matched
 * ancestor's subtree (the labeled `break outer` inside the crossing-check loops). A
 * "clean" compound-ancestor match with no escaping dependencies falls through and
 * keeps climbing toward the root, same as a non-match at all -- so, counter to what
 * the class's own doc comment ("check if the event has a cause or consequence
 * referring outside the matching compound module") seems to promise, finding an
 * escaping dependency admits the event, while finding none does not. There is no C++
 * original to cross-check this Java-only class against, and this quirk neither
 * crashes nor silently disables an entire feature (module filtering by exact leaf
 * module id, or by an ancestor that also happens to be the event's own module, both
 * work exactly as expected) -- so it is ported literally; see
 * filteredEventLog.test.ts's "compound-ancestor match" tests for the exact asserted
 * (quirky) behavior.
 *
 * MANDATED DEVIATION, phase E7 ("Memory bounding" in the port plan): Java retains
 * `eventNumberToFilteredEventMap`/`eventNumberToFilterMatchesFlagMap`/
 * `eventNumberToTraceableEventFlagMap` forever, same leak class as `EventLog`'s own
 * event cache. This port bounds all three:
 *  - `eventNumberToFilteredEventMap` (the `FilteredEvent` proxy cache) gets the same
 *    LRU treatment as `EventLog.eventNumberToEventMap` (see eventLog.ts's header):
 *    a plain `Map` doubling as LRU order, `firstMatchingEvent`/`lastMatchingEvent`
 *    (and any event number a host pins via `pinEvent()`) protected from eviction --
 *    exactly the property `FilteredEvent.getPreviousEvent()`/`getNextEvent()`'s
 *    `filteredEventLog.getFirstEvent() !== this` identity check relies on (see
 *    filteredEvent.ts's header) -- and eviction unlinks neighbour links the same way.
 *    `filteredEventCacheLimit`, default 50_000.
 *  - `eventNumberToFilterMatchesFlagMap`/`eventNumberToTraceableEventFlagMap` are pure
 *    memoization of boolean predicates (`matchesFilter()`/`isCauseOfTracedEvent()`/
 *    `isConsequenceOfTracedEvent()`) -- cheap to recompute, so per the plan's own
 *    guidance they are simply cleared wholesale once either exceeds
 *    `filteredFlagCacheLimit` (default 2_000_000), rather than LRU-tracked.
 */

import { BigDecimal } from './bigDecimal';
import { FileChange, MatchKind } from './enums';
import { BeginSendEntry, type ModuleDescriptionEntry, type SimulationBeginEntry, type SimulationEndEntry } from './entries';
import { EventBase } from './event';
import { EventLogBase } from './eventLogIndex';
import type { EventLogEntry } from './eventLogEntry';
import type { EventLogEntryCache } from './eventLogEntryCache';
import type { FileReader } from './fileReader';
import { FilteredEvent } from './filteredEvent';
import type { Index, Snapshot } from './chunks';
import type { IEvent, IEventLog, IMessageDependency } from './ieventlog';
import { MatchExpression } from '../match/matchExpression';
import { PatternMatcher } from '../match/patternMatcher';
import { MessageReuseDependency } from './messageDependency';

function isMessageReuseDependency(messageDependency: IMessageDependency): boolean {
  return messageDependency instanceof MessageReuseDependency;
}

const numberCompare = (a: number, b: number): number => a - b;

/** Constructor options for `FilteredEventLog` -- see this file's header, "MANDATED DEVIATION". */
export interface FilteredEventLogOptions {
  /** Max number of `FilteredEvent` proxy objects retained (LRU eviction). Default 50_000. */
  filteredEventCacheLimit?: number;
  /** Max size either boolean memoization map (`matchesFilter()`'s / the trace filter's) may reach before it is wholesale-cleared. Default 2_000_000. */
  filteredFlagCacheLimit?: number;
}

/** Port of `FilteredEventLog`. */
export class FilteredEventLog extends EventLogBase implements IEventLog {
  private readonly eventLog: IEventLog; // never destructed here; might be shared among multiple filtered eventlogs

  private approximateNumberOfEvents = -1;
  private approximateMatchingEventRatio = -1;

  // event range filter
  private firstConsideredEventNumber = -1; // the first event to be considered by the filter, or -1
  private lastConsideredEventNumber = -1; // the last event to be considered by the filter, or -1
  private readonly excludedEventNumbers = new Set<number>();

  // module filter
  private enableModuleFilter = false;
  private readonly moduleExpression = new MatchExpression();
  private readonly moduleNames: PatternMatcher[] = [];
  private readonly moduleClassNames: PatternMatcher[] = [];
  private readonly moduleNedTypeNames: PatternMatcher[] = [];
  private moduleIds: number[] = []; // events outside these modules will be filtered out; empty means "include all"

  // message filter
  private enableMessageFilter = false;
  private readonly messageExpression = new MatchExpression();
  private readonly messageNames: PatternMatcher[] = [];
  private readonly messageClassNames: PatternMatcher[] = [];
  private messageIds: number[] = [];
  private messageTreeIds: number[] = [];
  private messageEncapsulationIds: number[] = [];
  private messageEncapsulationTreeIds: number[] = [];

  // trace filter
  private tracedEventNumber = -1; // the event number from which causes/consequences are followed, or -1
  private traceCauses = true; // only when tracedEventNumber is given: includes events that cause the traced event, even through a chain of filtered events
  private traceConsequences = true; // only when tracedEventNumber is given
  private traceMessageReuses = true;
  private traceSelfMessages = true;

  // collection limits
  private collectMessageReuses = true; // if false, message reuse dependencies will not be collected
  private maximumCauseDepth = 15;
  private maximumNumberOfCauses = 5;
  private maximumCauseCollectionTime = 100; // ms
  private maximumConsequenceDepth = 15;
  private maximumNumberOfConsequences = 5;
  private maximumConsequenceCollectionTime = 100; // ms

  // internal state -- phase E7: plain `Map`s (not `SortedMap`s -- checked: only
  // `.get`/`.set`/`.delete`/`.clear`/`.values()` are ever called on these three, no
  // floor/ceiling navigation), so `eventNumberToFilteredEventMap`'s insertion order
  // doubles as LRU order, same convention as `EventLog.eventNumberToEventMap` (see
  // eventLog.ts's header and this file's header, "MANDATED DEVIATION").
  private readonly eventNumberToFilteredEventMap = new Map<number, FilteredEvent>();
  private readonly eventNumberToFilterMatchesFlagMap = new Map<number, boolean>(); // memoizes matchesFilter()
  private readonly eventNumberToTraceableEventFlagMap = new Map<number, boolean>(); // memoizes isCauseOfTracedEvent()/isConsequenceOfTracedEvent()
  private unseenTracedEventCauseEventNumbers: number[] = []; // remaining cause event numbers of the traced event still to be visited (kept sorted ascending, like Java's re-sorted LinkedList)
  private unseenTracedEventConsequenceEventNumbers: number[] = [];

  private firstMatchingEvent: FilteredEvent | null = null;
  private lastMatchingEvent: FilteredEvent | null = null;

  private readonly filteredEventCacheLimit: number;
  private readonly filteredFlagCacheLimit: number;
  /** Event numbers a host (E8's worker) has asked to protect from eviction -- mirrors `EventLog.pinnedEventNumbers`. */
  private readonly pinnedEventNumbers = new Set<number>();

  constructor(eventLog: IEventLog, options: FilteredEventLogOptions = {}) {
    super();
    this.eventLog = eventLog;
    this.filteredEventCacheLimit = options.filteredEventCacheLimit ?? 50_000;
    this.filteredFlagCacheLimit = options.filteredFlagCacheLimit ?? 2_000_000;
    this.setModuleExpression('');
    this.setMessageExpression('');
    this.clearInternalState();
  }

  close(): void {
    this.deleteAllocatedObjects();
  }

  // ---- phase E7: bounded FilteredEvent LRU + pinning API (see this file's header) ----

  /** Protects `eventNumber`'s `FilteredEvent` proxy from eviction -- see `EventLog.pinEvent()`'s doc comment (same contract, mirrored here). */
  pinEvent(eventNumber: number): void {
    if (eventNumber < 0) throw new Error('FilteredEventLog.pinEvent: eventNumber must be >= 0');
    this.pinnedEventNumbers.add(eventNumber);
  }

  unpinEvent(eventNumber: number): void {
    this.pinnedEventNumbers.delete(eventNumber);
  }

  isEventPinned(eventNumber: number): boolean {
    return this.pinnedEventNumbers.has(eventNumber);
  }

  /** Number of `FilteredEvent` proxies currently retained -- exposed for tests/instrumentation. */
  getFilteredEventCacheSize(): number {
    return this.eventNumberToFilteredEventMap.size;
  }

  getFilteredEventCacheLimit(): number {
    return this.filteredEventCacheLimit;
  }

  private isFilteredEventEvictable(eventNumber: number): boolean {
    if (this.pinnedEventNumbers.has(eventNumber)) return false;
    if (this.firstMatchingEvent !== null && this.firstMatchingEvent.getEventNumber() === eventNumber) return false;
    if (this.lastMatchingEvent !== null && this.lastMatchingEvent.getEventNumber() === eventNumber) return false;
    return true;
  }

  private touchCachedFilteredEvent(eventNumber: number, filteredEvent: FilteredEvent): void {
    this.eventNumberToFilteredEventMap.delete(eventNumber);
    this.eventNumberToFilteredEventMap.set(eventNumber, filteredEvent);
  }

  /** Evicts least-recently-used, non-pinned `FilteredEvent`s until back at/under `filteredEventCacheLimit` (mirrors `EventLog.enforceEventCacheLimit()`). */
  private enforceFilteredEventCacheLimit(): void {
    while (this.eventNumberToFilteredEventMap.size > this.filteredEventCacheLimit) {
      let victim: number | undefined;
      for (const eventNumber of this.eventNumberToFilteredEventMap.keys()) {
        if (this.isFilteredEventEvictable(eventNumber)) {
          victim = eventNumber;
          break;
        }
      }
      if (victim === undefined) break;
      const evicted = this.eventNumberToFilteredEventMap.get(victim);
      this.eventNumberToFilteredEventMap.delete(victim);
      if (evicted !== undefined) EventBase.unlinkNeighbourEvents(evicted);
    }
  }

  /** Wholesale-clears `eventNumberToFilterMatchesFlagMap` once it exceeds `filteredFlagCacheLimit` (see this file's header). */
  private rememberFilterMatch(eventNumber: number, matches: boolean): void {
    if (this.eventNumberToFilterMatchesFlagMap.size >= this.filteredFlagCacheLimit) this.eventNumberToFilterMatchesFlagMap.clear();
    this.eventNumberToFilterMatchesFlagMap.set(eventNumber, matches);
  }

  /** Wholesale-clears `eventNumberToTraceableEventFlagMap` once it exceeds `filteredFlagCacheLimit` (see this file's header). */
  private rememberTraceableFlag(eventNumber: number, value: boolean): void {
    if (this.eventNumberToTraceableEventFlagMap.size >= this.filteredFlagCacheLimit) this.eventNumberToTraceableEventFlagMap.clear();
    this.eventNumberToTraceableEventFlagMap.set(eventNumber, value);
  }

  // ---- filter parameter getters/setters ----

  getFirstConsideredEventNumber(): number {
    return this.firstConsideredEventNumber;
  }
  setFirstConsideredEventNumber(firstConsideredEventNumber: number): void {
    this.firstConsideredEventNumber = firstConsideredEventNumber;
  }

  getLastConsideredEventNumber(): number {
    return this.lastConsideredEventNumber;
  }
  setLastConsideredEventNumber(lastConsideredEventNumber: number): void {
    this.lastConsideredEventNumber = lastConsideredEventNumber;
  }

  /** Port of `setExcludedEventNumbers()`. NOTE: accumulates into the existing set rather than replacing it (see this file's header). */
  setExcludedEventNumbers(excludedEventNumbers: number[]): void {
    for (const eventNumber of excludedEventNumbers) this.excludedEventNumbers.add(eventNumber);
  }

  getCollectMessageReuses(): boolean {
    return this.collectMessageReuses;
  }
  setCollectMessageReuses(collectMessageReuses: boolean): void {
    this.collectMessageReuses = collectMessageReuses;
  }

  setEnableModuleFilter(enableModuleFilter: boolean): void {
    this.enableModuleFilter = enableModuleFilter;
  }
  setModuleExpression(moduleExpression: string | null): void {
    if (moduleExpression !== null) this.moduleExpression.setPattern(moduleExpression, false, true, false);
  }
  /** Port of `setModuleNames()`. NOTE: accumulates into the existing list rather than replacing it (see this file's header). */
  setModuleNames(moduleNames: string[]): void {
    this.setPatternMatchers(this.moduleNames, moduleNames, true);
  }
  setModuleClassNames(moduleClassNames: string[]): void {
    this.setPatternMatchers(this.moduleClassNames, moduleClassNames);
  }
  setModuleNedTypeNames(moduleNedTypeNames: string[]): void {
    this.setPatternMatchers(this.moduleNedTypeNames, moduleNedTypeNames);
  }
  setModuleIds(moduleIds: number[]): void {
    this.moduleIds = [...moduleIds];
  }

  setEnableMessageFilter(enableMessageFilter: boolean): void {
    this.enableMessageFilter = enableMessageFilter;
  }
  setMessageExpression(messageExpression: string | null): void {
    if (messageExpression !== null) this.messageExpression.setPattern(messageExpression, false, true, false);
  }
  /** Port of `setMessageNames()`. NOTE: accumulates (see this file's header). */
  setMessageNames(messageNames: string[]): void {
    this.setPatternMatchers(this.messageNames, messageNames);
  }
  setMessageClassNames(messageClassNames: string[]): void {
    this.setPatternMatchers(this.messageClassNames, messageClassNames);
  }
  setMessageIds(messageIds: number[]): void {
    this.messageIds = [...messageIds];
  }
  setMessageTreeIds(messageTreeIds: number[]): void {
    this.messageTreeIds = [...messageTreeIds];
  }
  setMessageEncapsulationIds(messageEncapsulationIds: number[]): void {
    this.messageEncapsulationIds = [...messageEncapsulationIds];
  }
  setMessageEncapsulationTreeIds(messageEncapsulationTreeIds: number[]): void {
    this.messageEncapsulationTreeIds = [...messageEncapsulationTreeIds];
  }

  setTracedEventNumber(tracedEventNumber: number): void {
    if (this.tracedEventNumber !== -1) throw new Error('FilteredEventLog.setTracedEventNumber: tracedEventNumber is already set');
    this.tracedEventNumber = tracedEventNumber;
    this.unseenTracedEventCauseEventNumbers.push(tracedEventNumber);
    this.unseenTracedEventConsequenceEventNumbers.push(tracedEventNumber);
  }
  setTraceCauses(traceCauses: boolean): void {
    this.traceCauses = traceCauses;
  }
  setTraceConsequences(traceConsequences: boolean): void {
    this.traceConsequences = traceConsequences;
  }
  setTraceSelfMessages(traceSelfMessages: boolean): void {
    this.traceSelfMessages = traceSelfMessages;
  }
  setTraceMessageReuses(traceMessageReuses: boolean): void {
    this.traceMessageReuses = traceMessageReuses;
  }

  getEventLog(): IEventLog {
    return this.eventLog;
  }

  getMaximumCauseDepth(): number {
    return this.maximumCauseDepth;
  }
  setMaximumCauseDepth(maximumCauseDepth: number): void {
    this.maximumCauseDepth = maximumCauseDepth;
  }
  getMaximumNumberOfCauses(): number {
    return this.maximumNumberOfCauses;
  }
  setMaximumNumberOfCauses(maximumNumberOfCauses: number): void {
    this.maximumNumberOfCauses = maximumNumberOfCauses;
  }
  getMaximumCauseCollectionTime(): number {
    return this.maximumCauseCollectionTime;
  }
  setMaximumCauseCollectionTime(maximumCauseCollectionTime: number): void {
    this.maximumCauseCollectionTime = maximumCauseCollectionTime;
  }
  getMaximumConsequenceDepth(): number {
    return this.maximumConsequenceDepth;
  }
  setMaximumConsequenceDepth(maximumConsequenceDepth: number): void {
    this.maximumConsequenceDepth = maximumConsequenceDepth;
  }
  getMaximumNumberOfConsequences(): number {
    return this.maximumNumberOfConsequences;
  }
  setMaximumNumberOfConsequences(maximumNumberOfConsequences: number): void {
    this.maximumNumberOfConsequences = maximumNumberOfConsequences;
  }
  getMaximumConsequenceCollectionTime(): number {
    return this.maximumConsequenceCollectionTime;
  }
  setMaximumConsequenceCollectionTime(maximumConsequenceCollectionTime: number): void {
    this.maximumConsequenceCollectionTime = maximumConsequenceCollectionTime;
  }

  // ---- filter matching ----

  /** Port of `matchesFilter()` -- memoized per event number. */
  matchesFilter(event: IEvent): boolean {
    const cached = this.eventNumberToFilterMatchesFlagMap.get(event.getEventNumber());
    if (cached !== undefined) return cached;
    const matches = this.matchesEvent(event) && this.matchesDependency(event);
    this.rememberFilterMatch(event.getEventNumber(), matches);
    return matches;
  }

  /** Port of `matchesModuleDescriptionEntry()`. */
  matchesModuleDescriptionEntry(moduleDescriptionEntry: ModuleDescriptionEntry): boolean {
    return (
      this.matchesExpression(this.moduleExpression, moduleDescriptionEntry) ||
      this.matchesPatterns(this.moduleNames, moduleDescriptionEntry.fullName) ||
      this.matchesPatterns(this.moduleClassNames, moduleDescriptionEntry.moduleClassName) ||
      this.matchesPatterns(this.moduleNedTypeNames, moduleDescriptionEntry.nedTypeName) ||
      this.matchesList(this.moduleIds, moduleDescriptionEntry.moduleId)
    );
  }

  /** Port of the 3 overloads of `getMatchingEventInDirection()`, collapsed via a union parameter (idiomatic TS replacement for Java overload resolution). */
  getMatchingEventInDirection(eventOrNumber: IEvent | number, forward: boolean, stopEventNumber = -1): FilteredEvent | null {
    let event: IEvent;
    if (typeof eventOrNumber === 'number') {
      if (eventOrNumber < 0) throw new Error('FilteredEventLog.getMatchingEventInDirection: eventNumber must be >= 0');
      const found = this.eventLog.getEventForEventNumber(eventOrNumber);
      if (found === null) throw new Error('FilteredEventLog.getMatchingEventInDirection: no event for the given event number');
      event = found;
    } else {
      event = eventOrNumber;
    }

    // optimization
    if (forward) {
      if (this.firstMatchingEvent !== null && event.getEventNumber() < this.firstMatchingEvent.getEventNumber()) {
        if (stopEventNumber !== -1 && stopEventNumber < this.firstMatchingEvent.getEventNumber()) return null;
        return this.firstMatchingEvent;
      }
      if (this.firstConsideredEventNumber !== -1 && event.getEventNumber() < this.firstConsideredEventNumber) {
        const shifted = this.eventLog.getEventForEventNumber(this.firstConsideredEventNumber, MatchKind.LAST_OR_NEXT);
        if (shifted === null) throw new Error('FilteredEventLog.getMatchingEventInDirection: no event at/after firstConsideredEventNumber');
        event = shifted;
      }
    } else {
      if (this.lastMatchingEvent !== null && this.lastMatchingEvent.getEventNumber() < event.getEventNumber()) {
        if (stopEventNumber !== -1 && this.lastMatchingEvent.getEventNumber() < stopEventNumber) return null;
        return this.lastMatchingEvent;
      }
      if (this.lastConsideredEventNumber !== -1 && this.lastConsideredEventNumber < event.getEventNumber()) {
        const shifted = this.eventLog.getEventForEventNumber(this.lastConsideredEventNumber, MatchKind.FIRST_OR_PREVIOUS);
        if (shifted === null) throw new Error('FilteredEventLog.getMatchingEventInDirection: no event at/before lastConsideredEventNumber');
        event = shifted;
      }
    }

    // LONG RUNNING OPERATION -- if none of firstConsideredEventNumber/lastConsideredEventNumber/stopEventNumber is set this might take a while
    let current: IEvent | null = event;
    while (current !== null) {
      this.eventLog.progress();
      const eventNumber = current.getEventNumber();
      if (this.matchesFilter(current)) return this.cacheFilteredEvent(eventNumber);
      if (forward) {
        const nextEventNumber = eventNumber + 1;
        current = current.getNextEvent();
        if (this.lastConsideredEventNumber !== -1 && nextEventNumber > this.lastConsideredEventNumber) return null;
        if (stopEventNumber !== -1 && nextEventNumber > stopEventNumber) return null;
      } else {
        const previousEventNumber = eventNumber - 1;
        current = current.getPreviousEvent();
        if (this.firstConsideredEventNumber !== -1 && previousEventNumber < this.firstConsideredEventNumber) return null;
        if (stopEventNumber !== -1 && previousEventNumber < stopEventNumber) return null;
      }
    }
    return null;
  }

  // ---- IEventLog interface ----

  setProgressCallInterval(seconds: number): void {
    this.eventLog.setProgressCallInterval(seconds);
  }

  progress(): void {
    this.eventLog.progress();
  }

  synchronize(change: FileChange): void {
    if (change !== FileChange.UNCHANGED) {
      switch (change) {
        case FileChange.OVERWRITTEN:
          this.eventLog.synchronize(change);
          this.deleteAllocatedObjects();
          this.clearInternalState();
          break;
        case FileChange.APPENDED:
          this.eventLog.synchronize(change);
          for (const filteredEvent of this.eventNumberToFilteredEventMap.values()) filteredEvent.synchronize(change);
          if (this.lastMatchingEvent !== null) {
            const eventNumber = this.lastMatchingEvent.getEventNumber();
            this.eventNumberToFilteredEventMap.delete(eventNumber);
            this.eventNumberToFilterMatchesFlagMap.delete(eventNumber);
            this.eventNumberToTraceableEventFlagMap.delete(eventNumber);
            if (this.firstMatchingEvent === this.lastMatchingEvent) this.firstMatchingEvent = null;
            this.lastMatchingEvent = null;
          }
          break;
        default:
          throw new Error('FilteredEventLog.synchronize: unknown file change');
      }
    }
  }

  getFileReader(): FileReader {
    return this.eventLog.getFileReader();
  }

  getEventLogEntryCache(): EventLogEntryCache {
    return this.eventLog.getEventLogEntryCache();
  }

  getNumParsedEvents(): number {
    return this.eventLog.getNumParsedEvents();
  }

  getMessageNames(): Set<string> {
    return this.eventLog.getMessageNames();
  }
  getMessageClassNames(): Set<string> {
    return this.eventLog.getMessageClassNames();
  }

  getSimulationBeginEntry(): SimulationBeginEntry | null {
    return this.eventLog.getSimulationBeginEntry();
  }
  getSimulationEndEntry(): SimulationEndEntry | null {
    return this.eventLog.getSimulationEndEntry();
  }

  override isEmpty(): boolean {
    if (this.tracedEventNumber !== -1) {
      const event = this.eventLog.getEventForEventNumber(this.tracedEventNumber);
      if (event !== null && this.matchesFilter(event)) return false;
    }
    return super.isEmpty();
  }

  getFirstEvent(): FilteredEvent | null {
    if (this.firstMatchingEvent === null && !this.eventLog.isEmpty()) {
      const eventLogFirstEvent = this.eventLog.getFirstEvent()!;
      const startEventNumber = this.firstConsideredEventNumber === -1 ? eventLogFirstEvent.getEventNumber() : Math.max(eventLogFirstEvent.getEventNumber(), this.firstConsideredEventNumber);
      this.firstMatchingEvent = this.getMatchingEventInDirection(startEventNumber, true);
    }
    return this.firstMatchingEvent;
  }
  getFirstEventNumber(): number {
    const event = this.getFirstEvent();
    return event !== null ? event.getEventNumber() : -1;
  }
  getFirstSimulationTime(): BigDecimal {
    const event = this.getFirstEvent();
    return event !== null ? event.getSimulationTime() : BigDecimal.ZERO;
  }

  getLastEvent(): FilteredEvent | null {
    if (this.lastMatchingEvent === null && !this.eventLog.isEmpty()) {
      const eventLogLastEvent = this.eventLog.getLastEvent()!;
      const startEventNumber = this.lastConsideredEventNumber === -1 ? eventLogLastEvent.getEventNumber() : Math.min(eventLogLastEvent.getEventNumber(), this.lastConsideredEventNumber);
      this.lastMatchingEvent = this.getMatchingEventInDirection(startEventNumber, false);
    }
    return this.lastMatchingEvent;
  }
  getLastEventNumber(): number {
    const event = this.getLastEvent();
    return event !== null ? event.getEventNumber() : -1;
  }
  getLastSimulationTime(): BigDecimal {
    const event = this.getLastEvent();
    return event !== null ? event.getSimulationTime() : BigDecimal.ZERO;
  }

  getEventForEventNumber(eventNumber: number, matchKind: MatchKind = MatchKind.EXACT, useCacheOnly = false): FilteredEvent | null {
    if (eventNumber < 0) throw new Error('FilteredEventLog.getEventForEventNumber: eventNumber must be >= 0');
    const cached = this.eventNumberToFilteredEventMap.get(eventNumber);
    if (cached !== undefined) {
      this.touchCachedFilteredEvent(eventNumber, cached);
      return cached;
    }
    const event = this.eventLog.getEventForEventNumber(eventNumber, matchKind, useCacheOnly);
    if (event !== null) {
      switch (matchKind) {
        case MatchKind.EXACT:
          if (this.matchesFilter(event)) return this.cacheFilteredEvent(event.getEventNumber());
          break;
        case MatchKind.FIRST_OR_PREVIOUS:
          if (event.getEventNumber() === eventNumber && this.matchesFilter(event)) return this.cacheFilteredEvent(event.getEventNumber());
          else if (!useCacheOnly) return this.getMatchingEventInDirection(event, false);
          break;
        case MatchKind.FIRST_OR_NEXT:
          if (!useCacheOnly) return this.getMatchingEventInDirection(event, true);
          break;
        case MatchKind.LAST_OR_PREVIOUS:
          if (!useCacheOnly) return this.getMatchingEventInDirection(event, false);
          break;
        case MatchKind.LAST_OR_NEXT:
          if (event.getEventNumber() === eventNumber && this.matchesFilter(event)) return this.cacheFilteredEvent(event.getEventNumber());
          else if (!useCacheOnly) return this.getMatchingEventInDirection(event, true);
          break;
      }
    }
    return null;
  }

  getEventForSimulationTime(simulationTime: BigDecimal, matchKind: MatchKind = MatchKind.EXACT, useCacheOnly = false): FilteredEvent | null {
    const event = this.eventLog.getEventForSimulationTime(simulationTime, matchKind, useCacheOnly);
    if (event !== null) {
      switch (matchKind) {
        case MatchKind.EXACT:
          if (this.matchesFilter(event)) return this.cacheFilteredEvent(event.getEventNumber());
          break;
        case MatchKind.FIRST_OR_PREVIOUS:
          if (!useCacheOnly) {
            // NOTE: uses .equals(), not Java's `==` -- see this file's header, deviation #2
            if (event.getSimulationTime().equals(simulationTime)) {
              const lastEvent = this.eventLog.getEventForSimulationTime(simulationTime, MatchKind.LAST_OR_NEXT)!;
              const matchingEvent = this.getMatchingEventInDirection(event, true, lastEvent.getEventNumber());
              if (matchingEvent !== null) return matchingEvent;
            }
            return this.getMatchingEventInDirection(event, false);
          }
          break;
        case MatchKind.FIRST_OR_NEXT:
          if (!useCacheOnly) return this.getMatchingEventInDirection(event, true);
          break;
        case MatchKind.LAST_OR_PREVIOUS:
          if (!useCacheOnly) return this.getMatchingEventInDirection(event, false);
          break;
        case MatchKind.LAST_OR_NEXT:
          if (!useCacheOnly) {
            // NOTE: uses .equals(), not Java's `==` -- see this file's header, deviation #2
            if (event.getSimulationTime().equals(simulationTime)) {
              const firstEvent = this.eventLog.getEventForSimulationTime(simulationTime, MatchKind.FIRST_OR_PREVIOUS)!;
              const matchingEvent = this.getMatchingEventInDirection(event, false, firstEvent.getEventNumber());
              if (matchingEvent !== null) return matchingEvent;
            }
            return this.getMatchingEventInDirection(event, true);
          }
          break;
      }
    }
    return null;
  }

  findEventLogEntry(start: EventLogEntry | null, search: string, forward: boolean, caseSensitive: boolean): EventLogEntry | null {
    let eventLogEntry: EventLogEntry | null = start;
    do {
      eventLogEntry = this.eventLog.findEventLogEntry(eventLogEntry, search, forward, caseSensitive);
    } while (eventLogEntry !== null && !this.matchesFilter(eventLogEntry.getEvent()!));
    return eventLogEntry;
  }

  getFirstIndex(): Index | null {
    return this.eventLog.getFirstIndex();
  }
  getLastIndex(): Index | null {
    return this.eventLog.getLastIndex();
  }
  getIndex(eventNumber: number, matchKind: MatchKind = MatchKind.EXACT): Index | null {
    return this.eventLog.getIndex(eventNumber, matchKind);
  }

  getFirstSnapshot(): Snapshot | null {
    return this.eventLog.getFirstSnapshot();
  }
  getLastSnapshot(): Snapshot | null {
    return this.eventLog.getLastSnapshot();
  }
  getSnapshot(eventNumber: number, matchKind: MatchKind = MatchKind.EXACT): Snapshot | null {
    return this.eventLog.getSnapshot(eventNumber, matchKind);
  }

  /** Port of `getApproximateNumberOfEvents()`. */
  getApproximateNumberOfEvents(): number {
    if (this.approximateNumberOfEvents === -1) {
      if (this.tracedEventNumber !== -1) {
        // TODO (matches a Java TODO): this is clearly not a good approximation
        if (this.firstConsideredEventNumber !== -1 && this.lastConsideredEventNumber !== -1) return this.lastConsideredEventNumber - this.firstConsideredEventNumber;
        else return 1000;
      } else {
        let firstEvent = this.getFirstEvent();
        let lastEvent = this.getLastEvent();
        if (firstEvent === null) this.approximateNumberOfEvents = 0;
        else {
          const beginOffset = firstEvent.getBeginOffset();
          const endOffset = lastEvent!.getEndOffset();
          let sumMatching = 0;
          let sumNotMatching = 0;
          let count = 0;
          const eventCount = 100;
          // TODO (matches a Java TODO): perhaps it would be better to read in random events
          for (let i = 0; i < eventCount; i++) {
            if (firstEvent !== null) {
              const previousEvent = firstEvent;
              sumMatching += firstEvent.getEndOffset() - firstEvent.getBeginOffset();
              count++;
              firstEvent = firstEvent.getNextEvent();
              if (firstEvent !== null) sumNotMatching += firstEvent.getBeginOffset() - previousEvent.getEndOffset();
            }
            if (lastEvent !== null) {
              const previousEvent = lastEvent;
              sumMatching += lastEvent.getEndOffset() - lastEvent.getBeginOffset();
              count++;
              lastEvent = lastEvent.getPreviousEvent();
              if (lastEvent !== null) sumNotMatching += previousEvent.getBeginOffset() - lastEvent.getEndOffset();
            }
          }
          const averageMatching = sumMatching / count;
          const averageNotMatching = sumNotMatching / count;
          this.approximateMatchingEventRatio = averageMatching / (averageMatching + averageNotMatching);
          this.approximateNumberOfEvents = Math.trunc(((endOffset - beginOffset) / averageMatching) * this.approximateMatchingEventRatio);
        }
      }
    }
    return this.approximateNumberOfEvents;
  }

  /**
   * Port of `getApproximatePercentageForEventNumber()` -- Java "overrides" this only
   * to call `super.getApproximatePercentageForEventNumber(eventNumber)` in both
   * branches (per its own TODO comments, acknowledging this isn't a real
   * specialization yet), so this port simply inherits `EventLogBase`'s default
   * instead of re-declaring an identical pass-through override.
   */

  getApproximateEventAt(percentage: number): FilteredEvent | null {
    if (this.isEmpty()) return null;
    const firstEventPercentage = this.eventLog.getApproximatePercentageForEventNumber(this.getFirstEvent()!.getEventNumber());
    const lastEventPercentage = this.eventLog.getApproximatePercentageForEventNumber(this.getLastEvent()!.getEventNumber());
    const adjustedPercentage = firstEventPercentage + percentage * (lastEventPercentage - firstEventPercentage);
    const event = this.eventLog.getApproximateEventAt(adjustedPercentage);
    if (event === null) throw new Error('FilteredEventLog.getApproximateEventAt: underlying event log returned no event');
    let filteredEvent = this.getMatchingEventInDirection(event, true);
    if (filteredEvent !== null) return filteredEvent;
    filteredEvent = this.getMatchingEventInDirection(event, false);
    if (filteredEvent !== null) return filteredEvent;
    throw new Error('FilteredEventLog.getApproximateEventAt: assertion failed -- no matching event found in either direction');
  }

  /** Port of the `EventLogBase.print()` default (Java's `FilteredEventLog` does not override `print()`) -- structurally identical to `EventLog.print()` (eventLog.ts), just walking `FilteredEvent`s. */
  print(fromEventNumber?: number, toEventNumber?: number, outputEventLogMessages = true): string {
    const lines: string[] = [];
    const simulationBeginEntry = this.getSimulationBeginEntry();
    if (simulationBeginEntry !== null) lines.push(simulationBeginEntry.print());
    let event: FilteredEvent | null = fromEventNumber === undefined ? this.getFirstEvent() : (this.getFirstEventNotBeforeEventNumber(fromEventNumber) as FilteredEvent | null);
    while (event !== null && (toEventNumber === undefined || event.getEventNumber() <= toEventNumber)) {
      const snapshot = this.getSnapshot(event.getEventNumber());
      if (snapshot !== null) lines.push(snapshot.print());
      const index = this.getIndex(event.getEventNumber());
      if (index !== null) lines.push(index.print());
      lines.push(event.print(outputEventLogMessages));
      event = event.getNextEvent();
    }
    const simulationEndEntry = this.getSimulationEndEntry();
    if (simulationEndEntry !== null) lines.push(simulationEndEntry.print());
    return lines.join('\n');
  }

  /**
   * Caches the given filtered event in the event cache if not present yet. The event
   * must already be known to match this filter. Port of `cacheFilteredEvent()`.
   */
  cacheFilteredEvent(eventNumber: number): FilteredEvent {
    const existing = this.eventNumberToFilteredEventMap.get(eventNumber);
    if (existing !== undefined) {
      this.touchCachedFilteredEvent(eventNumber, existing);
      return existing;
    }
    const filteredEvent = new FilteredEvent(this, eventNumber);
    this.eventNumberToFilteredEventMap.set(eventNumber, filteredEvent);
    this.enforceFilteredEventCacheLimit();
    return filteredEvent;
  }

  /** Port of `matchesEvent()` -- range/exclusion/module/message filters (everything except the trace filter, which is `matchesDependency()`). */
  private matchesEvent(event: IEvent): boolean {
    if ((this.firstConsideredEventNumber !== -1 && event.getEventNumber() < this.firstConsideredEventNumber) || (this.lastConsideredEventNumber !== -1 && event.getEventNumber() > this.lastConsideredEventNumber)) return false;
    if (this.excludedEventNumbers.has(event.getEventNumber())) return false;

    if (this.enableModuleFilter) {
      const eventModuleDescriptionEntry = event.getModuleDescriptionEntry();
      let moduleDescriptionEntry: ModuleDescriptionEntry | null = eventModuleDescriptionEntry;
      // match the parent chain of the event's module too (to handle compound modules)
      outer: while (moduleDescriptionEntry !== null) {
        if (this.matchesModuleDescriptionEntry(moduleDescriptionEntry)) {
          if (moduleDescriptionEntry === eventModuleDescriptionEntry) break;
          else {
            // check whether the event has a cause or consequence referring outside the matching compound module
            for (const cause of event.getCauses()) {
              const causeEvent = cause.getCauseEvent();
              if (causeEvent !== null && !this.isAncestorModuleDescriptionEntry(moduleDescriptionEntry, causeEvent.getModuleDescriptionEntry())) break outer;
            }
            for (const consequence of event.getConsequences()) {
              const consequenceEvent = consequence.getConsequenceEvent();
              if (consequenceEvent !== null && !this.isAncestorModuleDescriptionEntry(moduleDescriptionEntry, consequenceEvent.getModuleDescriptionEntry())) break outer;
            }
          }
        }
        moduleDescriptionEntry = this.getEventLogEntryCache().getModuleDescriptionEntry(moduleDescriptionEntry.parentModuleId);
      }
      if (moduleDescriptionEntry === null) return false;
    }

    if (this.enableMessageFilter) {
      const causeBeginSendEntry = event.getCauseBeginSendEntry();
      let matches = causeBeginSendEntry !== null ? this.matchesBeginSendEntry(causeBeginSendEntry) : false;
      if (!matches) {
        for (let i = 0; i < event.getNumEventLogEntries(); i++) {
          const entry = event.getEventLogEntry(i);
          const beginSendEntry = entry instanceof BeginSendEntry ? entry : null;
          if (beginSendEntry !== null && this.matchesBeginSendEntry(beginSendEntry)) {
            matches = true;
            break;
          }
        }
      }
      if (!matches) return false;
    }
    return true;
  }

  /** Port of `matchesDependency()` -- the trace filter. */
  private matchesDependency(event: IEvent): boolean {
    if (this.tracedEventNumber === -1) return true;
    if (event.getEventNumber() === this.tracedEventNumber) return true;
    if (this.tracedEventNumber > event.getEventNumber() && this.traceCauses) return this.isCauseOfTracedEvent(event);
    if (this.tracedEventNumber < event.getEventNumber() && this.traceConsequences) return this.isConsequenceOfTracedEvent(event);
    return false;
  }

  private matchesBeginSendEntry(beginSendEntry: BeginSendEntry): boolean {
    return (
      this.matchesExpression(this.messageExpression, beginSendEntry) ||
      this.matchesPatterns(this.messageNames, beginSendEntry.messageName) ||
      this.matchesPatterns(this.messageClassNames, beginSendEntry.messageClassName) ||
      this.matchesList(this.messageIds, beginSendEntry.messageId) ||
      this.matchesList(this.messageTreeIds, beginSendEntry.messageTreeId) ||
      this.matchesList(this.messageEncapsulationIds, beginSendEntry.messageEncapsulationId) ||
      this.matchesList(this.messageEncapsulationTreeIds, beginSendEntry.messageEncapsulationTreeId)
    );
  }

  /**
   * Port of `matchesExpression()`. Java wraps `eventLogEntry` in a `JavaMatchableObject`
   * (a JNI adapter over the C++ `MatchExpression::Matchable`); no adapter is needed
   * here -- `EventLogEntry` (eventLogEntry.ts) already implements the exact
   * `getAsString(attribute?: string): string | null` shape `Matchable` requires.
   */
  private matchesExpression(matchExpression: MatchExpression, eventLogEntry: EventLogEntry): boolean {
    return matchExpression.matches(eventLogEntry);
  }

  private matchesPatterns(patterns: PatternMatcher[], str: string): boolean {
    if (patterns.length === 0) return false;
    for (const pattern of patterns) if (pattern.matches(str)) return true;
    return false;
  }

  private matchesList<T>(elements: T[], element: T): boolean {
    if (elements.length === 0) return false;
    return elements.includes(element);
  }

  /**
   * Port of `isCauseOfTracedEvent()` -- LONG RUNNING OPERATION, recursive depth
   * search (breadth-expanded via the sorted `unseenTracedEventCauseEventNumbers`
   * queue). See this file's header (deviation #1) for the one behavioral change from
   * the literal Java source (a `Map.put()`-return-value bug at the very end).
   */
  private isCauseOfTracedEvent(causeEvent: IEvent): boolean {
    this.eventLog.progress();
    const cached = this.eventNumberToTraceableEventFlagMap.get(causeEvent.getEventNumber());
    if (cached !== undefined) return cached;
    const causeEventNumber = causeEvent.getEventNumber();
    while (this.unseenTracedEventCauseEventNumbers.length > 0 && this.unseenTracedEventCauseEventNumbers[0] >= causeEventNumber) {
      const unseenTracedEventCauseEventNumber = this.unseenTracedEventCauseEventNumbers.shift()!;
      const unseenTracedEventCauseEvent = this.eventLog.getEventForEventNumber(unseenTracedEventCauseEventNumber);
      if (unseenTracedEventCauseEvent !== null) {
        for (const messageDependency of unseenTracedEventCauseEvent.getCauses()) {
          const newUnseenTracedEventCauseEvent = messageDependency.getCauseEvent();
          if (newUnseenTracedEventCauseEvent !== null && (this.traceSelfMessages || !newUnseenTracedEventCauseEvent.isSelfMessageProcessingEvent()) && (this.traceMessageReuses || !isMessageReuseDependency(messageDependency))) {
            const newUnseenTracedEventCauseEventNumber = newUnseenTracedEventCauseEvent.getEventNumber();
            this.rememberTraceableFlag(newUnseenTracedEventCauseEventNumber, true);
            this.unseenTracedEventCauseEventNumbers.push(newUnseenTracedEventCauseEventNumber);
            if (newUnseenTracedEventCauseEventNumber === causeEventNumber) return true;
          }
        }
        // TODO (matches a Java TODO): far from optimal -- inserting in the right place would be better
        this.unseenTracedEventCauseEventNumbers.sort(numberCompare);
      }
    }
    // NOTE: see this file's header, deviation #1 -- Java's `return
    // eventNumberToTraceableEventFlagMap.put(causeEventNumber, false)` is a
    // Map.put()-return-value bug (would throw NPE here in Java); cache+return false instead.
    this.rememberTraceableFlag(causeEventNumber, false);
    return false;
  }

  /** Port of `isConsequenceOfTracedEvent()` (mirror-image of `isCauseOfTracedEvent()`). See this file's header, deviation #1. */
  private isConsequenceOfTracedEvent(consequenceEvent: IEvent): boolean {
    this.eventLog.progress();
    const cached = this.eventNumberToTraceableEventFlagMap.get(consequenceEvent.getEventNumber());
    if (cached !== undefined) return cached;
    const consequenceEventNumber = consequenceEvent.getEventNumber();
    while (this.unseenTracedEventConsequenceEventNumbers.length > 0 && this.unseenTracedEventConsequenceEventNumbers[0] <= consequenceEventNumber) {
      const unseenTracedEventConsequenceEventNumber = this.unseenTracedEventConsequenceEventNumbers.shift()!;
      const unseenTracedEventConsequenceEvent = this.eventLog.getEventForEventNumber(unseenTracedEventConsequenceEventNumber);
      if (unseenTracedEventConsequenceEvent !== null) {
        for (const messageDependency of unseenTracedEventConsequenceEvent.getConsequences()) {
          const newUnseenTracedEventConsequenceEvent = messageDependency.getConsequenceEvent();
          if (
            newUnseenTracedEventConsequenceEvent !== null &&
            (this.traceSelfMessages || !newUnseenTracedEventConsequenceEvent.isSelfMessageProcessingEvent()) &&
            (this.traceMessageReuses || !isMessageReuseDependency(messageDependency))
          ) {
            const newUnseenTracedEventConsequenceEventNumber = newUnseenTracedEventConsequenceEvent.getEventNumber();
            this.rememberTraceableFlag(newUnseenTracedEventConsequenceEventNumber, true);
            this.unseenTracedEventConsequenceEventNumbers.push(newUnseenTracedEventConsequenceEventNumber);
            if (newUnseenTracedEventConsequenceEventNumber === consequenceEventNumber) return true;
          }
        }
        this.unseenTracedEventConsequenceEventNumbers.sort(numberCompare);
      }
    }
    this.rememberTraceableFlag(consequenceEventNumber, false);
    return false;
  }

  /** Port of `setPatternMatchers()` (both overloads: `dottedPath` defaults to `false`). NOTE: accumulates into `target` rather than replacing it (see this file's header). */
  private setPatternMatchers(target: PatternMatcher[], patterns: string[], dottedPath = false): void {
    for (const pattern of patterns) {
      const matcher = new PatternMatcher();
      matcher.setPattern(pattern, dottedPath, true, false);
      target.push(matcher);
    }
  }

  protected override clearInternalState(): void {
    super.clearInternalState();
    this.firstMatchingEvent = null;
    this.lastMatchingEvent = null;
    this.approximateNumberOfEvents = -1;
    this.approximateMatchingEventRatio = -1;
    this.eventNumberToFilteredEventMap.clear();
    this.eventNumberToFilterMatchesFlagMap.clear();
    this.eventNumberToTraceableEventFlagMap.clear();
    this.unseenTracedEventCauseEventNumbers = [];
    this.unseenTracedEventConsequenceEventNumbers = [];
    // OVERWRITTEN is a full reset -- previously pinned event numbers no longer mean anything meaningful.
    this.pinnedEventNumbers.clear();
  }

  private deleteAllocatedObjects(): void {
    this.eventNumberToFilteredEventMap.clear();
    this.eventNumberToFilterMatchesFlagMap.clear();
    this.eventNumberToTraceableEventFlagMap.clear();
  }

  private isAncestorModuleDescriptionEntry(ancestor: ModuleDescriptionEntry, descendant: ModuleDescriptionEntry | null): boolean {
    let current = descendant;
    while (current !== null) {
      if (current === ancestor) return true;
      current = this.getEventLogEntryCache().getModuleDescriptionEntry(current.parentModuleId);
    }
    return false;
  }
}
