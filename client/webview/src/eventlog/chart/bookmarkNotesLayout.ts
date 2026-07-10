/**
 * bookmarkNotesLayout.ts (PURE) — the "Bookmark Info" note boxes' horizontal packing: given
 * each note's already-measured DOM width (`chartMain.ts` gets this via a real
 * `getBoundingClientRect()` pass -- see that file's note-layer refresh) and the timeline x it
 * would ideally sit under (its bookmark's flag-glyph anchor), choose a final x per note so
 * that none overlap, arranged in a single row, staying AS CLOSE AS POSSIBLE to each note's own
 * target x. No DOM/canvas access -- fully unit-testable in isolation.
 *
 * Sorting first (by `sortKey`, or `targetX` when no candidate needs a distinct one) is what
 * actually minimizes callout-line crossings: with every note on one row and every glyph
 * somewhere above/around it, two connector lines can only cross when a note's left-to-right
 * order disagrees with its own glyph's natural order -- so keeping the notes in a sort order
 * that tracks the glyphs' own layout (never reordered relative to each other after that)
 * guarantees zero crossings by construction, independent of how much any individual note
 * gets nudged to avoid overlapping its neighbors. `sortKey` exists because that "natural
 * order" isn't always x: e.g. a whole cluster of Axis-kind bookmarks sit at nearly the SAME
 * x (their glyphs are pinned to the left gutter, only nudged by nesting depth), so sorting
 * them by x is close to arbitrary/unstable -- their actual row position (y) is the dimension
 * that varies meaningfully and is what a caller should sort them by instead.
 *
 * The nudging itself is the classic "isotonic regression" / Pool Adjacent Violators Algorithm
 * (PAVA) solution to "adjust points to satisfy a minimum-gap ordering constraint with minimum
 * total displacement": convert each target into an equivalent unconstrained value by
 * subtracting the cumulative width+gap of every earlier note (turning "no overlap" into a
 * plain "non-decreasing" constraint), find the least-squares-closest non-decreasing sequence
 * via PAVA, then convert back. Unlike a one-directional greedy sweep (which leaves the FIRST
 * note glued to its own target and dumps the entire required separation onto whichever later
 * note collides with it -- compounding without bound as more notes compete for the same
 * region), PAVA distributes the necessary adjustment symmetrically between BOTH neighbors, so
 * a note is never dragged far from its bookmark just because other, unrelated notes happen to
 * be nearby.
 */

export interface NoteLayoutCandidate {
  id: string;
  /** The x this note would ideally sit under (its bookmark's on-screen anchor). */
  targetX: number;
  /** The note's own measured/desired width. */
  width: number;
  /** Overrides sort order (see this file's header on why x isn't always the right sort dimension); defaults to `targetX` when omitted. Placement itself still targets `targetX`, not this. */
  sortKey?: number;
}

export interface PackedNote {
  id: string;
  x: number;
}

/**
 * The least-squares-closest non-decreasing sequence to `values` (Pool Adjacent Violators
 * Algorithm): a single left-to-right pass maintaining a stack of "blocks", each an
 * already-non-decreasing-internally run collapsed to its weighted average. A new point that
 * would violate monotonicity against the last block gets merged into it (weighted-averaged),
 * and the merge cascades backward as long as the result still violates the block before that.
 */
function poolAdjacentViolators(values: readonly number[]): number[] {
  const blockValue: number[] = [];
  const blockWeight: number[] = [];
  const blockCount: number[] = [];
  for (const v of values) {
    let value = v;
    let weight = 1;
    let count = 1;
    while (blockValue.length > 0 && blockValue[blockValue.length - 1] > value) {
      const pw = blockWeight.pop()!;
      const pc = blockCount.pop()!;
      value = (blockValue.pop()! * pw + value * weight) / (pw + weight);
      weight += pw;
      count += pc;
    }
    blockValue.push(value);
    blockWeight.push(weight);
    blockCount.push(count);
  }
  const result: number[] = [];
  for (let b = 0; b < blockValue.length; b++) for (let k = 0; k < blockCount[b]; k++) result.push(blockValue[b]);
  return result;
}

/** `gap`: minimum horizontal space kept between adjacent notes. */
export function packNotes(candidates: readonly NoteLayoutCandidate[], minX: number, maxX: number, gap: number): PackedNote[] {
  if (candidates.length === 0) return [];
  const sorted = [...candidates].sort((a, b) => (a.sortKey ?? a.targetX) - (b.sortKey ?? b.targetX));
  const n = sorted.length;

  // Cumulative width+gap of every EARLIER note -- subtracting this turns "box i's left edge
  // must be >= box (i-1)'s right edge + gap" into a plain "non-decreasing" constraint on
  // (targetX - prefix), which is exactly what PAVA solves optimally.
  const prefix: number[] = new Array(n);
  prefix[0] = 0;
  for (let i = 1; i < n; i++) prefix[i] = prefix[i - 1] + sorted[i - 1].width + gap;

  const isotonic = poolAdjacentViolators(sorted.map((c, i) => c.targetX - prefix[i]));
  const x = isotonic.map((y, i) => y + prefix[i]);

  // Clamp into [minX, maxX]: shift the whole (already non-overlapping) chain right if it
  // starts before minX; if it still runs past maxX (too many/too wide notes for the
  // available width -- a genuine degenerate case), pull back from the right edge, cascading
  // left only as far as each neighbor's own gap allows. Some residual overflow past maxX in
  // that extreme case is an accepted trade-off (crowded, never hidden/dropped).
  if (x[0] < minX) {
    const shift = minX - x[0];
    for (let i = 0; i < n; i++) x[i] += shift;
  }
  const lastRight = x[n - 1] + sorted[n - 1].width;
  if (lastRight > maxX) {
    x[n - 1] -= lastRight - maxX;
    for (let i = n - 2; i >= 0; i--) {
      const maxAllowed = x[i + 1] - sorted[i].width - gap;
      if (x[i] > maxAllowed) x[i] = maxAllowed;
      else break;
    }
  }

  return sorted.map((c, i) => ({ id: c.id, x: x[i] }));
}
