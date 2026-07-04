import { test } from 'bun:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { ConfigRegistry } from '../ini/configRegistry';
import { parseIni } from '../ini/iniDocument';
import { iniParamDiagnostics } from '../ini/iniParamChecks';
import { reachableParamPaths } from '../ini/iniParamCompletion';
import { nedSemanticDiagnostics } from '../ned/nedSemanticChecks';

const reg = new ConfigRegistry(
  JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'resources', 'config', 'opp-config-options.json'), 'utf8')).options,
);

// A `like IRadio` interface with two implementers carrying disjoint params: freq
// (ApskRadio) vs gain (UnitRadio). The concrete type chosen for a `radio` slot is
// observable through which of these params resolves vs. is flagged `no-matching-param`.
const NED = `
package t;
moduleinterface IRadio { parameters: int dummy; }
simple ApskRadio like IRadio { parameters: int dummy; int freq = default(1); }
simple UnitRadio like IRadio { parameters: int dummy; int gain = default(2); }
module WirelessIf { submodules: radio: <> like IRadio; }
module BMacIf extends WirelessIf { parameters: radio.typename = default("ApskRadio"); }
module FixedNedIf extends WirelessIf { parameters: radio.typename = "UnitRadio"; }
module DfltBracketIf { submodules: radio: <default("ApskRadio")> like IRadio; }
module FixedBracketIf { submodules: radio: <"UnitRadio"> like IRadio; }
network NetB { submodules: h: BMacIf; }
network NetFN { submodules: h: FixedNedIf; }
network NetD { submodules: h: DfltBracketIf; }
network NetFB { submodules: h: FixedBracketIf; }`;

async function cacheWith(ned: string) {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  cache.addFile('file:///net.ned', svc.parse('ned', ned), 't');
  return cache;
}

const noMatch = (ini: string, cache: NedResourceCache) =>
  iniParamDiagnostics(parseIni(ini), cache, reg).filter((d) => d.code === 'no-matching-param');

test('NED default typename (inherited) resolves the like slot', async () => {
  const cache = await cacheWith(NED);
  // BMacIf inherits `radio` from WirelessIf and sets `radio.typename = default("ApskRadio")`.
  const paths = reachableParamPaths(parseIni('network = t.NetB\n'), cache, parseIni('network = t.NetB\n').sections[0]).map((p) => p.path);
  assert.ok(paths.includes('NetB.h.radio.freq'), JSON.stringify(paths.filter((p) => p.includes('radio'))));
  assert.deepEqual(noMatch('network = t.NetB\n*.h.radio.freq = 5\n', cache), []);
  // gain belongs to UnitRadio, not the resolved ApskRadio -> flagged
  assert.ok(noMatch('network = t.NetB\n*.h.radio.gain = 5\n', cache).length > 0);
});

test('INI typename overrides a NED default assignment', async () => {
  const cache = await cacheWith(NED);
  const ini = 'network = t.NetB\n*.h.radio.typename = "UnitRadio"\n';
  assert.deepEqual(noMatch(ini + '*.h.radio.gain = 5\n', cache), []);       // now UnitRadio
  assert.ok(noMatch(ini + '*.h.radio.freq = 5\n', cache).length > 0);       // ApskRadio's freq gone
});

test('a NED fixed (non-default) typename assignment beats INI', async () => {
  const cache = await cacheWith(NED);
  // FixedNedIf sets `radio.typename = "UnitRadio"` (fixed) — INI cannot override it.
  const ini = 'network = t.NetFN\n*.h.radio.typename = "ApskRadio"\n';
  assert.deepEqual(noMatch(ini + '*.h.radio.gain = 5\n', cache), []);       // stays UnitRadio
  assert.ok(noMatch(ini + '*.h.radio.freq = 5\n', cache).length > 0);
});

test('a fixed <"X"> bracket beats INI', async () => {
  const cache = await cacheWith(NED);
  const ini = 'network = t.NetFB\n*.h.radio.typename = "ApskRadio"\n';
  assert.deepEqual(noMatch(ini + '*.h.radio.gain = 5\n', cache), []);       // stays UnitRadio
  assert.ok(noMatch(ini + '*.h.radio.freq = 5\n', cache).length > 0);
});

test('a <default("X")> bracket is used absent INI, but overridden by INI', async () => {
  const cache = await cacheWith(NED);
  // no INI typename -> ApskRadio (freq)
  assert.deepEqual(noMatch('network = t.NetD\n*.h.radio.freq = 5\n', cache), []);
  // INI typename -> UnitRadio (gain)
  const ini = 'network = t.NetD\n*.h.radio.typename = "UnitRadio"\n';
  assert.deepEqual(noMatch(ini + '*.h.radio.gain = 5\n', cache), []);
  assert.ok(noMatch(ini + '*.h.radio.freq = 5\n', cache).length > 0);
});

// --- ambiguity -----------------------------------------------------------------

async function ambiguityCache() {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  cache.addFile('file:///c.ned', svc.parse('ned', 'package c;\nmoduleinterface IR { parameters: int dummy; }'), 'c');
  cache.addFile('file:///p1.ned', svc.parse('ned', 'package p1;\nimport c.IR;\nsimple Dup like IR { parameters: int dummy; }'), 'p1');
  cache.addFile('file:///p2.ned', svc.parse('ned', 'package p2;\nimport c.IR;\nsimple Dup like IR { parameters: int dummy; }'), 'p2');
  cache.addFile('file:///net.ned', svc.parse('ned', 'package n;\nimport c.IR;\nmodule Host { submodules: r: <> like IR; }\nnetwork NetA { submodules: h: Host; }'), 'n');
  cache.addFile('file:///nb.ned', svc.parse('ned', 'package nb;\nimport c.IR;\nmodule HostB { submodules: r: <"Dup"> like IR; }'), 'nb');
  return cache;
}

test('INI typename matching >1 implementers is flagged ambiguous (and left unresolved)', async () => {
  const cache = await ambiguityCache();
  const diags = iniParamDiagnostics(parseIni('network = n.NetA\n*.h.r.typename = "Dup"\n'), cache, reg);
  assert.ok(diags.some((d) => d.code === 'ambiguous-typename'), JSON.stringify(diags));
});

test('NED fixed bracket matching >1 implementers is flagged ambiguous', async () => {
  const cache = await ambiguityCache();
  const diags = nedSemanticDiagnostics(cache, 'file:///nb.ned');
  assert.ok(diags.some((d) => d.code === 'ambiguous-typename'), JSON.stringify(diags));
});

test('fully-qualified typename disambiguates (no ambiguity warning)', async () => {
  const cache = await ambiguityCache();
  const diags = iniParamDiagnostics(parseIni('network = n.NetA\n*.h.r.typename = "p1.Dup"\n'), cache, reg);
  assert.deepEqual(diags.filter((d) => d.code === 'ambiguous-typename'), []);
});
