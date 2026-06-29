import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  configSummaries,
  discoverProjectLayout,
  isExcludedPackage,
  packageForFile,
  parseIni,
  rootForPath,
} from '@omnetpp/shared';

/** Per-source-root index statistics, reported in the server log. */
export interface RootStats {
  dir: string;
  rootPackage: string;
  nedTypes: number;
  msgFiles: number;
  iniFiles: number;
  iniConfigs: number;
}

/**
 * Owns the project-wide NED type index. Discovers source roots, scans NED files
 * from disk, and keeps the cache in sync with open documents and file changes.
 */
export class ProjectIndex {
  readonly cache = new NedResourceCache();
  readonly msgCache = new MsgResourceCache();
  readonly configRegistry = new ConfigRegistry();
  /** Unified query surface over the caches + cross-reference graph. */
  readonly db = new SemanticDatabase(this.cache, this.msgCache, this.configRegistry);
  private layout: ProjectLayout = { roots: [], excludedPackages: [] };
  /** Scanned INI files → number of named [Config] sections (for status reporting). */
  private iniConfigCounts = new Map<string, number>();

  /** Predicate: is this uri currently open in an editor? Open docs are driven by
   *  the document store, so the disk scanner must not overwrite them. */
  private isOpen: (uri: string) => boolean = () => false;

  constructor(
    private fs: FileSystem,
    private parsers: ParserService,
    private configDir: string,
  ) {}

  setOpenPredicate(fn: (uri: string) => boolean): void {
    this.isOpen = fn;
  }

  /** Discover source roots and index all NED and MSG files on disk. */
  async initialize(workspaceFolders: string[], nedPathDirs: string[]): Promise<void> {
    this.iniConfigCounts.clear();

    // built-in NED declarations (ned.IdealChannel, ...)
    this.cache.addFile(BUILTIN_URI, this.parsers.parse('ned', BUILTIN_NED_TEXT), 'ned');

    // built-in MSG/sim type names
    try {
      const json = JSON.parse(await this.fs.readFile(join(this.configDir, 'msg-builtin-types.json')));
      this.msgCache.setBuiltins(json.types ?? []);
    } catch {
      /* builtins optional */
    }

    // config-option registry snapshot
    try {
      const json = JSON.parse(await this.fs.readFile(join(this.configDir, 'opp-config-options.json')));
      this.configRegistry.load(json.options ?? []);
    } catch {
      /* registry optional */
    }

    this.layout = await discoverProjectLayout(this.fs, workspaceFolders, nedPathDirs);
    for (const root of this.layout.roots) {
      await this.scanDir(root.dir);
    }
  }

  private async scanDir(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await this.fs.readDirectory(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.') || name === 'node_modules' || name === 'out') continue;
      const full = `${dir}/${name}`;
      let stat;
      try {
        stat = await this.fs.stat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory) {
        await this.scanDir(full);
      } else if (name.endsWith('.ned')) {
        await this.indexFile(full);
      } else if (name.endsWith('.msg')) {
        await this.indexMsgFile(full);
      } else if (name.endsWith('.ini')) {
        await this.indexIniFile(full);
      }
    }
  }

  /** Record an INI file's named-config count for status reporting. */
  async indexIniFile(fsPath: string): Promise<void> {
    const uri = pathToFileURL(fsPath).toString();
    let text: string;
    try {
      text = await this.fs.readFile(fsPath);
    } catch {
      return;
    }
    this.iniConfigCounts.set(uri, configSummaries(parseIni(text)).length);
  }

  /** Read and index a single MSG file from disk (by absolute fs path). */
  async indexMsgFile(fsPath: string): Promise<void> {
    const uri = pathToFileURL(fsPath).toString();
    if (this.isOpen(uri)) return; // open buffer owns the cache entry
    let text: string;
    try {
      text = await this.fs.readFile(fsPath);
    } catch {
      return;
    }
    this.msgCache.addFile(uri, this.parsers.parse('msg', text));
  }

