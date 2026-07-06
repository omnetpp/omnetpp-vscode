import {
  Location,
  Position,
  Range,
  configEntriesInScope,
  effectiveResolver,
  effectiveParamModules,
  classifyKey,
  nedTypeSym,
  msgTypeSym,
  memberKeyFor,
  MemberKey,
  nodeRange,
  nameNode,
  msgNameNode,
  MsgTypeInfo,
} from '@omnetpp/shared';
import type { ParsedDocument } from '../documentModel';
import { IndexContext, dedupLocations, plural } from './context';

/**
 * A code lens: a clickable cross-reference count anchored at `range`. The server
 * turns it into an LSP CodeLens whose command peeks `locations` (via the built-in
 * `editor.action.showReferences`).
 */
export interface CrossRefLens {
  range: Range;
  title: string;
  uri: string;
  position: Position;
  locations: Location[];
}

function declLocation(ctx: IndexContext, sym: ReturnType<typeof nedTypeSym>): Location | undefined {
  return ctx.db.index.defOf(sym)?.decl;
}

/**
 * Cross-reference count lenses for a NED or MSG document: per type, the number of
 * references, subtypes, and (NED) configs that use it as a network; per locally
 * declared NED parameter, the number of INI keys that assign it.
 */
export function computeCodeLenses(
  parsed: ParsedDocument,
  ctx: IndexContext,
  opts?: { iniParamLens?: boolean; fallbackNetwork?: string },
): CrossRefLens[] {
  const out: CrossRefLens[] = [];
  const lens = (range: Range, title: string, locations: Location[]) =>
    out.push({ range, title, uri: parsed.uri, position: range.start, locations });

  if (parsed.language === 'ini' && parsed.ini) {
    if (!opts?.iniParamLens) return out;
    for (const section of parsed.ini.sections) {
      // OMNeT++ first-match-wins: attribute each parameter only to the key that wins it.
      const isEffective = effectiveResolver(configEntriesInScope(parsed.ini, section, ctx.registry));
      for (const e of section.entries) {
        if (classifyKey(ctx.registry, e.key).kind !== 'param-assignment') continue;
        const matches = effectiveParamModules(parsed.ini, ctx.nedCache, section, e, ctx.registry, opts.fallbackNetwork, isEffective);
        if (!matches.length) continue;
        const decls = dedupLocations(matches.map((m) => m.decl).filter((l): l is Location => !!l));
        lens(e.keyRange, `${matches.length} module parameter${plural(matches.length)}`, decls);
      }
    }
    return out;
  }

  if (parsed.language === 'ned') {
    for (const t of ctx.nedCache.typesInFile(parsed.uri)) {
      const fq = t.fqName;
      const range = declLocation(ctx, nedTypeSym(fq))?.range ?? nodeRange(nameNode(t.node) ?? t.node);

      const usages = ctx.db.findTypeUsages(fq);
      lens(range, `${usages.length} reference${plural(usages.length)}`, usages);

      const subs = ctx.db.findSubtypes(fq, { direct: true });
      if (subs.length) {
        const locs = subs.map((s) => declLocation(ctx, nedTypeSym(s.fqName))).filter((l): l is Location => !!l);
        lens(range, `${subs.length} subtype${plural(subs.length)}`, locs);
      }

      const configs = ctx.db.findConfigsForNetwork(fq);
      if (configs.length) lens(range, `${configs.length} config${plural(configs.length)}`, configs);

      // the C++ class implementing this type (Define_Module/Define_Channel)
      const impl = ctx.db.findImplClass(fq);
      if (impl) {
        const shortName = impl.qualifiedName.split('::').pop() ?? impl.qualifiedName;
        lens(range, `C++ implementation by ${shortName}`, [impl.decl]);
      }

      // per-member "N C++ access(es)" — only for members this type declares, and
      // only when there is at least one access (absence is the unused-hint's job)
      const memberLens = (info: { node: Parameters<typeof nodeRange>[0] }, kind: MemberKey['kind'], name: string) => {
        const key = memberKeyFor(t, kind, name);
        if (!key || key.ownerFq !== fq) return;
        const accesses = ctx.db.findCppMemberAccesses(key);
        if (!accesses.length) return;
        const r = nodeRange(nameNode(info.node) ?? info.node);
        lens(r, `${accesses.length} C++ access${accesses.length === 1 ? '' : 'es'}`, accesses);
      };
      for (const [name, info] of t.localParams()) memberLens(info, 'param', name);
      for (const [name, info] of t.localGates()) memberLens(info, 'gate', name);
      for (const [name, info] of t.localSubmodules()) memberLens(info, 'submodule', name);
    }
  } else if (parsed.language === 'msg') {
    const msgTypes = ctx.msgCache.allTypes().filter((t: MsgTypeInfo) => t.file.uri === parsed.uri);
    for (const t of msgTypes) {
      const fq = t.fqName;
      const range = declLocation(ctx, msgTypeSym(fq))?.range ?? nodeRange(msgNameNode(t.node) ?? t.node);

      const usages = ctx.db.findMsgUsages(fq);
      lens(range, `${usages.length} NED usage${plural(usages.length)}`, usages);

      const subs = ctx.db.findMsgSubtypes(fq);
      if (subs.length) {
        const locs = subs.map((s) => declLocation(ctx, msgTypeSym(s.fqName))).filter((l): l is Location => !!l);
        lens(range, `${subs.length} subtype${plural(subs.length)}`, locs);
      }
    }
  }
  return out;
}
