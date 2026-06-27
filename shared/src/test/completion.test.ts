import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getParsers } from './helpers';
import { BUILTIN_NED_TEXT, BUILTIN_URI, NedResourceCache } from '../ned/nedResourceCache';
import { nedCompletion } from '../ned/nedCompletion';
import { ConfigRegistry } from '../ini/configRegistry';
import { parseIni } from '../ini/iniDocument';
import { iniCompletion } from '../ini/iniNavigation';

async function nedCache(files: Record<string, string>) {
  const svc = await getParsers();
  const cache = new NedResourceCache();
  cache.addFile(BUILTIN_URI, svc.parse('ned', BUILTIN_NED_TEXT), 'ned');
  for (const [uri, text] of Object.entries(files)) cache.addFile(uri, svc.parse('ned', text), '');
  return cache;
}

/** Run NED completion with the cursor at the END of the given line index. */
function completeAt(cache: NedResourceCache, uri: string, lineIdx: number): string[] {
  const file = cache.getFile(uri)!;
  const lines = file.tree.rootNode.text.split('\n');
  const line = lines[lineIdx];
  return nedCompletion(cache, file, file.tree, { line: lineIdx, character: line.length }, line).map(
    (i) => i.label,
  );
}

const KINDS = `simple SBase { }
module MBase { }
channel CBase { }
moduleinterface IMod { }
channelinterface IChan { }
`;

test('completion: file top level offers only top-level keywords (no types)', async () => {
  const cache = await nedCache({ 'file:///k.ned': KINDS + '\n' });
  const labels = completeAt(cache, 'file:///k.ned', 5); // trailing blank line
  assert.ok(labels.includes('simple') && labels.includes('module') && labels.includes('import'));
  assert.ok(!labels.includes('SBase'), 'no type names at file top');
});

test('completion: extends filters by the kind being defined', async () => {
  const cache = await nedCache({ 'file:///k.ned': KINDS + 'simple S extends \n' });
  const labels = completeAt(cache, 'file:///k.ned', 5);
  assert.ok(labels.includes('SBase') && labels.includes('MBase'), 'modules offered');
  assert.ok(!labels.includes('CBase'), 'channels not offered for a simple module');
  assert.ok(!labels.includes('IMod'), 'interfaces not offered after extends');
});

test('completion: channel extends offers only channels', async () => {
  const cache = await nedCache({ 'file:///k.ned': KINDS + 'channel C extends \n' });
  const labels = completeAt(cache, 'file:///k.ned', 5);
  assert.ok(labels.includes('CBase'));
  assert.ok(!labels.includes('SBase') && !labels.includes('MBase'));
});

test('completion: like offers interfaces', async () => {
  const cache = await nedCache({ 'file:///k.ned': KINDS + 'module M2 like \n' });
  const labels = completeAt(cache, 'file:///k.ned', 5);
  assert.ok(labels.includes('IMod'));
  assert.ok(!labels.includes('SBase') && !labels.includes('IChan'));
});

test('completion: submodule type position offers module types', async () => {
  const src = KINDS + 'network N {\n  submodules:\n    h: \n}\n';
  const cache = await nedCache({ 'file:///k.ned': src });
  const labels = completeAt(cache, 'file:///k.ned', 7); // "    h: "
  assert.ok(labels.includes('SBase') || labels.includes('MBase'));
  assert.ok(!labels.includes('CBase'));
});

test('completion: section-header line does NOT offer types (gates: -> direction keywords)', async () => {
  const src = 'simple S {\n  gates:\n    input g;\n}\n';
  const cache = await nedCache({ 'file:///g.ned': src });
  const labels = completeAt(cache, 'file:///g.ned', 1); // "  gates:"
  assert.ok(labels.includes('input') && labels.includes('output') && labels.includes('inout'));
  assert.ok(!labels.includes('S'), 'no type names on a section header line');
});

test('completion: parameters section offers param type keywords + inherited params', async () => {
  const src = 'simple Base { parameters: int capacity; }\nsimple D extends Base {\n  parameters:\n    \n}\n';
  const cache = await nedCache({ 'file:///p.ned': src });
  const labels = completeAt(cache, 'file:///p.ned', 3); // blank line inside parameters
  assert.ok(labels.includes('int') && labels.includes('double'));
  assert.ok(labels.includes('capacity'), 'inherited parameter offered for assignment');
});

// ---- INI completion ----
const reg = new ConfigRegistry(
  JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'resources', 'config', 'opp-config-options.json'), 'utf8')).options,
);

test('ini completion: key position offers config options + extends', () => {
  const doc = parseIni('[General]\n\n');
  const items = iniCompletion(doc, reg, undefined, { line: 1, character: 0 }, '');
  const labels = items.map((i) => i.label);
  assert.ok(labels.includes('network') && labels.includes('sim-time-limit') && labels.includes('extends'));
});

test('ini completion: bool config value offers true/false', () => {
  const doc = parseIni('parallel-simulation = \n');
  const line = 'parallel-simulation = ';
  const items = iniCompletion(doc, reg, undefined, { line: 0, character: line.length }, line);
  const labels = items.map((i) => i.label);
  assert.deepEqual(labels.sort(), ['false', 'true']);
});

test('ini completion: extends = offers config section names', () => {
  const doc = parseIni('[Config Base]\n[Config Run]\nextends = \n');
  const line = 'extends = ';
  const items = iniCompletion(doc, reg, undefined, { line: 2, character: line.length }, line);
  assert.deepEqual(items.map((i) => i.label).sort(), ['Base', 'Run']);
});

test('ini completion: section header offers General/Config', () => {
  const doc = parseIni('[\n');
  const items = iniCompletion(doc, reg, undefined, { line: 0, character: 1 }, '[');
  assert.deepEqual(items.map((i) => i.label).sort(), ['Config ', 'General']);
});
