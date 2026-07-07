/**
 * Message dependencies: the causal edges between events, drawn on the Sequence Chart
 * as arrows. Ported from:
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/MessageDependencyBase.java
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/MessageSendDependency.java
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/MessageReuseDependency.java
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/FilteredMessageDependency.java
 * (`IMessageDependency.java` is ported to ieventlog.ts, alongside `IEventLog`/`IEvent`,
 * not here.)
 *
 * FilteredMessageDependency decision (reported per the E3 task): the plan said to port
 * it now only if it has no hard dependency on `FilteredEventLog` (an E5 type). Checked
 * the Java source: it depends only on `IEventLog`/`IEvent`/`IMessageDependency` (all
 * already available) plus its own nested `Kind` enum -- no `FilteredEventLog` import at
 * all. Ported in full below; nothing for E5 to revisit here.
 *
 * These classes use `IEventLog` (the full interface from ieventlog.ts), not
 * `IEventLogContext` -- unlike `Event`/`Index`/`Snapshot`, the Java originals hold an
 * `IEventLog eventLog` field (the interface, not the concrete class), and never need
 * the extra internal coupling methods.
 */

import { BigDecimal } from './bigDecimal';
import { EventNumberKind, MatchKind } from './enums';
import type { BeginSendEntry, MessageDescriptionEntry } from './entries';
import type { IEvent, IEventLog, IMessageDependency } from './ieventlog';

// ---------------------------------------------------------------------------------
// MessageDependencyBase
// ---------------------------------------------------------------------------------

/** Port of `MessageDependencyBase`. */
export abstract class MessageDependencyBase {
  constructor(protected eventLog: IEventLog) {}

  /**
   * Port of the static `MessageDependencyBase.corresponds()`. Two dependencies
   * "correspond" if their begin entries refer to the same message by any of the four
   * message-identity fields OMNeT++ tracks (plain id, tree id [survives `dup()`],
   * encapsulation id, and encapsulation-tree id).
   */
  static corresponds(dependency1: IMessageDependency | null, dependency2: IMessageDependency | null): boolean {
    if (dependency1 === null || dependency2 === null) return false;
    const entry1 = dependency1.getBeginMessageDescriptionEntry();
    const entry2 = dependency2.getBeginMessageDescriptionEntry();
    if (entry1 === null || entry2 === null) return false;
    return (
      (entry1.messageId !== -1 && entry1.messageId === entry2.messageId) ||
      (entry1.messageTreeId !== -1 && entry1.messageTreeId === entry2.messageTreeId) ||
      (entry1.messageEncapsulationId !== -1 && entry1.messageEncapsulationId === entry2.messageEncapsulationId) ||
      (entry1.messageEncapsulationTreeId !== -1 && entry1.messageEncapsulationTreeId === entry2.messageEncapsulationTreeId)
    );
  }

  /** Port of `MessageDependencyBase.equals()`. Concrete subclasses call this via `super.equals(other)` first, then add their own field comparisons. */
  protected equalsBase(other: MessageDependencyBase): boolean {
    if (this.eventLog !== other.eventLog) throw new Error('MessageDependencyBase.equals: dependencies belong to different event logs');
    return true;
  }

  /** Port of `print()`/`print(OutputStream)` — returns the rendered text (see eventLogEntry.ts's `print()` convention). */
  abstract print(): string;
}

// ---------------------------------------------------------------------------------
// MessageSendDependency — a message was sent out at "cause", arrives at "consequence".
// ---------------------------------------------------------------------------------

/** Port of `MessageSendDependency`. */
export class MessageSendDependency extends MessageDependencyBase implements IMessageDependency {
  private causeEventNumber: number;
  private consequenceEventNumber: number = EventNumberKind.EVENT_NOT_YET_CALCULATED;
  /** Refers to an entry of the cause event. */
  private eventLogEntryIndex: number;

  constructor(eventLog: IEventLog, causeEventNumber: number, eventLogEntryIndex: number) {
    super(eventLog);
    if (causeEventNumber < 0) throw new Error('MessageSendDependency: causeEventNumber must be >= 0');
    this.causeEventNumber = causeEventNumber;
    this.eventLogEntryIndex = eventLogEntryIndex;
  }

