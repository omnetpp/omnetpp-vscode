// Single-walk INI edge extractor. Records the cross-file `network=` reference of
// each config section (→ a NED type) and the same-file `extends=` reference
// (→ another section), at index-update time.

import type { NedResourceCache } from '../ned/nedResourceCache';
import type { IniDocument, IniSection } from '../ini/iniDocument';
import { resolveNetworkType } from '../ini/iniParamResolution';
import { iniSectionSym, nedTypeSym } from './symbolId';
import type { XrefEdge } from './xrefModel';

/** Find a section in the same document by a base name (config name or raw header). */
function findSection(doc: IniDocument, base: string): IniSection | undefined {
  return doc.sections.find(
    (s) => s.configName === base || s.rawName === base || s.rawName === `Config ${base}`,
  );
}

/**
 * The `ini-network` (section → NED type) and `ini-extends` (section → section)
 * references of an INI document, as resolved edges. A `network=` whose target NED
 * type is not yet indexed carries `to=null` and is bucketed for drain.
 */
export function extractIniEdges(nedCache: NedResourceCache, uri: string, doc: IniDocument): XrefEdge[] {
  const out: XrefEdge[] = [];
  for (const sec of doc.sections) {
    const fromSym = iniSectionSym(uri, sec.rawName);

    for (const e of sec.entries) {
      if (e.key !== 'network' || !e.value) continue;
      const resolved = resolveNetworkType(nedCache, e.value);
      out.push({
        kind: 'ini-network',
        from: fromSym,
        to: resolved ? nedTypeSym(resolved.fqName) : null,
        rawTarget: e.value,
        src: { uri, range: e.valueRange },
        originUri: uri,
        unresolved: !resolved,
      });
    }

    const extEntry = sec.entries.find((e) => e.key === 'extends');
    if (extEntry) {
      for (const base of sec.extends) {
        const target = findSection(doc, base);
        out.push({
          kind: 'ini-extends',
          from: fromSym,
          to: target ? iniSectionSym(uri, target.rawName) : null,
          rawTarget: base,
          src: { uri, range: extEntry.valueRange },
          originUri: uri,
          unresolved: !target,
        });
      }
    }
  }
  return out;
}
