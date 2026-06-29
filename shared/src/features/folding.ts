import type { Tree, Node as SyntaxNode } from 'web-tree-sitter';
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
    // The grammar emits one `comment` node per `//` line, so fold a run of
    // consecutive comment siblings (a banner block) that spans multiple lines.
    // A single multi-row comment node (`\`-continued) still folds on its own.
    let runStart: SyntaxNode | null = null;
    let runEnd: SyntaxNode | null = null;
    const flush = () => {
      if (runStart && runEnd && runEnd.endPosition.row > runStart.startPosition.row) {
        ranges.push({ startLine: runStart.startPosition.row, endLine: runEnd.endPosition.row, kind: 'comment' });
      }
      runStart = runEnd = null;
    };
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i)!;
      if (c.type === 'comment') {
        if (runEnd && c.startPosition.row === runEnd.endPosition.row + 1) {
          runEnd = c; // contiguous with the current run
        } else {
          flush();
          runStart = runEnd = c;
        }
      } else {
        flush();
      }
      visit(c);
    }
    flush();
  };
  visit(tree.rootNode);
  return ranges;
}

export function iniFoldingRanges(doc: IniDocument): FoldingRange[] {
  return doc.sections
    .map((s) => ({ startLine: s.range.start.line, endLine: s.range.end.line }))
    .filter((r) => r.endLine > r.startLine);
}
