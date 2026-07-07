/**
 * A single event as seen through a `FilteredEventLog` -- a lazy proxy over the real
 * `IEvent`, remapping `getCause()`/`getCauses()`/`getConsequences()` through the
 * filter (building `FilteredMessageDependency` chains across any intermediate events
 * the filter excludes). Ported from:
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/FilteredEvent.java
 *
 * DEVIATION (NOT reproduced, latent upstream bug -- same policy as
 * eventLogEntryCache.ts's documented boxed-type-mismatch note): `getCauseEvent()`'s
 * `causeEventNumber` field is initialized to -1 and is **never assigned anywhere else
 * in the class** (grepped the whole file: the only two occurrences are the field
 * initializer and `clearInternalState()`'s reset, both to -1). This means:
 *   (a) the field's own "already resolved" fast path (`if (causeEventNumber == -1)`)
 *       is unconditionally true forever -- dead code, not a real cache;
 *   (b) if the cause-chain walk in the method body runs off the end without a match
 *       (walks all the way to an event whose own `getCauseEvent()` is `null`, e.g. it
 *       reaches an `initialize()`-caused event with no cause of its own), the method
 *       falls through to `return (FilteredEvent)filteredEventLog.getEventForEventNumber
 *       (causeEventNumber)` -- i.e. `getEventForEventNumber(-1)`, which
 *       `FilteredEventLog.getEventForEventNumber()` (correctly) rejects with
 *       `Assert.isTrue(eventNumber >= 0)`, so in Java this throws.
 * The clearly-intended behavior (matching the analogous, correctly-written
 * `getCause()` method right below it, whose `cause` field genuinely IS used as a
 * memo) is "no matching cause found -> return null", which is what this port does.
 */

import type { BigDecimal } from './bigDecimal';
import { BeginSendEntry, type EndSendEntry, type EventEntry, type MessageDescriptionEntry, type ModuleDescriptionEntry } from './entries';
import { EventBase } from './event';
import { FileChange } from './enums';
import type { EventLogEntry, EventLogMessageEntry } from './eventLogEntry';
import type { IEvent, IEventLog, IMessageDependency } from './ieventlog';
import { FilteredMessageDependency, FilteredMessageDependencyKind, MessageDependencyBase, MessageReuseDependency, MessageSendDependency } from './messageDependency';
import type { FilteredEventLog } from './filteredEventLog';

/** Port of `FilteredEvent.BreadthSearchItem` (used by `getCauses()`/`getConsequences()`'s breadth-first search). */
interface BreadthSearchItem {
  event: IEvent;
  firstSeenMessageDependency: IMessageDependency | null;
  effectiveKind: FilteredMessageDependencyKind;
  level: number;
}

/** Port of `FilteredEvent`. */
export class FilteredEvent extends EventBase implements IEvent {
  private readonly filteredEventLog: FilteredEventLog;
  private readonly eventNumber: number;

  private event: IEvent | null = null;
  private cause: IMessageDependency | null = null;
  private causes: IMessageDependency[] | null = null;
  private consequences: IMessageDependency[] | null = null;

  constructor(filteredEventLog: FilteredEventLog, eventNumber: number) {
    super();
    this.filteredEventLog = filteredEventLog;
    this.eventNumber = eventNumber;
  }

  /** Port of `getEvent()` -- lazily resolves (and caches) the real, unfiltered event this proxy wraps. */
  getEvent(): IEvent {
    if (this.event === null) this.event = this.filteredEventLog.getEventLog().getEventForEventNumber(this.eventNumber);
    return this.event!;
  }

  // ---- IEvent (delegating to the real event; unfiltered fields) ----

  /**
   * Port of `synchronize()`. NOTE: unlike `Event.synchronize()`, the Java original
   * does NOT call `super.synchronize()` here -- `EventBase`'s own
   * `previousEvent`/`nextEvent`/cached-timeline-coordinate fields are left untouched
   * by this override. In practice `FilteredEventLog.synchronize()`'s OVERWRITTEN
   * branch never reaches this method at all (it clears the whole
   * `eventNumberToFilteredEventMap` instead of calling `synchronize()` on each
   * entry), so this branch is effectively unreachable through the observed call
   * chain; ported verbatim regardless, in case something calls it directly.
   */
  synchronize(change: FileChange): void {
    if (change !== FileChange.UNCHANGED) {
      switch (change) {
        case FileChange.OVERWRITTEN:
          this.deleteAllocatedObjects();
          this.clearFilteredEventInternalState();
          break;
        case FileChange.APPENDED:
          this.deleteConsequences();
          break;
        default:
          throw new Error('FilteredEvent.synchronize: unknown file change');
      }
    }
  }

