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
 *
 * MANDATED DEVIATION, phase E7 ("Memory bounding" in the port plan): Java's `EventLog`
 * retains every parsed `Event` forever (`eventNumberToEventMap`/`beginOffsetToEventMap`/
 * `endOffsetToEventMap` are never trimmed) -- for a multi-GB file with tens of millions
 * of events this is exactly the leak the plan calls out as *not* to reproduce. This
 * port adds a bounded LRU over those three maps (`eventCacheLimit`, default 50_000):
 *   - `eventNumberToEventMap` changes from a `SortedMap` to a plain `Map<number, Event>`
 *     (checked: no caller ever needs floor/ceiling navigation on it, only
 *     `.get`/`.has`/`.set`/`.clear`/`.values()`) -- its insertion order doubles as LRU
 *     order: `touchCachedEvent()` bumps recency with a delete+re-set (O(1)), and the
 *     least-recently-used candidate is simply the first non-pinned key encountered
 *     iterating from the front.
 *   - the cached first/last `Event` (`this.firstEvent`/`this.lastEvent`) are always
 *     implicitly protected from eviction, and a `pinEvent()`/`unpinEvent()` API lets a
 *     host (the E8 worker) protect additional event numbers (the current viewport/row-
 *     window, the timeline coordinate system's origin, a traced event) for as long as
 *     the user is looking at them. Protecting first/last this way -- rather than
 *     rewriting event.ts's `getPreviousEvent()`/`getNextEvent()` identity checks
 *     (`eventLog.getFirstEvent() !== this`) into `getEventNumber()` comparisons --
 *     preserves the invariant those checks rely on (`getFirstEvent()`/`getLastEvent()`
 *     always return the SAME object) without touching event.ts at all; see this file's
 *     `isEventEvictable()` and event.ts's header for the two sides of this contract.
 *   - evicting an event removes it from all three maps and calls
 *     `EventBase.unlinkNeighbourEvents()` on it, so any still-cached neighbour's
 *     `previousEvent`/`nextEvent` link into the evicted event is cleared -- forcing
 *     `getPreviousEvent()`/`getNextEvent()` to lazily re-resolve (re-parsing the same
 *     bytes into a fresh `Event` object) instead of returning a dangling reference into
 *     a half-evicted chain. Eviction never mutates the evicted `Event` object itself
 *     (no `clearInternalState()`), so any reference a caller (or a chunk's
 *     `EventLogEntry.chunk` back-reference) is still holding stays a perfectly valid,
 *     just no-longer-cached, snapshot.
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
import { Event, EventBase } from './event';
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
  /**
   * Phase E7 memory bounding (see this file's header): max number of parsed `Event`
   * objects retained in `eventNumberToEventMap`/`beginOffsetToEventMap`/
   * `endOffsetToEventMap` before least-recently-used, non-pinned events are evicted.
   * Default 50_000. Pass `Infinity` to disable bounding entirely (keeps every parsed
   * event forever, matching the literal Java behavior -- useful for tests that want
   * the old unbounded semantics).
   */
  eventCacheLimit?: number;
  /**
   * Phase E8 follow-up: cap on `EventLogIndex`'s offset-search-acceleration maps
   * (`eventNumberToCacheEntryMap`/`simulationTimeToCacheEntryMap`) -- see
   * eventLogIndex.ts's `offsetCacheLimit` field doc for why a wholesale clear at this
   * limit is always safe (they are pure search caches, never a correctness source).
   * Default 1_000_000. Pass `Infinity` to disable (matches the literal unbounded Java
   * behavior).
   */
  offsetCacheLimit?: number;
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

  /**
   * All parsed events so far, bounded by an LRU (phase E7 -- see this file's header).
   * Deliberately a plain `Map`, not a `SortedMap`: no caller needs floor/ceiling
   * navigation on this particular map (checked), and a plain `Map`'s insertion order
   * IS the LRU order this cache relies on (`touchCachedEvent()` bumps recency with a
   * delete+re-set).
   */
  private eventNumberToEventMap = new Map<number, Event>();
  private beginOffsetToEventMap = new Map<number, Event | null>(); // all parsed events so far
  private endOffsetToEventMap = new Map<number, Event | null>(); // all parsed events so far

  private readonly eventCacheLimit: number;
  /** Event numbers a host (E8's worker) has asked to protect from eviction -- see this file's header. */
  private readonly pinnedEventNumbers = new Set<number>();

  private eventNumberToIndexMap = new SortedMap<number, Index>(numberCompare); // all indices are parsed at once
  private eventNumberToSnapshotMap = new SortedMap<number, Snapshot>(numberCompare); // snapshots are parsed lazily

  constructor(reader: FileReader, options: EventLogOptions = {}) {
    super(reader, options.offsetCacheLimit ?? 1_000_000);
    this.options = options;
    this.eventCacheLimit = options.eventCacheLimit ?? 50_000;
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

  // ---- phase E7: bounded parsed-event LRU + pinning API (see this file's header) ----

  /**
   * Protects `eventNumber` from eviction until `unpinEvent()` is called (or the whole
   * cache resets via an OVERWRITTEN `synchronize()`). Pinning an event number that
   * hasn't been parsed yet is harmless -- protection simply takes effect once/if that
   * event is later cached. Intended for a host (the E8 worker) to protect events the
   * user is actively looking at: the current viewport/row-window, the sequence
   * chart's timeline coordinate system origin, a traced event.
   */
  pinEvent(eventNumber: number): void {
    if (eventNumber < 0) throw new Error('EventLog.pinEvent: eventNumber must be >= 0');
    this.pinnedEventNumbers.add(eventNumber);
  }

  /** Reverses `pinEvent()`: the event becomes evictable again (if cached and not otherwise protected). */
  unpinEvent(eventNumber: number): void {
    this.pinnedEventNumbers.delete(eventNumber);
  }

  isEventPinned(eventNumber: number): boolean {
    return this.pinnedEventNumbers.has(eventNumber);
  }

  /** Number of `Event` objects currently retained -- exposed for tests/instrumentation (see this file's header). */
  getEventCacheSize(): number {
    return this.eventNumberToEventMap.size;
  }

  getEventCacheLimit(): number {
    return this.eventCacheLimit;
  }

  /**
   * True if `eventNumber` may currently be evicted: not explicitly pinned, and not the
   * cached first/last event. Protecting first/last here (rather than converting
   * event.ts's identity checks) is what keeps `Event.getPreviousEvent()`/
   * `getNextEvent()`'s `eventLog.getFirstEvent() !== this` checks correct without
   * modifying event.ts at all -- see this file's header.
   */
  private isEventEvictable(eventNumber: number): boolean {
    if (this.pinnedEventNumbers.has(eventNumber)) return false;
    if (this.firstEvent !== null && this.firstEvent.getEventNumber() === eventNumber) return false;
    if (this.lastEvent !== null && this.lastEvent.getEventNumber() === eventNumber) return false;
    return true;
  }

  /** Moves `eventNumber` to the most-recently-used end of `eventNumberToEventMap`'s iteration order (O(1): delete + re-set). */
  private touchCachedEvent(eventNumber: number, event: Event): void {
    this.eventNumberToEventMap.delete(eventNumber);
    this.eventNumberToEventMap.set(eventNumber, event);
  }

  /** `eventNumberToEventMap.get()` wrapper that also bumps recency on a hit -- use this (not a raw `.get()`) at every cache-lookup call site. */
  private lookupCachedEventByNumber(eventNumber: number): Event | undefined {
    const event = this.eventNumberToEventMap.get(eventNumber);
    if (event !== undefined) this.touchCachedEvent(eventNumber, event);
    return event;
  }

  /**
   * Evicts least-recently-used, non-pinned events until the cache is back at/under
   * `eventCacheLimit`, or gives up if every remaining cached event is protected (the
   * cache is then allowed to temporarily exceed the limit rather than evict a pinned
   * event -- pinning is a hard guarantee, the limit is a soft target).
   */
  private enforceEventCacheLimit(): void {
    while (this.eventNumberToEventMap.size > this.eventCacheLimit) {
      let victim: number | undefined;
      for (const eventNumber of this.eventNumberToEventMap.keys()) {
        if (this.isEventEvictable(eventNumber)) {
          victim = eventNumber;
          break;
        }
      }
      if (victim === undefined) break; // everything left is pinned; cannot shrink further
      this.evictCachedEvent(victim);
    }
  }

  /** Removes one event from all three caches and unlinks it from its still-cached neighbours (see this file's header). */
  private evictCachedEvent(eventNumber: number): void {
    const event = this.eventNumberToEventMap.get(eventNumber);
    if (event === undefined) return;
    this.eventNumberToEventMap.delete(eventNumber);
    this.beginOffsetToEventMap.delete(event.getBeginOffset());
    this.endOffsetToEventMap.delete(event.getEndOffset());
    EventBase.unlinkNeighbourEvents(event);
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
    if (cached !== null) {
      this.touchCachedEvent(cached.getEventNumber(), cached);
      return cached;
    }
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
    if (cached !== null) {
      this.touchCachedEvent(cached.getEventNumber(), cached);
      return cached;
    }
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
   * BEHAVIOR, not appearance") -- it is harmless: the second call just re-derives
   * `reader.synchronize(change)` (idempotent) and re-does the two field resets below
   * (also idempotent, since they're plain assignments to fixed sentinel values).
   *
   * FIX (phase E9, live-follow integration testing): the APPENDED branch below reads
   * `this.lastEvent.getEventNumber()` -- verified against
   * `omnetpp-dev/ui/.../EventLog.java`'s `eventNumberToCacheEntryMap.remove(lastEvent
   * .getEventNumber())`, i.e. it reads the event number off the still-live `lastEvent`
   * object, NOT the `lastEventNumber` *field*. That distinction matters: by this point
   * the two `super.synchronize(change)` calls above have already reset the
   * `lastEventNumber` field to the `EVENT_NOT_YET_CALCULATED` sentinel
   * (`EventLogIndex.synchronize()`'s own APPENDED branch, phase E4). The phase-E4 port
   * of this method used `this.lastEventNumber` (the already-reset field) here instead
   * -- a transcription bug that turned this into a no-op deleting the sentinel key,
   * leaving the *real* last event's now-stale offset-cache entry in place. That stale
   * entry could then make a subsequent `getEventForEventNumber()`/offset search resolve
   * the old (pre-reparse) begin/end offset for that event number, instead of falling
   * through to a fresh parse -- exactly the kind of gap phase E9 was told to look for.
   * Fixed by reading `this.lastEvent.getEventNumber()` directly (unaffected by the
   * field reset, and unaffected by the very next line's `parseLines()`, which only
   * extends the event's *end* offset, never changes its event number).
   *
   * FIX #2 (phase E9, live-follow integration testing): `lastEvent.parseLines(reader,
   * lastEvent.getEndOffset())` is Java-faithful (`Event.java`'s `parseLines()` has the
   * identical `Assert.isTrue((eventEntry == null && readEventEntry != null) ||
   * (eventEntry != null && readEventEntry == null))`), but calling it UNCONDITIONALLY
   * here throws whenever `lastEvent` had already been *cleanly* terminated by its own
   * blank-line separator before this append -- i.e. whenever the appended bytes start
   * a brand new event rather than continuing `lastEvent`'s own (previously
   * incomplete) entry list. `parseLines()` has no way to tell "clean prior boundary,
   * now starting fresh on a new event" apart from "corrupt file, an unexpected
   * mid-event `E` line" from inside its own loop -- that distinction can only be made
   * here, by peeking at the first line before deciding whether to continue parsing
   * the old event at all. This is also the overwhelmingly common live-follow case in
   * practice (an append landing between two complete events, not mid-event), so
   * skipping this check isn't a rare-edge-case gap -- it made basic append handling
   * unusable. Ported the general shape of `parseLines()`'s own `EventEntry` check
   * (`entries.ts`'s `EventEntry`, "E "-prefixed lines) for the peek.
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
            // See "FIX #2" above: only continue parsing `lastEvent` itself if the
            // first line right after its previously-known end is NOT already a fresh
            // event line (i.e. genuinely more entries were appended for THIS event,
            // not a whole new one).
            this.reader.seekTo(this.lastEvent.getEndOffset());
            const peeked = this.reader.getNextLine();
            const nextLineStartsANewEvent = peeked !== null && peeked.text.length >= 2 && peeked.text[0] === 'E' && peeked.text[1] === ' ';
            if (!nextLineStartsANewEvent) this.lastEvent.parseLines(this.reader, this.lastEvent.getEndOffset());
            // See this method's doc comment above: read the event number off the
            // `lastEvent` object itself, not the already-reset `lastEventNumber` field.
            this.eventNumberToCacheEntryMap.delete(this.lastEvent.getEventNumber());
            this.endOffsetToEventMap.delete(this.lastEvent.getEndOffset());
            this.lastEventNumber = EventNumberKind.EVENT_NOT_YET_CALCULATED;
            this.lastSimulationTime = BigDecimal.MINUS_ONE;
            this.lastEventOffset = -1;
            this.lastEvent = null;
          }
          // DEVIATION (phase E9, live-follow integration testing) from the literal Java
          // `for (Event it : eventNumberToEventMap.values()) it.synchronize(change)`:
          // `Event.synchronize()`'s APPENDED case calls the *same* `clearInternalState()`
          // as OVERWRITTEN (verified against Event.java -- not a transcription
          // difference), which nulls out `eventEntry`/`eventLogEntries`/offsets on
          // EVERY still-cached event, not just the repaired `lastEvent` above. Doing
          // that turned any subsequent access to an already-cached event (most
          // immediately: `SequenceChartFacade.synchronize()`'s own APPENDED handling,
          // which re-fetches the timeline origin event by number with `useCacheOnly:
          // true` right after this method returns) into a crash dereferencing a null
          // `eventEntry` -- neither Java's nor this port's `getEventForEventNumber()`/
          // `getEventForBeginOffset()` cache-hit paths re-parse a "hollowed" object
          // before handing it back (Java's original design has no notion of a stale-
          // but-still-cached event at all: it never mutates a *valid* cached Event in
          // place except via this exact call). An append, by definition, cannot change
          // anything about a *previously written* event's own content/offsets/level
          // nesting -- only `lastEvent` (already repaired above, since the append may
          // have continued its previously-incomplete tail) can possibly need updating.
          // So: leave every other still-cached event exactly as it is (matches E7's
          // eviction-safety invariant already documented on `evictCachedEvent()`: "any
          // reference a caller is still holding stays a perfectly valid ... snapshot"),
          // and let `parseIndicesAndSnapshots()` below discover the newly appended
          // events (which were never cached at all yet) the normal way.
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
      const cached = this.lookupCachedEventByNumber(eventNumber);
      if (cached !== undefined) return cached;
      if (useCacheOnly) return null;
      else {
        // the following two are still faster than binary searching, but this may access the disk
        const before = this.lookupCachedEventByNumber(eventNumber - 1);
        if (before !== undefined) {
          const event = before.getNextEvent();
          // the file might be filtered
          if (event === null || event.getEventNumber() !== eventNumber) return null;
          this.touchCachedEvent(eventNumber, event);
          return event;
        }
        const after = this.lookupCachedEventByNumber(eventNumber + 1);
        if (after !== undefined) {
          const event = after.getPreviousEvent();
          // the file might be filtered
          if (event === null || event.getEventNumber() !== eventNumber) return null;
          this.touchCachedEvent(eventNumber, event);
          return event;
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
    this.enforceEventCacheLimit();
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
    // OVERWRITTEN is a full reset (file content changed entirely) -- previously pinned
    // event numbers no longer mean anything meaningful, so drop them too.
    this.pinnedEventNumbers.clear();
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
