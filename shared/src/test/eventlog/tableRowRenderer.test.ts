/**
 * Phase U2 test suite: `renderTableRow()` (shared/src/eventlog/tableRowRenderer.ts) --
 * the Event Log table's per-entry styled-span row builder, ported from
 * `EventLogTableRowRenderer.java`. Uses the same Fifo1 sample fixture as the E6
 * `EventLogTableFacade` suite (eventLogTableFacade.test.ts) so every entry type checked
 * here comes from a real, hand-inspectable `.elog` file (see the literal file excerpt
 * quoted per test below) rather than a synthesized one -- exact text is read off the
 * fixture's own tokens (module/gate/message names & classes, delays, ids), not guessed.
 *
 * Where a rendered branch depends on already-independently-tested lower-level engine
 * derivations (`EventLogEntry.getContextModuleId()`'s call-stack tracking, `Event.
 * isSelfMessage()`), the expected text is computed from those same real, trusted API
 * calls rather than re-deriving them by hand a second time -- this suite is exercising
 * `renderTableRow()`'s text-building logic, not re-verifying event.ts/entries.ts (which
 * have their own dedicated suites).
 */

import { test } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { BigDecimal } from '../../eventlog/bigDecimal';
import {
  BeginSendEntry,
  ComponentMethodBeginEntry,
  ComponentMethodEndEntry,
  ConnectionCreatedEntry,
  EndSendEntry,
  EventEntry,
  GateCreatedEntry,
  GateDisplayStringChangedEntry,
  ModuleCreatedEntry,
} from '../../eventlog/entries';
import { EventLog } from '../../eventlog/eventLog';
import type { EventLogEntry } from '../../eventlog/eventLogEntry';
import { EventLogFacade } from '../../eventlog/facade';
import type { IChunk, IEvent } from '../../eventlog/ieventlog';
import {
  renderTableRow,
  secondsToTimeString,
  UnsupportedTableEntryError,
  type TableRowRenderContext,
} from '../../eventlog/tableRowRenderer';
import type { TableRenderModes, TableSpan } from '../../eventlog/elogProtocol';
import { fileReaderForContent } from './testEventLogHelper';

const fifoPath = resolve(__dirname, '..', 'fixtures', 'elog', 'sample', 'Fifo1-#0.elog');

function openFifo(): { eventLog: EventLog; ctx: TableRowRenderContext } {
  const text = fs.readFileSync(fifoPath, 'latin1');
  const eventLog = new EventLog(fileReaderForContent(text));
  const facade = new EventLogFacade(eventLog);
  const ctx: TableRowRenderContext = {
    getModuleDescriptionEntry: (id) => eventLog.getEventLogEntryCache().getModuleDescriptionEntry(id),
    getGateDescriptionEntry: (m, g) => eventLog.getEventLogEntryCache().getGateDescriptionEntry(m, g),
    getModuleFullPath: (e) => facade.ModuleDescriptionEntry_getModuleFullPath(e),
    getEventForEventNumber: (n) => eventLog.getEventForEventNumber(n),
  };
  return { eventLog, ctx };
}

const DESCRIPTIVE_SMART_CPP: TableRenderModes = { displayMode: 'DESCRIPTIVE', nameMode: 'SMART_NAME', typeMode: 'CPP' };
const RAW: TableRenderModes = { displayMode: 'RAW', nameMode: 'SMART_NAME', typeMode: 'CPP' };

function texts(spans: TableSpan[]): string {
  return spans.map((s) => s.text).join('');
}

function findEntryInEvent<T extends EventLogEntry>(
  eventLog: EventLog,
  eventNumber: number,
  ctor: new (...args: never[]) => T,
  predicate: (entry: T) => boolean = () => true,
): T {
  const event = eventLog.getEventForEventNumber(eventNumber)!;
  for (let i = 0; i < event.getNumEventLogEntries(); i++) {
    const entry = event.getEventLogEntry(i);
    if (entry instanceof ctor && predicate(entry)) return entry;
  }
  throw new Error(`no matching ${ctor.name} found in event #${eventNumber}`);
}

