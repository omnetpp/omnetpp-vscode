/**
 * The Event object model: all eventlog entries belonging to a single "E" line, up to
 * (but not including) the next chunk. Ported from:
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/EventBase.java
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/Event.java
 *
 * Object-identity caveats (port plan risk #3): Java uses `==`/`this ==` in a handful of
 * places to check "is this the very first/last event in the log" or "does this entry
 * really belong to this event" -- both same-call-frame sentinel/assertion checks, not
 * long-lived identity comparisons that could straddle an eviction. Each site below
 * keeps a short comment; `getPreviousEvent()`/`getNextEvent()`'s `eventLog.getFirstEvent()
 * !== this` / `eventLog.getLastEvent() !== this` checks are the ones that would matter
 * once E7 adds a bounded LRU IF `getFirstEvent()`/`getLastEvent()` could ever return a
 * *freshly reconstructed* wrapper object for the same first/last event number.
 * RESOLVED, not converted: `EventLog`'s phase E7 LRU (see eventLog.ts's header)
 * explicitly protects the cached `this.firstEvent`/`this.lastEvent` from eviction, so
 * `getFirstEvent()`/`getLastEvent()` always return that SAME object for as long as the
 * eventlog is open -- the identity checks below stay correct as written, no conversion
 * needed.
 *
 * `parse()`/`parseLines()` mirror the Java termination rule exactly: parsing an event
 * stops at the first entry that `parseEventLogEntry()` returns `null` for -- and that
 * happens for *both* a genuinely blank line *and* an unrecognized entry code (see
 * eventLogEntry.ts/entries.ts's "ME"/"MMB"/"MME" note). This means an event containing
 * a legacy pre-6.0-only code will end up truncated at that line, with `endOffset`
 * pointing just past it rather than at the real blank-line chunk boundary -- this is
 * not a bug in the port, it is Java's *own* documented behavior (`EventLogEntryFactory
 * .parseEntry` returning `null` for an unknown code, treated identically to the blank-
 * line terminator by `Event.parseLines`'s caller). Tests exercise both a modern-format
 * fixture (where this never triggers) and legacy fixtures (where it does, but only
 * affects events that themselves contain a legacy-only line).
 */

import { BigDecimal } from './bigDecimal';
import { FileChange } from './enums';
import {
  BeginSendEntry,
  CloneMessageEntry,
  ComponentMethodBeginEntry,
  ComponentMethodEndEntry,
  CustomEntry,
  DeleteMessageEntry,
  EndSendEntry,
  EventEntry,
  MessageDescriptionEntry,
  type ModuleDescriptionEntry,
  SendDirectEntry,
  SendHopEntry,
  createEntry,
} from './entries';
import { EventLogEntry, EventLogMessageEntry, parseEventLogEntry } from './eventLogEntry';
import type { FileReader } from './fileReader';
import type { IEvent, IEventLogContext, IMessageDependency } from './ieventlog';
import type { Index } from './chunks';
import { MessageReuseDependency, MessageSendDependency } from './messageDependency';

// ---------------------------------------------------------------------------------
// EventBase — the non-file-format-specific half (linking, cached timeline
// coordinates, synchronize()/print()/findBeginSendEntryIndex() defaults).
// ---------------------------------------------------------------------------------

/** Port of `EventBase`. */
export abstract class EventBase {
  previousEvent: EventBase | null = null;
  nextEvent: EventBase | null = null;

  // state for the Sequence Chart (U-track phases)
  cachedTimelineCoordinateBegin = 0;
  cachedTimelineCoordinateEnd = 0;
  cachedTimelineCoordinateSystemVersion = 0;

  abstract getNumEventLogEntries(): number;
  abstract getEventLogEntry(index: number): EventLogEntry;

  getCachedTimelineCoordinateBegin(): number {
    return this.cachedTimelineCoordinateBegin;
  }
  setCachedTimelineCoordinateBegin(value: number): void {
    this.cachedTimelineCoordinateBegin = value;
  }
  getCachedTimelineCoordinateEnd(): number {
    return this.cachedTimelineCoordinateEnd;
  }
  setCachedTimelineCoordinateEnd(value: number): void {
    this.cachedTimelineCoordinateEnd = value;
  }
  getCachedTimelineCoordinateSystemVersion(): number {
    return this.cachedTimelineCoordinateSystemVersion;
  }
  setCachedTimelineCoordinateSystemVersion(value: number): void {
    this.cachedTimelineCoordinateSystemVersion = value;
  }

