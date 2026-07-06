import { Diagnostic, DiagnosticSeverity } from '../model/location';
import { ConfigRegistry } from './configRegistry';
import { classifyKey } from './iniConfigChecks';
import type { IniDocument, IniSection } from './iniDocument';
import { NedResourceCache } from '../ned/nedResourceCache';
import { resolveNetworkType } from './iniParamResolution';

/** The bare section name (config name), e.g. "General" or "Foo" for [Config Foo]/[Foo]. */
export function sectionName(sec: IniSection): string {
  if (sec.type === 'general') return 'General';
  return sec.configName ?? sec.rawName;
}

/**
 * Structural & placement diagnostics for an ini document, mirroring
 * InifileAnalyzer.validateSections()/validateConfig(): section-name validity,
 * extends= placement and targets, config-option placement, and network= type.
 */
export function iniStructureDiagnostics(
  doc: IniDocument,
  cache: NedResourceCache,
  registry: ConfigRegistry,
  /** Extra section names reachable via `include`, so `extends=` into an included
   *  base config is not reported as unknown. */
  includedSectionNames?: Iterable<string>,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const known = new Set(doc.sections.map(sectionName));
  if (includedSectionNames) for (const n of includedSectionNames) known.add(n);

  for (const sec of doc.sections) {
    const name = sectionName(sec);

    // ---- section-name validity (skip [General]) ----
    if (sec.type !== 'general') {
      let msg: string | undefined;
      if (name === '') msg = 'Section name may not be empty';
      else if (name.includes(' ')) msg = 'Section name may not contain space';
      else if (!/^[a-zA-Z_]/.test(name)) msg = 'Section name must begin with a letter or underscore';
      else if (!/^[a-zA-Z0-9_@-]+$/.test(name)) msg = 'Section name contains illegal character(s)';
      if (msg) {
        out.push({
          range: sec.headerRange,
          severity: DiagnosticSeverity.Error,
          message: msg,
          source: 'omnetpp',
          code: 'bad-section-name',
        });
      }
    }

    // ---- extends= placement and targets ----
    const extendsEntry = sec.entries.find((e) => e.key === 'extends');
    if (extendsEntry) {
      if (sec.type === 'general') {
        out.push({
          range: extendsEntry.keyRange,
          severity: DiagnosticSeverity.Error,
          message: 'The extends= key cannot occur in the [General] section',
          source: 'omnetpp',
          code: 'extends-in-general',
        });
      } else {
        for (const target of sec.extends) {
          if (!known.has(target)) {
            out.push({
              range: extendsEntry.valueRange,
              severity: DiagnosticSeverity.Error,
              message: `No such section: [${target}]`,
              source: 'omnetpp',
              code: 'no-such-section',
            });
          }
        }
      }
    }

    // ---- per-entry: config-option placement & network= type ----
    for (const e of sec.entries) {
      const cls = classifyKey(registry, e.key);
      if (cls.kind === 'config') {
        if (cls.option.scope === 'global' && sec.type !== 'general') {
          out.push({
            range: e.keyRange,
            severity: DiagnosticSeverity.Error,
            message: `Option "${e.key}" can only be specified globally, in the [General] section`,
            source: 'omnetpp',
            code: 'config-placement',
          });
        }
        if (e.key === 'network') validateNetwork(cache, e, doc.uri, out);
      }
    }
  }
  return out;
}

function validateNetwork(
  cache: NedResourceCache,
  e: { value: string; valueRange: import('../model/location').Range },
  iniUri: string | undefined,
  out: Diagnostic[],
): void {
  const value = e.value;
  if (!value || value.includes('$')) return; // empty or variable-driven: skip

  // Resolve exactly as OMNeT++ does (`<ini-folder-package>.Name`, then verbatim);
  // report a "not found" / "not a network" error only for what it would actually pick.
  const t = resolveNetworkType(cache, value, iniUri);
  let msg: string | undefined;
  if (!t) msg = `No such NED type: ${value}`;
  else if (!t.isModuleType()) msg = `Not a module type: ${value}`;
  else if (!t.isNetworkType()) msg = `Module type '${value}' was not declared to be a network`;
  if (msg) {
    out.push({
      range: e.valueRange,
      severity: DiagnosticSeverity.Error,
      message: msg,
      source: 'omnetpp',
      code: 'network-type',
    });
  }
}
