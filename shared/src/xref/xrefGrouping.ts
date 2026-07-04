// Presentation-agnostic shaping of cross-reference graph queries: resolve the
// graph symbol under a cursor, give edge kinds human-readable labels, and group
// inbound edges into ordered, labelled buckets ("Extended by", "Instantiated
// by", ...). Consumed by the LSP server's Used-By/Impact features and the MCP
// impact tooling, so the labels stay identical everywhere.
import type { Tree } from 'web-tree-sitter';
import type { Position } from '../model/location';
import { posInRange } from '../model/location';
import type { IniDocument } from '../ini/iniDocument';
import type { NedResourceCache } from '../ned/nedResourceCache';
import type { MsgResourceCache } from '../msg/msgResourceCache';
import { referenceAt, memberRefAt } from '../ned/nedNavigation';
import { msgTypeAt } from '../msg/msgNavigation';
import { resolveNetworkType } from '../ini/iniParamResolution';
import { iniSectionSym, msgTypeSym, nedMemberSym, nedTypeSym, parseSymbolId } from './symbolId';
import type { SymbolId } from './symbolId';
import type { EdgeKind, XrefEdge } from './xrefModel';

export interface UsedByItem {
  label: string;
  description?: string;
  uri: string;
  range: import('../model/location').Range;
}
export interface UsedByGroup {
  label: string;
  items: UsedByItem[];
}

const EDGE_KIND_LABEL: Record<EdgeKind, string> = {
  extends: 'Extended by',
  implements: 'Implemented by',
  'like-iface': 'Used as «like» by',
  'submodule-type': 'Instantiated by',
  'channel-type': 'Used as channel by',
  import: 'Imported by',
  'gate-ref': 'Gate referenced by',
  'submodule-ref': 'Submodule referenced by',
  'msg-extends': 'Extended by',
  'msg-field-type': 'Field type in',
  'ned-class': 'Backing class for',
  'ned-impl': 'Implemented by',
  'cpp-par-ref': 'Parameter read in',
  'cpp-gate-ref': 'Gate accessed in',
  'cpp-submodule-ref': 'Submodule accessed in',
  'ini-network': 'Network for config',
  'ini-extends': 'Extended by config',
};

/** Display order of the edge-kind groups (inheritance first, references last). */
const GROUP_ORDER: EdgeKind[] = [
  'extends', 'implements', 'msg-extends', 'like-iface', 'submodule-type', 'channel-type',
  'msg-field-type', 'ned-class', 'ned-impl', 'cpp-par-ref', 'cpp-gate-ref', 'cpp-submodule-ref',
  'ini-network', 'ini-extends', 'import', 'gate-ref', 'submodule-ref',
];

/** Human-readable relation label for an edge kind, e.g. `extends` → "Extended by". */
export function edgeKindLabel(kind: EdgeKind): string {
  return EDGE_KIND_LABEL[kind];
}

const baseName = (uri: string) => uri.split('/').pop() ?? uri;

/** Short display name of a graph symbol (simple type name, section name, file name). */
export function refDisplayName(from: SymbolId): string {
  const p = parseSymbolId(from);
  if (!p) return String(from);
  if (p.lang === 'ned' || p.lang === 'msg') return p.fqName.split(/[.:]/).pop() ?? p.fqName;
  if (p.lang === 'ini') return p.rawName;
  if (p.lang === 'nedmem') return p.member.name;
  if (p.lang === 'cpp') return p.qualifiedName.split('::').pop() ?? p.qualifiedName;
  if (p.lang === 'file') return baseName(p.uri);
  return String(from);
}

/** Group edges into ordered, labelled buckets for the Used-By presentation. */
export function groupEdges(edges: readonly XrefEdge[]): UsedByGroup[] {
  const byKind = new Map<EdgeKind, UsedByItem[]>();
  for (const e of edges) {
    const items = byKind.get(e.kind) ?? [];
    items.push({ label: refDisplayName(e.from), description: baseName(e.src.uri), uri: e.src.uri, range: e.src.range });
    byKind.set(e.kind, items);
  }
  const out: UsedByGroup[] = [];
  for (const kind of GROUP_ORDER) {
    const items = byKind.get(kind);
    if (items?.length) out.push({ label: EDGE_KIND_LABEL[kind], items });
  }
  return out;
}

/** The slice of a parsed document `symbolAtPosition` needs (the server's
 *  ParsedDocument is structurally compatible). */
export interface SymbolLookupDoc {
  uri: string;
  language: string;
  tree?: Tree;
  ini?: IniDocument;
}

/** The cross-reference graph symbol at a position (NED/MSG type, INI network or section). */
export function symbolAtPosition(
  doc: SymbolLookupDoc,
  pos: Position,
  nedCache: NedResourceCache,
  msgCache: MsgResourceCache,
): SymbolId | undefined {
  if (doc.language === 'ned' && doc.tree) {
    const file = nedCache.getFile(doc.uri);
    if (!file) return undefined;
    const tref = referenceAt(nedCache, file, file.tree, pos);
    const fq = tref?.kind === 'typedef' ? tref.info.fqName : tref?.kind === 'typeref' ? tref.target?.fqName : undefined;
    if (fq) return nedTypeSym(fq);
    const mref = memberRefAt(nedCache, file, file.tree, pos);
    return mref ? nedMemberSym(mref.key) : undefined;
  }
  if (doc.language === 'msg' && doc.tree) {
    const file = msgCache.getFile(doc.uri);
    const t = file ? msgTypeAt(msgCache, file, file.tree, pos) : undefined;
    return t ? msgTypeSym(t.fqName) : undefined;
  }
  if (doc.language === 'ini' && doc.ini) {
    for (const section of doc.ini.sections) {
      for (const e of section.entries) {
        if (e.key === 'network' && e.value && (posInRange(pos, e.keyRange) || posInRange(pos, e.valueRange))) {
          const net = resolveNetworkType(nedCache, e.value);
          return net ? nedTypeSym(net.fqName) : undefined;
        }
      }
    }
    const sec = [...doc.ini.sections].reverse().find((s) => s.range.start.line <= pos.line);
    return sec ? iniSectionSym(doc.uri, sec.rawName) : undefined;
  }
  return undefined;
}
