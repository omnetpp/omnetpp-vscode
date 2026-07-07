/**
 * tableContextMenu.ts (PURE) -- decides WHAT appears in the Event Log table's context
 * menu, per `EventLogTableContributor.java`'s action set (read in full -- see
 * `@omnetpp/shared/elog-protocol`'s `TableGotoRelation` doc comment for the exact
 * per-action citations/keybindings this mirrors). Returns a `MenuEntry[]`
 * (`common/contextMenu.ts`'s generic DOM framework renders it -- the same one
 * `chartContextMenu.ts` uses, per that framework's own header note "table will reuse in
 * U6"). No DOM, fully unit-testable.
 *
 * The "Go To" family's keyboard equivalents (Ctrl+Up/Down, Alt+Up/Down, Shift+Up/Down)
 * live in `tableView.ts`'s `handleKeyDown()`; this menu is the discoverable,
 * mouse-driven surface for the same actions PLUS the two Java gives no accelerator at
 * all (Origin/Reuse) -- see that file's own header.
 */

import type { MenuEntry } from '../common/contextMenu';

export interface TableMenuActions {
  gotoCause(): void;
  gotoArrival(): void;
  gotoOrigin(): void;
  gotoReuse(): void;
  gotoPrevEvent(): void;
  gotoNextEvent(): void;
  gotoPrevModuleEvent(): void;
  gotoNextModuleEvent(): void;
  toggleBookmark(): void;
  copySelection(): void;
  openFindBar(): void;
  refresh(): void;
}

export interface TableMenuBuildParams {
  /** `false` when no row is focused (an empty table) -- disables the "Go To" family, which is relative to the focused row and would otherwise silently no-op. */
  hasFocus: boolean;
  /** `true` iff at least one row is currently selected -- gates "Copy". */
  hasSelection: boolean;
  actions: TableMenuActions;
}

export function buildTableContextMenu(params: TableMenuBuildParams): MenuEntry[] {
  const { hasFocus, hasSelection, actions } = params;
  const entries: MenuEntry[] = [
    { id: 'gotoCause', label: 'Go to Event Cause', disabled: !hasFocus, onSelect: actions.gotoCause },
    { id: 'gotoArrival', label: 'Go to Message Arrival', disabled: !hasFocus, onSelect: actions.gotoArrival },
    { id: 'gotoOrigin', label: 'Go to Message Origin', disabled: !hasFocus, onSelect: actions.gotoOrigin },
    { id: 'gotoReuse', label: 'Go to Message Reuse', disabled: !hasFocus, onSelect: actions.gotoReuse },
    { separator: true },
    { id: 'gotoPrevEvent', label: 'Go to Previous Event', disabled: !hasFocus, onSelect: actions.gotoPrevEvent },
    { id: 'gotoNextEvent', label: 'Go to Next Event', disabled: !hasFocus, onSelect: actions.gotoNextEvent },
    { id: 'gotoPrevModuleEvent', label: 'Go to Previous Module Event', disabled: !hasFocus, onSelect: actions.gotoPrevModuleEvent },
    { id: 'gotoNextModuleEvent', label: 'Go to Next Module Event', disabled: !hasFocus, onSelect: actions.gotoNextModuleEvent },
    { separator: true },
    { id: 'toggleBookmark', label: 'Toggle Bookmark', disabled: !hasFocus, onSelect: actions.toggleBookmark },
    { separator: true },
    { id: 'copy', label: 'Copy', disabled: !hasSelection, onSelect: actions.copySelection },
    { id: 'findText', label: 'Find Text...', onSelect: actions.openFindBar },
    { separator: true },
    { id: 'refresh', label: 'Refresh', icon: 'refresh', onSelect: actions.refresh },
  ];
  return entries;
}
