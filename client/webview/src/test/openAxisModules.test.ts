import { test } from 'bun:test';
import assert from 'node:assert';
import type { ElogModule } from '@omnetpp/shared/elog-protocol';
import {
  collapseOpenAxisModule,
  collapseOpenAxisModuleSubmodules,
  computeVisibleAxisModuleIds,
  defaultOpenAxisModules,
  expandOpenAxisModule,
  expandOpenAxisModuleRecursively,
  moduleGlyphInfo,
  moduleIdsToPaths,
  moduleIdToAxisModuleIdMap,
  openModule,
  openModuleRecursively,
  pathsToModuleIds,
  removeOpenAxisModule,
  removeOpenAxisModuleSubtree,
} from '../eventlog/chart/openAxisModules';
import { presetDefaultFlags, presetNetworkCommunicationFlags, showAllFlags } from '../eventlog/chart/displayFlags';
import { AUTO_AXIS_SPACING, layoutAxes } from '../eventlog/chart/axes';

/**
 * Test tree (ids in brackets):
 *   net[1]
 *   ├── host1[2]
 *   │   ├── app[3]
 *   │   └── nic[4] (compound)
 *   │       └── mac[5]
 *   └── host2[6]
 *       └── app[7]
 */
function makeTree(): ElogModule {
  const m = (moduleId: number, fullName: string, nedTypeName: string, compound: boolean, children: ElogModule[] = []): ElogModule => ({ moduleId, fullName, nedTypeName, compound, children });
  return m(1, 'net', 'Net', true, [
    m(2, 'net.host1', 'Host', true, [m(3, 'net.host1.app', 'App', false), m(4, 'net.host1.nic', 'Nic', true, [m(5, 'net.host1.nic.mac', 'Mac', false)])]),
    m(6, 'net.host2', 'Host', true, [m(7, 'net.host2.app', 'App', false)]),
  ]);
}

// ---------------------------------------------------------------------------------
// open-set operations (SequenceChart.java's exact semantics -- see openAxisModules.ts)
// ---------------------------------------------------------------------------------

test('openModule: REPLACE with module + direct submodules only', () => {
  assert.deepEqual(openModule(2, makeTree()), [2, 3, 4]);
  assert.deepEqual(openModule(1, makeTree()), [1, 2, 6]);
});

