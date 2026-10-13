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
import type { DocModel, DocPage } from '../neddoc/docModel';
import { fileComment, pageDirectives, sanitizePageFileName } from '../neddoc/topicPages';

const PACKAGE_NED = `//
// Copyright (C) 2026
//

//
// @titlepage
// <h1>Demo</h1>
//
// The demo library.
//
//#----------------------------------------
// @page usage.html, Using the library
//
// Use Host.
//
// @externalpage https://example.org/guide.html, The guide
// @externalpage notes.html
//

package demo;

// A host.
simple Host {}
`;
const MORE_NED = `// @page more, More
// More text.

package demo;
`;
const LATE_MSG = `// @titlepage
// Another title page.
//
// @page usage.html, Duplicate
// Dup.

namespace demo;
packet Pkt {}
`;

async function buildInput(files: Record<string, string> = {}): Promise<NeddocInput> {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  nedCache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  const msgCache = new MsgResourceCache();
  const all = { 'demo/package.ned': PACKAGE_NED, 'demo/more.ned': MORE_NED, 'demo/z.msg': LATE_MSG, ...files };
  for (const [path, text] of Object.entries(all)) {
    if (path.endsWith('.msg')) msgCache.addFile(`file:///p/${path}`, svc.parse('msg', text));
    else nedCache.addFile(`file:///p/${path}`, svc.parse('ned', text), '');
  }
  return { nedCache, msgCache, displayPath: (uri) => uri.replace(/^file:\/\/\/p\//, '') };
}

async function extract(opts: Partial<NeddocOptions> = {}, files?: Record<string, string>): Promise<DocModel> {
  return extractDocModel(await buildInput(files), { ...defaultNeddocOptions(), ...opts });
}

function page(model: DocModel, id: string): DocPage {
  const p = model.pages.find((p) => p.ref.id === id);
  assert.ok(p, `page ${id} missing (have: ${model.pages.map((p) => p.ref.id).join(', ')})`);
  return p!;
}

function docText(p: DocPage): string {
  return p.sections
    .flatMap((s) => (s.kind === 'doc' ? s.blocks : []))
    .map((b: DocBlock) => ('inlines' in b ? flattenInlines(b.inlines) : ''))
    .join('\n');
}

test('fileComment: the comment lines up to the last blank line before the code', () => {
  assert.equal(fileComment('// a\n\n// b\n\npackage x;\n'), '// a\n\n// b');
  assert.equal(fileComment('// banner of the type\nsimple A {}\n'), '');
  assert.equal(fileComment('  // indented\n\nsimple A {}\n'), '// indented');
  assert.equal(fileComment('// only comments\n// here\n'), '// only comments\n// here');
});

test('pageDirectives: external pages first, then the pages in source order', () => {
  const directives = pageDirectives(fileComment(PACKAGE_NED));
  assert.deepEqual(
    directives.map((d) => (d.kind === 'externalpage' ? [d.kind, d.href, d.title] : d.kind === 'page' ? [d.kind, d.fileName, d.title] : [d.kind])),
    [
      ['externalpage', 'https://example.org/guide.html', 'The guide'],
      ['externalpage', 'notes.html', 'notes.html'],
      ['titlepage'],
      ['page', 'usage.html', 'Using the library'],
    ],
  );
  const title = directives.find((d) => d.kind === 'titlepage')!;
  assert.match((title as { content: string }).content, /<h1>Demo<\/h1>[\s\S]*The demo library/);
  assert.doesNotMatch((title as { content: string }).content, /Copyright/);
});

test('sanitizePageFileName: the Eclipse file names', () => {
  assert.equal(sanitizePageFileName('foo', '.html'), 'foo.html');
  assert.equal(sanitizePageFileName(' Source syntax highlighting ', '.html'), 'Source-syntax-highlighting.html');
  // test/misc/neddoc/pages.ned of the OMNeT++ sources links to this name
  assert.equal(
    sanitizePageFileName('nasty-!@#$%^&*()[]{}"\':;.\\L<?>/+=-`äöüßÄÖÜé', '.html'),
    'nasty-!@_$____()(){}___;._L____+=-_________.html',
  );
});

test('topic pages: the title page replaces the overview, pages and links go under Selected Topics', async () => {
  const model = await extract();
  const index = page(model, 'index');
  assert.equal(index.ownHeading, true);
  assert.match(docText(index), /Demo[\s\S]*The demo library/);

  const usage = page(model, 'page-usage');
  assert.equal(usage.ref.kind, 'topic');
  assert.equal(usage.ref.title, 'Using the library');
  assert.match(docText(usage), /Use Host\./);
  const para = usage.sections[0].kind === 'doc' ? usage.sections[0].blocks[0] : undefined;
  assert.ok(para && 'inlines' in para && para.inlines.some((i) => i.kind === 'typeref' && i.name === 'Host'));
  assert.equal(page(model, 'page-more').ref.title, 'More');

  assert.deepEqual(
    model.navRoot.children.slice(0, 2).map((n) => n.title),
    ['Overview', 'Selected Topics'],
  );
  // files in path order: demo/more.ned, demo/package.ned, demo/z.msg
  assert.deepEqual(
    model.navRoot.children[1].children.map((n) => [n.title, n.page ?? n.href]),
    [
      ['More', 'page-more'],
      ['The guide', 'https://example.org/guide.html'],
      ['notes.html', 'notes.html'],
      ['Using the library', 'page-usage'],
    ],
  );
  assert.deepEqual(model.warnings, [
    'demo/z.msg: @titlepage ignored, the overview page comes from demo/package.ned',
    'demo/z.msg: @page usage.html ignored, a page with that name already exists',
  ]);
});

test('topic pages: none without directives; the default overview stays', async () => {
  const model = await extract({}, { 'demo/package.ned': 'package demo;\n', 'demo/more.ned': 'package demo;\n', 'demo/z.msg': 'packet P {}\n' });
  assert.ok(!model.pages.some((p) => p.ref.kind === 'topic'));
  assert.ok(!page(model, 'index').ownHeading);
  assert.ok(!model.navRoot.children.some((n) => n.title === 'Selected Topics'));
});

test('topic pages: independent of file listings, and @include is expanded first', async () => {
  const input = await buildInput({ 'demo/more.ned': '// @include pages.txt\n\npackage demo;\n' });
  const model = await extractDocModel(input, {
    ...defaultNeddocOptions(),
    fileListings: false,
    includeResolver: (ref) => (ref === 'pages.txt' ? { id: 'pages.txt', content: '@page inc, Included\nFrom an include.' } : undefined),
  });
  assert.match(docText(page(model, 'page-inc')), /From an include\./);
});

test('topic pages: paths, headings and navigation in each format', async () => {
  const materialDir = resolve(__dirname, '..', '..', '..', 'resources', 'neddoc-material');
  const materialAssets: Record<string, Uint8Array> = {};
  for (const f of readdirSync(materialDir)) materialAssets[f] = readFileSync(join(materialDir, f));
  const content = (files: { relativePath: string; content: string | Uint8Array }[], path: string): string => {
    const f = files.find((f) => f.relativePath === path);
    assert.ok(f, `no ${path} (have: ${files.map((f) => f.relativePath).join(', ')})`);
    return String(f!.content);
  };

  for (const format of ['html', 'html-readthedocs'] as const) {
    const { files } = await collectNeddoc(await buildInput(), { format });
    assert.doesNotMatch(content(files, 'index.html'), /<h1>NED Documentation<\/h1>/, format);
    assert.match(content(files, 'index.html'), /<h1>Demo<\/h1>/, format);
    assert.match(content(files, 'usage.html'), /<h1>Using the library<\/h1>/, format);
    const nav = content(files, 'assets/navtree-data.js');
    assert.match(nav, /"t":"The guide","u":"https:\/\/example.org\/guide.html"/, format);
    assert.match(nav, /"t":"notes.html","h":"notes.html"/, format);
  }

  const material = (await collectNeddoc(await buildInput(), { format: 'html-material', materialAssets })).files;
  assert.match(content(material, 'index.html'), /<h1>Demo<\/h1>/);
  assert.doesNotMatch(content(material, 'index.html'), /OMNeT\+\+ Model Documentation/);
  assert.match(content(material, 'navtreedata.js'), /\[`Using the library`, `usage.html`, null\]/);
  assert.match(content(material, 'navtreedata.js'), /\[`The guide`, `https:\/\/example.org\/guide.html`, null\]/);

  const md = (await collectNeddoc(await buildInput(), { format: 'markdown' })).files;
  assert.doesNotMatch(content(md, 'index.md'), /^# /);
  assert.match(content(md, 'usage.md'), /^# Using the library/);
  assert.match(content(md, 'SUMMARY.md'), /- \[The guide\]\(https:\/\/example.org\/guide.html\)/);

  const rst = (await collectNeddoc(await buildInput(), { format: 'rst' })).files;
  assert.match(content(rst, 'usage.rst'), /Using the library\n=+/);
  assert.match(content(rst, 'index.rst'), / {3}usage\n/);
  assert.match(content(rst, 'index.rst'), / {3}The guide <https:\/\/example.org\/guide.html>/);
  assert.doesNotMatch(content(rst, 'index.rst'), /notes\.html/);
});

test('topic pages: a page on the path of a generated page is dropped', async () => {
  const { files, result } = await collectNeddoc(
    await buildInput({ 'demo/more.ned': '// @page packages, Clash\n// text\n\npackage demo;\n' }),
    { format: 'html' },
  );
  assert.ok(result.warnings.includes('page "Clash" not written: packages.html is the page "Packages"'), result.warnings.join('\n'));
  assert.doesNotMatch(String(files.find((f) => f.relativePath === 'packages.html')!.content), /Clash/);
  assert.doesNotMatch(String(files.find((f) => f.relativePath === 'assets/navtree-data.js')!.content), /Clash/);
});
