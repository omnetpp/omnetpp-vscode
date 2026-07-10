import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import type { TextEdit } from '../model/location';
import { NedResourceCache, NedFileInfo, importToRegex } from './nedResourceCache';
import { importNodes, packageNode } from './nedAst';
import { isTypeRefNode, enclosingContextFor } from './nedNavigation';

/**
 * Compute the edits to organize a NED file's imports: add imports for unqualified
 * cross-package type references, drop unused explicit imports, keep wildcards, and
 * sort. Returns [] when nothing changes.
 *
 * Ported from: ui/org.omnetpp.ned.core/src/org/omnetpp/ned/core/refactoring/RefactoringTools.java
 * (`organizeImports`, `resolveImport`): same algorithm shape — walk unqualified
 * type references, resolve each against local/toplevel candidates, keep existing
 * wildcard imports, and drop unused explicit ones.
 */
export function organizeImports(cache: NedResourceCache, file: NedFileInfo, tree: Tree): TextEdit[] {
  // 1. collect fq-names needed by unqualified references in this file
  const needed = new Set<string>();
  const stack: SyntaxNode[] = [tree.rootNode];
  while (stack.length) {
    const n = stack.pop()!;
    if (isTypeRefNode(n) && n.parent?.type !== 'import' && !n.text.includes('.') && !n.text.includes('*')) {
      let resolved = cache.lookupType(n.text, file, enclosingContextFor(cache, n, file.uri));
      // not importable yet (no import present): find the unique top-level type by name
      if (!resolved) resolved = uniqueBySimpleName(cache, n.text);
      if (
        resolved &&
        !resolved.isInnerType &&
        resolved.packageName !== '' &&
        resolved.packageName !== file.packageName
      ) {
        needed.add(resolved.fqName);
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i)!);
  }

  // 2. keep existing wildcard imports; add needed ones not covered by a wildcard
  const existing = file.imports;
  const wildcards = existing.filter((s) => s.includes('*'));
  const explicit = [...needed].filter((fq) => !wildcards.some((w) => importToRegex(w).test(fq)));
  const finalImports = [...new Set([...wildcards, ...explicit])].sort();

  // 3. nothing changed? (same imports in the same order)
  if (existing.length === finalImports.length && existing.every((v, i) => v === finalImports[i])) {
    return [];
  }

  const block = finalImports.map((s) => `import ${s};`).join('\n');

  const imports = importNodes(tree);
  if (imports.length > 0) {
    const start = imports[0].startPosition;
    const end = imports[imports.length - 1].endPosition;
    if (finalImports.length === 0) {
      // remove the whole block (and its line)
      return [{ range: { start: { line: start.row, character: 0 }, end: { line: end.row, character: end.column } }, newText: '' }];
    }
    return [
      {
        range: {
          start: { line: start.row, character: start.column },
          end: { line: end.row, character: end.column },
        },
        newText: block,
      },
    ];
  }

  return insertNew(tree, finalImports, block);
}

/** The unique top-level type with the given simple name, or undefined if 0 or >1. */
function uniqueBySimpleName(cache: NedResourceCache, name: string) {
  let found;
  for (const t of cache.allTypes()) {
    if (t.simpleName === name && !t.isInnerType) {
      if (found) return undefined; // ambiguous
      found = t;
    }
  }
  return found;
}

function insertNew(tree: Tree, finalImports: string[], block: string): TextEdit[] {
  if (finalImports.length === 0) return [];
  // no existing imports: insert after the package declaration, else at file top
  const pkg = packageNode(tree);
  const anchorRow = pkg ? pkg.endPosition.row : -1;
  return [
    {
      range: {
        start: { line: anchorRow + 1, character: 0 },
        end: { line: anchorRow + 1, character: 0 },
      },
      newText: block + '\n',
    },
  ];
}
