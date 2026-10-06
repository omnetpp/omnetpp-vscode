import { test } from 'bun:test';
import assert from 'node:assert';
import { BUILTIN_URI } from '@omnetpp/shared';
import { ProjectIndex } from '../projectIndex';
import { MemFS, getParsers } from './memIndex';

// A Windows project as the server sees it: the workspace folder already in
// index-path form (see safeFsPath), editor URIs as VS Code spells them.
const ROOT = 'c:/proj';
const NED_URI = 'file:///c%3A/proj/sub/A.ned';
const INI_URI = 'file:///c%3A/proj/sub/omnetpp.ini';

async function windowsIndex(): Promise<{ fs: MemFS; idx: ProjectIndex }> {
  const fs = new MemFS();
  fs.set(`${ROOT}/sub/A.ned`, 'simple Alpha { }', 1000);
  fs.set(`${ROOT}/sub/omnetpp.ini`, '[General]\n', 1000);
  const idx = new ProjectIndex(fs, await getParsers(), '/no-config-dir', 'win32');
  idx.setOpenPredicate(() => false);
  await idx.initialize([ROOT], []);
  return { fs, idx };
}

test('on Windows, editor URIs resolve to their NED folder and package', async () => {
  const { idx } = await windowsIndex();
  assert.equal(idx.isInNedFolder(INI_URI), true);
  assert.equal(idx.folderPackageForUri(NED_URI), 'sub');
  assert.ok(idx.cache.getType('sub.Alpha'), 'disk walk indexed the type in its folder package');
});

test('on Windows, an open NED file without a package line keeps its folder package', async () => {
  const { idx } = await windowsIndex();
  idx.setOpenPredicate((u) => u === NED_URI);
  idx.updateOpenDocument(NED_URI, 'simple Beta { }');
  assert.ok(idx.cache.getType('sub.Beta'));
  assert.deepEqual(
    idx.cache.allFiles().map((f) => f.uri).filter((u) => u !== BUILTIN_URI),
    [NED_URI],
  );
});

test('on Windows, a watcher delete event removes the file and stats count per root', async () => {
  const { fs, idx } = await windowsIndex();
  assert.deepEqual(
    idx.stats().map((s) => [s.dir, s.nedTypes, s.iniFiles]),
    [[ROOT, 1, 1]],
  );
  fs.del(`${ROOT}/sub/A.ned`);
  await idx.onFileChanged(NED_URI, true);
  assert.ok(!idx.cache.getType('sub.Alpha'));
});
