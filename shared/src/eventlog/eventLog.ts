/**
 * EventLog -- the concrete eventlog manager: parses/caches events, indices and
 * snapshots on top of EventLogIndex's offset-search engine (eventLogIndex.ts).
 * Ported from:
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/EventLog.java
 * Parse-policy source (file-size threshold + parseBegin/parseEnd budgets):
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/common/eventlog/EventLogInput.java
 *   (`new EventLog(reader)`'s constructor body IS the policy in the Java sources --
 *   `EventLogInput` merely owns/constructs the `EventLog`, it does not add any policy
 *   of its own beyond that constructor call.)
 *
 * This is phase E4 of the eventlog port plan -- the correctness heart of the whole
 * port (plan risk #1). See eventLogIndex.ts's header for the EventLogIndex rewrite
 * design (strategy-object instantiations replacing Java's `instanceof`-dispatched
 * generic code); this file is a much more direct, structural port of `EventLog.java`
 * since it has no such generic/RefObject machinery.
 *
 * DEVIATION (constructor progress/parse-policy options, `EventLogOptions` below):
 * Java's `EventLog`/`IEventLog` receive progress reporting via
 * `setProgressMonitor(IProgressMonitor)` (an Eclipse UI type, deliberately not ported
 * -- see ieventlog.ts's header) and hardcode the parse-policy thresholds (`10E+6` /
 * `1E+6` bytes) inline in the constructor. Here both become one small options object:
 * `onProgress` is the E3-designed `ProgressCallback` mechanism's actual host hook (a
 * host -- e.g. the E8 worker thread -- can throw from it to unwind a long scan, same
 * "LongRunningOperationCanceled" idiom Java uses via `IProgressMonitor`, just as a
 * thrown JS error instead of a checked exception type), and the two byte thresholds
 * are overridable so tests can exercise the "large file" parse-begin/parse-end path
 * without needing an actual multi-megabyte fixture (item 7 of this phase's test plan).
 */

import { BigDecimal } from './bigDecimal';
import { EventNumberKind, FileChange, MatchKind } from './enums';
import { EventLogEntry, parseEventLogEntry } from './eventLogEntry';
import {
  createEntry,
  IndexEntry,
  MessageDescriptionEntry,
  SimulationBeginEntry,
  SimulationEndEntry,
  SnapshotEntry,
} from './entries';
import { Event } from './event';
import { Index, Snapshot } from './chunks';
import { EventLogEntryCache } from './eventLogEntryCache';
import type { FileReader } from './fileReader';
import type { IEvent, IEventLogContext, ProgressCallback, ReadToEventLineResult } from './ieventlog';
import { SortedMap } from './sortedMap';
import { EventLogIndex } from './eventLogIndex';

const numberCompare = (a: number, b: number): number => a - b;

/** Constructor options for `EventLog` -- see this file's header for why these exist beyond the literal Java surface. */
export interface EventLogOptions {
  /**
   * Called at most once per `setProgressCallInterval()`'s interval (default 100ms,
   * matching Java's `EventLog.clearInternalState()`) while a long-running scan is in
   * progress. Port of the effect of Java's `IProgressMonitor.worked(0)` call inside
   * `EventLog.progress()`; a host can throw from this callback to cooperatively cancel
   * a long search/scan (mirrors Java's `LongRunningOperationCanceled`).
   */
  onProgress?: () => void;
  /**
   * File size (bytes) below which the whole file is eagerly parsed at construction
   * time. Port of `EventLogInput`'s `reader.getFileSize() < 10E+6` policy. Default 10e6.
   */
  smallFileThresholdBytes?: number;
  /**
   * Byte budget for each of the begin/end partial-parse passes run at construction
   * time on files at or above `smallFileThresholdBytes`. Port of `parseBegin((long)1E+6)`
   * / `parseEnd((long)1E+6)`. Default 1e6.
   */
  parseBeginEndBytes?: number;
}

/** Port of `EventLog`. */
export class EventLog extends EventLogIndex implements IEventLogContext, ProgressCallback {
  private readonly options: EventLogOptions;

