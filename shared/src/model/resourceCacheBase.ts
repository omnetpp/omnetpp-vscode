import type { Tree } from 'web-tree-sitter';

/** What the base needs from a cached file record: its uri and the owned tree. */
export interface CachedSyntaxFile {
  uri: string;
  tree: Tree;
}

/** What the base needs from a type record: its definition node (for the
 *  node→fq-name reverse map; node.id is only unique within a single tree). */
export interface CachedTypeInfo {
  node: { id: number };
}

/**
 * Base for the project-wide, tree-owning resource caches (NED, MSG): the
 * file/type maps, the node→fq-name reverse map, tree ownership (freeing the
 * wasm-backed tree on remove/replace/clear), and the generation counter.
 *
 * Generation contract: `generation` is bumped on every add/remove/clear. Lazy
 * facades (e.g. `NedTypeInfo.resolve()`) re-resolve their cached inheritance
 * closure whenever it changes, so any edit conservatively invalidates every
 * facade. This is intentionally retained: it is a correctness mechanism, and
 * the expensive project-wide *reverse* queries (find-references / subtypes)
 * are already O(degree) via the cross-reference graph (see `SemanticDatabase`).
 * Decoupling resolution to per-symbol revisions is a further optimization
 * deferred until profiling on a large project (e.g. INET) shows the blanket
 * re-resolve is actually a bottleneck.
 */
export abstract class ResourceCacheBase<TFile extends CachedSyntaxFile, TType extends CachedTypeInfo> {
  generation = 0;
  protected readonly types = new Map<string, TType>();
  protected readonly files = new Map<string, TFile>();
  protected readonly fileTypeNames = new Map<string, string[]>();
  /** Maps a type-definition node (keyed by uri+nodeId) to its fq-name. */
  protected readonly nodeFqName = new Map<string, string>();

  /** Build the per-file node key (NUL-separated: cannot occur in a URI).
   *  node.id is only unique within a single tree. */
  protected nodeKey(uri: string, id: number): string {
    return `${uri}\0${id}`;
  }

  private freeTree(tree: Tree): void {
    try {
      tree.delete();
    } catch {
      /* already deleted */
    }
  }

  /** Hook: extra per-type cleanup while unregistering (MSG: bySimple index). */
  protected onTypeRemoved(_info: TType): void {}

  /** Hook: extra state dropped by clear() (MSG: bySimple; builtins are kept). */
  protected onCleared(): void {}

  /**
   * addFile skeleton: drop any previous entry for the uri (without bumping the
   * generation), store the file, let the subclass register its types (returning
   * the registered fq-names), then bump the generation exactly once.
   */
  protected replaceFileEntry(file: TFile, registerTypes: () => string[]): void {
    this.removeFile(file.uri, false);
    this.files.set(file.uri, file);
    this.fileTypeNames.set(file.uri, registerTypes());
    this.generation++;
  }

  /** Register one type under its fq-name (types map + node→fq-name reverse map). */
  protected registerTypeInfo(uri: string, fqName: string, info: TType): void {
    this.types.set(fqName, info);
    this.nodeFqName.set(this.nodeKey(uri, info.node.id), fqName);
  }

  removeFile(uri: string, bumpGen = true): void {
    const names = this.fileTypeNames.get(uri);
    if (names) {
      for (const n of names) {
        const info = this.types.get(n);
        this.types.delete(n);
        if (info) {
          this.nodeFqName.delete(this.nodeKey(uri, info.node.id));
          this.onTypeRemoved(info);
        }
      }
    }
    // the cache owns its trees; free the one being replaced/removed
    const prev = this.files.get(uri);
    if (prev) this.freeTree(prev.tree);
    this.fileTypeNames.delete(uri);
    this.files.delete(uri);
    if (bumpGen) this.generation++;
  }

  /** Drop all files and types, freeing every owned tree. */
  clear(): void {
    for (const f of this.files.values()) this.freeTree(f.tree);
    this.types.clear();
    this.files.clear();
    this.fileTypeNames.clear();
    this.nodeFqName.clear();
    this.onCleared();
    this.generation++;
  }

  getFile(uri: string): TFile | undefined {
    return this.files.get(uri);
  }

  getType(fqName: string): TType | undefined {
    return this.types.get(fqName);
  }

  /** The fq-name of a type-definition node in file `uri`, if registered. */
  getFqNameForNode(node: { id: number }, uri: string): string | undefined {
    return this.nodeFqName.get(this.nodeKey(uri, node.id));
  }

  typeInfoForNode(node: { id: number }, uri: string): TType | undefined {
    const fq = this.nodeFqName.get(this.nodeKey(uri, node.id));
    return fq ? this.types.get(fq) : undefined;
  }

  allTypes(): TType[] {
    return [...this.types.values()];
  }

  allFiles(): TFile[] {
    return [...this.files.values()];
  }

  allTypeNames(): string[] {
    return [...this.types.keys()];
  }

  /** The types declared in a single file (incl. inner types). */
  typesInFile(uri: string): TType[] {
    const names = this.fileTypeNames.get(uri);
    if (!names) return [];
    const out: TType[] = [];
    for (const n of names) {
      const t = this.types.get(n);
      if (t) out.push(t);
    }
    return out;
  }
}
