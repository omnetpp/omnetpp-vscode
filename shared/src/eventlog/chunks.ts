/**
 * Lazily-parsed "I"/"S" chunk objects. Ported from:
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/IChunk.java (interface;
 *     ported to ieventlog.ts, not here)
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/Index.java
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/Snapshot.java
 *
 * Both chunk kinds are "lazy": the constructor only records the chunk's begin offset;
 * the actual line content is parsed on first access (`ensureParsed()`), exactly like
 * the Java originals (`getEndOffset()`/`getEventNumber()`/etc. all call
 * `ensureParsed()` before touching parsed state).
 *
 * DEVIATION (mandated by the port plan, and see eventLogEntryCache.ts's file header for
 * the full reasoning): `Index.getFoundEventLogEntries()`/`Snapshot.getFoundEventLogEntries()`
 * return a plain `EventLogEntry[]` here, not an `EventLogEntryCache`. Java's version
 * constructs a fresh `EventLogEntryCache` per chunk purely to reuse its `ArrayList`
 * add/remove -- the categorized lookup maps that class exists for are never touched by
 * this code path, and (checked via `grep -rl getFoundEventLogEntries` across the whole
 * `ui/` tree) no caller outside these two files ever calls the method, so nothing
 * downstream depends on the richer shape.
 *
 * Object-identity caveat (port plan risk #3): `getFoundEventLogEntries()`'s merge step
 * removes a "removed" entry from the running array by reference identity (`Array#
 * indexOf`+`splice`, matching Java's `ArrayList.remove(Object)`, which is reference
 * equality since `EventLogEntry` never overrides `equals()`). This is safe as long as
 * the same `Event` object (and hence the same `EventLogEntry` instances within it) is
 * returned for a given event number every time -- true in this phase (no eviction
 * exists yet) but not guaranteed once E7's bounded LRU can evict and later recreate an
 * `Event` for the same event number. E7 must revisit this if it turns out a chunk's
 * merge can span an eviction (in practice unlikely, since chunks summarize forward from
 * the previous chunk in the same pass, but worth re-checking then).
 *
 * `getEvent()`/`getPreviousEvent()`/`getNextEvent()` return the concrete `Event` type
 * (not `IEvent`), narrowing (covariantly, same as Java's `Event`-returning overrides)
 * the `IEvent | null` that `IEventLogContext` hands back, via an explicit `as Event`
 * cast at the point where Java relies on a *concrete*-`EventLog`-typed field to already
 * return `Event` (see ieventlog.ts's file header for why `IEventLogContext` exists).
 */

import type { BigDecimal } from './bigDecimal';
import { MatchKind } from './enums';
import { createEntry } from './entries';
import { IndexEntry, ReferenceAddedEntry, ReferenceEntry, ReferenceFoundEntry, ReferenceRemovedEntry, SnapshotEntry } from './entries';
import type { EventLogEntry } from './eventLogEntry';
import { parseEventLogEntry } from './eventLogEntry';
import type { FileReader } from './fileReader';
import type { IChunk, IEventLogContext } from './ieventlog';
import type { Event } from './event';

// ---------------------------------------------------------------------------------
// Index — "I" chunk (incremental snapshot: added/removed references since the
// previous chunk).
// ---------------------------------------------------------------------------------

/** Port of `Index`. */
export class Index implements IChunk {
  eventLog: IEventLogContext;
  event: Event | null = null;
  indexEntry: IndexEntry | null = null;
  beginOffset: number;
  endOffset = -1;

  previousSnapshot: Snapshot | null;
  nextSnapshot: Snapshot | null = null;
  previousIndex: Index | null = null;
  nextIndex: Index | null = null;

  referenceAddedEntries: ReferenceEntry[] = [];
  referenceRemovedEntries: ReferenceEntry[] = [];
  referenceFoundEntries: ReferenceEntry[] | null = null;

  addedEventLogEntries: EventLogEntry[] | null = null;
  removedEventLogEntries: EventLogEntry[] | null = null;
  /** DEVIATION: `EventLogEntryCache` in Java -- see this file's header. */
  foundEventLogEntries: EventLogEntry[] | null = null;

  constructor(eventLog: IEventLogContext, beginOffset: number, previousSnapshot: Snapshot | null) {
    if (beginOffset < 0) throw new Error('Index: beginOffset must be >= 0');
    this.eventLog = eventLog;
    this.beginOffset = beginOffset;
    this.previousSnapshot = previousSnapshot;
  }

