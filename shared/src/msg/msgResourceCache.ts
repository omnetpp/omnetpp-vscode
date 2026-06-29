import type { Tree, SyntaxNode } from 'web-tree-sitter';
import { MsgKind, MsgTypeInfo } from './msgTypeInfo';
import { msgNameNode, msgNamespaceNode, msgTopLevelTypes } from './msgAst';
import { childrenOfType } from '../parser/treeUtils';

export interface MsgFileInfo {
  uri: string;
  namespace: string;
  tree: Tree;
}

export const MSG_PRIMITIVES = new Set([
  'char', 'short', 'int', 'long', 'double', 'string', 'bool',
  'unsigned char', 'unsigned short', 'unsigned int', 'unsigned long',
]);

/** Strip const/pointer/whitespace from a field type to its core type name. */
export function coreTypeName(typeText: string): string {
  return typeText
    .replace(/\bconst\b/g, '')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function simpleOf(qname: string): string {
  const i = qname.lastIndexOf('::');
  return i >= 0 ? qname.slice(i + 2) : qname;
}

/** Project-wide index of MSG types (across imported files), plus builtin names. */
export class MsgResourceCache {
  generation = 0;
  private types = new Map<string, MsgTypeInfo>();
  private bySimple = new Map<string, MsgTypeInfo[]>();
  private files = new Map<string, MsgFileInfo>();
  private fileTypeNames = new Map<string, string[]>();
  // keyed by `uri\0nodeId` (node.id is only unique within one tree)
  private nodeFqName = new Map<string, string>();
  private builtins = new Set<string>();

  setBuiltins(names: string[]): void {
    this.builtins = new Set(names);
  }

  addFile(uri: string, tree: Tree): void {
    this.removeFile(uri, false);
    const ns = msgNamespaceNode(tree);
    const namespace = ns ? msgNameNode(ns)?.text ?? '' : '';
    const file: MsgFileInfo = { uri, namespace, tree };
    this.files.set(uri, file);
    const registered: string[] = [];
    for (const t of msgTopLevelTypes(tree)) {
      const simple = msgNameNode(t)?.text;
      if (!simple) continue;
      const fqName = namespace ? `${namespace}::${simple}` : simple;
      const info = new MsgTypeInfo(this, fqName, simple, namespace, t.type as MsgKind, t, file);
      this.types.set(fqName, info);
      this.nodeFqName.set(`${uri} ${t.id}`, fqName);
      const arr = this.bySimple.get(simple) ?? [];
      arr.push(info);
      this.bySimple.set(simple, arr);
      registered.push(fqName);
    }
    this.fileTypeNames.set(uri, registered);
    this.generation++;
  }

  /** Drop all files and types, freeing every owned tree (builtins are kept). */
  clear(): void {
    for (const f of this.files.values()) {
      try {
        f.tree.delete();
      } catch {
        /* already deleted */
      }
    }
    this.types.clear();
    this.bySimple.clear();
    this.files.clear();
    this.fileTypeNames.clear();
    this.nodeFqName.clear();
    this.generation++;
  }

  removeFile(uri: string, bumpGen = true): void {
    const names = this.fileTypeNames.get(uri);
    if (names) {
      for (const n of names) {
        const info = this.types.get(n);
        this.types.delete(n);
        if (info) {
          const arr = this.bySimple.get(info.simpleName);
          if (arr) {
            const i = arr.indexOf(info);
            if (i >= 0) arr.splice(i, 1);
          }
          this.nodeFqName.delete(`${uri} ${info.node.id}`);
        }
      }
    }
    // the cache owns its trees; free the one being replaced/removed
    const prev = this.files.get(uri);
    if (prev) {
      try {
        prev.tree.delete();
      } catch {
        /* already deleted */
      }
    }
    this.fileTypeNames.delete(uri);
    this.files.delete(uri);
    if (bumpGen) this.generation++;
  }

  getFile(uri: string): MsgFileInfo | undefined {
    return this.files.get(uri);
  }
  getType(fqName: string): MsgTypeInfo | undefined {
    return this.types.get(fqName);
  }
  allTypes(): MsgTypeInfo[] {
    return [...this.types.values()];
  }
  allFiles(): MsgFileInfo[] {
    return [...this.files.values()];
  }
  typeInfoForNode(node: { id: number }, uri: string): MsgTypeInfo | undefined {
    const fq = this.nodeFqName.get(`${uri} ${node.id}`);
    return fq ? this.types.get(fq) : undefined;
  }

  /** Resolve a MSG type name in a namespace context to a declared type. */
  lookupType(name: string, namespace: string): MsgTypeInfo | undefined {
    const n = name.replace(/^::/, '');
    if (n.includes('::')) {
      return this.types.get(n);
    }
    // current namespace
    if (namespace) {
      const t = this.types.get(`${namespace}::${n}`);
      if (t) return t;
    }
    // global namespace
    const g = this.types.get(n);
    if (g) return g;
    // any namespace by simple name
    const arr = this.bySimple.get(n);
    return arr && arr.length ? arr[0] : undefined;
  }

  /** Whether a (core) type name is known: primitive, declared, or builtin. */
  isKnownType(core: string, namespace: string): boolean {
    if (!core) return true;
    if (MSG_PRIMITIVES.has(core)) return true;
    if (this.lookupType(core, namespace)) return true;
    if (this.builtins.has(simpleOf(core))) return true;
    return false;
  }

  /** Declarations (forward decls) registered as known names in a file. */
  collectForwardDecls(tree: Tree): Set<string> {
    const names = new Set<string>();
    for (const type of ['class_decl', 'struct_decl', 'message_decl', 'packet_decl', 'enum_decl']) {
      for (const d of childrenOfType(tree.rootNode, type)) {
        const n = msgNameNode(d)?.text;
        if (n) names.add(simpleOf(n));
      }
    }
    return names;
  }
}

export { simpleOf as msgSimpleOf };
