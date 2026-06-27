import type { SyntaxNode } from 'web-tree-sitter';
import type { Tree } from 'web-tree-sitter';
import type { Position, Range, TextEdit, WorkspaceEdit } from '../model/location';
import { nodeRange } from '../parser/treeUtils';
import { NedResourceCache, NedFileInfo } from './nedResourceCache';
import { NedTypeInfo } from './nedTypeInfo';
import { referenceAt, isTypeRefNode, enclosingContextFor, memberRefAt, memberReferences } from './nedNavigation';
import { nameNode } from './nedAst';

/** Range of the last dotted segment of a (possibly qualified) name node. */
function lastSegmentRange(node: SyntaxNode): Range {
  const text = node.text;
  const dot = text.lastIndexOf('.');
  const segLen = dot < 0 ? text.length : text.length - (dot + 1);
  const end = node.endPosition;
  return {
    start: { line: end.row, character: end.column - segLen },
    end: { line: end.row, character: end.column },
  };
}

/** The renameable target (a NED type) at a position, with the editable range. */
export function nedPrepareRename(
  cache: NedResourceCache,
  file: NedFileInfo,
  tree: Tree,
  pos: Position,
): { range: Range; placeholder: string } | null {
  const ref = referenceAt(cache, file, tree, pos);
  if (!ref) return null;
  if (ref.kind === 'typedef') {
    return { range: nodeRange(ref.nameNode), placeholder: ref.info.simpleName };
  }
  if (ref.kind === 'typeref' && ref.target) {
    return { range: lastSegmentRange(ref.refNode), placeholder: ref.target.simpleName };
  }
  return null;
}

/** The renameable member (param/gate/submodule) at a position, if any. */
export function nedPrepareMemberRename(
  cache: NedResourceCache,
  file: NedFileInfo,
  tree: Tree,
  pos: Position,
): { range: Range; placeholder: string } | null {
  const m = memberRefAt(cache, file, tree, pos);
  return m ? { range: m.range, placeholder: m.key.name } : null;
}

/** Rename a NED type and all its references across the project. */
export function nedRename(
  cache: NedResourceCache,
  file: NedFileInfo,
  tree: Tree,
  pos: Position,
  newName: string,
): WorkspaceEdit | null {
  const ref = referenceAt(cache, file, tree, pos);
  const target: NedTypeInfo | undefined = ref ? (ref.kind === 'typeref' ? ref.target : ref.info) : undefined;
  if (!target) {
    // member (param/gate/submodule) rename
    const m = memberRefAt(cache, file, tree, pos);
    if (!m) return null;
    const changes: Record<string, TextEdit[]> = {};
    for (const loc of memberReferences(cache, m.key)) {
      (changes[loc.uri] ??= []).push({ range: loc.range, newText: newName });
    }
    return { changes };
  }

  const changes: Record<string, TextEdit[]> = {};
  const add = (uri: string, edit: TextEdit) => {
    (changes[uri] ??= []).push(edit);
  };

  // declaration
  const declName = nameNode(target.node);
  if (declName) add(target.file.uri, { range: nodeRange(declName), newText: newName });

  // references across all files
  for (const f of cache.allFiles()) {
    const stack: SyntaxNode[] = [f.tree.rootNode];
    while (stack.length) {
      const n = stack.pop()!;
      if (isTypeRefNode(n) && n.text.split('.').pop() === target.simpleName) {
        const enclosing = enclosingContextFor(cache, n, f.uri);
        const resolved = cache.lookupType(n.text, f, enclosing);
        if (resolved && resolved.fqName === target.fqName) {
          add(f.uri, { range: lastSegmentRange(n), newText: newName });
        }
      }
      for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i)!);
    }
  }
  return { changes };
}
