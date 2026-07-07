import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { NedResourceCache, NedFileInfo } from './nedResourceCache';
import {
  ConnectionInfo,
  GateInfo,
  NedTypeKind,
  ParamInfo,
  SubmoduleInfo,
  TypenamePattern,
  connectionInfo,
  connectionNodes,
  extendsNodes,
  gateInfo,
  gateNodes,
  implementsNodes,
  leadingDocComment,
  paramInfo,
  paramNodes,
  propertyNodes,
  submoduleInfo,
  submoduleNodes,
  typenamePatternsOf,
} from './nedAst';

/**
 * Runtime type information for a NED type. Mirrors the C++ NedTypeInfo:
 * lazily resolves the transitive extends/interface closure and merged
 * (inherited + local) parameter/gate/submodule maps.
 */
export class NedTypeInfo {
  private gen = -1;
  private directExtends: NedTypeInfo[] = [];
  private directInterfaces: NedTypeInfo[] = [];
  private extendsName0?: string; // raw primary base name (for diagnostics)

  // Generation-gated memoization of the member accessors below. These are hit
  // once per module *instance* during network expansion (thousands of times for
  // a large network), and each computation walks the ancestor chain and re-parses
  // tree nodes — so caching them per generation is a large win. All returned
  // collections are treated as read-only by callers (verified), so sharing them
  // is safe; they are dropped whenever the cache generation bumps (any NED edit).
  private memoGen = -1;
  private ancestorsCache?: NedTypeInfo[];
  private localParamsCache?: Map<string, ParamInfo>;
  private localGatesCache?: Map<string, GateInfo>;
  private localSubmodulesCache?: Map<string, SubmoduleInfo>;
  private paramsCache?: Map<string, ParamInfo>;
  private gatesCache?: Map<string, GateInfo>;
  private submodulesCache?: Map<string, SubmoduleInfo>;
  private localTypenamePatternsCache?: TypenamePattern[];
  private typenamePatternsCache?: TypenamePattern[];

  private freshMemo(): void {
    if (this.memoGen === this.cache.generation) return;
    this.memoGen = this.cache.generation;
    this.ancestorsCache = undefined;
    this.localParamsCache = undefined;
    this.localGatesCache = undefined;
    this.localSubmodulesCache = undefined;
    this.paramsCache = undefined;
    this.gatesCache = undefined;
    this.submodulesCache = undefined;
    this.localTypenamePatternsCache = undefined;
    this.typenamePatternsCache = undefined;
  }

  constructor(
    public readonly cache: NedResourceCache,
    public readonly fqName: string,
    public readonly simpleName: string,
    public readonly packageName: string,
    public readonly kind: NedTypeKind,
    public readonly node: SyntaxNode,
    public readonly file: NedFileInfo,
    public readonly isInnerType: boolean,
    public readonly enclosingFqName: string | undefined,
  ) {}

  /** Resolve direct bases/interfaces against the current cache generation. */
  resolve(): void {
    if (this.gen === this.cache.generation) return;
    this.gen = this.cache.generation;
    this.directExtends = [];
    this.directInterfaces = [];
    const ctxEnclosing = this.isInnerType ? this.enclosingFqName : undefined;
    const exts = extendsNodes(this.node);
    this.extendsName0 = exts[0]?.text;
    for (const e of exts) {
      const t = this.cache.lookupType(e.text, this.file, ctxEnclosing);
      if (t) this.directExtends.push(t);
    }
    for (const i of implementsNodes(this.node)) {
      const t = this.cache.lookupType(i.text, this.file, ctxEnclosing);
      if (t) this.directInterfaces.push(t);
    }
  }

  /** Raw names of declared base types (for unresolved diagnostics). */
  extendsNames(): string[] {
    return extendsNodes(this.node).map((n) => n.text);
  }
  interfaceNames(): string[] {
    return implementsNodes(this.node).map((n) => n.text);
  }

  /** The primary (first) base type, resolved. */
  superType(): NedTypeInfo | undefined {
    this.resolve();
    return this.directExtends[0];
  }

  /** Directly-named supertypes (extends + implements), resolved. */
  directSupertypes(): NedTypeInfo[] {
    this.resolve();
    return [...this.directExtends, ...this.directInterfaces];
  }

