/**
 * EventLogBase + EventLogIndex: the eventlog manager's random-access search engine.
 * Ported from:
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/EventLogBase.java
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/EventLogIndex.java
 * (C++ original consulted where the Java looked machine-translated/garbled:
 *   omnetpp-dev/src/eventlog/eventlogindex.cc)
 *
 * `EventLog` (eventLog.ts) is the concrete class completing this hierarchy: it adds
 * event/index/snapshot parsing and caching on top of the offset-search machinery here.
 *
 * REWRITE, NOT TRANSLITERATION (port plan risk #1): `EventLogIndex.java` is
 * machine-translated C++ -- every generic method (`searchForOffset`/
 * `cacheSearchForOffset`/`binarySearchForOffset`/`linearSearchForOffset`) is written
 * once with `<T extends Comparable>` and dispatches internally on `key instanceof Long`
 * vs `key instanceof BigDecimal`, threading five `RefObject<T>` out-parameters through
 * three call levels. This port keeps the exact same control flow and BEHAVIOR (the plan
 * mandates this: "port BEHAVIOR, not appearance") but as two typed instantiations
 * sharing one generic core via a small strategy object (`KeySearchStrategy<T>`, below)
 * instead of runtime `instanceof` dispatch, and returns plain result objects instead of
 * mutating `RefObject` out-parameters -- both are mechanical, meaning-preserving
 * translations of the identical algorithm, verified against a brute-force oracle (see
 * shared/src/test/eventlog/eventLogIndex.test.ts) across all 5 `MatchKind`s and
 * duplicate-simulation-time runs.
 *
 * The two instantiations:
 *   - `eventNumberKeyStrategy` (`KeySearchStrategy<number>`): event numbers are unique,
 *     so an exact cache hit is unconditionally the answer (`uniqueExactMatch: true`,
 *     port of Java's `key instanceof Long` branch in `cacheSearchForOffset`/
 *     `searchForOffset`'s duplicate check).
 *   - `simulationTimeKeyStrategy` (`KeySearchStrategy<BigDecimal>`): many events can
 *     share a simulation time, so an exact cache hit must still check whether the
 *     cached range is "complete" on the begin/end side before it can be trusted
 *     (`uniqueExactMatch: false`, port of the `else` / `BigDecimal` branch, including
 *     the `completeBegin`/`completeEnd` logic that is the classic duplicate-simtime
 *     transcription-bug trap the port plan calls out).
 *
 * `readToEventLine()` (declared here as the package-private half of `IEventLogContext`,
 * ieventlog.ts) is intentionally left abstract at this layer: it both scans for and
 * *caches* ("E" line offset/eventNumber/simulationTime) whatever it reads, and the
 * caching hook (`cacheEntry()`) is concrete here, but the actual file-format knowledge
 * (tokenizing an "E " line) is shared with `Event.parseLines()`'s entry parsing --
 * kept concrete here (not deferred to `EventLog`) since Java's version lives on
 * `EventLogIndex`, not `EventLog`.
 */

import { BigDecimal } from './bigDecimal';
import { EventLogEntry } from './eventLogEntry';
import { EventNumberKind, FileChange, MatchKind } from './enums';
import type { FileReader } from './fileReader';
import { SortedMap } from './sortedMap';
import { tokenizeLine } from './lineTokenizer';
import type { IEvent, ReadToEventLineResult } from './ieventlog';
import type { Index, Snapshot } from './chunks';
import type { SimulationBeginEntry, SimulationEndEntry } from './entries';

const numberCompare = (a: number, b: number): number => a - b;
const bigDecimalCompare = (a: BigDecimal, b: BigDecimal): number => a.compareTo(b);

// ---------------------------------------------------------------------------------
// EventLogBase
// ---------------------------------------------------------------------------------

/** Port of `EventLogBase`. */
export abstract class EventLogBase {
  /** Remembers the last IEvent returned by getNeighbourEvent so that subsequent calls might return much faster. */
  protected lastNeighbourEventNumber = -1;
  protected lastNeighbourEvent: IEvent | null = null;

  /** Port of `EventLogBase.synchronize()`. (Not actually reached through the real
   * `EventLogIndex`/`EventLog` override chain -- see eventLogIndex.test.ts's note --
   * but kept for fidelity, exactly as Java declares it.) */
  synchronize(change: FileChange): void {
    if (change !== FileChange.UNCHANGED) {
      switch (change) {
        case FileChange.OVERWRITTEN:
        case FileChange.APPENDED:
          this.clearInternalState();
          break;
        default:
          throw new Error('EventLogBase.synchronize: unknown file change');
      }
    }
  }

  abstract getSimulationBeginEntry(): SimulationBeginEntry | null;
  abstract getSimulationEndEntry(): SimulationEndEntry | null;

