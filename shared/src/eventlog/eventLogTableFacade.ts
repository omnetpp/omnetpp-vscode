/**
 * EventLogTableFacade — virtual-table row enumeration for the Event Log table (the
 * per-entry, not per-event, view). Ported from:
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/EventLogTableFacade.java
 *
 * The table shows one row per `EventLogEntry` that passes the current filter mode
 * (`EventLogTableFilterMode`): every entry (ALL_ENTRIES), just the event/send/message
 * lines, just event/message lines, just the "E" lines, or a custom `MatchExpression`
 * (CUSTOM_ENTRIES). This facade turns "which entries pass the filter" into cheap
 * per-event counts (`getNumMatchingEventLogEntries`, memoized for the single most
 * recently asked event -- exactly like Java) plus entry-to-entry navigation
 * (`getNeighbourEntry`, walking `distance` matching entries forward/backward) and
 * approximate percentage-based positioning for the table's scrollbar
 * (`getApproximateEventLogEntryAt`/`getApproximatePercentageForEntry`, riding on
 * `IEventLog`'s own approximate event-percentage machinery from phase E4).
 *
 * MatchExpression wiring: Java wraps each `EventLogEntry` in a `JavaMatchableObject`
 * JNI adapter before calling `MatchExpression.matches()`. No adapter is needed here --
 * `EventLogEntry` (eventLogEntry.ts) already implements the `Matchable` interface's
 * `getAsString(attribute?)` shape structurally (same reasoning as
 * `filteredEventLog.ts`'s `matchesExpression()`), so `filterMatchExpression.matches(eventLogEntry)`
 * is called directly.
 *
 * RefObject-collapsing (port plan risk #3's collapsing convention, used consistently
 * across this port -- see ieventlog.ts's `ReadToEventLineResult` and
 * sequenceChartFacade.ts's header): `getEntryAndDistance()`'s `RefObject<Long>
 * reachedDistance` out-parameter becomes part of its returned object; `getPreviousEntry()`/
 * `getNextEntry()`'s `RefObject<Integer> index` out-parameter becomes a small mutable
 * `{ value: number }` box passed in and mutated in place (kept, rather than collapsed
 * into a return value, because `getEntryAndDistance()`'s loop needs to thread the same
 * mutable index through many successive calls exactly like Java's `RefObject` does).
 *
 * Object-identity note (port plan risk #3), FIXED in phase E7: `getEntryAndDistance()`'s
 * target-reached check compares two `EventLogEntry` references (Java: `!=`, matching
 * Java literally in earlier phases). Unlike `IEvent` (which already exposes a stable
 * `getEventNumber()` key, used everywhere else in this port instead of object
 * identity), `EventLogEntry` has no such key of its own -- so once phase E7's bounded
 * Event LRU can evict and later re-parse an `Event`, a fresh `EventLogEntry` object can
 * come back for the same logical (event number, entry index), and a plain `!==`
 * comparison against a `targetEventLogEntry` captured before that eviction would never
 * match, walking past the real target. Fixed by comparing the compound
 * `(eventNumber, entryIndex)` key instead (`entryKey()`, below) -- same fix applied to
 * `getEntryIndexInEvent()`'s analogous `===` check.
 */

import { BeginSendEntry, EventEntry } from './entries';
import type { EventLogEntry } from './eventLogEntry';
import { EventLogMessageEntry } from './eventLogEntry';
import { EventLogTableFilterMode, FileChange } from './enums';
import { EventLogFacade } from './facade';
import type { IEvent, IEventLog } from './ieventlog';
import { MatchExpression } from '../match/matchExpression';

/**
 * Logical identity for an `EventLogEntry` that survives Event eviction/reparse (phase
 * E7) -- see this file's header. Assumes `entry.getEvent()` is non-null, true for
 * every `EventLogEntry` this facade ever hands out (they all originate from
 * `event.getEventLogEntry(index)`, never from an Index/Snapshot chunk).
 */
function entryKey(entry: EventLogEntry): string {
  return `${entry.getEvent()!.getEventNumber()}:${entry.getEntryIndex()}`;
}

export class EventLogTableFacade extends EventLogFacade {
  protected approximateNumberOfEntries = -1; // cached value, -1 means not yet calculated
  protected lastMatchedEventNumber = -1; // -1 means unused
  protected lastNumMatchingEventLogEntries = -1; // cache for the event number above
  protected filterMode: EventLogTableFilterMode = EventLogTableFilterMode.ALL_ENTRIES; // can be set with the public API
  protected customFilter = '*'; // can be set with the public API
  protected readonly filterMatchExpression = new MatchExpression(); // cached expression

  constructor(eventLog: IEventLog) {
    super(eventLog);
    this.clearInternalState();
    this.setCustomFilter('*');
    this.setFilterMode(EventLogTableFilterMode.ALL_ENTRIES);
  }

