import { test } from 'bun:test';
import assert from 'node:assert';
import { TimelineMode } from '@omnetpp/shared/elog-protocol';
import { buildChartContextMenu, buildShowHideEntries, type AxisModuleMenuInfo, type ChartMenuActions, type ChartMenuBuildParams } from '../eventlog/chart/chartContextMenu';
import { DEFAULT_DISPLAY_FLAGS } from '../eventlog/chart/displayFlags';
import type { MenuEntry } from '../eventlog/common/contextMenu';
import type { HitObject } from '../eventlog/chart/hitTest';

/** Shared param defaults so each test only names what it varies (phase U8 grew the required param set). */
function makeParams(actions: ChartMenuActions, overrides: Partial<ChartMenuBuildParams> = {}): ChartMenuBuildParams {
  return {
    hits: [],
    resolveDependencyLabel: () => null,
    resolveDependencyMessageId: () => null,
    currentTimelineMode: TimelineMode.SIMULATION_TIME,
    currentAxisOrderingMode: 'moduleId',
    resolveAxisInfo: () => null,
    actions,
    displayFlags: DEFAULT_DISPLAY_FLAGS,
    ...overrides,
  };
}

function fakeActions(): ChartMenuActions & Record<string, unknown> {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string) => (...args: unknown[]) => {
    calls[name] = args;
  };
  return {
    calls,
    selectEvent: record('selectEvent'),
    centerOnEvent: record('centerOnEvent'),
    selectInTable: record('selectInTable'),
    goToCauseEvent: record('goToCauseEvent'),
    goToConsequenceEvent: record('goToConsequenceEvent'),
    zoomToDependency: record('zoomToDependency'),
    toggleEventBookmark: record('toggleEventBookmark'),
    toggleDependencyBookmark: record('toggleDependencyBookmark'),
    toggleAxisBookmark: record('toggleAxisBookmark'),
    centerOnAxis: record('centerOnAxis'),
    filterCausesConsequences: record('filterCausesConsequences'),
    filterMessage: record('filterMessage'),
    setTimelineMode: record('setTimelineMode'),
    zoomIn: record('zoomIn'),
    zoomOut: record('zoomOut'),
    defaultZoom: record('defaultZoom'),
    zoomToFitAll: record('zoomToFitAll'),
    openGotoEventDialog: record('openGotoEventDialog'),
    openGotoSimTimeDialog: record('openGotoSimTimeDialog'),
    gotoBegin: record('gotoBegin'),
    gotoEnd: record('gotoEnd'),
    openFindTextDialog: record('openFindTextDialog'),
    findNext: record('findNext'),
    refresh: record('refresh'),
    toggleDisplayFlag: record('toggleDisplayFlag'),
    removeAxisModule: record('removeAxisModule'),
    openCompoundModule: record('openCompoundModule'),
    openParentModule: record('openParentModule'),
    expandAxisModule: record('expandAxisModule'),
    expandAxisModuleRecursively: record('expandAxisModuleRecursively'),
    collapseAxisModule: record('collapseAxisModule'),
    collapseAxisModuleSubmodules: record('collapseAxisModuleSubmodules'),
    openSelectModulesDialog: record('openSelectModulesDialog'),
    applyPreset: record('applyPreset'),
    setAxisOrderingMode: record('setAxisOrderingMode'),
    spacingBalanced: record('spacingBalanced'),
    spacingDense: record('spacingDense'),
    spacingIncrease: record('spacingIncrease'),
    spacingDecrease: record('spacingDecrease'),
    releaseMemory: record('releaseMemory'),
    copyImage: record('copyImage'),
    exportSvg: record('exportSvg'),
    gotoNedDeclaration: record('gotoNedDeclaration'),
  } as unknown as ChartMenuActions & Record<string, unknown>;
}

function findEntry(entries: MenuEntry[], id: string): MenuEntry | undefined {
  return entries.find((e) => 'id' in e && e.id === id);
}

