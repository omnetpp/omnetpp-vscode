import { test } from 'bun:test';
import assert from 'node:assert';
import { packNotes, type NoteLayoutCandidate } from '../eventlog/chart/bookmarkNotesLayout';

function overlaps(a: { x: number; width: number }, b: { x: number; width: number }, gap: number): boolean {
  return a.x + a.width + gap > b.x && b.x + b.width + gap > a.x;
}

/** Asserts no two packed notes overlap (accounting for `gap`), matching each candidate's width back up by id. */
function assertNoOverlap(candidates: readonly NoteLayoutCandidate[], packed: { id: string; x: number }[], gap: number): void {
  const widthById = new Map(candidates.map((c) => [c.id, c.width]));
  const boxes = packed.map((p) => ({ x: p.x, width: widthById.get(p.id)! })).sort((a, b) => a.x - b.x);
  for (let i = 1; i < boxes.length; i++) assert.ok(!overlaps(boxes[i - 1], boxes[i], gap), `boxes at index ${i - 1}/${i} overlap`);
}

test('packNotes: empty input returns empty output', () => {
  assert.deepEqual(packNotes([], 0, 1000, 5), []);
});

test('packNotes: a single note with room to spare sits exactly at its target x', () => {
  const packed = packNotes([{ id: 'a', targetX: 100, width: 50 }], 0, 1000, 5);
  assert.deepEqual(packed, [{ id: 'a', x: 100 }]);
});

test('packNotes: non-overlapping targets stay at their own target x unchanged', () => {
  const candidates: NoteLayoutCandidate[] = [
    { id: 'a', targetX: 100, width: 40 },
    { id: 'b', targetX: 300, width: 40 },
    { id: 'c', targetX: 500, width: 40 },
  ];
  const packed = packNotes(candidates, 0, 1000, 5);
  assert.deepEqual(
    packed.sort((x, y) => x.id.localeCompare(y.id)),
    [
      { id: 'a', x: 100 },
      { id: 'b', x: 300 },
      { id: 'c', x: 500 },
    ],
  );
});

test('packNotes: two overlapping targets get pushed apart SYMMETRICALLY (least-squares displacement), never overlapping', () => {
  const candidates: NoteLayoutCandidate[] = [
    { id: 'a', targetX: 100, width: 80 },
    { id: 'b', targetX: 120, width: 80 }, // wants to start inside a's box
  ];
  const packed = packNotes(candidates, 0, 1000, 5);
  assertNoOverlap(candidates, packed, 5);
  const a = packed.find((p) => p.id === 'a')!;
  const b = packed.find((p) => p.id === 'b')!;
  // Both notes are displaced by the SAME amount (in opposite directions) from their own
  // targets -- neither one is glued to its target while the other absorbs the entire
  // required separation (that lopsided behavior is exactly what dragged an unrelated note
  // far from its own bookmark when several competed for the same region).
  assert.strictEqual(100 - a.x, b.x - 120, 'a and b are displaced from their targets by the same amount, in opposite directions');
  assert.strictEqual(b.x - a.x, 80 + 5, 'still separated by exactly width + gap');
});

test('packNotes: a long chain of overlapping targets never overlaps and stays sorted by target x', () => {
  const candidates: NoteLayoutCandidate[] = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, targetX: i * 10, width: 60 }));
  const packed = packNotes(candidates, 0, 2000, 4);
  assertNoOverlap(candidates, packed, 4);
});

test('packNotes: result never starts before minX', () => {
  const candidates: NoteLayoutCandidate[] = [
    { id: 'a', targetX: -50, width: 40 },
    { id: 'b', targetX: -10, width: 40 },
  ];
  const packed = packNotes(candidates, 0, 1000, 5);
  assertNoOverlap(candidates, packed, 5);
  for (const p of packed) assert.ok(p.x >= 0, `x=${p.x} must be >= minX`);
});

test('packNotes: a chain that would run past maxX is pulled back left as far as slack allows, without overlapping', () => {
  const candidates: NoteLayoutCandidate[] = [
    { id: 'a', targetX: 900, width: 100 },
    { id: 'b', targetX: 950, width: 100 },
    { id: 'c', targetX: 980, width: 100 },
  ];
  const packed = packNotes(candidates, 0, 1000, 5);
  assertNoOverlap(candidates, packed, 5);
  const last = packed.sort((x, y) => x.x - y.x)[packed.length - 1];
  const lastWidth = candidates.find((c) => c.id === last.id)!.width;
  assert.ok(last.x + lastWidth <= 1000 + 0.001, 'the rightmost note stays within maxX when there is enough total room');
});

test('packNotes: more/wider notes than the available width still returns exactly one entry per candidate (no dropping), even if crowded', () => {
  const candidates: NoteLayoutCandidate[] = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, targetX: i * 5, width: 200 }));
  const packed = packNotes(candidates, 0, 300, 5); // way too narrow for 10x200px boxes
  assert.strictEqual(packed.length, candidates.length);
  assert.deepEqual(
    new Set(packed.map((p) => p.id)),
    new Set(candidates.map((c) => c.id)),
  );
});

