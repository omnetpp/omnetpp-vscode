// Pruning support for the (expensive) reverse param-assignment query.
//
// findParamAssignments expands every config's network to discover which instances
// declare a given parameter. On a large workspace that is thousands of network
// expansions, almost all wasted on configs whose network cannot contain the type.
//
// This computes the cheap part: the simple names of every NED type whose instances
// transitively contain an instance of `typeFqName` (or a subtype) through CONCRETE
// containment — hardwired submodules, channel types, and like-slot *default* types
// — following inheritance (a subtype inherits its base's submodules). The caller
// combines this with each config's own `typename` bindings (which resolve `like`
// overrides) to decide, without expanding, whether a config is worth expanding.

import type { SemanticDatabase } from './semanticDatabase';
import { nedTypeSym, parseSymbolId } from './symbolId';

/** Last dotted/`::` segment of a fully-qualified name. */
export function simpleNameOf(fq: string): string {
  const dot = fq.lastIndexOf('.');
  const col = fq.lastIndexOf('::');
  const cut = Math.max(dot, col < 0 ? -1 : col + 1);
  return cut >= 0 ? fq.slice(cut + 1) : fq;
}

export function paramContainerSimpleNames(db: SemanticDatabase, typeFqName: string): Set<string> {
  const out = new Set<string>();
  const visited = new Set<string>();
  const queue: string[] = [];
  // Adding a type also adds every subtype (which inherits the same containment).
  const add = (fq: string) => {
    for (const t of [fq, ...db.findSubtypes(fq).map((s) => s.fqName)]) {
      if (visited.has(t)) continue;
      visited.add(t);
      out.add(simpleNameOf(t));
      queue.push(t);
    }
  };
  add(typeFqName);
  while (queue.length) {
    const cur = queue.pop()!;
    for (const e of db.index.inboundOf(nedTypeSym(cur))) {
      if (e.kind !== 'submodule-type' && e.kind !== 'channel-type') continue;
      const p = parseSymbolId(e.from);
      if (p?.lang === 'ned') add(p.fqName);
    }
  }
  return out;
}
