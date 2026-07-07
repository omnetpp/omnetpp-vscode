/**
 * `elog/table/gotoRelated` -- the Event Log table's "Go To" family (phase U6), ported
 * from `EventLogTableContributor.java`'s per-action handlers (see `TableGotoRelation`'s
 * doc comment in elogProtocol.ts for the exact algorithm/citations, and `engineSession.
 * ts`'s `tableGotoRelated()` for the implementation under test).
 *
 * In-process against `handleElogRequest()` (no worker_thread/child process), same
 * pattern as `handlers.test.ts` -- these fixtures are also used by
 * `shared/src/test/eventlog/messageDependency.test.ts`, whose header hand-derives the
 * exact event/entry structure this suite relies on (cause/consequence/reuse numbers are
 * NOT re-derived here; see that file for the by-hand trace).
 */

import { test } from 'bun:test';
import assert from 'node:assert';
import { join, resolve } from 'node:path';
import { EngineSession } from '../engineSession';
import { handleElogRequest } from '../handlers';
import { ElogMethods, EventLogTableFilterMode } from '@omnetpp/shared/elog-protocol';
import type { EventDetail, RowRef } from '@omnetpp/shared/elog-protocol';

const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const fifoFixturePath = join(repoRoot, 'shared', 'src', 'test', 'fixtures', 'elog', 'sample', 'Fifo1-#0.elog');
const timerFixturePath = join(repoRoot, 'shared', 'src', 'test', 'fixtures', 'elog', 'send-self-message', 'timer-is-processed-after-1-second-and-multiple-events.elog');
const reuseFixturePath = join(repoRoot, 'shared', 'src', 'test', 'fixtures', 'elog', 'reuse', 'message-reuse.elog');

function call<R>(session: EngineSession, method: string, params: unknown): R {
  const cancelFlag = new Int32Array(new SharedArrayBuffer(4));
  return handleElogRequest(session, method, params, cancelFlag, () => {}) as R;
}

function open(session: EngineSession, path: string): void {
  call(session, ElogMethods.open, { path });
}

function gotoRelated(session: EngineSession, from: RowRef, relation: string): RowRef | null {
  return call<RowRef | null>(session, ElogMethods.tableGotoRelated, { from, relation });
}

function eventEntryRef(eventNumber: number): RowRef {
  return { eventNumber, entryIndex: 0 };
}

function findEntryRef(session: EngineSession, eventNumber: number, entryClassCode: string): RowRef {
  const detail = call<EventDetail>(session, ElogMethods.getEventDetail, { eventNumber });
  const entry = detail.entries.find((e) => e.entryClassCode === entryClassCode);
  assert.ok(entry, `expected an entry with class code "${entryClassCode}" in event #${eventNumber}`);
  return entry!.ref;
}

// ---------------------------------------------------------------------------------
// cause / arrival -- timer fixture: E#1 sends msg id 0, arrives at E#5 (see
// messageDependency.test.ts's header for the hand-derived trace).
// ---------------------------------------------------------------------------------

test('gotoRelated: cause navigates from the arrival event (#5) to the sending BeginSendEntry in event #1', () => {
  const session = new EngineSession();
  open(session, timerFixturePath);
  const expected = findEntryRef(session, 1, 'BS');
  const result = gotoRelated(session, eventEntryRef(5), 'cause');
  assert.deepEqual(result, expected);
});

test('gotoRelated: cause returns null for an event with no cause (ce -1)', () => {
  const session = new EngineSession();
  open(session, timerFixturePath);
  assert.equal(gotoRelated(session, eventEntryRef(1), 'cause'), null);
});

test('gotoRelated: cause falls back to the closest matching entry under a restrictive line filter (gotoClosest=true)', () => {
  const session = new EngineSession();
  open(session, timerFixturePath);
  // Switch the table facade into EVENT_ENTRIES mode (only "E" lines match) via a
  // getRows call, then ask for the cause -- the raw BeginSendEntry no longer matches,
  // so the result must be the closest matching entry in the same event (its "E" line).
  call(session, ElogMethods.tableGetRows, { anchor: { kind: 'first' }, before: 0, after: 1, filterMode: EventLogTableFilterMode.EVENT_ENTRIES });
  const result = gotoRelated(session, eventEntryRef(5), 'cause');
  assert.deepEqual(result, eventEntryRef(1));
});

test('gotoRelated: arrival navigates from event #1\'s send entry to event #5 (single-consequence case; Java discards this navigation, this port performs it)', () => {
  const session = new EngineSession();
  open(session, timerFixturePath);
  const from = findEntryRef(session, 1, 'BS');
  const result = gotoRelated(session, from, 'arrival');
  assert.deepEqual(result, eventEntryRef(5));
});

