/**
 * Headless tests for `client/src/eventlog/bookmarkStore.ts` (phase U6) -- lives next to
 * `eventLogSession.test.ts` for the same reason (that file's own header: `client/worker/
 * src/test/` is the wired-in home for headless tests of `client/src/eventlog/*` modules
 * that must stay `vscode`-free to be importable by `bun:test` at all -- see
 * `bookmarkStore.ts`'s header on why the pure logic lives in its own file, separate
 * from `bookmarks.ts`'s `vscode`-dependent wiring).
 */

import { test } from 'bun:test';
import assert from 'node:assert';
import type { Bookmark, BookmarkCandidate } from '@omnetpp/shared/ui-protocol';
import { BookmarkStore, bookmarkMatches, bookmarkTitle, isStaleBookmark, migrateBookmarksBlob, toggleBookmarkInList, type MementoLike } from '../../../src/eventlog/bookmarkStore';

/** A minimal in-memory `MementoLike` fake -- `bookmarkStore.ts`'s header explains why this stands in for `vscode.Memento`. */
function fakeMemento(initial: Record<string, unknown> = {}): MementoLike & { store: Record<string, unknown> } {
  const store = { ...initial };
  return {
    store,
    get<T>(key: string, defaultValue: T): T {
      return key in store ? (store[key] as T) : defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      store[key] = value;
    },
  };
}

const eventCandidate: BookmarkCandidate = { kind: 'Event', eventNumber: 42 };
const axisCandidate: BookmarkCandidate = { kind: 'Axis', modulePath: 'Net.host[0].app' };
const depCandidate: BookmarkCandidate = { kind: 'MessageDependency', eventNumber: 3, consequenceEventNumber: 9, messageId: 7 };
const methodCandidate: BookmarkCandidate = { kind: 'ComponentMethodCall', eventNumber: 5, entryIndex: 2, methodName: 'sendPacket' };
const positionCandidate: BookmarkCandidate = { kind: 'Position', simulationTime: '1.5' };

// ---------------------------------------------------------------------------------
// bookmarkMatches -- per-kind identity
// ---------------------------------------------------------------------------------

test('bookmarkMatches: Event bookmarks match by eventNumber only', () => {
  const b: Bookmark = { id: '1', kind: 'Event', label: 'x', eventNumber: 42 };
  assert.ok(bookmarkMatches(eventCandidate, b));
  assert.ok(!bookmarkMatches({ kind: 'Event', eventNumber: 43 }, b));
});

test('bookmarkMatches: Axis bookmarks match by modulePath only', () => {
  const b: Bookmark = { id: '1', kind: 'Axis', label: 'x', modulePath: 'Net.host[0].app' };
  assert.ok(bookmarkMatches(axisCandidate, b));
  assert.ok(!bookmarkMatches({ kind: 'Axis', modulePath: 'Net.host[1].app' }, b));
});

test('bookmarkMatches: MessageDependency bookmarks match by (eventNumber, consequenceEventNumber, messageId)', () => {
  const b: Bookmark = { id: '1', kind: 'MessageDependency', label: 'x', eventNumber: 3, consequenceEventNumber: 9, messageId: 7 };
  assert.ok(bookmarkMatches(depCandidate, b));
  assert.ok(!bookmarkMatches({ ...depCandidate, messageId: 8 }, b));
  assert.ok(!bookmarkMatches({ ...depCandidate, consequenceEventNumber: 10 }, b));
});

test('bookmarkMatches: ComponentMethodCall bookmarks match by (eventNumber, entryIndex)', () => {
  const b: Bookmark = { id: '1', kind: 'ComponentMethodCall', label: 'x', eventNumber: 5, entryIndex: 2, methodName: 'sendPacket' };
  assert.ok(bookmarkMatches(methodCandidate, b));
  // methodName is descriptive only -- identity is (eventNumber, entryIndex)
  assert.ok(bookmarkMatches({ ...methodCandidate, methodName: 'renamed' }, b));
  assert.ok(!bookmarkMatches({ ...methodCandidate, entryIndex: 3 }, b));
});

