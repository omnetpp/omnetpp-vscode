import type { Tree, Node as SyntaxNode } from 'web-tree-sitter';
import { Diagnostic, DiagnosticSeverity } from '../model/location';
import { nodeRange, childrenOfType, firstChildOfType } from '../parser/treeUtils';
import { MsgResourceCache, coreTypeName } from './msgResourceCache';
import {
  msgBodyNode,
  msgExtendsNode,
  msgFieldNodes,
  msgNameNode,
  msgNamespaceNode,
  msgTopLevelTypes,
} from './msgAst';

/** Names introduced by cplusplus blocks (heuristic: class/struct/typedef). */
function cplusplusNames(tree: Tree): Set<string> {
  const names = new Set<string>();
  for (const cpp of childrenOfType(tree.rootNode, 'cplusplus')) {
    const body = firstChildOfType(cpp, 'body')?.text ?? '';
    // class/struct/enum (incl. `enum class`) declarations
    for (const m of body.matchAll(/\b(?:class|struct|enum)(?:\s+class)?\s+([A-Za-z_]\w*)/g)) names.add(m[1]);
    // `using Alias = ...`
    for (const m of body.matchAll(/\busing\s+([A-Za-z_]\w*)\s*=/g)) names.add(m[1]);
    // brace-less `typedef <type> Name;` (the [^;{}] stops before inner ; or {)
    for (const m of body.matchAll(/\btypedef\s+[^;{}]*?\b([A-Za-z_]\w*)\s*;/g)) names.add(m[1]);
    // `typedef struct/enum { ... } Name;` (capture the name after the closing brace)
    for (const m of body.matchAll(/\}\s*([A-Za-z_]\w*)\s*;/g)) names.add(m[1]);
  }
  return names;
}

/**
 * Local MSG diagnostics: duplicate type names and duplicate field names.
 *
 * The duplicate-field check corresponds to `MsgAnalyzer`'s `findField()`/"Field
 * '%s' already exists" check (src/nedxml/msganalyzer.cc, in `extractFields()`,
 * ~line 176); the rest of this file's checks are not ports.
 */
export function msgLocalDiagnostics(tree: Tree): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seenTypes = new Set<string>();
  for (const t of msgTopLevelTypes(tree)) {
    const nn = msgNameNode(t);
    const name = nn?.text;
    if (name) {
      if (seenTypes.has(name)) {
        out.push(diag(nn!, `Duplicate type '${name}'`, 'duplicate', DiagnosticSeverity.Error));
      } else seenTypes.add(name);
    }
    const body = msgBodyNode(t);
    if (body) {
      const seenFields = new Set<string>();
      for (const f of msgFieldNodes(t)) {
        const fn = firstChildOfType(f, 'name');
        const fname = fn?.text;
        if (!fname) continue;
        if (seenFields.has(fname)) {
          out.push(diag(fn!, `Duplicate field '${fname}'`, 'duplicate', DiagnosticSeverity.Error));
        } else seenFields.add(fname);
      }
    }
  }
  return out;
}

/**
 * Unknown-type diagnostics (warnings) for MSG field/base types. Conservative:
 * only flags unqualified (non-`::`) names that are not primitives, declared MSG
 * types, builtin sim types, forward declarations, or cplusplus-introduced names.
 *
 * Parallels the unresolved-`typeQName` check in `MsgAnalyzer::analyzeField()`
 * (src/nedxml/msganalyzer.cc, ~line 429-433: `lookupExistingClassName()` returns
 * empty -> "unknown type '%s' for field '%s'..."); this port narrows the check to
 * unqualified names and widens it with a warning severity instead of an error.
 */
export function msgSemanticDiagnostics(cache: MsgResourceCache, uri: string): Diagnostic[] {
  const file = cache.getFile(uri);
  if (!file) return [];
  const tree = file.tree;
  const ns = file.namespace;
  void msgNamespaceNode;

  const known = new Set<string>([
    ...cache.collectForwardDecls(tree),
    ...cplusplusNames(tree),
  ]);

  const isKnown = (core: string): boolean => {
    if (!core || core.includes('::')) return true; // qualified: assume C++
    if (known.has(core)) return true;
    return cache.isKnownType(core, ns);
  };

  const out: Diagnostic[] = [];
  for (const t of msgTopLevelTypes(tree)) {
    // base type
    const ext = msgExtendsNode(t);
    if (ext && !isKnown(coreTypeName(ext.text))) {
      out.push(diag(ext, `Unknown type '${ext.text}'`, 'unknown-type', DiagnosticSeverity.Warning));
    }
    // field types
    for (const f of msgFieldNodes(t)) {
      const typeNode = firstChildOfType(f, 'type');
      if (!typeNode) continue;
      const core = coreTypeName(typeNode.text);
      if (!isKnown(core)) {
        out.push(
          diag(typeNode, `Unknown type '${typeNode.text.trim()}'`, 'unknown-type', DiagnosticSeverity.Warning),
        );
      }
    }
  }
  return out;
}

function diag(node: SyntaxNode, message: string, code: string, severity: DiagnosticSeverity): Diagnostic {
  return { range: nodeRange(node), severity, message, source: 'omnetpp', code };
}
