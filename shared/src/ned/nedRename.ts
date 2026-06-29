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

/** Build the edit set that renames `target` (declaration + all references). */
function buildTypeRenameEdits(
  cache: NedResourceCache,
  target: NedTypeInfo,
  newName: string,
): WorkspaceEdit {
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

  return buildTypeRenameEdits(cache, target, newName);
}

/**
 * Rename a NED type identified by its fully-qualified name (no cursor position
 * needed), producing edits for the declaration and every reference project-wide.
 * Intended for programmatic callers (e.g. the MCP tool layer).
 */
export function nedRenameType(
  cache: NedResourceCache,
  fqName: string,
  newName: string,
): WorkspaceEdit | null {
  const target = cache.getType(fqName);
  if (!target) return null;
  return buildTypeRenameEdits(cache, target, newName);
}

/**
 * Rename a member (param/gate/submodule) of a type identified by its
 * fully-qualified name, across the whole project. `kind` may be omitted to
 * auto-detect from the type's members (param → gate → submodule precedence).
 */
export function nedRenameMember(
  cache: NedResourceCache,
  typeFqName: string,
  memberName: string,
  newName: string,
  kind?: 'param' | 'gate' | 'submodule',
): WorkspaceEdit | null {
  const type = cache.getType(typeFqName);
  if (!type) return null;

  const detectKind = (): 'param' | 'gate' | 'submodule' | undefined => {
    if (type.findParam(memberName)) return 'param';
    if (type.findGate(memberName)) return 'gate';
    if (type.getSubmodule(memberName)) return 'submodule';
    return undefined;
  };
  const memberKind = kind ?? detectKind();
  if (!memberKind) return null;

  // The canonical owner is the most-base type that locally declares the member.
  const has = (t: NedTypeInfo) =>
    memberKind === 'param' ? t.localParams().has(memberName)
    : memberKind === 'gate' ? t.localGates().has(memberName)
    : t.localSubmodules().has(memberName);
  let owner: NedTypeInfo | undefined;
  for (const t of [type, ...type.ancestors()]) if (has(t)) owner = t; // keep most-base
  if (!owner) return null;

  const changes: Record<string, TextEdit[]> = {};
  for (const loc of memberReferences(cache, { kind: memberKind, ownerFq: owner.fqName, name: memberName })) {
    (changes[loc.uri] ??= []).push({ range: loc.range, newText: newName });
  }
  return { changes };
}
