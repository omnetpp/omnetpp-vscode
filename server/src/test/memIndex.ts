import { join, resolve } from 'node:path';
import { ParserService } from '@omnetpp/shared';
import type { FileSystem, FileStat } from '@omnetpp/shared';

// --- shared parser (WASM grammars), created once ---------------------------
const repoRoot = resolve(__dirname, '..', '..', '..');
const wasmDir = join(repoRoot, 'resources', 'wasm');
let parserPromise: Promise<ParserService> | undefined;
export function getParsers(): Promise<ParserService> {
  if (!parserPromise) {
    parserPromise = ParserService.create({
      runtimeWasmDir: join(repoRoot, 'node_modules', 'web-tree-sitter'),
      nedWasmPath: join(wasmDir, 'tree-sitter-ned.wasm'),
      msgWasmPath: join(wasmDir, 'tree-sitter-msg.wasm'),
    });
  }
  return parserPromise;
}

// --- in-memory FileSystem with controllable mtime --------------------------
export class MemFS implements FileSystem {
  private files = new Map<string, { text: string; mtimeMs: number }>();
  set(path: string, text: string, mtimeMs: number): void {
    this.files.set(path, { text, mtimeMs });
  }
  del(path: string): void {
    this.files.delete(path);
  }
  private prefix(p: string): string {
    return p.endsWith('/') ? p : `${p}/`;
  }
  async readFile(path: string): Promise<string> {
    const f = this.files.get(path);
    if (!f) throw new Error(`ENOENT: ${path}`);
    return f.text;
  }
  async readDirectory(dir: string): Promise<string[]> {
    const pre = this.prefix(dir);
    const names = new Set<string>();
    for (const p of this.files.keys()) {
      if (p.startsWith(pre)) names.add(p.slice(pre.length).split('/')[0]);
    }
    return [...names];
  }
  async stat(path: string): Promise<FileStat> {
    const f = this.files.get(path);
    if (f) return { isFile: true, isDirectory: false, mtimeMs: f.mtimeMs, size: f.text.length };
    const pre = this.prefix(path);
    for (const k of this.files.keys()) if (k.startsWith(pre)) return { isFile: false, isDirectory: true };
    throw new Error(`ENOENT: ${path}`);
  }
  async exists(path: string): Promise<boolean> {
    if (this.files.has(path)) return true;
    const pre = this.prefix(path);
    for (const k of this.files.keys()) if (k.startsWith(pre)) return true;
    return false;
  }
}
