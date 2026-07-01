// A resident, workspace-wide index of parsed INI documents. Unlike NED/MSG this
// holds pure data (no tree-sitter tree to free), so it simply stores the parsed
// `IniDocument` per uri. It exists so reverse queries (NED param → INI keys that
// assign it) can scan every config in the project, which the per-request parsing
// model could not support.

import { parseIni } from './iniDocument';
import type { IniDocument } from './iniDocument';

export class IniResourceCache {
  generation = 0;
  // The raw source `text` is kept alongside the parsed doc so callers that need
  // the original bytes (e.g. inline `suppress(...)` directive scanning) don't have
  // to re-read the file from disk.
  private docs = new Map<string, { doc: IniDocument; text: string }>();

  addFile(uri: string, text: string): void {
    this.docs.set(uri, { doc: parseIni(text, uri), text });
    this.generation++;
  }

  removeFile(uri: string): void {
    if (this.docs.delete(uri)) this.generation++;
  }

  clear(): void {
    this.docs.clear();
    this.generation++;
  }

  getDoc(uri: string): IniDocument | undefined {
    return this.docs.get(uri)?.doc;
  }

  getText(uri: string): string | undefined {
    return this.docs.get(uri)?.text;
  }

  allDocs(): { uri: string; doc: IniDocument; text: string }[] {
    return [...this.docs.entries()].map(([uri, { doc, text }]) => ({ uri, doc, text }));
  }
}
