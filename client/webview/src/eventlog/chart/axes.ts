/**
 * axes.ts (PURE) — derives the module-axis list (which modules get an axis row, in
 * which vertical order, at which y position) from the accumulated set of module ids
 * seen across fetched `ViewportModel`s plus (optionally) the module tree
 * (`elog/getModuleTree`, for names/compound-ness).
 *
 * SIMPLIFICATION (documented, matches the plan's own "U8 adds algorithms" note):
 * ordering is plain ascending `moduleId` for now — Java's 3 real ordering algorithms
 * (declaration order / minimize-crossings via the adjacency matrix / manual) are
 * phase U8. An "only show modules with events" filter (Java's empty-axes toggle) is
 * always-on here (there is no "show empty axes" toggle yet) since every axis in this
 * module's output already comes from `knownModuleIds` (ids actually seen in fetched
 * data), never from the full module tree.
 *
 * Axis vertical layout: port of `SequenceChart.java`'s `AUTO` axis-spacing mode
 * (`calculateAxisSpacing()`/the axis-layout loop, `SequenceChart.java:2334-2337,
 * 2938`): spacing is spread evenly across the viewport (never tighter than
 * `FONT_HEIGHT_PX + 1`), and each axis's `y` is `axisOffset + running spacing/height
 * sum`, spacing added BEFORE each axis line, its own thickness added after.
 */

import type { ElogModule } from '@omnetpp/shared/elog-protocol';
import { AXIS_OFFSET, FONT_HEIGHT_PX } from './viewportState';

export interface AxisInfo {
  moduleId: number;
  label: string;
  compound: boolean;
  /** Y offset (CSS px) of this axis's line, relative to the top of the (unscrolled) axis stack -- i.e. before `viewport.vscroll` is subtracted. */
  y: number;
  /** Axis line rendering thickness -- `AxisLineRenderer.getHeight()`: 3px for compound modules (double-line look), 1px for simple modules. */
  lineHeight: number;
}

export interface AxesLayout {
  axes: AxisInfo[];
  /** Total height (CSS px) of the whole axis stack, for vertical-scrollbar range/clamping. */
  totalHeight: number;
  /** The (AUTO-mode) spacing applied above each axis. */
  spacing: number;
}

/** Finds `moduleId`'s node in the module tree, or `null` if not (yet) known. Exported for reuse by `labelProvider.ts` (U4), which needs the same lookup for tooltip module names/types. */
export function findModuleNode(moduleId: number, tree: ElogModule | null): ElogModule | null {
  if (tree === null) return null;
  const stack: ElogModule[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.moduleId === moduleId) return node;
    stack.push(...node.children);
  }
  return null;
}

function findModuleName(moduleId: number, tree: ElogModule | null): { label: string; compound: boolean } | null {
  const node = findModuleNode(moduleId, tree);
  return node ? { label: node.fullName, compound: node.compound } : null;
}

/**
 * Builds the ordered axis list + vertical layout for `knownModuleIds` (accumulated
 * across fetched viewports -- see renderModelCache.ts). `moduleTree` (may be `null`
 * before `elog/getModuleTree` resolves) supplies names/compound-ness; a module id not
 * yet found in the tree falls back to a synthetic `"Module #<id>"` label so an axis
 * still renders (just unnamed) rather than being dropped.
 */
export function deriveAxes(knownModuleIds: ReadonlySet<number>, moduleTree: ElogModule | null, contentHeightPx: number): AxesLayout {
  const ids = [...knownModuleIds].sort((a, b) => a - b);
  const resolved = ids.map((moduleId) => {
    const found = findModuleName(moduleId, moduleTree);
    return {
      moduleId,
      label: found?.label ?? `Module #${moduleId}`,
      compound: found?.compound ?? false,
      lineHeight: (found?.compound ?? false) ? 3 : 1,
    };
  });

  const totalLineHeights = resolved.reduce((sum, a) => sum + a.lineHeight, 0);
  const spacing = resolved.length === 0 ? 1 : Math.max(FONT_HEIGHT_PX + 1, (contentHeightPx - AXIS_OFFSET * 2 - totalLineHeights) / resolved.length);

  const axes: AxisInfo[] = [];
  let y = AXIS_OFFSET;
  for (const a of resolved) {
    y += spacing;
    axes.push({ ...a, y: Math.round(y) });
    y += a.lineHeight;
  }

  return { axes, totalHeight: Math.max(0, y - AXIS_OFFSET), spacing };
}

/** Max useful `vscroll` value so the axis stack never scrolls past its own content. */
export function maxVerticalScroll(layout: AxesLayout, contentHeightPx: number): number {
  return Math.max(0, layout.totalHeight - contentHeightPx);
}
