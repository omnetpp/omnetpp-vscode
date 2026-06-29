// The unified query surface over the three caches + the cross-reference graph.
//
// Both the MCP tool layer (`handleTool`) and the LSP providers consume this one
// object, so a query has a single implementation regardless of caller.
//
// The graph is populated incrementally per file: `onNedFile` / `onMsgFile` /
// `onIniFile` drop the file's prior edges, register its declarations, extract
// fresh edges, then drain any pending edges that the newly-declared symbols now
// satisfy. Cross-file edges hold SymbolIds, so editing a target re-points
// dependents to pending rather than re-walking referrers.

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Location } from '../model/location';
import type { NedResourceCache } from '../ned/nedResourceCache';
import type { MsgResourceCache } from '../msg/msgResourceCache';
import type { IniResourceCache } from '../ini/iniResourceCache';
import type { ConfigRegistry } from '../ini/configRegistry';
import type { NedTypeInfo } from '../ned/nedTypeInfo';
import type { MsgTypeInfo } from '../msg/msgTypeInfo';
import { isTypeRefNode, enclosingContextFor } from '../ned/nedNavigation';
import { nameNode } from '../ned/nedAst';
import { msgNameNode } from '../msg/msgAst';
import { resolveNetworkType } from '../ini/iniParamResolution';
import { nodeRange } from '../parser/treeUtils';
import { XrefIndex } from './xrefIndex';
import { extractNedEdges } from './xrefExtract';
import { extractMsgEdges } from './msgExtract';
import { extractIniEdges } from './iniExtract';
import { extractNedClassEdges, findMsgUsagesInNed } from './nedMsgLinks';
import { nedTypeSym, msgTypeSym, iniSectionSym, parseSymbolId, type SymbolId } from './symbolId';
import type { XrefEdge } from './xrefModel';

export class SemanticDatabase {
  /** The cross-reference graph. */
  readonly index = new XrefIndex();

  constructor(
    readonly nedCache: NedResourceCache,
    readonly msgCache: MsgResourceCache,
    readonly configRegistry: ConfigRegistry,
    readonly iniCache: IniResourceCache,
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
   * against `findTypeUsagesByWalk`. INI `network=` references are a separate query
   * (`findConfigsForNetwork`), so they are excluded here.
   */
  findTypeUsages(fq: string): Location[] {
    return this.index
      .inboundOf(nedTypeSym(fq))
      .filter((e) => e.kind !== 'ini-network')
      .map((e) => e.src);
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

  // ---- cross-language queries (graph-backed) ------------------------------

  /** Reverse: NED `@class` / `@signal(type=)` sites referencing a MSG type. */
  findMsgUsages(fq: string): Location[] {
    return this.index
      .inboundOf(msgTypeSym(fq))
      .filter((e) => e.kind === 'ned-class')
      .map((e) => e.src);
  }

  /** Same as `findMsgUsages` but via the full-scan walker (shadow oracle). */
  findMsgUsagesByWalk(fq: string): Location[] {
    return findMsgUsagesInNed(this.msgCache, this.nedCache, fq);
  }

  /** Direct MSG subtypes of a MSG type, from the reverse index. */
  findMsgSubtypes(fq: string): MsgTypeInfo[] {
    const out: MsgTypeInfo[] = [];
    const seen = new Set<string>();
    for (const e of this.index.inboundOf(msgTypeSym(fq))) {
      if (e.kind !== 'msg-extends') continue;
      const p = parseSymbolId(e.from);
      if (p?.lang !== 'msg' || seen.has(p.fqName)) continue;
      seen.add(p.fqName);
      const t = this.msgCache.getType(p.fqName);
      if (t) out.push(t);
    }
    return out;
  }

  /** Reverse: INI config-section sites whose `network=` resolves to a NED type. */
  findConfigsForNetwork(fq: string): Location[] {
    return this.index
      .inboundOf(nedTypeSym(fq))
      .filter((e) => e.kind === 'ini-network')
      .map((e) => e.src);
  }

  // ---- incremental population --------------------------------------------

  /**
   * (Re)index a NED file's edges. Must be called AFTER `nedCache.addFile` (the
   * tree must be live). Drops prior edges, registers declarations, extracts fresh
   * NED→NED and NED→MSG (`@class`/`@signal`) edges, then drains pending edges that
   * the newly-declared types now satisfy.
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
    for (const e of extractNedClassEdges(this.msgCache, this.nedCache, file)) this.index.addEdge(uri, e);

    this.drainDeclared(declared.map((t) => t.simpleName));
  }

  /** (Re)index a MSG file's `extends` / field-type edges. Call after `msgCache.addFile`. */
  onMsgFile(uri: string): void {
    this.index.dropFile(uri);
    const file = this.msgCache.getFile(uri);
    if (!file) return;

    const declared = this.msgCache.allTypes().filter((t) => t.file.uri === uri);
    for (const t of declared) {
      const declNode = msgNameNode(t.node) ?? t.node;
      this.index.setDef({ id: msgTypeSym(t.fqName), lang: 'msg', decl: { uri, range: nodeRange(declNode) } });
      this.index.addDeclares(uri, msgTypeSym(t.fqName));
    }
    for (const e of extractMsgEdges(this.msgCache, file)) this.index.addEdge(uri, e);

    this.drainDeclared(declared.map((t) => t.simpleName));
  }

  /** (Re)index an INI file's `network=` / `extends=` edges. Call after `iniCache.addFile`. */
  onIniFile(uri: string): void {
    this.index.dropFile(uri);
    const doc = this.iniCache.getDoc(uri);
    if (!doc) return;

    for (const sec of doc.sections) {
      this.index.setDef({ id: iniSectionSym(uri, sec.rawName), lang: 'ini', decl: { uri, range: sec.headerRange } });
      this.index.addDeclares(uri, iniSectionSym(uri, sec.rawName));
    }
    for (const e of extractIniEdges(this.nedCache, uri, doc)) this.index.addEdge(uri, e);
    // `ini-extends` targets are same-file sections (resolved at extract); `ini-network`
    // forward references are drained when the NED network file is (re)indexed.
  }

  /** Re-resolve pending edges referencing any of the given simple names. */
  private drainDeclared(simpleNames: Iterable<string>): void {
    const seen = new Set<string>();
    for (const name of simpleNames) {
      if (seen.has(name)) continue;
      seen.add(name);
      for (const e of [...this.index.pendingForName(name)]) {
        const resolved = this.resolveEdge(e);
        if (resolved) this.index.resolvePending(e, resolved);
      }
    }
  }

  /** Re-resolve a pending edge against the live caches, dispatching on its kind. */
  private resolveEdge(e: XrefEdge): SymbolId | null {
    switch (e.kind) {
      case 'msg-extends':
      case 'msg-field-type':
      case 'ned-class': {
        const t = this.msgCache.lookupType(e.rawTarget, e.nsContext ?? '');
        return t ? msgTypeSym(t.fqName) : null;
      }
      case 'ini-network': {
        const t = resolveNetworkType(this.nedCache, e.rawTarget);
        return t ? nedTypeSym(t.fqName) : null;
      }
      case 'ini-extends':
        return null; // same-file; resolved at extraction
      default: {
        const f = this.nedCache.getFile(e.originUri);
        if (!f) return null;
        const r = this.nedCache.lookupType(e.rawTarget, f, e.enclosingFq);
        return r ? nedTypeSym(r.fqName) : null;
      }
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