  isEmpty(): boolean {
    return this.getFirstEvent() === null;
  }

  abstract getFirstEvent(): IEvent | null;
  abstract getLastEvent(): IEvent | null;

  abstract getEventForEventNumber(eventNumber: number, matchKind?: MatchKind, useCacheOnly?: boolean): IEvent | null;
  abstract getEventForSimulationTime(simulationTime: BigDecimal, matchKind?: MatchKind, useCacheOnly?: boolean): IEvent | null;

  abstract getIndex(eventNumber: number, matchKind?: MatchKind): Index | null;
  abstract getSnapshot(eventNumber: number, matchKind?: MatchKind): Snapshot | null;

  /** Port of `EventLogBase.getNeighbourEvent()`. */
  getNeighbourEvent(event: IEvent, distance: number): IEvent | null {
    const neighbourEventNumber = event.getEventNumber() + distance;
    if (this.lastNeighbourEvent !== null && this.lastNeighbourEventNumber !== -1 && Math.abs(neighbourEventNumber - this.lastNeighbourEventNumber) < Math.abs(distance))
      return this.getNeighbourEvent(this.lastNeighbourEvent, neighbourEventNumber - this.lastNeighbourEventNumber);
    let current: IEvent | null = event;
    let remaining = distance;
    while (current !== null && remaining !== 0) {
      if (remaining > 0) {
        remaining--;
        current = current.getNextEvent();
      } else {
        remaining++;
        current = current.getPreviousEvent();
      }
    }
    this.lastNeighbourEventNumber = neighbourEventNumber;
    this.lastNeighbourEvent = current;
    return this.lastNeighbourEvent;
  }

  isIncludedInLog(eventNumber: number): boolean {
    return this.getEventForEventNumber(eventNumber) !== null;
  }

  /** Port of `getFirstEventNotBeforeEventNumber()` -- event numbers are unique, so the
   * FIRST_OR_.../LAST_OR_... tie-break choice below is irrelevant in practice (there is
   * never more than one match), but the literal Java wiring is kept for fidelity. */
  getFirstEventNotBeforeEventNumber(eventNumber: number): IEvent | null {
    return this.getEventForEventNumber(eventNumber, MatchKind.LAST_OR_NEXT);
  }
  getLastEventNotAfterEventNumber(eventNumber: number): IEvent | null {
    return this.getEventForEventNumber(eventNumber, MatchKind.FIRST_OR_PREVIOUS);
  }
  /** Port of `getFirstEventNotBeforeSimulationTime()`. NOTE (see this file's header
   * and eventLogIndex.test.ts): Java wires this to LAST_OR_NEXT, which -- per the
   * actual `searchForOffset`/`linearSearchForOffset` tie-breaking algorithm (verified
   * by tracing it, not just reading the enum's doc comment) -- lands on the LAST event
   * of a duplicate-simulation-time run, not the first, when `simulationTime` falls
   * exactly on one. Counterintuitive given the method's name, but this is what the
   * Java source literally does, so it is ported verbatim ("port BEHAVIOR, not
   * appearance"). Do not "fix" this to FIRST_OR_NEXT without re-deriving the tie
   * behavior from `searchForOffset` first. */
  getFirstEventNotBeforeSimulationTime(simulationTime: BigDecimal): IEvent | null {
    return this.getEventForSimulationTime(simulationTime, MatchKind.LAST_OR_NEXT);
  }
  /** Port of `getLastEventNotAfterSimulationTime()` -- see `getFirstEventNotBeforeSimulationTime()`'s note (mirror-image quirk: lands on the FIRST of a tied run). */
  getLastEventNotAfterSimulationTime(simulationTime: BigDecimal): IEvent | null {
    return this.getEventForSimulationTime(simulationTime, MatchKind.FIRST_OR_PREVIOUS);
  }

  /** Port of `EventLogBase.getApproximatePercentageForEventNumber()`. */
  getApproximatePercentageForEventNumber(eventNumber: number): number {
    const firstEvent = this.getFirstEvent();
    const lastEvent = this.getLastEvent();
    const event = this.getEventForEventNumber(eventNumber);
    if (firstEvent === null || firstEvent === lastEvent) return 0.0;
    else if (event === null) return 0.5;
    else {
      const beginOffset = firstEvent.getBeginOffset();
      const endOffset = lastEvent!.getBeginOffset();
      const percentage = (event.getBeginOffset() - beginOffset) / (endOffset - beginOffset);
      if (!(percentage >= 0.0 && percentage <= 1.0)) throw new Error('EventLogBase.getApproximatePercentageForEventNumber: percentage out of range');
      return percentage;
    }
  }

