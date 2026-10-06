/**
 * Ported from: ui/org.omnetpp.ned.core/src/org/omnetpp/ned/core/refactoring/RefactoringTools.java
 * (`renameNedType`, `renameSubmodule`, `renameGate`, `renameParam`, and the
 * `computeAffectedTypes*` helpers): same operation set (type/submodule/gate/param
 * rename with project-wide reference updates), same rule that the most-base
 * declaring type is the canonical owner of a renameable member.
 */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Tree } from 'web-tree-sitter';
import type { Position, Range, TextEdit, WorkspaceEdit } from '../model/location';
import { nodeRange } from '../parser/treeUtils';
import { NedResourceCache, NedFileInfo } from './nedResourceCache';
import { NedTypeInfo } from './nedTypeInfo';
import {
  referenceAt,
  isTypeRefNode,
  enclosingContextFor,
  memberRefAt,
  memberReferences,
  nedTypeTargetAt,
  typeStringAt,
  typeStringReferences,
} from './nedNavigation';
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
  if (ref?.kind === 'typedef') {
    return { range: nodeRange(ref.nameNode), placeholder: ref.info.simpleName };
  }
  if (ref?.kind === 'typeref' && ref.target) {
    return { range: lastSegmentRange(ref.refNode), placeholder: ref.target.simpleName };
  }
  if (ref) return null;
  const hit = nedTypeTargetAt(cache, file, tree, pos);
  return hit ? { range: trailingRange(hit.range, hit.target.simpleName), placeholder: hit.target.simpleName } : null;
}

/** The trailing `name`-long part of a single-line range (the last segment of a dotted name). */
function trailingRange(r: Range, name: string): Range {
  return { start: { line: r.end.line, character: r.end.character - name.length }, end: r.end };
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
  for (const loc of typeStringReferences(cache, target)) {
    add(loc.uri, { range: trailingRange(loc.range, target.simpleName), newText: newName });
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
  const target = nedTypeTargetAt(cache, file, tree, pos)?.target;
  if (!target) {
    if (referenceAt(cache, file, tree, pos) || typeStringAt(cache, file, tree, pos)) return null;
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
export type RenameMemberKind = 'param' | 'gate' | 'submodule';

/** The kind (auto-detected unless given) and canonical owner of member `memberName`
 *  as seen from type `typeFqName`, or undefined if there is no such member. */
export function resolveRenameMember(
  cache: NedResourceCache,
  typeFqName: string,
  memberName: string,
  kind?: RenameMemberKind,
): { kind: RenameMemberKind; owner: NedTypeInfo } | undefined {
  const type = cache.getType(typeFqName);
  if (!type) return undefined;

  const detectKind = (): RenameMemberKind | undefined => {
    if (type.findParam(memberName)) return 'param';
    if (type.findGate(memberName)) return 'gate';
    if (type.getSubmodule(memberName)) return 'submodule';
    return undefined;
  };
  const memberKind = kind ?? detectKind();
  if (!memberKind) return undefined;

  // The canonical owner is the most-base type that locally declares the member.
  const has = (t: NedTypeInfo) =>
    memberKind === 'param' ? t.localParams().has(memberName)
    : memberKind === 'gate' ? t.localGates().has(memberName)
    : t.localSubmodules().has(memberName);
  let owner: NedTypeInfo | undefined;
  for (const t of [type, ...type.ancestors()]) if (has(t)) owner = t; // keep most-base
  return owner && { kind: memberKind, owner };
}

export function nedRenameMember(
  cache: NedResourceCache,
  typeFqName: string,
  memberName: string,
  newName: string,
  kind?: RenameMemberKind,
): WorkspaceEdit | null {
  const member = resolveRenameMember(cache, typeFqName, memberName, kind);
  if (!member) return null;
  const changes: Record<string, TextEdit[]> = {};
  for (const loc of memberReferences(cache, { kind: member.kind, ownerFq: member.owner.fqName, name: memberName })) {
    (changes[loc.uri] ??= []).push({ range: loc.range, newText: newName });
  }
  return { changes };
}
