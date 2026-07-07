/**
 * Phase E4 test suite, part 1: the brute-force oracle for `EventLogIndex`'s
 * cached/binary/linear offset search (`EventLog.getEventForEventNumber()`/
 * `getEventForSimulationTime()`), across all 5 `MatchKind`s, and the classic
 * duplicate-simulation-time tie-breaking trap the port plan calls out (risk #1).
 *
 * The oracle is `TestEventLog` (shared/src/test/eventlog/testEventLogHelper.ts, phase
 * E3's "dumb but correct" linear/binary reference driver): for every fixture, both a
 * real `EventLog` and a `TestEventLog` are opened over the *same* file content, and
 * `getEventForEventNumber(n, matchKind)` / `getEventForSimulationTime(t, matchKind)`
 * must agree (same event number, or both null) for every `MatchKind`, across a mix of
 * in-range, exact-hit and between-events (gap) query values.
 *
 * DISCOVERED CONSTRAINT (verified against both the Java port AND the original C++
 * `eventlogindex.cc`, not just one of the two -- see this file's last test): the
 * search algorithm's internal invariant (`Assert.isTrue(lowerKey.compareTo(key) <= 0 &&
 * key.compareTo(upperKey) <= 0)` in `searchForOffset`, present verbatim in both the C++
 * and the Java sources) requires the query key to fall within
 * `[getFirstEventNumber(), getLastEventNumber()]` (or the simulation-time equivalent) --
 * querying strictly outside that closed range throws, for every `MatchKind`, not just
 * `EXACT`. This is a real, deliberate precondition of the engine, not a porting
 * artifact: production callers are expected to clamp against
 * `getFirst*()`/`getLast*()` themselves before calling in (see e.g.
 * `MessageSendDependency.getConsequenceEventNumber()` in messageDependency.ts, which
 * checks `consequenceTime.greater(getLastEvent().getSimulationTime())` *before* ever
 * calling `getEventForSimulationTime`). `TestEventLog`'s convenience methods do NOT
 * reproduce this precondition (they degrade gracefully outside the range by design,
 * per its own header) -- so out-of-range queries are intentionally excluded from the
 * cross-checked fuzz candidates below and covered by a separate, explicit test instead.
 *
 * SECOND DISCOVERED CONSTRAINT: `MatchKind.EXACT` on a simulation time shared by more
 * than one event throws in the real engine -- both the "cache entry is fully bounded
 * on both sides yet still spans more than one event number" branch
 * (`cacheSearchForOffset`'s `Assert.isTrue(cacheEntry.beginEventNumber ==
 * cacheEntry.endEventNumber)`) and the binary/linear-search fallback's explicit
 * `"Found non unique simulation time when exact match is requested"` both throw, never
 * return null. `TestEventLog.getEventForSimulationTime()`'s own EXACT branch
 * deliberately returns `null` instead (a convenience simplification, not a spec
 * mismatch to "fix") -- so, like the out-of-range case above, EXACT-on-a-duplicate is
 * excluded from the direct oracle comparison and checked with its own assertion.
 */

import { test } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { BigDecimal } from '../../eventlog/bigDecimal';
import { EventLog } from '../../eventlog/eventLog';
import { MatchKind } from '../../eventlog/enums';
import { fileReaderForContent, TestEventLog } from './testEventLogHelper';
import { makeDuplicateRunSimTime, mulberry32, synthesizeEventLog } from './synthesizeEventLog';

const ALL_MATCH_KINDS = [MatchKind.EXACT, MatchKind.FIRST_OR_PREVIOUS, MatchKind.FIRST_OR_NEXT, MatchKind.LAST_OR_PREVIOUS, MatchKind.LAST_OR_NEXT];

const fifoPath = resolve(__dirname, '..', 'fixtures', 'elog', 'sample', 'Fifo1-#0.elog');
const predefinedTreePath = resolve(__dirname, '..', 'fixtures', 'elog', 'send-message', 'message-P1T2RE-is-processed-after-3-second-immediately-at-the-next-event.elog');

interface Fixture {
  name: string;
  text: string;
}

function loadFixture(name: string, path: string): Fixture {
  return { name, text: fs.readFileSync(path, 'latin1') };
}

const duplicateRunSimTime = makeDuplicateRunSimTime([10, 5, 1, 8, 1, 1, 6]); // several runs of different lengths, incl. singletons