  private numParsedEvents = 0;
  private approximateNumberOfEvents = -1;

  private progressCallInterval = 100;
  private lastProgressCall = -1;

  private firstEvent: Event | null = null;
  private lastEvent: Event | null = null;

  private simulationBeginEntry: SimulationBeginEntry | null = null;
  private simulationEndEntry: SimulationEndEntry | null = null;

  /** Access all eventlog entries efficiently. */
  private readonly eventLogEntryCache = new EventLogEntryCache();

  // TODO (matches a Java TODO): move to eventlog entry cache
  private readonly messageClassNames = new Set<string>(); // message class names seen so far (see Event.parse)
  private readonly messageNames = new Set<string>(); // message names seen so far (see Event.parse)

  private eventNumberToEventMap = new SortedMap<number, Event>(numberCompare); // all parsed events so far
  private beginOffsetToEventMap = new Map<number, Event | null>(); // all parsed events so far
  private endOffsetToEventMap = new Map<number, Event | null>(); // all parsed events so far

  private eventNumberToIndexMap = new SortedMap<number, Index>(numberCompare); // all indices are parsed at once
  private eventNumberToSnapshotMap = new SortedMap<number, Snapshot>(numberCompare); // snapshots are parsed lazily

  constructor(reader: FileReader, options: EventLogOptions = {}) {
    super(reader);
    this.options = options;
    // NOTE: Java's `reader.setFileLocking(true)` call is not ported here -- file
    // locking has no host-agnostic equivalent (see fileReader.ts's header).
    this.parseIndicesAndSnapshots();
    const smallFileThresholdBytes = options.smallFileThresholdBytes ?? 10e6;
    const parseBeginEndBytes = options.parseBeginEndBytes ?? 1e6;
    if (reader.getFileSize() < smallFileThresholdBytes) this.parseAll();
    else {
      this.parseBegin(parseBeginEndBytes);
      this.parseEnd(parseBeginEndBytes);
    }
  }

  getEventLogEntryCache(): EventLogEntryCache {
    return this.eventLogEntryCache;
  }

  setProgressCallInterval(seconds: number): void {
    this.progressCallInterval = seconds * 1000;
    this.lastProgressCall = Date.now();
  }

  /** Port of `EventLog.progress()`, adapted to the injectable `onProgress` hook -- see this file's header. */
  progress(): void {
    if (this.options.onProgress !== undefined && this.lastProgressCall + this.progressCallInterval < Date.now()) {
      this.options.onProgress();
      this.lastProgressCall = Date.now();
    }
  }

  /** Port of `EventLog.getEventForBeginOffset()` -- returns the event exactly starting at the given offset, or null if there is no such event. */
  getEventForBeginOffset(beginOffset: number): Event | null {
    if (beginOffset < 0) throw new Error('EventLog.getEventForBeginOffset: beginOffset must be >= 0');
    const cached = this.beginOffsetToEventMap.get(beginOffset) ?? null;
    if (cached !== null) return cached;
    if (this.reader.getFileSize() !== beginOffset) {
      const event = new Event(this);
      this.parseEvent(event, beginOffset);
      this.cacheEvent(event);
      return event;
    } else {
      this.beginOffsetToEventMap.set(beginOffset, null);
      return null;
    }
  }

  /** Port of `EventLog.getEventForEndOffset()` -- returns the event exactly ending at the given offset, or null if there is no such event. */
  getEventForEndOffset(endOffset: number): Event | null {
    if (endOffset < 0) throw new Error('EventLog.getEventForEndOffset: endOffset must be >= 0');
    const cached = this.endOffsetToEventMap.get(endOffset) ?? null;
    if (cached !== null) return cached;
    const beginOffset = this.getBeginOffsetForEndOffset(endOffset);
    if (beginOffset === -1) {
      this.endOffsetToEventMap.set(endOffset, null);
      return null;
    } else return this.getEventForBeginOffset(beginOffset);
  }

  // ---- IEventLog / IEventLogContext ----