  getCauseEventNumber(): number {
    return this.causeEventNumber;
  }

  getCauseEvent(): IEvent | null {
    return this.eventLog.getEventForEventNumber(this.causeEventNumber);
  }

  getCauseSimulationTime(): BigDecimal {
    return this.getCauseEvent()!.getSimulationTime();
  }

  /**
   * Port of `getConsequenceEventNumber()`. When only the cause is known (the common
   * case: a send only records the *simulation time* of arrival, not the arrival event
   * number), this scans forward through every event at that simulation time looking
   * for the one this send actually caused (matched by cause-event-number + message
   * id) -- the "LONG RUNNING OPERATION" the port plan calls out, hence the
   * `eventLog.progress()` call inside the `while` loop below.
   */
  getConsequenceEventNumber(): number {
    if (this.consequenceEventNumber === EventNumberKind.EVENT_NOT_YET_CALCULATED || this.consequenceEventNumber === EventNumberKind.EVENT_NOT_YET_REACHED) {
      const consequenceTime = this.getConsequenceSimulationTime();
      if (consequenceTime.equals(BigDecimal.MINUS_ONE)) {
        this.consequenceEventNumber = EventNumberKind.NO_SUCH_EVENT;
      } else if (consequenceTime.greater(this.eventLog.getLastEvent()!.getSimulationTime())) {
        this.consequenceEventNumber = EventNumberKind.EVENT_NOT_YET_REACHED;
      } else {
        let event: IEvent | null = this.eventLog.getEventForSimulationTime(consequenceTime, MatchKind.FIRST_OR_PREVIOUS);
        const messageDescriptionEntry = this.getBeginMessageDescriptionEntry()!;
        // LONG RUNNING OPERATION
        while (event !== null) {
          this.eventLog.progress();
          if (event.getCauseEventNumber() === this.getCauseEventNumber() && event.getMessageId() === messageDescriptionEntry.messageId) {
            this.consequenceEventNumber = event.getEventNumber();
            break;
          }
          if (event.getSimulationTime().greater(consequenceTime)) {
            // no more event at that simulation time, and consequence event still not
            // found. It must have been cancelled (self message), or it is not in the
            // file (filtered out by the user, etc).
            this.consequenceEventNumber = EventNumberKind.NO_SUCH_EVENT;
            break;
          }
          event = event.getNextEvent();
        }
        // end of file
        if (event === null) this.consequenceEventNumber = EventNumberKind.EVENT_NOT_YET_REACHED;
      }
    }
    return this.consequenceEventNumber;
  }

  getConsequenceEvent(): IEvent | null {
    const consequenceEventNumber = this.getConsequenceEventNumber();
    if (consequenceEventNumber < 0) return null;
    return this.eventLog.getEventForEventNumber(consequenceEventNumber);
  }

  getConsequenceSimulationTime(): BigDecimal {
    if (this.consequenceEventNumber >= 0) return this.getConsequenceEvent()!.getSimulationTime();
    // find the arrival time of the message
    const event = this.getCauseEvent()!;
    const beginSendEntry = event.getEventLogEntry(this.eventLogEntryIndex) as BeginSendEntry;
    const endSendEntry = event.getEndSendEntry(beginSendEntry);
    return endSendEntry !== null ? endSendEntry.arrivalTime : BigDecimal.MINUS_ONE;
  }

  getBeginMessageDescriptionEntry(): MessageDescriptionEntry {
    if (this.eventLogEntryIndex === -1) throw new Error('MessageSendDependency: eventLogEntryIndex must not be -1');
    const event = this.getCauseEvent();
    if (event === null) throw new Error('MessageSendDependency: cause event not found');
    return event.getEventLogEntry(this.eventLogEntryIndex) as MessageDescriptionEntry;
  }

