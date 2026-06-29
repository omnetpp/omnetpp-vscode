import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BUILTIN_NED_TEXT,
  BUILTIN_URI,
  ConfigRegistry,
  FileSystem,
  MsgResourceCache,
  NedResourceCache,
  ParserService,
  ProjectLayout,
  SemanticDatabase,
  discoverProjectLayout,
  isExcludedPackage,
  packageForFile,
} from '@omnetpp/shared';

export interface DiskIndex {
  nedCache: NedResourceCache;
  msgCache: MsgResourceCache;
  configRegistry: ConfigRegistry;
  db: SemanticDatabase;
  layout: ProjectLayout;
}

/**
 * Build a project index by scanning NED/MSG files from disk. Mirrors the LSP
 * server's ProjectIndex.initialize but without the live-document machinery: a
 * standalone, read-mostly snapshot. INI files are read on demand by the tools,
 * so they are not indexed here.
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

  // built-in NED declarations (ned.IdealChannel, ...)
  nedCache.addFile(BUILTIN_URI, parsers.parse('ned', BUILTIN_NED_TEXT), 'ned');

  // built-in MSG/sim type names (optional)
  try {
    const json = JSON.parse(await fs.readFile(join(configDir, 'msg-builtin-types.json')));
    msgCache.setBuiltins(json.types ?? []);
  } catch {
    /* builtins optional */
  }

  // config-option registry snapshot (optional)
  try {
    const json = JSON.parse(await fs.readFile(join(configDir, 'opp-config-options.json')));
    configRegistry.load(json.options ?? []);
  } catch {
    /* registry optional */
  }

  const layout = await discoverProjectLayout(fs, workspaceFolders, nedPathDirs);

  const scan = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await fs.readDirectory(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.') || name === 'node_modules' || name === 'out') continue;
      const full = `${dir}/${name}`;
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory) {
        await scan(full);
      } else if (name.endsWith('.ned')) {
        const uri = pathToFileURL(full).toString();
        const pkg = packageForFile(layout.roots, full);
        if (pkg && isExcludedPackage(layout.excludedPackages, pkg)) continue;
        try {
          nedCache.addFile(uri, parsers.parse('ned', await fs.readFile(full)), pkg);
        } catch {
          /* unreadable file */
        }
      } else if (name.endsWith('.msg')) {
        const uri = pathToFileURL(full).toString();
        try {
          msgCache.addFile(uri, parsers.parse('msg', await fs.readFile(full)));
        } catch {
          /* unreadable file */
        }
      }
    }
  };

  for (const root of layout.roots) await scan(root.dir);
  const db = new SemanticDatabase(nedCache, msgCache, configRegistry);
  // populate the cross-reference graph (all types present → immediate resolution)
  for (const f of nedCache.allFiles()) db.onNedFile(f.uri);
  return { nedCache, msgCache, configRegistry, db, layout };
}
