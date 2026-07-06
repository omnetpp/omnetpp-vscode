/**
 * The "Unassigned submodule parameters" table of compound-module pages: a
 * deep walk over the (merged) submodule tree collecting parameters that have
 * no assignment or only a `default(...)` one — a port of the Eclipse
 * generator's collectUnassignedParameters(). Unlike the Java original, the
 * recursion is cycle-guarded and depth-capped.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { NedResourceCache } from '../ned/nedResourceCache';
import type { NedTypeInfo } from '../ned/nedTypeInfo';
import { paramInfo, paramNodes, type ParamInfo } from '../ned/nedAst';
import { resolveSubmoduleType } from '../ned/nedPreviewScene';

export interface ParamAssignment {
  /** Display value: for `default(x)` assignments this is the inner `x`
   *  (Eclipse's ParamElementEx.getValue() behaves the same). */
  value: string;
  isDefault: boolean;
}

function toAssignment(value: string): ParamAssignment {
  const dflt = /^default\s*\(([\s\S]*)\)$/.exec(value.trim());
  return dflt ? { value: dflt[1].trim(), isDefault: true } : { value: value.trim(), isDefault: false };
}

/** Merged parameter assignments over the inheritance chain, nearest override
 *  first (both `int x = 5` declarations and plain `x = 5` assignments). */
export function paramAssignmentsOf(type: NedTypeInfo): Map<string, ParamAssignment> {
  const out = new Map<string, ParamAssignment>();
  for (const t of [type, ...type.ancestors()]) {
    for (const node of paramNodes(t.node)) {
      const info = paramInfo(node);
      if (!info.name || info.isPattern || info.value === undefined) continue;
      if (!out.has(info.name)) out.set(info.name, toAssignment(info.value));
    }
  }
  return out;
}

/** Parameter assignments written in a submodule's own body. */
function submoduleBodyAssignments(subNode: SyntaxNode): Map<string, ParamAssignment> {
  const out = new Map<string, ParamAssignment>();
  for (const node of paramNodes(subNode)) {
    const info = paramInfo(node);
    if (!info.name || info.isPattern || info.value === undefined) continue;
    if (!out.has(info.name)) out.set(info.name, toAssignment(info.value));
  }
  return out;
}

/** One path segment of a deep parameter row: a submodule name, linked to the
 *  submodule's resolved type page when known. */
export interface UnassignedParamPathSegment {
  text: string;
  typeFqName?: string;
}

export interface UnassignedParamRow {
  /** Dotted path (submodule names, then the parameter name last). */
  path: UnassignedParamPathSegment[];
  param: ParamInfo;
  declNode: SyntaxNode;
  /** The effective (default) assignment value, if any. */
  value?: string;
}

const MAX_DEPTH = 16;

/** Collect unassigned/default parameters of all (deep) submodules of a
 *  compound module. */
export function collectUnassignedParameters(cache: NedResourceCache, type: NedTypeInfo): UnassignedParamRow[] {
  const rows: UnassignedParamRow[] = [];
  const walk = (
    owner: NedTypeInfo,
    prefix: UnassignedParamPathSegment[],
    pathTypes: Set<string>,
    depth: number,
  ): void => {
    if (depth > MAX_DEPTH) return;
    for (const [name, sub] of owner.submodules()) {
      const declOwner = owner.submoduleDecl(name)?.owner ?? owner;
      const resolved = resolveSubmoduleType(cache, owner, declOwner, sub);
      if (!resolved) continue;
      const segment: UnassignedParamPathSegment = { text: name, typeFqName: resolved.fqName };
      if (resolved.kind === 'compound' || resolved.kind === 'network') {
        if (pathTypes.has(resolved.fqName)) continue; // recursive composition guard
        walk(resolved, [...prefix, segment], new Set([...pathTypes, resolved.fqName]), depth + 1);
      } else {
        const typeAssignments = paramAssignmentsOf(resolved);
        const bodyAssignments = submoduleBodyAssignments(sub.node);
        for (const [paramName, decl] of resolved.params()) {
          const assignment = bodyAssignments.get(paramName) ?? typeAssignments.get(paramName);
          if (assignment && !assignment.isDefault) continue;
          const declNode = resolved.paramDecl(paramName)?.node ?? decl.node;
          rows.push({
            path: [...prefix, segment, { text: paramName }],
            param: decl,
            declNode,
            value: assignment?.value,
          });
        }
      }
    }
  };
  walk(type, [], new Set([type.fqName]), 0);
  return rows;
}
