import type { Tree, SyntaxNode } from 'web-tree-sitter';
import { Diagnostic, DiagnosticSeverity } from '../model/location';
import { collectSyntaxErrors, nodeRange } from '../parser/treeUtils';

function describe(node: SyntaxNode): string {
  if (node.isMissing()) {
    // tree-sitter names missing nodes like: MISSING ";"
    return `Syntax error: missing ${node.type}`;
  }
  return 'Syntax error: unexpected input';
}

/** Produce diagnostics for ERROR / MISSING nodes in a tree-sitter parse tree. */
export function syntaxDiagnostics(tree: Tree): Diagnostic[] {
  return collectSyntaxErrors(tree).map((node) => ({
    range: nodeRange(node),
    severity: DiagnosticSeverity.Error,
    message: describe(node),
    source: 'omnetpp',
    code: 'syntax',
  }));
}
