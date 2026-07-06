import { test } from 'bun:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getParsers } from './helpers';

function resolveLegacyDir(): string {
  return resolve(__dirname, '..', '..', '..', 'resources', 'neddoc-legacy');
}
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

// ---- markdown output ---------------------------------------------------------

test('neddoc markdown: pages, SUMMARY.md, tables and links', async () => {
  const { files } = await collectNeddoc(await buildInput({ 'file:///lib.ned': LIB }), { format: 'markdown' });
  const paths = files.map((f) => f.relativePath);
  assert.ok(paths.includes('index.md'));
  assert.ok(paths.includes('types/lib.Node.md'));
  assert.ok(paths.includes('SUMMARY.md'));

  const nodePage = files.find((f) => f.relativePath === 'types/lib.Node.md')!.content as string;
  assert.ok(nodePage.startsWith('# Node'), nodePage.slice(0, 40));
  // ~ref resolves to a relative md link
  assert.ok(nodePage.includes('[Sink](lib.Sink.md)'), nodePage);
  // parameters pipe table
  assert.ok(nodePage.includes('| Name | Type | Default value | Description |'), nodePage);
  assert.ok(/\| rate \| double \| 100bps \|.*transmission rate.*\|/.test(nodePage), nodePage);
  // fenced source with language tag
  assert.ok(nodePage.includes('```ned\n'));
  // heading anchors for section links
  assert.ok(nodePage.includes('<a id="parameters"></a>'));

  const summary = files.find((f) => f.relativePath === 'SUMMARY.md')!.content as string;
  assert.ok(summary.includes('- [Overview](index.md)'));
  assert.ok(summary.includes('  - [Net](types/lib.Net.md)'), summary);
});

// ---- rst output ------------------------------------------------------------------

test('neddoc rst: labels, refs, list-tables and toctree', async () => {
  const { files } = await collectNeddoc(await buildInput({ 'file:///lib.ned': LIB }), { format: 'rst' });
  const paths = files.map((f) => f.relativePath);
  assert.ok(paths.includes('index.rst'));
  assert.ok(paths.includes('types/lib.Node.rst'));

  const nodePage = files.find((f) => f.relativePath === 'types/lib.Node.rst')!.content as string;
  // page label + title underline
  assert.ok(nodePage.startsWith('.. _neddoc-lib-node:\n\nNode\n===='), nodePage.slice(0, 60));
  // ~ref resolves to a :ref: role against the target page label
  assert.ok(nodePage.includes(':ref:`Sink <neddoc-lib-sink>`'), nodePage);
  // parameters list-table with section label
  assert.ok(nodePage.includes('.. _neddoc-lib-node-parameters:'), nodePage);
  assert.ok(nodePage.includes('.. list-table::'), nodePage);
  assert.ok(nodePage.includes('     - transmission rate'), nodePage);
  // source code block
  assert.ok(nodePage.includes('.. code-block:: ned'));

  const index = files.find((f) => f.relativePath === 'index.rst')!.content as string;
  assert.ok(index.includes('.. toctree::'));
  assert.ok(index.includes('   types/lib.Node'), index);
});

test('neddoc rst: subheading underline lengths match text', async () => {
  const { files } = await collectNeddoc(await buildInput({ 'file:///lib.ned': LIB }), { format: 'rst' });
  const nodePage = files.find((f) => f.relativePath === 'types/lib.Node.rst')!.content as string;
  assert.ok(nodePage.includes('Parameters\n----------'), nodePage);
});

test('neddoc: unknown format throws', async () => {
  const input = await buildInput({ 'file:///lib.ned': LIB });
  await assert.rejects(() => collectNeddoc(input, { format: 'bogus' as never }), /not implemented/);
});

// ---- nedtags.xml / msgtags.xml -----------------------------------------------

const MSG = `namespace lib;
packet FooPkt { int seq; }
`;

test('neddoc tag files: Eclipse-style nedtags.xml and msgtags.xml', async () => {
  const { files } = await collectNeddoc(await buildInput({ 'file:///lib.ned': LIB }, { 'file:///p.msg': MSG }), {
    format: 'html',
  });
  const nedtags = files.find((f) => f.relativePath === 'nedtags.xml')!.content as string;
  assert.ok(nedtags.startsWith("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<tagfile>"), nedtags.slice(0, 80));
  // qualified NED name + the renderer's page path
  assert.ok(
    nedtags.includes(
      '  <compound kind="class">\n    <name>lib.Node</name>\n    <filename>types/lib.Node.html</filename>\n  </compound>',
    ),
    nedtags,
  );
  assert.ok(!nedtags.includes('FooPkt'), 'msg types must not appear in nedtags.xml');

  const msgtags = files.find((f) => f.relativePath === 'msgtags.xml')!.content as string;
  // MSG types are listed under their simple name (Eclipse behavior)
  assert.ok(
    msgtags.includes('<name>FooPkt</name>\n    <filename>types/msg-lib--FooPkt.html</filename>'),
    msgtags,
  );
  assert.ok(!msgtags.includes('lib.Node'), 'ned types must not appear in msgtags.xml');
});

test('neddoc tag files: filenames follow the active format', async () => {
  const input = await buildInput({ 'file:///lib.ned': LIB }, { 'file:///p.msg': MSG });
  const md = await collectNeddoc(input, { format: 'markdown' });
  const mdTags = md.files.find((f) => f.relativePath === 'nedtags.xml')!.content as string;
  assert.ok(mdTags.includes('<filename>types/lib.Node.md</filename>'), mdTags);

  // legacy layout: flat Eclipse naming, exactly what the Eclipse tag files carry
  const legacyDir = resolveLegacyDir();
  const legacyAssets: Record<string, string | Uint8Array> = {};
  for (const f of readdirSync(legacyDir)) legacyAssets[f] = readFileSync(join(legacyDir, f));
  const legacy = await collectNeddoc(input, { format: 'legacy-html', legacyAssets });
  const legacyNed = legacy.files.find((f) => f.relativePath === 'nedtags.xml')!.content as string;
  assert.ok(legacyNed.includes('<filename>lib.Node.html</filename>'), legacyNed);
  const legacyMsg = legacy.files.find((f) => f.relativePath === 'msgtags.xml')!.content as string;
  assert.ok(legacyMsg.includes('<filename>lib-FooPkt.html</filename>'), legacyMsg);
});

test('neddoc tag files: msgtags.xml omitted when message definitions are off', async () => {
  const { files } = await collectNeddoc(await buildInput({ 'file:///lib.ned': LIB }, { 'file:///p.msg': MSG }), {
    format: 'html',
    messageDefinitions: false,
  });
  assert.ok(files.some((f) => f.relativePath === 'nedtags.xml'));
  assert.ok(!files.some((f) => f.relativePath === 'msgtags.xml'));
});
