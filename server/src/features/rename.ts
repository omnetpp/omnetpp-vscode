import {
  Position,
  TextEdit,
  WorkspaceEdit,
  Range,
  addIniParamRenameEdits,
  addIniTypeRenameEdits,
  addRenameEdit,
  memberRefAt,
  msgTypeAt,
  msgRenameRangeAt,
  nedPrepareRename,
  nedPrepareMemberRename,
  nedRename,
  msgTypeSym,
  nodeRange,
  msgNameNode,
  nedTypeTargetAt,
  trailingNameEdit,
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

  const target = nedTypeTargetAt(ctx.nedCache, file, file.tree, pos)?.target;
  if (target) addIniTypeRenameEdits(changes, ctx, target, newName);
  const mref = memberRefAt(ctx.nedCache, file, file.tree, pos);
  if (mref?.key.kind === 'param') addIniParamRenameEdits(changes, ctx, mref.key.ownerFq, mref.key.name, newName);
  return { changes };
}

function msgRenameCrossLang(parsed: ParsedDocument, pos: Position, newName: string, ctx: IndexContext): WorkspaceEdit | null {
  const file = ctx.msgCache.getFile(parsed.uri);
  if (!file || !parsed.tree) return null;
  const t = msgTypeAt(ctx.msgCache, file, file.tree, pos);
  if (!t) return null;
  const changes: Record<string, TextEdit[]> = {};
  // declaration name
  addRenameEdit(changes, t.file.uri, { range: nodeRange(msgNameNode(t.node) ?? t.node), newText: newName });
  // every reference (MSG extends / field types + NED @class / @signal)
  for (const e of ctx.db.index.inboundOf(msgTypeSym(t.fqName))) {
    addRenameEdit(changes, e.src.uri, trailingNameEdit(e.src, t.simpleName, newName));
  }
  return { changes };
}
