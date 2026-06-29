// The unified query surface over the three caches + the cross-reference graph.
//
// Both the MCP tool layer (`handleTool`) and the LSP providers consume this one
// object, so a query has a single implementation regardless of caller.
//
// Phase 0: every method delegates to the existing caches (zero behavior change).
// Later phases move reverse/occurrence queries onto `this.index` and add the
// cross-language links, without changing this surface's shape.

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Location } from '../model/location';
import type { NedResourceCache } from '../ned/nedResourceCache';
import type { MsgResourceCache } from '../msg/msgResourceCache';
import type { ConfigRegistry } from '../ini/configRegistry';
import type { NedTypeInfo } from '../ned/nedTypeInfo';
import type { MsgTypeInfo } from '../msg/msgTypeInfo';
import { isTypeRefNode, enclosingContextFor } from '../ned/nedNavigation';
import { nameNode } from '../ned/nedAst';
import { nodeRange } from '../parser/treeUtils';
import { XrefIndex } from './xrefIndex';
import { extractNedEdges } from './xrefExtract';
import { nedTypeSym, parseSymbolId } from './symbolId';

export class SemanticDatabase {
  /** The cross-reference graph. Populated in Phase 1; unused by queries in Phase 0. */
  readonly index = new XrefIndex();

  constructor(
    readonly nedCache: NedResourceCache,
    readonly msgCache: MsgResourceCache,
    readonly configRegistry: ConfigRegistry,
  ) {}

  getNedType(fq: string): NedTypeInfo | undefined {
    return this.nedCache.getType(fq);
  }

  getMsgType(fq: string): MsgTypeInfo | undefined {
    return this.msgCache.getType(fq);
  }

  /**
   * Subtypes of a NED type (direct or transitive), read from the reverse index.
   * O(degree) instead of the cache's O(types) full scan.
   */
  findSubtypes(fq: string, opts?: { direct?: boolean }): NedTypeInfo[] {
    const direct = this.findDirectSubtypesIndexed(fq);
    if (opts?.direct) return direct;
    const out: NedTypeInfo[] = [];
    const seen = new Set<string>();
    const queue = [...direct];
    while (queue.length) {
      const t = queue.shift()!;
      if (seen.has(t.fqName)) continue;
      seen.add(t.fqName);
      out.push(t);
      queue.push(...this.findDirectSubtypesIndexed(t.fqName));
    }
    return out;
  }

  /**
   * Type-position references (extends/implements/like/submodule/channel/import) of a
   * NED type, project-wide — O(degree) from the reverse index. Shadow-validated
   * against `findTypeUsagesByWalk` (Phase 1 tests).
   */
  findTypeUsages(fq: string): Location[] {
    return this.index.inboundOf(nedTypeSym(fq)).map((e) => e.src);
  }

  /** The pre-index project-wide tree walk. Retained as a fallback / shadow oracle. */
  findTypeUsagesByWalk(fq: string): Location[] {
    const target = this.nedCache.getType(fq);
    if (!target) return [];
    const out: Location[] = [];
    for (const f of this.nedCache.allFiles()) {
      const stack: SyntaxNode[] = [f.tree.rootNode];
      while (stack.length) {
        const n = stack.pop()!;
        if (isTypeRefNode(n) && n.text.split('.').pop() === target.simpleName) {
          const enclosing = enclosingContextFor(this.nedCache, n, f.uri);
          const resolved = this.nedCache.lookupType(n.text, f, enclosing);
          if (resolved && resolved.fqName === target.fqName) {
            out.push({ uri: f.uri, range: nodeRange(n) });
          }
        }
        for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i)!);
      }
    }
    return out;
  }

  // ---- incremental population --------------------------------------------

  /**
   * (Re)index a NED file's edges into the cross-reference graph. Must be called
   * AFTER `nedCache.addFile(uri, ...)` (the cache's tree must be live). Drops the
   * file's prior edges, registers its declarations, extracts fresh edges, then
   * drains any pending edges that the newly-declared types now satisfy.
   */
  onNedFile(uri: string): void {
    this.index.dropFile(uri);
    const file = this.nedCache.getFile(uri);
    if (!file) return;

    const declared = this.nedCache.typesInFile(uri);
    for (const t of declared) {
      const declNode = nameNode(t.node) ?? t.node;
      this.index.setDef({ id: nedTypeSym(t.fqName), lang: 'ned', decl: { uri: t.file.uri, range: nodeRange(declNode) } });
      this.index.addDeclares(uri, nedTypeSym(t.fqName));
    }
    for (const e of extractNedEdges(this.nedCache, file)) this.index.addEdge(uri, e);

    // forward references elsewhere that this file's types now satisfy
    const seen = new Set<string>();
    for (const t of declared) {
      if (seen.has(t.simpleName)) continue;
      seen.add(t.simpleName);
      this.drainName(t.simpleName);
    }
  }

  /** Re-resolve pending edges referencing `simpleName` against the live cache. */
  private drainName(simpleName: string): void {
    for (const e of [...this.index.pendingForName(simpleName)]) {
      const f = this.nedCache.getFile(e.originUri);
      if (!f) continue;
      const resolved = this.nedCache.lookupType(e.rawTarget, f, e.enclosingFq);
      if (resolved) this.index.resolvePending(e, nedTypeSym(resolved.fqName));
    }
  }

  /** Forget a file's contribution to the cross-reference graph. */
  dropFile(uri: string): void {
    this.index.dropFile(uri);
  }

  clear(): void {
    this.index.clear();
  }

  // ---- index-backed query primitives -------------------------------------

  /** Direct subtypes of a NED type, read from the reverse index. */
  findDirectSubtypesIndexed(fq: string): NedTypeInfo[] {
    const out: NedTypeInfo[] = [];
    const seen = new Set<string>();
    for (const e of this.index.inboundOf(nedTypeSym(fq))) {
      if (e.kind !== 'extends' && e.kind !== 'implements') continue;
      const p = parseSymbolId(e.from);
      if (p?.lang !== 'ned' || seen.has(p.fqName)) continue;
      seen.add(p.fqName);
      const t = this.nedCache.getType(p.fqName);
      if (t) out.push(t);
    }
    return out;
  }
}
