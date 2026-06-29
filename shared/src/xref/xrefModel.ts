// The typed-edge model for the cross-reference graph.
//
// An edge records only VALUES (a Location and SymbolIds) — never a live
// `SyntaxNode`. This is the safety invariant that lets a cache free its trees
// (`tree.delete()`) without ever dangling an edge.

import type { Location } from '../model/location';
import type { SymbolId } from './symbolId';

export type EdgeKind =
  // NED → NED
  | 'extends'
  | 'implements'
  | 'like-iface'
  | 'submodule-type'
  | 'channel-type'
  | 'import'
  | 'gate-ref'
  | 'submodule-ref'
  // MSG → MSG
  | 'msg-extends'
  | 'msg-field-type'
  // NED → MSG / C++
  | 'ned-class'
  // INI → NED
  | 'ini-network'
  | 'ini-extends';

export interface XrefEdge {
  kind: EdgeKind;
  /** The declaring symbol that owns the reference site. */
  from: SymbolId;
  /** Resolved target, or null when unresolved / behind a `like` boundary. */
  to: SymbolId | null;
  /** The reference text exactly as written (for unresolved reporting + re-resolve). */
  rawTarget: string;
  /** Location of the occurrence (a value — never a node). */
  src: Location;
  /** The referencing file's uri (resolution context for drain re-resolution). */
  originUri: string;
  /** NED lookup context (topmost enclosing compound fq) for re-resolution. */
  enclosingFq?: string;
  /** True when the edge was reached through a `like` interface boundary. */
  viaLike?: boolean;
  /** True when `to` is null because the target could not be resolved. */
  unresolved?: boolean;
}

export type SymbolLang = 'ned' | 'msg' | 'ini' | 'cfg' | 'cpp' | 'file';

export interface SymbolDef {
  id: SymbolId;
  lang: SymbolLang;
  /** Declaration location, when the symbol has a concrete declaration site. */
  decl?: Location;
}
