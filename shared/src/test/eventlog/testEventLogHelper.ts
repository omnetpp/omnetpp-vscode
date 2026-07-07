/**
 * Test-only helpers for the eventlog port's E3 suite (event.ts/chunks.ts/
 * messageDependency.ts/eventLogEntryCache.ts) — and, per the phase plan, meant to be
 * reused by E4's oracle tests once `EventLog` exists.
 *
 * `TestEventLog` is the "dumb but correct reference driver" the phase plan asked for:
 * a minimal `IEventLogContext` implementation that finds events/indices/snapshots by
 * linear/binary scanning over a `FileReader`, with none of E4's optimized indexed
 * search (`EventLogIndex.searchForOffset`, binary/linear/cache-first strategies, etc.).
 * It exists purely so E3's classes (which need *some* `IEventLogContext` to call into)
 * can be exercised against real fixture files before the real `EventLog` (E4) exists.
 */

import { BigDecimal } from '../../eventlog/bigDecimal';
import { EventLogEntry } from '../../eventlog/eventLogEntry';
import { createEntry, type SimulationBeginEntry, type SimulationEndEntry, MessageDescriptionEntry } from '../../eventlog/entries';
import { Event } from '../../eventlog/event';
import { Index, Snapshot } from '../../eventlog/chunks';
import { EventLogEntryCache } from '../../eventlog/eventLogEntryCache';
import { FileReader } from '../../eventlog/fileReader';
import { MatchKind } from '../../eventlog/enums';
import type { FileChange } from '../../eventlog/enums';
import type { IEvent, IEventLogContext, ReadToEventLineResult } from '../../eventlog/ieventlog';
import { SortedMap } from '../../eventlog/sortedMap';
import { tokenizeLine } from '../../eventlog/lineTokenizer';
import type { RandomAccessFile } from '../../fs/randomAccess';

// ---------------------------------------------------------------------------------
// FakeRandomAccessFile — an in-memory RandomAccessFile, so tests that synthesize
// eventlog content need no disk I/O. Mirrors fileReader.test.ts's fake of the same
// name (kept separate/file-local there since it predates this shared helper).
// ---------------------------------------------------------------------------------

export class FakeRandomAccessFile implements RandomAccessFile {
  readonly path = 'fake:///test.elog';
  private data: Uint8Array;
  private mtimeMs: number;

  constructor(data: Uint8Array | string, mtimeMs = 1_000_000) {
    this.data = typeof data === 'string' ? encodeLatin1(data) : data;
    this.mtimeMs = mtimeMs;
  }

  getSize(): number {
    return this.data.length;
  }
  getMtimeMs(): number {
    return this.mtimeMs;
  }
  readAt(buffer: Uint8Array, fileOffset: number): number {
    if (fileOffset >= this.data.length) return 0;
    const n = Math.min(buffer.length, this.data.length - fileOffset);
    buffer.set(this.data.subarray(fileOffset, fileOffset + n));
    return n;
  }
  close(): void {}

  setContent(data: Uint8Array | string, mtimeMs: number): void {
    this.data = typeof data === 'string' ? encodeLatin1(data) : data;
    this.mtimeMs = mtimeMs;
  }
}

function encodeLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Builds a `FileReader` directly over an in-memory string (convenience for synthesized fixtures). */
export function fileReaderForContent(content: string, bufferSize?: number): FileReader {
  return new FileReader(new FakeRandomAccessFile(content), bufferSize);
}

// ---------------------------------------------------------------------------------
// TestEventLog
// ---------------------------------------------------------------------------------

const numberCompare = (a: number, b: number): number => a - b;

interface SimTimeEntry {
  simulationTime: BigDecimal;
  eventNumber: number;
}

export class TestEventLog implements IEventLogContext {
  private readonly reader: FileReader;
  private readonly entryCache = new EventLogEntryCache();

  private readonly eventOffsetByNumber = new SortedMap<number, number>(numberCompare);
  private readonly eventNumberByOffset = new Map<number, number>();
  private readonly indexOffsetByNumber = new SortedMap<number, number>(numberCompare);
  private readonly snapshotOffsetByNumber = new SortedMap<number, number>(numberCompare);

  private readonly eventsByNumber = new Map<number, Event>();
  private readonly indicesByOffset = new Map<number, Index>();
  private readonly snapshotsByOffset = new Map<number, Snapshot>();