function submenuOf(entries: MenuEntry[], id: string): MenuEntry[] {
  const entry = findEntry(entries, id);
  if (!entry || !('submenu' in entry) || !entry.submenu) throw new Error(`no submenu for ${id}`);
  return entry.submenu;
}

test('buildChartContextMenu: no hits -- only the static tail appears', () => {
  const actions = fakeActions();
  const entries = buildChartContextMenu(makeParams(actions));
  assert.ok(!findEntry(entries, 'event-1'));
  assert.ok(findEntry(entries, 'timelineMode'));
  assert.ok(findEntry(entries, 'zoom'));
  assert.ok(findEntry(entries, 'gotoMenu'));
  assert.ok(findEntry(entries, 'refresh'));
});

test('buildChartContextMenu: an event hit gets its own submenu with Select/Center/Filter Causes-Consequences wired', () => {
  const actions = fakeActions();
  const hits: HitObject[] = [{ kind: 'event', eventNumber: 42, moduleId: 3 }];
  const entries = buildChartContextMenu(makeParams(actions, { hits }));
  const sub = submenuOf(entries, 'event-42');
  const select = findEntry(sub, 'select')!;
  assert.ok('onSelect' in select);
  (select as { onSelect: () => void }).onSelect();
  assert.deepEqual(actions.calls.selectEvent, [42]);

  const center = findEntry(sub, 'center')! as { onSelect: () => void };
  center.onSelect();
  assert.deepEqual(actions.calls.centerOnEvent, [42]);

  const selectInTable = findEntry(sub, 'selectInTable')! as { onSelect: () => void };
  selectInTable.onSelect();
  assert.deepEqual(actions.calls.selectInTable, [42]);

  const toggleBookmark = findEntry(sub, 'toggleBookmark')! as { onSelect: () => void };
  toggleBookmark.onSelect();
  assert.deepEqual(actions.calls.toggleEventBookmark, [42]);

  const filter = findEntry(sub, 'filter')! as { onSelect: () => void };
  filter.onSelect();
  assert.deepEqual(actions.calls.filterCausesConsequences, [42]);
});

test('buildChartContextMenu: two overlapping events each get their own section', () => {
  const actions = fakeActions();
  const hits: HitObject[] = [
    { kind: 'event', eventNumber: 5, moduleId: 1 },
    { kind: 'event', eventNumber: 6, moduleId: 2 },
  ];
  const entries = buildChartContextMenu(makeParams(actions, { hits }));
  assert.ok(findEntry(entries, 'event-5'));
  assert.ok(findEntry(entries, 'event-6'));
});

test('buildChartContextMenu: dependency hit -- Go to Cause/Consequence + Zoom to Message + Filter Message wired, title from resolveDependencyLabel', () => {
  const actions = fakeActions();
  const hits: HitObject[] = [{ kind: 'dependency', dependencyKind: 'send', causeEventNumber: 1, consequenceEventNumber: 2, causeTc: 10, consequenceTc: 20 }];
  const entries = buildChartContextMenu(makeParams(actions, { hits, resolveDependencyLabel: () => 'msgA', resolveDependencyMessageId: () => 5 }));
  const depEntry = findEntry(entries, 'dep-1-2')!;
  assert.equal((depEntry as { label: string }).label, 'msgA');
  const sub = submenuOf(entries, 'dep-1-2');

  (findEntry(sub, 'gotoCause') as { onSelect: () => void }).onSelect();
  assert.deepEqual(actions.calls.goToCauseEvent, [1]);
  (findEntry(sub, 'gotoConsequence') as { onSelect: () => void }).onSelect();
  assert.deepEqual(actions.calls.goToConsequenceEvent, [2]);
  (findEntry(sub, 'zoomToMessage') as { onSelect: () => void }).onSelect();
  assert.deepEqual(actions.calls.zoomToDependency, [10, 20]);
  (findEntry(sub, 'toggleBookmark') as { onSelect: () => void }).onSelect();
  assert.deepEqual(actions.calls.toggleDependencyBookmark, [hits[0]]);
  const filterMessage = findEntry(sub, 'filterMessage')! as { disabled: boolean; onSelect: () => void };
  assert.ok(!filterMessage.disabled, 'a resolvable messageId enables Filter Message...');
  filterMessage.onSelect();
  assert.deepEqual(actions.calls.filterMessage, [hits[0]]);
});

