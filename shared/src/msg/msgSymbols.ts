import type { SyntaxNode, Tree } from 'web-tree-sitter';
import { DocumentSymbol, SymbolKind } from '../model/symbols';
import { nodeRange } from '../parser/treeUtils';
import { childrenOfType } from '../parser/treeUtils';
import {
  MsgTypeKind,
  msgBodyNode,
  msgFieldInfo,
  msgFieldNodes,
  msgNameNode,
  msgTopLevelTypes,
} from './msgAst';

function kindOf(node: SyntaxNode): { kind: SymbolKind; detail: string } {
  switch (node.type as MsgTypeKind) {
    case 'class':
      return { kind: SymbolKind.Class, detail: 'class' };
    case 'struct':
      return { kind: SymbolKind.Struct, detail: 'struct' };
    case 'message':
      return { kind: SymbolKind.Class, detail: 'message' };
    case 'packet':
      return { kind: SymbolKind.Class, detail: 'packet' };
    case 'enum':
      return { kind: SymbolKind.Enum, detail: 'enum' };
    default:
      return { kind: SymbolKind.Class, detail: node.type };
  }
}

function typeSymbol(node: SyntaxNode): DocumentSymbol {
  const { kind, detail } = kindOf(node);
  const nameNode = msgNameNode(node);
  const children: DocumentSymbol[] = [];

  if (node.type === 'enum') {
    const body = msgBodyNode(node);
    if (body) {
      for (const f of childrenOfType(body, 'field')) {
        const nameNode = nameOf(f);
        children.push({
          name: nameNode?.text ?? f.text,
          kind: SymbolKind.EnumMember,
          range: nodeRange(f),
          selectionRange: nodeRange(nameNode ?? f),
        });
      }
    }
  } else {
    for (const f of msgFieldNodes(node)) {
      const info = msgFieldInfo(f);
      children.push({
        name: (info.name ?? '?') + (info.isVector ? '[]' : ''),
        detail: info.type,
        kind: SymbolKind.Field,
        range: nodeRange(f),
        selectionRange: nodeRange(nameOf(f) ?? f),
      });
    }
  }

  return {
    name: nameNode?.text ?? '<anonymous>',
    detail,
    kind,
    range: nodeRange(node),
    selectionRange: nodeRange(nameNode ?? node),
    children,
  };
}

function nameOf(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    if (node.namedChild(i)!.type === 'name') return node.namedChild(i);
  }
  return null;
}

export function msgDocumentSymbols(tree: Tree): DocumentSymbol[] {
  return msgTopLevelTypes(tree).map(typeSymbol);
}
