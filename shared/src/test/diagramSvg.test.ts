import { test } from 'bun:test';
import assert from 'node:assert';
import type { PreviewScene, PreviewSubmodule } from '../protocol';
import { buildCardFigure, buildDiagram, type IconProvider } from '../graphics/diagramLayout';
import { renderCardSvg, renderDiagramSvg } from '../graphics/diagramSvg';

// Structural checks of the string SVG renderer shared by the preview webview
// (via DOMParser) and the documentation generator.

const icons: IconProvider = {
  get: (id, _size, tintColor, tintPct) =>
    Promise.resolve({
      href: `icons/${id}.png`,
      width: 32,
      height: 20,
      tint: tintColor ? { color: '#ff0000', pct: tintPct ?? 30 } : undefined,
    }),
};
const opts = (seed = 1) => ({ icons, measureText: (t: string) => 7 * t.length, seed });

function sub(name: string, display: string[], extra: Partial<PreviewSubmodule> = {}): PreviewSubmodule {
  return {
    name,
    isLike: false,
    displayChain: display,
    declUri: 'file:///net.ned',
    declRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    ...extra,
  };
}

function scene(overrides: Partial<PreviewScene>): PreviewScene {
  return {
    kind: 'compound',
    fqName: 'demo.Net',
    simpleName: 'Net',
    isNetwork: false,
    typeUri: 'file:///net.ned',
    displayChain: ['bgb=400,300'],
    icons: [],
    submodules: [],
    connections: [],
    ...overrides,
  };
}

const CONN = {
  srcGate: 'g',
  destGate: 'g',
  bidirectional: false,
  isLoop: false,
  isConditional: false,
  displayChain: [] as string[],
  declUri: 'file:///net.ned',
  declRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
};

async function demoModel() {
  return buildDiagram(
    scene({
      submodules: [
        sub('a', ['p=100,100', 'i=device/pc'], { resolvedTypeFqName: 'demo.Node' }),
        sub('b', ['p=300,100', 'i=device/pc'], { resolvedTypeFqName: 'demo.Sink' }),
      ],
      connections: [{ ...CONN, srcModule: 'a', destModule: 'b' }],
    }),
    opts(),
  );
}

test('diagramSvg: structure, layers, tooltips and hit-test attributes', async () => {
  const { svg, width, height, areas } = renderDiagramSvg(await demoModel(), { title: 'Net' });
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), svg.slice(0, 80));
  assert.ok(width > 400 && height > 300, `${width}x${height}`);
  // 2 submodule groups with data-sub, one connection with data-conn
  assert.equal((svg.match(/data-sub="/g) ?? []).length, 2);
  assert.equal((svg.match(/data-conn="/g) ?? []).length, 1);
  // tooltips as <title>, arrowhead polygon, name labels
  assert.ok(svg.includes('<title>a: demo.Node</title>'), svg);
  assert.ok(svg.includes('<polygon points='), 'arrowhead missing');
  assert.ok(svg.includes('>a</text>') && svg.includes('>b</text>'), 'name labels missing');
  // background rect with the bgb size
  assert.ok(svg.includes('width="400" height="300"'), 'background rect missing');
  // no links when linkHrefFor is absent, but areas still reported
  assert.ok(!svg.includes('<a '), 'unexpected links');
  assert.equal(areas.length, 2);
  assert.equal(areas[0].targetFqName, 'demo.Node');
  assert.ok(areas[0].x >= 0 && areas[0].y >= 0, 'area coords must be in image space');
});

test('diagramSvg: linkHrefFor wraps submodules in <a href>', async () => {
  const { svg, areas } = renderDiagramSvg(await demoModel(), {
    linkHrefFor: (fq) => `../types/${fq}.html`,
  });
  assert.ok(svg.includes('<a href="../types/demo.Node.html" target="_top"><g data-sub="0"'), svg);
  assert.equal(areas[1].href, '../types/demo.Sink.html');
});

test('diagramSvg: tinted icons get a color-matrix filter', async () => {
  const model = await buildDiagram(
    scene({ submodules: [sub('t', ['p=50,50;i=block/proc,red,50'])] }),
    opts(),
  );
  const { svg } = renderDiagramSvg(model, {});
  assert.ok(svg.includes('<defs><filter id="tint0" color-interpolation-filters="sRGB">'), svg.slice(0, 400));
  assert.ok(svg.includes('feColorMatrix'), 'matrix missing');
  assert.ok(svg.includes('filter="url(#tint0)"'), 'filter not applied to image');
  // untinted icons don't get filters
  const plain = renderDiagramSvg(await demoModel(), {});
  assert.ok(!plain.svg.includes('<defs>'), 'no defs expected without tint');
});

test('diagramSvg: card rendering for non-compound types', async () => {
  const s = scene({ kind: 'simple', fqName: 'demo.Node', simpleName: 'Node', displayChain: ['i=device/pc'], submodules: undefined, connections: undefined });
  const figure = await buildCardFigure(s, opts());
  const { svg, width, height } = renderCardSvg(s, figure);
  assert.ok(width >= 160 && height > 0);
  assert.ok(svg.includes('>Node</text>'), 'type name label missing');
  assert.ok(svg.includes('>simple</text>'), 'kind caption missing');
});

test('diagramSvg: text content and attributes are XML-escaped', async () => {
  const model = await buildDiagram(
    scene({ submodules: [sub('x', ['p=10,10;i=device/pc;tt=a<b&"c"'])] }),
    opts(),
  );
  const { svg } = renderDiagramSvg(model, { title: '<Net> & co' });
  assert.ok(svg.includes('&lt;Net&gt; &amp; co'), 'title not escaped');
  assert.ok(svg.includes('a&lt;b&amp;'), 'tooltip not escaped');
  assert.ok(!/<b&/.test(svg), 'unescaped markup leaked');
});
