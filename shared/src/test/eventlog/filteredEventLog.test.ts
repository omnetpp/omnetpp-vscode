/**
 * Phase E5 test suite: `FilteredEventLog`/`FilteredEvent` (shared/src/eventlog/
 * filteredEventLog.ts, filteredEvent.ts). Every filter dimension is checked against a
 * naive full-scan predicate or a hand-derived expected set computed directly from the
 * underlying (unfiltered) `EventLog`, not against `FilteredEventLog`'s own internals --
 * so these tests exercise the caching/directional-search machinery
 * (`getMatchingEventInDirection`, forward/backward neighbour walking,
 * `getEventForEventNumber` under every `MatchKind`), not just "does the predicate
 * look right".
 */

import { test } from 'bun:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { BeginSendEntry } from '../../eventlog/entries';
import { EventLog } from '../../eventlog/eventLog';
import type { Event } from '../../eventlog/event';
import { FileReader } from '../../eventlog/fileReader';
import { FilteredEvent } from '../../eventlog/filteredEvent';
import { FilteredEventLog } from '../../eventlog/filteredEventLog';
import { FilteredMessageDependency } from '../../eventlog/messageDependency';
import { MatchKind } from '../../eventlog/enums';
import type { IEvent } from '../../eventlog/ieventlog';
import { NodeRandomAccessFile } from '../../node/nodeRandomAccessFile';
import { fileReaderForContent } from './testEventLogHelper';
import { synthesizeEventLog } from './synthesizeEventLog';

function openEventLog(text: string): EventLog {
  return new EventLog(fileReaderForContent(text));
}

/** Collects every event number in the (unfiltered) log, forward, via `getNextEvent()`. */
function allEventNumbers(eventLog: EventLog): number[] {
  const result: number[] = [];
  let event: Event | null = eventLog.getFirstEvent();
  while (event !== null) {
    result.push(event.getEventNumber());
    event = event.getNextEvent();
  }
  return result;
}

/** Collects every event number the filtered view considers matching, forward, via `getNextEvent()`. */
function filteredEventNumbersForward(filteredLog: FilteredEventLog): number[] {
  const result: number[] = [];
  let event: FilteredEvent | null = filteredLog.getFirstEvent();
  while (event !== null) {
    result.push(event.getEventNumber());
    event = event.getNextEvent();
  }
  return result;
}

/** Same as `filteredEventNumbersForward()`, but walking backward from `getLastEvent()`. */
function filteredEventNumbersBackward(filteredLog: FilteredEventLog): number[] {
  const result: number[] = [];
  let event: FilteredEvent | null = filteredLog.getLastEvent();
  while (event !== null) {
    result.push(event.getEventNumber());
    event = event.getPreviousEvent();
  }
  return result;
}

// ---------------------------------------------------------------------------------
// 1. Event range + exclusion filter, vs. a brute-force predicate.
// ---------------------------------------------------------------------------------

