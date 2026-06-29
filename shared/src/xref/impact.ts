// Impact analysis: the transitive set of symbols that depend (directly or
// indirectly) on a starting symbol — "what breaks if I change this". A breadth-
// first walk over the reverse index, so it is O(reachable edges).

import type { Location } from '../model/location';
import type { SemanticDatabase } from './semanticDatabase';
import { parseSymbolId, type SymbolId } from './symbolId';
import type { EdgeKind } from './xrefModel';

export interface ImpactNode {
  id: SymbolId;
  /** Display name of the dependent symbol. */
  name: string;
  /** Symbol language: ned | msg | ini | nedmem | cfg | cpp | file. */
  lang: string;
  /** Declaration location, when known. */
  decl?: Location;
  /** The relation by which it was reached from its (closer) predecessor. */
  via: EdgeKind;
  /** Distance (in edges) from the starting symbol. */
  depth: number;
}

function describe(id: SymbolId): { name: string; lang: string } {
  const p = parseSymbolId(id);
  if (!p) return { name: String(id), lang: 'unknown' };
  switch (p.lang) {
    case 'ned':
    case 'msg':
      return { name: p.fqName, lang: p.lang };
    case 'ini':
      return { name: p.rawName, lang: 'ini' };
    case 'nedmem':
      return { name: `${p.member.ownerFq}.${p.member.name}`, lang: 'nedmem' };
    case 'cfg':
      return { name: p.name, lang: 'cfg' };
    case 'cpp':
      return { name: p.qualifiedName, lang: 'cpp' };
    case 'file':
      return { name: p.uri.split('/').pop() ?? p.uri, lang: 'file' };
  }
}

/**
 * Every symbol transitively depending on `start`, breadth-first over inbound
 * edges. The start symbol itself is not included. `maxDepth` (default unlimited)
 * bounds the walk.
 */
export function impactOf(db: SemanticDatabase, start: SymbolId, opts?: { maxDepth?: number }): ImpactNode[] {
  const maxDepth = opts?.maxDepth ?? Infinity;
  const seen = new Set<SymbolId>([start]);
  const out: ImpactNode[] = [];
  let frontier: SymbolId[] = [start];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: SymbolId[] = [];
    for (const id of frontier) {
      for (const e of db.index.inboundOf(id)) {
        if (seen.has(e.from)) continue;
        seen.add(e.from);
        out.push({ id: e.from, ...describe(e.from), decl: db.index.defOf(e.from)?.decl, via: e.kind, depth });
        next.push(e.from);
      }
    }
    frontier = next;
  }
  return out;
}
