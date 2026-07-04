import { pathToFileURL } from 'node:url';
import {
  ConfigRegistry,
  CppResourceCache,
  FileSystem,
  IniResourceCache,
  MsgResourceCache,
  NedResourceCache,
  ParserService,
  SemanticDatabase,
  discoverProjectLayout,
  isExcludedPackage,
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
}

/**
 * Build a project index by scanning NED/MSG/INI/C++ files from disk. The
 * one-shot counterpart of the LSP server's ProjectIndex: same builtin
 * bootstrap, walk and skip rules (via shared's diskIndexer), but without the
 * live-document/watcher/revalidate machinery — a standalone, read-mostly
 * snapshot.
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
  await scanSourceRoots(fs, layout.roots.map((r) => r.dir), {
    ned: async (p) => {
      const pkg = packageForFile(layout.roots, p);
      if (pkg && isExcludedPackage(layout.excludedPackages, pkg)) return;
      try {
        nedCache.addFile(pathToFileURL(p).toString(), parsers.parse('ned', await fs.readFile(p)), pkg);
      } catch {
        /* unreadable file */
      }
    },
    msg: async (p) => {
      try {
        msgCache.addFile(pathToFileURL(p).toString(), parsers.parse('msg', await fs.readFile(p)));
      } catch {
        /* unreadable file */
      }
    },
    ini: async (p) => {
      try {
        iniCache.addFile(pathToFileURL(p).toString(), await fs.readFile(p));
      } catch {
        /* unreadable file */
      }
    },
    cpp: async (p) => {
      try {
        cppCache.addFile(pathToFileURL(p).toString(), await fs.readFile(p));
      } catch {
        /* unreadable file */
      }
    },
  });

  const db = new SemanticDatabase(nedCache, msgCache, configRegistry, iniCache, cppCache);
  populateDatabase(db, { nedCache, msgCache, iniCache, cppCache });
  return { nedCache, msgCache, configRegistry, iniCache, cppCache, db };
}
