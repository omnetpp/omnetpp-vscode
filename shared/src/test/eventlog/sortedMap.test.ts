import { test } from 'bun:test';
import assert from 'node:assert';
import { SortedMap, type SortedMapEntry } from '../../eventlog/sortedMap';

const numCompare = (a: number, b: number): number => a - b;

// ---- basic operations -------------------------------------------------------

test('sortedMap: basic set/get/has/delete/size/clear', () => {
  const m = new SortedMap<number, string>(numCompare);
  assert.equal(m.size, 0);
  assert.equal(m.get(1), undefined);
  assert.equal(m.has(1), false);
  assert.equal(m.delete(1), false);

  m.set(3, 'three');
  m.set(1, 'one');
  m.set(2, 'two');
  assert.equal(m.size, 3);
  assert.equal(m.get(1), 'one');
  assert.equal(m.get(2), 'two');
  assert.equal(m.get(3), 'three');
  assert.equal(m.has(2), true);
  assert.equal(m.has(4), false);

  assert.equal(m.delete(2), true);
  assert.equal(m.size, 2);
  assert.equal(m.get(2), undefined);
  assert.equal(m.delete(2), false);

  m.clear();
  assert.equal(m.size, 0);
  assert.equal(m.get(1), undefined);
});

test('sortedMap: set() overwrites an existing key without changing size', () => {
  const m = new SortedMap<number, string>(numCompare);
  m.set(1, 'a');
  m.set(2, 'b');
  m.set(3, 'c');
  assert.equal(m.size, 3);
  m.set(2, 'B');
  assert.equal(m.size, 3);
  assert.equal(m.get(2), 'B');
  assert.deepEqual([...m.keys()], [1, 2, 3]);
});

test('sortedMap: in-order iteration produces ascending keys after scrambled inserts', () => {
  const m = new SortedMap<number, number>(numCompare);
  const inputOrder = [50, 10, 40, 20, 30, -5, 100, 0, 25];
  for (const k of inputOrder) m.set(k, k * 10);

  const expectedKeys = [...inputOrder].sort(numCompare);
  assert.deepEqual([...m.keys()], expectedKeys);
  assert.deepEqual([...m.values()], expectedKeys.map((k) => k * 10));
  assert.deepEqual(
    [...m].map((e) => e.key),
    expectedKeys,
  );
  assert.deepEqual(
    [...m.entries()].map((e) => e.key),
    expectedKeys,
  );
});

// ---- navigation: empty map ---------------------------------------------------

test('sortedMap: navigation ops on an empty map all return undefined', () => {
  const m = new SortedMap<number, string>(numCompare);
  assert.equal(m.firstEntry(), undefined);
  assert.equal(m.lastEntry(), undefined);
  assert.equal(m.floorEntry(5), undefined);
  assert.equal(m.ceilingEntry(5), undefined);
  assert.equal(m.lowerEntry(5), undefined);
  assert.equal(m.higherEntry(5), undefined);
});

// ---- navigation: single-element map ------------------------------------------

test('sortedMap: navigation ops on a single-element map', () => {
  const m = new SortedMap<number, string>(numCompare);
  m.set(10, 'ten');
  const entry: SortedMapEntry<number, string> = { key: 10, value: 'ten' };

  assert.deepEqual(m.firstEntry(), entry);
  assert.deepEqual(m.lastEntry(), entry);

  // query below the one key
  assert.deepEqual(m.floorEntry(5), undefined);
  assert.deepEqual(m.ceilingEntry(5), entry);
  assert.deepEqual(m.lowerEntry(5), undefined);
  assert.deepEqual(m.higherEntry(5), entry);

  // query exactly at the one key
  assert.deepEqual(m.floorEntry(10), entry);
  assert.deepEqual(m.ceilingEntry(10), entry);
  assert.deepEqual(m.lowerEntry(10), undefined);
  assert.deepEqual(m.higherEntry(10), undefined);

  // query above the one key
  assert.deepEqual(m.floorEntry(15), entry);
  assert.deepEqual(m.ceilingEntry(15), undefined);
  assert.deepEqual(m.lowerEntry(15), entry);
  assert.deepEqual(m.higherEntry(15), undefined);
});

// ---- navigation: multi-element map, incl. exact-match boundaries -------------

