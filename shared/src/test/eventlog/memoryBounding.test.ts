/**
 * Phase E7 test suite: memory bounding. Per the port plan, this is "the highest-value
 * test in the whole plan": every bounded cache (`EventLog`'s parsed-event LRU,
 * `FilteredEventLog`'s `FilteredEvent`/flag-map caches, `SequenceChartFacade`'s
 * timeline-coordinate cache) must produce IDENTICAL results to the unbounded/oracle
 * behavior even under pathologically small cache limits -- eviction must be invisible
 * to correctness, only to memory footprint. Also covers the pinning API and the
 * eventLogTableFacade.ts entry-identity regression (phase E7's identity-site sweep),
 * plus a disk-backed, bounded-memory stress scan.
 */

import { test } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BigDecimal } from '../../eventlog/bigDecimal';
import { Event } from '../../eventlog/event';
import { EventLog } from '../../eventlog/eventLog';
import { EventLogTableFacade } from '../../eventlog/eventLogTableFacade';
import type { EventLogEntry } from '../../eventlog/eventLogEntry';
import { EventLogTableFilterMode, MatchKind, TimelineMode } from '../../eventlog/enums';
import { FileReader } from '../../eventlog/fileReader';
import { FilteredEvent } from '../../eventlog/filteredEvent';
import { FilteredEventLog } from '../../eventlog/filteredEventLog';
import type { IEvent, IEventLog } from '../../eventlog/ieventlog';
import { NodeRandomAccessFile } from '../../node/nodeRandomAccessFile';
import { SequenceChartFacade } from '../../eventlog/sequenceChartFacade';
import { fileReaderForContent, TestEventLog } from './testEventLogHelper';
import { makeDuplicateRunSimTime, mulberry32, synthesizeEventLog } from './synthesizeEventLog';

const ALL_MATCH_KINDS = [MatchKind.EXACT, MatchKind.FIRST_OR_PREVIOUS, MatchKind.FIRST_OR_NEXT, MatchKind.LAST_OR_PREVIOUS, MatchKind.LAST_OR_NEXT];

function openEventLog(text: string, eventCacheLimit?: number): EventLog {
  return new EventLog(fileReaderForContent(text), eventCacheLimit === undefined ? {} : { eventCacheLimit });
}
function openTestEventLog(text: string): TestEventLog {
  return new TestEventLog(fileReaderForContent(text));
}

// ---------------------------------------------------------------------------------
// 1. EventLog: oracle-under-pressure (eventCacheLimit: 8) -- must match the unbounded
//    TestEventLog oracle on every query kind.
// ---------------------------------------------------------------------------------

test('memoryBounding: EventLog with eventCacheLimit=8 matches the unbounded oracle for getEventForEventNumber (every MatchKind, every event)', () => {
  const { text, eventCount } = synthesizeEventLog({ eventCount: 500, simTimeForEvent: makeDuplicateRunSimTime([20, 1, 1, 50, 1, 428]) });
  const bounded = openEventLog(text, 8);
  const oracle = openTestEventLog(text);
  assert.equal(bounded.getEventCacheLimit(), 8);

  // NOTE: probes stay within [0, eventCount - 1] -- querying past the last event number
  // throws an (unrelated, pre-existing, out-of-scope) invariant assertion in
  // `EventLogIndex.searchForOffset()` regardless of caching, confirmed by reproducing
  // it against an eventCacheLimit: Infinity instance too; not an E7 concern.
  for (let n = 0; n < eventCount; n++) {
    for (const matchKind of ALL_MATCH_KINDS) {
      const expected = oracle.getEventForEventNumber(n, matchKind);
      const actual = bounded.getEventForEventNumber(n, matchKind);
      assert.equal(actual === null ? null : actual.getEventNumber(), expected === null ? null : expected.getEventNumber(), `getEventForEventNumber(${n}, ${matchKind})`);
    }
  }
  // the cache must actually have been bounded (proves eviction really happened, not just a no-op limit)
  assert.ok(bounded.getEventCacheSize() <= 8, `cache size ${bounded.getEventCacheSize()} should never exceed the limit`);
});

