import {
  FileChangeType,
  DidChangeWatchedFilesNotification,
  WatchKind,
  type Connection,
  type TextDocuments,
  type Disposable,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { fileUri, isCppSourceFile, OmnetppMethods } from '@omnetpp/shared';
import { ServerState, currentNedPathDirs, refreshCodeLenses } from './serverState';
import type { WorkspaceDiagnosticsApi } from './workspaceDiagnostics';

/** The operations the rest of the server (and `onDidChangeConfiguration`) trigger
 *  to (re)build/reconcile the project index. */
export interface IndexLifecycleApi {
  /** Log where the OMNeT++ install was found, the effective NED path, and per-root
   *  index counts. */
  logIndexStatus(): void;
  /** Debounced full reindex (roots/exclusions may have changed). */
  scheduleReindex(): void;
  /** (Re-)register LSP watchers for source roots outside the workspace folders. */
  registerExternalWatchers(): Promise<void>;
  /** Debounced, single-flighted self-healing reconciliation against disk. */
  scheduleRevalidate(): void;
}

function isProjectConfigFile(uri: string): boolean {
  return /\/(\.nedfolders|\.nedexclusions|package\.ned)$/.test(uri);
}

/**
 * Wires up index (re)build orchestration: status logging, debounced reindex
 * scheduling, the self-healing revalidate subsystem, external-root watcher
 * registration, `workspace/didChangeWatchedFiles` handling, and the
 * `omnetpp/revalidate` notification handler.
 */
export function registerIndexLifecycle(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  state: ServerState,
  wsDiag: WorkspaceDiagnosticsApi,
): IndexLifecycleApi {
  /**
   * Log where the OMNeT++ install was found, the effective NED path (every source root
   * actually scanned, including auto-discovered ones), and per-root index counts.
   */
  function logIndexStatus(): void {
    if (!state.index) return;
    connection.console.info(
      state.installDir
        ? `OMNeT++ installation: ${state.installDir}`
        : 'OMNeT++ installation: not detected (set omnetpp.installDir, OMNETPP_ROOT or __omnetpp_root_dir)',
    );
    const roots = state.index.stats();
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
      `OMNeT++ index ready: ${state.index.cache.allTypeNames().length} NED types total.`,
    );
  }

  // ---- external-root file watching ------------------------------------------
  // VS Code's client-declared `synchronize.fileEvents` globs only watch files
  // inside the open workspace folders. Source roots from `omnetpp.nedPath` (and any
  // install-dir roots) live elsewhere, so the server registers watchers for them via
  // LSP dynamic registration. Re-run whenever the resolved roots may have changed
  // (startup and after every reindex) so setting changes re-scope the watchers.
  let externalWatchers: Disposable | undefined;

  async function registerExternalWatchers(): Promise<void> {
    if (!state.index || !state.canRegisterWatchers) return;
    const dirs = state.index.externalRootDirs(state.workspaceFolders);
    externalWatchers?.dispose(); // drop the previous set before installing a new one
    externalWatchers = undefined;
    if (!dirs.length) return;
    const watchers = dirs.map((dir) => ({
      globPattern: {
        baseUri: fileUri(dir),
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
      if (!state.index) return;
      try {
        await state.index.reindex(state.workspaceFolders, currentNedPathDirs(state));
        logIndexStatus();
        await registerExternalWatchers(); // roots may have changed → re-scope watchers
        // re-apply open buffers (the scan skips them) then refresh everything
        wsDiag.refreshOpenDocuments();
        wsDiag.publishWorkspaceDiagnostics();
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
    if (!state.index) return;
    if (revalidateRunning) {
      revalidatePending = true; // a trigger arrived mid-pass → run once more after
      return;
    }
    revalidateRunning = true;
    try {
      const r = await state.index.revalidate(state.workspaceFolders, currentNedPathDirs(state));
      if (r.needsReindex) {
        scheduleReindex(); // roots/exclusions changed → full rebuild
      } else if (r.nedChanged || r.msgChanged || r.iniChanged || r.cppChanged) {
        // reconciled closed files may change cross-file diagnostics for open docs
        if (r.nedChanged || r.iniChanged) wsDiag.refreshAll('ned');
        if (r.msgChanged) wsDiag.refreshAll('msg');
        // a C++ change alters NED reverse counts (CodeLens) — re-pull lenses and
        // re-lint NED (unused-member hints depend on C++ accesses)
        if (r.cppChanged) {
          wsDiag.refreshAll('ned');
          refreshCodeLenses(connection, state);
        }
        logIndexStatus();
        wsDiag.scheduleWorkspaceDiagnostics();
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
  connection.onNotification(OmnetppMethods.revalidate, () => scheduleRevalidate());

  connection.onDidChangeWatchedFiles(async (params) => {
    if (!state.index) return;
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
      await state.index.onFileChanged(change.uri, change.type === FileChangeType.Deleted);
      if (isNed) nedChanged = true;
      else if (isMsg) msgChanged = true;
      else if (isIni) iniChanged = true;
      else cppChanged = true;
    }
    if (layoutChanged) {
      scheduleReindex(); // re-discovers .nedfolders/.nedexclusions/package.ned
    } else {
      if (nedChanged || iniChanged) wsDiag.refreshAll('ned');
      if (msgChanged) wsDiag.refreshAll('msg');
      // a C++ change alters NED reverse counts (CodeLens) + unused-member hints
      if (cppChanged) {
        wsDiag.refreshAll('ned');
        refreshCodeLenses(connection, state);
      }
      // closed INI files have no open-doc refresh path; the workspace pass covers them
      if (nedChanged || msgChanged || iniChanged || cppChanged) wsDiag.scheduleWorkspaceDiagnostics();
    }
  });

  return { logIndexStatus, scheduleReindex, registerExternalWatchers, scheduleRevalidate };
}