test('FilteredEventLog: event range (first/lastConsideredEventNumber) + excludedEventNumbers matches a brute-force predicate, forward and backward', () => {
  const { text } = synthesizeEventLog({ eventCount: 30 });
  const eventLog = openEventLog(text);
  const all = allEventNumbers(eventLog);
  assert.equal(all.length, 30);

  const first = 5;
  const last = 20;
  const excluded = [7, 13, 20];
  const expected = all.filter((n) => n >= first && n <= last && !excluded.includes(n));

  const filteredLog = new FilteredEventLog(eventLog);
  filteredLog.setFirstConsideredEventNumber(first);
  filteredLog.setLastConsideredEventNumber(last);
  filteredLog.setExcludedEventNumbers(excluded);

  assert.deepEqual(filteredEventNumbersForward(filteredLog), expected);
  assert.deepEqual(filteredEventNumbersBackward(filteredLog), [...expected].reverse());

  assert.equal(filteredLog.getFirstEventNumber(), expected[0]);
  assert.equal(filteredLog.getLastEventNumber(), expected[expected.length - 1]);

  // getEventForEventNumber(EXACT): matches iff in the expected set.
  for (const n of [4, 5, 7, 8, 13, 20, 21, 25]) {
    const found = filteredLog.getEventForEventNumber(n, MatchKind.EXACT);
    assert.equal(found !== null, expected.includes(n), `event ${n}`);
    if (found !== null) assert.equal(found.getEventNumber(), n);
  }

  // isIncludedInLog() (inherited from EventLogBase, driven by the overridden getEventForEventNumber()).
  for (const n of [4, 5, 7, 20, 21]) assert.equal(filteredLog.isIncludedInLog(n), expected.includes(n));

  // FIRST_OR_NEXT / LAST_OR_PREVIOUS land on the nearest expected neighbour of an excluded/out-of-range number.
  assert.equal(filteredLog.getEventForEventNumber(7, MatchKind.FIRST_OR_NEXT)!.getEventNumber(), 8);
  assert.equal(filteredLog.getEventForEventNumber(7, MatchKind.LAST_OR_PREVIOUS)!.getEventNumber(), 6);
  assert.equal(filteredLog.getEventForEventNumber(2, MatchKind.FIRST_OR_NEXT)!.getEventNumber(), first);
  // 25 is out of range and past `last`(20), which is itself excluded -- nearest included is 19.
  assert.equal(filteredLog.getEventForEventNumber(25, MatchKind.LAST_OR_PREVIOUS)!.getEventNumber(), expected[expected.length - 1]);

  // getNeighbourEvent() (EventLogBase default, exercised through the filtered getNextEvent/getPreviousEvent chain).
  const firstFiltered = filteredLog.getFirstEvent()!;
  assert.equal(filteredLog.getNeighbourEvent(firstFiltered, 2)!.getEventNumber(), expected[2]);
  const lastFiltered = filteredLog.getLastEvent()!;
  assert.equal(filteredLog.getNeighbourEvent(lastFiltered, -2)!.getEventNumber(), expected[expected.length - 3]);
});

// ---------------------------------------------------------------------------------
// 2 & 3. Module filter (by id) and message filter (by name), on the real sample fixture.
// Fifo1-#0.elog: module 1 = SingleQueue (compound), 2 = source, 3 = fifo, 4 = sink
// (all leaves are direct children of the compound root -- no ancestor-chain matching
// is exercised here, that's covered separately below with a synthesized fixture).
// ---------------------------------------------------------------------------------

const fifoPath = resolve(__dirname, '..', 'fixtures', 'elog', 'sample', 'Fifo1-#0.elog');

function openFifoEventLog(): EventLog {
  return new EventLog(new FileReader(new NodeRandomAccessFile(fifoPath)));
}

test('FilteredEventLog: module filter by id (moduleIds) matches a brute-force predicate over getModuleId()', () => {
  const eventLog = openFifoEventLog();
  const all = allEventNumbers(eventLog);
  const expected = all.filter((n) => eventLog.getEventForEventNumber(n)!.getModuleId() === 4); // sink only

  const filteredLog = new FilteredEventLog(eventLog);
  filteredLog.setEnableModuleFilter(true);
  filteredLog.setModuleIds([4]);

  assert.ok(expected.length > 0);
  assert.deepEqual(filteredEventNumbersForward(filteredLog), expected);
  assert.deepEqual(filteredEventNumbersBackward(filteredLog), [...expected].reverse());
});

test('FilteredEventLog: module filter by NED type name expression matches the same set as the equivalent moduleIds filter', () => {
  const eventLog = openFifoEventLog();
  const byIds = new FilteredEventLog(eventLog);
  byIds.setEnableModuleFilter(true);
  byIds.setModuleIds([4]);

  const byExpression = new FilteredEventLog(openFifoEventLog());
  byExpression.setEnableModuleFilter(true);
  byExpression.setModuleExpression('t=~Sink'); // "t" = ModuleDescriptionEntry's nedTypeName

  assert.deepEqual(filteredEventNumbersForward(byExpression), filteredEventNumbersForward(byIds));
});