/** Maps every simulation time (by its printed string) to how many events share it -- mirrors eventLogIndex.test.ts's helper of the same name. */
function countEventsPerSimulationTime(oracle: TestEventLog): Map<string, number> {
  const counts = new Map<string, number>();
  for (let event = oracle.getFirstEvent(); event !== null; event = event.getNextEvent()) {
    const key = event.getSimulationTime().toString();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

test('memoryBounding: EventLog with eventCacheLimit=8 matches the unbounded oracle for getEventForSimulationTime (every MatchKind)', () => {
  const { text } = synthesizeEventLog({ eventCount: 400, simTimeForEvent: makeDuplicateRunSimTime([15, 1, 1, 1, 40, 1, 1, 300]) });
  const bounded = openEventLog(text, 6);
  const oracle = openTestEventLog(text);
  const eventCountAtSimTime = countEventsPerSimulationTime(oracle);
  const rnd = mulberry32(11);

  // NOTE: kept within the actual simulated time range (this fixture's last event lands
  // around t=47) -- querying past the last event's simulation time throws (a
  // documented, unrelated engine precondition -- see eventLogIndex.test.ts). Likewise,
  // MatchKind.EXACT on a simulation time shared by more than one event is documented
  // to throw (also covered there) -- both are skipped here since this test is about
  // eviction transparency, not re-litigating eventLogIndex.test.ts's own coverage.
  for (let i = 0; i < 300; i++) {
    const simTime = BigDecimal.parse(String(Math.floor(rnd() * 45)));
    const isDuplicated = (eventCountAtSimTime.get(simTime.toString()) ?? 0) > 1;
    for (const matchKind of ALL_MATCH_KINDS) {
      if (matchKind === MatchKind.EXACT && isDuplicated) continue;
      const expected = oracle.getEventForSimulationTime(simTime, matchKind);
      const actual = bounded.getEventForSimulationTime(simTime, matchKind);
      assert.equal(actual === null ? null : actual.getEventNumber(), expected === null ? null : expected.getEventNumber(), `getEventForSimulationTime(${simTime.toString()}, ${matchKind})`);
    }
  }
});

test('memoryBounding: EventLog with eventCacheLimit=8 -- forward/backward full iteration matches the oracle', () => {
  const { text } = synthesizeEventLog({ eventCount: 350, simTimeForEvent: makeDuplicateRunSimTime([10, 1, 1, 300]) });
  const bounded = openEventLog(text, 8);
  const oracle = openTestEventLog(text);

  const forward: number[] = [];
  for (let event = bounded.getFirstEvent(); event !== null; event = event.getNextEvent()) forward.push(event.getEventNumber());
  const oracleForward: number[] = [];
  for (let event = oracle.getFirstEvent(); event !== null; event = event.getNextEvent()) oracleForward.push(event.getEventNumber());
  assert.deepEqual(forward, oracleForward);

  const backward: number[] = [];
  for (let event = bounded.getLastEvent(); event !== null; event = event.getPreviousEvent()) backward.push(event.getEventNumber());
  assert.deepEqual(forward, [...backward].reverse());
});

test('memoryBounding: EventLog with eventCacheLimit=8 -- getNeighbourEvent() random walks match the oracle', () => {
  const { text } = synthesizeEventLog({ eventCount: 300, simTimeForEvent: makeDuplicateRunSimTime([8, 1, 1, 1, 20, 1, 250]) });
  const bounded = openEventLog(text, 8);
  const oracle = openTestEventLog(text);
  const rnd = mulberry32(42);

  for (let i = 0; i < 400; i++) {
    const startEventNumber = Math.floor(rnd() * 300);
    const distance = Math.floor(rnd() * 41) - 20; // [-20, 20]
    const boundedStart = bounded.getEventForEventNumber(startEventNumber)!;
    const oracleStart = oracle.getEventForEventNumber(startEventNumber)!;
    const boundedResult = bounded.getNeighbourEvent(boundedStart, distance);
    const oracleResult = oracle.getNeighbourEvent(oracleStart, distance);
    assert.equal(boundedResult === null ? null : boundedResult.getEventNumber(), oracleResult === null ? null : oracleResult.getEventNumber(), `getNeighbourEvent(#${startEventNumber}, ${distance})`);
  }
  // repeated random-access churn must keep the cache within its limit throughout
  assert.ok(bounded.getEventCacheSize() <= 8);
});

// ---------------------------------------------------------------------------------
// 2. Pinning: pinned events survive heavy scanning; unpinning makes them evictable.
// ---------------------------------------------------------------------------------

test('memoryBounding: pinEvent() protects an event from eviction through heavy unrelated scanning; unpinEvent() releases it', () => {
  const { text, eventCount } = synthesizeEventLog({ eventCount: 500 });
  const eventLog = openEventLog(text, 4);

  const pinnedNumber = 250;
  const pinnedEvent = eventLog.getEventForEventNumber(pinnedNumber)!;
  eventLog.pinEvent(pinnedNumber);
  assert.ok(eventLog.isEventPinned(pinnedNumber));

  // heavy unrelated forward scan across the whole file (far more churn than the tiny cache limit)
  for (let event = eventLog.getFirstEvent(); event !== null; event = event.getNextEvent()) {
    /* just walk */
  }
  // heavy unrelated backward scan too
  for (let event = eventLog.getLastEvent(); event !== null; event = event.getPreviousEvent()) {
    /* just walk */
  }

  // pinned event must still be served straight from cache (useCacheOnly=true), and be the SAME object (never evicted, never reparsed)
  const stillCached = eventLog.getEventForEventNumber(pinnedNumber, MatchKind.EXACT, true);
  assert.notEqual(stillCached, null, 'pinned event must survive heavy scanning');
  assert.equal(stillCached, pinnedEvent, 'pinned event must be the exact same object -- never evicted/reparsed');

  eventLog.unpinEvent(pinnedNumber);
  assert.ok(!eventLog.isEventPinned(pinnedNumber));

  // more heavy scanning, now that it is unpinned, must eventually evict it
  for (let event = eventLog.getFirstEvent(); event !== null; event = event.getNextEvent()) {
    /* just walk */
  }
  const afterUnpin = eventLog.getEventForEventNumber(pinnedNumber, MatchKind.EXACT, true);
  assert.equal(afterUnpin, null, 'unpinned event should be evictable again after further unrelated scanning');
  void eventCount;
});

test('memoryBounding: the cached first/last events are always implicitly protected from eviction', () => {
  const { text } = synthesizeEventLog({ eventCount: 200 });
  const eventLog = openEventLog(text, 3); // pathologically small: only first+last+1 more would already be tight
  const first = eventLog.getFirstEvent()!;
  const last = eventLog.getLastEvent()!;

  for (let event = eventLog.getFirstEvent(); event !== null; event = event.getNextEvent()) {
    /* heavy scan */
  }

  assert.equal(eventLog.getEventForEventNumber(first.getEventNumber(), MatchKind.EXACT, true), first);
  assert.equal(eventLog.getEventForEventNumber(last.getEventNumber(), MatchKind.EXACT, true), last);
});

// ---------------------------------------------------------------------------------
// 3. FilteredEventLog/FilteredEvent: oracle-under-pressure with tiny caps.
// ---------------------------------------------------------------------------------

function collectFilteredForward(filteredLog: FilteredEventLog): number[] {
  const result: number[] = [];
  for (let event: FilteredEvent | null = filteredLog.getFirstEvent(); event !== null; event = event.getNextEvent()) result.push(event.getEventNumber());
  return result;
}
function collectFilteredBackward(filteredLog: FilteredEventLog): number[] {
  const result: number[] = [];
  for (let event: FilteredEvent | null = filteredLog.getLastEvent(); event !== null; event = event.getPreviousEvent()) result.push(event.getEventNumber());
  return result;
}

test('memoryBounding: FilteredEventLog with tiny filteredEventCacheLimit/filteredFlagCacheLimit matches an unbounded instance', () => {
  const { text, eventCount } = synthesizeEventLog({ eventCount: 600, simTimeForEvent: makeDuplicateRunSimTime([30, 1, 1, 550]) });
  const eventLog = openEventLog(text);
  const excluded = [10, 11, 12, 200, 201, 350, 470, 471, 472, 473];

  const makeFiltered = (options: { filteredEventCacheLimit?: number; filteredFlagCacheLimit?: number }): FilteredEventLog => {
    const filteredLog = new FilteredEventLog(eventLog, options);
    filteredLog.setFirstConsideredEventNumber(5);
    filteredLog.setLastConsideredEventNumber(eventCount - 5);
    filteredLog.setExcludedEventNumbers(excluded);
    return filteredLog;
  };

  const unbounded = makeFiltered({ filteredEventCacheLimit: Infinity, filteredFlagCacheLimit: Infinity });
  const bounded = makeFiltered({ filteredEventCacheLimit: 5, filteredFlagCacheLimit: 7 });
  assert.equal(bounded.getFilteredEventCacheLimit(), 5);

  assert.deepEqual(collectFilteredForward(bounded), collectFilteredForward(unbounded));
  assert.deepEqual(collectFilteredBackward(bounded), collectFilteredBackward(unbounded));
  assert.ok(collectFilteredForward(unbounded).length > 0, 'sanity: the filter must actually admit some events');

  // random getEventForEventNumber probes under every MatchKind
  const rnd = mulberry32(7);
  for (let i = 0; i < 300; i++) {
    const n = Math.floor(rnd() * eventCount);
    for (const matchKind of ALL_MATCH_KINDS) {
      const expected = unbounded.getEventForEventNumber(n, matchKind);
      const actual = bounded.getEventForEventNumber(n, matchKind);
      assert.equal(actual === null ? null : actual.getEventNumber(), expected === null ? null : expected.getEventNumber(), `getEventForEventNumber(${n}, ${matchKind})`);
    }
  }
  assert.ok(bounded.getFilteredEventCacheSize() <= 5, `FilteredEvent cache size ${bounded.getFilteredEventCacheSize()} should never exceed its limit`);
});

test('memoryBounding: FilteredEventLog pinEvent() protects a FilteredEvent through heavy unrelated navigation', () => {
  const { text } = synthesizeEventLog({ eventCount: 400 });
  const eventLog = openEventLog(text);
  const filteredLog = new FilteredEventLog(eventLog, { filteredEventCacheLimit: 3 });

  const pinnedNumber = 200;
  const pinned = filteredLog.getEventForEventNumber(pinnedNumber)!;
  filteredLog.pinEvent(pinnedNumber);

  for (let event: FilteredEvent | null = filteredLog.getFirstEvent(); event !== null; event = event.getNextEvent()) {
    /* heavy scan */
  }

  const stillCached = filteredLog.getEventForEventNumber(pinnedNumber);
  assert.equal(stillCached, pinned, 'pinned FilteredEvent must survive heavy scanning as the same object');

  filteredLog.unpinEvent(pinnedNumber);
  for (let event: FilteredEvent | null = filteredLog.getFirstEvent(); event !== null; event = event.getNextEvent()) {
    /* heavy scan */
  }
  // it's fine if it happens to still be cached (eviction is best-effort LRU), but it must at least be
  // logically re-derivable and equal by event number once unpinned+churned (no crash / no wrong answer)
  const afterUnpin = filteredLog.getEventForEventNumber(pinnedNumber);
  assert.equal(afterUnpin!.getEventNumber(), pinnedNumber);
});

// ---------------------------------------------------------------------------------
// 4. SequenceChartFacade: coordinate cache trimming preserves exact recomputed values.
// ---------------------------------------------------------------------------------

function collectCoordinates(eventLog: IEventLog, facade: SequenceChartFacade): number[] {
  const result: number[] = [];
  for (let event: IEvent | null = eventLog.getFirstEvent(); event !== null; event = event.getNextEvent()) result.push(facade.getTimelineCoordinateBegin(event));
  return result;
}

/** Asserts every pair of coordinates agrees within a tiny floating-point tolerance (see the test below for why exact bit-equality isn't the right bar here). */
function assertCoordinatesClose(actual: number[], expected: number[], eps: number): void {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) assert.ok(Math.abs(actual[i] - expected[i]) <= eps, `index ${i}: expected ${expected[i]}, got ${actual[i]}`);
}

test('memoryBounding: SequenceChartFacade (NONLINEAR) with a tiny coordCacheLimit reproduces the unbounded coordinates, forward and backward', () => {
  const { text } = synthesizeEventLog({ eventCount: 300, simTimeForEvent: makeDuplicateRunSimTime([20, 1, 1, 1, 250]) });
  const eventLog = openEventLog(text);
  const origin = eventLog.getFirstEvent()!;

  const makeFacade = (coordCacheLimit: number): SequenceChartFacade => {
    const facade = new SequenceChartFacade(eventLog, { coordCacheLimit });
    facade.setTimelineMode(TimelineMode.NONLINEAR);
    facade.relocateTimelineCoordinateSystem(origin);
    return facade;
  };

  const unbounded = makeFacade(Infinity);
  const bounded = makeFacade(4); // pathologically small -- forces contiguous trimming on almost every step

  // Forward pass: both facades compute every coordinate via the identical forward
  // delta-chain (trimming only discards the FAR/start side, never touching how a NEW
  // step is computed), so this is bit-exact, not just close.
  const unboundedForward = collectCoordinates(eventLog, unbounded);
  const boundedForward = collectCoordinates(eventLog, bounded);
  assert.deepEqual(boundedForward, unboundedForward);
  assert.ok(bounded.getTimelineCoordinateCacheSize() <= 4, `coordinate cache size ${bounded.getTimelineCoordinateCacheSize()} should never exceed its limit`);

  // Backward pass (exercises the opposite trim direction): for `bounded`, most of the
  // forward-computed range has since been trimmed away, so re-deriving these
  // coordinates walks a genuinely different (reverse) chain of floating-point
  // additions than the original forward pass did -- mathematically equal, but not
  // bit-for-bit identical (floating point addition isn't associative: summing the
  // same deltas in a different order can differ in the last few ULPs). A tight
  // tolerance is the correct bar here, not bit-exact equality -- and still a
  // meaningful regression test: a real contiguity bug (e.g. an off-by-one in the trim,
  // or a not-actually-cached boundary) would produce errors many orders of magnitude
  // larger than this, or an outright exception.
  const unboundedBackward: number[] = [];
  const boundedBackward: number[] = [];
  for (let event: IEvent | null = eventLog.getLastEvent(); event !== null; event = event.getPreviousEvent()) {
    unboundedBackward.push(unbounded.getTimelineCoordinateBegin(event));
    boundedBackward.push(bounded.getTimelineCoordinateBegin(event));
  }
  assertCoordinatesClose(boundedBackward, unboundedBackward, 1e-9);
});

test('memoryBounding: SequenceChartFacade (STEP) with a tiny coordCacheLimit matches the unbounded facade after a mid-scan relocate (version bump clears the cache)', () => {
  const { text } = synthesizeEventLog({ eventCount: 200 });
  const eventLog = openEventLog(text);
  const origin = eventLog.getFirstEvent()!;

  const unbounded = new SequenceChartFacade(eventLog, { coordCacheLimit: Infinity });
  const bounded = new SequenceChartFacade(eventLog, { coordCacheLimit: 5 });
  for (const facade of [unbounded, bounded]) {
    facade.setTimelineMode(TimelineMode.STEP);
    facade.relocateTimelineCoordinateSystem(origin);
  }

  // walk half way, then relocate to a new origin (bumps the coordinate-system version,
  // clearing the cache) and keep walking -- coordinates must still agree throughout.
  let event: IEvent | null = eventLog.getFirstEvent();
  for (let i = 0; i < 100 && event !== null; i++) {
    assert.equal(bounded.getTimelineCoordinateBegin(event), unbounded.getTimelineCoordinateBegin(event));
    event = event.getNextEvent();
  }
  const newOrigin = eventLog.getEventForEventNumber(100)!;
  unbounded.relocateTimelineCoordinateSystem(newOrigin);
  bounded.relocateTimelineCoordinateSystem(newOrigin);
  while (event !== null) {
    assert.equal(bounded.getTimelineCoordinateBegin(event), unbounded.getTimelineCoordinateBegin(event));
    event = event.getNextEvent();
  }
});

// ---------------------------------------------------------------------------------
// 5. EventLogTableFacade: entry-identity regression (phase E7 identity-site fix) --
//    getDistanceToEntry()/getNeighbourEntry() must work correctly across evictions
//    that reparse events into fresh EventLogEntry objects.
// ---------------------------------------------------------------------------------

test('memoryBounding: EventLogTableFacade getDistanceToEntry()/getNeighbourEntry() survive eviction-induced reparsing (compound-key fix)', () => {
  const { text, eventCount } = synthesizeEventLog({ eventCount: 300 });
  const eventLog = openEventLog(text, 4); // tiny cache: guarantees heavy churn/reparsing between the two captured entries
  const tableFacade = new EventLogTableFacade(eventLog);
  tableFacade.setFilterMode(EventLogTableFilterMode.ALL_ENTRIES);

  // NOTE: neither endpoint may be event #0 or the last event (#299) -- those are
  // implicitly pinned (see eventLog.ts's header) and would never evict, defeating the
  // point of this test.
  const sourceEventNumber = 5;
  const targetEventNumber = 250;
  const source = tableFacade.getEntryInEvent(eventLog.getEventForEventNumber(sourceEventNumber)!, 0);
  // Force `source`'s underlying Event out of the tiny cache: touching many other,
  // scattered event numbers (each an independent, index-assisted direct fetch -- NOT
  // a walk through the events in between, which the offset index built at
  // construction time already makes possible) guarantees enough distinct insertions
  // to LRU-evict event #5 well before the walk below even starts.
  for (let k = 10; k < 290; k += 7) eventLog.getEventForEventNumber(k);
  const target = tableFacade.getEntryInEvent(eventLog.getEventForEventNumber(targetEventNumber)!, 0);
  assert.equal(eventLog.getEventForEventNumber(sourceEventNumber, MatchKind.EXACT, true), null, 'sanity: source event must have been evicted by now');

  const { entry: reached, reachedDistance } = tableFacade.getEntryAndDistance(source, target, 100_000);
  assert.notEqual(reached, null, 'must actually reach the target entry, not walk past it');
  assert.equal(reached!.getEvent()!.getEventNumber(), targetEventNumber);
  assert.equal(reachedDistance, targetEventNumber - sourceEventNumber); // one entry per event (ALL_ENTRIES, single-line events)

  // round trip: walk from the target back to the source by the exact negated distance
  const back = tableFacade.getNeighbourEntry(target, -reachedDistance);
  assert.notEqual(back, null);
  assert.equal(back!.getEvent()!.getEventNumber(), sourceEventNumber);
  void eventCount;
});

// ---------------------------------------------------------------------------------
// 6. Bounded-memory stress test: a real, disk-backed, larger-than-fixture file.
// ---------------------------------------------------------------------------------
//
// Sizing note: the plan's nominal target is "~1M events / 50-100MB", scanned with
// default caps, asserting heapUsed stays under a documented budget. A true 1M-event
// linear forward scan was measured (dev machine, `bun test`) at ~27s and ~500-700MB
// heap with the default eventCacheLimit -- both numbers dominated NOT by this phase's
// bounded Event-object cache (which correctly stays pinned at its configured limit
// throughout, asserted below) but by `EventLogIndex.eventNumberToCacheEntryMap`/
// `simulationTimeToCacheEntryMap` (eventLogIndex.ts) -- a separate, deliberately
// unbounded, compact per-event-number offset index that mirrors Java's own (also
// unbounded) design and is out of this phase's explicit scope (see the phase's task
// list: only eventNumberToEventMap/beginOffsetToEventMap/endOffsetToEventMap, the
// coordinate cache, and the FilteredEventLog caches). A full linear scan of every
// event is the pathological case for that index (it grows one entry per event under
// pure forward iteration); real usage (viewport/random-access navigation) keeps it far
// sparser. Per the phase's own test-plan escape hatch ("if 1M is too slow in CI, scale
// to the largest size that stays under ~30s and note it"), this test uses 300,000
// events (~11MB on disk) -- comfortably under the runtime budget with a defensible,
// non-flaky heap budget -- while still exercising real disk I/O (NodeRandomAccessFile)
// and proving the Event-object cache itself never grows past its configured limit.
// See this file's header / the phase report for the full numbers and the residual
// eventNumberToCacheEntryMap growth flagged as a risk for E8 to consider (e.g. capping
// it too, or accepting it as bounded-by-chunk-density in realistic snapshot/index-
// bearing files).

test(
  'memoryBounding: disk-backed stress scan (300k events) stays within a defensible heap budget and never exceeds the event cache limit',
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnetpp-memoryBounding-'));
    const file = path.join(dir, 'stress.elog');
    try {
      const eventCount = 300_000;
      writeSynthesizedEventLogToDisk(file, eventCount);

      const eventCacheLimit = 50_000; // the class default
      Bun.gc(true);
      const heapBefore = process.memoryUsage().heapUsed;
      const start = performance.now();

      const raf = new NodeRandomAccessFile(file);
      const reader = new FileReader(raf);
      const eventLog = new EventLog(reader, { eventCacheLimit });

      let count = 0;
      let maxCacheSizeSeen = 0;
      for (let event: Event | null = eventLog.getFirstEvent(); event !== null; event = event.getNextEvent()) {
        count++;
        if (count % 1000 === 0) maxCacheSizeSeen = Math.max(maxCacheSizeSeen, eventLog.getEventCacheSize());
      }
      const elapsedMs = performance.now() - start;
      reader.close();

      Bun.gc(true);
      const heapAfter = process.memoryUsage().heapUsed;
      const heapDeltaMB = (heapAfter - heapBefore) / 1e6;

      assert.equal(count, eventCount, 'must yield every event via a plain forward walk');
      assert.ok(eventLog.getEventCacheSize() <= eventCacheLimit, `final event cache size ${eventLog.getEventCacheSize()} must not exceed the limit ${eventCacheLimit}`);
      assert.ok(maxCacheSizeSeen <= eventCacheLimit, `event cache size must never exceed its limit during the scan (saw ${maxCacheSizeSeen})`);
      assert.ok(elapsedMs < 30_000, `scan should finish in a reasonable time (took ${elapsedMs.toFixed(0)}ms)`);
      // Defensible budget for 300k events at the default cache limit (measured ~175MB
      // delta on a dev machine) -- generous headroom for CI variance. See this test's
      // header note for why a full 1M-event scan needs a much larger budget (dominated
      // by the out-of-scope eventNumberToCacheEntryMap index, not this phase's cache).
          assert.ok(heapDeltaMB < 350, `heap delta should stay within a defensible budget (was ${heapDeltaMB.toFixed(1)}MB)`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  60_000,
);

// ---------------------------------------------------------------------------------
// 7. EventLogIndex offset-cache cap (phase E8 follow-up): wholesale-clearing
//    eventNumberToCacheEntryMap/simulationTimeToCacheEntryMap at a small cap must
//    never change a result -- only how much re-scanning a later search does -- and
//    the cache must actually stay bounded through heavy churn.
// ---------------------------------------------------------------------------------

test('memoryBounding: EventLogIndex offsetCacheLimit caps the offset-search caches without changing any result', () => {
  const { text, eventCount } = synthesizeEventLog({ eventCount: 400, simTimeForEvent: makeDuplicateRunSimTime([12, 1, 1, 1, 30, 1, 350]) });
  const unbounded = new EventLog(fileReaderForContent(text), { offsetCacheLimit: Infinity });
  const bounded = new EventLog(fileReaderForContent(text), { offsetCacheLimit: 10 });
  assert.equal(bounded.getOffsetCacheLimit(), 10);

  const rnd = mulberry32(99);
  let maxSizeSeen = 0;
  for (let i = 0; i < 500; i++) {
    const n = Math.floor(rnd() * eventCount);
    for (const matchKind of ALL_MATCH_KINDS) {
      const expected = unbounded.getEventForEventNumber(n, matchKind);
      const actual = bounded.getEventForEventNumber(n, matchKind);
      assert.equal(actual === null ? null : actual.getEventNumber(), expected === null ? null : expected.getEventNumber(), `getEventForEventNumber(${n}, ${matchKind})`);
    }
    maxSizeSeen = Math.max(maxSizeSeen, bounded.getOffsetCacheSize());
  }
  assert.ok(maxSizeSeen <= 10 + 1, `offset cache should stay near its cap throughout heavy churn (saw ${maxSizeSeen})`);
  assert.ok(bounded.getOffsetCacheSize() <= 10 + 1, `final offset cache size ${bounded.getOffsetCacheSize()} should not exceed the cap`);
});

/** Streams a plain (no I/S chunks) synthesized eventlog straight to disk, avoiding building the whole text as one in-memory string first (relevant only at this test's scale). */
function writeSynthesizedEventLogToDisk(file: string, eventCount: number): void {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, 'SB ov 1536 ev 2 rid Test-0\n\n');
    for (let i = 0; i < eventCount; i++) {
      fs.writeSync(fd, `E # ${i} t ${i} m 1 ce -1 msg -1\n`);
      if (i === 0) fs.writeSync(fd, 'MC id 1 c C t T n root cm 1\n');
      fs.writeSync(fd, '\n');
    }
    fs.writeSync(fd, 'SE e 0 c 9 m "done"\n');
  } finally {
    fs.closeSync(fd);
  }
}
