import { test } from 'bun:test';
import assert from 'node:assert';
import { LcgRandom, BasicSpringEmbedderLayout } from '../graphics/springEmbedder';
import { arrowcoords } from '../graphics/arrowcoords';

// ---- LCG random -------------------------------------------------------------

test('graphics: LcgRandom matches the C++ golden self-test value', () => {
  // LCGRandom::selfTest(): seed=1, 10000 iterations -> seed 1043618065
  assert.ok(new LcgRandom().selfTest());
});

test('graphics: LcgRandom sequences are deterministic per seed', () => {
  const a = new LcgRandom(42);
  const b = new LcgRandom(42);
  const c = new LcgRandom(43);
  const seqA = Array.from({ length: 5 }, () => a.next01());
  const seqB = Array.from({ length: 5 }, () => b.next01());
  const seqC = Array.from({ length: 5 }, () => c.next01());
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  for (const v of seqA) assert.ok(v > 0 && v < 1);
});

// ---- spring embedder ----------------------------------------------------------

function ringGraph(seed: number, opts = {}): BasicSpringEmbedderLayout {
  const layout = new BasicSpringEmbedderLayout(seed, opts);
  for (let i = 0; i < 6; i++) layout.addMovableNode(i, 40, 24);
  for (let i = 0; i < 6; i++) layout.addEdge(i, (i + 1) % 6);
  return layout;
}

test('graphics: spring embedder is deterministic for the same seed and graph', () => {
  const l1 = ringGraph(1);
  const l2 = ringGraph(1);
  l1.execute();
  l2.execute();
  for (let i = 0; i < 6; i++) assert.deepEqual(l1.getNodePosition(i), l2.getNodePosition(i));

  const l3 = ringGraph(2);
  l3.execute();
  const moved = Array.from({ length: 6 }, (_, i) => i)
    .some((i) => l1.getNodePosition(i).x !== l3.getNodePosition(i).x);
  assert.ok(moved, 'a different seed should produce a different layout');
});