test('FilteredEventLog: module filter by moduleClassNames pattern', () => {
  const eventLog = openFifoEventLog();
  const all = allEventNumbers(eventLog);
  const expected = all.filter((n) => eventLog.getEventForEventNumber(n)!.getModuleDescriptionEntry().moduleClassName === 'fifo::Fifo');

  const filteredLog = new FilteredEventLog(eventLog);
  filteredLog.setEnableModuleFilter(true);
  filteredLog.setModuleClassNames(['fifo::Fifo']);

  assert.ok(expected.length > 0);
  assert.deepEqual(filteredEventNumbersForward(filteredLog), expected);
});

function eventHasMessageName(event: IEvent, name: string): boolean {
  const cause = event.getCauseBeginSendEntry();
  if (cause !== null && cause.messageName === name) return true;
  for (let i = 0; i < event.getNumEventLogEntries(); i++) {
    const entry = event.getEventLogEntry(i);
    if (entry instanceof BeginSendEntry && entry.messageName === name) return true;
  }
  return false;
}

test('FilteredEventLog: message filter by name (messageNames) matches a brute-force predicate', () => {
  const eventLog = openFifoEventLog();
  const all = allEventNumbers(eventLog);
  const expected = all.filter((n) => eventHasMessageName(eventLog.getEventForEventNumber(n)!, 'end-service'));

  const filteredLog = new FilteredEventLog(eventLog);
  filteredLog.setEnableMessageFilter(true);
  filteredLog.setMessageNames(['end-service']);

  assert.ok(expected.length > 0);
  assert.deepEqual(filteredEventNumbersForward(filteredLog), expected);
  assert.deepEqual(filteredEventNumbersBackward(filteredLog), [...expected].reverse());
});

test('FilteredEventLog: message filter by class name and by id agree with a brute-force predicate', () => {
  const eventLog = openFifoEventLog();
  const all = allEventNumbers(eventLog);

  // messageIds=[1] -- the "end-service" self-timer's message id in this fixture
  const expectedById = all.filter((n) => {
    const event = eventLog.getEventForEventNumber(n)!;
    const cause = event.getCauseBeginSendEntry();
    if (cause !== null && cause.messageId === 1) return true;
    for (let i = 0; i < event.getNumEventLogEntries(); i++) {
      const entry = event.getEventLogEntry(i);
      if (entry instanceof BeginSendEntry && entry.messageId === 1) return true;
    }
    return false;
  });

  const byId = new FilteredEventLog(eventLog);
  byId.setEnableMessageFilter(true);
  byId.setMessageIds([1]);
  assert.deepEqual(filteredEventNumbersForward(byId), expectedById);

  // all messages in this fixture share class name "omnetpp::cMessage" -> matches everything with a BeginSendEntry-bearing message reference
  const byClassName = new FilteredEventLog(openFifoEventLog());
  byClassName.setEnableMessageFilter(true);
  byClassName.setMessageClassNames(['omnetpp::cMessage']);
  const expectedByClass = all.filter((n) => {
    const event = eventLog.getEventForEventNumber(n)!;
    const cause = event.getCauseBeginSendEntry();
    if (cause !== null && cause.messageClassName === 'omnetpp::cMessage') return true;
    for (let i = 0; i < event.getNumEventLogEntries(); i++) {
      const entry = event.getEventLogEntry(i);
      if (entry instanceof BeginSendEntry && entry.messageClassName === 'omnetpp::cMessage') return true;
    }
    return false;
  });
  assert.deepEqual(filteredEventNumbersForward(byClassName), expectedByClass);
});