  /**
   * Port of `EventLog.synchronize()`. NOTE: Java literally calls
   * `super.synchronize(change)` TWICE in a row here (verified against the source, not
   * a transcription artifact of this port). This is preserved verbatim ("port
   * BEHAVIOR, not appearance") -- it is harmless, not merely coincidentally: the
   * second call re-derives `reader.synchronize(change)` (idempotent) and, on APPENDED,
   * removes `lastEventNumber`/`lastSimulationTime` from the two cache maps, but
   * `EventLogIndex.synchronize()`'s own APPENDED branch already reset both fields to
   * their "not yet calculated" sentinels on the first call, so the second call's
   * `.delete()`s are guaranteed no-ops. E9 (live-follow) is expected to exercise this
   * path for real; it is implemented faithfully now per the phase plan but not
   * exhaustively tested until then.
   */
  synchronize(change: FileChange): void {
    if (change !== FileChange.UNCHANGED) {
      super.synchronize(change);
      super.synchronize(change);
      switch (change) {
        case FileChange.OVERWRITTEN:
          this.clearInternalState();
          this.parseIndicesAndSnapshots();
          break;
        case FileChange.APPENDED:
          this.approximateNumberOfEvents = -1;
          if (this.lastEvent !== null) {
            this.lastEvent.parseLines(this.reader, this.lastEvent.getEndOffset());
            // NOTE (kept verbatim from Java -- see this method's doc comment above):
            // by this point the two `super.synchronize(change)` calls above have
            // already reset `this.lastEventNumber` to the EVENT_NOT_YET_CALCULATED
            // sentinel (EventLogIndex's own APPENDED branch), so this `.delete(...)`
            // removes that sentinel key, not `this.lastEvent`'s real event number --
            // a no-op, exactly as in the Java source (`eventNumberToCacheEntryMap
            // .remove(lastEventNumber)` reads the same already-reset field). Fields
            // are `protected` on `EventLogIndex`, hence this direct subclass access.
            this.eventNumberToCacheEntryMap.delete(this.lastEventNumber);
            this.endOffsetToEventMap.delete(this.lastEvent.getEndOffset());
            this.lastEventNumber = EventNumberKind.EVENT_NOT_YET_CALCULATED;
            this.lastSimulationTime = BigDecimal.MINUS_ONE;
            this.lastEventOffset = -1;
            this.lastEvent = null;
          }
          for (const event of this.eventNumberToEventMap.values()) event.synchronize(change);
          this.parseIndicesAndSnapshots();
          break;
        default:
          throw new Error('EventLog.synchronize: unknown file change');
      }
    }
  }

  getFileReader(): FileReader {
    return this.reader;
  }

  getNumParsedEvents(): number {
    return this.numParsedEvents;
  }

  getMessageNames(): Set<string> {
    return new Set(this.messageNames);
  }
  getMessageClassNames(): Set<string> {
    return new Set(this.messageClassNames);
  }

  getSimulationBeginEntry(): SimulationBeginEntry | null {
    if (this.simulationBeginEntry === null) {
      this.reader.seekTo(0);
      const line = this.reader.getNextLine();
      if (line !== null) {
        const entry = parseEventLogEntry(createEntry, null, 0, line.startOffset, line.text);
        if (entry instanceof SimulationBeginEntry) this.simulationBeginEntry = entry;
      }
    }
    return this.simulationBeginEntry;
  }

  getSimulationEndEntry(): SimulationEndEntry | null {
    if (this.simulationEndEntry === null) {
      this.reader.seekTo(this.reader.getFileSize());
      const line = this.reader.getPreviousLine();
      if (line !== null) {
        const entry = parseEventLogEntry(createEntry, null, 0, line.startOffset, line.text);
        if (entry instanceof SimulationEndEntry) this.simulationEndEntry = entry;
      }
    }
    return this.simulationEndEntry;
  }

  getFirstEvent(): Event | null {
    if (this.firstEvent === null) {
      const offset = this.getFirstEventOffset();
      if (offset !== -1) this.firstEvent = this.getEventForBeginOffset(offset);
    }
    return this.firstEvent;
  }