  private simulationBeginEntry: SimulationBeginEntry | null = null;
  private simulationEndEntry: SimulationEndEntry | null = null;
  private simTimeIndex: SimTimeEntry[] | null = null;

  progressCount = 0;

  constructor(reader: FileReader) {
    this.reader = reader;
    this.scanChunkOffsets();
    this.buildChunkChain();
  }

  // ---- scanning (the "dumb" part: one forward pass tokenizing only chunk-header lines) ----

  private scanChunkOffsets(): void {
    this.reader.seekTo(0);
    while (true) {
      const line = this.reader.getNextLine();
      if (line === null) break;
      if (line.text.startsWith('E ')) {
        const eventNumber = readIntTokenFromLine(line.text, '#');
        this.eventOffsetByNumber.set(eventNumber, line.startOffset);
        this.eventNumberByOffset.set(line.startOffset, eventNumber);
      } else if (line.text.startsWith('I ')) {
        this.indexOffsetByNumber.set(readIntTokenFromLine(line.text, '#'), line.startOffset);
      } else if (line.text.startsWith('S ')) {
        this.snapshotOffsetByNumber.set(readIntTokenFromLine(line.text, '#'), line.startOffset);
      } else if (line.text.startsWith('SB ')) {
        const entry = createEntry('SB')!;
        entry.parse(tokenizeLine(line.text));
        this.simulationBeginEntry = entry as SimulationBeginEntry;
      } else if (line.text.startsWith('SE ')) {
        const entry = createEntry('SE')!;
        entry.parse(tokenizeLine(line.text));
        this.simulationEndEntry = entry as SimulationEndEntry;
      }
    }
  }

  /** Builds the Index/Snapshot doubly-linked chain eagerly (fine at test-fixture scale; E4 does this incrementally). */
  private buildChunkChain(): void {
    type Ref = { kind: 'I' | 'S'; beginOffset: number };
    const refs: Ref[] = [];
    for (const e of this.indexOffsetByNumber) refs.push({ kind: 'I', beginOffset: e.value });
    for (const e of this.snapshotOffsetByNumber) refs.push({ kind: 'S', beginOffset: e.value });
    refs.sort((a, b) => a.beginOffset - b.beginOffset);

    let lastSnapshot: Snapshot | null = null;
    let lastIndex: Index | null = null;
    for (const ref of refs) {
      if (ref.kind === 'S') {
        const snapshot = new Snapshot(this, ref.beginOffset);
        snapshot.previousSnapshot = lastSnapshot;
        if (lastSnapshot !== null) lastSnapshot.nextSnapshot = snapshot;
        this.snapshotsByOffset.set(ref.beginOffset, snapshot);
        lastSnapshot = snapshot;
      } else {
        const index = new Index(this, ref.beginOffset, lastSnapshot);
        if (lastIndex !== null) Index.linkIndices(lastIndex, index);
        this.indicesByOffset.set(ref.beginOffset, index);
        lastIndex = index;
      }
    }
  }

  /** Port of `EventLog.parseEvent()` + `cacheEventLogEntries()`: parsing an event for the
   * first time also feeds every one of its entries into the shared `EventLogEntryCache`
   * (this is how `IEvent.getModuleDescriptionEntry()` etc. ever find anything — Java's
   * concrete `EventLog` does this as part of forward-parsing/index-building, which this
   * dumb driver otherwise has no equivalent of). */
  private parseAndCacheEvent(eventNumber: number, beginOffset: number): Event {
    const cached = this.eventsByNumber.get(eventNumber);
    if (cached !== undefined) return cached;
    const event = new Event(this);
    event.parse(this.reader, beginOffset);
    for (let i = 0; i < event.getNumEventLogEntries(); i++) this.cacheEventLogEntry(event.getEventLogEntry(i));
    this.eventsByNumber.set(eventNumber, event);
    return event;
  }

  private buildSimTimeIndexIfNeeded(): SimTimeEntry[] {
    if (this.simTimeIndex === null) {
      const list: SimTimeEntry[] = [];
      for (const { key: eventNumber } of this.eventOffsetByNumber) {
        const event = this.getEventForEventNumber(eventNumber)!;
        list.push({ simulationTime: event.getSimulationTime(), eventNumber });
      }
      list.sort((a, b) => a.simulationTime.compareTo(b.simulationTime) || a.eventNumber - b.eventNumber);
      this.simTimeIndex = list;
    }
    return this.simTimeIndex;
  }

