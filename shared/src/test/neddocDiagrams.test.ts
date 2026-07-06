import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { layeredLayout } from '../neddoc/layeredLayout';
import { renderGraphDiagramSvg, type DocGraph } from '../neddoc/graphDiagram';
import { renderTypeFigureSvg } from '../neddoc/typeFigure';
import { collectNeddoc, createDiagramRenderer } from '../neddoc/generate';
import type { IconProvider } from '../graphics/diagramLayout';

// ---- layered layout -------------------------------------------------------------

const box = (id: string, width = 60) => ({ id, width, height: 24 });

test('layeredLayout: ranks are monotone along edges', () => {
  const nodes = [box('a'), box('b'), box('c'), box('d')];
  const edges = [
    { src: 'a', dest: 'b' },
    { src: 'b', dest: 'c' },
    { src: 'a', dest: 'd' },
  ];
  const { pos } = layeredLayout(nodes, edges);
  assert.ok(pos.get('a')!.y < pos.get('b')!.y);
  assert.ok(pos.get('b')!.y < pos.get('c')!.y);
  assert.ok(pos.get('a')!.y < pos.get('d')!.y);
});

test('layeredLayout: no overlap within a rank', () => {
  const nodes = [box('root'), box('s1'), box('s2'), box('s3'), box('s4')];
  const edges = ['s1', 's2', 's3', 's4'].map((s) => ({ src: 'root', dest: s }));
  const { pos, width } = layeredLayout(nodes, edges);
  const xs = ['s1', 's2', 's3', 's4'].map((s) => pos.get(s)!.x).sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= 60, `overlap: ${xs.join(',')}`);
  assert.ok(width >= 4 * 60);
});

test('layeredLayout: cycles do not hang and still produce positions', () => {
  const nodes = [box('a'), box('b')];
  const edges = [
    { src: 'a', dest: 'b' },
    { src: 'b', dest: 'a' },
  ];
  const { pos } = layeredLayout(nodes, edges);
  assert.equal(pos.size, 2);
});

test('layeredLayout: empty graph', () => {
  const r = layeredLayout([], []);
  assert.equal(r.pos.size, 0);
});

// ---- graph diagram ------------------------------------------------------------------

const GRAPH: DocGraph = {
  nodes: [
    { id: 'lib.Node', label: 'Node', kind: 'simple', focus: true, tooltip: 'simple module Node' },
    { id: 'lib.Base', label: 'Base', kind: 'simple' },
    { id: 'lib.IApp', label: 'IApp', kind: 'moduleinterface' },
    { id: 'unresolved:Gone', label: 'Gone', kind: 'unresolved' },
  ],
  edges: [
    { src: 'lib.Base', dest: 'lib.Node', kind: 'inheritance' },
    { src: 'lib.IApp', dest: 'lib.Node', kind: 'interface' },
    { src: 'unresolved:Gone', dest: 'lib.Node', kind: 'inheritance' },
  ],
};

test('graphDiagram: Eclipse colors, dashed interfaces, hollow arrowheads, links', () => {
  const { svg, areas } = renderGraphDiagramSvg(GRAPH, {
    hrefFor: (id) => (id.startsWith('unresolved') ? undefined : `../types/${id}.html`),
  });
  // focus node gets the strong yellow, neighbor the pale one
  assert.ok(svg.includes('fill="#fff700"'), 'focus fill');
  assert.ok(svg.includes('fill="#fffcaf"'), 'neighbor fill');
  // unresolved node in red
  assert.ok(svg.includes('fill="#ff0000"'), 'unresolved fill');
  // interface node border dashed
  assert.ok(svg.includes('stroke-dasharray="4 2"'), 'dashed interface');
  // hollow triangle (white fill) for inheritance arrowheads
  assert.ok(/polygon[^>]*fill="white"/.test(svg), 'hollow arrowhead');
  // links on resolvable nodes only
  assert.ok(svg.includes('<a href="../types/lib.Base.html" target="_top">'), 'node link');
  assert.ok(!svg.includes('href="../types/unresolved'), 'no link for unresolved');
  // tooltips
  assert.ok(svg.includes('<title>simple module Node</title>'));
  assert.equal(areas.length, 4);
});

