import { test } from 'bun:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { ConfigRegistry } from '../ini/configRegistry';
import { parseIni } from '../ini/iniDocument';
import { iniParamDiagnostics } from '../ini/iniParamChecks';
import { nedSemanticDiagnostics } from '../ned/nedSemanticChecks';
import { buildSuppressionIndex, applySuppressions } from '../diagnostics/suppress';
import type { Diagnostic } from '../model/location';

const reg = new ConfigRegistry(
  JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'resources', 'config', 'opp-config-options.json'), 'utf8')).options,
);

const LIB = `package lib;
moduleinterface IApp { }
moduleinterface IOther { }
simple AppA like IApp { }
simple OtherA like IOther { }
channel Chan { }`;

const CODES = ['unknown-typename', 'typename-interface-mismatch'];
const typeStringDiags = (diags: Diagnostic[]) => diags.filter((d) => CODES.includes(String(d.code)));

async function nedDiags(text: string) {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  cache.addFile('file:///lib.ned', svc.parse('ned', LIB), 'lib');
  const tree = svc.parse('ned', text);
  cache.addFile('file:///h.ned', tree, 'app');
  return { diags: typeStringDiags(nedSemanticDiagnostics(cache, 'file:///h.ned')), tree, cache };
}

test('NED: a type string naming no type is flagged', async () => {
  const T = `package app;
module Host {
  parameters:
    a.typename = default("Nope");
  submodules:
    a: <> like lib.IApp;
    b: <default("lib.Missing")> like lib.IApp;
}`;
  const { diags } = await nedDiags(T);
  assert.deepEqual(diags.map((d) => [d.code, d.range.start.line]), [
    ['unknown-typename', 3],
    ['unknown-typename', 6],
  ]);
  assert.ok(diags.every((d) => d.severity === 2), 'warnings');
  assert.match(diags[0].message, /Nope/);
});

test('NED: a type string whose types do not implement the slot interface is flagged', async () => {
  const T = `package app;
module Host {
  parameters:
    a.typename = "OtherA";
  submodules:
    a: <> like lib.IApp;
    b: <"lib.OtherA"> like lib.IApp;
}`;
  const { diags } = await nedDiags(T);
  assert.deepEqual(diags.map((d) => [d.code, d.range.start.line]), [
    ['typename-interface-mismatch', 3],
    ['typename-interface-mismatch', 6],
  ]);
  assert.match(diags[0].message, /IApp/);
});

test('NED: valid strings, unknown slots, and non-type strings are not flagged', async () => {
  const T = `package app;
module Host {
  parameters:
    string s = "Nope";
    **.typename = "AppA";
    c.typename = "Chan";
  submodules:
    a: <default("AppA")> like lib.IApp;
    b: <"lib.AppA"> like lib.IApp;
    c: <> like IUnknownIface;
}`;
  const { diags } = await nedDiags(T);
  assert.deepEqual(diags, []);
});

test('NED: the warnings can be suppressed', async () => {
  const T = `package app;
module Host {
  submodules:
    a: <"Nope"> like lib.IApp; //# suppress(unknown-typename)
}`;
  const { diags, tree } = await nedDiags(T);
  assert.equal(diags.length, 1);
  const idx = buildSuppressionIndex({ language: 'ned', text: T, tree });
  assert.deepEqual(applySuppressions(diags, idx), []);
});

const INI_NED = `package app;
import lib.IApp;
module Host { submodules: app: <> like IApp; }
network Net { submodules: h: Host; }`;

async function iniDiags(ini: string) {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  cache.addFile('file:///lib.ned', svc.parse('ned', LIB), 'lib');
  cache.addFile('file:///net.ned', svc.parse('ned', INI_NED), 'app');
  return typeStringDiags(iniParamDiagnostics(parseIni(ini), cache, reg));
}

test('INI: unknown and interface-mismatching typename values are flagged', async () => {
  const diags = await iniDiags(`[General]
network = app.Net
*.h.app.typename = "Nope"
[Config B]
network = app.Net
*.h.app.typename = "OtherA"
[Config C]
network = app.Net
*.h.app.typename = "AppA"
**.channel.typename = "Chan"
**.nowhere.typename = "\${t}"
`);
  assert.deepEqual(diags.map((d) => [d.code, d.range.start.line]), [
    ['unknown-typename', 2],
    ['typename-interface-mismatch', 5],
  ]);
});

test('INI: typename values are checked for unknown names also without a network', async () => {
  const diags = await iniDiags(`[General]
**.app.typename = "Nope"
**.app2.typename = "AppA"
`);
  assert.deepEqual(diags.map((d) => [d.code, d.range.start.line]), [['unknown-typename', 1]]);
});

test('NED: comparison operands and firstAvailable arguments are not flagged', async () => {
  const T = `package app;
module Host {
  parameters:
    string r;
    a.typename = default(r == "unitDisk" ? "AppA" : "");
  submodules:
    a: <> like lib.IApp;
    b: <default(firstAvailable("Missing", "AppA"))> like lib.IApp;
    c: <default(r != "scalar" ? "AppA" : "Nope")> like lib.IApp;
}`;
  const { diags } = await nedDiags(T);
  assert.deepEqual(diags.map((d) => d.message), ["Unknown type 'Nope'"]);
});
