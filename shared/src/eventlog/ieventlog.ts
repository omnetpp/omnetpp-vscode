/**
 * The interfaces that sit between "a single event's entries" (Event/IChunk, phase E3)
 * and "the eventlog manager" (EventLog, phase E4). Ported from:
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/IChunk.java
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/IEvent.java
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/IMessageDependency.java
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/IEventLog.java
 * plus `org.omnetpp.common.engineext.IMatchableObject` (the two-method `getAsString()`
 * mixin that `IChunk` extends in Java).
 *
 * DESIGN CHOICE (reported per the E3 task): this file ports **all** of IEventLog.java's
 * public surface now (not just the subset Event/chunks/dependencies call), because it
 * is small, entirely self-contained (BigDecimal/MatchKind/IEvent/Index/Snapshot/
 * EventLogEntry/EventLogEntryCache/FileReader — nothing from FilteredEventLog or later
 * phases), and IMessageDependency's implementations (messageDependency.ts) already need
 * the full contract (getEventForSimulationTime, getLastEvent, ...). Porting it whole now
 * means E4's `EventLog` class has one finished contract to implement instead of the
 * surface growing piecemeal across E3/E4/E5.
 *
 * `IEventLog` alone is *not* enough for Event/Index/Snapshot, though: in Java, `Event`,
 * `Index` and `Snapshot` don't hold an `IEventLog` at all -- they hold a reference to the
 * *concrete* `EventLog` class (`protected EventLog eventLog;`) and call several methods
 * that are only public on that concrete class, never declared on the `IEventLog`
 * interface: `getEventForBeginOffset()`, the package-private `readToEventLine()`
 * (declared on `EventLogIndex`, `EventLog`'s superclass), and `cacheEventLogEntry()`.
 * `IEventLogContext` below is that extra coupling surface, named per the phase plan
 * ("a minimal IEventLogContext-style interface... mirroring the subset that
 * Event/chunks/dependencies actually call"). E4's `EventLog` will implement
 * `IEventLogContext` (which structurally implies `IEventLog`); `messageDependency.ts`
 * only needs the narrower, Java-faithful `IEventLog`.
 *
 * Deliberate omissions from the literal Java surface:
 *  - `setProgressMonitor(IProgressMonitor)`: Eclipse-UI-specific, no host-agnostic
 *    equivalent, and redundant with `progress()`/`setProgressCallInterval()` (which
 *    normal callback-based cancellation, per the port plan's `ProgressCallback`
 *    mechanism below).
 *  - `print(OutputStream, ...)` overloads collapse to a single `print(...)` returning a
 *    `string` (no trailing newline; same convention as `EventLogEntry.print()` -- see
 *    eventLogEntry.ts's file header), with the two `long` range arguments and the
 *    `boolean` becoming optional parameters instead of four Java overloads.
 *  - `getMessageNames()`/`getMessageClassNames()` return a plain (insertion-ordered) TS
 *    `Set<string>`, not a `java.util.TreeSet` -- nothing downstream in this phase (or in
 *    IEventLog's own Java callers) depends on iteration order.
 *
 * Object-identity caveat (port plan risk #3): every `IEvent`/`Index`/`Snapshot` this
 * interface hands back is a *value* obtained by calling into the engine, not a stable
 * singleton per event number, once a bounded LRU (phase E7) can evict and later
 * recreate the wrapper object for the same event number. Comparing two `IEvent`s (or an
 * `IEvent` and a concrete `Event`) with `===` is only safe where the plan's risk note
 * says so (a same-call-frame sentinel check, e.g. "is this the very first event");
 * anywhere spans might cross an eviction, compare `getEventNumber()` instead. Each call
 * site in event.ts/chunks.ts that does an identity comparison carries its own comment.
 */

import type { BigDecimal } from './bigDecimal';
import type { MatchKind, FileChange } from './enums';
import type { EventLogEntry } from './eventLogEntry';
import type {
  BeginSendEntry,
  EndSendEntry,
  EventEntry,
  MessageDescriptionEntry,
  ModuleDescriptionEntry,
  SimulationBeginEntry,
  SimulationEndEntry,
} from './entries';
import type { EventLogEntryCache } from './eventLogEntryCache';
import type { FileReader } from './fileReader';
import type { Index, Snapshot } from './chunks';

// ---------------------------------------------------------------------------------
// ProgressCallback -- the injectable long-running-operation hook (port plan: every
// Java loop marked "LONG RUNNING OPERATION" must call this; E1 predates the
// mechanism, so it starts here). `IEventLog.progress()` below *is* the hook: engine
// code calls `this.eventLog.progress()` wherever the Java calls `eventLog.progress()`
// or `progress()`. A host (e.g. the E8 worker thread) implements it by checking a
// SharedArrayBuffer cancel flag and throwing to unwind a long search/scan.
// ---------------------------------------------------------------------------------

