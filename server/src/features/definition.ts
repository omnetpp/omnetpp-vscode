import {
  Location,
  Position,
  referenceAt,
  resolveNetworkType,
  iniParamDefinition,
  modulesAtPath,
  typenameTypeTargets,
  classifyKey,
  IniDocument,
  nedDefinition,
  nedClassDefinition,
  nedClassRefAt,
  msgDefinition,
  sectionName,
  posInRange,
  iniEntryAt,
  leafSegment,
  keySegmentPrefixAt,
  isWildcardSegment,
  extendsLabelAt,
} from '@omnetpp/shared';
import type { ParsedDocument } from '../documentModel';
import { IndexContext, typeDeclLoc, asDefResult, dedupLocations } from './context';

export function computeDefinition(
  parsed: ParsedDocument,
  pos: Position,
  ctx: IndexContext,
  fallbackNetwork?: string,
): Location | Location[] | null {
  // INI has no tree — handle it before the tree guard below.
  if (parsed.language === 'ini' && parsed.ini) {
    return iniDefinition(parsed.ini, parsed.uri, pos, ctx, fallbackNetwork);
  }
  if (!parsed.tree) return null;
  if (parsed.language === 'ned') {
    const file = ctx.nedCache.getFile(parsed.uri);
    if (!file) return null;
    // a NED @class / @signal(type=) token jumps to its MSG type declaration
    const cls = nedClassDefinition(ctx.msgCache, ctx.nedCache, file, file.tree, pos);
    if (cls) return cls;
    // a @class token naming a hand-written C++ class (no .msg) jumps to Define_Module
    const clsRef = nedClassRefAt(ctx.msgCache, ctx.nedCache, file, file.tree, pos);
    if (clsRef && !clsRef.target) {
      const impl = ctx.db.findImplClass(clsRef.owner.fqName);
      if (impl) return impl.decl;
    }
    // on a simple/channel type's own name, jump to its C++ implementation class
    const tref = referenceAt(ctx.nedCache, file, file.tree, pos);
    if (tref?.kind === 'typedef') {
      const impl = ctx.db.findImplClass(tref.info.fqName);
      if (impl) return impl.decl;
    }
    return nedDefinition(ctx.nedCache, file, file.tree, pos);
  }
  if (parsed.language === 'msg') {
    const file = ctx.msgCache.getFile(parsed.uri);
    return file ? msgDefinition(ctx.msgCache, file, file.tree, pos) : null;
  }
  return null;
}

/**
 * Go-to-definition for a position inside an INI file:
 * - a `network=` key or value jumps to the resolved network's NED declaration;
 * - a `*.typename = "T"` value jumps to the type(s) `T` denotes;
 * - an `extends=` label jumps to that section's header (same file);
 * - a param-assignment key is segment-aware: the leaf (param-name) segment jumps to
 *   the NED parameter declaration, while an earlier module-path segment jumps to the
 *   NED type of the module instance(s) at that path;
 * - a per-object pseudo-parameter key (`.typename`, `.display-name`, …) — which has
 *   no NED declaration of its own — jumps to the NED type of the module it applies to.
 */
function iniDefinition(
  ini: IniDocument,
  uri: string,
  pos: Position,
  ctx: IndexContext,
  fallbackNetwork?: string,
): Location | Location[] | null {
  const hit = iniEntryAt(ini, pos);
  if (!hit) return null;
  const { section, entry } = hit;

  // network= : either the key or the value navigates to the network type.
  if (entry.key === 'network') {
    if (!entry.value) return null;
    const net = resolveNetworkType(ctx.nedCache, entry.value, uri);
    return net ? typeDeclLoc(net) : null;
  }

  // extends= : each comma-separated label navigates to that section's header.
  if (entry.key === 'extends' && posInRange(pos, entry.valueRange)) {
    const label = extendsLabelAt(entry, pos);
    if (!label) return null;
    const target = ini.sections.find((s) => sectionName(s) === label);
    return target ? { uri, range: target.headerRange } : null;
  }

  // typename value: the string denotes a NED type — navigate to it.
  if (leafSegment(entry.key) === 'typename' && posInRange(pos, entry.valueRange)) {
    return asDefResult(typenameTypeTargets(ctx.nedCache, entry.value));
  }

  // dotted key: segment-aware navigation for both real params and per-object
  // pseudo-parameters (typename/display-name/…).
  if (posInRange(pos, entry.keyRange) && entry.key.includes('.')) {
    const cls = classifyKey(ctx.registry, entry.key);
    const isPseudo = cls.kind === 'config' && cls.option.scope === 'per-object';
    if (cls.kind !== 'param-assignment' && !isPseudo) return null;

    // The NED type of the module(s) at a dotted instance path (empty if the path's
    // last segment is a wildcard, i.e. names no specific module).
    const moduleTypeAt = (path: string): Location[] => {
      if (isWildcardSegment(leafSegment(path))) return [];
      return dedupLocations(modulesAtPath(ini, ctx.nedCache, section, path, fallbackNetwork).map((m) => m.decl));
    };

    const seg = keySegmentPrefixAt(entry, pos);
    if (seg && !seg.isLast) {
      // an earlier segment that names a concrete module -> that module's NED type
      const locs = moduleTypeAt(seg.prefix);
      if (locs.length) return asDefResult(locs);
    } else if (seg && isPseudo) {
      // the pseudo-parameter leaf -> the NED type of the module it is applied on
      const locs = moduleTypeAt(entry.key.slice(0, entry.key.lastIndexOf('.')));
      if (locs.length) return asDefResult(locs);
    }
    // a real-param leaf (or an unresolved earlier segment) -> the NED param decl(s)
    if (cls.kind === 'param-assignment')
      return asDefResult(iniParamDefinition(ini, ctx.nedCache, section, entry.key, fallbackNetwork));
    return null;
  }
  return null;
}
