import { Location } from '../model/location';
import { NedResourceCache } from '../ned/nedResourceCache';
import { NedTypeInfo } from '../ned/nedTypeInfo';
import { nameNode } from '../ned/nedAst';
import { nodeRange } from '../parser/treeUtils';
import { ExpandResult, expandNetwork } from './moduleTree';
import { ConfigRegistry } from './configRegistry';
import { classifyKey } from './iniConfigChecks';
import type { IniDocument, IniSection, IniEntry } from './iniDocument';
import { sectionCanonicalName } from './iniDocument';
import { iniKeyToRegex, normIndices } from './keyMatch';

export { iniKeyToRegex, normIndices };

/**
 * The base module for INI parameter resolution: the core resolve/expand
 * primitives shared by {@link ./iniParamChecks}, {@link ./iniParamCodeActions},
 * {@link ./iniParamNavigation} and {@link ./iniParamCompletion}. Those modules
 * import from here; this module never imports from them (no cycles).
 */

export function findSection(doc: IniDocument, configName: string): IniSection | undefined {
  return doc.sections.find((s) => s.configName === configName);
}

export function generalSection(doc: IniDocument): IniSection | undefined {
  return doc.sections.find((s) => s.type === 'general');
}

// ---- C3 linearization of the section fallback chain --------------------------
// A faithful port of OMNeT++'s SectionBasedConfiguration section-chain resolution
// (src/envir/sectionbasedconfig.cc): getBaseConfigIds + computeSectionChain +
// mergeSectionChains/selectNext. Config sections may `extends=` several bases;
// C3 (the Python-MRO algorithm) produces a single, consistent precedence order
// even for diamond inheritance, which the previous depth-first walk did not.

/** Direct base sections (OMNeT++ getBaseConfigIds): none for [General]; the
 *  implicit [General] when there is no `extends`; else the listed configs that
 *  exist (unknown bases are reported by the structure check, skipped here). */
function baseSections(section: IniSection, byName: Map<string, IniSection>): IniSection[] {
  if (section.type === 'general') return [];
  if (section.extends.length === 0) {
    const general = byName.get('General');
    return general ? [general] : [];
  }
  const out: IniSection[] = [];
  for (const name of section.extends) {
    const base = byName.get(name);
    if (base) out.push(base);
  }
  return out;
}

/** C3 merge (OMNeT++ mergeSectionChains + selectNext), comparing by canonical
 *  name. Appends the linearized order onto `result`. On an inconsistent
 *  hierarchy the merge stops early and the remaining sections are appended
 *  deduped, so none are dropped from resolution. */
function mergeChains(chains: IniSection[][], result: IniSection[]): void {
  const nameAt = (s: IniSection) => sectionCanonicalName(s);
  // reversed copies so each chain's head sits at the back (cheap to pop)
  const rev = chains.map((c) => c.slice().reverse());
  const nonEmpty = () => rev.some((c) => c.length > 0);

  while (nonEmpty()) {
    let next: IniSection | undefined;
    for (const chain of rev) {
      if (!chain.length) continue;
      const candidate = chain[chain.length - 1];
      const cname = nameAt(candidate);
      // valid iff the candidate is in no chain's *tail* (everything but the head)
      let inTail = false;
      for (const c of rev) {
        for (let i = 0; i < c.length - 1 && !inTail; i++) if (nameAt(c[i]) === cname) inTail = true;
        if (inTail) break;
      }
      if (!inTail) {
        next = candidate;
        break;
      }
    }
    if (!next) break; // inconsistency → fall through to the degrade path below
    const nname = nameAt(next);
    result.push(next);
    for (const c of rev) if (c.length && nameAt(c[c.length - 1]) === nname) c.pop();
  }

  const placed = new Set(result.map(nameAt));
  for (const c of rev)
    for (let i = c.length - 1; i >= 0; i--) {
      const n = nameAt(c[i]);
      if (!placed.has(n)) {
        placed.add(n);
        result.push(c[i]);
      }
    }
}

/** OMNeT++ computeSectionChain: L[C] = C + merge(L[B1]…L[Bn], [B1…Bn]). */
function computeChain(
  section: IniSection,
  byName: Map<string, IniSection>,
  cache: Map<string, IniSection[]>,
  visiting: Set<string>,
): IniSection[] {
  const key = sectionCanonicalName(section);
  const cached = cache.get(key);
  if (cached) return cached;
  if (visiting.has(key)) return [section]; // extends cycle: break, best-effort
  visiting.add(key);

  const bases = baseSections(section, byName);
  const chains: IniSection[][] = bases.map((b) => computeChain(b, byName, cache, visiting));
  chains.push(bases);

  const result: IniSection[] = [section];
  mergeChains(chains, result);

  visiting.delete(key);
  cache.set(key, result);
  return result;
}

