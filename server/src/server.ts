import { join } from 'node:path';
import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  InitializeResult,
  InitializeParams,
  MarkupKind,
  Diagnostic as LspDiagnostic,
  DocumentSymbol as LspDocumentSymbol,
  FoldingRange as LspFoldingRange,
  TypeHierarchyItem,
  SymbolKind,
  CodeLens as LspCodeLens,
  CodeLensRefreshRequest,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ParserService, workspaceSymbols } from '@omnetpp/shared';
import type { OmnetppSettings } from '@omnetpp/shared';
import { DocumentModelStore } from './documentModel';
import { NodeFileSystem } from '@omnetpp/shared/node';
import { ProjectIndex } from './projectIndex';
import { computeDiagnostics } from './features/diagnostics';
import { computeDocumentSymbols, computeFoldingRanges } from './features/symbolsFolding';
import { computeDefinition } from './features/definition';
import { computeHover } from './features/hover';
import { computeReferences, computeDocumentHighlights } from './features/references';
import { computeCodeLenses } from './features/codeLens';
import { computeCompletion } from './features/completion';
import { computePrepareRename, computeRename } from './features/rename';
import { computeFormatting } from './features/formatting';
import { computeCodeActions } from './features/codeActions';
import {
  computePrepareTypeHierarchy,
  computeTypeHierarchySupertypes,
  computeTypeHierarchySubtypes,
} from './features/typeHierarchy';
import { ServerState, ctx, currentNedPathDirs, languageOfDoc, safeFsPath } from './serverState';
import { registerWorkspaceDiagnostics } from './workspaceDiagnostics';
import { registerIndexLifecycle } from './indexLifecycle';
import { registerViewRequests } from './viewRequests';
import { registerMcpRequests } from './mcpRequests';
import type { NedHierarchyItem } from '@omnetpp/shared';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const state = new ServerState();

/** Read the `omnetpp.*` settings the server cares about from init/config options. */
function applySettings(opts: OmnetppSettings | undefined): void {
  state.nedPathSetting = opts?.nedPath ?? '';
  // explicit setting wins; otherwise fall back to the env vars an OMNeT++ shell exports
  state.installDir =
    opts?.installDir || process.env.OMNETPP_ROOT || process.env.__omnetpp_root_dir || '';
  state.diagnosticsScope = opts?.diagnostics?.scope === 'openFiles' ? 'openFiles' : 'workspace';
  state.iniParamCodeLensEnabled = opts?.codeLens?.iniParams !== false;
}

const wsDiag = registerWorkspaceDiagnostics(connection, documents, state);
const indexLifecycle = registerIndexLifecycle(connection, documents, state, wsDiag);
registerViewRequests(connection, documents, state);
registerMcpRequests(connection, documents, state);

connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
  state.workspaceFolders = (params.workspaceFolders ?? [])
    .map((f) => safeFsPath(f.uri))
    .filter((p): p is string => !!p);
  if (!state.workspaceFolders.length && params.rootUri) {
    const p = safeFsPath(params.rootUri);
    if (p) state.workspaceFolders = [p];
  }
  applySettings(params.initializationOptions);
  state.canRegisterWatchers = !!params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration;

  const wasmDir = join(__dirname, 'wasm');
  state.parsers = await ParserService.create({
    runtimeWasmDir: wasmDir,
    nedWasmPath: join(wasmDir, 'tree-sitter-ned.wasm'),
    msgWasmPath: join(wasmDir, 'tree-sitter-msg.wasm'),
  });
  state.store = new DocumentModelStore(state.parsers);
  state.index = new ProjectIndex(new NodeFileSystem(), state.parsers, join(__dirname, 'config'));
  // open documents are owned by the store; protect them from the disk scanner
  state.index.setOpenPredicate((uri) => documents.get(uri) !== undefined);

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

connection.onInitialized(async () => {
  if (!state.index) return;
  try {
    await state.index.initialize(state.workspaceFolders, currentNedPathDirs(state));
    indexLifecycle.logIndexStatus();
    await indexLifecycle.registerExternalWatchers();
  } catch (e) {
    connection.console.error(`OMNeT++ indexing failed: ${(e as Error).message}`);
  }
  // refresh diagnostics for any already-open documents, then publish markers for
  // every other indexed file so the Problems view reflects the whole workspace.
  for (const doc of documents.all()) wsDiag.refresh(doc);
  wsDiag.publishWorkspaceDiagnostics();
});

documents.onDidChangeContent((e) => {
  const lang = languageOfDoc(e.document);
  if (lang === 'ini') {
    state.store?.update(e.document); // cheap parse now; defer (heavier) analysis
    wsDiag.scheduleIni(e.document.uri);
    return;
  }
  wsDiag.refresh(e.document);
  if (lang === 'ned') wsDiag.refreshAll('ned', e.document.uri);
  else if (lang === 'msg') wsDiag.refreshAll('msg', e.document.uri);
  // an edit can introduce/clear errors in *closed* files that reference this one
  wsDiag.scheduleWorkspaceDiagnostics();
});
documents.onDidClose((e) => {
  state.store?.remove(e.document.uri);
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
  wsDiag.forgetDiagUri(e.document.uri);
  // re-sync the index to the on-disk version of the now-closed file
  const lang = languageOfDoc(e.document);
  if (state.index && (lang === 'ned' || lang === 'msg')) {
    void state.index.onFileChanged(e.document.uri, false);
  }
  // the file stays in the index (now disk-backed) — re-publish its markers
  wsDiag.scheduleWorkspaceDiagnostics();
});

