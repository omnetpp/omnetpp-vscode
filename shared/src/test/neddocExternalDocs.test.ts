import { test } from 'bun:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { MsgResourceCache } from '../msg/msgResourceCache';
import type { NeddocInput } from '../neddoc/extract';
import { collectNeddoc, type DiagramSvgRenderer } from '../neddoc/generate';
import { ExternalDocsResolver, parseExternalDocsSpec, type ExternalDocSet } from '../neddoc/externalDocs';
import type { NeddocOptions } from '../neddoc/options';

const APP = `package app;
import inet.node.Host;
import other.Gadget;
//
// Uses ~Host and ~Gadget; Host is also mentioned without a tilde.
//
simple MyHost extends Host { }
simple MyGadget extends Gadget { }
network Net
{
    submodules:
        h: Host;
        g: Gadget;
}
`;
const INET = `package inet.node;
simple Host { }
`;
const OTHER = `package other;
simple Gadget { }
`;
const APP_MSG = `namespace app;
message Frame extends inet::Packet { }
`;
const INET_MSG = `namespace inet;
packet Packet { }
`;

const tagFile = (entries: [string, string][]) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<tagfile>\n` +
  entries.map(([n, f]) => `  <compound kind="class">\n    <name>${n}</name>\n    <filename>${f}</filename>\n  </compound>\n`).join('') +
  `</tagfile>\n`;

async function input(): Promise<NeddocInput> {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  nedCache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  nedCache.addFile('file:///app/Net.ned', svc.parse('ned', APP), '');
  nedCache.addFile('file:///inet/node/Host.ned', svc.parse('ned', INET), '');
  nedCache.addFile('file:///other/Gadget.ned', svc.parse('ned', OTHER), '');
  const msgCache = new MsgResourceCache();
  msgCache.addFile('file:///app/Frame.msg', svc.parse('msg', APP_MSG));
  msgCache.addFile('file:///inet/Packet.msg', svc.parse('msg', INET_MSG));
  return { nedCache, msgCache, isTargetUri: (uri) => uri.startsWith('file:///app/') };
}

async function generate(externalDocs: ExternalDocSet[], options: Partial<NeddocOptions> = {}, renderDiagram?: DiagramSvgRenderer) {
  const { files, result } = await collectNeddoc(await input(), { externalDocs, ...options }, renderDiagram);
  const file = (path: string) => {
    const f = files.find((x) => x.relativePath === path);
    assert.ok(f, `missing output ${path}; have ${files.map((x) => x.relativePath).join(', ')}`);
    return String(f.content);
  };
  return { file, result };
}

// ---- configuration --------------------------------------------------------------

test('externalDocs: the legacy list syntax parses and rejects malformed items', () => {
  assert.deepEqual(parseExternalDocsSpec('inet=https://a/b, other=../o\nx.y=c'), {
    inet: 'https://a/b',
    other: '../o',
    'x.y': 'c',
  });
  assert.deepEqual(parseExternalDocsSpec('  '), {});
  assert.throws(() => parseExternalDocsSpec('inet'), /invalid external documentation entry "inet"/);
  assert.throws(() => parseExternalDocsSpec('inet='), /invalid/);
  assert.throws(() => parseExternalDocsSpec('=x'), /invalid/);
});

test('externalDocs: resolver picks the longest prefix, legacy naming and tag-file names', () => {
  const resolver = new ExternalDocsResolver([
    { prefix: 'inet', target: 'https://inet.example/neddoc/' },
    { prefix: 'inet.showcases', target: './showcases', nedTags: tagFile([['inet.showcases.Demo', 'types/inet.showcases.Demo.html']]) },
  ]);
  assert.deepEqual(resolver.resolveNed('inet.node.Host'), {
    from: 'inet',
    target: 'https://inet.example/neddoc/inet.node.Host.html',
  });
  assert.deepEqual(resolver.resolveNed('inet.showcases.Demo'), {
    from: 'inet.showcases',
    target: 'showcases/types/inet.showcases.Demo.html',
  });
  assert.deepEqual(resolver.resolveNed('inet.showcases.Other'), { from: 'inet.showcases', reason: 'not-in-tagfile' });
  // a prefix matches whole package segments only
  assert.deepEqual(resolver.resolveNed('inetx.Foo'), { from: 'inetx', reason: 'unconfigured' });
  assert.deepEqual(resolver.resolveNed('Toplevel'), { from: '(default package)', reason: 'unconfigured' });
  // MSG types: C++ names match as dotted, legacy page naming maps :: to -
  assert.deepEqual(resolver.resolveMsg('inet::Packet', 'Packet'), {
    from: 'inet',
    target: 'https://inet.example/neddoc/inet-Packet.html',
  });
});

// ---- generated output -----------------------------------------------------------

test('externalDocs: html links configured dependency types and marks the others', async () => {
  const { file, result } = await generate([{ prefix: 'inet', target: 'https://inet.example/neddoc' }]);
  const myHost = file('types/app.MyHost.html');
  // supertype cell: external link with the marker tooltip
  assert.match(myHost, /<a class="externaltype" href="https:\/\/inet\.example\/neddoc\/inet\.node\.Host\.html" title="[^"]*\[from inet\] ↗">Host<\/a>/);
  // automatic hyperlinking picks up the linkable dependency type name in prose
  assert.match(myHost, /also mentioned/);
  assert.match(myHost, /<div class="description">.*<a class="externaltype"[^>]*>Host<\/a> is also mentioned/);
  // unconfigured dependency: a marked span, not a broken link
  assert.match(file('types/app.MyGadget.html'), /<span class="externaltype" title="[^"]*\[from other — not documented here\]">Gadget<\/span>/);
  // MSG supertype from a dependency, legacy msg page naming
  const frame = file('types/msg-app--Frame.html');
  assert.match(frame, /href="https:\/\/inet\.example\/neddoc\/inet-Packet\.html"/);
  // the stylesheet carries the marker rules
  assert.match(file('assets/style.css'), /a\.externaltype::after/);
  // one line per unlinked dependency, kept apart from the generator warnings
  assert.equal(result.externalWarnings.length, 1);
  assert.match(result.externalWarnings[0], /types from 'other' not linked \(no external documentation configured/);
  assert.ok(!result.warnings.some((w) => w.includes('other')));
});

test('externalDocs: a relative target uses the tag-file page names and page-relative paths', async () => {
  const sets: ExternalDocSet[] = [
    { prefix: 'inet', target: '../inet', nedTags: tagFile([['inet.node.Host', 'types/inet.node.Host.html']]) },
  ];
  const { file, result } = await generate(sets);
  assert.match(file('types/app.MyHost.html'), /href="\.\.\/\.\.\/inet\/types\/inet\.node\.Host\.html"/);
  // msgtags.xml was not read for inet: MSG types fall back to the legacy naming
  assert.match(file('types/msg-app--Frame.html'), /href="\.\.\/\.\.\/inet\/inet-Packet\.html"/);
  assert.ok(result.externalWarnings.every((w) => !w.includes("'inet'")));
});

test('externalDocs: a type missing from the target tag file is not linked', async () => {
  const sets: ExternalDocSet[] = [{ prefix: 'inet', target: '../inet', nedTags: tagFile([]), msgTags: tagFile([]) }];
  const { file, result } = await generate(sets);
  assert.match(file('types/app.MyHost.html'), /<span class="externaltype" title="[^"]*\[from inet — not documented here\]">Host<\/span>/);
  assert.ok(result.externalWarnings.some((w) => /'inet' not linked \(not listed in the tag file/.test(w)));
});

test('externalDocs: tilde mode resolves all dependency types, automatic mode only linkable ones', async () => {
  const description = (html: string) => /<div class="description">(.*?)<\/div>/s.exec(html)?.[1] ?? '';
  // automatic mode: unlinkable names stay plain prose (no marker noise)
  const auto = description((await generate([])).file('types/app.MyHost.html'));
  assert.ok(!auto.includes('externaltype'), auto);
  // tilde mode: explicit references to dependency types are marked, not errors
  const tilde = description((await generate([], { automaticHyperlinks: false })).file('types/app.MyHost.html'));
  assert.match(tilde, /Uses <span class="externaltype"[^>]*>Host<\/span> and <span class="externaltype"[^>]*>Gadget<\/span>/);
  assert.ok(!tilde.includes('class="error"'));
});

test('externalDocs: markdown and rst use plain links with a ↗ marker', async () => {
  const sets: ExternalDocSet[] = [{ prefix: 'inet', target: 'https://inet.example/neddoc' }];
  const md = (await generate(sets, { format: 'markdown' })).file('types/app.MyHost.md');
  assert.match(md, /\[Host ↗\]\(https:\/\/inet\.example\/neddoc\/inet\.node\.Host\.html\)/);
  assert.ok(!(await generate(sets, { format: 'markdown' })).file('types/app.MyGadget.md').includes('[Gadget'), 'unlinked dependency types are plain text');
  const rst = (await generate(sets, { format: 'rst' })).file('types/app.MyHost.rst');
  assert.match(rst, /`Host ↗ <https:\/\/inet\.example\/neddoc\/inet\.node\.Host\.html>`__/);
});

test('externalDocs: diagram nodes link to dependency documentation', async () => {
  const hrefs: (string | undefined)[] = [];
  const renderDiagram: DiagramSvgRenderer = (req, ctx) => {
    if (req.typeFqName !== 'app.Net' || req.diagram !== 'type') return undefined;
    hrefs.push(ctx.hrefForPage('inet.node.Host'), ctx.hrefForPage('other.Gadget'));
    return `<svg><a href="${hrefs[0]}"><rect/></a></svg>`;
  };
  const { file } = await generate([{ prefix: 'inet', target: '../inet' }], {}, renderDiagram);
  // images/ is one level deep; the dependency docs sit next to the output dir
  assert.deepEqual(hrefs, ['../../inet/inet.node.Host.html', undefined]);
  // inlined into a types/ page, the link keeps pointing above the output root
  assert.match(file('types/app.Net.html'), /<svg><a href="\.\.\/\.\.\/inet\/inet\.node\.Host\.html">/);
});

test('externalDocs: html-material renders the marker with root-relative links', async () => {
  const dir = resolve(__dirname, '..', '..', '..', 'resources', 'neddoc-material');
  const materialAssets: Record<string, Uint8Array> = {};
  for (const f of readdirSync(dir)) materialAssets[f] = readFileSync(join(dir, f));
  const { file } = await generate([{ prefix: 'inet', target: '../inet' }], { format: 'html-material', materialAssets });
  assert.match(file('app.MyHost.html'), /<a class="externaltype" href="\.\.\/inet\/inet\.node\.Host\.html"/);
  assert.match(file('style.css'), /a\.externaltype::after/);
});
