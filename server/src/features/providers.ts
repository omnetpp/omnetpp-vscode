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
  IniResourceCache,
  findParamAssignments,
  memberRefAt,
  referenceAt,
  msgTypeAt,
  msgRenameRangeAt,
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
  effectiveResolver,
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
  effectiveParamModules,
  MatchedParamModule,
  modulesAtPath,
  typenameTypeTargets,
  classifyKey,
  IniDocument,
  IniSection,
  IniEntry,
  nedDocumentSymbols,
  iniDocumentSymbols,
  treeFoldingRanges,
  iniFoldingRanges,
  msgDocumentSymbols,
  msgLocalDiagnostics,
  msgSemanticDiagnostics,
  nedDefinition,
  nedHover,
  nedDocRefResolver,
  nedReferences,
  nedCompletion,
  nedClassDefinition,
  nedClassRefAt,
  fileNamespace,
  msgDefinition,
  msgHover,
  msgDocRefResolver,
  msgCompletion,
  iniHover,
  iniCompletion,
  HoverResult,
  nedTypeSym,
  msgTypeSym,
  nedMemberSym,
  memberKeyFor,
  MemberKey,
  iniSectionSym,
  nodeRange,
  nameNode,
  msgNameNode,
  isMsgTypeHeaderLine,
  MsgTypeInfo,
  parseSymbolId,
  SymbolId,
  EdgeKind,
  XrefEdge,
  impactOf,
  paramContainerSimpleNames,
  nedUnusedNetworkDiagnostics,
  nedMissingImplClassDiagnostics,
  suggestSimilar,
  sectionName,
  filterSuppressedDiagnostics,
  formatSuppressDirective,
  ImpactResult,
  UsedByGroup,
  posInRange,
  iniEntryAt,
  leafSegment,
  keySegmentPrefixAt,
  isWildcardSegment,
  extendsLabelAt,
  symbolAtPosition,
  groupEdges,
  refDisplayName,
  edgeKindLabel,
} from '@omnetpp/shared';
import type { ParsedDocument } from '../documentModel';

export interface IndexContext {
  nedCache: NedResourceCache;
  msgCache: MsgResourceCache;
  registry: ConfigRegistry;
  db: SemanticDatabase;
  iniCache: IniResourceCache;
}

function lineAt(text: string, line: number): string {
  return text.split(/\r?\n/)[line] ?? '';
}

const baseName = (uri: string): string => uri.split('/').pop() ?? uri;

/** Declaration location of a NED type (its name identifier). */
function typeDeclLoc(t: NedTypeInfo): Location {
  return { uri: t.file.uri, range: nodeRange(nameNode(t.node) ?? t.node) };
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
        diags.push(...nedUnusedNetworkDiagnostics(ctx.db, ctx.nedCache, ctx.iniCache, parsed.uri));
        diags.push(...nedMissingImplClassDiagnostics(ctx.db, ctx.nedCache, parsed.uri));
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
  return filterSuppressedDiagnostics(diags, {
    language: parsed.language,
    text: parsed.text,
    tree: parsed.tree,
  });
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

const asDefResult = (locs: Location[]): Location | Location[] | null =>
  locs.length === 0 ? null : locs.length === 1 ? locs[0] : locs;

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

/**
 * VS Code's hover widget reserves a minimum height (~4 rows): content shorter
 * than that leaves the bottom of the widget unpainted, so the editor behind it
 * shows through as a transparent strip. Built-in hovers never surface this
 * because they are rarely shorter than the minimum, but our signature-only and
 * short-doc hovers routinely are. Pad short hovers with trailing zero-width-space
 * paragraphs so every reserved row carries the hover background.
 */
const HOVER_MIN_ROWS = 4;
const ZWSP_PARAGRAPH = '\n\n​';

/** Rough count of the rows VS Code renders for a hover's markdown. */
function estimateHoverRows(md: string): number {
  let rows = 0;
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence; // a fence marker is the code box border, not a visible row
      continue;
    }
    if (inFence) rows += 1; // each code line is a row
    else if (line.trim() !== '') rows += 1; // a text line is ~a row; blank separators add only margin
  }
  return rows;
}

function padHoverMarkdown(md: string): string {
  let out = md;
  for (let rows = estimateHoverRows(md); rows < HOVER_MIN_ROWS; rows += 1) {
    out += ZWSP_PARAGRAPH;
  }
  return out;
}

