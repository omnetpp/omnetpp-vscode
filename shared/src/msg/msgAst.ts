import type { SyntaxNode, Tree } from 'web-tree-sitter';
import { childrenOfType, firstChildOfType } from '../parser/treeUtils';

/** MSG type definitions (with a body). */
export const MSG_TYPE_NODES = ['class', 'struct', 'message', 'packet', 'enum'] as const;
/** Forward declarations. */
export const MSG_DECL_NODES = [
  'class_decl',
  'struct_decl',
  'message_decl',
  'packet_decl',
  'enum_decl',
] as const;

export type MsgTypeKind = 'class' | 'struct' | 'message' | 'packet' | 'enum';

export function isMsgTypeNode(node: SyntaxNode): boolean {
  return (MSG_TYPE_NODES as readonly string[]).includes(node.type);
}

export function isMsgDeclNode(node: SyntaxNode): boolean {
  return (MSG_DECL_NODES as readonly string[]).includes(node.type);
}

export function msgNameNode(node: SyntaxNode): SyntaxNode | null {
  return firstChildOfType(node, 'name');
}

export function msgExtendsNode(node: SyntaxNode): SyntaxNode | null {
  return firstChildOfType(node, 'extends');
}

export function msgBodyNode(node: SyntaxNode): SyntaxNode | null {
  return firstChildOfType(node, 'body');
}

export function msgTopLevelTypes(tree: Tree): SyntaxNode[] {
  const root = tree.rootNode;
  const out: SyntaxNode[] = [];
  for (let i = 0; i < root.namedChildCount; i++) {
    const c = root.namedChild(i)!;
    if (isMsgTypeNode(c)) out.push(c);
  }
  return out;
}

export function msgImportNodes(tree: Tree): SyntaxNode[] {
  return childrenOfType(tree.rootNode, 'import');
}

export function msgNamespaceNode(tree: Tree): SyntaxNode | null {
  return firstChildOfType(tree.rootNode, 'namespace');
}

export function msgFieldNodes(typeNode: SyntaxNode): SyntaxNode[] {
  const body = msgBodyNode(typeNode);
  return body ? childrenOfType(body, 'field') : [];
}

export interface MsgFieldInfo {
  node: SyntaxNode;
  name?: string;
  type?: string;
  value?: string;
  isVector: boolean;
}

export function msgFieldInfo(node: SyntaxNode): MsgFieldInfo {
  return {
    node,
    name: firstChildOfType(node, 'name')?.text,
    type: firstChildOfType(node, 'type')?.text,
    value: firstChildOfType(node, 'value')?.text,
    isVector: !!firstChildOfType(node, 'vector'),
  };
}