  /** Port of `Index.parse()`. */
  parse(reader: FileReader): number {
    reader.seekTo(this.beginOffset);
    let index = 0;
    while (true) {
      const line = reader.getNextLine();
      if (line === null) {
        this.endOffset = reader.getFileSize();
        break;
      }
      const eventLogEntry = parseEventLogEntry(createEntry, null, index, line.startOffset, line.text);
      // stop at first empty line (or an unrecognized entry code -- see eventLogEntry.ts: both parse to null)
      if (eventLogEntry === null) {
        this.endOffset = line.endOffset;
        break;
      } else {
        index++;
      }
      // first line must be an index entry, and only the first
      if (this.indexEntry === null) {
        if (!(eventLogEntry instanceof IndexEntry)) throw new Error('Index: first entry of an "I" chunk must be an IndexEntry');
        this.indexEntry = eventLogEntry;
      } else if (eventLogEntry instanceof IndexEntry) {
        throw new Error('Index: unexpected second IndexEntry within one "I" chunk');
      }
      if (eventLogEntry instanceof ReferenceAddedEntry) this.referenceAddedEntries.push(eventLogEntry);
      if (eventLogEntry instanceof ReferenceRemovedEntry) this.referenceRemovedEntries.push(eventLogEntry);
    }
    return this.endOffset;
  }

  /** Port of `Index.print()` (returns the rendered text instead of writing to a stream -- see eventLogEntry.ts's `print()` convention). */
  print(): string {
    this.ensureParsed();
    const lines = [this.indexEntry!.print()];
    for (const entry of this.referenceRemovedEntries) lines.push(entry.print());
    for (const entry of this.referenceAddedEntries) lines.push(entry.print());
    return lines.join('\n');
  }

  getAsString(_attribute?: string): string | null {
    return null;
  }

  getBeginOffset(): number {
    return this.beginOffset;
  }
  getEndOffset(): number {
    this.ensureParsed();
    return this.endOffset;
  }
  getIndexEntry(): IndexEntry {
    this.ensureParsed();
    return this.indexEntry!;
  }
  getEventNumber(): number {
    this.ensureParsed();
    return this.indexEntry!.eventNumber;
  }
  getSimulationTime(): BigDecimal {
    this.ensureParsed();
    return this.indexEntry!.simulationTime;
  }

  getEvent(): Event {
    if (this.event === null) this.event = this.eventLog.getEventForEventNumber(this.getIndexEntry().eventNumber) as Event;
    return this.event!;
  }
  getPreviousEvent(): Event | null {
    return this.getEvent().getPreviousEvent();
  }
  getNextEvent(): Event {
    return this.getEvent();
  }

  getPreviousIndex(): Index | null {
    return this.previousIndex;
  }
  getNextIndex(): Index | null {
    return this.nextIndex;
  }
  getPreviousSnapshot(): Snapshot | null {
    return this.previousSnapshot;
  }
  getNextSnapshot(): Snapshot | null {
    if (this.nextSnapshot === null) this.nextSnapshot = this.eventLog.getSnapshot(this.getIndexEntry().eventNumber, MatchKind.LAST_OR_NEXT);
    return this.nextSnapshot;
  }

  containsReferenceAddedEntry(eventNumber: number, entryIndex: number): boolean {
    this.ensureParsed();
    return Index.containsReferenceEntry(this.referenceAddedEntries, eventNumber, entryIndex);
  }
  containsReferenceRemovedEntry(eventNumber: number, entryIndex: number): boolean {
    this.ensureParsed();
    return Index.containsReferenceEntry(this.referenceRemovedEntries, eventNumber, entryIndex);
  }
  containsReferenceFoundEntry(eventNumber: number, entryIndex: number): boolean {
    this.ensureParsed();
    return Index.containsReferenceEntry(this.getReferenceFoundEntries(), eventNumber, entryIndex);
  }

  getReferenceAddedEntries(): ReferenceEntry[] {
    this.ensureParsed();
    return [...this.referenceAddedEntries];
  }
  getReferenceRemovedEntries(): ReferenceEntry[] {
    this.ensureParsed();
    return [...this.referenceRemovedEntries];
  }