/**
 * The C3-linearized fallback chain of `section`: the section itself, then its
 * base sections in C3 (MRO) order, ending at [General]. Mirrors OMNeT++'s
 * section-chain resolution so first-match-wins lookup follows the identical
 * precedence — including diamond inheritance from multiple `extends=` bases.
 */
export function sectionChain(doc: IniDocument, section: IniSection): IniSection[] {
  const byName = new Map<string, IniSection>();
  for (const s of doc.sections) {
    const n = sectionCanonicalName(s);
    if (!byName.has(n)) byName.set(n, s);
  }
  return computeChain(section, byName, new Map(), new Set());
}

/** Resolve the effective `network` for a section along its C3 fallback chain. */
export function effectiveNetwork(doc: IniDocument, section: IniSection): string | undefined {
  for (const sec of sectionChain(doc, section)) {
    let net: string | undefined;
    for (const e of sec.entries) if (e.key === 'network') net = e.value;
    if (net) return net;
  }
  return undefined;
}

/**
 * Parameter-assignment entries visible to a section, in OMNeT++ lookup-precedence
 * order: the C3-linearized section chain (self → bases in MRO order → [General]),
 * each section's entries in file order. The first entry whose pattern matches a
 * path wins. Config-option keys (network=, sim-time-limit=, etc.) are excluded.
 */
export function configEntriesInScope(
  doc: IniDocument,
  section: IniSection,
  registry: ConfigRegistry,
): IniEntry[] {
  const out: IniEntry[] = [];
  for (const sec of sectionChain(doc, section)) {
    for (const e of sec.entries) {
      if (classifyKey(registry, e.key).kind === 'param-assignment') out.push(e);
    }
  }
  return out;
}

/**
 * The `*.typename` assignment entries visible to a section, along its C3 chain.
 * These bind `like` submodule slots to concrete types during network expansion.
 * No registry needed — a `typename` leaf is always a parameter assignment.
 */
export function collectTypenameEntries(doc: IniDocument, section: IniSection): IniEntry[] {
  const out: IniEntry[] = [];
  for (const sec of sectionChain(doc, section)) {
    for (const e of sec.entries) {
      const dot = e.key.lastIndexOf('.');
      const leaf = dot < 0 ? e.key : e.key.slice(dot + 1);
      if (leaf === 'typename') out.push(e);
    }
  }
  return out;
}

/** A resolver from a `like`-slot norm path to its bound concrete type name(s). */
export interface TypenameBindings {
  /** the first (highest-precedence) matching typename, if any. */
  resolve: (slotNorm: string) => string | undefined;
  /**
   * ALL matching typenames in precedence order (deduped). A single normalized slot
   * can match several bindings when vector indices differ (e.g. `x[0]` vs `x[*]`);
   * the expansion unions the parameters of every candidate concrete type.
   */
  resolveAll: (slotNorm: string) => string[];
  /** stable digest of the bindings, for the expansion cache key. */
  digest: string;
}

/** Compile typename entries into bindings (OMNeT++ precedence order). */
export function buildTypenameBindings(entries: IniEntry[]): TypenameBindings {
  const compiled: { re: RegExp; value: string }[] = [];
  const parts: string[] = [];
  for (const e of entries) {
    const dot = e.key.lastIndexOf('.');
    const prefix = dot < 0 ? '' : e.key.slice(0, dot); // module-path pattern
    const value = e.value.replace(/^"|"$/g, '').trim();
    if (!value) continue;
    compiled.push({ re: iniKeyToRegex(prefix), value });
    parts.push(`${normIndices(prefix)}=${value}`);
  }
  const resolveAll = (slotNorm: string) => {
    const out: string[] = [];
    for (const c of compiled) if (c.re.test(slotNorm) && !out.includes(c.value)) out.push(c.value);
    return out;
  };
  return {
    resolve: (slotNorm) => resolveAll(slotNorm)[0],
    resolveAll,
    digest: parts.join(';'),
  };
}

/** Resolves a normalized parameter path to its winning INI assignment, if any. */
export type ConfigResolve = (normPath: string) => IniEntry | undefined;

