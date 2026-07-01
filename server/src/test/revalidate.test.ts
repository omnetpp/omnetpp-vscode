import { test } from 'bun:test';
import assert from 'node:assert';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ParserService } from '@omnetpp/shared';
import type { FileSystem, FileStat } from '@omnetpp/shared';
import { ProjectIndex } from '../projectIndex';

// --- shared parser (WASM grammars), created once ---------------------------
const repoRoot = resolve(__dirname, '..', '..', '..');
const wasmDir = join(repoRoot, 'resources', 'wasm');
let parserPromise: Promise<ParserService> | undefined;
function getParsers(): Promise<ParserService> {
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
class MemFS implements FileSystem {
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

const ROOT = '/proj';
const uri = (name: string): string => pathToFileURL(`${ROOT}/${name}`).toString();

async function freshIndex(fs: MemFS): Promise<ProjectIndex> {
  const idx = new ProjectIndex(fs, await getParsers(), '/no-config-dir');
  idx.setOpenPredicate(() => false);
  await idx.initialize([ROOT], []);
  return idx;
}

test('revalidate re-reads a file whose content (mtime/size) changed on disk', async () => {
  const fs = new MemFS();
  fs.set(`${ROOT}/A.ned`, 'simple Alpha { }', 1000);
  const idx = await freshIndex(fs);
  assert.ok(idx.cache.getType('Alpha'), 'Alpha indexed initially');

  fs.set(`${ROOT}/A.ned`, 'simple Renamed { }', 2000); // background rewrite
  const r = await idx.revalidate([ROOT], []);
  assert.equal(r.needsReindex, false);
  assert.equal(r.nedChanged, true);
  assert.ok(idx.cache.getType('Renamed'), 'new type picked up');
  assert.ok(!idx.cache.getType('Alpha'), 'old type gone');
});

test('revalidate indexes a file added on disk', async () => {
  const fs = new MemFS();
  fs.set(`${ROOT}/A.ned`, 'simple Alpha { }', 1000);
  const idx = await freshIndex(fs);
  assert.ok(!idx.cache.getType('Beta'), 'Beta absent before');

  fs.set(`${ROOT}/B.ned`, 'simple Beta { }', 1000);
  const r = await idx.revalidate([ROOT], []);
  assert.equal(r.nedChanged, true);
  assert.ok(idx.cache.getType('Beta'), 'added file indexed');
});

test('revalidate removes a file deleted on disk (and frees it from the cache)', async () => {
  const fs = new MemFS();
  fs.set(`${ROOT}/A.ned`, 'simple Alpha { }', 1000);
  fs.set(`${ROOT}/B.ned`, 'simple Beta { }', 1000);
  const idx = await freshIndex(fs);
  assert.ok(idx.cache.getFile(uri('B.ned')), 'B present before');

  fs.del(`${ROOT}/B.ned`);
  const r = await idx.revalidate([ROOT], []);
  assert.equal(r.nedChanged, true);
  assert.ok(!idx.cache.getFile(uri('B.ned')), 'deleted file dropped');
  assert.ok(!idx.cache.getType('Beta'), 'its type gone');
});

test('revalidate never touches open buffers (editor owns them)', async () => {
  const fs = new MemFS();
  fs.set(`${ROOT}/A.ned`, 'simple Alpha { }', 1000);
  const idx = await freshIndex(fs);
  idx.setOpenPredicate((u) => u === uri('A.ned')); // pretend A is open in the editor

  fs.set(`${ROOT}/A.ned`, 'simple DiskOnly { }', 2000); // disk diverges from buffer
  const r = await idx.revalidate([ROOT], []);
  assert.equal(r.nedChanged, false, 'open file not reconciled');
  assert.ok(!idx.cache.getType('DiskOnly'), 'disk version not indexed for open buffer');
});

test('revalidate requests a full reindex when the layout changes', async () => {
  const fs = new MemFS();
  fs.set(`${ROOT}/A.ned`, 'simple Alpha { }', 1000);
  const idx = await freshIndex(fs);

  // introduce a .nedfolders that re-roots the project → layout differs
  fs.set(`${ROOT}/.nedfolders`, 'src\n', 1000);
  fs.set(`${ROOT}/src/A.ned`, 'simple Alpha { }', 1000);
  const r = await idx.revalidate([ROOT], []);
  assert.equal(r.needsReindex, true, 'layout change forces reindex');
});
