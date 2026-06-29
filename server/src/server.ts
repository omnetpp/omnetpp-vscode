import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  InitializeResult,
  InitializeParams,
  FileChangeType,
  MarkupKind,
  Diagnostic as LspDiagnostic,
  DocumentSymbol as LspDocumentSymbol,
  FoldingRange as LspFoldingRange,
  TypeHierarchyItem,
  SymbolKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { promises as fsp } from 'node:fs';
import { ParserService, parseIni, configSummaries, OMNETPP_TOOLS, handleTool } from '@omnetpp/shared';
import type { ToolContext, FileSystem } from '@omnetpp/shared';
import { DocumentModelStore } from './documentModel';
import { NodeFileSystem } from './nodeFileSystem';
import { ProjectIndex } from './projectIndex';
import {
  computeDiagnostics,
  computeDocumentSymbols,
  computeFoldingRanges,
  computeDefinition,
  computeHover,
  computeReferences,
  computeCompletion,
  computePrepareRename,
  computeRename,
  computeFormatting,
  computeDocumentHighlights,
  computeCodeActions,
  computePrepareTypeHierarchy,
  computeTypeHierarchySupertypes,
  computeTypeHierarchySubtypes,
  computeInheritanceRoots,
  computeInheritanceSpineByFq,
  computeModuleHierarchy,
  computeModuleHierarchyByFq,
  computeModuleHierarchyChildren,
  computeParamHierarchy,
  computeParamHierarchyByFq,
  computeParamHierarchyChildren,
  computeConfigNetwork,
  buildConfigCtx,
} from './features/providers';
import type { Position as LspPosition } from 'vscode-languageserver/node';
import type { NedHierarchyItem, ParamAssign, IniDocument } from '@omnetpp/shared';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let parsers: ParserService | undefined;
let store: DocumentModelStore | undefined;
let index: ProjectIndex | undefined;
let workspaceFolders: string[] = [];
let nedPathSetting = '';
let installDir = '';

/** Read the `omnetpp.*` settings the server cares about from init/config options. */
function applySettings(opts: { nedPath?: string; installDir?: string } | undefined): void {
  nedPathSetting = opts?.nedPath ?? '';
  // explicit setting wins; otherwise fall back to the env vars an OMNeT++ shell exports
  installDir =
    opts?.installDir || process.env.OMNETPP_ROOT || process.env.__omnetpp_root_dir || '';
}

connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
  workspaceFolders = (params.workspaceFolders ?? [])
    .map((f) => safeFsPath(f.uri))
    .filter((p): p is string => !!p);
  if (!workspaceFolders.length && params.rootUri) {
    const p = safeFsPath(params.rootUri);
    if (p) workspaceFolders = [p];
  }
  applySettings(params.initializationOptions);

  const wasmDir = join(__dirname, 'wasm');
  parsers = await ParserService.create({
    runtimeWasmDir: wasmDir,
    nedWasmPath: join(wasmDir, 'tree-sitter-ned.wasm'),
    msgWasmPath: join(wasmDir, 'tree-sitter-msg.wasm'),
  });
  store = new DocumentModelStore(parsers);
  index = new ProjectIndex(new NodeFileSystem(), parsers, join(__dirname, 'config'));
  // open documents are owned by the store; protect them from the disk scanner
  index.setOpenPredicate((uri) => documents.get(uri) !== undefined);

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full,
      documentSymbolProvider: true,
      foldingRangeProvider: true,
      definitionProvider: true,
      hoverProvider: true,
      referencesProvider: true,
      completionProvider: { triggerCharacters: ['.', ':', '>', ' ', '"', ';', ',', '=', '@'] },
      renameProvider: { prepareProvider: true },
      documentFormattingProvider: true,
      documentHighlightProvider: true,
      codeActionProvider: { codeActionKinds: ['source.organizeImports', 'source'] },
      typeHierarchyProvider: true,
    },
  };
});

const NED_SYMBOL_KIND: Record<string, SymbolKind> = {
  simple: SymbolKind.Class,
  compound: SymbolKind.Class,
  network: SymbolKind.Class,
  channel: SymbolKind.Class,
  moduleinterface: SymbolKind.Interface,
  channelinterface: SymbolKind.Interface,
};

