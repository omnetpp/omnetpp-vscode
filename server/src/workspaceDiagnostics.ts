import type { Connection, TextDocuments, Diagnostic as LspDiagnostic } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { BUILTIN_URI } from '@omnetpp/shared';
import type { ParsedDocument } from './documentModel';
import { computeDiagnostics } from './features/diagnostics';
import { ServerState, ctx, safeFsPath } from './serverState';

/**
 * The functions the rest of the server calls to keep diagnostics in sync: instant
 * recompute for open documents, plus debounced whole-workspace passes for closed
 * files (and cross-file errors they pick up).
 */
export interface WorkspaceDiagnosticsApi {
  /** Recompute + publish diagnostics for a single (just-parsed) open document. */
  refresh(doc: TextDocument): void;
  /** Recompute diagnostics for all open docs of a language (cross-file changed). */
  refreshAll(language: 'ned' | 'msg', exceptUri?: string): void;
  /** Compute + publish diagnostics for every indexed NED/MSG/INI file under the workspace. */
  publishWorkspaceDiagnostics(): void;
  /** Drop all workspace markers for files that aren't open. */
  clearWorkspaceDiagnostics(): void;
  /** Debounced trigger for `publishWorkspaceDiagnostics`. */
  scheduleWorkspaceDiagnostics(): void;
  /** Debounced diagnostics recompute for one (heavier, INI) document. */
  scheduleIni(uri: string): void;
  /** Stop tracking a uri's published markers (e.g. once its document closes). */
  forgetDiagUri(uri: string): void;
}

// ---- Workspace-wide diagnostics -------------------------------------------
// By default the Problems view shows markers for *every* indexed file under the
// workspace, not just the active/open editors. `refresh()` keeps open files
// instantly up to date; the passes below cover closed files (and cross-file
// errors they pick up), and are debounced so editing stays responsive.

export function registerWorkspaceDiagnostics(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  state: ServerState,
): WorkspaceDiagnosticsApi {
  /** URIs we last published *non-empty* diagnostics for, so we can clear their
   *  markers once a file becomes clean or drops out of the index. */
  const workspaceDiagUris = new Set<string>();

  function isUnderWorkspace(uri: string): boolean {
    const p = safeFsPath(uri);
    if (!p) return false;
    return state.workspaceFolders.some(
      (root) => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`),
    );
  }

  function refresh(doc: TextDocument): void {
    if (!state.store) return;
    const parsed = state.store.update(doc);
    if (state.index && parsed.tree) {
      if (parsed.language === 'ned') state.index.updateOpenDocument(doc.uri, parsed.text);
      else if (parsed.language === 'msg') state.index.updateOpenMsgDocument(doc.uri, parsed.text);
      else if (parsed.language === 'ini') state.index.updateOpenIniDocument(doc.uri, parsed.text);
    }
    const diags = computeDiagnostics(parsed, ctx(state)) as LspDiagnostic[];
    connection.sendDiagnostics({ uri: doc.uri, diagnostics: diags });
  }

  function refreshAll(language: 'ned' | 'msg', exceptUri?: string): void {
    if (!state.store) return;
    for (const doc of documents.all()) {
      if (doc.uri === exceptUri) continue; // already refreshed by the caller
      const parsed = state.store.get(doc.uri);
      if (parsed?.language === language) {
        const diags = computeDiagnostics(parsed, ctx(state)) as LspDiagnostic[];
        connection.sendDiagnostics({ uri: doc.uri, diagnostics: diags });
      }
    }
  }

  /** Compute + publish diagnostics for every indexed NED/MSG/INI file under the
   *  workspace, clearing markers for files that are now clean. Open files are
   *  skipped: they are owned by `refresh()`/`scheduleIni`, which see unsaved edits
   *  the resident caches may not yet reflect. */
  function publishWorkspaceDiagnostics(): void {
    if (!state.index || state.diagnosticsScope !== 'workspace') return;
    const c = ctx(state);
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
    for (const f of state.index.cache.allFiles()) {
      if (f.uri === BUILTIN_URI) continue;
      publish(f.uri, { uri: f.uri, language: 'ned', version: 0, text: f.tree.rootNode.text, tree: f.tree });
    }
    for (const f of state.index.msgCache.allFiles()) {
      publish(f.uri, { uri: f.uri, language: 'msg', version: 0, text: f.tree.rootNode.text, tree: f.tree });
    }
    for (const { uri, doc, text } of state.index.iniCache.allDocs()) {
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
    if (state.diagnosticsScope !== 'workspace') return;
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
        const parsed = state.store?.get(uri);
        if (!parsed) return;
        const diags = computeDiagnostics(parsed, ctx(state)) as LspDiagnostic[];
        connection.sendDiagnostics({ uri, diagnostics: diags });
      }, 300),
    );
  }

  function forgetDiagUri(uri: string): void {
    workspaceDiagUris.delete(uri);
  }

  return {
    refresh,
    refreshAll,
    publishWorkspaceDiagnostics,
    clearWorkspaceDiagnostics,
    scheduleWorkspaceDiagnostics,
    scheduleIni,
    forgetDiagUri,
  };
}