  override synchronize(change: FileChange): void {
    if (change !== FileChange.UNCHANGED) {
      switch (change) {
        case FileChange.OVERWRITTEN:
        case FileChange.APPENDED:
          super.synchronize(change);
          this.clearInternalState();
          break;
        default:
          throw new Error('EventLogTableFacade.synchronize: unknown file change');
      }
    }
  }

  getFilterMode(): EventLogTableFilterMode {
    return this.filterMode;
  }

  setFilterMode(filterMode: EventLogTableFilterMode): void {
    this.filterMode = filterMode;
    this.clearInternalState();
  }

  matchesFilter(eventLogEntry: EventLogEntry): boolean {
    switch (this.filterMode) {
      case EventLogTableFilterMode.ALL_ENTRIES:
        return true;
      case EventLogTableFilterMode.EVENT_AND_SEND_AND_MESSAGE_ENTRIES:
        return eventLogEntry instanceof EventEntry || eventLogEntry instanceof BeginSendEntry || eventLogEntry instanceof EventLogMessageEntry;
      case EventLogTableFilterMode.EVENT_AND_MESSAGE_ENTRIES:
        return eventLogEntry instanceof EventEntry || eventLogEntry instanceof EventLogMessageEntry;
      case EventLogTableFilterMode.EVENT_ENTRIES:
        return eventLogEntry instanceof EventEntry;
      case EventLogTableFilterMode.CUSTOM_ENTRIES:
        return this.filterMatchExpression.matches(eventLogEntry);
      default:
        throw new Error('EventLogTableFacade.matchesFilter: unknown eventlog table filter');
    }
  }

  getNumMatchingEventLogEntries(event: IEvent): number {
    if (this.lastMatchedEventNumber === event.getEventNumber()) return this.lastNumMatchingEventLogEntries;
    this.lastMatchedEventNumber = event.getEventNumber();
    switch (this.filterMode) {
      case EventLogTableFilterMode.ALL_ENTRIES:
        this.lastNumMatchingEventLogEntries = event.getNumEventLogEntries();
        break;
      case EventLogTableFilterMode.EVENT_AND_SEND_AND_MESSAGE_ENTRIES:
        this.lastNumMatchingEventLogEntries = event.getNumBeginSendEntries() + event.getNumEventLogMessages() + 1;
        break;
      case EventLogTableFilterMode.EVENT_AND_MESSAGE_ENTRIES:
        this.lastNumMatchingEventLogEntries = event.getNumEventLogMessages() + 1;
        break;
      case EventLogTableFilterMode.EVENT_ENTRIES:
        this.lastNumMatchingEventLogEntries = 1;
        break;
      case EventLogTableFilterMode.CUSTOM_ENTRIES: {
        let count = 0;
        const num = event.getNumEventLogEntries();
        for (let i = 0; i < num; i++) if (this.matchesFilter(event.getEventLogEntry(i))) count++;
        this.lastNumMatchingEventLogEntries = count;
        break;
      }
      default:
        throw new Error('EventLogTableFacade.getNumMatchingEventLogEntries: unknown eventlog table filter');
    }
    return this.lastNumMatchingEventLogEntries;
  }

  setCustomFilter(pattern: string): void {
    this.customFilter = pattern;
    this.filterMatchExpression.setPattern(`E or (${this.customFilter})`, false, true, false);
    this.clearInternalState();
  }

  getCustomFilter(): string {
    return this.customFilter;
  }

  getEventLogEntry(eventNumber: number, eventLogEntryIndex: number): EventLogEntry {
    const event = this.eventLog.getEventForEventNumber(eventNumber);
    if (event === null) throw new Error('EventLogTableFacade.getEventLogEntry: no event for the given event number');
    return event.getEventLogEntry(eventLogEntryIndex);
  }

  getFirstEntry(): EventLogEntry | null {
    const event = this.eventLog.getFirstEvent();
    if (event === null) return null;
    return this.getEntryInEvent(event, 0);
  }

  getLastEntry(): EventLogEntry | null {
    const event = this.eventLog.getLastEvent();
    if (event === null) return null;
    return this.getEntryInEvent(event, this.getNumMatchingEventLogEntries(event) - 1);
  }

  getEntryIndexInEvent(eventLogEntry: EventLogEntry): number {
    const event = eventLogEntry.getEvent();
    if (event === null) throw new Error('EventLogTableFacade.getEntryIndexInEvent: eventLogEntry does not belong to an event');
    let index = 0;
    const num = event.getNumEventLogEntries();
    const targetEntryIndex = eventLogEntry.getEntryIndex();
    for (let i = 0; i < num; i++) {
      const currentEventLogEntry = event.getEventLogEntry(i);
      if (this.matchesFilter(currentEventLogEntry)) {
        // compound-key comparison, not object identity (phase E7 -- see this file's header)
        if (i === targetEntryIndex) return index;
        else index++;
      }
    }
    throw new Error(`EventLogTableFacade.getEntryIndexInEvent: no eventlog entry found in event: ${event.getEventNumber()}`);
  }