function toTypeHierarchyItem(it: NedHierarchyItem): TypeHierarchyItem {
  return {
    name: it.name,
    kind: NED_SYMBOL_KIND[it.kind] ?? SymbolKind.Class,
    detail: it.detail,
    uri: it.uri,
    range: it.range,
    selectionRange: it.selectionRange,
    data: { fqName: it.fqName },
  };
}

function fqNameOf(item: TypeHierarchyItem): string | undefined {
  const data = item.data as { fqName?: string } | undefined;
  return data?.fqName;
}

function currentNedPathDirs(): string[] {
  // The install dir itself is never a NED source root, so it is not added here.
  return nedPathSetting.split(/[;:]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Log where the OMNeT++ install was found, the effective NED path (every source root
 * actually scanned, including auto-discovered ones), and per-root index counts.
 */
function logIndexStatus(): void {
  if (!index) return;
  connection.console.info(
    installDir
      ? `OMNeT++ installation: ${installDir}`
      : 'OMNeT++ installation: not detected (set omnetpp.installDir, OMNETPP_ROOT or __omnetpp_root_dir)',
  );
  const roots = index.stats();
  if (!roots.length) {
    connection.console.info('OMNeT++ NED path: no source roots found');
    return;
  }
  connection.console.info(`OMNeT++ NED path (${roots.length} source root(s)):`);
  for (const r of roots) {
    const pkg = r.rootPackage ? ` [package ${r.rootPackage}]` : '';
    connection.console.info(
      `  ${r.dir}${pkg} — ${r.nedTypes} NED type(s), ${r.msgFiles} MSG file(s), ` +
        `${r.iniFiles} INI file(s)/${r.iniConfigs} config(s)`,
    );
  }
  connection.console.info(
    `OMNeT++ index ready: ${index.cache.allTypeNames().length} NED types total.`,
  );
}

connection.onInitialized(async () => {
  if (!index) return;
  try {
    await index.initialize(workspaceFolders, currentNedPathDirs());
    logIndexStatus();
  } catch (e) {
    connection.console.error(`OMNeT++ indexing failed: ${(e as Error).message}`);
  }
  // refresh diagnostics for any already-open documents
  for (const doc of documents.all()) refresh(doc);
});

function ctx() {
  return index
    ? { nedCache: index.cache, msgCache: index.msgCache, registry: index.configRegistry, db: index.db }
    : undefined;
}

function refresh(doc: TextDocument): void {
  if (!store) return;
  const parsed = store.update(doc);
  if (index && parsed.tree) {
    if (parsed.language === 'ned') index.updateOpenDocument(doc.uri, parsed.text);
    else if (parsed.language === 'msg') index.updateOpenMsgDocument(doc.uri, parsed.text);
  }
  const diags = computeDiagnostics(parsed, ctx()) as LspDiagnostic[];
  connection.sendDiagnostics({ uri: doc.uri, diagnostics: diags });
}

/** Recompute diagnostics for all open docs of a language (cross-file changed). */
function refreshAll(language: 'ned' | 'msg', exceptUri?: string): void {
  if (!store) return;
  for (const doc of documents.all()) {
    if (doc.uri === exceptUri) continue; // already refreshed by the caller
    const parsed = store.get(doc.uri);
    if (parsed?.language === language) {
      const diags = computeDiagnostics(parsed, ctx()) as LspDiagnostic[];
      connection.sendDiagnostics({ uri: doc.uri, diagnostics: diags });
    }
  }
}

const iniTimers = new Map<string, NodeJS.Timeout>();
function scheduleIni(uri: string): void {
  const prev = iniTimers.get(uri);
  if (prev) clearTimeout(prev);
  iniTimers.set(
    uri,
    setTimeout(() => {
      iniTimers.delete(uri);
      const parsed = store?.get(uri);
      if (!parsed) return;
      const diags = computeDiagnostics(parsed, ctx()) as LspDiagnostic[];
      connection.sendDiagnostics({ uri, diagnostics: diags });
    }, 300),
  );
}

documents.onDidChangeContent((e) => {
  const lang = languageOfDoc(e.document);
  if (lang === 'ini') {
    store?.update(e.document); // cheap parse now; defer (heavier) analysis
    scheduleIni(e.document.uri);
    return;
  }
  refresh(e.document);
  if (lang === 'ned') refreshAll('ned', e.document.uri);
  else if (lang === 'msg') refreshAll('msg', e.document.uri);
});
documents.onDidClose((e) => {
  store?.remove(e.document.uri);
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
  // re-sync the index to the on-disk version of the now-closed file
  const lang = languageOfDoc(e.document);
  if (index && (lang === 'ned' || lang === 'msg')) {
    void index.onFileChanged(e.document.uri, false);
  }
});

function isProjectConfigFile(uri: string): boolean {
  return /\/(\.nedfolders|\.nedexclusions|package\.ned)$/.test(uri);
}

let reindexTimer: NodeJS.Timeout | undefined;
function scheduleReindex(): void {
  if (reindexTimer) clearTimeout(reindexTimer);
  reindexTimer = setTimeout(async () => {
    reindexTimer = undefined;
    if (!index) return;
    try {
      await index.reindex(workspaceFolders, currentNedPathDirs());
      logIndexStatus();
      // re-apply open buffers (the scan skips them) then refresh everything
      for (const doc of documents.all()) refresh(doc);
    } catch (e) {
      connection.console.error(`OMNeT++ reindex failed: ${(e as Error).message}`);
    }
  }, 400);
}

connection.onDidChangeConfiguration((change) => {
  const before = `${nedPathSetting}\0${installDir}`;
  applySettings((change.settings as { omnetpp?: { nedPath?: string; installDir?: string } })?.omnetpp);
  const after = `${nedPathSetting}\0${installDir}`;
  if (before !== after) scheduleReindex(); // re-discover roots with the new path/install dir
});

connection.onDidChangeWatchedFiles(async (params) => {
  if (!index) return;
  let nedChanged = false;
  let msgChanged = false;
  let layoutChanged = false;
  for (const change of params.changes) {
    if (isProjectConfigFile(change.uri)) {
      layoutChanged = true;
      continue;
    }
    const isNed = change.uri.endsWith('.ned');
    const isMsg = change.uri.endsWith('.msg');
    if (!isNed && !isMsg) continue;
    // skip files that are open (their state comes from the editor)
    if (documents.get(change.uri)) continue;
    await index.onFileChanged(change.uri, change.type === FileChangeType.Deleted);
    if (isNed) nedChanged = true;
    else msgChanged = true;
  }
  if (layoutChanged) {
    scheduleReindex(); // re-discovers .nedfolders/.nedexclusions/package.ned
  } else {
    if (nedChanged) refreshAll('ned');
    if (msgChanged) refreshAll('msg');
  }
});

connection.onDocumentSymbol((params) => {
  const parsed = store?.get(params.textDocument.uri);
  if (!parsed) return [];
  return computeDocumentSymbols(parsed) as unknown as LspDocumentSymbol[];
});

connection.onFoldingRanges((params) => {
  const parsed = store?.get(params.textDocument.uri);
  if (!parsed) return [];
  return computeFoldingRanges(parsed) as unknown as LspFoldingRange[];
});

connection.onDefinition((params) => {
  const parsed = store?.get(params.textDocument.uri);
  const c = ctx();
  if (!parsed || !c) return null;
  return computeDefinition(parsed, params.position, c);
});

connection.onHover((params) => {
  const parsed = store?.get(params.textDocument.uri);
  const c = ctx();
  if (!parsed || !c) return null;
  const h = computeHover(parsed, params.position, c);
  if (!h) return null;
  return { contents: { kind: MarkupKind.Markdown, value: h.markdown }, range: h.range };
});

connection.onReferences((params) => {
  const parsed = store?.get(params.textDocument.uri);
  const c = ctx();
  if (!parsed || !c) return [];
  return computeReferences(parsed, params.position, params.context.includeDeclaration, c);
});

connection.onCompletion((params) => {
  const parsed = store?.get(params.textDocument.uri);
  const c = ctx();
  if (!parsed || !c) return [];
  return computeCompletion(parsed, params.position, c);
});

connection.onPrepareRename((params) => {
  const parsed = store?.get(params.textDocument.uri);
  const c = ctx();
  if (!parsed || !c) return null;
  return computePrepareRename(parsed, params.position, c);
});

connection.onRenameRequest((params) => {
  const parsed = store?.get(params.textDocument.uri);
  const c = ctx();
  if (!parsed || !c) return null;
  return computeRename(parsed, params.position, params.newName, c);
});

connection.onDocumentHighlight((params) => {
  const parsed = store?.get(params.textDocument.uri);
  const c = ctx();
  if (!parsed || !c) return [];
  return computeDocumentHighlights(parsed, params.position, c);
});

connection.onCodeAction((params) => {
  const parsed = store?.get(params.textDocument.uri);
  const c = ctx();
  if (!parsed || !c) return [];
  return computeCodeActions(parsed, c).map((a) => ({
    title: a.title,
    kind: a.kind,
    edit: a.edit,
  }));
});

connection.languages.typeHierarchy.onPrepare((params) => {
  const parsed = store?.get(params.textDocument.uri);
  const c = ctx();
  if (!parsed || !c) return null;
  const item = computePrepareTypeHierarchy(parsed, params.position, c);
  return item ? [toTypeHierarchyItem(item)] : null;
});

connection.languages.typeHierarchy.onSupertypes((params) => {
  const c = ctx();
  const fq = fqNameOf(params.item);
  if (!c || !fq) return null;
  return computeTypeHierarchySupertypes(fq, c).map(toTypeHierarchyItem);
});

connection.languages.typeHierarchy.onSubtypes((params) => {
  const c = ctx();
  const fq = fqNameOf(params.item);
  if (!c || !fq) return null;
  return computeTypeHierarchySubtypes(fq, c).map(toTypeHierarchyItem);
});

// ---- custom requests for the auxiliary tree views ----
interface ViewParams {
  uri: string;
  position?: LspPosition;
}

connection.onRequest('omnetpp/inheritanceRoots', (params: ViewParams & { fqName?: string }) => {
  const c = ctx();
  if (!c) return [];
  if (params.fqName) return computeInheritanceSpineByFq(params.fqName, c);
  const parsed = params.uri ? store?.get(params.uri) : undefined;
  if (!parsed) return [];
  return computeInheritanceRoots(parsed, params.position, c);
});

connection.onRequest('omnetpp/moduleHierarchy', (params: ViewParams & { fqName?: string }) => {
  const c = ctx();
  if (!c) return [];
  if (params.fqName) return computeModuleHierarchyByFq(params.fqName, c);
  const parsed = params.uri ? store?.get(params.uri) : undefined;
  if (!parsed) return [];
  return computeModuleHierarchy(parsed, params.position, c);
});

connection.onRequest('omnetpp/moduleHierarchyChildren', (params: { fqName: string }) => {
  const c = ctx();
  if (!c) return [];
  return computeModuleHierarchyChildren(params.fqName, c);
});

interface ActiveConfig {
  uri: string;
  name: string;
}

/** Build the active-configuration value overlay; reads the ini from the open
 *  buffer or from disk (so it works even when the ini isn't open, e.g. on startup). */
async function activeConfigCtx(cfg: ActiveConfig | undefined, c: ReturnType<typeof ctx>) {
  if (!cfg || !c) return undefined;
  const ini = await iniDocFor(cfg.uri);
  return ini ? buildConfigCtx(ini, cfg.uri, cfg.name, c) : undefined;
}

connection.onRequest(
  'omnetpp/paramHierarchy',
  async (params: ViewParams & { fqName?: string; activeConfig?: ActiveConfig }) => {
    const c = ctx();
    if (!c) return [];
    const cfg = await activeConfigCtx(params.activeConfig, c);
    if (params.fqName) return computeParamHierarchyByFq(params.fqName, c, cfg);
    const parsed = params.uri ? store?.get(params.uri) : undefined;
    if (!parsed) return [];
    return computeParamHierarchy(parsed, params.position, c, cfg);
  },
);

connection.onRequest(
  'omnetpp/paramHierarchyChildren',
  async (params: {
    fqName: string;
    path?: string;
    activeConfig?: ActiveConfig;
    subAssign?: Record<string, ParamAssign>;
  }) => {
    const c = ctx();
    if (!c) return [];
    const cfg = await activeConfigCtx(params.activeConfig, c);
    return computeParamHierarchyChildren(params.fqName, c, params.path, cfg, params.subAssign);
  },
);

connection.onRequest('omnetpp/subtypes', (params: { fqName: string }) => {
  const c = ctx();
  if (!c) return [];
  return computeTypeHierarchySubtypes(params.fqName, c);
});

// ---- configuration listing for the Configurations view ----
/** Parse an ini either from its open buffer (authoritative) or from disk. */
async function iniDocFor(uri: string): Promise<IniDocument | undefined> {
  const open = store?.get(uri);
  if (open?.ini) return open.ini;
  const p = safeFsPath(uri);
  if (!p) return undefined;
  try {
    return parseIni(await fsp.readFile(p, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * A conservative test that an `.ini` file is actually an OMNeT++ ini, so that
 * unrelated `*.ini` files in the workspace (tox.ini, pytest.ini, ...) are not
 * listed as configurations. Every real OMNeT++ ini has a `[General]` section or
 * a `network`/`extends` key or module-path/wildcard parameter keys.
 */
function looksLikeOmnetppIni(doc: IniDocument): boolean {
  return doc.sections.some(
    (s) =>
      s.type === 'general' ||
      s.entries.some(
        (e) => e.key === 'network' || e.key === 'extends' || e.key.includes('**') || e.key.includes('.'),
      ),
  );
}

connection.onRequest(
  'omnetpp/configNetwork',
  async (params: { uri: string; name: string }): Promise<string | undefined> => {
    const c = ctx();
    if (!c) return undefined;
    const ini = await iniDocFor(params.uri);
    return ini ? computeConfigNetwork(ini, params.name, c) : undefined;
  },
);

connection.onRequest(
  'omnetpp/listConfigurations',
  async (params: { uris?: string[] }): Promise<{ uri: string; configs: ReturnType<typeof configSummaries> }[]> => {
    // The client supplies the candidate ini uris (found via workspace.findFiles);
    // union in any open ini buffers so freshly-created/unsaved files appear too.
    const uris = new Set<string>(params.uris ?? []);
    for (const doc of documents.all()) if (languageOfDoc(doc) === 'ini') uris.add(doc.uri);

    const result: { uri: string; configs: ReturnType<typeof configSummaries> }[] = [];
    for (const uri of uris) {
      const doc = await iniDocFor(uri);
      if (!doc || !looksLikeOmnetppIni(doc)) continue;
      const configs = configSummaries(doc);
      if (configs.length) result.push({ uri, configs });
    }
    result.sort((a, b) => a.uri.localeCompare(b.uri));
    return result;
  },
);

connection.onDocumentFormatting((params) => {
  const parsed = store?.get(params.textDocument.uri);
  if (!parsed) return [];
  return computeFormatting(parsed, {
    tabSize: params.options.tabSize,
    insertSpaces: params.options.insertSpaces,
  });
});

function languageOfDoc(doc: TextDocument): 'ned' | 'msg' | 'ini' | undefined {
  const u = doc.uri.toLowerCase();
  if (doc.languageId === 'OMNeT++ NED' || u.endsWith('.ned')) return 'ned';
  if (doc.languageId === 'OMNeT++ MSG' || u.endsWith('.msg')) return 'msg';
  if (doc.languageId === 'OMNeT++ INI' || u.endsWith('.ini')) return 'ini';
  return undefined;
}

function safeFsPath(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

// ---- MCP live-index bridge ------------------------------------------------
// The extension hosts an MCP HTTP endpoint and forwards tool calls here, so MCP
// clients query the SAME live index the editor uses (reflecting unsaved buffers).
const mcpNodeFs = new NodeFileSystem();
/** FileSystem that serves open editor buffers first, falling back to disk. */
const mcpLiveFs: FileSystem = {
  async readFile(path) {
    const doc = documents.get(pathToFileURL(path).toString());
    return doc ? doc.getText() : mcpNodeFs.readFile(path);
  },
  readDirectory: (p) => mcpNodeFs.readDirectory(p),
  stat: (p) => mcpNodeFs.stat(p),
  exists: (p) => mcpNodeFs.exists(p),
};

function mcpCtx(): ToolContext | undefined {
  if (!index || !parsers) return undefined;
  return {
    nedCache: index.cache,
    msgCache: index.msgCache,
    configRegistry: index.configRegistry,
    db: index.db,
    fs: mcpLiveFs,
    parsers,
    toUri: (p) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) ? p : pathToFileURL(p).toString()),
    toPath: (u) => (u.startsWith('file:') ? fileURLToPath(u) : u),
  };
}

connection.onRequest('omnetpp/mcp/listTools', () => OMNETPP_TOOLS);

connection.onRequest(
  'omnetpp/mcp/callTool',
  async (params: { name: string; arguments?: Record<string, unknown> }) => {
    const c = mcpCtx();
    if (!c) throw new Error('OMNeT++ project index not ready');
    return handleTool(params.name, params.arguments ?? {}, c);
  },
);

documents.listen(connection);
connection.listen();
