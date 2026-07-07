import { test } from 'bun:test';
import assert from 'node:assert';
import { EventLogTableFilterMode, DEFAULT_TABLE_RENDER_MODES } from '@omnetpp/shared/elog-protocol';
import { buildTableContextMenu, type TableMenuActions, type TableMenuBuildParams } from '../eventlog/table/tableContextMenu';
import type { MenuEntry } from '../eventlog/common/contextMenu';

function fakeActions(): TableMenuActions & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls[name] = args;
    };
  return {
    calls,
    gotoCause: record('gotoCause'),
    gotoArrival: record('gotoArrival'),
    gotoOrigin: record('gotoOrigin'),
    gotoReuse: record('gotoReuse'),
    gotoPrevEvent: record('gotoPrevEvent'),
    gotoNextEvent: record('gotoNextEvent'),
    gotoPrevModuleEvent: record('gotoPrevModuleEvent'),
    gotoNextModuleEvent: record('gotoNextModuleEvent'),
    toggleBookmark: record('toggleBookmark'),
    copySelection: record('copySelection'),
    openFindBar: record('openFindBar'),
    refresh: record('refresh'),
    openFilter: record('openFilter'),
    gotoNedDeclaration: record('gotoNedDeclaration'),
    setLineFilterMode: record('setLineFilterMode'),
    setTypeMode: record('setTypeMode'),
    setNameMode: record('setNameMode'),
    setDisplayMode: record('setDisplayMode'),
  };
}

/** Defaults for the fields every test doesn't care about, spread + overridden per test (phase U10 added `currentFilterMode`/`currentModes`, both required). */
function baseParams(overrides: Partial<TableMenuBuildParams> & Pick<TableMenuBuildParams, 'hasFocus' | 'hasSelection' | 'focusedRowNedTypeName' | 'actions'>): TableMenuBuildParams {
  return { currentFilterMode: EventLogTableFilterMode.ALL_ENTRIES, currentModes: DEFAULT_TABLE_RENDER_MODES, ...overrides };
}

function findEntry(entries: MenuEntry[], id: string): MenuEntry | undefined {
  return entries.find((e) => 'id' in e && e.id === id);
}

test('buildTableContextMenu: includes the full Go To family plus bookmark/copy/find/refresh/view-mode submenus', () => {
  const actions = fakeActions();
  const entries = buildTableContextMenu(baseParams({ hasFocus: true, hasSelection: true, focusedRowNedTypeName: null, actions }));
  for (const id of [
    'gotoCause',
    'gotoArrival',
    'gotoOrigin',
    'gotoReuse',
    'gotoPrevEvent',
    'gotoNextEvent',
    'gotoPrevModuleEvent',
    'gotoNextModuleEvent',
    'toggleBookmark',
    'gotoNedDeclaration',
    'copy',
    'findText',
    'filter',
    'lineFilterMode',
    'typeMode',
    'nameMode',
    'displayMode',
    'refresh',
  ]) {
    assert.ok(findEntry(entries, id), `expected menu entry "${id}"`);
  }
});

test('buildTableContextMenu: "Filter Event Log..." is always available and calls openFilter', () => {
  const actions = fakeActions();
  const entries = buildTableContextMenu(baseParams({ hasFocus: false, hasSelection: false, focusedRowNedTypeName: null, actions }));
  const entry = findEntry(entries, 'filter')! as { onSelect: () => void; disabled?: boolean };
  assert.ok(!entry.disabled);
  entry.onSelect();
  assert.ok(actions.calls.openFilter);
});

test('buildTableContextMenu: "Go To" family items invoke their wired action', () => {
  const actions = fakeActions();
  const entries = buildTableContextMenu(baseParams({ hasFocus: true, hasSelection: false, focusedRowNedTypeName: null, actions }));
  for (const [id, actionName] of [
    ['gotoCause', 'gotoCause'],
    ['gotoArrival', 'gotoArrival'],
    ['gotoOrigin', 'gotoOrigin'],
    ['gotoReuse', 'gotoReuse'],
    ['gotoPrevEvent', 'gotoPrevEvent'],
    ['gotoNextEvent', 'gotoNextEvent'],
    ['gotoPrevModuleEvent', 'gotoPrevModuleEvent'],
    ['gotoNextModuleEvent', 'gotoNextModuleEvent'],
    ['toggleBookmark', 'toggleBookmark'],
  ] as const) {
    const entry = findEntry(entries, id);
    assert.ok(entry && 'onSelect' in entry && entry.onSelect);
    (entry as { onSelect: () => void }).onSelect();
    assert.ok(actions.calls[actionName], `expected ${actionName} to have been called`);
  }
});

