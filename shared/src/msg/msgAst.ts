import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import { childrenOfType, firstChildOfType } from '../parser/treeUtils';
import { stripCommentMarkers } from '../ned/nedAst';

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

/**
 * The banner doc comment of a MSG type. Unlike NED (where the comment is a
 * preceding sibling), the MSG grammar nests the leading `// ...` lines as the
 * first children of the type node, so gather the run of `comment` children that
 * precedes the type name and strip the markers.
 */
export function msgLeadingDocComment(node: SyntaxNode): string | undefined {
  const lines: string[] = [];
  for (const c of node.namedChildren) {
    if (!c || c.type !== 'comment') break; // the run ends at the type name/keyword
    lines.push(c.text);
  }
  return lines.length ? stripCommentMarkers(lines.join('\n')) : undefined;
}

/**
 * True if `line` (0-based) falls on a MSG type *header* — from the type name
 * through the opening `{` of its body. The MSG grammar drops a trailing comment
 * placed here, so a `suppress(...)` directive can't be a trailing comment on such a
 * line and must go on the line above instead (see the suppress-directive quick-fix).
 */
export function isMsgTypeHeaderLine(tree: Tree, line: number): boolean {
  for (const t of msgTopLevelTypes(tree)) {
    const name = msgNameNode(t);
    const startRow = name ? name.startPosition.row : t.startPosition.row;
    const body = msgBodyNode(t);
    const endRow = body ? body.startPosition.row : t.endPosition.row;
    if (line >= startRow && line <= endRow) return true;
  }
  return false;
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
    type: firstChildOfType(node, 'type')?.text?.trim(),
    value: firstChildOfType(node, 'value')?.text,
    isVector: !!firstChildOfType(node, 'vector'),
  };
}

// ---- @property support (grammar exposes property / property_key / property_value) ----

/** A `key=value` (or bare `value`) entry inside a property's parentheses. */
export interface MsgPropertyKey {
  name?: string;
  values: string[];
}

export interface MsgPropertyInfo {
  node: SyntaxNode;
  /** Property name without the leading `@` (e.g. `display`, `unit`, `enum`). */
  name: string;
  /** Optional `@prop[index]` selector. */
  index?: string;
  /** Parenthesized entries, e.g. `@enum(A=1; B=2)` -> two keys. */
  keys: MsgPropertyKey[];
  /** Legacy `enum(NAME)` tag, when present. */
  tag?: string;
}

/** Direct `@property` children of a container (a type body, or a field). */
export function msgPropertyNodes(container: SyntaxNode): SyntaxNode[] {
  return childrenOfType(container, 'property');
}

/** The `@property` declarations attached to a type (its body-level properties). */
export function msgTypeProperties(typeNode: SyntaxNode): SyntaxNode[] {
  const body = msgBodyNode(typeNode);
  return body ? msgPropertyNodes(body) : [];
}

export function msgPropertyInfo(node: SyntaxNode): MsgPropertyInfo {
  const keys: MsgPropertyKey[] = [];
  for (const key of childrenOfType(node, 'property_key')) {
    const values = childrenOfType(key, 'property_value').map((v) => v.text.trim());
    keys.push({ name: firstChildOfType(key, 'name')?.text?.trim(), values });
  }
  return {
    node,
    name: (firstChildOfType(node, 'name')?.text ?? '').trim(),
    index: firstChildOfType(node, 'index')?.text?.trim(),
    keys,
    tag: firstChildOfType(node, 'tag')?.text?.trim(),
  };
}
