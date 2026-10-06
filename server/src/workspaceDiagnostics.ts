import type { Connection, TextDocuments, Diagnostic as LspDiagnostic } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { BUILTIN_URI } from '@omnetpp/shared';
import type { ParsedDocument } from './documentModel';
import { computeDiagnostics } from './features/diagnostics';
import { ServerState, ctx, isIgnoredDoc, isUnderWorkspace } from './serverState';

/**
 * The functions the rest of the server calls to keep diagnostics in sync: instant
 * recompute for open documents, plus debounced whole-workspace passes for closed
 * files (and cross-file errors they pick up).
 */
export interface WorkspaceDiagnosticsApi {
  /** Recompute + publish diagnostics for a single (just-parsed) open document. */
  refresh(doc: TextDocument): void;
  /** `refresh` every open document, after all of them have reached the index. */
  refreshOpenDocuments(): void;
  /** Recompute diagnostics for all open docs of a language (cross-file changed). */
  refreshAll(language: 'ned' | 'msg', exceptUri?: string): void;
  /** Start a pass that computes + publishes diagnostics for every indexed NED/MSG/INI file under the workspace; it runs in yielding slices and returns before it finishes. */
  publishWorkspaceDiagnostics(): void;
  /** Drop all workspace markers for files that aren't open. */
  clearWorkspaceDiagnostics(): void;
  /** Debounced trigger for `publishWorkspaceDiagnostics`. */
  scheduleWorkspaceDiagnostics(): void;
  /** Debounced index update + diagnostics recompute for one (heavier, INI) document. */
  scheduleIni(uri: string): void;
  /** Stop tracking a uri's published markers (e.g. once its document closes). */
  forgetDiagUri(uri: string): void;
}

// ---- Workspace-wide diagnostics -------------------------------------------
// By default the Problems view shows markers for *every* indexed file under the
// workspace, not just the active/open editors. `refresh()` keeps open files
// instantly up to date; the passes below cover closed files (and cross-file
// errors they pick up), and are debounced so editing stays responsive.

const SLICE_MS = 20;

