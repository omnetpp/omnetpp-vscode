/**
 * Phase E6 test suite, part 2: `EventLogTableFacade` (shared/src/eventlog/
 * eventLogTableFacade.ts) -- the Event Log table's per-entry (not per-event) row
 * enumeration. Every filter mode is checked against a brute-force predicate written
 * independently from `matchesFilter()`'s own logic (walking every event's entries
 * directly, not going through the facade at all), so these tests exercise the
 * `getNeighbourEntry()`/`getEntryAndDistance()` navigation machinery, not just "does
 * the predicate look right".
 */

import { test } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { BeginSendEntry, EventEntry } from '../../eventlog/entries';
import { EventLog } from '../../eventlog/eventLog';
import { EventLogTableFacade } from '../../eventlog/eventLogTableFacade';
import type { EventLogEntry } from '../../eventlog/eventLogEntry';
import { EventLogMessageEntry } from '../../eventlog/eventLogEntry';
import { EventLogTableFilterMode } from '../../eventlog/enums';
import { fileReaderForContent } from './testEventLogHelper';
import { mulberry32, synthesizeEventLog } from './synthesizeEventLog';

function openEventLog(text: string): EventLog {
  return new EventLog(fileReaderForContent(text));
}

const fifoPath = resolve(__dirname, '..', 'fixtures', 'elog', 'sample', 'Fifo1-#0.elog');

/** Every eventlog entry in the (unfiltered) log, in event order, "E" line then its following entries, event by event forward. */
function collectAllEntries(eventLog: EventLog): EventLogEntry[] {
  const result: EventLogEntry[] = [];
  let event = eventLog.getFirstEvent();
  while (event !== null) {
    for (let i = 0; i < event.getNumEventLogEntries(); i++) result.push(event.getEventLogEntry(i));
    event = event.getNextEvent();
  }
  return result;
}

/**
 * Independent re-derivation of `EventLogTableFacade.matchesFilter()`'s per-mode logic
 * (from the Java source, not by calling the facade) -- the brute-force oracle these
 * tests check the facade's navigation against.
 */
function predicateFor(mode: EventLogTableFilterMode): (entry: EventLogEntry) => boolean {
  switch (mode) {
    case EventLogTableFilterMode.ALL_ENTRIES:
      return () => true;
    case EventLogTableFilterMode.EVENT_AND_SEND_AND_MESSAGE_ENTRIES:
      return (entry) => entry instanceof EventEntry || entry instanceof BeginSendEntry || entry instanceof EventLogMessageEntry;
    case EventLogTableFilterMode.EVENT_AND_MESSAGE_ENTRIES:
      return (entry) => entry instanceof EventEntry || entry instanceof EventLogMessageEntry;
    case EventLogTableFilterMode.EVENT_ENTRIES:
      return (entry) => entry instanceof EventEntry;
    case EventLogTableFilterMode.CUSTOM_ENTRIES:
      // matches the "n=~job" custom filter used below: always includes "E" lines
      // (mirrors setCustomFilter()'s own "E or (...)" wrapping), plus any entry whose
      // "n" attribute case-insensitively equals "job".
      return (entry) => {
        if (entry instanceof EventEntry) return true;
        const n = entry.getAsString('n');
        return n !== null && n.toLowerCase() === 'job';
      };
  }
}

/** Walks `getNeighbourEntry(_, +1)` from `getFirstEntry()` to `null`, collecting every visited entry. */
function walkAllMatchingEntriesForward(facade: EventLogTableFacade): EventLogEntry[] {
  const result: EventLogEntry[] = [];
  let entry = facade.getFirstEntry();
  while (entry !== null) {
    result.push(entry);
    entry = facade.getNeighbourEntry(entry, 1);
  }
  return result;
}

