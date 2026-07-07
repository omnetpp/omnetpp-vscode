/**
 * axisOrder.ts (PURE, phase U8) — the four axis-ordering strategies, ported exactly
 * from `org.omnetpp.sequencechart.widgets.axisorder/` (all four Java files read in
 * full; there is no shared interface in Java either — four independent classes
 * dispatched by a switch in `SequenceChart.calculateAxisModulePositions()`):
 *
 *  - `calculateOrderingByModuleId()`   — `AxisOrderByModuleId.java`: stable sort of an
 *    index array by integer module id, inverted into a positions array.
 *  - `calculateOrderingByModuleName()` — `AxisOrderByModuleName.java`: same skeleton,
 *    comparator = `StringUtils.dictionaryCompare` over the module FULL PATH (the
 *    native `opp_strdictcmp`, ported below as `dictionaryCompare()`).
 *  - `calculateOrderingByMinimizingCost()` — `FlatAxisOrderByMinimizingCost.java`'s
 *    bubble sort over the message-dependency weight matrix (the matrix itself comes
 *    from the engine's `elog/sc/adjacencyMatrix`; weights per Java: send=1, reuse=0,
 *    1000 samples when the event range is large).
 *  - Manual — `ManualAxisOrder.java`'s persistent total order over all modules ever
 *    seen, here keyed by module FULL PATH (Java keys by `ModuleTreeItem` object
 *    reference, which only works in-process; paths survive persistence AND a file
 *    overwrite where module ids may shift — the port plan's own "paths survive
 *    overwrite better" note). Pure-function style: the Java methods that mutate
 *    `lastAxisModuleOrder` in place return the updated order here instead.
 *
 * Positions-array contract (all `calculateOrdering*`): input index `i` = current
 * position, `result[i]` = NEW position of that element — apply with `applyOrdering()`.
 */

/** Port of `SequenceChart.AxisOrderingMode { MODULE_ID, MODULE_FULL_PATH, MINIMIZE_CROSSINGS, MANUAL }` (persisted as these string literals in `PersistedChartState.axisOrderingMode`). */
export type AxisOrderingMode = 'moduleId' | 'moduleFullPath' | 'minimizeCrossings' | 'manual';

