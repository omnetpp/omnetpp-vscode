import { Parser, Language, Tree } from 'web-tree-sitter';

export type GrammarId = 'ned' | 'msg';

export interface ParserServiceOptions {
  /** Directory containing tree-sitter.wasm (the web-tree-sitter runtime). */
  runtimeWasmDir: string;
  /** Absolute path to the compiled tree-sitter-ned.wasm grammar. */
  nedWasmPath: string;
  /** Absolute path to the compiled tree-sitter-msg.wasm grammar. */
  msgWasmPath: string;
}

/**
 * Loads and caches the tree-sitter grammars and hands out per-language parsers.
 * One Parser instance per grammar is reused for incremental reparsing.
 */
export class ParserService {
  private languages = new Map<GrammarId, Language>();
  private parsers = new Map<GrammarId, Parser>();

  private constructor() {}

  static async create(opts: ParserServiceOptions): Promise<ParserService> {
    await Parser.init({
      // emscripten asks for 'tree-sitter.wasm' by name; resolve it next to dist/wasm.
      locateFile: (scriptName: string) => `${opts.runtimeWasmDir}/${scriptName}`,
    });
    const svc = new ParserService();
    const ned = await Language.load(opts.nedWasmPath);
    const msg = await Language.load(opts.msgWasmPath);
    svc.languages.set('ned', ned);
    svc.languages.set('msg', msg);
    for (const id of ['ned', 'msg'] as GrammarId[]) {
      const p = new Parser();
      p.setLanguage(svc.languages.get(id)!);
      svc.parsers.set(id, p);
    }
    return svc;
  }

  getLanguage(id: GrammarId): Language {
    const l = this.languages.get(id);
    if (!l) throw new Error(`grammar not loaded: ${id}`);
    return l;
  }

  /** Parse text, optionally reusing a previous tree for incremental reparsing. */
  parse(id: GrammarId, text: string, oldTree?: Tree): Tree {
    const p = this.parsers.get(id);
    if (!p) throw new Error(`parser not available: ${id}`);
    const tree = p.parse(text, oldTree);
    if (!tree) throw new Error(`parse failed: ${id}`);
    return tree;
  }
}