  // ---- IEventLogContext ----

  getFileReader(): FileReader {
    return this.reader;
  }
  getEventLogEntryCache(): EventLogEntryCache {
    return this.entryCache;
  }
  cacheEventLogEntry(eventLogEntry: EventLogEntry): void {
    this.entryCache.cacheEventLogEntry(eventLogEntry);
  }

  progress(): void {
    this.progressCount++;
  }
  setProgressCallInterval(_seconds: number): void {
    // not modeled by this dumb driver
  }

  getNumParsedEvents(): number {
    return this.eventsByNumber.size;
  }
  getMessageNames(): Set<string> {
    const names = new Set<string>();
    this.forEachEntry((entry) => {
      if (entry instanceof MessageDescriptionEntry) names.add(entry.messageName);
    });
    return names;
  }
  getMessageClassNames(): Set<string> {
    const names = new Set<string>();
    this.forEachEntry((entry) => {
      if (entry instanceof MessageDescriptionEntry) names.add(entry.messageClassName);
    });
    return names;
  }
  private forEachEntry(fn: (entry: EventLogEntry) => void): void {
    for (const { key: eventNumber } of this.eventOffsetByNumber) {
      const event = this.getEventForEventNumber(eventNumber)!;
      for (let i = 0; i < event.getNumEventLogEntries(); i++) fn(event.getEventLogEntry(i));
    }
  }

  getSimulationBeginEntry(): SimulationBeginEntry | null {
    return this.simulationBeginEntry;
  }
  getSimulationEndEntry(): SimulationEndEntry | null {
    return this.simulationEndEntry;
  }

  isEmpty(): boolean {
    return this.eventOffsetByNumber.size === 0;
  }

  getFirstEventNumber(): number {
    return this.eventOffsetByNumber.firstEntry()?.key ?? -1;
  }
  getFirstSimulationTime(): BigDecimal {
    return this.getFirstEvent()?.getSimulationTime() ?? BigDecimal.ZERO;
  }
  getFirstEvent(): Event | null {
    const first = this.eventOffsetByNumber.firstEntry();
    return first === undefined ? null : this.parseAndCacheEvent(first.key, first.value);
  }

  getLastSimulationTime(): BigDecimal {
    return this.getLastEvent()?.getSimulationTime() ?? BigDecimal.ZERO;
  }
  getLastEventNumber(): number {
    return this.eventOffsetByNumber.lastEntry()?.key ?? -1;
  }
  getLastEvent(): Event | null {
    const last = this.eventOffsetByNumber.lastEntry();
    return last === undefined ? null : this.parseAndCacheEvent(last.key, last.value);
  }

  getEventForBeginOffset(beginOffset: number): Event | null {
    const eventNumber = this.eventNumberByOffset.get(beginOffset);
    if (eventNumber === undefined) return null;
    return this.parseAndCacheEvent(eventNumber, beginOffset);
  }

  getEventForEventNumber(eventNumber: number, matchKind: MatchKind = MatchKind.EXACT): Event | null {
    // Event numbers are unique and densely searchable, so FIRST_OR_* / LAST_OR_* only
    // differ from a plain floor/ceiling lookup when there can be multiple matches for
    // one key (never true here) -- see this file's header (dumb-but-correct driver).
    const entry = resolveByMatchKind(this.eventOffsetByNumber, eventNumber, matchKind);
    return entry === undefined ? null : this.parseAndCacheEvent(entry.key, entry.value);
  }

