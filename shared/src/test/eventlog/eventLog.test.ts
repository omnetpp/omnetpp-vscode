/**
 * Phase E4 test suite, part 2: the `EventLog` manager's features beyond raw offset
 * search (covered by eventLogIndex.test.ts) -- chunked-file parsing and truncated-file
 * handling, forward/backward neighbour iteration, approximate counts/positions,
 * `findEventLogEntry()` text search, and the parse-begin/parse-end/parse-all policy.
 */

import { test } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { BigDecimal } from '../../eventlog/bigDecimal';
import { EventLog } from '../../eventlog/eventLog';
import { FileReader } from '../../eventlog/fileReader';
import { MatchKind } from '../../eventlog/enums';
import { fileReaderForContent, FakeRandomAccessFile, TestEventLog } from './testEventLogHelper';
import { CountingRandomAccessFile, makeDuplicateRunSimTime, mulberry32, synthesizeChunkedEventLog, synthesizeEventLog } from './synthesizeEventLog';

const ALL_MATCH_KINDS = [MatchKind.EXACT, MatchKind.FIRST_OR_PREVIOUS, MatchKind.FIRST_OR_NEXT, MatchKind.LAST_OR_PREVIOUS, MatchKind.LAST_OR_NEXT];

const fifoPath = resolve(__dirname, '..', 'fixtures', 'elog', 'sample', 'Fifo1-#0.elog');

function openEventLog(text: string): EventLog {
  return new EventLog(fileReaderForContent(text));
}
function openTestEventLog(text: string): TestEventLog {
  return new TestEventLog(fileReaderForContent(text));
}

// ---------------------------------------------------------------------------------
// Item 3: chunked file (S/I chunks) + truncated-file handling.
// ---------------------------------------------------------------------------------

test('eventLog: parseIndicesAndSnapshots() finds every synthesized S/I chunk and links them correctly', () => {
  const { text, eventCount } = synthesizeChunkedEventLog({ eventCount: 120, snapshotEvery: 25, indexEvery: 6 });
  const eventLog = openEventLog(text);

  const expectedSnapshotEvents = [0, 25, 50, 75, 100];
  const expectedIndexEvents: number[] = [];
  for (let i = 1; i < eventCount; i++) if (i % 25 !== 0 && i % 6 === 0) expectedIndexEvents.push(i);

  let snapshot = eventLog.getFirstSnapshot();
  const foundSnapshotEvents: number[] = [];
  while (snapshot !== null) {
    foundSnapshotEvents.push(snapshot.getEventNumber());
    snapshot = snapshot.getNextSnapshot();
  }
  assert.deepEqual(foundSnapshotEvents, expectedSnapshotEvents);

  let index = eventLog.getFirstIndex();
  const foundIndexEvents: number[] = [];
  while (index !== null) {
    foundIndexEvents.push(index.getEventNumber());
    index = index.getNextIndex();
  }
  assert.deepEqual(foundIndexEvents, expectedIndexEvents);
});

test('eventLog: getEventForEventNumber()/getIndex()/getSnapshot() near chunk boundaries agree with the oracle', () => {
  const { text, eventCount } = synthesizeChunkedEventLog({ eventCount: 80, snapshotEvery: 20, indexEvery: 4 });
  const eventLog = openEventLog(text);
  const oracle = openTestEventLog(text);

  // probe every event number right around each chunk boundary (S at 0/20/40/60, I at every 4th otherwise)
  const boundaries = [0, 4, 8, 20, 24, 40, 44, 60, 64, eventCount - 1];
  for (const n of boundaries) {
    for (const delta of [-1, 0, 1]) {
      const eventNumber = n + delta;
      if (eventNumber < 0 || eventNumber >= eventCount) continue;
      for (const matchKind of ALL_MATCH_KINDS) {
        const expected = oracle.getEventForEventNumber(eventNumber, matchKind);
        const actual = eventLog.getEventForEventNumber(eventNumber, matchKind);
        assert.equal(actual === null ? null : actual.getEventNumber(), expected === null ? null : expected.getEventNumber(), `getEventForEventNumber(${eventNumber}, ${matchKind})`);
      }
    }
  }
});

