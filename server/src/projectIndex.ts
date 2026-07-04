import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BUILTIN_NED_TEXT,
  BUILTIN_URI,
  ConfigRegistry,
  CppResourceCache,
  FileSystem,
  IniResourceCache,
  MsgResourceCache,
  NedResourceCache,
  ParserService,
  ProjectLayout,
  SemanticDatabase,
  configSummaries,
  discoverProjectLayout,
  isCppSourceFile,
  isExcludedPackage,
  packageForFile,
  parseIni,
  rootForPath,
} from '@omnetpp/shared';

/** Outcome of a `revalidate()` pass: whether a full reindex is required and,
 *  if not, which languages had at least one file added/removed/changed. */
export interface RevalidateResult {
  needsReindex: boolean;
  nedChanged: boolean;
  msgChanged: boolean;
  iniChanged: boolean;
  cppChanged: boolean;
}

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
  readonly iniCache = new IniResourceCache();
  readonly cppCache = new CppResourceCache();
  /** Unified query surface over the caches + cross-reference graph. */
  readonly db = new SemanticDatabase(
    this.cache,
    this.msgCache,
    this.configRegistry,
    this.iniCache,
    this.cppCache,
  );
  private layout: ProjectLayout = { roots: [], excludedPackages: [] };
  /** Scanned INI files → number of named [Config] sections (for status reporting). */
  private iniConfigCounts = new Map<string, number>();
  /**
   * Disk-indexed files → their last-seen {mtimeMs,size}. Populated only for files
   * read from disk (never for open buffers, which the editor owns), so it doubles
   * as the authoritative set of disk-backed URIs for `revalidate()` reconciliation.
   */
  private fileMeta = new Map<string, { mtimeMs: number; size: number }>();

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
    this.fileMeta.clear();

    // built-in NED declarations (ned.IdealChannel, ...)
    this.cache.addFile(BUILTIN_URI, this.parsers.parse('ned', BUILTIN_NED_TEXT), 'ned');
    this.db.onNedFile(BUILTIN_URI);

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
      } else if (isCppSourceFile(name)) {
        await this.indexCppFile(full);
      }
    }
  }

  /** Stat `fsPath` and remember its {mtimeMs,size} for `revalidate()`. */
  private async recordMeta(uri: string, fsPath: string): Promise<void> {
    try {
      const st = await this.fs.stat(fsPath);
      this.fileMeta.set(uri, { mtimeMs: st.mtimeMs ?? 0, size: st.size ?? 0 });
    } catch {
      /* stat failed (raced deletion); leave meta absent so revalidate re-checks */
    }
  }

  /** Index an INI file into the workspace INI cache + record its config count. */
  async indexIniFile(fsPath: string): Promise<void> {
    const uri = pathToFileURL(fsPath).toString();
    if (this.isOpen(uri)) return; // open buffer owns the cache entry
    let text: string;
    try {
      text = await this.fs.readFile(fsPath);
    } catch {
      return;
    }
    this.iniCache.addFile(uri, text);
    this.iniConfigCounts.set(uri, configSummaries(parseIni(text)).length);
    this.db.onIniFile(uri);
    await this.recordMeta(uri, fsPath);
  }

  /** Update the INI index from an open document's text (for reverse queries). */
  updateOpenIniDocument(uri: string, text: string): void {
    this.iniCache.addFile(uri, text);
    this.iniConfigCounts.set(uri, configSummaries(parseIni(text)).length);
    this.db.onIniFile(uri);
  }

  /** Read and index a single C++ (.cc/.h) file from disk (by absolute fs path). */
  async indexCppFile(fsPath: string): Promise<void> {
    const uri = pathToFileURL(fsPath).toString();
    let text: string;
    try {
      text = await this.fs.readFile(fsPath);
    } catch {
      return;
    }
    this.cppCache.addFile(uri, text);
    this.db.onCppFile(uri);
    await this.recordMeta(uri, fsPath);
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
    this.db.onMsgFile(uri);
    await this.recordMeta(uri, fsPath);
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
    this.db.onNedFile(uri);
    await this.recordMeta(uri, fsPath);
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
      this.db.dropFile(uri);
      return;
    }
    this.cache.addFile(uri, this.parsers.parse('ned', text), pkg);
    this.db.onNedFile(uri);
  }

  /** Update the MSG index from an open document's text (cache owns its tree). */
  updateOpenMsgDocument(uri: string, text: string): void {
    this.msgCache.addFile(uri, this.parsers.parse('msg', text));
    this.db.onMsgFile(uri);
  }

  /** Re-read a changed file from disk; remove if deleted or gone. */
  async onFileChanged(uri: string, deleted: boolean): Promise<void> {
    const isMsg = uri.endsWith('.msg');
    const isIni = uri.endsWith('.ini');
    const isNed = uri.endsWith('.ned');
    const isCpp = !isMsg && !isIni && !isNed && isCppSourceFile(uri);
    let fsPath: string | undefined;
    try {
      fsPath = fileURLToPath(uri);
    } catch {
      return; // not a file uri
    }
    if (deleted || !(await this.fs.exists(fsPath))) {
      if (isMsg) {
        this.msgCache.removeFile(uri);
        this.db.dropFile(uri);
      } else if (isIni) {
        this.iniCache.removeFile(uri);
        this.iniConfigCounts.delete(uri);
        this.db.dropFile(uri);
      } else if (isCpp) {
        this.cppCache.removeFile(uri);
        this.db.dropFile(uri);
      } else {
        this.cache.removeFile(uri);
        this.db.dropFile(uri);
      }
      this.fileMeta.delete(uri);
      return;
    }
    if (isMsg) await this.indexMsgFile(fsPath);
    else if (isIni) await this.indexIniFile(fsPath);
    else if (isCpp) await this.indexCppFile(fsPath);
    else await this.indexFile(fsPath);
  }

  /** Re-discover the project layout and rebuild the index from scratch. */
  async reindex(workspaceFolders: string[], nedPathDirs: string[]): Promise<void> {
    this.cache.clear();
    this.msgCache.clear();
    this.iniCache.clear();
    this.cppCache.clear();
    this.db.clear();
    await this.initialize(workspaceFolders, nedPathDirs);
  }

  /** Serialize a layout to a stable key for cheap equality checks. */
  private static layoutKey(l: ProjectLayout): string {
    const roots = l.roots.map((r) => `${r.dir}\0${r.rootPackage}`).sort().join('\n');
    const excl = [...l.excludedPackages].sort().join('\n');
    return `${roots}\0\0${excl}`;
  }

  /**
   * Source roots that live outside every workspace folder (`nedPath` dirs and any
   * install-dir roots). VS Code's workspace-glob watchers don't cover these, so the
   * server registers watchers for them explicitly (see `registerExternalWatchers`).
   */
  externalRootDirs(workspaceFolders: string[]): string[] {
    const inWorkspace = (dir: string): boolean =>
      workspaceFolders.some((w) => dir === w || dir.startsWith(w.endsWith('/') ? w : `${w}/`));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of this.layout.roots) {
      if (inWorkspace(r.dir) || seen.has(r.dir)) continue;
      seen.add(r.dir);
      out.push(r.dir);
    }
    return out;
  }

  /** Recursively collect indexable files under `dir` (stat-only, no parse), keyed
   *  by URI. Mirrors `scanDir`'s skip rules so the disk view matches the index. */
  private async collectDiskFiles(
    dir: string,
    out: Map<string, { mtimeMs: number; size: number }>,
  ): Promise<void> {
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
        await this.collectDiskFiles(full, out);
      } else if (
        name.endsWith('.ned') ||
        name.endsWith('.msg') ||
        name.endsWith('.ini') ||
        isCppSourceFile(name)
      ) {
        out.set(pathToFileURL(full).toString(), { mtimeMs: stat.mtimeMs ?? 0, size: stat.size ?? 0 });
      }
    }
  }

  /**
   * Self-healing reconciliation against disk, independent of file-watch events.
   * Catches changes missed when a background process (git checkout/reset, a build)
   * rewrites many files and the editor's watcher drops or coalesces events.
   *
   * If the project *layout* changed (roots/exclusions), a full reindex is needed,
   * so this returns `{ needsReindex: true }` and does nothing else. Otherwise it
   * stats every root, then adds/removes/re-reads only the files that actually
   * differ from `fileMeta`. Open buffers are never touched (the editor owns them).
   */
  async revalidate(
    workspaceFolders: string[],
    nedPathDirs: string[],
  ): Promise<RevalidateResult> {
    const fresh = await discoverProjectLayout(this.fs, workspaceFolders, nedPathDirs);
    if (ProjectIndex.layoutKey(fresh) !== ProjectIndex.layoutKey(this.layout)) {
      return {
        needsReindex: true,
        nedChanged: false,
        msgChanged: false,
        iniChanged: false,
        cppChanged: false,
      };
    }

    const disk = new Map<string, { mtimeMs: number; size: number }>();
    for (const root of this.layout.roots) await this.collectDiskFiles(root.dir, disk);

    const result: RevalidateResult = {
      needsReindex: false,
      nedChanged: false,
      msgChanged: false,
      iniChanged: false,
      cppChanged: false,
    };
    const mark = (uri: string): void => {
      if (uri.endsWith('.msg')) result.msgChanged = true;
      else if (uri.endsWith('.ini')) result.iniChanged = true;
      else if (uri.endsWith('.ned')) result.nedChanged = true;
      else if (isCppSourceFile(uri)) result.cppChanged = true;
    };

    // added or modified (present on disk, missing from / differing in fileMeta)
    for (const [uri, cur] of disk) {
      if (this.isOpen(uri)) continue; // editor owns open buffers
      const prev = this.fileMeta.get(uri);
      if (prev && prev.mtimeMs === cur.mtimeMs && prev.size === cur.size) continue;
      await this.onFileChanged(uri, false);
      mark(uri);
    }
    // deleted (tracked in fileMeta but gone from disk)
    for (const uri of [...this.fileMeta.keys()]) {
      if (disk.has(uri) || this.isOpen(uri)) continue;
      await this.onFileChanged(uri, true);
      mark(uri);
    }
    return result;
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
