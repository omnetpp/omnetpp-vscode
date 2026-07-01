import { Diagnostic, DiagnosticSeverity, Location, Range } from '../model/location';
import { NedResourceCache } from '../ned/nedResourceCache';
import type { IniResourceCache } from './iniResourceCache';
import { NedTypeInfo } from '../ned/nedTypeInfo';
import { nameNode } from '../ned/nedAst';
import { nodeRange } from '../parser/treeUtils';
import { ExpandResult, ParamSlot, expandNetwork, paramSlots } from './moduleTree';
import { ConfigRegistry } from './configRegistry';
import { classifyKey } from './iniConfigChecks';
import type { IniDocument, IniSection, IniEntry } from './iniDocument';
import { parseExpression } from '../expr/exprParser';
import { inferType, isTypeMismatch } from '../expr/infer';
import { unitsCompatible } from '../expr/units';
import { iniKeyToRegex, normIndices } from './keyMatch';

export { iniKeyToRegex, normIndices };

function findSection(doc: IniDocument, configName: string): IniSection | undefined {
  return doc.sections.find((s) => s.configName === configName);
}

function generalSection(doc: IniDocument): IniSection | undefined {
  return doc.sections.find((s) => s.type === 'general');
}

/** Resolve the effective `network` for a section through extends chain and [General]. */
export function effectiveNetwork(doc: IniDocument, section: IniSection): string | undefined {
  const seen = new Set<string>();
  const walk = (sec: IniSection | undefined): string | undefined => {
    if (!sec || seen.has(sec.rawName)) return undefined;
    seen.add(sec.rawName);
    let net: string | undefined;
    for (const e of sec.entries) if (e.key === 'network') net = e.value;
    if (net) return net;
    for (const base of sec.extends) {
      const r = walk(findSection(doc, base));
      if (r) return r;
    }
    return undefined;
  };
  const direct = walk(section);
  if (direct) return direct;
  // fall back to [General]
  return walk(generalSection(doc));
}

/**
 * Parameter-assignment entries visible to a section, in OMNeT++ lookup-precedence
 * order: the section's own entries (file order), then its `extends` parents
 * (depth-first), then `[General]`. The first entry whose pattern matches a path
 * wins. Config-option keys (network=, sim-time-limit=, etc.) are excluded.
 */
export function configEntriesInScope(
  doc: IniDocument,
  section: IniSection,
  registry: ConfigRegistry,
): IniEntry[] {
  const out: IniEntry[] = [];
  const seen = new Set<string>();
  const visit = (sec: IniSection | undefined) => {
    if (!sec || seen.has(sec.rawName)) return;
    seen.add(sec.rawName);
    for (const e of sec.entries) {
      if (classifyKey(registry, e.key).kind === 'param-assignment') out.push(e);
    }
    for (const base of sec.extends) visit(findSection(doc, base));
  };
  visit(section);
  visit(generalSection(doc));
  return out;
}

/**
 * The `*.typename` assignment entries visible to a section (own + extends + General).
 * These bind `like` submodule slots to concrete types during network expansion.
 * No registry needed — a `typename` leaf is always a parameter assignment.
 */
