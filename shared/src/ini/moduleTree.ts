import { NedResourceCache } from '../ned/nedResourceCache';
import { NedTypeInfo } from '../ned/nedTypeInfo';
import { nameNode, SubmoduleInfo } from '../ned/nedAst';
import { nodeRange } from '../parser/treeUtils';
import type { Range } from '../model/location';
import { iniKeyToRegex } from './keyMatch';

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

/** An INI `**.x.typename = "Name"` that resolved a `like` slot to >1 candidate
 *  types (ambiguous — OMNeT++ rejects it). Surfaced as a diagnostic on the entry. */
export interface LikeAmbiguity {
  /** the resolved slot's instance path. */
  path: string;
  /** the unqualified type name that matched several implementers. */
  typeName: string;
  /** fq-names of the matching candidate types. */
  candidates: string[];
}

export interface ExpandResult {
  modules: ModuleNode[];
  truncated: boolean;
  /** INI-sourced ambiguous `typename` resolutions (for diagnostics). */
  ambiguities: LikeAmbiguity[];
}

/** A NED `<sub>.typename = ...` deep assignment, compiled relative to the instance
 *  where its declaring type was expanded. Accumulated down the traversal so that
 *  deeper (later-added) rules win for the non-default case and the shallowest wins
 *  for the default case — matching OMNeT++'s parent-chain walk. */
interface NedTypeRule {
  re: RegExp;
  typeName: string;
  isDefault: boolean;
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

/** Append `type`'s `<sub>.typename = ...` deep assignments to the accumulated rules,
 *  compiled against this instance's normalized path so they match descendant slots. */
function compileNedRules(type: NedTypeInfo, instanceNorm: string, base: NedTypeRule[]): NedTypeRule[] {
  const patterns = type.typenamePatterns();
  if (!patterns.length) return base;
  const rules = base.slice();
  for (const p of patterns) {
    if (!p.typeName || !p.prefixPattern) continue; // non-literal or bare `typename` → skip
    rules.push({ re: iniKeyToRegex(`${instanceNorm}.${p.prefixPattern}`), typeName: p.typeName, isDefault: p.isDefault });
  }
  return rules;
}

/** Choose the concrete type name(s) for a `like` slot, in OMNeT++ precedence order.
 *  Returns the candidate names plus whether they came from the INI `typename` source
 *  (the only source whose ambiguity we surface via INI diagnostics). */
function resolveLikeTypeNames(
  sub: SubmoduleInfo,
  slotNorm: string,
  nedRules: NedTypeRule[],
  typenamesFor?: (slotNorm: string) => string[],
): { names: string[]; fromIni: boolean } {
  // 1. fixed angle-bracket `<"X">` — highest, not overridable
  if (sub.likeFixedType) return { names: [sub.likeFixedType], fromIni: false };
  // 2. NED non-default `<sub>.typename = "X"` deep assignment — innermost (deepest) wins
  let nonDefault: string | undefined;
  for (const r of nedRules) if (!r.isDefault && r.re.test(slotNorm)) nonDefault = r.typeName;
  if (nonDefault !== undefined) return { names: [nonDefault], fromIni: false };
  // 3. INI `typename` binding
  const ini = typenamesFor?.(slotNorm) ?? [];
  if (ini.length) return { names: ini, fromIni: true };
  // 4. NED `<sub>.typename = default("X")` deep assignment — outermost (shallowest) wins
  for (const r of nedRules) if (r.isDefault && r.re.test(slotNorm)) return { names: [r.typeName], fromIni: false };
  // 5. default angle-bracket `<default("X")>` — lowest
  if (sub.likeDefaultType) return { names: [sub.likeDefaultType], fromIni: false };
  return { names: [], fromIni: false };
}

/**
 * Expand the module tree of a network into module nodes with their parameters.
 *
 * A `like` submodule's concrete type is resolved with OMNeT++'s exact precedence
 * (`getSubmoduleTypeName`): (1) a fixed `<"X">` bracket, (2) a non-`default()` NED
 * `<sub>.typename` deep assignment (innermost wins), (3) the INI `typename` binding
 * (`typenamesFor`), (4) a `default()` NED deep assignment (outermost wins), (5) the
 * `<default("X")>` bracket. The chosen name is resolved against the `like` interface;
 * if it resolves the subtree is expanded fully (no longer `open`), with `typename`
 * kept as an assignable pseudo-parameter.
 *
 * The precedence order mirrors `cNedNetworkBuilder::getSubmoduleTypeName()`
 * (src/sim/netbuilder/cnednetworkbuilder.cc), as re-derived for the IDE's static
 * (non-simulation) resolution by `InifileUtils.resolveLikeExpr()`
 * (ui/org.omnetpp.inifile.core/src/org/omnetpp/inifile/core/model/InifileUtils.java),
 * which cites the same C++ function as its source of truth.
 */
export function expandNetwork(
  cache: NedResourceCache,
  root: NedTypeInfo,
  typenamesFor?: (slotNorm: string) => string[],
): ExpandResult {
  const modules: ModuleNode[] = [];
  const ambiguities: LikeAmbiguity[] = [];
  let nodeCount = 0;
  let truncated = false;

  const visit = (type: NedTypeInfo | undefined, path: string, stack: Set<string>, depth: number, open: boolean, nedRules: NedTypeRule[]): void => {
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

    // Accumulate this type's `<sub>.typename = ...` deep assignments, compiled
    // relative to this instance path (they target descendant `like` slots). Later
    // (deeper) rules are appended after inherited/ancestor ones.
    const myRules = compileNedRules(type, norm(path), nedRules);

    for (const [subName, sub] of type.submodules()) {
      const vec = sub.isVector ? '[*]' : '';
      const subPath = `${path}.${subName}${vec}`;
      // 'typename' is assignable for `like` submodules
      if (sub.isLike) {
        const iface = sub.likeType ? cache.lookupType(sub.likeType, type.file, type.fqName) : undefined;
        const slotNorm = norm(subPath);
        const { names, fromIni } = resolveLikeTypeNames(sub, slotNorm, myRules, typenamesFor);
        // Because vector indices are normalized to [], a single `like` slot can match
        // several INI typename bindings (e.g. `app[0]="UdpSink"` and `app[*]="UdpBasicApp"`)
        // — treat it as possibly ANY of them and expose the union of their parameters.
        const concretes: NedTypeInfo[] = [];
        for (const name of names) {
          const c = cache.lookupLikeType(name, iface);
          if (c && !concretes.some((t) => t.fqName === c.fqName)) concretes.push(c);
          else if (!c && fromIni && !name.includes('.')) {
            const cands = cache.lookupLikeCandidates(name, iface);
            if (cands.length > 1) ambiguities.push({ path: subPath, typeName: name, candidates: cands.map((t) => t.fqName) });
          }
        }
        if (concretes.length) {
          const idx = modules.length;
          visit(concretes[0], subPath, nextStack, depth + 1, false, myRules);
          const node = modules[idx];
          if (node && node.path === subPath) {
            for (let i = 1; i < concretes.length; i++) mergeParams(node, concretes[i]);
            node.params.set('typename', 'string'); // keep typename assignable
            node.defaulted.add('typename');
          }
          continue;
        }
        // Unresolved concrete type: emit an open interface node (typename assignable).
        visitLike(iface, subPath, nextStack, depth + 1);
        continue;
      }
      const subType = sub.type ? cache.lookupType(sub.type, type.file, type.fqName) : undefined;
      visit(subType, subPath, nextStack, depth + 1, false, myRules);
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
        visit(undefined, `${path}.${subName}${vec}`, ns, depth + 1, true, []);
      }
    }
  };

