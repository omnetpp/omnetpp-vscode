import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { MsgResourceCache } from '../msg/msgResourceCache';
import type { NeddocInput } from '../neddoc/extract';
import { collectNeddoc } from '../neddoc/generate';
import { dirOf, relativeRef } from '../neddoc/renderer';

async function buildInput(nedFiles: Record<string, string>, msgFiles: Record<string, string> = {}): Promise<NeddocInput> {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  nedCache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  for (const [uri, text] of Object.entries(nedFiles)) nedCache.addFile(uri, svc.parse('ned', text), '');
  const msgCache = new MsgResourceCache();
  for (const [uri, text] of Object.entries(msgFiles)) msgCache.addFile(uri, svc.parse('msg', text));
  return { nedCache, msgCache };
}

const LIB = `package lib;
// Base node; talks to ~Sink instances.
simple Node
{
    parameters:
        double rate @unit(bps) = default(100bps); // transmission rate
    gates:
        inout g[];
}
// Receives from ~Node.
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

// ---- path helpers -------------------------------------------------------------

test('neddoc render: relativeRef computes ../ paths', () => {
  assert.equal(relativeRef('', 'index.html'), 'index.html');
  assert.equal(relativeRef('types', 'index.html'), '../index.html');
  assert.equal(relativeRef('types', 'types/lib.Node.html'), 'lib.Node.html');
  assert.equal(relativeRef('', 'types/lib.Node.html'), 'types/lib.Node.html');
  assert.equal(relativeRef('types', 'images/x.svg'), '../images/x.svg');
  assert.equal(dirOf('types/a.html'), 'types');
  assert.equal(dirOf('index.html'), '');
});

// ---- html output ----------------------------------------------------------------

test('neddoc html: generates pages, assets and cross-page links', async () => {
  const { files, result } = await collectNeddoc(await buildInput({ 'file:///lib.ned': LIB }), { format: 'html' });
  const paths = files.map((f) => f.relativePath);
  assert.ok(paths.includes('index.html'), paths.join());
  assert.ok(paths.includes('packages.html'));
  assert.ok(paths.includes('types/lib.Node.html'));
  assert.ok(paths.includes('assets/style.css'));
  assert.ok(paths.includes('assets/neddoc.js'));
  assert.ok(paths.includes('assets/navtree-data.js'));
  assert.ok(paths.includes('assets/search-data.js'));
  assert.equal(result.pages, paths.filter((p) => p.endsWith('.html')).length);
  assert.equal(result.diagrams, 0); // no diagram renderer wired

  const nodePage = files.find((f) => f.relativePath === 'types/lib.Node.html')!.content as string;
  // description ~ref -> relative link to the sibling type page
  assert.ok(nodePage.includes('<a href="lib.Sink.html">Sink</a>'), nodePage);
  // package line links up to packages.html with the package anchor
  assert.ok(nodePage.includes('href="../packages.html#lib"'), nodePage);
  // parameters table with anchors and row classes
  assert.ok(nodePage.includes('id="param-rate"'));
  assert.ok(nodePage.includes('transmission rate'));
  // badge and heading
  assert.ok(nodePage.includes('badge-simple'));
  assert.ok(nodePage.includes('<h1>Node</h1>'));
  // source listing escaped
  assert.ok(nodePage.includes('<pre class="src src-ned">'));

  const sinkPage = files.find((f) => f.relativePath === 'types/lib.Sink.html')!.content as string;
  assert.ok(sinkPage.includes('class="inherited"') || sinkPage.includes("class=\"inherited\""), 'inherited row styling');

  const packagesPage = files.find((f) => f.relativePath === 'packages.html')!.content as string;
  assert.ok(packagesPage.includes('id="lib"'));
  assert.ok(packagesPage.includes('href="types/lib.Node.html"'));
});

test('neddoc html: nav and search data are valid JS with expected entries', async () => {
  const { files } = await collectNeddoc(await buildInput({ 'file:///lib.ned': LIB }), { format: 'html' });
  const nav = files.find((f) => f.relativePath === 'assets/navtree-data.js')!.content as string;
  const navJson = JSON.parse(nav.replace('window.NEDDOC_NAV = ', '').replace(/;\n$/, ''));
  const titles = navJson.c.map((n: { t: string }) => n.t);
  assert.deepEqual(titles, ['Overview', 'Packages', 'Networks', 'Modules']);

  const search = files.find((f) => f.relativePath === 'assets/search-data.js')!.content as string;
  const searchJson = JSON.parse(search.replace('window.NEDDOC_SEARCH = ', '').replace(/;\n$/, ''));
  const node = searchJson.find((e: { f: string }) => e.f === 'lib.Node');
  assert.ok(node);
  assert.equal(node.p, 'types/lib.Node.html');
});

test('neddoc html: diagram sections render inline SVG when a renderer is wired', async () => {
  const { files } = await collectNeddoc(
    await buildInput({ 'file:///lib.ned': LIB }),
    { format: 'html' },
    (req) => `<svg xmlns="http://www.w3.org/2000/svg"><a href="../types/lib.Node.html"><rect/></a><!--${req.diagram}--></svg>`,
  );
  const netPage = files.find((f) => f.relativePath === 'types/lib.Net.html')!.content as string;
  assert.ok(netPage.includes('<div class="diagram"><svg'), 'inline svg present');
  // svg written as a file too
  assert.ok(files.some((f) => f.relativePath === 'images/lib.Net-type.svg'));
  // links inside the inlined svg are rebased for the page directory
  assert.ok(netPage.includes('href="lib.Node.html"'), netPage.match(/href="[^"]*lib\.Node[^"]*"/)?.[0]);
});

test('neddoc html: unknown format throws', async () => {
  const input = await buildInput({ 'file:///lib.ned': LIB });
  await assert.rejects(() => collectNeddoc(input, { format: 'markdown' }), /not implemented/);
});