export function collectTypenameEntries(doc: IniDocument, section: IniSection): IniEntry[] {
  const out: IniEntry[] = [];
  const seen = new Set<string>();
  const visit = (sec: IniSection | undefined) => {
    if (!sec || seen.has(sec.rawName)) return;
    seen.add(sec.rawName);
    for (const e of sec.entries) {
      const dot = e.key.lastIndexOf('.');
      const leaf = dot < 0 ? e.key : e.key.slice(dot + 1);
      if (leaf === 'typename') out.push(e);
    }
    for (const base of sec.extends) visit(findSection(doc, base));
  };
  visit(section);
  visit(generalSection(doc));
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

function getExpansion(
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

/**
 * Full INI parameter resolution: matches every `**.param = value` assignment
 * against the expanded module tree of the section's network, reporting keys that
 * match no parameter and values whose type conflicts with the NED declaration.
 */
export function iniParamDiagnostics(
  doc: IniDocument,
  cache: NedResourceCache,
  registry: ConfigRegistry,
): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const section of doc.sections) {
    const netName = effectiveNetwork(doc, section);
    if (!netName) continue;
    const net = resolveNetworkType(cache, netName, doc.uri);
    if (!net) continue;

    const typenameEntries = collectTypenameEntries(doc, section);
    const bindings = buildTypenameBindings(typenameEntries);
    const expansion = getExpansion(cache, net, bindings);
    const params = paramSlots(expansion);

    // An INI `**.x.typename = "Name"` that matched >1 implementers of the slot's
    // interface is ambiguous (OMNeT++ rejects it) — flag the offending entry's value.
    const flagged = new Set<string>();
    for (const amb of expansion.ambiguities) {
      const slotNorm = normIndices(amb.path);
      for (const e of typenameEntries) {
        const dot = e.key.lastIndexOf('.');
        const prefix = dot < 0 ? '' : e.key.slice(0, dot);
        if (e.value.replace(/^"|"$/g, '').trim() !== amb.typeName) continue;
        if (!iniKeyToRegex(prefix).test(slotNorm)) continue;
        const dedupe = `${e.valueRange.start.line}:${e.valueRange.start.character}:${amb.typeName}`;
        if (flagged.has(dedupe)) continue;
        flagged.add(dedupe);
        out.push({
          range: e.valueRange,
          severity: DiagnosticSeverity.Warning,
          message: `Ambiguous typename '${amb.typeName}': ${amb.candidates.length} types implement the interface (${amb.candidates.join(', ')}). Use a fully qualified name to disambiguate.`,
          source: 'omnetpp',
          code: 'ambiguous-typename',
        });
      }
    }

    for (const e of section.entries) {
      if (classifyKey(registry, e.key).kind !== 'param-assignment') continue;
      const re = iniKeyToRegex(e.key);
      const matched = params.filter((p) => re.test(p.norm));

      if (matched.length > 0) {
        typeCheck(e, matched, out);
        continue;
      }

      // No param matched. Deep-wildcard (`**`) keys can target modules created
      // dynamically at runtime (builder networks) — never flag those.
      if (e.key.includes('**')) continue;
      // Otherwise only warn when we can pinpoint the target MODULE as fully-known
      // but missing the leaf param (the param may live behind a `like` subtree).
      const dot = e.key.lastIndexOf('.');
      if (dot < 0) continue;
      const leaf = e.key.slice(dot + 1);
      if (/[*?\]]/.test(leaf)) continue; // wildcard leaf: too vague to flag
      const prefixRe = iniKeyToRegex(e.key.slice(0, dot));
      const candidateModules = expansion.modules.filter((m) => prefixRe.test(m.norm));
      if (candidateModules.length > 0 && candidateModules.every((m) => !m.open) && !expansion.truncated) {
        out.push({
          range: e.keyRange,
          severity: DiagnosticSeverity.Warning,
          message: `No parameter '${leaf}' in the module(s) matched by '${e.key}' (network '${net.simpleName}')`,
          source: 'omnetpp',
          code: 'no-matching-param',
        });
      }
    }
  }
  return out;
}