  getAsString(attribute?: string): string | null {
    return attribute === undefined ? this.getEvent().getAsString() : this.getEvent().getAsString(attribute);
  }

  getEventLog(): IEventLog {
    return this.filteredEventLog;
  }

  getBeginOffset(): number {
    return this.getEvent().getBeginOffset();
  }
  getEndOffset(): number {
    return this.getEvent().getEndOffset();
  }
  getEventEntry(): EventEntry {
    return this.getEvent().getEventEntry();
  }
  getModuleDescriptionEntry(): ModuleDescriptionEntry {
    return this.getEvent().getModuleDescriptionEntry();
  }

  getNumEventLogEntries(): number {
    return this.getEvent().getNumEventLogEntries();
  }
  getEventLogEntry(index: number): EventLogEntry {
    return this.getEvent().getEventLogEntry(index);
  }
  getNumEventLogMessages(): number {
    return this.getEvent().getNumEventLogMessages();
  }
  getNumBeginSendEntries(): number {
    return this.getEvent().getNumBeginSendEntries();
  }
  getNumCustomEntries(): number {
    return this.getEvent().getNumCustomEntries();
  }
  getEventLogMessage(index: number): EventLogMessageEntry {
    return this.getEvent().getEventLogMessage(index) as EventLogMessageEntry;
  }

  getEventNumber(): number {
    return this.eventNumber;
  }
  getSimulationTime(): BigDecimal {
    return this.getEvent().getSimulationTime();
  }
  getModuleId(): number {
    return this.getEvent().getModuleId();
  }
  getMessageId(): number {
    return this.getEvent().getMessageId();
  }
  getCauseEventNumber(): number {
    return this.getEvent().getCauseEventNumber();
  }

  isSelfMessage(beginSendEntry: BeginSendEntry): boolean {
    return this.getEvent().isSelfMessage(beginSendEntry);
  }
  isSelfMessageProcessingEvent(): boolean {
    return this.getEvent().isSelfMessageProcessingEvent();
  }
  getEndSendEntry(beginSendEntry: BeginSendEntry): EndSendEntry | null {
    return this.getEvent().getEndSendEntry(beginSendEntry);
  }

  /**
   * Port of `getPreviousEvent()`. `filteredEventLog.getFirstEvent() !== this` is an
   * object-identity check (port plan risk #3) -- safe as long as `FilteredEvent`
   * instances are memoized per event number by `FilteredEventLog.cacheFilteredEvent()`
   * (true through phase E7; a future bounded-eviction cache for filtered events would
   * need this converted to an event-number comparison, same as `event.ts`'s analogous
   * checks).
   */
  getPreviousEvent(): FilteredEvent | null {
    if (this.previousEvent === null && this.filteredEventLog.getFirstEvent() !== this) {
      const previous = this.filteredEventLog.getMatchingEventInDirection(this.getEvent().getPreviousEvent()!, false);
      this.previousEvent = previous;
      if (previous !== null) EventBase.linkEvents(previous, this);
    }
    return this.previousEvent as FilteredEvent | null;
  }

  /** Port of `getNextEvent()` (see `getPreviousEvent()`'s note on the identity check). */
  getNextEvent(): FilteredEvent | null {
    if (this.nextEvent === null && this.filteredEventLog.getLastEvent() !== this) {
      const next = this.filteredEventLog.getMatchingEventInDirection(this.getEvent().getNextEvent()!, true);
      this.nextEvent = next;
      if (next !== null) EventBase.linkEvents(this, next);
    }
    return this.nextEvent as FilteredEvent | null;
  }