// ---------------------------------------------------------------------------------
// 1. secondsToTimeString() -- port of TimeUtils.secondsToTimeString(), independent of
//    the table row renderer itself but used by every timestamp it prints.
// ---------------------------------------------------------------------------------

test('secondsToTimeString: matches hand-computed breakdowns', () => {
  assert.equal(secondsToTimeString(BigDecimal.ZERO), '0s');
  assert.equal(secondsToTimeString(BigDecimal.parse('0.1')), '100ms');
  assert.equal(secondsToTimeString(BigDecimal.parse('0.159174900913')), '159ms 174us 900ns 913ps');
  assert.equal(secondsToTimeString(BigDecimal.parse('-1.5')), '-1s 500ms');
  assert.equal(secondsToTimeString(BigDecimal.parse('2')), '2s');
});

// ---------------------------------------------------------------------------------
// 2. RAW mode: exact attribute-dump parity with getAsString()/getAttributeNames().
// ---------------------------------------------------------------------------------

test('renderTableRow: RAW mode reproduces entry.getAsString()/getAttributeNames() exactly (ModuleCreatedEntry, event #0)', () => {
  const { eventLog, ctx } = openFifo();
  const entry = findEntryInEvent(eventLog, 0, ModuleCreatedEntry, (e) => e.moduleId === 2);
  const row = renderTableRow(entry, ctx, RAW);

  let expected = `${entry.getAsString()} `;
  for (const name of entry.getAttributeNames()) {
    expected += `${name} `;
    const value = entry.getAsString(name);
    expected += (value === null || value === '' ? '""' : value) + ' ';
  }
  assert.equal(texts(row.detailSpans), expected);
  assert.equal(row.detailSpans[0].style, 'constBold');
  assert.equal(row.detailSpans[1].style, 'const'); // first attribute name
  assert.equal(row.detailSpans[2].style, 'raw'); // first attribute value
});

test('renderTableRow: RAW mode for a BeginSendEntry (event #1) also matches getAsString() parity', () => {
  const { eventLog, ctx } = openFifo();
  const entry = findEntryInEvent(eventLog, 1, BeginSendEntry);
  const row = renderTableRow(entry, ctx, RAW);
  let expected = `${entry.getAsString()} `;
  for (const name of entry.getAttributeNames()) {
    expected += `${name} `;
    const value = entry.getAsString(name);
    expected += (value === null || value === '' ? '""' : value) + ' ';
  }
  assert.equal(texts(row.detailSpans), expected);
});

// ---------------------------------------------------------------------------------
// 3. DESCRIPTIVE mode -- concrete entries from the Fifo1 fixture (see the literal
//    tokens quoted per test), name/type mode variations.
// ---------------------------------------------------------------------------------

test('renderTableRow: ModuleCreatedEntry (event #0: "MC id 2 c fifo::Source t Source pid 1 n source") descriptive text, SMART_NAME/CPP', () => {
  const { eventLog, ctx } = openFifo();
  const entry = findEntryInEvent(eventLog, 0, ModuleCreatedEntry, (e) => e.moduleId === 2); // module 2 = "source"
  assert.equal(entry.moduleId, 2);
  assert.equal(entry.fullName, 'source');
  const row = renderTableRow(entry, ctx, DESCRIPTIVE_SMART_CPP);
  // module 1 ("SingleQueue") is the network root -- module(2) is a smart-name mismatch
  // against the event's own module (1), so it renders as the full path; module(1) (the
  // "under" parent) matches the event's module exactly, so it renders as the full name.
  assert.equal(texts(row.detailSpans), 'Creating module (fifo::Source) SingleQueue.source under module (omnetpp::cModule) SingleQueue started');
  assert.deepEqual(
    row.detailSpans.map((s) => s.style),
    ['const', 'const', 'type', 'name', 'const', 'const', 'type', 'name', 'const'],
  );
});

