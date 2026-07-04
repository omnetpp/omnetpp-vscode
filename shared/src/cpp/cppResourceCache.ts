// Project-wide index of C++ scan results (`Define_Module` classes + literal
// member accesses), keyed for the two lookups the cross-reference graph needs:
// a class by its qualified name, and every access made by a class.
//
// Unlike the NED/MSG caches this owns no parse tree — `scanCpp` returns plain
// values, so there is nothing to `delete()`. Each file's contribution is tracked
// so `removeFile` fully forgets it.

import { scanCpp, type CppClassDecl, type CppMemberAccess } from './cppScanner';

export interface CppFileInfo {
  uri: string;
  classes: CppClassDecl[];
  accesses: CppMemberAccess[];
}

function simpleOf(qname: string): string {
  const i = qname.lastIndexOf('::');
  return i >= 0 ? qname.slice(i + 2) : qname;
}

export class CppResourceCache {
  generation = 0;
  private files = new Map<string, CppFileInfo>();
  /** qualified class name → declaring file infos (usually one). */
  private byQualified = new Map<string, CppClassDecl[]>();
  /** simple class name → qualified names (for namespace-tolerant lookup). */
  private bySimple = new Map<string, Set<string>>();
  /** qualified class name → accesses that class makes (across all files). */
  private accessesByClass = new Map<string, CppMemberAccess[]>();

  addFile(uri: string, text: string): void {
    this.removeFile(uri, false);
    const { classes, accesses } = scanCpp(uri, text);
    this.files.set(uri, { uri, classes, accesses });
    for (const c of classes) {
      push(this.byQualified, c.qualifiedName, c);
      let set = this.bySimple.get(c.simpleName);
      if (!set) this.bySimple.set(c.simpleName, (set = new Set()));
      set.add(c.qualifiedName);
    }
    for (const a of accesses) {
      if (a.ownerClass) push(this.accessesByClass, a.ownerClass, a);
    }
    this.generation++;
  }

  removeFile(uri: string, bumpGen = true): void {
    const info = this.files.get(uri);
    if (info) {
      for (const c of info.classes) {
        remove(this.byQualified, c.qualifiedName, c);
        if (!this.byQualified.has(c.qualifiedName)) {
          const set = this.bySimple.get(c.simpleName);
          if (set) {
            set.delete(c.qualifiedName);
            if (set.size === 0) this.bySimple.delete(c.simpleName);
          }
        }
      }
      for (const a of info.accesses) if (a.ownerClass) remove(this.accessesByClass, a.ownerClass, a);
      this.files.delete(uri);
    }
    if (bumpGen) this.generation++;
  }

  clear(): void {
    this.files.clear();
    this.byQualified.clear();
    this.bySimple.clear();
    this.accessesByClass.clear();
    this.generation++;
  }

  getFile(uri: string): CppFileInfo | undefined {
    return this.files.get(uri);
  }
  allFiles(): CppFileInfo[] {
    return [...this.files.values()];
  }

  /** True when any indexed file registers `qualifiedName` via a `Define_*` macro. */
  hasClass(qualifiedName: string): boolean {
    return this.byQualified.has(qualifiedName);
  }

  /** The class registration for a qualified name, if indexed. */
  classByQualifiedName(qualifiedName: string): CppClassDecl | undefined {
    return this.byQualified.get(qualifiedName)?.[0];
  }

  /**
   * Resolve a (possibly unqualified) class name in a namespace context to an
   * indexed registration. Mirrors `MsgResourceCache.lookupType`: exact qualified
   * match, then `namespace::name`, then global, then any namespace by simple name.
   */
  lookupClass(name: string, namespace: string): CppClassDecl | undefined {
    const n = name.replace(/^::/, '');
    if (n.includes('::')) return this.classByQualifiedName(n);
    if (namespace) {
      const q = this.classByQualifiedName(`${namespace}::${n}`);
      if (q) return q;
    }
    const g = this.classByQualifiedName(n);
    if (g) return g;
    const set = this.bySimple.get(n);
    if (set && set.size) return this.classByQualifiedName([...set][0]);
    return undefined;
  }

  /** Every literal member access made by a given qualified class. */
  accessesOf(qualifiedName: string): readonly CppMemberAccess[] {
    return this.accessesByClass.get(qualifiedName) ?? [];
  }

  /** True when any class anywhere accesses a member of the given name/kind. */
  isNameAccessed(kind: CppMemberAccess['kind'], name: string): boolean {
    for (const arr of this.accessesByClass.values())
      for (const a of arr) if (a.kind === kind && a.name === name) return true;
    return false;
  }
}

export { simpleOf as cppSimpleOf };

function push<K, V>(map: Map<K, V[]>, key: K, val: V): void {
  const arr = map.get(key);
  if (arr) arr.push(val);
  else map.set(key, [val]);
}

function remove<K, V>(map: Map<K, V[]>, key: K, val: V): void {
  const arr = map.get(key);
  if (!arr) return;
  const i = arr.indexOf(val);
  if (i >= 0) arr.splice(i, 1);
  if (arr.length === 0) map.delete(key);
}
