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
  CodeLens as LspCodeLens,
  CodeLensRefreshRequest,
  DidChangeWatchedFilesNotification,
  WatchKind,
  type Disposable,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { promises as fsp } from 'node:fs';
import { ParserService, parseIni, configSummaries, effectiveNetwork, OMNETPP_TOOLS, handleTool, workspaceSymbols, isCppSourceFile, BUILTIN_URI } from '@omnetpp/shared';
import type { ToolContext, FileSystem } from '@omnetpp/shared';
import { DocumentModelStore } from './documentModel';
import type { ParsedDocument } from './documentModel';
import { NodeFileSystem } from './nodeFileSystem';
import { ProjectIndex } from './projectIndex';
import {
  computeDiagnostics,
  computeDocumentSymbols,
  computeFoldingRanges,
  computeDefinition,
  computeHover,
  computeReferences,
  computeCodeLenses,
  computeUsedBy,
  computeImpact,
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
/** Whether diagnostics are published for the whole workspace or only open files. */
let diagnosticsScope: 'openFiles' | 'workspace' = 'workspace';
/** Whether to emit code lenses on INI parameter-assignment lines. */
let iniParamCodeLensEnabled = true;

/** Read the `omnetpp.*` settings the server cares about from init/config options. */
function applySettings(
  opts:
    | {
        nedPath?: string;
        installDir?: string;
        diagnostics?: { scope?: string };
        codeLens?: { iniParams?: boolean };
      }
    | undefined,
): void {
  nedPathSetting = opts?.nedPath ?? '';
  // explicit setting wins; otherwise fall back to the env vars an OMNeT++ shell exports
  installDir =
    opts?.installDir || process.env.OMNETPP_ROOT || process.env.__omnetpp_root_dir || '';
  diagnosticsScope = opts?.diagnostics?.scope === 'openFiles' ? 'openFiles' : 'workspace';
  iniParamCodeLensEnabled = opts?.codeLens?.iniParams !== false;
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
  canRegisterWatchers = !!params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration;

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
      codeActionProvider: { codeActionKinds: ['source.organizeImports', 'source', 'quickfix'] },
      typeHierarchyProvider: true,
      codeLensProvider: { resolveProvider: false },
      workspaceSymbolProvider: true,
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
    await registerExternalWatchers();
  } catch (e) {
    connection.console.error(`OMNeT++ indexing failed: ${(e as Error).message}`);
  }
  // refresh diagnostics for any already-open documents, then publish markers for
  // every other indexed file so the Problems view reflects the whole workspace.
  for (const doc of documents.all()) refresh(doc);
  publishWorkspaceDiagnostics();
});

function ctx() {
  return index
    ? { nedCache: index.cache, msgCache: index.msgCache, registry: index.configRegistry, db: index.db, iniCache: index.iniCache }
    : undefined;
}

