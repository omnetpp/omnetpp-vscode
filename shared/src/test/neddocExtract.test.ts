import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { MsgResourceCache } from '../msg/msgResourceCache';
import { extractDocModel, type NeddocInput } from '../neddoc/extract';
import { defaultNeddocOptions, type NeddocOptions } from '../neddoc/options';
import type { DocCell, DocModel, DocPage, DocSection } from '../neddoc/docModel';

async function buildInput(nedFiles: Record<string, string>, msgFiles: Record<string, string> = {}): Promise<NeddocInput> {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  nedCache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  for (const [uri, text] of Object.entries(nedFiles)) nedCache.addFile(uri, svc.parse('ned', text), '');
  const msgCache = new MsgResourceCache();
  for (const [uri, text] of Object.entries(msgFiles)) msgCache.addFile(uri, svc.parse('msg', text));
  return { nedCache, msgCache };
}

function extract(input: NeddocInput, opts: Partial<NeddocOptions> = {}): Promise<DocModel> {
  return extractDocModel(input, { ...defaultNeddocOptions(), ...opts });
}

function page(model: DocModel, id: string): DocPage {
  const p = model.pages.find((p) => p.ref.id === id);
  assert.ok(p, `page ${id} missing (have: ${model.pages.map((p) => p.ref.id).join(', ')})`);
  return p!;
}

function tableAfter(page: DocPage, heading: string): Extract<DocSection, { kind: 'table' }> {
  const i = page.sections.findIndex((s) => s.kind === 'subheading' && s.text === heading);
  assert.ok(i >= 0, `no "${heading}" heading on ${page.ref.id}`);
  const table = page.sections[i + 1];
  assert.equal(table?.kind, 'table', `no table after "${heading}"`);
  return table as Extract<DocSection, { kind: 'table' }>;
}

function hasHeading(page: DocPage, heading: string): boolean {
  return page.sections.some((s) => s.kind === 'subheading' && s.text === heading);
}

function cellText(cells: DocCell[]): string {
  return cells
    .map((c) => (c.kind === 'doc' ? '<doc>' : c.text))
    .join('');
}

const LIB = `package lib;
// Base node with a rate parameter.
simple Node
{
    parameters:
        double rate @unit(bps) = default(100bps); // transmission rate
        string label; // display label
        @display("i=device/pc");
        @signal[pktSent](type=lib::FooPkt);
        @statistic[throughput](title="thruput";source=pktSent;record=vector,stats;unit=bps);
    gates:
        inout g[]; // connector
}

// A sink; see ~Node for the base.
simple Sink extends Node
{
    parameters:
        rate = 200bps;
        int capacity; // buffer capacity
}

moduleinterface IApp { }

simple UdpApp like IApp { }
`;

const NET = `package lib;
// The demo network.
network Net
{
    submodules:
        n1: Node;
        n2: Sink;
        app: <default("UdpApp")> like IApp;
    connections:
        n1.g++ <--> n2.g++;
}
`;

const MSG = `namespace lib;

// A packet carrying stuff.
packet FooPkt
{
    int seq; // sequence number
    string payload[];
}

packet BarPkt extends FooPkt
{
    int extra;
}
`;

// ---- pages & structure -----------------------------------------------------------

test('neddoc extract: produces index, packages, namespaces and type pages', async () => {
  const model = await extract(await buildInput({ 'file:///lib.ned': LIB, 'file:///net.ned': NET }, { 'file:///p.msg': MSG }));
  page(model, 'index');
  page(model, 'packages');
  page(model, 'namespaces');
  page(model, 'lib.Node');
  page(model, 'lib.Net');
  page(model, 'msg-lib--FooPkt');
  // builtins excluded by default
  assert.ok(!model.pages.some((p) => p.ref.id === 'ned.DelayChannel'));
});

test('neddoc extract: includeBuiltins pulls in the built-in NED declarations', async () => {
  const model = await extract(await buildInput({ 'file:///lib.ned': LIB }), { includeBuiltins: true });
  page(model, 'ned.DelayChannel');
});

test('neddoc extract: NED page section order follows the Eclipse layout', async () => {
  const model = await extract(await buildInput({ 'file:///lib.ned': LIB, 'file:///net.ned': NET }));
  const p = page(model, 'lib.Node');
  const kinds = p.sections.map((s) => (s.kind === 'subheading' ? `h:${s.text}` : s.kind));
  // package line, badge, description first
  assert.equal(kinds[0], 'para');
  assert.equal(kinds[1], 'badge');
  assert.equal(kinds[2], 'doc');
  // member tables in Eclipse order
  const order = ['h:Known subclasses', 'h:Parameters', 'h:Properties', 'h:Gates', 'h:Signals', 'h:Statistics', 'h:Source code'];
  const positions = order.map((k) => kinds.indexOf(k));
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1] && positions[i - 1] >= 0, `order violated at ${order[i]}: ${kinds.join(',')}`);
  }
});

