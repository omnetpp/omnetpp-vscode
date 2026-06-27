import { DocumentSymbol, SymbolKind } from '../model/symbols';
import type { IniDocument } from './iniDocument';

export function iniDocumentSymbols(doc: IniDocument): DocumentSymbol[] {
  return doc.sections.map((sec) => ({
    name: `[${sec.rawName}]`,
    detail: sec.extends.length ? `extends ${sec.extends.join(', ')}` : undefined,
    kind: SymbolKind.Namespace,
    range: sec.range,
    selectionRange: sec.headerRange,
    children: sec.entries.map((e) => ({
      name: e.key,
      detail: e.value.length > 40 ? e.value.slice(0, 40) + '…' : e.value,
      kind: SymbolKind.Key,
      range: { start: e.keyRange.start, end: e.valueRange.end },
      selectionRange: e.keyRange,
    })),
  }));
}