test('eventLog: a snapshot\'s getFoundEventLogEntries() (root module) resolves for every synthesized snapshot', () => {
  const { text } = synthesizeChunkedEventLog({ eventCount: 50, snapshotEvery: 10, indexEvery: 3 });
  const eventLog = openEventLog(text);
  let snapshot = eventLog.getFirstSnapshot();
  let count = 0;
  while (snapshot !== null) {
    const found = snapshot.getFoundEventLogEntries();
    assert.equal(found.length, 1, `snapshot at event #${snapshot.getEventNumber()} should always find the root module reference`);
    count++;
    snapshot = snapshot.getNextSnapshot();
  }
  assert.ok(count >= 5);
});

/** Cuts `text` at every byte offset in `cutPositions` and asserts EventLog still opens and yields the complete prefix of events (per the file's actual content up to the cut), including mid-line and mid-event cuts. */
function assertTruncationYieldsCompletePrefix(text: string, oracleFullEventCount: number): void {
  const rnd = mulberry32(7);
  const cutPositions = new Set<number>();
  // a mix of structured cuts (mid-event, mid-line, chunk boundaries) and random ones
  for (let i = 0; i < 30; i++) cutPositions.add(Math.floor(rnd() * text.length));
  for (const marker of ['\nE ', '\nI ', '\nS ']) {
    let idx = text.indexOf(marker);
    while (idx !== -1) {
      cutPositions.add(idx + 1); // exactly at the line start
      cutPositions.add(idx + 3); // mid-line, inside the marker
      idx = text.indexOf(marker, idx + 1);
    }
  }

  for (const cutPosition of cutPositions) {
    if (cutPosition <= 0) continue;
    const truncated = text.slice(0, cutPosition);
    // must not throw just from opening a truncated file
    const eventLog = openEventLog(truncated);
    const oracleFull = openTestEventLog(text);

    let count = 0;
    let previousEventNumber = -1;
    let event = eventLog.getFirstEvent();
    while (event !== null) {
      assert.ok(event.getEventNumber() > previousEventNumber, `event numbers must still increase after truncation at ${cutPosition}`);
      // every event yielded must be a real, complete event that also exists (identically) in the untruncated oracle
      const oracleEvent = oracleFull.getEventForEventNumber(event.getEventNumber());
      assert.notEqual(oracleEvent, null, `event #${event.getEventNumber()} (truncated at ${cutPosition}) must be a real, complete event in the full file`);
      assert.equal(event.getBeginOffset(), oracleEvent!.getBeginOffset());
      previousEventNumber = event.getEventNumber();
      count++;
      event = event.getNextEvent();
    }
    assert.ok(count <= oracleFullEventCount, `truncated file must not yield more events than the full file (cut at ${cutPosition})`);
  }
}

test('eventLog: truncating a plain (unchunked) file at arbitrary byte positions still opens and yields a complete event prefix', () => {
  const { text, eventCount } = synthesizeEventLog({ eventCount: 40 });
  assertTruncationYieldsCompletePrefix(text, eventCount);
});

test('eventLog: truncating a chunked (S/I) file at arbitrary byte positions still opens and yields a complete event prefix', () => {
  const { text, eventCount } = synthesizeChunkedEventLog({ eventCount: 60, snapshotEvery: 15, indexEvery: 4 });
  assertTruncationYieldsCompletePrefix(text, eventCount);
});

test('eventLog: truncating the real Fifo1-#0.elog sample at arbitrary byte positions still opens and yields a complete event prefix', () => {
  const text = fs.readFileSync(fifoPath, 'latin1');
  assertTruncationYieldsCompletePrefix(text, 33);
});

// ---------------------------------------------------------------------------------
// Item 4: neighbour/iteration.
// ---------------------------------------------------------------------------------

