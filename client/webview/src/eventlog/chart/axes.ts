/**
 * axes.ts (PURE) — lays out the module-axis list (which modules get an axis row, in
 * which vertical order, at which y position).
 *
 * Phase U8: the axis SET and ORDER are now decided upstream (`openAxisModules.ts`'s
 * `computeVisibleAxisModuleIds()` + `axisOrder.ts`'s ordering strategies —
 * `chartMain.ts`'s `currentAxesLayout()` runs the full pipeline); `layoutAxes()`
 * below takes the already-ordered module id list and only does the vertical layout.
 * The pre-U8 `deriveAxes()` (plain ascending-moduleId over the accumulated
 * `knownModuleIds`) is kept as a thin wrapper — still used as the fallback while the
 * module tree hasn't loaded yet (no tree = no open-module model to consult), and by
 * existing tests.
 *
 * `includeEmptyAxes` (phase U5, port of `showEmptyAxes`, default `false` matching
 * Java): when `false` (the default), only modules actually seen in fetched viewport
 * data (`knownModuleIds`) get an axis — a module the log never produced an event for
 * has no row. When `true`, every module in `moduleTree` (not just ones with events)
 * additionally gets an axis, exactly like Java's "show empty axes" toggle. (In the
 * U8 pipeline this flag is consumed by `computeVisibleAxisModuleIds()` instead —
 * open modules verbatim.)
 *
 * Axis vertical layout: port of `SequenceChart.java`'s axis-spacing modes
 * (`AxisSpacingMode { MANUAL, AUTO }`, `calculateAxisSpacing()`,
 * `SequenceChart.java:236-237, 285-288, 2935-2945` + the layout loop at 2334-2337):
 * AUTO ("Balanced Axes") spreads spacing evenly across the viewport (never tighter
 * than `FONT_HEIGHT_PX + 1`); MANUAL uses a fixed per-axis spacing (min 1 px,
 * `setAxisSpacing()`'s own clamp — "Dense Axes" pins it to `fontHeight + 1`,
 * Increase/Decrease Spacing nudge it ±5). Each axis's `y` is `axisOffset + running
 * spacing/height sum`, spacing added BEFORE each axis line, its thickness after.
 */

import type { ElogModule } from '@omnetpp/shared/elog-protocol';
import { AXIS_OFFSET, FONT_HEIGHT_PX } from './viewportState';

/** Height (px) reserved for an axis that shows a vector-data strip (Eclipse `AxisVectorBarRenderer.getHeight()` = 12), instead of the 1/3px plain line. */
export const AXIS_VECTOR_STRIP_HEIGHT = 12;

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

/** The reverse of `findModuleNode()`'s id lookup -- resolves a module's `fullName` (`ModuleTreeItem.getModuleFullPath()` in Java) back to its id. Phase U6: Axis bookmarks are stored by `modulePath` (survives a session restart, unlike a bare id -- see `Bookmark`'s doc comment in `@omnetpp/shared/ui-protocol`), so rendering an Axis bookmark's mark needs this to find which axis row to decorate. */
export function findModuleIdByFullName(fullName: string, tree: ElogModule | null): number | null {
  if (tree === null) return null;
  const stack: ElogModule[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.fullName === fullName) return node.moduleId;
    stack.push(...node.children);
  }
  return null;
}

/** A module's full dotted path (ancestor `fullName`s joined with `.`, e.g. `"SingleQueue.source"`), used to build the axis-HEADER hierarchy (the merge logic splits on `.` to group siblings under their common compound ancestor). `null` if the id isn't in the tree. */
export function findModuleFullPath(moduleId: number, tree: ElogModule | null): string | null {
  const walk = (node: ElogModule, prefix: string): string | null => {
    const path = prefix ? `${prefix}.${node.fullName}` : node.fullName;
    if (node.moduleId === moduleId) return path;
    for (const child of node.children) {
      const found = walk(child, path);
      if (found !== null) return found;
    }
    return null;
  };
  return tree === null ? null : walk(tree, '');
}

/** Resolves a full dotted path (`findModuleFullPath`'s output, e.g. `"SingleQueue.source"`) back to its module id, walking the tree segment by segment. Used to map an axis HEADER (which carries a dotted path) back to its compound module for the expand/collapse/close glyphs. `null` if any segment doesn't resolve. */
export function findModuleIdByFullPath(fullPath: string, tree: ElogModule | null): number | null {
  if (tree === null || fullPath === '') return null;
  const segments = fullPath.split('.');
  if (segments[0] !== tree.fullName) return null;
  let node: ElogModule = tree;
  for (let i = 1; i < segments.length; i++) {
    const next = node.children.find((c) => c.fullName === segments[i]);
    if (!next) return null;
    node = next;
  }
  return node.moduleId;
}

/** Flattens every module id in `tree` (all descendants, compound and simple alike) -- used by `deriveAxes()`'s `includeEmptyAxes` option. */
function allModuleIds(tree: ElogModule | null): number[] {
  if (tree === null) return [];
  const ids: number[] = [];
  const stack: ElogModule[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    ids.push(node.moduleId);
    stack.push(...node.children);
  }
  return ids;
}

