import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { NedResourceCache } from '../ned/nedResourceCache';
import { ConfigRegistry } from '../ini/configRegistry';
import { parseIni } from '../ini/iniDocument';
import { iniKeyToRegex, normIndices } from '../ini/keyMatch';
import { iniParamDiagnostics } from '../ini/iniParamChecks';

// ---- iniKeyToRegex: OMNeT++ brace patterns ({set} and {num..num}) ----

const yes = (key: string, path: string) =>
  assert.equal(iniKeyToRegex(key).test(path), true, `expected match: ${key} ~ ${path}`);
const no = (key: string, path: string) =>
  assert.equal(iniKeyToRegex(key).test(path), false, `expected NO match: ${key} ~ ${path}`);

test('{a,b} is a character set (matches one enumerated char)', () => {
  // `node{3,5}` matches node3 / node5 (and the literal comma), not node4 or node35
  yes('*.node{3,5}.mrp.mrpRole', 'Mrp8.node3.mrp.mrpRole');
  yes('*.node{3,5}.mrp.mrpRole', 'Mrp8.node5.mrp.mrpRole');
  no('*.node{3,5}.mrp.mrpRole', 'Mrp8.node4.mrp.mrpRole');
  no('*.node{3,5}.mrp.mrpRole', 'Mrp8.node35.mrp.mrpRole');
  for (const n of [0, 2, 4, 6]) yes('*.node{0,2,4,6}.mrp', `Mrp8.node${n}.mrp`);
  for (const n of [1, 3, 5, 7]) no('*.node{0,2,4,6}.mrp', `Mrp8.node${n}.mrp`);
});

test('{a-z} character ranges and {^..} negation', () => {
  yes('h.eth{a-c}', 'h.ethb');
  no('h.eth{a-c}', 'h.ethd');
  yes('h.p{^0-9}', 'h.px');
  no('h.p{^0-9}', 'h.p5');
});

test('{lo..up} is a numeric range on the digit run', () => {
  for (const n of [0, 1, 2, 3]) yes('*.node{0..3}.mrp', `Mrp8.node${n}.mrp`);
  for (const n of [4, 5, 10]) no('*.node{0..3}.mrp', `Mrp8.node${n}.mrp`);
  for (const n of [4, 5, 6, 7]) yes('*.node{4..7}.mrp', `Mrp8.node${n}.mrp`);
  for (const n of [3, 8]) no('*.node{4..7}.mrp', `Mrp8.node${n}.mrp`);
  // multi-length range
  for (const n of [10, 55, 100, 255]) yes('h.a{10..255}', `h.a${n}`);
  for (const n of [9, 256, 300]) no('h.a{10..255}', `h.a${n}`);
  // open-ended bounds
  yes('h.a{10..}', 'h.a999');
  no('h.a{10..}', 'h.a9');
  yes('h.a{..5}', 'h.a3');
  no('h.a{..5}', 'h.a6');
  yes('h.a{..}', 'h.a42');
  // leading zeros compare by value (atol), as in OMNeT++
  yes('h.a{0..3}', 'h.a03');
});

test('a numeric range consumes the whole digit run (OMNeT++ atol semantics)', () => {
  // OMNeT++'s NUMRANGE greedily eats every consecutive digit, then value-checks — so an
  // adjacent digit-matching element cannot steal trailing digits.
  no('{..3}?', '03');       // {..3} eats "03"=3, leaving nothing for '?'
  no('{0..3}{0..3}', '03'); // first range eats "03"; second gets no digits
  no('{0..9}{0..9}', '05'); // adjacent ranges are unusable: the first eats both digits
  no('2{..3}{..3}', '222'); // '2' then a range that eats "22"=22 (>3)
  yes('{0..3}.x', '3.x');   // followed by a non-digit: fine
  yes('{0..3}?', '3x');     // '?' matches the non-digit 'x' after the maximal run "3"
  yes('a{10..25}b', 'a12b');
  no('a{10..25}b', 'a123b'); // "123">25
});