  /** Port of `EventBase.synchronize()`. */
  synchronize(change: FileChange): void {
    if (change !== FileChange.UNCHANGED) {
      switch (change) {
        case FileChange.OVERWRITTEN:
          this.clearInternalState();
          break;
        case FileChange.APPENDED:
          break;
        default:
          throw new Error('EventBase.synchronize: unknown file change');
      }
    }
  }

  /** Port of `print()`/`print(OutputStream)`/`print(OutputStream, boolean)`, unified (see eventLogEntry.ts's `print()` convention). */
  abstract print(outputEventLogMessages?: boolean): string;

  /** Port of `EventBase.findBeginSendEntryIndex()`. */
  findBeginSendEntryIndex(messageId: number): number {
    for (let i = 0; i < this.getNumEventLogEntries(); i++) {
      const entry = this.getEventLogEntry(i);
      if (entry instanceof BeginSendEntry && entry.messageId === messageId) return i;
    }
    return -1;
  }

  /** Port of `EventBase.linkEvents()`. */
  static linkEvents(previousEvent: EventBase, nextEvent: EventBase): void {
    previousEvent.nextEvent = nextEvent;
    nextEvent.previousEvent = previousEvent;
  }
  /** Port of `EventBase.unlinkEvents()`. */
  static unlinkEvents(previousEvent: EventBase, nextEvent: EventBase): void {
    previousEvent.nextEvent = null;
    nextEvent.previousEvent = null;
  }
  /** Port of `EventBase.unlinkNeighbourEvents()`. */
  static unlinkNeighbourEvents(event: EventBase): void {
    if (event.previousEvent !== null) EventBase.unlinkEvents(event.previousEvent, event);
    if (event.nextEvent !== null) EventBase.unlinkEvents(event, event.nextEvent);
  }

  protected clearInternalState(): void {
    this.previousEvent = null;
    this.nextEvent = null;
    this.cachedTimelineCoordinateBegin = -1;
    this.cachedTimelineCoordinateEnd = -1;
    this.cachedTimelineCoordinateSystemVersion = -1;
  }
}

// ---------------------------------------------------------------------------------
// Event — one "E" line plus every entry up to the next chunk boundary.
// ---------------------------------------------------------------------------------

/** Port of `Event`. */
export class Event extends EventBase implements IEvent {
  eventLog: IEventLogContext;
  beginOffset = -1;
  endOffset = -1;
  eventEntry: EventEntry | null = null;
  moduleDescriptionEntry: ModuleDescriptionEntry | null = null;
  numEventLogMessages = 0;
  numBeginSendEntries = 0;
  numCustomEntries = 0;
  /** All entries parsed from the file (lines below the "E" line). */
  eventLogEntries: EventLogEntry[] = [];

  /** The message send this event is processing ("A is a cause of B iff B is a consequence of A"). */
  cause: MessageSendDependency | null = null;
  /** The arrival message sends of messages this event reuses. */
  causes: IMessageDependency[] | null = null;
  /** The message sends performed in this event. */
  consequences: IMessageDependency[] | null = null;

  constructor(eventLog: IEventLogContext) {
    super();
    this.eventLog = eventLog;
  }

  /**
   * Port of `Event.parse()`. Parses an event starting at the given offset; clears
   * this instance's internal state first.
   */
  parse(reader: FileReader, offset: number): number {
    this.eventLog.progress();
    this.clearInternalState();
    this.numEventLogMessages = 0;
    this.numBeginSendEntries = 0;
    this.numCustomEntries = 0;
    if (offset < 0) throw new Error('Event.parse: offset must be >= 0');
    this.beginOffset = offset;
    return this.parseLines(reader, offset);
  }

