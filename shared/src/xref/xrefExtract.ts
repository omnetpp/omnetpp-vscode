// Single-walk edge extractors. These subsume the per-query tree walks
// (`collectTypeRefs`, `nedTypeReferences`) by recording every type-position
// reference once, with its resolved target, at index-update time.

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { nodeRange } from '../parser/treeUtils';
import type { NedResourceCache, NedFileInfo } from '../ned/nedResourceCache';
import { isTypeRefNode, enclosingContextFor } from '../ned/nedNavigation';
import { NED_TYPE_NODES } from '../ned/nedAst';
import { nedTypeSym, fileSym } from './symbolId';
import type { EdgeKind, XrefEdge } from './xrefModel';

const TYPE_NODE_SET = new Set<string>(NED_TYPE_NODES as readonly string[]);

function isConnectionEndpointModule(n: SyntaxNode): boolean {
  return n.type === 'module' && (n.parent?.type === 'src' || n.parent?.type === 'dest');
}

/** Classify a type-reference node into an edge kind. */
function classify(n: SyntaxNode): EdgeKind {
  switch (n.type) {
    case 'extends':
      return 'extends';
    case 'implements':
      return 'implements';
    case 'like_type':
      return 'like-iface';
  }
  if (n.type === 'type' && n.parent?.type === 'submodule') return 'submodule-type';
  if (n.parent?.type === 'connection') return 'channel-type';
  if (n.parent?.type === 'import') return 'import';
  return 'submodule-type';
}

/** fq-name of the nearest enclosing NED type definition (the referencing type). */
function enclosingTypeFq(
  cache: NedResourceCache,
  node: SyntaxNode,
  uri: string,
): string | undefined {
  let cur: SyntaxNode | null = node;
  while (cur) {
    if (TYPE_NODE_SET.has(cur.type) && !isConnectionEndpointModule(cur)) {
      const f = cache.getFqNameForNode(cur, uri);
      if (f) return f;
    }
    cur = cur.parent;
  }
  return undefined;
}

/**
 * Every NED type-position reference in a file, as resolved edges. The `to` target
 * uses the exact same `lookupType` resolution as navigation, so the reverse index
 * agrees with the live walkers by construction. Unresolved refs carry `to=null`
 * and are bucketed for drain by the caller.
 */
export function extractNedEdges(cache: NedResourceCache, file: NedFileInfo): XrefEdge[] {
  const out: XrefEdge[] = [];
  const stack: SyntaxNode[] = [file.tree.rootNode];
  while (stack.length) {
    const n = stack.pop()!;
    if (isTypeRefNode(n)) {
      const fromFq = enclosingTypeFq(cache, n, file.uri);
      const enclosingFq = enclosingContextFor(cache, n, file.uri);
      const resolved = cache.lookupType(n.text, file, enclosingFq);
      out.push({
        kind: classify(n),
        from: fromFq ? nedTypeSym(fromFq) : fileSym(file.uri),
        to: resolved ? nedTypeSym(resolved.fqName) : null,
        rawTarget: n.text,
        src: { uri: file.uri, range: nodeRange(n) },
        originUri: file.uri,
        enclosingFq,
        unresolved: !resolved,
      });
    }
    for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i)!);
  }
  return out;
}