test('backslash escapes the next character (literal), as in OMNeT++', () => {
  yes('a\\*b', 'a*b'); no('a\\*b', 'axb');
  yes('a\\{b', 'a{b');
  yes('a\\.b', 'a.b'); no('a\\.b', 'axb');
  yes('a\\?b', 'a?b'); no('a\\?b', 'axb');
  yes('x\\\\y', 'x\\y');
});

test('a reversed character range matches nothing (never throws)', () => {
  // OMNeT++ accepts {9-0}; isInSet is never true, so it matches nothing. Must not throw.
  assert.doesNotThrow(() => iniKeyToRegex('h.{9-0}'));
  no('h.{9-0}', 'h.5');
  no('h.a{z-a}b', 'h.axb');
  // a mixed set keeps its valid members
  yes('h.{9-0a-c}', 'h.b');
  no('h.{9-0a-c}', 'h.5');
});

test('brace forms compose with the other wildcards and do not disturb them', () => {
  yes('*.node0.mrp.mrpRole', 'Mrp8.node0.mrp.mrpRole');
  yes('**.mrp.mrpRole', 'Mrp8.node3.mrp.mrpRole');
  yes('*.host[*].app', 'Net.host[].app'); // callers normalize indices to [] on both sides
  no('*.node{3,5}.x', 'Mrp8.sub.node3.x'); // '*' does not cross a dot
});

test('vector index VALUES are normalized away (intentional divergence from OMNeT++)', () => {
  // normIndices collapses every [i] to [], on both the key and the instance path, so the
  // plugin matches a vector slot regardless of the concrete index. OMNeT++ matches indices
  // precisely (`host[0]` != `host[5]`, and `host[0..3]` excludes `host[5]`); the plugin is
  // deliberately index-insensitive because the module tree represents a vector as one slot.
  assert.equal(normIndices('*.host[0].app'), '*.host[].app');
  yes(normIndices('*.host[0].app'), normIndices('Net.host[5].app'));   // OMNeT++: no
  yes(normIndices('*.host[0..3].app'), normIndices('Net.host[9].app')); // OMNeT++: no
});

// ---- end-to-end: the mrp-style keys resolve against the module tree ----

const NED = `
simple Mrp { parameters: string mrpRole = default(""); }
module Sw { submodules: mrp: Mrp; }
network Net {
  submodules:
    node0: Sw; node1: Sw; node2: Sw; node3: Sw;
    node4: Sw; node5: Sw; node6: Sw; node7: Sw;
}
`;

async function cache() {
  const svc = await getParsers();
  const c = new NedResourceCache();
  c.addFile('file:///net.ned', svc.parse('ned', NED), '');
  return c;
}

const registry = new ConfigRegistry([
  { name: 'network', type: 'string', default: null, scope: 'per-run', description: '' },
]);

test('a {set} node key resolves (no "no-matching-param")', async () => {
  const c = await cache();
  const ini = parseIni('[General]\nnetwork = Net\n*.node{3,5}.mrp.mrpRole = "MRM"\n');
  const diags = iniParamDiagnostics(ini, c, registry);
  assert.deepEqual(diags.filter((d) => d.code === 'no-matching-param'), [], JSON.stringify(diags));
});

test('a {lo..up} node key resolves (no "no-matching-param")', async () => {
  const c = await cache();
  const ini = parseIni('[General]\nnetwork = Net\n*.node{0..3}.mrp.mrpRole = "MRC"\n');
  const diags = iniParamDiagnostics(ini, c, registry);
  assert.deepEqual(diags.filter((d) => d.code === 'no-matching-param'), [], JSON.stringify(diags));
});

test('a brace key resolves the module, so a bogus leaf on it is flagged', async () => {
  const c = await cache();
  // {3,5} matches node3.mrp / node5.mrp; `bogus` is not a param of Mrp -> flagged
  const ini = parseIni('[General]\nnetwork = Net\n*.node{3,5}.mrp.bogus = 1\n');
  const diags = iniParamDiagnostics(ini, c, registry);
  assert.ok(diags.some((d) => d.code === 'no-matching-param'), JSON.stringify(diags));
});