  getEndMessageDescriptionEntry(): MessageDescriptionEntry | null {
    const event = this.getCauseEvent()!;
    const beginSendEntry = event.getEventLogEntry(this.eventLogEntryIndex) as BeginSendEntry;
    return event.getEndSendEntry(beginSendEntry);
  }

  duplicate(eventLog: IEventLog): MessageSendDependency {
    return new MessageSendDependency(eventLog, this.causeEventNumber, this.eventLogEntryIndex);
  }

  equals(other: IMessageDependency): boolean {
    if (!(other instanceof MessageSendDependency)) return false;
    return this.equalsBase(other) && this.causeEventNumber === other.causeEventNumber && this.consequenceEventNumber === other.consequenceEventNumber && this.eventLogEntryIndex === other.eventLogEntryIndex;
  }

  print(): string {
    const lines: string[] = [];
    lines.push(this.getCauseEvent()!.getEventEntry().print());
    lines.push(this.getBeginMessageDescriptionEntry().print());
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------------
// MessageReuseDependency — a message arrived at "cause", and was sent out again at
// "consequence" (self-messages rescheduled, or messages forwarded unchanged).
// ---------------------------------------------------------------------------------

/** Port of `MessageReuseDependency`. */
export class MessageReuseDependency extends MessageDependencyBase implements IMessageDependency {
  private causeEventNumber: number = EventNumberKind.EVENT_NOT_YET_CALCULATED;
  private consequenceEventNumber: number;
  /** Refers to an entry of the consequence event. */
  private eventLogEntryIndex: number;

  constructor(eventLog: IEventLog, consequenceEventNumber: number, eventLogEntryIndex: number) {
    super(eventLog);
    this.consequenceEventNumber = consequenceEventNumber;
    this.eventLogEntryIndex = eventLogEntryIndex;
  }

  getCauseEventNumber(): number {
    if (this.causeEventNumber === EventNumberKind.EVENT_NOT_YET_CALCULATED) {
      // only consequence is present, calculate cause from it
      const consequenceEvent = this.getConsequenceEvent();
      if (consequenceEvent === null) throw new Error('MessageReuseDependency: consequence event not found');
      const messageDescriptionEntry = consequenceEvent.getEventLogEntry(this.eventLogEntryIndex) as MessageDescriptionEntry;
      this.causeEventNumber = messageDescriptionEntry.previousEventNumber;
    }
    return this.causeEventNumber;
  }

  getCauseEvent(): IEvent | null {
    const causeEventNumber = this.getCauseEventNumber();
    if (causeEventNumber < 0) return null;
    return this.eventLog.getEventForEventNumber(causeEventNumber);
  }

  getCauseSimulationTime(): BigDecimal {
    if (this.causeEventNumber >= 0) return this.getCauseEvent()!.getSimulationTime();
    return BigDecimal.MINUS_ONE;
  }

  getConsequenceEventNumber(): number {
    return this.consequenceEventNumber;
  }

  getConsequenceEvent(): IEvent | null {
    return this.eventLog.getEventForEventNumber(this.consequenceEventNumber);
  }

  getConsequenceSimulationTime(): BigDecimal {
    return this.getConsequenceEvent()!.getSimulationTime();
  }

  getBeginMessageDescriptionEntry(): MessageDescriptionEntry {
    if (this.eventLogEntryIndex === -1) throw new Error('MessageReuseDependency: eventLogEntryIndex must not be -1');
    const event = this.getConsequenceEvent();
    if (event === null) throw new Error('MessageReuseDependency: consequence event not found');
    return event.getEventLogEntry(this.eventLogEntryIndex) as MessageDescriptionEntry;
  }

  getEndMessageDescriptionEntry(): MessageDescriptionEntry {
    return this.getBeginMessageDescriptionEntry();
  }

  duplicate(eventLog: IEventLog): MessageReuseDependency {
    return new MessageReuseDependency(eventLog, this.consequenceEventNumber, this.eventLogEntryIndex);
  }

  equals(other: IMessageDependency): boolean {
    if (!(other instanceof MessageReuseDependency)) return false;
    return this.equalsBase(other) && this.causeEventNumber === other.causeEventNumber && this.consequenceEventNumber === other.consequenceEventNumber && this.eventLogEntryIndex === other.eventLogEntryIndex;
  }

  print(): string {
    const lines: string[] = [];
    lines.push(this.getConsequenceEvent()!.getEventEntry().print());
    lines.push(this.getBeginMessageDescriptionEntry().print());
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------------
// FilteredMessageDependency — a chain of dependencies collapsed to one begin/end pair
// (used when intermediate events are filtered out of the log).
// ---------------------------------------------------------------------------------

/** Port of `FilteredMessageDependency`. */
export class FilteredMessageDependency extends MessageDependencyBase implements IMessageDependency {
  constructor(
    eventLog: IEventLog,
    private kind: FilteredMessageDependencyKind,
    private beginMessageDependency: IMessageDependency,
    private endMessageDependency: IMessageDependency,
  ) {
    super(eventLog);
  }

  getBeginMessageDependency(): IMessageDependency {
    return this.beginMessageDependency;
  }
  getEndMessageDependency(): IMessageDependency {
    return this.endMessageDependency;
  }

  getCauseEventNumber(): number {
    return this.beginMessageDependency.getCauseEventNumber();
  }
  getCauseEvent(): IEvent | null {
    const causeEventNumber = this.beginMessageDependency.getCauseEventNumber();
    if (causeEventNumber < 0) return null;
    return this.eventLog.getEventForEventNumber(causeEventNumber);
  }
  getCauseSimulationTime(): BigDecimal {
    return this.beginMessageDependency.getCauseSimulationTime();
  }

  getConsequenceEventNumber(): number {
    return this.endMessageDependency.getConsequenceEventNumber();
  }
  getConsequenceEvent(): IEvent | null {
    const consequenceEventNumber = this.endMessageDependency.getConsequenceEventNumber();
    if (consequenceEventNumber < 0) return null;
    return this.eventLog.getEventForEventNumber(consequenceEventNumber);
  }
  getConsequenceSimulationTime(): BigDecimal {
    return this.endMessageDependency.getConsequenceSimulationTime();
  }

  /** Port of `FilteredMessageDependency.getBeginMessageDescriptionEntry()` — note it reads from `beginMessageDependency`, same as Java (not a typo for `endMessageDescriptionEntry`). */
  getBeginMessageDescriptionEntry(): MessageDescriptionEntry | null {
    return this.beginMessageDependency.getBeginMessageDescriptionEntry();
  }
  getEndMessageDescriptionEntry(): MessageDescriptionEntry | null {
    return this.beginMessageDependency.getEndMessageDescriptionEntry();
  }

  getKind(): FilteredMessageDependencyKind {
    return this.kind;
  }

  duplicate(eventLog: IEventLog): FilteredMessageDependency {
    return new FilteredMessageDependency(eventLog, this.kind, this.beginMessageDependency.duplicate(eventLog), this.endMessageDependency.duplicate(eventLog));
  }

  equals(other: IMessageDependency): boolean {
    if (!(other instanceof FilteredMessageDependency)) return false;
    return this.equalsBase(other) && this.beginMessageDependency.equals(other.beginMessageDependency) && this.endMessageDependency.equals(other.endMessageDependency);
  }

  print(): string {
    return [this.beginMessageDependency.print(), this.endMessageDependency.print()].join('\n');
  }
}

/**
 * Port of `FilteredMessageDependency.Kind`. `MIXED = SENDS | REUSES` (bitwise, per the
 * Java enum's own comment) — kept as a plain numeric union rather than reproducing
 * Java's contrived `HashMap`-backed `forValue()`/`getValue()` enum machinery, which
 * exists only to work around Java enums not letting you write `SENDS | REUSES` as a
 * case label; a numeric const object needs no such workaround.
 */
export const FilteredMessageDependencyKind = {
  UNDEFINED: 0,
  SENDS: 1,
  REUSES: 2,
  MIXED: 3, // SENDS | REUSES
} as const;
export type FilteredMessageDependencyKind = (typeof FilteredMessageDependencyKind)[keyof typeof FilteredMessageDependencyKind];