test('openModuleRecursively / default open set: every module, compounds included (addAllSubmodules)', () => {
  // addAllSubmodules: self, then simple children as leaves / compound children recursively
  assert.deepEqual(openModuleRecursively(1, makeTree()), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(defaultOpenAxisModules(makeTree()), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(defaultOpenAxisModules(null), []);
});

test('expandOpenAxisModule: INCREMENTAL append of direct submodules not already open', () => {
  assert.deepEqual(expandOpenAxisModule([1, 2, 3], 2, makeTree()), [1, 2, 3, 4]);
  // module itself is untouched, already-open children not duplicated
  assert.deepEqual(expandOpenAxisModule([2, 4], 2, makeTree()), [2, 4, 3]);
});

test('expandOpenAxisModuleRecursively: appends every descendant not already open', () => {
  assert.deepEqual(expandOpenAxisModuleRecursively([1, 2], 2, makeTree()), [1, 2, 3, 4, 5]);
});

test('collapseOpenAxisModule: prunes every open STRICT descendant, keeps the module', () => {
  assert.deepEqual(collapseOpenAxisModule([1, 2, 3, 4, 5, 6], 2, makeTree()), [1, 2, 6]);
});

test('collapseOpenAxisModuleSubmodules: prunes one level deeper -- direct submodules survive', () => {
  // collapsing host1's SUBMODULES keeps app/nic open but removes nic's descendants
  assert.deepEqual(collapseOpenAxisModuleSubmodules([1, 2, 3, 4, 5], 2, makeTree()), [1, 2, 3, 4]);
});

test('removeOpenAxisModule vs removeOpenAxisModuleSubtree (axis close vs header close)', () => {
  assert.deepEqual(removeOpenAxisModule([1, 2, 3, 4], 2), [1, 3, 4]);
  // header close: visitItems removes the module AND all descendants
  assert.deepEqual(removeOpenAxisModuleSubtree([1, 2, 3, 4, 5, 6], 2, makeTree()), [1, 6]);
});

// ---------------------------------------------------------------------------------
// visible-axis derivation (calculateVisibleAxisModules port)
// ---------------------------------------------------------------------------------

test('visible axes: nearest open ancestor of each ACTIVE module, dedup', () => {
  const tree = makeTree();
  // open cut points: net + the two hosts; activity in app(3), mac(5), app(7)
  const visible = computeVisibleAxisModuleIds([1, 2, 6], new Set([3, 5, 7]), tree, false);
  assert.deepEqual([...visible].sort((a, b) => a - b), [2, 6]);
});

test('visible axes: an open module with no activity below it gets NO axis', () => {
  const tree = makeTree();
  const visible = computeVisibleAxisModuleIds([2, 6], new Set([3]), tree, false);
  assert.deepEqual(visible, [2]);
});

test('visible axes: an active module that IS open matches itself (no parent walk)', () => {
  const tree = makeTree();
  const visible = computeVisibleAxisModuleIds([3, 4], new Set([3, 4]), tree, false);
  assert.deepEqual([...visible].sort((a, b) => a - b), [3, 4]);
});

test('visible axes: activity above every open module produces no axis (walk goes UP only)', () => {
  const tree = makeTree();
  // only the leaf app(3) is open; activity on host1(2) has no open ancestor-or-self
  const visible = computeVisibleAxisModuleIds([3], new Set([2]), tree, false);
  assert.deepEqual(visible, []);
});

test('visible axes: showEmptyAxes returns the open list verbatim, activity ignored', () => {
  const tree = makeTree();
  const visible = computeVisibleAxisModuleIds([6, 2, 4], new Set(), tree, true);
  assert.deepEqual(visible, [6, 2, 4]);
});

test('expand -> children axes appear; collapse -> single axis again (end-to-end open-set flow)', () => {
  const tree = makeTree();
  const active = new Set([3, 5]); // events in app + mac
  let open = [2]; // just host1
  assert.deepEqual(computeVisibleAxisModuleIds(open, active, tree, false), [2]);
  open = expandOpenAxisModule(open, 2, tree); // + app, nic
  assert.deepEqual([...computeVisibleAxisModuleIds(open, active, tree, false)].sort((a, b) => a - b), [3, 4]);
  open = collapseOpenAxisModule(open, 2, tree); // back to host1 alone
  assert.deepEqual(computeVisibleAxisModuleIds(open, active, tree, false), [2]);
  open = removeOpenAxisModule(open, 2); // gone entirely
  assert.deepEqual(computeVisibleAxisModuleIds(open, active, tree, false), []);
});

// ---------------------------------------------------------------------------------
// event -> axis attribution map (calculateModuleIdToAxisModuleIndexMap port)
// ---------------------------------------------------------------------------------

test('moduleIdToAxisModuleIdMap: every module maps to its nearest visible-axis ancestor-or-self', () => {
  const tree = makeTree();
  const map = moduleIdToAxisModuleIdMap([2, 6], tree);
  assert.equal(map.get(3), 2); // app under host1's axis
  assert.equal(map.get(5), 2); // mac (two levels down) too
  assert.equal(map.get(7), 6);
  assert.equal(map.get(2), 2); // an axis maps to itself
  assert.equal(map.get(1), undefined); // net has no open-axis ancestor
});

// ---------------------------------------------------------------------------------
// path <-> id round trip (persistence identity)
// ---------------------------------------------------------------------------------

test('moduleIdsToPaths / pathsToModuleIds round-trip; unresolvable entries dropped', () => {
  const tree = makeTree();
  assert.deepEqual(moduleIdsToPaths([2, 5, 99], tree), ['net.host1', 'net.host1.nic.mac']);
  assert.deepEqual(pathsToModuleIds(['net.host1', 'gone.module', 'net.host2.app'], tree), [2, 7]);
  assert.deepEqual(pathsToModuleIds(['net.host1'], null), []);
});

// ---------------------------------------------------------------------------------
// glyph conditions (layoutAxis/layoutAxisHeader's allSubmodulesOpen/noSubmodulesOpen)
// ---------------------------------------------------------------------------------

test('moduleGlyphInfo: expand iff some direct child closed, collapse iff some direct child open', () => {
  const tree = makeTree();
  // host1 with only app open: partially expanded -> BOTH glyphs (Java shows both)
  assert.deepEqual(moduleGlyphInfo(2, [2, 3], tree), { expand: true, collapse: true });
  // all children open -> collapse only
  assert.deepEqual(moduleGlyphInfo(2, [2, 3, 4], tree), { expand: false, collapse: true });
  // no children open -> expand only
  assert.deepEqual(moduleGlyphInfo(2, [2], tree), { expand: true, collapse: false });
  // simple module -> neither
  assert.deepEqual(moduleGlyphInfo(3, [3], tree), { expand: false, collapse: false });
});

// ---------------------------------------------------------------------------------
// preset flag profiles (setShowAll/setShowDefault/setShowNetworkCommunication ports)
// ---------------------------------------------------------------------------------

test('preset flags: showAllFlags flips every key; Default/NetworkCommunication match the Java true-lists', () => {
  const all = showAllFlags(true);
  const none = showAllFlags(false);
  for (const value of Object.values(all)) assert.equal(value, true);
  for (const value of Object.values(none)) assert.equal(value, false);

  const dflt = presetDefaultFlags();
  assert.equal(dflt.showEventMarks, true);
  assert.equal(dflt.showMessageSends, true);
  assert.equal(dflt.showSelfMessageSends, true);
  assert.equal(dflt.showComponentMethodCalls, true);
  assert.equal(dflt.showMessageReuses, false); // not in setShowDefault's true-list
  assert.equal(dflt.showEmptyAxes, false);
  assert.equal(dflt.showEventLogInfo, false);

  const net = presetNetworkCommunicationFlags();
  assert.equal(net.showMessageSends, true);
  assert.equal(net.showTransmissionDurations, true);
  assert.equal(net.showEventMarks, false); // network view hides event marks
  assert.equal(net.showEventNumbers, false);
  assert.equal(net.showSelfMessageSends, false);
  assert.equal(net.showComponentMethodCalls, false);
});

// ---------------------------------------------------------------------------------
// manual axis spacing (layoutAxes' MANUAL mode, phase U8)
// ---------------------------------------------------------------------------------

test('layoutAxes: manual spacing uses the fixed value (clamped to >= 1), auto spreads', () => {
  const tree = makeTree();
  const manual = layoutAxes([3, 7], tree, 600, { mode: 'manual', manualSpacing: 20 });
  assert.equal(manual.spacing, 20);
  // y layout: AXIS_OFFSET(20) + spacing before each axis + lineHeight after
  assert.equal(manual.axes[0].y, 40);
  assert.equal(manual.axes[1].y, 61); // 40 + lineHeight(1) + 20

  const clamped = layoutAxes([3, 7], tree, 600, { mode: 'manual', manualSpacing: -5 });
  assert.equal(clamped.spacing, 1);

  const auto = layoutAxes([3, 7], tree, 600, AUTO_AXIS_SPACING);
  assert.ok(auto.spacing > 20, 'auto spacing spreads two axes across 600px');
});
