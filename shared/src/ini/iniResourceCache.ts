// A resident, workspace-wide index of parsed INI documents. Unlike NED/MSG this
// holds pure data (no tree-sitter tree to free), so it simply stores the parsed
// `IniDocument` per uri. It exists so reverse queries (NED param → INI keys that
// assign it) can scan every config in the project, which the per-request parsing
// model could not support.

import { parseIni } from './iniDocument';
import type { IniDocument } from './iniDocument';

export class IniResourceCache {
  generation = 0;
  private docs = new Map<string, IniDocument>();

  addFile(uri: string, text: string): void {
    this.docs.set(uri, parseIni(text));
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
    return this.docs.get(uri);
  }

  allDocs(): { uri: string; doc: IniDocument }[] {
    return [...this.docs.entries()].map(([uri, doc]) => ({ uri, doc }));
  }
}
