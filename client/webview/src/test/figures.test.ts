import { test } from 'bun:test';
import assert from 'node:assert';
import type { PreviewScene, PreviewSubmodule } from '@omnetpp/shared/protocol';
import { buildCardFigure, buildDiagram } from '../figures';
import type { IconStore } from '../icons';

// DOM-free checks of the figure/layout/routing pipeline. Icon loading and
// text measurement are stubbed (they need a browser); scenes use an explicit
// bgb so auto-sizing (which measures labels) is not exercised here.

const fakeIcons = {
  get: () => Promise.resolve({ dataUri: 'data:image/png;base64,', width: 32, height: 20 }),
} as unknown as IconStore;

function sub(name: string, display: string[], extra: Partial<PreviewSubmodule> = {}): PreviewSubmodule {
  return {
    name,
    isLike: false,
    displayChain: display,
    declUri: 'file:///net.ned',
    declRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    ...extra,
  };
}

function scene(overrides: Partial<PreviewScene>): PreviewScene {
  return {
    kind: 'compound',
    fqName: 'Net',
    simpleName: 'Net',
    isNetwork: false,
    typeUri: 'file:///net.ned',
    displayChain: ['bgb=400,300'],
    icons: [],
    submodules: [],
    connections: [],
    ...overrides,
  };
}

const CONN = {
  srcGate: 'g',
  destGate: 'g',
  bidirectional: false,
  isLoop: false,
  isConditional: false,
  displayChain: [] as string[],
  declUri: 'file:///net.ned',
  declRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
};

test('figures: pinned position honored, unpinned laid out inside the area', async () => {
  const s = scene({
    submodules: [sub('a', ['p=100,100', 'i=device/pc']), sub('b', ['i=device/pc'])],
    connections: [{ ...CONN, srcModule: 'a', destModule: 'b' }],
  });
  const model = await buildDiagram(s, fakeIcons, 1);
  assert.equal(model.background.width, 400);
  assert.equal(model.background.height, 300);
  const [a, b] = model.submodules;
  assert.deepEqual([a.cx, a.cy], [100, 100]);
  assert.ok(a.pinned && !b.pinned);
  assert.ok(b.cx > 0 && b.cx < 400 && b.cy > 0 && b.cy < 300, `b inside area: (${b.cx},${b.cy})`);
  // determinism per seed
  const model2 = await buildDiagram(s, fakeIcons, 1);
  assert.deepEqual([model2.submodules[1].cx, model2.submodules[1].cy], [b.cx, b.cy]);
  const model3 = await buildDiagram(s, fakeIcons, 2);
  assert.notDeepEqual([model3.submodules[1].cx, model3.submodules[1].cy], [b.cx, b.cy]);
});

test('figures: shape/icon resolution follows the IDE rules', async () => {
  const s = scene({
    submodules: [
      sub('boxy', ['p=50,50;b=60,40,oval,red,black,3']),
      sub('iconless', ['p=150,50']), // no i, no b -> default icon
      sub('faded', ['p=250,50;i=block/proc,red,50;q=jobs;t=hello,l;r=30,,red']),
    ],
  });
  const model = await buildDiagram(s, fakeIcons, 1);
  const [boxy, iconless, faded] = model.submodules;
  assert.equal(boxy.shape?.kind, 'oval');
  assert.equal(boxy.width, 60);
  assert.equal(boxy.height, 40);
  assert.equal(boxy.icon, undefined);
  assert.ok(iconless.icon, 'default icon expected');
  assert.equal(iconless.width, 32); // stub icon natural size
  assert.ok(faded.queue);
  assert.equal(faded.text?.pos, 'left');
  assert.equal(faded.range?.radius, 30);
  assert.equal(faded.label, 'faded');
});

test('figures: vector label, connection styles, markers and bundling', async () => {
  const s = scene({
    submodules: [sub('n', ['p=100,100;i=device/pc'], { vectorSize: '8' }), sub('m', ['p=300,100;i=device/pc'])],
    connections: [
      { ...CONN, srcModule: 'n', destModule: 'm', displayChain: ['ls=blue,2,dashed'] },
      { ...CONN, srcModule: 'n', destModule: 'm' },
      { ...CONN, srcModule: 'n', destModule: 'n', isLoop: true, isConditional: true }, // self, in a loop with if
      { ...CONN, destModule: 'm', bidirectional: true }, // from the parent border
    ],
  });
  const model = await buildDiagram(s, fakeIcons, 1);
  assert.equal(model.submodules[0].label, 'n[8]');

  const [styled, plain, self, border] = model.connections;
  assert.equal(styled.color, '#0000ff');
  assert.equal(styled.width, 2);
  assert.equal(styled.style, 'dashed');
  assert.ok(styled.arrowhead);
  // the two parallel n->m connections are bundled: distinct endpoints
  assert.notDeepEqual(styled.points, plain.points);
  // self connection renders as an arc at the top-right corner
  assert.ok(self.selfArc && !self.selfArc.onBorder);
  assert.equal(self.marker, 'o?');
  // border connection: containment routing from the compound rect, no arrowhead
  assert.ok(!border.arrowhead);
  assert.equal(border.points.length, 2);
});

test('figures: card figure uses the type display chain', async () => {
  const card = await buildCardFigure(
    scene({ kind: 'simple', displayChain: ['i=block/sink,red;b=40,24'], submodules: undefined, connections: undefined }),
    fakeIcons,
  );
  assert.equal(card.label, 'Net');
  assert.ok(card.shape);
  assert.ok(card.icon);
  assert.equal(card.tooltip, 'Net');
});