  /** Read and index a single NED file from disk (by absolute fs path). */
  async indexFile(fsPath: string): Promise<void> {
    const uri = pathToFileURL(fsPath).toString();
    if (this.isOpen(uri)) return; // open buffer owns the cache entry
    const pkg = packageForFile(this.layout.roots, fsPath);
    if (pkg && isExcludedPackage(this.layout.excludedPackages, pkg)) return;
    let text: string;
    try {
      text = await this.fs.readFile(fsPath);
    } catch {
      return;
    }
    this.cache.addFile(uri, this.parsers.parse('ned', text), pkg);
  }

  /**
   * Update the NED index from an open document's text. The cache parses and owns
   * its own tree (separate from the document store's), so neither can free a tree
   * the other still references.
   */
  updateOpenDocument(uri: string, text: string): void {
    const pkg = this.folderPackageForUri(uri);
    if (pkg && isExcludedPackage(this.layout.excludedPackages, pkg)) {
      this.cache.removeFile(uri); // respect exclusions even for open buffers
      return;
    }
    this.cache.addFile(uri, this.parsers.parse('ned', text), pkg);
  }

  /** Update the MSG index from an open document's text (cache owns its tree). */
  updateOpenMsgDocument(uri: string, text: string): void {
    this.msgCache.addFile(uri, this.parsers.parse('msg', text));
  }

  /** Re-read a changed file from disk; remove if deleted or gone. */
  async onFileChanged(uri: string, deleted: boolean): Promise<void> {
    const isMsg = uri.endsWith('.msg');
    let fsPath: string | undefined;
    try {
      fsPath = fileURLToPath(uri);
    } catch {
      return; // not a file uri
    }
    if (deleted || !(await this.fs.exists(fsPath))) {
      if (isMsg) this.msgCache.removeFile(uri);
      else this.cache.removeFile(uri);
      return;
    }
    if (isMsg) await this.indexMsgFile(fsPath);
    else await this.indexFile(fsPath);
  }

  /** Re-discover the project layout and rebuild the index from scratch. */
  async reindex(workspaceFolders: string[], nedPathDirs: string[]): Promise<void> {
    this.cache.clear();
    this.msgCache.clear();
    this.db.clear();
    await this.initialize(workspaceFolders, nedPathDirs);
  }

  folderPackageForUri(uri: string): string {
    try {
      return packageForFile(this.layout.roots, fileURLToPath(uri));
    } catch {
      return '';
    }
  }

  /**
   * Per-source-root counts of indexed NED types, MSG files, and INI files/configs.
   * The root list is the effective NED path actually scanned (workspace-discovered
   * roots plus `nedPath` entries). Built-ins and files outside any root are omitted.
   */
  stats(): RootStats[] {
    const byDir = new Map<string, RootStats>();
    const order: RootStats[] = [];
    for (const r of this.layout.roots) {
      if (byDir.has(r.dir)) continue;
      const s: RootStats = {
        dir: r.dir,
        rootPackage: r.rootPackage,
        nedTypes: 0,
        msgFiles: 0,
        iniFiles: 0,
        iniConfigs: 0,
      };
      byDir.set(r.dir, s);
      order.push(s);
    }
    const statFor = (uri: string): RootStats | undefined => {
      let fsPath: string;
      try {
        fsPath = fileURLToPath(uri);
      } catch {
        return undefined; // non-file uri (e.g. the NED built-ins)
      }
      const root = rootForPath(this.layout.roots, fsPath);
      return root ? byDir.get(root.dir) : undefined;
    };

    for (const f of this.cache.allFiles()) {
      if (f.uri === BUILTIN_URI) continue;
      const s = statFor(f.uri);
      if (s) s.nedTypes += this.cache.typesInFile(f.uri).length;
    }
    for (const f of this.msgCache.allFiles()) {
      const s = statFor(f.uri);
      if (s) s.msgFiles++;
    }
    for (const [uri, configs] of this.iniConfigCounts) {
      const s = statFor(uri);
      if (s) {
        s.iniFiles++;
        s.iniConfigs += configs;
      }
    }
    return order;
  }
}
