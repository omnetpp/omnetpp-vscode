import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import {
  NedResourceCache,
  parseIni,
  matchedParamModules,
  matchedModules,
  iniParamDefinition,
  type IniDocument,
  type IniSection,
} from '../index';

const NED = `
moduleinterface IApp { }
simple App { parameters: int p = default(0);
  double q; }
simple LikeApp like IApp { parameters: int p = default(0); }
module Host { submodules: app: App; }
network Net { submodules: host: Host; }
network LNet { submodules: a: <> like IApp; }
`;

const INI = `
[General]
**.app.p = 10

[Config C]
network = Net
**.host.app.p = 1
**.host.app.* = 2
**.p = 3

[Config L]
network = LNet
**.a.typename = "LikeApp"
**.a.p = 4
`;

async function makeCtx() {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  nedCache.addFile('file:///net.ned', svc.parse('ned', NED), '');
  const doc = parseIni(INI);
  return { nedCache, doc };
}

function sec(doc: IniDocument, name: string): IniSection {
  const s = name === 'General'
    ? doc.sections.find((x) => x.type === 'general')
    : doc.sections.find((x) => x.configName === name);
  assert.ok(s, `missing section ${name}`);
  return s!;
}

const paths = (ms: { path: string }[]) => ms.map((m) => m.path).sort();

test('concrete key matches a single module parameter with a NED decl', async () => {
  const { nedCache, doc } = await makeCtx();
  const ms = matchedParamModules(doc, nedCache, sec(doc, 'C'), '**.host.app.p');
  assert.deepEqual(paths(ms), ['Net.host.app']);
  assert.equal(ms[0].paramName, 'p');
  assert.equal(ms[0].typeFqName, 'App');
  assert.ok(ms[0].decl, 'expected a NED declaration location');
  assert.equal(ms[0].decl!.uri, 'file:///net.ned');
});

test('wildcard leaf matches every parameter of the module', async () => {
  const { nedCache, doc } = await makeCtx();
  const ms = matchedParamModules(doc, nedCache, sec(doc, 'C'), '**.host.app.*');
  assert.deepEqual(ms.map((m) => m.paramName).sort(), ['p', 'q']);
});

test('** deep-wildcard matches by leaf name', async () => {
  const { nedCache, doc } = await makeCtx();
  const ms = matchedParamModules(doc, nedCache, sec(doc, 'C'), '**.p');
  assert.deepEqual(paths(ms), ['Net.host.app']);
  assert.equal(ms[0].paramName, 'p');
});

test('typename-bound like submodule resolves and matches', async () => {
  const { nedCache, doc } = await makeCtx();
  const ms = matchedParamModules(doc, nedCache, sec(doc, 'L'), '**.a.p');
  assert.deepEqual(paths(ms), ['LNet.a']);
  assert.equal(ms[0].typeFqName, 'LikeApp');
});

test('[General] line resolves through the active-config fallback network', async () => {
  const { nedCache, doc } = await makeCtx();
  const general = sec(doc, 'General');
  // no network in scope → no matches
  assert.equal(matchedParamModules(doc, nedCache, general, '**.app.p').length, 0);
  // active config supplies the network
  const ms = matchedParamModules(doc, nedCache, general, '**.app.p', 'Net');
  assert.deepEqual(paths(ms), ['Net.host.app']);
});

test('go-to-definition falls back to the first matching module when the leaf is not a parameter', async () => {
  const { nedCache, doc } = await makeCtx();
  const c = sec(doc, 'C');
  // no such parameter → no parameter matches
  assert.equal(matchedParamModules(doc, nedCache, c, '**.host.app.nope').length, 0);
  // the module prefix still resolves
  const mods = matchedModules(doc, nedCache, c, '**.host.app.nope');
  assert.deepEqual(paths(mods), ['Net.host.app']);
  assert.equal(mods[0].typeFqName, 'App');
  // definition returns that module's declaration instead of nothing
  const defs = iniParamDefinition(doc, nedCache, c, '**.host.app.nope');
  assert.equal(defs.length, 1);
  assert.deepEqual(defs[0], mods[0].decl);
});

test('iniParamDefinition returns distinct decls, including for wildcard leaves', async () => {
  const { nedCache, doc } = await makeCtx();
  // wildcard leaf used to return nothing; now yields both App params' decls
  const defs = iniParamDefinition(doc, nedCache, sec(doc, 'C'), '**.host.app.*');
  assert.equal(defs.length, 2);
  const lines = new Set(defs.map((d) => d.range.start.line));
  assert.equal(lines.size, 2, 'expected two distinct declaration locations');
});
