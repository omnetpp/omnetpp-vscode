import {
  Location,
  Position,
  TextEdit,
  WorkspaceEdit,
  Range,
  findParamAssignments,
  memberRefAt,
  msgTypeAt,
  msgRenameRangeAt,
  nedPrepareRename,
  nedPrepareMemberRename,
  nedRename,
  nedTypeSym,
  msgTypeSym,
  nodeRange,
  msgNameNode,
  nedTypeTargetAt,
  iniTypenameReferences,
} from '@omnetpp/shared';
import type { ParsedDocument } from '../documentModel';
import type { IndexContext } from './context';

export function computePrepareRename(
  parsed: ParsedDocument,
  pos: Position,
  ctx: IndexContext,
): { range: Range; placeholder: string } | null {
  if (parsed.language === 'ned' && parsed.tree) {
    const file = ctx.nedCache.getFile(parsed.uri);
    if (!file) return null;
    return (
      nedPrepareRename(ctx.nedCache, file, file.tree, pos) ??
      nedPrepareMemberRename(ctx.nedCache, file, file.tree, pos)
    );
  }
  if (parsed.language === 'msg' && parsed.tree) {
    const file = ctx.msgCache.getFile(parsed.uri);
    if (!file) return null;
    const range = msgRenameRangeAt(file.tree, pos);
    const t = msgTypeAt(ctx.msgCache, file, file.tree, pos);
    return range && t ? { range, placeholder: t.simpleName } : null;
  }
  return null;
}

/** Replace the trailing `oldName` segment of a single-line reference token. */
function trailingNameEdit(loc: Location, oldName: string, newName: string): TextEdit | undefined {
  const r = loc.range;
  if (r.start.line !== r.end.line) return undefined;
  const start = { line: r.end.line, character: r.end.character - oldName.length };
  if (start.character < r.start.character) return undefined;
  return { range: { start, end: r.end }, newText: newName };
}

const addEdit = (changes: Record<string, TextEdit[]>, uri: string, edit?: TextEdit) => {
  if (edit) (changes[uri] ??= []).push(edit);
};

export function computeRename(
  parsed: ParsedDocument,
  pos: Position,
  newName: string,
  ctx: IndexContext,
): WorkspaceEdit | null {
  if (parsed.language === 'ned' && parsed.tree) return nedRenameCrossLang(parsed, pos, newName, ctx);
  if (parsed.language === 'msg' && parsed.tree) return msgRenameCrossLang(parsed, pos, newName, ctx);
  return null;
}

function nedRenameCrossLang(parsed: ParsedDocument, pos: Position, newName: string, ctx: IndexContext): WorkspaceEdit | null {
  const file = ctx.nedCache.getFile(parsed.uri);
  if (!file || !parsed.tree) return null;
  const base = nedRename(ctx.nedCache, file, file.tree, pos, newName);
  if (!base) return null;
  const changes: Record<string, TextEdit[]> = base.changes ?? {};

  // NED type rename → INI `network=` and `typename` values that name it
  const target = nedTypeTargetAt(ctx.nedCache, file, file.tree, pos)?.target;
  if (target) {
    const oldSimple = target.simpleName;
    for (const e of ctx.db.index.inboundOf(nedTypeSym(target.fqName))) {
      if (e.kind === 'ini-network') addEdit(changes, e.src.uri, trailingNameEdit(e.src, oldSimple, newName));
    }
    for (const loc of iniTypenameReferences(ctx.iniCache, ctx.nedCache, target)) {
      addEdit(changes, loc.uri, trailingNameEdit(loc, oldSimple, newName));
    }
  }

  // NED parameter rename → INI assignment keys whose leaf is the param
  const mref = memberRefAt(ctx.nedCache, file, file.tree, pos);
  if (mref?.key.kind === 'param') {
    const old = mref.key.name;
    for (const a of findParamAssignments(ctx.iniCache, ctx.nedCache, ctx.registry, { typeFqName: mref.key.ownerFq, param: old })) {
      if (a.key === old || a.key.endsWith('.' + old)) {
        addEdit(changes, a.uri, trailingNameEdit({ uri: a.uri, range: a.keyRange }, old, newName));
      }
    }
  }
  return { changes };
}

function msgRenameCrossLang(parsed: ParsedDocument, pos: Position, newName: string, ctx: IndexContext): WorkspaceEdit | null {
  const file = ctx.msgCache.getFile(parsed.uri);
  if (!file || !parsed.tree) return null;
  const t = msgTypeAt(ctx.msgCache, file, file.tree, pos);
  if (!t) return null;
  const changes: Record<string, TextEdit[]> = {};
  // declaration name
  addEdit(changes, t.file.uri, { range: nodeRange(msgNameNode(t.node) ?? t.node), newText: newName });
  // every reference (MSG extends / field types + NED @class / @signal)
  for (const e of ctx.db.index.inboundOf(msgTypeSym(t.fqName))) {
    addEdit(changes, e.src.uri, trailingNameEdit(e.src, t.simpleName, newName));
  }
  return { changes };
}
