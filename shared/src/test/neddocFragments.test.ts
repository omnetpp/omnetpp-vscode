import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { MsgResourceCache } from '../msg/msgResourceCache';
import { extractDocModel, type NeddocInput } from '../neddoc/extract';
import { defaultNeddocOptions } from '../neddoc/options';
import { collectNeddoc } from '../neddoc/generate';
import { flattenInlines } from '../neddoc/commentEmit';
import { DocFragmentSet, dedent, parseDocFragments } from '../neddoc/fragments';
import type { DocBlock } from '../neddoc/commentAst';
import type { DocModel, DocPage, DocSection } from '../neddoc/docModel';

const NED = `package demo;
// A host.
simple Host {
  parameters:
    int n;
  gates:
    input in;
}
network Net { submodules: h: Host; }
`;
const MSG = `namespace demo;
// A packet.
packet Pkt { int len; }
`;

async function buildInput(): Promise<NeddocInput> {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  nedCache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  nedCache.addFile('file:///demo/Host.ned', svc.parse('ned', NED), '');
  nedCache.addFile('file:///Plain.ned', svc.parse('ned', 'simple Plain {}\n'), '');
  const msgCache = new MsgResourceCache();
  msgCache.addFile('file:///demo/Pkt.msg', svc.parse('msg', MSG));
  return { nedCache, msgCache };
}

function fragmentsXml(...items: string[]): string {
  return `<?xml version="1.0"?>\n<!-- test -->\n<docfragments>\n${items.join('\n')}\n</docfragments>\n`;
}

function frag(attrs: string, text: string): string {
  return `<docfragment ${attrs}><![CDATA[${text}]]></docfragment>`;
}

async function extract(xml: string): Promise<DocModel> {
  return extractDocModel(await buildInput(), { ...defaultNeddocOptions(), docFragments: [{ source: 'frags.xml', xml }] });
}

function page(model: DocModel, id: string): DocPage {
  const p = model.pages.find((p) => p.ref.id === id);
  assert.ok(p, `page ${id} missing`);
  return p!;
}

function blocksText(blocks: DocBlock[]): string {
  return blocks
    .map((b) => ('inlines' in b ? flattenInlines(b.inlines) : 'items' in b ? b.items.map((i) => flattenInlines(i.inlines)).join('|') : ''))
    .join('\n');
}

/** Index of the doc section whose text contains `marker`. */
function indexOf(p: DocPage, marker: string): number {
  return p.sections.findIndex((s) => s.kind === 'doc' && blocksText(s.blocks).includes(marker));
}

function indexOfHeading(p: DocPage, text: string): number {
  return p.sections.findIndex((s) => s.kind === 'subheading' && s.text === text);
}

test('fragments: parses CDATA, entities, comments and concatenates same-anchor fragments', () => {
  const warnings: string[] = [];
  const fragments = parseDocFragments(
    [
      {
        source: 'a.xml',
        xml: fragmentsXml(
          frag('nedtype="demo.Host" anchor="top"', 'one'),
          '<!-- skipped --><docfragment nedtype="demo.Host" anchor=\'top\'>two &amp; <![CDATA[<b>three</b>]]></docfragment>',
          '<docfragment msgtype="demo::Pkt" anchor="bottom"/>',
        ),
      },
    ],
    warnings,
  );
  assert.deepEqual(warnings, []);
  assert.equal(fragments.length, 3);
  const set = new DocFragmentSet(fragments);
  assert.equal(set.take('nedtype', 'demo.Host', 'top'), 'one\ntwo & <b>three</b>');
  assert.equal(set.take('msgtype', 'demo::Pkt', 'bottom'), '');
  assert.equal(set.take('nedtype', 'demo.Host', 'bottom'), undefined);
  assert.deepEqual(set.unused(), []);
  assert.equal(fragments[0].location, 'a.xml:4');
});