  /** Transitive ancestors (primary chain + additional extends), nearest first. */
  ancestors(): NedTypeInfo[] {
    this.freshMemo();
    if (this.ancestorsCache) return this.ancestorsCache;
    const out: NedTypeInfo[] = [];
    const seen = new Set<string>();
    const visit = (t: NedTypeInfo) => {
      t.resolve();
      for (const base of t.directExtends) {
        if (!seen.has(base.fqName)) {
          seen.add(base.fqName);
          out.push(base);
          visit(base);
        }
      }
    };
    visit(this);
    this.ancestorsCache = out;
    return out;
  }

  /** Transitive interfaces (own + inherited). */
  allInterfaces(): NedTypeInfo[] {
    const out: NedTypeInfo[] = [];
    const seen = new Set<string>();
    const add = (t: NedTypeInfo) => {
      if (!seen.has(t.fqName)) {
        seen.add(t.fqName);
        out.push(t);
        for (const sup of t.ancestors()) add(sup);
      }
    };
    this.resolve();
    for (const i of this.directInterfaces) add(i);
    for (const sup of this.ancestors()) {
      sup.resolve();
      for (const i of sup.directInterfaces) add(i);
    }
    return out;
  }

  // ---- members (local) ----
  localParams(): Map<string, ParamInfo> {
    this.freshMemo();
    if (this.localParamsCache) return this.localParamsCache;
    const m = new Map<string, ParamInfo>();
    for (const p of paramNodes(this.node)) {
      const info = paramInfo(p);
      if (info.name && info.type && !info.isPattern) m.set(info.name, info);
    }
    this.localParamsCache = m;
    return m;
  }
  localGates(): Map<string, GateInfo> {
    this.freshMemo();
    if (this.localGatesCache) return this.localGatesCache;
    const m = new Map<string, GateInfo>();
    for (const g of gateNodes(this.node)) {
      const info = gateInfo(g);
      if (info.name) m.set(info.name, info);
    }
    this.localGatesCache = m;
    return m;
  }
  localSubmodules(): Map<string, SubmoduleInfo> {
    this.freshMemo();
    if (this.localSubmodulesCache) return this.localSubmodulesCache;
    const m = new Map<string, SubmoduleInfo>();
    for (const s of submoduleNodes(this.node)) {
      const info = submoduleInfo(s);
      if (info.name) m.set(info.name, info);
    }
    this.localSubmodulesCache = m;
    return m;
  }

  // ---- members (merged with inherited; local overrides base) ----
  params(): Map<string, ParamInfo> {
    this.freshMemo();
    if (this.paramsCache) return this.paramsCache;
    const m = new Map<string, ParamInfo>();
    const chain = [...this.ancestors()].reverse();
    for (const base of chain) for (const [k, v] of base.localParams()) m.set(k, v);
    for (const [k, v] of this.localParams()) m.set(k, v);
    this.paramsCache = m;
    return m;
  }
  gates(): Map<string, GateInfo> {
    this.freshMemo();
    if (this.gatesCache) return this.gatesCache;
    const m = new Map<string, GateInfo>();
    const chain = [...this.ancestors()].reverse();
    for (const base of chain) for (const [k, v] of base.localGates()) m.set(k, v);
    for (const [k, v] of this.localGates()) m.set(k, v);
    this.gatesCache = m;
    return m;
  }
  submodules(): Map<string, SubmoduleInfo> {
    this.freshMemo();
    if (this.submodulesCache) return this.submodulesCache;
    const m = new Map<string, SubmoduleInfo>();
    const chain = [...this.ancestors()].reverse();
    for (const base of chain) for (const [k, v] of base.localSubmodules()) m.set(k, v);
    for (const [k, v] of this.localSubmodules()) m.set(k, v);
    this.submodulesCache = m;
    return m;
  }

  /** `<sub>.typename = ...` assignments in this type's own `parameters:` section. */
  localTypenamePatterns(): TypenamePattern[] {
    this.freshMemo();
    if (!this.localTypenamePatternsCache) this.localTypenamePatternsCache = typenamePatternsOf(this.node);
    return this.localTypenamePatternsCache;
  }

  /**
   * `<sub>.typename = ...` assignments visible on this type, base-first then local.
   * These select the concrete type of a (possibly inherited) `like` submodule — e.g.
   * `BMacInterface`'s `radio.typename = default("ApskRadio")` applies to the `radio`
   * slot declared in its base `WirelessInterface`. All apply at the same instance level.
   */
  typenamePatterns(): TypenamePattern[] {
    this.freshMemo();
    if (this.typenamePatternsCache) return this.typenamePatternsCache;
    const out: TypenamePattern[] = [];
    for (const base of [...this.ancestors()].reverse()) out.push(...base.localTypenamePatterns());
    out.push(...this.localTypenamePatterns());
    this.typenamePatternsCache = out;
    return out;
  }