  protected clearInternalState(): void {
    this.lastNeighbourEventNumber = -1;
    this.lastNeighbourEvent = null;
  }
}

// ---------------------------------------------------------------------------------
// KeySearchStrategy -- the E4 rewrite's strategy object (see this file's header).
// ---------------------------------------------------------------------------------

/**
 * One `CacheEntry` describes a (possibly still-growing) range of consecutive-in-file
 * events sharing one simulation time -- port of `EventLogIndex.CacheEntry`. Kept as a
 * single concrete class (not generic): every field it stores is meaningful for *both*
 * key kinds simultaneously (an event-number cache entry still has a `simulationTime`,
 * a simtime cache entry still has begin/end event numbers) -- only the *key extracted
 * from it* differs per search kind, which is exactly what `KeySearchStrategy`'s
 * `beginKeyOf`/`endKeyOf` abstract over (port of `CacheEntry.getBeginKey()`/
 * `getEndKey()`'s `key instanceof Long/BigDecimal` dispatch).
 */
class CacheEntry {
  simulationTime: BigDecimal;
  beginEventNumber: number; // begin event with this simulation time
  endEventNumber: number; // end event with this simulation time
  beginOffset: number; // begin offset of begin event
  endEventBeginOffset: number; // begin offset of end event
  endOffset: number; // end offset of end event

  constructor(eventNumber: number, simulationTime: BigDecimal, beginOffset: number, endOffset: number) {
    this.simulationTime = simulationTime;
    this.beginEventNumber = eventNumber;
    this.endEventNumber = eventNumber;
    this.beginOffset = beginOffset;
    this.endEventBeginOffset = beginOffset;
    this.endOffset = endOffset;
  }

  /** Port of `CacheEntry.include()`. */
  include(eventNumber: number, simulationTime: BigDecimal, beginOffset: number, endOffset: number): void {
    if (!this.simulationTime.equals(simulationTime)) throw new Error('CacheEntry.include: simulation time mismatch');
    this.beginEventNumber = Math.min(this.beginEventNumber, eventNumber);
    this.endEventNumber = Math.max(this.endEventNumber, eventNumber);
    this.beginOffset = Math.min(this.beginOffset, beginOffset);
    this.endEventBeginOffset = Math.max(this.endEventBeginOffset, beginOffset);
    this.endOffset = Math.max(this.endOffset, endOffset);
  }
}

/** The E4 rewrite's strategy object: one per key kind (event number / simulation time). See this file's header. */
interface KeySearchStrategy<T> {
  /** True for event numbers (unique -> an exact cache hit is unconditionally the
   * answer); false for simulation times (many events can share one -> an exact cache
   * hit must still be checked for begin/end "completeness" -- port of `key instanceof
   * Long` vs the `else` branch throughout `EventLogIndex`). */
  readonly uniqueExactMatch: boolean;
  compare(a: T, b: T): number;
  equals(a: T, b: T): boolean;
  /** Port of the private `EventLogIndex.getKey()` overload matching this key kind. */
  keyOf(eventNumber: number, simulationTime: BigDecimal): T;
  /** Port of `CacheEntry.getBeginKey()` for this key kind. */
  beginKeyOf(entry: CacheEntry): T;
  /** Port of `CacheEntry.getEndKey()` for this key kind. */
  endKeyOf(entry: CacheEntry): T;
}

const eventNumberKeyStrategy: KeySearchStrategy<number> = {
  uniqueExactMatch: true,
  compare: numberCompare,
  equals: (a, b) => a === b,
  keyOf: (eventNumber) => eventNumber,
  beginKeyOf: (entry) => entry.beginEventNumber,
  endKeyOf: (entry) => entry.endEventNumber,
};

const simulationTimeKeyStrategy: KeySearchStrategy<BigDecimal> = {
  uniqueExactMatch: false,
  compare: bigDecimalCompare,
  equals: (a, b) => a.equals(b),
  keyOf: (_eventNumber, simulationTime) => simulationTime,
  beginKeyOf: (entry) => entry.simulationTime,
  endKeyOf: (entry) => entry.simulationTime,
};

/** Result shape for `cacheSearchForOffset()`/`binarySearchForOffset()` -- plain return
 * values replacing Java's `RefObject<T>` out-parameters (see this file's header). */
interface CacheSearchResult<T> {
  found: boolean;
  lowerKey: T;
  upperKey: T;
  foundOffset: number;
  lowerOffset: number;
  upperOffset: number;
}

// ---------------------------------------------------------------------------------
// EventLogIndex
// ---------------------------------------------------------------------------------

/** Port of `EventLogIndex`. */
export abstract class EventLogIndex extends EventLogBase {
  protected reader: FileReader;

