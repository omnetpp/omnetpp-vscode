import { test } from 'bun:test';
import assert from 'node:assert';
import type { PreviewScene, PreviewSubmodule } from '../protocol';
import { buildDiagram, type IconProvider } from '../graphics/diagramLayout';
import { arrangementOf, arrangementOffset } from '../graphics/arrangement';
import { displayStringFromChain } from '../ned/displayStringModel';

const icons: IconProvider = { get: () => Promise.resolve(undefined) };
const opts = { icons, measureText: (t: string) => 7 * t.length, seed: 1 };

function sub(name: string, display: string): PreviewSubmodule {
  return {
    name,
    isLike: false,
    displayChain: [display],
    declUri: 'file:///net.ned',
    declRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  };
}

function scene(submodules: PreviewSubmodule[]): PreviewScene {
  return {
    kind: 'compound',
    fqName: 'LayoutGroup2',
    simpleName: 'LayoutGroup2',
    isNetwork: false,
    typeUri: 'file:///net.ned',
    displayChain: ['bgb=600,500'],
    icons: [],
    submodules,
    connections: [],
  };
}

const offset = (display: string, index: number, size: number) =>
  arrangementOffset(arrangementOf(displayStringFromChain([display])), index, size);

function assertNear(actual: { x: number; y: number }, expected: [number, number], what: string): void {
  assert.ok(
    Math.abs(actual.x - expected[0]) < 1e-6 && Math.abs(actual.y - expected[1]) < 1e-6,
    `${what}: expected (${expected}), got (${actual.x},${actual.y})`,
  );
}

test('arrangement: offsets for each arrangement kind', () => {
  assertNear(offset('p=0,0', 3, 5), [0, 0], 'none');
  assertNear(offset('p=0,0,exact,10,20', 3, 5), [10, 20], 'exact');
  assertNear(offset('p=0,0,row', 2, 5), [160, 0], 'row, default spacing');
  assertNear(offset('p=0,0,row,30,2,40', 3, 5), [30, 40], 'row, wrapped');
  assertNear(offset('p=0,0,column,30', 2, 5), [0, 60], 'column');
  assertNear(offset('p=0,0,column,30,2,40', 3, 5), [40, 30], 'column, wrapped');
  assertNear(offset('p=0,0,matrix', 6, 10), [80, 80], 'matrix, default 5 columns');
  assertNear(offset('p=0,0,matrix,3,60,50', 4, 6), [60, 50], 'matrix');
  assertNear(offset('p=0,0,ring,70', 1, 4), [0, 70], 'ring');
  assertNear(offset('p=0,0,cring,70', 1, 4), [-70, 0], 'cring');
  assertNear(offset('p=0,0,cring', 0, 4), [0, -50], 'cring, radius from size and spacing');
  assertNear(offset('p=0,0,ring,x', 0, 1), [12, 0], 'unparsable radius falls back to spacing*size/2pi');
});

test('arrangement: "g" layout groups are arranged in declaration order (test/anim LayoutGroup2)', async () => {
  const model = await buildDiagram(
    scene([
      sub('a', 'p=60,60,row,70;g=top'),
      sub('c', 'p=60,60,row,70;g=top'),
      sub('b', 'p=60,60,row,70;g=top'),
      sub('n', 'p=163,251,cring,70;g=circle'),
      sub('e', 'p=163,251,cring,70;g=circle'),
      sub('s', 'p=163,251,cring,70;g=circle'),
      ...[1, 2, 3, 4, 5, 6].map((i) => sub(`m${i}`, 'p=293,81,matrix,3,60,60;g=grid')),
      sub('lone', 'p=500,400,row,70'),
    ]),
    opts,
  );
  const pos = new Map(model.submodules.map((f) => [f.sub.name, { x: f.cx, y: f.cy }]));
  assertNear(pos.get('a')!, [60, 60], 'a');
  assertNear(pos.get('c')!, [130, 60], 'c');
  assertNear(pos.get('b')!, [200, 60], 'b');
  const alpha = (2 * Math.PI) / 3;
  assertNear(pos.get('n')!, [163, 251 - 70], 'n');
  assertNear(pos.get('e')!, [163 - 70 * Math.sin(alpha), 251 - 70 * Math.cos(alpha)], 'e');
  assertNear(pos.get('s')!, [163 - 70 * Math.sin(2 * alpha), 251 - 70 * Math.cos(2 * alpha)], 's');
  assertNear(pos.get('m1')!, [293, 81], 'm1');
  assertNear(pos.get('m3')!, [413, 81], 'm3');
  assertNear(pos.get('m4')!, [293, 141], 'm4');
  assertNear(pos.get('m6')!, [413, 141], 'm6');
  assertNear(pos.get('lone')!, [500, 400], 'a submodule outside any group gets the index-0 offset');
});

test('arrangement: an unpinned layout group is laid out as one rigid body', async () => {
  const model = await buildDiagram(
    scene([
      sub('f1', 'p=,,column,60;g=floating'),
      sub('f2', 'p=,,column,60;g=floating'),
      sub('f3', 'p=,,column,60;g=floating'),
      sub('free', ''),
    ]),
    opts,
  );
  const [f1, f2, f3] = model.submodules;
  assert.ok(!f1.pinned);
  assertNear({ x: f2.cx - f1.cx, y: f2.cy - f1.cy }, [0, 60], 'f2 - f1');
  assertNear({ x: f3.cx - f1.cx, y: f3.cy - f1.cy }, [0, 120], 'f3 - f1');
});
