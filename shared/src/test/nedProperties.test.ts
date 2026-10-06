import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { nedCompletion } from '../ned/nedCompletion';
import { unquotePropertyValue } from '../ned/nedAst';

async function nedCache(files: Record<string, string>) {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  for (const [uri, text] of Object.entries(files)) cache.addFile(uri, svc.parse('ned', text), '');
  return cache;
}

/** Completion labels with the cursor at the END of the given line index. */
function completeAt(cache: NedResourceCache, uri: string, lineIdx: number, iconIds: string[] = []): string[] {
  const file = cache.getFile(uri)!;
  const lines = file.tree.rootNode.text.split('\n');
  const line = lines[lineIdx];
  return nedCompletion(cache, file, file.tree, { line: lineIdx, character: line.length }, line, iconIds).map(
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

test('@unit(...) argument offers known unit names', async () => {
  const ned = `module M {
    parameters:
        double x @unit(
}
`;
  const cache = await nedCache({ 'file:///u.ned': ned });
  const labels = completeAt(cache, 'file:///u.ned', 2);
  assert.ok(has(labels, 's', 'ms', 'm', 'Hz', 'kg', 'bps'), `missing unit names: ${labels.join(',')}`);
});

test('@signal[...](...) argument offers unit=/enum=/type= templates, not statistic-only ones', async () => {
  const ned = `module M {
    @signal[s](
}
`;
  const cache = await nedCache({ 'file:///sig.ned': ned });
  const labels = completeAt(cache, 'file:///sig.ned', 1);
  assert.ok(has(labels, 'unit=', 'enum=', 'type='), `missing signal arg templates: ${labels.join(',')}`);
  assert.ok(hasNone(labels, 'title=', 'record=', 'interpolationmode=', 'source='),
    `unexpected statistic-only templates in @signal: ${labels.join(',')}`);
});

test('@statistic[...](...) argument offers the full parameter-name template set', async () => {
  const ned = `module M {
    @statistic[s](
}
`;
  const cache = await nedCache({ 'file:///stat.ned': ned });
  const labels = completeAt(cache, 'file:///stat.ned', 1);
  assert.ok(
    has(labels, 'title=', 'unit=', 'interpolationmode=', 'source=', 'enum=', 'record='),
    `missing statistic arg templates: ${labels.join(',')}`,
  );
});

test('@statistic[...](unit=... offers unit names', async () => {
  const ned = `module M {
    @statistic[s](unit=
}
`;
  const cache = await nedCache({ 'file:///statu.ned': ned });
  const labels = completeAt(cache, 'file:///statu.ned', 1);
  assert.ok(has(labels, 's', 'ms', 'Hz'), `missing unit names after unit=: ${labels.join(',')}`);
  assert.ok(hasNone(labels, 'title=', 'record='), `should not offer arg templates once past unit=: ${labels.join(',')}`);
});

test('@statistic[...](record=... offers the recording-mode enum', async () => {
  const ned = `module M {
    @statistic[s](record=
}
`;
  const cache = await nedCache({ 'file:///statr.ned': ned });
  const labels = completeAt(cache, 'file:///statr.ned', 1);
  assert.deepEqual(
    labels,
    ['auto', 'count', 'vector', 'last', 'sum', 'mean', 'min', 'max', 'timeavg', 'stats', 'histogram'],
  );
});

test('@statistic[...](record=vector,... continues offering the recording-mode enum after a comma', async () => {
  const ned = `module M {
    @statistic[s](record=vector,
}
`;
  const cache = await nedCache({ 'file:///statr2.ned': ned });
  const labels = completeAt(cache, 'file:///statr2.ned', 1);
  assert.ok(has(labels, 'stats', 'histogram'), `missing recording modes after comma: ${labels.join(',')}`);
});

test('@statistic[...](interpolationmode=... offers the interpolation-mode enum', async () => {
  const ned = `module M {
    @statistic[s](interpolationmode=
}
`;
  const cache = await nedCache({ 'file:///stati.ned': ned });
  const labels = completeAt(cache, 'file:///stati.ned', 1);
  assert.deepEqual(labels, ['none', 'linear', 'sample-hold', 'backward-sample-hold']);
});

test('@signal[...](record=... does not treat record= as a value trigger (statistic-only)', async () => {
  const ned = `module M {
    @signal[s](record=
}
`;
  const cache = await nedCache({ 'file:///sigr.ned': ned });
  const labels = completeAt(cache, 'file:///sigr.ned', 1);
  assert.ok(has(labels, 'unit=', 'enum=', 'type='),
    `@signal(record= should still offer signal arg templates: ${labels.join(',')}`);
  assert.ok(hasNone(labels, 'vector', 'stats', 'histogram', 'auto'),
    `@signal(record= must not offer the statistic-only recording-mode enum: ${labels.join(',')}`);
});

test('bare @display( argument position does not offer unit names (context isolation)', async () => {
  const ned = `module M {
    @display(
}
`;
  const cache = await nedCache({ 'file:///disp.ned': ned });
  const labels = completeAt(cache, 'file:///disp.ned', 1);
  assert.ok(hasNone(labels, 's', 'ms', 'Hz', 'unit=', 'record='),
    `@display( should not leak @unit/@statistic completions: ${labels.join(',')}`);
});

// --- @figure[...](...) type-aware completion (NedCanvasFigureValidator schema) ---

test('@figure[...]( first argument offers figure type-name candidates', async () => {
  const ned = `module M {
    @figure[f](
}
`;
  const cache = await nedCache({ 'file:///fig1.ned': ned });
  const labels = completeAt(cache, 'file:///fig1.ned', 1);
  assert.ok(
    has(labels, 'line', 'polyline', 'polygon', 'rectangle', 'oval', 'ring', 'pieslice', 'arc',
      'group', 'panel', 'text', 'label', 'image', 'pixmap', 'icon', 'path'),
    `missing figure type candidates: ${labels.join(',')}`,
  );
});

test('@figure[...](type=rectangle; offers rectangle-specific keys, not other types\' exclusive keys', async () => {
  const ned = `module M {
    @figure[f](type=rectangle;
}
`;
  const cache = await nedCache({ 'file:///fig2.ned': ned });
  const labels = completeAt(cache, 'file:///fig2.ned', 1);
  assert.ok(has(labels, 'bounds=x,y,width,height;'), `missing bounds= template: ${labels.join(',')}`);
  assert.ok(has(labels, 'cornerRadius=r;', 'cornerRadius=rx,ry;'), `missing cornerRadius= templates: ${labels.join(',')}`);
  assert.ok(has(labels, 'lineColor=lineColor;'), `missing generic lineColor= template: ${labels.join(',')}`);
  assert.ok(hasNone(labels, 'font=family,size,style;', 'text=text;', 'points=x1,y1, x2,y2;'),
    `rectangle must not offer text-only/line-only keys: ${labels.join(',')}`);
  assert.ok(hasNone(labels, 'innerSize=size;', 'innerSize=width,height;'),
    `rectangle must not offer ring-only innerSize=: ${labels.join(',')}`);
});

test('@figure[...](type=text; offers text-specific keys, not rectangle-exclusive keys', async () => {
  const ned = `module M {
    @figure[f](type=text;
}
`;
  const cache = await nedCache({ 'file:///fig3.ned': ned });
  const labels = completeAt(cache, 'file:///fig3.ned', 1);
  assert.ok(has(labels, 'font=family,size,style;'), `missing font= template for text: ${labels.join(',')}`);
  assert.ok(hasNone(labels, 'bounds=x,y,width,height;', 'cornerRadius=r;', 'cornerRadius=rx,ry;'),
    `text must not offer rectangle-only bounds=/cornerRadius= keys: ${labels.join(',')}`);
});

test('@figure[...](type=path; offers path-specific keys, not text-exclusive keys', async () => {
  const ned = `module M {
    @figure[f](type=path;
}
`;
  const cache = await nedCache({ 'file:///fig4.ned': ned });
  const labels = completeAt(cache, 'file:///fig4.ned', 1);
  assert.ok(has(labels, 'path=path;', 'offset=dx,dy;'), `missing path=/offset= templates: ${labels.join(',')}`);
  assert.ok(hasNone(labels, 'font=family,size,style;'), `path must not offer text-only font=: ${labels.join(',')}`);
});

test('@figure[...](type=ring; offers innerSize=, not the rectangle-only cornerRadius=', async () => {
  const ned = `module M {
    @figure[f](type=ring;
}
`;
  const cache = await nedCache({ 'file:///fig5.ned': ned });
  const labels = completeAt(cache, 'file:///fig5.ned', 1);
  assert.ok(has(labels, 'innerSize=size;', 'innerSize=width,height;'), `missing innerSize= templates: ${labels.join(',')}`);
  assert.ok(hasNone(labels, 'cornerRadius=r;', 'cornerRadius=rx,ry;'), `ring must not offer rectangle-only cornerRadius=: ${labels.join(',')}`);
});

test('@figure[...](...lineColor= offers color names', async () => {
  const ned = `module M {
    @figure[f](type=rectangle;lineColor=
}
`;
  const cache = await nedCache({ 'file:///fig6.ned': ned });
  const labels = completeAt(cache, 'file:///fig6.ned', 1);
  assert.ok(has(labels, 'black', 'red', 'blue'), `missing color names for lineColor=: ${labels.join(',')}`);
});

test('@figure[...](...image= offers the supplied icon-id list', async () => {
  const ned = `module M {
    @figure[f](type=icon;image=
}
`;
  const cache = await nedCache({ 'file:///fig7.ned': ned });
  const ICON_FIXTURE = ['device/pc', 'device/router', 'maps/world', 'status/ok'];
  const labels = completeAt(cache, 'file:///fig7.ned', 1, ICON_FIXTURE);
  assert.deepStrictEqual([...labels].sort(), [...ICON_FIXTURE].sort());
});

test('@figure[...](...transform= offers the 6 transform-function templates', async () => {
  const ned = `module M {
    @figure[f](type=rectangle;transform=
}
`;
  const cache = await nedCache({ 'file:///fig8.ned': ned });
  const labels = completeAt(cache, 'file:///fig8.ned', 1);
  for (const fn of ['translate', 'rotate', 'scale', 'skewx', 'skewy', 'matrix']) {
    assert.ok(labels.some((l) => l.startsWith(fn + '(')), `missing ${fn}(...) transform template: ${labels.join(',')}`);
  }
});

test('@figure[...](...align= (enum-valued key) offers its exact enum values', async () => {
  const ned = `module M {
    @figure[f](type=text;align=
}
`;
  const cache = await nedCache({ 'file:///fig9.ned': ned });
  const labels = completeAt(cache, 'file:///fig9.ned', 1);
  assert.deepStrictEqual(labels, ['left', 'center', 'right']);
});

test('findTypeProperty resolves @defaultStatistic (local) and inherits it, exposing its value + module tag', () => {
  return nedCache({
    'file:///Q.ned':
      'simple Base { @defaultStatistic(queueLength; module=q); }\n' +
      'simple Queue extends Base { }\n' +
      'simple Plain { }',
  }).then((cache) => {
    const base = cache.getType('Base')!.findTypeProperty('defaultStatistic')!;
    assert.ok(base, 'local @defaultStatistic found');
    assert.strictEqual(base.tags.find((t) => t.key === undefined || t.key === '')?.value, 'queueLength');
    assert.strictEqual(base.tags.find((t) => t.key === 'module')?.value, 'q');
    // inherited through extends
    assert.ok(cache.getType('Queue')!.findTypeProperty('defaultStatistic'), 'inherited @defaultStatistic found');
    // absent -> null
    assert.strictEqual(cache.getType('Plain')!.findTypeProperty('defaultStatistic'), null);
  });
});

test('unquotePropertyValue: quoted and unquoted single values mean the same', () => {
  assert.strictEqual(unquotePropertyValue('X2AppServer'), 'X2AppServer');
  assert.strictEqual(unquotePropertyValue('"X2AppServer"'), 'X2AppServer');
  assert.strictEqual(unquotePropertyValue('"inet::Packet"'), 'inet::Packet');
  assert.strictEqual(unquotePropertyValue('""'), '');
  assert.strictEqual(unquotePropertyValue('"a","b"'), '"a","b"', 'a list is not a single quoted value');
});

test('@isNetwork accepts quoted and unquoted values', async () => {
  const cache = await nedCache({
    'file:///N.ned':
      'module Bare { @isNetwork; }\n' +
      'module T1 { @isNetwork(true); }\n' +
      'module T2 { @isNetwork("true"); }\n' +
      'module F1 { @isNetwork(false); }\n' +
      'module F2 { @isNetwork("false"); }\n' +
      'module Sub extends F2 { }\n',
  });
  const isNet = (n: string) => cache.getType(n)!.isNetworkType();
  assert.deepStrictEqual(
    ['Bare', 'T1', 'T2', 'F1', 'F2', 'Sub'].map(isNet),
    [true, true, true, false, false, false],
  );
});