test('graphDiagram: usage edges get filled arrowheads', () => {
  const usage: DocGraph = {
    nodes: [
      { id: 'a', label: 'A', kind: 'compound', focus: true },
      { id: 'b', label: 'B', kind: 'simple' },
    ],
    edges: [{ src: 'a', dest: 'b', kind: 'usage' }],
  };
  const { svg } = renderGraphDiagramSvg(usage);
  assert.ok(/polygon[^>]*fill="#404040"/.test(svg), 'filled usage arrowhead');
  assert.ok(!/fill="white"/.test(svg), 'no hollow arrowhead expected');
});

// ---- type figure + full pipeline -------------------------------------------------------

const fakeIcons: IconProvider = {
  get: () => Promise.resolve({ href: 'icons/stub.png', width: 32, height: 20 }),
};

async function nedCache(files: Record<string, string>): Promise<NedResourceCache> {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  for (const [uri, text] of Object.entries(files)) cache.addFile(uri, svc.parse('ned', text), '');
  return cache;
}

const LIB = `package lib;
simple Node { gates: inout g[]; }
simple Sink extends Node { }
network Net
{
    submodules:
        n: Node;
        s: Sink;
    connections:
        n.g++ <--> s.g++;
}
`;

test('typeFigure: compound modules render the full diagram with submodule links', async () => {
  const cache = await nedCache({ 'file:///lib.ned': LIB });
  const result = await renderTypeFigureSvg(cache, cache.getType('lib.Net')!, {
    icons: fakeIcons,
    linkHrefFor: (fq) => `../types/${fq}.html`,
  });
  assert.ok(result);
  assert.ok(result!.svg.includes('<a href="../types/lib.Node.html" target="_top">'), result!.svg.slice(0, 400));
  assert.equal(result!.areas.length, 2);
});

test('typeFigure: simple modules render the card', async () => {
  const cache = await nedCache({ 'file:///lib.ned': LIB });
  const result = await renderTypeFigureSvg(cache, cache.getType('lib.Node')!, { icons: fakeIcons });
  assert.ok(result);
  assert.ok(result!.svg.includes('>simple</text>'), 'kind caption expected');
});

test('neddoc end-to-end: diagrams rendered and referenced by the html output', async () => {
  const cache = await nedCache({ 'file:///lib.ned': LIB });
  const renderDiagram = createDiagramRenderer({ nedCache: cache, icons: fakeIcons });
  const { files, result } = await collectNeddoc({ nedCache: cache }, { format: 'html' }, renderDiagram);
  assert.ok(result.diagrams > 0, 'diagrams expected');
  // Net gets a type figure; Node an inheritance + usage diagram
  assert.ok(files.some((f) => f.relativePath === 'images/lib.Net-type.svg'));
  assert.ok(files.some((f) => f.relativePath === 'images/lib.Node-inheritance.svg'));
  assert.ok(files.some((f) => f.relativePath === 'images/lib.Node-usage.svg'));
  const inheritance = files.find((f) => f.relativePath === 'images/lib.Node-inheritance.svg')!.content as string;
  // subtype link relative to the images/ dir
  assert.ok(inheritance.includes('<a href="../types/lib.Sink.html" target="_top">'), inheritance);
  // the Node page inlines the inheritance diagram
  const nodePage = files.find((f) => f.relativePath === 'types/lib.Node.html')!.content as string;
  assert.ok(nodePage.includes('Inheritance diagram'), 'diagram section missing');
  assert.ok(nodePage.includes('<div class="diagram"><svg'), 'inline svg missing');
  // links rebased for the page directory
  assert.ok(nodePage.includes('<a href="lib.Sink.html" target="_top">'), 'rebased link missing');
});