  /** Port of `Index.getReferenceFoundEntries()` — merges this chunk's added/removed references onto the previous chunk's found set. */
  getReferenceFoundEntries(): ReferenceEntry[] {
    if (this.referenceFoundEntries === null) {
      this.ensureParsed();
      const result: ReferenceEntry[] = [];
      let previousReferenceFoundEntries: ReferenceEntry[] | null = null;
      if (this.previousSnapshot !== null && (this.previousIndex === null || this.previousIndex.getEventNumber() <= this.previousSnapshot.getEventNumber()))
        previousReferenceFoundEntries = this.previousSnapshot.getReferenceFoundEntries();
      else if (this.previousIndex !== null) previousReferenceFoundEntries = this.previousIndex.getReferenceFoundEntries();
      if (previousReferenceFoundEntries !== null) {
        for (const previous of previousReferenceFoundEntries) {
          const referenceFoundEntry = new ReferenceFoundEntry();
          referenceFoundEntry.chunk = this;
          referenceFoundEntry.entryIndex = -1;
          referenceFoundEntry.eventNumber = previous.eventNumber;
          referenceFoundEntry.beginEntryIndex = previous.beginEntryIndex;
          referenceFoundEntry.endEntryIndex = previous.endEntryIndex;
          result.push(referenceFoundEntry);
        }
      }
      for (const referenceRemovedEntry of this.referenceRemovedEntries) {
        for (let index = 0; index < result.length; ) {
          const referenceFoundEntry = result[index];
          if (referenceFoundEntry.eventNumber === referenceRemovedEntry.eventNumber) {
            if (referenceRemovedEntry.endEntryIndex < referenceFoundEntry.beginEntryIndex || referenceRemovedEntry.beginEntryIndex > referenceFoundEntry.endEntryIndex) {
              // unrelated remove
              index++;
            } else if (referenceRemovedEntry.beginEntryIndex <= referenceFoundEntry.beginEntryIndex && referenceRemovedEntry.endEntryIndex >= referenceFoundEntry.endEntryIndex) {
              // complete remove
              result.splice(index, 1);
            } else if (referenceRemovedEntry.beginEntryIndex <= referenceFoundEntry.beginEntryIndex && referenceRemovedEntry.endEntryIndex < referenceFoundEntry.endEntryIndex) {
              // remove lower part
              referenceFoundEntry.beginEntryIndex = referenceRemovedEntry.endEntryIndex - 1;
              index++;
            } else if (referenceRemovedEntry.beginEntryIndex > referenceFoundEntry.beginEntryIndex && referenceRemovedEntry.endEntryIndex >= referenceFoundEntry.endEntryIndex) {
              // remove upper part
              referenceFoundEntry.endEntryIndex = referenceRemovedEntry.beginEntryIndex - 1;
              index++;
            } else {
              // split remove
              result.splice(index, 1);
              const lower = new ReferenceFoundEntry();
              lower.chunk = this;
              lower.entryIndex = -1;
              lower.eventNumber = referenceFoundEntry.eventNumber;
              lower.beginEntryIndex = referenceFoundEntry.beginEntryIndex;
              lower.endEntryIndex = referenceRemovedEntry.beginEntryIndex - 1;
              result.push(lower);
              const upper = new ReferenceFoundEntry();
              upper.chunk = this;
              upper.entryIndex = -1;
              upper.eventNumber = referenceFoundEntry.eventNumber;
              upper.beginEntryIndex = referenceRemovedEntry.endEntryIndex + 1;
              upper.endEntryIndex = referenceFoundEntry.endEntryIndex;
              result.push(upper);
            }
          } else {
            index++;
          }
        }
      }
      // added entries are disjunct
      for (const referenceAddedEntry of this.referenceAddedEntries) {
        const referenceFoundEntry = new ReferenceFoundEntry();
        referenceFoundEntry.chunk = this;
        referenceFoundEntry.entryIndex = -1;
        referenceFoundEntry.eventNumber = referenceAddedEntry.eventNumber;
        referenceFoundEntry.beginEntryIndex = referenceAddedEntry.beginEntryIndex;
        referenceFoundEntry.endEntryIndex = referenceAddedEntry.endEntryIndex;
        result.push(referenceFoundEntry);
      }
      this.referenceFoundEntries = result;
    }
    return this.referenceFoundEntries;
  }

  getAddedEventLogEntries(): EventLogEntry[] {
    if (this.addedEventLogEntries === null) this.addedEventLogEntries = this.resolveReferenceEntries(this.referenceAddedEntries);
    return this.addedEventLogEntries;
  }
  getRemovedEventLogEntries(): EventLogEntry[] {
    if (this.removedEventLogEntries === null) this.removedEventLogEntries = this.resolveReferenceEntries(this.referenceRemovedEntries);
    return this.removedEventLogEntries;
  }