function typeCheck(
  e: { value: string; valueRange: import('../model/location').Range; key: string },
  matched: ParamSlot[],
  out: Diagnostic[],
): void {
  const err = (message: string, code: string) =>
    out.push({ range: e.valueRange, severity: DiagnosticSeverity.Error, message, source: 'omnetpp', code });

  // matched parameters must agree on units (purely a NED-side check)
  const units = new Set(matched.map((m) => m.unit ?? ''));
  if (units.size > 1) {
    err(
      `Entry matches parameters with different units: ${[...units].map((u) => u || 'none').join(', ')}`,
      'param-unit-mismatch',
    );
    return;
  }

  const types = new Set(matched.map((m) => m.type).filter(Boolean));
  if (types.size !== 1) return;
  const declared = [...types][0]!;
  const v = e.value;
  if (!v || v.includes('$') || v.includes('{') || v === 'default' || v === 'ask') return;

  const { type: vt, unit: valueUnit } = inferType(parseExpression(v));

  // data-type mismatch
  if (isTypeMismatch(declared, vt)) {
    err(`Cannot assign ${vt} value to '${declared}' parameter (matched by '${e.key}')`, 'param-value-type');
    return;
  }

  // unit compatibility: value's unit vs the (agreed) parameter @unit
  const paramUnit = matched[0].unit;
  if (valueUnit && paramUnit && !unitsCompatible(valueUnit, paramUnit)) {
    err(`Wrong unit: '${paramUnit}' expected, got '${valueUnit}'`, 'param-unit-mismatch');
    return;
  }

  // @enum validation (string params with an @enum property)
  if (declared === 'string' && /^".*"$/.test(v)) {
    const allowed = new Set<string>();
    for (const m of matched) for (const x of m.enumValues ?? []) allowed.add(x);
    if (allowed.size) {
      const unquoted = v.slice(1, -1);
      if (!allowed.has(unquoted)) {
        err(`Invalid value ${v}, should be one of: ${[...allowed].map((x) => `"${x}"`).join(', ')}`, 'param-enum-value');
        return;
      }
    }
  }

  // info: assignment is redundant (same as the NED default)
  const defaults = new Set(matched.map((m) => m.default).filter((d): d is string => d !== undefined));
  if (defaults.size === 1 && matched.every((m) => m.default !== undefined) && v.trim() === [...defaults][0].trim()) {
    out.push({
      range: e.valueRange,
      severity: DiagnosticSeverity.Information,
      message: 'Value is same as the NED default',
      source: 'omnetpp',
      code: 'redundant-assignment',
    });
  }
}

/** All param-assignment keys visible to a section (own + extends chain + [General]). */
function scopeParamKeys(doc: IniDocument, section: IniSection): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const visit = (sec: IniSection | undefined) => {
    if (!sec || seen.has(sec.rawName)) return;
    seen.add(sec.rawName);
    for (const e of sec.entries) keys.push(e.key);
    for (const base of sec.extends) visit(findSection(doc, base));
  };
  visit(section);
  visit(generalSection(doc));
  return keys;
}

/**
 * Edits that add ini entries for mandatory parameters (no NED default) of each
 * section's network that are not yet assigned. Returns [] if nothing is missing.
 */
export function addMissingKeys(
  doc: IniDocument,
  cache: NedResourceCache,
): import('../model/location').TextEdit[] {
  const edits: import('../model/location').TextEdit[] = [];
  for (const section of doc.sections) {
    const netName = effectiveNetwork(doc, section);
    if (!netName) continue;
    const net = resolveNetworkType(cache, netName, doc.uri);
    if (!net) continue;
    const bindings = buildTypenameBindings(collectTypenameEntries(doc, section));
    const slots = paramSlots(getExpansion(cache, net, bindings));
    const keyRes = scopeParamKeys(doc, section).map((k) => iniKeyToRegex(k));
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const s of slots) {
      if (s.hasDefault || s.open) continue;
      if (keyRes.some((re) => re.test(s.norm))) continue;
      if (seen.has(s.norm)) continue;
      seen.add(s.norm);
      missing.push(s.path);
    }
    if (!missing.length) continue;
    const text = '\n' + missing.map((p) => `${p} = `).join('\n');
    edits.push({ range: { start: section.range.end, end: section.range.end }, newText: text });
  }
  return edits;
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
 * Unlike {@link iniParamDefinition} this also handles wildcard leaves (e.g.
 * `**.host.*`) and reports the matched instance path + parameter type.
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

