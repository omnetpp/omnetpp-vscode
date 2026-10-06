import { test } from 'bun:test';
import assert from 'node:assert';
import { fileUri } from '@omnetpp/shared';
import { ProjectIndex } from '../projectIndex';
import { MemFS, getParsers } from './memIndex';

const ROOT = '/proj';
const uri = (name: string): string => fileUri(`${ROOT}/${name}`);

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

test('INI files outside NED folders are never indexed, nor reported as changes', async () => {
  const fs = new MemFS();
  fs.set(`${ROOT}/.nedfolders`, 'src\n-old', 1000);
  fs.set(`${ROOT}/src/omnetpp.ini`, '[General]\nnetwork = Net', 1000);
  fs.set(`${ROOT}/src/old/omnetpp.ini`, '[General]\nnetwork = Net', 1000);
  fs.set(`${ROOT}/doc/omnetpp.ini`, '[General]\nnetwork = Net', 1000);
  const idx = await freshIndex(fs);
  const indexed = () => [...idx.iniCache.allDocs()].map((d) => d.uri);
  assert.deepEqual(indexed(), [uri('src/omnetpp.ini')]);
  assert.equal(idx.isInNedFolder(uri('src/omnetpp.ini')), true);
  assert.equal(idx.isInNedFolder(uri('src/old/omnetpp.ini')), false);
  assert.equal(idx.isInNedFolder(uri('doc/omnetpp.ini')), false);

  await idx.onFileChanged(uri('doc/omnetpp.ini'), false); // watcher event
  assert.deepEqual(indexed(), [uri('src/omnetpp.ini')]);

  const r = await idx.revalidate([ROOT], []);
  assert.equal(r.iniChanged, false);
});
