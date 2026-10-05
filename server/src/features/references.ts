import {
  Location,
  Position,
  Range,
  findParamAssignments,
  memberRefAt,
  msgTypeAt,
  resolveNetworkType,
  effectiveParamModules,
  classifyKey,
  nedReferences,
  nedTypeSym,
  msgTypeSym,
  paramContainerSimpleNames,
  posInRange,
  iniEntryAt,
  nedTypeTargetAt,
  iniTypenameReferences,
  typeStringReferences,
  typenameCandidates,
  typenameSlotInterfaces,
  leafSegment,
  mergedSection,
  type NedTypeInfo,
} from '@omnetpp/shared';
import type { ParsedDocument } from '../documentModel';
import { IndexContext, dedupLocations, mergedIniDoc } from './context';

export function computeReferences(
  parsed: ParsedDocument,
  pos: Position,
  includeDeclaration: boolean,
  ctx: IndexContext,
  fallbackNetwork?: string,
): Location[] {
  if (parsed.language === 'ned' && parsed.tree) return nedReferencesAt(parsed, pos, includeDeclaration, ctx);
  if (parsed.language === 'msg' && parsed.tree) return msgReferencesAt(parsed, pos, includeDeclaration, ctx);
  if (parsed.language === 'ini' && parsed.ini) return iniReferencesAt(parsed, pos, includeDeclaration, ctx, fallbackNetwork);
  return [];
}

function nedReferencesAt(parsed: ParsedDocument, pos: Position, includeDeclaration: boolean, ctx: IndexContext): Location[] {
  const file = ctx.nedCache.getFile(parsed.uri);
  if (!file || !parsed.tree) return [];
  const refs = nedReferences(ctx.nedCache, file, file.tree, pos, includeDeclaration, (fq) =>
    ctx.db.findTypeUsages(fq),
  );
  // a NED member is also accessed in C++ (par()/gate()/getSubmodule())
  const mref = memberRefAt(ctx.nedCache, file, file.tree, pos);
  if (mref) refs.push(...ctx.db.findCppMemberAccesses(mref.key));
  // a NED parameter declaration also has references in INI files (assignments)
  if (mref?.key.kind === 'param') {
    const relevant = paramContainerSimpleNames(ctx.db, mref.key.ownerFq);
    for (const a of findParamAssignments(
      ctx.iniCache,
      ctx.nedCache,
      ctx.registry,
      { typeFqName: mref.key.ownerFq, param: mref.key.name },
      undefined,
      relevant,
    )) {
      refs.push({ uri: a.uri, range: a.keyRange });
    }
  }
  // a NED type is also referenced from INI `network=` keys and `typename` values
  const target = nedTypeTargetAt(ctx.nedCache, file, file.tree, pos)?.target;
  if (target) {
    refs.push(...ctx.db.findConfigsForNetwork(target.fqName));
    refs.push(...iniTypenameReferences(ctx.iniCache, ctx.nedCache, target));
  }
  return refs;
}

/** Symmetric references from a MSG type: NED @class/@signal, MSG subtypes + field types. */
function msgReferencesAt(parsed: ParsedDocument, pos: Position, includeDeclaration: boolean, ctx: IndexContext): Location[] {
  const file = ctx.msgCache.getFile(parsed.uri);
  if (!file || !parsed.tree) return [];
  const t = msgTypeAt(ctx.msgCache, file, file.tree, pos);
  if (!t) return [];
  const refs = ctx.db.index.inboundOf(msgTypeSym(t.fqName)).map((e) => e.src);
  if (includeDeclaration) {
    const decl = ctx.db.index.defOf(msgTypeSym(t.fqName))?.decl;
    if (decl) refs.push(decl);
  }
  return refs;
}

/**
 * References from an INI key: on a `network=` key, the NED type's usages + configs;
 * on a param-assignment key, the matched NED parameter declaration(s) plus every
 * other in-scope INI assignment targeting the same parameters.
 */