test('buildChartContextMenu: dependency hit with no resolvable messageId disables Filter Message...', () => {
  const actions = fakeActions();
  const hits: HitObject[] = [{ kind: 'dependency', dependencyKind: 'filtered', causeEventNumber: 1, consequenceEventNumber: 2, causeTc: 10, consequenceTc: 20 }];
  const entries = buildChartContextMenu(makeParams(actions, { hits, resolveDependencyLabel: () => 'gap' }));
  const sub = submenuOf(entries, 'dep-1-2');
  assert.ok((findEntry(sub, 'filterMessage') as { disabled: boolean }).disabled);
});

test('buildChartContextMenu: unresolvable dependency label falls back to a generic placeholder', () => {
  const actions = fakeActions();
  const hits: HitObject[] = [{ kind: 'dependency', dependencyKind: 'send', causeEventNumber: 1, consequenceEventNumber: 2, causeTc: 0, consequenceTc: 1 }];
  const entries = buildChartContextMenu(makeParams(actions, { hits }));
  const depEntry = findEntry(entries, 'dep-1-2')! as { label: string };
  assert.equal(depEntry.label, '(message)');
});

test('buildChartContextMenu: axis hit -- full U8 action set wired, enablement from resolveAxisInfo', () => {
  const actions = fakeActions();
  const hits: HitObject[] = [{ kind: 'axis', moduleId: 7 }];
  const info: AxisModuleMenuInfo = { label: 'net.host[7] (id = 7)', hasParent: true, canExpand: true, canCollapse: false, nedTypeName: 'inet.node.Host' };
  const entries = buildChartContextMenu(makeParams(actions, { hits, resolveAxisInfo: () => info }));
  const axisEntry = findEntry(entries, 'axis-7')! as { label: string };
  assert.equal(axisEntry.label, 'net.host[7] (id = 7)');
  const sub = submenuOf(entries, 'axis-7');
  (findEntry(sub, 'center') as { onSelect: () => void }).onSelect();
  assert.deepEqual(actions.calls.centerOnAxis, [7]);
  (findEntry(sub, 'toggleBookmark') as { onSelect: () => void }).onSelect();
  assert.deepEqual(actions.calls.toggleAxisBookmark, [7]);
  const gotoNed = findEntry(sub, 'gotoNedDeclaration')! as { disabled?: boolean; onSelect: () => void };
  assert.ok(!gotoNed.disabled, 'a resolvable nedTypeName enables Go to NED Declaration');
  gotoNed.onSelect();
  assert.deepEqual(actions.calls.gotoNedDeclaration, [7]);

  for (const [id, name] of [
    ['removeAxisModule', 'removeAxisModule'],
    ['openCompoundModule', 'openCompoundModule'],
    ['openParentModule', 'openParentModule'],
    ['expandAxisModule', 'expandAxisModule'],
    ['expandAxisModuleRecursively', 'expandAxisModuleRecursively'],
  ] as const) {
    const item = findEntry(sub, id)! as { disabled?: boolean; onSelect: () => void };
    assert.ok(!item.disabled, `${id} should be enabled`);
    item.onSelect();
    assert.deepEqual(actions.calls[name], [7], `${name} should receive the module id`);
  }
  // canCollapse false -> both collapse variants disabled (Java greys via noSubmodulesOpen)
  assert.ok((findEntry(sub, 'collapseAxisModule') as { disabled: boolean }).disabled);
  assert.ok((findEntry(sub, 'collapseAxisModuleSubmodules') as { disabled: boolean }).disabled);
});

