// Workspace-wide symbol enumeration (LSP `workspace/symbol`, the Ctrl-T picker).
// Surfaces every NED type, MSG type, and INI config section, filtered by a simple
// case-insensitive substring query.

import type { Location } from '../model/location';
import { SymbolKind } from '../model/symbols';
import { BUILTIN_URI } from '../ned/nedResourceCache';
import type { NedResourceCache } from '../ned/nedResourceCache';
import type { MsgResourceCache } from '../msg/msgResourceCache';
import type { IniResourceCache } from '../ini/iniResourceCache';
import { nameNode } from '../ned/nedAst';
import { msgNameNode } from '../msg/msgAst';
import { nodeRange } from '../parser/treeUtils';
import { configSummaries } from '../ini/iniDocument';

export interface WorkspaceSymbolInfo {
  name: string;
  kind: SymbolKind;
  location: Location;
  containerName?: string;
}

const NED_KIND: Record<string, SymbolKind> = {
  simple: SymbolKind.Class,
  compound: SymbolKind.Class,
  network: SymbolKind.Class,
  channel: SymbolKind.Class,
  moduleinterface: SymbolKind.Interface,
  channelinterface: SymbolKind.Interface,
};

const MSG_KIND: Record<string, SymbolKind> = {
  class: SymbolKind.Class,
  struct: SymbolKind.Struct,
  message: SymbolKind.Class,
  packet: SymbolKind.Class,
  enum: SymbolKind.Enum,
};

function matches(name: string, q: string): boolean {
  return q === '' || name.toLowerCase().includes(q);
}

function packageOf(fqName: string): string | undefined {
  const dot = fqName.lastIndexOf('.');
  return dot > 0 ? fqName.slice(0, dot) : undefined;
}

export function workspaceSymbols(
  query: string,
  caches: { nedCache: NedResourceCache; msgCache: MsgResourceCache; iniCache: IniResourceCache },
): WorkspaceSymbolInfo[] {
  const q = query.toLowerCase();
  const out: WorkspaceSymbolInfo[] = [];

  for (const t of caches.nedCache.allTypes()) {
    if (t.file.uri === BUILTIN_URI || !matches(t.simpleName, q)) continue;
    out.push({
      name: t.simpleName,
      kind: NED_KIND[t.kind] ?? SymbolKind.Class,
      location: { uri: t.file.uri, range: nodeRange(nameNode(t.node) ?? t.node) },
      containerName: packageOf(t.fqName),
    });
  }

  for (const t of caches.msgCache.allTypes()) {
    if (!matches(t.simpleName, q)) continue;
    out.push({
      name: t.simpleName,
      kind: MSG_KIND[t.kind] ?? SymbolKind.Class,
      location: { uri: t.file.uri, range: nodeRange(msgNameNode(t.node) ?? t.node) },
      containerName: t.namespace || undefined,
    });
  }

  for (const { uri, doc } of caches.iniCache.allDocs()) {
    for (const c of configSummaries(doc)) {
      if (!matches(c.name, q)) continue;
      out.push({ name: c.name, kind: SymbolKind.Namespace, location: { uri, range: c.range }, containerName: 'config' });
    }
  }

  return out;
}