test('bookmarkMatches: Position bookmarks match by exact simulationTime string', () => {
  const b: Bookmark = { id: '1', kind: 'Position', label: 'x', simulationTime: '1.5' };
  assert.ok(bookmarkMatches(positionCandidate, b));
  assert.ok(!bookmarkMatches({ kind: 'Position', simulationTime: '1.500000001' }, b));
});

test('bookmarkMatches: different kinds never match, even with overlapping fields', () => {
  const eventBookmark: Bookmark = { id: '1', kind: 'Event', label: 'x', eventNumber: 5 };
  assert.ok(!bookmarkMatches({ kind: 'ComponentMethodCall', eventNumber: 5, entryIndex: 0 }, eventBookmark));
});

// ---------------------------------------------------------------------------------
// isStaleBookmark
// ---------------------------------------------------------------------------------

test('isStaleBookmark: an eventNumber beyond the current last event is stale', () => {
  const b: Bookmark = { id: '1', kind: 'Event', label: 'x', eventNumber: 100 };
  assert.ok(isStaleBookmark(b, 50));
  assert.ok(!isStaleBookmark(b, 100));
  assert.ok(!isStaleBookmark(b, 150));
});

test('isStaleBookmark: Axis bookmarks (no eventNumber) are never reported stale', () => {
  const b: Bookmark = { id: '1', kind: 'Axis', label: 'x', modulePath: 'Net.host[0]' };
  assert.ok(!isStaleBookmark(b, 0));
});

test('isStaleBookmark: Position bookmarks (no eventNumber) are never reported stale', () => {
  const b: Bookmark = { id: '1', kind: 'Position', label: 'x', simulationTime: '1.5' };
  assert.ok(!isStaleBookmark(b, 0));
});

// ---------------------------------------------------------------------------------
// bookmarkTitle
// ---------------------------------------------------------------------------------

test('bookmarkTitle: Position bookmarks show their simulation time', () => {
  const b: Bookmark = { id: '1', kind: 'Position', label: 'x', simulationTime: '1.5' };
  assert.strictEqual(bookmarkTitle(b), 'Position: t = 1.5s');
});

// ---------------------------------------------------------------------------------
// toggleBookmarkInList -- add/remove
// ---------------------------------------------------------------------------------

test('toggleBookmarkInList: adds a new bookmark with a generated id and the given label when no match exists', () => {
  const { bookmarks, added } = toggleBookmarkInList([], eventCandidate, 'my label');
  assert.equal(added, true);
  assert.equal(bookmarks.length, 1);
  assert.equal(bookmarks[0].label, 'my label');
  assert.equal(bookmarks[0].eventNumber, 42);
  assert.ok(bookmarks[0].id.length > 0);
});

test('toggleBookmarkInList: removes a matching bookmark without prompting (no label needed)', () => {
  const existing: Bookmark = { id: 'abc', kind: 'Event', label: 'x', eventNumber: 42 };
  const { bookmarks, added } = toggleBookmarkInList([existing], eventCandidate, '');
  assert.equal(added, false);
  assert.equal(bookmarks.length, 0);
});

test('toggleBookmarkInList: removes ALL matches (defensive against a corrupted/duplicated blob), leaves unrelated bookmarks untouched', () => {
  const dup1: Bookmark = { id: '1', kind: 'Event', label: 'a', eventNumber: 42 };
  const dup2: Bookmark = { id: '2', kind: 'Event', label: 'b', eventNumber: 42 };
  const other: Bookmark = { id: '3', kind: 'Event', label: 'c', eventNumber: 99 };
  const { bookmarks } = toggleBookmarkInList([dup1, dup2, other], eventCandidate, '');
  assert.deepEqual(bookmarks, [other]);
});

test('toggleBookmarkInList: two toggles round-trip back to empty', () => {
  const afterAdd = toggleBookmarkInList([], axisCandidate, 'bottleneck').bookmarks;
  const afterRemove = toggleBookmarkInList(afterAdd, axisCandidate, '').bookmarks;
  assert.deepEqual(afterRemove, []);
});

// ---------------------------------------------------------------------------------
// migrateBookmarksBlob -- versioned load
// ---------------------------------------------------------------------------------

test('migrateBookmarksBlob: loads a well-formed v1 blob', () => {
  const b: Bookmark = { id: '1', kind: 'Event', label: 'x', eventNumber: 1 };
  assert.deepEqual(migrateBookmarksBlob({ version: 1, bookmarks: [b] }), [b]);
});