test('renderTableRow: ModuleCreatedEntry with FULL_NAME/NED modes changes both the name and type spans', () => {
  const { eventLog, ctx } = openFifo();
  const entry = findEntryInEvent(eventLog, 0, ModuleCreatedEntry, (e) => e.moduleId === 2);
  const row = renderTableRow(entry, ctx, { displayMode: 'DESCRIPTIVE', nameMode: 'FULL_NAME', typeMode: 'NED' });
  assert.equal(texts(row.detailSpans), 'Creating module (Source) source under module (SingleQueue) SingleQueue started');
});

test('renderTableRow: GateCreatedEntry (event #0: "GC m 2 g 1 n out o 1") descriptive text', () => {
  const { eventLog, ctx } = openFifo();
  const entry = findEntryInEvent(eventLog, 0, GateCreatedEntry, (e) => e.moduleId === 2);
  assert.equal(entry.moduleId, 2);
  assert.equal(entry.name, 'out');
  const row = renderTableRow(entry, ctx, DESCRIPTIVE_SMART_CPP);
  assert.equal(texts(row.detailSpans), 'Creating gate out in module (fifo::Source) SingleQueue.source');
});

test('renderTableRow: ConnectionCreatedEntry (event #0: "CC sm 2 sg 1 dm 3 dg 0") descriptive text', () => {
  const { eventLog, ctx } = openFifo();
  const entry = findEntryInEvent(eventLog, 0, ConnectionCreatedEntry, (e) => e.sourceModuleId === 2);
  assert.equal(entry.sourceModuleId, 2);
  assert.equal(entry.destModuleId, 3);
  const row = renderTableRow(entry, ctx, DESCRIPTIVE_SMART_CPP);
  assert.equal(
    texts(row.detailSpans),
    'Creating connection from module (fifo::Source) SingleQueue.source gate out to module (fifo::Fifo) SingleQueue.fifo gate in',
  );
});

test('renderTableRow: ComponentMethodBeginEntry/End (event #0: "CMB sm 1 tm 2 m initialize(0)" then "CME")', () => {
  const { eventLog, ctx } = openFifo();
  const event = eventLog.getEventForEventNumber(0)!;
  let beginEntry: ComponentMethodBeginEntry | null = null;
  let endEntry: ComponentMethodEndEntry | null = null;
  for (let i = 0; i < event.getNumEventLogEntries() && (beginEntry === null || endEntry === null); i++) {
    const entry = event.getEventLogEntry(i);
    if (beginEntry === null && entry instanceof ComponentMethodBeginEntry && entry.targetComponentId === 2) beginEntry = entry;
    else if (beginEntry !== null && endEntry === null && entry instanceof ComponentMethodEndEntry) endEntry = entry;
  }
  assert.ok(beginEntry && endEntry, 'fixture sanity: CMB(target=2) followed eventually by a CME');

  const beginRow = renderTableRow(beginEntry!, ctx, DESCRIPTIVE_SMART_CPP);
  // contextModuleId for the first CMB in the event equals the event's own module (1) --
  // the source module -- so the "from" clause is NOT appended (per the Java `if
  // (contextEvent.getModuleId() != entry.getContextModuleId())` guard).
  assert.equal(event.getModuleId(), beginEntry!.getContextModuleId(), 'fixture sanity: this CMB runs at the event\'s own module context');
  assert.equal(texts(beginRow.detailSpans), 'Begin calling initialize(0) in module (fifo::Source) SingleQueue.source');

  const endRow = renderTableRow(endEntry!, ctx, DESCRIPTIVE_SMART_CPP);
  assert.equal(texts(endRow.detailSpans), 'End calling module');
});

