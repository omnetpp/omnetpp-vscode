import {
  Position,
  inheritanceSpineFor,
  NedHierarchyItem,
  NedTypeInfo,
  ModuleHierNode,
  moduleHierarchyRoot,
  moduleHierarchyChildren,
  ParamHierNode,
  ParamViewOpts,
  ParamResolve,
  ParamAssign,
  paramHierarchyRoot,
  paramHierarchyChildren,
  configEntriesInScope,
  configResolver,
  effectiveNetwork,
  resolveNetworkType,
  IniDocument,
  IniSection,
} from '@omnetpp/shared';
import type { ParsedDocument } from '../documentModel';
import type { IndexContext } from './context';

// ---- auxiliary tree views ----

/** The NED type whose definition spans `pos`, if any. */
function typeAtPos(parsed: ParsedDocument, pos: Position | undefined, ctx: IndexContext): NedTypeInfo | undefined {
  if (!pos) return undefined;
  const contains = (t: NedTypeInfo) =>
    (t.node.startPosition.row < pos.line ||
      (t.node.startPosition.row === pos.line && t.node.startPosition.column <= pos.character)) &&
    (t.node.endPosition.row > pos.line ||
      (t.node.endPosition.row === pos.line && t.node.endPosition.column >= pos.character));
  // most specific (smallest, e.g. inner type) enclosing type wins
  return ctx.nedCache
    .typesInFile(parsed.uri)
    .filter(contains)
    .sort((a, b) => b.node.startPosition.row - a.node.startPosition.row)[0];
}

/**
 * The inheritance spine for the type at the cursor (or the file's first type if
 * the cursor isn't on one): supertype chain down to the selected type, with the
 * selected type opened to its direct subtypes (kept collapsed).
 */
export function computeInheritanceRoots(
  parsed: ParsedDocument,
  pos: Position | undefined,
  ctx: IndexContext,
): NedHierarchyItem[] {
  if (parsed.language !== 'ned') return [];
  const target =
    typeAtPos(parsed, pos, ctx) ??
    ctx.nedCache.typesInFile(parsed.uri).find((t) => !t.isInnerType);
  return target ? inheritanceSpineFor(ctx.nedCache, target) : [];
}

/** The inheritance spine for a type identified by fq-name (used by pinned types). */
export function computeInheritanceSpineByFq(fqName: string, ctx: IndexContext): NedHierarchyItem[] {
  const t = ctx.nedCache.getType(fqName);
  return t ? inheritanceSpineFor(ctx.nedCache, t) : [];
}

/**
 * Module-hierarchy root for the type at the cursor (own submodules + inherited),
 * or by fq-name for a pinned type. Returns [] when no type resolves.
 */
export function computeModuleHierarchy(
  parsed: ParsedDocument,
  pos: Position | undefined,
  ctx: IndexContext,
): ModuleHierNode[] {
  if (parsed.language !== 'ned') return [];
  const target =
    typeAtPos(parsed, pos, ctx) ??
    ctx.nedCache.typesInFile(parsed.uri).find((t) => !t.isInnerType);
  return target ? [moduleHierarchyRoot(ctx.nedCache, target)] : [];
}

export function computeModuleHierarchyByFq(fqName: string, ctx: IndexContext): ModuleHierNode[] {
  const t = ctx.nedCache.getType(fqName);
  return t ? [moduleHierarchyRoot(ctx.nedCache, t)] : [];
}

export function computeModuleHierarchyChildren(fqName: string, ctx: IndexContext): ModuleHierNode[] {
  return moduleHierarchyChildren(ctx.nedCache, fqName);
}

/**
 * An active-configuration value overlay for the Module Parameters view: matches a
 * parameter's (root-relative) path against the config's INI assignments. The view
 * stays type-centric and editor-following — this only changes resolved values.
 */
export interface ConfigCtx {
  configName: string;
  resolve: ParamResolve;
}

/** The section matching `configName` ('General' → the general section), if any. */
function configSection(iniDoc: IniDocument, configName: string): IniSection | undefined {
  if (configName === 'General') return iniDoc.sections.find((s) => s.type === 'general');
  return iniDoc.sections.find((s) => s.configName === configName);
}

/** Build a {@link ConfigCtx} from an active configuration, or undefined if unresolvable. */
export function buildConfigCtx(
  iniDoc: IniDocument,
  iniUri: string,
  configName: string,
  ctx: IndexContext,
): ConfigCtx | undefined {
  const section = configSection(iniDoc, configName);
  if (!section) return undefined;
  const base = configResolver(configEntriesInScope(iniDoc, section, ctx.registry));
  const resolve: ParamResolve = (p) => {
    const e = base(p);
    return e ? { value: e.value, uri: iniUri, range: e.keyRange } : undefined;
  };
  return { configName, resolve };
}

/** View opts rooting the (relative) instance path at `type`, with config overlay. */
function paramOpts(type: NedTypeInfo, cfg?: ConfigCtx): ParamViewOpts | undefined {
  return cfg ? { path: type.simpleName, configName: cfg.configName, resolve: cfg.resolve } : undefined;
}

/**
 * Module-parameters root for the type at the cursor (own params, inherited params,
 * then submodules), or by fq-name for a pinned type. Returns [] when none resolves.
 * With an active configuration (`cfg`), resolved values reflect that config.
 */
export function computeParamHierarchy(
  parsed: ParsedDocument,
  pos: Position | undefined,
  ctx: IndexContext,
  cfg?: ConfigCtx,
): ParamHierNode[] {
  if (parsed.language !== 'ned') return [];
  const target =
    typeAtPos(parsed, pos, ctx) ??
    ctx.nedCache.typesInFile(parsed.uri).find((t) => !t.isInnerType);
  return target ? [paramHierarchyRoot(ctx.nedCache, target, paramOpts(target, cfg))] : [];
}

/** The fq-name of the network type a configuration selects, or undefined. */
export function computeConfigNetwork(
  iniDoc: IniDocument,
  configName: string,
  ctx: IndexContext,
): string | undefined {
  const section = configSection(iniDoc, configName);
  if (!section) return undefined;
  const netName = effectiveNetwork(iniDoc, section);
  if (!netName) return undefined;
  return resolveNetworkType(ctx.nedCache, netName)?.fqName;
}

export function computeParamHierarchyByFq(fqName: string, ctx: IndexContext, cfg?: ConfigCtx): ParamHierNode[] {
  const t = ctx.nedCache.getType(fqName);
  return t ? [paramHierarchyRoot(ctx.nedCache, t, paramOpts(t, cfg))] : [];
}

export function computeParamHierarchyChildren(
  fqName: string,
  ctx: IndexContext,
  path?: string,
  cfg?: ConfigCtx,
  subAssign?: Record<string, ParamAssign>,
): ParamHierNode[] {
  const opts: ParamViewOpts | undefined =
    (cfg && path !== undefined) || subAssign
      ? { path, configName: cfg?.configName, resolve: cfg?.resolve, subAssign }
      : undefined;
  return paramHierarchyChildren(ctx.nedCache, fqName, opts);
}