/** Build a {@link ConfigResolve} from the entries in scope (first match wins). */
export function configResolver(entries: IniEntry[]): ConfigResolve {
  const compiled = entries.map((e) => ({ re: iniKeyToRegex(e.key), entry: e }));
  return (normPath: string) => compiled.find((c) => c.re.test(normPath))?.entry;
}

/** Whether a key pins a *concrete* vector index (`[0]`, `[0..3]`, `[$x]`) rather than
 *  a full-cover one (`[*]`, `[]`, or no bracket). The module tree collapses every
 *  vector index to `[]`, so a concrete-index key only *partially* covers its slot. */
function hasConcreteVectorIndex(key: string): boolean {
  const brackets = key.match(/\[[^\]]*\]/g);
  return !!brackets && brackets.some((b) => {
    const inner = b.slice(1, -1);
    return inner !== '' && inner !== '*';
  });
}

/**
 * Whether an entry effectively assigns the parameter at a normalized path, under
 * OMNeT++ first-match-wins — but a key with a concrete vector index only partially
 * covers the index-normalized slot, so it neither fully shadows later keys nor is
 * fully shadowed by earlier concrete-index keys. This exactly matches OMNeT++ for
 * named (non-vector) submodules, and safely over-approximates for vectors the
 * collapsed module tree cannot split per element (e.g. `*.node[0].x` before
 * `**.x`: both stay effective, since `[0]` covers only one element).
 */
export type EffectiveResolve = (entry: IniEntry, normPath: string) => boolean;

/** Build an {@link EffectiveResolve}: the first FULL-COVER matching entry shadows
 *  later keys; concrete-index keys are co-effective. */
export function effectiveResolver(entries: IniEntry[]): EffectiveResolve {
  const compiled = entries.map((e) => ({
    entry: e,
    re: iniKeyToRegex(e.key),
    fullCover: !hasConcreteVectorIndex(e.key),
  }));
  return (entry, normPath) => {
    for (const c of compiled) {
      if (c.entry === entry) return c.re.test(normPath); // reached it: effective iff it matches
      if (c.fullCover && c.re.test(normPath)) return false; // an earlier full-cover key claims it
    }
    return false;
  };
}

/** The directory portion of a file URI (everything before the last '/'). */
function dirOf(uri: string): string {
  const i = uri.lastIndexOf('/');
  return i < 0 ? '' : uri.slice(0, i);
}

/**
 * The NED package of the folder containing the ini file, or `undefined` if it
 * cannot be determined. OMNeT++ derives this from the ini folder's NED source
 * root (`getNedPackageForFolder`); a NED file sharing the ini file's directory
 * carries the identical folder-derived package, so we read it off a co-located
 * NED file. Only such a file could declare a `<package>.Name` network anyway, so
 * this is behaviourally equivalent to OMNeT++'s package-prefix lookup.
 */
function iniFolderPackage(cache: NedResourceCache, iniUri: string): string | undefined {
  const dir = dirOf(iniUri);
  for (const f of cache.allFiles()) {
    if (dirOf(f.uri) === dir) return f.packageName;
  }
  return undefined;
}

/**
 * Resolve a `network=` value to its NED type, matching OMNeT++'s
 * `EnvirBase::resolveNetwork`: an unqualified name is looked up first as
 * `<ini-folder-package>.Name` and then verbatim (`Name`, i.e. the root package),
 * both by exact fully-qualified name; a qualified name is looked up directly.
 * The returned type may not be a network — callers validate that separately, just
 * as OMNeT++ finds the module type first and then checks `isNetwork()`.
 */
export function resolveNetworkType(
  cache: NedResourceCache,
  name: string,
  iniUri?: string,
): NedTypeInfo | undefined {
  if (name.includes('.')) return cache.getType(name);
  if (iniUri) {
    const pkg = iniFolderPackage(cache, iniUri);
    if (pkg) {
      const inPkg = cache.getType(`${pkg}.${name}`);
      if (inPkg) return inPkg;
    }
  }
  return cache.getType(name);
}

// expansion cache, scoped per resource-cache instance and keyed by (generation, fqName)
const expandCache = new WeakMap<NedResourceCache, Map<string, ExpandResult>>();

/**
 * Expand `net`'s module tree (bound by `bindings`), memoized per resource-cache
 * generation. Shared by every module that needs the expanded tree
 * (diagnostics, code actions, navigation, completion).
 */