  /** Connections declared directly in this type's `connections:` section. */
  localConnections(): ConnectionInfo[] {
    return connectionNodes(this.node).map(connectionInfo);
  }

  /** Connections merged with those inherited from compound bases (base-first). */
  connections(): ConnectionInfo[] {
    const out: ConnectionInfo[] = [];
    for (const base of [...this.ancestors()].reverse()) out.push(...base.localConnections());
    out.push(...this.localConnections());
    return out;
  }

  findParam(name: string): ParamInfo | undefined {
    return this.params().get(name);
  }
  findGate(name: string): GateInfo | undefined {
    return this.gates().get(name);
  }
  getSubmodule(name: string): SubmoduleInfo | undefined {
    return this.submodules().get(name);
  }

  /** The type (self or ancestor) and param node declaring parameter `name`. */
  paramDecl(name: string): { owner: NedTypeInfo; node: SyntaxNode } | undefined {
    const find = (t: NedTypeInfo) => {
      for (const p of paramNodes(t.node)) {
        const info = paramInfo(p);
        if (info.name === name && info.type && !info.isPattern) return p;
      }
      return undefined;
    };
    const local = find(this);
    if (local) return { owner: this, node: local };
    for (const base of this.ancestors()) {
      const p = find(base);
      if (p) return { owner: base, node: p };
    }
    return undefined;
  }

  /** The type and gate node declaring gate `name` (self or inherited). */
  gateDecl(name: string): { owner: NedTypeInfo; node: SyntaxNode } | undefined {
    const find = (t: NedTypeInfo) => gateNodes(t.node).find((g) => gateInfo(g).name === name);
    const local = find(this);
    if (local) return { owner: this, node: local };
    for (const base of this.ancestors()) {
      const g = find(base);
      if (g) return { owner: base, node: g };
    }
    return undefined;
  }

  /** The type and submodule node declaring submodule `name` (self or inherited). */
  submoduleDecl(name: string): { owner: NedTypeInfo; node: SyntaxNode } | undefined {
    const find = (t: NedTypeInfo) => submoduleNodes(t.node).find((s) => submoduleInfo(s).name === name);
    const local = find(this);
    if (local) return { owner: this, node: local };
    for (const base of this.ancestors()) {
      const s = find(base);
      if (s) return { owner: base, node: s };
    }
    return undefined;
  }

  documentation(): string | undefined {
    return leadingDocComment(this.node);
  }

  /** Whether this type is a module/network (can contain submodules/connections). */
  isModuleType(): boolean {
    return this.kind === 'simple' || this.kind === 'compound' || this.kind === 'network';
  }

  /**
   * Whether this type may be used as a network: declared with the `network`
   * keyword, or a module carrying an `@isNetwork` property (value not `false`).
   */
  isNetworkType(): boolean {
    if (this.kind === 'network') return true;
    if (!this.isModuleType()) return false;
    for (const p of propertyNodes(this.node)) {
      const t = p.text.replace(/\s+/g, '');
      if (/^@isNetwork\b/.test(t) && !/^@isNetwork\(false\)/.test(t)) return true;
    }
    // inherited @isNetwork
    for (const base of this.ancestors()) {
      if (base.kind === 'network') return true;
      for (const p of propertyNodes(base.node)) {
        const t = p.text.replace(/\s+/g, '');
        if (/^@isNetwork\b/.test(t) && !/^@isNetwork\(false\)/.test(t)) return true;
      }
    }
    return false;
  }

  /**
   * Names of this type's type-level NED properties (`@display`, `@networkNode`, ...),
   * local first, then inherited from `ancestors()` (primary chain + additional
   * extends), deduplicated. Names are returned WITHOUT the leading `@`. Used by the
   * `get_ned_type` MCP tool (`properties` field) -- e.g. the Sequence Chart's
   * "Network Node"/"Network Interface" preset configurations check for
   * `@networkNode`/`@networkInterface`/`@wireJunction`, mirroring how the Eclipse
   * IDE's `SequenceChartContributor.collectAxisModules()` queries NEDResources.
   */
  typePropertyNames(): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    const collect = (t: NedTypeInfo): void => {
      for (const p of propertyNodes(t.node)) {
        const m = /^@\s*([A-Za-z_][A-Za-z0-9_:-]*)/.exec(p.text);
        if (m && !seen.has(m[1])) {
          seen.add(m[1]);
          names.push(m[1]);
        }
      }
    };
    collect(this);
    for (const base of this.ancestors()) collect(base);
    return names;
  }
}
