import { test } from 'bun:test';
import assert from 'node:assert';
import { EventLogEntryCache } from '../../eventlog/eventLogEntryCache';
import { createEntry } from '../../eventlog/entries';
import { tokenizeLine } from '../../eventlog/lineTokenizer';
import type {
  ConnectionCreatedEntry,
  ConnectionDisplayStringChangedEntry,
  CustomChangedEntry,
  CustomCreatedEntry,
  GateCreatedEntry,
  GateDisplayStringChangedEntry,
  ModuleCreatedEntry,
  ModuleDeletedEntry,
  ModuleDisplayStringChangedEntry,
} from '../../eventlog/entries';

/** Builds and `parse()`s an entry by code + a raw token line (the code itself is prepended). */
function build<T>(code: string, rest: string): T {
  const entry = createEntry(code)!;
  entry.parse(tokenizeLine(`${code} ${rest}`));
  return entry as T;
}

// ---------------------------------------------------------------------------------
// modules
// ---------------------------------------------------------------------------------

test('EventLogEntryCache: module description/created/deleted per-id lookups', () => {
  const cache = new EventLogEntryCache();
  const created = build<ModuleCreatedEntry>('MC', 'id 1 c cCompoundModule t Net n Net cm 1');
  cache.cacheEventLogEntry(created);

  // ModuleCreatedEntry extends ModuleDescriptionEntry -- caching it populates BOTH the
  // description map and the created map (matches Java: two independent if/else-if
  // chains, not one chain, precisely so a created entry double-caches).
  assert.equal(cache.getModuleDescriptionEntry(1), created);
  assert.equal(cache.getModuleCreatedEntry(1), created);
  assert.equal(cache.getModuleDescriptionEntry(2), null);
  assert.equal(cache.getModuleCreatedEntry(2), null);

  assert.deepEqual(cache.getModuleDescriptionEntries(), [created]);
  assert.equal(cache.getNumModuleDescriptionEntries(), 1);

  const deleted = build<ModuleDeletedEntry>('MD', 'id 1');
  cache.cacheEventLogEntry(deleted);
  assert.equal(cache.getModuleDeletedEntry(1), deleted);
  assert.equal(cache.getModuleDeletedEntry(2), null);
  // ModuleDeletedEntry does NOT extend ModuleDescriptionEntry (unlike ModuleCreatedEntry) --
  // caching it must not disturb the description map.
  assert.equal(cache.getModuleDescriptionEntry(1), created);
});

test('EventLogEntryCache: getModuleDescriptionEntries() is ordered ascending by module id (TreeMap-equivalent)', () => {
  const cache = new EventLogEntryCache();
  const m3 = build<ModuleCreatedEntry>('MC', 'id 3 c C t T n three');
  const m1 = build<ModuleCreatedEntry>('MC', 'id 1 c C t T n one');
  const m2 = build<ModuleCreatedEntry>('MC', 'id 2 c C t T n two');
  cache.cacheEventLogEntry(m3);
  cache.cacheEventLogEntry(m1);
  cache.cacheEventLogEntry(m2);
  assert.deepEqual(
    cache.getModuleDescriptionEntries().map((e) => e.moduleId),
    [1, 2, 3],
  );
});

// ---------------------------------------------------------------------------------
// display-string change vectors (the multi-entry case)
// ---------------------------------------------------------------------------------

test('EventLogEntryCache: module display-string changed vector, first entry with getEntryIndex() >= given index', () => {
  const cache = new EventLogEntryCache();
  const change1 = build<ModuleDisplayStringChangedEntry>('MDC', 'id 5 d "p=0,0"');
  change1.entryIndex = 10;
  const change2 = build<ModuleDisplayStringChangedEntry>('MDC', 'id 5 d "p=10,10"');
  change2.entryIndex = 20;
  const change3 = build<ModuleDisplayStringChangedEntry>('MDC', 'id 5 d "p=20,20"');
  change3.entryIndex = 30;
  cache.cacheEventLogEntry(change1);
  cache.cacheEventLogEntry(change2);
  cache.cacheEventLogEntry(change3);

  assert.equal(cache.getModuleDisplayStringChangedEntry(5, 0), change1);
  assert.equal(cache.getModuleDisplayStringChangedEntry(5, 10), change1);
  assert.equal(cache.getModuleDisplayStringChangedEntry(5, 11), change2);
  assert.equal(cache.getModuleDisplayStringChangedEntry(5, 20), change2);
  assert.equal(cache.getModuleDisplayStringChangedEntry(5, 21), change3);
  assert.equal(cache.getModuleDisplayStringChangedEntry(5, 31), null);
  assert.equal(cache.getModuleDisplayStringChangedEntry(6, 0), null); // wrong module id
});

