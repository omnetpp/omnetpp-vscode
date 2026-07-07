import { test } from 'bun:test';
import assert from 'node:assert';
import { MatchKind } from '../../eventlog/enums';
import type { ModuleCreatedEntry, ModuleDeletedEntry } from '../../eventlog/entries';
import { fileReaderForContent, TestEventLog } from './testEventLogHelper';

/**
 * A small synthetic .elog exercising "S"/"I" chunks with "RF"/"RA"/"RR" reference
 * entries, following the exact wire syntax emitted by the C++ writer
 * (omnetpp-dev/src/envir/eventlogwriter.cc: `recordSnapshotEntry_f_e_t`/
 * `recordIndexEntry_f_i_s_e_t`/`recordReference{Found,Added,Removed}Entry_e_b_e`) and
 * the field list in resources/eventlog/eventlogentries.txt. The "f"/"i"/"s" numeric
 * fields (file offsets) are pure metadata Index/Snapshot never reads back (verified:
 * neither class references `indexEntry.fileOffset`/`.previousIndexFileOffset`/
 * `.previousSnapshotFileOffset` -- only `.eventNumber`/`.simulationTime`), so they are
 * left as harmless placeholders (`0`); chunk *offsets* come from where TestEventLog's
 * scan actually finds each "S "/"I " line in this text, not from those fields.
 *
 * Simulated module tree history: event #0 creates module "root" (id 1); event #1
 * creates "child" (id 2); event #2 deletes "child" and creates "grandchild" (id 3).
 *   S1 (after event #0): snapshot, state = { root }
 *   I1 (after event #1): index,    adds { child }                    -> state = { root, child }
 *   I2 (after event #2): index,    removes { child }, adds { grandchild } -> state = { root, grandchild }
 *   S2 (after event #3, a no-op event): snapshot, state = { root, grandchild } (independently recorded, same state I2 computes)
 */
const lines: string[] = [
  'SB ov 1536 ev 2 rid Test-0',
  '',
  'E # 0 t 0 m 1 ce -1 msg -1',
  'MC id 1 c C t T n root cm 1',
  '',
  'S f 0 # 0 t 0',
  'RF # 0 b 1 e 1',
  '',
  'E # 1 t 1 m 1 ce -1 msg -1',
  'MC id 2 c C t T n child pid 1',
  '',
  'I f 0 i 0 s 0 # 1 t 1',
  'RA # 1 b 1 e 1',
  '',
  'E # 2 t 2 m 1 ce -1 msg -1',
  'MD id 2',
  'MC id 3 c C t T n grandchild pid 1',
  '',
  'I f 0 i 0 s 0 # 2 t 2',
  'RR # 1 b 1 e 1',
  'RA # 2 b 2 e 2',
  '',
  'E # 3 t 3 m 1 ce -1 msg -1',
  '',
  'S f 0 # 3 t 3',
  'RF # 0 b 1 e 1',
  'RF # 2 b 2 e 2',
  '',
  'E # 4 t 4 m 1 ce -1 msg -1',
  '',
  'SE e 0 c 9 m "done"',
  '',
];

function openFixture(): TestEventLog {
  return new TestEventLog(fileReaderForContent(lines.join('\n')));
}

test('chunks: Index/Snapshot parse their header entry and event number/simulation time', () => {
  const eventLog = openFixture();
  const s1 = eventLog.getFirstSnapshot()!;
  assert.equal(s1.getEventNumber(), 0);
  assert.ok(s1.getSimulationTime().equals(eventLog.getEventForEventNumber(0)!.getSimulationTime()));

  const s2 = eventLog.getLastSnapshot()!;
  assert.equal(s2.getEventNumber(), 3);

  const i1 = eventLog.getFirstIndex()!;
  assert.equal(i1.getEventNumber(), 1);

  const i2 = eventLog.getLastIndex()!;
  assert.equal(i2.getEventNumber(), 2);
});