  /**
   * Port of `Event.parseLines()`. May be called multiple times if a previous call
   * stopped because it reached the end of the file before the event was completely
   * parsed (live-follow re-entrancy, per the port plan's E9 append handling) --
   * replays the already-loaded entries first to rebuild `contextModuleIds`.
   */
  parseLines(reader: FileReader, offset: number): number {
    reader.seekTo(offset);
    let index = this.eventLogEntries.length;
    // stack of open method-call context module ids; front = top (Java: LinkedList.addFirst/removeFirst)
    const contextModuleIds: number[] = [];
    if (this.eventEntry !== null) contextModuleIds.unshift(this.eventEntry.moduleId);
    for (const entry of this.eventLogEntries) {
      if (entry instanceof ComponentMethodEndEntry) contextModuleIds.shift();
      if (entry instanceof ComponentMethodBeginEntry) contextModuleIds.unshift(entry.targetComponentId);
    }
    while (true) {
      const line = reader.getNextLine();
      if (line === null) {
        this.endOffset = reader.getFileSize();
        break;
      }
      const eventLogEntry = parseEventLogEntry(createEntry, this, index, line.startOffset, line.text);
      // stop at first empty line (or an unrecognized entry code -- see this file's header)
      if (eventLogEntry === null) {
        this.endOffset = line.endOffset;
        break;
      } else {
        index++;
      }
      // first line must be an event entry, and only the first
      const readEventEntry = eventLogEntry instanceof EventEntry ? eventLogEntry : null;
      if (!((this.eventEntry === null && readEventEntry !== null) || (this.eventEntry !== null && readEventEntry === null)))
        throw new Error('Event.parseLines: first entry of an event must be an EventEntry, and only the first');
      if (this.eventEntry === null) {
        this.eventEntry = readEventEntry!;
        contextModuleIds.unshift(this.eventEntry.moduleId);
      }
      if (eventLogEntry instanceof ComponentMethodEndEntry) contextModuleIds.shift();
      eventLogEntry.level = contextModuleIds.length - 1;
      eventLogEntry.contextModuleId = contextModuleIds[0];
      this.eventLogEntries.push(eventLogEntry);
      if (eventLogEntry instanceof ComponentMethodBeginEntry) contextModuleIds.unshift(eventLogEntry.targetComponentId);
      if (eventLogEntry instanceof EventLogMessageEntry) this.numEventLogMessages++;
      else if (eventLogEntry instanceof BeginSendEntry) this.numBeginSendEntries++;
      else if (eventLogEntry instanceof CustomEntry) this.numCustomEntries++;
    }
    if (this.eventEntry === null) throw new Error('Event.parseLines: no EventEntry found while parsing');
    return this.endOffset;
  }

  // ---- IEvent ----

  /** Port of `Event.synchronize()` (calls `super.synchronize()` first, exactly like Java, including its redundant second `clearInternalState()` on OVERWRITTEN). */
  synchronize(change: FileChange): void {
    if (change !== FileChange.UNCHANGED) {
      super.synchronize(change);
      switch (change) {
        case FileChange.OVERWRITTEN:
          this.clearInternalState();
          break;
        case FileChange.APPENDED:
          this.clearInternalState();
          break;
        default:
          throw new Error('Event.synchronize: unknown file change');
      }
    }
  }

  getAsString(attribute?: string): string | null {
    if (attribute === undefined) return this.getModuleDescriptionEntry().fullName;
    if (attribute === 'moduleName') return this.getModuleDescriptionEntry().fullName;
    return null;
  }

  getEventLog(): IEventLogContext {
    return this.eventLog;
  }
  getBeginOffset(): number {
    return this.beginOffset;
  }
  getEndOffset(): number {
    return this.endOffset;
  }
  getEventEntry(): EventEntry {
    return this.eventEntry!;
  }
  getModuleDescriptionEntry(): ModuleDescriptionEntry {
    if (this.moduleDescriptionEntry === null) this.moduleDescriptionEntry = this.eventLog.getEventLogEntryCache().getModuleDescriptionEntry(this.getModuleId());
    return this.moduleDescriptionEntry!;
  }

  getNumEventLogEntries(): number {
    return this.eventLogEntries.length;
  }
  getEventLogEntry(index: number): EventLogEntry {
    return this.eventLogEntries[index];
  }
  getNumEventLogMessages(): number {
    return this.numEventLogMessages;
  }
  getNumBeginSendEntries(): number {
    return this.numBeginSendEntries;
  }
  getNumCustomEntries(): number {
    return this.numCustomEntries;
  }

