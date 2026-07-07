import { test } from 'bun:test';
import assert from 'node:assert';
import { TimelineMode } from '@omnetpp/shared/elog-protocol';
import { buildChartContextMenu, type ChartMenuActions } from '../eventlog/chart/chartContextMenu';
import { DEFAULT_DISPLAY_FLAGS } from '../eventlog/chart/displayFlags';
import type { MenuEntry } from '../eventlog/common/contextMenu';
import type { HitObject } from '../eventlog/chart/hitTest';

function fakeActions(): ChartMenuActions & Record<string, unknown> {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string) => (...args: unknown[]) => {
    calls[name] = args;
  };
  return {
    calls,
    selectEvent: record('selectEvent'),
    centerOnEvent: record('centerOnEvent'),
    goToCauseEvent: record('goToCauseEvent'),
    goToConsequenceEvent: record('goToConsequenceEvent'),
    zoomToDependency: record('zoomToDependency'),
    centerOnAxis: record('centerOnAxis'),
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
  const entries = buildChartContextMenu({ hits: [], resolveDependencyLabel: () => null, currentTimelineMode: TimelineMode.SIMULATION_TIME, actions, displayFlags: DEFAULT_DISPLAY_FLAGS });
  assert.ok(!findEntry(entries, 'event-1'));
  assert.ok(findEntry(entries, 'timelineMode'));
  assert.ok(findEntry(entries, 'zoom'));
  assert.ok(findEntry(entries, 'gotoMenu'));
  assert.ok(findEntry(entries, 'refresh'));
});

test('buildChartContextMenu: an event hit gets its own submenu with Select/Center wired + Filter disabled', () => {
  const actions = fakeActions();
  const hits: HitObject[] = [{ kind: 'event', eventNumber: 42, moduleId: 3 }];
  const entries = buildChartContextMenu({ hits, resolveDependencyLabel: () => null, currentTimelineMode: TimelineMode.SIMULATION_TIME, actions, displayFlags: DEFAULT_DISPLAY_FLAGS });
  const sub = submenuOf(entries, 'event-42');
  const select = findEntry(sub, 'select')!;
  assert.ok('onSelect' in select);
  (select as { onSelect: () => void }).onSelect();
  assert.deepEqual(actions.calls.selectEvent, [42]);

  const center = findEntry(sub, 'center')! as { onSelect: () => void };
  center.onSelect();
  assert.deepEqual(actions.calls.centerOnEvent, [42]);

  const filter = findEntry(sub, 'filter')!;
  assert.ok('disabled' in filter && filter.disabled, 'Filter Causes/Consequences is disabled -- deferred to U7');
});

test('buildChartContextMenu: two overlapping events each get their own section', () => {
  const actions = fakeActions();
  const hits: HitObject[] = [
    { kind: 'event', eventNumber: 5, moduleId: 1 },
    { kind: 'event', eventNumber: 6, moduleId: 2 },
  ];
  const entries = buildChartContextMenu({ hits, resolveDependencyLabel: () => null, currentTimelineMode: TimelineMode.SIMULATION_TIME, actions, displayFlags: DEFAULT_DISPLAY_FLAGS });
  assert.ok(findEntry(entries, 'event-5'));
  assert.ok(findEntry(entries, 'event-6'));
});

test('buildChartContextMenu: dependency hit -- Go to Cause/Consequence + Zoom to Message wired, Filter Message disabled, title from resolveDependencyLabel', () => {
  const actions = fakeActions();
  const hits: HitObject[] = [{ kind: 'dependency', dependencyKind: 'send', causeEventNumber: 1, consequenceEventNumber: 2, causeTc: 10, consequenceTc: 20 }];
  const entries = buildChartContextMenu({ hits, resolveDependencyLabel: () => 'msgA', currentTimelineMode: TimelineMode.SIMULATION_TIME, actions, displayFlags: DEFAULT_DISPLAY_FLAGS });
  const depEntry = findEntry(entries, 'dep-1-2')!;
  assert.equal((depEntry as { label: string }).label, 'msgA');
  const sub = submenuOf(entries, 'dep-1-2');

  (findEntry(sub, 'gotoCause') as { onSelect: () => void }).onSelect();
  assert.deepEqual(actions.calls.goToCauseEvent, [1]);
  (findEntry(sub, 'gotoConsequence') as { onSelect: () => void }).onSelect();
  assert.deepEqual(actions.calls.goToConsequenceEvent, [2]);
  (findEntry(sub, 'zoomToMessage') as { onSelect: () => void }).onSelect();
  assert.deepEqual(actions.calls.zoomToDependency, [10, 20]);
  assert.ok((findEntry(sub, 'filterMessage') as { disabled: boolean }).disabled);
});

test('buildChartContextMenu: unresolvable dependency label falls back to a generic placeholder', () => {
  const actions = fakeActions();
  const hits: HitObject[] = [{ kind: 'dependency', dependencyKind: 'send', causeEventNumber: 1, consequenceEventNumber: 2, causeTc: 0, consequenceTc: 1 }];
  const entries = buildChartContextMenu({ hits, resolveDependencyLabel: () => null, currentTimelineMode: TimelineMode.SIMULATION_TIME, actions, displayFlags: DEFAULT_DISPLAY_FLAGS });
  const depEntry = findEntry(entries, 'dep-1-2')! as { label: string };
  assert.equal(depEntry.label, '(message)');
});

