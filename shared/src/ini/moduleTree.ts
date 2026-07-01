import { NedResourceCache } from '../ned/nedResourceCache';
import { NedTypeInfo } from '../ned/nedTypeInfo';
import { nameNode } from '../ned/nedAst';
import { nodeRange } from '../parser/treeUtils';
import type { Range } from '../model/location';

/** Extra per-parameter metadata used for value-level checks. */
export interface ParamMeta {
  unit?: string;
  enumValues?: string[];
  /** the NED default value expression text, if any. */
  default?: string;
}

export interface ModuleNode {
  /** Full dotted path with vector indices collapsed to [*], e.g. Net.host[*] */
  path: string;
  /** path with indices collapsed to [] (for pattern comparison). */
  norm: string;
  type?: string; // module type fqName
  /** the resolved NED type of this module (for locating param declarations). */
  typeInfo?: NedTypeInfo;
  /** param name -> declared NED type. */
  params: Map<string, string | undefined>;
  /** param name -> unit/enum/default metadata. */
  paramMeta: Map<string, ParamMeta>;
  /**
   * param name -> the concrete NED type that declares it. Usually `typeInfo`, but
   * for a `like` slot whose typename resolves to several candidate types (one per
   * vector index) this records the actual owner of each unioned parameter, so
   * navigation/references can find the right NED declaration.
   */
  paramOwner: Map<string, NedTypeInfo>;
  /** names of params that have a default value in NED (no ini assignment required). */
  defaulted: Set<string>;
  /**
   * True if this module's set of params/submodules is not fully known
   * (e.g. it was reached via a `like` submodule, its type was unresolved, or
   * recursion was pruned). Callers should not report "no matching parameter"
   * for keys targeting an open module.
   */
  open: boolean;
}

export interface ExpandResult {
  modules: ModuleNode[];
  truncated: boolean;
}

export interface ParamSlot {
  path: string;
  norm: string;
  name: string;
  type?: string;
  hasDefault: boolean;
  unit?: string;
  enumValues?: string[];
  /** the NED default value expression text, if any. */
  default?: string;
  /** true if reached via a like/unresolved subtree (don't report as "missing"). */
  open: boolean;
}

const MAX_DEPTH = 25;
const MAX_NODES = 50000;

function norm(s: string): string {
  return s.replace(/\[[^\]]*\]/g, '[]');
}

/**
 * Expand the module tree of a network into module nodes with their parameters.
 * When `typenameFor` is supplied, a `like` submodule whose `typename` is bound
 * (typically by an INI `**.x.typename = T` assignment) is resolved to its concrete
 * type and expanded fully (the subtree is no longer `open`), while still exposing
 * `typename` as an assignable pseudo-parameter.
 */
