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
  msgDefinition,
  msgHover,
  msgCompletion,
  iniHover,
  iniCompletion,
  HoverResult,
  nedTypeSym,
  msgTypeSym,
  iniSectionSym,
  nodeRange,
  nameNode,
  msgNameNode,
  MsgTypeInfo,
  parseSymbolId,
  SymbolId,
  EdgeKind,
  XrefEdge,
  impactOf,
  nedUnusedNetworkDiagnostics,
  suggestSimilar,
  sectionName,
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
        diags.push(...nedUnusedNetworkDiagnostics(ctx.db, ctx.nedCache, ctx.iniCache, parsed.uri));
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

function posInRange(pos: Position, r: Range): boolean {
  if (pos.line < r.start.line || pos.line > r.end.line) return false;
  if (pos.line === r.start.line && pos.character < r.start.character) return false;
  if (pos.line === r.end.line && pos.character > r.end.character) return false;
  return true;
}

export function computeReferences(
  parsed: ParsedDocument,
  pos: Position,
  includeDeclaration: boolean,
  ctx: IndexContext,
): Location[] {
  if (parsed.language === 'ned' && parsed.tree) return nedReferencesAt(parsed, pos, includeDeclaration, ctx);
  if (parsed.language === 'msg' && parsed.tree) return msgReferencesAt(parsed, pos, includeDeclaration, ctx);
  if (parsed.language === 'ini' && parsed.ini) return iniReferencesAt(parsed, pos, includeDeclaration, ctx);
  return [];
}

