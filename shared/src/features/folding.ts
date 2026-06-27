import type { Tree, SyntaxNode } from 'web-tree-sitter';
import type { IniDocument } from '../ini/iniDocument';

export interface FoldingRange {
  startLine: number;
  endLine: number;
  kind?: 'comment' | 'region';
}

// Node types worth folding (blocks and sections) for NED and MSG.
const FOLDABLE = new Set([
  // NED
  'simple', 'module', 'network', 'channel', 'channel_interface', 'moduleinterface',
  'parameters', 'gates', 'types', 'submodules', 'connections', 'submodule',
  'connection_group', 'object',
  // MSG
  'class', 'struct', 'message', 'packet', 'enum', 'body', 'cplusplus',
]);

export function treeFoldingRanges(tree: Tree): FoldingRange[] {
  const ranges: FoldingRange[] = [];
  const visit = (node: SyntaxNode) => {
    if (FOLDABLE.has(node.type)) {
      const start = node.startPosition.row;
      const end = node.endPosition.row;
      if (end > start) ranges.push({ startLine: start, endLine: end });
    }
    if (node.type === 'comment' && node.endPosition.row > node.startPosition.row) {
      ranges.push({ startLine: node.startPosition.row, endLine: node.endPosition.row, kind: 'comment' });
    }
    for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i)!);
  };
  visit(tree.rootNode);
  return ranges;
}

export function iniFoldingRanges(doc: IniDocument): FoldingRange[] {
  return doc.sections
    .map((s) => ({ startLine: s.range.start.line, endLine: s.range.end.line }))
    .filter((r) => r.endLine > r.startLine);
}