test('graphics: fixed nodes stay put, movable nodes spread out', () => {
  const layout = new BasicSpringEmbedderLayout(1);
  layout.addFixedNode(0, 100, 100, 40, 24);
  layout.addMovableNode(1, 40, 24);
  layout.addMovableNode(2, 40, 24);
  layout.addEdge(0, 1);
  layout.addEdge(1, 2);
  layout.execute();
  assert.deepEqual(layout.getNodePosition(0), { x: 100, y: 100 });
  const p1 = layout.getNodePosition(1);
  const p2 = layout.getNodePosition(2);
  const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
  assert.ok(dist > 10, `connected movable nodes should keep some distance, got ${dist}`);
  for (const p of [p1, p2]) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

test('graphics: layout without fixed nodes is scaled into the given area', () => {
  const layout = ringGraph(1, { width: 400, height: 300, border: 30 });
  layout.execute();
  for (let i = 0; i < 6; i++) {
    const p = layout.getNodePosition(i);
    assert.ok(p.x >= 30 - 21 && p.x <= 370 + 21, `x within area: ${p.x}`);
    assert.ok(p.y >= 30 - 13 && p.y <= 270 + 13, `y within area: ${p.y}`);
  }
});

test('graphics: disconnected components do not blow up', () => {
  const layout = new BasicSpringEmbedderLayout(1);
  for (let i = 0; i < 4; i++) layout.addMovableNode(i, 40, 24);
  layout.addEdge(0, 1); // two separate components: {0,1} and {2,3}
  layout.addEdge(2, 3);
  layout.execute();
  for (let i = 0; i < 4; i++) {
    const p = layout.getNodePosition(i);
    assert.ok(Math.abs(p.x) < 10000 && Math.abs(p.y) < 10000, `no blow-up: (${p.x},${p.y})`);
  }
});

test('graphics: all-fixed graphs are left untouched', () => {
  const layout = new BasicSpringEmbedderLayout(1);
  layout.addFixedNode(0, 10, 20, 40, 24);
  layout.addFixedNode(1, 200, 20, 40, 24);
  layout.addEdge(0, 1);
  layout.execute();
  assert.deepEqual(layout.getNodePosition(0), { x: 10, y: 20 });
  assert.deepEqual(layout.getNodePosition(1), { x: 200, y: 20 });
});

// ---- arrowcoords ---------------------------------------------------------------

test('arrowcoords: y-overlap produces a straight horizontal line on facing edges', () => {
  const src = { x: 0, y: 0, width: 40, height: 24 };
  const dest = { x: 100, y: 4, width: 40, height: 24 }; // y-overlap = 20 >= 10
  const pts = arrowcoords(src, dest);
  assert.equal(pts.length, 2);
  assert.equal(pts[0].y, pts[1].y);
  assert.equal(pts[0].x, 40); // right edge of src
  assert.equal(pts[1].x, 100); // left edge of dest
  // bundle_coeff = 1/2 within the overlap zone [4, 24]
  assert.equal(pts[0].y, 4 + 0.5 * 20);
});

test('arrowcoords: x-overlap produces a straight vertical line', () => {
  const src = { x: 0, y: 0, width: 40, height: 24 };
  const dest = { x: 8, y: 100, width: 40, height: 24 }; // x-overlap = 32
  const pts = arrowcoords(src, dest);
  assert.equal(pts.length, 2);
  assert.equal(pts[0].x, pts[1].x);
  assert.equal(pts[0].y, 24);
  assert.equal(pts[1].y, 100);
});

test('arrowcoords: m-tag direction on disjoint rects yields an L-shape', () => {
  const src = { x: 0, y: 0, width: 40, height: 24 };
  const dest = { x: 200, y: 200, width: 40, height: 24 };
  const pts = arrowcoords(src, dest, 0, 1, { srcDir: 'h' });
  assert.equal(pts.length, 3);
  // src exits east at mid-height; bend at (dest.x-ish, src.y)
  assert.equal(pts[0].x, 40);
  assert.equal(pts[0].y, 12);
  assert.equal(pts[1].y, pts[0].y);
  assert.equal(pts[1].x, pts[2].x);
});

test('arrowcoords: same-axis directions (h,h) fall back to a straight line', () => {
  const src = { x: 0, y: 0, width: 40, height: 24 };
  const dest = { x: 200, y: 200, width: 40, height: 24 };
  const pts = arrowcoords(src, dest, 0, 1, { srcDir: 'h', destDir: 'h' });
  assert.equal(pts.length, 2); // invalid combination -> rule 3 fallback
});

test('arrowcoords: fallback straight line is clipped to the rect boundaries', () => {
  const src = { x: 0, y: 0, width: 40, height: 24 };
  const dest = { x: 200, y: 200, width: 40, height: 24 };
  const [a, b] = arrowcoords(src, dest);
  // endpoints must lie on the respective rect borders
  const onBorder = (p: { x: number; y: number }, r: { x: number; y: number; width: number; height: number }): boolean =>
    (p.x === r.x || p.x === r.x + r.width || p.y === r.y || p.y === r.y + r.height) &&
    p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
  assert.ok(onBorder(a, src), `src point on border: ${JSON.stringify(a)}`);
  assert.ok(onBorder(b, dest), `dest point on border: ${JSON.stringify(b)}`);
});

test('arrowcoords: bundled parallel connections are spread apart', () => {
  const src = { x: 0, y: 0, width: 40, height: 24 };
  const dest = { x: 100, y: 0, width: 40, height: 24 };
  const [a0] = arrowcoords(src, dest, 0, 3);
  const [a1] = arrowcoords(src, dest, 1, 3);
  const [a2] = arrowcoords(src, dest, 2, 3);
  assert.ok(a0.y < a1.y && a1.y < a2.y, `distinct offsets: ${a0.y}, ${a1.y}, ${a2.y}`);
});

test('arrowcoords: manual mode uses percentage anchors, clipped to borders', () => {
  const src = { x: 0, y: 0, width: 100, height: 100 };
  const dest = { x: 300, y: 0, width: 100, height: 100 };
  const [a, b] = arrowcoords(src, dest, 0, 1, {
    srcDir: 'm', srcAnchX: 50, srcAnchY: 50, destAnchX: 50, destAnchY: 50,
  });
  // anchors at the centers; the line is horizontal, so clipping lands on the facing edges
  assert.deepEqual(a, { x: 100, y: 50 });
  assert.deepEqual(b, { x: 300, y: 50 });
});

test('arrowcoords: containment picks the nearest border and points inner -> outer', () => {
  const outer = { x: 0, y: 0, width: 400, height: 300 };
  const inner = { x: 20, y: 100, width: 40, height: 24 }; // nearest border: west
  const [a, b] = arrowcoords(inner, outer);
  assert.equal(a.x, 20); // inner left edge
  assert.equal(b.x, 0); // outer left edge
  assert.equal(a.y, b.y);
  // reversed when the outer rect is the source
  const [c, d] = arrowcoords(outer, inner);
  assert.deepEqual(c, b);
  assert.deepEqual(d, a);
});

test('arrowcoords: same rect resolves by aspect ratio', () => {
  const rect = { x: 0, y: 0, width: 40, height: 24 }; // wider than tall -> vertical line
  const [a, b] = arrowcoords(rect, rect);
  assert.equal(a.x, b.x);
  assert.equal(a.y, 0);
  assert.equal(b.y, 24);
});
