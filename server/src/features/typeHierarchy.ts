import {
  Position,
  prepareTypeHierarchy,
  typeSupertypes,
  typeSubtypes,
  NedHierarchyItem,
} from '@omnetpp/shared';
import type { ParsedDocument } from '../documentModel';
import type { IndexContext } from './context';

export function computePrepareTypeHierarchy(
  parsed: ParsedDocument,
  pos: Position,
  ctx: IndexContext,
): NedHierarchyItem | null {
  if (parsed.language !== 'ned' || !parsed.tree) return null;
  const file = ctx.nedCache.getFile(parsed.uri);
  return file ? prepareTypeHierarchy(ctx.nedCache, file, file.tree, pos) : null;
}

export function computeTypeHierarchySupertypes(fqName: string, ctx: IndexContext): NedHierarchyItem[] {
  return typeSupertypes(ctx.nedCache, fqName);
}

export function computeTypeHierarchySubtypes(fqName: string, ctx: IndexContext): NedHierarchyItem[] {
  return typeSubtypes(ctx.nedCache, fqName);
}
