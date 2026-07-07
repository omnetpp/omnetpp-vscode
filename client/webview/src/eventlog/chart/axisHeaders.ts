/**
 * axisHeaders.ts (PURE) — port of `SequenceChart.java`'s `calculateAxisHeaders()` /
 * `mergeSiblingAxisHeaders()` / `mergeDescendantAxisHeaders()`
 * (`SequenceChart.java:2399-2489`, verified by reading the source), which groups the
 * left-gutter axis labels into merged spans for compound modules ("Net.host[3]" and
 * "Net.host[4]" sharing the "host" ancestor draw ONE header box spanning both axes,
 * not two"). Only ADJACENT axes with a common path-component prefix merge — two axes
 * of the same compound module separated by an unrelated axis do NOT merge into one
 * span (this is Java's own behavior, not a simplification: `mergeSiblingAxisHeaders`
 * only ever accumulates a contiguous run before flushing on the first prefix change).
 *
 * `drawAxisHeaders()`'s own rule (`SequenceChart.java:4312-4319`, `axisHeader.children.
 * size() != 0`) is that only a MERGED (>=2-descendant) node gets an actual drawn
 * header box — a single unmerged leaf axis draws no header at all (its own
 * `axisLabel` in the gutter is enough). `flattenDrawableAxisHeaders()` below applies
 * that same filter.
 */

interface RawHeader {
  /** The still-to-be-merged remainder of this node's module path (dot-separated), or (post-merge) the JOINED label for a collapsed multi-level span. */
  modulePathFragment: string;
  axisIndexStart: number;
  axisCount: number;
  /** The real module id for an unmerged leaf; `null` for a synthetic merged/ancestor group (this port never resolves a synthetic group back to an actual compound module id — callers needing one can look it up via the group's `label` + the module tree, same as `findModuleNode()` in `axes.ts`). */
  moduleId: number | null;
  children: RawHeader[];
}

export interface AxisHeaderNode {
  label: string;
  axisIndexStart: number;
  axisCount: number;
  moduleId: number | null;
  children: AxisHeaderNode[];
}

function firstPathComponent(path: string): string {
  const dot = path.indexOf('.');
  return dot === -1 ? path : path.slice(0, dot);
}

function stripFirstPathComponent(path: string): string {
  const dot = path.indexOf('.');
  return dot === -1 ? '' : path.slice(dot + 1);
}

/** Port of `mergeSiblingAxisHeaders()` — groups ADJACENT same-first-component children, recursing one level into each freshly merged group (a run of exactly 1 passes through with its fragment UNCHANGED, per Java's `addMergedAxisHeaders`'s `commonAxisHeaders.size() == 1` branch). */
function mergeSiblings(children: RawHeader[]): RawHeader[] {
  if (children.length < 2) return children;
  const merged: RawHeader[] = [];
  let run: RawHeader[] = [];
  let runPrefix: string | null = null;

  const flushRun = (): void => {
    if (run.length === 0) return;
    if (run.length === 1) {
      merged.push(run[0]);
    } else {
      const axisIndexStart = run[0].axisIndexStart;
      const axisCount = run.reduce((sum, r) => sum + r.axisCount, 0);
      const rewritten = run.map((r) => ({ ...r, modulePathFragment: stripFirstPathComponent(r.modulePathFragment) }));
      merged.push({ modulePathFragment: runPrefix!, axisIndexStart, axisCount, moduleId: null, children: mergeSiblings(rewritten) });
    }
    run = [];
  };

  for (const child of children) {
    const prefix = firstPathComponent(child.modulePathFragment);
    if (runPrefix === null || prefix === runPrefix) {
      runPrefix = prefix;
      run.push(child);
    } else {
      flushRun();
      runPrefix = prefix;
      run.push(child);
    }
  }
  flushRun();
  return merged;
}

/** Port of `mergeDescendantAxisHeaders()` — collapses single-child chains, joining path fragments with `.`. */
function mergeDescendants(node: RawHeader): RawHeader {
  if (node.children.length === 1) {
    const child = mergeDescendants(node.children[0]);
    const label = node.modulePathFragment === '' ? child.modulePathFragment : `${node.modulePathFragment}.${child.modulePathFragment}`;
    return { modulePathFragment: label, axisIndexStart: node.axisIndexStart, axisCount: node.axisCount, moduleId: child.moduleId, children: child.children };
  }
  return { ...node, children: node.children.map(mergeDescendants) };
}

function toAxisHeaderNode(raw: RawHeader): AxisHeaderNode {
  return { label: raw.modulePathFragment, axisIndexStart: raw.axisIndexStart, axisCount: raw.axisCount, moduleId: raw.moduleId, children: raw.children.map(toAxisHeaderNode) };
}

/**
 * Builds the merged axis-header tree for `orderedModuleIds` (axis order — index `i` is
 * axis `i`'s position, matching `AxesLayout.axes`'s own order). `fullPathOf` resolves a
 * module id to its full dotted path (e.g. `"Net.host[3].app"`, via `findModuleNode()`
 * in `axes.ts`); a module id the tree can't resolve falls back to `"Module #<id>"`
 * (matching `axes.ts`'s own convention) so it still participates in header layout
 * (as its own unmergeable singleton) rather than crashing.
 */
export function calculateAxisHeaders(orderedModuleIds: readonly number[], fullPathOf: (moduleId: number) => string): AxisHeaderNode | null {
  if (orderedModuleIds.length === 0) return null;
  const leaves: RawHeader[] = orderedModuleIds.map((moduleId, i) => ({ modulePathFragment: fullPathOf(moduleId), axisIndexStart: i, axisCount: 1, moduleId, children: [] }));
  const mergedChildren = mergeSiblings(leaves);
  const root: RawHeader = { modulePathFragment: '', axisIndexStart: 0, axisCount: orderedModuleIds.length, moduleId: null, children: mergedChildren };
  return toAxisHeaderNode(mergeDescendants(root));
}

export interface DrawableAxisHeader {
  label: string;
  level: number;
  axisIndexStart: number;
  axisCount: number;
  moduleId: number | null;
  /**
   * Phase U8: the header's full dotted module path (ancestor labels joined with its
   * own — e.g. a level-1 header labeled `"host[3]"` under the root header `"net"` has
   * `fullPath === "net.host[3]"`). Used to resolve the header back to a real module
   * (`findModuleIdByFullName`) for the expand/collapse/close glyph actions; empty for
   * the synthetic root. Note a merged multi-level label (`"a.b"`) already contains
   * its dots, so the composition below stays a plain join.
   */
  fullPath: string;
}

/**
 * Flattens `root` into the (only) nodes Java actually draws a header box for --
 * `children.length !== 0`, i.e. merged/ancestor groups, never a lone unmerged leaf
 * (`SequenceChart.java:4312-4319`'s own filter). `level` is depth from the root
 * (0-based), for indentation -- Java's `AxisHeader.level` (`layoutAxisHeader()`).
 */
export function flattenDrawableAxisHeaders(root: AxisHeaderNode | null, level = 0, parentPath = ''): DrawableAxisHeader[] {
  if (root === null) return [];
  const out: DrawableAxisHeader[] = [];
  const fullPath = root.label === '' ? parentPath : parentPath === '' ? root.label : `${parentPath}.${root.label}`;
  if (root.children.length !== 0) out.push({ label: root.label, level, axisIndexStart: root.axisIndexStart, axisCount: root.axisCount, moduleId: root.moduleId, fullPath });
  for (const child of root.children) out.push(...flattenDrawableAxisHeaders(child, level + 1, fullPath));
  return out;
}