  protected firstEventOffset = -1;
  protected lastEventOffset = -1;
  protected firstEventNumber: number = EventNumberKind.EVENT_NOT_YET_CALCULATED;
  protected lastEventNumber: number = EventNumberKind.EVENT_NOT_YET_CALCULATED;
  protected firstSimulationTime: BigDecimal = BigDecimal.MINUS_ONE;
  protected lastSimulationTime: BigDecimal = BigDecimal.MINUS_ONE;

  /** Subsequent events in an eventlog file may not have subsequent event numbers, therefore it is insufficient to store the file offset only in the cache. */
  protected eventNumberToCacheEntryMap = new SortedMap<number, CacheEntry>(numberCompare);
  /** Subsequent events in an eventlog file may have the same simulation time, therefore it is insufficient to store the file offset only in the cache. */
  protected simulationTimeToCacheEntryMap = new SortedMap<BigDecimal, CacheEntry>(bigDecimalCompare);

  /**
   * Phase E8 follow-up (memoryBounding.test.ts's stress test flagged this as the
   * residual unbounded grower once the E7 Event-object cache was capped):
   * `eventNumberToCacheEntryMap`/`simulationTimeToCacheEntryMap` are pure
   * search-acceleration caches (see `searchForOffset()`'s header) -- unlike the E7
   * Event/FilteredEvent/coordinate caches, losing an entry never changes a result,
   * only how many bytes must be re-scanned to re-derive it. That makes a wholesale
   * clear (rather than a real per-entry LRU) always safe here: simplest possible fix
   * for what is, in the worst case (a linear full-file scan), an unbounded grower.
   * Default 1_000_000 (comfortably above realistic viewport/random-access working
   * sets); `Infinity` restores the literal unbounded Java behavior for tests that want
   * it (e.g. the eventLogIndex.test.ts oracle suite already exercises this
   * unboundedly).
   */
  protected offsetCacheLimit: number;

  constructor(reader: FileReader, offsetCacheLimit = 1_000_000) {
    super();
    this.reader = reader;
    this.offsetCacheLimit = offsetCacheLimit;
  }

  /** Port of `EventLogIndex.cacheEntry()`. */
  protected cacheEntry(eventNumber: number, simulationTime: BigDecimal, beginOffset: number, endOffset: number): void {
    // wholesale clear before inserting once either map is at capacity -- see this
    // field's doc comment above for why a full clear (not a per-entry LRU) is safe.
    if (this.eventNumberToCacheEntryMap.size >= this.offsetCacheLimit || this.simulationTimeToCacheEntryMap.size >= this.offsetCacheLimit) {
      this.eventNumberToCacheEntryMap.clear();
      this.simulationTimeToCacheEntryMap.clear();
    }

    const eventNumberCacheEntry = this.eventNumberToCacheEntryMap.ceilingEntry(eventNumber);
    if (eventNumberCacheEntry !== undefined && eventNumberCacheEntry.key === eventNumber) eventNumberCacheEntry.value.include(eventNumber, simulationTime, beginOffset, endOffset);
    else this.eventNumberToCacheEntryMap.set(eventNumber, new CacheEntry(eventNumber, simulationTime, beginOffset, endOffset));

    const simulationTimeCacheEntry = this.simulationTimeToCacheEntryMap.ceilingEntry(simulationTime);
    if (simulationTimeCacheEntry !== undefined && simulationTimeCacheEntry.key.equals(simulationTime)) simulationTimeCacheEntry.value.include(eventNumber, simulationTime, beginOffset, endOffset);
    else this.simulationTimeToCacheEntryMap.set(simulationTime, new CacheEntry(eventNumber, simulationTime, beginOffset, endOffset));
  }

  // ---- the search core (port of searchForOffset/cacheSearchForOffset/binarySearchForOffset/linearSearchForOffset) ----