  getEventLogMessage(index: number): EventLogMessageEntry {
    if (index < 0) throw new Error('Event.getEventLogMessage: index must be >= 0');
    for (const entry of this.eventLogEntries) {
      if (entry instanceof EventLogMessageEntry) {
        if (index === 0) return entry;
        index--;
      }
    }
    throw new Error('Event.getEventLogMessage: index out of range');
  }

  getEventNumber(): number {
    return this.eventEntry!.eventNumber;
  }
  getSimulationTime(): BigDecimal {
    return this.eventEntry!.simulationTime;
  }
  getModuleId(): number {
    return this.eventEntry!.moduleId;
  }
  getMessageId(): number {
    return this.eventEntry!.messageId;
  }
  getCauseEventNumber(): number {
    return this.eventEntry!.causeEventNumber;
  }

  /**
   * Port of `isSelfMessage()`. Java asserts `this == beginSendEntry.getEvent()`
   * (object identity); ported as an event-number comparison per the port plan's
   * eviction-safety rule (risk #3).
   */
  isSelfMessage(beginSendEntry: BeginSendEntry): boolean {
    const owner = beginSendEntry.getEvent();
    if (owner === null || owner.getEventNumber() !== this.getEventNumber())
      throw new Error('Event.isSelfMessage: beginSendEntry does not belong to this event');
    const index = beginSendEntry.getEntryIndex();
    if (index + 1 < this.eventLogEntries.length) return this.eventLogEntries[index + 1] instanceof EndSendEntry;
    return false;
  }

  isSelfMessageProcessingEvent(): boolean {
    const beginSendEntry = this.getCauseBeginSendEntry();
    return beginSendEntry !== null && (beginSendEntry.getEvent() as Event).isSelfMessage(beginSendEntry);
  }

  /**
   * Port of `getEndSendEntry()`. Java asserts `this == beginSendEntry.getEvent()`
   * (object identity); ported as an event-number comparison (risk #3, see `isSelfMessage`).
   */
  getEndSendEntry(beginSendEntry: BeginSendEntry): EndSendEntry | null {
    const owner = beginSendEntry.getEvent();
    if (owner === null || owner.getEventNumber() !== this.getEventNumber())
      throw new Error('Event.getEndSendEntry: beginSendEntry does not belong to this event');
    for (let i = beginSendEntry.getEntryIndex() + 1; i < this.eventLogEntries.length; i++) {
      const entry = this.eventLogEntries[i];
      if (entry instanceof EndSendEntry) return entry;
      // message deleted on the channel (skip all deletes until the matching one is found)
      if (entry instanceof DeleteMessageEntry && entry.messageId === beginSendEntry.messageId) return null;
    }
    throw new Error('Event.getEndSendEntry: neither EndSendEntry nor DeleteMessageEntry found');
  }

  /** Port of `Event.getComponentMethodEndEntry()` (not part of `IEvent`, only on the concrete class, same as Java). */
  getComponentMethodEndEntry(componentMethodBeginEntry: ComponentMethodBeginEntry): ComponentMethodEndEntry | null {
    const owner = componentMethodBeginEntry.getEvent();
    if (owner === null || owner.getEventNumber() !== this.getEventNumber())
      throw new Error('Event.getComponentMethodEndEntry: componentMethodBeginEntry does not belong to this event');
    let level = 0;
    for (let i = componentMethodBeginEntry.getEntryIndex() + 1; i < this.eventLogEntries.length; i++) {
      const entry = this.eventLogEntries[i];
      if (entry instanceof ComponentMethodBeginEntry) level++;
      if (entry instanceof ComponentMethodEndEntry) {
        if (level === 0) return entry;
        level--;
      }
    }
    // premature end of file
    return null;
  }

