import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { nedCompletion } from '../ned/nedCompletion';

async function nedCache(files: Record<string, string>) {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  for (const [uri, text] of Object.entries(files)) cache.addFile(uri, svc.parse('ned', text), '');
  return cache;
}

/** Completion labels with the cursor at the END of the given line index. */
function completeAt(cache: NedResourceCache, uri: string, lineIdx: number): string[] {
  const file = cache.getFile(uri)!;
  const lines = file.tree.rootNode.text.split('\n');
  const line = lines[lineIdx];
  return nedCompletion(cache, file, file.tree, { line: lineIdx, character: line.length }, line).map(
    (i) => i.label,
  );
}

const has = (labels: string[], ...want: string[]) =>
  want.every((w) => labels.includes(w));
const hasNone = (labels: string[], ...unwanted: string[]) =>
  unwanted.every((w) => !labels.includes(w));

test('properties: type/param scope in parameters section', async () => {
  const ned = `module M {
    parameters:
        @
}
`;
  const cache = await nedCache({ 'file:///t.ned': ned });
  const labels = completeAt(cache, 'file:///t.ned', 2);
  assert.ok(
    has(labels, '@display', '@class', '@signal', '@statistic', '@isNetwork', '@figure', '@labels',
      '@group', '@unit', '@enum', '@mutable', '@prompt'),
    `missing type/param properties: ${labels.join(',')}`,
  );
  assert.ok(hasNone(labels, '@loose', '@directIn', '@reconnect', '@dynamic', '@namespace'),
    `unexpected out-of-scope properties: ${labels.join(',')}`);
});

test('properties: implicit parameters section (no `parameters:` keyword)', async () => {
  const ned = `module M {
    int n;
    @
}
`;
  const cache = await nedCache({ 'file:///imp.ned': ned });
  const labels = completeAt(cache, 'file:///imp.ned', 2);
  assert.ok(has(labels, 'int', 'double', '@display', '@class'),
    `implicit params should offer param keywords + properties: ${labels.join(',')}`);
});

test('properties: keyword-less empty type body offers sections + param/property bundle', async () => {
  const ned = `module M {

}
`;
  const cache = await nedCache({ 'file:///empty.ned': ned });
  const labels = completeAt(cache, 'file:///empty.ned', 1);
  assert.ok(has(labels, 'parameters', 'gates', 'int', '@display'),
    `empty body should offer sections + param bundle: ${labels.join(',')}`);
});

test('properties: gate scope in gates section', async () => {
  const ned = `module M {
    gates:
        @
}
`;
  const cache = await nedCache({ 'file:///g.ned': ned });
  const labels = completeAt(cache, 'file:///g.ned', 2);
  assert.ok(has(labels, '@loose', '@directIn', '@labels'), `missing gate props: ${labels.join(',')}`);
  assert.ok(hasNone(labels, '@display', '@unit', '@reconnect'), `unexpected: ${labels.join(',')}`);
});

test('properties: submodule scope offers @display and @dynamic', async () => {
  const ned = `simple Foo { }
module M {
    submodules:
        a: Foo {
            @
        }
}
`;
  const cache = await nedCache({ 'file:///s.ned': ned });
  const labels = completeAt(cache, 'file:///s.ned', 4);
  assert.ok(has(labels, '@display', '@dynamic'), `missing submodule props: ${labels.join(',')}`);
  assert.ok(hasNone(labels, '@reconnect', '@loose'), `unexpected: ${labels.join(',')}`);
});

test('properties: connection scope offers @display and @reconnect', async () => {
  const ned = `simple SBase {
    gates:
        input in;
        output out;
}
module M {
    submodules:
        a: SBase {}
        b: SBase {}
    connections:
        a.out --> {
            @display("x");
            @
        } --> b.in;
}
`;
  const cache = await nedCache({ 'file:///c.ned': ned });
  const labels = completeAt(cache, 'file:///c.ned', 12);
  assert.ok(has(labels, '@display', '@reconnect'), `missing connection props: ${labels.join(',')}`);
  assert.ok(hasNone(labels, '@loose', '@unit'), `unexpected: ${labels.join(',')}`);
});

test('properties: file scope offers @namespace and @license', async () => {
  const ned = `@
`;
  const cache = await nedCache({ 'file:///f.ned': ned });
  const labels = completeAt(cache, 'file:///f.ned', 0);
  assert.ok(has(labels, '@namespace', '@license'), `missing file props: ${labels.join(',')}`);
  assert.ok(hasNone(labels, '@display', '@unit'), `unexpected: ${labels.join(',')}`);
});

test('properties: insert snippets carry the leading @ and arg placeholders', async () => {
  const ned = `module M {
    parameters:
        @
}
`;
  const cache = await nedCache({ 'file:///x.ned': ned });
  const file = cache.getFile('file:///x.ned')!;
  const items = nedCompletion(cache, file, file.tree, { line: 2, character: 9 }, '        @');
  const cls = items.find((i) => i.label === '@class');
  assert.ok(cls && cls.insertText === '@class(${1:cppClass})', `bad @class insert: ${cls?.insertText}`);
  const mut = items.find((i) => i.label === '@mutable');
  assert.ok(mut && mut.insertText === '@mutable', `bad @mutable insert: ${mut?.insertText}`);
});

test('@enum values parse without stray quotes regardless of spacing after commas', async () => {
  const cache = await nedCache({
    'file:///E.ned':
      'simple E { parameters: string velocityProjection @enum("projected", "trueLength", "isometric") = default("projected"); }',
  });
  const p = cache.getType('E')!.localParams().get('velocityProjection')!;
  // Before the fix, values after the first kept a leading quote ('"trueLength').
  assert.deepEqual(p.enumValues, ['projected', 'trueLength', 'isometric']);
});
