// Stable, name-derived symbol identities for the cross-reference graph.
//
// A `SymbolId` NEVER embeds a tree-sitter node id (those are only unique within a
// single parse and are invalidated on every reparse). Every id is derived purely
// from names/uris so an edge can outlive the tree that produced it.

import type { MemberKey, MemberKind } from '../ned/nedNavigation';

/** Branded string identifying a symbol across NED/MSG/INI. */
export type SymbolId = string & { readonly __sym: unique symbol };

export function nedTypeSym(fqName: string): SymbolId {
  return `ned:${fqName}` as SymbolId;
}
export function msgTypeSym(fqName: string): SymbolId {
  return `msg:${fqName}` as SymbolId;
}
export function nedMemberSym(key: MemberKey): SymbolId {
  return `nedmem:${key.ownerFq}#${key.kind}:${key.name}` as SymbolId;
}
export function iniSectionSym(uri: string, rawName: string): SymbolId {
  return `ini:${uri}#${rawName}` as SymbolId;
}
export function cfgOptSym(name: string): SymbolId {
  return `cfgopt:${name}` as SymbolId;
}
export function cppSym(qualifiedName: string): SymbolId {
  return `cpp:${qualifiedName}` as SymbolId;
}
export function fileSym(uri: string): SymbolId {
  return `file:${uri}` as SymbolId;
}

export type ParsedSymbol =
  | { lang: 'ned'; fqName: string }
  | { lang: 'msg'; fqName: string }
  | { lang: 'nedmem'; member: MemberKey }
  | { lang: 'ini'; uri: string; rawName: string }
  | { lang: 'cfg'; name: string }
  | { lang: 'cpp'; qualifiedName: string }
  | { lang: 'file'; uri: string };

/** Decode a SymbolId back into its structured form, or undefined if malformed. */
export function parseSymbolId(id: SymbolId): ParsedSymbol | undefined {
  const colon = id.indexOf(':');
  if (colon < 0) return undefined;
  const tag = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  switch (tag) {
    case 'ned':
      return { lang: 'ned', fqName: rest };
    case 'msg':
      return { lang: 'msg', fqName: rest };
    case 'cfgopt':
      return { lang: 'cfg', name: rest };
    case 'cpp':
      return { lang: 'cpp', qualifiedName: rest };
    case 'file':
      return { lang: 'file', uri: rest };
    case 'nedmem': {
      const hash = rest.indexOf('#');
      const colon2 = rest.indexOf(':', hash + 1);
      if (hash < 0 || colon2 < 0) return undefined;
      const ownerFq = rest.slice(0, hash);
      const kind = rest.slice(hash + 1, colon2) as MemberKind;
      const name = rest.slice(colon2 + 1);
      return { lang: 'nedmem', member: { kind, ownerFq, name } };
    }
    case 'ini': {
      const hash = rest.indexOf('#');
      if (hash < 0) return undefined;
      return { lang: 'ini', uri: rest.slice(0, hash), rawName: rest.slice(hash + 1) };
    }
    default:
      return undefined;
  }
}
