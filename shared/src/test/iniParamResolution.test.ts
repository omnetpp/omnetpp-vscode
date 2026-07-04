import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { ConfigRegistry } from '../ini/configRegistry';
import { parseIni } from '../ini/iniDocument';
import { iniParamDiagnostics } from '../ini/iniParamChecks';
import { iniKeyToRegex, effectiveNetwork } from '../ini/iniParamResolution';
import { reachableParamPaths } from '../ini/iniParamCompletion';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const reg = new ConfigRegistry(
  JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'resources', 'config', 'opp-config-options.json'), 'utf8')).options,
);

const NED = `
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

async function cacheWith(ned: string) {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  cache.addFile('file:///net.ned', svc.parse('ned', ned), '');
  return cache;
}

test('iniKeyToRegex wildcard semantics', () => {
  assert.ok(iniKeyToRegex('**.capacity').test('Net.queue.capacity'));
  assert.ok(iniKeyToRegex('*.queue.capacity').test('Net.queue.capacity'));
  assert.ok(!iniKeyToRegex('*.capacity').test('Net.queue.capacity')); // * is single-level
  assert.ok(iniKeyToRegex('Net.host[*].dummy').test('Net.host[].dummy'));
});

test('matched param: clean; type mismatch flagged', async () => {
  const cache = await cacheWith(NED);
  const doc = parseIni(`network = Net
**.queue.capacity = 50
Net.queue.rate = "fast"`);
  const diags = iniParamDiagnostics(doc, cache, reg);
  const msgs = diags.map((d) => `${d.code}:${d.message}`);
  // capacity=50 ok; rate="fast" is string to double param -> error
  assert.equal(diags.length, 1, JSON.stringify(msgs));
  assert.match(msgs[0], /param-value-type/);
});

test('no-matching-param flagged for known module, missing leaf', async () => {
  const cache = await cacheWith(NED);
  const doc = parseIni(`network = Net
*.queue.nonexistent = 5`);
  const diags = iniParamDiagnostics(doc, cache, reg);
  assert.ok(diags.some((d) => d.code === 'no-matching-param'), JSON.stringify(diags));
});

test('like submodule subtree does not produce false no-match', async () => {
  const cache = await cacheWith(NED);
  // host is `like IApp`; addr exists only on ConcreteApp -> open subtree, no warning
  const doc = parseIni(`network = Net
*.host[*].addr = "x"`);
  const diags = iniParamDiagnostics(doc, cache, reg);
  assert.deepEqual(diags.filter((d) => d.code === 'no-matching-param'), []);
});

test('index-specific like typenames: param on any candidate type is not flagged', async () => {
  const cache = await cacheWith(NED);
  // host[0] is SinkApp (no `addr`), the rest are ConcreteApp (has `addr`). Because
  // vector indices normalize to [], both bindings match the same slot -> the union
  // of their params must be considered, so `addr` matches ConcreteApp and is clean.
  const doc = parseIni(`network = Net
*.host[0].typename = "SinkApp"
*.host[*].typename = "ConcreteApp"
*.host[*].addr = "x"`);
  const diags = iniParamDiagnostics(doc, cache, reg);
  assert.deepEqual(diags.filter((d) => d.code === 'no-matching-param'), [], JSON.stringify(diags));
});

test('index-specific like typenames: param on NO candidate type is still flagged', async () => {
  const cache = await cacheWith(NED);
  const doc = parseIni(`network = Net
*.host[0].typename = "SinkApp"
*.host[*].typename = "ConcreteApp"
*.host[*].bogusPort = 1`);
  const diags = iniParamDiagnostics(doc, cache, reg);
  assert.ok(diags.some((d) => d.code === 'no-matching-param'), JSON.stringify(diags));
});

test('deep wildcard never flagged (dynamic-safe)', async () => {
  const cache = await cacheWith(NED);
  const doc = parseIni(`network = Net
**.totallyMadeUp = 5`);
  const diags = iniParamDiagnostics(doc, cache, reg);
  assert.deepEqual(diags.filter((d) => d.code === 'no-matching-param'), []);
});

test('effectiveNetwork resolves through extends and General', () => {
  const doc = parseIni(`[General]