  getEventForSimulationTime(simulationTime: BigDecimal, matchKind: MatchKind = MatchKind.EXACT): Event | null {
    const list = this.buildSimTimeIndexIfNeeded();
    const matches = list.filter((e) => e.simulationTime.equals(simulationTime));
    switch (matchKind) {
      case MatchKind.EXACT:
        return matches.length === 1 ? this.getEventForEventNumber(matches[0].eventNumber) : null;
      case MatchKind.FIRST_OR_PREVIOUS:
      case MatchKind.LAST_OR_PREVIOUS: {
        const chosen = matchKind === MatchKind.FIRST_OR_PREVIOUS ? matches[0] : matches[matches.length - 1];
        if (chosen !== undefined) return this.getEventForEventNumber(chosen.eventNumber);
        let prev: SimTimeEntry | undefined;
        for (const e of list) if (e.simulationTime.less(simulationTime)) prev = e;
        return prev !== undefined ? this.getEventForEventNumber(prev.eventNumber) : null;
      }
      case MatchKind.FIRST_OR_NEXT:
      case MatchKind.LAST_OR_NEXT: {
        const chosen = matchKind === MatchKind.FIRST_OR_NEXT ? matches[0] : matches[matches.length - 1];
        if (chosen !== undefined) return this.getEventForEventNumber(chosen.eventNumber);
        const next = list.find((e) => e.simulationTime.greater(simulationTime));
        return next !== undefined ? this.getEventForEventNumber(next.eventNumber) : null;
      }
    }
  }

  findEventLogEntry(start: EventLogEntry | null, search: string, forward: boolean, caseSensitive: boolean): EventLogEntry | null {
    const needle = caseSensitive ? search : search.toLowerCase();
    const matches = (entry: EventLogEntry): boolean => {
      const text = entry.print();
      return (caseSensitive ? text : text.toLowerCase()).includes(needle);
    };
    // Linear scan in event-number order (dumb but correct); `start` (if given) is skipped past.
    const all: EventLogEntry[] = [];
    this.forEachEntry((entry) => all.push(entry));
    const ordered = forward ? all : [...all].reverse();
    let skipping = start !== null;
    for (const entry of ordered) {
      if (skipping) {
        if (entry === start) skipping = false;
        continue;
      }
      if (matches(entry)) return entry;
    }
    return null;
  }

  getFirstIndex(): Index | null {
    const first = this.indexOffsetByNumber.firstEntry();
    return first === undefined ? null : this.indicesByOffset.get(first.value)!;
  }
  getLastIndex(): Index | null {
    const last = this.indexOffsetByNumber.lastEntry();
    return last === undefined ? null : this.indicesByOffset.get(last.value)!;
  }
  getIndex(eventNumber: number, matchKind: MatchKind = MatchKind.EXACT): Index | null {
    const entry = resolveByMatchKind(this.indexOffsetByNumber, eventNumber, matchKind);
    return entry === undefined ? null : this.indicesByOffset.get(entry.value)!;
  }

  getFirstSnapshot(): Snapshot | null {
    const first = this.snapshotOffsetByNumber.firstEntry();
    return first === undefined ? null : this.snapshotsByOffset.get(first.value)!;
  }
  getLastSnapshot(): Snapshot | null {
    const last = this.snapshotOffsetByNumber.lastEntry();
    return last === undefined ? null : this.snapshotsByOffset.get(last.value)!;
  }
  getSnapshot(eventNumber: number, matchKind: MatchKind = MatchKind.EXACT): Snapshot | null {
    const entry = resolveByMatchKind(this.snapshotOffsetByNumber, eventNumber, matchKind);
    return entry === undefined ? null : this.snapshotsByOffset.get(entry.value)!;
  }

  getApproximateNumberOfEvents(): number {
    return this.eventOffsetByNumber.size;
  }
  getApproximateEventAt(percentage: number): Event | null {
    const entries = [...this.eventOffsetByNumber];
    if (entries.length === 0) return null;
    const index = Math.min(entries.length - 1, Math.max(0, Math.floor(percentage * entries.length)));
    return this.parseAndCacheEvent(entries[index].key, entries[index].value);
  }
  getApproximatePercentageForEventNumber(eventNumber: number): number {
    const entries = [...this.eventOffsetByNumber.keys()];
    const index = entries.indexOf(eventNumber);
    return entries.length === 0 || index < 0 ? 0 : index / entries.length;
  }

  print(fromEventNumber?: number, toEventNumber?: number, outputEventLogMessages = true): string {
    const lines: string[] = [];
    for (const { key: eventNumber } of this.eventOffsetByNumber) {
      if (fromEventNumber !== undefined && eventNumber < fromEventNumber) continue;
      if (toEventNumber !== undefined && eventNumber > toEventNumber) continue;
      lines.push(this.getEventForEventNumber(eventNumber)!.print(outputEventLogMessages));
    }
    return lines.join('\n\n');
  }

