import { describe, expect, test } from 'bun:test';
import type { FileStat, FileSystem } from '../fs/fileSystem';
import { collectIndexableFiles, scanSourceRoots } from '../project/diskIndexer';

// Minimal in-memory FileSystem (same shape as server/src/test/revalidate.test.ts).
class MemFS implements FileSystem {
  private files = new Map<string, { text: string; mtimeMs: number }>();
  set(path: string, text: string, mtimeMs = 1): void {
    this.files.set(path, { text, mtimeMs });
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

function collectingSink(): { seen: Map<string, string[]>; sink: Parameters<typeof scanSourceRoots>[2] } {
  const seen = new Map<string, string[]>([['ned', []], ['msg', []], ['ini', []], ['cpp', []]]);
  const push = (kind: string) => async (p: string) => {
    seen.get(kind)!.push(p);
  };
  return {
    seen,
    sink: { ned: push('ned'), msg: push('msg'), ini: push('ini'), cpp: push('cpp') },
  };
}

describe('diskIndexer', () => {
  test('scanSourceRoots dispatches by extension and honors skip rules', async () => {
    const fs = new MemFS();
    fs.set('/proj/Net.ned', 'network Net {}');
    fs.set('/proj/sub/Pkt.msg', 'packet Pkt {}');
    fs.set('/proj/run/omnetpp.ini', '[General]');
    fs.set('/proj/src/Host.cc', 'void f() {}');
    fs.set('/proj/src/Host.h', 'class Host;');
    fs.set('/proj/README.md', 'not indexable');
    // all three skip rules
    fs.set('/proj/.git/blob.ned', 'skipped');
    fs.set('/proj/node_modules/dep/X.ned', 'skipped');
    fs.set('/proj/out/gen.msg', 'skipped');

    const { seen, sink } = collectingSink();
    await scanSourceRoots(fs, ['/proj'], sink);

    expect(seen.get('ned')).toEqual(['/proj/Net.ned']);
    expect(seen.get('msg')).toEqual(['/proj/sub/Pkt.msg']);
    expect(seen.get('ini')).toEqual(['/proj/run/omnetpp.ini']);
    expect(seen.get('cpp')!.sort()).toEqual(['/proj/src/Host.cc', '/proj/src/Host.h']);
  });

  test('scanSourceRoots visits roots in order and tolerates missing roots', async () => {
    const fs = new MemFS();
    fs.set('/a/A.ned', 'x');
    fs.set('/b/B.ned', 'x');
    const { seen, sink } = collectingSink();
    await scanSourceRoots(fs, ['/b', '/missing', '/a'], sink);
    expect(seen.get('ned')).toEqual(['/b/B.ned', '/a/A.ned']);
  });

  test('collectIndexableFiles returns mtime/size for exactly the indexable set', async () => {
    const fs = new MemFS();
    fs.set('/proj/Net.ned', '12345', 111);
    fs.set('/proj/Pkt.msg', '1234567', 222);
    fs.set('/proj/notes.txt', 'nope', 333);
    fs.set('/proj/.hidden/X.ned', 'nope', 444);

    const disk = await collectIndexableFiles(fs, ['/proj']);
    expect([...disk.keys()].sort()).toEqual(['/proj/Net.ned', '/proj/Pkt.msg']);
    expect(disk.get('/proj/Net.ned')).toEqual({ mtimeMs: 111, size: 5 });
    expect(disk.get('/proj/Pkt.msg')).toEqual({ mtimeMs: 222, size: 7 });
  });
});