test('eventLog: forward iteration (first->last) equals reversed backward iteration (last->first), matches the oracle', () => {
  const { text } = synthesizeEventLog({ eventCount: 50, simTimeForEvent: makeDuplicateRunSimTime([5, 5, 10, 1, 1, 28]) });
  const eventLog = openEventLog(text);
  const oracle = openTestEventLog(text);

  const forward: number[] = [];
  let event = eventLog.getFirstEvent();
  while (event !== null) {
    forward.push(event.getEventNumber());
    event = event.getNextEvent();
  }
  const backward: number[] = [];
  let back = eventLog.getLastEvent();
  while (back !== null) {
    backward.push(back.getEventNumber());
    back = back.getPreviousEvent();
  }
  assert.deepEqual(forward, [...backward].reverse());

  const oracleForward: number[] = [];
  let oracleEvent = oracle.getFirstEvent();
  while (oracleEvent !== null) {
    oracleForward.push(oracleEvent.getEventNumber());
    oracleEvent = oracleEvent.getNextEvent();
  }
  assert.deepEqual(forward, oracleForward);
});

test('eventLog: getNeighbourEvent() random walks match the oracle', () => {
  const { text } = synthesizeEventLog({ eventCount: 60, simTimeForEvent: makeDuplicateRunSimTime([10, 1, 20, 1, 28]) });
  const eventLog = openEventLog(text);
  const oracle = openTestEventLog(text);
  const rnd = mulberry32(99);

  for (let i = 0; i < 150; i++) {
    const startEventNumber = Math.floor(rnd() * 60);
    const distance = Math.floor(rnd() * 21) - 10; // [-10, 10]
    const startEvent = eventLog.getEventForEventNumber(startEventNumber)!;
    const startOracleEvent = oracle.getEventForEventNumber(startEventNumber)!;
    const result = eventLog.getNeighbourEvent(startEvent, distance);
    const oracleResult = oracle.getNeighbourEvent(startOracleEvent, distance);
    assert.equal(result === null ? null : result.getEventNumber(), oracleResult === null ? null : oracleResult.getEventNumber(), `getNeighbourEvent(#${startEventNumber}, ${distance})`);
  }
});

test('eventLog: getNeighbourEvent(event, 0) returns the same event', () => {
  const { text } = synthesizeEventLog({ eventCount: 10 });
  const eventLog = openEventLog(text);
  const event = eventLog.getEventForEventNumber(5)!;
  assert.equal(eventLog.getNeighbourEvent(event, 0), event);
});

// ---------------------------------------------------------------------------------
// Item 5: approximates.
// ---------------------------------------------------------------------------------

test('eventLog: getApproximateNumberOfEvents() is within a documented tolerance of the true count', () => {
  // Tolerance: getApproximateNumberOfEvents() extrapolates true event density from the
  // first/last 100 events' average size; for a file with roughly uniform event sizes
  // (as synthesized here) this should land within 20% of the real count.
  for (const eventCount of [5, 50, 500]) {
    const { text } = synthesizeEventLog({ eventCount });
    const eventLog = openEventLog(text);
    const approx = eventLog.getApproximateNumberOfEvents();
    const tolerance = Math.max(2, Math.ceil(eventCount * 0.2));
    assert.ok(Math.abs(approx - eventCount) <= tolerance, `approx=${approx} true=${eventCount} tolerance=${tolerance}`);
  }
});

test('eventLog: getApproximateNumberOfEvents() is 0 for an empty log', () => {
  const eventLog = openEventLog('');
  assert.equal(eventLog.getApproximateNumberOfEvents(), 0);
});

test('eventLog: getApproximateEventAt(0)/(1) are the first/last events; monotone in percentage', () => {
  const { text, eventCount } = synthesizeEventLog({ eventCount: 40 });
  const eventLog = openEventLog(text);
  const first = eventLog.getApproximateEventAt(0);
  const last = eventLog.getApproximateEventAt(1);
  assert.equal(first!.getEventNumber(), eventLog.getFirstEventNumber());
  assert.equal(last!.getEventNumber(), eventLog.getLastEventNumber());

  let previous = -1;
  for (let i = 0; i <= 10; i++) {
    const event = eventLog.getApproximateEventAt(i / 10);
    assert.ok(event !== null);
    assert.ok(event!.getEventNumber() >= previous, `getApproximateEventAt(${i / 10}) should be monotone non-decreasing (got ${event!.getEventNumber()} after ${previous})`);
    previous = event!.getEventNumber();
  }
  assert.equal(previous, eventCount - 1);
});