  getLastEvent(): Event | null {
    if (this.lastEvent === null) {
      const offset = this.getLastEventOffset();
      if (offset !== -1) this.lastEvent = this.getEventForBeginOffset(offset);
    }
    return this.lastEvent;
  }

  getEventForEventNumber(eventNumber: number, matchKind: MatchKind = MatchKind.EXACT, useCacheOnly = false): Event | null {
    if (eventNumber < 0) throw new Error('EventLog.getEventForEventNumber: eventNumber must be >= 0');
    if (matchKind === MatchKind.EXACT) {
      const cached = this.eventNumberToEventMap.get(eventNumber);
      if (cached !== undefined) return cached;
      if (useCacheOnly) return null;
      else {
        // the following two are still faster than binary searching, but this may access the disk
        const before = this.eventNumberToEventMap.get(eventNumber - 1);
        if (before !== undefined) {
          const event = before.getNextEvent();
          // the file might be filtered
          return event !== null && event.getEventNumber() === eventNumber ? event : null;
        }
        const after = this.eventNumberToEventMap.get(eventNumber + 1);
        if (after !== undefined) {
          const event = after.getPreviousEvent();
          // the file might be filtered
          return event !== null && event.getEventNumber() === eventNumber ? event : null;
        }
      }
    }
    if (useCacheOnly) return null;
    const offset = this.getOffsetForEventNumber(eventNumber, matchKind);
    if (offset === -1) return null;
    return this.getEventForBeginOffset(offset);
  }

  getEventForSimulationTime(simulationTime: BigDecimal, matchKind: MatchKind = MatchKind.EXACT, useCacheOnly = false): Event | null {
    if (useCacheOnly) return null;
    if (!simulationTime.greaterOrEqual(BigDecimal.ZERO)) throw new Error('EventLog.getEventForSimulationTime: simulationTime must be >= 0');
    const offset = this.getOffsetForSimulationTime(simulationTime, matchKind);
    if (offset === -1) return null;
    return this.getEventForBeginOffset(offset);
  }

  /**
   * Port of `EventLog.findEventLogEntry()`. GENERALIZATION beyond the literal Java
   * (which requires a non-null `start`, per `IEventLog.java`'s signature): the E3-authored
   * `IEventLogContext`/`IEventLog` interfaces (ieventlog.ts) type `start` as
   * `EventLogEntry | null`, matching `TestEventLog`'s oracle implementation (a `null`
   * start means "search the whole log from the very beginning/end"). This adapts
   * Java's algorithm 1:1 for a real `start`, and additionally handles `start === null`
   * by seeking from offset 0 (forward) / the file's end (backward) and treating "no
   * event crossed yet" as "no event" (forward) / "the last event" (backward) --
   * the natural generalization of Java's own `eventBeginOffset == -1` fallback, which
   * uses `start.getEvent()` (forward) or `start.getEntryIndex() == 0 ? ...previousEvent
   * : ...getEvent()` (backward) for exactly the same "haven't crossed an 'E' line yet"
   * situation.
   */
  findEventLogEntry(start: EventLogEntry | null, search: string, forward: boolean, caseSensitive: boolean): EventLogEntry | null {
    if (search.length === 0) {
      if (start === null) return null;
      return forward ? start.getNextEventLogEntry() : start.getPreviousEventLogEntry();
    }
    const matchesLine = (text: string): boolean => (caseSensitive ? text.includes(search) : text.toLowerCase().includes(search.toLowerCase()));

    let eventBeginOffset = -1;
    let matchOffset = -1;
    let matchEvent: Event | null = null;

    if (forward) {
      this.reader.seekTo(start !== null ? start.getOffset() : 0);
      if (start !== null) this.reader.getNextLine(); // skip past start's own line, like Java
      let line = this.reader.getNextLine();
      while (line !== null) {
        if (line.text.length >= 2 && line.text[0] === 'E' && line.text[1] === ' ') eventBeginOffset = line.startOffset;
        if (matchesLine(line.text)) {
          const currentLineStartOffset = line.startOffset;
          const event: Event | null = eventBeginOffset === -1 ? (start !== null ? (start.getEvent() as Event | null) : null) : this.getEventForBeginOffset(eventBeginOffset);
          if (event !== null && event.getBeginOffset() <= currentLineStartOffset && currentLineStartOffset <= event.getEndOffset()) {
            matchEvent = event;
            matchOffset = currentLineStartOffset;
            break;
          }
        }
        this.progress();
        line = this.reader.getNextLine();
      }
    } else {
      this.reader.seekTo(start !== null ? start.getOffset() : this.reader.getFileSize());
      let line = this.reader.getPreviousLine();
      while (line !== null) {
        if (matchesLine(line.text)) {
          const currentLineStartOffset = line.startOffset;
          let event: Event | null;
          if (eventBeginOffset === -1) {
            if (start !== null) event = start.getEntryIndex() === 0 ? (start.getEvent() as Event).getPreviousEvent() : (start.getEvent() as Event | null);
            else event = this.getLastEvent();
          } else event = this.getEventForBeginOffset(eventBeginOffset)!.getPreviousEvent();
          if (event !== null && event.getBeginOffset() <= currentLineStartOffset && currentLineStartOffset <= event.getEndOffset()) {
            matchEvent = event;
            matchOffset = currentLineStartOffset;
            break;
          }
        }
        if (line.text.length >= 2 && line.text[0] === 'E' && line.text[1] === ' ') eventBeginOffset = line.startOffset;
        this.progress();
        line = this.reader.getPreviousLine();
      }
    }

    if (matchEvent !== null && matchOffset !== -1) {
      for (let i = 0; i < matchEvent.getNumEventLogEntries(); i++) {
        const eventLogEntry = matchEvent.getEventLogEntry(i);
        if (eventLogEntry.getOffset() === matchOffset) return eventLogEntry;
      }
    }
    return null;
  }

