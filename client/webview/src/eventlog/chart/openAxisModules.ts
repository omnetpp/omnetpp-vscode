/**
 * openAxisModules.ts (PURE, phase U8) — the "open axis modules" model, ported from
 * `SequenceChart.java`'s OPEN AXIS MODULES / VISIBLE AXIS MODULES sections
 * (`SequenceChart.java:2005-2281`, read in full).
 *
 * Semantics (verified against the Java source, NOT the naive "children of open
 * modules" reading):
 *  - `openAxisModules` is a list of modules that MAY each have an axis — a set of cut
 *    points in the module tree, in no particular order (Java: an `ArrayList` of
 *    `ModuleTreeItem` references).
 *  - The axes actually shown (`calculateVisibleAxisModules()`): for every module with
 *    ACTIVITY in the loaded range, walk UP the parent chain until hitting an open
 *    module — that open module gets the axis (dedup, discovery order). An open module
 *    with no activity anywhere under it gets no axis. With `showEmptyAxes` on, the
 *    open list is the axis list verbatim, activity ignored.
 *  - Events/dependencies of a module WITHOUT its own axis render on the nearest open
 *    ancestor's axis (Java's `calculateModuleIdToAxisModuleIndexMap()` — ported as
 *    `moduleIdToAxisModuleIdMap()` and threaded into `drawList.ts`).
 *  - Expand (glyph/menu) is INCREMENTAL: append the module's direct submodules.
 *    Collapse prunes every open strict descendant. Remove deletes one module.
 *    `openModule`/`openModuleRecursively` (double-click, presets, Open Compound/Open
 *    Parent) REPLACE the whole open set.
 *  - Default open set on first open (Java `setup()`):
 *    `openModuleRecursively(root)` — every module in the tree.
 *
 * REPRESENTATION (this port's own decision, documented): in memory the open set is a
 * `readonly number[]` of module ids (insertion-ordered like Java's ArrayList; ids are
 * what the engine DTOs speak). PERSISTED as module full paths
 * (`PersistedChartState.openAxisModulePaths` — paths survive a window reload AND a
 * file overwrite where ids may shift, unlike Eclipse's in-process object references;
 * same reasoning as Axis bookmarks' `modulePath`, see `uiProtocol.ts`).
 */

import type { ElogModule, RenderDependency, RenderMethodCall, TimelineEvent } from '@omnetpp/shared/elog-protocol';
import { dependencyPassesDisplayFlags } from './drawList';
import type { ChartDisplayFlags } from './displayFlags';

/** `moduleId -> parent moduleId` for every module in `tree` (root maps to `null`). One O(n) walk; callers cache per tree instance. */
export function buildParentMap(tree: ElogModule | null): Map<number, number | null> {
  const parents = new Map<number, number | null>();
  if (tree === null) return parents;
  const stack: { node: ElogModule; parent: number | null }[] = [{ node: tree, parent: null }];
  while (stack.length > 0) {
    const { node, parent } = stack.pop()!;
    parents.set(node.moduleId, parent);
    for (const child of node.children) stack.push({ node: child, parent: node.moduleId });
  }
  return parents;
}

/** `moduleId -> node` lookup for every module in `tree`. */
export function buildNodeMap(tree: ElogModule | null): Map<number, ElogModule> {
  const nodes = new Map<number, ElogModule>();
  if (tree === null) return nodes;
  const stack: ElogModule[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    nodes.set(node.moduleId, node);
    stack.push(...node.children);
  }
  return nodes;
}

/** Resolves open-module ids to full paths (for persistence); ids the tree doesn't know are dropped (nothing durable to store for them). */
export function moduleIdsToPaths(ids: readonly number[], tree: ElogModule | null): string[] {
  const nodes = buildNodeMap(tree);
  return ids.map((id) => nodes.get(id)?.fullName).filter((p): p is string => p !== undefined);
}