/** The NED type-declaration location for a module (its name identifier). */
function moduleDeclLocation(typeInfo: NedTypeInfo): Location {
  const nn = nameNode(typeInfo.node) ?? typeInfo.node;
  return { uri: typeInfo.file.uri, range: nodeRange(nn) };
}

/**
 * Modules whose instance path matches the module-prefix of an ini key (the part
 * before the leaf parameter name). Used as a navigation fallback when the leaf
 * matches no actual parameter — jump to the module rather than nowhere.
 */
export function matchedModules(
  doc: IniDocument,
  cache: NedResourceCache,
  section: IniSection,
  key: string,
  fallbackNetwork?: string,
): { path: string; typeFqName: string; decl: Location }[] {
  const dot = key.lastIndexOf('.');
  if (dot < 0) return []; // no module prefix to match
  const prefix = key.slice(0, dot);
  const netName = effectiveNetwork(doc, section) ?? fallbackNetwork;
  if (!netName) return [];
  const net = resolveNetworkType(cache, netName, doc.uri);
  if (!net) return [];
  const re = iniKeyToRegex(prefix);
  const out: { path: string; typeFqName: string; decl: Location }[] = [];
  const bindings = buildTypenameBindings(collectTypenameEntries(doc, section));
  for (const m of getExpansion(cache, net, bindings).modules) {
    if (!m.typeInfo || !re.test(m.norm)) continue;
    out.push({ path: m.path, typeFqName: m.typeInfo.fqName, decl: moduleDeclLocation(m.typeInfo) });
  }
  return out;
}

/**
 * Go-to-definition target(s) for an ini parameter key: the NED param
 * declaration(s). When the leaf matches no actual parameter, falls back to the
 * first matching module's declaration so navigation still lands somewhere useful.
 */
export function iniParamDefinition(
  doc: IniDocument,
  cache: NedResourceCache,
  section: IniSection,
  key: string,
  fallbackNetwork?: string,
): Location[] {
  const out: Location[] = [];
  const seen = new Set<string>();
  for (const m of matchedParamModules(doc, cache, section, key, fallbackNetwork)) {
    if (!m.decl) continue;
    const locKey = `${m.decl.uri}:${m.decl.range.start.line}:${m.decl.range.start.character}`;
    if (seen.has(locKey)) continue;
    seen.add(locKey);
    out.push(m.decl);
  }
  if (out.length) return out;
  // No parameter matched — navigate to the first matching module instead.
  const mods = matchedModules(doc, cache, section, key, fallbackNetwork);
  return mods.length ? [mods[0].decl] : [];
}

/** One INI assignment that targets a given NED parameter declaration. */
export interface ParamAssignment {
  uri: string;
  /** config name, or 'General'. */
  config: string;
  key: string;
  value: string;
  keyRange: Range;
  /** the normalized instance path the key matched. */
  matchedPath: string;
  /** true if this entry wins precedence for `matchedPath` in its config. */
  isWinner: boolean;
}

/**
 * Reverse of {@link iniParamDefinition}: every INI key across the workspace that
 * assigns the NED parameter declared by `(typeFqName, param)`. For each config,
 * the parameter's declaring type is expanded to its instance paths, then every
 * in-scope entry whose pattern matches one of those paths is reported (with the
 * precedence winner flagged). Optionally restricted to a single config.
 */
/**
 * Whether a config could possibly instantiate a type in `relevant` (a set of
 * container simple names), given its effective network and `typename` bindings —
 * a cheap, network-expansion-free over-approximation used to prune the scan.
 */
function sectionMaybeRelevant(netName: string, tnEntries: IniEntry[], relevant: Set<string>): boolean {
  if (relevant.has(lastSegment(unquote(netName)))) return true;
  for (const e of tnEntries) {
    const v = e.value;
    if (v.includes('$') || v.includes('{')) return true; // variable typename: cannot rule out
    if (relevant.has(lastSegment(unquote(v)))) return true;
  }
  return false;
}

