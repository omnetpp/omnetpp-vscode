import { test } from 'bun:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { BigDecimal } from '../../eventlog/bigDecimal';
import { FileReader } from '../../eventlog/fileReader';
import { NodeRandomAccessFile } from '../../node/nodeRandomAccessFile';
import { TestEventLog, fileReaderForContent } from './testEventLogHelper';
import type { BeginSendEntry, EventEntry } from '../../eventlog/entries';

const fifoPath = resolve(__dirname, '..', 'fixtures', 'elog', 'sample', 'Fifo1-#0.elog');

function openFifo(): TestEventLog {
  const reader = new FileReader(new NodeRandomAccessFile(fifoPath));
  return new TestEventLog(reader);
}

// ---------------------------------------------------------------------------------
// Whole-file iteration: monotonic event numbers/simulation times, entry-level
// invariants, offset contiguity.
// ---------------------------------------------------------------------------------

test('event: iterating Fifo1-#0.elog yields monotonically increasing event numbers and simulation times', () => {
  const eventLog = openFifo();
  let event = eventLog.getFirstEvent();
  assert.ok(event, 'expected a first event');
  let previousEventNumber = -1;
  let previousSimulationTime: BigDecimal | null = null;
  let count = 0;
  while (event !== null) {
    assert.ok(event.getEventNumber() > previousEventNumber, `event numbers must strictly increase (${previousEventNumber} -> ${event.getEventNumber()})`);
    if (previousSimulationTime !== null) assert.ok(event.getSimulationTime().greaterOrEqual(previousSimulationTime), 'simulation time must never decrease');
    previousEventNumber = event.getEventNumber();
    previousSimulationTime = event.getSimulationTime();
    count++;
    event = event.getNextEvent();
  }
  assert.equal(count, 33, 'Fifo1-#0.elog has events #0..#32');
  assert.equal(previousEventNumber, 32);
});

test('event: getEventEntry() is the first entry of every event, and every parsed entry knows its owning event', () => {
  const eventLog = openFifo();
  let event = eventLog.getFirstEvent();
  while (event !== null) {
    assert.ok(event.getNumEventLogEntries() >= 1);
    assert.equal(event.getEventLogEntry(0), event.getEventEntry());
    for (let i = 0; i < event.getNumEventLogEntries(); i++) {
      const entry = event.getEventLogEntry(i);
      assert.equal(entry.getEvent(), event, `entry ${i} of event #${event.getEventNumber()} should report this event as its owner`);
      assert.equal(entry.getEventNumber(), event.getEventNumber());
      assert.ok(entry.getSimulationTime().equals(event.getSimulationTime()));
    }
    event = event.getNextEvent();
  }
});

test('event: offsets are contiguous — endOffset of one event equals beginOffset of the next (one blank-line separator)', () => {
  const eventLog = openFifo();
  let event = eventLog.getFirstEvent()!;
  let next = event.getNextEvent();
  while (next !== null) {
    assert.equal(event.getEndOffset(), next.getBeginOffset(), `event #${event.getEventNumber()}'s endOffset should equal event #${next.getEventNumber()}'s beginOffset`);
    event = next;
    next = event.getNextEvent();
  }
});

test('event: getPreviousEvent()/getNextEvent() are inverse and terminate with null at the ends', () => {
  const eventLog = openFifo();
  const first = eventLog.getFirstEvent()!;
  assert.equal(first.getPreviousEvent(), null);
  const last = eventLog.getLastEvent()!;
  assert.equal(last.getNextEvent(), null);

  let event = first;
  while (event.getNextEvent() !== null) {
    const next = event.getNextEvent()!;
    assert.equal(next.getPreviousEvent(), event, 'getPreviousEvent() should invert getNextEvent()');
    event = next;
  }
  assert.equal(event.getEventNumber(), last.getEventNumber());
});

// ---------------------------------------------------------------------------------
// Spot-checks against the raw file text for a couple of known events.
// ---------------------------------------------------------------------------------

test('event: event #0 (the initialize event) fields and entry composition, cross-checked against the raw file', () => {
  const eventLog = openFifo();
  const event0 = eventLog.getEventForEventNumber(0)!;
  assert.equal(event0.getEventNumber(), 0);
  assert.ok(event0.getSimulationTime().equals(BigDecimal.ZERO));
  assert.equal(event0.getModuleId(), 1);
  assert.equal(event0.getCauseEventNumber(), -1);
  assert.equal(event0.getMessageId(), -1);
  assert.equal(event0.getModuleDescriptionEntry().fullName, 'SingleQueue');

  // raw lines from "E # 0 ..." itself (eventLogEntries[0] === getEventEntry()) through
  // "CME" just before the blank line before "E # 1" is 1 (the "E" line) + 24 = 25 entries:
  // E MC MDC MC GC MDC MC GC GC MDC MC GC MDC CC CC CMB CM BS ES CME CMB CM CME CMB CME
  assert.equal(event0.getNumEventLogEntries(), 25);
  assert.equal(event0.getEventLogEntry(0), event0.getEventEntry());
  assert.equal(event0.getNumBeginSendEntries(), 1); // one "BS" line (sendMessageEvent, id 0)
  assert.equal(event0.getNumEventLogMessages(), 0); // no "- ..." free-text lines in event #0
});