// ---- parameters ---------------------------------------------------------------------

test('neddoc extract: parameters table with local/inherited rows and default values', async () => {
  const model = await extract(await buildInput({ 'file:///lib.ned': LIB }));
  const sink = tableAfter(page(model, 'lib.Sink'), 'Parameters');
  assert.deepEqual(sink.columns, ['Name', 'Type', 'Default value', 'Description']);
  const byName = new Map(sink.rows.map((r) => [cellText(r.cells[0]), r]));
  const rate = byName.get('rate')!;
  assert.equal(rate.cssClass, 'inherited'); // declared in Node
  assert.equal(cellText(rate.cells[1]), 'double');
  assert.equal(cellText(rate.cells[2]), '200bps'); // nearest assignment wins
  const capacity = byName.get('capacity')!;
  assert.equal(capacity.cssClass, 'local');
  const label = byName.get('label')!;
  assert.equal(cellText(label.cells[2]), ''); // unassigned
  assert.equal(rate.anchor, 'param-rate');
});

test('neddoc extract: parameter description comes from the declaring type', async () => {
  const model = await extract(await buildInput({ 'file:///lib.ned': LIB }));
  const sink = tableAfter(page(model, 'lib.Sink'), 'Parameters');
  const rate = sink.rows.find((r) => cellText(r.cells[0]) === 'rate')!;
  const doc = rate.cells[3][0];
  assert.equal(doc.kind, 'doc');
  const text = JSON.stringify(doc);
  assert.ok(text.includes('transmission rate'), text);
});

// ---- gates -------------------------------------------------------------------------------

test('neddoc extract: gates table shows direction and vector marker', async () => {
  const model = await extract(await buildInput({ 'file:///lib.ned': LIB }));
  const gates = tableAfter(page(model, 'lib.Node'), 'Gates');
  assert.deepEqual(gates.columns, ['Name', 'Direction', 'Size', 'Description']);
  const g = gates.rows[0];
  assert.equal(cellText(g.cells[0]), 'g [ ]');
  assert.equal(cellText(g.cells[1]), 'inout');
  assert.equal(g.cssClass, 'local');
});

// ---- signals / statistics ------------------------------------------------------------------

test('neddoc extract: signals and statistics tables from indexed properties', async () => {
  const model = await extract(await buildInput({ 'file:///lib.ned': LIB }, { 'file:///p.msg': MSG }));
  const p = page(model, 'lib.Node');
  const signals = tableAfter(p, 'Signals');
  assert.equal(cellText(signals.rows[0].cells[0]), 'pktSent');
  // the signal C++ type resolves to the documented MSG type -> link
  const typeCell = signals.rows[0].cells[1][0];
  assert.equal(typeCell.kind, 'link');
  assert.equal((typeCell as { page?: string }).page, 'msg-lib--FooPkt');

  const stats = tableAfter(p, 'Statistics');
  assert.deepEqual(stats.columns, ['Name', 'Title', 'Source', 'Record', 'Unit', 'Interpolation Mode', 'Description']);
  const row = stats.rows[0];
  assert.equal(cellText(row.cells[0]), 'throughput');
  assert.equal(cellText(row.cells[1]), 'thruput');
  assert.equal(cellText(row.cells[3]), 'vector,stats');
});

test('neddoc extract: signals are inherited by subtypes', async () => {
  const model = await extract(await buildInput({ 'file:///lib.ned': LIB }));
  const sink = page(model, 'lib.Sink');
  const signals = tableAfter(sink, 'Signals');
  assert.equal(cellText(signals.rows[0].cells[0]), 'pktSent');
});

// ---- inheritance / usage tables -----------------------------------------------------------------

test('neddoc extract: extends, known subclasses, implemented by, used in', async () => {
  const model = await extract(await buildInput({ 'file:///lib.ned': LIB, 'file:///net.ned': NET }));

  const sink = page(model, 'lib.Sink');
  const ext = tableAfter(sink, 'Extends');
  assert.equal(cellText(ext.rows[0].cells[0]), 'Node');

  const node = page(model, 'lib.Node');
  const subs = tableAfter(node, 'Known subclasses');
  assert.equal(cellText(subs.rows[0].cells[0]), 'Sink');
  assert.ok(cellText(subs.rows[0].cells[1]).includes('simple module'));

  const usedIn = tableAfter(node, 'Used in');
  assert.equal(cellText(usedIn.rows[0].cells[0]), 'Net'); // networks table

  const iapp = page(model, 'lib.IApp');
  const impl = tableAfter(iapp, 'Implemented by');
  assert.equal(cellText(impl.rows[0].cells[0]), 'UdpApp');
});

