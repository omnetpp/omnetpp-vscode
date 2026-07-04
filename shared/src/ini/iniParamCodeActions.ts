import { TextEdit } from '../model/location';
import { NedResourceCache } from '../ned/nedResourceCache';
import { paramSlots } from './moduleTree';
import type { IniDocument, IniSection } from './iniDocument';
import { iniKeyToRegex } from './keyMatch';
import {
  findSection,
  generalSection,
  effectiveNetwork,
  resolveNetworkType,
  collectTypenameEntries,
  buildTypenameBindings,
  getExpansion,
} from './iniParamResolution';

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
): TextEdit[] {
  const edits: TextEdit[] = [];
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
