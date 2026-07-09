import { test } from 'bun:test';
import assert from 'node:assert';
import type { ElogModule } from '@omnetpp/shared/elog-protocol';
import { AUTO_AXIS_SPACING, AXIS_VECTOR_STRIP_HEIGHT, deriveAxes, layoutAxes, maxVerticalScroll } from '../eventlog/chart/axes';

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

test('a module showing a vector strip reserves the taller strip height, and pushes later axes down', () => {
  const ids = [1, 2, 3];
  // manual (fixed) spacing so the reserved height actually shifts positions -- AUTO mode
  // would rebalance the spacing to fill the viewport and hide the effect.
  const spacing = { mode: 'manual' as const, manualSpacing: 20 };
  const plain = layoutAxes(ids, null, 600, spacing);
  const withStrip = layoutAxes(ids, null, 600, spacing, new Set([2]));
  const byId = new Map(withStrip.axes.map((a) => [a.moduleId, a]));
  assert.strictEqual(byId.get(2)?.lineHeight, AXIS_VECTOR_STRIP_HEIGHT, 'strip axis reserves 12px');
  assert.strictEqual(byId.get(1)?.lineHeight, 1, 'other axes unchanged');
  const plain3 = plain.axes.find((a) => a.moduleId === 3)!.y;
  assert.ok(byId.get(3)!.y > plain3, 'strip height pushes the following axis down');
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

test('includeEmptyAxes=true (Show Empty Axes toggle) adds every module-tree id, even ones never seen in fetched data; default (false) does not', () => {
  const tree = module_(1, 'Net', true, [module_(2, 'Net.node[0]', false), module_(3, 'Net.node[1]', false)]);
  const withoutEmpty = deriveAxes(new Set([1]), tree, 600);
  assert.strictEqual(withoutEmpty.axes.length, 1);

  const withEmpty = deriveAxes(new Set([1]), tree, 600, true);
  assert.strictEqual(withEmpty.axes.length, 3);
  assert.deepStrictEqual(
    withEmpty.axes.map((a) => a.moduleId),
    [1, 2, 3],
  );
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

test('totalHeight (and so maxVerticalScroll) includes a BOTTOM margin matching the top one, so the last axis is fully reachable by scrolling -- not just short of it', () => {
  // Regression for: "sometimes I cannot drag the canvas to make the server module at the
  // bottom visible" (Aloha example). Java's calculateVirtualSize() reserves axisOffset*2
  // (top AND bottom margin); this port's totalHeight used to only account for the top one
  // baked into the loop's starting y, so maxVerticalScroll came up short by up to
  // 2*AXIS_OFFSET px -- sometimes clamping to 0 outright even though the last axis
  // genuinely extends past the visible content height.
  const spacing = { mode: 'manual' as const, manualSpacing: 15 };
  const layout = layoutAxes([1, 2], null, 600, spacing); // 2 simple axes, lineHeight=1 each
  const last = layout.axes[layout.axes.length - 1];

  // A content height that comfortably exceeds the OLD (buggy) totalHeight but is still less
  // than the actual bottom-of-content extent -- exactly the "old formula clamps scroll to 0,
  // but the last axis is genuinely clipped" case.
  const contentHeightPx = 40;
  const max = maxVerticalScroll(layout, contentHeightPx);
  assert.ok(max > 0, `expected scrolling to be possible/needed, got maxVerticalScroll=${max}`);

  // At the maximum allowed scroll, the last axis's line must be fully within the visible
  // content window [0, contentHeightPx] (axis lines are centered on their y, 1px thick here).
  const visibleY = last.y - max;
  assert.ok(visibleY - last.lineHeight / 2 >= 0 && visibleY + last.lineHeight / 2 <= contentHeightPx, `last axis (y=${last.y}) not fully visible at max scroll (${max}): visibleY=${visibleY}`);
});