function nedReferencesAt(parsed: ParsedDocument, pos: Position, includeDeclaration: boolean, ctx: IndexContext): Location[] {
  const file = ctx.nedCache.getFile(parsed.uri);
  if (!file || !parsed.tree) return [];
  const refs = nedReferences(ctx.nedCache, file, file.tree, pos, includeDeclaration, (fq) =>
    ctx.db.findTypeUsages(fq),
  );
  // a NED parameter declaration also has references in INI files (assignments)
  const mref = memberRefAt(ctx.nedCache, file, file.tree, pos);
  if (mref?.key.kind === 'param') {
    for (const a of findParamAssignments(ctx.iniCache, ctx.nedCache, ctx.registry, {
      typeFqName: mref.key.ownerFq,
      param: mref.key.name,
    })) {
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

/** Symmetric references from an INI `network=`: the NED type's usages + configs. */
function iniReferencesAt(parsed: ParsedDocument, pos: Position, includeDeclaration: boolean, ctx: IndexContext): Location[] {
  if (!parsed.ini) return [];
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
export function computeCodeLenses(parsed: ParsedDocument, ctx: IndexContext): CrossRefLens[] {
  const out: CrossRefLens[] = [];
  const lens = (range: Range, title: string, locations: Location[]) =>
    out.push({ range, title, uri: parsed.uri, position: range.start, locations });

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

      for (const [name, p] of t.localParams()) {
        const assigns = findParamAssignments(ctx.iniCache, ctx.nedCache, ctx.registry, { typeFqName: fq, param: name });
        if (!assigns.length) continue;
        const prange = nodeRange(p.node);
        const locs = assigns.map((a) => ({ uri: a.uri, range: a.keyRange }));
        out.push({ range: prange, title: `assigned in ${assigns.length} INI key${plural(assigns.length)}`, uri: parsed.uri, position: prange.start, locations: locs });
      }
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

export interface UsedByItem {
  label: string;
  description?: string;
  uri: string;
  range: Range;
}
export interface UsedByGroup {
  label: string;
  items: UsedByItem[];
}

const EDGE_GROUP_LABEL: Record<EdgeKind, string> = {
  extends: 'Extended by',
  implements: 'Implemented by',
  'like-iface': 'Used as «like» by',
  'submodule-type': 'Instantiated by',
  'channel-type': 'Used as channel by',
  import: 'Imported by',
  'gate-ref': 'Gate referenced by',
  'submodule-ref': 'Submodule referenced by',
  'msg-extends': 'Extended by',
  'msg-field-type': 'Field type in',
  'ned-class': 'Backing class for',
  'ini-network': 'Network for config',
  'ini-extends': 'Extended by config',
};
const GROUP_ORDER: EdgeKind[] = [
  'extends', 'implements', 'msg-extends', 'like-iface', 'submodule-type', 'channel-type',
  'msg-field-type', 'ned-class', 'ini-network', 'ini-extends', 'import', 'gate-ref', 'submodule-ref',
];

const baseName = (uri: string) => uri.split('/').pop() ?? uri;

function refName(from: SymbolId): string {
  const p = parseSymbolId(from);
  if (!p) return String(from);
  if (p.lang === 'ned' || p.lang === 'msg') return p.fqName.split(/[.:]/).pop() ?? p.fqName;
  if (p.lang === 'ini') return p.rawName;
  if (p.lang === 'nedmem') return p.member.name;
  if (p.lang === 'file') return baseName(p.uri);
  return String(from);
}

function groupEdges(edges: readonly XrefEdge[]): UsedByGroup[] {
  const byKind = new Map<EdgeKind, UsedByItem[]>();
  for (const e of edges) {
    const items = byKind.get(e.kind) ?? [];
    items.push({ label: refName(e.from), description: baseName(e.src.uri), uri: e.src.uri, range: e.src.range });
    byKind.set(e.kind, items);
  }
  const out: UsedByGroup[] = [];
  for (const kind of GROUP_ORDER) {
    const items = byKind.get(kind);
    if (items?.length) out.push({ label: EDGE_GROUP_LABEL[kind], items });
  }
  return out;
}

/** The cross-reference graph symbol at a position (NED/MSG type, INI network or section). */
function symbolAt(parsed: ParsedDocument, pos: Position, ctx: IndexContext): SymbolId | undefined {
  if (parsed.language === 'ned' && parsed.tree) {
    const file = ctx.nedCache.getFile(parsed.uri);
    if (!file) return undefined;
    const tref = referenceAt(ctx.nedCache, file, file.tree, pos);
    const fq = tref?.kind === 'typedef' ? tref.info.fqName : tref?.kind === 'typeref' ? tref.target?.fqName : undefined;
    return fq ? nedTypeSym(fq) : undefined;
  }
  if (parsed.language === 'msg' && parsed.tree) {
    const file = ctx.msgCache.getFile(parsed.uri);
    const t = file ? msgTypeAt(ctx.msgCache, file, file.tree, pos) : undefined;
    return t ? msgTypeSym(t.fqName) : undefined;
  }
  if (parsed.language === 'ini' && parsed.ini) {
    for (const section of parsed.ini.sections) {
      for (const e of section.entries) {
        if (e.key === 'network' && e.value && (posInRange(pos, e.keyRange) || posInRange(pos, e.valueRange))) {
          const net = resolveNetworkType(ctx.nedCache, e.value);
          return net ? nedTypeSym(net.fqName) : undefined;
        }
      }
    }
    const sec = [...parsed.ini.sections].reverse().find((s) => s.range.start.line <= pos.line);
    return sec ? iniSectionSym(parsed.uri, sec.rawName) : undefined;
  }
  return undefined;
}

/** The reverse dependencies of the symbol at a position, grouped by relation. */
export function computeUsedBy(parsed: ParsedDocument, pos: Position, ctx: IndexContext): { groups: UsedByGroup[] } {
  const sym = symbolAt(parsed, pos, ctx);
  if (sym) return { groups: groupEdges(ctx.db.index.inboundOf(sym)) };
  // NED parameters are not graph symbols; fall back to their INI assignment keys
  if (parsed.language === 'ned' && parsed.tree) {
    const file = ctx.nedCache.getFile(parsed.uri);
    const mref = file ? memberRefAt(ctx.nedCache, file, file.tree, pos) : null;
    if (mref?.key.kind === 'param') {
      const items = findParamAssignments(ctx.iniCache, ctx.nedCache, ctx.registry, { typeFqName: mref.key.ownerFq, param: mref.key.name }).map((a) => ({
        label: a.key,
        description: `${a.config}${a.isWinner ? ' ✓' : ''}`,
        uri: a.uri,
        range: a.keyRange,
      }));
      return { groups: items.length ? [{ label: 'Assigned in INI', items }] : [] };
    }
  }
  return { groups: [] };
}

export interface ImpactResult {
  /** The starting symbol's display name, or undefined if nothing resolved. */
  target?: string;
  items: { label: string; description: string; uri?: string; range?: Range }[];
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
      description: `${EDGE_GROUP_LABEL[n.via]} · depth ${n.depth}`,
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
