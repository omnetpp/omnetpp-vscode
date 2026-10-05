import { test } from 'bun:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getParsers } from './helpers';
import {
  NedResourceCache,
  BUILTIN_NED_TEXT,
  BUILTIN_URI,
  ConfigRegistry,
  classifyKey,
  parseIni,
  matchedParamModules,
  matchedModules,
  modulesAtPath,
  typenameTypeTargets,
  typenameSlotInterfaces,
  iniParamDefinition,
  type IniDocument,
  type IniSection,
} from '../index';

const registry = new ConfigRegistry(
  JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'resources', 'config', 'opp-config-options.json'), 'utf8')).options,
);

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

// ---- segment-aware navigation: a module-path segment -> the module's NED type ----

test('modulesAtPath resolves a path prefix to the module instance(s) and their type', async () => {
  const { nedCache, doc } = await makeCtx();
  const c = sec(doc, 'C');
  // the `host` segment of `**.host.app.p`
  const host = modulesAtPath(doc, nedCache, c, '**.host');
  assert.deepEqual(paths(host), ['Net.host']);
  assert.equal(host[0].typeFqName, 'Host');
  // the `app` segment
  const app = modulesAtPath(doc, nedCache, c, '**.host.app');
  assert.deepEqual(paths(app), ['Net.host.app']);
  assert.equal(app[0].typeFqName, 'App');
  // the network root itself
  const root = modulesAtPath(doc, nedCache, c, 'Net');
  assert.deepEqual(paths(root), ['Net']);
  assert.equal(root[0].typeFqName, 'Net');
});

test('modulesAtPath resolves a like slot to its typename-bound concrete type', async () => {
  const { nedCache, doc } = await makeCtx();
  const a = modulesAtPath(doc, nedCache, sec(doc, 'L'), '**.a');
  assert.deepEqual(paths(a), ['LNet.a']);
  assert.equal(a[0].typeFqName, 'LikeApp');
});

// ---- typename value navigation: the string denotes a NED type ----

test('typenameTypeTargets resolves an unqualified typename value to the module type', async () => {
  const { nedCache } = await makeCtx();
  const locs = typenameTypeTargets(nedCache, '"LikeApp"');
  assert.equal(locs.length, 1);
  assert.equal(locs[0].uri, 'file:///net.ned');
});

test('typenameTypeTargets ignores non-module names and variable-driven values', async () => {
  const { nedCache } = await makeCtx();
  assert.deepEqual(typenameTypeTargets(nedCache, '"IApp"'), []); // an interface, not a module
  assert.deepEqual(typenameTypeTargets(nedCache, '"${t}"'), []); // variable-driven
  assert.deepEqual(typenameTypeTargets(nedCache, '"Nope"'), []); // unknown
});

// ---- pseudo-parameter keys (typename/display-name) navigate to the applied module type ----

test('typename/display-name are per-object pseudo-parameters (drive module-type navigation)', () => {
  // The navigation routing keys off this classification, so lock it down.
  for (const key of ['**.host.app.typename', '**.host.display-name']) {
    const cls = classifyKey(registry, key);
    assert.equal(cls.kind, 'config', key);
    assert.equal(cls.kind === 'config' && cls.option.scope, 'per-object', key);
  }
});

test('a pseudo-parameter leaf resolves to the NED type of the module it applies to', async () => {
  const { nedCache, doc } = await makeCtx();
  const c = sec(doc, 'C');
  // `**.host.display-name` applies to `host` -> Host
  const host = modulesAtPath(doc, nedCache, c, '**.host', undefined);
  assert.equal(host[0]?.typeFqName, 'Host');
  // `**.host.app.typename` applies to `app` -> App (the module the pseudo-param is on)
  const app = modulesAtPath(doc, nedCache, c, '**.host.app', undefined);
  assert.equal(app[0]?.typeFqName, 'App');
});

// ---- iniParamDefinition through `like` submodules with index-specific typenames ----

const LIKE_NED = `
moduleinterface IApp { parameters: int dummy; }
simple Queue { parameters: int capacity = 10; double rate @unit(bps); }
simple ConcreteApp like IApp { parameters: int dummy; string addr; }
simple SinkApp like IApp { parameters: int dummy; }
network Net {
  parameters:
    int numHosts = 3;
  submodules:
    queue: Queue;
    host[numHosts]: <> like IApp;
}`;

async function cacheWithLikeNed() {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  cache.addFile('file:///net.ned', svc.parse('ned', LIKE_NED), '');
  return cache;
}

test('go-to-definition resolves a param that lives only on a non-primary candidate', async () => {
  const cache = await cacheWithLikeNed();
  const doc = parseIni(`network = Net
*.host[0].typename = "SinkApp"
*.host[*].typename = "ConcreteApp"
*.host[*].addr = "x"`);
  // `addr` is declared on ConcreteApp (the 2nd candidate); paramOwner must make
  // navigation land on its real NED declaration, not fail.
  const defs = iniParamDefinition(doc, cache, doc.sections[0], '*.host[*].addr');
  assert.ok(defs.length >= 1, 'found a declaration for addr');
  assert.equal(defs[0].uri, 'file:///net.ned');
});

test('iniParamDefinition jumps to the NED parameter declaration', async () => {
  const cache = await cacheWithLikeNed();
  const doc = parseIni('network = Net\n**.queue.capacity = 50\n');
  const defs = iniParamDefinition(doc, cache, doc.sections[0], '**.queue.capacity');
  assert.ok(defs.length >= 1, 'found a declaration');
  assert.equal(defs[0].uri, 'file:///net.ned');
  // Queue.capacity is declared on the `Queue` simple module
  assert.ok(defs[0].range.start.line >= 0);
});

const TWIN_NED = `
moduleinterface IApp { }
moduleinterface IOther { }
simple Twin like IApp { }
module Host { submodules: app: <> like IApp; }
network TNet { submodules: host[2]: Host; o: <> like IOther; }
`;
const TWIN_OTHER_NED = `package other;
import IOther;
simple Twin like IOther { }
`;
const TWIN_INI = `
[Config T]
network = TNet
**.host[*].app.typename = "Twin"
**.o.typename = "Twin"
**.nowhere.typename = "Twin"
`;

async function makeTwinCtx() {
  const svc = await getParsers();
  const nedCache = new NedResourceCache();
  nedCache.addFile('file:///net.ned', svc.parse('ned', TWIN_NED), '');
  nedCache.addFile('file:///other.ned', svc.parse('ned', TWIN_OTHER_NED), 'other');
  const doc = parseIni(TWIN_INI);
  return { nedCache, doc };
}

function twinTargets(nedCache: NedResourceCache, doc: IniDocument, key: string): string[] {
  const ifaces = typenameSlotInterfaces(doc, nedCache, sec(doc, 'T'), key);
  return typenameTypeTargets(nedCache, '"Twin"', ifaces).map((l) => l.uri).sort();
}

test('typenameTypeTargets filters a simple name by the like interface of the targeted slot', async () => {
  const { nedCache, doc } = await makeTwinCtx();
  assert.deepEqual(twinTargets(nedCache, doc, '**.host[*].app.typename'), ['file:///net.ned']);
  assert.deepEqual(twinTargets(nedCache, doc, '**.o.typename'), ['file:///other.ned']);
});

test('typenameTypeTargets falls back to every module type with that name when the slot is unknown', async () => {
  const { nedCache, doc } = await makeTwinCtx();
  assert.deepEqual(twinTargets(nedCache, doc, '**.nowhere.typename'), ['file:///net.ned', 'file:///other.ned']);
});
