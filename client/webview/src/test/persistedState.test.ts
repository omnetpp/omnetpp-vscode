import { test } from 'bun:test';
import assert from 'node:assert';
import { loadPersistedBlob, withVersion } from '../eventlog/common/persistedState';

interface FakeState {
  foo?: string;
  bar?: number;
}

const CURRENT_VERSION = 1;

// ---------------------------------------------------------------------------------
// garbage / absent input -> fresh defaults
// ---------------------------------------------------------------------------------

test('loadPersistedBlob: undefined/null/non-object input yields {}', () => {
  assert.deepStrictEqual(loadPersistedBlob<FakeState>(undefined, CURRENT_VERSION), {});
  assert.deepStrictEqual(loadPersistedBlob<FakeState>(null, CURRENT_VERSION), {});
  assert.deepStrictEqual(loadPersistedBlob<FakeState>('garbage', CURRENT_VERSION), {});
  assert.deepStrictEqual(loadPersistedBlob<FakeState>(42, CURRENT_VERSION), {});
  assert.deepStrictEqual(loadPersistedBlob<FakeState>(true, CURRENT_VERSION), {});
});

// ---------------------------------------------------------------------------------
// legacy (versionless) blob -- known fields round-trip
// ---------------------------------------------------------------------------------

test('loadPersistedBlob: a legacy blob without a version field round-trips its known fields', () => {
  const legacy = { foo: 'hello', bar: 7 };
  assert.deepStrictEqual(loadPersistedBlob<FakeState>(legacy, CURRENT_VERSION), { foo: 'hello', bar: 7 });
});

test('loadPersistedBlob: a legacy blob with only SOME known fields keeps just those (others stay undefined for the caller to default)', () => {
  const legacy = { foo: 'only-this' };
  assert.deepStrictEqual(loadPersistedBlob<FakeState>(legacy, CURRENT_VERSION), { foo: 'only-this' });
});

// ---------------------------------------------------------------------------------
// current-version blob -- accepted, `version` key stripped
// ---------------------------------------------------------------------------------

test('loadPersistedBlob: a current-version blob is accepted and its version key is stripped from the result', () => {
  const blob = withVersion<FakeState>({ foo: 'x', bar: 1 }, CURRENT_VERSION);
  const loaded = loadPersistedBlob<FakeState>(blob, CURRENT_VERSION);
  assert.deepStrictEqual(loaded, { foo: 'x', bar: 1 });
  assert.strictEqual('version' in loaded, false);
});

// ---------------------------------------------------------------------------------
// the version bump test -- a future-versioned blob is ignored entirely
// ---------------------------------------------------------------------------------

test('loadPersistedBlob: a blob whose version is newer than currentVersion is ignored entirely (fresh defaults)', () => {
  const future = { version: 2, foo: 'from-the-future', bar: 99 };
  assert.deepStrictEqual(loadPersistedBlob<FakeState>(future, CURRENT_VERSION), {});
});

test('loadPersistedBlob: a blob whose version equals currentVersion is accepted', () => {
  const current = { version: CURRENT_VERSION, foo: 'here', bar: 3 };
  assert.deepStrictEqual(loadPersistedBlob<FakeState>(current, CURRENT_VERSION), { foo: 'here', bar: 3 });
});

test('loadPersistedBlob: a non-numeric version field is treated as unrecognizable (ignored entirely)', () => {
  const malformed = { version: 'v1', foo: 'nope' };
  assert.deepStrictEqual(loadPersistedBlob<FakeState>(malformed, CURRENT_VERSION), {});
});

// ---------------------------------------------------------------------------------
// withVersion -- the write-side stamp
// ---------------------------------------------------------------------------------

test('withVersion stamps a version field without mutating the input', () => {
  const state: FakeState = { foo: 'x' };
  const stamped = withVersion(state, CURRENT_VERSION);
  assert.deepStrictEqual(stamped, { foo: 'x', version: CURRENT_VERSION });
  assert.strictEqual('version' in state, false);
});
