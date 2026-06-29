import type { Node as SyntaxNode, Tree, Point } from 'web-tree-sitter';
import type { Position, Range } from '../model/location';

export function pointToPosition(p: Point): Position {
  return { line: p.row, character: p.column };
}

export function nodeRange(node: SyntaxNode): Range {
  return {
    start: pointToPosition(node.startPosition),
    end: pointToPosition(node.endPosition),
  };
}

export function positionToPoint(pos: Position): Point {
  return { row: pos.line, column: pos.character };
}

/** The smallest named node containing the given position. */
export function namedDescendantAt(tree: Tree, pos: Position): SyntaxNode {
  const p = positionToPoint(pos);
  // the root node contains every in-range position, so this is never null in practice
  return tree.rootNode.namedDescendantForPosition(p)!;
}

/** The smallest node (named or anonymous) containing the given position. */
export function descendantAt(tree: Tree, pos: Position): SyntaxNode {
  const p = positionToPoint(pos);
  return tree.rootNode.descendantForPosition(p)!;
}

/** All direct named children of a given type. */
export function childrenOfType(node: SyntaxNode, type: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)!;
    if (c.type === type) out.push(c);
  }
  return out;
}

export function firstChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)!;
    if (c.type === type) return c;
  }
  return null;
}

/** The child reached via a grammar `field()` name, if present. */
export function childByField(node: SyntaxNode, field: string): SyntaxNode | null {
  return node.childForFieldName(field);
}

/** All children reached via a grammar `field()` name. */
export function childrenByField(node: SyntaxNode, field: string): SyntaxNode[] {
  return node.childrenForFieldName(field).filter((c): c is SyntaxNode => c != null);
}

/** Depth-first walk over all named descendants (inclusive of node). */
export function* walk(node: SyntaxNode): Generator<SyntaxNode> {
  yield node;
  for (let i = 0; i < node.namedChildCount; i++) {
    yield* walk(node.namedChild(i)!);
  }
}

/** Find the nearest ancestor (inclusive) whose type is in `types`. */
export function ancestorOfType(node: SyntaxNode | null, types: string[]): SyntaxNode | null {
  let cur: SyntaxNode | null = node;
  while (cur) {
    if (types.includes(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

/** Collect ERROR and MISSING nodes for syntax diagnostics. */
export function collectSyntaxErrors(tree: Tree): SyntaxNode[] {
  const errors: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [tree.rootNode];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'ERROR' || n.isMissing) {
      errors.push(n);
      // do not descend into ERROR subtrees to avoid noise
      if (n.type === 'ERROR') continue;
    }
    for (let i = 0; i < n.childCount; i++) stack.push(n.child(i)!);
  }
  return errors;
}