  getFirstIndex(): Index | null {
    const first = this.eventNumberToIndexMap.firstEntry();
    return first === undefined ? null : first.value;
  }
  getLastIndex(): Index | null {
    const last = this.eventNumberToIndexMap.lastEntry();
    return last === undefined ? null : last.value;
  }
  /**
   * Port of `EventLog.getIndex()` -- REWRITTEN from a transcription bug found in the
   * Java source (verified against the C++ original, `eventlog.cc`'s
   * `EventLog::getIndex()` -- see this file's header for the full write-up). Java's
   * literal FIRST_OR_NEXT/LAST_OR_NEXT branch used `floorEntry` -- looking *backward*
   * from `eventNumber` -- where the C++ uses `lower_bound` (forward, i.e. `ceilingEntry`);
   * it only ever returned a real "next" chunk when `eventNumber` itself happened to
   * already be an exact match, i.e. essentially never for genuine forward-navigation
   * callers like `Snapshot.getNextIndex()`/`Index.getNextSnapshot()` (chunks.ts) or
   * `Snapshot.getNextSnapshot()`/`getPreviousSnapshot()` (which pre-shift by
   * `eventNumber +- 1` specifically so that an inclusive ceiling/floor from there finds
   * a genuinely-adjacent chunk without re-finding themselves -- confirming the intended
   * semantics are the plain inclusive `ceilingEntry`/`floorEntry`, not an "always
   * strictly-different" exclusive search). Confirmed via `eventLog.test.ts`'s "finds
   * every synthesized S/I chunk" test, which failed against the literal Java
   * translation and passes with this fix.
   */
  getIndex(eventNumber: number, matchKind: MatchKind = MatchKind.EXACT): Index | null {
    switch (matchKind) {
      case MatchKind.EXACT:
        return this.eventNumberToIndexMap.get(eventNumber) ?? null;
      case MatchKind.FIRST_OR_PREVIOUS:
      case MatchKind.LAST_OR_PREVIOUS: {
        const entry = this.eventNumberToIndexMap.floorEntry(eventNumber);
        return entry === undefined ? null : entry.value;
      }
      case MatchKind.FIRST_OR_NEXT:
      case MatchKind.LAST_OR_NEXT: {
        const entry = this.eventNumberToIndexMap.ceilingEntry(eventNumber);
        return entry === undefined ? null : entry.value;
      }
      default:
        throw new Error('EventLog.getIndex: unknown match kind');
    }
  }

