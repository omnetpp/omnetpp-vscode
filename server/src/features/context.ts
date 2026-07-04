import {
  Location,
  NedResourceCache,
  MsgResourceCache,
  ConfigRegistry,
  SemanticDatabase,
  IniResourceCache,
  NedTypeInfo,
  nodeRange,
  nameNode,
} from '@omnetpp/shared';

export interface IndexContext {
  nedCache: NedResourceCache;
  msgCache: MsgResourceCache;
  registry: ConfigRegistry;
  db: SemanticDatabase;
  iniCache: IniResourceCache;
}

export function lineAt(text: string, line: number): string {
  return text.split(/\r?\n/)[line] ?? '';
}

export const baseName = (uri: string): string => uri.split('/').pop() ?? uri;

/** Declaration location of a NED type (its name identifier). */
export function typeDeclLoc(t: NedTypeInfo): Location {
  return { uri: t.file.uri, range: nodeRange(nameNode(t.node) ?? t.node) };
}

export const asDefResult = (locs: Location[]): Location | Location[] | null =>
  locs.length === 0 ? null : locs.length === 1 ? locs[0] : locs;

export function dedupLocations(locs: Location[]): Location[] {
  const seen = new Set<string>();
  const out: Location[] = [];
  for (const l of locs) {
    const k = `${l.uri}:${l.range.start.line}:${l.range.start.character}:${l.range.end.line}:${l.range.end.character}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

export const plural = (n: number) => (n === 1 ? '' : 's');
