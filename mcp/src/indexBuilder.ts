import {
  ConfigRegistry,
  CppResourceCache,
  FileSystem,
  IniResourceCache,
  MsgResourceCache,
  NedResourceCache,
  ParserService,
  ProjectLayout,
  SemanticDatabase,
  collectIndexableFiles,
  discoverProjectLayout,
  fileUri,
  loadBuiltins,
  packageForFile,
  populateDatabase,
  scanSourceRoots,
} from '@omnetpp/shared';

export interface DiskIndex {
  nedCache: NedResourceCache;
  msgCache: MsgResourceCache;
  configRegistry: ConfigRegistry;
  iniCache: IniResourceCache;
  cppCache: CppResourceCache;
  db: SemanticDatabase;
  layout: ProjectLayout;
  /** Indexed file URI → its path and {mtimeMs,size} at the last scan, for `refreshDiskIndex`. */
  fileMeta: Map<string, FileMeta>;
}

interface FileMeta {
  path: string;
  mtimeMs: number;
  size: number;
}

type FileKind = 'ned' | 'msg' | 'ini' | 'cpp';

function kindOf(path: string): FileKind {
  if (path.endsWith('.ned')) return 'ned';
  if (path.endsWith('.msg')) return 'msg';
  if (path.endsWith('.ini')) return 'ini';
  return 'cpp';
}

/** Read and parse one file into its cache. Unreadable files are skipped. */
async function addFile(fs: FileSystem, parsers: ParserService, index: DiskIndex, kind: FileKind, p: string): Promise<void> {
  let text: string;
  try {
    text = await fs.readFile(p);
  } catch {
    return;
  }
  const uri = fileUri(p);
  if (kind === 'ned') index.nedCache.addFile(uri, parsers.parse('ned', text), packageForFile(index.layout.roots, p));
  else if (kind === 'msg') index.msgCache.addFile(uri, parsers.parse('msg', text));
  else if (kind === 'ini') index.iniCache.addFile(uri, text);
  else index.cppCache.addFile(uri, text);
}

function removeFile(index: DiskIndex, uri: string): void {
  const kind = kindOf(uri);
  if (kind === 'ned') index.nedCache.removeFile(uri);
  else if (kind === 'msg') index.msgCache.removeFile(uri);
  else if (kind === 'ini') index.iniCache.removeFile(uri);
  else index.cppCache.removeFile(uri);
  index.db.dropFile(uri);
}

function layoutKey(l: ProjectLayout): string {
  const roots = l.roots.map((r) => `${r.dir}\0${r.rootPackage}`).sort().join('\n');
  return `${roots}\0\0${[...l.excludedPackages].sort().join('\n')}`;
}

async function diskMeta(fs: FileSystem, layout: ProjectLayout): Promise<Map<string, FileMeta>> {
  const meta = new Map<string, FileMeta>();
  for (const [path, m] of await collectIndexableFiles(fs, layout)) meta.set(fileUri(path), { path, ...m });
  return meta;
}

/**
 * Build a project index by scanning NED/MSG/INI/C++ files from disk. The
 * standalone counterpart of the LSP server's ProjectIndex: same builtin
 * bootstrap, walk and skip rules (via shared's diskIndexer), but without open
 * documents or file watchers; `refreshDiskIndex` catches up with disk changes.
 */
export async function buildDiskIndex(
  fs: FileSystem,
  parsers: ParserService,
  configDir: string,
  workspaceFolders: string[],
  nedPathDirs: string[],
): Promise<DiskIndex> {
  const nedCache = new NedResourceCache();
  const msgCache = new MsgResourceCache();
  const configRegistry = new ConfigRegistry();
  const iniCache = new IniResourceCache();
  const cppCache = new CppResourceCache();

  await loadBuiltins(fs, parsers, configDir, { nedCache, msgCache, configRegistry });

  const layout = await discoverProjectLayout(fs, workspaceFolders, nedPathDirs);
  const db = new SemanticDatabase(nedCache, msgCache, configRegistry, iniCache, cppCache);
  const index: DiskIndex = { nedCache, msgCache, configRegistry, iniCache, cppCache, db, layout, fileMeta: new Map() };
  // Stat before reading, so a file changed during the scan looks changed to the next refresh.
  index.fileMeta = await diskMeta(fs, layout);
  await scanSourceRoots(fs, layout, {
    ned: (p) => addFile(fs, parsers, index, 'ned', p),
    msg: (p) => addFile(fs, parsers, index, 'msg', p),
    ini: (p) => addFile(fs, parsers, index, 'ini', p),
    cpp: (p) => addFile(fs, parsers, index, 'cpp', p),
  });
  populateDatabase(db, { nedCache, msgCache, iniCache, cppCache });
  return index;
}

/**
 * Re-read the files that were added, changed (mtime or size) or deleted on disk
 * since the last scan. Returns false, without changing anything, when the project
 * layout itself changed (new or removed NED folders, package.ned, exclusions): the
 * caller must then rebuild the index with `buildDiskIndex`.
 */
export async function refreshDiskIndex(
  fs: FileSystem,
  parsers: ParserService,
  index: DiskIndex,
  workspaceFolders: string[],
  nedPathDirs: string[],
): Promise<boolean> {
  const layout = await discoverProjectLayout(fs, workspaceFolders, nedPathDirs);
  if (layoutKey(layout) !== layoutKey(index.layout)) return false;

  const disk = await diskMeta(fs, layout);
  const changed: string[] = [];
  for (const [uri, cur] of disk) {
    const prev = index.fileMeta.get(uri);
    if (!prev || prev.mtimeMs !== cur.mtimeMs || prev.size !== cur.size) changed.push(uri);
  }
  for (const uri of index.fileMeta.keys()) if (!disk.has(uri)) removeFile(index, uri);
  for (const uri of changed) await addFile(fs, parsers, index, kindOf(uri), disk.get(uri)!.path);
  index.fileMeta = disk;

  // Dependencies first, as in populateDatabase.
  const order: FileKind[] = ['msg', 'cpp', 'ned', 'ini'];
  for (const kind of order) {
    for (const uri of changed) {
      if (kindOf(uri) !== kind) continue;
      if (kind === 'msg') index.db.onMsgFile(uri);
      else if (kind === 'cpp') index.db.onCppFile(uri);
      else if (kind === 'ned') index.db.onNedFile(uri);
      else index.db.onIniFile(uri);
    }
  }
  return true;
}