test('chunks: Index/Snapshot prev/next linkage (doubly-linked chains, built in file order)', () => {
  const eventLog = openFixture();
  const s1 = eventLog.getFirstSnapshot()!;
  const s2 = eventLog.getLastSnapshot()!;
  const i1 = eventLog.getFirstIndex()!;
  const i2 = eventLog.getLastIndex()!;

  // Snapshot <-> Snapshot
  assert.equal(s1.getPreviousSnapshot(), null);
  assert.equal(s1.getNextSnapshot(), s2);
  assert.equal(s2.getPreviousSnapshot(), s1);
  assert.equal(s2.getNextSnapshot(), null);

  // Index <-> Index
  assert.equal(i1.getPreviousIndex(), null);
  assert.equal(i1.getNextIndex(), i2);
  assert.equal(i2.getPreviousIndex(), i1);
  assert.equal(i2.getNextIndex(), null);

  // Index -> Snapshot (both directions)
  assert.equal(i1.getPreviousSnapshot(), s1);
  assert.equal(i1.getNextSnapshot(), s2);
  assert.equal(i2.getPreviousSnapshot(), s1); // I2 still precedes S2 in file order
  assert.equal(i2.getNextSnapshot(), s2);

  // Snapshot -> Index (both directions)
  assert.equal(s1.getPreviousIndex(), null); // no index chunk before event #0
  assert.equal(s1.getNextIndex(), i1);
  assert.equal(s2.getPreviousIndex(), i2);
  assert.equal(s2.getNextIndex(), null); // no index chunk after event #3

  // getEvent()/getPreviousEvent()/getNextEvent()
  assert.equal(s1.getEvent().getEventNumber(), 0);
  assert.equal(i1.getEvent().getEventNumber(), 1);
  assert.equal(i1.getNextEvent(), i1.getEvent()); // Index.getNextEvent() === getEvent() (per Java)
  assert.equal(i1.getPreviousEvent()!.getEventNumber(), 0);
});

test('chunks: Index.getReferenceAddedEntries()/getReferenceRemovedEntries() reflect the RA/RR lines verbatim', () => {
  const eventLog = openFixture();
  const i1 = eventLog.getFirstIndex()!;
  assert.equal(i1.getReferenceAddedEntries().length, 1);
  assert.equal(i1.getReferenceAddedEntries()[0].eventNumber, 1);
  assert.equal(i1.getReferenceRemovedEntries().length, 0);

  const i2 = eventLog.getLastIndex()!;
  assert.equal(i2.getReferenceRemovedEntries().length, 1);
  assert.equal(i2.getReferenceRemovedEntries()[0].eventNumber, 1);
  assert.equal(i2.getReferenceAddedEntries().length, 1);
  assert.equal(i2.getReferenceAddedEntries()[0].eventNumber, 2);
});

test('chunks: Index.getAddedEventLogEntries()/getRemovedEventLogEntries() resolve references to the actual entries', () => {
  const eventLog = openFixture();
  const i1 = eventLog.getFirstIndex()!;
  const added1 = i1.getAddedEventLogEntries();
  assert.equal(added1.length, 1);
  assert.equal((added1[0] as ModuleCreatedEntry).fullName, 'child');

  const i2 = eventLog.getLastIndex()!;
  const removed2 = i2.getRemovedEventLogEntries();
  assert.equal(removed2.length, 1);
  assert.equal((removed2[0] as ModuleCreatedEntry).fullName, 'child');
  assert.equal(removed2[0], added1[0]); // same underlying entry object (event #1's own MC entry)

  const added2 = i2.getAddedEventLogEntries();
  assert.equal(added2.length, 1);
  assert.equal((added2[0] as ModuleCreatedEntry).fullName, 'grandchild');
});

test('chunks: Snapshot.getReferenceFoundEntries()/getFoundEventLogEntries() reflect the RF lines directly', () => {
  const eventLog = openFixture();
  const s1 = eventLog.getFirstSnapshot()!;
  assert.equal(s1.getReferenceFoundEntries().length, 1);
  const s1Found = s1.getFoundEventLogEntries();
  assert.equal(s1Found.length, 1);
  assert.equal((s1Found[0] as ModuleCreatedEntry).fullName, 'root');

  const s2 = eventLog.getLastSnapshot()!;
  assert.equal(s2.getReferenceFoundEntries().length, 2);
  const s2Found = s2.getFoundEventLogEntries();
  const names = s2Found.map((e) => (e as ModuleCreatedEntry).fullName).sort();
  assert.deepEqual(names, ['grandchild', 'root']);
});