test('neddoc extract: unresolved extends is reported', async () => {
  const model = await extract(await buildInput({ 'file:///x.ned': 'package x;\nsimple Foo extends Missing { }\n' }));
  const ext = tableAfter(page(model, 'x.Foo'), 'Extends');
  assert.equal(cellText(ext.rows[0].cells[0]), 'Missing');
  assert.ok(cellText(ext.rows[0].cells[1]).includes('unknown'));
});

// ---- unassigned submodule parameters --------------------------------------------------------------

test('neddoc extract: unassigned submodule parameters walk', async () => {
  const model = await extract(await buildInput({ 'file:///lib.ned': LIB, 'file:///net.ned': NET }));
  const net = page(model, 'lib.Net');
  const deep = tableAfter(net, 'Unassigned submodule parameters');
  const names = deep.rows.map((r) => cellText(r.cells[0]));
  // Node.label has no assignment; Node.rate has only default(...); Sink.capacity unassigned
  assert.ok(names.includes('n1.label'), names.join('; '));
  assert.ok(names.includes('n1.rate'), names.join('; '));
  assert.ok(names.includes('n2.capacity'), names.join('; '));
  // the submodule path segment links to the type page
  const row = deep.rows.find((r) => cellText(r.cells[0]) === 'n1.rate')!;
  const first = row.cells[0][0];
  assert.equal(first.kind, 'link');
  assert.equal((first as { page?: string }).page, 'lib.Node');
});

test('neddoc extract: recursive compound modules do not loop', async () => {
  const REC = `package r;
module Rec { submodules: inner: Rec2; }
module Rec2 { submodules: back: Rec; }
network N { submodules: top: Rec; }
`;
  const model = await extract(await buildInput({ 'file:///r.ned': REC }));
  page(model, 'r.N'); // completing extraction is the assertion
});

// ---- MSG pages ------------------------------------------------------------------------------------

test('neddoc extract: msg fields table with inherited rows, vectors and type links', async () => {
  const model = await extract(await buildInput({}, { 'file:///p.msg': MSG }));
  const bar = page(model, 'msg-lib--BarPkt');
  const fields = tableAfter(bar, 'Fields');
  const byName = new Map(fields.rows.map((r) => [cellText(r.cells[0]), r]));
  assert.equal(byName.get('seq')!.cssClass, 'inherited');
  assert.equal(byName.get('extra')!.cssClass, 'local');
  assert.equal(cellText(byName.get('payload')!.cells[1]), 'string[]');

  const ext = tableAfter(bar, 'Extends');
  const link = ext.rows[0].cells[0][0];
  assert.equal(link.kind, 'link');
  assert.equal((link as { page?: string }).page, 'msg-lib--FooPkt');

  const foo = page(model, 'msg-lib--FooPkt');
  const subs = tableAfter(foo, 'Known subclasses');
  assert.equal(cellText(subs.rows[0].cells[0]), 'BarPkt');
});

test('neddoc extract: messageDefinitions=false drops msg pages', async () => {
  const model = await extract(await buildInput({ 'file:///lib.ned': LIB }, { 'file:///p.msg': MSG }), {
    messageDefinitions: false,
  });
  assert.ok(!model.pages.some((p) => p.ref.kind === 'msgtype'));
});

// ---- comment type refs across languages -------------------------------------------------------------

test('neddoc extract: ~refs in descriptions resolve to page ids', async () => {
  const model = await extract(await buildInput({ 'file:///lib.ned': LIB }));
  const sink = page(model, 'lib.Sink');
  const doc = sink.sections.find((s) => s.kind === 'doc')!;
  const json = JSON.stringify(doc);
  assert.ok(json.includes('"typeref"') && json.includes('lib.Node'), json);
});

// ---- nav & search -------------------------------------------------------------------------------------

test('neddoc extract: nav tree categories and search index', async () => {
  const model = await extract(await buildInput({ 'file:///lib.ned': LIB, 'file:///net.ned': NET }, { 'file:///p.msg': MSG }));
  const titles = model.navRoot.children.map((n) => n.title);
  assert.deepEqual(titles, ['Overview', 'Packages', 'Networks', 'Modules', 'Module Interfaces', 'Namespaces', 'Message Definitions', 'Files']);
  const networks = model.navRoot.children.find((n) => n.title === 'Networks')!;
  assert.deepEqual(networks.children.map((c) => c.title), ['Net']);
  const msgDefs = model.navRoot.children.find((n) => n.title === 'Message Definitions')!;
  assert.deepEqual(msgDefs.children.map((c) => c.title), ['Packets']);
  assert.ok(model.searchIndex.some((e) => e.fqName === 'lib.Node' && e.page === 'lib.Node'));
});

