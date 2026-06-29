// NED ↔ MSG cross-language links. This is the ONLY core module that imports both
// the NED and MSG caches; keep MSG out of nedAst.ts / nedTypeInfo.ts.
//
// It resolves NED `@class(...)` and `@signal(...type=...)` class tokens to MSG
// types (using the NED file's `@namespace`), and provides the reverse: which NED
// sites reference a given MSG type. Resolution is best-effort — registered C++
// classes legitimately have no `.msg` declaration, so unresolved refs are never
// hard errors.

import type { Tree } from 'web-tree-sitter';
import { Diagnostic, DiagnosticSeverity, Location, Position, Range } from '../model/location';
import { ancestorOfType, namedDescendantAt, nodeRange } from '../parser/treeUtils';
import type { NedResourceCache, NedFileInfo } from '../ned/nedResourceCache';
import type { NedTypeInfo } from '../ned/nedTypeInfo';
import type { MsgResourceCache } from '../msg/msgResourceCache';
import type { MsgTypeInfo } from '../msg/msgTypeInfo';
import {
  NED_TYPE_NODES,
  NedClassRef,
  fileNamespace,
  nameNode,
  nedClassRefs,
  nedSignalTypeRefs,
} from '../ned/nedAst';

/** Resolve a NED `@class`/`@signal` class token to a MSG type via the file namespace. */
export function resolveNedClass(
  msgCache: MsgResourceCache,
  nedType: NedTypeInfo,
  className: string,
): MsgTypeInfo | undefined {
  const ns = fileNamespace(nedType.file.tree) ?? '';
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
    const range = nodeRange(ref.node);
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
      if (resolved?.fqName === msgFqName) out.push({ uri: type.file.uri, range: nodeRange(ref.node) });
    }
  }
  return out;
}

/**
 * `unknown-class` warnings for `@class`/`@signal` tokens that resolve to no MSG
 * type. Gated on a non-empty MSG index (registered C++ classes with no `.msg` are
 * legitimate, so we stay silent when there are no message definitions to check
 * against) and emitted as warnings, never errors.
 */
export function nedMsgDiagnostics(
  msgCache: MsgResourceCache,
  nedCache: NedResourceCache,
  uri: string,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (msgCache.allTypes().length === 0) return out; // nothing to validate against
  for (const type of nedCache.typesInFile(uri)) {
    const ns = fileNamespace(type.file.tree) ?? '';
    for (const ref of nedClassReferences(type)) {
      const name = ref.className.replace(/^::/, '');
      if (msgCache.isKnownType(name, ns)) continue;
      out.push({
        range: nodeRange(ref.node),
        severity: DiagnosticSeverity.Warning,
        message: `Class '${ref.className}' is not declared in any .msg file`,
        source: 'omnetpp',
        code: 'unknown-class',
      });
    }
  }
  return out;
}