test('renderTableRow: BeginSendEntry for the "job" message (event #1: "BS id 2 ... n job m 2 pe 1"), non-self send', () => {
  const { eventLog, ctx } = openFifo();
  const entry = findEntryInEvent(eventLog, 1, BeginSendEntry);
  assert.equal(entry.messageName, 'job');
  // Note: the message class is the fully-qualified "omnetpp::cMessage", NOT the literal
  // "cMessage" the Java source special-cases when deciding to append a length clause
  // (`!beginSendEntry.getMessageClassName().equals("cMessage")`) -- so that comparison
  // is true here and the length clause IS appended (see the expected text below); a
  // send of a literal, unqualified `cMessage` (no subclass) would omit it instead.
  assert.equal(entry.messageClassName, 'omnetpp::cMessage');
  const event = eventLog.getEventForEventNumber(1)!;
  const isSelf = event.isSelfMessage(entry);
  assert.equal(isSelf, false, 'fixture sanity: source (module 2) sending to fifo (module 3) is not a self-message');
  const endSend = event.getEndSendEntry(entry);
  assert.notEqual(endSend, null, 'fixture sanity: the matching EndSendEntry is in the same event');

  const row = renderTableRow(entry, ctx, DESCRIPTIVE_SMART_CPP);
  assert.equal(texts(row.detailSpans), 'Sending message (omnetpp::cMessage) job arriving at  kind = 0 length = 0');
  assert.deepEqual(
    row.detailSpans.map((s) => s.style),
    ['const', 'const', 'type', 'name', 'const', 'const', 'data', 'const', 'data'],
  );
});

// ---------------------------------------------------------------------------------
// 3b. Row icon id -- port of EventLogTableRowRenderer.getImage() (~lines 242-268 of the
//     Java source). Fixture facts below were verified against the real Fifo1 log rather
//     than assumed: event #1 contains BOTH a non-adjacent "job" BeginSendEntry/
//     EndSendEntry pair (with a SendHopEntry in between -- generic "BeginSend"/"EndSend")
//     AND an adjacent "sendMessageEvent" BeginSendEntry/EndSendEntry pair (a self-timer
//     reschedule, no entry in between -- the "scheduleAt" pattern, "ScheduleAt"); event
//     #1 itself is a self-message-processing event (it processes the self-timer message
//     scheduled adjacently in event #0), while event #2 is not.
// ---------------------------------------------------------------------------------

test('renderTableRow: iconId -- generic mapping strips the trailing "Entry" off the class name', () => {
  const { eventLog, ctx } = openFifo();
  const mc = findEntryInEvent(eventLog, 0, ModuleCreatedEntry, (e) => e.moduleId === 2);
  assert.equal(renderTableRow(mc, ctx, DESCRIPTIVE_SMART_CPP).iconId, 'ModuleCreated');

  const gc = findEntryInEvent(eventLog, 0, GateCreatedEntry, (e) => e.moduleId === 2);
  assert.equal(renderTableRow(gc, ctx, DESCRIPTIVE_SMART_CPP).iconId, 'GateCreated');

  const cc = findEntryInEvent(eventLog, 0, ConnectionCreatedEntry, (e) => e.sourceModuleId === 2);
  assert.equal(renderTableRow(cc, ctx, DESCRIPTIVE_SMART_CPP).iconId, 'ConnectionCreated');
});

test('renderTableRow: iconId is computed identically in RAW mode (not just DESCRIPTIVE)', () => {
  const { eventLog, ctx } = openFifo();
  const mc = findEntryInEvent(eventLog, 0, ModuleCreatedEntry, (e) => e.moduleId === 2);
  assert.equal(renderTableRow(mc, ctx, RAW).iconId, 'ModuleCreated');
});

test('renderTableRow: iconId -- EventEntry special case: a self-message-processing event renders "SelfEvent" instead of "Event"', () => {
  const { eventLog, ctx } = openFifo();
  const event1 = eventLog.getEventForEventNumber(1)!;
  assert.equal(event1.isSelfMessageProcessingEvent(), true, 'fixture sanity: event #1 processes the self-timer message scheduled adjacently in event #0');
  assert.equal(renderTableRow(event1.getEventEntry(), ctx, DESCRIPTIVE_SMART_CPP).iconId, 'SelfEvent');

  const event2 = eventLog.getEventForEventNumber(2)!;
  assert.equal(event2.isSelfMessageProcessingEvent(), false, 'fixture sanity: event #2 ("end-service") is not a self-message-processing event');
  assert.equal(renderTableRow(event2.getEventEntry(), ctx, DESCRIPTIVE_SMART_CPP).iconId, 'Event');
});