// ---------------------------------------------------------------------------------
// 2b. Module filter's ancestor-chain walk (compound module matching) -- needs a
// synthesized fixture with real nesting, since Fifo1's leaves are all direct children
// of one compound module.
//
// NOTE on a genuinely surprising (but literally-ported) control-flow quirk in
// `matchesEvent()`'s ancestor-chain `while` loop (`FilteredEventLog.java`,
// `matchesEvent()`): reaching a compound ancestor that matches the module filter does
// NOT by itself stop the walk / accept the event -- the loop only stops (accepting,
// since `moduleDescriptionEntry` ends up non-null) via (a) matching the event's OWN
// module directly (`break`), or (b) finding that some cause/consequence of the event
// escapes *outside* the matched ancestor's subtree (`break OUTER`, from inside the
// crossing-check `for` loops). If a compound ancestor matches and NO crossing is
// found, the loop falls through and keeps climbing toward the root, same as a
// non-match -- meaning a "clean" compound-ancestor match with no escaping
// dependencies is actually *not* enough on its own to admit the event, while finding
// an escaping cause/consequence paradoxically *is* enough (because that's the only
// other path that leaves `moduleDescriptionEntry` non-null when the loop stops).
// This looks backwards from the class's own doc comment's intent ("check if the event
// has a cause or consequence referring outside the matching compound module" reads
// like it should *reject* on a crossing, not accept), but there is no C++ original to
// cross-check this Java-only class against, so per the port plan ("port BEHAVIOR, not
// appearance") this is ported literally rather than "fixed". The tests below assert
// the literal (quirky) behavior, not the more intuitive one.
// ---------------------------------------------------------------------------------

function ancestorFixtureText(): string {
  const lines: string[] = [
    'SB ov 1536 ev 2 rid Test-0',
    '',
    'E # 0 t 0 m 1 ce -1 msg -1',
    'MC id 1 c cModule t Root n root cm 1',
    'MC id 2 c cModule t Mid n mid pid 1 cm 1', // compound, child of root
    'MC id 3 c cModule t Leaf n leaf pid 2', // leaf, child of "mid"
    'MC id 4 c cModule t Other n other pid 1', // leaf, sibling of "mid" directly under root
    '',
    // #1: in "leaf" (under "mid"), no causes/consequences at all -- a "clean" compound
    // match with nothing to check -> per the quirk above, still NOT accepted (falls
    // through, climbs past "mid" all the way to null).
    'E # 1 t 0 m 3 ce -1 msg -1',
    '',
    // #2: in "leaf" (under "mid") again, but sends a message that arrives OUTSIDE
    // "mid" (in "other", a sibling under root) -> a genuine crossing -> per the quirk,
    // this IS accepted.
    'E # 2 t 1 m 3 ce -1 msg -1',
    'BS id 50 tid 50 eid 50 etid 50 c cMessage n toOther pe 2 sm 3 st 1 am 4 at 2',
    'SH sm 3 sg 0',
    'ES id 50 tid 50 eid 50 etid 50 c cMessage n toOther sm 3 sg 0 st 1 am 4 ag 0 at 2 pe 2',
    '',
    // #3: the arrival in "other" -- not under "mid" at all via its own chain -> rejected normally.
    'E # 3 t 2 m 4 ce 2 msg 50',
    '',
    'SE e 0 c 9 m "done"',
    '',
  ];
  return lines.join('\n');
}

test('FilteredEventLog: module filter, own-module direct match (unambiguous, no ancestor climbing needed)', () => {
  const eventLog = openEventLog(ancestorFixtureText());
  const filteredLog = new FilteredEventLog(eventLog);
  filteredLog.setEnableModuleFilter(true);
  filteredLog.setModuleIds([3]); // "leaf" itself

  assert.deepEqual(filteredEventNumbersForward(filteredLog), [1, 2]);
});

test('FilteredEventLog: module filter, compound-ancestor match -- see this file\'s header note above (a "clean" match with no crossing is NOT accepted; a match with an escaping cause/consequence IS)', () => {
  const eventLog = openEventLog(ancestorFixtureText());
  const filteredLog = new FilteredEventLog(eventLog);
  filteredLog.setEnableModuleFilter(true);
  filteredLog.setModuleIds([2]); // "mid", the compound ancestor of #1/#2's module ("leaf")

  assert.deepEqual(filteredEventNumbersForward(filteredLog), [2]);
});

// ---------------------------------------------------------------------------------
// 4. Trace filter: a hand-built causal graph --
//   #1 (A) --msg10--> #2 (B) --msg30--> #5 (C)              [main chain]
//                       \--msg40(self)--> #4 (self-arrival)  [self-message]
//                       (via #5's reuse of msg99) --> #7     [message reuse]
//   #1 (A) --msg20--> #3 (D)                                 [side branch, NOT under B]
//   #0 (init) and #6 (unrelated noise) are structurally disconnected from B's causal graph.
// tracedEventNumber = 2 (B) throughout.
// ---------------------------------------------------------------------------------