test('packNotes: zero-width candidates (e.g. a DOM measurement environment that cannot lay out real content, like headless-DOM smoke tests) never throw and still separate by the gap', () => {
  const candidates: NoteLayoutCandidate[] = [
    { id: 'a', targetX: 100, width: 0 },
    { id: 'b', targetX: 100, width: 0 },
    { id: 'c', targetX: 100, width: 0 },
  ];
  const packed = packNotes(candidates, 0, 1000, 5);
  assert.strictEqual(packed.length, 3);
  assertNoOverlap(candidates, packed, 5);
});

test('packNotes: a leftmost note (e.g. an Axis-kind bookmark, always near the gutter) is not dragged toward unrelated competition elsewhere -- with an old one-directional greedy sweep, a chain of notes competing for space anywhere could cascade far enough to eventually drag even an unrelated, distant note along with it (see this file\'s header on why PAVA\'s symmetric adjustment fixes that class of bug: every note stays as close as the least-squares-optimal solution allows).', () => {
  const leftmost: NoteLayoutCandidate = { id: 'axis', targetX: 130, width: 180 };
  // A cluster of otherwise-unrelated notes, close enough together to need some mutual
  // adjustment among THEMSELVES, but not directly competing with `leftmost` at all.
  const cluster: NoteLayoutCandidate[] = Array.from({ length: 6 }, (_, i) => ({ id: `e${i}`, targetX: 900 + i * 40, width: 180 }));
  const packed = packNotes([leftmost, ...cluster], 0, 1400, 8);
  assertNoOverlap([leftmost, ...cluster], packed, 8);
  const axis = packed.find((p) => p.id === 'axis')!;
  assert.ok(axis.x < 400, `the leftmost note should stay near its own target (130), not be dragged into the competing cluster's region; got x=${axis.x}`);
  // It's still the leftmost of the whole packed row (order preserved, so lines never cross).
  for (const p of packed) if (p.id !== 'axis') assert.ok(axis.x <= p.x, `axis note (x=${axis.x}) must stay left of ${p.id} (x=${p.x})`);
});

test('packNotes: order of candidates in the input does not matter (sorted internally by target x)', () => {
  const candidates: NoteLayoutCandidate[] = [
    { id: 'c', targetX: 500, width: 40 },
    { id: 'a', targetX: 100, width: 40 },
    { id: 'b', targetX: 300, width: 40 },
  ];
  const packed = packNotes(candidates, 0, 1000, 5);
  assert.deepEqual(
    packed.sort((x, y) => x.id.localeCompare(y.id)),
    [
      { id: 'a', x: 100 },
      { id: 'b', x: 300 },
      { id: 'c', x: 500 },
    ],
  );
});

test('packNotes: sortKey overrides ordering when targets are nearly identical (e.g. a cluster of Axis-kind bookmarks, all pinned near the same x) -- notes end up ordered by sortKey, not targetX', () => {
  // All three want to sit at essentially the same x (varying only by a few px of nesting
  // indent, like real Axis-bookmark glyphs do) -- targetX alone gives an unstable/
  // near-arbitrary order, so the caller supplies sortKey (here: row position) instead.
  // sortKey = -anchor.y, matching chartMain.ts's repositionBookmarkNotes(): a row further
  // down the (bottom-anchored) axis stack has a LARGER y (closer to the note band below
  // it), giving it a MORE NEGATIVE sortKey -- sorting ascending by sortKey puts it FIRST,
  // i.e. leftmost.
  const candidates: NoteLayoutCandidate[] = [
    { id: 'top', targetX: 132, width: 60, sortKey: -100 }, // smallest y (topmost row) -> least negative sortKey -> should end up RIGHTMOST
    { id: 'middle', targetX: 130, width: 60, sortKey: -200 },
    { id: 'bottom', targetX: 128, width: 60, sortKey: -300 }, // largest y (bottommost row, closest to the band) -> most negative sortKey -> should end up LEFTMOST
  ];
  const packed = packNotes(candidates, 0, 1000, 5);
  assertNoOverlap(candidates, packed, 5);
  const byId = new Map(packed.map((p) => [p.id, p.x]));
  assert.ok(byId.get('bottom')! < byId.get('middle')!, 'bottom (closest row) sits left of middle');
  assert.ok(byId.get('middle')! < byId.get('top')!, 'middle sits left of top (furthest row)');
});

test('packNotes: sortKey defaults to targetX when omitted (no behavior change for callers that never set it)', () => {
  const withKey: NoteLayoutCandidate[] = [
    { id: 'a', targetX: 100, width: 40, sortKey: 100 },
    { id: 'b', targetX: 300, width: 40, sortKey: 300 },
  ];
  const withoutKey: NoteLayoutCandidate[] = [
    { id: 'a', targetX: 100, width: 40 },
    { id: 'b', targetX: 300, width: 40 },
  ];
  assert.deepEqual(packNotes(withKey, 0, 1000, 5), packNotes(withoutKey, 0, 1000, 5));
});
