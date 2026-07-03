import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import {
  NedResourceCache,
  BUILTIN_URI,
  BUILTIN_NED_TEXT,
  ConfigRegistry,
  parseIni,
  effectiveParamModules,
  matchedParamModules,
  iniParamDiagnostics,
  type IniDocument,
  type IniSection,
  type IniEntry,
} from '../index';

// A network with four individually-named nodes, each holding an `mrp` submodule
// with a `role` string parameter.
const NED = `
simple Mrp { parameters: string role = default(""); }
module Sw { submodules: mrp: Mrp; }
network Net {
  submodules:
    node0: Sw; node1: Sw; node2: Sw; node3: Sw;
}
network Ring { submodules: node[4]: Sw; }
`;

const registry = new ConfigRegistry([
  { name: 'network', type: 'string', default: null, scope: 'per-run', description: '' },
]);

async function cache() {
  const svc = await getParsers();
  const c = new NedResourceCache();
  c.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  c.addFile('file:///net.ned', svc.parse('ned', NED), '');
  return c;
}

function sec(doc: IniDocument, name: string): IniSection {
  const s = name === 'General'
    ? doc.sections.find((x) => x.type === 'general')
    : doc.sections.find((x) => x.configName === name);
  assert.ok(s, `missing section ${name}`);
  return s!;
}
function entry(section: IniSection, key: string): IniEntry {
  const e = section.entries.find((x) => x.key === key);
  assert.ok(e, `missing entry ${key}`);
  return e!;
}
const nodes = (ms: { path: string }[]) =>
  ms.map((m) => m.path.replace(/^Net\.(node\d).*/, '$1')).sort();

test('a broader key does not claim a parameter an earlier, more specific key won', async () => {
  const c = await cache();
  const doc = parseIni('[Config C]\nnetwork = Net\n*.node0.mrp.role = "MIM"\n*.node*.mrp.role = "MIC"\n');
  const C = sec(doc, 'C');

  // the specific line wins node0
  assert.deepEqual(nodes(effectiveParamModules(doc, c, C, entry(C, '*.node0.mrp.role'), registry)), ['node0']);
  // the broad line wins node1..node3 — NOT node0 (shadowed by the earlier line)
  assert.deepEqual(nodes(effectiveParamModules(doc, c, C, entry(C, '*.node*.mrp.role'), registry)), ['node1', 'node2', 'node3']);
  // for contrast, raw matching (no precedence) still reports all four for the broad key
  assert.deepEqual(nodes(matchedParamModules(doc, c, C, '*.node*.mrp.role')), ['node0', 'node1', 'node2', 'node3']);
});

test('a `**` key wins only the parameters not already claimed by an earlier key', async () => {
  const c = await cache();
  const doc = parseIni('[Config C]\nnetwork = Net\n*.node0.mrp.role = "X"\n**.role = "Y"\n');
  const C = sec(doc, 'C');
  assert.deepEqual(nodes(effectiveParamModules(doc, c, C, entry(C, '**.role'), registry)), ['node1', 'node2', 'node3']);
});

test('precedence follows config inheritance: derived overrides base overrides [General]', async () => {
  const c = await cache();
  const doc = parseIni(
    '[General]\n**.role = "gen"\n' +
    '[Config Base]\nnetwork = Net\n*.node0.mrp.role = "base0"\n' +
    '[Config Derived]\nextends = Base\n*.node1.mrp.role = "der1"\n',
  );
  const gen = sec(doc, 'General');
  const base = sec(doc, 'Base');
  const derived = sec(doc, 'Derived');

  // In the Derived run: node0 stays with Base's key, node1 with Derived's key,
  // node2/node3 fall through to [General]'s `**.role`.
  assert.deepEqual(nodes(effectiveParamModules(doc, c, derived, entry(derived, '*.node1.mrp.role'), registry)), ['node1']);
  assert.deepEqual(nodes(effectiveParamModules(doc, c, derived, entry(base, '*.node0.mrp.role'), registry)), ['node0']);
  assert.deepEqual(nodes(effectiveParamModules(doc, c, derived, entry(gen, '**.role'), registry)), ['node2', 'node3']);
});

test('a concrete vector index does not shadow (nor get shadowed by a later) broad key', async () => {
  const c = await cache();
  // The module tree collapses node[4] into one `node[]` slot; `*.node[0]` covers only
  // one real element, so it must NOT eclipse the later `**.mrp.role` (OMNeT++: node[0]
  // gets MIM, node[1..3] get MIC). Both keys stay effective for the slot.
  const doc = parseIni('[Config R]\nnetwork = Ring\n*.node[0].mrp.role = "MIM"\n**.mrp.role = "MIC"\n');
  const R = sec(doc, 'R');
  assert.equal(effectiveParamModules(doc, c, R, entry(R, '*.node[0].mrp.role'), registry).length, 1);
  assert.equal(effectiveParamModules(doc, c, R, entry(R, '**.mrp.role'), registry).length, 1);
  // and no false "no effect" hint on either line
  assert.deepEqual(iniParamDiagnostics(doc, c, registry).filter((d) => d.code === 'shadowed-assignment'), []);
});

test('an earlier FULL-COVER key does shadow a later concrete-index key (dead assignment)', async () => {
  const c = await cache();
  // `**.mrp.role` first claims every element, so the later `*.node[0]` line is dead.
  const doc = parseIni('[Config R]\nnetwork = Ring\n**.mrp.role = "all"\n*.node[0].mrp.role = "spec"\n');
  const R = sec(doc, 'R');
  assert.equal(effectiveParamModules(doc, c, R, entry(R, '*.node[0].mrp.role'), registry).length, 0);
  assert.ok(iniParamDiagnostics(doc, c, registry).some((d) => d.code === 'shadowed-assignment'));
});

test('iniParamDiagnostics flags a fully-shadowed assignment and not a partially-winning one', async () => {
  const c = await cache();
  // `**.role` first claims everything, so the later `*.node0` line is entirely dead.
  const shadowed = iniParamDiagnostics(
    parseIni('[Config C]\nnetwork = Net\n**.role = "all"\n*.node0.mrp.role = "spec"\n'),
    c,
    registry,
  );
  assert.ok(shadowed.some((d) => d.code === 'shadowed-assignment'), JSON.stringify(shadowed));

  // node0-first / node*-second: the broad line still wins node1..node3 → not dead.
  const partial = iniParamDiagnostics(
    parseIni('[Config C]\nnetwork = Net\n*.node0.mrp.role = "MIM"\n*.node*.mrp.role = "MIC"\n'),
    c,
    registry,
  );
  assert.deepEqual(partial.filter((d) => d.code === 'shadowed-assignment'), [], JSON.stringify(partial));
});
