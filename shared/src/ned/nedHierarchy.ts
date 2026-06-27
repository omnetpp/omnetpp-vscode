import type { Tree } from 'web-tree-sitter';
import type { Position, Range } from '../model/location';
import { nodeRange } from '../parser/treeUtils';
import { NedResourceCache, NedFileInfo } from './nedResourceCache';
import { NedTypeInfo } from './nedTypeInfo';
import { nameNode } from './nedAst';
import { referenceAt } from './nedNavigation';

/** A host-agnostic type-hierarchy item; mapped to an LSP TypeHierarchyItem by the server. */
export interface NedHierarchyItem {
  fqName: string;
  name: string;
  kind: string;
  detail?: string;
  uri: string;
  range: Range;
  selectionRange: Range;
  /** Whether the type has any direct subtypes (for the tree-view expand marker). */
  hasSubtypes?: boolean;
  /** Prebuilt children for spine/selected nodes (supertype path + selected's subtypes). */
  children?: NedHierarchyItem[];
  /** Subtype node: the client fetches its children lazily via `omnetpp/subtypes`. */
  lazy?: boolean;
  /** Render this node expanded (supertype-chain nodes and the selected node). */
  expanded?: boolean;
  /** The focused/selected type (root of the subtype expansion). */
  isSelected?: boolean;
}

export function hierarchyItemFor(info: NedTypeInfo): NedHierarchyItem {
  return itemFor(info);
}

function itemFor(info: NedTypeInfo): NedHierarchyItem {
  const nn = nameNode(info.node) ?? info.node;
  return {
    fqName: info.fqName,
    name: info.simpleName,
    kind: info.kind,
    detail: info.packageName || undefined,
    uri: info.file.uri,
    range: nodeRange(info.node),
    selectionRange: nodeRange(nn),
    hasSubtypes: info.cache.directSubtypesOf(info.fqName).length > 0,
  };
}

/** The type-hierarchy item for the NED type at a position, if any. */
export function prepareTypeHierarchy(
  cache: NedResourceCache,
  file: NedFileInfo,
  tree: Tree,
  pos: Position,
): NedHierarchyItem | null {
  const ref = referenceAt(cache, file, tree, pos);
  if (!ref) return null;
  const info = ref.kind === 'typeref' ? ref.target : ref.info;
  return info ? itemFor(info) : null;
}

/** Direct supertypes (extends + implements) of a type identified by fq-name. */
export function typeSupertypes(cache: NedResourceCache, fqName: string): NedHierarchyItem[] {
  const t = cache.getType(fqName);
  return t ? t.directSupertypes().map(itemFor) : [];
}

/** Direct subtypes (types that extend/implement the type) of a type by fq-name. */
export function typeSubtypes(cache: NedResourceCache, fqName: string): NedHierarchyItem[] {
  return cache.directSubtypesOf(fqName).map((t) => {
    const it = itemFor(t);
    it.lazy = true; // keep deeper expansion lazy/collapsed
    return it;
  });
}

/**
 * The inheritance spine for `target`: the supertype chain from the root(s) down
 * to the target (each node expanded, showing only the next node toward the
 * target), and the target node expanded to its direct subtypes (which stay
 * collapsed). Subtype nodes below the target are marked lazy.
 */
export function inheritanceSpineFor(cache: NedResourceCache, target: NedTypeInfo): NedHierarchyItem[] {
  const inScope = new Set<string>([target.fqName, ...target.ancestors().map((a) => a.fqName)]);
  const candidates = [target, ...target.ancestors()];
  const rootTypes = candidates.filter((c) => c.directSupertypes().length === 0);
  const roots = new Map<string, NedTypeInfo>(
    (rootTypes.length ? rootTypes : [target]).map((r) => [r.fqName, r]),
  );

  const buildNode = (t: NedTypeInfo, seen: Set<string>): NedHierarchyItem => {
    const item = itemFor(t);
    item.expanded = true;
    if (seen.has(t.fqName)) return item; // cycle guard
    const next = new Set(seen).add(t.fqName);
    if (t.fqName === target.fqName) {
      item.isSelected = true;
      item.children = cache.directSubtypesOf(t.fqName).map((st) => {
        const c = itemFor(st);
        c.lazy = true; // collapsed; expanded on demand
        return c;
      });
    } else {
      item.children = cache
        .directSubtypesOf(t.fqName)
        .filter((st) => inScope.has(st.fqName))
        .map((st) => buildNode(st, next));
    }
    return item;
  };

  return [...roots.values()].map((r) => buildNode(r, new Set()));
}
