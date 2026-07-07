import { test } from 'bun:test';
import assert from 'node:assert';
import { buildTableContextMenu, type TableMenuActions } from '../eventlog/table/tableContextMenu';
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
  };
}

function findEntry(entries: MenuEntry[], id: string): MenuEntry | undefined {
  return entries.find((e) => 'id' in e && e.id === id);
}

test('buildTableContextMenu: includes the full Go To family plus bookmark/copy/find/refresh', () => {
  const actions = fakeActions();
  const entries = buildTableContextMenu({ hasFocus: true, hasSelection: true, actions });
  for (const id of ['gotoCause', 'gotoArrival', 'gotoOrigin', 'gotoReuse', 'gotoPrevEvent', 'gotoNextEvent', 'gotoPrevModuleEvent', 'gotoNextModuleEvent', 'toggleBookmark', 'copy', 'findText', 'filter', 'refresh']) {
    assert.ok(findEntry(entries, id), `expected menu entry "${id}"`);
  }
});

test('buildTableContextMenu: "Filter Event Log..." is always available and calls openFilter', () => {
  const actions = fakeActions();
  const entries = buildTableContextMenu({ hasFocus: false, hasSelection: false, actions });
  const entry = findEntry(entries, 'filter')! as { onSelect: () => void; disabled?: boolean };
  assert.ok(!entry.disabled);
  entry.onSelect();
  assert.ok(actions.calls.openFilter);
});

test('buildTableContextMenu: "Go To" family items invoke their wired action', () => {
  const actions = fakeActions();
  const entries = buildTableContextMenu({ hasFocus: true, hasSelection: false, actions });
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
  const entries = buildTableContextMenu({ hasFocus: false, hasSelection: false, actions });
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
  const entries = buildTableContextMenu({ hasFocus: true, hasSelection: false, actions });
  const copy = findEntry(entries, 'copy');
  assert.ok(copy && 'disabled' in copy && copy.disabled);
});
