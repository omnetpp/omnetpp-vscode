import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { ConfigRegistry } from '../ini/configRegistry';
import { iniStructureDiagnostics } from '../ini/iniStructureChecks';
import { iniVariableDiagnostics } from '../ini/iniVariables';
import { iniParamDiagnostics, resolveNetworkType } from '../ini/iniParamResolution';
import { nedRename } from '../ned/nedRename';
import { nedReferences } from '../ned/nedNavigation';
import { prepareTypeHierarchy, typeSupertypes, typeSubtypes, inheritanceSpineFor } from '../ned/nedHierarchy';
import { docCommentCompletion } from '../ned/nedCompletion';
import { networkModuleTree } from '../ini/moduleTree';
import { moduleHierarchyRoot, moduleHierarchyChildren } from '../ned/nedModuleHierarchy';
import { paramHierarchyRoot, paramHierarchyChildren } from '../ned/nedParamHierarchy';
import { parseIni } from '../ini/iniDocument';
import { DiagnosticSeverity } from '../model/location';

async function nedCache(files: Record<string, { text: string; pkg: string }>) {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  for (const [uri, f] of Object.entries(files)) cache.addFile(uri, svc.parse('ned', f.text), f.pkg);
  return cache;
}

const registry = new ConfigRegistry([
  { name: 'network', type: 'string', default: null, scope: 'per-run', description: '' },
  { name: 'sim-time-limit', type: 'double', unit: 's', default: null, scope: 'per-run', description: '' },
  { name: 'configuration-class', type: 'string', default: null, scope: 'global', description: '' },
]);

// ---- Phase 1: INI structural & config diagnostics ----

test('section name with space is flagged', async () => {
  const cache = await nedCache({});
  const doc = parseIni('[Config Foo Bar]\nsim-time-limit = 1s\n');
  const diags = iniStructureDiagnostics(doc, cache, registry);
  assert.ok(diags.some((d) => d.code === 'bad-section-name' && /space/.test(d.message)));
});

test('extends= in [General] is flagged', async () => {
  const cache = await nedCache({});
  const doc = parseIni('[General]\nextends = Foo\n[Config Foo]\n');
  const diags = iniStructureDiagnostics(doc, cache, registry);
  assert.ok(diags.some((d) => d.code === 'extends-in-general'));
});

test('extends= to non-existent section is flagged', async () => {
  const cache = await nedCache({});
  const doc = parseIni('[Config A]\nextends = Nope\n');
  const diags = iniStructureDiagnostics(doc, cache, registry);
  assert.ok(diags.some((d) => d.code === 'no-such-section' && /Nope/.test(d.message)));
});

test('extends= to existing section is OK', async () => {
  const cache = await nedCache({});
  const doc = parseIni('[Config Base]\n[Config A]\nextends = Base\n');
  const diags = iniStructureDiagnostics(doc, cache, registry);
  assert.ok(!diags.some((d) => d.code === 'no-such-section'));
});

test('global-only option outside [General] is flagged', async () => {
  const cache = await nedCache({});
  const doc = parseIni('[Config A]\nconfiguration-class = Foo\n');
  const diags = iniStructureDiagnostics(doc, cache, registry);
  assert.ok(diags.some((d) => d.code === 'config-placement'));
});

test('network= unknown / not-a-module / not-a-network', async () => {
  const cache = await nedCache({
    'file:///n.ned': {
      text: 'network Net { }\nsimple Plain { }\nchannel Chan { }',
      pkg: '',
    },
  });
  const unknown = iniStructureDiagnostics(parseIni('[General]\nnetwork = Missing\n'), cache, registry);
  assert.ok(unknown.some((d) => d.code === 'network-type' && /No such NED type/.test(d.message)));

  const notModule = iniStructureDiagnostics(parseIni('[General]\nnetwork = Chan\n'), cache, registry);
  assert.ok(notModule.some((d) => d.code === 'network-type' && /Not a module type/.test(d.message)));

  const notNetwork = iniStructureDiagnostics(parseIni('[General]\nnetwork = Plain\n'), cache, registry);
  assert.ok(notNetwork.some((d) => d.code === 'network-type' && /was not declared to be a network/.test(d.message)));

  const ok = iniStructureDiagnostics(parseIni('[General]\nnetwork = Net\n'), cache, registry);
  assert.ok(!ok.some((d) => d.code === 'network-type'));
});

