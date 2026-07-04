import { NedResourceCache } from '../ned/nedResourceCache';
import type { IniDocument, IniSection } from './iniDocument';
import { iniKeyToRegex, normIndices } from './keyMatch';
import { paramSlots } from './moduleTree';
import {
  effectiveNetwork,
  resolveNetworkType,
  collectTypenameEntries,
  buildTypenameBindings,
  getExpansion,
} from './iniParamResolution';

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