const fixtures: Fixture[] = [
  loadFixture('Fifo1-#0.elog (real sample)', fifoPath),
  loadFixture('predefined send-message tree fixture', predefinedTreePath),
  { name: 'synthesized: unique simulation times', text: synthesizeEventLog({ eventCount: 60 }).text },
  { name: 'synthesized: duplicate simulation time runs', text: synthesizeEventLog({ eventCount: 33, simTimeForEvent: duplicateRunSimTime }).text },
];

function openEventLog(text: string): EventLog {
  return new EventLog(fileReaderForContent(text));
}
function openTestEventLog(text: string): TestEventLog {
  return new TestEventLog(fileReaderForContent(text));
}

/**
 * Collects candidate event numbers to query: every real event number (exact hits --
 * a plain unfiltered eventlog's event numbers are always dense, so there are no
 * "gap"/between-events event-number values to construct) plus the two boundary values
 * (first/last), all safely within `[getFirstEventNumber(), getLastEventNumber()]` (see
 * this file's header on why out-of-range values are deliberately excluded here).
 */
function collectEventNumberCandidates(oracle: TestEventLog): number[] {
  const values = new Set<number>();
  let event = oracle.getFirstEvent();
  while (event !== null) {
    values.add(event.getEventNumber());
    event = event.getNextEvent();
  }
  return [...values];
}

/**
 * Collects candidate simulation times: every real simulation time present (exact
 * hits, including duplicate-time runs), plus "between" values strictly inside two
 * consecutive *distinct* simulation times (gap values) -- clamped to stay within
 * `[getFirstSimulationTime(), getLastSimulationTime()]` (see this file's header).
 */
/** Maps every simulation time (by its printed string) to how many events share it -- used to detect duplicate-time runs (see this file's header, "SECOND DISCOVERED CONSTRAINT"). */
function countEventsPerSimulationTime(oracle: TestEventLog): Map<string, number> {
  const counts = new Map<string, number>();
  let event = oracle.getFirstEvent();
  while (event !== null) {
    const key = event.getSimulationTime().toString();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    event = event.getNextEvent();
  }
  return counts;
}

function collectSimTimeCandidates(oracle: TestEventLog): BigDecimal[] {
  const values: BigDecimal[] = [];
  const lastSimulationTime = oracle.getLastSimulationTime();
  let event = oracle.getFirstEvent();
  while (event !== null) {
    const t = event.getSimulationTime();
    values.push(t);
    const between = t.add(BigDecimal.parse('0.5'));
    if (between.lessOrEqual(lastSimulationTime)) values.push(between); // strictly between two integral simtimes, and still in range
    event = event.getNextEvent();
  }
  return values;
}

for (const fixture of fixtures) {
  test(`eventLogIndex oracle: getEventForEventNumber() matches TestEventLog for every MatchKind (${fixture.name})`, () => {
    const eventLog = openEventLog(fixture.text);
    const oracle = openTestEventLog(fixture.text);
    const candidates = collectEventNumberCandidates(oracle);
    const rnd = mulberry32(1);
    let comparisons = 0;
    // exercise every candidate directly, then top up with random picks/combinations to reach ~200 queries
    const queries: number[] = [...candidates];
    while (queries.length < 200) queries.push(candidates[Math.floor(rnd() * candidates.length)]);

    for (const eventNumber of queries) {
      for (const matchKind of ALL_MATCH_KINDS) {
        const expected = oracle.getEventForEventNumber(eventNumber, matchKind);
        const actual = eventLog.getEventForEventNumber(eventNumber, matchKind);
        comparisons++;
        assert.equal(
          actual === null ? null : actual.getEventNumber(),
          expected === null ? null : expected.getEventNumber(),
          `getEventForEventNumber(${eventNumber}, ${matchKind}) mismatch`,
        );
      }
    }
    assert.ok(comparisons >= 200 * ALL_MATCH_KINDS.length - 1, `expected at least ~200*5 comparisons, ran ${comparisons}`);
  });

  test(`eventLogIndex oracle: getEventForSimulationTime() matches TestEventLog for every MatchKind (${fixture.name})`, () => {
    const eventLog = openEventLog(fixture.text);
    const oracle = openTestEventLog(fixture.text);
    const candidates = collectSimTimeCandidates(oracle);
    const eventCountAtSimTime = countEventsPerSimulationTime(oracle);
    const rnd = mulberry32(2);
    let comparisons = 0;
    const queries: BigDecimal[] = [...candidates];
    while (queries.length < 200) queries.push(candidates[Math.floor(rnd() * candidates.length)]);

    for (const simTime of queries) {
      // MatchKind.EXACT on a simulation time shared by more than one event is a
      // documented "throw" in the real engine (see this file's header and the
      // dedicated test below) -- TestEventLog's convenience EXACT implementation
      // deliberately degrades to `null` instead, so the two are not comparable there.
      const isDuplicated = (eventCountAtSimTime.get(simTime.toString()) ?? 0) > 1;
      for (const matchKind of ALL_MATCH_KINDS) {
        comparisons++;
        if (matchKind === MatchKind.EXACT && isDuplicated) {
          assert.throws(() => eventLog.getEventForSimulationTime(simTime, matchKind), `EXACT should throw for duplicated t=${simTime.toString()}`);
          continue;
        }
        const expected = oracle.getEventForSimulationTime(simTime, matchKind);
        const actual = eventLog.getEventForSimulationTime(simTime, matchKind);
        assert.equal(
          actual === null ? null : actual.getEventNumber(),
          expected === null ? null : expected.getEventNumber(),
          `getEventForSimulationTime(${simTime.toString()}, ${matchKind}) mismatch`,
        );
      }
    }
    assert.ok(comparisons >= 200 * ALL_MATCH_KINDS.length - 1, `expected at least ~200*5 comparisons, ran ${comparisons}`);
  });
}