test('EventLogEntryCache: gate/connection display-string changed vectors are independent per (module,gate) / (sourceModule,sourceGate) pair', () => {
  const cache = new EventLogEntryCache();
  const gate1 = build<GateDisplayStringChangedEntry>('GDC', 'm 1 g 1 d "a"');
  gate1.entryIndex = 1;
  const gate2 = build<GateDisplayStringChangedEntry>('GDC', 'm 1 g 2 d "b"'); // different gate id, same module
  gate2.entryIndex = 1;
  cache.cacheEventLogEntry(gate1);
  cache.cacheEventLogEntry(gate2);
  assert.equal(cache.getGateDisplayStringChangedEntry(1, 1, 0), gate1);
  assert.equal(cache.getGateDisplayStringChangedEntry(1, 2, 0), gate2);
  assert.equal(cache.getGateDisplayStringChangedEntry(1, 3, 0), null);

  const conn1 = build<ConnectionDisplayStringChangedEntry>('CDC', 'sm 1 sg 1 d "x"');
  conn1.entryIndex = 1;
  const conn2a = build<ConnectionDisplayStringChangedEntry>('CDC', 'sm 1 sg 1 d "y"');
  conn2a.entryIndex = 2;
  cache.cacheEventLogEntry(conn1);
  cache.cacheEventLogEntry(conn2a);
  assert.equal(cache.getConnectionDisplayStringChangedEntry(1, 1, 0), conn1);
  assert.equal(cache.getConnectionDisplayStringChangedEntry(1, 1, 2), conn2a);
  assert.equal(cache.getConnectionDisplayStringChangedEntry(2, 2, 0), null);
});

// ---------------------------------------------------------------------------------
// connections / gates (single-entry maps, keyed by a composite pair)
// ---------------------------------------------------------------------------------

test('EventLogEntryCache: connection description/created keyed by (sourceModuleId, sourceGateId), gate keyed by (moduleId, gateId)', () => {
  const cache = new EventLogEntryCache();
  const connection = build<ConnectionCreatedEntry>('CC', 'sm 2 sg 0 dm 3 dg 1');
  cache.cacheEventLogEntry(connection);
  assert.equal(cache.getConnectionDescriptionEntry(2, 0), connection);
  assert.equal(cache.getConnectionCreatedEntry(2, 0), connection);
  assert.equal(cache.getConnectionDescriptionEntry(3, 1), null); // dest end doesn't key the same connection

  const gate = build<GateCreatedEntry>('GC', 'm 3 g 0 n in o 0');
  cache.cacheEventLogEntry(gate);
  assert.equal(cache.getGateDescriptionEntry(3, 0), gate);
  assert.equal(cache.getGateCreatedEntry(3, 0), gate);
  assert.equal(cache.getGateDescriptionEntry(3, 1), null);
});

// ---------------------------------------------------------------------------------
// custom entries (keyed by string type + numeric key)
// ---------------------------------------------------------------------------------

test('EventLogEntryCache: custom description/created/deleted/changed keyed by (type, key)', () => {
  const cache = new EventLogEntryCache();
  const created = build<CustomCreatedEntry>('CUC', 't myType k 42 c "hello"');
  cache.cacheEventLogEntry(created);
  assert.equal(cache.getCustomDescriptionEntry('myType', 42), created);
  assert.equal(cache.getCustomCreatedEntry('myType', 42), created);
  assert.equal(cache.getCustomDescriptionEntry('otherType', 42), null);
  assert.equal(cache.getCustomDescriptionEntry('myType', 43), null);

  const change1 = build<CustomChangedEntry>('CUM', 't myType k 42 c "v1"');
  change1.entryIndex = 5;
  const change2 = build<CustomChangedEntry>('CUM', 't myType k 42 c "v2"');
  change2.entryIndex = 15;
  cache.cacheEventLogEntry(change1);
  cache.cacheEventLogEntry(change2);
  assert.equal(cache.getCustomChangedEntry('myType', 42, 0), change1);
  assert.equal(cache.getCustomChangedEntry('myType', 42, 6), change2);
  assert.equal(cache.getCustomChangedEntry('myType', 42, 16), null);
});

// ---------------------------------------------------------------------------------
// clearCache()
// ---------------------------------------------------------------------------------

test('EventLogEntryCache: clearCache() empties every map', () => {
  const cache = new EventLogEntryCache();
  cache.cacheEventLogEntry(build<ModuleCreatedEntry>('MC', 'id 1 c C t T n one'));
  cache.cacheEventLogEntry(build<ConnectionCreatedEntry>('CC', 'sm 1 sg 0 dm 2 dg 0'));
  cache.cacheEventLogEntry(build<CustomCreatedEntry>('CUC', 't x k 1 c "v"'));
  assert.equal(cache.getNumModuleDescriptionEntries(), 1);

  cache.clearCache();
  assert.equal(cache.getNumModuleDescriptionEntries(), 0);
  assert.equal(cache.getModuleDescriptionEntry(1), null);
  assert.equal(cache.getConnectionCreatedEntry(1, 0), null);
  assert.equal(cache.getCustomCreatedEntry('x', 1), null);
});
