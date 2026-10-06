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
