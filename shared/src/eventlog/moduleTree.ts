/**
 * buildModuleTree() — the module hierarchy DTO the Sequence Chart's axis-selection UI
 * (U8) and the module-tree filter panel (U7) need. Ported (intent, not the mutable
 * incremental API) from:
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/common/eventlog/EventLogInput.java
 *     (the `moduleTreeRoot` field + `getModuleTreeRoot()`/`synchronizeModuleTree()`)
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/common/eventlog/ModuleTreeItem.java
 *
 * DESIGN CHOICE (reported per the E6 task): Java's `ModuleTreeItem` is a mutable,
 * incrementally-patched tree -- `EventLogInput.synchronizeModuleTree()` is called
 * repeatedly as the file grows, walking `eventLog.getEventLogEntryCache()
 * .getModuleDescriptionEntries()` each time and *adding* any new module it doesn't
 * already know about via `ModuleTreeItem.addDescendantModule()` (which asserts the
 * parent must already exist in the tree). It also has a placeholder-replacement dance
 * for `ModuleTreeItem`s named `"<unknown>"`, created only by
 * `SequenceChart.java` (a UI-side "let me reference this module's axis before I've
 * actually seen its description entry" trick, not by `EventLogInput` itself) and
 * spliced out here once the real description arrives.
 *
 * This port is a **pure, one-shot function**: `buildModuleTree(eventLog)` always
 * rebuilds the whole tree from the eventlog's *current* `ModuleDescriptionEntry` set
 * (calling it again after more of the file has been parsed naturally picks up newly
 * discovered modules -- the caller doesn't need to hold any tree state between calls).
 * This deliberately drops two pieces of Java-only, incremental-specific plumbing that
 * have no purpose in a pure function:
 *  - the `"<unknown>"` placeholder/replacement dance (there is nothing to placehold --
 *    a one-shot build only ever sees real `ModuleDescriptionEntry` objects);
 *  - `ModuleTreeItem`'s mutable `moduleIdToModuleMap`/`addSubmodule()`/`remove()` API
 *    (no longer needed once there's no "patch the existing tree" operation to support).
 * A plain two-pass build (index all `ModuleDescriptionEntry`s by module id, then link
 * each to its parent) is used instead of Java's "assert the parent node already exists"
 * single pass, since nothing here guarantees `getModuleDescriptionEntries()` (ascending
 * module-id order, per `EventLogEntryCache`'s `SortedMap`) lists a parent before every
 * one of its children under every possible eventlog content -- though in practice it
 * always does, since OMNeT++ always creates a compound module before its submodules.
 *
 * Preserved from Java (real behavior, not incremental plumbing):
 *  - only the FIRST module description entry with `parentModuleId === -1` becomes the
 *    tree root -- Java's `if (moduleTreeRoot == null) moduleTreeRoot = ...` has no
 *    `else` branch, so any further top-level entries are silently dropped rather than
 *    starting a forest. A real `.elog` always has exactly one top-level (network)
 *    module, so this never actually triggers in practice.
 *  - `ModuleTreeItem.addSubmodule()` unconditionally sets `isCompoundModule = true` on
 *    the parent when a child is attached, independent of the parent's own `"cm"` flag
 *    as read from its `ModuleDescriptionEntry` -- ported as `parent.compound = true`
 *    whenever a child is linked.
 *  - child order matches `getModuleDescriptionEntries()`'s ascending module-id order
 *    (Java's `submodules` `ArrayList` is built by insertion order of `addSubmodule()`
 *    calls, driven by that same ascending-order iteration).
 *
 * An orphan entry (a `parentModuleId` that names no known module, e.g. because that
 * module's own description hasn't been parsed into the cache yet) is dropped quietly
 * rather than asserting like Java's `addDescendantModule()` does -- consistent with
 * this being a pure, re-callable snapshot rather than an incrementally-patched tree: a
 * later call (once the parent's entry has since been parsed) picks it up correctly.
 */

import type { ModuleDescriptionEntry } from './entries';
import type { IEventLog } from './ieventlog';

/** DTO shape for one module in the tree (per the port plan's protocol sketch). */
export interface ElogModule {
  moduleId: number;
  fullName: string;
  nedTypeName: string;
  moduleClassName: string;
  compound: boolean;
  children: ElogModule[];
}

/**
 * Builds the module hierarchy for `eventLog`'s currently-known
 * `ModuleDescriptionEntry`s (see this file's header for how this differs from Java's
 * incrementally-patched `ModuleTreeItem` tree). Returns `null` if the eventlog
 * describes no modules at all (e.g. an empty or not-yet-parsed file).
 */
export function buildModuleTree(eventLog: IEventLog): ElogModule | null {
  const entries = eventLog.getEventLogEntryCache().getModuleDescriptionEntries(); // ascending module-id order

  const nodes = new Map<number, ElogModule>();
  for (const entry of entries) nodes.set(entry.moduleId, moduleDescriptionEntryToNode(entry));

  let root: ElogModule | null = null;
  for (const entry of entries) {
    const node = nodes.get(entry.moduleId)!;
    if (entry.parentModuleId === -1) {
      // only the first top-level entry becomes the root -- see this file's header
      if (root === null) root = node;
    } else {
      const parent = nodes.get(entry.parentModuleId);
      if (parent !== undefined) {
        parent.children.push(node);
        parent.compound = true; // port of ModuleTreeItem.addSubmodule()'s unconditional promotion
      }
      // else: orphan entry (parent not yet known) -- dropped quietly, see this file's header
    }
  }
  return root;
}

function moduleDescriptionEntryToNode(entry: ModuleDescriptionEntry): ElogModule {
  return {
    moduleId: entry.moduleId,
    fullName: entry.fullName,
    nedTypeName: entry.nedTypeName,
    moduleClassName: entry.moduleClassName,
    compound: entry.compoundModule,
    children: [],
  };
}