test('sortedMap: navigation ops on a multi-element map', () => {
  const m = new SortedMap<number, string>(numCompare);
  for (const k of [10, 20, 30, 40, 50]) m.set(k, `v${k}`);

  assert.deepEqual(m.firstEntry(), { key: 10, value: 'v10' });
  assert.deepEqual(m.lastEntry(), { key: 50, value: 'v50' });

  // below everything
  assert.deepEqual(m.floorEntry(5), undefined);
  assert.deepEqual(m.ceilingEntry(5), { key: 10, value: 'v10' });
  assert.deepEqual(m.lowerEntry(5), undefined);
  assert.deepEqual(m.higherEntry(5), { key: 10, value: 'v10' });

  // above everything
  assert.deepEqual(m.floorEntry(100), { key: 50, value: 'v50' });
  assert.deepEqual(m.ceilingEntry(100), undefined);
  assert.deepEqual(m.lowerEntry(100), { key: 50, value: 'v50' });
  assert.deepEqual(m.higherEntry(100), undefined);

  // in a gap between two keys
  assert.deepEqual(m.floorEntry(25), { key: 20, value: 'v20' });
  assert.deepEqual(m.ceilingEntry(25), { key: 30, value: 'v30' });
  assert.deepEqual(m.lowerEntry(25), { key: 20, value: 'v20' });
  assert.deepEqual(m.higherEntry(25), { key: 30, value: 'v30' });

  // exact match at an interior key: floor/ceiling return the exact entry,
  // lower/higher skip past it to the true neighbor
  assert.deepEqual(m.floorEntry(30), { key: 30, value: 'v30' });
  assert.deepEqual(m.ceilingEntry(30), { key: 30, value: 'v30' });
  assert.deepEqual(m.lowerEntry(30), { key: 20, value: 'v20' });
  assert.deepEqual(m.higherEntry(30), { key: 40, value: 'v40' });

  // exact match at the first key
  assert.deepEqual(m.floorEntry(10), { key: 10, value: 'v10' });
  assert.deepEqual(m.ceilingEntry(10), { key: 10, value: 'v10' });
  assert.deepEqual(m.lowerEntry(10), undefined);
  assert.deepEqual(m.higherEntry(10), { key: 20, value: 'v20' });

  // exact match at the last key
  assert.deepEqual(m.floorEntry(50), { key: 50, value: 'v50' });
  assert.deepEqual(m.ceilingEntry(50), { key: 50, value: 'v50' });
  assert.deepEqual(m.lowerEntry(50), { key: 40, value: 'v40' });
  assert.deepEqual(m.higherEntry(50), undefined);
});

// ---- fuzz test: numeric comparator against a reference Map -------------------