export function computeHover(
  parsed: ParsedDocument,
  pos: Position,
  ctx: IndexContext,
  fallbackNetwork?: string,
): HoverResult | null {
  const h = computeHoverRaw(parsed, pos, ctx, fallbackNetwork);
  return h ? { ...h, markdown: padHoverMarkdown(h.markdown) } : null;
}

/** How many matched module paths to list in a param-line hover before eliding. */
const HOVER_PATH_LIMIT = 12;

/** Markdown for a param-assignment hover: parameter type(s) + the matched modules. */
function paramAssignmentHover(matches: MatchedParamModule[], key: string, range: Range): HoverResult {
  const types = [...new Set(matches.map((m) => m.paramType).filter((t): t is string => !!t))];
  const typeStr = types.length === 1 ? ` — type \`${types[0]}\`` : types.length ? ` — types ${types.map((t) => `\`${t}\``).join(', ')}` : '';
  const paths = matches.map((m) => m.path);
  const shown = paths.slice(0, HOVER_PATH_LIMIT).map((p) => `- \`${p}\``);
  if (paths.length > HOVER_PATH_LIMIT) shown.push(`- …and ${paths.length - HOVER_PATH_LIMIT} more`);
  const header = `parameter \`${key}\`${typeStr} — **${matches.length}** matching module parameter${plural(matches.length)}`;
  return { markdown: `${header}\n\n${shown.join('\n')}`, range };
}

function computeHoverRaw(
  parsed: ParsedDocument,
  pos: Position,
  ctx: IndexContext,
  fallbackNetwork?: string,
): HoverResult | null {
  if (parsed.language === 'ini' && parsed.ini) {
    const h = iniHover(parsed.ini, ctx.registry, pos);
    if (h) return h;
    // parameter assignment key: show the resolved NED parameter type + matched modules
    const hit = iniEntryAt(parsed.ini, pos);
    if (hit && posInRange(pos, hit.entry.keyRange) && classifyKey(ctx.registry, hit.entry.key).kind === 'param-assignment') {
      // only the parameters this key WINS (OMNeT++ first-match-wins precedence)
      const matches = effectiveParamModules(parsed.ini, ctx.nedCache, hit.section, hit.entry, ctx.registry, fallbackNetwork);
      if (matches.length) return paramAssignmentHover(matches, hit.entry.key, hit.entry.keyRange);
    }
    return null;
  }
  if (!parsed.tree) return null;
  if (parsed.language === 'ned') {
    const file = ctx.nedCache.getFile(parsed.uri);
    if (!file) return null;
    // @class / @signal(type=) token: a data type resolves to its MSG declaration;
    // a module/channel @class names a C++ implementation class (Define_Module), so
    // fall back to the C++ index and report where the class is registered.
    const hit = nedClassRefAt(ctx.msgCache, ctx.nedCache, file, file.tree, pos);
    if (hit) {
      let md: string;
      if (hit.target) {
        md = `\`\`\`msg\n${hit.target.kind} ${hit.target.fqName}\n\`\`\``;
      } else {
        const ns = fileNamespace(file.tree) ?? '';
        const cpp = ctx.db.cppCache.lookupClass(hit.ref.className, ns);
        if (cpp) {
          const where = baseName(cpp.decl.uri);
          const line = cpp.decl.range.start.line + 1;
          md =
            `\`\`\`cpp\nclass ${cpp.qualifiedName}\n\`\`\`\n\n` +
            `Registered with \`${cpp.macro}\` in [${where}](${cpp.decl.uri}) (line ${line})`;
        } else {
          md =
            `C++ class \`${hit.ref.className}\` — no matching class registration ` +
            `(\`Define_Module\`/\`Define_Channel\`/\`Register_Class\`, …) found in the indexed C++ sources.`;
        }
      }
      return { markdown: md, range: hit.range };
    }
    // NED docs may cross-reference MSG types: resolve those against the MSG index.
    return nedHover(ctx.nedCache, file, file.tree, pos, msgDocRefResolver(ctx.msgCache));
  }
  if (parsed.language === 'msg') {
    const file = ctx.msgCache.getFile(parsed.uri);
    // MSG docs may cross-reference NED types, and vice versa.
    return file ? msgHover(ctx.msgCache, file, file.tree, pos, nedDocRefResolver(ctx.nedCache)) : null;
  }
  return null;
}

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