function traceFixtureText(): string {
  const lines: string[] = [
    'SB ov 1536 ev 2 rid Test-0',
    '',
    'E # 0 t 0 m 1 ce -1 msg -1',
    'MC id 1 c cModule t Root n root cm 1',
    '',
    // A: sends msg10 (main chain, arrives #2 @ t=1) and msg20 (side branch, arrives #3 @ t=1)
    'E # 1 t 0 m 1 ce -1 msg -1',
    'BS id 10 tid 10 eid 10 etid 10 c cMessage n toB pe 1 sm 1 st 0 am 1 at 1',
    'SH sm 1 sg 0',
    'ES id 10 tid 10 eid 10 etid 10 c cMessage n toB sm 1 sg 0 st 0 am 1 ag 0 at 1 pe 1',
    'BS id 20 tid 20 eid 20 etid 20 c cMessage n sideMsg pe 1 sm 1 st 0 am 1 at 1',
    'SH sm 1 sg 0',
    'ES id 20 tid 20 eid 20 etid 20 c cMessage n sideMsg sm 1 sg 0 st 0 am 1 ag 0 at 1 pe 1',
    '',
    // B: arrival of msg10 from A. Sends msg30 (to C, main chain, arrives #5 @ t=2) and a
    // genuine self-message msg40 (BS immediately followed by ES, no SH -- arrives #4 @ t=1.5).
    'E # 2 t 1 m 1 ce 1 msg 10',
    'BS id 30 tid 30 eid 30 etid 30 c cMessage n toC pe 2 sm 1 st 1 am 1 at 2',
    'SH sm 1 sg 0',
    'ES id 30 tid 30 eid 30 etid 30 c cMessage n toC sm 1 sg 0 st 1 am 1 ag 0 at 2 pe 2',
    'BS id 40 tid 40 eid 40 etid 40 c cMessage n selfTimer pe 2 sm 1 st 1 am 1 at 1.5',
    'ES id 40 tid 40 eid 40 etid 40 c cMessage n selfTimer sm 1 st 1 am 1 at 1.5 pe 2',
    '',
    // D: side branch, arrival of msg20 from A. Not reachable from B.
    'E # 3 t 1 m 1 ce 1 msg 20',
    '',
    // self-message arrival back at B's module (msg40 from #2)
    'E # 4 t 1.5 m 1 ce 2 msg 40',
    '',
    // C: arrival of msg30 from B (end of the main chain). Touches msg99 (fresh reference, "pe 5" == own event number -- not a reuse yet).
    'E # 5 t 2 m 1 ce 2 msg 30',
    'CM id 99 tid 99 eid 99 etid 99 c cMessage n reusable pe 5',
    '',
    // unrelated noise event, structurally disconnected from everything above
    'E # 6 t 3 m 1 ce -1 msg -1',
    '',
    // reuse of msg99 (created/touched at #5) -- previousEventNumber (pe) = 5, != this event's own number (7)
    'E # 7 t 4 m 1 ce -1 msg -1',
    'CM id 99 tid 99 eid 99 etid 99 c cMessage n reusable pe 5',
    '',
    'SE e 0 c 9 m "done"',
    '',
  ];
  return lines.join('\n');
}

function traceFilteredEventNumbers(eventLog: EventLog, configure: (filteredLog: FilteredEventLog) => void): number[] {
  const filteredLog = new FilteredEventLog(eventLog);
  filteredLog.setTracedEventNumber(2);
  configure(filteredLog);
  return filteredEventNumbersForward(filteredLog);
}

test('FilteredEventLog: trace filter, causes only', () => {
  const eventLog = openEventLog(traceFixtureText());
  const result = traceFilteredEventNumbers(eventLog, (f) => {
    f.setTraceCauses(true);
    f.setTraceConsequences(false);
  });
  assert.deepEqual(result, [1, 2]);
});