const ALL_BUILTIN_MODES = [
  EventLogTableFilterMode.ALL_ENTRIES,
  EventLogTableFilterMode.EVENT_AND_SEND_AND_MESSAGE_ENTRIES,
  EventLogTableFilterMode.EVENT_AND_MESSAGE_ENTRIES,
  EventLogTableFilterMode.EVENT_ENTRIES,
];

// ---------------------------------------------------------------------------------
// 1. Per-mode agreement with the brute-force predicate, over the real Fifo1 sample
//    (has BeginSendEntry/EndSendEntry/etc alongside "E" lines).
// ---------------------------------------------------------------------------------

test('EventLogTableFacade: each built-in filter mode\'s forward walk matches the brute-force predicate exactly (Fifo1 sample)', () => {
  const text = fs.readFileSync(fifoPath, 'latin1');
  const eventLog = openEventLog(text);
  const allEntries = collectAllEntries(eventLog);

  for (const mode of ALL_BUILTIN_MODES) {
    const facade = new EventLogTableFacade(eventLog);
    facade.setFilterMode(mode);
    const expected = allEntries.filter(predicateFor(mode));
    const actual = walkAllMatchingEntriesForward(facade);
    assert.deepEqual(actual, expected, `filter mode ${mode}`);
    assert.equal(actual[actual.length - 1], facade.getLastEntry(), `filter mode ${mode}: last walked entry === getLastEntry()`);
    assert.equal(actual[0], facade.getFirstEntry(), `filter mode ${mode}: first walked entry === getFirstEntry()`);
  }
});

// ---------------------------------------------------------------------------------
// 2. A synthesized log with a filler "-" (EventLogMessageEntry) line per event, so
//    EVENT_AND_MESSAGE_ENTRIES/EVENT_AND_SEND_AND_MESSAGE_ENTRIES actually exercise the
//    EventLogMessageEntry branch, not just EventEntry/BeginSendEntry.
// ---------------------------------------------------------------------------------

test('EventLogTableFacade: each built-in filter mode agrees with the brute-force predicate on a synthesized log with EventLogMessageEntry ("-") lines', () => {
  const { text } = synthesizeEventLog({ eventCount: 40, fillerBytesPerEvent: 5 });
  const eventLog = openEventLog(text);
  const allEntries = collectAllEntries(eventLog);
  assert.ok(allEntries.some((e) => e instanceof EventLogMessageEntry), 'fixture sanity: must contain at least one EventLogMessageEntry');

  for (const mode of ALL_BUILTIN_MODES) {
    const facade = new EventLogTableFacade(eventLog);
    facade.setFilterMode(mode);
    const expected = allEntries.filter(predicateFor(mode));
    const actual = walkAllMatchingEntriesForward(facade);
    assert.deepEqual(actual, expected, `filter mode ${mode}`);
  }
});

// ---------------------------------------------------------------------------------
// 3. CUSTOM_ENTRIES with a MatchExpression matching BeginSendEntry rows by field.
// ---------------------------------------------------------------------------------

test('EventLogTableFacade: CUSTOM_ENTRIES with a MatchExpression ("n=~job") agrees with the independent predicate (Fifo1 sample)', () => {
  const text = fs.readFileSync(fifoPath, 'latin1');
  const eventLog = openEventLog(text);
  const allEntries = collectAllEntries(eventLog);
  // fixture sanity: the pattern must actually select a proper, non-trivial subset
  assert.ok(allEntries.some((e) => e instanceof BeginSendEntry && e.messageName === 'job'));
  assert.ok(allEntries.some((e) => e instanceof BeginSendEntry && e.messageName !== 'job'));

  const facade = new EventLogTableFacade(eventLog);
  facade.setFilterMode(EventLogTableFilterMode.CUSTOM_ENTRIES);
  facade.setCustomFilter('n=~job');

  const expected = allEntries.filter(predicateFor(EventLogTableFilterMode.CUSTOM_ENTRIES));
  const actual = walkAllMatchingEntriesForward(facade);
  assert.deepEqual(actual, expected);
});

