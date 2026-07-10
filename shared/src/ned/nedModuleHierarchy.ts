import type { Range } from '../model/location';
import { NedResourceCache } from './nedResourceCache';
import { NedTypeInfo } from './nedTypeInfo';
import { SubmoduleInfo, nameNode, submoduleInfo, submoduleNodes } from './nedAst';
import { nodeRange } from '../parser/treeUtils';

/**
 * A node in the type-centric Module Hierarchy: the focused type (root) or one of
 * its submodules. Inherited submodules carry `inheritedFrom` and are labelled
 * `Super::name`. Children are fetched lazily per node via its `typeFqName`.
 *
 * The submodule-tree traversal and `like`-type resolution during recursive
 * expansion below are adapted from
 * ui/org.omnetpp.ned.core/src/org/omnetpp/ned/core/NedTreeTraversal.java /
 * IModuleTreeVisitor.java; the `Super::name` inherited-label formatting is
 * original to this view, not a port.
 */
export interface ModuleHierNode {
  /** Display label: submodule name, or `Super::name` when inherited. */
  label: string;
  /** Submodule name (or the type's simple name for the root). */
  name: string;
  /** Resolved type of this module/submodule (for lazy expansion). */
  typeFqName?: string;
  typeUri?: string;
  typeRange?: Range;
  /** Location of the submodule declaration itself (where it is `name: Type;`). */
  declUri?: string;
  declRange?: Range;
  /** Simple name of the supertype this submodule is inherited from, if any. */
  inheritedFrom?: string;
  isLike?: boolean;
  /** Whether the resolved type has any submodules of its own to explore. */
  hasChildren: boolean;
  /** True for the focused type (the root), so the view can reveal+select it. */
  isSelected?: boolean;
  /** Prebuilt children for the root (its immediate submodules). */
  children?: ModuleHierNode[];
}

function byName(a: [string, SubmoduleInfo], b: [string, SubmoduleInfo]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

function makeNode(
  cache: NedResourceCache,
  label: string,
  name: string,
  sub: SubmoduleInfo,
  owner: NedTypeInfo,
  inheritedFrom: string | undefined,
): ModuleHierNode {
  const resolved = sub.isLike
    ? sub.likeType
      ? cache.lookupType(sub.likeType, owner.file, owner.fqName)
      : undefined
    : sub.type
      ? cache.lookupType(sub.type, owner.file, owner.fqName)
      : undefined;
  const nn = resolved ? nameNode(resolved.node) : undefined;
  const declName = nameNode(sub.node) ?? sub.node;
  return {
    label,
    name,
    typeFqName: resolved?.fqName,
    typeUri: resolved?.file.uri,
    typeRange: resolved && nn ? nodeRange(nn) : undefined,
    declUri: owner.file.uri,
    declRange: nodeRange(declName),
    inheritedFrom,
    isLike: sub.isLike,
    hasChildren: resolved ? resolved.submodules().size > 0 : false,
  };
}

/** Local submodules of a type (declared directly in its body), by name. */
function localSubmoduleEntries(type: NedTypeInfo): [string, SubmoduleInfo][] {
  const out: [string, SubmoduleInfo][] = [];
  for (const node of submoduleNodes(type.node)) {
    const info = submoduleInfo(node);
    if (info.name) out.push([info.name, info]);
  }
  return out;
}

/**
 * The immediate submodules of a type: its own submodules (alphabetical), then
 * the submodules inherited from each supertype along the chain (direct supertype
 * first), alphabetical within each, skipping names already shown (overrides).
 */
export function immediateSubmodules(cache: NedResourceCache, type: NedTypeInfo): ModuleHierNode[] {
  const out: ModuleHierNode[] = [];
  const seen = new Set<string>();

  const vec = (info: SubmoduleInfo) => (info.isVector ? '[]' : '');

  for (const [name, info] of localSubmoduleEntries(type).sort(byName)) {
    seen.add(name);
    out.push(makeNode(cache, name + vec(info), name, info, type, undefined));
  }
  for (const anc of type.ancestors()) {
    for (const [name, info] of localSubmoduleEntries(anc).sort(byName)) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(makeNode(cache, `${anc.simpleName}::${name}${vec(info)}`, name, info, anc, anc.simpleName));
    }
  }
  return out;
}

/** The root node (the focused type) with its immediate submodules prebuilt. */
export function moduleHierarchyRoot(cache: NedResourceCache, type: NedTypeInfo): ModuleHierNode {
  const nn = nameNode(type.node);
  const children = immediateSubmodules(cache, type);
  return {
    label: type.simpleName,
    name: type.simpleName,
    typeFqName: type.fqName,
    typeUri: type.file.uri,
    typeRange: nn ? nodeRange(nn) : undefined,
    hasChildren: children.length > 0,
    isSelected: true,
    children,
  };
}

/** Immediate submodules of a type identified by fq-name (lazy expansion). */
export function moduleHierarchyChildren(cache: NedResourceCache, fqName: string): ModuleHierNode[] {
  const t = cache.getType(fqName);
  return t ? immediateSubmodules(cache, t) : [];
}
