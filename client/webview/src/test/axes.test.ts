import { test } from 'bun:test';
import assert from 'node:assert';
import type { ElogModule } from '@omnetpp/shared/elog-protocol';
import { deriveAxes, maxVerticalScroll } from '../eventlog/chart/axes';

function module_(moduleId: number, fullName: string, compound: boolean, children: ElogModule[] = []): ElogModule {
  return { moduleId, fullName, nedTypeName: fullName, moduleClassName: fullName, compound, children };
}

test('axes are ordered ascending by module id, regardless of Set insertion order', () => {
  const known = new Set([30, 10, 20]);
  const layout = deriveAxes(known, null, 600);
  assert.deepStrictEqual(
    layout.axes.map((a) => a.moduleId),
    [10, 20, 30],
  );
});

test('a module id not found in the tree falls back to a synthetic label instead of being dropped', () => {
  const layout = deriveAxes(new Set([42]), null, 600);
  assert.strictEqual(layout.axes.length, 1);
  assert.strictEqual(layout.axes[0].label, 'Module #42');
  assert.strictEqual(layout.axes[0].compound, false);
});

test('names/compound-ness are resolved from the module tree when available', () => {
  const tree = module_(1, 'Net', true, [module_(2, 'Net.node[0]', false), module_(3, 'Net.node[1]', false)]);
  const layout = deriveAxes(new Set([1, 3]), tree, 600);
  const byId = new Map(layout.axes.map((a) => [a.moduleId, a]));
  assert.strictEqual(byId.get(1)?.label, 'Net');
  assert.strictEqual(byId.get(1)?.compound, true);
  assert.strictEqual(byId.get(1)?.lineHeight, 3);
  assert.strictEqual(byId.get(3)?.label, 'Net.node[1]');
  assert.strictEqual(byId.get(3)?.compound, false);
  assert.strictEqual(byId.get(3)?.lineHeight, 1);
});

test('only known (seen) module ids get an axis -- the tree may contain modules with no events yet', () => {
  const tree = module_(1, 'Net', true, [module_(2, 'Net.node[0]', false)]);
  const layout = deriveAxes(new Set([1]), tree, 600); // node[0] never seen -> no axis
  assert.strictEqual(layout.axes.length, 1);
  assert.strictEqual(layout.axes[0].moduleId, 1);
});

test('axis y positions are strictly increasing and start after AXIS_OFFSET', () => {
  const layout = deriveAxes(new Set([1, 2, 3]), null, 600);
  assert.ok(layout.axes[0].y > 0);
  for (let i = 1; i < layout.axes.length; i++) assert.ok(layout.axes[i].y > layout.axes[i - 1].y);
});

test('AUTO spacing spreads axes evenly across the viewport height, never tighter than FONT_HEIGHT_PX+1', () => {
  const many = deriveAxes(new Set(Array.from({ length: 100 }, (_, i) => i)), null, 200);
  assert.ok(many.spacing >= 15, `spacing floor respected: ${many.spacing}`);

  const few = deriveAxes(new Set([1, 2]), null, 600);
  assert.ok(few.spacing > 15, `plenty of room -> spacing spreads out: ${few.spacing}`);
});

test('an empty known-module set produces an empty axis list with zero total height', () => {
  const layout = deriveAxes(new Set(), null, 600);
  assert.deepStrictEqual(layout.axes, []);
  assert.strictEqual(layout.totalHeight, 0);
});

test('maxVerticalScroll is zero when content fits, positive when it overflows', () => {
  const short = deriveAxes(new Set([1, 2]), null, 2000);
  assert.strictEqual(maxVerticalScroll(short, 2000), 0);

  const tall = deriveAxes(new Set(Array.from({ length: 200 }, (_, i) => i)), null, 100);
  assert.ok(maxVerticalScroll(tall, 100) > 0);
});