function iniReferencesAt(
  parsed: ParsedDocument,
  pos: Position,
  includeDeclaration: boolean,
  ctx: IndexContext,
  fallbackNetwork?: string,
): Location[] {
  if (!parsed.ini) return [];
  // network= key: the NED type's usages + the configs selecting it.
  for (const section of parsed.ini.sections) {
    for (const e of section.entries) {
      if (e.key !== 'network' || !e.value) continue;
      if (!posInRange(pos, e.keyRange) && !posInRange(pos, e.valueRange)) continue;
      const net = resolveNetworkType(ctx.nedCache, e.value);
      if (!net) return [];
      return nedTypeReferences(net, includeDeclaration, ctx, fallbackNetwork);
    }
  }
  // typename value naming exactly one type: that type's references.
  const tn = iniEntryAt(parsed.ini, pos);
  if (tn && leafSegment(tn.entry.key) === 'typename' && posInRange(pos, tn.entry.valueRange)) {
    const merged = mergedIniDoc(parsed.ini, parsed.uri, ctx);
    const ifaces = typenameSlotInterfaces(merged, ctx.nedCache, mergedSection(merged, tn.section), tn.entry.key, fallbackNetwork);
    const candidates = typenameCandidates(ctx.nedCache, tn.entry.value, ifaces);
    return candidates.length === 1 ? nedTypeReferences(candidates[0], includeDeclaration, ctx, fallbackNetwork) : [];
  }
  // param-assignment key: matched NED declarations + other INI assignment lines.
  // Restrict to the parameters this key actually WINS (OMNeT++ first-match-wins).
  const at = iniEntryAt(parsed.ini, pos);
  if (at && posInRange(pos, at.entry.keyRange) && classifyKey(ctx.registry, at.entry.key).kind === 'param-assignment') {
    const matches = effectiveParamModules(parsed.ini, ctx.nedCache, at.section, at.entry, ctx.registry, fallbackNetwork);
    const refs: Location[] = [];
    const targets = new Set<string>();
    for (const m of matches) {
      if (m.decl) refs.push(m.decl);
      targets.add(`${m.typeFqName}\0${m.paramName}`);
    }
    for (const t of targets) {
      const [typeFqName, param] = t.split('\0');
      const relevant = paramContainerSimpleNames(ctx.db, typeFqName);
      for (const a of findParamAssignments(ctx.iniCache, ctx.nedCache, ctx.registry, { typeFqName, param }, undefined, relevant)) {
        if (!includeDeclaration && a.uri === parsed.uri && a.keyRange.start.line === at.entry.keyRange.start.line) continue;
        refs.push({ uri: a.uri, range: a.keyRange });
      }
    }
    return dedupLocations(refs);
  }
  return [];
}

/** Every reference to a NED type: NED type positions and strings, INI `network=` and `typename` values. */
function nedTypeReferences(target: NedTypeInfo, includeDeclaration: boolean, ctx: IndexContext, fallbackNetwork?: string): Location[] {
  const refs = [
    ...ctx.db.findTypeUsages(target.fqName),
    ...typeStringReferences(ctx.nedCache, target),
    ...ctx.db.findConfigsForNetwork(target.fqName),
    ...iniTypenameReferences(ctx.iniCache, ctx.nedCache, target, fallbackNetwork),
  ];
  if (includeDeclaration) {
    const decl = ctx.db.index.defOf(nedTypeSym(target.fqName))?.decl;
    if (decl) refs.push(decl);
  }
  return refs;
}

/** Highlight occurrences of the type under the cursor within the current document. */
export function computeDocumentHighlights(
  parsed: ParsedDocument,
  pos: Position,
  ctx: IndexContext,
): { range: Range }[] {
  if (parsed.language !== 'ned' || !parsed.tree) return [];
  const file = ctx.nedCache.getFile(parsed.uri);
  if (!file) return [];
  return nedReferences(ctx.nedCache, file, file.tree, pos, true, (fq) => ctx.db.findTypeUsages(fq))
    .filter((l) => l.uri === parsed.uri)
    .map((l) => ({ range: l.range }));
}