test('renderTableRow: iconId -- BeginSendEntry special case: immediately followed by an EndSendEntry in the same event renders "ScheduleAt"', () => {
  const { eventLog, ctx } = openFifo();
  const event1 = eventLog.getEventForEventNumber(1)!;
  const scheduleAtEntry = findEntryInEvent(eventLog, 1, BeginSendEntry, (e) => e.messageName === 'sendMessageEvent');
  assert.equal(event1.isSelfMessage(scheduleAtEntry), true, 'fixture sanity: the "sendMessageEvent" BeginSendEntry is immediately followed by its own EndSendEntry');
  assert.equal(renderTableRow(scheduleAtEntry, ctx, DESCRIPTIVE_SMART_CPP).iconId, 'ScheduleAt');
});

test('renderTableRow: iconId -- a plain BeginSendEntry NOT immediately followed by an EndSendEntry (a SendHopEntry sits in between) still gets the generic "BeginSend" id', () => {
  const { eventLog, ctx } = openFifo();
  const event1 = eventLog.getEventForEventNumber(1)!;
  const jobEntry = findEntryInEvent(eventLog, 1, BeginSendEntry, (e) => e.messageName === 'job');
  assert.equal(event1.isSelfMessage(jobEntry), false, 'fixture sanity: the "job" BeginSendEntry has a SendHopEntry between it and its EndSendEntry');
  assert.equal(renderTableRow(jobEntry, ctx, DESCRIPTIVE_SMART_CPP).iconId, 'BeginSend');
});

test('renderTableRow: iconId -- EndSendEntry is never itself special-cased, generic "EndSend"', () => {
  const { eventLog, ctx } = openFifo();
  const endSend = findEntryInEvent(eventLog, 1, EndSendEntry, (e) => e.messageName === 'job');
  assert.equal(renderTableRow(endSend, ctx, DESCRIPTIVE_SMART_CPP).iconId, 'EndSend');
});

// ---------------------------------------------------------------------------------
// 4. Event# / Time cell styling -- "E" rows get the non-faint style, non-"E" rows are
//    dimmed (duplicated event# across an event's multiple rows).
// ---------------------------------------------------------------------------------

test('renderTableRow: event#/time cell style -- eventNo/simtime for an EventEntry row, faint for any other row of the same event', () => {
  const { eventLog, ctx } = openFifo();
  const event = eventLog.getEventForEventNumber(1)!;
  const eventEntry = event.getEventEntry();
  const eventRow = renderTableRow(eventEntry, ctx, DESCRIPTIVE_SMART_CPP);
  assert.equal(eventRow.eventNumberSpan.style, 'eventNo');
  assert.equal(eventRow.simTimeSpan.style, 'simtime');
  assert.equal(eventRow.eventNumberSpan.text, '#1');

  const otherEntry = findEntryInEvent(eventLog, 1, BeginSendEntry);
  const otherRow = renderTableRow(otherEntry, ctx, DESCRIPTIVE_SMART_CPP);
  assert.equal(otherRow.eventNumberSpan.style, 'faint');
  assert.equal(otherRow.simTimeSpan.style, 'faint');
  // Still the same (duplicated) event number/time as the "E" row -- just dimmed.
  assert.equal(otherRow.eventNumberSpan.text, eventRow.eventNumberSpan.text);
  assert.equal(otherRow.simTimeSpan.text, eventRow.simTimeSpan.text);
});

// ---------------------------------------------------------------------------------
// 5. Indentation -- getIndentation() port (level + non-EventEntry bump + SendHop bump).
// ---------------------------------------------------------------------------------