test('buildTableContextMenu: "Go To"/bookmark family disabled when nothing is focused (empty table)', () => {
  const actions = fakeActions();
  const entries = buildTableContextMenu(baseParams({ hasFocus: false, hasSelection: false, focusedRowNedTypeName: null, actions }));
  for (const id of ['gotoCause', 'gotoArrival', 'gotoOrigin', 'gotoReuse', 'gotoPrevEvent', 'gotoNextEvent', 'gotoPrevModuleEvent', 'gotoNextModuleEvent', 'toggleBookmark']) {
    const entry = findEntry(entries, id);
    assert.ok(entry && 'disabled' in entry && entry.disabled, `expected "${id}" disabled`);
  }
  // find / refresh are always available regardless of focus
  for (const id of ['findText', 'refresh']) {
    const entry = findEntry(entries, id);
    assert.ok(entry && !('disabled' in entry && entry.disabled), `expected "${id}" enabled`);
  }
});

test('buildTableContextMenu: Copy disabled without a selection', () => {
  const actions = fakeActions();
  const entries = buildTableContextMenu(baseParams({ hasFocus: true, hasSelection: false, focusedRowNedTypeName: null, actions }));
  const copy = findEntry(entries, 'copy');
  assert.ok(copy && 'disabled' in copy && copy.disabled);
});

// ---------------------------------------------------------------------------------
// "Go to NED Declaration" (phase U10)
// ---------------------------------------------------------------------------------

test('buildTableContextMenu: "Go to NED Declaration" enabled and wired when the focused row has a resolvable NED type name', () => {
  const actions = fakeActions();
  const entries = buildTableContextMenu(baseParams({ hasFocus: true, hasSelection: false, focusedRowNedTypeName: 'inet.node.Host', actions }));
  const entry = findEntry(entries, 'gotoNedDeclaration')! as { disabled?: boolean; onSelect: () => void };
  assert.ok(!entry.disabled);
  entry.onSelect();
  assert.ok(actions.calls.gotoNedDeclaration);
});

test('buildTableContextMenu: "Go to NED Declaration" disabled when the focused row has no resolvable NED type name (even though something is focused)', () => {
  const actions = fakeActions();
  const entries = buildTableContextMenu(baseParams({ hasFocus: true, hasSelection: false, focusedRowNedTypeName: null, actions }));
  const entry = findEntry(entries, 'gotoNedDeclaration')! as { disabled?: boolean };
  assert.ok(entry.disabled);
});

// ---------------------------------------------------------------------------------
// view-mode radio submenus (phase U10 cheap gap -- previously toolbar-only)
// ---------------------------------------------------------------------------------

test('buildTableContextMenu: Line Filter submenu has 5 radio entries, current mode checked, others not, and selecting one calls setLineFilterMode', () => {
  const actions = fakeActions();
  const entries = buildTableContextMenu(baseParams({ hasFocus: true, hasSelection: false, focusedRowNedTypeName: null, actions, currentFilterMode: EventLogTableFilterMode.EVENT_ENTRIES }));
  const lineFilter = findEntry(entries, 'lineFilterMode')! as { submenu: MenuEntry[] };
  assert.equal(lineFilter.submenu.length, 5);
  const checkedEntries = lineFilter.submenu.filter((e) => 'checked' in e && e.checked);
  assert.equal(checkedEntries.length, 1);
  assert.equal((checkedEntries[0] as { label: string }).label, 'Events only');
  const custom = lineFilter.submenu.find((e) => 'label' in e && e.label === 'Custom...') as { onSelect: () => void };
  custom.onSelect();
  assert.deepEqual(actions.calls.setLineFilterMode, [EventLogTableFilterMode.CUSTOM_ENTRIES]);
});

test('buildTableContextMenu: Type/Name/Display Mode submenus check the current mode and wire their setters', () => {
  const actions = fakeActions();
  const entries = buildTableContextMenu(baseParams({ hasFocus: true, hasSelection: false, focusedRowNedTypeName: null, actions, currentModes: { displayMode: 'RAW', nameMode: 'FULL_PATH', typeMode: 'NED' } }));

  const typeMode = findEntry(entries, 'typeMode')! as { submenu: MenuEntry[] };
  const nedType = typeMode.submenu.find((e) => 'label' in e && e.label === 'NED type') as { checked?: boolean; onSelect: () => void };
  assert.ok(nedType.checked);
  const cppType = typeMode.submenu.find((e) => 'label' in e && e.label === 'C++ type') as { checked?: boolean; onSelect: () => void };
  assert.ok(!cppType.checked);
  cppType.onSelect();
  assert.deepEqual(actions.calls.setTypeMode, ['CPP']);

  const nameMode = findEntry(entries, 'nameMode')! as { submenu: MenuEntry[] };
  const fullPath = nameMode.submenu.find((e) => 'label' in e && e.label === 'Full path') as { checked?: boolean };
  assert.ok(fullPath.checked);

  const displayMode = findEntry(entries, 'displayMode')! as { submenu: MenuEntry[] };
  const raw = displayMode.submenu.find((e) => 'label' in e && e.label === 'Raw') as { checked?: boolean; onSelect: () => void };
  assert.ok(raw.checked);
  const descriptive = displayMode.submenu.find((e) => 'label' in e && e.label === 'Descriptive') as { onSelect: () => void };
  descriptive.onSelect();
  assert.deepEqual(actions.calls.setDisplayMode, ['DESCRIPTIVE']);
});