  getFirstSnapshot(): Snapshot | null {
    const first = this.eventNumberToSnapshotMap.firstEntry();
    return first === undefined ? null : first.value;
  }
  getLastSnapshot(): Snapshot | null {
    const last = this.eventNumberToSnapshotMap.lastEntry();
    return last === undefined ? null : last.value;
  }
  /** Port of `EventLog.getSnapshot()` -- see `getIndex()`'s doc comment for the rewrite rationale (same transcription bug, same fix, mirrored for the snapshot map). */
  getSnapshot(eventNumber: number, matchKind: MatchKind = MatchKind.EXACT): Snapshot | null {
    switch (matchKind) {
      case MatchKind.EXACT:
        return this.eventNumberToSnapshotMap.get(eventNumber) ?? null;
      case MatchKind.FIRST_OR_PREVIOUS:
      case MatchKind.LAST_OR_PREVIOUS: {
        const entry = this.eventNumberToSnapshotMap.floorEntry(eventNumber);
        return entry === undefined ? null : entry.value;
      }
      case MatchKind.FIRST_OR_NEXT:
      case MatchKind.LAST_OR_NEXT: {
        const entry = this.eventNumberToSnapshotMap.ceilingEntry(eventNumber);
        return entry === undefined ? null : entry.value;
      }
      default:
        throw new Error('EventLog.getSnapshot: unknown match kind');
    }
  }

  getApproximateNumberOfEvents(): number {
    if (this.approximateNumberOfEvents === -1) {
      let firstEvent = this.getFirstEvent();
      let lastEvent = this.getLastEvent();
      if (firstEvent === null) this.approximateNumberOfEvents = 0;
      else {
        const beginOffset = firstEvent.getBeginOffset();
        const endOffset = lastEvent!.getEndOffset();
        let sum = 0;
        let count = 0;
        const eventCount = 100;
        for (let i = 0; i < eventCount; i++) {
          if (firstEvent !== null) {
            sum += firstEvent.getEndOffset() - firstEvent.getBeginOffset();
            count++;
            firstEvent = firstEvent.getNextEvent();
          }
          if (lastEvent !== null) {
            sum += lastEvent.getEndOffset() - lastEvent.getBeginOffset();
            count++;
            lastEvent = lastEvent.getPreviousEvent();
          }
        }
        const average = sum / count;
        this.approximateNumberOfEvents = Math.trunc((endOffset - beginOffset) / average);
      }
    }
    return this.approximateNumberOfEvents;
  }

  getApproximateEventAt(percentage: number): Event | null {
    const firstEvent = this.getFirstEvent();
    const lastEvent = this.getLastEvent();
    if (firstEvent === null) return null;
    const beginOffset = firstEvent.getBeginOffset();
    const endOffset = lastEvent!.getEndOffset();
    const offset = beginOffset + Math.trunc((endOffset - beginOffset) * percentage);
    const result = this.readToEventLine(false, offset);
    const event = result.found ? this.getEventForBeginOffset(result.lineBeginOffset) : this.getFirstEvent();
    if (event === null) throw new Error('EventLog.getApproximateEventAt: expected a non-null event');
    return event;
  }