export function getExpansion(
  cache: NedResourceCache,
  net: NedTypeInfo,
  bindings?: TypenameBindings,
): ExpandResult {
  let perCache = expandCache.get(cache);
  if (!perCache) {
    perCache = new Map();
    expandCache.set(cache, perCache);
  }
  const key = `${cache.generation}:${net.fqName}:${bindings?.digest ?? ''}`;
  let r = perCache.get(key);
  if (!r) {
    r = expandNetwork(cache, net, bindings?.resolveAll);
    perCache.set(key, r);
    // Bound memory by evicting the OLDEST entries (FIFO) rather than clearing the
    // whole cache — a single reverse-assignment scan reuses hundreds of distinct
    // (network, bindings) expansions, so clear-all caused pathological re-expansion.
    const CAP = 1024;
    if (perCache.size > CAP) {
      let evict = perCache.size - CAP;
      for (const oldKey of perCache.keys()) {
        if (evict-- <= 0) break;
        perCache.delete(oldKey);
      }
    }
  }
  return r;
}

/** A concrete module parameter that an ini key pattern matches. */
export interface MatchedParamModule {
  /** full instance path, vector indices as [*], e.g. "Net.host[*].app". */
  path: string;
  paramName: string;
  /** the NED type of the parameter, if known. */
  paramType?: string;
  /** fq-name of the NED type that declares the parameter. */
  typeFqName: string;
  /** the NED parameter declaration location. */
  decl?: Location;
}

/**
 * Every concrete module parameter that an ini key pattern matches, in the context
 * of `section`'s effective network (falling back to `fallbackNetwork` — the active
 * config's network — when the section itself selects none, e.g. `[General]`).
 * Unlike `iniParamDefinition` (see `iniParamNavigation.ts`) this also handles
 * wildcard leaves (e.g. `**.host.*`) and reports the matched instance path +
 * parameter type.
 */
export function matchedParamModules(
  doc: IniDocument,
  cache: NedResourceCache,
  section: IniSection,
  key: string,
  fallbackNetwork?: string,
): MatchedParamModule[] {
  const netName = effectiveNetwork(doc, section) ?? fallbackNetwork;
  if (!netName) return [];
  const net = resolveNetworkType(cache, netName, doc.uri);
  if (!net) return [];
  const re = iniKeyToRegex(key);
  const out: MatchedParamModule[] = [];
  const bindings = buildTypenameBindings(collectTypenameEntries(doc, section));
  for (const m of getExpansion(cache, net, bindings).modules) {
    if (!m.typeInfo) continue;
    for (const [name, ptype] of m.params) {
      if (!re.test(`${m.norm}.${name}`)) continue;
      // a unioned like-slot param may be declared by a non-primary candidate type
      const owner = m.paramOwner.get(name) ?? m.typeInfo;
      const decl = owner.paramDecl(name);
      let loc: Location | undefined;
      if (decl) {
        const nn = nameNode(decl.node) ?? decl.node;
        loc = { uri: decl.owner.file.uri, range: nodeRange(nn) };
      }
      out.push({
        path: m.path,
        paramName: name,
        paramType: ptype,
        typeFqName: decl?.owner.fqName ?? owner.fqName,
        decl: loc,
      });
    }
  }
  return out;
}

/**
 * Like {@link matchedParamModules}, but restricted to the parameters for which
 * `entry` is the precedence winner — OMNeT++ assigns each parameter from the FIRST
 * matching key (own section, file order → `extends` → `[General]`), so a broader
 * key never claims a parameter an earlier, higher-precedence key already set. This
 * is the forward-direction counterpart of `findParamAssignments`'s `isWinner`
 * (see `iniParamNavigation.ts`) and reuses the same {@link configEntriesInScope} +
 * {@link configResolver} oracle.
 *
 * Pass a precomputed `isEffective` (from `effectiveResolver(configEntriesInScope(...))`)
 * to amortize the resolver build across every entry of a section.
 */
export function effectiveParamModules(
  doc: IniDocument,
  cache: NedResourceCache,
  section: IniSection,
  entry: IniEntry,
  registry: ConfigRegistry,
  fallbackNetwork?: string,
  isEffective?: EffectiveResolve,
): MatchedParamModule[] {
  const eff = isEffective ?? effectiveResolver(configEntriesInScope(doc, section, registry));
  return matchedParamModules(doc, cache, section, entry.key, fallbackNetwork).filter((m) =>
    eff(entry, normIndices(`${m.path}.${m.paramName}`)),
  );
}