test('fragments: problems become warnings, valid fragments are kept', () => {
  const warnings: string[] = [];
  const fragments = parseDocFragments(
    [
      { source: 'bad.xml', xml: '<docfragments><docfragment nedtype="x" anchor="top">' },
      {
        source: 'b.xml',
        xml: fragmentsXml(
          frag('nedtype="demo.Host" anchor="after-nothing"', 'x'),
          frag('anchor="top"', 'x'),
          frag('msgtype="demo::Pkt"', 'x'),
          '<fragment nedtype="demo.Host" anchor="top"/>',
          frag('filename="demo/Host.ned" anchor="after-types"', 'ok'),
        ),
      },
    ],
    warnings,
  );
  assert.equal(fragments.length, 1);
  assert.equal(fragments[0].target, 'filename');
  assert.equal(warnings.length, 5, warnings.join('\n'));
  assert.match(warnings[0], /^doc fragments bad\.xml: line 1: <docfragment> is not closed/);
  assert.match(warnings[1], /b\.xml:4: unknown anchor "after-nothing" for nedtype \(expected one of: top, /);
  assert.match(warnings[2], /needs a nedtype, msgtype or filename attribute/);
  assert.match(warnings[3], /missing anchor for msgtype/);
  assert.match(warnings[4], /unexpected <fragment> element/);
});

test('fragments: dedent strips the common indentation only', () => {
  assert.equal(dedent('\n    - a\n      - b\n\n    c\n  '), '\n- a\n  - b\n\nc\n');
});

test('fragments: NED type page anchors land at the Eclipse positions', async () => {
  const anchors = [
    'top',
    'after-description',
    'after-image',
    'after-diagrams',
    'after-usage',
    'after-inheritance',
    'after-parameters',
    'after-properties',
    'after-gates',
    'after-signals',
    'after-statistics',
    'after-unassigned-parameters',
    'bottom',
  ];
  const model = await extract(fragmentsXml(...anchors.map((a) => frag(`nedtype="demo.Host" anchor="${a}"`, `F:${a}`))));
  assert.deepEqual(model.warnings, []);
  const p = page(model, 'demo.Host');
  const at = anchors.map((a) => indexOf(p, `F:${a}`));
  assert.ok(at.every((i) => i >= 0), `missing fragments: ${anchors.filter((_a, i) => at[i] < 0).join(', ')}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'fragments out of order');
  assert.equal(at[0], 0);
  assert.equal(at[at.length - 1], p.sections.length - 1);
  // after-parameters directly follows the parameters table, after-gates the gates table
  assert.equal(at[anchors.indexOf('after-parameters')], indexOfHeading(p, 'Parameters') + 2);
  assert.equal(at[anchors.indexOf('after-gates')], indexOfHeading(p, 'Gates') + 2);
  // after-description directly follows the description
  const desc = p.sections[at[1] - 1] as Extract<DocSection, { kind: 'doc' }>;
  assert.equal(blocksText(desc.blocks), 'A host.');
});

test('fragments: MSG type page anchors land at the Eclipse positions', async () => {
  const anchors = ['top', 'after-description', 'after-diagrams', 'after-inheritance', 'after-fields', 'after-properties', 'bottom'];
  const model = await extract(fragmentsXml(...anchors.map((a) => frag(`msgtype="demo::Pkt" anchor="${a}"`, `M:${a}`))));
  assert.deepEqual(model.warnings, []);
  const p = page(model, 'msg-demo--Pkt');
  const at = anchors.map((a) => indexOf(p, `M:${a}`));
  assert.ok(at.every((i) => i >= 0));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  assert.equal(at[anchors.indexOf('after-fields')], indexOfHeading(p, 'Fields') + 2);
  assert.equal(at[at.length - 1], p.sections.length - 1);
});

test('fragments: package and namespace sections, incl. the Eclipse "default" key', async () => {
  const model = await extract(
    fragmentsXml(
      frag('nedtype="demo" anchor="top"', 'P:top'),
      frag('nedtype="demo" anchor="bottom"', 'P:bottom'),
      frag('nedtype="default" anchor="top"', 'P:default'),
      frag('msgtype="demo" anchor="bottom"', 'N:bottom'),
    ),
  );
  assert.deepEqual(model.warnings, []);
  const pkgs = page(model, 'packages');
  const demo = indexOfHeading(pkgs, 'demo');
  assert.equal(indexOf(pkgs, 'P:top'), demo + 1);
  assert.equal(pkgs.sections[demo + 2].kind, 'table');
  assert.equal(indexOf(pkgs, 'P:bottom'), demo + 3);
  assert.equal(indexOf(pkgs, 'P:default'), indexOfHeading(pkgs, '(default)') + 1);
  const nss = page(model, 'namespaces');
  assert.equal(indexOf(nss, 'N:bottom'), indexOfHeading(nss, 'demo') + 2);
});

test('fragments: content is comment markup with type links', async () => {
  const model = await extract(fragmentsXml(frag('nedtype="demo.Host" anchor="bottom"', '\n    See Net and <b>more</b>.\n')));
  const p = page(model, 'demo.Host');
  const s = p.sections[p.sections.length - 1] as Extract<DocSection, { kind: 'doc' }>;
  const inlines = s.blocks.flatMap((b) => ('inlines' in b ? b.inlines : []));
  assert.ok(inlines.some((i) => i.kind === 'typeref' && i.name === 'Net' && i.targets[0] === 'demo.Net'));
  assert.ok(inlines.some((i) => i.kind === 'html' && i.tag === 'b'));
});

test('fragments: fragments that are not inserted are reported', async () => {
  const model = await extract(
    fragmentsXml(
      frag('nedtype="demo.Nope" anchor="top"', 'x'),
      frag('nedtype="demo" anchor="after-gates"', 'x'),
      frag('msgtype="demo::Nope" anchor="top"', 'x'),
      frag('filename="demo/Host.ned" anchor="top"', 'x'),
      frag('filename="demo/Pkt.msg" anchor="bottom"', 'x'),
    ),
  );
  assert.equal(model.warnings.length, 4, model.warnings.join('\n'));
  assert.match(model.warnings[0], /^2 doc fragments with a filename attribute skipped: file listing pages are not generated \(first at frags\.xml:7\)$/);
  assert.match(model.warnings[1], /^frags\.xml:4: no documented NED type or package 'demo\.Nope'/);
  assert.match(model.warnings[2], /^frags\.xml:5: anchor "after-gates" does not exist on the package section of 'demo'/);
  assert.match(model.warnings[3], /^frags\.xml:6: no documented message type or namespace 'demo::Nope'/);
});

test('fragments: rendered in the html, Read the Docs, Markdown and RST formats', async () => {
  const xml = fragmentsXml(frag('nedtype="demo.Host" anchor="after-signals"', 'Fragment <b>text</b> about Net.'));
  for (const format of ['html', 'html-readthedocs', 'markdown', 'rst'] as const) {
    const { files } = await collectNeddoc(await buildInput(), { format, docFragments: [{ source: 'f.xml', xml }] });
    const hostPage = files.find((f) => /demo\.Host\.(html|md|rst)$/.test(f.relativePath));
    assert.ok(hostPage, `${format}: no Host page (${files.map((f) => f.relativePath).join(', ')})`);
    const text = String(hostPage!.content);
    assert.match(text, /Fragment/, `${format}: fragment missing`);
    if (format.startsWith('html')) assert.match(text, /<b>text<\/b>/, `${format}: markup lost`);
  }
});
