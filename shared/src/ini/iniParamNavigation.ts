import { Location, Range } from '../model/location';
import { NedResourceCache } from '../ned/nedResourceCache';
import { NedTypeInfo } from '../ned/nedTypeInfo';
import { nameNode } from '../ned/nedAst';
import { nodeRange } from '../parser/treeUtils';
import { ConfigRegistry } from './configRegistry';
import type { IniDocument, IniSection, IniEntry } from './iniDocument';
import type { IniResourceCache } from './iniResourceCache';
import { iniKeyToRegex } from './keyMatch';
import {
  effectiveNetwork,
  resolveNetworkType,
  collectTypenameEntries,
  buildTypenameBindings,
  getExpansion,
  configEntriesInScope,
  configResolver,
  matchedParamModules,
} from './iniParamResolution';

/** The NED type-declaration location for a module (its name identifier). */
function moduleDeclLocation(typeInfo: NedTypeInfo): Location {
  const nn = nameNode(typeInfo.node) ?? typeInfo.node;
  return { uri: typeInfo.file.uri, range: nodeRange(nn) };
}

/**
 * The NED types a `*.typename = "T"` value can denote, resolved by OMNeT++'s `like`
 * rules: a qualified name maps to that exact type; a simple name maps to every
 * type sharing it that implements one of `slotIfaces` (the `like` interfaces of
 * the slots the key targets, see {@link typenameSlotInterfaces}). With no slot
 * interface, or no implementing match, a simple name maps to every non-inner
 * module type sharing it.
 */
export function typenameCandidates(
  cache: NedResourceCache,
  value: string,
  slotIfaces: NedTypeInfo[] = [],
): NedTypeInfo[] {
  const name = value.replace(/^"|"$/g, '').trim();
  if (!name || name.includes('$') || name.includes('{')) return [];
  const out: NedTypeInfo[] = [];
  const push = (t: NedTypeInfo | undefined) => {
    if (t && !out.some((o) => o.fqName === t.fqName)) out.push(t);
  };
  for (const iface of slotIfaces) for (const t of cache.lookupLikeCandidates(name, iface)) push(t);
  if (out.length) return out;
  const fallback = (t: NedTypeInfo | undefined) => {
    if (t && !t.isInnerType && t.isModuleType()) push(t);
  };
  if (name.includes('.')) fallback(cache.getType(name));
  else for (const t of cache.allTypes()) if (t.simpleName === name) fallback(t);
  return out;
}

/** Declaration locations of the {@link typenameCandidates} (callers may present a picker). */
export function typenameTypeTargets(
  cache: NedResourceCache,
  value: string,
  slotIfaces: NedTypeInfo[] = [],
): Location[] {
  return typenameCandidates(cache, value, slotIfaces).map(moduleDeclLocation);
}

/**
 * The `like` interfaces of the slots a `<path>.typename` key targets in the
 * section's network (empty when the network or the slots cannot be resolved).
 */
export function typenameSlotInterfaces(
  doc: IniDocument,
  cache: NedResourceCache,
  section: IniSection,
  key: string,
  fallbackNetwork?: string,
): NedTypeInfo[] {
  if (!key.endsWith('.typename')) return [];
  const netName = effectiveNetwork(doc, section) ?? fallbackNetwork;
  const net = netName ? resolveNetworkType(cache, netName, doc.uri) : undefined;
  if (!net) return [];
  const re = iniKeyToRegex(key.slice(0, -'.typename'.length));
  const bindings = buildTypenameBindings(collectTypenameEntries(doc, section));
  const out: NedTypeInfo[] = [];
  for (const m of getExpansion(cache, net, bindings).modules) {
    if (m.likeInterface && re.test(m.norm) && !out.includes(m.likeInterface)) out.push(m.likeInterface);
  }
  return out;
}

/**
 * Modules of the section's network whose instance path matches `pathPattern` (an
 * ini-style dotted path, possibly with wildcards), each with its concrete NED
 * type and that type's declaration location. Backs both "jump to the module
 * behind an ini key" and per-segment navigation from a dotted key.
 */
export function modulesAtPath(
  doc: IniDocument,
  cache: NedResourceCache,
  section: IniSection,
  pathPattern: string,
  fallbackNetwork?: string,
): { path: string; typeFqName: string; decl: Location }[] {
  const netName = effectiveNetwork(doc, section) ?? fallbackNetwork;
  if (!netName) return [];
  const net = resolveNetworkType(cache, netName, doc.uri);
  if (!net) return [];
  const re = iniKeyToRegex(pathPattern);
  const out: { path: string; typeFqName: string; decl: Location }[] = [];
  const bindings = buildTypenameBindings(collectTypenameEntries(doc, section));
  for (const m of getExpansion(cache, net, bindings).modules) {
    if (!m.typeInfo || !re.test(m.norm)) continue;
    out.push({ path: m.path, typeFqName: m.typeInfo.fqName, decl: moduleDeclLocation(m.typeInfo) });
  }
  return out;
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
  return modulesAtPath(doc, cache, section, key.slice(0, dot), fallbackNetwork);
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

/**
 * Reverse of {@link iniParamDefinition}: every INI key across the workspace that
 * assigns the NED parameter declared by `(typeFqName, param)`. For each config,
 * the parameter's declaring type is expanded to its instance paths, then every
 * in-scope entry whose pattern matches one of those paths is reported (with the
 * precedence winner flagged). Optionally restricted to a single config.
 */
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