connection.onDidChangeConfiguration((change) => {
  const before = `${state.nedPathSetting}\0${state.installDir}`;
  const beforeScope = state.diagnosticsScope;
  const beforeIniLens = state.iniParamCodeLensEnabled;
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
  const after = `${state.nedPathSetting}\0${state.installDir}`;
  if (before !== after) indexLifecycle.scheduleReindex(); // re-discover roots with the new path/install dir
  if (state.diagnosticsScope !== beforeScope) {
    if (state.diagnosticsScope === 'workspace') wsDiag.publishWorkspaceDiagnostics();
    else wsDiag.clearWorkspaceDiagnostics();
  }
  // toggle the ini param lenses live (pull-based: ask the client to re-query)
  if (state.iniParamCodeLensEnabled !== beforeIniLens) void connection.sendRequest(CodeLensRefreshRequest.type);
});

connection.onDocumentSymbol((params) => {
  const parsed = state.store?.get(params.textDocument.uri);
  if (!parsed) return [];
  return computeDocumentSymbols(parsed) as unknown as LspDocumentSymbol[];
});

connection.onWorkspaceSymbol((params) => {
  if (!state.index) return [];
  return workspaceSymbols(params.query, {
    nedCache: state.index.cache,
    msgCache: state.index.msgCache,
    iniCache: state.index.iniCache,
  }).map((s) => ({ name: s.name, kind: s.kind, location: s.location, containerName: s.containerName }));
});

connection.onFoldingRanges((params) => {
  const parsed = state.store?.get(params.textDocument.uri);
  if (!parsed) return [];
  return computeFoldingRanges(parsed) as unknown as LspFoldingRange[];
});

connection.onDefinition((params) => {
  const parsed = state.store?.get(params.textDocument.uri);
  const c = ctx(state);
  if (!parsed || !c) return null;
  return computeDefinition(parsed, params.position, c, state.currentActiveNetwork);
});

connection.onHover((params) => {
  const parsed = state.store?.get(params.textDocument.uri);
  const c = ctx(state);
  if (!parsed || !c) return null;
  const h = computeHover(parsed, params.position, c, state.currentActiveNetwork);
  if (!h) return null;
  return { contents: { kind: MarkupKind.Markdown, value: h.markdown }, range: h.range };
});

connection.onReferences((params) => {
  const parsed = state.store?.get(params.textDocument.uri);
  const c = ctx(state);
  if (!parsed || !c) return [];
  return computeReferences(parsed, params.position, params.context.includeDeclaration, c, state.currentActiveNetwork);
});

connection.onCompletion((params) => {
  const parsed = state.store?.get(params.textDocument.uri);
  const c = ctx(state);
  if (!parsed || !c) return [];
  return computeCompletion(parsed, params.position, c);
});

connection.onCodeLens((params): LspCodeLens[] => {
  const parsed = state.store?.get(params.textDocument.uri);
  const c = ctx(state);
  if (!parsed || !c) return [];
  return computeCodeLenses(parsed, c, {
    iniParamLens: state.iniParamCodeLensEnabled,
    fallbackNetwork: state.currentActiveNetwork,
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
  const parsed = state.store?.get(params.textDocument.uri);
  const c = ctx(state);
  if (!parsed || !c) return null;
  return computePrepareRename(parsed, params.position, c);
});

connection.onRenameRequest((params) => {
  const parsed = state.store?.get(params.textDocument.uri);
  const c = ctx(state);
  if (!parsed || !c) return null;
  return computeRename(parsed, params.position, params.newName, c);
});

connection.onDocumentHighlight((params) => {
  const parsed = state.store?.get(params.textDocument.uri);
  const c = ctx(state);
  if (!parsed || !c) return [];
  return computeDocumentHighlights(parsed, params.position, c);
});

connection.onCodeAction((params) => {
  const parsed = state.store?.get(params.textDocument.uri);
  const c = ctx(state);
  if (!parsed || !c) return [];
  return computeCodeActions(parsed, c, params.context.diagnostics).map((a) => ({
    title: a.title,
    kind: a.kind,
    edit: a.edit,
  }));
});

connection.languages.typeHierarchy.onPrepare((params) => {
  const parsed = state.store?.get(params.textDocument.uri);
  const c = ctx(state);
  if (!parsed || !c) return null;
  const item = computePrepareTypeHierarchy(parsed, params.position, c);
  return item ? [toTypeHierarchyItem(item)] : null;
});

connection.languages.typeHierarchy.onSupertypes((params) => {
  const c = ctx(state);
  const fq = fqNameOf(params.item);
  if (!c || !fq) return null;
  return computeTypeHierarchySupertypes(fq, c).map(toTypeHierarchyItem);
});

connection.languages.typeHierarchy.onSubtypes((params) => {
  const c = ctx(state);
  const fq = fqNameOf(params.item);
  if (!c || !fq) return null;
  return computeTypeHierarchySubtypes(fq, c).map(toTypeHierarchyItem);
});

connection.onDocumentFormatting((params) => {
  const parsed = state.store?.get(params.textDocument.uri);
  if (!parsed) return [];
  return computeFormatting(parsed, {
    tabSize: params.options.tabSize,
    insertSpaces: params.options.insertSpaces,
  });
});

documents.listen(connection);
connection.listen();