  /** Port of `EventLog.print()`, unified across Java's four `print(...)` overloads -- see ieventlog.ts's header. */
  print(fromEventNumber?: number, toEventNumber?: number, outputEventLogMessages = true): string {
    const lines: string[] = [];
    const simulationBeginEntry = this.getSimulationBeginEntry();
    if (simulationBeginEntry !== null) lines.push(simulationBeginEntry.print());
    let event = fromEventNumber === undefined ? this.getFirstEvent() : this.getEventForEventNumber(fromEventNumber, MatchKind.LAST_OR_NEXT);
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

  // ---- parsing / caching internals ----

  private parseEvent(event: Event, beginOffset: number): void {
    event.parse(this.reader, beginOffset);
    this.cacheEntry(event.getEventNumber(), event.getSimulationTime(), event.getBeginOffset(), event.getEndOffset());
    this.cacheEventLogEntries(event);
    this.numParsedEvents++;
    if (event.getEventEntry() === null) throw new Error('EventLog.parseEvent: parsed event has no EventEntry');
  }

  private cacheEvent(event: Event): void {
    const eventNumber = event.getEventNumber();
    if (this.firstEvent !== null && eventNumber < this.firstEvent.getEventNumber()) throw new Error('EventLog.cacheEvent: event number precedes the cached first event');
    if (this.lastEvent !== null && eventNumber > this.lastEvent.getEventNumber()) throw new Error('EventLog.cacheEvent: event number follows the cached last event');
    if (this.eventNumberToEventMap.has(eventNumber)) throw new Error('EventLog.cacheEvent: event number already cached');
    this.eventNumberToEventMap.set(eventNumber, event);
    this.beginOffsetToEventMap.set(event.getBeginOffset(), event);
    this.endOffsetToEventMap.set(event.getEndOffset(), event);
  }

  private cacheEventLogEntries(event: Event): void {
    for (let i = 0; i < event.getNumEventLogEntries(); i++) this.cacheEventLogEntry(event.getEventLogEntry(i));
  }

  /** Port of `EventLog.cacheEventLogEntry()` -- part of `IEventLogContext` (see ieventlog.ts). */
  cacheEventLogEntry(eventLogEntry: EventLogEntry): void {
    this.eventLogEntryCache.cacheEventLogEntry(eventLogEntry);
    // collect message description entries
    if (eventLogEntry instanceof MessageDescriptionEntry) {
      this.messageNames.add(eventLogEntry.messageName);
      this.messageClassNames.add(eventLogEntry.messageClassName);
    }
  }

  protected clearInternalState(): void {
    super.clearInternalState();
    this.numParsedEvents = 0;
    this.approximateNumberOfEvents = -1;
    this.progressCallInterval = 100;
    this.lastProgressCall = -1;
    this.firstEvent = null;
    this.lastEvent = null;
    this.messageNames.clear();
    this.messageClassNames.clear();
    this.eventLogEntryCache.clearCache();
    this.simulationBeginEntry = null;
    this.simulationEndEntry = null;
    this.eventNumberToEventMap.clear();
    this.eventNumberToIndexMap.clear();
    this.eventNumberToSnapshotMap.clear();
    this.beginOffsetToEventMap.clear();
    this.endOffsetToEventMap.clear();
  }

  /**
   * Port of `EventLog.parseIndicesAndSnapshots()`. Optimized (per Java's own comment)
   * to read indices backwards starting from the end of file; file offsets are shifted
   * to cope with truncated files (the `realFileOffset` computations below).
   */
  private parseIndicesAndSnapshots(): void {
    const snapshotFileOffsetsToSnapshotMap = new SortedMap<number, Snapshot>(numberCompare);
    this.reader.seekTo(this.reader.getFileSize());
    let line = this.reader.getPreviousLine();
    const indices: Index[] = [];
    while (line !== null) {
      const eventLogEntry = parseEventLogEntry(createEntry, null, 0, line.startOffset, line.text);
      const snapshotEntryAtLine = eventLogEntry instanceof SnapshotEntry ? eventLogEntry : null;
      const indexEntry = eventLogEntry instanceof IndexEntry ? eventLogEntry : null;
      if (indexEntry !== null) {
        // check if we already have this index
        const existing = this.eventNumberToIndexMap.get(indexEntry.eventNumber);
        if (existing !== undefined) {
          indices.push(existing);
          break;
        }
        // jump to previous snapshot entry
        let snapshot: Snapshot | null = null;
        const cachedSnapshot = snapshotFileOffsetsToSnapshotMap.get(indexEntry.previousSnapshotFileOffset);
        if (indexEntry.previousSnapshotFileOffset !== -1 && cachedSnapshot === undefined) {
          const realFileOffset = indexEntry.getOffset() - indexEntry.fileOffset + indexEntry.previousSnapshotFileOffset;
          if (realFileOffset >= 0) {
            this.reader.seekTo(realFileOffset);
            const snapshotLine = this.reader.getNextLine();
            const parsedSnapshotEntry = snapshotLine === null ? null : parseEventLogEntry(createEntry, null, 0, snapshotLine.startOffset, snapshotLine.text);
            if (!(parsedSnapshotEntry instanceof SnapshotEntry)) throw new Error('EventLog.parseIndicesAndSnapshots: expected a SnapshotEntry at the previous-snapshot file offset');
            const existingSnapshot = this.eventNumberToSnapshotMap.get(parsedSnapshotEntry.eventNumber);
            if (existingSnapshot === undefined) {
              snapshot = new Snapshot(this, snapshotLine!.startOffset);
              this.eventNumberToSnapshotMap.set(parsedSnapshotEntry.eventNumber, snapshot);
            } else snapshot = existingSnapshot;
            snapshotFileOffsetsToSnapshotMap.set(indexEntry.previousSnapshotFileOffset, snapshot);
          }
        } else if (cachedSnapshot !== undefined) snapshot = cachedSnapshot;
        // create index
        const index = new Index(this, indexEntry.getOffset(), snapshot);
        indices.push(index);
        this.eventNumberToIndexMap.set(indexEntry.eventNumber, index);
        // jump to previous index entry
        const realFileOffset = index.getBeginOffset() - indexEntry.fileOffset + indexEntry.previousIndexFileOffset;
        if (realFileOffset >= 0) {
          this.reader.seekTo(realFileOffset);
          line = this.reader.getNextLine();
        } else line = null;
      } else if (snapshotEntryAtLine !== null) {
        const snapshot = new Snapshot(this, line.startOffset);
        this.eventNumberToSnapshotMap.set(snapshotEntryAtLine.eventNumber, snapshot);
        line = this.reader.getPreviousLine();
      } else line = this.reader.getPreviousLine();
      this.progress();
    }
    for (let i = 1; i < indices.length; i++) Index.linkIndices(indices[i], indices[i - 1]);
  }

  /** Port of `EventLog.parseBegin()`. */
  private parseBegin(limit: number): void {
    const initialReadBytes = this.reader.getNumReadBytes();
    const snapshot = this.getFirstSnapshot();
    if (snapshot !== null) snapshot.getEventNumber(); // ensureParsed() via any parsing getter -- see chunks.ts
    const index = this.getFirstIndex();
    if (index !== null) index.getEventNumber();
    let event: IEvent | null = this.getFirstEvent();
    while (event !== null) {
      event = event.getNextEvent();
      if (this.reader.getNumReadBytes() - initialReadBytes > limit) break;
    }
  }

  /** Port of `EventLog.parseEnd()`. */
  private parseEnd(limit: number): void {
    const initialReadBytes = this.reader.getNumReadBytes();
    const snapshot = this.getLastSnapshot();
    if (snapshot !== null) snapshot.getEventNumber();
    const index = this.getLastIndex();
    if (index !== null) index.getEventNumber();
    let event: IEvent | null = this.getLastEvent();
    while (event !== null) {
      event = event.getPreviousEvent();
      if (this.reader.getNumReadBytes() - initialReadBytes > limit) break;
    }
  }

  /** Port of `EventLog.parseAll()`. */
  private parseAll(): void {
    let event: IEvent | null = this.getFirstEvent();
    while (event !== null) event = event.getNextEvent();
    for (const snapshot of this.eventNumberToSnapshotMap.values()) snapshot.getEventNumber();
    for (const index of this.eventNumberToIndexMap.values()) index.getEventNumber();
  }
}

// Re-exported purely so callers of `readToEventLine`'s result type (e.g. tests) don't
// need a separate import from ieventlog.ts just for this one type alias.
export type { ReadToEventLineResult };
