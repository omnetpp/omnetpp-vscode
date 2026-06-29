import { test } from 'node:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { nedDefinition, nedHover, nedReferences } from '../ned/nedNavigation';
import { nedCompletion } from '../ned/nedCompletion';
import type { Position } from '../model/location';

async function build(files: Record<string, { text: string; pkg?: string }>) {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  for (const [uri, f] of Object.entries(files)) cache.addFile(uri, svc.parse('ned', f.text), f.pkg ?? '');
  return cache;
}

/** Position of the first occurrence of `needle` (at its first char). */
function posOf(text: string, needle: string): Position {
  const idx = text.indexOf(needle);
  const before = text.slice(0, idx);
  const line = before.split('\n').length - 1;
  const character = idx - (before.lastIndexOf('\n') + 1);
  return { line, character };
}

const TEXT = `simple Base {
  parameters:
    int n = 1;
}
simple Derived extends Base {
}
module Net {
  submodules:
    host: Derived;
}`;

test('go-to-definition on extends target', async () => {
  const cache = await build({ 'file:///a.ned': { text: TEXT } });
  const file = cache.getFile('file:///a.ned')!;
  const tree = file.tree;
  // position on the `Base` token in `extends Base`
  const ep = posOf(TEXT, 'extends Base');
  const refPos: Position = { line: ep.line, character: ep.character + 'extends '.length };
  const def = nedDefinition(cache, file, tree, refPos);
  assert.ok(def, 'definition found from extends reference');
  assert.equal(def!.range.start.line, 0, 'Base defined on line 0');
  // also: go-to-def on submodule type `host: Derived`
  const sp = posOf(TEXT, 'Derived;');
  const def2 = nedDefinition(cache, file, tree, sp);
  assert.ok(def2, 'definition found from submodule type');
  assert.equal(def2!.range.start.line, 4, 'Derived defined on line 4');
});

test('hover shows type signature and doc', async () => {
  const T = `// A great module
simple Base { }
simple D extends Base { }`;
  const cache = await build({ 'file:///b.ned': { text: T } });
  const file = cache.getFile('file:///b.ned')!;
  const hov = nedHover(cache, file, file.tree, posOf(T, 'Base { }'));
  assert.ok(hov);
  assert.match(hov!.markdown, /simple Base/);
  assert.match(hov!.markdown, /A great module/);
});

test('parameter hover includes trailing and leading doc comments', async () => {
  const T = `simple S {
  parameters:
    int foo = 5;  // documents foo
    // banner for bar
    string bar;
}`;
  const cache = await build({ 'file:///p.ned': { text: T } });
  const file = cache.getFile('file:///p.ned')!;
  // hover on the `foo` declaration -> trailing comment
  const hovFoo = nedHover(cache, file, file.tree, posOf(T, 'foo = 5'));
  assert.ok(hovFoo);
  assert.match(hovFoo!.markdown, /int foo/);
  assert.match(hovFoo!.markdown, /documents foo/);
  // hover on `bar` -> falls back to the leading banner comment
  const hovBar = nedHover(cache, file, file.tree, posOf(T, 'bar;'));
  assert.ok(hovBar);
  assert.match(hovBar!.markdown, /banner for bar/);
});

test('find references to a type', async () => {
  const cache = await build({ 'file:///a.ned': { text: TEXT } });
  const file = cache.getFile('file:///a.ned')!;
  // references of Derived (defined + used in submodule + ... )
  const refs = nedReferences(cache, file, file.tree, posOf(TEXT, 'Derived extends'), true);
  // declaration + submodule type usage
  assert.ok(refs.length >= 2, `expected >=2 refs, got ${refs.length}`);
});

test('completion after extends offers types', async () => {
  const cache = await build({ 'file:///a.ned': { text: TEXT } });
  const file = cache.getFile('file:///a.ned')!;
  const prefix = 'simple X extends ';
  const items = nedCompletion(cache, file, file.tree, { line: 0, character: prefix.length }, prefix);
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes('Base'));
  assert.ok(labels.includes('Derived'));
});

test('completion after submodule colon offers module types', async () => {
  const cache = await build({ 'file:///a.ned': { text: TEXT } });
  const file = cache.getFile('file:///a.ned')!;
  const prefix = '    host: ';
  const items = nedCompletion(cache, file, file.tree, { line: 0, character: prefix.length }, prefix);
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes('Net') || labels.includes('Base') || labels.includes('Derived'));
});
