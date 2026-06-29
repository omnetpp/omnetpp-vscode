import type { Tree, Node as SyntaxNode } from 'web-tree-sitter';
import type { Location, Position, Range } from '../model/location';
import { CompletionItem, CompletionItemKind } from '../model/completion';
import { ancestorOfType, namedDescendantAt, nodeRange } from '../parser/treeUtils';
import { MsgFileInfo, MsgResourceCache, coreTypeName } from './msgResourceCache';
import { MsgTypeInfo } from './msgTypeInfo';
import { isMsgTypeNode, msgNameNode } from './msgAst';
import { docCommentCompletion } from '../ned/nedCompletion';

function refTypeNameAt(tree: Tree, pos: Position): { node: SyntaxNode; isDef: boolean } | null {
  const node = namedDescendantAt(tree, pos);
  if (!node) return null;
  if (node.type === 'name' && node.parent && isMsgTypeNode(node.parent)) {
    return { node, isDef: true };
  }
  const t = ancestorOfType(node, ['type', 'extends']);
  if (t) return { node: t, isDef: false };
  return null;
}

/** Range of the MSG type-name token under the cursor (decl or reference), for prepareRename. */
export function msgRenameRangeAt(tree: Tree, pos: Position): Range | undefined {
  const r = refTypeNameAt(tree, pos);
  return r ? nodeRange(r.node) : undefined;
}

/** The MSG type declared or referenced at a position (for references / rename). */
export function msgTypeAt(
  cache: MsgResourceCache,
  file: MsgFileInfo,
  tree: Tree,
  pos: Position,
): MsgTypeInfo | undefined {
  const r = refTypeNameAt(tree, pos);
  if (!r) return undefined;
  if (r.isDef) return cache.typeInfoForNode(r.node.parent!, file.uri);
  return cache.lookupType(coreTypeName(r.node.text), file.namespace);
}

export function msgDefinition(
  cache: MsgResourceCache,
  file: MsgFileInfo,
  tree: Tree,
  pos: Position,
): Location | null {
  const r = refTypeNameAt(tree, pos);
  if (!r) return null;
  if (r.isDef) {
    const info = cache.typeInfoForNode(r.node.parent!, file.uri);
    if (!info) return null;
    return { uri: info.file.uri, range: nodeRange(msgNameNode(info.node) ?? info.node) };
  }
  const target = cache.lookupType(coreTypeName(r.node.text), file.namespace);
  if (!target) return null;
  return { uri: target.file.uri, range: nodeRange(msgNameNode(target.node) ?? target.node) };
}

export interface HoverResult {
  markdown: string;
  range: Range;
}

export function msgHover(
  cache: MsgResourceCache,
  file: MsgFileInfo,
  tree: Tree,
  pos: Position,
): HoverResult | null {
  const r = refTypeNameAt(tree, pos);
  if (!r) return null;
  const info = r.isDef
    ? cache.typeInfoForNode(r.node.parent!, file.uri)
    : cache.lookupType(coreTypeName(r.node.text), file.namespace);
  if (!info) return null;
  let sig = `${info.kind} ${info.fqName}`;
  const base = info.extendsName();
  if (base) sig += ` extends ${base}`;
  return { markdown: '```msg\n' + sig + '\n```', range: nodeRange(r.node) };
}

const MSG_PRIMITIVE_ITEMS = [
  'bool', 'char', 'short', 'int', 'long', 'double', 'string',
  'unsigned int', 'unsigned long',
];

export function msgCompletion(
  cache: MsgResourceCache,
  file: MsgFileInfo,
  tree: Tree,
  pos: Position,
  lineText: string,
): CompletionItem[] {
  const prefix = lineText.slice(0, pos.character);

  // documentation-comment completion (doc keywords / HTML tags)
  const doc = docCommentCompletion(prefix);
  if (doc) return doc;

  const items: CompletionItem[] = [];

  // after `extends ` -> type names
  const afterExtends = /\bextends\s+[\w:]*$/.test(prefix);

  for (const t of cache.allTypes()) {
    items.push({
      label: t.simpleName,
      kind: t.kind === 'enum' ? CompletionItemKind.Enum : CompletionItemKind.Class,
      detail: `${t.kind} — ${t.fqName}`,
      insertText: t.simpleName,
    });
  }
  if (!afterExtends) {
    for (const p of MSG_PRIMITIVE_ITEMS) {
      items.push({ label: p, kind: CompletionItemKind.Keyword });
    }
  }
  return items;
}
