import { test } from 'node:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { organizeImports } from '../ned/nedOrganizeImports';
import { addMissingKeys } from '../ini/iniParamResolution';
import { parseIni } from '../ini/iniDocument';

async function nedCache(files: Record<string, { text: string; pkg: string }>) {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  for (const [uri, f] of Object.entries(files)) cache.addFile(uri, svc.parse('ned', f.text), f.pkg);
  return cache;
}

test('organizeImports adds a missing cross-package import', async () => {
  const cache = await nedCache({
    'file:///lib/Foo.ned': { text: 'package lib;\nsimple Foo { }', pkg: 'lib' },
    'file:///app/A.ned': { text: 'package app;\nsimple A extends Foo { }', pkg: 'app' },
  });
  const f = cache.getFile('file:///app/A.ned')!;
  const edits = organizeImports(cache, f, f.tree);
  assert.equal(edits.length, 1);
  assert.match(edits[0].newText, /import lib\.Foo;/);
});

test('organizeImports removes an unused import', async () => {
  const cache = await nedCache({
    'file:///lib/Foo.ned': { text: 'package lib;\nsimple Foo { }', pkg: 'lib' },
    'file:///app/B.ned': { text: 'package app;\nimport lib.Foo;\nsimple B { }', pkg: 'app' },
  });
  const f = cache.getFile('file:///app/B.ned')!;
  const edits = organizeImports(cache, f, f.tree);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].newText.trim(), '', 'unused import is removed');
});

test('organizeImports is a no-op when imports are already correct', async () => {
  const cache = await nedCache({
    'file:///lib/Foo.ned': { text: 'package lib;\nsimple Foo { }', pkg: 'lib' },
    'file:///app/C.ned': { text: 'package app;\nimport lib.Foo;\nsimple C extends Foo { }', pkg: 'app' },
  });
  const f = cache.getFile('file:///app/C.ned')!;
  assert.deepEqual(organizeImports(cache, f, f.tree), []);
});

test('addMissingKeys adds entries for mandatory (no-default) parameters', async () => {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  const ned = `simple Queue { parameters: int capacity; double rate @unit(bps) = default(0bps); }
network Net { submodules: q: Queue; }`;
  cache.addFile('file:///net.ned', svc.parse('ned', ned), '');
  const doc = parseIni('[General]\nnetwork = Net\n');
  const edits = addMissingKeys(doc, cache);
  assert.equal(edits.length, 1);
  assert.match(edits[0].newText, /Net\.q\.capacity = /);
  assert.ok(!/rate/.test(edits[0].newText), 'rate has a default -> not added');
});

test('addMissingKeys is empty when all mandatory params are assigned', async () => {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  const ned = `simple Queue { parameters: int capacity; }
network Net { submodules: q: Queue; }`;
  cache.addFile('file:///net.ned', svc.parse('ned', ned), '');
  const doc = parseIni('[General]\nnetwork = Net\n**.capacity = 10\n');
  assert.deepEqual(addMissingKeys(doc, cache), []);
});
