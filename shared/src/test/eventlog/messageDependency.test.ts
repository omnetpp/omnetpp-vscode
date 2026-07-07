import { test } from 'bun:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { BigDecimal } from '../../eventlog/bigDecimal';
import { FileReader } from '../../eventlog/fileReader';
import { MessageReuseDependency, MessageSendDependency, FilteredMessageDependency, FilteredMessageDependencyKind, MessageDependencyBase } from '../../eventlog/messageDependency';
import { NodeRandomAccessFile } from '../../node/nodeRandomAccessFile';
import { TestEventLog, fileReaderForContent } from './testEventLogHelper';

// ---------------------------------------------------------------------------------
// MessageSendDependency: cause of an arrival event resolves back to the sending
// event, including the forward simulation-time scan in getConsequenceEventNumber()
// (the port plan's "LONG RUNNING OPERATION").
//
// Fixture: shared/src/test/fixtures/elog/send-self-message/timer-is-processed-after-
// 1-second-and-multiple-events.elog (modern BS/ES/CM codes; "BU"/"ME" lines are
// legacy-era, but only appear inside event #0, which nothing here depends on -- see
// event.ts's file header on why that's safe). Derived by hand from the raw file:
//   E#0 (t0, initialize) -- module setup, irrelevant here
//   E#1 (t0): BS+ES a self-message (id 0, "test"), arrival predicted at t=1
//   E#2 (t0), E#3 (t0.5), E#4 (t1): unrelated events (ce -1, msg -1) inserted
//     specifically to make the consequence-search scan past non-matching events
//     that share simulation times with both the send (t0) and the arrival (t1)
//   E#5 (t1, ce 1 msg 0): the actual arrival of the self-message sent in E#1
// ---------------------------------------------------------------------------------

const timerFixturePath = resolve(
  __dirname,
  '..',
  'fixtures',
  'elog',
  'send-self-message',
  'timer-is-processed-after-1-second-and-multiple-events.elog',
);

function openTimerFixture(): TestEventLog {
  return new TestEventLog(new FileReader(new NodeRandomAccessFile(timerFixturePath)));
}

test('MessageSendDependency: event #1 causeEvent is itself, consequence resolves forward to event #5 (skipping unrelated same-simtime events)', () => {
  const eventLog = openTimerFixture();
  const event1 = eventLog.getEventForEventNumber(1)!;

  const beginSendIndex = event1.findBeginSendEntryIndex(0);
  assert.notEqual(beginSendIndex, -1);
  const dependency = new MessageSendDependency(eventLog, 1, beginSendIndex);

  assert.equal(dependency.getCauseEventNumber(), 1);
  assert.equal(dependency.getCauseEvent()!.getEventNumber(), 1);
  assert.ok(dependency.getCauseSimulationTime().equals(BigDecimal.ZERO));

  assert.equal(dependency.getConsequenceEventNumber(), 5);
  assert.equal(dependency.getConsequenceEvent()!.getEventNumber(), 5);
  assert.ok(dependency.getConsequenceSimulationTime().equals(BigDecimal.ONE));

  // exercises the "LONG RUNNING OPERATION" scan: progress() must have been called at least once per event visited
  assert.ok(eventLog.progressCount > 0);
});

test('MessageSendDependency: event #5 getCause() (via the "ce"/"msg" fields on its EventEntry) resolves back to event #1', () => {
  const eventLog = openTimerFixture();
  const event5 = eventLog.getEventForEventNumber(5)!;
  assert.equal(event5.getCauseEventNumber(), 1);
  assert.equal(event5.getMessageId(), 0);

  const cause = event5.getCause();
  assert.ok(cause);
  assert.equal(cause!.getCauseEventNumber(), 1);
  assert.equal(cause!.getConsequenceEventNumber(), 5);

  const causeBeginSendEntry = event5.getCauseBeginSendEntry();
  assert.ok(causeBeginSendEntry);
  assert.equal(causeBeginSendEntry!.messageId, 0);
});

test('MessageSendDependency: event #1 getConsequences() contains the send whose consequence is event #5; event #1 has no causes of its own (ce -1)', () => {
  const eventLog = openTimerFixture();
  const event1 = eventLog.getEventForEventNumber(1)!;

  assert.equal(event1.getCauses().length, 0); // "ce -1" on event #1's own EventEntry, and no reuse entries
  const consequences = event1.getConsequences();
  assert.equal(consequences.length, 1);
  assert.equal(consequences[0].getCauseEventNumber(), 1);
  assert.equal(consequences[0].getConsequenceEventNumber(), 5);
});

test('MessageSendDependency: duplicate()/equals()', () => {
  const eventLog = openTimerFixture();
  const event1 = eventLog.getEventForEventNumber(1)!;
  const beginSendIndex = event1.findBeginSendEntryIndex(0);
  const dependency = new MessageSendDependency(eventLog, 1, beginSendIndex);
  const copy = dependency.duplicate(eventLog);
  assert.ok(dependency.equals(copy));
  assert.ok(copy.equals(dependency));
  const other = new MessageSendDependency(eventLog, 1, beginSendIndex + 1 <= 0 ? 0 : beginSendIndex);
  assert.ok(dependency.equals(other)); // same fields -> equal, even though it's a different instance
});

// ---------------------------------------------------------------------------------
// MessageReuseDependency: a message description entry recorded in a later event but
// pointing (via "pe", previousEventNumber) back to an earlier event that already
// "owned" the message -- hand-synthesized (per the phase task: real fixtures don't
// happen to contain a message-reuse case small enough to hand-verify; the "pe" field
// alone drives the mechanism, so a minimal synthetic file exercises it precisely).
// ---------------------------------------------------------------------------------