test('network= unqualified name resolves via the ini folder package, like OMNeT++', async () => {
  const cache = await nedCache({
    'file:///proj/a/net.ned': { text: 'package a;\nnetwork Dup { }', pkg: 'a' },
    'file:///proj/b/net.ned': { text: 'package b;\nnetwork Dup { }', pkg: 'b' },
  });
  // ini in a/ resolves Dup to a.Dup; ini in b/ resolves the same name to b.Dup
  assert.equal(resolveNetworkType(cache, 'Dup', 'file:///proj/a/omnetpp.ini')?.fqName, 'a.Dup');
  assert.equal(resolveNetworkType(cache, 'Dup', 'file:///proj/b/omnetpp.ini')?.fqName, 'b.Dup');

  // neither is flagged: OMNeT++ has no "ambiguous network" concept
  const inA = iniStructureDiagnostics(parseIni('[General]\nnetwork = Dup\n', 'file:///proj/a/omnetpp.ini'), cache, registry);
  assert.ok(!inA.some((d) => d.code === 'ambiguous-network' || d.code === 'network-type'), JSON.stringify(inA));

  // a fully qualified name is looked up directly
  assert.equal(resolveNetworkType(cache, 'b.Dup', 'file:///proj/a/omnetpp.ini')?.fqName, 'b.Dup');
  const qualified = iniStructureDiagnostics(parseIni('[General]\nnetwork = a.Dup\n', 'file:///proj/a/omnetpp.ini'), cache, registry);
  assert.ok(!qualified.some((d) => d.code === 'network-type'), JSON.stringify(qualified));
});

test('network= unqualified name with no co-located NED falls back to the root package', async () => {
  const cache = await nedCache({
    'file:///proj/a/net.ned': { text: 'package a;\nnetwork Dup { }', pkg: 'a' },
    'file:///Root.ned': { text: 'network Root { }', pkg: '' },
  });
  // ini folder has no NED file: only the verbatim (root-package) lookup applies
  assert.equal(resolveNetworkType(cache, 'Root', 'file:///proj/x/omnetpp.ini')?.fqName, 'Root');
  assert.equal(resolveNetworkType(cache, 'Dup', 'file:///proj/x/omnetpp.ini'), undefined);
});

test('param resolution uses the ini-folder network for an unqualified name', async () => {
  const cache = await nedCache({
    'file:///proj/a/net.ned': { text: 'package a;\nnetwork Dup { parameters: int aOnly = 0; }', pkg: 'a' },
    'file:///proj/b/net.ned': { text: 'package b;\nnetwork Dup { parameters: int bOnly = 0; }', pkg: 'b' },
  });
  // ini next to package a → Dup.aOnly matches a.Dup, no warning
  const nearA = iniParamDiagnostics(
    parseIni('[General]\nnetwork = Dup\nDup.aOnly = 1\n', 'file:///proj/a/omnetpp.ini'),
    cache,
    registry,
  );
  assert.deepEqual(nearA.filter((d) => d.code === 'no-matching-param'), [], JSON.stringify(nearA));
  // the very same key against package b resolves to b.Dup, where aOnly does not exist
  const nearB = iniParamDiagnostics(
    parseIni('[General]\nnetwork = Dup\nDup.aOnly = 1\n', 'file:///proj/b/omnetpp.ini'),
    cache,
    registry,
  );
  assert.ok(nearB.some((d) => d.code === 'no-matching-param'), JSON.stringify(nearB));
});

// ---- Phase 2: iteration variables ----

test('undefined ${var} reference is flagged', () => {
  const d = iniVariableDiagnostics(parseIni('[Config A]\n**.x = ${nope}\n'));
  assert.ok(d.some((x) => x.code === 'undefined-variable' && /nope/.test(x.message)));
});

test('defined named variable resolves and reference is OK', () => {
  const d = iniVariableDiagnostics(parseIni('[Config A]\n**.x = ${v=1,2,3}\n**.y = ${v}\n'));
  assert.ok(!d.some((x) => x.code === 'undefined-variable'));
});

test('predefined variables are valid references', () => {
  const d = iniVariableDiagnostics(parseIni('[Config A]\n**.x = ${configname}\n'));
  assert.deepEqual(d, []);
});

test('redefining a predefined variable is flagged', () => {
  const d = iniVariableDiagnostics(parseIni('[Config A]\n**.x = ${configname=1,2}\n'));
  assert.ok(d.some((x) => x.code === 'predefined-variable'));
});

test('in-section redefinition is flagged', () => {
  const d = iniVariableDiagnostics(parseIni('[Config A]\n**.x = ${v=1,2}\n**.y = ${v=3,4}\n'));
  assert.ok(d.some((x) => x.code === 'redefined-variable'));
});