/** Axis-spacing mode + manual value (phase U8) — port of `AxisSpacingMode { MANUAL, AUTO }` + the `axisSpacing` field. "Balanced"/"Dense" are ACTION names in Java, not modes: Balanced = AUTO; Dense = MANUAL pinned to `FONT_HEIGHT_PX + 1`. */
export interface AxisSpacingSpec {
  mode: 'auto' | 'manual';
  /** Only used when `mode === 'manual'`; already clamped by the caller (`setAxisSpacing()`'s `Math.max(1, …)`). */
  manualSpacing: number;
}

export const AUTO_AXIS_SPACING: AxisSpacingSpec = { mode: 'auto', manualSpacing: 0 };

/** `setAxisSpacing()`'s own clamp (`SequenceChart.java:2907-2911`) — minimum 1 px, no maximum. */
export function clampAxisSpacing(spacing: number): number {
  return Math.max(1, spacing);
}

/** The "Dense Axes" manual spacing value — `getFontHeight(null) + 1` in Java, which is also AUTO mode's floor. */
export const DENSE_AXIS_SPACING = FONT_HEIGHT_PX + 1;

/**
 * Phase U8: vertical layout for an ALREADY-ordered module id list (the output of
 * `computeVisibleAxisModuleIds()` + an `axisOrder.ts` strategy). `moduleTree` (may be
 * `null` before `elog/getModuleTree` resolves) supplies names/compound-ness; a module
 * id not yet found in the tree falls back to a synthetic `"Module #<id>"` label so an
 * axis still renders (just unnamed) rather than being dropped. Spacing per
 * `spacing` — see `AxisSpacingSpec`.
 */
export function layoutAxes(orderedModuleIds: readonly number[], moduleTree: ElogModule | null, contentHeightPx: number, spacing: AxisSpacingSpec = AUTO_AXIS_SPACING, stripModuleIds?: ReadonlySet<number>): AxesLayout {
  const resolved = orderedModuleIds.map((moduleId) => {
    const found = findModuleName(moduleId, moduleTree);
    const compound = found?.compound ?? false;
    // A module showing a vector-data strip reserves the strip height BELOW its line (Eclipse
    // AxisVectorBarRenderer hangs the bar from `axis.y` down to `axis.y + height`, not
    // centered -- see `canvasStack.ts`'s `axisVectorStrip` case); this loop already reserves
    // exactly that span, since `lineHeight` is added to `y` AFTER placing `axis.y`, not split
    // around it. Otherwise the plain 3px (compound) / 1px (simple) line thickness.
    const lineHeight = stripModuleIds?.has(moduleId) ? AXIS_VECTOR_STRIP_HEIGHT : compound ? 3 : 1;
    return { moduleId, label: found?.label ?? `Module #${moduleId}`, compound, lineHeight };
  });

  const totalLineHeights = resolved.reduce((sum, a) => sum + a.lineHeight, 0);
  const effectiveSpacing =
    spacing.mode === 'manual'
      ? clampAxisSpacing(spacing.manualSpacing)
      : resolved.length === 0
        ? 1
        : Math.max(FONT_HEIGHT_PX + 1, (contentHeightPx - AXIS_OFFSET * 2 - totalLineHeights) / resolved.length);

  const axes: AxisInfo[] = [];
  let y = AXIS_OFFSET;
  for (const a of resolved) {
    y += effectiveSpacing;
    axes.push({ ...a, y: Math.round(y) });
    y += a.lineHeight;
  }

  // Java `calculateVirtualSize()`: the scrollable content height is `totalAxesHeight +
  // n*spacing + axisOffset*2` -- a BOTTOM margin mirroring the TOP one already baked into
  // `y`'s starting point (`y = AXIS_OFFSET` above), so the axis stack gets the same
  // breathing room below its last axis as above its first. Without this second AXIS_OFFSET,
  // `maxVerticalScroll()` came up short by up to 2*AXIS_OFFSET px -- sometimes clamping to
  // 0 outright -- leaving the LAST axis permanently just out of reach of any scroll/drag,
  // however tall the axis stack (reported: couldn't drag far enough to see e.g. Aloha's
  // "server" module at the bottom). An empty axis stack legitimately needs no margin at all.
  const totalHeight = resolved.length === 0 ? 0 : Math.max(0, y + AXIS_OFFSET);

  return { axes, totalHeight, spacing: effectiveSpacing };
}

/**
 * Pre-U8 derivation, kept as the module-tree-not-yet-loaded fallback (and for the
 * existing U3-U5 tests): every accumulated `knownModuleIds` member gets an axis, in
 * plain ascending-moduleId order, AUTO spacing. `includeEmptyAxes` -- see this file's
 * header.
 */
export function deriveAxes(knownModuleIds: ReadonlySet<number>, moduleTree: ElogModule | null, contentHeightPx: number, includeEmptyAxes = false): AxesLayout {
  const idSet = includeEmptyAxes ? new Set([...knownModuleIds, ...allModuleIds(moduleTree)]) : knownModuleIds;
  const ids = [...idSet].sort((a, b) => a - b);
  return layoutAxes(ids, moduleTree, contentHeightPx, AUTO_AXIS_SPACING);
}

/** Max useful `vscroll` value so the axis stack never scrolls past its own content. */
export function maxVerticalScroll(layout: AxesLayout, contentHeightPx: number): number {
  return Math.max(0, layout.totalHeight - contentHeightPx);
}