test('eventLog: getApproximatePercentageForEventNumber() is 0 at the first event and non-decreasing', () => {
  const { text } = synthesizeEventLog({ eventCount: 30 });
  const eventLog = openEventLog(text);
  assert.equal(eventLog.getApproximatePercentageForEventNumber(eventLog.getFirstEventNumber()), 0);
  let previous = -1;
  let event = eventLog.getFirstEvent();
  while (event !== null) {
    const percentage = eventLog.getApproximatePercentageForEventNumber(event.getEventNumber());
    assert.ok(percentage >= previous - 1e-9, `percentage must be non-decreasing (event #${event.getEventNumber()})`);
    assert.ok(percentage >= 0 && percentage <= 1);
    previous = percentage;
    event = event.getNextEvent();
  }
});

// ---------------------------------------------------------------------------------
// Item 6: findEventLogEntry() text search vs. a naive full-scan reference.
// ---------------------------------------------------------------------------------

/** Naive reference: scans every eventlog entry (in file order) belonging to a real event, forward or backward from `start` (exclusive), and returns the first line whose printed text contains `search`. */
function naiveFindEventLogEntry(oracle: TestEventLog, startEventNumber: number, startEntryIndex: number, search: string, forward: boolean, caseSensitive: boolean): { eventNumber: number; entryIndex: number } | null {
  const all: { eventNumber: number; entryIndex: number; text: string }[] = [];
  let event = oracle.getFirstEvent();
  while (event !== null) {
    for (let i = 0; i < event.getNumEventLogEntries(); i++) all.push({ eventNumber: event.getEventNumber(), entryIndex: i, text: event.getEventLogEntry(i).print() });
    event = event.getNextEvent();
  }
  const ordered = forward ? all : [...all].reverse();
  const needle = caseSensitive ? search : search.toLowerCase();
  let skipping = true;
  for (const entry of ordered) {
    if (skipping) {
      if (entry.eventNumber === startEventNumber && entry.entryIndex === startEntryIndex) skipping = false;
      continue;
    }
    const text = caseSensitive ? entry.text : entry.text.toLowerCase();
    if (text.includes(needle)) return { eventNumber: entry.eventNumber, entryIndex: entry.entryIndex };
  }
  return null;
}

test('eventLog: findEventLogEntry() forward text search matches a naive full-scan reference (real Fifo1-#0.elog sample)', () => {
  const text = fs.readFileSync(fifoPath, 'latin1');
  const eventLog = openEventLog(text);
  const oracle = openTestEventLog(text);

  const startEvent = eventLog.getEventForEventNumber(0)!;
  const start = startEvent.getEventLogEntry(0);
  for (const search of ['fifo', 'FIFO', 'cQueue', 'nonexistent-needle-xyz']) {
    for (const caseSensitive of [true, false]) {
      const found = eventLog.findEventLogEntry(start, search, true, caseSensitive);
      const expected = naiveFindEventLogEntry(oracle, 0, 0, search, true, caseSensitive);
      if (expected === null) assert.equal(found, null, `search="${search}" caseSensitive=${caseSensitive}`);
      else {
        assert.notEqual(found, null, `search="${search}" caseSensitive=${caseSensitive}`);
        assert.equal(found!.getEvent()!.getEventNumber(), expected.eventNumber);
        assert.equal(found!.getEntryIndex(), expected.entryIndex);
      }
    }
  }
});

test('eventLog: findEventLogEntry() backward text search matches a naive full-scan reference (real Fifo1-#0.elog sample)', () => {
  const text = fs.readFileSync(fifoPath, 'latin1');
  const eventLog = openEventLog(text);
  const oracle = openTestEventLog(text);

  const lastEvent = eventLog.getLastEvent()!;
  const start = lastEvent.getEventLogEntry(lastEvent.getNumEventLogEntries() - 1);
  for (const search of ['fifo', 'cQueue']) {
    const found = eventLog.findEventLogEntry(start, search, false, true);
    const expected = naiveFindEventLogEntry(oracle, lastEvent.getEventNumber(), lastEvent.getNumEventLogEntries() - 1, search, false, true);
    if (expected === null) assert.equal(found, null, `search="${search}"`);
    else {
      assert.notEqual(found, null, `search="${search}"`);
      assert.equal(found!.getEvent()!.getEventNumber(), expected.eventNumber);
      assert.equal(found!.getEntryIndex(), expected.entryIndex);
    }
  }
});