// ---- full project-wide diagram pages -----------------------------------------------------------

test('neddoc extract: full diagram pages are off by default', async () => {
  const model = await extract(await buildInput({ 'file:///lib.ned': LIB }, { 'file:///p.msg': MSG }));
  assert.ok(!model.pages.some((p) => p.ref.kind === 'fulldiagram'));
  assert.ok(!model.navRoot.children.some((n) => n.title === 'Diagrams'));
});

test('neddoc extract: full diagram pages, nav node and graph-carrying requests', async () => {
  const model = await extract(await buildInput({ 'file:///lib.ned': LIB, 'file:///net.ned': NET }, { 'file:///p.msg': MSG }), {
    fullUsageDiagrams: true,
    fullInheritanceDiagrams: true,
  });
  // Eclipse page ids/titles
  for (const id of ['full-ned-usage-diagram', 'full-ned-inheritance-diagram', 'full-msg-usage-diagram', 'full-msg-inheritance-diagram'])
    page(model, id);
  assert.equal(page(model, 'full-ned-usage-diagram').ref.title, 'Full NED Usage Diagram');
  assert.equal(page(model, 'full-ned-usage-diagram').ref.kind, 'fulldiagram');

  // nav "Diagrams" node right after Overview
  const titles = model.navRoot.children.map((n) => n.title);
  assert.equal(titles[0], 'Overview');
  assert.equal(titles[1], 'Diagrams');
  const diagrams = model.navRoot.children[1];
  assert.deepEqual(
    diagrams.children.map((c) => c.title),
    ['Full NED Usage Diagram', 'Full NED Inheritance Diagram', 'Full MSG Usage Diagram', 'Full MSG Inheritance Diagram'],
  );

  // graph-carrying requests covering the whole project
  const fullInh = model.diagrams.find((d) => d.image === 'images/full-ned-inheritance-diagram.svg')!;
  assert.ok(fullInh);
  assert.equal(fullInh.diagram, 'inheritance');
  const nodeIds = fullInh.graph!.nodes.map((n) => n.id);
  assert.ok(nodeIds.includes('lib.Node') && nodeIds.includes('lib.Sink') && nodeIds.includes('lib.Net'), nodeIds.join());
  assert.ok(fullInh.graph!.edges.some((e) => e.src === 'lib.Node' && e.dest === 'lib.Sink'), 'Node->Sink edge missing');
  // UdpApp implements IApp -> interface edge
  assert.ok(fullInh.graph!.edges.some((e) => e.src === 'lib.IApp' && e.dest === 'lib.UdpApp' && e.kind === 'interface'));

  const fullUsage = model.diagrams.find((d) => d.image === 'images/full-ned-usage-diagram.svg')!;
  assert.ok(fullUsage.graph!.edges.some((e) => e.src === 'lib.Net' && e.dest === 'lib.Node' && e.kind === 'usage'));

  const msgInh = model.diagrams.find((d) => d.image === 'images/full-msg-inheritance-diagram.svg')!;
  assert.ok(msgInh.graph!.edges.some((e) => e.src === 'msg-lib--FooPkt' && e.dest === 'msg-lib--BarPkt'));
});

test('neddoc extract: msg full diagram pages skipped without msg types', async () => {
  const model = await extract(await buildInput({ 'file:///lib.ned': LIB }), {
    fullUsageDiagrams: true,
    fullInheritanceDiagrams: true,
  });
  page(model, 'full-ned-usage-diagram');
  assert.ok(!model.pages.some((p) => p.ref.id === 'full-msg-usage-diagram'));
});

// ---- diagram requests -----------------------------------------------------------------------------------

test('neddoc extract: diagram placeholders and requests honor options', async () => {
  const input = await buildInput({ 'file:///lib.ned': LIB, 'file:///net.ned': NET });
  const model = await extract(input);
  const forNet = model.diagrams.filter((d) => d.typeFqName === 'lib.Net');
  assert.deepEqual(forNet.map((d) => d.diagram).sort(), ['type', 'usage']);
  const none = await extract(input, { typeDiagrams: false, usageDiagrams: false, inheritanceDiagrams: false });
  assert.equal(none.diagrams.length, 0);
});
