import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers, posOf } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { nedRename, nedPrepareRename } from '../ned/nedRename';

async function build(files: Record<string, string>) {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  for (const [uri, text] of Object.entries(files)) cache.addFile(uri, svc.parse('ned', text), '');
  return cache;
}

const BASE = 'simple Base { }';
const USE = `simple D extends Base { }
module M { submodules: x: Base; }`;

test('rename type updates declaration and all references across files', async () => {
  const cache = await build({ 'file:///Base.ned': BASE, 'file:///Use.ned': USE });
  const useFile = cache.getFile('file:///Use.ned')!;
  // rename from the `extends Base` reference
  const pos = posOf(USE, 'extends Base', 'extends '.length);
  const edit = nedRename(cache, useFile, useFile.tree, pos, 'Queue');
  assert.ok(edit);
  // Base.ned declaration edited
  assert.ok(edit!.changes['file:///Base.ned']?.length === 1);
  // Use.ned: extends + submodule type = 2 edits
  assert.equal(edit!.changes['file:///Use.ned']?.length, 2);
  for (const e of Object.values(edit!.changes).flat()) assert.equal(e.newText, 'Queue');
});

test('prepareRename returns name range and placeholder', async () => {
  const cache = await build({ 'file:///Base.ned': BASE });
  const f = cache.getFile('file:///Base.ned')!;
  const pr = nedPrepareRename(cache, f, f.tree, posOf(BASE, 'Base'));
  assert.ok(pr);
  assert.equal(pr!.placeholder, 'Base');
});