export function expandNetwork(
  cache: NedResourceCache,
  root: NedTypeInfo,
  typenamesFor?: (slotNorm: string) => string[],
): ExpandResult {
  const modules: ModuleNode[] = [];
  let nodeCount = 0;
  let truncated = false;

  const visit = (type: NedTypeInfo | undefined, path: string, stack: Set<string>, depth: number, open: boolean): void => {
    if (truncated) return;
    if (depth > MAX_DEPTH || nodeCount > MAX_NODES) {
      truncated = true;
      return;
    }
    nodeCount++;

    const params = new Map<string, string | undefined>();
    const paramMeta = new Map<string, ParamMeta>();
    const paramOwner = new Map<string, NedTypeInfo>();
    const defaulted = new Set<string>();
    let nodeOpen = open || !type;
    if (type) {
      for (const [name, info] of type.params()) {
        params.set(name, info.type);
        paramMeta.set(name, { unit: info.unit, enumValues: info.enumValues, default: info.value });
        paramOwner.set(name, type);
        if (info.value !== undefined) defaulted.add(name);
      }
    }

    const recursive = type ? stack.has(type.fqName) : false;
    if (recursive) nodeOpen = true;

    modules.push({ path, norm: norm(path), type: type?.fqName, typeInfo: type, params, paramMeta, paramOwner, defaulted, open: nodeOpen });

    if (!type || recursive) return;
    const nextStack = new Set(stack).add(type.fqName);

    for (const [subName, sub] of type.submodules()) {
      const vec = sub.isVector ? '[*]' : '';
      const subPath = `${path}.${subName}${vec}`;
      // 'typename' is assignable for `like` submodules
      if (sub.isLike) {
        const iface = sub.likeType ? cache.lookupType(sub.likeType, type.file, type.fqName) : undefined;
        // The concrete type may be bound (e.g. via an INI typename assignment).
        // Because vector indices are normalized to [], a single `like` slot can
        // match several typename bindings (e.g. `app[0]="UdpSink"` and
        // `app[*]="UdpBasicApp"`) — treat it as possibly ANY of them and expose the
        // union of their parameters, so a param declared on only one candidate type
        // still matches.
        const chosen = typenamesFor?.(norm(subPath)) ?? [];
        const concretes: NedTypeInfo[] = [];
        for (const name of chosen) {
          const c = cache.lookupLikeType(name, iface);
          if (c && !concretes.some((t) => t.fqName === c.fqName)) concretes.push(c);
        }
        if (concretes.length) {
          const idx = modules.length;
          visit(concretes[0], subPath, nextStack, depth + 1, false);
          const node = modules[idx];
          if (node && node.path === subPath) {
            for (let i = 1; i < concretes.length; i++) mergeParams(node, concretes[i]);
            node.params.set('typename', 'string'); // keep typename assignable
            node.defaulted.add('typename');
          }
          continue;
        }
        // otherwise the submodule node is open (concrete type unknown), typename valid
        visitLike(iface, subPath, nextStack, depth + 1);
        continue;
      }
      const subType = sub.type ? cache.lookupType(sub.type, type.file, type.fqName) : undefined;
      visit(subType, subPath, nextStack, depth + 1, false);
    }
  };

  /** Union another candidate concrete type's own params into a like-slot node
   *  (first candidate wins for shared params' metadata). */
  const mergeParams = (node: ModuleNode, type: NedTypeInfo): void => {
    for (const [name, info] of type.params()) {
      if (node.params.has(name)) continue;
      node.params.set(name, info.type);
      node.paramMeta.set(name, { unit: info.unit, enumValues: info.enumValues, default: info.value });
      node.paramOwner.set(name, type);
      if (info.value !== undefined) node.defaulted.add(name);
    }
  };

  const visitLike = (iface: NedTypeInfo | undefined, path: string, stack: Set<string>, depth: number): void => {
    // emit an open module node carrying interface params + a typename pseudo-param
    if (truncated) return;
    if (depth > MAX_DEPTH || nodeCount > MAX_NODES) {
      truncated = true;
      return;
    }
    nodeCount++;
    const params = new Map<string, string | undefined>();
    const paramMeta = new Map<string, ParamMeta>();
    const paramOwner = new Map<string, NedTypeInfo>();
    params.set('typename', 'string');
    if (iface) for (const [name, info] of iface.params()) {
      params.set(name, info.type);
      paramMeta.set(name, { unit: info.unit, enumValues: info.enumValues, default: info.value });
      paramOwner.set(name, iface);
    }
    modules.push({ path, norm: norm(path), type: iface?.fqName, typeInfo: iface, params, paramMeta, paramOwner, defaulted: new Set(['typename']), open: true });
    // recurse into interface submodules (rare) but keep open
    if (iface && !stack.has(iface.fqName)) {
      const ns = new Set(stack).add(iface.fqName);
      for (const [subName, sub] of iface.submodules()) {
        const vec = sub.isVector ? '[*]' : '';
        visit(undefined, `${path}.${subName}${vec}`, ns, depth + 1, true);
      }
    }
  };

  visit(root, root.simpleName, new Set(), 0, false);
  return { modules, truncated };
}