test('gotoRelated: arrival returns null for an event with no consequences', () => {
  const session = new EngineSession();
  open(session, timerFixturePath);
  // event #5 (the arrival) has no consequences of its own in this fixture
  assert.equal(gotoRelated(session, eventEntryRef(5), 'arrival'), null);
});

// ---------------------------------------------------------------------------------
// origin / reuse -- synthetic reuse fixture (message-reuse.elog, same content as
// messageDependency.test.ts's inline `reuseFixture`): E#1's "BS ... pe 0" line is a
// reuse of the message E#0 created (previousEventNumber 0).
// ---------------------------------------------------------------------------------

test('gotoRelated: origin navigates from the reuse entry (event #1) back to the original event (#0)', () => {
  const session = new EngineSession();
  open(session, reuseFixturePath);
  const from = findEntryRef(session, 1, 'BS');
  const result = gotoRelated(session, from, 'origin');
  assert.deepEqual(result, eventEntryRef(0));
});

test('gotoRelated: origin returns null when the focused entry is not a message reuse', () => {
  const session = new EngineSession();
  open(session, timerFixturePath);
  const from = findEntryRef(session, 1, 'BS'); // a plain send, not a reuse
  assert.equal(gotoRelated(session, from, 'origin'), null);
});

test('gotoRelated: reuse navigates from the original event (#0) forward to the reusing entry in event #1', () => {
  const session = new EngineSession();
  open(session, reuseFixturePath);
  const expected = findEntryRef(session, 1, 'BS');
  const result = gotoRelated(session, eventEntryRef(0), 'reuse');
  assert.deepEqual(result, expected);
});

test('gotoRelated: reuse returns null when the event has no reuse consequence', () => {
  const session = new EngineSession();
  open(session, timerFixturePath);
  assert.equal(gotoRelated(session, eventEntryRef(1), 'reuse'), null);
});

// ---------------------------------------------------------------------------------
// prevEvent / nextEvent -- timer fixture, plain neighbor walk.
// ---------------------------------------------------------------------------------

test('gotoRelated: prevEvent/nextEvent walk to the immediate neighbor event', () => {
  const session = new EngineSession();
  open(session, timerFixturePath);
  assert.deepEqual(gotoRelated(session, eventEntryRef(1), 'prevEvent'), eventEntryRef(0));
  assert.deepEqual(gotoRelated(session, eventEntryRef(1), 'nextEvent'), eventEntryRef(2));
});

test('gotoRelated: prevEvent is null for the first event, nextEvent is null for the last event', () => {
  const session = new EngineSession();
  const summary = call<{ firstEventNumber: number; lastEventNumber: number }>(session, ElogMethods.open, { path: timerFixturePath });
  assert.equal(gotoRelated(session, eventEntryRef(summary.firstEventNumber), 'prevEvent'), null);
  assert.equal(gotoRelated(session, eventEntryRef(summary.lastEventNumber), 'nextEvent'), null);
});

// ---------------------------------------------------------------------------------
// prevModuleEvent / nextModuleEvent -- Fifo1 fixture. Module ids per event number
// (0..32), hand-derived by scanning `elog/getEventDetail` over the whole (small)
// fixture: [1,2,3,3,4,2,3,3,4,2,3,3,4,2,3,3,4,2,3,3,4,2,3,3,4,2,3,3,4,2,3,3,4].
// Event #10 is module 3; the nearest earlier/later module-3 events are #7 and #11.
// Event #0 is the only module-1 event in the whole file (no match either direction).
// ---------------------------------------------------------------------------------

test('gotoRelated: prevModuleEvent/nextModuleEvent find the nearest same-module neighbor (Fifo1, event #10 -> #7/#11)', () => {
  const session = new EngineSession();
  open(session, fifoFixturePath);
  assert.deepEqual(gotoRelated(session, eventEntryRef(10), 'prevModuleEvent'), eventEntryRef(7));
  assert.deepEqual(gotoRelated(session, eventEntryRef(10), 'nextModuleEvent'), eventEntryRef(11));
});

test('gotoRelated: prevModuleEvent/nextModuleEvent return null when no other event shares the module (Fifo1, event #0)', () => {
  const session = new EngineSession();
  open(session, fifoFixturePath);
  assert.equal(gotoRelated(session, eventEntryRef(0), 'prevModuleEvent'), null);
  assert.equal(gotoRelated(session, eventEntryRef(0), 'nextModuleEvent'), null);
});

// ---------------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------------

test('gotoRelated: returns null when `from` does not resolve to a known event', () => {
  const session = new EngineSession();
  const summary = call<{ lastEventNumber: number }>(session, ElogMethods.open, { path: timerFixturePath });
  assert.equal(gotoRelated(session, eventEntryRef(summary.lastEventNumber + 1), 'cause'), null);
});
