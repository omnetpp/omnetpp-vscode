import { URI } from 'vscode-uri';

// Index keys must be spelled exactly as VS Code spells URIs (open documents,
// watcher events, request params). Node's pathToFileURL encodes `+ @ ( ) ~ …`
// and the Windows drive letter differently, so its keys never match.

/** The canonical `file:` URI of an absolute filesystem path. */
export function fileUri(fsPath: string): string {
  return URI.file(fsPath).toString();
}

/** Re-spell a `file:` URI from any encoder in the canonical form; other schemes pass through. */
export function normalizeFileUri(uri: string): string {
  return uri.startsWith('file:') ? URI.parse(uri).toString() : uri;
}
