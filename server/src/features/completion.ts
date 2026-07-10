import { Position, CompletionItem, nedCompletion, msgCompletion, iniCompletion } from '@omnetpp/shared';
import type { ParsedDocument } from '../documentModel';
import { IndexContext, lineAt } from './context';

export function computeCompletion(
  parsed: ParsedDocument,
  pos: Position,
  ctx: IndexContext,
): CompletionItem[] {
  const line = lineAt(parsed.text, pos.line);
  if (parsed.language === 'ini' && parsed.ini) {
    return iniCompletion(parsed.ini, ctx.registry, ctx.nedCache, pos, line);
  }
  if (!parsed.tree) return [];
  if (parsed.language === 'ned') {
    const file = ctx.nedCache.getFile(parsed.uri);
    return file ? nedCompletion(ctx.nedCache, file, file.tree, pos, line, ctx.iconIds) : [];
  }
  if (parsed.language === 'msg') {
    const file = ctx.msgCache.getFile(parsed.uri);
    return file ? msgCompletion(ctx.msgCache, file, file.tree, pos, line) : [];
  }
  return [];
}