  /**
   * Port of `getCauseEvent()`. See this file's header for the one behavioral
   * deviation (a latent Java bug around the dead `causeEventNumber` field, not
   * reproduced).
   */
  getCauseEvent(): FilteredEvent | null {
    let causeEvent: IEvent | null = this.getEvent().getCauseEvent();
    // LONG RUNNING OPERATION -- walks backwards on the cause chain until an event
    // matched by the filter is found; may read all events backward if none matches.
    while (causeEvent !== null) {
      this.filteredEventLog.progress();
      if (causeEvent.getEventNumber() < this.filteredEventLog.getFirstConsideredEventNumber()) return null;
      if (this.filteredEventLog.matchesFilter(causeEvent)) return this.filteredEventLog.getEventForEventNumber(causeEvent.getEventNumber()) as FilteredEvent | null;
      causeEvent = causeEvent.getCauseEvent();
    }
    return null; // see this file's header: no cause found within the considered range
  }

  /** Port of `getCause()`. */
  getCause(): IMessageDependency | null {
    if (this.cause === null) {
      let causeEvent: IEvent | null = this.getEvent();
      const causeMessageDependency = causeEvent.getCause();
      if (causeMessageDependency !== null) {
        // LONG RUNNING OPERATION -- might read all events backward if none of the causes matches the filter
        while (causeEvent !== null && causeEvent.getCause() !== null) {
          const messageDependency = causeEvent.getCause()!;
          this.filteredEventLog.progress();
          if (causeEvent.getEventNumber() < this.filteredEventLog.getFirstConsideredEventNumber()) return null;
          if (this.filteredEventLog.matchesFilter(messageDependency.getCauseEvent()!)) {
            this.cause =
              messageDependency === causeMessageDependency
                ? messageDependency.duplicate(this.filteredEventLog)
                : new FilteredMessageDependency(
                    this.filteredEventLog,
                    FilteredMessageDependencyKind.SENDS,
                    messageDependency.duplicate(this.filteredEventLog.getEventLog()),
                    causeMessageDependency.duplicate(this.filteredEventLog.getEventLog()),
                  );
            break;
          }
          causeEvent = causeEvent.getCauseEvent();
        }
      }
    }
    return this.cause;
  }

  getCauseBeginSendEntry(): BeginSendEntry | null {
    const cause = this.getCause();
    if (cause === null) return null;
    const messageDescriptionEntry = cause.getBeginMessageDescriptionEntry();
    return messageDescriptionEntry instanceof BeginSendEntry ? messageDescriptionEntry : null;
  }

  /** Port of the static `FilteredEvent.getMessageDependencyKind()`. */
  static getMessageDependencyKind(messageDependency: IMessageDependency): FilteredMessageDependencyKind {
    if (messageDependency instanceof MessageSendDependency) return FilteredMessageDependencyKind.SENDS;
    if (messageDependency instanceof MessageReuseDependency) return FilteredMessageDependencyKind.REUSES;
    return FilteredMessageDependencyKind.MIXED;
  }

  /**
   * Port of `getCauses()`. Breadth-first search outward from the real event, stopping
   * at events the filter matches (collecting a `FilteredMessageDependency` spanning
   * the gap when intermediate events were filtered out) or at `maximumCauseDepth`/
   * `maximumNumberOfCauses`/`maximumCauseCollectionTime`.
   */
  getCauses(): IMessageDependency[] {
    if (this.causes === null) {
      const begin = Date.now();
      const causes: IMessageDependency[] = [];
      const todoList: BreadthSearchItem[] = [{ event: this.getEvent(), firstSeenMessageDependency: null, effectiveKind: FilteredMessageDependencyKind.UNDEFINED, level: 0 }];
      // LONG RUNNING OPERATION -- recursive (via the queue) and might take some time
      while (todoList.length > 0) {
        this.filteredEventLog.progress();
        if (Date.now() - begin >= this.filteredEventLog.getMaximumCauseCollectionTime()) break;

        const searchItem = todoList.shift()!;
        const currentEvent = searchItem.event;
        const endMessageDependency = searchItem.firstSeenMessageDependency;
        const currentKind = searchItem.effectiveKind;
        const level = searchItem.level;

        for (const messageDependency of currentEvent.getCauses()) {
          const causeEvent = messageDependency.getCauseEvent();
          if (causeEvent !== null && (this.filteredEventLog.getCollectMessageReuses() || !(messageDependency instanceof MessageReuseDependency))) {
            const effectiveKind = (currentKind | FilteredEvent.getMessageDependencyKind(messageDependency)) as FilteredMessageDependencyKind;
            if (this.filteredEventLog.matchesFilter(causeEvent) && (level === 0 || MessageDependencyBase.corresponds(messageDependency, endMessageDependency))) {
              if (level === 0) causes.push(messageDependency.duplicate(this.filteredEventLog));
              else this.pushNewFilteredMessageDependency(causes, effectiveKind, messageDependency, endMessageDependency!);
              if (countFilteredMessageDependencies(causes) === this.filteredEventLog.getMaximumNumberOfCauses()) return causes;
            } else if (level < this.filteredEventLog.getMaximumCauseDepth()) {
              todoList.push({ event: causeEvent, firstSeenMessageDependency: level === 0 ? messageDependency : endMessageDependency, effectiveKind, level: level + 1 });
            }
          }
        }
      }
      this.causes = causes;
    }
    return this.causes;
  }

