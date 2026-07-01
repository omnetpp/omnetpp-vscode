import type { Tree } from 'web-tree-sitter';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { ParserService, GrammarId, IniDocument, parseIni } from '@omnetpp/shared';

export type OmnetppLanguage = 'ned' | 'msg' | 'ini';

const LANGUAGE_ID_MAP: Record<string, OmnetppLanguage> = {
  'OMNeT++ NED': 'ned',
  'OMNeT++ MSG': 'msg',
  'OMNeT++ INI': 'ini',
};

export function languageOf(doc: TextDocument): OmnetppLanguage | undefined {
  const byId = LANGUAGE_ID_MAP[doc.languageId];
  if (byId) return byId;
  const uri = doc.uri.toLowerCase();
  if (uri.endsWith('.ned')) return 'ned';
  if (uri.endsWith('.msg')) return 'msg';
  if (uri.endsWith('.ini')) return 'ini';
  return undefined;
}

/** A parsed open document: its text version and tree-sitter tree (ned/msg only). */
export interface ParsedDocument {
  uri: string;
  language: OmnetppLanguage;
  version: number;
  text: string;
  tree?: Tree;
  ini?: IniDocument;
}

/**
 * Maintains parse trees for open documents. For now performs full reparses on
 * change (tree-sitter is fast); incremental editing is a later optimization.
 */
export class DocumentModelStore {
  private docs = new Map<string, ParsedDocument>();

  constructor(private parsers: ParserService) {}

  update(doc: TextDocument): ParsedDocument {
    const language = languageOf(doc) ?? 'ned';
    const text = doc.getText();
    let tree: Tree | undefined;
    let ini: IniDocument | undefined;
    if (language === 'ned' || language === 'msg') {
      const prev = this.docs.get(doc.uri);
      tree = this.parsers.parse(language as GrammarId, text, undefined);
      prev?.tree?.delete();
    } else if (language === 'ini') {
      ini = parseIni(text, doc.uri);
    }
    const parsed: ParsedDocument = {
      uri: doc.uri,
      language,
      version: doc.version,
      text,
      tree,
      ini,
    };
    this.docs.set(doc.uri, parsed);
    return parsed;
  }

  get(uri: string): ParsedDocument | undefined {
    return this.docs.get(uri);
  }

  remove(uri: string): void {
    const d = this.docs.get(uri);
    d?.tree?.delete();
    this.docs.delete(uri);
  }
}
