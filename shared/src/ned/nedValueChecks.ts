import type { Tree, SyntaxNode } from 'web-tree-sitter';
import { Diagnostic, DiagnosticSeverity } from '../model/location';
import { nodeRange, firstChildOfType } from '../parser/treeUtils';
import { paramNodes, topLevelTypes, innerTypes, paramInfo } from './nedAst';
import { parseExpression } from '../expr/exprParser';
import { inferType, isTypeMismatch } from '../expr/infer';

function checkType(typeNode: SyntaxNode, out: Diagnostic[]): void {
  for (const p of paramNodes(typeNode)) {
    const info = paramInfo(p);
    if (!info.type || info.isPattern) continue; // only typed declarations with values
    const valueNode = firstChildOfType(p, 'value');
    if (!valueNode) continue;
    const text = valueNode.text.trim();
    if (text === 'default' || text === 'ask' || text === '') continue;
    const expr = parseExpression(text);
    const { type: vt } = inferType(expr);
    if (isTypeMismatch(info.type, vt)) {
      out.push({
        range: nodeRange(valueNode),
        severity: DiagnosticSeverity.Error,
        message: `Cannot assign ${vt} value to '${info.type}' parameter '${info.name ?? ''}'`,
        source: 'omnetpp',
        code: 'type-mismatch',
      });
    }
  }
  for (const inner of innerTypes(typeNode)) checkType(inner, out);
}

/** Value-level NED diagnostics: parameter default value type checking. */
export function nedValueDiagnostics(tree: Tree): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const t of topLevelTypes(tree)) checkType(t, out);
  return out;
}