test('renderTableRow: indentUnits -- EventEntry has the plain level, a non-EventEntry gets +1', () => {
  const { eventLog, ctx } = openFifo();
  const event = eventLog.getEventForEventNumber(0)!;
  const eventRow = renderTableRow(event.getEventEntry(), ctx, DESCRIPTIVE_SMART_CPP);
  assert.equal(eventRow.indentUnits, event.getEventEntry().getLevel());

  const mc = findEntryInEvent(eventLog, 0, ModuleCreatedEntry);
  const mcRow = renderTableRow(mc, ctx, DESCRIPTIVE_SMART_CPP);
  assert.equal(mcRow.indentUnits, mc.getLevel() + 1);
});

// ---------------------------------------------------------------------------------
// 6. Degraded fallback -- an entry type the Java descriptive switch does not handle
//    falls back to RAW instead of throwing (see tableRowRenderer.ts's header).
// ---------------------------------------------------------------------------------

test('renderTableRow: an entry type unhandled by the descriptive switch falls back to RAW instead of throwing', () => {
  const { ctx } = openFifo();
  const entry = new GateDisplayStringChangedEntry();
  entry.moduleId = 7;
  entry.gateId = 2;
  entry.displayString = 'p=10,10';

  const fakeEvent: IEvent = {
    getAsString: () => null,
    getBeginOffset: () => 0,
    getEndOffset: () => 0,
    getEventNumber: () => 42,
    getSimulationTime: () => BigDecimal.parse('1.5'),
    getEventLog: () => {
      throw new Error('not used by this test');
    },
    getEventEntry: () => {
      throw new Error('not used by this test');
    },
    getModuleDescriptionEntry: () => {
      throw new Error('not used by this test');
    },
    getNumEventLogEntries: () => 1,
    getNumEventLogMessages: () => 0,
    getNumBeginSendEntries: () => 0,
    getNumCustomEntries: () => 0,
    getEventLogEntry: () => entry,
    getEventLogMessage: () => entry,
    getModuleId: () => 7,
    getMessageId: () => -1,
    getCauseEventNumber: () => -1,
    getPreviousEvent: () => null,
    getNextEvent: () => null,
    getCauseEvent: () => null,
    getCauseBeginSendEntry: () => null,
    getCause: () => null,
    getCauses: () => [],
    getConsequences: () => [],
    print: () => '',
    synchronize: () => {},
    findBeginSendEntryIndex: () => -1,
    isSelfMessage: () => false,
    isSelfMessageProcessingEvent: () => false,
    getEndSendEntry: () => null,
    getCachedTimelineCoordinateBegin: () => -1,
    setCachedTimelineCoordinateBegin: () => {},
    getCachedTimelineCoordinateEnd: () => -1,
    setCachedTimelineCoordinateEnd: () => {},
    getCachedTimelineCoordinateSystemVersion: () => -1,
    setCachedTimelineCoordinateSystemVersion: () => {},
  };
  entry.chunk = fakeEvent as unknown as IChunk;
  entry.entryIndex = 0;

  assert.equal(entry.getEvent(), fakeEvent, 'fixture sanity: the fake chunk must be recognized as an IEvent (see isIEvent())');

  const row = renderTableRow(entry, ctx, DESCRIPTIVE_SMART_CPP);
  // Falls back to the exact RAW rendering rather than throwing.
  const rawRow = renderTableRow(entry, ctx, RAW);
  assert.deepEqual(row.detailSpans, rawRow.detailSpans);
  assert.equal(row.eventNumberSpan.text, '#42');
});

test('UnsupportedTableEntryError is exported and named for an unhandled descriptive entry type', () => {
  const err = new UnsupportedTableEntryError('GateDisplayStringChangedEntry');
  assert.equal(err.name, 'UnsupportedTableEntryError');
  assert.match(err.message, /GateDisplayStringChangedEntry/);
});