/** Small deterministic PRNG (mulberry32) so the fuzz test is repeatable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function referenceFloor(sortedKeys: number[], key: number): number | undefined {
  let result: number | undefined;
  for (const k of sortedKeys) if (k <= key) result = k; else break;
  return result;
}
function referenceCeiling(sortedKeys: number[], key: number): number | undefined {
  for (const k of sortedKeys) if (k >= key) return k;
  return undefined;
}
function referenceLower(sortedKeys: number[], key: number): number | undefined {
  let result: number | undefined;
  for (const k of sortedKeys) if (k < key) result = k; else break;
  return result;
}
function referenceHigher(sortedKeys: number[], key: number): number | undefined {
  for (const k of sortedKeys) if (k > key) return k;
  return undefined;
}

test('sortedMap: fuzz test against a reference Map (numeric keys)', () => {
  const rnd = mulberry32(12345);
  const m = new SortedMap<number, string>(numCompare);
  const reference = new Map<number, string>();

  const KEY_RANGE = 50; // keys in [-50, 50], forces collisions/boundary hits
  const randKey = (): number => Math.floor(rnd() * (2 * KEY_RANGE + 1)) - KEY_RANGE;

  for (let i = 0; i < 1000; i++) {
    const op = rnd();
    const key = randKey();

    if (op < 0.45) {
      // set
      const value = `v${key}#${i}`;
      m.set(key, value);
      reference.set(key, value);
    } else if (op < 0.65) {
      // delete
      const deleted = m.delete(key);
      const refDeleted = reference.delete(key);
      assert.equal(deleted, refDeleted, `delete(${key}) mismatch at op ${i}`);
    } else {
      // navigation query (also exercise get/has while we're at it)
      const sortedKeys = [...reference.keys()].sort(numCompare);

      assert.equal(m.get(key), reference.get(key), `get(${key}) mismatch at op ${i}`);
      assert.equal(m.has(key), reference.has(key), `has(${key}) mismatch at op ${i}`);
      assert.equal(m.size, reference.size, `size mismatch at op ${i}`);

      const first = sortedKeys.length === 0 ? undefined : sortedKeys[0];
      const last = sortedKeys.length === 0 ? undefined : sortedKeys[sortedKeys.length - 1];
      assert.deepEqual(
        m.firstEntry(),
        first === undefined ? undefined : { key: first, value: reference.get(first) },
        `firstEntry mismatch at op ${i}`,
      );
      assert.deepEqual(
        m.lastEntry(),
        last === undefined ? undefined : { key: last, value: reference.get(last) },
        `lastEntry mismatch at op ${i}`,
      );

      const expectFor = (fn: (keys: number[], k: number) => number | undefined, actual: SortedMapEntry<number, string> | undefined, label: string) => {
        const expectedKey = fn(sortedKeys, key);
        const expected = expectedKey === undefined ? undefined : { key: expectedKey, value: reference.get(expectedKey) };
        assert.deepEqual(actual, expected, `${label}(${key}) mismatch at op ${i}`);
      };
      expectFor(referenceFloor, m.floorEntry(key), 'floorEntry');
      expectFor(referenceCeiling, m.ceilingEntry(key), 'ceilingEntry');
      expectFor(referenceLower, m.lowerEntry(key), 'lowerEntry');
      expectFor(referenceHigher, m.higherEntry(key), 'higherEntry');
    }
  }
});

// ---- fuzz test: custom comparators (non-numeric / reverse order) -------------

test('sortedMap: fuzz test with a string comparator confirms the comparator is used', () => {
  const rnd = mulberry32(999);
  const stringCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const m = new SortedMap<string, number>(stringCompare);
  const reference = new Map<string, number>();

  const alphabet = 'abcde';
  const randKey = (): string =>
    alphabet[Math.floor(rnd() * alphabet.length)] + alphabet[Math.floor(rnd() * alphabet.length)];

  for (let i = 0; i < 1000; i++) {
    const op = rnd();
    const key = randKey();

    if (op < 0.5) {
      m.set(key, i);
      reference.set(key, i);
    } else if (op < 0.7) {
      assert.equal(m.delete(key), reference.delete(key), `delete(${key}) mismatch at op ${i}`);
    } else {
      const sortedKeys = [...reference.keys()].sort(stringCompare);
      const floor = (): string | undefined => {
        let result: string | undefined;
        for (const k of sortedKeys) if (stringCompare(k, key) <= 0) result = k; else break;
        return result;
      };
      const ceiling = (): string | undefined => {
        for (const k of sortedKeys) if (stringCompare(k, key) >= 0) return k;
        return undefined;
      };
      const floorKey = floor();
      const ceilingKey = ceiling();
      assert.deepEqual(
        m.floorEntry(key),
        floorKey === undefined ? undefined : { key: floorKey, value: reference.get(floorKey) },
        `floorEntry(${key}) mismatch at op ${i}`,
      );
      assert.deepEqual(
        m.ceilingEntry(key),
        ceilingKey === undefined ? undefined : { key: ceilingKey, value: reference.get(ceilingKey) },
        `ceilingEntry(${key}) mismatch at op ${i}`,
      );
    }
  }

  // sanity: iteration order really follows the string comparator, not insertion order
  const expectedOrder = [...reference.keys()].sort(stringCompare);
  assert.deepEqual([...m.keys()], expectedOrder);
});

test('sortedMap: fuzz test with a reverse numeric comparator', () => {
  const rnd = mulberry32(777);
  const reverseCompare = (a: number, b: number): number => b - a;
  const m = new SortedMap<number, number>(reverseCompare);
  const reference = new Map<number, number>();

  const KEY_RANGE = 30;
  const randKey = (): number => Math.floor(rnd() * (2 * KEY_RANGE + 1)) - KEY_RANGE;

  for (let i = 0; i < 1000; i++) {
    const op = rnd();
    const key = randKey();

    if (op < 0.5) {
      m.set(key, i);
      reference.set(key, i);
    } else if (op < 0.7) {
      assert.equal(m.delete(key), reference.delete(key));
    } else {
      // descending sort == ascending per reverseCompare
      const sortedKeys = [...reference.keys()].sort((a, b) => b - a);
      const first = sortedKeys[0];
      const last = sortedKeys[sortedKeys.length - 1];
      assert.deepEqual(
        m.firstEntry(),
        first === undefined ? undefined : { key: first, value: reference.get(first) },
      );
      assert.deepEqual(
        m.lastEntry(),
        last === undefined ? undefined : { key: last, value: reference.get(last) },
      );
      // "floor" per reverseCompare means: greatest entry whose reverseCompare(entry,key) <= 0,
      // i.e. the largest key that is >= the queried key (since order is reversed)
      let floorKey: number | undefined;
      for (const k of sortedKeys) if (reverseCompare(k, key) <= 0) floorKey = k; else break;
      assert.deepEqual(
        m.floorEntry(key),
        floorKey === undefined ? undefined : { key: floorKey, value: reference.get(floorKey) },
      );
    }
  }

  const expectedOrder = [...reference.keys()].sort((a, b) => b - a);
  assert.deepEqual([...m.keys()], expectedOrder);
});