  getEntryInEvent(event: IEvent, index: number): EventLogEntry {
    if (!(index >= 0 && index < this.getNumMatchingEventLogEntries(event))) throw new Error('EventLogTableFacade.getEntryInEvent: index out of range');
    if (this.filterMode === EventLogTableFilterMode.ALL_ENTRIES) return event.getEventLogEntry(index);
    else {
      const num = event.getNumEventLogEntries();
      let remaining = index;
      for (let i = 0; i < num; i++) {
        const eventLogEntry = event.getEventLogEntry(i);
        if (this.matchesFilter(eventLogEntry)) {
          if (remaining === 0) return eventLogEntry;
          else remaining--;
        }
      }
    }
    throw new Error(`EventLogTableFacade.getEntryInEvent: no eventlog entry with index: ${index} in event: ${event.getEventNumber()}`);
  }

  getDistanceToEntry(sourceEventLogEntry: EventLogEntry, targetEventLogEntry: EventLogEntry, limit: number): number {
    return this.getEntryAndDistance(sourceEventLogEntry, targetEventLogEntry, limit).reachedDistance;
  }

  getClosestEntryInEvent(eventLogEntry: EventLogEntry): EventLogEntry {
    if (eventLogEntry === null) throw new Error('EventLogTableFacade.getClosestEntryInEvent: eventLogEntry must not be null');
    const event = eventLogEntry.getEvent();
    if (event === null) throw new Error('EventLogTableFacade.getClosestEntryInEvent: eventLogEntry does not belong to an event');
    for (let i = eventLogEntry.getEntryIndex(); i >= 0; i--) {
      const candidate = event.getEventLogEntry(i);
      if (this.matchesFilter(candidate)) return candidate;
    }
    throw new Error('EventLogTableFacade.getClosestEntryInEvent: EventEntry should always match the filter');
  }

  getDistanceToFirstEntry(eventLogEntry: EventLogEntry, limit: number): number {
    return -this.getEntryAndDistance(eventLogEntry, this.getFirstEntry(), -limit).reachedDistance;
  }

  getDistanceToLastEntry(eventLogEntry: EventLogEntry, limit: number): number {
    return this.getEntryAndDistance(eventLogEntry, this.getLastEntry(), limit).reachedDistance;
  }

  getNeighbourEntry(eventLogEntry: EventLogEntry, distance: number): EventLogEntry | null {
    return this.getEntryAndDistance(eventLogEntry, null, distance).entry;
  }

  getApproximatePercentageForEntry(eventLogEntry: EventLogEntry): number {
    const beforeEvent = eventLogEntry.getEvent();
    if (beforeEvent === null) throw new Error('EventLogTableFacade.getApproximatePercentageForEntry: eventLogEntry does not belong to an event');
    const afterEvent = beforeEvent.getNextEvent();
    const beforePercentage = this.eventLog.getApproximatePercentageForEventNumber(beforeEvent.getEventNumber());
    const afterPercentage = afterEvent !== null ? this.eventLog.getApproximatePercentageForEventNumber(afterEvent.getEventNumber()) : 1.0;
    const index = this.getEntryIndexInEvent(eventLogEntry);
    return beforePercentage + ((afterPercentage - beforePercentage) * index) / this.getNumMatchingEventLogEntries(beforeEvent);
  }

  getApproximateEventLogEntryAt(percentage: number): EventLogEntry | null {
    if (!(0.0 <= percentage && percentage <= 1.0)) throw new Error('EventLogTableFacade.getApproximateEventLogEntryAt: percentage must be in [0,1]');
    if (percentage === 1) {
      const event = this.eventLog.getLastEvent();
      if (event === null) return null;
      return this.getEntryInEvent(event, this.getNumMatchingEventLogEntries(event) - 1);
    } else {
      const beforeEvent = this.eventLog.getApproximateEventAt(percentage);
      if (beforeEvent === null) return null;
      const beforePercentage = this.eventLog.getApproximatePercentageForEventNumber(beforeEvent.getEventNumber());
      let afterPercentage = 1;
      const afterEvent = beforeEvent.getNextEvent();
      if (afterEvent !== null) afterPercentage = this.eventLog.getApproximatePercentageForEventNumber(afterEvent.getEventNumber());
      if (percentage < beforePercentage || percentage > afterPercentage) return beforeEvent.getEventEntry();
      else {
        const entryPercentage = (percentage - beforePercentage) / (afterPercentage - beforePercentage);
        if (!(0.0 <= entryPercentage && entryPercentage <= 1.0)) throw new Error('EventLogTableFacade.getApproximateEventLogEntryAt: assertion failed (entryPercentage out of range)');
        const index = Math.floor((this.getNumMatchingEventLogEntries(beforeEvent) - 1) * entryPercentage);
        return this.getEntryInEvent(beforeEvent, index);
      }
    }
  }