const reuseFixture = [
  'SB ov 1536 ev 2 rid Test-0',
  '',
  'E # 0 t 0 m 1 ce -1 msg -1',
  'CM id 10 tid 10 eid 10 etid 10 c cMessage n reused pe -1',
  '',
  'E # 1 t 1 m 1 ce -1 msg -1',
  'BS id 10 tid 10 eid 10 etid 10 c cMessage n reused pe 0',
  '',
  'E # 2 t 2 m 1 ce -1 msg -1',
  '',
  'SE e 0 c 9 m "done"',
  '',
].join('\n');

function openReuseFixture(): TestEventLog {
  return new TestEventLog(fileReaderForContent(reuseFixture));
}

test('MessageReuseDependency: event #1 getCauses() finds the "pe 0" reuse pointing back to event #0', () => {
  const eventLog = openReuseFixture();
  const event1 = eventLog.getEventForEventNumber(1)!;
  const causes = event1.getCauses();
  assert.equal(causes.length, 1);
  assert.ok(causes[0] instanceof MessageReuseDependency);
  assert.equal(causes[0].getCauseEventNumber(), 0);
  assert.equal(causes[0].getConsequenceEventNumber(), 1);
});

test('MessageReuseDependency: event #0 getConsequences() finds the same reuse, searching forward from the message it created', () => {
  const eventLog = openReuseFixture();
  const event0 = eventLog.getEventForEventNumber(0)!;
  const consequences = event0.getConsequences();
  assert.equal(consequences.length, 1);
  assert.ok(consequences[0] instanceof MessageReuseDependency);
  assert.equal(consequences[0].getCauseEventNumber(), 0);
  assert.equal(consequences[0].getConsequenceEventNumber(), 1);
});

test('MessageReuseDependency: getBeginMessageDescriptionEntry()/getEndMessageDescriptionEntry() are the same entry (both "begin" and "end" of a reuse)', () => {
  const eventLog = openReuseFixture();
  const event1 = eventLog.getEventForEventNumber(1)!;
  const [reuse] = event1.getCauses() as MessageReuseDependency[];
  const begin = reuse.getBeginMessageDescriptionEntry();
  const end = reuse.getEndMessageDescriptionEntry();
  assert.equal(begin, end);
  assert.equal(begin!.messageId, 10);
});

test('MessageReuseDependency: duplicate()/equals()', () => {
  const eventLog = openReuseFixture();
  const event1 = eventLog.getEventForEventNumber(1)!;
  const [reuse] = event1.getCauses() as MessageReuseDependency[];
  const copy = reuse.duplicate(eventLog);
  assert.ok(reuse.equals(copy));
});

// ---------------------------------------------------------------------------------
// FilteredMessageDependency: a chain collapsed to (begin, end); ported in full this
// phase since it has no dependency on FilteredEventLog (E5) -- see messageDependency.ts's
// file header for the grep-verified reasoning.
// ---------------------------------------------------------------------------------

test('FilteredMessageDependency: SENDS kind delegates cause to begin, consequence to end', () => {
  const eventLog = openTimerFixture();
  const event1 = eventLog.getEventForEventNumber(1)!;
  const beginSendIndex = event1.findBeginSendEntryIndex(0);
  const send = new MessageSendDependency(eventLog, 1, beginSendIndex);

  const filtered = new FilteredMessageDependency(eventLog, FilteredMessageDependencyKind.SENDS, send, send);
  assert.equal(filtered.getKind(), FilteredMessageDependencyKind.SENDS);
  assert.equal(filtered.getCauseEventNumber(), 1);
  assert.equal(filtered.getConsequenceEventNumber(), 5);
  assert.equal(filtered.getBeginMessageDependency(), send);
  assert.equal(filtered.getEndMessageDependency(), send);
  // per the Java source, getBeginMessageDescriptionEntry()/getEndMessageDescriptionEntry()
  // both read from beginMessageDependency (not a typo -- see the doc comment in messageDependency.ts)
  assert.equal(filtered.getBeginMessageDescriptionEntry(), send.getBeginMessageDescriptionEntry());
  assert.equal(filtered.getEndMessageDescriptionEntry(), send.getEndMessageDescriptionEntry());
});

test('FilteredMessageDependency: MIXED = SENDS | REUSES numerically', () => {
  assert.equal(FilteredMessageDependencyKind.MIXED, FilteredMessageDependencyKind.SENDS | FilteredMessageDependencyKind.REUSES);
});

test('FilteredMessageDependency: MIXED-kind wrapper around a reuse dependency, duplicate()/equals(), and corresponds()', () => {
  const eventLog = openReuseFixture();
  const event1 = eventLog.getEventForEventNumber(1)!;
  const [reuse] = event1.getCauses() as MessageReuseDependency[];

  const chain = new FilteredMessageDependency(eventLog, FilteredMessageDependencyKind.MIXED, reuse, reuse);
  const copy = chain.duplicate(eventLog);
  assert.ok(chain.equals(copy));
  assert.equal(copy.getKind(), FilteredMessageDependencyKind.MIXED);
  assert.equal(copy.getCauseEventNumber(), 0);
  assert.equal(copy.getConsequenceEventNumber(), 1);

  // corresponds() ties two dependencies together when they describe the same message
  // (matched by any of the four message-identity fields -- see MessageDependencyBase.corresponds()).
  assert.ok(MessageDependencyBase.corresponds(reuse, copy.getBeginMessageDependency()));
});
