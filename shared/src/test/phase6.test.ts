import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigRegistry } from '../ini/configRegistry';
import { classifyKey, iniConfigDiagnostics } from '../ini/iniConfigChecks';
import { iniHover, iniCompletion } from '../ini/iniNavigation';
import { parseIni } from '../ini/iniDocument';

const registryJson = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'resources', 'config', 'opp-config-options.json'), 'utf8'),
);
const reg = new ConfigRegistry(registryJson.options);

test('registry resolves exact and %-pattern names', () => {
  assert.ok(reg.get('network'));
  assert.ok(reg.get('sim-time-limit'));
  assert.ok(reg.get('seed-0-mt'), 'seed-0-mt matches seed-%-mt');
  assert.ok(!reg.get('totally-made-up-option'));
});

test('classifyKey distinguishes config vs param assignment', () => {
  assert.equal(classifyKey(reg, 'network').kind, 'config');
  assert.equal(classifyKey(reg, 'extends').kind, 'directive');
  assert.equal(classifyKey(reg, 'no-such-option').kind, 'unknown-config');
  assert.equal(classifyKey(reg, '**.app.typename').kind, 'config'); // per-object
  assert.equal(classifyKey(reg, '**.host.queueLength').kind, 'param-assignment');
});

test('config diagnostics: unknown option and value-type', () => {
  const doc = parseIni(`network = Foo
made-up-option = 1
parallel-simulation = 7
sim-time-limit = "not a number"`);
  const diags = iniConfigDiagnostics(doc, reg);
  const msgs = diags.map((d) => `${d.code}:${d.message}`);
  assert.ok(msgs.some((m) => /unknown-config.*made-up-option/.test(m)));
  assert.ok(msgs.some((m) => /config-value-type.*parallel-simulation/.test(m)));
  assert.ok(msgs.some((m) => /config-value-type.*sim-time-limit/.test(m)));
});

test('config diagnostics: valid file is clean', () => {
  const doc = parseIni(`[General]
network = Foo
sim-time-limit = 100s
parallel-simulation = true
**.app.typename = "X"`);
  assert.deepEqual(iniConfigDiagnostics(doc, reg), []);
});

test('ini hover on config key', () => {
  const doc = parseIni('sim-time-limit = 10s');
  const hov = iniHover(doc, reg, { line: 0, character: 3 });
  assert.ok(hov);
  assert.match(hov!.markdown, /sim-time-limit/);
});

test('ini completion offers config options at key position', () => {
  const items = iniCompletion(doc(), reg, undefined, { line: 1, character: 0 }, '');
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes('network'));
  assert.ok(labels.includes('extends'));
  function doc() {
    return parseIni('[General]\n');
  }
});
