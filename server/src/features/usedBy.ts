import {
  Position,
  parseSymbolId,
  SymbolId,
  impactOf,
  ImpactResult,
  UsedByGroup,
  symbolAtPosition,
  groupEdges,
  refDisplayName,
  edgeKindLabel,
} from '@omnetpp/shared';
import type { ParsedDocument } from '../documentModel';
import type { IndexContext } from './context';

// ---- "Used By" reverse-dependency view ----------------------------------
// (symbol resolution, edge grouping and labels live in shared's xrefGrouping)

/** The cross-reference graph symbol at a position, against the live index. */
function symbolAt(parsed: ParsedDocument, pos: Position, ctx: IndexContext): SymbolId | undefined {
  return symbolAtPosition(parsed, pos, ctx.nedCache, ctx.msgCache);
}

/**
 * The reverse dependencies of the symbol at a position, grouped by relation.
 * Purely graph-backed (O(degree)), so it is safe to drive from cursor movement.
 * NED parameter → INI assignments are intentionally NOT resolved here: that query
 * (findParamAssignments) expands every config's network and costs seconds on large
 * workspaces, which must never run on an auto-firing view. Use Find All References
 * on the parameter for its INI assignment sites.
 */
export function computeUsedBy(
  parsed: ParsedDocument,
  pos: Position,
  ctx: IndexContext,
): { target?: string; groups: UsedByGroup[] } {
  const sym = symbolAt(parsed, pos, ctx);
  if (!sym) return { groups: [] };
  return { target: refDisplayName(sym), groups: groupEdges(ctx.db.index.inboundOf(sym)) };
}

/** Transitive impact (what depends on the symbol at a position), for the command/MCP. */
export function computeImpact(parsed: ParsedDocument, pos: Position, ctx: IndexContext): ImpactResult {
  const sym = symbolAt(parsed, pos, ctx);
  if (!sym) return { items: [] };
  const nodes = impactOf(ctx.db, sym);
  return {
    target: parseSymbolId(sym)?.lang === 'ini' ? undefined : sym,
    items: nodes.map((n) => ({
      label: n.name,
      description: `${edgeKindLabel(n.via)} · depth ${n.depth}`,
      uri: n.decl?.uri,
      range: n.decl?.range,
    })),
  };
}