  /** Port of `Event.getTransmissionDelay()` (not part of `IEvent`, only on the concrete class, same as Java). */
  getTransmissionDelay(beginSendEntry: BeginSendEntry): BigDecimal {
    const owner = beginSendEntry.getEvent();
    if (owner === null || owner.getEventNumber() !== this.getEventNumber())
      throw new Error('Event.getTransmissionDelay: beginSendEntry does not belong to this event');
    const endSendEntry = this.getEndSendEntry(beginSendEntry);
    let index = beginSendEntry.getEntryIndex() + 1;
    let transmissionDelay = BigDecimal.ZERO;
    // there is at most one entry which specifies a transmission delay
    while (index < this.eventLogEntries.length) {
      const entry = this.eventLogEntries[index];
      if (entry instanceof SendDirectEntry) {
        transmissionDelay = entry.transmissionDelay;
      } else if (entry instanceof SendHopEntry) {
        transmissionDelay = entry.transmissionDelay;
      } else if (entry === endSendEntry || !(entry instanceof EventLogMessageEntry || entry instanceof MessageDescriptionEntry)) {
        break;
      }
      if (!transmissionDelay.equals(BigDecimal.ZERO)) break;
      index++;
    }
    return transmissionDelay;
  }

  /** Port of `Event.getRemainingDuration()` (not part of `IEvent`, only on the concrete class, same as Java). */
  getRemainingDuration(beginSendEntry: BeginSendEntry): BigDecimal {
    const owner = beginSendEntry.getEvent();
    if (owner === null || owner.getEventNumber() !== this.getEventNumber())
      throw new Error('Event.getRemainingDuration: beginSendEntry does not belong to this event');
    const endSendEntry = this.getEndSendEntry(beginSendEntry);
    let index = beginSendEntry.getEntryIndex() + 1;
    let remainingDuration = BigDecimal.ZERO;
    // there is at most one entry which specifies a transmission delay
    while (index < this.eventLogEntries.length) {
      const entry = this.eventLogEntries[index];
      if (entry instanceof SendDirectEntry) {
        remainingDuration = entry.remainingDuration;
      } else if (entry instanceof SendHopEntry) {
        remainingDuration = entry.remainingDuration;
      } else if (entry === endSendEntry || !(entry instanceof EventLogMessageEntry || entry instanceof MessageDescriptionEntry)) {
        break;
      }
      if (!remainingDuration.equals(BigDecimal.ZERO)) break;
      index++;
    }
    return remainingDuration;
  }

  /**
   * Port of `getPreviousEvent()`. `eventLog.getFirstEvent() !== this` is a same-call
   * sentinel check ("am I the very first event"), not a long-lived identity
   * comparison -- safe under the port plan's risk #3, see this file's header.
   */
  getPreviousEvent(): Event | null {
    if (this.previousEvent === null && this.eventLog.getFirstEvent() !== this) {
      const result = this.eventLog.readToEventLine(false, this.beginOffset);
      if (result.found) {
        const previousEvent = this.eventLog.getEventForBeginOffset(result.lineBeginOffset) as Event | null;
        this.previousEvent = previousEvent;
        if (previousEvent !== null) EventBase.linkEvents(previousEvent, this);
      }
    }
    return this.previousEvent as Event | null;
  }

  /** Port of `getNextEvent()` (see `getPreviousEvent()`'s note on the identity check). */
  getNextEvent(): Event | null {
    if (this.nextEvent === null && this.eventLog.getLastEvent() !== this) {
      const result = this.eventLog.readToEventLine(true, this.endOffset);
      if (result.found) {
        const nextEvent = this.eventLog.getEventForBeginOffset(result.lineBeginOffset) as Event | null;
        this.nextEvent = nextEvent;
        if (nextEvent !== null) EventBase.linkEvents(this, nextEvent);
      }
    }
    return this.nextEvent as Event | null;
  }

  getCauseEvent(): Event | null {
    const causeEventNumber = this.getCauseEventNumber();
    if (causeEventNumber !== -1) return this.eventLog.getEventForEventNumber(causeEventNumber) as Event | null;
    return null;
  }

  getCauseBeginSendEntry(): BeginSendEntry | null {
    const cause = this.getCause();
    return cause !== null ? (cause.getBeginMessageDescriptionEntry() as BeginSendEntry) : null;
  }

  getCause(): MessageSendDependency | null {
    if (this.cause === null) {
      const event = this.getCauseEvent();
      if (event !== null) {
        const index = event.findBeginSendEntryIndex(this.getMessageId());
        if (index !== -1) this.cause = new MessageSendDependency(this.eventLog, this.getCauseEventNumber(), index);
      }
    }
    return this.cause;
  }