test('FilteredEventLog: trace filter, consequences only (default self-message/reuse toggles: both true)', () => {
  const eventLog = openEventLog(traceFixtureText());
  const result = traceFilteredEventNumbers(eventLog, (f) => {
    f.setTraceCauses(false);
    f.setTraceConsequences(true);
  });
  assert.deepEqual(result, [2, 4, 5, 7]);
});

test('FilteredEventLog: trace filter, consequences only, traceSelfMessages=false excludes the self-message arrival (#4) but keeps the rest', () => {
  const eventLog = openEventLog(traceFixtureText());
  const result = traceFilteredEventNumbers(eventLog, (f) => {
    f.setTraceCauses(false);
    f.setTraceConsequences(true);
    f.setTraceSelfMessages(false);
  });
  assert.deepEqual(result, [2, 5, 7]);
});

test('FilteredEventLog: trace filter, consequences only, traceMessageReuses=false excludes the reuse (#7) but keeps the rest', () => {
  const eventLog = openEventLog(traceFixtureText());
  const result = traceFilteredEventNumbers(eventLog, (f) => {
    f.setTraceCauses(false);
    f.setTraceConsequences(true);
    f.setTraceMessageReuses(false);
  });
  assert.deepEqual(result, [2, 4, 5]);
});

test('FilteredEventLog: trace filter, consequences only, both toggles off leaves only the direct (non-self, non-reuse) chain', () => {
  const eventLog = openEventLog(traceFixtureText());
  const result = traceFilteredEventNumbers(eventLog, (f) => {
    f.setTraceCauses(false);
    f.setTraceConsequences(true);
    f.setTraceSelfMessages(false);
    f.setTraceMessageReuses(false);
  });
  assert.deepEqual(result, [2, 5]);
});

test('FilteredEventLog: trace filter, both causes and consequences (default toggles)', () => {
  const eventLog = openEventLog(traceFixtureText());
  const result = traceFilteredEventNumbers(eventLog, (f) => {
    f.setTraceCauses(true);
    f.setTraceConsequences(true);
  });
  assert.deepEqual(result, [1, 2, 4, 5, 7]);
});