test('cross-section redeclaration through extends is flagged', () => {
  const d = iniVariableDiagnostics(
    parseIni('[Config Base]\n**.x = ${v=1,2}\n[Config A]\nextends = Base\n**.y = ${v=3,4}\n'),
  );
  assert.ok(d.some((x) => x.code === 'redeclared-variable'));
});

test('unknown parallel !var is flagged', () => {
  const d = iniVariableDiagnostics(parseIni('[Config A]\n**.x = ${1,2,3 ! nope}\n'));
  assert.ok(d.some((x) => x.code === 'unknown-parvar'));
});

// ---- Phase 3: INI value-level parity ----

const VALUE_NED = `simple Host {
  parameters:
    double rate @unit(bps);
    string mode @enum("a","b");
    int n = 10;
}
network Net { submodules: h: Host; }`;

async function valueCache() {
  return nedCache({ 'file:///v.ned': { text: VALUE_NED, pkg: '' } });
}

test('incompatible unit is flagged, compatible unit is OK', async () => {
  const cache = await valueCache();
  const bad = iniParamDiagnostics(parseIni('[General]\nnetwork = Net\n**.rate = 5s\n'), cache, registry);
  assert.ok(bad.some((d) => d.code === 'param-unit-mismatch'));
  const good = iniParamDiagnostics(parseIni('[General]\nnetwork = Net\n**.rate = 5Mbps\n'), cache, registry);
  assert.ok(!good.some((d) => d.code === 'param-unit-mismatch'));
});

test('@enum value validation', async () => {
  const cache = await valueCache();
  const bad = iniParamDiagnostics(parseIni('[General]\nnetwork = Net\n**.mode = "c"\n'), cache, registry);
  assert.ok(bad.some((d) => d.code === 'param-enum-value'));
  const good = iniParamDiagnostics(parseIni('[General]\nnetwork = Net\n**.mode = "a"\n'), cache, registry);
  assert.ok(!good.some((d) => d.code === 'param-enum-value'));
});

test('same-as-NED-default reports an info', async () => {
  const cache = await valueCache();
  const d = iniParamDiagnostics(parseIni('[General]\nnetwork = Net\n**.h.n = 10\n'), cache, registry);
  assert.ok(d.some((x) => x.code === 'redundant-assignment' && x.severity === DiagnosticSeverity.Information));
});

// ---- Phase 4: NED member rename + find-references ----

/** Position of the nth (0-based) occurrence of `needle` in text. */
function posOf(text: string, needle: string, n = 0): { line: number; character: number } {
  const lines = text.split('\n');
  let count = 0;
  for (let line = 0; line < lines.length; line++) {
    let from = 0;
    for (;;) {
      const idx = lines[line].indexOf(needle, from);
      if (idx < 0) break;
      if (count === n) return { line, character: idx };
      count++;
      from = idx + 1;
    }
  }
  throw new Error(`needle "${needle}" #${n} not found`);
}

test('param rename rewrites declaration and inherited override', async () => {
  const text = 'simple Host {\n  parameters:\n    int q = 1;\n}\nsimple Fast extends Host {\n  parameters:\n    q = 2;\n}\n';
  const cache = await nedCache({ 'file:///h.ned': { text, pkg: '' } });
  const f = cache.getFile('file:///h.ned')!;
  const edit = nedRename(cache, f, f.tree, posOf(text, 'q'), 'qlen');
  assert.ok(edit?.changes);
  const edits = edit!.changes!['file:///h.ned'];
  assert.equal(edits.length, 2, 'declaration + override');
  assert.ok(edits.every((e) => e.newText === 'qlen'));
});

test('gate references include connection endpoints', async () => {
  const text =
    'simple Node {\n  gates:\n    inout g;\n}\n' +
    'network Net {\n  submodules:\n    a: Node;\n    b: Node;\n  connections:\n    a.g <--> b.g;\n}\n';
  const cache = await nedCache({ 'file:///g.ned': { text, pkg: '' } });
  const f = cache.getFile('file:///g.ned')!;
  const refs = nedReferences(cache, f, f.tree, posOf(text, 'g;'), true);
  // declaration + a.g + b.g
  assert.ok(refs.length >= 3, `expected >=3 gate refs, got ${refs.length}`);
});

test('submodule rename rewrites declaration and connection reference', async () => {
  const text =
    'simple Node {\n  gates:\n    inout g;\n}\n' +
    'network Net {\n  submodules:\n    a: Node;\n    b: Node;\n  connections:\n    a.g <--> b.g;\n}\n';
  const cache = await nedCache({ 'file:///s.ned': { text, pkg: '' } });
  const f = cache.getFile('file:///s.ned')!;
  // cursor on the submodule declaration "a:"
  const edit = nedRename(cache, f, f.tree, posOf(text, 'a:'), 'src');
  const edits = edit?.changes?.['file:///s.ned'] ?? [];
  assert.ok(edits.length >= 2, `expected decl + connection ref, got ${edits.length}`);
});