  /** Port of `EventLogIndex.searchForOffset()`. */
  private searchForOffset<T>(map: SortedMap<T, CacheEntry>, strategy: KeySearchStrategy<T>, key: T, matchKind: MatchKind): number {
    // first try to look up in the cache; this may result in an exact offset or a range around the offset being searched
    const cacheResult = this.cacheSearchForOffset(map, strategy, key, matchKind);
    let { lowerKey, upperKey, foundOffset, lowerOffset, upperOffset } = cacheResult;
    const { found } = cacheResult;

    // no events in cache (not even the first and last which is always cached) so there are no events at all
    if (map.size === 0) return -1;
    if (found) return foundOffset;

    if (!(strategy.compare(lowerKey, key) <= 0 && strategy.compare(key, upperKey) <= 0)) throw new Error('EventLogIndex.searchForOffset: invariant violated (lowerKey <= key <= upperKey)');
    if (!(foundOffset === -1 || (lowerOffset <= foundOffset && foundOffset <= upperOffset))) throw new Error('EventLogIndex.searchForOffset: invariant violated (lowerOffset <= foundOffset <= upperOffset)');

    // if we still have a key range then use a binary search to look up the closest match
    if (foundOffset === -1 || !strategy.equals(lowerKey, upperKey)) {
      const binaryResult = this.binarySearchForOffset(strategy, key, lowerKey, upperKey, lowerOffset, upperOffset);
      foundOffset = binaryResult.foundOffset;
      lowerKey = binaryResult.lowerKey;
      upperKey = binaryResult.upperKey;
      lowerOffset = binaryResult.lowerOffset;
      upperOffset = binaryResult.upperOffset;
    }

    const exactMatchFound = strategy.equals(lowerKey, key) && strategy.equals(upperKey, key);

    // finally use linear search to find the requested offset
    if (matchKind === MatchKind.EXACT) {
      if (foundOffset !== -1 && !strategy.uniqueExactMatch) {
        // check if there are multiple events with the same simulation time
        const firstOffset = this.linearSearchForOffset(strategy, key, foundOffset, false, true);
        const lastOffset = this.linearSearchForOffset(strategy, key, foundOffset, true, true);
        if (foundOffset !== lastOffset || foundOffset !== firstOffset) throw new Error('EventLogIndex.searchForOffset: found non-unique simulation time when exact match is requested');
      }
    } else {
      let forward: boolean;
      let searchOffset: number;
      if (exactMatchFound) {
        forward = matchKind === MatchKind.LAST_OR_NEXT || matchKind === MatchKind.LAST_OR_PREVIOUS;
        searchOffset = foundOffset;
      } else {
        forward = matchKind === MatchKind.FIRST_OR_NEXT || matchKind === MatchKind.LAST_OR_NEXT;
        if (forward) searchOffset = lowerOffset;
        else {
          this.reader.seekTo(upperOffset);
          const line = this.reader.getNextLine();
          searchOffset = line !== null ? line.startOffset : this.reader.getFileSize();
        }
      }
      foundOffset = this.linearSearchForOffset(strategy, key, searchOffset, forward, exactMatchFound);
    }
    if (!(foundOffset === -1 || this.isEventBeginOffset(foundOffset))) throw new Error('EventLogIndex.searchForOffset: resulting offset is not an event begin offset');
    return foundOffset;
  }