test('event: event #1 message-send accessors (two BS entries: "job" via a connection, "sendMessageEvent" a self-message)', () => {
  const eventLog = openFifo();
  const event1 = eventLog.getEventForEventNumber(1)!;
  assert.equal(event1.getEventNumber(), 1);
  assert.ok(event1.getSimulationTime().equals(BigDecimal.ZERO));
  assert.equal(event1.getModuleId(), 2);
  assert.equal(event1.getCauseEventNumber(), 0);
  assert.equal(event1.getMessageId(), 0);
  // eventLogEntries: [0]=E [1]=CM(job,id2) [2]=BS(job,id2) [3]=SH [4]=ES(job,id2) [5]=BS(sendMessageEvent,id0) [6]=ES(id0)
  assert.equal(event1.getNumEventLogEntries(), 7);
  assert.equal(event1.getNumBeginSendEntries(), 2);

  // "job" (id 2): sent through a connection (SH in between) -- not a self-message.
  const jobBeginSendIndex = event1.findBeginSendEntryIndex(2);
  assert.equal(jobBeginSendIndex, 2);
  const jobBeginSendEntry = event1.getEventLogEntry(jobBeginSendIndex) as BeginSendEntry;
  assert.equal(jobBeginSendEntry.messageId, 2);
  assert.equal(event1.isSelfMessage(jobBeginSendEntry), false);
  const jobEndSend = event1.getEndSendEntry(jobBeginSendEntry);
  assert.ok(jobEndSend);
  assert.equal(jobEndSend!.messageId, 2);

  // "sendMessageEvent" (id 0): BS immediately followed by its own ES -- a self-message
  // (module 2 rescheduling its own periodic generator; "sm 2 ... am 2" in the raw text).
  const selfBeginSendIndex = event1.findBeginSendEntryIndex(0);
  assert.equal(selfBeginSendIndex, 5);
  const selfBeginSendEntry = event1.getEventLogEntry(selfBeginSendIndex) as BeginSendEntry;
  assert.equal(event1.isSelfMessage(selfBeginSendEntry), true);
});

test('event: getEventLogEntry()/getEventLogMessage() bounds and EventEntry field access', () => {
  const eventLog = openFifo();
  const event1 = eventLog.getEventForEventNumber(1)!;
  const eventEntry = event1.getEventEntry() as EventEntry;
  assert.equal(eventEntry.eventNumber, 1);
  assert.equal(eventEntry.moduleId, 2);
  assert.throws(() => event1.getEventLogMessage(0), /Index out of range|out of range/);
});

// ---------------------------------------------------------------------------------
// synchronize()/print()
// ---------------------------------------------------------------------------------

test('event: print() renders entries without their trailing newline, one per line, and omits messages when asked', () => {
  const eventLog = openFifo();
  const event1 = eventLog.getEventForEventNumber(1)!;
  const withMessages = event1.print(true);
  const withoutMessages = event1.print(false);
  assert.equal(withMessages, withoutMessages); // event #1 has no "-" message lines
  const lines = withMessages.split('\n');
  assert.equal(lines.length, event1.getNumEventLogEntries());
  assert.ok(lines[0].startsWith('E ')); // eventLogEntries[0] is the EventEntry ("E" line) itself
  assert.ok(lines[1].startsWith('CM '));
});

// ---------------------------------------------------------------------------------
// A synthesized fixture exercising a self-message (BS immediately followed by ES in
// the same event) — Fifo1 never self-schedules, so isSelfMessage()'s true branch
// needs a small hand-built file (per the phase task: modern-format content, no
// legacy codes).
// ---------------------------------------------------------------------------------

test('event: isSelfMessage() is true when a BS is immediately followed by its own ES', () => {
  const content = [
    'SB ov 1536 ev 2 rid Test-0',
    '',
    'E # 0 t 0 m 1 ce -1 msg -1',
    'CM id 0 tid 0 eid 0 etid 0 c cMessage n timer pe -1',
    'BS id 0 tid 0 eid 0 etid 0 c cMessage n timer m 1 pe 0',
    'ES id 0 tid 0 eid 0 etid 0 c cMessage n timer sm 1 st 0 am 1 at 1 pe 0',
    '',
    'E # 1 t 1 m 1 ce 0 msg 0',
    '',
    'SE e 0 c 9 m "done"',
    '',
  ].join('\n');
  const eventLog = new TestEventLog(fileReaderForContent(content));
  const event0 = eventLog.getEventForEventNumber(0)!;
  const beginSendIndex = event0.findBeginSendEntryIndex(0);
  const beginSendEntry = event0.getEventLogEntry(beginSendIndex) as BeginSendEntry;
  assert.equal(event0.isSelfMessage(beginSendEntry), true);

  const event1 = eventLog.getEventForEventNumber(1)!;
  assert.equal(event1.isSelfMessageProcessingEvent(), true);
});
