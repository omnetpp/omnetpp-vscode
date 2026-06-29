// The cross-reference graph store: forward + reverse adjacency over typed edges,
// maintained incrementally per file.
//
// Phase 0 establishes the structure and the per-file add/drop primitives. The
// extraction + eager-resolution + pending-drain logic is wired in Phase 1; until
// then `SemanticDatabase` still answers queries by delegating to the existing
// caches, so behavior is unchanged.

import type { SymbolId } from './symbolId';
import type { SymbolDef, XrefEdge } from './xrefModel';

interface FileEdges {
  edges: XrefEdge[];
  declares: SymbolId[];
}

/** Simple-name component of a SymbolId target text (last dotted/`::` segment). */
function simpleNameOf(raw: string): string {
  const dot = raw.lastIndexOf('.');
  const colon = raw.lastIndexOf('::');
  const cut = Math.max(dot, colon < 0 ? -1 : colon + 1);
  return cut >= 0 ? raw.slice(cut + 1) : raw;
}

export class XrefIndex {
  private defs = new Map<SymbolId, SymbolDef>();
  private fileEdges = new Map<string, FileEdges>();
  /** Reverse adjacency: target symbol → edges pointing at it. */
  private inEdges = new Map<SymbolId, XrefEdge[]>();
  /** Forward adjacency: source symbol → edges leaving it. */
  private outEdges = new Map<SymbolId, XrefEdge[]>();
  /** Unresolved edges bucketed by referenced simple name, for drain. */
  private pendingByName = new Map<string, XrefEdge[]>();

  /** Register (or replace) a symbol definition. */
  setDef(def: SymbolDef): void {
    this.defs.set(def.id, def);
  }

  defOf(id: SymbolId): SymbolDef | undefined {
    return this.defs.get(id);
  }

  /** Record an edge into the forward/reverse/pending structures. */
  addEdge(uri: string, edge: XrefEdge): void {
    let fe = this.fileEdges.get(uri);
    if (!fe) {
      fe = { edges: [], declares: [] };
      this.fileEdges.set(uri, fe);
    }
    fe.edges.push(edge);
    push(this.outEdges, edge.from, edge);
    if (edge.to) push(this.inEdges, edge.to, edge);
    else push(this.pendingByName, simpleNameOf(edge.rawTarget), edge);
  }

  /** Note that `uri` declares `sym` (so dropping the file forgets it). */
  addDeclares(uri: string, sym: SymbolId): void {
    let fe = this.fileEdges.get(uri);
    if (!fe) {
      fe = { edges: [], declares: [] };
      this.fileEdges.set(uri, fe);
    }
    fe.declares.push(sym);
  }

  /** Remove a file's edges and declarations from every structure. */
  dropFile(uri: string): void {
    const fe = this.fileEdges.get(uri);
    if (!fe) return;
    for (const e of fe.edges) {
      remove(this.outEdges, e.from, e);
      if (e.to) remove(this.inEdges, e.to, e);
      else remove(this.pendingByName, simpleNameOf(e.rawTarget), e);
    }
    for (const sym of fe.declares) this.defs.delete(sym);
    this.fileEdges.delete(uri);
  }

  /** Edges pointing at `sym` (the reverse layer that replaces full scans). */
  inboundOf(sym: SymbolId): readonly XrefEdge[] {
    return this.inEdges.get(sym) ?? [];
  }

  /** Edges leaving `sym`. */
  outboundOf(sym: SymbolId): readonly XrefEdge[] {
    return this.outEdges.get(sym) ?? [];
  }

  /** Unresolved edges referencing the given simple name (for drain on new decls). */
  pendingForName(name: string): readonly XrefEdge[] {
    return this.pendingByName.get(name) ?? [];
  }

  clear(): void {
    this.defs.clear();
    this.fileEdges.clear();
    this.inEdges.clear();
    this.outEdges.clear();
    this.pendingByName.clear();
  }
}

function push<K>(map: Map<K, XrefEdge[]>, key: K, edge: XrefEdge): void {
  const arr = map.get(key);
  if (arr) arr.push(edge);
  else map.set(key, [edge]);
}

function remove<K>(map: Map<K, XrefEdge[]>, key: K, edge: XrefEdge): void {
  const arr = map.get(key);
  if (!arr) return;
  const i = arr.indexOf(edge);
  if (i >= 0) arr.splice(i, 1);
  if (arr.length === 0) map.delete(key);
}