  /** Port of `EventLogIndex.cacheSearchForOffset()`. */
  private cacheSearchForOffset<T>(map: SortedMap<T, CacheEntry>, strategy: KeySearchStrategy<T>, key: T, matchKind: MatchKind): CacheSearchResult<T> {
    this.ensureFirstEventAndLastEventCached();
    const it = map.ceilingEntry(key); // greater or equal

    // if exact match found
    if (it !== undefined && strategy.equals(it.key, key)) {
      const cacheEntry = it.value;
      // for event numbers there can be only one exact match so we can safely return it independently of matchKind
      if (strategy.uniqueExactMatch) {
        return { found: true, lowerKey: key, upperKey: key, foundOffset: cacheEntry.beginOffset, lowerOffset: cacheEntry.beginOffset, upperOffset: cacheEntry.beginOffset };
      } else {
        // for simulation times we must consider whether the cache entry is complete or not by looking around it
        const itUpper = map.higherEntry(it.key);
        const firstEntry = map.firstEntry();
        const itLower = firstEntry !== undefined && strategy.equals(it.key, firstEntry.key) ? undefined : map.lowerEntry(it.key);
        // subsequent events may or may not have subsequent event numbers in the eventlog file
        // the end offset for the nth event is less than or equal to the begin offset of the nth + 1 event
        const completeBegin = itLower === undefined || itLower.value.endOffset === cacheEntry.beginOffset || itLower.value.endEventNumber + 1 === cacheEntry.beginEventNumber;
        const completeEnd = itUpper !== undefined && (itUpper.value.beginOffset === cacheEntry.endOffset || itUpper.value.beginEventNumber === cacheEntry.endEventNumber + 1);
        // dispatching on match kind is required
        switch (matchKind) {
          case MatchKind.EXACT:
            if (completeBegin && completeEnd) {
              if (cacheEntry.beginEventNumber !== cacheEntry.endEventNumber) throw new Error('EventLogIndex.cacheSearchForOffset: complete cache entry spans more than one event number');
              return { found: true, lowerKey: key, upperKey: key, foundOffset: cacheEntry.beginOffset, lowerOffset: cacheEntry.beginOffset, upperOffset: cacheEntry.beginOffset };
            }
            break;
          case MatchKind.FIRST_OR_PREVIOUS:
          case MatchKind.FIRST_OR_NEXT:
            if (completeBegin) return { found: true, lowerKey: key, upperKey: key, foundOffset: cacheEntry.beginOffset, lowerOffset: cacheEntry.beginOffset, upperOffset: cacheEntry.beginOffset };
            break;
          case MatchKind.LAST_OR_PREVIOUS:
          case MatchKind.LAST_OR_NEXT:
            if (completeEnd) return { found: true, lowerKey: key, upperKey: key, foundOffset: cacheEntry.endEventBeginOffset, lowerOffset: cacheEntry.endEventBeginOffset, upperOffset: cacheEntry.endEventBeginOffset };
            break;
        }
        // cannot exactly determine from cache; an event's begin offset must be returned
        return { found: false, lowerKey: key, upperKey: key, foundOffset: cacheEntry.beginOffset, lowerOffset: cacheEntry.beginOffset, upperOffset: cacheEntry.endOffset };
      }
    } else {
      // upper iterator refers to the closest element after the key
      const itUpper = it;
      let upperKey: T;
      let upperOffset: number;
      if (itUpper !== undefined) {
        upperKey = strategy.beginKeyOf(itUpper.value);
        upperOffset = itUpper.value.beginOffset;
      } else {
        upperKey = strategy.keyOf(this.getLastEventNumber(), this.getLastSimulationTime());
        upperOffset = this.reader.getFileSize();
      }

      // lower iterator refers to the closest element before the key. `it` (renamed
      // `itLower` here, matching Java's own reuse of the ceiling-entry variable) is
      // only usable as a genuine "element before the key" once it is reassigned to
      // `map.lowerEntry(...)` below -- that only happens when `it` exists and is not
      // already the map's very first entry (there being nothing before the first).
      const firstEntry = map.firstEntry();
      const itIsFirstEntry = it !== undefined && firstEntry !== undefined && strategy.equals(it.key, firstEntry.key);
      let itLower = it;
      let lowerKey: T = key;
      let lowerOffset = -1;
      if (itLower !== undefined && !itIsFirstEntry) {
        itLower = map.lowerEntry(itLower.key);
        const cacheEntry = itLower!.value;
        lowerKey = strategy.endKeyOf(cacheEntry);
        lowerOffset = cacheEntry.endOffset;
      } else {
        const firstEventNumber = this.getFirstEventNumber();
        if (firstEventNumber !== -1) {
          lowerKey = strategy.keyOf(firstEventNumber, this.getFirstSimulationTime());
          lowerOffset = this.getFirstEventOffset();
        }
        // else: log is empty; lowerKey/lowerOffset stay at their placeholder values --
        // searchForOffset()'s caller already returns -1 as soon as it observes
        // map.size === 0, so these placeholders are never read in that case.
        // NOTE: `itLower` is intentionally left as-is here (still `it`, i.e. the
        // original ceiling entry, or undefined) -- matches Java, where the local
        // variable is simply never reassigned in this branch, and is read again
        // below (FIRST_OR_PREVIOUS/LAST_OR_PREVIOUS) when `it` happens to be the
        // map's first entry itself (see this file's header discussion in the port
        // plan write-up: this is what makes FIRST_OR_PREVIOUS/LAST_OR_PREVIOUS land
        // on the very first event rather than -1 when the key is before it but the
        // cache's first entry is already known to be the true first event).
      }

      // if the closest element before and after are subsequent elements then the cache
      // is complete around the key so the exact offset can be determined
      if (lowerOffset === upperOffset) {
        let foundOffset: number;
        switch (matchKind) {
          case MatchKind.EXACT:
            // we did not get an exact match in the first place (see above)
            foundOffset = -1;
            break;
          case MatchKind.FIRST_OR_PREVIOUS:
          case MatchKind.LAST_OR_PREVIOUS:
            foundOffset = itLower === undefined ? -1 : itLower.value.endEventBeginOffset;
            break;
          case MatchKind.FIRST_OR_NEXT:
          case MatchKind.LAST_OR_NEXT:
            foundOffset = itUpper === undefined ? -1 : itUpper.value.beginOffset;
            break;
        }
        return { found: true, lowerKey, upperKey, foundOffset, lowerOffset, upperOffset };
      } else {
        return { found: false, lowerKey, upperKey, foundOffset: -1, lowerOffset, upperOffset };
      }
    }
  }