// ---------------------------------------------------------------------------------
// dictionaryCompare — port of opp_strdictcmp (src/common/stringutil.cc, read in full)
// ---------------------------------------------------------------------------------

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function isAlpha(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

function isUpper(c: string): boolean {
  return c >= 'A' && c <= 'Z';
}

/** `strtod`-like scan of a leading number at `s[i]` (digits, optional fraction/exponent — enough for the digit-run case `opp_strdictcmp` feeds it, which always STARTS at a digit). Returns the parsed value + end index. */
function scanNumber(s: string, start: number): { value: number; end: number } {
  let i = start;
  while (i < s.length && isDigit(s[i])) i++;
  if (s[i] === '.' && isDigit(s[i + 1] ?? '')) {
    i++;
    while (i < s.length && isDigit(s[i])) i++;
  }
  return { value: Number(s.slice(start, i)), end: i };
}

/**
 * Port of `opp_strdictcmp()`: "dictionary" comparison where embedded digit runs
 * compare numerically (`mod2 < mod10`), letters compare case-insensitively first, and
 * ties broken by the FIRST difference found (case of the first differing alpha pair —
 * lowercase in the first string sorts first; or the shorter digit run for
 * equal-valued, different-length numbers). Prefixes sort first. ASCII/C-locale ctype,
 * matching the native implementation.
 */
export function dictionaryCompare(s1: string, s2: string): number {
  let i1 = 0;
  let i2 = 0;
  let firstdiff = 0;
  while (i1 < s1.length && i2 < s2.length) {
    const c1 = s1[i1];
    const c2 = s2[i2];
    if (isDigit(c1) && isDigit(c2)) {
      const n1 = scanNumber(s1, i1);
      const n2 = scanNumber(s2, i2);
      if (n1.value !== n2.value) return n1.value < n2.value ? -1 : 1;
      if (!firstdiff) {
        const len1 = n1.end - i1;
        const len2 = n2.end - i2;
        const common = Math.min(len1, len2);
        const a = s1.slice(i1, i1 + common).toLowerCase();
        const b = s2.slice(i2, i2 + common).toLowerCase();
        firstdiff = a < b ? -1 : a > b ? 1 : 0;
        if (!firstdiff && len1 !== len2) firstdiff = len1 < len2 ? -1 : 1;
      }
      i1 = n1.end;
      i2 = n2.end;
    } else if (c1 === c2) {
      i1++;
      i2++;
    } else {
      const lc1 = c1.toLowerCase();
      const lc2 = c2.toLowerCase();
      if (lc1 !== lc2) return lc1 < lc2 ? -1 : 1;
      if (c1 !== c2 && !firstdiff && isAlpha(c1) && isAlpha(c2)) firstdiff = isUpper(c2) ? -1 : 1;
      i1++;
      i2++;
    }
  }
  if (i1 >= s1.length && i2 >= s2.length) return firstdiff;
  return i2 < s2.length ? -1 : 1;
}

// ---------------------------------------------------------------------------------
// positions-array plumbing (the Java classes' shared index-sort skeleton)
// ---------------------------------------------------------------------------------

/** The shared skeleton of `AxisOrderByModuleId`/`AxisOrderByModuleName`: stable-sort an index array with `compare`, then invert (`axisPositions[sortedIndex[i]] = i`). JS `Array.prototype.sort` is spec-stable (ES2019+), matching Java's TimSort. */
function orderingBy(count: number, compare: (a: number, b: number) => number): number[] {
  const indexes = Array.from({ length: count }, (_, i) => i);
  indexes.sort(compare);
  const positions = new Array<number>(count);
  for (let i = 0; i < indexes.length; i++) positions[indexes[i]] = i;
  return positions;
}

/** `AxisOrderByModuleId.calculateOrdering()` — positions after a stable sort by module id. */
export function calculateOrderingByModuleId(moduleIds: readonly number[]): number[] {
  return orderingBy(moduleIds.length, (a, b) => moduleIds[a] - moduleIds[b]);
}

/** `AxisOrderByModuleName.calculateOrdering()` — positions after a stable sort by `dictionaryCompare` over the module full paths. */
export function calculateOrderingByModuleName(fullPaths: readonly string[]): number[] {
  return orderingBy(fullPaths.length, (a, b) => dictionaryCompare(fullPaths[a], fullPaths[b]));
}

/** Applies a positions array (`positions[i]` = new position of `items[i]`) — the inverse of what the `calculateOrdering*` functions return. */
export function applyOrdering<T>(items: readonly T[], positions: readonly number[]): T[] {
  const result = new Array<T>(items.length);
  for (let i = 0; i < items.length; i++) result[positions[i]] = items[i];
  return result;
}

// ---------------------------------------------------------------------------------
// minimize crossings — FlatAxisOrderByMinimizingCost.java, ported exactly
// ---------------------------------------------------------------------------------

/** Java's `TIME_LIMIT` (wall-clock budget of the whole bubble sort, all passes). */
export const MINIMIZE_CROSSINGS_TIME_LIMIT_MS = 1000;
/** Java's `eventCount` — both the small-range threshold and the approximate-path sample count. */
export const MINIMIZE_CROSSINGS_SAMPLE_COUNT = 1000;

/**
 * `FlatAxisOrderByMinimizingCost.calculateOrdering()`'s bubble sort, operating on
 * axis INDICES (0..n-1) instead of `ModuleTreeItem[]` — the caller identifies axes by
 * their index into whatever list produced the weight `matrix` (row-major n×n, row =
 * cause axis, column = consequence axis, from `elog/sc/adjacencyMatrix`).
 *
 * Exact port notes (all verified against the Java source):
 *  - `cost(p) = Σ_{i≠p} (w[p][i] + w[i][p]) * ((p−i)² − 1)` — adjacent pairs cost 0,
 *    so minimizing pulls heavily-communicating axes next to each other.
 *  - Sweep i ascending, j from i+1 ascending; each candidate pair is swapped
 *    UNCONDITIONALLY (matrix rows AND columns swapped along), cost re-measured at the
 *    same two positions, and reverted unless STRICTLY better (`costAfter < costBefore`
 *    — equal cost never swaps). Later pairs in the same pass see earlier swaps.
 *  - Terminates on a full swap-free pass, or when `now() - begin >= timeLimitMs`
 *    (Java's 1000 ms wall clock). `now` is injectable so tests are deterministic.
 *
 * Returns the positions array (`positions[i]` = new position of input axis `i`),
 * exactly like Java's `getAxisModulePositions()`.
 */
export function calculateOrderingByMinimizingCost(matrix: readonly number[], numberOfAxes: number, timeLimitMs: number = MINIMIZE_CROSSINGS_TIME_LIMIT_MS, now: () => number = Date.now): number[] {
  // working copies: `order[k]` = which ORIGINAL axis currently sits at position k
  const order = Array.from({ length: numberOfAxes }, (_, i) => i);
  const w: number[][] = [];
  for (let i = 0; i < numberOfAxes; i++) w.push(Array.from({ length: numberOfAxes }, (_, j) => matrix[numberOfAxes * i + j] ?? 0));

  const cost = (position: number): number => {
    let c = 0;
    for (let i = 0; i < numberOfAxes; i++) if (i !== position) c += (w[position][i] + w[i][position]) * ((position - i) * (position - i) - 1);
    return c;
  };

  const swap = (index1: number, index2: number): void => {
    const oldOrder = order[index1];
    order[index1] = order[index2];
    order[index2] = oldOrder;
    for (let i = 0; i < numberOfAxes; i++) {
      const old = w[index1][i];
      w[index1][i] = w[index2][i];
      w[index2][i] = old;
    }
    for (let i = 0; i < numberOfAxes; i++) {
      const old = w[i][index1];
      w[i][index1] = w[i][index2];
      w[i][index2] = old;
    }
  };

  const begin = now();
  while (now() - begin < timeLimitMs) {
    let swapped = false;
    for (let i = 0; i < numberOfAxes; i++) {
      for (let j = i + 1; j < numberOfAxes; j++) {
        const costBefore = cost(i) + cost(j);
        swap(i, j);
        const costAfter = cost(i) + cost(j);
        if (costAfter < costBefore) swapped = true;
        else swap(i, j);
      }
    }
    if (!swapped) break;
  }

  // order[k] = original axis at position k  ->  positions[original] = k
  const positions = new Array<number>(numberOfAxes);
  for (let k = 0; k < numberOfAxes; k++) positions[order[k]] = k;
  return positions;
}

// ---------------------------------------------------------------------------------
// manual order — ManualAxisOrder.java, keyed by module full path (see file header)
// ---------------------------------------------------------------------------------

/**
 * `getCurrentAxisModuleOrder()`'s first half: ensures every `selected` path is known
 * to the persistent total order, appending unknown ones AT THE END in `selected`'s own
 * order (Java's exact side effect). Returns the (possibly grown) total order — the
 * caller persists it.
 */
export function ensureInManualOrder(lastOrder: readonly string[], selected: readonly string[]): string[] {
  const result = [...lastOrder];
  const known = new Set(lastOrder);
  for (const path of selected) {
    if (!known.has(path)) {
      known.add(path);
      result.push(path);
    }
  }
  return result;
}

/**
 * `getCurrentAxisModuleOrder()`'s second half: the persistent total order
 * stable-filtered down to the `selected` subset (deduplicated, matching Java's
 * `!currentAxisModuleOrder.contains()` kludge). Callers must pass a `lastOrder`
 * already containing every selected path (i.e. `ensureInManualOrder()`'s result).
 */
export function currentManualOrder(lastOrder: readonly string[], selected: readonly string[]): string[] {
  const selectedSet = new Set(selected);
  const result: string[] = [];
  const added = new Set<string>();
  for (const path of lastOrder) {
    if (selectedSet.has(path) && !added.has(path)) {
      added.add(path);
      result.push(path);
    }
  }
  return result;
}

/**
 * `updateLastAxisModuleOrder()`: splices the user's reordering of the visible subset
 * (`currentOrder` -> `updatedCurrentOrder`, same members) back into the full
 * persistent order, keeping every non-visible module's slot fixed. Exact port of the
 * Java loop: for each visible module, the module that should occupy its old slot is
 * `currentOrder[updatedCurrentOrder.indexOf(module)]`... inverted here the same way
 * Java does it (`updatedLast[lastOrder.indexOf(target)] = module`).
 */
export function updateManualOrder(lastOrder: readonly string[], currentOrder: readonly string[], updatedCurrentOrder: readonly string[]): string[] {
  const result = [...lastOrder];
  for (const path of currentOrder) {
    const target = currentOrder[updatedCurrentOrder.indexOf(path)];
    result[lastOrder.indexOf(target)] = path;
  }
  return result;
}

/**
 * `ManualAxisOrder.calculateOrdering()`: positions of `selectedPaths` per the
 * persistent order. `lastOrder` must already contain every selected path
 * (`ensureInManualOrder()`); a path missing anyway (defensive) sorts to the end,
 * keeping relative input order — the "unknown-module fallback" the U8 test brief
 * names (Java can't hit this case because `getCurrentAxisModuleOrder` always appends
 * first; this port makes the same guarantee explicit instead of returning -1).
 */
export function calculateManualOrdering(lastOrder: readonly string[], selectedPaths: readonly string[]): number[] {
  const order = currentManualOrder(lastOrder, selectedPaths);
  const indexOf = new Map(order.map((p, i) => [p, i]));
  // defensive fallback slots for paths not in `order` (see doc comment)
  let nextFallback = order.length;
  const positions = selectedPaths.map((p) => {
    const known = indexOf.get(p);
    if (known !== undefined) return known;
    return nextFallback++;
  });
  // compress: positions must be a permutation of 0..n-1 even when fallback slots interleave
  const sorted = [...positions].map((pos, i) => ({ pos, i })).sort((a, b) => a.pos - b.pos || a.i - b.i);
  const result = new Array<number>(positions.length);
  sorted.forEach((entry, rank) => (result[entry.i] = rank));
  return result;
}
