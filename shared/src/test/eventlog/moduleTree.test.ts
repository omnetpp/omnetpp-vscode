/**
 * Phase E6 test suite, part 3: `buildModuleTree()` (shared/src/eventlog/moduleTree.ts).
 * Checks the DTO tree shape against hand-derived expectations from the "MC"
 * (ModuleCreatedEntry/ModuleDescriptionEntry) lines of a real fixture and a
 * purpose-built synthesized nested-module log (deeper than 2 levels, exercising the
 * parent-promoted-to-compound behavior and the two Java-faithful edge cases: only the
 * first top-level entry becomes the root, and an orphan entry -- referencing a parent
 * module id that has no description of its own -- is dropped quietly).
 */

import { test } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { EventLog } from '../../eventlog/eventLog';
import { buildModuleTree, type ElogModule } from '../../eventlog/moduleTree';
import { fileReaderForContent } from './testEventLogHelper';

function openEventLog(text: string): EventLog {
  return new EventLog(fileReaderForContent(text));
}

const fifoPath = resolve(__dirname, '..', 'fixtures', 'elog', 'sample', 'Fifo1-#0.elog');

// ---------------------------------------------------------------------------------
// 1. Real fixture: Fifo1-#0.elog's "MC" lines (hand-derived from the file content).
// ---------------------------------------------------------------------------------

test('buildModuleTree: Fifo1-#0.elog sample matches its "MC" lines exactly', () => {
  const text = fs.readFileSync(fifoPath, 'latin1');
  const eventLog = openEventLog(text);

  const root = buildModuleTree(eventLog);
  assert.notEqual(root, null);
  assert.deepEqual(root, {
    moduleId: 1,
    fullName: 'SingleQueue',
    nedTypeName: 'SingleQueue',
    moduleClassName: 'omnetpp::cModule',
    compound: true, // has children (also its own "cm 1" token agrees)
    children: [
      { moduleId: 2, fullName: 'source', nedTypeName: 'Source', moduleClassName: 'fifo::Source', compound: false, children: [] },
      { moduleId: 3, fullName: 'fifo', nedTypeName: 'Fifo', moduleClassName: 'fifo::Fifo', compound: false, children: [] },
      { moduleId: 4, fullName: 'sink', nedTypeName: 'Sink', moduleClassName: 'fifo::Sink', compound: false, children: [] },
    ],
  } satisfies ElogModule);
});

// ---------------------------------------------------------------------------------
// 2. Empty log: no modules described at all -> null root.
// ---------------------------------------------------------------------------------

test('buildModuleTree: an eventlog with no module description entries returns null', () => {
  const lines = ['SB ov 1536 ev 2 rid Test-0', '', 'SE e 0 c 9 m "done"', ''];
  const eventLog = openEventLog(lines.join('\n'));
  assert.equal(buildModuleTree(eventLog), null);
});

// ---------------------------------------------------------------------------------
// 3. Synthesized nested modules (3+ levels): parent/child/compound flags, including
//    the parent-promoted-to-compound behavior for a module whose own "cm" token is
//    absent (defaults false) but which has children attached.
// ---------------------------------------------------------------------------------

function nestedModuleFixtureText(): string {
  const lines: string[] = [
    'SB ov 1536 ev 2 rid Test-0',
    '',
    'E # 0 t 0 m 1 ce -1 msg -1',
    'MC id 1 c cModule t Root n root cm 1', // root, explicitly compound
    'MC id 2 c cModule t Mid n mid pid 1', // NOTE: no "cm" token -- becomes compound only because "leaf1"/"leaf2" attach below
    'MC id 3 c cModule t Leaf n leaf1 pid 2',
    'MC id 4 c cModule t Leaf n leaf2 pid 2',
    'MC id 5 c cModule t Other n other pid 1', // leaf, direct child of root, sibling of "mid"
    '',
    'SE e 0 c 9 m "done"',
    '',
  ];
  return lines.join('\n');
}

test('buildModuleTree: synthesized 3-level nested modules -- parent/child/compound flags', () => {
  const eventLog = openEventLog(nestedModuleFixtureText());
  const root = buildModuleTree(eventLog);
  assert.notEqual(root, null);
  assert.equal(root!.moduleId, 1);
  assert.equal(root!.compound, true);
  assert.equal(root!.children.length, 2);

  const mid = root!.children.find((m) => m.moduleId === 2)!;
  assert.notEqual(mid, undefined);
  assert.equal(mid.fullName, 'mid');
  assert.equal(mid.nedTypeName, 'Mid');
  assert.equal(mid.moduleClassName, 'cModule');
  // no "cm" token on this module's own MC line, yet promoted to compound because it has children
  assert.equal(mid.compound, true);
  assert.deepEqual(
    mid.children.map((c) => c.moduleId),
    [3, 4],
  );
  for (const leaf of mid.children) assert.equal(leaf.compound, false);

  const other = root!.children.find((m) => m.moduleId === 5)!;
  assert.notEqual(other, undefined);
  assert.equal(other.fullName, 'other');
  assert.equal(other.compound, false);
  assert.deepEqual(other.children, []);
});

// ---------------------------------------------------------------------------------
// 4. Java-faithful edge cases: only the first top-level entry becomes the root; an
//    orphan entry (parentModuleId names no known module) is dropped quietly.
// ---------------------------------------------------------------------------------

test('buildModuleTree: only the first top-level (parentModuleId === -1) entry becomes the root; a second one is silently dropped', () => {
  const lines = [
    'SB ov 1536 ev 2 rid Test-0',
    '',
    'E # 0 t 0 m 1 ce -1 msg -1',
    'MC id 1 c cModule t Root n root cm 1',
    'MC id 2 c cModule t SecondRoot n secondRoot', // also top-level (no "pid"): dropped, per Java's `if (moduleTreeRoot == null)` guard
    '',
    'SE e 0 c 9 m "done"',
    '',
  ];
  const eventLog = openEventLog(lines.join('\n'));
  const root = buildModuleTree(eventLog);
  assert.notEqual(root, null);
  assert.equal(root!.moduleId, 1);
  assert.deepEqual(root!.children, []);
});

test('buildModuleTree: an orphan entry (parentModuleId names no known module) is dropped quietly, the rest of the tree still builds', () => {
  const lines = [
    'SB ov 1536 ev 2 rid Test-0',
    '',
    'E # 0 t 0 m 1 ce -1 msg -1',
    'MC id 1 c cModule t Root n root cm 1',
    'MC id 2 c cModule t Child n child pid 1',
    'MC id 99 c cModule t Orphan n orphan pid 42', // parent module 42 is never described -> orphan
    '',
    'SE e 0 c 9 m "done"',
    '',
  ];
  const eventLog = openEventLog(lines.join('\n'));
  const root = buildModuleTree(eventLog);
  assert.notEqual(root, null);
  assert.equal(root!.moduleId, 1);
  assert.deepEqual(
    root!.children.map((c) => c.moduleId),
    [2],
  );
  // the orphan must not appear anywhere in the tree
  function findAll(node: ElogModule): ElogModule[] {
    return [node, ...node.children.flatMap(findAll)];
  }
  const allNodes = findAll(root!);
  assert.equal(
    allNodes.some((n) => n.moduleId === 99),
    false,
  );
});