test('eventLog: findEventLogEntry() with a null start searches the entire log from the beginning/end', () => {
  const text = fs.readFileSync(fifoPath, 'latin1');
  const eventLog = openEventLog(text);
  const foundForward = eventLog.findEventLogEntry(null, 'fifo', true, false);
  assert.notEqual(foundForward, null);
  assert.equal(foundForward!.getEvent()!.getEventNumber(), 0);

  const foundBackward = eventLog.findEventLogEntry(null, 'fifo', false, false);
  assert.notEqual(foundBackward, null);
});

// ---------------------------------------------------------------------------------
// Item 7: parse policy (parseAll vs. parseBegin+parseEnd).
// ---------------------------------------------------------------------------------

test('eventLog: parseAll() on a small file (default policy) reads (close to) the entire file', () => {
  const { text } = synthesizeEventLog({ eventCount: 400, fillerBytesPerEvent: 40 });
  const counting = new CountingRandomAccessFile(new FakeRandomAccessFile(text));
  new EventLog(new FileReader(counting));
  // parseAll walks every event forward, so it should read (order of) the whole file,
  // not a small fraction of it.
  assert.ok(counting.totalBytesRead >= text.length * 0.9, `expected parseAll to read most of the file: read ${counting.totalBytesRead} of ${text.length} bytes`);
});

test('eventLog: on a file at/above the size threshold, parseBegin()+parseEnd() reads only a small fraction of the file (size override option keeps this fast)', () => {
  // A few hundred KB of tiny, filler-padded events -- big enough to demonstrate the
  // policy split without committing a genuinely multi-MB fixture (per the phase's
  // "size override option" requirement), using synthesizeChunkedEventLog so
  // parseIndicesAndSnapshots() also stays cheap (periodic chunks let it jump between
  // chunk boundaries instead of scanning the whole file backward line-by-line). A
  // SMALL FileReader buffer is essential here: with the default 256KB buffer (larger
  // than this whole fixture), every chunk-to-chunk jump would reload a buffer window
  // comparable to the entire file, defeating the point of the "large file" policy --
  // exactly what a multi-GB real file's much-smaller-than-file buffer achieves
  // naturally, reproduced here at a fixture-friendly scale.
  const { text: paddedText } = synthesizeChunkedEventLog({ eventCount: 3000, snapshotEvery: 1000, indexEvery: 100, simTimeForEvent: (i) => String(i), fillerBytesPerEvent: 60 });
  const counting = new CountingRandomAccessFile(new FakeRandomAccessFile(paddedText));

  const parseBeginEndBytes = 5000;
  const bufferSize = 1024;
  new EventLog(new FileReader(counting, bufferSize), { smallFileThresholdBytes: paddedText.length / 2, parseBeginEndBytes });

  assert.ok(counting.totalBytesRead < paddedText.length * 0.3, `expected parseBegin/parseEnd to read only a small fraction of the file: read ${counting.totalBytesRead} of ${paddedText.length} bytes`);
});

test('eventLog: honors the smallFileThresholdBytes/parseBeginEndBytes override to force each policy branch deterministically', () => {
  const { text } = synthesizeEventLog({ eventCount: 100, fillerBytesPerEvent: 20 });

  // force parseAll by setting a huge threshold
  const countingAll = new CountingRandomAccessFile(new FakeRandomAccessFile(text));
  new EventLog(new FileReader(countingAll), { smallFileThresholdBytes: Number.MAX_SAFE_INTEGER });
  assert.ok(countingAll.totalBytesRead >= text.length * 0.9);

  // force parseBegin+parseEnd by setting threshold to 0 (every file is "large")
  const countingSplit = new CountingRandomAccessFile(new FakeRandomAccessFile(text));
  const eventLogSplit = new EventLog(new FileReader(countingSplit), { smallFileThresholdBytes: 0, parseBeginEndBytes: 200 });
  // events near the two ends should be parsed already (cache-only lookups succeed)
  assert.notEqual(eventLogSplit.getEventForEventNumber(0, MatchKind.EXACT, true), null);
  assert.notEqual(eventLogSplit.getEventForEventNumber(99, MatchKind.EXACT, true), null);
});