test('buildChartContextMenu: axis hit -- Center wired, Open Module + more-actions disabled (U8)', () => {
  const actions = fakeActions();
  const hits: HitObject[] = [{ kind: 'axis', moduleId: 7 }];
  const entries = buildChartContextMenu({ hits, resolveDependencyLabel: () => null, currentTimelineMode: TimelineMode.SIMULATION_TIME, actions, displayFlags: DEFAULT_DISPLAY_FLAGS });
  const sub = submenuOf(entries, 'axis-7');
  (findEntry(sub, 'center') as { onSelect: () => void }).onSelect();
  assert.deepEqual(actions.calls.centerOnAxis, [7]);
  assert.ok((findEntry(sub, 'openModule') as { disabled: boolean }).disabled);
});

test('buildChartContextMenu: methodCall hits do not get a dedicated section (matches Java -- verified no such submenu in SequenceChartContributor)', () => {
  const actions = fakeActions();
  const hits: HitObject[] = [{ kind: 'methodCall', eventNumber: 1, sourceModuleId: 1, targetModuleId: 2, tc: 5 }];
  const entries = buildChartContextMenu({ hits, resolveDependencyLabel: () => null, currentTimelineMode: TimelineMode.SIMULATION_TIME, actions, displayFlags: DEFAULT_DISPLAY_FLAGS });
  assert.ok(!entries.some((e) => 'id' in e && e.id.startsWith('call-')));
});

test('buildChartContextMenu: Timeline Mode submenu has a checked radio matching currentTimelineMode', () => {
  const actions = fakeActions();
  const entries = buildChartContextMenu({ hits: [], resolveDependencyLabel: () => null, currentTimelineMode: TimelineMode.EVENT_NUMBER, actions, displayFlags: DEFAULT_DISPLAY_FLAGS });
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
  const entries = buildChartContextMenu({ hits: [], resolveDependencyLabel: () => null, currentTimelineMode: TimelineMode.SIMULATION_TIME, actions, displayFlags: DEFAULT_DISPLAY_FLAGS });
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
  const entries = buildChartContextMenu({ hits: [], resolveDependencyLabel: () => null, currentTimelineMode: TimelineMode.SIMULATION_TIME, actions, displayFlags: DEFAULT_DISPLAY_FLAGS });
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
  const entries = buildChartContextMenu({ hits: [], resolveDependencyLabel: () => null, currentTimelineMode: TimelineMode.SIMULATION_TIME, actions, displayFlags: DEFAULT_DISPLAY_FLAGS });
  (findEntry(entries, 'findText') as { onSelect: () => void }).onSelect();
  assert.ok(actions.calls.openFindTextDialog);
  (findEntry(entries, 'findNext') as { onSelect: () => void }).onSelect();
  assert.ok(actions.calls.findNext);
  (findEntry(entries, 'refresh') as { onSelect: () => void }).onSelect();
  assert.ok(actions.calls.refresh);
});

test('buildChartContextMenu: deferred static items (Select Modules, Filter dropdown, etc.) are not present at all', () => {
  const actions = fakeActions();
  const entries = buildChartContextMenu({ hits: [], resolveDependencyLabel: () => null, currentTimelineMode: TimelineMode.SIMULATION_TIME, actions, displayFlags: DEFAULT_DISPLAY_FLAGS });
  const ids = entries.filter((e): e is Extract<MenuEntry, { id: string }> => 'id' in e).map((e) => e.id);
  for (const deferred of ['selectModules', 'presetConfiguration', 'axisOrderingMode', 'filter', 'configureStyle', 'spacing', 'changeFont', 'bookmark', 'pin', 'releaseMemory', 'selfTest', 'copyToClipboard', 'exportToSvg', 'showIn']) {
    assert.ok(!ids.includes(deferred), `"${deferred}" must not appear (deferred to a later phase)`);
  }
});

// ---------------------------------------------------------------------------------
// Show/Hide submenu (phase U5)
// ---------------------------------------------------------------------------------

test('buildChartContextMenu: Show/Hide submenu lists every toggle, checked state mirrors displayFlags, and toggling one calls toggleDisplayFlag with that key', () => {
  const actions = fakeActions();
  const flags = { ...DEFAULT_DISPLAY_FLAGS, showEventNumbers: false };
  const entries = buildChartContextMenu({ hits: [], resolveDependencyLabel: () => null, currentTimelineMode: TimelineMode.SIMULATION_TIME, actions, displayFlags: flags });
  const sub = submenuOf(entries, 'showHide');
  assert.ok(sub.length >= 24, 'expected ~25 Show/Hide toggles');

  const eventNumbersEntry = findEntry(sub, 'flag-showEventNumbers')! as { checked: boolean; onSelect: () => void };
  assert.equal(eventNumbersEntry.checked, false);
  eventNumbersEntry.onSelect();
  assert.deepEqual(actions.calls.toggleDisplayFlag, ['showEventNumbers']);

  const arrowHeadsEntry = findEntry(sub, 'flag-showArrowHeads')! as { checked: boolean };
  assert.equal(arrowHeadsEntry.checked, true);
});
