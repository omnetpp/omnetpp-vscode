import type { FileSystem } from '../fs/fileSystem';

export interface NedSourceRoot {
  /** Absolute directory path that is a NED source root. */
  dir: string;
  /** Root package name for this directory (from package.ned), '' if none. */
  rootPackage: string;
}

export interface ProjectLayout {
  roots: NedSourceRoot[];
  /** Excluded package names (from .nedfolders '-' lines or .nedexclusions). */
  excludedPackages: string[];
}

function joinPath(a: string, b: string): string {
  if (!b || b === '.') return a;
  if (a.endsWith('/')) return a + b;
  return a + '/' + b;
}

/** Parse a `package x.y;` declaration out of NED text. */
export function parsePackageDecl(text: string): string {
  const m = /(^|\n)\s*package\s+([A-Za-z_][\w.]*)\s*;/.exec(text);
  return m ? m[2] : '';
}

async function readRootPackage(fs: FileSystem, dir: string): Promise<string> {
  const pkgFile = joinPath(dir, 'package.ned');
  if (await fs.exists(pkgFile)) {
    try {
      return parsePackageDecl(await fs.readFile(pkgFile));
    } catch {
      /* ignore */
    }
  }
  return '';
}

/**
 * Discover NED source roots for the given workspace folders. Honors `.nedfolders`
 * (one folder per line; lines starting with '-' are excluded packages) and
 * `.nedexclusions`, falling back to treating the workspace folder as a single root.
 * Additional roots from the `nedPath` setting are appended.
 *
 * Ported from the Eclipse IDE's `ProjectUtils.readNedFoldersFile()`:
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/common/project/ProjectUtils.java
 */
export async function discoverProjectLayout(
  fs: FileSystem,
  workspaceFolders: string[],
  nedPathDirs: string[] = [],
): Promise<ProjectLayout> {
  const roots: NedSourceRoot[] = [];
  const excludedPackages: string[] = [];

  for (const folder of workspaceFolders) {
    const nedFolders = joinPath(folder, '.nedfolders');
    let dirs: string[] = [];
    if (await fs.exists(nedFolders)) {
      const content = await fs.readFile(nedFolders);
      for (const lineRaw of content.split(/\r?\n/)) {
        const line = lineRaw.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('-')) excludedPackages.push(line.slice(1).trim());
        else dirs.push(line);
      }
    } else {
      dirs = ['.'];
    }
    for (const d of dirs) {
      const dir = d === '.' ? folder : joinPath(folder, d);
      roots.push({ dir, rootPackage: await readRootPackage(fs, dir) });
    }

    const exclFile = joinPath(folder, '.nedexclusions');
    if (await fs.exists(exclFile)) {
      for (const lineRaw of (await fs.readFile(exclFile)).split(/\r?\n/)) {
        const line = lineRaw.trim();
        if (line && !line.startsWith('#')) excludedPackages.push(line);
      }
    }
  }

  for (const dir of nedPathDirs) {
    if (dir) roots.push({ dir, rootPackage: await readRootPackage(fs, dir) });
  }

  return { roots, excludedPackages };
}

/** The package name for a folder, given its source root. */
export function packageForFolder(root: NedSourceRoot, folder: string): string {
  let rel = folder.slice(root.dir.length).replace(/^\/+/, '').replace(/\/+$/, '');
  const sub = rel ? rel.split('/').filter(Boolean).join('.') : '';
  if (!root.rootPackage) return sub;
  return sub ? `${root.rootPackage}.${sub}` : root.rootPackage;
}

/** Find the source root that contains the given path (longest prefix wins). */
export function rootForPath(roots: NedSourceRoot[], path: string): NedSourceRoot | undefined {
  let best: NedSourceRoot | undefined;
  for (const r of roots) {
    if (path === r.dir || path.startsWith(r.dir + '/')) {
      if (!best || r.dir.length > best.dir.length) best = r;
    }
  }
  return best;
}

/** The folder-derived package for a NED file path. */
export function packageForFile(roots: NedSourceRoot[], filePath: string): string {
  const root = rootForPath(roots, filePath);
  if (!root) return '';
  const slash = filePath.lastIndexOf('/');
  const folder = slash >= 0 ? filePath.slice(0, slash) : filePath;
  return packageForFolder(root, folder);
}

export function isExcludedPackage(excluded: string[], pkg: string): boolean {
  return excluded.some((e) => pkg === e || pkg.startsWith(e + '.'));
}
