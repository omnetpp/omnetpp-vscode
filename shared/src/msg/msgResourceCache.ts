import type { Tree } from 'web-tree-sitter';
import { ResourceCacheBase } from '../model/resourceCacheBase';
import { MsgKind, MsgTypeInfo } from './msgTypeInfo';
import { msgNameNode, msgNamespaceNode, msgTopLevelTypes } from './msgAst';
import { childrenOfType } from '../parser/treeUtils';

export interface MsgFileInfo {
  uri: string;
  namespace: string;
  tree: Tree;
}

export const MSG_PRIMITIVES = new Set([
  'char', 'short', 'int', 'long', 'float', 'double', 'string', 'bool',
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

/** Project-wide index of MSG types (across imported files), plus builtin names.
 *  File/type storage, tree ownership, and the generation contract live in
 *  {@link ResourceCacheBase}; builtins survive clear(). */
export class MsgResourceCache extends ResourceCacheBase<MsgFileInfo, MsgTypeInfo> {
  private bySimple = new Map<string, MsgTypeInfo[]>();
  private builtins = new Set<string>();

  setBuiltins(names: string[]): void {
    this.builtins = new Set(names);
  }

  addFile(uri: string, tree: Tree): void {
    const ns = msgNamespaceNode(tree);
    const namespace = ns ? msgNameNode(ns)?.text ?? '' : '';
    const file: MsgFileInfo = { uri, namespace, tree };
    this.replaceFileEntry(file, () => {
      const registered: string[] = [];
      for (const t of msgTopLevelTypes(tree)) {
        const simple = msgNameNode(t)?.text;
        if (!simple) continue;
        const fqName = namespace ? `${namespace}::${simple}` : simple;
        const info = new MsgTypeInfo(this, fqName, simple, namespace, t.type as MsgKind, t, file);
        this.registerTypeInfo(uri, fqName, info);
        const arr = this.bySimple.get(simple) ?? [];
        arr.push(info);
        this.bySimple.set(simple, arr);
        registered.push(fqName);
      }
      return registered;
    });
  }

  protected override onTypeRemoved(info: MsgTypeInfo): void {
    const arr = this.bySimple.get(info.simpleName);
    if (arr) {
      const i = arr.indexOf(info);
      if (i >= 0) arr.splice(i, 1);
    }
  }

  protected override onCleared(): void {
    this.bySimple.clear(); // builtins are kept
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
