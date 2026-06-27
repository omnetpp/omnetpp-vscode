import type { Range } from '../model/location';
import { NedResourceCache } from './nedResourceCache';
import { NedTypeInfo } from './nedTypeInfo';
import { ParamInfo, SubmoduleInfo, nameNode, paramInfo, paramNodes } from './nedAst';
import { nodeRange } from '../parser/treeUtils';

/**
 * A node in the type-centric Module Parameters tree. A `module` node groups its
 * own parameters (alphabetical), then inherited parameters (`Super::name`), then
 * its submodules (own alphabetical, then inherited `Super::name`); each submodule
 * is itself a `module` node that expands recursively. A `param` node is a leaf.
 */
export interface ParamHierNode {
  kind: 'module' | 'param';
  label: string;
  /** Location to navigate to (param declaration, submodule declaration, or type). */
  declUri?: string;
  declRange?: Range;
  inheritedFrom?: string;
  // module-only
  typeFqName?: string;
  isLike?: boolean;
  isSelected?: boolean;
  hasChildren?: boolean;
  children?: ParamHierNode[];
  /** Normalized instance path from the network root (config mode only). */
  path?: string;
  // param-only
  paramType?: string;
  /** The value in effect (primary row) or the shadowed value (overridden row). */
  paramValue?: string;
  paramUnit?: string;
  /** True for a shadowed assignment/default that is overridden (render greyed). */
  overridden?: boolean;
  /** True when the effective value comes from the active configuration (INI). */
  fromConfig?: boolean;
  /** True when no value is in effect (no NED default and no config assignment). */
  unset?: boolean;
  /** simpleName of the type whose assignment provides this value (or config name). */
  valueOwner?: string;
  /** simpleName of the type that declares the parameter. */
  declaredIn?: string;
  // module-only: parameter assignments from this submodule's declaration body
  // (e.g. `host: Host { txRate = parent.txRate; }`), applied when expanded.
  subAssign?: Record<string, ParamAssign>;
}

/** A located value (config assignment, submodule-body assignment, ...). */
export interface ParamAssign {
  value: string;
  uri: string;
  range: Range;
}

export type ConfigParamHit = ParamAssign;

/** Resolves a normalized parameter path to its winning config assignment, if any. */
export type ParamResolve = (normPath: string) => ConfigParamHit | undefined;

/** Options for config-aware / instance-aware param-view computation. */
export interface ParamViewOpts {
  /** Normalized instance path of the current module (network-rooted). */
  path?: string;
  /** Active configuration name (shown as the value owner for config values). */
  configName?: string;
  /** Resolve a parameter path to its config assignment. */
  resolve?: ParamResolve;
  /** This module-instance's own parameter assignments (from its submodule body). */
  subAssign?: Record<string, ParamAssign>;
}

