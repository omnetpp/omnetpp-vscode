import { test } from 'bun:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { MsgResourceCache } from '../msg/msgResourceCache';
import { extractDocModel, type NeddocInput } from '../neddoc/extract';
import { defaultNeddocOptions, type NeddocOptions } from '../neddoc/options';
import { collectNeddoc } from '../neddoc/generate';
import { flattenInlines } from '../neddoc/commentEmit';
import type { DocBlock } from '../neddoc/commentAst';
import type { DocCell, DocModel, DocPage, DocSection } from '../neddoc/docModel';

const HOST = `  // Leading comment.
package demo;
// A host.
simple Host {
  gates:
    input in;
}
// The network.
network Net {
  types:
    channel C extends ned.DatarateChannel {}
  submodules:
    h: Host;
}
`;
const PKT = `namespace demo;
// A packet.
packet Pkt { int len; }
enum Kind { A = 1; }
`;

async function buildInput(isTargetUri?: (uri: string) => boolean): Promise<NeddocInput> {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  nedCache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  nedCache.addFile('file:///p/demo/Host.ned', svc.parse('ned', HOST), '');
  nedCache.addFile('file:///p/demo/package.ned', svc.parse('ned', 'package demo;\n'), '');
  nedCache.addFile('file:///p/Alpha.ned', svc.parse('ned', 'simple Alpha {}\n'), '');
  const msgCache = new MsgResourceCache();
  msgCache.addFile('file:///p/demo/Pkt.msg', svc.parse('msg', PKT));
  return { nedCache, msgCache, isTargetUri, displayPath: (uri) => uri.replace(/^file:\/\/\/p\//, '') };
}

async function extract(opts: Partial<NeddocOptions> = {}, isTargetUri?: (uri: string) => boolean): Promise<DocModel> {
  return extractDocModel(await buildInput(isTargetUri), { ...defaultNeddocOptions(), ...opts });
}

function page(model: DocModel, id: string): DocPage {
  const p = model.pages.find((p) => p.ref.id === id);
  assert.ok(p, `page ${id} missing (have: ${model.pages.map((p) => p.ref.id).join(', ')})`);
  return p!;
}

function blocksText(blocks: DocBlock[]): string {
  return blocks.map((b) => ('inlines' in b ? flattenInlines(b.inlines) : '')).join('\n');
}

function cellText(cells: DocCell[]): string {
  return cells.map((c) => (c.kind === 'doc' ? blocksText(c.blocks) : c.text)).join('');
}

function linkTarget(cells: DocCell[]): string | undefined {
  const c = cells[0];
  return c?.kind === 'link' ? c.page : undefined;
}

function table(p: DocPage): Extract<DocSection, { kind: 'table' }> {
  const t = p.sections.find((s) => s.kind === 'table');
  assert.ok(t, `no table on ${p.ref.id}`);
  return t as Extract<DocSection, { kind: 'table' }>;
}

function source(p: DocPage): string {
  const s = p.sections.find((s) => s.kind === 'source');
  assert.ok(s, `no source on ${p.ref.id}`);
  return (s as Extract<DocSection, { kind: 'source' }>).code;
}

function fileLine(p: DocPage): Extract<DocSection, { kind: 'para' }> {
  const line = p.sections.find((s) => s.kind === 'para' && s.cells[0]?.kind === 'text' && s.cells[0].text.startsWith('File: '));
  assert.ok(line, `no File: line on ${p.ref.id}`);
  return line as Extract<DocSection, { kind: 'para' }>;
}

test('file listings: a page per NED and MSG file, sorted by path, in the nav', async () => {
  const model = await extract();
  const files = model.pages.filter((p) => p.ref.kind === 'file');
  assert.deepEqual(
    files.map((p) => [p.ref.id, p.ref.title]),
    [
      ['file-Alpha.ned', 'NED File Alpha.ned'],
      ['file-demo-Host.ned', 'NED File demo/Host.ned'],
      ['file-demo-package.ned', 'NED File demo/package.ned'],
      ['file-demo-Pkt.msg', 'MSG File demo/Pkt.msg'],
    ],
  );
  const nav = model.navRoot.children.at(-1)!;
  assert.equal(nav.title, 'Files');
  assert.deepEqual(
    nav.children.map((c) => [c.title, c.page]),
    files.map((p) => [p.ref.title.replace(/^\w+ File /, ''), p.ref.id]),
  );
});

test('file listings: types table in source order without inner types, then the whole source', async () => {
  const model = await extract();
  const host = page(model, 'file-demo-Host.ned');
  assert.deepEqual(host.sections.map((s) => s.kind), ['table', 'subheading', 'source']);
  assert.deepEqual(table(host).rows.map((r) => r.cells.map(cellText)), [
    ['Host', 'simple module', 'A host.'],
    ['Net', 'network', 'The network.'],
  ]);
  assert.equal(linkTarget(table(host).rows[0].cells[0]), 'demo.Host');
  assert.equal(source(host), HOST.trimEnd());

  const pkt = page(model, 'file-demo-Pkt.msg');
  assert.deepEqual(table(pkt).rows.map((r) => linkTarget(r.cells[0])), ['msg-demo--Pkt', 'msg-demo--Kind']);
  assert.equal(source(pkt), PKT.trimEnd());

  // a file without types has no table
  assert.deepEqual(page(model, 'file-demo-package.ned').sections.map((s) => s.kind), ['subheading', 'source']);
});

test('file listings: the File: line of type pages links to the file page', async () => {
  const model = await extract();
  assert.deepEqual(fileLine(page(model, 'demo.Host')).cells, [
    { kind: 'text', text: 'File: ' },
    { kind: 'link', text: 'demo/Host.ned', page: 'file-demo-Host.ned' },
  ]);
  assert.deepEqual(fileLine(page(model, 'msg-demo--Pkt')).cells[1], { kind: 'link', text: 'demo/Pkt.msg', page: 'file-demo-Pkt.msg' });
});

test('file listings: MSG files are listed when MSG types are not documented', async () => {
  const model = await extract({ messageDefinitions: false });
  const pkt = page(model, 'file-demo-Pkt.msg');
  assert.deepEqual(table(pkt).rows[0].cells[0], [{ kind: 'link', text: 'Pkt', page: undefined, tooltip: 'demo::Pkt' }]);
});

test('file listings: excluded files are not listed', async () => {
  const model = await extract({}, (uri) => !uri.endsWith('/Alpha.ned'));
  assert.ok(!model.pages.some((p) => p.ref.id === 'file-Alpha.ned'));
  assert.ok(model.pages.some((p) => p.ref.id === 'file-demo-Host.ned'));
});

test('file listings: turned off', async () => {
  const model = await extract({ fileListings: false });
  assert.ok(!model.pages.some((p) => p.ref.kind === 'file'));
  assert.ok(!model.navRoot.children.some((n) => n.title === 'Files'));
  assert.deepEqual(fileLine(page(model, 'demo.Host')).cells, [{ kind: 'text', text: 'File: demo/Host.ned' }]);
});

test('file listings: filename fragments land at their anchors', async () => {
  const frag = (anchor: string) => `<docfragment filename="demo/Host.ned" anchor="${anchor}"><![CDATA[F:${anchor}]]></docfragment>`;
  const xml = `<docfragments>${['top', 'after-types', 'bottom'].map(frag).join('')}</docfragments>`;
  const model = await extract({ docFragments: [{ source: 'f.xml', xml }] });
  assert.deepEqual(model.warnings, []);
  const host = page(model, 'file-demo-Host.ned');
  assert.deepEqual(host.sections.map((s) => (s.kind === 'doc' ? blocksText(s.blocks) : s.kind)), ['F:top', 'table', 'F:after-types', 'subheading', 'source', 'F:bottom']);
});

test('file listings: output paths and links in each format', async () => {
  const materialDir = resolve(__dirname, '..', '..', '..', 'resources', 'neddoc-material');
  const materialAssets: Record<string, Uint8Array> = {};
  for (const f of readdirSync(materialDir)) materialAssets[f] = readFileSync(join(materialDir, f));
  const cases = [
    ['html', 'files/demo-Host.ned.html', 'types/demo.Host.html', '../files/demo-Host.ned.html'],
    ['html-readthedocs', 'files/demo-Host.ned.html', 'types/demo.Host.html', '../files/demo-Host.ned.html'],
    ['html-material', 'demo-Host.ned.html', 'demo.Host.html', 'demo-Host.ned.html'],
    ['markdown', 'files/demo-Host.ned.md', 'types/demo.Host.md', '../files/demo-Host.ned.md'],
    ['rst', 'files/demo-Host.ned.rst', 'types/demo.Host.rst', '<neddoc-file-demo-host-ned>'],
  ] as const;
  for (const [format, filePath, typePath, link] of cases) {
    const { files } = await collectNeddoc(await buildInput(), { format, materialAssets });
    const filePage = files.find((f) => f.relativePath === filePath);
    assert.ok(filePage, `${format}: no ${filePath}`);
    assert.match(String(filePage!.content), /Leading comment/, `${format}: source missing`);
    const typePage = files.find((f) => f.relativePath === typePath);
    assert.ok(String(typePage!.content).includes(link), `${format}: File: line does not link ${link}`);
  }
});