  getApproximateNumberOfEntries(): number {
    if (this.approximateNumberOfEntries === -1) {
      let firstEvent = this.eventLog.getFirstEvent();
      let lastEvent = this.eventLog.getLastEvent();
      if (firstEvent === null) this.approximateNumberOfEntries = 0;
      else {
        let sum = 0;
        let count = 0;
        const eventCount = 100;
        for (let i = 0; i < eventCount; i++) {
          if (firstEvent !== null) {
            sum += this.getNumMatchingEventLogEntries(firstEvent);
            count++;
            firstEvent = firstEvent.getNextEvent();
          }
          if (lastEvent !== null) {
            sum += this.getNumMatchingEventLogEntries(lastEvent);
            count++;
            lastEvent = lastEvent.getPreviousEvent();
          }
        }
        const average = sum / count;
        this.approximateNumberOfEntries = Math.trunc(this.eventLog.getApproximateNumberOfEvents() * average);
      }
    }
    return this.approximateNumberOfEntries;
  }

  /** Port of `getPreviousEntry()`. `indexRef` is a mutable box standing in for Java's `RefObject<Integer>` (see this file's header). */
  protected getPreviousEntry(eventLogEntry: EventLogEntry, indexRef: { value: number }): EventLogEntry | null {
    const owningEvent = eventLogEntry.getEvent();
    if (owningEvent === null) throw new Error('EventLogTableFacade.getPreviousEntry: eventLogEntry does not belong to an event');
    let event: IEvent | null = this.eventLog.getEventForEventNumber(owningEvent.getEventNumber());
    indexRef.value--;
    if (indexRef.value === -1) {
      event = event !== null ? event.getPreviousEvent() : null;
      if (event !== null) indexRef.value = this.getNumMatchingEventLogEntries(event) - 1;
    }
    if (event === null) return null;
    return this.getEntryInEvent(event, indexRef.value);
  }

  /** Port of `getNextEntry()` (see `getPreviousEntry()`'s note). */
  protected getNextEntry(eventLogEntry: EventLogEntry, indexRef: { value: number }): EventLogEntry | null {
    const owningEvent = eventLogEntry.getEvent();
    if (owningEvent === null) throw new Error('EventLogTableFacade.getNextEntry: eventLogEntry does not belong to an event');
    let event: IEvent | null = this.eventLog.getEventForEventNumber(owningEvent.getEventNumber());
    indexRef.value++;
    if (event !== null && indexRef.value === this.getNumMatchingEventLogEntries(event)) {
      event = event.getNextEvent();
      indexRef.value = 0;
    }
    if (event === null) return null;
    return this.getEntryInEvent(event, indexRef.value);
  }

  /**
   * Port of `getEntryAndDistance()`. Returns both the reached entry and the actually
   * covered distance (Java's `RefObject<Long> reachedDistance` out-parameter), folded
   * into one object per this file's header.
   */
  getEntryAndDistance(sourceEventLogEntry: EventLogEntry, targetEventLogEntry: EventLogEntry | null, distance: number): { entry: EventLogEntry | null; reachedDistance: number } {
    if (sourceEventLogEntry === null) throw new Error('EventLogTableFacade.getEntryAndDistance: sourceEventLogEntry must not be null');
    let eventLogEntry: EventLogEntry | null = sourceEventLogEntry;
    let reachedDistance = 0;
    const indexRef = { value: this.getEntryIndexInEvent(eventLogEntry) };
    if (!(indexRef.value >= 0)) throw new Error('EventLogTableFacade.getEntryAndDistance: assertion failed (index < 0)');
    // Compound-key comparison against targetEventLogEntry, not object identity (phase E7 -- see this file's header).
    const targetKey = targetEventLogEntry === null ? null : entryKey(targetEventLogEntry);
    while (distance !== 0 && eventLogEntry !== null && (targetKey === null || entryKey(eventLogEntry) !== targetKey)) {
      if (distance > 0) {
        eventLogEntry = this.getNextEntry(eventLogEntry, indexRef);
        distance--;
        reachedDistance++;
      } else {
        eventLogEntry = this.getPreviousEntry(eventLogEntry, indexRef);
        distance++;
        reachedDistance--;
      }
    }
    if (eventLogEntry === null) reachedDistance += distance;
    return { entry: eventLogEntry, reachedDistance };
  }

  protected clearInternalState(): void {
    this.approximateNumberOfEntries = -1;
    this.lastMatchedEventNumber = -1;
    this.lastNumMatchingEventLogEntries = -1;
  }
}
