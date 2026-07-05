import { buildPreviewScene, previewSceneByFq } from '@omnetpp/shared';
import type { PreviewScene, Position } from '@omnetpp/shared';
import type { ParsedDocument } from '../documentModel';
import type { IndexContext } from './context';
import { typeAtPos } from './hierarchyViews';

/**
 * The preview scene for the type at the cursor, falling back to the file's
 * first top-level type (same focus rule as the hierarchy views). Returns
 * undefined when the document isn't NED or contains no types.
 */
export function computePreviewScene(
  parsed: ParsedDocument,
  pos: Position | undefined,
  ctx: IndexContext,
): PreviewScene | undefined {
  if (parsed.language !== 'ned') return undefined;
  const target =
    typeAtPos(parsed, pos, ctx) ??
    ctx.nedCache.typesInFile(parsed.uri).find((t) => !t.isInnerType);
  return target ? buildPreviewScene(ctx.nedCache, target) : undefined;
}

/** The preview scene for a pinned type identified by fq-name. */
export function computePreviewSceneByFq(fqName: string, ctx: IndexContext): PreviewScene | undefined {
  return previewSceneByFq(ctx.nedCache, fqName);
}