  getCauses(): IMessageDependency[] {
    if (this.causes === null) {
      const causes: IMessageDependency[] = [];
      // using "ce" from the "E" line
      const cause = this.getCause();
      if (cause !== null) causes.push(cause);
      // add message reuses
      const eventNumber = this.getEventNumber();
      for (let i = 0; i < this.eventLogEntries.length; i++) {
        const entry = this.eventLogEntries[i];
        if (entry instanceof MessageDescriptionEntry && entry.previousEventNumber !== -1 && entry.previousEventNumber !== eventNumber)
          causes.push(new MessageReuseDependency(this.eventLog, eventNumber, i));
      }
      this.causes = causes;
    }
    return this.causes;
  }

  getConsequences(): IMessageDependency[] {
    if (this.consequences === null) {
      const consequences: IMessageDependency[] = [];
      // collect all message ids used in this event (eliminating duplicates), sorted ascending like Java's TreeSet<Long>
      const messageIds = new Set<number>();
      if (this.getMessageId() !== -1) messageIds.add(this.getMessageId());
      for (let i = 0; i < this.eventLogEntries.length; i++) {
        const entry = this.eventLogEntries[i];
        if (entry instanceof MessageDescriptionEntry) {
          if (entry instanceof DeleteMessageEntry) {
            messageIds.delete(entry.messageId);
          } else {
            messageIds.add(entry.messageId);
            if (entry instanceof CloneMessageEntry) messageIds.add(entry.cloneId);
          }
        }
      }
      // collect reuses (Java iterates the TreeSet in ascending order; match that for determinism)
      for (const messageId of [...messageIds].sort((a, b) => a - b)) {
        const reuseMessageDescriptionEntry = this.findReuseMessageDescriptionEntry(messageId);
        if (reuseMessageDescriptionEntry !== null) {
          // Java: Assert.isTrue(reuseMessageDescriptionEntry.previousEventNumber == getEventNumber())
          // -- a plain-number field comparison (not an object-identity check, so risk #3
          // does not apply here), verifying the found entry really points back at *this* event.
          if (reuseMessageDescriptionEntry.previousEventNumber !== this.getEventNumber())
            throw new Error('Event.getConsequences: found reuse entry does not point back to this event');
          const reuseEvent = reuseMessageDescriptionEntry.getEvent() as Event;
          consequences.push(new MessageReuseDependency(this.eventLog, reuseEvent.getEventNumber(), reuseMessageDescriptionEntry.getEntryIndex()));
        }
      }
      // handle begin sends separately
      for (let i = 0; i < this.eventLogEntries.length; i++) {
        // Java calls eventLog.progress() here too (this loop can run once per entry of
        // a huge event); it isn't literally commented "LONG RUNNING OPERATION" in
        // Event.java the way MessageSendDependency's loop is, but the call is real.
        this.eventLog.progress();
        // using "t" from "ES" lines
        const entry = this.eventLogEntries[i];
        if (entry instanceof BeginSendEntry && messageIds.has(entry.messageId)) consequences.push(new MessageSendDependency(this.eventLog, this.getEventNumber(), i));
      }
      this.consequences = consequences;
    }
    return this.consequences;
  }

  print(outputEventLogMessages = true): string {
    const lines: string[] = [];
    for (const entry of this.eventLogEntries) if (outputEventLogMessages || !(entry instanceof EventLogMessageEntry)) lines.push(entry.print());
    return lines.join('\n');
  }

  protected clearInternalState(): void {
    super.clearInternalState();
    this.beginOffset = -1;
    this.endOffset = -1;
    this.numEventLogMessages = -1;
    this.numBeginSendEntries = -1;
    this.numCustomEntries = -1;
    this.eventEntry = null;
    this.moduleDescriptionEntry = null;
    this.cause = null;
    this.causes = null;
    this.consequences = null;
    this.eventLogEntries.length = 0;
  }