  /** Port of `Index.getFoundEventLogEntries()` (returns `EventLogEntry[]`, not an `EventLogEntryCache` — see this file's header). */
  getFoundEventLogEntries(): EventLogEntry[] {
    if (this.foundEventLogEntries === null) {
      this.ensureParsed();
      const found: EventLogEntry[] = [];
      let previousFound: EventLogEntry[] | null = null;
      if (this.previousSnapshot !== null && (this.previousIndex === null || this.previousIndex.getEventNumber() <= this.previousSnapshot.getEventNumber()))
        previousFound = this.previousSnapshot.getFoundEventLogEntries();
      else if (this.previousIndex !== null) previousFound = this.previousIndex.getFoundEventLogEntries();
      if (previousFound !== null) for (const entry of previousFound) found.push(entry);
      for (const entry of this.getRemovedEventLogEntries()) {
        // Java: ArrayList.remove(Object) — reference-identity removal (see this file's header note on risk #3).
        const idx = found.indexOf(entry);
        if (idx >= 0) found.splice(idx, 1);
      }
      for (const entry of this.getAddedEventLogEntries()) found.push(entry);
      this.foundEventLogEntries = found;
    }
    return this.foundEventLogEntries;
  }

  /** Port of `Index.linkIndices()`. */
  static linkIndices(previousIndex: Index, nextIndex: Index): void {
    previousIndex.nextIndex = nextIndex;
    nextIndex.previousIndex = previousIndex;
  }
  /** Port of `Index.unlinkIndices()`. */
  static unlinkIndices(previousIndex: Index, nextIndex: Index): void {
    previousIndex.nextIndex = null;
    nextIndex.previousIndex = null;
  }
  /** Port of `Index.unlinkNeighbourIndices()`. */
  static unlinkNeighbourIndices(index: Index): void {
    if (index.previousIndex !== null) Index.unlinkIndices(index.previousIndex, index);
    if (index.nextIndex !== null) Index.unlinkIndices(index, index.nextIndex);
  }

  private ensureParsed(): void {
    if (this.indexEntry === null) this.parse(this.eventLog.getFileReader());
  }

  private resolveReferenceEntries(referenceEntries: ReferenceEntry[]): EventLogEntry[] {
    this.ensureParsed();
    const entries: EventLogEntry[] = [];
    for (const referenceEntry of referenceEntries) {
      const event = this.eventLog.getEventForEventNumber(referenceEntry.eventNumber);
      if (event !== null) for (let i = referenceEntry.beginEntryIndex; i <= referenceEntry.endEntryIndex; i++) entries.push(event.getEventLogEntry(i));
    }
    return entries;
  }

  private static containsReferenceEntry(referenceEntries: ReferenceEntry[], eventNumber: number, entryIndex: number): boolean {
    for (const referenceEntry of referenceEntries) if (referenceEntry.eventNumber === eventNumber && referenceEntry.entryIndex === entryIndex) return true;
    return false;
  }
}

// ---------------------------------------------------------------------------------
// Snapshot — "S" chunk (a full snapshot of the current simulation state).
// ---------------------------------------------------------------------------------

/** Port of `Snapshot`. */
export class Snapshot implements IChunk {
  eventLog: IEventLogContext;
  event: Event | null = null;
  snapshotEntry: SnapshotEntry | null = null;
  beginOffset: number;
  endOffset = -1;
  eventLogEntries: EventLogEntry[] = [];

  previousSnapshot: Snapshot | null = null;
  nextSnapshot: Snapshot | null = null;
  previousIndex: Index | null = null;
  nextIndex: Index | null = null;

  referenceFoundEntries: ReferenceEntry[] = [];
  /** DEVIATION: `EventLogEntryCache` in Java -- see this file's header. */
  foundEventLogEntryCache: EventLogEntry[] | null = null;

  constructor(eventLog: IEventLogContext, beginOffset: number) {
    if (beginOffset < 0) throw new Error('Snapshot: beginOffset must be >= 0');
    this.eventLog = eventLog;
    this.beginOffset = beginOffset;
  }

