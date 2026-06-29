import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import { childrenOfType, firstChildOfType, childByField } from '../parser/treeUtils';

/** tree-sitter node types for the six NED type definitions. */
export const NED_TYPE_NODES = [
  'simple',
  'module',
  'network',
  'channel',
  'channel_interface',
  'moduleinterface',
] as const;

export type NedTypeKind =
  | 'simple'
  | 'compound'
  | 'network'
  | 'channel'
  | 'channelinterface'
  | 'moduleinterface';

export function isTypeNode(node: SyntaxNode): boolean {
  return (NED_TYPE_NODES as readonly string[]).includes(node.type);
}

export function typeKind(node: SyntaxNode): NedTypeKind {
  switch (node.type) {
    case 'simple':
      return 'simple';
    case 'module':
      return 'compound';
    case 'network':
      return 'network';
    case 'channel':
      return 'channel';
    case 'channel_interface':
      return 'channelinterface';
    case 'moduleinterface':
      return 'moduleinterface';
    default:
      throw new Error(`not a NED type node: ${node.type}`);
  }
}

/** The `name` child node of a type/param/gate/submodule, or null. */
export function nameNode(node: SyntaxNode): SyntaxNode | null {
  return firstChildOfType(node, 'name');
}

export function nameText(node: SyntaxNode): string | undefined {
  return nameNode(node)?.text;
}

export function extendsNodes(node: SyntaxNode): SyntaxNode[] {
  return childrenOfType(node, 'extends');
}

export function implementsNodes(node: SyntaxNode): SyntaxNode[] {
  return childrenOfType(node, 'implements');
}

export function sectionNode(typeNode: SyntaxNode, section: string): SyntaxNode | null {
  return firstChildOfType(typeNode, section);
}

/** All top-level NED type definitions in a file. */
export function topLevelTypes(tree: Tree): SyntaxNode[] {
  const root = tree.rootNode;
  const out: SyntaxNode[] = [];
  for (let i = 0; i < root.namedChildCount; i++) {
    const c = root.namedChild(i)!;
    if (isTypeNode(c)) out.push(c);
  }
  return out;
}

/** Inner types declared in a compound module's `types:` section. */
export function innerTypes(typeNode: SyntaxNode): SyntaxNode[] {
  const types = sectionNode(typeNode, 'types');
  if (!types) return [];
  const out: SyntaxNode[] = [];
  for (let i = 0; i < types.namedChildCount; i++) {
    const c = types.namedChild(i)!;
    if (isTypeNode(c)) out.push(c);
  }
  return out;
}

export function packageNode(tree: Tree): SyntaxNode | null {
  return firstChildOfType(tree.rootNode, 'package');
}

export function importNodes(tree: Tree): SyntaxNode[] {
  return childrenOfType(tree.rootNode, 'import');
}

/** The declared package name of a file ('' if none). */
export function filePackage(tree: Tree): string {
  const pkg = packageNode(tree);
  return pkg ? nameNode(pkg)?.text ?? '' : '';
}

/** The import specs of a file. */
export function fileImports(tree: Tree): string[] {
  return importNodes(tree)
    .map((imp) => nameNode(imp)?.text)
    .filter((s): s is string => !!s);
}

/** Parameters declared directly in a type's `parameters:` section. */
export function paramNodes(typeNode: SyntaxNode): SyntaxNode[] {
  const params = sectionNode(typeNode, 'parameters');
  return params ? childrenOfType(params, 'parameter') : [];
}

/** Property assignments (e.g. @display) in a type's parameters section. */
export function propertyNodes(typeNode: SyntaxNode): SyntaxNode[] {
  const params = sectionNode(typeNode, 'parameters');
  return params ? childrenOfType(params, 'property') : [];
}

export function gateNodes(typeNode: SyntaxNode): SyntaxNode[] {
  const gates = sectionNode(typeNode, 'gates');
  return gates ? childrenOfType(gates, 'gate') : [];
}

