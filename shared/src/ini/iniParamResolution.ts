import { Diagnostic, DiagnosticSeverity, Location } from '../model/location';
import { NedResourceCache } from '../ned/nedResourceCache';
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

/** Collapse vector indices to [] for pattern comparison. */
function normIndices(s: string): string {
  return s.replace(/\[[^\]]*\]/g, '[]');
}

/** Compile an ini key (OMNeT++ wildcard pattern) to an anchored RegExp. */
export function iniKeyToRegex(key: string): RegExp {
  const norm = normIndices(key);
  let out = '';
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === '*' && norm[i + 1] === '*') { out += '.*'; i++; }
    else if (c === '*') out += '[^.]*';
    else if (c === '?') out += '[^.]';
    else if (c === '[' && norm[i + 1] === ']') { out += '\\[\\]'; i++; }
    else if (/[a-zA-Z0-9_]/.test(c)) out += c;
    else out += '\\' + c;
  }
  return new RegExp('^' + out + '$');
}

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

/** Resolves a normalized parameter path to its winning INI assignment, if any. */
export type ConfigResolve = (normPath: string) => IniEntry | undefined;

/** Build a {@link ConfigResolve} from the entries in scope (first match wins). */
export function configResolver(entries: IniEntry[]): ConfigResolve {
  const compiled = entries.map((e) => ({ re: iniKeyToRegex(e.key), entry: e }));
  return (normPath: string) => compiled.find((c) => c.re.test(normPath))?.entry;
}

export function resolveNetworkType(cache: NedResourceCache, name: string): NedTypeInfo | undefined {
  if (name.includes('.')) return cache.getType(name);
  let fallback: NedTypeInfo | undefined;
  for (const t of cache.allTypes()) {
    if (t.simpleName === name && !t.isInnerType && t.isModuleType()) {
      if (t.kind === 'network') return t;
      fallback = fallback ?? t;
    }
  }
  return fallback;
}

// expansion cache, scoped per resource-cache instance and keyed by (generation, fqName)
const expandCache = new WeakMap<NedResourceCache, Map<string, ExpandResult>>();

function getExpansion(cache: NedResourceCache, net: NedTypeInfo): ExpandResult {
  let perCache = expandCache.get(cache);
  if (!perCache) {
    perCache = new Map();
    expandCache.set(cache, perCache);
  }
  const key = `${cache.generation}:${net.fqName}`;
  let r = perCache.get(key);
  if (!r) {
    if (perCache.size > 128) perCache.clear();
    r = expandNetwork(cache, net);
    perCache.set(key, r);
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
    const net = resolveNetworkType(cache, netName);
    if (!net) continue;

    const expansion = getExpansion(cache, net);
    const params = paramSlots(expansion);

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
    const net = resolveNetworkType(cache, netName);
    if (!net) continue;
    const slots = paramSlots(getExpansion(cache, net));
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

/** Go-to-definition target(s) for an ini parameter key: the NED param declaration(s). */
export function iniParamDefinition(
  doc: IniDocument,
  cache: NedResourceCache,
  section: IniSection,
  key: string,
): Location[] {
  const dot = key.lastIndexOf('.');
  const leaf = dot < 0 ? key : key.slice(dot + 1);
  if (/[*?\]]/.test(leaf)) return []; // wildcard leaf cannot pinpoint a declaration
  const netName = effectiveNetwork(doc, section);
  if (!netName) return [];
  const net = resolveNetworkType(cache, netName);
  if (!net) return [];
  const re = iniKeyToRegex(key);
  const out: Location[] = [];
  const seen = new Set<string>();
  for (const m of getExpansion(cache, net).modules) {
    if (!m.typeInfo || !m.params.has(leaf)) continue;
    if (!re.test(`${m.norm}.${leaf}`)) continue;
    const decl = m.typeInfo.paramDecl(leaf);
    if (!decl) continue;
    const nn = nameNode(decl.node) ?? decl.node;
    const locKey = `${decl.owner.file.uri}:${nn.startPosition.row}:${nn.startPosition.column}`;
    if (seen.has(locKey)) continue;
    seen.add(locKey);
    out.push({ uri: decl.owner.file.uri, range: nodeRange(nn) });
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
  const net = resolveNetworkType(cache, netName);
  if (!net) return [];
  return paramSlots(getExpansion(cache, net)).map((p) => ({ path: p.path, type: p.type }));
}