test('buildChartContextMenu: axis hit with NO module tree (resolveAxisInfo null) -- axis-management items disabled, Center/Bookmark still live', () => {
  const actions = fakeActions();
  const hits: HitObject[] = [{ kind: 'axis', moduleId: 7 }];
  const entries = buildChartContextMenu(makeParams(actions, { hits }));
  const sub = submenuOf(entries, 'axis-7');
  for (const id of ['removeAxisModule', 'openCompoundModule', 'openParentModule', 'expandAxisModule', 'expandAxisModuleRecursively', 'collapseAxisModule', 'collapseAxisModuleSubmodules']) {
    assert.ok((findEntry(sub, id) as { disabled: boolean }).disabled, `${id} should be disabled without a module tree`);
  }
  assert.ok((findEntry(sub, 'gotoNedDeclaration') as { disabled: boolean }).disabled, 'Go to NED Declaration should be disabled without a module tree');
  (findEntry(sub, 'center') as { onSelect: () => void }).onSelect();
  assert.deepEqual(actions.calls.centerOnAxis, [7]);
});

test('buildChartContextMenu: axis hit with a resolved node but no NED type name -- "Go to NED Declaration" disabled, other axis-management items unaffected', () => {
  const actions = fakeActions();
  const hits: HitObject[] = [{ kind: 'axis', moduleId: 7 }];
  const info: AxisModuleMenuInfo = { label: 'net.host[7] (id = 7)', hasParent: true, canExpand: true, canCollapse: false, nedTypeName: null };
  const entries = buildChartContextMenu(makeParams(actions, { hits, resolveAxisInfo: () => info }));
  const sub = submenuOf(entries, 'axis-7');
  assert.ok((findEntry(sub, 'gotoNedDeclaration') as { disabled: boolean }).disabled);
  assert.ok(!(findEntry(sub, 'removeAxisModule') as { disabled: boolean }).disabled);
});

test('buildChartContextMenu: methodCall hits do not get a dedicated section (matches Java -- verified no such submenu in SequenceChartContributor)', () => {
  const actions = fakeActions();
  const hits: HitObject[] = [{ kind: 'methodCall', eventNumber: 1, sourceModuleId: 1, targetModuleId: 2, tc: 5 }];
  const entries = buildChartContextMenu(makeParams(actions, { hits }));
  assert.ok(!entries.some((e) => 'id' in e && e.id.startsWith('call-')));
});

test('buildChartContextMenu: Timeline Mode submenu has a checked radio matching currentTimelineMode', () => {
  const actions = fakeActions();
  const entries = buildChartContextMenu(makeParams(actions, { currentTimelineMode: TimelineMode.EVENT_NUMBER }));
  const sub = submenuOf(entries, 'timelineMode');
  const checked = sub.filter((e) => 'checked' in e && e.checked);
  assert.equal(checked.length, 1);
  assert.equal((checked[0] as { id: string }).id, `tm-${TimelineMode.EVENT_NUMBER}`);

  (findEntry(sub, `tm-${TimelineMode.STEP}`) as { onSelect: () => void }).onSelect();
  assert.deepEqual(actions.calls.setTimelineMode, [TimelineMode.STEP]);
  assert.ok((findEntry(sub, 'tm-custom') as { disabled: boolean }).disabled);
});

test('buildChartContextMenu: Zoom submenu wires all four actions', () => {
  const actions = fakeActions();
  const entries = buildChartContextMenu(makeParams(actions));
  const sub = submenuOf(entries, 'zoom');
  for (const [id, name] of [
    ['defaultZoom', 'defaultZoom'],
    ['zoomToFit', 'zoomToFitAll'],
    ['zoomIn', 'zoomIn'],
    ['zoomOut', 'zoomOut'],
  ] as const) {
    (findEntry(sub, id) as { onSelect: () => void }).onSelect();
    assert.ok(actions.calls[name], `${name} should have been called`);
  }
});

