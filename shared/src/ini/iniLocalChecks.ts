import { Diagnostic, DiagnosticSeverity } from '../model/location';
import type { IniDocument } from './iniDocument';

/** Local INI checks: duplicate keys within a section. */
export function iniLocalDiagnostics(doc: IniDocument): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const sec of doc.sections) {
    const seen = new Map<string, number>();
    for (const e of sec.entries) {
      if (seen.has(e.key)) {
        out.push({
          range: e.keyRange,
          severity: DiagnosticSeverity.Warning,
          message: `Duplicate key '${e.key}' in section [${sec.rawName}] (also defined on line ${seen.get(e.key)! + 1})`,
          source: 'omnetpp',
          code: 'duplicate-key',
        });
      }
      seen.set(e.key, e.line);
    }
  }
  return out;
}