// ---- Phase 5: NED type hierarchy ----

test('type hierarchy resolves super- and subtypes', async () => {
  const text = 'simple Base { }\nsimple Mid extends Base { }\nsimple Leaf extends Mid { }\n';
  const cache = await nedCache({ 'file:///t.ned': { text, pkg: '' } });
  const f = cache.getFile('file:///t.ned')!;
  const item = prepareTypeHierarchy(cache, f, f.tree, posOf(text, 'Mid'));
  assert.equal(item?.fqName, 'Mid');
  assert.deepEqual(typeSupertypes(cache, 'Mid').map((i) => i.name), ['Base']);
  assert.deepEqual(typeSubtypes(cache, 'Mid').map((i) => i.name), ['Leaf']);
  assert.deepEqual(typeSubtypes(cache, 'Base').map((i) => i.name), ['Mid']);
});

test('inheritance spine: supertype chain to selected, only direct subtypes opened', async () => {
  const text =
    'simple Base { }\nsimple Mid extends Base { }\n' +
    'simple Leaf extends Mid { }\nsimple Other extends Mid { }\n';
  const cache = await nedCache({ 'file:///sp.ned': { text, pkg: '' } });

  // select Mid: root Base -> Mid (selected) -> [Leaf, Other] (collapsed/lazy)
  const mid = inheritanceSpineFor(cache, cache.getType('Mid')!);
  assert.equal(mid.length, 1);
  assert.equal(mid[0].name, 'Base');
  assert.ok(mid[0].expanded);
  assert.deepEqual(mid[0].children?.map((c) => c.name), ['Mid']);
  const midNode = mid[0].children![0];
  assert.ok(midNode.isSelected && midNode.expanded);
  assert.deepEqual(midNode.children?.map((c) => c.name).sort(), ['Leaf', 'Other']);
  assert.ok(midNode.children?.every((c) => c.lazy && !c.expanded), 'subtype nodes are lazy/closed');

  // select Leaf: chain Base -> Mid -> Leaf, excluding sibling Other
  const leaf = inheritanceSpineFor(cache, cache.getType('Leaf')!);
  assert.deepEqual(leaf[0].children?.map((c) => c.name), ['Mid']);
  assert.deepEqual(leaf[0].children![0].children?.map((c) => c.name), ['Leaf']);
});

// ---- Phase 6: doc-comment completion ----

test('doc-comment keyword completion after @', () => {
  const items = docCommentCompletion('// @')!;
  assert.ok(items, 'in-comment @ yields proposals');
  assert.ok(items.some((i) => i.label === '@author'));
});

test('doc-comment HTML tag completion after <', () => {
  const items = docCommentCompletion('// see <')!;
  assert.ok(items.some((i) => i.label === '<b>'));
});

test('no doc completion outside a comment', () => {
  assert.equal(docCommentCompletion('simple @'), undefined);
});

// ---- Phase 7: module tree (data backing the tree views) ----

test('networkModuleTree builds a nested module tree', async () => {
  const text =
    'simple App { parameters: int p = 1; }\n' +
    'module Host { submodules: app: App; }\n' +
    'network Net { submodules: h: Host; h2: Host; }\n';
  const cache = await nedCache({ 'file:///m.ned': { text, pkg: '' } });
  const net = cache.getType('Net')!;
  const tree = networkModuleTree(cache, net);
  assert.equal(tree.name, 'Net');
  assert.equal(tree.children.length, 2);
  const h = tree.children.find((c) => c.name === 'h')!;
  assert.equal(h.typeFqName, 'Host');
  const app = h.children.find((c) => c.name === 'app' && c.typeFqName === 'App')!;
  assert.ok(app, 'nested submodule app present');
  // params are carried per node (for the Module Parameters view)
  assert.ok(app.params.some((p) => p.name === 'p' && p.type === 'int' && p.uri));
});

test('module hierarchy: own submodules (alpha) then inherited as Super::name', async () => {
  const text =
    'simple Leaf { }\n' +
    'module Base {\n  submodules:\n    b1: Leaf;\n    a1: Leaf;\n}\n' +
    'module Derived extends Base {\n  submodules:\n    z: Leaf;\n    m: Leaf;\n}\n';
  const cache = await nedCache({ 'file:///mh.ned': { text, pkg: '' } });
  const root = moduleHierarchyRoot(cache, cache.getType('Derived')!);
  assert.equal(root.name, 'Derived');
  assert.ok(root.isSelected);
  const labels = root.children!.map((c) => c.label);
  // own submodules first, alphabetical: m, z; then inherited from Base, alpha: a1, b1
  assert.deepEqual(labels, ['m', 'z', 'Base::a1', 'Base::b1']);
  assert.equal(root.children!.find((c) => c.label === 'Base::a1')!.inheritedFrom, 'Base');
});

