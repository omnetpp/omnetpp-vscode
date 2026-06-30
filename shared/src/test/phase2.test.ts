import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import {
  BUILTIN_NED_TEXT,
  BUILTIN_URI,
  NedResourceCache,
  importToRegex,
} from '../ned/nedResourceCache';
import { nedSemanticDiagnostics } from '../ned/nedSemanticChecks';
import {
  discoverProjectLayout,
  packageForFile,
  parsePackageDecl,
} from '../project/projectModel';
import type { FileSystem } from '../fs/fileSystem';

async function buildCache(files: Record<string, { text: string; pkg?: string }>) {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  for (const [uri, f] of Object.entries(files)) {
    cache.addFile(uri, svc.parse('ned', f.text), f.pkg ?? '');
  }
  return cache;
}

test('lookup: fully-qualified, same-package, exact import, wildcard import', async () => {
  const cache = await buildCache({
    'file:///lib/Base.ned': { text: 'package lib;\nsimple Base { }', pkg: 'lib' },
    'file:///lib/Helper.ned': { text: 'package lib;\nsimple Helper { }', pkg: 'lib' },
    'file:///app/A.ned': {
      text: 'package app;\nimport lib.Base;\nimport lib.*;\nsimple A extends Base { }',
      pkg: 'app',
    },
  });
  const appFile = cache.getFile('file:///app/A.ned')!;
  // fully-qualified
  assert.ok(cache.lookupType('lib.Base', appFile));
  // exact import
  assert.equal(cache.lookupType('Base', appFile)?.fqName, 'lib.Base');
  // wildcard import (Helper only reachable via lib.*)
  assert.equal(cache.lookupType('Helper', appFile)?.fqName, 'lib.Helper');
  // same package
  assert.equal(cache.lookupType('A', appFile)?.fqName, 'app.A');
  // builtin
  assert.ok(cache.lookupType('ned.DatarateChannel', appFile));
});

test('inner type resolution', async () => {
  const cache = await buildCache({
    'file:///N.ned': {
      text: `network N {
        types:
          simple Inner { }
        submodules:
          x: Inner;
      }`,
    },
  });
  assert.ok(cache.getType('N.Inner'), 'inner type registered as N.Inner');
  const diags = nedSemanticDiagnostics(cache, 'file:///N.ned');
  assert.deepEqual(diags, [], 'inner submodule type resolves with no diagnostics');
});

test('inheritance: merged params from base', async () => {
  const cache = await buildCache({
    'file:///B.ned': { text: 'simple Base { parameters: int a = 1; }' },
    'file:///D.ned': { text: 'simple Derived extends Base { parameters: int b = 2; }' },
  });
  const d = cache.getType('Derived')!;
  const params = d.params();
  assert.deepEqual([...params.keys()].sort(), ['a', 'b']);
  assert.equal(d.superType()?.fqName, 'Base');
});

test('semantic diagnostics: unknown type and bad extends kind', async () => {
  const cache = await buildCache({
    'file:///X.ned': {
      text: `channel C { }
simple S extends C { }
module M { submodules: u: NoSuchType; }`,
    },
  });
  const diags = nedSemanticDiagnostics(cache, 'file:///X.ned');
  const msgs = diags.map((d) => d.message);
  assert.ok(msgs.some((m) => /cannot extend a channel/.test(m)), 'bad extends kind');
  assert.ok(msgs.some((m) => /Unknown type 'NoSuchType'/.test(m)), 'unknown submodule type');
});

test('importToRegex semantics', () => {
  assert.ok(importToRegex('lib.*').test('lib.Foo'));
  assert.ok(!importToRegex('lib.*').test('lib.sub.Foo'));
  assert.ok(importToRegex('lib.**').test('lib.sub.Foo'));
});

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
