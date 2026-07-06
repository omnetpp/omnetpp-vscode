import { test } from 'bun:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { MsgResourceCache } from '../msg/msgResourceCache';
import type { NeddocInput } from '../neddoc/extract';
import { collectNeddoc } from '../neddoc/generate';

const legacyDir = resolve(__dirname, '..', '..', '..', 'resources', 'neddoc-legacy');

function loadLegacyAssets(): Record<string, string | Uint8Array> {
  const assets: Record<string, string | Uint8Array> = {};
  for (const f of readdirSync(legacyDir)) assets[f] = readFileSync(join(legacyDir, f));
  return assets;
}

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
// A node; see ~Sink.
simple Node
{
    parameters:
        double rate = default(100bps); // the rate
    gates:
        inout g[];
}
simple Sink extends Node { }
network Net { submodules: n: Node; s: Sink; connections: n.g++ <--> s.g++; }
`;

const MSG = `namespace lib;
packet FooPkt { int seq; }
`;

test('neddoc legacy-html: Eclipse flat file naming and page.tmpl chrome', async () => {
  const { files } = await collectNeddoc(await buildInput({ 'file:///lib.ned': LIB }, { 'file:///p.msg': MSG }), {
    format: 'legacy-html',
    legacyAssets: loadLegacyAssets(),
  });
  const paths = files.map((f) => f.relativePath);
  // flat layout, fq-name file names, msg :: -> -
  assert.ok(paths.includes('lib.Node.html'), paths.join());
  assert.ok(paths.includes('lib-FooPkt.html'), paths.join());
  assert.ok(paths.includes('index.html'));
  assert.ok(paths.includes('packages.html'));
  // template assets shipped
  for (const asset of ['style.css', 'jquery.js', 'navtree.js', 'material.min.js', 'material.blue-light_blue.min.css'])
    assert.ok(paths.includes(asset), `missing ${asset}`);
  // nav data files
  assert.ok(paths.includes('navtreedata.js'));
  assert.ok(paths.includes('navtreeindex0.js'));

  const nodePage = files.find((f) => f.relativePath === 'lib.Node.html')!.content as string;
  // page.tmpl chrome with the title substituted
  assert.ok(nodePage.includes('<div class="mdl-layout'), 'material layout missing');
  assert.ok(nodePage.includes('<title>Node</title>'), 'title not substituted');
  // Eclipse typeSectionHeading markup: floated h2 + colored chip
  assert.ok(nodePage.includes('<h2 class="comptitle" style="float: left;">Node</h2>'), nodePage.slice(0, 500));
  assert.ok(nodePage.includes('mdl-chip__text">simple module<'), 'kind chip missing');
  assert.ok(nodePage.includes('background-color: #ff000040'), 'simple module chip color');
  // flat sibling links
  assert.ok(nodePage.includes('href="lib.Sink.html"'), '~ref link should be flat');
  // subsection heading markup
  assert.ok(nodePage.includes('<h3 class="subtitle">Parameters</h3>'));
  // th class names
  assert.ok(nodePage.includes('<th class="defaultvalue">Default value</th>'), nodePage);
});

test('neddoc legacy-html: client-side type search is wired into the chrome', async () => {
  const { files } = await collectNeddoc(await buildInput({ 'file:///lib.ned': LIB }, { 'file:///p.msg': MSG }), {
    format: 'legacy-html',
    legacyAssets: loadLegacyAssets(),
  });
  const paths = files.map((f) => f.relativePath);
  // search assets emitted alongside the nav data
  assert.ok(paths.includes('search-data.js'), paths.join());
  assert.ok(paths.includes('neddoc-search.js'), paths.join());

  // search-data.js is a JS global with flat root-relative hrefs and every type
  const searchData = files.find((f) => f.relativePath === 'search-data.js')!.content as string;
  assert.ok(searchData.startsWith('var NEDDOC_SEARCH = ['), searchData.slice(0, 60));
  const index = JSON.parse(searchData.slice(searchData.indexOf('['), searchData.lastIndexOf(']') + 1));
  const node = index.find((e: { n: string }) => e.n === 'Node');
  assert.ok(node, searchData);
  assert.strictEqual(node.f, 'lib.Node');
  assert.strictEqual(node.k, 'simple module');
  assert.strictEqual(node.p, 'lib.Node.html');
  assert.ok(index.some((e: { n: string; p: string }) => e.n === 'FooPkt' && e.p === 'lib-FooPkt.html'), searchData);

  // the header search box + script includes are injected into each page
  const nodePage = files.find((f) => f.relativePath === 'lib.Node.html')!.content as string;
  assert.ok(nodePage.includes('id="nd-search-input"'), 'search box not injected');
  assert.ok(nodePage.includes('src="search-data.js"'), 'search-data.js not included');
  assert.ok(nodePage.includes('src="neddoc-search.js"'), 'neddoc-search.js not included');
  // the vendored template stays a verbatim Eclipse snapshot (spacer preserved)
  assert.ok(nodePage.includes('<div class="mdl-layout-spacer"></div>'), 'spacer anchor lost');
});

test('neddoc legacy-html: index page is the Eclipse default overview', async () => {
  const { files } = await collectNeddoc(await buildInput({ 'file:///lib.ned': LIB }), {
    format: 'legacy-html',
    legacyAssets: loadLegacyAssets(),
  });
  const index = files.find((f) => f.relativePath === 'index.html')!.content as string;
  assert.ok(index.includes('OMNeT++ Model Documentation'), index.slice(0, 300));
  assert.ok(index.includes('Generated by neddoc.'));
});

test('neddoc legacy-html: navtreedata.js follows the Eclipse array format', async () => {
  const { files } = await collectNeddoc(await buildInput({ 'file:///lib.ned': LIB }), {
    format: 'legacy-html',
    legacyAssets: loadLegacyAssets(),
  });
  const nav = files.find((f) => f.relativePath === 'navtreedata.js')!.content as string;
  assert.ok(nav.includes('var NAVTREE ='), nav.slice(0, 100));
  // backtick-quoted [title, url, children] entries
  assert.ok(/\[`Networks`, null, \[/.test(nav), nav);
  assert.ok(/\[`Net`, `lib\.Net\.html`, null\]/.test(nav), nav);
  assert.ok(/\[`Overview`, `index\.html`, null\]/.test(nav), nav);

  const idx = files.find((f) => f.relativePath === 'navtreeindex0.js')!.content as string;
  assert.ok(idx.startsWith('var NAVTREEINDEX0 = {'), idx.slice(0, 60));
  assert.ok(/'lib\.Net\.html':\[\d+(,\d+)*\],/.test(idx), idx);
});

test('neddoc legacy-html: diagrams embed via <object> with root-level names', async () => {
  const { files } = await collectNeddoc(
    await buildInput({ 'file:///lib.ned': LIB }),
    { format: 'legacy-html', legacyAssets: loadLegacyAssets() },
    () => '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  const netPage = files.find((f) => f.relativePath === 'lib.Net.html')!.content as string;
  assert.ok(netPage.includes('<object type="image/svg+xml" data="lib.Net-type.svg"></object>'), netPage);
  assert.ok(files.some((f) => f.relativePath === 'lib.Net-type.svg'), 'svg should be written at the root');
});

test('neddoc legacy-html: missing assets produce a clear error', async () => {
  const input = await buildInput({ 'file:///lib.ned': LIB });
  await assert.rejects(() => collectNeddoc(input, { format: 'legacy-html' }), /legacy-html format needs/);
});