test('FilteredEventLog: trace filter never includes the disconnected init event (#0), the side branch (#3), or the unrelated noise event (#6), under any toggle combination', () => {
  const eventLog = openEventLog(traceFixtureText());
  for (const causes of [true, false]) {
    for (const consequences of [true, false]) {
      for (const selfMessages of [true, false]) {
        for (const reuses of [true, false]) {
          const result = traceFilteredEventNumbers(openEventLog(traceFixtureText()), (f) => {
            f.setTraceCauses(causes);
            f.setTraceConsequences(consequences);
            f.setTraceSelfMessages(selfMessages);
            f.setTraceMessageReuses(reuses);
          });
          for (const excluded of [0, 3, 6]) assert.ok(!result.includes(excluded), `causes=${causes} consequences=${consequences} self=${selfMessages} reuses=${reuses}`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------------
// 5. FilteredEvent dependency mapping: getCauses()/getConsequences() build a
// FilteredMessageDependency spanning an excluded intermediate event ("gap"), by
// forwarding the SAME message identity (id/tid/eid/etid) across the gap -- the
// MessageDependencyBase.corresponds() check that makes gap-spanning possible.
// ---------------------------------------------------------------------------------

/** A -> B -> C, all forwarding message id/tid/eid/etid = 5 (same message, just relayed). */
function simpleGapFixtureText(): string {
  const lines: string[] = [
    'SB ov 1536 ev 2 rid Test-0',
    '',
    'E # 0 t 0 m 1 ce -1 msg -1',
    'MC id 1 c cModule t Root n root cm 1',
    '',
    'E # 1 t 0 m 1 ce -1 msg -1',
    'BS id 5 tid 5 eid 5 etid 5 c cMessage n msg5 pe 1 sm 1 st 0 am 1 at 1',
    'SH sm 1 sg 0',
    'ES id 5 tid 5 eid 5 etid 5 c cMessage n msg5 sm 1 sg 0 st 0 am 1 ag 0 at 1 pe 1',
    '',
    'E # 2 t 1 m 1 ce 1 msg 5',
    'BS id 5 tid 5 eid 5 etid 5 c cMessage n msg5 pe 2 sm 1 st 1 am 1 at 2',
    'SH sm 1 sg 0',
    'ES id 5 tid 5 eid 5 etid 5 c cMessage n msg5 sm 1 sg 0 st 1 am 1 ag 0 at 2 pe 2',
    '',
    'E # 3 t 2 m 1 ce 2 msg 5',
    '',
    'SE e 0 c 9 m "done"',
    '',
  ];
  return lines.join('\n');
}

test('FilteredEvent: getConsequences()/getCauses() build a FilteredMessageDependency spanning an excluded intermediate event', () => {
  const eventLog = openEventLog(simpleGapFixtureText());
  const filteredLog = new FilteredEventLog(eventLog);
  filteredLog.setExcludedEventNumbers([2]); // B is filtered out

  const a = filteredLog.getEventForEventNumber(1)!;
  const aConsequences = a.getConsequences();
  assert.equal(aConsequences.length, 1);
  assert.ok(aConsequences[0] instanceof FilteredMessageDependency);
  assert.equal(aConsequences[0].getCauseEventNumber(), 1);
  assert.equal(aConsequences[0].getConsequenceEventNumber(), 3);

  const c = filteredLog.getEventForEventNumber(3)!;
  const cCauses = c.getCauses();
  assert.equal(cCauses.length, 1);
  assert.ok(cCauses[0] instanceof FilteredMessageDependency);
  assert.equal(cCauses[0].getCauseEventNumber(), 1);
  assert.equal(cCauses[0].getConsequenceEventNumber(), 3);
});

/**
 * A -> X1 -> X2 -> X3 -> Z (events #1..#5), all relaying the same message
 * (id/tid/eid/etid = 5); X1/X2/X3 (#2/#3/#4) excluded. Reaching #5 (Z) requires
 * pushing a breadth-search item for each of the 3 excluded hops in turn -- pushing
 * the item for X3 (#4) requires `level(2) < maximumConsequenceDepth`, i.e.
 * `maximumConsequenceDepth >= 3`; #5 is then found immediately while *processing*
 * that item (no further push needed), so depth 3 is both necessary and sufficient.
 */
function deepGapFixtureText(): string {
  const lines: string[] = ['SB ov 1536 ev 2 rid Test-0', '', 'E # 0 t 0 m 1 ce -1 msg -1', 'MC id 1 c cModule t Root n root cm 1', ''];
  for (let i = 1; i <= 5; i++) {
    const t = i - 1;
    lines.push(`E # ${i} t ${t} m 1 ce ${i === 1 ? -1 : i - 1} msg ${i === 1 ? -1 : 5}`);
    if (i < 5) {
      lines.push(`BS id 5 tid 5 eid 5 etid 5 c cMessage n relay pe ${i} sm 1 st ${t} am 1 at ${t + 1}`);
      lines.push('SH sm 1 sg 0');
      lines.push(`ES id 5 tid 5 eid 5 etid 5 c cMessage n relay sm 1 sg 0 st ${t} am 1 ag 0 at ${t + 1} pe ${i}`);
    }
    lines.push('');
  }
  lines.push('SE e 0 c 9 m "done"', '');
  return lines.join('\n');
}

test('FilteredEvent: getConsequences() depth cutoff (maximumConsequenceDepth) -- 3 excluded hops need depth >= 3 to bridge', () => {
  // too shallow: never reaches the visible endpoint (#5)
  const shallow = new FilteredEventLog(openEventLog(deepGapFixtureText()));
  shallow.setExcludedEventNumbers([2, 3, 4]); // exclude the three purely-intermediate hops
  shallow.setMaximumConsequenceDepth(2);
  assert.deepEqual(shallow.getEventForEventNumber(1)!.getConsequences(), []);

  // just enough depth: bridges all the way to #5
  const deepEnough = new FilteredEventLog(openEventLog(deepGapFixtureText()));
  deepEnough.setExcludedEventNumbers([2, 3, 4]);
  deepEnough.setMaximumConsequenceDepth(3);
  const consequences = deepEnough.getEventForEventNumber(1)!.getConsequences();
  assert.equal(consequences.length, 1);
  assert.equal(consequences[0].getCauseEventNumber(), 1);
  assert.equal(consequences[0].getConsequenceEventNumber(), 5);

  // default depth (15) also succeeds
  const defaultDepth = new FilteredEventLog(openEventLog(deepGapFixtureText()));
  defaultDepth.setExcludedEventNumbers([2, 3, 4]);
  assert.equal(defaultDepth.getEventForEventNumber(1)!.getConsequences().length, 1);
});

/** A sends two independent messages (id 5 and id 6), each relayed once through an excluded hop to a distinct visible endpoint. */
function twoBranchGapFixtureText(): string {
  const lines: string[] = [
    'SB ov 1536 ev 2 rid Test-0',
    '',
    'E # 0 t 0 m 1 ce -1 msg -1',
    'MC id 1 c cModule t Root n root cm 1',
    '',
    'E # 1 t 0 m 1 ce -1 msg -1',
    'BS id 5 tid 5 eid 5 etid 5 c cMessage n branchA pe 1 sm 1 st 0 am 1 at 1',
    'SH sm 1 sg 0',
    'ES id 5 tid 5 eid 5 etid 5 c cMessage n branchA sm 1 sg 0 st 0 am 1 ag 0 at 1 pe 1',
    'BS id 6 tid 6 eid 6 etid 6 c cMessage n branchB pe 1 sm 1 st 0 am 1 at 1',
    'SH sm 1 sg 0',
    'ES id 6 tid 6 eid 6 etid 6 c cMessage n branchB sm 1 sg 0 st 0 am 1 ag 0 at 1 pe 1',
    '',
    'E # 2 t 1 m 1 ce 1 msg 5', // excluded relay for branch A
    'BS id 5 tid 5 eid 5 etid 5 c cMessage n branchA pe 2 sm 1 st 1 am 1 at 2',
    'SH sm 1 sg 0',
    'ES id 5 tid 5 eid 5 etid 5 c cMessage n branchA sm 1 sg 0 st 1 am 1 ag 0 at 2 pe 2',
    '',
    'E # 3 t 1 m 1 ce 1 msg 6', // excluded relay for branch B
    'BS id 6 tid 6 eid 6 etid 6 c cMessage n branchB pe 3 sm 1 st 1 am 1 at 2',
    'SH sm 1 sg 0',
    'ES id 6 tid 6 eid 6 etid 6 c cMessage n branchB sm 1 sg 0 st 1 am 1 ag 0 at 2 pe 3',
    '',
    'E # 4 t 2 m 1 ce 2 msg 5', // visible endpoint of branch A
    '',
    'E # 5 t 2 m 1 ce 3 msg 6', // visible endpoint of branch B
    '',
    'SE e 0 c 9 m "done"',
    '',
  ];
  return lines.join('\n');
}

test('FilteredEvent: getConsequences() count cutoff (maximumNumberOfConsequences) truncates once the limit is reached', () => {
  const uncapped = new FilteredEventLog(openEventLog(twoBranchGapFixtureText()));
  uncapped.setExcludedEventNumbers([2, 3]);
  const both = uncapped.getEventForEventNumber(1)!.getConsequences();
  assert.equal(both.length, 2);
  assert.deepEqual(
    both.map((d) => d.getConsequenceEventNumber()).sort(),
    [4, 5],
  );

  const capped = new FilteredEventLog(openEventLog(twoBranchGapFixtureText()));
  capped.setExcludedEventNumbers([2, 3]);
  capped.setMaximumNumberOfConsequences(1);
  const limited = capped.getEventForEventNumber(1)!.getConsequences();
  assert.equal(limited.length, 1);
  assert.ok(limited[0].getConsequenceEventNumber() === 4 || limited[0].getConsequenceEventNumber() === 5);
});
