import { test } from 'bun:test';
import assert from 'node:assert';
import { BUILTIN_URI } from '@omnetpp/shared';
import { ProjectIndex } from '../projectIndex';
import { MemFS, getParsers } from './memIndex';

// URIs spelled as VS Code sends them (vscode-uri encodes `+` and `(`/`)`,
// unlike Node's pathToFileURL).
const DISK_PATH = '/proj/a+b (copy).ned';
const EDITOR_URI = 'file:///proj/a%2Bb%20%28copy%29.ned';

async function indexWithFile(): Promise<{ fs: MemFS; idx: ProjectIndex }> {
  const fs = new MemFS();
  fs.set(DISK_PATH, 'simple Alpha { }', 1000);
  const idx = new ProjectIndex(fs, await getParsers(), '/no-config-dir');
  idx.setOpenPredicate(() => false);
  await idx.initialize(['/proj'], []);
  return { fs, idx };
}

const nedFileUris = (idx: ProjectIndex): string[] =>
  idx.cache.allFiles().map((f) => f.uri).filter((u) => u !== BUILTIN_URI);

test('the disk index keys files by the URI the editor uses', async () => {
  const { idx } = await indexWithFile();
  assert.deepEqual(nedFileUris(idx), [EDITOR_URI]);
});

test('opening an indexed file replaces its disk entry instead of adding a second one', async () => {
  const { idx } = await indexWithFile();
  idx.setOpenPredicate((u) => u === EDITOR_URI);
  idx.updateOpenDocument(EDITOR_URI, 'simple Alpha { }');
  assert.deepEqual(nedFileUris(idx), [EDITOR_URI]);
});

test('an open file is not re-read from disk by indexing or revalidate', async () => {
  const { fs, idx } = await indexWithFile();
  idx.setOpenPredicate((u) => u === EDITOR_URI);
  idx.updateOpenDocument(EDITOR_URI, 'simple Edited { }');
  fs.set(DISK_PATH, 'simple OnDisk { }', 2000);
  await idx.indexFile(DISK_PATH);
  await idx.revalidate(['/proj'], []);
  assert.ok(idx.cache.getType('Edited'), 'open buffer content kept');
  assert.ok(!idx.cache.getType('OnDisk'), 'disk content not indexed over the buffer');
});

test('a watcher delete event under the editor URI removes the file', async () => {
  const { fs, idx } = await indexWithFile();
  fs.del(DISK_PATH);
  await idx.onFileChanged(EDITOR_URI, true);
  assert.ok(!idx.cache.getType('Alpha'), 'types of the deleted file dropped');
  assert.deepEqual(nedFileUris(idx), []);
});