  /**
   * Port of `EventLogIndex.binarySearchForOffset()`.
   * IMPORTANT NOTE (kept from the Java source): `lowerOffset` will always be exactly
   * on an "E" line (that of `lowerKey`), but `upperOffset` will NOT -- necessary for
   * the distance between them to shrink properly.
   */
  private binarySearchForOffset<T>(strategy: KeySearchStrategy<T>, key: T, lowerKey: T, upperKey: T, lowerOffset: number, upperOffset: number): { foundOffset: number; lowerKey: T; upperKey: T; lowerOffset: number; upperOffset: number } {
    let foundOffset = -1;
    while (true) {
      const middleOffset = Math.floor((upperOffset + lowerOffset) / 2);
      const result = this.readToEventLine(true, middleOffset);
      if (result.found) {
        const middleEventBeginOffset = result.lineBeginOffset;
        const middleKey = strategy.keyOf(result.eventNumber, result.simulationTime);
        const cmp = strategy.compare(middleKey, key);
        if (cmp < 0) {
          lowerKey = middleKey;
          lowerOffset = lowerOffset === middleEventBeginOffset ? middleEventBeginOffset + 1 : middleEventBeginOffset;
        } else if (cmp > 0) {
          upperKey = middleKey;
          upperOffset = upperOffset === middleOffset ? middleOffset - 1 : middleOffset;
        } else {
          lowerKey = upperKey = key;
          foundOffset = lowerOffset = upperOffset = middleEventBeginOffset;
          break;
        }
      } else {
        // no key found -- we must be at the very end of the file; try again finding an "E" line from a bit earlier point
        upperOffset = middleOffset;
      }
      if (lowerOffset >= upperOffset) {
        foundOffset = -1;
        break;
      }
    }
    return { foundOffset, lowerKey, upperKey, lowerOffset, upperOffset };
  }

  /** Port of `EventLogIndex.linearSearchForOffset()`. */
  private linearSearchForOffset<T>(strategy: KeySearchStrategy<T>, key: T, beginOffset: number, forward: boolean, exactMatchRequired: boolean): number {
    if (beginOffset < 0) throw new Error('EventLogIndex.linearSearchForOffset: beginOffset must be >= 0');
    let previousOffset = beginOffset;
    let offset = beginOffset;
    while (offset !== -1) {
      const result = this.readToEventLine(forward, offset);
      if (!result.found) return exactMatchRequired ? previousOffset : -1;
      const readKey = strategy.keyOf(result.eventNumber, result.simulationTime);
      if (!exactMatchRequired) {
        if (forward) {
          if (strategy.compare(readKey, key) > 0) return result.lineBeginOffset;
        } else if (strategy.compare(readKey, key) < 0) return result.lineBeginOffset;
      } else if (!strategy.equals(readKey, key)) return previousOffset;
      previousOffset = result.lineBeginOffset;
      offset = forward ? result.lineEndOffset : result.lineBeginOffset;
    }
    return -1;
  }

  protected clearInternalState(): void {
    super.clearInternalState();
    this.firstEventNumber = EventNumberKind.EVENT_NOT_YET_CALCULATED;
    this.lastEventNumber = EventNumberKind.EVENT_NOT_YET_CALCULATED;
    this.firstSimulationTime = BigDecimal.MINUS_ONE;
    this.lastSimulationTime = BigDecimal.MINUS_ONE;
    this.firstEventOffset = -1;
    this.lastEventOffset = -1;
    this.eventNumberToCacheEntryMap.clear();
    this.simulationTimeToCacheEntryMap.clear();
  }

  /** Number of entries currently retained in the offset-search caches -- exposed for tests/instrumentation (see `offsetCacheLimit`'s doc comment above). Both maps are cleared together, so either's size is representative. */
  getOffsetCacheSize(): number {
    return this.eventNumberToCacheEntryMap.size;
  }

  /** The configured cap that triggers a wholesale clear of the offset-search caches -- see `offsetCacheLimit`'s doc comment above. */
  getOffsetCacheLimit(): number {
    return this.offsetCacheLimit;
  }

  protected isEventBeginOffset(offset: number): boolean {
    this.reader.seekTo(offset);
    const line = this.reader.getNextLine();
    return line !== null && line.text.length > 0 && line.text[0] === 'E';
  }

  /** Port of `EventLogIndex.synchronize()` (does NOT call `super.synchronize()` -- matches Java exactly: `EventLogBase`'s `lastNeighbourEvent` reset only cascades through `clearInternalState()`, and only OVERWRITTEN calls that here). */
  synchronize(change: FileChange): void {
    if (change !== FileChange.UNCHANGED) {
      this.reader.synchronize(change);
      switch (change) {
        case FileChange.OVERWRITTEN:
          this.clearInternalState();
          break;
        case FileChange.APPENDED:
          this.eventNumberToCacheEntryMap.delete(this.lastEventNumber);
          this.simulationTimeToCacheEntryMap.delete(this.lastSimulationTime);
          this.lastEventNumber = EventNumberKind.EVENT_NOT_YET_CALCULATED;
          this.lastSimulationTime = BigDecimal.MINUS_ONE;
          this.lastEventOffset = -1;
          break;
        default:
          throw new Error('EventLogIndex.synchronize: unknown file change');
      }
    }
  }