  /** Port of `getConsequences()` (mirror-image of `getCauses()`). */
  getConsequences(): IMessageDependency[] {
    if (this.consequences === null) {
      const begin = Date.now();
      const consequences: IMessageDependency[] = [];
      const todoList: BreadthSearchItem[] = [{ event: this.getEvent(), firstSeenMessageDependency: null, effectiveKind: FilteredMessageDependencyKind.UNDEFINED, level: 0 }];
      // LONG RUNNING OPERATION -- recursive (via the queue) and might take some time
      while (todoList.length > 0) {
        this.filteredEventLog.progress();
        if (Date.now() - begin >= this.filteredEventLog.getMaximumConsequenceCollectionTime()) break;

        const searchItem = todoList.shift()!;
        const currentEvent = searchItem.event;
        const beginMessageDependency = searchItem.firstSeenMessageDependency;
        const currentKind = searchItem.effectiveKind;
        const level = searchItem.level;

        for (const messageDependency of currentEvent.getConsequences()) {
          const consequenceEvent = messageDependency.getConsequenceEvent();
          if (consequenceEvent !== null && (this.filteredEventLog.getCollectMessageReuses() || !(messageDependency instanceof MessageReuseDependency))) {
            const effectiveKind = (currentKind | FilteredEvent.getMessageDependencyKind(messageDependency)) as FilteredMessageDependencyKind;
            if (this.filteredEventLog.matchesFilter(consequenceEvent) && (level === 0 || MessageDependencyBase.corresponds(beginMessageDependency, messageDependency))) {
              if (level === 0) consequences.push(messageDependency.duplicate(this.filteredEventLog));
              else this.pushNewFilteredMessageDependency(consequences, effectiveKind, beginMessageDependency!, messageDependency);
              if (countFilteredMessageDependencies(consequences) === this.filteredEventLog.getMaximumNumberOfConsequences()) return consequences;
            } else if (level < this.filteredEventLog.getMaximumConsequenceDepth()) {
              todoList.push({ event: consequenceEvent, firstSeenMessageDependency: level === 0 ? messageDependency : beginMessageDependency, effectiveKind, level: level + 1 });
            }
          }
        }
      }
      this.consequences = consequences;
    }
    return this.consequences;
  }

  /** Port of `print()`/`print(OutputStream)`/`print(OutputStream, boolean)` -- see eventLogEntry.ts's `print()` convention. */
  print(outputEventLogMessages = true): string {
    return this.getEvent().print(outputEventLogMessages);
  }

  private clearFilteredEventInternalState(): void {
    this.cause = null;
    this.causes = null;
    this.consequences = null;
  }
  private deleteConsequences(): void {
    this.consequences = null;
  }
  private deleteAllocatedObjects(): void {
    this.cause = null;
    this.causes = null;
    this.deleteConsequences();
  }

  private pushNewFilteredMessageDependency(messageDependencies: IMessageDependency[], kind: FilteredMessageDependencyKind, beginMessageDependency: IMessageDependency, endMessageDependency: IMessageDependency): void {
    const newMessageDependency = new FilteredMessageDependency(this.filteredEventLog, kind, beginMessageDependency.duplicate(this.filteredEventLog.getEventLog()), endMessageDependency.duplicate(this.filteredEventLog.getEventLog()));
    for (const existing of messageDependencies) if (existing.equals(newMessageDependency)) return;
    messageDependencies.push(newMessageDependency);
  }
}

function countFilteredMessageDependencies(messageDependencies: IMessageDependency[]): number {
  let count = 0;
  for (const dependency of messageDependencies) if (dependency instanceof FilteredMessageDependency) count++;
  return count;
}
