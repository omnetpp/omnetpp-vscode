/**
 * A comparator-based sorted map with `java.util.TreeMap`-style navigation
 * (`firstEntry`/`lastEntry`/`floorEntry`/`ceilingEntry`/`lowerEntry`/`higherEntry`).
 *
 * TypeScript has no built-in sorted associative container, and the OMNeT++
 * eventlog library (being ported from Java/C++) leans on `TreeMap` navigation
 * heavily to build and query its index structures. This is a from-scratch
 * implementation, not a port of a specific source file: entries are kept in a
 * single sorted array and located via binary search on the comparator. That
 * gives O(log n) lookup/navigation and O(n) insert/delete — simplicity and
 * correctness matter more here than the O(log n) insert a balanced tree would
 * give.
 *
 * Browser-safe: no Node/vscode imports.
 */

export type Comparator<K> = (a: K, b: K) => number;

export interface SortedMapEntry<K, V> {
  readonly key: K;
  readonly value: V;
}

export class SortedMap<K, V> {
  private readonly items: Array<{ key: K; value: V }> = [];
  private readonly compare: Comparator<K>;

  constructor(compare: Comparator<K>) {
    this.compare = compare;
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }

  /**
   * Returns the index of `key` if present, otherwise the (negative-encoded)
   * insertion point, `java.util.Collections.binarySearch`-style: for a
   * missing key, `-(insertionPoint) - 1` is returned, so the insertion point
   * itself is `-result - 1`.
   */
  private search(key: K): number {
    let lo = 0;
    let hi = this.items.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const cmp = this.compare(this.items[mid].key, key);
      if (cmp < 0) lo = mid + 1;
      else if (cmp > 0) hi = mid - 1;
      else return mid;
    }
    return -(lo) - 1;
  }

  set(key: K, value: V): void {
    const idx = this.search(key);
    if (idx >= 0) {
      this.items[idx] = { key, value };
    } else {
      this.items.splice(-idx - 1, 0, { key, value });
    }
  }

  get(key: K): V | undefined {
    const idx = this.search(key);
    return idx >= 0 ? this.items[idx].value : undefined;
  }

  has(key: K): boolean {
    return this.search(key) >= 0;
  }

  delete(key: K): boolean {
    const idx = this.search(key);
    if (idx < 0) return false;
    this.items.splice(idx, 1);
    return true;
  }

  firstEntry(): SortedMapEntry<K, V> | undefined {
    return this.items.length === 0 ? undefined : this.items[0];
  }

  lastEntry(): SortedMapEntry<K, V> | undefined {
    return this.items.length === 0 ? undefined : this.items[this.items.length - 1];
  }

  /** Greatest entry with key <= the given key, or undefined if none. */
  floorEntry(key: K): SortedMapEntry<K, V> | undefined {
    const idx = this.search(key);
    if (idx >= 0) return this.items[idx];
    const insertionPoint = -idx - 1;
    return insertionPoint === 0 ? undefined : this.items[insertionPoint - 1];
  }

  /** Smallest entry with key >= the given key, or undefined if none. */
  ceilingEntry(key: K): SortedMapEntry<K, V> | undefined {
    const idx = this.search(key);
    if (idx >= 0) return this.items[idx];
    const insertionPoint = -idx - 1;
    return insertionPoint === this.items.length ? undefined : this.items[insertionPoint];
  }

  /** Greatest entry with key < the given key, or undefined if none. */
  lowerEntry(key: K): SortedMapEntry<K, V> | undefined {
    const idx = this.search(key);
    const beforeIdx = idx >= 0 ? idx : -idx - 1;
    return beforeIdx === 0 ? undefined : this.items[beforeIdx - 1];
  }

  /** Smallest entry with key > the given key, or undefined if none. */
  higherEntry(key: K): SortedMapEntry<K, V> | undefined {
    const idx = this.search(key);
    const afterIdx = idx >= 0 ? idx + 1 : -idx - 1;
    return afterIdx === this.items.length ? undefined : this.items[afterIdx];
  }

  [Symbol.iterator](): IterableIterator<SortedMapEntry<K, V>> {
    return this.items[Symbol.iterator]();
  }

  entries(): IterableIterator<SortedMapEntry<K, V>> {
    return this.items[Symbol.iterator]();
  }

  *keys(): IterableIterator<K> {
    for (const e of this.items) yield e.key;
  }

  *values(): IterableIterator<V> {
    for (const e of this.items) yield e.value;
  }
}
