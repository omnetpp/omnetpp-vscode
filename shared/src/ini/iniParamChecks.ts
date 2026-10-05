import { Diagnostic, DiagnosticSeverity, Range } from '../model/location';
import { NedResourceCache } from '../ned/nedResourceCache';
import { ExpandResult, ParamSlot, paramSlotsByName, paramSlots } from './moduleTree';
import { ConfigRegistry } from './configRegistry';
import { classifyKey } from './iniConfigChecks';
import type { IniDocument, IniEntry } from './iniDocument';
import { entryInFile } from './iniInclude';
import { parseExpression } from '../expr/exprParser';
import { inferType, isTypeMismatch } from '../expr/infer';
import { unitsCompatible } from '../expr/units';
import { iniKeyToRegex, normIndices } from './keyMatch';
import { leafSegment } from './iniKeySegments';
import { typeStringDiagnostic } from '../ned/nedSemanticChecks';
import type { NedTypeInfo } from '../ned/nedTypeInfo';
import {
  effectiveNetwork,
  resolveNetworkType,
  collectTypenameEntries,
  buildTypenameBindings,
  getExpansion,
  effectiveResolver,
  configEntriesInScope,
} from './iniParamResolution';

/**
 * Full INI parameter resolution: matches every `**.param = value` assignment
 * against the expanded module tree of the section's network, reporting keys that
 * match no parameter and values whose type conflicts with the NED declaration.
 */
export function iniParamDiagnostics(
  doc: IniDocument,
  cache: NedResourceCache,
  registry: ConfigRegistry,
  /** When `doc` is an include-expanded document, the URI of the file being linted:
   *  only its own entries are flagged, while resolution still sees included ones. */
  thisUri?: string,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const own = (e: IniEntry) => !thisUri || entryInFile(e, thisUri);

  for (const section of doc.sections) {
    // skip sections contributing no entry from the file being linted (e.g. a base
    // config pulled in only via include — it is linted in its own file)
    if (!section.entries.some(own)) continue;
    const netName = effectiveNetwork(doc, section);
    const net = netName ? resolveNetworkType(cache, netName, doc.uri) : undefined;
    const typenameEntries = collectTypenameEntries(doc, section);
    const bindings = buildTypenameBindings(typenameEntries);
    const expansion = net ? getExpansion(cache, net, bindings) : undefined;
    checkTypenameValues(section.entries.filter(own), cache, expansion, out);
    if (!net || !expansion) continue;
    const params = paramSlots(expansion);

    // An INI `**.x.typename = "Name"` that matched >1 implementers of the slot's
    // interface is ambiguous (OMNeT++ rejects it) — flag the offending entry's value.
    const flagged = new Set<string>();
    for (const amb of expansion.ambiguities) {
      const slotNorm = normIndices(amb.path);
      for (const e of typenameEntries) {
        if (!own(e)) continue; // flag only assignments written in this file
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

    // OMNeT++ resolves each parameter from the FIRST matching key in precedence
    // order (own section file-order → extends → [General]); build that oracle once
    // for the whole section (concrete vector indices only partially cover a slot).
    const isEffective = effectiveResolver(configEntriesInScope(doc, section, registry));

    for (const e of section.entries) {
      if (!own(e)) continue; // flag only assignments written in this file
      if (classifyKey(registry, e.key).kind !== 'param-assignment') continue;
      const re = iniKeyToRegex(e.key);
      const matched = candidateSlots(e.key, expansion, params).filter((p) => re.test(p.norm));

      if (matched.length > 0) {
        // Only the parameters this key actually WINS are effectively assigned;
        // type-check just those (a broader key does not set a parameter an earlier,
        // higher-precedence key already claimed).
        const won = matched.filter((p) => isEffective(e, p.norm));
        if (won.length > 0) {
          typeCheck(e, won, out);
        } else {
          out.push({
            range: e.keyRange,
            severity: DiagnosticSeverity.Information,
            message:
              'This assignment has no effect — every parameter it matches is already set by an earlier, higher-precedence key',
            source: 'omnetpp',
            code: 'shadowed-assignment',
          });
        }
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

/**
 * The slots an ini key can possibly match. A key whose last segment is a plain
 * identifier compiles to a regex anchored on `.<leaf>$`, so only the slots of that
 * parameter name can match; testing every slot of a large network for every entry
 * dominated the workspace diagnostics pass.
 */
function candidateSlots(key: string, expansion: ExpandResult, all: readonly ParamSlot[]): readonly ParamSlot[] {
  const leaf = key.slice(key.lastIndexOf('.') + 1);
  if (!/^[A-Za-z_]\w*$/.test(leaf)) return all;
  return paramSlotsByName(expansion).get(leaf) ?? [];
}

/**
 * Mirrors OMNeT++'s `InifileAnalyzer.validateParamKey()`
 * (ui/org.omnetpp.inifile.core/src/org/omnetpp/inifile/core/model/InifileAnalyzer.java):
 * same check sequence — unit consistency across matched parameters, data-type
 * mismatch, `@enum` value validation, then the redundant-assignment info when the
 * value equals the NED default — and largely the same diagnostic wording.
 */
function typeCheck(
  e: { value: string; valueRange: Range; key: string },
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

/**
 * `*.typename = "T"` values that name no type, or no type implementing the `like`
 * interface of the slots the key targets in `expansion` (the section's network,
 * when it resolves). Ambiguous names are reported separately (`ambiguous-typename`).
 */
function checkTypenameValues(
  entries: IniEntry[],
  cache: NedResourceCache,
  expansion: ExpandResult | undefined,
  out: Diagnostic[],
): void {
  for (const e of entries) {
    if (leafSegment(e.key) !== 'typename' || e.valueRange.start.line !== e.valueRange.end.line) continue;
    const m = /^"\s*([A-Za-z_][\w.]*)\s*"$/.exec(e.value);
    if (!m) continue;
    const name = m[1];
    const ifaces: NedTypeInfo[] = [];
    if (expansion) {
      const re = iniKeyToRegex(e.key.slice(0, -'.typename'.length));
      for (const mod of expansion.modules) {
        if (mod.likeInterface && re.test(mod.norm) && !ifaces.includes(mod.likeInterface)) ifaces.push(mod.likeInterface);
      }
    }
    const candidates = cache.lookupLikeCandidates(name, undefined);
    const start = e.valueRange.start.character + e.value.indexOf(name);
    const line = e.valueRange.start.line;
    const range = { start: { line, character: start }, end: { line, character: start + name.length } };
    const d = typeStringDiagnostic(name, range, ifaces, candidates);
    if (d) out.push(d);
  }
}
