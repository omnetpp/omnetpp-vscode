import { test } from 'node:test';
import assert from 'node:assert';
import { parseIni, configSummaries } from '../ini/iniDocument';

test('configSummaries: lists named configs, skips [General]', () => {
  const doc = parseIni('[General]\nnetwork = Net\n[Config Foo]\n[Config Bar]\n');
  const cfgs = configSummaries(doc);
  assert.deepEqual(
    cfgs.map((c) => c.name),
    ['Foo', 'Bar'],
  );
});

test('configSummaries: bare [Name] section (Config prefix optional)', () => {
  const doc = parseIni('[General]\n[PureAloha1]\niaTime = 2s\n');
  const cfgs = configSummaries(doc);
  assert.equal(cfgs.length, 1);
  assert.equal(cfgs[0].name, 'PureAloha1');
  assert.equal(cfgs[0].rawName, 'PureAloha1');
});

test('configSummaries: abstract flag reflects only the section own entry (not inherited)', () => {
  const doc = parseIni(
    '[Config Base]\nabstract = true\n[Config Derived]\nextends = Base\nnetwork = Net\n',
  );
  const cfgs = configSummaries(doc);
  const base = cfgs.find((c) => c.name === 'Base')!;
  const derived = cfgs.find((c) => c.name === 'Derived')!;
  assert.equal(base.abstract, true);
  assert.equal(derived.abstract, false); // abstract is not inherited from Base
  assert.deepEqual(derived.extends, ['Base']);
});

test('configSummaries: captures description and header range', () => {
  const doc = parseIni('[Config Foo]\ndescription = "the foo run"\n');
  const cfgs = configSummaries(doc);
  assert.equal(cfgs[0].description, '"the foo run"');
  assert.equal(cfgs[0].range.start.line, 0);
});

test('configSummaries: abstract accepts true/1/yes, rejects false', () => {
  const mk = (v: string) => configSummaries(parseIni(`[Config A]\nabstract = ${v}\n`))[0].abstract;
  assert.equal(mk('true'), true);
  assert.equal(mk('1'), true);
  assert.equal(mk('yes'), true);
  assert.equal(mk('false'), false);
  assert.equal(mk('0'), false);
});
