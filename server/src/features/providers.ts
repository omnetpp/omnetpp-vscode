import {
  Diagnostic,
  DocumentSymbol,
  FoldingRange,
  Location,
  Position,
  CompletionItem,
  TextEdit,
  WorkspaceEdit,
  Range,
  FormatOptions,
  NedResourceCache,
  MsgResourceCache,
  ConfigRegistry,
  SemanticDatabase,
  nedPrepareRename,
  nedPrepareMemberRename,
  nedRename,
  prepareTypeHierarchy,
  typeSupertypes,
  typeSubtypes,
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
  organizeImports,
  addMissingKeys,
  formatDocumentEdits,
  syntaxDiagnostics,
  nedLocalDiagnostics,
  nedSemanticDiagnostics,
  nedValueDiagnostics,
  iniLocalDiagnostics,
  iniConfigDiagnostics,
  iniStructureDiagnostics,
  iniVariableDiagnostics,
  iniParamDiagnostics,
  iniParamDefinition,
  matchedParamType,
  classifyKey,
  IniDocument,
  IniSection,
  nedDocumentSymbols,
  iniDocumentSymbols,
  treeFoldingRanges,
  iniFoldingRanges,
  msgDocumentSymbols,
  msgLocalDiagnostics,
  msgSemanticDiagnostics,
  nedDefinition,
  nedHover,
  nedReferences,
  nedCompletion,
  nedClassDefinition,
  nedClassRefAt,
  nedMsgDiagnostics,
  msgDefinition,
  msgHover,
  msgCompletion,
  iniHover,
  iniCompletion,
  HoverResult,
} from '@omnetpp/shared';
import type { ParsedDocument } from '../documentModel';

export interface IndexContext {
  nedCache: NedResourceCache;
  msgCache: MsgResourceCache;
  registry: ConfigRegistry;
  db: SemanticDatabase;
}

function lineAt(text: string, line: number): string {
  return text.split(/\r?\n/)[line] ?? '';
}

/** The ini section + entry-key whose key spans `pos`, if any. */
function iniKeyAt(
  doc: IniDocument,
  pos: Position,
): { section: IniSection; key: string; range: Range } | undefined {
  for (const section of doc.sections) {
    for (const e of section.entries) {
      const r = e.keyRange;
      if (pos.line === r.start.line && pos.character >= r.start.character && pos.character <= r.end.character) {
        return { section, key: e.key, range: r };
      }
    }
  }
  return undefined;
}

export function computeDiagnostics(parsed: ParsedDocument, ctx?: IndexContext): Diagnostic[] {
  const diags: Diagnostic[] = [];
  if (parsed.tree) {
    diags.push(...syntaxDiagnostics(parsed.tree));
    if (parsed.language === 'ned') {
      diags.push(...nedLocalDiagnostics(parsed.tree));
      diags.push(...nedValueDiagnostics(parsed.tree));
      if (ctx) {
        diags.push(...nedSemanticDiagnostics(ctx.nedCache, parsed.uri));
        diags.push(...nedMsgDiagnostics(ctx.msgCache, ctx.nedCache, parsed.uri));
      }
    } else if (parsed.language === 'msg') {
      diags.push(...msgLocalDiagnostics(parsed.tree));
      if (ctx) diags.push(...msgSemanticDiagnostics(ctx.msgCache, parsed.uri));
    }
  }
  if (parsed.ini) {
    diags.push(...iniLocalDiagnostics(parsed.ini));
    diags.push(...iniVariableDiagnostics(parsed.ini));
    if (ctx) {
      diags.push(...iniConfigDiagnostics(parsed.ini, ctx.registry));
      diags.push(...iniStructureDiagnostics(parsed.ini, ctx.nedCache, ctx.registry));
      diags.push(...iniParamDiagnostics(parsed.ini, ctx.nedCache, ctx.registry));
    }
  }
  return diags;
}

export function computeDocumentSymbols(parsed: ParsedDocument): DocumentSymbol[] {
  if (parsed.language === 'ned' && parsed.tree) return nedDocumentSymbols(parsed.tree);
  if (parsed.language === 'msg' && parsed.tree) return msgDocumentSymbols(parsed.tree);
  if (parsed.language === 'ini' && parsed.ini) return iniDocumentSymbols(parsed.ini);
  return [];
}

export function computeFoldingRanges(parsed: ParsedDocument): FoldingRange[] {
  if (parsed.tree) return treeFoldingRanges(parsed.tree);
  if (parsed.ini) return iniFoldingRanges(parsed.ini);
  return [];
}

export function computeDefinition(
  parsed: ParsedDocument,
  pos: Position,
  ctx: IndexContext,
): Location | null {
  if (!parsed.tree) return null;
  if (parsed.language === 'ned') {
    const file = ctx.nedCache.getFile(parsed.uri);
    if (!file) return null;
    // a NED @class / @signal(type=) token jumps to its MSG type declaration
    const cls = nedClassDefinition(ctx.msgCache, ctx.nedCache, file, file.tree, pos);
    return cls ?? nedDefinition(ctx.nedCache, file, file.tree, pos);
  }
  if (parsed.language === 'msg') {
    const file = ctx.msgCache.getFile(parsed.uri);
    return file ? msgDefinition(ctx.msgCache, file, file.tree, pos) : null;
  }
  if (parsed.language === 'ini' && parsed.ini) {
    const at = iniKeyAt(parsed.ini, pos);
    if (at && classifyKey(ctx.registry, at.key).kind === 'param-assignment') {
      const defs = iniParamDefinition(parsed.ini, ctx.nedCache, at.section, at.key);
      return defs[0] ?? null; // jump to the first matching NED parameter declaration
    }
  }
  return null;
}