test('module hierarchy is recursive: submodule nodes expose their own submodules', async () => {
  const text =
    'simple Leaf { }\n' +
    'module Inner {\n  submodules:\n    x: Leaf;\n}\n' +
    'network Net {\n  submodules:\n    inner: Inner;\n}\n';
  const cache = await nedCache({ 'file:///r.ned': { text, pkg: '' } });
  const root = moduleHierarchyRoot(cache, cache.getType('Net')!);
  const inner = root.children!.find((c) => c.name === 'inner')!;
  assert.equal(inner.typeFqName, 'Inner');
  assert.ok(inner.hasChildren, 'inner has further submodules → expandable');
  // navigation target is the submodule DECLARATION (the `inner: Inner;` line),
  // not the Inner type definition
  assert.equal(inner.declUri, 'file:///r.ned');
  assert.equal(inner.declRange!.start.line, 7);
  assert.notEqual(inner.declRange!.start.line, inner.typeRange!.start.line);
  // expanding the inner node (lazy) yields Inner's own submodules
  const kids = moduleHierarchyChildren(cache, inner.typeFqName!);
  assert.deepEqual(kids.map((c) => c.name), ['x']);
  assert.equal(kids[0].hasChildren, false);
});

test('module parameters: own params (alpha), inherited Super::param, then submodules', async () => {
  const text =
    'simple Leaf { parameters: int k; }\n' +
    'module Base {\n  parameters:\n    int bb;\n    int aa;\n}\n' +
    'module Derived extends Base {\n  parameters:\n    int z;\n    int m;\n  submodules:\n    sub: Leaf;\n}\n';
  const cache = await nedCache({ 'file:///pp.ned': { text, pkg: '' } });
  const root = paramHierarchyRoot(cache, cache.getType('Derived')!);
  assert.ok(root.isSelected);
  const labels = root.children!.map((c) => `${c.kind}:${c.label}`);
  // own params alpha (m,z), then inherited Base::aa, Base::bb, then submodule sub
  assert.deepEqual(labels, ['param:m', 'param:z', 'param:Base::aa', 'param:Base::bb', 'module:sub']);
  const sub = root.children!.find((c) => c.label === 'sub')!;
  assert.equal(sub.kind, 'module');
  assert.ok(sub.hasChildren, 'submodule expandable (Leaf has param k)');
  // recursive: expanding the submodule yields its type's params
  const subKids = paramHierarchyChildren(cache, sub.typeFqName!);
  assert.deepEqual(subKids.map((c) => `${c.kind}:${c.label}`), ['param:k']);
});

test('module parameters: effective value first, overridden supertype assignment greyed', async () => {
  const text =
    'simple Base { parameters: int cap = 1; }\n' +
    'simple D extends Base {\n  parameters:\n    cap = 5;\n}\n';
  const cache = await nedCache({ 'file:///ov.ned': { text, pkg: '' } });
  const root = paramHierarchyRoot(cache, cache.getType('D')!);
  const rows = root.children!.filter((c) => c.kind === 'param');
  assert.equal(rows.length, 2);
  // effective value (set in D) first, labelled without prefix
  assert.equal(rows[0].label, 'cap');
  assert.equal(rows[0].paramValue, '5');
  assert.equal(rows[0].paramType, 'int');
  assert.ok(!rows[0].overridden);
  // overridden base default right after, greyed, with Base:: prefix
  assert.equal(rows[1].label, 'Base::cap');
  assert.equal(rows[1].paramValue, '1');
  assert.equal(rows[1].overridden, true);
});

test('module parameters: most-derived wins across a 3-level chain', async () => {
  const text =
    'simple Base { parameters: int cap = 1; }\n' +
    'simple Mid extends Base { parameters: cap = 2; }\n' +
    'simple D extends Mid { parameters: cap = 3; }\n';
  const cache = await nedCache({ 'file:///chain.ned': { text, pkg: '' } });
  const rows = paramHierarchyRoot(cache, cache.getType('D')!).children!.filter((c) => c.kind === 'param');
  assert.deepEqual(
    rows.map((r) => `${r.label}=${r.paramValue}${r.overridden ? '(o)' : ''}`),
    ['cap=3', 'Mid::cap=2(o)', 'Base::cap=1(o)'],
  );
});
