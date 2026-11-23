import { fileURLToPath } from 'node:url';

// The project model compares paths as '/'-separated strings, so on Windows every
// path entering the index must use '/' and one drive-letter case (VS Code's
// lowercase). Only on win32: elsewhere '\' is a legal filename character.

/** The form of an absolute filesystem path that the project model compares. */
export function indexPath(fsPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return fsPath;
  const p = fsPath.replace(/\\/g, '/');
  return /^[A-Za-z]:/.test(p) ? p[0].toLowerCase() + p.slice(1) : p;
}

/** `indexPath` of a `file:` URI; throws like `fileURLToPath` for other URIs. */
export function uriToIndexPath(uri: string, platform: NodeJS.Platform = process.platform): string {
  return indexPath(fileURLToPath(uri, { windows: platform === 'win32' }), platform);
}

/**
 * `path` relative to the directory `dir`, '/'-separated ('' for `dir` itself), or
 * undefined when it lies outside. Both are compared in their index form, so a path that
 * resolve() spelled from user input (`C:\\proj`) matches one that came from an index URI
 * (`c:/proj/...`).
 */
export function indexRelative(dir: string, path: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const d = indexPath(dir, platform).replace(/\/+$/, '');
  const p = indexPath(path, platform);
  if (p === d) return '';
  return p.startsWith(`${d}/`) ? p.slice(d.length + 1) : undefined;
}

/** Split a NED path list. Windows uses ';' only, since ':' follows the drive
 *  letter; elsewhere ':' (the OS path-list separator) and ';' both work. */
export function splitNedPath(list: string, platform: NodeJS.Platform = process.platform): string[] {
  return list
    .split(platform === 'win32' ? ';' : /[;:]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