function refresh(doc: TextDocument): void {
  if (!store) return;
  const parsed = store.update(doc);
  if (index && parsed.tree) {
    if (parsed.language === 'ned') index.updateOpenDocument(doc.uri, parsed.text);
    else if (parsed.language === 'msg') index.updateOpenMsgDocument(doc.uri, parsed.text);
    else if (parsed.language === 'ini') index.updateOpenIniDocument(doc.uri, parsed.text);
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

// ---- Workspace-wide diagnostics -------------------------------------------
// By default the Problems view shows markers for *every* indexed file under the
// workspace, not just the active/open editors. `refresh()` keeps open files
// instantly up to date; the passes below cover closed files (and cross-file
// errors they pick up), and are debounced so editing stays responsive.

/** URIs we last published *non-empty* diagnostics for, so we can clear their
 *  markers once a file becomes clean or drops out of the index. */
const workspaceDiagUris = new Set<string>();

function isUnderWorkspace(uri: string): boolean {
  const p = safeFsPath(uri);
  if (!p) return false;
  return workspaceFolders.some(
    (root) => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`),
  );
}

/** Compute + publish diagnostics for every indexed NED/MSG/INI file under the
 *  workspace, clearing markers for files that are now clean. Open files are
 *  skipped: they are owned by `refresh()`/`scheduleIni`, which see unsaved edits
 *  the resident caches may not yet reflect. */
function publishWorkspaceDiagnostics(): void {
  if (!index || diagnosticsScope !== 'workspace') return;
  const c = ctx();
  const nextNonEmpty = new Set<string>();
  const publish = (uri: string, parsed: ParsedDocument): void => {
    if (!isUnderWorkspace(uri) || documents.get(uri)) return;
    const diags = computeDiagnostics(parsed, c) as LspDiagnostic[];
    if (!diags.length) return;
    nextNonEmpty.add(uri);
    connection.sendDiagnostics({ uri, diagnostics: diags });
  };
  // Pass the real source `text` (not '') so inline `suppress(...)` directives are
  // honored for closed files too — the suppress filter reads directives from it
  // (and short-circuits on `text` lacking "suppress"). NED/MSG text comes free from
  // the tree; INI text is retained by the cache.
  for (const f of index.cache.allFiles()) {
    if (f.uri === BUILTIN_URI) continue;
    publish(f.uri, { uri: f.uri, language: 'ned', version: 0, text: f.tree.rootNode.text, tree: f.tree });
  }
  for (const f of index.msgCache.allFiles()) {
    publish(f.uri, { uri: f.uri, language: 'msg', version: 0, text: f.tree.rootNode.text, tree: f.tree });
  }
  for (const { uri, doc, text } of index.iniCache.allDocs()) {
    publish(uri, { uri, language: 'ini', version: 0, text, ini: doc });
  }
  // anything previously dirty but now clean (or gone from the index) → clear it,
  // unless it is open (then `refresh()` owns its markers)
  for (const uri of workspaceDiagUris) {
    if (!nextNonEmpty.has(uri) && !documents.get(uri)) {
      connection.sendDiagnostics({ uri, diagnostics: [] });
    }
  }
  workspaceDiagUris.clear();
  for (const uri of nextNonEmpty) workspaceDiagUris.add(uri);
}

/** Drop all workspace markers for files that aren't open (used when the scope
 *  setting flips back to open-files-only). Open files are owned by `refresh()`. */
function clearWorkspaceDiagnostics(): void {
  for (const uri of workspaceDiagUris) {
    if (!documents.get(uri)) connection.sendDiagnostics({ uri, diagnostics: [] });
  }
  workspaceDiagUris.clear();
}

let wsDiagTimer: NodeJS.Timeout | undefined;
function scheduleWorkspaceDiagnostics(): void {
  if (diagnosticsScope !== 'workspace') return;
  if (wsDiagTimer) clearTimeout(wsDiagTimer);
  wsDiagTimer = setTimeout(() => {
    wsDiagTimer = undefined;
    publishWorkspaceDiagnostics();
  }, 500);
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
  // an edit can introduce/clear errors in *closed* files that reference this one
  scheduleWorkspaceDiagnostics();
});
documents.onDidClose((e) => {
  store?.remove(e.document.uri);
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
  workspaceDiagUris.delete(e.document.uri);
  // re-sync the index to the on-disk version of the now-closed file
  const lang = languageOfDoc(e.document);
  if (index && (lang === 'ned' || lang === 'msg')) {
    void index.onFileChanged(e.document.uri, false);
  }
  // the file stays in the index (now disk-backed) — re-publish its markers
  scheduleWorkspaceDiagnostics();
});

function isProjectConfigFile(uri: string): boolean {
  return /\/(\.nedfolders|\.nedexclusions|package\.ned)$/.test(uri);
}

// ---- external-root file watching ------------------------------------------
// VS Code's client-declared `synchronize.fileEvents` globs only watch files
// inside the open workspace folders. Source roots from `omnetpp.nedPath` (and any
// install-dir roots) live elsewhere, so the server registers watchers for them via
// LSP dynamic registration. Re-run whenever the resolved roots may have changed
// (startup and after every reindex) so setting changes re-scope the watchers.
let canRegisterWatchers = false;
let externalWatchers: Disposable | undefined;

async function registerExternalWatchers(): Promise<void> {
  if (!index || !canRegisterWatchers) return;
  const dirs = index.externalRootDirs(workspaceFolders);
  externalWatchers?.dispose(); // drop the previous set before installing a new one
  externalWatchers = undefined;
  if (!dirs.length) return;
  const watchers = dirs.map((dir) => ({
    globPattern: {
      baseUri: pathToFileURL(dir).toString(),
      pattern: '**/*.{ned,msg,ini,cc,cpp,cxx,h,hpp,hxx,hh}',
    },
    kind: WatchKind.Create | WatchKind.Change | WatchKind.Delete,
  }));
  try {
    externalWatchers = await connection.client.register(DidChangeWatchedFilesNotification.type, {
      watchers,
    });
  } catch (e) {
    connection.console.warn(
      `OMNeT++ external-root watch registration failed: ${(e as Error).message}`,
    );
  }
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
      await registerExternalWatchers(); // roots may have changed → re-scope watchers
      // re-apply open buffers (the scan skips them) then refresh everything
      for (const doc of documents.all()) refresh(doc);
      publishWorkspaceDiagnostics();
    } catch (e) {
      connection.console.error(`OMNeT++ reindex failed: ${(e as Error).message}`);
    }
  }, 400);
}

// ---- self-healing revalidation --------------------------------------------
// A trigger-driven reconciliation of the index against disk, for changes that
// file-watch events miss (bulk `git checkout`/`reset`/`stash`, a build script).
// Debounced and single-flighted so a storm of triggers collapses to one pass.
let revalidateTimer: NodeJS.Timeout | undefined;
let revalidateRunning = false;
let revalidatePending = false;
function scheduleRevalidate(): void {
  if (revalidateTimer) clearTimeout(revalidateTimer);
  revalidateTimer = setTimeout(() => void runRevalidate(), 300);
}
async function runRevalidate(): Promise<void> {
  revalidateTimer = undefined;
  if (!index) return;
  if (revalidateRunning) {
    revalidatePending = true; // a trigger arrived mid-pass → run once more after
    return;
  }
  revalidateRunning = true;
  try {
    const r = await index.revalidate(workspaceFolders, currentNedPathDirs());
    if (r.needsReindex) {
      scheduleReindex(); // roots/exclusions changed → full rebuild
    } else if (r.nedChanged || r.msgChanged || r.iniChanged || r.cppChanged) {
      // reconciled closed files may change cross-file diagnostics for open docs
      if (r.nedChanged) refreshAll('ned');
      if (r.msgChanged) refreshAll('msg');
      // a C++ change alters NED reverse counts (CodeLens) — re-pull lenses and
      // re-lint NED (unused-member hints depend on C++ accesses)
      if (r.cppChanged) {
        refreshAll('ned');
        void connection.sendRequest(CodeLensRefreshRequest.type);
      }
      logIndexStatus();
      scheduleWorkspaceDiagnostics();
    }
  } catch (e) {
    connection.console.error(`OMNeT++ revalidate failed: ${(e as Error).message}`);
  } finally {
    revalidateRunning = false;
    if (revalidatePending) {
      revalidatePending = false;
      scheduleRevalidate();
    }
  }
}

// The client pokes this on git HEAD changes and window-focus regain (see the
// extension), where a background process may have rewritten files on disk.
connection.onNotification('omnetpp/revalidate', () => scheduleRevalidate());

connection.onDidChangeConfiguration((change) => {
  const before = `${nedPathSetting}\0${installDir}`;
  const beforeScope = diagnosticsScope;
  const beforeIniLens = iniParamCodeLensEnabled;
  applySettings(
    (change.settings as {
      omnetpp?: {
        nedPath?: string;
        installDir?: string;
        diagnostics?: { scope?: string };
        codeLens?: { iniParams?: boolean };
      };
    })?.omnetpp,
  );
  const after = `${nedPathSetting}\0${installDir}`;
  if (before !== after) scheduleReindex(); // re-discover roots with the new path/install dir
  if (diagnosticsScope !== beforeScope) {
    if (diagnosticsScope === 'workspace') publishWorkspaceDiagnostics();
    else clearWorkspaceDiagnostics();
  }
  // toggle the ini param lenses live (pull-based: ask the client to re-query)
  if (iniParamCodeLensEnabled !== beforeIniLens) void connection.sendRequest(CodeLensRefreshRequest.type);
});

connection.onDidChangeWatchedFiles(async (params) => {
  if (!index) return;
  let nedChanged = false;
  let msgChanged = false;
  let iniChanged = false;
  let cppChanged = false;
  let layoutChanged = false;
  for (const change of params.changes) {
    if (isProjectConfigFile(change.uri)) {
      layoutChanged = true;
      continue;
    }
    const isNed = change.uri.endsWith('.ned');
    const isMsg = change.uri.endsWith('.msg');
    const isIni = change.uri.endsWith('.ini');
    const isCpp = !isNed && !isMsg && !isIni && isCppSourceFile(change.uri);
    if (!isNed && !isMsg && !isIni && !isCpp) continue;
    // skip files that are open (their state comes from the editor)
    if (documents.get(change.uri)) continue;
    await index.onFileChanged(change.uri, change.type === FileChangeType.Deleted);
    if (isNed) nedChanged = true;
    else if (isMsg) msgChanged = true;
    else if (isIni) iniChanged = true;
    else cppChanged = true;
  }
  if (layoutChanged) {
    scheduleReindex(); // re-discovers .nedfolders/.nedexclusions/package.ned
  } else {
    if (nedChanged) refreshAll('ned');
    if (msgChanged) refreshAll('msg');
    // a C++ change alters NED reverse counts (CodeLens) + unused-member hints
    if (cppChanged) {
      refreshAll('ned');
      void connection.sendRequest(CodeLensRefreshRequest.type);
    }
    // closed INI files have no open-doc refresh path; the workspace pass covers them
    if (nedChanged || msgChanged || iniChanged || cppChanged) scheduleWorkspaceDiagnostics();
  }
});

connection.onDocumentSymbol((params) => {
  const parsed = store?.get(params.textDocument.uri);
  if (!parsed) return [];
  return computeDocumentSymbols(parsed) as unknown as LspDocumentSymbol[];
});

connection.onWorkspaceSymbol((params) => {
  if (!index) return [];
  return workspaceSymbols(params.query, {
    nedCache: index.cache,
    msgCache: index.msgCache,
    iniCache: index.iniCache,
  }).map((s) => ({ name: s.name, kind: s.kind, location: s.location, containerName: s.containerName }));
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
  return computeDefinition(parsed, params.position, c, currentActiveNetwork);
});

connection.onHover((params) => {
  const parsed = store?.get(params.textDocument.uri);
  const c = ctx();
  if (!parsed || !c) return null;
  const h = computeHover(parsed, params.position, c, currentActiveNetwork);
  if (!h) return null;
  return { contents: { kind: MarkupKind.Markdown, value: h.markdown }, range: h.range };
});

connection.onReferences((params) => {
  const parsed = store?.get(params.textDocument.uri);
  const c = ctx();
  if (!parsed || !c) return [];
  return computeReferences(parsed, params.position, params.context.includeDeclaration, c, currentActiveNetwork);
});

connection.onCompletion((params) => {
  const parsed = store?.get(params.textDocument.uri);
  const c = ctx();
  if (!parsed || !c) return [];
  return computeCompletion(parsed, params.position, c);
});

connection.onCodeLens((params): LspCodeLens[] => {
  const parsed = store?.get(params.textDocument.uri);
  const c = ctx();
  if (!parsed || !c) return [];
  return computeCodeLenses(parsed, c, {
    iniParamLens: iniParamCodeLensEnabled,
    fallbackNetwork: currentActiveNetwork,
  }).map((l) => ({
    range: l.range,
    command: {
      title: l.title,
      command: 'omnetpp.showReferences',
      arguments: [l.uri, l.position, l.locations],
    },
  }));
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
  return computeCodeActions(parsed, c, params.context.diagnostics).map((a) => ({
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

connection.onRequest('omnetpp/usedBy', (params: { uri: string; position: LspPosition }) => {
  const parsed = store?.get(params.uri);
  const c = ctx();
  if (!parsed || !c) return { groups: [] };
  return computeUsedBy(parsed, params.position, c);
});

connection.onRequest('omnetpp/impact', (params: { uri: string; position: LspPosition }) => {
  const parsed = store?.get(params.uri);
  const c = ctx();
  if (!parsed || !c) return { items: [] };
  return computeImpact(parsed, params.position, c);
});

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

/**
 * The globally-selected active configuration, pushed by the client. Its effective
 * network is the fallback context for INI param navigation on lines whose own
 * section selects no network (e.g. `[General]`) — the "hybrid" rule.
 */
let currentActiveConfig: ActiveConfig | undefined;
let currentActiveNetwork: string | undefined;

/** Resolve (and cache) the active config's effective network name. */
async function refreshActiveNetwork(): Promise<void> {
  currentActiveNetwork = undefined;
  const cfg = currentActiveConfig;
  if (!cfg) return;
  const ini = await iniDocFor(cfg.uri);
  if (!ini) return;
  const section =
    cfg.name === 'General'
      ? ini.sections.find((s) => s.type === 'general')
      : ini.sections.find((s) => s.configName === cfg.name);
  if (section) currentActiveNetwork = effectiveNetwork(ini, section);
}

connection.onNotification('omnetpp/activeConfigChanged', (cfg: ActiveConfig | null) => {
  currentActiveConfig = cfg ?? undefined;
  void refreshActiveNetwork();
});

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
    return parseIni(await fsp.readFile(p, 'utf8'), uri);
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
    iniCache: index.iniCache,
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