export interface ProgressCallback {
  progress(): void;
}

// ---------------------------------------------------------------------------------
// IChunk / IEvent / IMessageDependency -- ported close to 1:1.
// ---------------------------------------------------------------------------------

/** Port of `IChunk` (+ the `IMatchableObject` mixin it extends in Java). */
export interface IChunk {
  /**
   * Port of `IMatchableObject.getAsString()`/`getAsString(String)`, unified into one
   * optional-argument method -- same convention as `EventLogEntry.getAsString()`
   * (see eventLogEntry.ts's file header for the rationale).
   */
  getAsString(attribute?: string): string | null;
  getBeginOffset(): number;
  getEndOffset(): number;
  getEventNumber(): number;
  getSimulationTime(): BigDecimal;
}

/** Type guard distinguishing an `IEvent` from a plain `IChunk` (Index/Snapshot), used
 * by `EventLogEntry.getEvent()` (a port of `chunk instanceof Event ? (Event)chunk :
 * null` that avoids a value-level import of the concrete `Event` class from
 * eventLogEntry.ts, which would otherwise create a real circular module dependency --
 * `getEventEntry()` only exists on `IEvent`, never on `Index`/`Snapshot`, so it is a
 * safe and unique discriminator). */
export function isIEvent(chunk: IChunk): chunk is IEvent {
  return typeof (chunk as Partial<IEvent>).getEventEntry === 'function';
}

/** Port of `IEvent` (extends `IChunk`). */
export interface IEvent extends IChunk {
  getEventLog(): IEventLog;
  getEventEntry(): EventEntry;
  getModuleDescriptionEntry(): ModuleDescriptionEntry;

  getNumEventLogEntries(): number;
  getNumEventLogMessages(): number;
  getNumBeginSendEntries(): number;
  getNumCustomEntries(): number;

  getEventLogEntry(index: number): EventLogEntry;
  getEventLogMessage(index: number): EventLogEntry;

  // subset of the "E" line's fields exposed directly (rest via getEventEntry())
  getModuleId(): number;
  getMessageId(): number;
  getCauseEventNumber(): number;

  getPreviousEvent(): IEvent | null;
  getNextEvent(): IEvent | null;

  getCauseEvent(): IEvent | null;
  getCauseBeginSendEntry(): BeginSendEntry | null;
  /**
   * Port of `IEvent.getCause()`. Typed as the broad `IMessageDependency` (matching the
   * Java interface exactly), not the narrower `MessageSendDependency` a plain `Event`
   * always happens to return -- `FilteredEvent` (phase E5) can return a
   * `FilteredMessageDependency` here (spanning a gap of filtered-out intermediate
   * events), which is not a `MessageSendDependency`.
   */
  getCause(): IMessageDependency | null;
  getCauses(): IMessageDependency[];
  getConsequences(): IMessageDependency[];

  /** Port of `print()`/`print(OutputStream)`/`print(OutputStream, boolean)` -- see this file's header. */
  print(outputEventLogMessages?: boolean): string;

  synchronize(change: FileChange): void;

  findBeginSendEntryIndex(messageId: number): number;
  isSelfMessage(beginSendEntry: BeginSendEntry): boolean;
  isSelfMessageProcessingEvent(): boolean;
  getEndSendEntry(beginSendEntry: BeginSendEntry): EndSendEntry | null;

  getCachedTimelineCoordinateBegin(): number;
  setCachedTimelineCoordinateBegin(value: number): void;
  getCachedTimelineCoordinateEnd(): number;
  setCachedTimelineCoordinateEnd(value: number): void;
  getCachedTimelineCoordinateSystemVersion(): number;
  setCachedTimelineCoordinateSystemVersion(value: number): void;
}

/** Port of `IMessageDependency`. */
export interface IMessageDependency {
  getCauseEventNumber(): number;
  getCauseEvent(): IEvent | null;
  getCauseSimulationTime(): BigDecimal;

  getConsequenceEventNumber(): number;
  getConsequenceEvent(): IEvent | null;
  getConsequenceSimulationTime(): BigDecimal;

  getBeginMessageDescriptionEntry(): MessageDescriptionEntry | null;
  getEndMessageDescriptionEntry(): MessageDescriptionEntry | null;

  duplicate(eventLog: IEventLog): IMessageDependency;
  equals(other: IMessageDependency): boolean;

  /** Port of `print()`/`print(OutputStream)` -- returns the rendered text (see this file's header). */
  print(): string;
}