  getFirstEventNumber(): number {
    if (this.firstEventNumber === EventNumberKind.EVENT_NOT_YET_CALCULATED) {
      const result = this.readToEventLine(true, 0);
      if (result.found) {
        this.firstEventNumber = result.eventNumber;
        this.firstSimulationTime = result.simulationTime;
        this.firstEventOffset = result.lineBeginOffset;
      }
    }
    return this.firstEventNumber;
  }

  getLastEventNumber(): number {
    if (this.lastEventNumber === EventNumberKind.EVENT_NOT_YET_CALCULATED) {
      const result = this.readToEventLine(false, this.reader.getFileSize());
      if (result.found) {
        this.lastEventNumber = result.eventNumber;
        this.lastSimulationTime = result.simulationTime;
        this.lastEventOffset = result.lineBeginOffset;
        this.cacheEntry(this.lastEventNumber, this.lastSimulationTime, this.lastEventOffset, this.reader.getFileSize());
      }
    }
    return this.lastEventNumber;
  }

  getFirstSimulationTime(): BigDecimal {
    this.getFirstEventNumber();
    return this.firstSimulationTime;
  }
  getLastSimulationTime(): BigDecimal {
    this.getLastEventNumber();
    return this.lastSimulationTime;
  }
  getFirstEventOffset(): number {
    this.getFirstEventNumber();
    return this.firstEventOffset;
  }
  getLastEventOffset(): number {
    this.getLastEventNumber();
    return this.lastEventOffset;
  }
  ensureFirstEventAndLastEventCached(): void {
    this.getFirstEventNumber();
    this.getLastEventNumber();
  }

  /** Port of `EventLogIndex.getBeginOffsetForEndOffset()`. */
  getBeginOffsetForEndOffset(endOffset: number): number {
    if (endOffset < 0) throw new Error('EventLogIndex.getBeginOffsetForEndOffset: endOffset must be >= 0');
    const result = this.readToEventLine(false, endOffset);
    return result.found ? result.lineBeginOffset : -1;
  }

  /** Port of `EventLogIndex.getEndOffsetForBeginOffset()`. */
  getEndOffsetForBeginOffset(beginOffset: number): number {
    if (beginOffset < 0) throw new Error('EventLogIndex.getEndOffsetForBeginOffset: beginOffset must be >= 0');
    const result = this.readToEventLine(true, beginOffset + 1);
    return result.found ? result.lineBeginOffset : this.reader.getFileSize();
  }

  /** Port of `EventLogIndex.getOffsetForEventNumber()`. */
  getOffsetForEventNumber(eventNumber: number, matchKind: MatchKind): number {
    if (eventNumber < 0) throw new Error('EventLogIndex.getOffsetForEventNumber: eventNumber must be >= 0');
    return this.searchForOffset(this.eventNumberToCacheEntryMap, eventNumberKeyStrategy, eventNumber, matchKind);
  }

  /** Port of `EventLogIndex.getOffsetForSimulationTime()`. */
  getOffsetForSimulationTime(simulationTime: BigDecimal, matchKind: MatchKind): number {
    if (!simulationTime.greaterOrEqual(BigDecimal.ZERO)) throw new Error('EventLogIndex.getOffsetForSimulationTime: simulationTime must be >= 0');
    return this.searchForOffset(this.simulationTimeToCacheEntryMap, simulationTimeKeyStrategy, simulationTime, matchKind);
  }

  /**
   * Port of the package-private `EventLogIndex.readToEventLine()` (declared abstract
   * here and implemented once, concretely, in this same class -- Java has only one
   * implementation too; it is not overridden by `EventLog`). Scans for the first "E "
   * line at-or-after (`forward`) or at-or-before (`!forward`) `readStartOffset`,
   * caching whatever it finds along the way (matching Java: every "E" line read here
   * feeds `cacheEntry()`, which is how the cache gets populated during binary/linear
   * search, not just during event parsing).
   */
  readToEventLine(forward: boolean, readStartOffset: number): ReadToEventLineResult {
    if (readStartOffset < 0) throw new Error('EventLogIndex.readToEventLine: readStartOffset must be >= 0');
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
        if (eventNumber === -1) throw new Error(`EventLogIndex.readToEventLine: wrong file format: no event number in 'E' line: ${line.text}`);
        this.cacheEntry(eventNumber, simulationTime, line.startOffset, line.endOffset);
        return { found: true, eventNumber, simulationTime, lineBeginOffset: line.startOffset, lineEndOffset: line.endOffset };
      }
    }
  }
}
