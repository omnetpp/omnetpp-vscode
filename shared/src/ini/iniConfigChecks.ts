import { Diagnostic, DiagnosticSeverity } from '../model/location';
import { ConfigRegistry, INI_SECTION_DIRECTIVES, ConfigOption } from './configRegistry';
import type { IniDocument, IniEntry } from './iniDocument';
import { parseExpression } from '../expr/exprParser';
import { inferType } from '../expr/infer';

export type KeyClass =
  | { kind: 'directive' }
  | { kind: 'config'; option: ConfigOption }
  | { kind: 'unknown-config' }
  | { kind: 'param-assignment' };

/** Classify an ini key as a section directive, config option, or param assignment. */
export function classifyKey(registry: ConfigRegistry, key: string): KeyClass {
  if (INI_SECTION_DIRECTIVES.has(key)) return { kind: 'directive' };
  if (!key.includes('.')) {
    const opt = registry.get(key);
    return opt ? { kind: 'config', option: opt } : { kind: 'unknown-config' };
  }
  const lastSeg = key.slice(key.lastIndexOf('.') + 1);
  if (registry.isPerObjectOptionName(lastSeg)) {
    return { kind: 'config', option: registry.get(lastSeg)! };
  }
  return { kind: 'param-assignment' };
}

const NED_TYPE_FOR_CONFIG: Record<string, string> = {
  bool: 'bool',
  int: 'int',
  double: 'double',
};

function validateValue(entry: IniEntry, option: ConfigOption, out: Diagnostic[]): void {
  const v = entry.value;
  if (!v || v.includes('$') || v.includes('{') || v === 'default') return;
  const nedType = NED_TYPE_FOR_CONFIG[option.type];
  if (!nedType) return; // string/path/custom: too flexible to check
  const { type: vt } = inferType(parseExpression(v));
  if (vt === 'unknown') return;
  let bad = false;
  if (nedType === 'bool') bad = vt !== 'bool';
  else if (nedType === 'int' || nedType === 'double') {
    bad = vt === 'string' || vt === 'bool' || vt === 'xml';
  }
  if (bad) {
    out.push({
      range: entry.valueRange,
      severity: DiagnosticSeverity.Error,
      message: `Configuration option '${option.name}' expects a ${option.type} value`,
      source: 'omnetpp',
      code: 'config-value-type',
    });
  }
}

/** Config-key diagnostics: unknown config options and value-type mismatches. */
export function iniConfigDiagnostics(doc: IniDocument, registry: ConfigRegistry): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const sec of doc.sections) {
    for (const e of sec.entries) {
      const cls = classifyKey(registry, e.key);
      if (cls.kind === 'unknown-config') {
        out.push({
          range: e.keyRange,
          severity: DiagnosticSeverity.Warning,
          message: `Unknown configuration option '${e.key}'`,
          source: 'omnetpp',
          code: 'unknown-config',
        });
      } else if (cls.kind === 'config') {
        validateValue(e, cls.option, out);
      }
    }
  }
  return out;
}
