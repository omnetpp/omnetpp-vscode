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

test('semantic diagnostics: unknown type', async () => {
  const cache = await buildCache({
    'file:///X.ned': {
      text: `channel C { }
module M { submodules: u: NoSuchType; }`,
    },
  });
  const diags = nedSemanticDiagnostics(cache, 'file:///X.ned');
  const msgs = diags.map((d) => d.message);
  assert.ok(msgs.some((m) => /Unknown type 'NoSuchType'/.test(m)), 'unknown submodule type');
});

test('importToRegex semantics', () => {
  assert.ok(importToRegex('lib.*').test('lib.Foo'));
  assert.ok(!importToRegex('lib.*').test('lib.sub.Foo'));
  assert.ok(importToRegex('lib.**').test('lib.sub.Foo'));
});