function lastSegment(s: string): string {
  const dot = s.lastIndexOf('.');
  const col = s.lastIndexOf('::');
  const cut = Math.max(dot, col < 0 ? -1 : col + 1);
  return cut >= 0 ? s.slice(cut + 1) : s;
}
function unquote(s: string): string {
  return s.replace(/^"|"$/g, '');
}

export function findParamAssignments(
  iniCache: IniResourceCache,
  cache: NedResourceCache,
  registry: ConfigRegistry,
  target: { typeFqName: string; param: string },
  configFilter?: string,
  /** Container simple names (from paramContainerSimpleNames); when given, configs
   *  that cannot reach the type are skipped without expanding their network. */
  relevant?: Set<string>,
): ParamAssignment[] {
  const out: ParamAssignment[] = [];
  const seen = new Set<string>();
  for (const { uri, doc } of iniCache.allDocs()) {
    for (const section of doc.sections) {
      const cfgName = section.configName ?? 'General';
      if (configFilter && cfgName !== configFilter) continue;
      const netName = effectiveNetwork(doc, section);
      if (!netName) continue;
      const tnEntries = collectTypenameEntries(doc, section);
      if (relevant && !sectionMaybeRelevant(netName, tnEntries, relevant)) continue;
      const net = resolveNetworkType(cache, netName, doc.uri);
      if (!net) continue;
      const bindings = buildTypenameBindings(tnEntries);
      const expansion = getExpansion(cache, net, bindings);

      // instance paths where (typeFqName, param) is declared
      const targetNorms = new Set<string>();
      for (const m of expansion.modules) {
        if (!m.params.has(target.param)) continue;
        const owner = m.paramOwner.get(target.param) ?? m.typeInfo;
        const decl = owner?.paramDecl(target.param);
        if (decl && decl.owner.fqName === target.typeFqName) {
          targetNorms.add(`${m.norm}.${target.param}`);
        }
      }
      if (!targetNorms.size) continue;

      const entries = configEntriesInScope(doc, section, registry);
      const winner = configResolver(entries);
      for (const e of entries) {
        const re = iniKeyToRegex(e.key);
        for (const tn of targetNorms) {
          if (!re.test(tn)) continue;
          const dkey = `${uri}|${cfgName}|${e.keyRange.start.line}|${tn}`;
          if (seen.has(dkey)) continue;
          seen.add(dkey);
          out.push({
            uri,
            config: cfgName,
            key: e.key,
            value: e.value,
            keyRange: e.keyRange,
            matchedPath: tn,
            isWinner: winner(tn) === e,
          });
        }
      }
    }
  }
  return out;
}

/** The NED type of the parameter(s) a key matches, if unambiguous. */
export function matchedParamType(
  doc: IniDocument,
  cache: NedResourceCache,
  section: IniSection,
  key: string,
): string | undefined {
  const re = iniKeyToRegex(key);
  const types = new Set<string>();
  for (const p of reachableParamPaths(doc, cache, section)) {
    if (p.type && re.test(normIndices(p.path))) types.add(p.type);
  }
  return types.size === 1 ? [...types][0] : undefined;
}

/** Reachable parameter paths for completion in a section's network context. */
export function reachableParamPaths(
  doc: IniDocument,
  cache: NedResourceCache,
  section: IniSection,
): { path: string; type?: string }[] {
  const netName = effectiveNetwork(doc, section);
  if (!netName) return [];
  const net = resolveNetworkType(cache, netName, doc.uri);
  if (!net) return [];
  const bindings = buildTypenameBindings(collectTypenameEntries(doc, section));
  return paramSlots(getExpansion(cache, net, bindings)).map((p) => ({ path: p.path, type: p.type }));
}