  /** Port of `Snapshot.parse()`. */
  parse(reader: FileReader): number {
    reader.seekTo(this.beginOffset);
    let index = 0;
    while (true) {
      const line = reader.getNextLine();
      if (line === null) {
        this.endOffset = reader.getFileSize();
        break;
      }
      const eventLogEntry = parseEventLogEntry(createEntry, null, index, line.startOffset, line.text);
      // stop at first empty line (or an unrecognized entry code -- see eventLogEntry.ts: both parse to null)
      if (eventLogEntry === null) {
        this.endOffset = line.endOffset;
        break;
      } else {
        index++;
      }
      // first line must be a snapshot entry, and only the first
      if (this.snapshotEntry === null) {
        if (!(eventLogEntry instanceof SnapshotEntry)) throw new Error('Snapshot: first entry of an "S" chunk must be a SnapshotEntry');
        this.snapshotEntry = eventLogEntry;
      } else if (eventLogEntry instanceof SnapshotEntry) {
        throw new Error('Snapshot: unexpected second SnapshotEntry within one "S" chunk');
      }
      this.eventLogEntries.push(eventLogEntry);
      this.eventLog.cacheEventLogEntry(eventLogEntry);
      if (eventLogEntry instanceof ReferenceFoundEntry) this.referenceFoundEntries.push(eventLogEntry);
    }
    if (this.snapshotEntry === null) throw new Error('Snapshot: no SnapshotEntry found while parsing an "S" chunk');
    return this.endOffset;
  }

  /** Port of `Snapshot.print()` (returns the rendered text instead of writing to a stream). */
  print(): string {
    this.ensureParsed();
    return this.eventLogEntries.map((entry) => entry.print()).join('\n');
  }

  getAsString(_attribute?: string): string | null {
    return null;
  }

  getBeginOffset(): number {
    return this.beginOffset;
  }
  getEndOffset(): number {
    this.ensureParsed();
    return this.endOffset;
  }
  getSnapshotEntry(): SnapshotEntry {
    this.ensureParsed();
    return this.snapshotEntry!;
  }
  getEventNumber(): number {
    this.ensureParsed();
    return this.snapshotEntry!.eventNumber;
  }
  getSimulationTime(): BigDecimal {
    this.ensureParsed();
    return this.snapshotEntry!.simulationTime;
  }

  getEvent(): Event {
    if (this.event === null) this.event = this.eventLog.getEventForEventNumber(this.getSnapshotEntry().eventNumber) as Event;
    return this.event!;
  }
  getPreviousEvent(): Event | null {
    return this.getEvent().getPreviousEvent();
  }
  getNextEvent(): Event {
    return this.getEvent();
  }

  getPreviousIndex(): Index | null {
    if (this.previousIndex === null) this.previousIndex = this.eventLog.getIndex(this.getSnapshotEntry().eventNumber, MatchKind.FIRST_OR_PREVIOUS);
    return this.previousIndex;
  }
  getNextIndex(): Index | null {
    if (this.nextIndex === null) this.nextIndex = this.eventLog.getIndex(this.getSnapshotEntry().eventNumber, MatchKind.LAST_OR_NEXT);
    return this.nextIndex;
  }
  getPreviousSnapshot(): Snapshot | null {
    if (this.previousSnapshot === null) this.previousSnapshot = this.eventLog.getSnapshot(this.getSnapshotEntry().eventNumber - 1, MatchKind.FIRST_OR_PREVIOUS);
    return this.previousSnapshot;
  }
  getNextSnapshot(): Snapshot | null {
    if (this.nextSnapshot === null) this.nextSnapshot = this.eventLog.getSnapshot(this.getSnapshotEntry().eventNumber + 1, MatchKind.LAST_OR_NEXT);
    return this.nextSnapshot;
  }

  getReferenceFoundEntries(): ReferenceEntry[] {
    this.ensureParsed();
    return [...this.referenceFoundEntries];
  }

  /** Port of `Snapshot.getFoundEventLogEntries()` (returns `EventLogEntry[]`, not an `EventLogEntryCache` — see this file's header). */
  getFoundEventLogEntries(): EventLogEntry[] {
    if (this.foundEventLogEntryCache === null) {
      this.ensureParsed();
      const found: EventLogEntry[] = [];
      for (const referenceFoundEntry of this.referenceFoundEntries) {
        const event = this.eventLog.getEventForEventNumber(referenceFoundEntry.eventNumber);
        if (event !== null) for (let i = referenceFoundEntry.beginEntryIndex; i <= referenceFoundEntry.endEntryIndex; i++) found.push(event.getEventLogEntry(i));
      }
      this.foundEventLogEntryCache = found;
    }
    return this.foundEventLogEntryCache;
  }

  getNumEventLogEntries(): number {
    this.ensureParsed();
    return this.eventLogEntries.length;
  }
  getEventLogEntry(index: number): EventLogEntry {
    this.ensureParsed();
    return this.eventLogEntries[index];
  }

  private ensureParsed(): void {
    if (this.snapshotEntry === null) this.parse(this.eventLog.getFileReader());
  }
}
