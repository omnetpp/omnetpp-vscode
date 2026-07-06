import { fileURLToPath } from 'node:url';
import { promises as fsp } from 'node:fs';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { ParserService, parseIni } from '@omnetpp/shared';
import type { ActiveConfig, IniDocument } from '@omnetpp/shared';
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
  };
}

export function currentNedPathDirs(state: ServerState): string[] {
  // The install dir itself is never a NED source root, so it is not added here.
  return state.nedPathSetting.split(/[;:]/).map((s) => s.trim()).filter(Boolean);
}

export function safeFsPath(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

export function languageOfDoc(doc: TextDocument): 'ned' | 'msg' | 'ini' | undefined {
  const u = doc.uri.toLowerCase();
  if (doc.languageId === 'OMNeT++ NED' || u.endsWith('.ned')) return 'ned';
  if (doc.languageId === 'OMNeT++ MSG' || u.endsWith('.msg')) return 'msg';
  if (doc.languageId === 'OMNeT++ INI' || u.endsWith('.ini')) return 'ini';
  return undefined;
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