export function registerWorkspaceDiagnostics(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  state: ServerState,
): WorkspaceDiagnosticsApi {
  /** URIs we last published *non-empty* diagnostics for, so we can clear their
   *  markers once a file becomes clean or drops out of the index. */
  const workspaceDiagUris = new Set<string>();

  /** Parse an open buffer into the store and the index; undefined if ignored. */
  function sync(doc: TextDocument): ParsedDocument | undefined {
    if (!state.store) return undefined;
    if (isIgnoredDoc(state, doc)) {
      state.store.remove(doc.uri);
      connection.sendDiagnostics({ uri: doc.uri, diagnostics: [] });
      return undefined;
    }
    const parsed = state.store.update(doc);
    if (state.index) {
      if (parsed.language === 'ini') state.index.updateOpenIniDocument(doc.uri, parsed.text);
      else if (parsed.language === 'ned' && parsed.tree) state.index.updateOpenDocument(doc.uri, parsed.text);
      else if (parsed.language === 'msg' && parsed.tree) state.index.updateOpenMsgDocument(doc.uri, parsed.text);
    }
    return parsed;
  }

  function publish(parsed: ParsedDocument): void {
    const diags = computeDiagnostics(parsed, ctx(state)) as LspDiagnostic[];
    connection.sendDiagnostics({ uri: parsed.uri, diagnostics: diags });
  }

  function refresh(doc: TextDocument): void {
    const parsed = sync(doc);
    if (parsed) publish(parsed);
  }

  // Open files depend on each other (NED types, INI networks), and the disk scan
  // skips them, so diagnostics must wait until every buffer is in the index.
  function refreshOpenDocuments(): void {
    const synced = documents.all().map(sync);
    for (const parsed of synced) if (parsed) publish(parsed);
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

  /** Bumped to cancel a running workspace pass; each pass checks it between slices. */
  let passGeneration = 0;

  /** Compute + publish diagnostics for every indexed NED/MSG/INI file under the
   *  workspace, clearing markers for files that are now clean. Open files are
   *  skipped: they are owned by `refresh()`/`scheduleIni`, which see unsaved edits
   *  the resident caches may not yet reflect.
   *
   *  On a large workspace (INET) the pass takes seconds, so it runs in short time
   *  slices and yields between them: otherwise every LSP request (hover,
   *  go-to-definition) queued behind it waits for the whole pass. A newer pass, a
   *  scope change or an edit cancels the running one, whose results would be stale. */
  function publishWorkspaceDiagnostics(): void {
    const gen = ++passGeneration;
    if (!state.index || state.index.scanning || state.diagnosticsScope !== 'workspace') return;
    const index = state.index;
    const c = ctx(state);
    // Pass the real source `text` (not '') so inline `suppress(...)` directives are
    // honored for closed files too — the suppress filter reads directives from it
    // (and short-circuits on `text` lacking "suppress"). NED/MSG text comes free from
    // the tree; INI text is retained by the cache. Only the URIs are snapshotted:
    // between slices the caches may replace or drop a file and free its tree, so
    // each item reads the current entry within its own slice.
    const work: (() => ParsedDocument | undefined)[] = [];
    for (const { uri } of index.cache.allFiles()) {
      if (uri === BUILTIN_URI || !isUnderWorkspace(state, uri)) continue;
      work.push(() => {
        const f = index.cache.getFile(uri);
        return f && { uri, language: 'ned', version: 0, text: f.tree.rootNode.text, tree: f.tree };
      });
    }
    for (const { uri } of index.msgCache.allFiles()) {
      if (!isUnderWorkspace(state, uri)) continue;
      work.push(() => {
        const f = index.msgCache.getFile(uri);
        return f && { uri, language: 'msg', version: 0, text: f.tree.rootNode.text, tree: f.tree };
      });
    }
    for (const { uri } of index.iniCache.allDocs()) {
      if (!isUnderWorkspace(state, uri)) continue;
      work.push(() => {
        const doc = index.iniCache.getDoc(uri);
        const text = index.iniCache.getText(uri);
        return doc && text !== undefined ? { uri, language: 'ini', version: 0, text, ini: doc } : undefined;
      });
    }

    const nextNonEmpty = new Set<string>();
    let next = 0;
    const step = (): void => {
      if (gen !== passGeneration || state.index !== index || index.scanning) return;
      const deadline = performance.now() + SLICE_MS;
      // at least one item per slice, so the pass always moves on
      for (let first = true; next < work.length && (first || performance.now() < deadline); first = false) {
        const parsed = work[next++]();
        if (!parsed || documents.get(parsed.uri)) continue;
        const diags = computeDiagnostics(parsed, c) as LspDiagnostic[];
        if (!diags.length) continue;
        nextNonEmpty.add(parsed.uri);
        // tracked right away so a later pass clears it even if this one is cancelled
        workspaceDiagUris.add(parsed.uri);
        connection.sendDiagnostics({ uri: parsed.uri, diagnostics: diags });
      }
      if (next < work.length) {
        setImmediate(step);
        return;
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
    };
    step();
  }

  /** Drop all workspace markers for files that aren't open (used when the scope
   *  setting flips back to open-files-only). Open files are owned by `refresh()`. */
  function clearWorkspaceDiagnostics(): void {
    passGeneration++;
    for (const uri of workspaceDiagUris) {
      if (!documents.get(uri)) connection.sendDiagnostics({ uri, diagnostics: [] });
    }
    workspaceDiagUris.clear();
  }

  let wsDiagTimer: NodeJS.Timeout | undefined;
  function scheduleWorkspaceDiagnostics(): void {
    if (state.diagnosticsScope !== 'workspace') return;
    passGeneration++; // the caches changed: a running pass would publish stale results
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
        state.index?.updateOpenIniDocument(uri, parsed.text);
        publish(parsed);
        // unused-network markers and cross-file INI references follow the buffer
        refreshAll('ned');
        scheduleWorkspaceDiagnostics();
      }, 300),
    );
  }

  function forgetDiagUri(uri: string): void {
    workspaceDiagUris.delete(uri);
  }

  return {
    refresh,
    refreshOpenDocuments,
    refreshAll,
    publishWorkspaceDiagnostics,
    clearWorkspaceDiagnostics,
    scheduleWorkspaceDiagnostics,
    scheduleIni,
    forgetDiagUri,
  };
}