test('migrateBookmarksBlob: tolerates a bare array (hypothetical unversioned legacy shape)', () => {
  const b: Bookmark = { id: '1', kind: 'Event', label: 'x', eventNumber: 1 };
  assert.deepEqual(migrateBookmarksBlob([b]), [b]);
});

test('migrateBookmarksBlob: defaults to an empty array for null/undefined/malformed input', () => {
  assert.deepEqual(migrateBookmarksBlob(null), []);
  assert.deepEqual(migrateBookmarksBlob(undefined), []);
  assert.deepEqual(migrateBookmarksBlob({ notBookmarks: true }), []);
  assert.deepEqual(migrateBookmarksBlob('garbage'), []);
});

// ---------------------------------------------------------------------------------
// BookmarkStore -- persistence round trip against a fake Memento
// ---------------------------------------------------------------------------------

test('BookmarkStore: starts empty against a fresh Memento, add/remove persist immediately', async () => {
  const memento = fakeMemento();
  const store = new BookmarkStore(memento, 'file:///a.elog');
  assert.deepEqual(store.list(), []);

  const { added } = await store.toggle(eventCandidate, 'first');
  assert.equal(added, true);
  assert.equal(store.list().length, 1);
  assert.ok('omnetpp.eventlog.bookmarks:file:///a.elog' in memento.store);

  await store.toggle(eventCandidate, ''); // toggling the same candidate again removes it
  assert.deepEqual(store.list(), []);
});

test('BookmarkStore: is keyed per-uri -- two stores over the same Memento do not see each other\'s bookmarks', async () => {
  const memento = fakeMemento();
  const storeA = new BookmarkStore(memento, 'file:///a.elog');
  const storeB = new BookmarkStore(memento, 'file:///b.elog');
  await storeA.toggle(eventCandidate, 'in A');
  assert.equal(storeA.list().length, 1);
  assert.equal(storeB.list().length, 0);
});

test('BookmarkStore: loads pre-existing persisted bookmarks on construction (survives "reload")', () => {
  const b: Bookmark = { id: '1', kind: 'Event', label: 'restored', eventNumber: 7 };
  const memento = fakeMemento({ 'omnetpp.eventlog.bookmarks:file:///a.elog': { version: 1, bookmarks: [b] } });
  const store = new BookmarkStore(memento, 'file:///a.elog');
  assert.deepEqual(store.list(), [b]);
});

test('BookmarkStore: remove() deletes by id', async () => {
  const memento = fakeMemento();
  const store = new BookmarkStore(memento, 'file:///a.elog');
  await store.toggle(eventCandidate, 'x');
  const id = store.list()[0].id;
  await store.remove(id);
  assert.deepEqual(store.list(), []);
});

test('BookmarkStore: update() renames a bookmark and sets its notes, persists, and leaves other bookmarks untouched', async () => {
  const memento = fakeMemento();
  const store = new BookmarkStore(memento, 'file:///a.elog');
  await store.toggle(eventCandidate, 'original label');
  await store.toggle(axisCandidate, 'unrelated');
  const id = store.list().find((b) => b.kind === 'Event')!.id;

  await store.update(id, 'renamed', '**bold** note');
  assert.strictEqual(store.list().find((b) => b.id === id)!.label, 'renamed');
  assert.strictEqual(store.list().find((b) => b.id === id)!.note, '**bold** note');
  assert.strictEqual(store.list().find((b) => b.kind === 'Axis')!.label, 'unrelated', 'the other bookmark is untouched');

  // survives "reload"
  const reloaded = new BookmarkStore(memento, 'file:///a.elog');
  assert.strictEqual(reloaded.list().find((b) => b.id === id)!.label, 'renamed');
  assert.strictEqual(reloaded.list().find((b) => b.id === id)!.note, '**bold** note');
});

test('BookmarkStore: update() on a no-longer-existing id is a harmless no-op', async () => {
  const memento = fakeMemento();
  const store = new BookmarkStore(memento, 'file:///a.elog');
  await store.toggle(eventCandidate, 'x');
  await store.update('does-not-exist', 'renamed', 'note');
  assert.strictEqual(store.list()[0].label, 'x');
});
