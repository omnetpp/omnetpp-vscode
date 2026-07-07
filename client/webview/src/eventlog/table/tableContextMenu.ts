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
 *
 * Phase U10 ADDS "Go to NED Declaration" for the focused row, when its entry describes a
 * module (`ModuleCreatedEntry`/`ModuleFoundEntry`) -- mirrors the Sequence Chart axis
 * menu's own item of the same name (`chartContextMenu.ts`'s `axisSection()`); see
 * `uiProtocol.ts`'s `gotoNedDeclaration` message doc for the resolution path.
 *
 * Phase U10 (cheap gap, parity-audit closure) ADDS the four view-mode radio submenus
 * `EventLogTableContributor.java`'s popup also carries (`lineFilterModeAction`,
 * `typeModeAction`, `nameModeAction`, `displayModeAction`) -- previously toolbar-only in
 * the port. Placed in the same relative order as Java's `contributeToPopupMenu()`:
 * filterAction, lineFilterModeAction, separator, typeModeAction, nameModeAction,
 * displayModeAction (Java's own order interleaves typeMode before nameMode). Each
 * radio's values/labels are the exact same ones `tableView.ts`'s toolbar dropdowns
 * already use (`EventLogTableFilterMode`/`TableRenderModes`) -- both surfaces stay in
 * sync because both call the same setter, not two independent state copies.
 */

import { EventLogTableFilterMode, type TableDisplayMode, type TableNameMode, type TableRenderModes, type TableTypeMode } from '@omnetpp/shared/elog-protocol';
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
  /** ADDITIVE (phase U7): the table has no filter panel of its own -- opens/focuses the Sequence Chart's (see `uiProtocol.ts`'s `requestFilterPanel` doc comment). */
  openFilter(): void;
  /** ADDITIVE (phase U10): "Go to NED Declaration" for the focused row's module (see `uiProtocol.ts`'s `gotoNedDeclaration` message doc); only ever invoked when `TableMenuBuildParams.focusedRowNedTypeName` is non-null (the item disables itself otherwise). */
  gotoNedDeclaration(): void;
  /** Phase U10 (cheap gap) -- `lineFilterModeAction`; same setter the toolbar's Line Filter dropdown calls (`tableView.ts`). */
  setLineFilterMode(mode: EventLogTableFilterMode): void;
  /** Phase U10 (cheap gap) -- `typeModeAction`; same setter the toolbar's Type Mode dropdown calls. */
  setTypeMode(mode: TableTypeMode): void;
  /** Phase U10 (cheap gap) -- `nameModeAction`; same setter the toolbar's Name Mode dropdown calls. */
  setNameMode(mode: TableNameMode): void;
  /** Phase U10 (cheap gap) -- `displayModeAction`; same setter the toolbar's Display Mode dropdown calls. */
  setDisplayMode(mode: TableDisplayMode): void;
}

export interface TableMenuBuildParams {
  /** `false` when no row is focused (an empty table) -- disables the "Go To" family, which is relative to the focused row and would otherwise silently no-op. */
  hasFocus: boolean;
  /** `true` iff at least one row is currently selected -- gates "Copy". */
  hasSelection: boolean;
  /**
   * ADDITIVE (phase U10): the focused row's fully-qualified NED type name, when its
   * underlying entry is a `ModuleDescriptionEntry` subtype (`ModuleCreatedEntry`/
   * `ModuleFoundEntry` -- see `shared/src/eventlog/entries.ts`); `null` when nothing is
   * focused, or the focused row's entry doesn't describe a module at all -- gates "Go to
   * NED Declaration".
   */
  focusedRowNedTypeName: string | null;
  /** Phase U10 (cheap gap) -- current Line Filter mode, for the radio submenu's checkmark. */
  currentFilterMode: EventLogTableFilterMode;
  /** Phase U10 (cheap gap) -- current Name/Type/Display render modes, for the three radio submenus' checkmarks. */
  currentModes: TableRenderModes;
  actions: TableMenuActions;
}

/** Phase U10 (cheap gap) -- the Line Filter mode radio submenu; same 5 options as the toolbar dropdown (`tableView.ts`'s `buildTableToolbar()`). */
const LINE_FILTER_MODE_LABELS: [EventLogTableFilterMode, string][] = [
  [EventLogTableFilterMode.ALL_ENTRIES, 'All lines'],
  [EventLogTableFilterMode.EVENT_AND_SEND_AND_MESSAGE_ENTRIES, 'Events + sends + messages'],
  [EventLogTableFilterMode.EVENT_AND_MESSAGE_ENTRIES, 'Events + messages'],
  [EventLogTableFilterMode.EVENT_ENTRIES, 'Events only'],
  [EventLogTableFilterMode.CUSTOM_ENTRIES, 'Custom...'],
];

const TYPE_MODE_LABELS: [TableTypeMode, string][] = [
  ['CPP', 'C++ type'],
  ['NED', 'NED type'],
];

const NAME_MODE_LABELS: [TableNameMode, string][] = [
  ['SMART_NAME', 'Smart name'],
  ['FULL_NAME', 'Full name'],
  ['FULL_PATH', 'Full path'],
];

const DISPLAY_MODE_LABELS: [TableDisplayMode, string][] = [
  ['DESCRIPTIVE', 'Descriptive'],
  ['RAW', 'Raw'],
];

export function buildTableContextMenu(params: TableMenuBuildParams): MenuEntry[] {
  const { hasFocus, hasSelection, focusedRowNedTypeName, currentFilterMode, currentModes, actions } = params;
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
    { id: 'gotoNedDeclaration', label: 'Go to NED Declaration', disabled: focusedRowNedTypeName === null, onSelect: actions.gotoNedDeclaration },
    { separator: true },
    { id: 'copy', label: 'Copy', disabled: !hasSelection, onSelect: actions.copySelection },
    { id: 'findText', label: 'Find Text...', onSelect: actions.openFindBar },
    { separator: true },
    { id: 'filter', label: 'Filter Event Log...', icon: 'filter', onSelect: actions.openFilter },
    {
      id: 'lineFilterMode',
      label: 'Line Filter',
      submenu: LINE_FILTER_MODE_LABELS.map(([mode, label]): MenuEntry => ({ id: `lineFilter-${mode}`, label, checked: mode === currentFilterMode, onSelect: () => actions.setLineFilterMode(mode) })),
    },
    { separator: true },
    {
      id: 'typeMode',
      label: 'Type Mode',
      submenu: TYPE_MODE_LABELS.map(([mode, label]): MenuEntry => ({ id: `typeMode-${mode}`, label, checked: mode === currentModes.typeMode, onSelect: () => actions.setTypeMode(mode) })),
    },
    {
      id: 'nameMode',
      label: 'Name Mode',
      submenu: NAME_MODE_LABELS.map(([mode, label]): MenuEntry => ({ id: `nameMode-${mode}`, label, checked: mode === currentModes.nameMode, onSelect: () => actions.setNameMode(mode) })),
    },
    {
      id: 'displayMode',
      label: 'Display Mode',
      submenu: DISPLAY_MODE_LABELS.map(([mode, label]): MenuEntry => ({ id: `displayMode-${mode}`, label, checked: mode === currentModes.displayMode, onSelect: () => actions.setDisplayMode(mode) })),
    },
    { separator: true },
    { id: 'refresh', label: 'Refresh', icon: 'refresh', onSelect: actions.refresh },
  ];
  return entries;
}
