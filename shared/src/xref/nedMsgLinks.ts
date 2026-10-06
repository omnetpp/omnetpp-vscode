// NED ↔ MSG cross-language links. This is the ONLY core module that imports both
// the NED and MSG caches; keep MSG out of nedAst.ts / nedTypeInfo.ts.
//
// It resolves NED `@class(...)` and `@signal(...type=...)` class tokens to MSG
// types (using the NED file's effective `@namespace`), and provides the reverse: which NED
// sites reference a given MSG type. This is purely best-effort *navigation*: a
// `@class` names a registered C++ class, which is very often hand-written C++ with
// no `.msg` file at all. So an unresolved `@class` is NOT an error — we never emit
// a diagnostic for it, we only offer go-to-def / hover when a matching MSG type
// happens to exist.

import type { Tree } from 'web-tree-sitter';
import { Location, Position, Range } from '../model/location';
import { ancestorOfType, namedDescendantAt, nodeRange } from '../parser/treeUtils';
import type { NedResourceCache, NedFileInfo } from '../ned/nedResourceCache';
import type { NedTypeInfo } from '../ned/nedTypeInfo';
import type { MsgResourceCache } from '../msg/msgResourceCache';
import type { MsgTypeInfo } from '../msg/msgTypeInfo';
import {
  NED_TYPE_NODES,
  NedClassRef,
  nameNode,
  nedClassRefs,
  nedHasNoClassMarker,
  nedSignalTypeRefs,
} from '../ned/nedAst';
import { cppSym, msgTypeSym, nedTypeSym } from './symbolId';
import type { XrefEdge } from './xrefModel';
import type { CppResourceCache } from '../cpp/cppResourceCache';

/**
 * Resolve a NED type's C++ implementation class the way the OMNeT++ kernel does:
 * the nearest `@class(...)` found walking up the `extends` chain wins, and only if
 * NO type in the chain declares `@class` does the class default to the ROOT
 * (extends-nothing) type's own name. So `simple Derived extends Base` without a
 * `@class` inherits Base's implementation class rather than expecting one named
 * `Derived`. Only `simple` and `channel` roots get the default-name; a compound
 * module / network / interface has a C++ class only via an explicit `@class`.
 * `@class(-)` marks an abstract type: it and the subtypes that inherit it have
 * no C++ class.
 *
 * Returns the class name plus the NED type whose `@namespace` qualifies it (the
 * one that declared the `@class`, or the root for the default-name case), or null
 * when the type has no C++ class or its base type is not indexed.
 */
export function nedImplClass(type: NedTypeInfo): { className: string; owner: NedTypeInfo } | null {
  const seen = new Set<string>();
  let t: NedTypeInfo | undefined = type;
  while (t && !seen.has(t.fqName)) {
    seen.add(t.fqName);
    if (nedHasNoClassMarker(t.node)) return null;
    const own = nedClassRefs(t.node)[0]?.className;
    if (own) return { className: own, owner: t };
    const base = t.superType();
    if (!base) {
      // no @class up to here: `t` is the chain root, unless it names a base we
      // could not resolve (then the class is unknown, not the type's own name).
      if (t.extendsNames().length > 0) return null;
      if (t.kind === 'simple' || t.kind === 'channel') return { className: t.simpleName, owner: t };
      return null;
    }
    t = base;
  }
  return null; // inheritance cycle
}

/**
 * The C++ implementation class NAME a NED type maps to, or null when it has none.
 * This is the type's OWN class (`@class` value, else — for `simple`/`channel` —
 * its own name); it drives the per-type `ned-impl` edge. For the fully inherited
 * resolution used by navigation and the missing-class check, see `nedImplClass`.
 */
export function nedImplClassName(type: NedTypeInfo): string | null {
  if (nedHasNoClassMarker(type.node)) return null;
  const explicit = nedClassRefs(type.node)[0]?.className;
  if (explicit) return explicit;
  if (type.kind === 'simple' || type.kind === 'channel') return type.simpleName;
  return null;
}

/**
 * `ned-impl` edges of a NED file: each type that maps to a C++ implementation
 * class, resolved (via the effective `@namespace`) to the class registered with
 * `Define_Module`/`Define_Channel`. Unresolved when the class isn't indexed
 * (hand-written C++ not yet scanned, or a header-only base) — bucketed for drain.
 */