test('chunks: Index.getReferenceFoundEntries()/getFoundEventLogEntries() merge forward from the previous chunk (add/remove/complete-overlap cases)', () => {
  const eventLog = openFixture();
  const i1 = eventLog.getFirstIndex()!;
  // I1 merges S1's found set ({root}) with its own added ({child}) -> {root, child}
  const i1Refs = i1.getReferenceFoundEntries();
  assert.equal(i1Refs.length, 2);
  const i1Found = i1.getFoundEventLogEntries();
  const i1Names = i1Found.map((e) => (e as ModuleCreatedEntry).fullName).sort();
  assert.deepEqual(i1Names, ['child', 'root']);

  const i2 = eventLog.getLastIndex()!;
  // I2 merges I1's found set ({root, child}), removes {child} (a complete-overlap
  // remove: referenceRemovedEntry spans exactly the found entry's begin/end range),
  // adds {grandchild} -> {root, grandchild}
  const i2Refs = i2.getReferenceFoundEntries();
  assert.equal(i2Refs.length, 2);
  const i2Found = i2.getFoundEventLogEntries();
  const i2Names = i2Found.map((e) => (e as ModuleCreatedEntry).fullName).sort();
  assert.deepEqual(i2Names, ['grandchild', 'root']);

  // I2's merged found set should agree with S2's independently-recorded RF set (same simulation state).
  const s2 = eventLog.getLastSnapshot()!;
  assert.deepEqual(
    i2Found.map((e) => e.getOffset()).sort(),
    s2.getFoundEventLogEntries().map((e) => e.getOffset()).sort(),
  );
});

test('chunks: containsReferenceAddedEntry()/containsReferenceRemovedEntry()/containsReferenceFoundEntry()', () => {
  const eventLog = openFixture();
  const i1 = eventLog.getFirstIndex()!;
  assert.equal(i1.containsReferenceAddedEntry(1, 1), true);
  assert.equal(i1.containsReferenceAddedEntry(1, 2), false);
  assert.equal(i1.containsReferenceRemovedEntry(1, 1), false);

  const i2 = eventLog.getLastIndex()!;
  assert.equal(i2.containsReferenceRemovedEntry(1, 1), true);
  // containsReferenceFoundEntry() checks the *merged* found list, whose synthesized
  // ReferenceFoundEntry objects always carry entryIndex -1 (Java: `new
  // ReferenceFoundEntry(this, -1)` for every forwarded/added entry -- see
  // getReferenceFoundEntries()'s implementation). The only real call site in the whole
  // Java UI tree (Event.findReuseMessageDescriptionEntry) always passes -1 for exactly
  // this reason; matched here for fidelity rather than picking an arbitrary index.
  assert.equal(i2.containsReferenceFoundEntry(0, -1), true); // "root" survives into I2's found set
  assert.equal(i2.containsReferenceFoundEntry(1, -1), false); // "child" was removed by I2
});

test('chunks: getIndex()/getSnapshot() MatchKind lookups on the eventlog', () => {
  const eventLog = openFixture();
  assert.equal(eventLog.getIndex(1, MatchKind.EXACT), eventLog.getFirstIndex());
  assert.equal(eventLog.getIndex(0, MatchKind.EXACT), null); // no index chunk at event #0 (that's a snapshot)
  assert.equal(eventLog.getIndex(0, MatchKind.FIRST_OR_NEXT), eventLog.getFirstIndex());
  assert.equal(eventLog.getIndex(3, MatchKind.FIRST_OR_PREVIOUS), eventLog.getLastIndex());

  assert.equal(eventLog.getSnapshot(0, MatchKind.EXACT), eventLog.getFirstSnapshot());
  assert.equal(eventLog.getSnapshot(1, MatchKind.EXACT), null);
  assert.equal(eventLog.getSnapshot(1, MatchKind.LAST_OR_NEXT), eventLog.getLastSnapshot());
});

test('chunks: parsing is lazy — Index/Snapshot only touch the FileReader once a getter that needs it is called', () => {
  const eventLog = openFixture();
  const i2 = eventLog.getLastIndex()!;
  // getBeginOffset() never calls ensureParsed(); getEventNumber() does.
  assert.ok(i2.getBeginOffset() >= 0);
  assert.equal(i2.indexEntry, null, 'not parsed yet');
  assert.equal(i2.getEventNumber(), 2);
  assert.notEqual(i2.indexEntry, null, 'parsed after the first ensureParsed()-backed getter call');
});

test('chunks: print() renders the header entry followed by removed then added reference entries (matches Index.print()\'s order)', () => {
  const eventLog = openFixture();
  const i2 = eventLog.getLastIndex()!;
  const printed = i2.print();
  const printedLines = printed.split('\n');
  assert.equal(printedLines.length, 3); // IndexEntry + 1 RR + 1 RA
  assert.ok(printedLines[0].startsWith('I '));
  assert.ok(printedLines[1].startsWith('RR '));
  assert.ok(printedLines[2].startsWith('RA '));
});

test('chunks: ModuleDeletedEntry (MD) inside event #2 is a plain reference entry, unaffected by the chunk machinery', () => {
  const eventLog = openFixture();
  const event2 = eventLog.getEventForEventNumber(2)!;
  const deleted = event2.getEventLogEntry(1) as ModuleDeletedEntry;
  assert.equal(deleted.moduleId, 2);
});
