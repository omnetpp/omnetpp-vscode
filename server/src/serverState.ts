import { existsSync, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { ParserService, parseIni } from '@omnetpp/shared';
import type { ActiveConfig, IniDocument } from '@omnetpp/shared';
import { createNodeIconProvider, indexPath, listIconIds, uriToIndexPath } from '@omnetpp/shared/node';
import { DocumentModelStore } from './documentModel';
import { ProjectIndex } from './projectIndex';
import type { IndexContext } from './features/context';

/**
 * All server-wide mutable state. Created once in `server.ts` and threaded through
 * the register functions of the feature modules (`indexLifecycle`,
 * `workspaceDiagnostics`, `viewRequests`, `mcpRequests`) instead of living as bare
 * module-level variables.
 */
export class ServerState {
  parsers: ParserService | undefined;
  store: DocumentModelStore | undefined;
  index: ProjectIndex | undefined;
  workspaceFolders: string[] = [];
  nedPathSetting = '';
  installDir = '';
  /** Whether diagnostics are published for the whole workspace or only open files. */
  diagnosticsScope: 'openFiles' | 'workspace' = 'workspace';
  /** Whether to emit code lenses on INI parameter-assignment lines. */
  iniParamCodeLensEnabled = true;
  /** Whether the client declared dynamic-registration support for watched files. */
  canRegisterWatchers = false;
  /** Lazily-computed, cached icon-id list for display-string image completion
   *  (`i=`/`i2=`/`bgi=`, see `iconIds()`/`invalidateIconIds()` below) — undefined
   *  means "not computed yet"; recomputed on first use after a cache clear. */
  iconIdsCache: string[] | undefined;
  /** Lazily-created, cached icon provider for `completionItem/resolve`'s
   *  on-demand icon-preview embedding (`iconProvider()`/`invalidateIconProvider()`
   *  below) — undefined means "not created yet"; recreated on first use after
   *  a cache clear (same trigger as `iconIdsCache`, since both derive from the
   *  same icon search roots). */
  iconProviderCache: ReturnType<typeof createNodeIconProvider> | undefined;

  /**
   * The globally-selected active configuration, pushed by the client. Its effective
   * network is the fallback context for INI param navigation on lines whose own
   * section selects no network (e.g. `[General]`) — the "hybrid" rule.
   */
  currentActiveConfig: ActiveConfig | undefined;
  currentActiveNetwork: string | undefined;
}

/** Build the `IndexContext` the feature analyzers query against, from the current index. */
export function ctx(state: ServerState): IndexContext | undefined {
  if (!state.index) return undefined;
  const index = state.index;
  return {
    nedCache: index.cache,
    msgCache: index.msgCache,
    registry: index.configRegistry,
    db: index.db,
    iniCache: index.iniCache,
    // open buffer (unsaved edits) wins over the on-disk index
    getIniDoc: (uri: string) => state.store?.get(uri)?.ini ?? index.iniCache.getDoc(uri),
    iconIds: iconIds(state),
  };
}

/**
 * Ordered icon search roots: workspace `images/` dirs → `installDir/images` →
 * the bundled `dist/icons` snapshot. The exact construction `docsRequests.ts`
 * uses for doc-generation diagrams; reused here so display-string icon-name
 * completion (`iconIds` below) sees the same search order/precedence.
 */
export function iconDirs(state: ServerState): string[] {
  return [
    ...state.workspaceFolders.map((d) => join(d, 'images')).filter(existsSync),
    ...(state.installDir ? [join(state.installDir, 'images')] : []),
    join(__dirname, 'icons'),
  ];
}

/**
 * All available icon ids for display-string `i=`/`i2=`/`bgi=` completion,
 * computed once per session (or since the last `invalidateIconIds`) — a
 * filesystem walk on every completion request would be too slow since
 * completion fires on every keystroke.
 */
export function iconIds(state: ServerState): string[] {
  if (state.iconIdsCache === undefined) state.iconIdsCache = listIconIds(iconDirs(state));
  return state.iconIdsCache;
}

/** Drop the cached icon-id list; call after `installDir`/`workspaceFolders` change. */
export function invalidateIconIds(state: ServerState): void {
  state.iconIdsCache = undefined;
}

/**
 * The icon provider used to lazily embed a `data:image/...;base64,...` preview
 * when resolving a display-string icon-name completion item
 * (`server/src/features/completionResolve.ts`). Built once per session (or
 * since the last `invalidateIconProvider`) over the same search roots as
 * `iconIds()`, in `'embed'` mode so `.get()` returns self-contained data URIs.
 */
export function iconProvider(state: ServerState): ReturnType<typeof createNodeIconProvider> {
  if (state.iconProviderCache === undefined) {
    state.iconProviderCache = createNodeIconProvider({ iconDirs: iconDirs(state), emit: 'embed' });
  }
  return state.iconProviderCache;
}

/** Drop the cached icon provider; call after `installDir`/`workspaceFolders` change. */
export function invalidateIconProvider(state: ServerState): void {
  state.iconProviderCache = undefined;
}

export function currentNedPathDirs(state: ServerState): string[] {
  // The install dir itself is never a NED source root, so it is not added here.
  return state.nedPathSetting.split(/[;:]/).map((s) => s.trim()).filter(Boolean).map((s) => indexPath(s));
}

export function safeFsPath(uri: string): string | undefined {
  try {
    return uriToIndexPath(uri);
  } catch {
    return undefined;
  }
}

export function isUnderWorkspace(state: ServerState, uri: string): boolean {
  const p = safeFsPath(uri);
  if (!p) return false;
  return state.workspaceFolders.some(
    (root) => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`),
  );
}

export function languageOfDoc(doc: TextDocument): 'ned' | 'msg' | 'ini' | undefined {
  const u = doc.uri.toLowerCase();
  if (doc.languageId === 'OMNeT++ NED' || u.endsWith('.ned')) return 'ned';
  if (doc.languageId === 'OMNeT++ MSG' || u.endsWith('.msg')) return 'msg';
  if (doc.languageId === 'OMNeT++ INI' || u.endsWith('.ini')) return 'ini';
  return undefined;
}

/** An INI document outside every NED folder: the server provides no features for it. */
export function isIgnoredDoc(state: ServerState, doc: TextDocument): boolean {
  return languageOfDoc(doc) === 'ini' && !state.index?.isInNedFolder(doc.uri);
}

/** Parse an ini either from its open buffer (authoritative) or from disk. */
export async function iniDocFor(state: ServerState, uri: string): Promise<IniDocument | undefined> {
  const open = state.store?.get(uri);
  if (open?.ini) return open.ini;
  const p = safeFsPath(uri);
  if (!p) return undefined;
  try {
    return parseIni(await fsp.readFile(p, 'utf8'), uri);
  } catch {
    return undefined;
  }
}