export function submoduleNodes(typeNode: SyntaxNode): SyntaxNode[] {
  const subs = sectionNode(typeNode, 'submodules');
  return subs ? childrenOfType(subs, 'submodule') : [];
}

export interface ParamInfo {
  node: SyntaxNode;
  name?: string;
  type?: string;
  value?: string;
  isPattern: boolean;
  volatile: boolean;
  /** Measurement unit from a `@unit(...)` property, if any. */
  unit?: string;
  /** Allowed values from an `@enum(...)` property, if any. */
  enumValues?: string[];
}

/** Extract the `@unit(...)` value from a parameter declaration's text. */
function paramUnit(text: string): string | undefined {
  const m = /@unit\s*\(\s*([^)]*?)\s*\)/.exec(text);
  return m ? m[1].replace(/^["']|["']$/g, '').trim() || undefined : undefined;
}

/** Extract the `@enum(...)` members from a parameter declaration's text. */
function paramEnum(text: string): string[] | undefined {
  const m = /@enum\s*\(\s*([^)]*?)\s*\)/.exec(text);
  if (!m) return undefined;
  const vals = m[1].split(',').map((s) => s.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
  return vals.length ? vals : undefined;
}

export function paramInfo(node: SyntaxNode): ParamInfo {
  const pattern = firstChildOfType(node, 'pattern');
  return {
    node,
    name: nameText(node),
    type: firstChildOfType(node, 'type')?.text,
    value: firstChildOfType(node, 'value')?.text,
    isPattern: !!pattern,
    volatile: /\bvolatile\b/.test(node.text.split('=')[0] ?? ''),
    unit: paramUnit(node.text),
    enumValues: paramEnum(node.text),
  };
}

export interface GateInfo {
  node: SyntaxNode;
  name?: string;
  type?: string; // input | output | inout
  isVector: boolean;
}

export function gateInfo(node: SyntaxNode): GateInfo {
  // the gate direction is exposed via the `direction` field (input|output|inout)
  return {
    node,
    name: nameText(node),
    type: (childByField(node, 'direction') ?? firstChildOfType(node, 'type'))?.text,
    isVector: !!firstChildOfType(node, 'vector'),
  };
}

export interface SubmoduleInfo {
  node: SyntaxNode;
  name?: string;
  type?: string; // concrete type (when not 'like')
  likeType?: string; // interface name (when 'like')
  isVector: boolean;
  isLike: boolean;
}

export function submoduleInfo(node: SyntaxNode): SubmoduleInfo {
  const likeType = firstChildOfType(node, 'like_type');
  return {
    node,
    name: nameText(node),
    type: firstChildOfType(node, 'type')?.text,
    likeType: likeType?.text,
    isVector: !!firstChildOfType(node, 'vector'),
    isLike: !!likeType,
  };
}

/**
 * The doc comment immediately preceding a node (banner comment), if any.
 * Returns the comment text with leading // markers stripped.
 */
export function leadingDocComment(node: SyntaxNode): string | undefined {
  // The grammar emits one `comment` node per `//` line, so a multi-line banner
  // is a run of consecutive `comment` siblings. Walk backward over that run,
  // stopping at a non-contiguous gap or a trailing comment that shares its line
  // with a preceding statement (e.g. `package foo; // not a banner`).
  const lines: SyntaxNode[] = [];
  let cur: SyntaxNode | null = node.previousNamedSibling;
  while (
    cur &&
    cur.type === 'comment' &&
    (lines.length === 0 || cur.startPosition.row === lines[lines.length - 1].startPosition.row - 1)
  ) {
    const before = cur.previousNamedSibling;
    if (before && before.type !== 'comment' && before.endPosition.row === cur.startPosition.row) break;
    lines.push(cur);
    cur = cur.previousNamedSibling;
  }
  if (lines.length === 0) return undefined;
  lines.reverse();
  return stripCommentMarkers(lines.map((l) => l.text).join('\n'));
}

export function stripCommentMarkers(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\/\/+\s?/, ''))
    .join('\n')
    .trim();
}