// ---------------------------------------------------------------------------------
// Duplicate simulation times: FIRST_OR_*/LAST_OR_* must land on the first/last event
// of the tied run (the classic transcription-bug trap the port plan calls out).
// ---------------------------------------------------------------------------------

test('eventLogIndex: FIRST_OR_PREVIOUS/FIRST_OR_NEXT land on the FIRST event of a duplicate-simulation-time run', () => {
  // ten events at t=0, five at t=1, one at t=2, eight at t=3, one at t=4, one at t=5, six at t=6
  const runLengths = [10, 5, 1, 8, 1, 1, 6];
  const { text } = synthesizeEventLog({ eventCount: 32, simTimeForEvent: makeDuplicateRunSimTime(runLengths) });
  const eventLog = openEventLog(text);
  const oracle = openTestEventLog(text);

  let firstOfRun = 0;
  for (const runLength of runLengths) {
    const t = eventLog.getEventForEventNumber(firstOfRun)!.getSimulationTime();
    for (const matchKind of [MatchKind.FIRST_OR_PREVIOUS, MatchKind.FIRST_OR_NEXT]) {
      const event = eventLog.getEventForSimulationTime(t, matchKind);
      assert.equal(event!.getEventNumber(), firstOfRun, `${matchKind} at t=${t.toString()} should land on the first event of the run (#${firstOfRun})`);
      // cross-check against the oracle too
      assert.equal(event!.getEventNumber(), oracle.getEventForSimulationTime(t, matchKind)!.getEventNumber());
    }
    firstOfRun += runLength;
  }
});

test('eventLogIndex: LAST_OR_PREVIOUS/LAST_OR_NEXT land on the LAST event of a duplicate-simulation-time run', () => {
  const runLengths = [10, 5, 1, 8, 1, 1, 6];
  const { text } = synthesizeEventLog({ eventCount: 32, simTimeForEvent: makeDuplicateRunSimTime(runLengths) });
  const eventLog = openEventLog(text);
  const oracle = openTestEventLog(text);

  let firstOfRun = 0;
  for (const runLength of runLengths) {
    const lastOfRun = firstOfRun + runLength - 1;
    const t = eventLog.getEventForEventNumber(firstOfRun)!.getSimulationTime();
    for (const matchKind of [MatchKind.LAST_OR_PREVIOUS, MatchKind.LAST_OR_NEXT]) {
      const event = eventLog.getEventForSimulationTime(t, matchKind);
      assert.equal(event!.getEventNumber(), lastOfRun, `${matchKind} at t=${t.toString()} should land on the last event of the run (#${lastOfRun})`);
      assert.equal(event!.getEventNumber(), oracle.getEventForSimulationTime(t, matchKind)!.getEventNumber());
    }
    firstOfRun += runLength;
  }
});

test('eventLogIndex: EXACT throws when a simulation time matches more than one event (non-unique exact match)', () => {
  const { text } = synthesizeEventLog({ eventCount: 15, simTimeForEvent: makeDuplicateRunSimTime([10, 5]) });
  const eventLog = openEventLog(text);
  const tiedTime = eventLog.getEventForEventNumber(0)!.getSimulationTime();
  assert.throws(() => eventLog.getEventForSimulationTime(tiedTime, MatchKind.EXACT));
});