  visit(root, root.simpleName, new Set(), 0, false, []);
  return { modules, truncated, ambiguities };
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
    nedRules: NedTypeRule[],
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
    const myRules = compileNedRules(type, norm(path), nedRules);
    for (const [subName, sub] of type.submodules()) {
      const label = subName + (sub.isVector ? '[]' : '');
      const subPath = `${path}.${subName}${sub.isVector ? '[*]' : ''}`;
      if (sub.isLike) {
        const iface = sub.likeType ? cache.lookupType(sub.likeType, type.file, type.fqName) : undefined;
        // Resolve the concrete type via the NED-intrinsic precedence (no INI context here):
        // fixed bracket, NED deep typename assignments, then default bracket.
        const { names } = resolveLikeTypeNames(sub, norm(subPath), myRules);
        const concrete = names.length ? cache.lookupLikeType(names[0], iface) : undefined;
        node.children.push(concrete
          ? build(concrete, label, subPath, nextStack, depth + 1, false, myRules)
          : build(iface, label, subPath, nextStack, depth + 1, true, myRules));
      } else {
        const subType = sub.type ? cache.lookupType(sub.type, type.file, type.fqName) : undefined;
        node.children.push(build(subType, label, subPath, nextStack, depth + 1, false, myRules));
      }
    }
    return node;
  };

  return build(root, root.simpleName, root.simpleName, new Set(), 0, false, []);
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
