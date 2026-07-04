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
import {
  isTypeRefNode,
  enclosingContextFor,
  memberKeyFor,
  type MemberKind,
  type MemberKey,
} from '../ned/nedNavigation';
import { nameNode } from '../ned/nedAst';
import { msgNameNode } from '../msg/msgAst';
import { resolveNetworkType } from '../ini/iniParamResolution';
import { nodeRange } from '../parser/treeUtils';
import { CppResourceCache } from '../cpp/cppResourceCache';
import { XrefIndex } from './xrefIndex';
import { extractNedEdges } from './xrefExtract';
import { extractMsgEdges } from './msgExtract';
import { extractIniEdges } from './iniExtract';
import { extractNedClassEdges, extractNedImplEdges, findMsgUsagesInNed } from './nedMsgLinks';
import { cppClassSymbols, extractCppMemberEdges } from './cppExtract';
import {
  nedTypeSym,
  nedMemberSym,
  msgTypeSym,
  cppSym,
  iniSectionSym,
  parseSymbolId,
  type SymbolId,
} from './symbolId';
import type { EdgeKind, XrefEdge } from './xrefModel';

export class SemanticDatabase {
  /** The cross-reference graph. */
  readonly index = new XrefIndex();

  constructor(
    readonly nedCache: NedResourceCache,
    readonly msgCache: MsgResourceCache,
    readonly configRegistry: ConfigRegistry,
    readonly iniCache: IniResourceCache,
    readonly cppCache: CppResourceCache = new CppResourceCache(),
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
    const memberNames: string[] = [];
    for (const t of declared) {
      const declNode = nameNode(t.node) ?? t.node;
      this.index.setDef({ id: nedTypeSym(t.fqName), lang: 'ned', decl: { uri: t.file.uri, range: nodeRange(declNode) } });
      this.index.addDeclares(uri, nedTypeSym(t.fqName));
      // Declare each member this type is the canonical (most-base) owner of, so a
      // C++ access edge targeting it is demoted to pending when the type is dropped.
      const localMembers: [MemberKind, Iterable<string>][] = [
        ['param', t.localParams().keys()],
        ['gate', t.localGates().keys()],
        ['submodule', t.localSubmodules().keys()],
      ];
      for (const [kind, names] of localMembers) {
        for (const name of names) {
          const key = memberKeyFor(t, kind, name);
          if (key && key.ownerFq === t.fqName) {
            this.index.addDeclares(uri, nedMemberSym(key));
            memberNames.push(name);
          }
        }
      }
    }
    for (const e of extractNedEdges(this.nedCache, file)) this.index.addEdge(uri, e);
    for (const e of extractNedClassEdges(this.msgCache, this.nedCache, file)) this.index.addEdge(uri, e);
    for (const e of extractNedImplEdges(this.cppCache, this.nedCache, file)) this.index.addEdge(uri, e);

    // Draining member names re-resolves any C++ access edges now that this type's
    // members (and their `ned-impl` link) exist; type names cover NED/impl edges.
    this.drainDeclared([...declared.map((t) => t.simpleName), ...memberNames]);
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

  /**
   * (Re)index a C++ file. Call after `cppCache.addFile`. Registers each
   * `Define_Module`/`Define_Channel` class as a `cppSym` (the target of NED
   * `ned-impl` edges), then adds the file's literal member-access edges. Draining
   * class names first resolves NED `ned-impl` edges (establishing which NED type a
   * class implements); draining member names then resolves the access edges to
   * their NED members.
   */
  onCppFile(uri: string): void {
    this.index.dropFile(uri);
    if (!this.cppCache.getFile(uri)) return;

    const classNames: string[] = [];
    for (const c of cppClassSymbols(this.cppCache, uri)) {
      this.index.setDef({ id: c.sym, lang: 'cpp', decl: c.decl });
      this.index.addDeclares(uri, c.sym);
      classNames.push(c.simpleName);
    }
    const memberNames: string[] = [];
    for (const e of extractCppMemberEdges(this.cppCache, uri)) {
      this.index.addEdge(uri, e);
      memberNames.push(e.rawTarget);
    }
    this.drainDeclared([...classNames, ...memberNames]);
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
        const t = resolveNetworkType(this.nedCache, e.rawTarget, e.src?.uri);
        return t ? nedTypeSym(t.fqName) : null;
      }
      case 'ini-extends':
        return null; // same-file; resolved at extraction
      case 'ned-impl': {
        const c = this.cppCache.lookupClass(e.rawTarget, e.nsContext ?? '');
        return c ? cppSym(c.qualifiedName) : null;
      }
      case 'cpp-par-ref':
      case 'cpp-gate-ref':
      case 'cpp-submodule-ref':
        return this.resolveCppMemberEdge(e);
      default: {
        const f = this.nedCache.getFile(e.originUri);
        if (!f) return null;
        const r = this.nedCache.lookupType(e.rawTarget, f, e.enclosingFq);
        return r ? nedTypeSym(r.fqName) : null;
      }
    }
  }

  /**
   * Resolve a `cpp-*-ref` edge to the NED member it references: follow the
   * accessing class's resolved `ned-impl` edge(s) to the NED type, then key the
   * member canonically (so the SymbolId matches the one navigation produces).
   */
  private resolveCppMemberEdge(e: XrefEdge): SymbolId | null {
    const kind: MemberKind =
      e.kind === 'cpp-par-ref' ? 'param' : e.kind === 'cpp-gate-ref' ? 'gate' : 'submodule';
    for (const impl of this.index.inboundOf(e.from)) {
      if (impl.kind !== 'ned-impl') continue;
      const p = parseSymbolId(impl.from);
      if (p?.lang !== 'ned') continue;
      const type = this.nedCache.getType(p.fqName);
      if (!type) continue;
      const key = memberKeyFor(type, kind, e.rawTarget);
      if (key) return nedMemberSym(key);
    }
    return null;
  }

  // ---- cross-language queries (C++ ⇆ NED, graph-backed) -------------------

  /** Locations where a NED member is accessed in C++ (`par`/`gate`/`getSubmodule`). */
  findCppMemberAccesses(key: MemberKey): Location[] {
    const cppKinds = new Set<EdgeKind>(['cpp-par-ref', 'cpp-gate-ref', 'cpp-submodule-ref']);
    return this.index
      .inboundOf(nedMemberSym(key))
      .filter((e) => cppKinds.has(e.kind))
      .map((e) => e.src);
  }

  /** The C++ implementation class a NED type resolves to, if indexed. */
  findImplClass(fq: string): { qualifiedName: string; decl: Location } | null {
    for (const e of this.index.outboundOf(nedTypeSym(fq))) {
      if (e.kind !== 'ned-impl' || !e.to) continue;
      const p = parseSymbolId(e.to);
      if (p?.lang !== 'cpp') continue;
      const c = this.cppCache.classByQualifiedName(p.qualifiedName);
      if (c) return { qualifiedName: c.qualifiedName, decl: c.decl };
    }
    return null;
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