/** Resolves persisted full paths back to module ids against the (possibly changed) tree; unresolvable paths are dropped. */
export function pathsToModuleIds(paths: readonly string[], tree: ElogModule | null): number[] {
  if (tree === null) return [];
  const byPath = new Map<string, number>();
  const stack: ElogModule[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    byPath.set(node.fullName, node.moduleId);
    stack.push(...node.children);
  }
  return paths.map((p) => byPath.get(p)).filter((id): id is number => id !== undefined);
}

// ---------------------------------------------------------------------------------
// open-set operations (each returns a NEW array; Java mutates + invalidates instead)
// ---------------------------------------------------------------------------------

/** Port of `openModule()`: REPLACE the open set with `[module, ...its direct submodules]`. */
export function openModule(moduleId: number, tree: ElogModule | null): number[] {
  const node = buildNodeMap(tree).get(moduleId);
  if (!node) return [moduleId];
  return [node.moduleId, ...node.children.map((c) => c.moduleId)];
}

/** Port of `addAllSubmodules()` (used by `openModuleRecursively` and the default open set): the module itself, then per child — simple modules as leaves, compound modules recursively (compounds are included TOO, via the recursive self-add). */
function addAllSubmodules(into: number[], node: ElogModule): void {
  into.push(node.moduleId);
  for (const child of node.children) {
    if (!child.compound) into.push(child.moduleId);
    else addAllSubmodules(into, child);
  }
}

/** Port of `openModuleRecursively()`: REPLACE the open set with the module + every descendant (Java's default preset applies this to the tree root). */
export function openModuleRecursively(moduleId: number, tree: ElogModule | null): number[] {
  const node = buildNodeMap(tree).get(moduleId);
  if (!node) return [moduleId];
  const result: number[] = [];
  addAllSubmodules(result, node);
  return result;
}

/** The default open set on first open — Java `setup()`: `openModuleRecursively(root)`. Empty when the tree isn't loaded yet. */
export function defaultOpenAxisModules(tree: ElogModule | null): number[] {
  return tree === null ? [] : openModuleRecursively(tree.moduleId, tree);
}

/** Port of `expandOpenAxisModule()`: INCREMENTAL — append the module's direct submodules not already open (the module itself stays open). */
export function expandOpenAxisModule(open: readonly number[], moduleId: number, tree: ElogModule | null): number[] {
  const node = buildNodeMap(tree).get(moduleId);
  if (!node) return [...open];
  const openSet = new Set(open);
  const result = [...open];
  for (const child of node.children) {
    if (!openSet.has(child.moduleId)) {
      openSet.add(child.moduleId);
      result.push(child.moduleId);
    }
  }
  return result;
}

/** Port of the contributor's "Expand Axis Module Recursively": append EVERY descendant not already open (all levels, compound and simple alike — the contributor's local `addAllSubmodules` walk over the existing open list). */
export function expandOpenAxisModuleRecursively(open: readonly number[], moduleId: number, tree: ElogModule | null): number[] {
  const node = buildNodeMap(tree).get(moduleId);
  if (!node) return [...open];
  const openSet = new Set(open);
  const result = [...open];
  const visit = (n: ElogModule): void => {
    if (!openSet.has(n.moduleId)) {
      openSet.add(n.moduleId);
      result.push(n.moduleId);
    }
    for (const child of n.children) visit(child);
  };
  visit(node);
  return result;
}

/** All STRICT descendants of `moduleId` (not the module itself). */
function strictDescendantIds(node: ElogModule): Set<number> {
  const ids = new Set<number>();
  const stack: ElogModule[] = [...node.children];
  while (stack.length > 0) {
    const n = stack.pop()!;
    ids.add(n.moduleId);
    stack.push(...n.children);
  }
  return ids;
}

/** Port of `collapseOpenAxisModule()`: remove every open module that is a STRICT descendant of `moduleId` (the whole subtree collapses onto the module's own axis; the module itself stays open). */
export function collapseOpenAxisModule(open: readonly number[], moduleId: number, tree: ElogModule | null): number[] {
  const node = buildNodeMap(tree).get(moduleId);
  if (!node) return [...open];
  const descendants = strictDescendantIds(node);
  return open.filter((id) => !descendants.has(id));
}

