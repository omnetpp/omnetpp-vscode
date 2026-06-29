import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import { Diagnostic, DiagnosticSeverity } from '../model/location';
import { nodeRange } from '../parser/treeUtils';
import {
  gateNodes,
  innerTypes,
  nameNode,
  paramInfo,
  paramNodes,
  submoduleNodes,
  topLevelTypes,
} from './nedAst';

function dup(node: SyntaxNode, what: string, name: string): Diagnostic {
  return {
    range: nodeRange(node),
    severity: DiagnosticSeverity.Error,
    message: `Duplicate ${what} '${name}'`,
    source: 'omnetpp',
    code: 'duplicate',
  };
}

function checkType(typeNode: SyntaxNode, out: Diagnostic[]): void {
  // duplicate parameters
  const seenParams = new Set<string>();
  for (const p of paramNodes(typeNode)) {
    const info = paramInfo(p);
    if (!info.name || info.isPattern) continue;
    const nn = nameNode(p);
    if (seenParams.has(info.name)) out.push(dup(nn ?? p, 'parameter', info.name));
    else seenParams.add(info.name);
  }
  // duplicate gates
  const seenGates = new Set<string>();
  for (const g of gateNodes(typeNode)) {
    const nn = nameNode(g);
    const name = nn?.text;
    if (!name) continue;
    if (seenGates.has(name)) out.push(dup(nn, 'gate', name));
    else seenGates.add(name);
  }
  // duplicate submodules
  const seenSubs = new Set<string>();
  for (const s of submoduleNodes(typeNode)) {
    const nn = nameNode(s);
    const name = nn?.text;
    if (!name) continue;
    if (seenSubs.has(name)) out.push(dup(nn, 'submodule', name));
    else seenSubs.add(name);
  }
  // recurse into inner types
  for (const inner of innerTypes(typeNode)) checkType(inner, out);
}

/**
 * Local (single-file, no cross-file resolution) NED checks: duplicate type names
 * and duplicate parameter/gate/submodule names within a type.
 */
export function nedLocalDiagnostics(tree: Tree): Diagnostic[] {
  const out: Diagnostic[] = [];
  const types = topLevelTypes(tree);
  const seenTypes = new Set<string>();
  for (const t of types) {
    const nn = nameNode(t);
    const name = nn?.text;
    if (name) {
      if (seenTypes.has(name)) out.push(dup(nn!, 'type', name));
      else seenTypes.add(name);
    }
    checkType(t, out);
  }
  return out;
}