export function computeHover(
  parsed: ParsedDocument,
  pos: Position,
  ctx: IndexContext,
): HoverResult | null {
  if (parsed.language === 'ini' && parsed.ini) {
    const h = iniHover(parsed.ini, ctx.registry, pos);
    if (h) return h;
    // parameter assignment key: show the resolved NED parameter type
    const at = iniKeyAt(parsed.ini, pos);
    if (at && classifyKey(ctx.registry, at.key).kind === 'param-assignment') {
      const ptype = matchedParamType(parsed.ini, ctx.nedCache, at.section, at.key);
      if (ptype) {
        return { markdown: `parameter \`${at.key}\` — type \`${ptype}\``, range: at.range };
      }
    }
    return null;
  }
  if (!parsed.tree) return null;
  if (parsed.language === 'ned') {
    const file = ctx.nedCache.getFile(parsed.uri);
    if (!file) return null;
    // @class / @signal(type=) token: show the resolved MSG type
    const hit = nedClassRefAt(ctx.msgCache, ctx.nedCache, file, file.tree, pos);
    if (hit) {
      const md = hit.target
        ? `\`\`\`msg\n${hit.target.kind} ${hit.target.fqName}\n\`\`\``
        : `Class \`${hit.ref.className}\` (no matching .msg declaration)`;
      return { markdown: md, range: hit.range };
    }
    return nedHover(ctx.nedCache, file, file.tree, pos);
  }
  if (parsed.language === 'msg') {
    const file = ctx.msgCache.getFile(parsed.uri);
    return file ? msgHover(ctx.msgCache, file, file.tree, pos) : null;
  }
  return null;
}

export function computeReferences(
  parsed: ParsedDocument,
  pos: Position,
  includeDeclaration: boolean,
  ctx: IndexContext,
): Location[] {
  if (parsed.language !== 'ned' || !parsed.tree) return [];
  const file = ctx.nedCache.getFile(parsed.uri);
  if (!file) return [];
  return nedReferences(ctx.nedCache, file, file.tree, pos, includeDeclaration, (fq) =>
    ctx.db.findTypeUsages(fq),
  );
}

export function computePrepareRename(
  parsed: ParsedDocument,
  pos: Position,
  ctx: IndexContext,
): { range: Range; placeholder: string } | null {
  if (parsed.language !== 'ned' || !parsed.tree) return null;
  const file = ctx.nedCache.getFile(parsed.uri);
  if (!file) return null;
  return (
    nedPrepareRename(ctx.nedCache, file, file.tree, pos) ??
    nedPrepareMemberRename(ctx.nedCache, file, file.tree, pos)
  );
}

export function computeRename(
  parsed: ParsedDocument,
  pos: Position,
  newName: string,
  ctx: IndexContext,
): WorkspaceEdit | null {
  if (parsed.language !== 'ned' || !parsed.tree) return null;
  const file = ctx.nedCache.getFile(parsed.uri);
  return file ? nedRename(ctx.nedCache, file, file.tree, pos, newName) : null;
}

export interface CodeActionResult {
  title: string;
  kind: string;
  edit: WorkspaceEdit;
}

export function computeCodeActions(parsed: ParsedDocument, ctx: IndexContext): CodeActionResult[] {
  const out: CodeActionResult[] = [];
  if (parsed.language === 'ned' && parsed.tree) {
    const file = ctx.nedCache.getFile(parsed.uri);
    if (file) {
      const edits = organizeImports(ctx.nedCache, file, file.tree);
      if (edits.length) {
        out.push({
          title: 'OMNeT++: Organize Imports',
          kind: 'source.organizeImports',
          edit: { changes: { [parsed.uri]: edits } },
        });
      }
    }
  }
  if (parsed.language === 'ini' && parsed.ini) {
    const edits = addMissingKeys(parsed.ini, ctx.nedCache);
    if (edits.length) {
      out.push({
        title: 'OMNeT++: Add Missing Parameter Keys',
        kind: 'source',
        edit: { changes: { [parsed.uri]: edits } },
      });
    }
  }
  return out;
}

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

export function computeFormatting(parsed: ParsedDocument, opts: FormatOptions): TextEdit[] {
  if (parsed.language !== 'ned' && parsed.language !== 'msg') return [];
  return formatDocumentEdits(parsed.text, parsed.tree, opts);
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
    return file ? nedCompletion(ctx.nedCache, file, file.tree, pos, line) : [];
  }
  if (parsed.language === 'msg') {
    const file = ctx.msgCache.getFile(parsed.uri);
    return file ? msgCompletion(ctx.msgCache, file, file.tree, pos, line) : [];
  }
  return [];
}