/** Port of the contributor's "Collapse Axis Module Submodules": for each DIRECT submodule, remove its open strict descendants (one level deeper than plain Collapse — the direct submodules themselves stay open). */
export function collapseOpenAxisModuleSubmodules(open: readonly number[], moduleId: number, tree: ElogModule | null): number[] {
  const node = buildNodeMap(tree).get(moduleId);
  if (!node) return [...open];
  const toRemove = new Set<number>();
  for (const child of node.children) for (const id of strictDescendantIds(child)) toRemove.add(id);
  return open.filter((id) => !toRemove.has(id));
}

/** Port of `removeOpenAxisModule()`: remove exactly one module (its subtree's events reattach to the nearest still-open ancestor, or disappear). */
export function removeOpenAxisModule(open: readonly number[], moduleId: number): number[] {
  return open.filter((id) => id !== moduleId);
}

/** Port of the axis-HEADER close glyph's dispatch (`mouseUp`'s `visitItems` loop): remove the module AND every descendant from the open set. */
export function removeOpenAxisModuleSubtree(open: readonly number[], moduleId: number, tree: ElogModule | null): number[] {
  const node = buildNodeMap(tree).get(moduleId);
  if (!node) return removeOpenAxisModule(open, moduleId);
  const ids = strictDescendantIds(node);
  ids.add(moduleId);
  return open.filter((id) => !ids.has(id));
}

// ---------------------------------------------------------------------------------
// visible-axis derivation + event->axis attribution
// ---------------------------------------------------------------------------------

/**
 * Port of `collectPotentiallyVisibleModuleIds()` (`SequenceChart.java:2168-2231`): which
 * modules currently have real, VISIBLE activity in `model` -- the set that justifies an
 * axis when `showEmptyAxes` is off. Deliberately re-derived from the raw
 * events/dependencies/methodCalls (not `ViewportModel.moduleIds`, which the engine builds
 * from ALL of them unconditionally): a module credited only by something the CURRENT
 * display flags are hiding -- an `initialize()`-caused message while
 * `showInitializationEvent` is off, a reuse dependency while `showMessageReuses` is off,
 * etc. -- must NOT count as "active," or its axis appears with nothing drawn on it (the
 * "empty modules sometimes get added" bug this fixes). Shares
 * `dependencyPassesDisplayFlags()` (drawList.ts) with the actual dependency-drawing code so
 * the two can never drift apart. Like Java, this is a snapshot of the CURRENTLY FETCHED
 * viewport window, not an accumulation across the whole session -- the visible-axis set is
 * meant to track "what's relevant to look at right now," matching Java's own
 * `getFirstLastEventForViewportRange`-scoped collection, not "everything ever seen."
 */
export function collectActiveModuleIds(model: { events: readonly TimelineEvent[]; dependencies: readonly RenderDependency[]; methodCalls: readonly RenderMethodCall[] }, flags: ChartDisplayFlags): Set<number> {
  const ids = new Set<number>();
  for (const event of model.events) {
    if (!flags.showInitializationEvent && event.eventNumber === 0) continue;
    ids.add(event.moduleId);
  }
  for (const dep of model.dependencies) {
    if (!dependencyPassesDisplayFlags(dep, flags)) continue;
    if (dep.causeModuleId !== null) ids.add(dep.causeModuleId);
    if (dep.consequenceModuleId !== null) ids.add(dep.consequenceModuleId);
  }
  if (flags.showComponentMethodCalls) {
    for (const call of model.methodCalls) {
      if (!flags.showInitializationEvent && call.eventNumber === 0) continue;
      ids.add(call.sourceModuleId);
      ids.add(call.targetModuleId);
    }
  }
  return ids;
}

/**
 * Port of `calculateVisibleAxisModules()` — see this file's header for the exact
 * semantics. `activeModuleIds` plays the role of Java's
 * `collectPotentiallyVisibleModuleIds()` (`collectActiveModuleIds()` above); iterated in
 * ascending order for determinism (Java iterates a HashSet — unspecified order; the
 * ordering strategies applied afterwards make the base order irrelevant for MODULE_ID/
 * MODULE_FULL_PATH and both MANUAL and MINIMIZE_CROSSINGS re-base on the manual total order
 * anyway).
 */