  getNeighbourEvent(event: IEvent, distance: number): Event | null {
    let current: Event | null = this.getEventForEventNumber(event.getEventNumber());
    let remaining = distance;
    while (current !== null && remaining !== 0) {
      current = remaining > 0 ? current.getNextEvent() : current.getPreviousEvent();
      remaining += remaining > 0 ? -1 : 1;
    }
    return current;
  }

  isIncludedInLog(eventNumber: number): boolean {
    return this.eventOffsetByNumber.has(eventNumber);
  }

  getFirstEventNotBeforeEventNumber(eventNumber: number): Event | null {
    const entry = this.eventOffsetByNumber.ceilingEntry(eventNumber);
    return entry === undefined ? null : this.parseAndCacheEvent(entry.key, entry.value);
  }
  getLastEventNotAfterEventNumber(eventNumber: number): Event | null {
    const entry = this.eventOffsetByNumber.floorEntry(eventNumber);
    return entry === undefined ? null : this.parseAndCacheEvent(entry.key, entry.value);
  }
  getFirstEventNotBeforeSimulationTime(simulationTime: BigDecimal): Event | null {
    const list = this.buildSimTimeIndexIfNeeded();
    const found = list.find((e) => e.simulationTime.greaterOrEqual(simulationTime));
    return found === undefined ? null : this.getEventForEventNumber(found.eventNumber);
  }
  getLastEventNotAfterSimulationTime(simulationTime: BigDecimal): Event | null {
    const list = this.buildSimTimeIndexIfNeeded();
    let found: SimTimeEntry | undefined;
    for (const e of list) if (e.simulationTime.lessOrEqual(simulationTime)) found = e;
    return found === undefined ? null : this.getEventForEventNumber(found.eventNumber);
  }

  /** Port-plan-faithful shape (`ReadToEventLineResult`); see ieventlog.ts. */
  readToEventLine(forward: boolean, readStartOffset: number): ReadToEventLineResult {
    this.reader.seekTo(readStartOffset);
    while (true) {
      const line = forward ? this.reader.getNextLine() : this.reader.getPreviousLine();
      if (line === null) return { found: false, eventNumber: -1, simulationTime: BigDecimal.MINUS_ONE, lineBeginOffset: -1, lineEndOffset: -1 };
      if (line.text.length >= 2 && line.text[0] === 'E' && line.text[1] === ' ') {
        const tokens = tokenizeLine(line.text);
        let eventNumber = -1;
        let simulationTime = BigDecimal.MINUS_ONE;
        for (let i = 1; i + 1 < tokens.length; i += 2) {
          const token = tokens[i];
          if (token.length !== 1) continue;
          if (token === '#') eventNumber = EventLogEntry.parseEventNumber(tokens[i + 1]);
          else if (token === 't') simulationTime = EventLogEntry.parseSimulationTime(tokens[i + 1]);
        }
        return { found: true, eventNumber, simulationTime, lineBeginOffset: line.startOffset, lineEndOffset: line.endOffset };
      }
    }
  }

  synchronize(_change: FileChange): void {
    // Not exercised by the E3 suite (fixtures are static); E9's live-follow tests
    // reuse this driver's *parsing*, not this method, so a no-op is enough for now.
  }
}

function resolveByMatchKind<V>(map: SortedMap<number, V>, key: number, matchKind: MatchKind): { key: number; value: V } | undefined {
  switch (matchKind) {
    case MatchKind.EXACT: {
      const entry = map.floorEntry(key);
      return entry !== undefined && entry.key === key ? entry : undefined;
    }
    case MatchKind.FIRST_OR_PREVIOUS:
    case MatchKind.LAST_OR_PREVIOUS:
      return map.floorEntry(key);
    case MatchKind.FIRST_OR_NEXT:
    case MatchKind.LAST_OR_NEXT:
      return map.ceilingEntry(key);
  }
}

/** Reads the value following a single-char shorthand key token out of a raw (not-yet-fully-tokenized) chunk-header line, without constructing a full entry object -- used only to discover chunk offsets during the initial scan. */
function readIntTokenFromLine(line: string, sign: string): number {
  const tokens = tokenizeLine(line);
  for (let i = 1; i < tokens.length; i += 2) {
    if (tokens[i] === sign) return Number(tokens[i + 1]);
  }
  throw new Error(`TestEventLog: missing token '${sign}' in chunk header line: ${line}`);
}