test('eventLogIndex: EXACT succeeds for a simulation time matching exactly one event, even amid duplicate runs elsewhere', () => {
  const runLengths = [10, 1, 5]; // the middle run (event #10) is a lone singleton
  const { text } = synthesizeEventLog({ eventCount: 16, simTimeForEvent: makeDuplicateRunSimTime(runLengths) });
  const eventLog = openEventLog(text);
  const singletonTime = eventLog.getEventForEventNumber(10)!.getSimulationTime();
  const event = eventLog.getEventForSimulationTime(singletonTime, MatchKind.EXACT);
  assert.equal(event!.getEventNumber(), 10);
});

test('eventLogIndex: repeated queries against a warm cache still agree with the oracle (exercises cacheSearchForOffset, not just binary/linear search)', () => {
  const eventCount = 50;
  const { text } = synthesizeEventLog({ eventCount, simTimeForEvent: makeDuplicateRunSimTime([1, 1, 1, 1, 1, 20, 1, 1, 1, 1, 1, 20]) });
  const eventLog = openEventLog(text);
  const oracle = openTestEventLog(text);
  const rnd = mulberry32(42);

  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 100; i++) {
      const eventNumber = Math.floor(rnd() * eventCount); // stays within [0, eventCount-1] -- see this file's header on the out-of-range precondition
      const matchKind = ALL_MATCH_KINDS[Math.floor(rnd() * ALL_MATCH_KINDS.length)];
      const expected = oracle.getEventForEventNumber(eventNumber, matchKind);
      const actual = eventLog.getEventForEventNumber(eventNumber, matchKind);
      assert.equal(actual === null ? null : actual.getEventNumber(), expected === null ? null : expected.getEventNumber());
    }
  }
});

// ---------------------------------------------------------------------------------
// Discovered constraint (see this file's header): querying strictly outside
// [getFirstEventNumber(), getLastEventNumber()] (or the simulation-time equivalent)
// throws -- verified against both the Java port and the C++ original, so this is
// ported faithfully rather than "fixed" to degrade gracefully.
// ---------------------------------------------------------------------------------

test('eventLogIndex: querying an event number beyond the last one throws for FIRST_OR_*/LAST_OR_* (documented engine precondition, not a bug)', () => {
  const { text } = synthesizeEventLog({ eventCount: 10 });
  const eventLog = openEventLog(text);
  const lastEventNumber = eventLog.getLastEventNumber();
  for (const matchKind of [MatchKind.FIRST_OR_PREVIOUS, MatchKind.FIRST_OR_NEXT, MatchKind.LAST_OR_PREVIOUS, MatchKind.LAST_OR_NEXT])
    assert.throws(() => eventLog.getEventForEventNumber(lastEventNumber + 1, matchKind), `matchKind=${matchKind}`);
  // one past the very last event is the one EXACT scenario that does NOT reach the
  // search algorithm at all: `getEventForEventNumber`'s EXACT branch has its own
  // neighbour-based shortcut (`eventNumberToEventMap.get(eventNumber - 1)` ->
  // `.getNextEvent()`), which resolves "is there really nothing at eventNumber+1"
  // directly from the already-linked last event without ever calling
  // `getOffsetForEventNumber()` -- so it gracefully returns null instead of throwing.
  // Two past the end has no such neighbour to shortcut through, so it does throw.
  assert.equal(eventLog.getEventForEventNumber(lastEventNumber + 1, MatchKind.EXACT), null);
  assert.throws(() => eventLog.getEventForEventNumber(lastEventNumber + 2, MatchKind.EXACT));
});

test('eventLogIndex: querying a simulation time beyond the last one throws (documented engine precondition, not a bug)', () => {
  const { text } = synthesizeEventLog({ eventCount: 10 });
  const eventLog = openEventLog(text);
  const beyond = eventLog.getLastSimulationTime().add(BigDecimal.ONE);
  // getEventForSimulationTime() has no neighbour-shortcut for EXACT (unlike the
  // event-number overload above), so every MatchKind throws here.
  for (const matchKind of ALL_MATCH_KINDS) assert.throws(() => eventLog.getEventForSimulationTime(beyond, matchKind), `matchKind=${matchKind}`);
});
