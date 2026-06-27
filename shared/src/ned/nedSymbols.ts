import type { SyntaxNode, Tree } from 'web-tree-sitter';
import { DocumentSymbol, SymbolKind } from '../model/symbols';
import { nodeRange } from '../parser/treeUtils';
import {
  NedTypeKind,
  gateInfo,
  gateNodes,
  innerTypes,
  isTypeNode,
  nameNode,
  paramInfo,
  paramNodes,
  submoduleInfo,
  submoduleNodes,
  topLevelTypes,
  typeKind,
} from './nedAst';

function typeSymbolKind(kind: NedTypeKind): SymbolKind {
  switch (kind) {
    case 'simple':
      return SymbolKind.Class;
    case 'compound':
    case 'network':
      return SymbolKind.Module;
    case 'channel':
      return SymbolKind.Class;
    case 'channelinterface':
    case 'moduleinterface':
      return SymbolKind.Interface;
  }
}

function typeDetail(kind: NedTypeKind): string {
  switch (kind) {
    case 'simple':
      return 'simple module';
    case 'compound':
      return 'compound module';
    case 'network':
      return 'network';
    case 'channel':
      return 'channel';
    case 'channelinterface':
      return 'channel interface';
    case 'moduleinterface':
      return 'module interface';
  }
}

function selRange(typeNode: SyntaxNode) {
  const n = nameNode(typeNode);
  return n ? nodeRange(n) : nodeRange(typeNode);
}

function typeSymbol(typeNode: SyntaxNode): DocumentSymbol {
  const kind = typeKind(typeNode);
  const name = nameNode(typeNode)?.text ?? '<anonymous>';
  const children: DocumentSymbol[] = [];

  for (const p of paramNodes(typeNode)) {
    const info = paramInfo(p);
    if (!info.name && info.isPattern) continue; // pattern assignment, not a declaration
    children.push({
      name: info.name ?? p.text.slice(0, 24),
      detail: info.type,
      kind: SymbolKind.Property,
      range: nodeRange(p),
      selectionRange: nameNode(p) ? nodeRange(nameNode(p)!) : nodeRange(p),
    });
  }

  for (const g of gateNodes(typeNode)) {
    const info = gateInfo(g);
    children.push({
      name: (info.name ?? '?') + (info.isVector ? '[]' : ''),
      detail: info.type,
      kind: SymbolKind.Field,
      range: nodeRange(g),
      selectionRange: nameNode(g) ? nodeRange(nameNode(g)!) : nodeRange(g),
    });
  }

  for (const s of submoduleNodes(typeNode)) {
    const info = submoduleInfo(s);
    children.push({
      name: (info.name ?? '?') + (info.isVector ? '[]' : ''),
      detail: info.isLike ? `<> like ${info.likeType}` : info.type,
      kind: SymbolKind.Variable,
      range: nodeRange(s),
      selectionRange: nameNode(s) ? nodeRange(nameNode(s)!) : nodeRange(s),
    });
  }

  for (const inner of innerTypes(typeNode)) {
    children.push(typeSymbol(inner));
  }

  return {
    name,
    detail: typeDetail(kind),
    kind: typeSymbolKind(kind),
    range: nodeRange(typeNode),
    selectionRange: selRange(typeNode),
    children,
  };
}

export function nedDocumentSymbols(tree: Tree): DocumentSymbol[] {
  return topLevelTypes(tree).map(typeSymbol);
}