test('buildChartContextMenu: Go to submenu wires Event/SimTime dialogs + Begin/End', () => {
  const actions = fakeActions();
  const entries = buildChartContextMenu(makeParams(actions));
  const sub = submenuOf(entries, 'gotoMenu');
  (findEntry(sub, 'gotoEvent') as { onSelect: () => void }).onSelect();
  assert.ok(actions.calls.openGotoEventDialog);
  (findEntry(sub, 'gotoSimTime') as { onSelect: () => void }).onSelect();
  assert.ok(actions.calls.openGotoSimTimeDialog);
  (findEntry(sub, 'gotoBegin') as { onSelect: () => void }).onSelect();
  assert.ok(actions.calls.gotoBegin);
  (findEntry(sub, 'gotoEnd') as { onSelect: () => void }).onSelect();
  assert.ok(actions.calls.gotoEnd);
});

test('buildChartContextMenu: Find Text/Find Next/Refresh wired at the top level', () => {
  const actions = fakeActions();
  const entries = buildChartContextMenu(makeParams(actions));
  (findEntry(entries, 'findText') as { onSelect: () => void }).onSelect();
  assert.ok(actions.calls.openFindTextDialog);
  (findEntry(entries, 'findNext') as { onSelect: () => void }).onSelect();
  assert.ok(actions.calls.findNext);
  (findEntry(entries, 'refresh') as { onSelect: () => void }).onSelect();
  assert.ok(actions.calls.refresh);
});

test('buildChartContextMenu: still-deferred static items (Filter dropdown, Configure Style, etc.) are not present at all', () => {
  const actions = fakeActions();
  const entries = buildChartContextMenu(makeParams(actions));
  const ids = entries.filter((e): e is Extract<MenuEntry, { id: string }> => 'id' in e).map((e) => e.id);
  for (const deferred of ['filter', 'configureStyle', 'changeFont', 'bookmark', 'pin', 'selfTest', 'showIn']) {
    assert.ok(!ids.includes(deferred), `"${deferred}" must not appear (deferred to a later phase, or out of this port's scope)`);
  }
});

test('buildChartContextMenu: Release Memory/Copy Image to Clipboard/Export to SVG wired at the top level (phase U9)', () => {
  const actions = fakeActions();
  const entries = buildChartContextMenu(makeParams(actions));
  (findEntry(entries, 'releaseMemory') as { onSelect: () => void }).onSelect();
  assert.ok(actions.calls.releaseMemory);
  (findEntry(entries, 'copyImage') as { onSelect: () => void }).onSelect();
  assert.ok(actions.calls.copyImage);
  (findEntry(entries, 'exportSvg') as { onSelect: () => void }).onSelect();
  assert.ok(actions.calls.exportSvg);
});

// ---------------------------------------------------------------------------------
// Axis-management static sections (phase U8)
// ---------------------------------------------------------------------------------

test('buildChartContextMenu: Select Modules... wired at the top level', () => {
  const actions = fakeActions();
  const entries = buildChartContextMenu(makeParams(actions));
  (findEntry(entries, 'selectModules') as { onSelect: () => void }).onSelect();
  assert.ok(actions.calls.openSelectModulesDialog);
});

test('buildChartContextMenu: Preset Configuration submenu -- the 5 presets in contributor order, each dispatching applyPreset', () => {
  const actions = fakeActions();
  const entries = buildChartContextMenu(makeParams(actions));
  const sub = submenuOf(entries, 'presetConfiguration');
  const ids = sub.filter((e): e is Extract<MenuEntry, { id: string }> => 'id' in e).map((e) => e.id);
  assert.deepEqual(ids, ['preset-networkNode', 'preset-networkInterface', 'preset-fullDetail', 'preset-default', 'preset-empty']);
  for (const preset of ['networkNode', 'networkInterface', 'fullDetail', 'default', 'empty'] as const) {
    (findEntry(sub, `preset-${preset}`) as { onSelect: () => void }).onSelect();
    assert.deepEqual(actions.calls.applyPreset, [preset]);
  }
});