  /**
   * Port of `Event.findReuseMessageDescriptionEntry()`. Searches for the first
   * eventlog entry reusing `messageId`, starting from the immediately following event
   * and ending at the end of the eventlog. Three phases, exactly like Java: (1) linear
   * search among events until the first `Index` chunk is reached; (2) linear search
   * among indices; (3) linear search among the remaining events after the last index.
   */
  protected findReuseMessageDescriptionEntry(messageId: number): MessageDescriptionEntry | null {
    // 1. linear search among the events starting from the immediately following event until the first index
    let index: Index | null = null;
    let event = this.getNextEvent();
    const previousEventNumber = this.getEventNumber();
    while (event !== null) {
      if (event.getMessageId() === messageId) return null; // found an EventEntry, but that is not a message reuse
      const found = event.findLocalReuseMessageDescriptionEntry(previousEventNumber, messageId);
      if (found !== null) return found;
      index = this.eventLog.getIndex(event.getEventNumber());
      if (index !== null) break;
      event = event.getNextEvent();
    }
    // 2. linear search among the indices starting from the first index after this event until the last index
    event = null;
    while (index !== null) {
      // check if there's any reference to this event
      if (index.containsReferenceRemovedEntry(previousEventNumber, -1)) {
        const removedEntries = index.getRemovedEventLogEntries();
        for (const removedEntry of removedEntries) {
          const removedMessageDescriptionEntry = removedEntry instanceof MessageDescriptionEntry ? removedEntry : null;
          const removedEventEntry = removedEntry instanceof EventEntry ? removedEntry : null;
          // looking for a removed eventlog entry (from this event) belonging to this event, with the given message id
          const removedFromThisEvent =
            (removedMessageDescriptionEntry !== null &&
              removedMessageDescriptionEntry.messageId === messageId &&
              (removedMessageDescriptionEntry.getEvent()?.getEventNumber() ?? null) === this.getEventNumber()) ||
            (removedEventEntry !== null && removedEventEntry.messageId === messageId && (removedEventEntry.getEvent()?.getEventNumber() ?? null) === this.getEventNumber());
          if (removedFromThisEvent) {
            // there can be another entry that removed the one we are looking for
            const addedEntries = index.getAddedEventLogEntries();
            for (const addedEntry of addedEntries) {
              const addedMessageDescriptionEntry = addedEntry instanceof MessageDescriptionEntry ? addedEntry : null;
              // we must make sure that the previousEventNumber matches
              if (addedMessageDescriptionEntry !== null && addedMessageDescriptionEntry.messageId === messageId && addedMessageDescriptionEntry.previousEventNumber === previousEventNumber)
                return addedMessageDescriptionEntry;
            }
            // since there was no such entry the message is deleted between the two indices
            // do a linear search between the previous and this index to find out what happened between them
            const previousIndex = index.getPreviousIndex();
            if (previousIndex !== null) {
              let scanEvent = this.eventLog.getEventForEventNumber(previousIndex.getIndexEntry().eventNumber) as Event | null;
              scanEvent = scanEvent !== null ? scanEvent.getNextEvent() : null;
              while (scanEvent !== null) {
                if (scanEvent.getMessageId() === messageId) return null; // found an EventEntry, but that is not a message reuse
                const found = scanEvent.findLocalReuseMessageDescriptionEntry(previousEventNumber, messageId);
                if (found !== null) return found;
                if (scanEvent.getEventNumber() === index.getIndexEntry().eventNumber) break;
                scanEvent = scanEvent.getNextEvent();
              }
            }
            // we can stop here, because there is no sign of the message
            return null;
          }
        }
      }
      const nextIndex = index.getNextIndex();
      if (nextIndex === null) event = index.getEvent();
      index = nextIndex;
    }
    // 3. linear search among the remaining events (after the last index)
    while (event !== null) {
      if (event.getMessageId() === messageId) return null; // found an EventEntry, but that is not a message reuse
      const found = event.findLocalReuseMessageDescriptionEntry(previousEventNumber, messageId);
      if (found !== null) return found;
      event = event.getNextEvent();
    }
    // reached end of eventlog
    return null;
  }

  /** Port of `Event.findLocalReuseMessageDescriptionEntry()` (not part of `IEvent`, only on the concrete class, same as Java). */
  protected findLocalReuseMessageDescriptionEntry(previousEventNumber: number, messageId: number): MessageDescriptionEntry | null {
    for (const entry of this.eventLogEntries) {
      if (entry instanceof MessageDescriptionEntry && entry.messageId === messageId && entry.previousEventNumber === previousEventNumber) return entry;
    }
    return null;
  }
}