network = Net
[Config A]
[Config B]
extends = A`);
  const b = doc.sections.find((s) => s.configName === 'B')!;
  assert.equal(effectiveNetwork(doc, b), 'Net');
});

test('reachableParamPaths includes nested params', async () => {
  const cache = await cacheWith(NED);
  const doc = parseIni('network = Net\n');
  const paths = reachableParamPaths(doc, cache, doc.sections[0]).map((p) => p.path);
  assert.ok(paths.includes('Net.numHosts'));
  assert.ok(paths.includes('Net.queue.capacity'));
});

// A `like` submodule that names its concrete type inline in the NED `<...>` slot
// (the fixed `<"X">` form or the default `<default("X")>` form) must be expanded
// to that type when no INI `typename` override is present — mirroring how INET
// wires e.g. `ipv4: <default("Ipv4NetworkLayer")> like INetworkLayer`, so that a
// deep key like `*.A1.ipv4.routingTable.routerId` resolves.
const DFLT_NED = `
moduleinterface INet2 { parameters: int dummy; }
simple RTable2 { parameters: string routerId = default("auto"); }
module DfltLayer like INet2 { parameters: int dummy; submodules: routingTable: RTable2; }
module FixedLayer like INet2 { parameters: int dummy; submodules: routingTable: RTable2; }
module Router2 {
  submodules:
    ipv4: <default("DfltLayer")> like INet2;
    ip6: <"FixedLayer"> like INet2;
    open: <> like INet2;
}
network RouterNet { submodules: A1: Router2; }`;

test('like default type: deep param through <default("X")> resolves and is reachable', async () => {
  const cache = await cacheWith(DFLT_NED);
  const doc = parseIni('network = RouterNet\n*.A1.ipv4.routingTable.routerId = "1.2.3.4"\n');
  const diags = iniParamDiagnostics(doc, cache, reg);
  // routerId is a real param on the default type's nested routingTable -> clean
  assert.deepEqual(diags.filter((d) => d.code === 'no-matching-param'), [], JSON.stringify(diags));
  const paths = reachableParamPaths(doc, cache, doc.sections[0]).map((p) => p.path);
  assert.ok(paths.includes('RouterNet.A1.ipv4.routingTable.routerId'), JSON.stringify(paths));
});

test('like default type: <default("X")> subtree is fully known -> typo is flagged', async () => {
  const cache = await cacheWith(DFLT_NED);
  const doc = parseIni('network = RouterNet\n*.A1.ipv4.routingTable.bogusId = "x"\n');
  const diags = iniParamDiagnostics(doc, cache, reg);
  // discriminating case: only fires if the default type was expanded as non-open
  assert.ok(diags.some((d) => d.code === 'no-matching-param'), JSON.stringify(diags));
});

test('like default type: fixed <"X"> form behaves the same', async () => {
  const cache = await cacheWith(DFLT_NED);
  const clean = iniParamDiagnostics(parseIni('network = RouterNet\n*.A1.ip6.routingTable.routerId = "1.2.3.4"\n'), cache, reg);
  assert.deepEqual(clean.filter((d) => d.code === 'no-matching-param'), [], JSON.stringify(clean));
  const flagged = iniParamDiagnostics(parseIni('network = RouterNet\n*.A1.ip6.routingTable.bogusId = "x"\n'), cache, reg);
  assert.ok(flagged.some((d) => d.code === 'no-matching-param'), JSON.stringify(flagged));
});

test('like with no inline type (`<>`) stays open -> deep key not falsely flagged', async () => {
  const cache = await cacheWith(DFLT_NED);
  const doc = parseIni('network = RouterNet\n*.A1.open.routingTable.routerId = "x"\n');
  const diags = iniParamDiagnostics(doc, cache, reg);
  assert.deepEqual(diags.filter((d) => d.code === 'no-matching-param'), [], JSON.stringify(diags));
});

test('like default type: an INI typename override still wins over the NED default', async () => {
  const cache = await cacheWith(DFLT_NED);
  // override ipv4 to FixedLayer; its routingTable.routerId must still resolve
  const doc = parseIni('network = RouterNet\n*.A1.ipv4.typename = "FixedLayer"\n*.A1.ipv4.routingTable.routerId = "1.2.3.4"\n');
  const diags = iniParamDiagnostics(doc, cache, reg);
  assert.deepEqual(diags.filter((d) => d.code === 'no-matching-param'), [], JSON.stringify(diags));
});
