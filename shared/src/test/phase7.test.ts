import { test } from 'node:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { ConfigRegistry } from '../ini/configRegistry';
import { parseIni } from '../ini/iniDocument';
import {
  iniParamDiagnostics,
  iniKeyToRegex,
  effectiveNetwork,
  reachableParamPaths,
  iniParamDefinition,
} from '../ini/iniParamResolution';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const reg = new ConfigRegistry(
  JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'resources', 'config', 'opp-config-options.json'), 'utf8')).options,
);

const NED = `
moduleinterface IApp { parameters: int dummy; }
simple Queue { parameters: int capacity = 10; double rate @unit(bps); }
simple ConcreteApp like IApp { parameters: int dummy; string addr; }
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

test('iniParamDefinition jumps to the NED parameter declaration', async () => {
  const cache = await cacheWith(NED);
  const doc = parseIni('network = Net\n**.queue.capacity = 50\n');
  const defs = iniParamDefinition(doc, cache, doc.sections[0], '**.queue.capacity');
  assert.ok(defs.length >= 1, 'found a declaration');
  assert.equal(defs[0].uri, 'file:///net.ned');
  // Queue.capacity is declared on the `Queue` simple module
  assert.ok(defs[0].range.start.line >= 0);
});

test('reachableParamPaths includes nested params', async () => {
  const cache = await cacheWith(NED);
  const doc = parseIni('network = Net\n');
  const paths = reachableParamPaths(doc, cache, doc.sections[0]).map((p) => p.path);
  assert.ok(paths.includes('Net.numHosts'));
  assert.ok(paths.includes('Net.queue.capacity'));
});
