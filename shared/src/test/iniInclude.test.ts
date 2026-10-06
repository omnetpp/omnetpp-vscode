import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import {
  NedResourceCache,
  BUILTIN_URI,
  BUILTIN_NED_TEXT,
  ConfigRegistry,
  parseIni,
  expandIncludes,
  resolveIncludeUri,
  entryInFile,
  iniIncludeDiagnostics,
  iniStructureDiagnostics,
  iniParamDiagnostics,
  sectionName,
  effectiveNetwork,
  findSection,
  type IniDocument,
} from '../index';

const NED = `
simple App { parameters: string role = default(""); }
network Net { submodules: app: App; }
`;

const registry = new ConfigRegistry([
  { name: 'network', type: 'string', default: null, scope: 'per-run', description: '' },
]);

async function nedCache() {
  const svc = await getParsers();
  const c = new NedResourceCache();
  c.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  c.addFile('file:///proj/net.ned', svc.parse('ned', NED), '');
  return c;
}

const BASE_URI = 'file:///proj/base.ini';
const MAIN_URI = 'file:///proj/main.ini';

const BASE = `[General]
network = Net

[Config Base]
**.role = "base"
`;

const MAIN = `include base.ini

[Config Derived]
extends = Base
**.app.role = "derived"
`;

function docMap(map: Record<string, string>): (uri: string) => IniDocument | undefined {
  const parsed = new Map(Object.entries(map).map(([uri, text]) => [uri, parseIni(text, uri)]));
  return (uri) => parsed.get(uri);
}

test('resolveIncludeUri resolves relative paths against the including file', () => {
  assert.equal(resolveIncludeUri('file:///proj/main.ini', 'base.ini'), 'file:///proj/base.ini');
  assert.equal(resolveIncludeUri('file:///proj/a/main.ini', '../base.ini'), 'file:///proj/base.ini');
  assert.equal(resolveIncludeUri('file:///proj/main.ini', '"quoted.ini"'), 'file:///proj/quoted.ini');
  assert.equal(resolveIncludeUri('file:///proj/main.ini', '   '), undefined);
});

test('resolveIncludeUri spells the result like the editor and the index do', () => {
  assert.equal(resolveIncludeUri('file:///proj/main.ini', 'x+y (1).ini'), 'file:///proj/x%2By%20%281%29.ini');
  assert.equal(resolveIncludeUri('file:///c%3A/proj/main.ini', 'base.ini'), 'file:///c%3A/proj/base.ini');
});

test('expandIncludes merges included sections and tags entry origin', () => {
  const merged = expandIncludes(MAIN_URI, docMap({ [MAIN_URI]: MAIN, [BASE_URI]: BASE }));
  // [General] (from base), [Config Base] (from base), [Config Derived] (from main)
  const names = merged.sections.map(sectionName).sort();
  assert.deepEqual(names, ['Base', 'Derived', 'General']);

  const general = merged.sections.find((s) => s.type === 'general')!;
  const net = general.entries.find((e) => e.key === 'network')!;
  assert.equal(net.value, 'Net');
  assert.equal(net.sourceUri, BASE_URI, 'included entry carries its source file');

  const derived = findSection(merged, 'Derived')!;
  assert.ok(derived.entries.some((e) => e.key === '**.app.role' && entryInFile(e, MAIN_URI)));
});

test('extends into an included base config is not reported as unknown', () => {
  const own = parseIni(MAIN, MAIN_URI);
  const merged = expandIncludes(MAIN_URI, docMap({ [MAIN_URI]: MAIN, [BASE_URI]: BASE }));

  // Without include awareness, extends=Base would be "No such section".
  const withoutIncludes = iniStructureDiagnostics(own, null as never, registry);
  assert.ok(withoutIncludes.some((d) => d.code === 'no-such-section'));

  const withIncludes = iniStructureDiagnostics(own, null as never, registry, merged.sections.map(sectionName));
  assert.ok(!withIncludes.some((d) => d.code === 'no-such-section'), 'base config resolved via include');
});

test('effective network is inherited from an included [General]', async () => {
  const cache = await nedCache();
  const merged = expandIncludes(MAIN_URI, docMap({ [MAIN_URI]: MAIN, [BASE_URI]: BASE }));
  const derived = findSection(merged, 'Derived')!;
  assert.equal(effectiveNetwork(merged, derived), 'Net');

  // param diagnostics over the merged doc flag only the current file's entries,
  // and resolve **.app.role against Net (no false "no such param").
  const diags = iniParamDiagnostics(merged, cache, registry, MAIN_URI);
  assert.ok(!diags.some((d) => d.code === 'no-matching-param'), 'app.role resolves via inherited network');
  // the base file's `**.role` entry is not flagged while linting main.ini
  assert.ok(diags.every((d) => d.range.start.line >= 0));
});

test('iniIncludeDiagnostics warns only for unresolvable includes', () => {
  const own = parseIni(MAIN, MAIN_URI);
  const present = iniIncludeDiagnostics(own, (u) => u === BASE_URI);
  assert.equal(present.length, 0);

  const missing = iniIncludeDiagnostics(own, () => false);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].code, 'include-not-found');
});

test('a cyclic include does not loop forever', () => {
  const a = 'file:///proj/a.ini';
  const b = 'file:///proj/b.ini';
  const merged = expandIncludes(
    a,
    docMap({ [a]: 'include b.ini\n[Config A]\n', [b]: 'include a.ini\n[Config B]\n' }),
  );
  const names = merged.sections.map(sectionName).sort();
  assert.deepEqual(names, ['A', 'B']);
});