// ---------------------------------------------------------------------------------
// 4. navigate(+n) then (-n) returns to the start (random n fuzz), per filter mode.
// ---------------------------------------------------------------------------------

test('EventLogTableFacade: getNeighbourEntry(+n) then getNeighbourEntry(-n) returns to the start (fuzz), per filter mode', () => {
  const { text } = synthesizeEventLog({ eventCount: 60, fillerBytesPerEvent: 3 });
  const eventLog = openEventLog(text);
  const rnd = mulberry32(42);

  for (const mode of ALL_BUILTIN_MODES) {
    const facade = new EventLogTableFacade(eventLog);
    facade.setFilterMode(mode);
    const matching = walkAllMatchingEntriesForward(facade);
    assert.ok(matching.length > 10, `filter mode ${mode}: fixture too small to fuzz meaningfully`);

    for (let trial = 0; trial < 40; trial++) {
      const maxN = Math.floor(matching.length / 3);
      const n = 1 + Math.floor(rnd() * maxN);
      const startIndex = n + Math.floor(rnd() * (matching.length - 2 * n));
      const start = matching[startIndex];

      const forward = facade.getNeighbourEntry(start, n);
      assert.notEqual(forward, null, `filter mode ${mode}: forward(+${n}) from index ${startIndex} should stay in range`);
      const back = facade.getNeighbourEntry(forward!, -n);
      assert.equal(back, start, `filter mode ${mode}: round trip +${n}/-${n} from index ${startIndex}`);
    }
  }
});

// ---------------------------------------------------------------------------------
// 5. getApproximateEventLogEntryAt(0)/(1) === first/last entry; percentage monotonicity.
// ---------------------------------------------------------------------------------

test('EventLogTableFacade: getApproximateEventLogEntryAt(0)/(1) match getFirstEntry()/getLastEntry()', () => {
  const text = fs.readFileSync(fifoPath, 'latin1');
  const eventLog = openEventLog(text);
  const facade = new EventLogTableFacade(eventLog);

  assert.equal(facade.getApproximateEventLogEntryAt(0), facade.getFirstEntry());
  assert.equal(facade.getApproximateEventLogEntryAt(1), facade.getLastEntry());
});

test('EventLogTableFacade: getApproximatePercentageForEntry() is monotonically non-decreasing along a forward walk', () => {
  const { text } = synthesizeEventLog({ eventCount: 80, fillerBytesPerEvent: 2 });
  const eventLog = openEventLog(text);
  const facade = new EventLogTableFacade(eventLog);
  facade.setFilterMode(EventLogTableFilterMode.EVENT_AND_MESSAGE_ENTRIES);

  const entries = walkAllMatchingEntriesForward(facade);
  let previousPercentage = -1;
  for (const entry of entries) {
    const percentage = facade.getApproximatePercentageForEntry(entry);
    assert.ok(percentage >= previousPercentage - 1e-9, 'percentage must be non-decreasing along the forward walk');
    assert.ok(percentage >= 0 && percentage <= 1, 'percentage must be within [0,1]');
    previousPercentage = percentage;
  }
});

test('EventLogTableFacade: getApproximateEventLogEntryAt() spot-check percentages agree with a coarse monotonic sweep', () => {
  const { text } = synthesizeEventLog({ eventCount: 200, fillerBytesPerEvent: 2 });
  const eventLog = openEventLog(text);
  const facade = new EventLogTableFacade(eventLog);

  let previousPercentage = -1;
  for (let i = 0; i <= 10; i++) {
    const percentage = i / 10;
    const entry = facade.getApproximateEventLogEntryAt(percentage);
    assert.notEqual(entry, null);
    const resolvedPercentage = facade.getApproximatePercentageForEntry(entry!);
    assert.ok(resolvedPercentage >= previousPercentage - 1e-6, `getApproximateEventLogEntryAt(${percentage}) should not regress`);
    previousPercentage = resolvedPercentage;
  }
});