function dedupLocations(locs: Location[]): Location[] {
  const seen = new Set<string>();
  const out: Location[] = [];
  for (const l of locs) {
    const k = `${l.uri}:${l.range.start.line}:${l.range.start.character}:${l.range.end.line}:${l.range.end.character}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
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
  // a NED type used as a network also has references in INI `network=` keys
  const tref = referenceAt(ctx.nedCache, file, file.tree, pos);
  const fq = tref?.kind === 'typedef' ? tref.info.fqName : tref?.kind === 'typeref' ? tref.target?.fqName : undefined;
  if (fq) refs.push(...ctx.db.findConfigsForNetwork(fq));
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
      const refs = [...ctx.db.findTypeUsages(net.fqName), ...ctx.db.findConfigsForNetwork(net.fqName)];
      if (includeDeclaration) {
        const decl = ctx.db.index.defOf(nedTypeSym(net.fqName))?.decl;
        if (decl) refs.push(decl);
      }
      return refs;
    }
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
      targets.add(`${m.typeFqName} ${m.paramName}`);
    }
    for (const t of targets) {
      const [typeFqName, param] = t.split(' ');
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

const plural = (n: number) => (n === 1 ? '' : 's');

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
        lens(range, `implemented by ${shortName}`, [impl.decl]);
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

export function computePrepareRename(
  parsed: ParsedDocument,
  pos: Position,
  ctx: IndexContext,
): { range: Range; placeholder: string } | null {
  if (parsed.language === 'ned' && parsed.tree) {
    const file = ctx.nedCache.getFile(parsed.uri);
    if (!file) return null;
    return (
      nedPrepareRename(ctx.nedCache, file, file.tree, pos) ??
      nedPrepareMemberRename(ctx.nedCache, file, file.tree, pos)
    );
  }
  if (parsed.language === 'msg' && parsed.tree) {
    const file = ctx.msgCache.getFile(parsed.uri);
    if (!file) return null;
    const range = msgRenameRangeAt(file.tree, pos);
    const t = msgTypeAt(ctx.msgCache, file, file.tree, pos);
    return range && t ? { range, placeholder: t.simpleName } : null;
  }
  return null;
}

/** Replace the trailing `oldName` segment of a single-line reference token. */
function trailingNameEdit(loc: Location, oldName: string, newName: string): TextEdit | undefined {
  const r = loc.range;
  if (r.start.line !== r.end.line) return undefined;
  const start = { line: r.end.line, character: r.end.character - oldName.length };
  if (start.character < r.start.character) return undefined;
  return { range: { start, end: r.end }, newText: newName };
}

const addEdit = (changes: Record<string, TextEdit[]>, uri: string, edit?: TextEdit) => {
  if (edit) (changes[uri] ??= []).push(edit);
};

export function computeRename(
  parsed: ParsedDocument,
  pos: Position,
  newName: string,
  ctx: IndexContext,
): WorkspaceEdit | null {
  if (parsed.language === 'ned' && parsed.tree) return nedRenameCrossLang(parsed, pos, newName, ctx);
  if (parsed.language === 'msg' && parsed.tree) return msgRenameCrossLang(parsed, pos, newName, ctx);
  return null;
}

function nedRenameCrossLang(parsed: ParsedDocument, pos: Position, newName: string, ctx: IndexContext): WorkspaceEdit | null {
  const file = ctx.nedCache.getFile(parsed.uri);
  if (!file || !parsed.tree) return null;
  const base = nedRename(ctx.nedCache, file, file.tree, pos, newName);
  if (!base) return null;
  const changes: Record<string, TextEdit[]> = base.changes ?? {};

  // NED type rename → INI `network=` values that name it
  const tref = referenceAt(ctx.nedCache, file, file.tree, pos);
  const fq = tref?.kind === 'typedef' ? tref.info.fqName : tref?.kind === 'typeref' ? tref.target?.fqName : undefined;
  if (fq) {
    const oldSimple = fq.split('.').pop()!;
    for (const e of ctx.db.index.inboundOf(nedTypeSym(fq))) {
      if (e.kind === 'ini-network') addEdit(changes, e.src.uri, trailingNameEdit(e.src, oldSimple, newName));
    }
  }

  // NED parameter rename → INI assignment keys whose leaf is the param
  const mref = memberRefAt(ctx.nedCache, file, file.tree, pos);
  if (mref?.key.kind === 'param') {
    const old = mref.key.name;
    for (const a of findParamAssignments(ctx.iniCache, ctx.nedCache, ctx.registry, { typeFqName: mref.key.ownerFq, param: old })) {
      if (a.key === old || a.key.endsWith('.' + old)) {
        addEdit(changes, a.uri, trailingNameEdit({ uri: a.uri, range: a.keyRange }, old, newName));
      }
    }
  }
  return { changes };
}

function msgRenameCrossLang(parsed: ParsedDocument, pos: Position, newName: string, ctx: IndexContext): WorkspaceEdit | null {
  const file = ctx.msgCache.getFile(parsed.uri);
  if (!file || !parsed.tree) return null;
  const t = msgTypeAt(ctx.msgCache, file, file.tree, pos);
  if (!t) return null;
  const changes: Record<string, TextEdit[]> = {};
  // declaration name
  addEdit(changes, t.file.uri, { range: nodeRange(msgNameNode(t.node) ?? t.node), newText: newName });
  // every reference (MSG extends / field types + NED @class / @signal)
  for (const e of ctx.db.index.inboundOf(msgTypeSym(t.fqName))) {
    addEdit(changes, e.src.uri, trailingNameEdit(e.src, t.simpleName, newName));
  }
  return { changes };
}

export interface CodeActionResult {
  title: string;
  kind: string;
  edit: WorkspaceEdit;
}

/** The value text of the INI entry whose value occupies `range`, if any. */
function iniValueAtRange(ini: IniDocument, range: Range): string | undefined {
  for (const section of ini.sections) {
    for (const e of section.entries) {
      if (e.valueRange.start.line === range.start.line && e.valueRange.start.character === range.start.character) {
        return e.value;
      }
    }
  }
  return undefined;
}

export function computeCodeActions(
  parsed: ParsedDocument,
  ctx: IndexContext,
  contextDiagnostics?: { code?: string | number; range: Range }[],
): CodeActionResult[] {
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
    // "did you mean …" quick-fixes for broken network= / extends= targets
    const replace = (range: Range, name: string): CodeActionResult => ({
      title: `Change to '${name}'`,
      kind: 'quickfix',
      edit: { changes: { [parsed.uri]: [{ range, newText: name }] } },
    });
    for (const d of contextDiagnostics ?? []) {
      const value = iniValueAtRange(parsed.ini, d.range);
      if (!value) continue;
      if (d.code === 'network-type') {
        const cands = ctx.nedCache.allTypes().filter((t) => t.isNetworkType() && !t.isInnerType).map((t) => t.simpleName);
        for (const s of suggestSimilar(value, cands)) out.push(replace(d.range, s));
      } else if (d.code === 'no-such-section') {
        const cands = parsed.ini.sections.map(sectionName);
        for (const s of suggestSimilar(value, cands)) out.push(replace(d.range, s));
      }
    }
  }
  // "Suppress this diagnostic" — insert a //# (ned/msg) or ### (ini) suppress(code)
  // directive as a trailing comment on the reported line. Works for all langs.
  const seenSuppress = new Set<string>();
  for (const d of contextDiagnostics ?? []) {
    const code = typeof d.code === 'string' ? d.code : undefined;
    if (!code) continue;
    const line = d.range.start.line;
    const key = `${line} ${code}`;
    if (seenSuppress.has(key)) continue;
    seenSuppress.add(key);
    const directive = formatSuppressDirective(parsed.language, code);
    const lineText = lineAt(parsed.text, line);
    const insert = (title: string, at: Position, newText: string): CodeActionResult => ({
      title,
      kind: 'quickfix',
      edit: { changes: { [parsed.uri]: [{ range: { start: at, end: at }, newText }] } },
    });
    // A trailing directive is dropped by the MSG grammar on a type-header line, so
    // there it must go on the line above; everywhere else, keep it trailing.
    if (parsed.language === 'msg' && parsed.tree && isMsgTypeHeaderLine(parsed.tree, line)) {
      const indent = /^\s*/.exec(lineText)?.[0] ?? '';
      out.push(insert(`Suppress '${code}' on the line above`, { line, character: 0 }, `${indent}${directive}\n`));
    } else {
      out.push(insert(`Suppress '${code}' on this line`, { line, character: lineText.length }, `  ${directive}`));
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