export function computeVisibleAxisModuleIds(open: readonly number[], activeModuleIds: ReadonlySet<number>, tree: ElogModule | null, showEmptyAxes: boolean): number[] {
  if (showEmptyAxes) return [...open];
  const openSet = new Set(open);
  const parents = buildParentMap(tree);
  const result: number[] = [];
  const added = new Set<number>();
  for (const activeId of [...activeModuleIds].sort((a, b) => a - b)) {
    let id: number | null | undefined = activeId;
    // walk up until an open module is found (a module unknown to the tree can still
    // match itself if it is directly open; otherwise it has no parent chain to walk)
    while (id !== null && id !== undefined) {
      if (openSet.has(id)) {
        if (!added.has(id)) {
          added.add(id);
          result.push(id);
        }
        break;
      }
      id = parents.has(id) ? parents.get(id) : null;
    }
  }
  return result;
}

/**
 * Port of `calculateModuleIdToAxisModuleIndexMap()`, keyed by module id instead of
 * index: maps EVERY module in the tree (plus any `extraIds` seen in viewport data but
 * missing from the tree) to the module id of the nearest visible-axis
 * ancestor-or-self, so `drawList.ts` can draw a closed submodule's events on its
 * ancestor's axis. Modules with no open-axis ancestor are absent from the map (their
 * events simply don't draw — same as Java's `null` axis mapping).
 */
export function moduleIdToAxisModuleIdMap(visibleAxisModuleIds: readonly number[], tree: ElogModule | null, extraIds?: Iterable<number>): Map<number, number> {
  const axisSet = new Set(visibleAxisModuleIds);
  const parents = buildParentMap(tree);
  const map = new Map<number, number>();
  const resolve = (startId: number): number | undefined => {
    let id: number | null | undefined = startId;
    while (id !== null && id !== undefined) {
      if (axisSet.has(id)) return id;
      id = parents.has(id) ? parents.get(id) : null;
    }
    return undefined;
  };
  for (const id of parents.keys()) {
    const axisId = resolve(id);
    if (axisId !== undefined) map.set(id, axisId);
  }
  if (extraIds) {
    for (const id of extraIds) {
      if (map.has(id)) continue;
      const axisId = resolve(id);
      if (axisId !== undefined) map.set(id, axisId);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------------
// glyph visibility conditions (layoutAxis/layoutAxisHeader's allSubmodulesOpen /
// noSubmodulesOpen booleans, SequenceChart.java:2507-2553)
// ---------------------------------------------------------------------------------

export interface ModuleGlyphInfo {
  /** Expand glyph shown: compound module with at least one direct submodule NOT open. */
  expand: boolean;
  /** Collapse glyph shown: compound module with at least one direct submodule open. */
  collapse: boolean;
}

/** Java's per-axis/per-header glyph conditions. A simple module (or one without children) shows neither expand nor collapse; the close glyph is unconditional (handled by the caller). `nodeMap` (optional): a prebuilt `buildNodeMap(tree)`, so per-frame callers computing glyphs for MANY axes do one tree walk instead of one per axis. */
export function moduleGlyphInfo(moduleId: number, open: readonly number[], tree: ElogModule | null, nodeMap?: Map<number, ElogModule>): ModuleGlyphInfo {
  const node = (nodeMap ?? buildNodeMap(tree)).get(moduleId);
  if (!node || !node.compound || node.children.length === 0) return { expand: false, collapse: false };
  const openSet = new Set(open);
  let allSubmodulesOpen = true;
  let noSubmodulesOpen = true;
  for (const child of node.children) {
    if (openSet.has(child.moduleId)) noSubmodulesOpen = false;
    else allSubmodulesOpen = false;
  }
  return { expand: !allSubmodulesOpen, collapse: !noSubmodulesOpen };
}