export function extractNedImplEdges(
  cppCache: CppResourceCache,
  nedCache: NedResourceCache,
  file: NedFileInfo,
): XrefEdge[] {
  const ns = nedCache.cxxNamespace(file);
  const out: XrefEdge[] = [];
  for (const type of nedCache.typesInFile(file.uri)) {
    const className = nedImplClassName(type);
    if (!className) continue;
    const resolved = cppCache.lookupClass(className, ns);
    const nn = nameNode(type.node) ?? type.node;
    out.push({
      kind: 'ned-impl',
      from: nedTypeSym(type.fqName),
      to: resolved ? cppSym(resolved.qualifiedName) : null,
      rawTarget: className,
      src: { uri: file.uri, range: nodeRange(nn) },
      originUri: file.uri,
      nsContext: ns,
      unresolved: !resolved,
    });
  }
  return out;
}

/** Resolve a NED `@class`/`@signal` class token to a MSG type via the file namespace. */
export function resolveNedClass(
  msgCache: MsgResourceCache,
  nedType: NedTypeInfo,
  className: string,
): MsgTypeInfo | undefined {
  const ns = nedType.cache.cxxNamespace(nedType.file);
  const name = className.replace(/^::/, ''); // leading :: forces global
  return msgCache.lookupType(name, ns);
}

/** All NED→MSG class references declared by a type (both `@class` and `@signal`). */
export function nedClassReferences(type: NedTypeInfo): NedClassRef[] {
  return [...nedClassRefs(type.node), ...nedSignalTypeRefs(type.node)];
}

function rangeContainsPos(r: { start: Position; end: Position }, p: Position): boolean {
  if (p.line < r.start.line || p.line > r.end.line) return false;
  if (p.line === r.start.line && p.character < r.start.character) return false;
  if (p.line === r.end.line && p.character > r.end.character) return false;
  return true;
}

export interface NedClassRefAt {
  ref: NedClassRef;
  owner: NedTypeInfo;
  target?: MsgTypeInfo;
  range: Range;
}

/** The NED→MSG class reference at a position (cursor on a `@class`/`@signal` value). */
export function nedClassRefAt(
  msgCache: MsgResourceCache,
  nedCache: NedResourceCache,
  file: NedFileInfo,
  tree: Tree,
  pos: Position,
): NedClassRefAt | null {
  const node = namedDescendantAt(tree, pos);
  if (!node) return null;
  const typeNode = ancestorOfType(node, NED_TYPE_NODES as unknown as string[]);
  if (!typeNode) return null;
  const owner = nedCache.typeInfoForNode(typeNode, file.uri);
  if (!owner) return null;
  for (const ref of nedClassReferences(owner)) {
    const range = ref.range;
    if (rangeContainsPos(range, pos)) {
      return { ref, owner, target: resolveNedClass(msgCache, owner, ref.className), range };
    }
  }
  return null;
}

/** Go-to-definition: a NED `@class`/`@signal` token → the MSG type declaration. */
export function nedClassDefinition(
  msgCache: MsgResourceCache,
  nedCache: NedResourceCache,
  file: NedFileInfo,
  tree: Tree,
  pos: Position,
): Location | null {
  const hit = nedClassRefAt(msgCache, nedCache, file, tree, pos);
  if (!hit?.target) return null;
  const t = hit.target;
  const nn = nameNode(t.node) ?? t.node;
  return { uri: t.file.uri, range: nodeRange(nn) };
}

/**
 * `ned-class` edges of a NED file: every `@class` / `@signal(type=)` reference of
 * each type in the file, resolved to its MSG type via the effective `@namespace`. An
 * unresolved reference (the backing class is hand-written C++ with no `.msg`)
 * carries `to=null` and is bucketed for drain — it is navigation, never an error.
 */
export function extractNedClassEdges(
  msgCache: MsgResourceCache,
  nedCache: NedResourceCache,
  file: NedFileInfo,
): XrefEdge[] {
  const ns = nedCache.cxxNamespace(file);
  const out: XrefEdge[] = [];
  for (const type of nedCache.typesInFile(file.uri)) {
    const fromSym = nedTypeSym(type.fqName);
    for (const ref of nedClassReferences(type)) {
      const resolved = resolveNedClass(msgCache, type, ref.className);
      out.push({
        kind: 'ned-class',
        from: fromSym,
        to: resolved ? msgTypeSym(resolved.fqName) : null,
        rawTarget: ref.className,
        src: { uri: file.uri, range: ref.range },
        originUri: file.uri,
        nsContext: ns,
        unresolved: !resolved,
      });
    }
  }
  return out;
}

/** Reverse: every NED site referencing a MSG type (by `@class` / `@signal type`). */
export function findMsgUsagesInNed(
  msgCache: MsgResourceCache,
  nedCache: NedResourceCache,
  msgFqName: string,
): Location[] {
  const out: Location[] = [];
  for (const type of nedCache.allTypes()) {
    for (const ref of nedClassReferences(type)) {
      const resolved = resolveNedClass(msgCache, type, ref.className);
      if (resolved?.fqName === msgFqName) out.push({ uri: type.file.uri, range: ref.range });
    }
  }
  return out;
}