function byName<T>(a: [string, T], b: [string, T]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

function resolveSubType(cache: NedResourceCache, sub: SubmoduleInfo, owner: NedTypeInfo): NedTypeInfo | undefined {
  if (sub.isLike) return sub.likeType ? cache.lookupType(sub.likeType, owner.file, owner.fqName) : undefined;
  return sub.type ? cache.lookupType(sub.type, owner.file, owner.fqName) : undefined;
}

interface ParamSetter {
  owner: NedTypeInfo;
  info: ParamInfo;
}

/** All `parameter` nodes of a type as ParamInfo (declarations AND bare assignments). */
function paramEntries(type: NedTypeInfo): ParamInfo[] {
  return paramNodes(type.node).map(paramInfo).filter((i) => i.name && !i.isPattern);
}

/** The typed declaration of `name` (most-derived first); carries type/unit. */
function declFor(chain: NedTypeInfo[], name: string): ParamSetter | undefined {
  for (const owner of chain) {
    const info = paramEntries(owner).find((i) => i.name === name && i.type);
    if (info) return { owner, info };
  }
  return undefined;
}

/** Types that set a value for `name`, most-derived first (assignment or default). */
function settersFor(chain: NedTypeInfo[], name: string): ParamSetter[] {
  const out: ParamSetter[] = [];
  for (const owner of chain) {
    const info = paramEntries(owner).find((i) => i.name === name && i.value !== undefined);
    if (info) out.push({ owner, info });
  }
  return out;
}

function setterNode(s: ParamSetter, type: string | undefined, unit: string | undefined, label: string, overridden: boolean, declaredIn?: string, path?: string): ParamHierNode {
  const declName = nameNode(s.info.node) ?? s.info.node;
  return {
    kind: 'param',
    label,
    declUri: s.owner.file.uri,
    declRange: nodeRange(declName),
    paramType: type,
    paramUnit: unit,
    paramValue: s.info.value,
    overridden: overridden || undefined,
    valueOwner: s.owner.simpleName,
    declaredIn,
    path,
    hasChildren: false,
  };
}

/**
 * Parameter rows for a type: for each parameter the effective (in-effect) value
 * first, immediately followed by any overridden (shadowed) assignments/defaults
 * from supertypes. Own params (declared or assigned locally) come first
 * (alphabetical), then inherited params (declared in an ancestor) by chain then
 * alphabetical. In config mode (opts.path/opts.resolve given) a matching INI
 * assignment becomes the effective value and the NED default(s) are shown as
 * greyed overridden rows.
 */
function paramRows(type: NedTypeInfo, opts?: ParamViewOpts): ParamHierNode[] {
  const chain = [type, ...type.ancestors()];
  const out: ParamHierNode[] = [];

  const localNames = [...new Set(paramEntries(type).map((i) => i.name!))].sort();
  const seen = new Set(localNames);
  const inheritedNames: string[] = [];
  for (const anc of type.ancestors()) {
    for (const name of [...anc.localParams().keys()].sort()) {
      if (seen.has(name)) continue;
      seen.add(name);
      inheritedNames.push(name);
    }
  }

  const emit = (name: string, own: boolean) => {
    const decl = declFor(chain, name);
    const setters = settersFor(chain, name);
    const type_ = decl?.info.type;
    const unit = decl?.info.unit;
    const declaredIn = decl?.owner.simpleName;
    const label = own ? name : `${declaredIn ?? setters[0]?.owner.simpleName ?? type.simpleName}::${name}`;
    const path = opts?.path ? `${opts.path}.${name}` : undefined;

    // value sources, highest precedence first: active config > this instance's
    // submodule-body assignment > NED declaration/inherited assignments.
    type Source = ParamAssign & { tag: 'config' | 'sub' | 'ned'; owner?: string };
    const sources: Source[] = [];
    const hit = path && opts?.resolve ? opts.resolve(path) : undefined;
    if (hit) sources.push({ ...hit, tag: 'config' });
    const sub = opts?.subAssign?.[name];
    if (sub) sources.push({ ...sub, tag: 'sub' });
    for (const s of setters) {
      const nn = nameNode(s.info.node) ?? s.info.node;
      sources.push({ value: s.info.value!, uri: s.owner.file.uri, range: nodeRange(nn), tag: 'ned', owner: s.owner.simpleName });
    }

    if (sources.length === 0) {
      if (decl) {
        // A declared parameter with no default and no assignment anywhere (NED
        // or config) has no value in effect — flag it as unassigned.
        const node = setterNode(decl, type_, unit, label, false, declaredIn, path);
        node.paramValue = undefined;
        node.unset = true;
        out.push(node);
      }
      return;
    }

    const eff = sources[0];
    out.push({
      kind: 'param', label, paramType: type_, paramUnit: unit, paramValue: eff.value,
      fromConfig: eff.tag === 'config' || undefined,
      valueOwner: eff.tag === 'config' ? opts?.configName : eff.owner,
      declaredIn, path, declUri: eff.uri, declRange: eff.range, hasChildren: false,
    });
    for (const s of sources.slice(1)) {
      out.push({
        kind: 'param', label: s.owner ? `${s.owner}::${name}` : name,
        paramType: type_, paramUnit: unit, paramValue: s.value, overridden: true,
        valueOwner: s.owner, declaredIn, path, declUri: s.uri, declRange: s.range, hasChildren: false,
      });
    }
  };

  for (const name of localNames) emit(name, true);
  for (const name of inheritedNames) emit(name, false);
  return out;
}

/** Parameter assignments in a submodule's declaration body (`sub: T { p = expr; }`). */
function submoduleAssignments(sub: SubmoduleInfo, owner: NedTypeInfo): Record<string, ParamAssign> | undefined {
  const out: Record<string, ParamAssign> = {};
  for (const p of paramNodes(sub.node)) {
    const info = paramInfo(p);
    if (info.name && !info.isPattern && !info.type && info.value !== undefined) {
      const nn = nameNode(info.node) ?? info.node;
      out[info.name] = { value: info.value, uri: owner.file.uri, range: nodeRange(nn) };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function submoduleNode(cache: NedResourceCache, name: string, sub: SubmoduleInfo, owner: NedTypeInfo, inheritedFrom?: string, opts?: ParamViewOpts): ParamHierNode {
  const resolved = resolveSubType(cache, sub, owner);
  const declName = nameNode(sub.node) ?? sub.node;
  const vec = sub.isVector ? '[]' : '';
  return {
    kind: 'module',
    label: (inheritedFrom ? `${inheritedFrom}::${name}` : name) + vec,
    declUri: owner.file.uri,
    declRange: nodeRange(declName),
    inheritedFrom,
    typeFqName: resolved?.fqName,
    isLike: sub.isLike,
    path: opts?.path ? `${opts.path}.${name}${vec}` : undefined,
    subAssign: submoduleAssignments(sub, owner),
    hasChildren: resolved ? resolved.params().size > 0 || resolved.submodules().size > 0 : false,
  };
}

/**
 * The immediate children of a module type in the parameters view: own params
 * (alpha), inherited params (`Super::name`, by chain then alpha), then own
 * submodules (alpha) and inherited submodules (`Super::name`). With `opts` the
 * tree is config-rooted (instance paths + INI-assigned values).
 */
export function immediateParamChildren(cache: NedResourceCache, type: NedTypeInfo, opts?: ParamViewOpts): ParamHierNode[] {
  const out: ParamHierNode[] = paramRows(type, opts);

  const seenS = new Set<string>();
  for (const [name, sub] of [...type.localSubmodules()].sort(byName)) {
    seenS.add(name);
    out.push(submoduleNode(cache, name, sub, type, undefined, opts));
  }
  for (const anc of type.ancestors()) {
    for (const [name, sub] of [...anc.localSubmodules()].sort(byName)) {
      if (seenS.has(name)) continue;
      seenS.add(name);
      out.push(submoduleNode(cache, name, sub, anc, anc.simpleName, opts));
    }
  }
  return out;
}

/** The root node (the focused type) with its immediate params + submodules prebuilt. */
export function paramHierarchyRoot(cache: NedResourceCache, type: NedTypeInfo, opts?: ParamViewOpts): ParamHierNode {
  const nn = nameNode(type.node);
  const children = immediateParamChildren(cache, type, opts);
  return {
    kind: 'module',
    label: type.simpleName,
    declUri: type.file.uri,
    declRange: nn ? nodeRange(nn) : undefined,
    typeFqName: type.fqName,
    path: opts?.path,
    hasChildren: children.length > 0,
    isSelected: true,
    children,
  };
}

/** Immediate params + submodules of a type identified by fq-name (lazy expansion). */
export function paramHierarchyChildren(cache: NedResourceCache, fqName: string, opts?: ParamViewOpts): ParamHierNode[] {
  const t = cache.getType(fqName);
  return t ? immediateParamChildren(cache, t, opts) : [];
}
