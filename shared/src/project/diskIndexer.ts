// Host-agnostic building blocks for constructing a project index from disk.
// Owns the pieces every disk-backed index needs — builtin bootstrap, the
// recursive source-root walk with its skip rules, and the canonical
// SemanticDatabase population order — so the LSP server's incremental
// ProjectIndex and the standalone MCP/lint index builder share one
// implementation instead of drifting copies.
//
// Everything here goes through the injected FileSystem; no Node APIs. Paths
// are plain absolute fs paths (callers convert to URIs as needed), and the
// builtin-JSON paths are built with '/' concatenation, which node's fs accepts
// on every platform.
import type { FileStat, FileSystem } from '../fs/fileSystem';
import type { ParserService } from '../parser/parserService';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { MsgResourceCache } from '../msg/msgResourceCache';
import { ConfigRegistry } from '../ini/configRegistry';
import type { IniResourceCache } from '../ini/iniResourceCache';
import type { CppResourceCache } from '../cpp/cppResourceCache';
import type { SemanticDatabase } from '../xref/semanticDatabase';
import { isCppSourceFile } from '../cpp/cppScanner';
import { isInNedFolder, type ProjectLayout } from './projectModel';

/** {mtimeMs,size} change signal recorded per disk file (see `FileStat`). */
export interface DiskFileMeta {
  mtimeMs: number;
  size: number;
}

/** Per-language handlers invoked by `scanSourceRoots` with absolute fs paths. */
export interface DiskFileSink {
  ned(fsPath: string): Promise<void>;
  msg(fsPath: string): Promise<void>;
  ini(fsPath: string): Promise<void>;
  cpp(fsPath: string): Promise<void>;
}

/** Skip rules common to every disk scan: dot entries, node_modules, out. */
function isSkippedEntry(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules' || name === 'out';
}

/** The language a file is indexed as, or undefined if it is not indexed. NED
 *  and INI files in excluded packages are not indexed. */
function indexedKind(layout: ProjectLayout, fsPath: string, name: string): keyof DiskFileSink | undefined {
  if (name.endsWith('.ned')) return isInNedFolder(layout, fsPath) ? 'ned' : undefined;
  if (name.endsWith('.msg')) return 'msg';
  if (name.endsWith('.ini')) return isInNedFolder(layout, fsPath) ? 'ini' : undefined;
  if (isCppSourceFile(name)) return 'cpp';
  return undefined;
}

/** Recursive walk under `dir`; `visit()` gets every surviving non-directory
 *  entry. Unreadable directories and unstattable entries are silently skipped. */
async function walkDir(
  fs: FileSystem,
  dir: string,
  visit: (fsPath: string, name: string, stat: FileStat) => Promise<void>,
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readDirectory(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (isSkippedEntry(name)) continue;
    const full = `${dir}/${name}`;
    let stat: FileStat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (stat.isDirectory) {
      await walkDir(fs, full, visit);
    } else {
      await visit(full, name, stat);
    }
  }
}

/**
 * Builtin bootstrap shared by every index: the built-in NED declarations
 * (ned.IdealChannel, ...), the optional MSG/sim builtin type names
 * (`msg-builtin-types.json` → `msgCache.setBuiltins`), and the optional
 * config-option registry snapshot (`opp-config-options.json` →
 * `configRegistry.load`). Notifying the SemanticDatabase about BUILTIN_URI is
 * the caller's job (the server does it immediately; the batch builder does it
 * via `populateDatabase`).
 */
export async function loadBuiltins(
  fs: FileSystem,
  parsers: ParserService,
  configDir: string,
  into: {
    nedCache: NedResourceCache;
    msgCache: MsgResourceCache;
    configRegistry: ConfigRegistry;
  },
): Promise<void> {
  into.nedCache.addFile(BUILTIN_URI, parsers.parse('ned', BUILTIN_NED_TEXT), 'ned');

  try {
    const json = JSON.parse(await fs.readFile(`${configDir}/msg-builtin-types.json`));
    into.msgCache.setBuiltins(json.types ?? []);
  } catch {
    /* builtins optional */
  }

  try {
    const json = JSON.parse(await fs.readFile(`${configDir}/opp-config-options.json`));
    into.configRegistry.load(json.options ?? []);
  } catch {
    /* registry optional */
  }
}

/**
 * Walk every source root of the layout and dispatch each indexable file to the
 * sink by extension: `.ned` / `.msg` / `.ini` / C++ source (`isCppSourceFile`),
 * in that test order. Roots are visited in order, without dedup (a file under two
 * overlapping roots is dispatched twice, matching the historical behavior).
 */
export async function scanSourceRoots(
  fs: FileSystem,
  layout: ProjectLayout,
  sink: DiskFileSink,
): Promise<void> {
  for (const { dir } of layout.roots) {
    await walkDir(fs, dir, async (fsPath, name) => {
      const kind = indexedKind(layout, fsPath, name);
      if (kind) await sink[kind](fsPath);
    });
  }
}

/**
 * Stat-only collection of every indexable file under the roots, keyed by
 * absolute fs path. Uses the same walk + skip + extension rules as
 * `scanSourceRoots`, so the disk view always matches what the scanner would
 * index (used by the server's `revalidate()` reconciliation).
 */
export async function collectIndexableFiles(
  fs: FileSystem,
  layout: ProjectLayout,
): Promise<Map<string, DiskFileMeta>> {
  const out = new Map<string, DiskFileMeta>();
  for (const { dir } of layout.roots) {
    await walkDir(fs, dir, async (fsPath, name, stat) => {
      if (indexedKind(layout, fsPath, name)) {
        out.set(fsPath, { mtimeMs: stat.mtimeMs ?? 0, size: stat.size ?? 0 });
      }
    });
  }
  return out;
}

/**
 * Populate a SemanticDatabase from already-filled caches in the canonical
 * order: msg first so NED @class resolves eagerly, cpp before ned so `ned-impl`
 * resolves eagerly, ned before ini so `network=` resolves eagerly; the db's
 * drain covers any residual order.
 */
export function populateDatabase(
  db: SemanticDatabase,
  caches: {
    nedCache: NedResourceCache;
    msgCache: MsgResourceCache;
    iniCache: IniResourceCache;
    cppCache: CppResourceCache;
  },
): void {
  for (const f of caches.msgCache.allFiles()) db.onMsgFile(f.uri);
  for (const f of caches.cppCache.allFiles()) db.onCppFile(f.uri);
  for (const f of caches.nedCache.allFiles()) db.onNedFile(f.uri);
  for (const { uri } of caches.iniCache.allDocs()) db.onIniFile(uri);
}