test('buildChartContextMenu: Axis Ordering Mode radios -- current mode checked, selection dispatches setAxisOrderingMode', () => {
  const actions = fakeActions();
  const entries = buildChartContextMenu(makeParams(actions, { currentAxisOrderingMode: 'minimizeCrossings' }));
  const sub = submenuOf(entries, 'axisOrderingMode');
  const checked = sub.filter((e) => 'checked' in e && e.checked);
  assert.equal(checked.length, 1);
  assert.equal((checked[0] as { id: string }).id, 'order-minimizeCrossings');
  (findEntry(sub, 'order-manual') as { onSelect: () => void }).onSelect();
  assert.deepEqual(actions.calls.setAxisOrderingMode, ['manual']);
  (findEntry(sub, 'order-moduleFullPath') as { onSelect: () => void }).onSelect();
  assert.deepEqual(actions.calls.setAxisOrderingMode, ['moduleFullPath']);
});

test('buildChartContextMenu: Spacing submenu wires all four actions', () => {
  const actions = fakeActions();
  const entries = buildChartContextMenu(makeParams(actions));
  const sub = submenuOf(entries, 'spacing');
  for (const [id, name] of [
    ['spacing-balanced', 'spacingBalanced'],
    ['spacing-dense', 'spacingDense'],
    ['spacing-increase', 'spacingIncrease'],
    ['spacing-decrease', 'spacingDecrease'],
  ] as const) {
    (findEntry(sub, id) as { onSelect: () => void }).onSelect();
    assert.ok(actions.calls[name], `${name} should have been called`);
  }
});

// ---------------------------------------------------------------------------------
// Show/Hide submenu (phase U5)
// ---------------------------------------------------------------------------------

test('buildChartContextMenu: Show/Hide submenu lists every toggle, checked state mirrors displayFlags, and toggling one calls toggleDisplayFlag with that key', () => {
  const actions = fakeActions();
  const flags = { ...DEFAULT_DISPLAY_FLAGS, showEventNumbers: false };
  const entries = buildChartContextMenu(makeParams(actions, { displayFlags: flags }));
  const sub = submenuOf(entries, 'showHide');
  assert.ok(sub.length >= 24, 'expected ~25 Show/Hide toggles');

  const eventNumbersEntry = findEntry(sub, 'flag-showEventNumbers')! as { checked: boolean; onSelect: () => void };
  assert.equal(eventNumbersEntry.checked, false);
  eventNumbersEntry.onSelect();
  assert.deepEqual(actions.calls.toggleDisplayFlag, ['showEventNumbers']);

  const arrowHeadsEntry = findEntry(sub, 'flag-showArrowHeads')! as { checked: boolean };
  assert.equal(arrowHeadsEntry.checked, true);
});

test('buildShowHideEntries (phase U10, chart toolbar Show/Hide button): same item list as the context menu submenu, standalone', () => {
  const flags = { ...DEFAULT_DISPLAY_FLAGS, showEventNumbers: false };
  const calls: unknown[][] = [];
  const entries = buildShowHideEntries(flags, { toggleDisplayFlag: (...args) => calls.push(args) });
  assert.ok(entries.length >= 24, 'expected ~25 Show/Hide toggles');
  const eventNumbersEntry = findEntry(entries, 'flag-showEventNumbers')! as { checked: boolean; onSelect: () => void };
  assert.equal(eventNumbersEntry.checked, false);
  eventNumbersEntry.onSelect();
  assert.deepEqual(calls[0], ['showEventNumbers']);
});
