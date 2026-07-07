import { test } from 'bun:test';
import assert from 'node:assert';
import { TileCache, TILE_WIDTH_PX, viewportGeneration } from '../eventlog/chart/canvasStack';

// Only `TileCache` (pure bookkeeping) is covered here -- the rest of canvasStack.ts
// creates real <canvas> elements and draws to a 2D context, which is DOM-dependent
// and (per this repo's convention) left untested at the unit level; its correctness
// is exercised indirectly by the dev:build + manual F5 checklist instead.

test('tileIndicesForRange covers exactly the tiles a tc range spans', () => {
  const pixelsPerTc = 1; // 1 px per tc -> tile width in tc equals TILE_WIDTH_PX
  const indices = TileCache.tileIndicesForRange(0, TILE_WIDTH_PX * 2.5, pixelsPerTc);
  assert.deepStrictEqual(indices, [0, 1, 2]);
});

test('tileIndicesForRange handles a negative-tc range (before the coordinate-system origin)', () => {
  const pixelsPerTc = 1;
  const indices = TileCache.tileIndicesForRange(-TILE_WIDTH_PX * 1.5, TILE_WIDTH_PX * 0.5, pixelsPerTc);
  assert.deepStrictEqual(indices, [-2, -1, 0]);
});

test('a non-positive pixelsPerTc yields no tiles rather than throwing', () => {
  assert.deepStrictEqual(TileCache.tileIndicesForRange(0, 100, 0), []);
});

test('a freshly-created tile is not resident until markResident is called', () => {
  const cache = new TileCache(4);
  assert.strictEqual(cache.isResident(0, 1), false);
  cache.markResident(0, 1);
  assert.strictEqual(cache.isResident(0, 1), true);
});

test('the same tileIndex under a different generation is a different cache entry', () => {
  const cache = new TileCache(4);
  cache.markResident(5, 1);
  assert.strictEqual(cache.isResident(5, 1), true);
  assert.strictEqual(cache.isResident(5, 2), false, 'a generation bump invalidates every tile at once (checked per-lookup)');
});

test('LRU eviction: once maxTiles is exceeded, the least-recently-touched tile is evicted first', () => {
  const cache = new TileCache(2);
  cache.markResident(0, 1);
  cache.markResident(1, 1);
  cache.touch(0, 1); // 0 is now more recently used than 1
  cache.markResident(2, 1); // pushes size to 3 -> evicts the LRU entry (tile 1)
  assert.strictEqual(cache.size(), 2);
  assert.strictEqual(cache.isResident(1, 1), false, 'least-recently-used tile evicted');
  assert.strictEqual(cache.isResident(0, 1), true, 'recently-touched tile survives');
  assert.strictEqual(cache.isResident(2, 1), true, 'newly-added tile survives');
});

test('clear() empties the cache', () => {
  const cache = new TileCache(4);
  cache.markResident(0, 1);
  cache.clear();
  assert.strictEqual(cache.size(), 0);
  assert.strictEqual(cache.isResident(0, 1), false);
});

test('viewportGeneration changes whenever any of its inputs changes', () => {
  const base = { pixelsPerTc: 10, vscroll: 0, coordinateSystemVersion: 1, timelineMode: 'SIMULATION_TIME', themeVersion: 0 };
  const g0 = viewportGeneration(base);
  assert.notStrictEqual(viewportGeneration({ ...base, pixelsPerTc: 20 }), g0);
  assert.notStrictEqual(viewportGeneration({ ...base, vscroll: 5 }), g0);
  assert.notStrictEqual(viewportGeneration({ ...base, coordinateSystemVersion: 2 }), g0);
  assert.notStrictEqual(viewportGeneration({ ...base, timelineMode: 'STEP' }), g0);
  assert.notStrictEqual(viewportGeneration({ ...base, themeVersion: 1 }), g0);
  assert.strictEqual(viewportGeneration({ ...base }), g0, 'identical inputs -> identical generation key');
});
