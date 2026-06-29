// Single-walk MSG edge extractor. Records every MSG type-position reference
// (a type's `extends` base and each field's type) once, with its resolved target,
// at index-update time — the MSG counterpart of `extractNedEdges`.

import { nodeRange, firstChildOfType } from '../parser/treeUtils';
import type { MsgResourceCache, MsgFileInfo } from '../msg/msgResourceCache';
import { coreTypeName, MSG_PRIMITIVES } from '../msg/msgResourceCache';
import { msgExtendsNode, msgFieldNodes, msgFieldInfo, msgTopLevelTypes } from '../msg/msgAst';
import { msgTypeSym } from './symbolId';
import type { XrefEdge } from './xrefModel';

/**
 * Every MSG type-position reference in a file, as resolved edges. `to` uses the
 * same `lookupType` resolution as navigation, so the reverse index agrees with the
 * walkers by construction. Unresolved refs carry `to=null` and are bucketed for
 * drain by the caller. Primitive field types (int, double, …) are not edges.
 */
export function extractMsgEdges(cache: MsgResourceCache, file: MsgFileInfo): XrefEdge[] {
  const out: XrefEdge[] = [];
  for (const typeNode of msgTopLevelTypes(file.tree)) {
    const owner = cache.typeInfoForNode(typeNode, file.uri);
    if (!owner) continue;
    const fromSym = msgTypeSym(owner.fqName);

    const extNode = msgExtendsNode(typeNode);
    if (extNode) {
      const raw = extNode.text.trim();
      const resolved = cache.lookupType(raw, owner.namespace);
      out.push({
        kind: 'msg-extends',
        from: fromSym,
        to: resolved ? msgTypeSym(resolved.fqName) : null,
        rawTarget: raw,
        src: { uri: file.uri, range: nodeRange(extNode) },
        originUri: file.uri,
        nsContext: owner.namespace,
        unresolved: !resolved,
      });
    }

    for (const fieldNode of msgFieldNodes(typeNode)) {
      const info = msgFieldInfo(fieldNode);
      const core = info.type ? coreTypeName(info.type) : '';
      if (!core || MSG_PRIMITIVES.has(core)) continue;
      const typeChild = firstChildOfType(fieldNode, 'type') ?? fieldNode;
      const resolved = cache.lookupType(core, owner.namespace);
      out.push({
        kind: 'msg-field-type',
        from: fromSym,
        to: resolved ? msgTypeSym(resolved.fqName) : null,
        rawTarget: core,
        src: { uri: file.uri, range: nodeRange(typeChild) },
        originUri: file.uri,
        nsContext: owner.namespace,
        unresolved: !resolved,
      });
    }
  }
  return out;
}