/** A parameter of a module node (for the Module Parameters view). */
export interface ModuleParam {
  name: string;
  type?: string;
  default?: string;
  hasDefault: boolean;
  unit?: string;
  /** Location of the NED declaration (declaring type may be an ancestor). */
  uri?: string;
  range?: Range;
}

/** A nested module-tree node, for the Module Hierarchy / Parameters views. */
export interface ModuleTreeNode {
  name: string;
  path: string;
  typeFqName?: string;
  typeUri?: string;
  typeRange?: Range;
  isLike: boolean;
  open: boolean;
  /** This module's own parameters (incl. inherited), with declaration locations. */
  params: ModuleParam[];
  children: ModuleTreeNode[];
}

/** Collect a module type's parameters with their NED declaration locations. */
function nodeParams(type: NedTypeInfo | undefined, isLike: boolean): ModuleParam[] {
  const out: ModuleParam[] = [];
  if (isLike) out.push({ name: 'typename', type: 'string', hasDefault: false });
  if (!type) return out;
  for (const [name, info] of type.params()) {
    const decl = type.paramDecl(name);
    const dn = decl ? nameNode(decl.node) ?? decl.node : undefined;
    out.push({
      name,
      type: info.type,
      default: info.value,
      hasDefault: info.value !== undefined,
      unit: info.unit,
      uri: decl?.owner.file.uri,
      range: dn ? nodeRange(dn) : undefined,
    });
  }
  return out;
}

/** Build the nested submodule tree of a network, for display in a tree view. */
export function networkModuleTree(cache: NedResourceCache, root: NedTypeInfo): ModuleTreeNode {
  let nodeCount = 0;

  const build = (
    type: NedTypeInfo | undefined,
    name: string,
    path: string,
    stack: Set<string>,
    depth: number,
    isLike: boolean,
  ): ModuleTreeNode => {
    const nn = type ? nameNode(type.node) : undefined;
    const node: ModuleTreeNode = {
      name,
      path,
      typeFqName: type?.fqName,
      typeUri: type?.file.uri,
      typeRange: type && nn ? nodeRange(nn) : undefined,
      isLike,
      open: isLike || !type,
      params: nodeParams(type, isLike),
      children: [],
    };
    if (!type) return node;
    if (depth > MAX_DEPTH || nodeCount > MAX_NODES || stack.has(type.fqName)) return node;
    nodeCount++;
    const nextStack = new Set(stack).add(type.fqName);
    for (const [subName, sub] of type.submodules()) {
      const label = subName + (sub.isVector ? '[]' : '');
      const subPath = `${path}.${subName}${sub.isVector ? '[*]' : ''}`;
      if (sub.isLike) {
        const iface = sub.likeType ? cache.lookupType(sub.likeType, type.file, type.fqName) : undefined;
        node.children.push(build(iface, label, subPath, nextStack, depth + 1, true));
      } else {
        const subType = sub.type ? cache.lookupType(sub.type, type.file, type.fqName) : undefined;
        node.children.push(build(subType, label, subPath, nextStack, depth + 1, false));
      }
    }
    return node;
  };

  return build(root, root.simpleName, root.simpleName, new Set(), 0, false);
}

/** Flatten module nodes into individual parameter slots. */
export function paramSlots(result: ExpandResult): ParamSlot[] {
  const out: ParamSlot[] = [];
  for (const m of result.modules) {
    for (const [name, type] of m.params) {
      const meta = m.paramMeta.get(name);
      out.push({
        path: `${m.path}.${name}`,
        norm: `${m.norm}.${name}`,
        name,
        type,
        hasDefault: m.defaulted.has(name),
        unit: meta?.unit,
        enumValues: meta?.enumValues,
        default: meta?.default,
        open: m.open,
      });
    }
  }
  return out;
}
