// C++ → NED cross-reference edges, extracted from the C++ scan cache.
//
// A C++ file contributes two things to the graph:
//   1. class *declarations* — each `Define_Module`/`Define_Channel` class becomes
//      a `cppSym`, the resolution target of NED `ned-impl` edges.
//   2. member-access *edges* — each literal `par()/gate()/getSubmodule()` call
//      becomes a `cpp-*-ref` edge from the accessing class to the NED member.
//      The member target is resolved later (in `SemanticDatabase.resolveEdge`),
//      by following the class's `ned-impl` link to the NED type, so a plain
//      extraction leaves `to=null` and lets the drain do the two-hop resolution.

import type { CppResourceCache } from '../cpp/cppResourceCache';
import type { CppMemberKind } from '../cpp/cppScanner';
import { cppSym, type SymbolId } from './symbolId';
import type { EdgeKind, XrefEdge } from './xrefModel';
import type { Location } from '../model/location';

const KIND_EDGE: Record<CppMemberKind, EdgeKind> = {
  param: 'cpp-par-ref',
  gate: 'cpp-gate-ref',
  submodule: 'cpp-submodule-ref',
};

/** The `cppSym` class declarations a C++ file registers (for `setDef`/`addDeclares`). */
export function cppClassSymbols(
  cppCache: CppResourceCache,
  uri: string,
): { sym: SymbolId; simpleName: string; decl: Location }[] {
  const file = cppCache.getFile(uri);
  if (!file) return [];
  return file.classes.map((c) => ({
    sym: cppSym(c.qualifiedName),
    simpleName: c.simpleName,
    decl: c.decl,
  }));
}

/** `cpp-*-ref` edges for every literal member access with a known owning class. */
export function extractCppMemberEdges(cppCache: CppResourceCache, uri: string): XrefEdge[] {
  const file = cppCache.getFile(uri);
  if (!file) return [];
  const out: XrefEdge[] = [];
  for (const a of file.accesses) {
    if (!a.ownerClass) continue; // unattributed access — cannot target a member
    out.push({
      kind: KIND_EDGE[a.kind],
      from: cppSym(a.ownerClass),
      to: null,
      rawTarget: a.name,
      src: a.src,
      originUri: uri,
      unresolved: true,
    });
  }
  return out;
}