// ---------------------------------------------------------------------------------
// IEventLog -- full port of the public Java interface (see the DESIGN CHOICE note above).
// ---------------------------------------------------------------------------------

/** Port of `IEventLog`. */
export interface IEventLog extends ProgressCallback {
  getFileReader(): FileReader;
  getEventLogEntryCache(): EventLogEntryCache;

  getNumParsedEvents(): number;
  getMessageNames(): Set<string>;
  getMessageClassNames(): Set<string>;

  getSimulationBeginEntry(): SimulationBeginEntry | null;
  getSimulationEndEntry(): SimulationEndEntry | null;

  isEmpty(): boolean;

  getFirstEventNumber(): number;
  getFirstSimulationTime(): BigDecimal;
  getFirstEvent(): IEvent | null;

  getLastSimulationTime(): BigDecimal;
  getLastEventNumber(): number;
  getLastEvent(): IEvent | null;

  /** `matchKind` defaults to `MatchKind.EXACT`, `useCacheOnly` to `false` (per the Java overloads). */
  getEventForEventNumber(eventNumber: number, matchKind?: MatchKind, useCacheOnly?: boolean): IEvent | null;
  /** `matchKind` defaults to `MatchKind.EXACT`, `useCacheOnly` to `false` (per the Java overloads). */
  getEventForSimulationTime(simulationTime: BigDecimal, matchKind?: MatchKind, useCacheOnly?: boolean): IEvent | null;

  findEventLogEntry(start: EventLogEntry | null, search: string, forward: boolean, caseSensitive: boolean): EventLogEntry | null;

  getFirstIndex(): Index | null;
  getLastIndex(): Index | null;
  /** `matchKind` defaults to `MatchKind.EXACT` (per the Java overload). */
  getIndex(eventNumber: number, matchKind?: MatchKind): Index | null;

  getFirstSnapshot(): Snapshot | null;
  getLastSnapshot(): Snapshot | null;
  /** `matchKind` defaults to `MatchKind.EXACT` (per the Java overload). */
  getSnapshot(eventNumber: number, matchKind?: MatchKind): Snapshot | null;

  getApproximateNumberOfEvents(): number;
  getApproximateEventAt(percentage: number): IEvent | null;
  getApproximatePercentageForEventNumber(eventNumber: number): number;

  /** Port of the four `print(...)` overloads -- see this file's header. */
  print(fromEventNumber?: number, toEventNumber?: number, outputEventLogMessages?: boolean): string;

  getNeighbourEvent(event: IEvent, distance: number): IEvent | null;
  isIncludedInLog(eventNumber: number): boolean;

  getFirstEventNotBeforeEventNumber(eventNumber: number): IEvent | null;
  getLastEventNotAfterEventNumber(eventNumber: number): IEvent | null;
  getFirstEventNotBeforeSimulationTime(simulationTime: BigDecimal): IEvent | null;
  getLastEventNotAfterSimulationTime(simulationTime: BigDecimal): IEvent | null;

  setProgressCallInterval(seconds: number): void;

  synchronize(change: FileChange): void;
}

// ---------------------------------------------------------------------------------
// IEventLogContext -- the extra internal coupling Event/Index/Snapshot need beyond
// IEventLog's public contract (see the DESIGN CHOICE note above for why this is a
// separate, wider interface rather than folding these into IEventLog itself).
// ---------------------------------------------------------------------------------

/** Port of `EventLogIndex.ReadToEventLineResult`, with the `boolean` return value of
 * `readToEventLine()` folded in as `found` instead of an output parameter mutated
 * through a passed-in result object (idiomatic-TS replacement for the Java
 * out-parameter idiom; same fields otherwise). */
export interface ReadToEventLineResult {
  found: boolean;
  eventNumber: number;
  simulationTime: BigDecimal;
  lineBeginOffset: number;
  lineEndOffset: number;
}

export interface IEventLogContext extends IEventLog {
  /** Port of `EventLog.getEventForBeginOffset()` -- concrete-`EventLog`-only in Java (not on `IEventLog`). */
  getEventForBeginOffset(beginOffset: number): IEvent | null;
  /** Port of the package-private `EventLogIndex.readToEventLine()` (accessible to
   * `Event` only because both live in the same Java package; exposed here as part of
   * the context interface instead). */
  readToEventLine(forward: boolean, readStartOffset: number): ReadToEventLineResult;
  /** Port of `EventLog.cacheEventLogEntry()`, which forwards to the shared
   * `EventLogEntryCache` (`eventLogEntryCache.cacheEventLogEntry(eventLogEntry)`);
   * called by `Snapshot.parse()` for every entry parsed out of an "S" chunk. */
  cacheEventLogEntry(eventLogEntry: EventLogEntry): void;
}
