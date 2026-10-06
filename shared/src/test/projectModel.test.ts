import { test } from 'bun:test';
import assert from 'node:assert';
import {
  discoverProjectLayout,
  isInNedFolder,
  packageForFile,
  parsePackageDecl,
} from '../project/projectModel';
import type { FileSystem } from '../fs/fileSystem';

test('project layout discovery with .nedfolders and package.ned', async () => {
  const fsMap: Record<string, string> = {
    '/ws/.nedfolders': 'src\n-org.excluded',
    '/ws/src/package.ned': 'package myproj;',
  };
  const dirs = new Set(['/ws', '/ws/src']);
  const fs: FileSystem = {
    readFile: async (p) => {
      if (p in fsMap) return fsMap[p];
      throw new Error('no ' + p);
    },
    readDirectory: async () => [],
    stat: async (p) => ({ isFile: !dirs.has(p), isDirectory: dirs.has(p) }),
    exists: async (p) => p in fsMap || dirs.has(p),
  };
  const layout = await discoverProjectLayout(fs, ['/ws']);
  assert.equal(layout.roots.length, 1);
  assert.equal(layout.roots[0].dir, '/ws/src');
  assert.equal(layout.roots[0].rootPackage, 'myproj');
  assert.deepEqual(layout.excludedPackages, ['org.excluded']);
  assert.equal(packageForFile(layout.roots, '/ws/src/sub/Foo.ned'), 'myproj.sub');
  assert.equal(parsePackageDecl('// c\npackage a.b.c;\n'), 'a.b.c');
});

test('isInNedFolder: under a source root and not in an excluded package', () => {
  const layout = {
    roots: [{ dir: '/ws/src', rootPackage: 'myproj' }, { dir: '/ws/simulations', rootPackage: '' }],
    excludedPackages: ['myproj.old', 'doc'],
  };
  assert.equal(isInNedFolder(layout, '/ws/src/net/omnetpp.ini'), true);
  assert.equal(isInNedFolder(layout, '/ws/simulations/omnetpp.ini'), true);
  assert.equal(isInNedFolder(layout, '/ws/docs/copy/omnetpp.ini'), false);
  assert.equal(isInNedFolder(layout, '/ws/srcold/omnetpp.ini'), false);
  assert.equal(isInNedFolder(layout, '/ws/src/old/omnetpp.ini'), false);
  assert.equal(isInNedFolder(layout, '/ws/simulations/doc/omnetpp.ini'), false);
});
