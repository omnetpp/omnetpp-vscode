import { test } from 'bun:test';
import assert from 'node:assert';
import {
  parseIni,
  sectionChain,
  sectionName,
  configEntriesInScope,
  ConfigRegistry,
  type IniDocument,
} from '../index';

const registry = new ConfigRegistry([
  { name: 'network', type: 'string', default: null, scope: 'per-run', description: '' },
]);

function chainOf(doc: IniDocument, config: string): string[] {
  const section = doc.sections.find((s) => sectionName(s) === config);
  assert.ok(section, `missing section ${config}`);
  return sectionChain(doc, section!).map(sectionName);
}

// The exact example from the OMNeT++ kernel test test/core/inifile_inheritance.test
// (SectionBasedConfiguration C3 linearization).
test('C3: kernel inifile_inheritance example', () => {
  const doc = parseIni(`[General]
[Config pane]
[Config scrolling-mixin]
[Config editing-mixin]
[Config scrollable-pane]
extends = pane, scrolling-mixin
[Config editable-pane]
extends = pane, editing-mixin
[Config editable-scrollable-pane]
extends = scrollable-pane, editable-pane
`);
  assert.deepEqual(chainOf(doc, 'editable-scrollable-pane'), [
    'editable-scrollable-pane',
    'scrollable-pane',
    'editable-pane',
    'pane',
    'scrolling-mixin',
    'editing-mixin',
    'General',
  ]);
});

test('C3: diamond keeps the shared base last', () => {
  const doc = parseIni(`[General]
[Config A]
[Config B]
extends = A
[Config C]
extends = A
[Config D]
extends = B, C
`);
  assert.deepEqual(chainOf(doc, 'D'), ['D', 'B', 'C', 'A', 'General']);
});

test('C3: single inheritance is a plain chain, ending at General', () => {
  const doc = parseIni(`[General]
[Config A]
[Config B]
extends = A
[Config C]
extends = B
`);
  assert.deepEqual(chainOf(doc, 'C'), ['C', 'B', 'A', 'General']);
});

test('C3: a config with no extends implicitly inherits [General]', () => {
  const doc = parseIni(`[General]
[Config X]
`);
  assert.deepEqual(chainOf(doc, 'X'), ['X', 'General']);
  // [General] itself has no base
  assert.deepEqual(chainOf(doc, 'General'), ['General']);
});

test('C3: an extends cycle terminates (best-effort, no infinite loop)', () => {
  const doc = parseIni(`[Config A]
extends = B
[Config B]
extends = A
`);
  const chain = chainOf(doc, 'A');
  assert.equal(chain[0], 'A');
  assert.ok(chain.includes('B'));
});

test('C3 precedence drives first-match-wins parameter lookup', () => {
  // B and C both set **.x; in the D-chain B precedes C, so B's value wins.
  const doc = parseIni(`[General]
[Config B]
**.x = 1
[Config C]
**.x = 2
[Config D]
extends = B, C
`);
  const d = doc.sections.find((s) => sectionName(s) === 'D')!;
  const entries = configEntriesInScope(doc, d, registry).filter((e) => e.key === '**.x');
  // first entry in scope order is the winner
  assert.equal(entries[0].value, '1');
  assert.deepEqual(entries.map((e) => e.value), ['1', '2']);
});
