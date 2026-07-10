/**
 * The Event Log table's DOM orchestrator (phase U2): header + resizable columns,
 * fixed-height row pool, custom approximate scrollbar, keyboard/mouse selection, Ctrl+C
 * copy, an inline find bar (forward/backward, case-sensitive -- see the "find" section
 * below), and follow-end-on-append. Everything DOM-free (the fix-point
 * windowing clamp, the scrollbar math, the selection-state reducer) lives in
 * `rowPool.ts`/`scrollMath.ts`/`selectionModel.ts` and is unit-tested there; this file is
 * the (untested, by design) glue that wires those pure pieces to real DOM events and
 * `elogProtocol.ts` RPCs.
 *
 * Porting source: `VirtualTable.java` (see this directory's other files' headers for
 * the specific methods). Two deliberate architecture simplifications from the Java
 * fix-point model, both noted where they matter:
 *  - The "remembered anchor" (`lastAnchorRef`, analogous to Java's `fixPointElement`) is
 *    always re-derived to be the row currently occupying screen row 0 after every
 *    reload/scroll, i.e. its `distance` (screen offset) is always conceptually 0 rather
 *    than free-drifting -- `scroll()`-equivalent operations resolve the new top row via
 *    `elog/table/navigate` (one round trip) instead of Java's zero-round-trip "same
 *    element, new distance" (which requires a mutable already-fetched superset window
 *    this port does not keep). Functionally equivalent for scrolling/paging; simpler to
 *    keep correct.
 *  - The scrollbar's top/bottom-visible-row percentages (needed by
 *    `computeScrollbarPercentage()`) come from two `elog/table/position` calls per
 *    repaint (cheap, non-long-running) rather than being read off an already-resident
 *    widget state the way SWT's `ScrollBar` is in Java.
 */

import {
  ElogMethods,
  EventLogTableFilterMode,
  type EntryTypeSchema,
  type FilterHints,
  type FindTextParams,
  type FindTextResult,
  type RowAnchor,
  type RowRef,
  type RowWindow,
  type RowWindowParams,
  type TableGotoRelatedParams,
  type TableGotoRelation,
  type TableNavigateParams,
  type TablePositionParams,
  type TablePositionResult,
  type TableRenderModes,
  type TableRow,
  DEFAULT_TABLE_RENDER_MODES,
} from '@omnetpp/shared/elog-protocol';
import { computeEntryProposals } from '@omnetpp/shared/entry-proposals';
import type { Bookmark, EventLogSelection, RevealTarget, WebviewToHostMessage } from '@omnetpp/shared/ui-protocol';
import type { EngineRpc } from '../common/rpc';
import { loadPersistedBlob, withVersion } from '../common/persistedState';
import { showContextMenu } from '../common/contextMenu';
import { buildToolbar, type ToolbarHandle } from '../common/toolbar';
import { attachAutocomplete, type AutocompleteProposals } from '../common/autocompleteDropdown';
import { DEFAULT_FIND_TEXT_STATE, type FindTextState } from '../common/dialogs';
import { createRowPool, computeTopIndex, type RowPool } from './rowPool';
import { buildTableContextMenu, type TableMenuActions } from './tableContextMenu';
import { compareRowRef, gotoElement, isSelected, moveFocusTo, refEquals, selectAll as selectAllRange, EMPTY_SELECTION, type SelectionState } from './selectionModel';
import { computeScrollbarGeometry, computeScrollbarPercentage, percentageToScrollbarSelection } from './scrollMath';

/** Java `EventLogTable`'s column defaults (Event# 120px, Time 200px, Details flexible). */
const DEFAULT_COL_WIDTHS = { eventNo: 120, time: 160 };
/** `HORIZONTAL_SPACING` + one `INDENT_SPACING` unit, in px (`EventLogTableRowRenderer.java`'s constants, ~line 97-99). */
const INDENT_UNIT_PX = 16;
const BASE_INDENT_PX = 4;

interface PersistedTableState {
  modes?: TableRenderModes;
  filterMode?: EventLogTableFilterMode;
  customFilterPattern?: string;
  colWidths?: { eventNo: number; time: number };
  /** Phase U10 (GAP 2) -- the last anchor row's event number (`lastAnchorRef`), debounced-persisted on scroll/anchor changes (`notePositionActivity()`) so reopening the table resumes near where the user left it instead of always jumping back to row 0. `undefined` = never persisted (a fresh file, or an older blob) -- `start()` then falls back to `{kind: 'first'}`. */
  lastEventNumber?: number;
}

/** Phase U10 -- bump whenever `PersistedTableState`'s shape changes in a way older code could misinterpret; see `client/webview/src/eventlog/common/persistedState.ts`'s header for the tolerant-load policy this gates. */
const TABLE_STATE_VERSION = 1;

export interface TableViewOptions {
  root: HTMLElement;
  rpc: EngineRpc;
  postToHost: (message: WebviewToHostMessage) => void;
  persistedState: unknown;
  /** Phase U6 -- the session's bookmark list as of when this table view was (re)mounted (see `tableMain.ts`'s `init`/`bookmarksChanged` handling). */
  initialBookmarks?: Bookmark[];
  /** Table popup Pin entry gap-closure -- the table's pinned state as of when this view was (re)mounted (see `tableMain.ts`'s `init`/`pinnedChanged` handling); feeds the context menu's "Pin"/"Unpin" item label/checkmark. */
  initialPinned?: boolean;
  /** Event Log table row icons -- icon id (`RenderedTableRow.iconId`) -> webview URI, precomputed host-side (see `uiProtocol.ts`'s `iconMap` doc comment); `renderRowInto()` looks up each row's icon here and omits it gracefully if absent. */
  iconMap?: Record<string, string>;
  /**
   * ADDITIVE (phase U9): called when `reload()` (the table's primary data-fetch path)
   * fails for a reason other than being superseded by a newer reload (see `reload()`'s
   * own `mySeq` staleness check) -- `tableMain.ts` feeds this through
   * `common/notificationOverlay.ts`'s `classifyEngineError()` to decide whether/how to
   * show the shared overlay.
   */
  onError?: (err: unknown) => void;
}

export interface TableViewHandle {
  /** Call once the log is known non-empty, or after a full reset (e.g. overwritten). */
  start(): void;
  onEngineChanged(change: 'appended' | 'overwritten'): void;
  /**
   * ADDITIVE (phase U7): the session's `elog/setFilter` just changed (always triggered
   * by the Sequence Chart's filter panel -- the table has none of its own, see
   * `uiProtocol.ts`'s `requestFilterPanel` doc comment). Port of `EventLogTable.
   * eventLogFiltered()` (`EventLogTable.java`, verified by reading the source):
   * re-resolves the SAME event number the table was last anchored to (via the `RowAnchor`
   * `'event'` variant, phase U6 -- `elog/table/getRows` finds the nearest still-matching
   * row for it under the NEW filter, exactly like `getMatchingEventInDirection()`'s
   * backward-then-forward search), falling back to the very first row if nothing was
   * anchored yet (an empty/never-scrolled table).
   */
  onFilterChanged(): void;
  applyReveal(target: RevealTarget): void;
  applySetSelection(selection: EventLogSelection): void;
  /** Phase U6 -- replaces the bookmark set this view tints rows for (`bookmarksChanged`/fresh `init`). */
  setBookmarks(bookmarks: Bookmark[]): void;
  /** Table popup Pin entry gap-closure -- updates the pinned state the context menu's "Pin"/"Unpin" item reflects (`pinnedChanged`/fresh `init`). */
  setPinned(pinned: boolean): void;
  /**
   * Table find parity gap-closure -- driven by the host's `'command'` messages
   * (`tableMain.ts`'s `'command'` case), mirroring `chartMain.ts`'s
   * `showFindTextDialog()`/`repeatFind()`: opens (focuses) the inline find bar, for
   * `omnetpp.eventlog.findText` routed here (`eventLogDialogs.ts`) when this table
   * currently has focus.
   */
  openFindBar(): void;
  /** Table find parity gap-closure -- repeats the last search (same direction/case-sensitivity as last used), or opens the find bar if nothing has been searched for yet; for `omnetpp.eventlog.findNext` routed here. */
  repeatFind(): void;
  /**
   * ADDITIVE (phase U9): the notification overlay's "Refresh" action -- re-resolves
   * the SAME anchor the table was last showing (same re-anchor logic `onFilterChanged()`
   * uses; see that method's doc comment), so a Refresh after a genuine fetch failure
   * retries in place rather than jumping back to the first row.
   */
  refreshCurrentWindow(): void;
  dispose(): void;
}

export function createTableView(options: TableViewOptions): TableViewHandle {
  const { root, rpc, postToHost } = options;
  const iconMap = options.iconMap ?? {};
  const persisted = loadPersistedBlob<PersistedTableState>(options.persistedState, TABLE_STATE_VERSION);

  let modes: TableRenderModes = { ...DEFAULT_TABLE_RENDER_MODES, ...persisted.modes };
  let filterMode: EventLogTableFilterMode = persisted.filterMode ?? EventLogTableFilterMode.ALL_ENTRIES;
  let customFilterPattern = persisted.customFilterPattern ?? '*';
  const colWidths = { ...DEFAULT_COL_WIDTHS, ...persisted.colWidths };

  root.innerHTML = '';
  const tableEl = document.createElement('div');
  tableEl.className = 'elog-table';
  tableEl.tabIndex = 0;

  const headerEl = document.createElement('div');
  headerEl.className = 'elog-table-header';
  const rowsWrapperEl = document.createElement('div');
  rowsWrapperEl.className = 'elog-rows';
  const scrollbarEl = document.createElement('div');
  scrollbarEl.className = 'elog-scrollbar';
  const thumbEl = document.createElement('div');
  thumbEl.className = 'elog-scrollbar-thumb';
  scrollbarEl.appendChild(thumbEl);

  const findBarEl = document.createElement('div');
  findBarEl.className = 'elog-findbar';
  const findInputEl = document.createElement('input');
  findInputEl.type = 'text';
  findInputEl.placeholder = 'Find text in event log… (Enter = next, Shift+Enter = previous, Esc = close)';
  findBarEl.appendChild(findInputEl);
  /**
   * Table find parity gap-closure -- upgrades this bar to match the chart's
   * `FindTextState` (`common/dialogs.ts`): a case-sensitivity toggle button (mirrors
   * VS Code's own find widget's "Match Case" button) and forward/backward search,
   * reachable both via these two buttons and via Enter/Shift+Enter on the input
   * (`findInputEl`'s own `keydown` handler below). Kept as plain icon buttons rather
   * than porting the chart's modal dialog wholesale -- this bar is meant to stay a
   * lightweight, always-inline affordance, not a dialog.
   */
  const findCaseButton = document.createElement('button');
  findCaseButton.innerHTML = '<span class="codicon codicon-case-sensitive"></span>';
  findCaseButton.title = 'Match Case';
  findCaseButton.setAttribute('aria-label', 'Match Case');
  findBarEl.appendChild(findCaseButton);
  const findPrevButton = document.createElement('button');
  findPrevButton.innerHTML = '<span class="codicon codicon-arrow-up"></span>';
  findPrevButton.title = 'Find Previous';
  findPrevButton.setAttribute('aria-label', 'Find Previous');
  findBarEl.appendChild(findPrevButton);
  const findNextButton = document.createElement('button');
  findNextButton.innerHTML = '<span class="codicon codicon-arrow-down"></span>';
  findNextButton.title = 'Find Next';
  findNextButton.setAttribute('aria-label', 'Find Next');
  findBarEl.appendChild(findNextButton);
  /** Phase U9 (loose end, U2's find was minimal) -- a miss used to be entirely silent; a small inline status word now confirms the search actually ran and simply found nothing. */
  const findStatusEl = document.createElement('span');
  findStatusEl.className = 'elog-findbar-status';
  findBarEl.appendChild(findStatusEl);

  // The header is an in-flow flex-column child; the rows + scrollbar live in a
  // flex-filling viewport BELOW it (`.elog-rows-viewport`) so the virtualized rows
  // (absolutely positioned inside it) start under the header instead of on top of it,
  // and `computeViewportRowCount()` measures the real available height.
  const rowsViewportEl = document.createElement('div');
  rowsViewportEl.className = 'elog-rows-viewport';
  rowsViewportEl.append(rowsWrapperEl, scrollbarEl);
  tableEl.append(headerEl, rowsViewportEl);
  root.append(findBarEl, tableEl);

  const eventNoHeaderCol = makeHeaderCol('Event #', colWidths.eventNo);
  const timeHeaderCol = makeHeaderCol('Time', colWidths.time);
  const detailsHeaderCol = makeHeaderCol('Details', undefined);
  headerEl.append(eventNoHeaderCol.el, timeHeaderCol.el, detailsHeaderCol.el);
  wireResizer(eventNoHeaderCol.resizer, (dx) => {
    colWidths.eventNo = Math.max(40, colWidths.eventNo + dx);
    layoutColumns();
    persistState();
  });
  wireResizer(timeHeaderCol.resizer, (dx) => {
    colWidths.time = Math.max(40, colWidths.time + dx);
    layoutColumns();
    persistState();
  });

  let rowHeightPx = measureRowHeight();
  const rowPool: RowPool = createRowPool(rowsWrapperEl, rowHeightPx);

  let rows: TableRow[] = [];
  let anchorIndex = -1;
  let topIndex = 0;
  let lastAnchorRef: RowRef | null = null;
  let approximateNumberOfEntries = 0;
  let selection: SelectionState = EMPTY_SELECTION;
  /** Table find parity gap-closure -- the last-used search params (case sensitivity persists across searches; `backward` reflects whichever direction was used most recently, so `repeatFind()`/the host's `findNext` command continues the same way F3 would). Mirrors `chartMain.ts`'s own `findTextState` variable. */
  let findTextState: FindTextState = { ...DEFAULT_FIND_TEXT_STATE };
  /** Phase U6 -- event numbers with an `'Event'`-kind bookmark, for the row-background tint (the port plan's "table = row background tint" -- see this file's `renderRowInto()`). */
  let bookmarkedEventNumbers = new Set<number>(options.initialBookmarks?.filter((b) => b.kind === 'Event').map((b) => b.eventNumber!));
  /** Table popup Pin entry gap-closure -- the context menu's "Pin"/"Unpin" item label/checkmark; the host owns the authoritative state (`pinnedChanged`/fresh `init` keep this in sync). */
  let pinned = options.initialPinned ?? false;
  let scrolledToEnd = false;
  /**
   * Phase U10 (cheap gap) -- `VirtualTable.java`'s ArrowLeft/ArrowRight horizontal
   * scroll (10px/keystroke). The DOM table has no native horizontal scrollbar (the
   * fixed-width Event#/Time columns + flexible Details column normally fit the
   * viewport), but `.elog-rows`/`.elog-table` are both `overflow: hidden` (see
   * `webviewHtml.ts`) and the two fixed columns have no upper resize bound
   * (`wireResizer()` above), so wide columns or a narrow panel CAN clip content with no
   * way to reach it -- this offset (applied as a per-row `translateX()` in `repaint()`)
   * is that reach mechanism. Clamped only at the left edge (0); no measured
   * right-edge clamp (Java's own is against the real content width, which this port's
   * absolutely-positioned/virtualized rows don't cheaply expose) -- simplest faithful
   * variant per the parity audit's cheap-gap work order.
   */
  let horizontalScrollPx = 0;
  let requestSeq = 0;
  let viewportRowCount = 1;
  let disposed = false;
  /**
   * Phase U9 (loose end, noted in the U6 report): `start()` kicks off its own
   * `reload({kind:'first'}, 0)` fire-and-forget; `tableMain.ts`'s `init` handler
   * immediately calls `applySetSelection()` right after `start()` returns (both on the
   * SAME synchronous tick, for a freshly-mounted table attaching to an
   * already-selected session -- a pinned table rebind, or this very table reloading).
   * Without serializing them, both `reload()` calls race the engine round trip:
   * whichever response lands LAST wins, so a slow "first row" response arriving after
   * the selection's own reload would silently override it back to the first row.
   * `start()` now remembers its own in-flight promise here; `applySetSelection()`
   * (below) waits for it before running its own reload, so the selection's reload
   * always runs (and therefore lands) strictly after the initial one, never racing it.
   * `null` once consumed (or if `start()` was never called) -- every LATER
   * `applySetSelection()` call (an ordinary cross-view sync, not the first-mount case)
   * runs immediately, unaffected.
   */
  let initialLoadPromise: Promise<void> | null = null;

  const resizeObserver = new ResizeObserver(() => {
    const newCount = computeViewportRowCount();
    if (newCount !== viewportRowCount) {
      viewportRowCount = newCount;
      if (lastAnchorRef) void reload({ kind: 'ref', ref: lastAnchorRef }, 0);
    }
  });
  resizeObserver.observe(rowsWrapperEl);

  tableEl.addEventListener('focus', () => tableEl.classList.add('focused'));
  tableEl.addEventListener('blur', () => tableEl.classList.remove('focused'));
  /**
   * Table find parity gap-closure -- reports "does any part of this view (the row
   * grid OR the inline find bar) currently have DOM focus" to the host, via
   * `focusin`/`focusout` delegation on `root` (both bubble, unlike plain `focus`/
   * `blur` above, which only fire on `tableEl` itself and would wrongly report a
   * blur while the user is merely typing in `findInputEl`, a sibling of `tableEl`
   * under `root` -- see this file's DOM layout above). `eventLogTableView.ts` uses
   * this to route `omnetpp.eventlog.findText`/`.findNext` here instead of into the
   * Sequence Chart when this table is the focused webview (see `uiProtocol.ts`'s
   * `tableFocusChanged` doc comment). `focusout` fires before the new focus target is
   * committed, so the "did focus really leave `root`" check runs on a microtask tick.
   */
  root.addEventListener('focusin', () => postToHost({ type: 'tableFocusChanged', focused: true }));
  root.addEventListener('focusout', () => {
    queueMicrotask(() => {
      if (!root.contains(document.activeElement)) postToHost({ type: 'tableFocusChanged', focused: false });
    });
  });
  tableEl.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const dir = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
      if (dir !== 0) queueScroll(dir * 3);
    },
    { passive: false },
  );
  tableEl.addEventListener('keydown', (e) => void handleKeyDown(e));
  rowsWrapperEl.addEventListener('mousedown', (e) => void handleRowMouseDown(e));
  // Double-click -- the second click's own 'mousedown' (handled above, just like any
  // single click) already selected+focused the row by the time 'dblclick' fires; this
  // just adds the explicit "center in chart" action on top (see `requestRevealInChart()`'s doc).
  rowsWrapperEl.addEventListener('dblclick', () => requestRevealInChart());
  rowsWrapperEl.addEventListener('contextmenu', (e) => handleContextMenu(e));
  thumbEl.addEventListener('mousedown', (e) => handleThumbMouseDown(e));
  scrollbarEl.addEventListener('mousedown', (e) => {
    if (e.target === thumbEl) return;
    void handleTrackClick(e);
  });
  findInputEl.addEventListener('keydown', (e) => {
    // Table find parity gap-closure -- Enter = forward (matches the pre-existing
    // behavior), Shift+Enter = backward (mirrors VS Code's own find widget and the
    // chart's `FindTextState.backward`); Escape still closes, unchanged.
    if (e.key === 'Enter') void doFind(!e.shiftKey);
    else if (e.key === 'Escape') closeFindBar();
  });
  findInputEl.addEventListener('input', () => (findStatusEl.textContent = ''));
  // Table find parity gap-closure -- case-sensitivity toggle + explicit
  // forward/backward buttons, the mouse-driven equivalents of Shift+Enter above.
  findCaseButton.addEventListener('click', () => {
    findTextState = { ...findTextState, caseSensitive: !findTextState.caseSensitive };
    findCaseButton.classList.toggle('active', findTextState.caseSensitive);
    if (findInputEl.value) void doFind(!findTextState.backward);
  });
  findPrevButton.addEventListener('click', () => {
    findInputEl.focus();
    void doFind(false);
  });
  findNextButton.addEventListener('click', () => {
    findInputEl.focus();
    void doFind(true);
  });

  // ---- viewport sizing -----------------------------------------------------------------

  function measureRowHeight(): number {
    const probe = document.createElement('div');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.className = 'elog-row';
    probe.textContent = 'M';
    rowsWrapperEl.appendChild(probe);
    const fontSizePx = parseFloat(getComputedStyle(probe).fontSize) || 13;
    probe.remove();
    // VERTICAL_SPACING (3px) added to the font's natural line height, per
    // EventLogTableRowRenderer.getRowHeight() -- font metrics aren't queried through a
    // GC here, so a 1.35x line-height approximation stands in for `gc.getFontMetrics()`.
    return Math.round(fontSizePx * 1.35) + 3;
  }

  function computeViewportRowCount(): number {
    const h = rowsWrapperEl.clientHeight || 1;
    return Math.max(1, Math.floor(h / rowHeightPx));
  }
  viewportRowCount = computeViewportRowCount();

  function layoutColumns(): void {
    eventNoHeaderCol.el.style.flex = `0 0 ${colWidths.eventNo}px`;
    timeHeaderCol.el.style.flex = `0 0 ${colWidths.time}px`;
    repaint();
  }

  // ---- data loading ---------------------------------------------------------------------

  /** Shared by `onFilterChanged()` and the notification overlay's "Refresh" (`refreshCurrentWindow()`): re-resolves the SAME event the table was last anchored to (falling back to the first row if nothing was anchored yet). */
  function reanchorCurrent(): void {
    const anchor: RowAnchor = lastAnchorRef ? { kind: 'event', eventNumber: lastAnchorRef.eventNumber } : { kind: 'first' };
    void reload(anchor, 0);
  }

  async function reload(anchor: RowAnchor, desiredDistance: number): Promise<void> {
    const mySeq = ++requestSeq;
    const before = Math.max(0, desiredDistance) + viewportRowCount;
    const after = Math.max(1, viewportRowCount - desiredDistance) + viewportRowCount;
    const params: RowWindowParams = { anchor, before, after, filterMode, customFilterPattern, render: modes };
    let win;
    try {
      win = await rpc.request<RowWindow>(ElogMethods.tableGetRows, params);
    } catch (err) {
      // Phase U9: only report a genuine (non-superseded) failure -- a NEWER reload
      // already in flight by the time this one's rejection lands means this
      // particular attempt is stale/irrelevant (matches the same `mySeq` staleness
      // check the success path below applies), not a real user-facing problem.
      if (mySeq === requestSeq) options.onError?.(err);
      return;
    }
    if (mySeq !== requestSeq || disposed) return;
    approximateNumberOfEntries = win.approximateNumberOfEntries;
    if (win.anchorIndex === -1) {
      rows = [];
      anchorIndex = -1;
      topIndex = 0;
      lastAnchorRef = null;
      repaint();
      return;
    }
    rows = win.rows;
    anchorIndex = win.anchorIndex;
    topIndex = computeTopIndex(anchorIndex, desiredDistance, rows.length, viewportRowCount, win.hasMoreBefore, win.hasMoreAfter);
    lastAnchorRef = rows[topIndex]?.ref ?? rows[anchorIndex]?.ref ?? null;
    scrolledToEnd = anchor.kind === 'last';
    repaint();
    void refreshScrollbar();
    notePositionActivity(); // Phase U10 (GAP 2) -- lastAnchorRef just moved
  }

  let pendingScrollRows = 0;
  let scrollInFlight = false;
  function queueScroll(n: number): void {
    pendingScrollRows += n;
    if (!scrollInFlight) void drainScroll();
  }
  async function drainScroll(): Promise<void> {
    if (pendingScrollRows === 0) return;
    scrollInFlight = true;
    const n = pendingScrollRows;
    pendingScrollRows = 0;
    await scrollBy(n);
    scrollInFlight = false;
    if (pendingScrollRows !== 0) void drainScroll();
  }
  async function scrollBy(n: number): Promise<void> {
    if (lastAnchorRef === null) return;
    let target: RowRef | null;
    try {
      target = await rpc.request<RowRef | null>(ElogMethods.tableNavigate, { ref: lastAnchorRef, distance: n } satisfies TableNavigateParams);
    } catch {
      return;
    }
    if (target === null) {
      await reload({ kind: n < 0 ? 'first' : 'last' }, n < 0 ? 0 : viewportRowCount - 1);
      return;
    }
    await reload({ kind: 'ref', ref: target }, 0);
  }

  // ---- rendering --------------------------------------------------------------------------

  function repaint(): void {
    const poolRows = rowPool.resize(viewportRowCount);
    const transform = horizontalScrollPx > 0 ? `translateX(-${horizontalScrollPx}px)` : '';
    for (let i = 0; i < poolRows.length; i++) {
      const row = rows[topIndex + i];
      const el = poolRows[i];
      el.style.transform = transform; // Phase U10 (cheap gap) -- horizontal scroll offset, see its own doc comment
      if (!row) {
        el.style.visibility = 'hidden';
        continue;
      }
      el.style.visibility = 'visible';
      const selected = isSelected(selection, row.ref);
      const isFocusRow = selection.focus !== null && refEquals(selection.focus, row.ref);
      renderRowInto(el, row, selected, isFocusRow);
    }
  }

  function renderRowInto(el: HTMLDivElement, row: TableRow, selected: boolean, isFocusRow: boolean): void {
    el.classList.toggle('selected', selected);
    el.classList.toggle('focus-row', isFocusRow);
    el.classList.toggle('bookmarked', bookmarkedEventNumbers.has(row.eventNumber));
    el.dataset.eventNumber = String(row.ref.eventNumber);
    el.dataset.entryIndex = String(row.ref.entryIndex);
    el.innerHTML = '';
    const eventNoCol = document.createElement('div');
    eventNoCol.className = 'elog-col';
    eventNoCol.style.flex = `0 0 ${colWidths.eventNo}px`;
    const timeCol = document.createElement('div');
    timeCol.className = 'elog-col';
    timeCol.style.flex = `0 0 ${colWidths.time}px`;
    const detailsCol = document.createElement('div');
    detailsCol.className = 'elog-col';
    detailsCol.style.flex = '1 1 auto';

    const rendered = row.rendered;
    if (rendered) {
      eventNoCol.textContent = rendered.eventNumberSpan.text;
      eventNoCol.classList.add(`elog-span-${rendered.eventNumberSpan.style}`);
      timeCol.textContent = rendered.simTimeSpan.text;
      timeCol.classList.add(`elog-span-${rendered.simTimeSpan.style}`);
      detailsCol.style.paddingLeft = `${BASE_INDENT_PX + rendered.indentUnits * INDENT_UNIT_PX}px`;
      // Row icon (EventLogTableRowRenderer.java's getImage() -- see elogProtocol.ts's
      // `RenderedTableRow.iconId` doc comment): drawn immediately to the left of the
      // Details text, inside the row's existing indent. Omitted gracefully if `iconId`
      // has no matching bundled asset (e.g. an entry type this port doesn't ship an icon
      // for yet, or the eventlog icon snapshot was never generated).
      const iconUri = iconMap[rendered.iconId];
      if (iconUri) {
        const icon = document.createElement('img');
        icon.className = 'elog-row-icon';
        icon.src = iconUri;
        icon.width = 16;
        icon.height = 16;
        icon.alt = '';
        detailsCol.appendChild(icon);
      }
      for (const span of rendered.detailSpans) {
        const s = document.createElement('span');
        s.className = `elog-span-${span.style}`;
        s.textContent = span.text;
        detailsCol.appendChild(s);
      }
    } else {
      eventNoCol.textContent = `#${row.eventNumber}`;
      timeCol.textContent = row.simulationTime;
      detailsCol.textContent = `${row.entryClassCode} ${Object.values(row.fields).join(' ')}`;
    }
    el.append(eventNoCol, timeCol, detailsCol);
  }

  // ---- scrollbar --------------------------------------------------------------------------

  async function refreshScrollbar(): Promise<void> {
    if (rows.length === 0 || topIndex >= rows.length) {
      thumbEl.style.display = 'none';
      return;
    }
    const bottomIdx = Math.min(topIndex + viewportRowCount - 1, rows.length - 1);
    const topRef = rows[topIndex].ref;
    const bottomRef = rows[bottomIdx].ref;
    let topPos: TablePositionResult;
    let bottomPos: TablePositionResult;
    try {
      [topPos, bottomPos] = await Promise.all([
        rpc.request<TablePositionResult>(ElogMethods.tablePosition, { ref: topRef } satisfies TablePositionParams),
        rpc.request<TablePositionResult>(ElogMethods.tablePosition, { ref: bottomRef } satisfies TablePositionParams),
      ]);
    } catch {
      return;
    }
    if (disposed) return;
    const geometry = computeScrollbarGeometry(approximateNumberOfEntries, viewportRowCount);
    if (geometry.max <= 0) {
      thumbEl.style.display = 'none';
      return;
    }
    const pct = computeScrollbarPercentage(topPos.approximatePercentage, bottomPos.approximatePercentage);
    const trackHeightPx = scrollbarEl.clientHeight || 1;
    const thumbHeightPx = Math.max(16, (geometry.thumb / geometry.max) * trackHeightPx);
    const selectionUnits = percentageToScrollbarSelection(pct, geometry);
    const rangeUnits = Math.max(1, geometry.max - geometry.thumb);
    const availablePx = Math.max(0, trackHeightPx - thumbHeightPx);
    thumbEl.style.display = '';
    thumbEl.style.height = `${thumbHeightPx}px`;
    thumbEl.style.top = `${(selectionUnits / rangeUnits) * availablePx}px`;
  }

  function handleThumbMouseDown(e: MouseEvent): void {
    e.preventDefault();
    const trackRect = scrollbarEl.getBoundingClientRect();
    const move = (ev: MouseEvent): void => {
      const percentage = Math.min(1, Math.max(0, (ev.clientY - trackRect.top) / Math.max(1, trackRect.height)));
      void reload({ kind: 'percentage', percentage }, Math.floor(viewportRowCount / 2));
    };
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  async function handleTrackClick(e: MouseEvent): Promise<void> {
    const trackRect = scrollbarEl.getBoundingClientRect();
    const percentage = Math.min(1, Math.max(0, (e.clientY - trackRect.top) / Math.max(1, trackRect.height)));
    await reload({ kind: 'percentage', percentage }, Math.floor(viewportRowCount / 2));
  }

  // ---- selection / keyboard / mouse ------------------------------------------------------

  async function applyMoveFocus(target: RowRef, shift: boolean, ctrl: boolean, click: boolean): Promise<void> {
    selection = moveFocusTo(selection, target, { shift, ctrl, click });
    await revealRef(target);
    repaint();
    emitSelectionChanged();
  }

  /** Port of `reveal()` -- scrolls only if `ref` is not already on screen; reuses the already-fetched window when `ref` merely sits in the overscan margin (no round trip). */
  async function revealRef(ref: RowRef): Promise<void> {
    const idx = rows.findIndex((r) => refEquals(r.ref, ref));
    if (idx !== -1) {
      if (idx < topIndex) topIndex = idx;
      else if (idx > topIndex + viewportRowCount - 1) topIndex = idx - viewportRowCount + 1;
      lastAnchorRef = rows[topIndex]?.ref ?? lastAnchorRef;
      notePositionActivity(); // Phase U10 (GAP 2) -- reused-window scroll, no reload() of its own to trigger this
      return;
    }
    if (rows.length === 0) {
      await reload({ kind: 'ref', ref }, 0);
      return;
    }
    const beforeStart = compareRowRef(ref, rows[0].ref) < 0;
    await reload({ kind: 'ref', ref }, beforeStart ? 0 : viewportRowCount - 1);
  }

  async function handleKeyDown(e: KeyboardEvent): Promise<void> {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      copySelection();
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openFindBar();
      return;
    }
    // Phase U10 (cheap gap) -- F5 = Refresh, same `checkChanges` RPC the context-menu
    // Refresh item and toolbar Refresh button already use (`EventLogTableContributor`
    // plugin.xml binding; the chart canvas's own F5 handler is `interactions.ts`'s
    // `onRefresh`, ported already -- this closes the table-side gap noted in the parity
    // audit's "Cheap gaps" section).
    if (e.key === 'F5') {
      e.preventDefault();
      void rpc.request(ElogMethods.checkChanges, undefined);
      return;
    }
    // Phase U10 (cheap gap) -- Ctrl+Space: keyboard toggle-select of the focused row,
    // port of `VirtualTable.java`'s key listener (`moveFocusBy(0, false, true, true)`):
    // same distance-0 "stay on the focused row" move, ctrl set, but `click=true` so it
    // goes through `moveFocusTo()`'s ctrl+mouse branch (toggle membership) rather than
    // the ctrl+keyboard branch (which only moves focus, see that function's doc comment).
    if (ctrl && e.key === ' ') {
      e.preventDefault();
      const focus = selection.focus;
      if (focus) await applyMoveFocus(focus, false, true, true);
      return;
    }
    // Phase U10 (cheap gap) -- Ctrl+A: select all. `SelectionRange`s are ref pairs (see
    // `selectionModel.ts`'s header), so the whole table is representable as one range
    // from the first to the last row -- no need to materialize/fetch every row.
    if (ctrl && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      await selectAll();
      return;
    }
    // Phase U6 -- the "Go To" family (`EventLogTableContributor.java`'s accelerators,
    // see `tableContextMenu.ts`'s header): Ctrl+Up/Down = Cause/Arrival, Alt+Up/Down =
    // Previous/Next Event, Shift+Up/Down = Previous/Next Module Event. Checked BEFORE
    // the plain distance-based Up/Down handling below, and consumes the keystroke
    // entirely (a documented interpretation choice: Shift+Up/Down no longer also
    // extends the keyboard selection range the way Shift+PageUp/PageDown/Home/End still
    // do below -- Eclipse's own accelerator binding would consume the keystroke the
    // same way before it ever reaches `VirtualTable`'s native key handler).
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const up = e.key === 'ArrowUp';
      let relation: TableGotoRelation | null = null;
      if (ctrl) relation = up ? 'cause' : 'arrival';
      else if (e.altKey) relation = up ? 'prevEvent' : 'nextEvent';
      else if (e.shiftKey) relation = up ? 'prevModuleEvent' : 'nextModuleEvent';
      if (relation) {
        e.preventDefault();
        await doGotoRelated(relation);
        return;
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      requestRevealInChart();
      return;
    }
    // Phase U10 (cheap gap) -- ArrowLeft/ArrowRight: horizontal scroll by 10px
    // (`VirtualTable.java`'s key listener; see `horizontalScrollPx`'s own doc comment
    // above for why this is reachable, not dead code, despite the table having no
    // native scrollbar).
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      horizontalScrollPx = Math.max(0, horizontalScrollPx + (e.key === 'ArrowLeft' ? -10 : 10));
      repaint();
      return;
    }
    let distance = 0;
    switch (e.key) {
      case 'ArrowDown':
        distance = 1;
        break;
      case 'ArrowUp':
        distance = -1;
        break;
      case 'PageDown':
        distance = viewportRowCount;
        break;
      case 'PageUp':
        distance = -viewportRowCount;
        break;
      case 'Home':
        e.preventDefault();
        await gotoEdge('first', e);
        return;
      case 'End':
        e.preventDefault();
        await gotoEdge('last', e);
        return;
      default:
        return;
    }
    e.preventDefault();
    const focusRef = selection.focus ?? rows[topIndex]?.ref;
    if (!focusRef) return;
    let target: RowRef | null;
    try {
      target = await rpc.request<RowRef | null>(ElogMethods.tableNavigate, { ref: focusRef, distance } satisfies TableNavigateParams);
    } catch {
      return;
    }
    const resolved = target ?? (distance < 0 ? rows[0]?.ref : rows[rows.length - 1]?.ref) ?? null;
    if (!resolved) return;
    await applyMoveFocus(resolved, e.shiftKey, ctrl, false);
  }

  /**
   * The table's "Go To" family (context menu + keyboard, see `handleKeyDown()`/
   * `tableContextMenu.ts`) -- resolves `relation` relative to the focused row via the
   * engine's `elog/table/gotoRelated` (port of `EventLogTableContributor.java`'s
   * per-action handlers, see `TableGotoRelation`'s doc in elogProtocol.ts), then applies
   * it exactly like any other programmatic goto: replaces the selection with just the
   * resolved row (no shift/ctrl semantics -- matches Java's plain `gotoElement()`/
   * `gotoClosestElement()`), reveals it, and broadcasts `selectionChanged` (so the chart
   * follows, per the session's cross-view sync). A `null` result (no cause/consequence/
   * neighbor/etc.) is a silent no-op, matching every Java handler's own behavior for
   * "nothing there."
   */
  async function doGotoRelated(relation: TableGotoRelation): Promise<void> {
    const focus = selection.focus;
    if (!focus) return;
    let target: RowRef | null;
    try {
      target = await rpc.request<RowRef | null>(ElogMethods.tableGotoRelated, { from: focus, relation } satisfies TableGotoRelatedParams);
    } catch {
      return;
    }
    if (!target) return;
    await applyMoveFocus(target, false, false, false);
  }

  /** Enter / double-click -- explicitly asks the chart to CENTER on the focused event (a stronger action than the passive "reveal if off-screen" a plain cross-view `setSelection` already does -- see `applySetSelection()`'s doc and `chartMain.ts`'s `setSelection` handler). No-op with nothing focused. */
  function requestRevealInChart(): void {
    const ref = selection.focus;
    if (!ref) return;
    postToHost({ type: 'revealRequest', target: { kind: 'event', eventNumber: ref.eventNumber, ref } });
  }

  /**
   * Phase U10 (cheap gap) -- Ctrl+A "select all": fetches the table's first and last
   * row refs (same `elog/table/getRows` edge lookups `gotoEdge()` uses) and hands them
   * to `selectionModel.ts`'s `selectAll()`, which represents the whole table as a
   * single `{from, to}` range -- no per-row materialization, matching that module's own
   * "ranges are ref pairs" design (see its header). A no-op on an empty table.
   */
  async function selectAll(): Promise<void> {
    const edge = async (kind: 'first' | 'last'): Promise<RowRef | undefined> => {
      try {
        const win = await rpc.request<RowWindow>(ElogMethods.tableGetRows, { anchor: { kind }, before: 0, after: 1, filterMode, customFilterPattern } satisfies RowWindowParams);
        return win.rows[0]?.ref;
      } catch {
        return undefined;
      }
    };
    const [first, last] = await Promise.all([edge('first'), edge('last')]);
    if (!first || !last) return;
    selection = selectAllRange(first, last);
    repaint();
    emitSelectionChanged();
  }

  async function gotoEdge(which: 'first' | 'last', e: KeyboardEvent): Promise<void> {
    let win;
    try {
      win = await rpc.request<RowWindow>(ElogMethods.tableGetRows, {
        anchor: { kind: which },
        before: 0,
        after: 1,
        filterMode,
        customFilterPattern,
      } satisfies RowWindowParams);
    } catch {
      return;
    }
    const ref = win.rows[0]?.ref;
    if (!ref) return;
    await applyMoveFocus(ref, e.shiftKey, e.ctrlKey || e.metaKey, false);
  }

  async function handleRowMouseDown(e: MouseEvent): Promise<void> {
    const rowEl = (e.target as HTMLElement).closest('.elog-row') as HTMLDivElement | null;
    if (!rowEl) return;
    const poolIndex = Array.from(rowsWrapperEl.children).indexOf(rowEl);
    if (poolIndex === -1) return;
    const row = rows[topIndex + poolIndex];
    if (!row) return;
    tableEl.focus();
    await applyMoveFocus(row.ref, e.shiftKey, e.ctrlKey || e.metaKey, true);
  }

  function emitSelectionChanged(): void {
    const eventNumbers = [...new Set(rows.filter((r) => isSelected(selection, r.ref)).map((r) => r.eventNumber))];
    postToHost({ type: 'selectionChanged', selection: { eventNumbers, originId: 'table' } });
  }

  // ---- copy (Ctrl+C) ----------------------------------------------------------------------

  function copySelection(): void {
    const selected = rows.filter((r) => isSelected(selection, r.ref));
    if (selected.length === 0) return;
    const text = selected.map(rowPlainText).join('\n');
    postToHost({ type: 'copyText', text });
  }

  function rowPlainText(row: TableRow): string {
    if (row.rendered) return `${row.rendered.eventNumberSpan.text}\t${row.rendered.simTimeSpan.text}\t${row.rendered.detailSpans.map((s) => s.text).join('')}`;
    return `#${row.eventNumber}\t${row.simulationTime}\t${row.entryClassCode}`;
  }

  // ---- find (Ctrl+F; table find parity gap-closure -- forward/backward + case toggle,
  // matching the chart's FindTextState; U4 does the full filter/find UI) ------------------

  function openFindBar(): void {
    findBarEl.classList.add('open');
    findInputEl.focus();
    findInputEl.select();
  }
  function closeFindBar(): void {
    findBarEl.classList.remove('open');
    tableEl.focus();
  }
  /** Table find parity gap-closure -- host-driven "Find Next" (`omnetpp.eventlog.findNext` routed here, see `TableViewHandle.repeatFind()`'s doc comment): repeats the last search in its last-used direction, or just opens the bar if nothing has been searched for yet (mirrors `chartMain.ts`'s `repeatFind()`). */
  function repeatFind(): void {
    if (!findTextState.search) {
      openFindBar();
      return;
    }
    findInputEl.value = findTextState.search;
    void doFind(!findTextState.backward);
  }
  /**
   * Table find parity gap-closure -- now carries direction + case sensitivity
   * (`findTextState`, matching the chart's `FindTextState`/`performFind()`), not just
   * a hardcoded forward+case-insensitive search. Continuation semantics are unchanged
   * from before this gap-closure: `start: selection.focus` anchors on the currently
   * focused row, which -- since a hit moves focus onto the found row via
   * `gotoElement()` below -- naturally makes a repeated call (Enter again, `repeatFind()`,
   * or the opposite-direction button) continue from the last match, in either
   * direction, with no separate "last found ref" bookkeeping needed (contrast
   * `chartMain.ts`'s `lastFindRef`, needed there only because ITS dialog always starts
   * a fresh submit from `null`, not from the current selection).
   */
  async function doFind(forward: boolean): Promise<void> {
    const search = findInputEl.value;
    if (!search) return;
    findTextState = { ...findTextState, search, backward: !forward };
    const params: FindTextParams = { start: selection.focus, search, forward, caseSensitive: findTextState.caseSensitive };
    let result;
    try {
      result = await rpc.request<FindTextResult>(ElogMethods.findText, params);
    } catch {
      return;
    }
    if (!result.found || !result.ref) {
      findStatusEl.textContent = 'Not found';
      return;
    }
    findStatusEl.textContent = '';
    selection = gotoElement(result.ref);
    await revealRef(result.ref);
    repaint();
    emitSelectionChanged();
  }

  // ---- cross-view selection sync (phase U6) ------------------------------------------------

  /**
   * Applies an incoming `setSelection` (the chart's selection changed, or a session
   * rebind/late-attach push -- see `EventLogSession.setSelection()`/`attach()`'s doc):
   * resolves each event number to its first table row via the `elog/table/getRows`
   * `{kind: 'event'}` anchor (additive, elogProtocol.ts), replaces the local selection
   * (no shift/ctrl semantics -- an incoming selection is always a plain "this is now the
   * selection", matching `gotoElement()`), and REVEALS it -- per the researched Eclipse
   * semantics (`EventLogSelection.java`'s header/citations in `uiProtocol.ts`):
   * receiving a selection from elsewhere both selects AND scrolls into view, unlike a
   * local click (which only selects, since the clicked row is already on screen).
   * Deliberately does NOT call `emitSelectionChanged()` -- this is the RECEIVING half of
   * the sync, not a new user action; re-broadcasting it would be redundant at best (the
   * session's own re-entry guard already prevents an echo-back-to-origin, but nothing
   * stops a needless second hop through the session otherwise).
   */
  async function applySetSelectionImpl(sel: EventLogSelection): Promise<void> {
    if (sel.eventNumbers.length === 0) {
      selection = EMPTY_SELECTION;
      repaint();
      return;
    }
    const refs: RowRef[] = [];
    for (const eventNumber of sel.eventNumbers) {
      let win: RowWindow;
      try {
        win = await rpc.request<RowWindow>(ElogMethods.tableGetRows, { anchor: { kind: 'event', eventNumber }, before: 0, after: 1 } satisfies RowWindowParams);
      } catch {
        continue;
      }
      const ref = win.anchorIndex >= 0 ? win.rows[win.anchorIndex]?.ref : undefined;
      if (ref) refs.push(ref);
    }
    if (refs.length === 0) return;
    const focus = refs[refs.length - 1];
    selection = { anchor: refs[0], focus, ranges: refs.map((r) => ({ from: r, to: r })) };
    await revealRef(focus);
    repaint();
  }

  // ---- bookmarks (phase U6) -----------------------------------------------------------------

  /** "Toggle Bookmark" (context menu -- Java gives the table's own version no accelerator either) -- the focused row's EVENT (Java: `EventLogTableContributor.java`'s own simpler "Toggle Bookmark", which always bookmarks the focused event, never a dependency/axis/method-call -- those are chart-only, see `chartMain.ts`). */
  function toggleBookmarkForFocus(): void {
    const ref = selection.focus;
    if (!ref) return;
    postToHost({ type: 'toggleBookmark', candidate: { kind: 'Event', eventNumber: ref.eventNumber } });
  }

  /**
   * Phase U10 -- "Go to NED Declaration": resolvable only for the currently-rendered
   * window's rows (`rows`, the same set `handleContextMenu()`/`copySelection()` already
   * work off of -- no reason to fetch a row outside the visible window just to check its
   * type). A row is navigable exactly when its underlying entry is a
   * `ModuleDescriptionEntry` subtype (`ModuleCreatedEntry`/`ModuleFoundEntry`, see
   * `shared/src/eventlog/entries.ts`) -- both expose the module's fully-qualified NED
   * type name through the same `'t'` attribute (`ModuleDescriptionEntry.getAsString('t')`),
   * already present in `TableRow.fields` with no extra engine round trip needed.
   */
  function focusedRowNedTypeName(): string | null {
    if (!selection.focus) return null;
    const row = rows.find((r) => refEquals(r.ref, selection.focus!));
    if (!row) return null;
    if (row.entryClassName !== 'ModuleCreatedEntry' && row.entryClassName !== 'ModuleFoundEntry') return null;
    return row.fields['t'] || null;
  }

  function handleContextMenu(e: MouseEvent): void {
    e.preventDefault();
    const actions: TableMenuActions = {
      gotoCause: () => void doGotoRelated('cause'),
      gotoArrival: () => void doGotoRelated('arrival'),
      gotoOrigin: () => void doGotoRelated('origin'),
      gotoReuse: () => void doGotoRelated('reuse'),
      gotoPrevEvent: () => void doGotoRelated('prevEvent'),
      gotoNextEvent: () => void doGotoRelated('nextEvent'),
      gotoPrevModuleEvent: () => void doGotoRelated('prevModuleEvent'),
      gotoNextModuleEvent: () => void doGotoRelated('nextModuleEvent'),
      toggleBookmark: toggleBookmarkForFocus,
      copySelection,
      openFindBar,
      refresh: () => void rpc.request(ElogMethods.checkChanges, undefined),
      openFilter: () => postToHost({ type: 'requestFilterPanel' }),
      gotoNedDeclaration: () => {
        const typeName = focusedRowNedTypeName();
        if (typeName) postToHost({ type: 'gotoNedDeclaration', typeName });
      },
      setLineFilterMode,
      setTypeMode,
      setNameMode,
      setDisplayMode,
      togglePin: () => postToHost({ type: 'togglePin' }),
    };
    const entries = buildTableContextMenu({
      hasFocus: selection.focus !== null,
      hasSelection: rows.some((r) => isSelected(selection, r.ref)),
      focusedRowNedTypeName: focusedRowNedTypeName(),
      currentFilterMode: filterMode,
      currentModes: modes,
      pinned,
      actions,
    });
    showContextMenu(e.clientX, e.clientY, entries);
  }

  // ---- persistence ------------------------------------------------------------------------

  function persistState(): void {
    const state: PersistedTableState = { modes, filterMode, customFilterPattern, colWidths, lastEventNumber: lastAnchorRef?.eventNumber };
    postToHost({ type: 'stateChanged', state: withVersion(state, TABLE_STATE_VERSION) });
  }

  /** Phase U10 (GAP 2) -- debounces `persistState()` after scroll/anchor activity (`reload()`'s success path, `revealRef()`'s reused-window branch) so a scroll/PageDown spree doesn't spam a `stateChanged` postMessage per row; mirrors `chartMain.ts`'s `noteViewportActivity()` (same window, same "settle before persisting" intent). Mode/column-width changes still persist immediately via their own direct `persistState()` calls above -- only the high-frequency scroll-position updates go through this debounce. */
  const POSITION_PERSIST_DEBOUNCE_MS = 400;
  let positionPersistTimer: ReturnType<typeof setTimeout> | undefined;
  function notePositionActivity(): void {
    clearTimeout(positionPersistTimer);
    positionPersistTimer = setTimeout(persistState, POSITION_PERSIST_DEBOUNCE_MS);
  }

  // ---- view-mode setters (phase U10 cheap gap) -----------------------------------------
  // Shared by the toolbar dropdowns (below) AND the context menu's radio submenus
  // (`handleContextMenu()`) -- one setter per mode, so both discoverable surfaces always
  // stay in sync (same state, same reload path) rather than duplicating the mutation.

  /** Handle of the toolbar built by `buildTableToolbar()`, kept so the setters below can update its dropdown display when a mode changes via the CONTEXT MENU (the toolbar's own `onChange` already reflects a toolbar-driven change for free). */
  let toolbarHandle: ToolbarHandle | undefined;

  /**
   * Table content-assist (phase U10): flat, deduped, sorted module/message names (from
   * `elog/getFilterHints`, same RPC and data shape the chart's filter panel already
   * consumes) folded into the `customFilter` box's autocomplete dropdown at "value"
   * positions (right after `field =~`) -- `entryProposals.ts`'s `computeEntryProposals()`
   * is a faithful port of Eclipse's `EventLogEntryProposalProvider`, whose own
   * `getFieldValueProposals()` is an unconditional no-op there too (see that file's
   * header), so this is a UI-layer enrichment on top of the ported grammar logic, not
   * part of it. Formerly rendered via a native `<datalist>` (`ToolbarInputSpec.
   * datalistId`) -- upgraded to route through `attachAutocomplete()` instead once that
   * existed, since a native datalist popup and a custom one can both render at once in
   * Chromium (a confusing double dropdown), and `computeEntryProposals()`'s
   * `positionKind` now lets this be folded in only where it's actually relevant (a bare
   * value position) rather than unconditionally on every keystroke.
   */
  let flatValueHints: string[] = [];
  /** Set once an `elog/getFilterHints` request SUCCEEDS, so repeated switches into Custom-filter mode don't re-request; left `false` on failure so the next opportunity retries (same best-effort policy as the chart's `chartMain.ts` `filterHintsLoaded`). */
  let filterHintsLoaded = false;
  /** The entry-type-code -> attribute-names schema `computeEntryProposals()` needs (`elog/getEntryTypeSchema`) -- `undefined` until loaded, in which case the dropdown offers nothing (fails closed, not open with a stale/empty schema silently misbehaving). Static data (independent of the open file), but still fetched lazily/once on the same trigger as `flatValueHints` for symmetry. */
  let entryTypeSchema: EntryTypeSchema | undefined;
  let entryTypeSchemaLoaded = false;

  /** Lazily fetches both content-assist data sources the first time the Custom-filter box becomes relevant (mirrors `chartMain.ts`'s `requestData` -> `elog/getFilterHints` lazy-load-once-on-first-need pattern). Each is independently best-effort: a failed request leaves its own `*Loaded` flag false so the next opportunity retries that one without re-requesting the other. */
  function requestCustomFilterAssistDataOnce(): void {
    if (!filterHintsLoaded) {
      void rpc
        .request<FilterHints>(ElogMethods.getFilterHints, undefined)
        .then((hints) => {
          filterHintsLoaded = true;
          flatValueHints = [...new Set([...hints.moduleNames, ...hints.moduleClassNames, ...hints.moduleNedTypeNames, ...hints.messageNames, ...hints.messageClassNames])].sort((a, b) => a.localeCompare(b));
        })
        .catch(() => {
          // best effort -- flatValueHints just stays empty until the next Custom-filter activation
        });
    }
    if (!entryTypeSchemaLoaded) {
      void rpc
        .request<EntryTypeSchema>(ElogMethods.getEntryTypeSchema, undefined)
        .then((schema) => {
          entryTypeSchemaLoaded = true;
          entryTypeSchema = schema;
        })
        .catch(() => {
          // best effort -- the dropdown just stays inactive until the next Custom-filter activation
        });
    }
  }

  /** `AutocompleteProposals` source for the `customFilter` input (see `attachAutocomplete()`'s wiring below): the Java-faithful grammar proposals from `computeEntryProposals()`, with `flatValueHints` folded in at "value" positions (see `flatValueHints`'s own doc comment). Returns no proposals (dropdown stays closed) until `entryTypeSchema` has loaded. */
  function computeCustomFilterProposals(text: string, cursorOffset: number): AutocompleteProposals {
    if (!entryTypeSchema) return { replaceStart: cursorOffset, replaceEnd: cursorOffset, items: [] };
    const result = computeEntryProposals(text, cursorOffset, entryTypeSchema);
    const items = result.proposals.map((p) => ({ text: p.text, label: p.label }));
    if (result.positionKind === 'after-matches' && flatValueHints.length > 0) {
      const prefix = text.slice(result.replaceStart, cursorOffset);
      const lowerPrefix = prefix.toLowerCase();
      for (const value of flatValueHints) {
        if (value.toLowerCase().startsWith(lowerPrefix) && value.length !== prefix.length) items.push({ text: `${value} `, label: value });
      }
    }
    return { replaceStart: result.replaceStart, replaceEnd: result.replaceEnd, items };
  }

  function setLineFilterMode(mode: EventLogTableFilterMode): void {
    filterMode = mode;
    toolbarHandle?.setDropdownValue('lineFilter', mode === EventLogTableFilterMode.CUSTOM_ENTRIES ? 'CUSTOM' : mode);
    toolbarHandle?.setItemVisible('customFilter', mode === EventLogTableFilterMode.CUSTOM_ENTRIES);
    if (mode === EventLogTableFilterMode.CUSTOM_ENTRIES) requestCustomFilterAssistDataOnce();
    persistState();
    void reload({ kind: 'ref', ref: lastAnchorRef ?? { eventNumber: 0, entryIndex: 0 } }, 0);
  }

  function setNameMode(mode: TableRenderModes['nameMode']): void {
    modes = { ...modes, nameMode: mode };
    toolbarHandle?.setDropdownValue('nameMode', mode);
    persistState();
    if (lastAnchorRef) void reload({ kind: 'ref', ref: lastAnchorRef }, 0);
  }

  function setTypeMode(mode: TableRenderModes['typeMode']): void {
    modes = { ...modes, typeMode: mode };
    toolbarHandle?.setDropdownValue('typeMode', mode);
    persistState();
    if (lastAnchorRef) void reload({ kind: 'ref', ref: lastAnchorRef }, 0);
  }

  function setDisplayMode(mode: TableRenderModes['displayMode']): void {
    modes = { ...modes, displayMode: mode };
    toolbarHandle?.setDropdownValue('displayMode', mode);
    persistState();
    if (lastAnchorRef) void reload({ kind: 'ref', ref: lastAnchorRef }, 0);
  }

  // ---- toolbar (Line Filter / Name / Type / Display + Refresh, mounted by tableMain.ts) ---

  function buildTableToolbar(container: HTMLElement, onRefresh: () => void): ToolbarHandle {
    const handle = buildToolbar(container, [
      { kind: 'button', button: { id: 'refresh', icon: 'refresh', title: 'Refresh', onClick: onRefresh } },
      // Phase U7: the table has no filter panel of its own -- opens/focuses the
      // Sequence Chart's (see `uiProtocol.ts`'s `requestFilterPanel` doc comment). Kept
      // clearly distinct from the "Line Filter" dropdown below (a per-row TABLE-side
      // rendering filter, unrelated to `elog/setFilter`'s event-level filtering).
      { kind: 'button', button: { id: 'openFilter', icon: 'filter', title: 'Filter Event Log… (event-level filter, shared with the Sequence Chart)', onClick: () => postToHost({ type: 'requestFilterPanel' }) } },
      { kind: 'separator' },
      {
        kind: 'dropdown',
        dropdown: {
          id: 'lineFilter',
          title: 'Line Filter',
          value: filterMode === EventLogTableFilterMode.CUSTOM_ENTRIES ? 'CUSTOM' : filterMode,
          options: [
            { value: EventLogTableFilterMode.ALL_ENTRIES, label: 'All lines' },
            { value: EventLogTableFilterMode.EVENT_AND_SEND_AND_MESSAGE_ENTRIES, label: 'Events + sends + messages' },
            { value: EventLogTableFilterMode.EVENT_AND_MESSAGE_ENTRIES, label: 'Events + messages' },
            { value: EventLogTableFilterMode.EVENT_ENTRIES, label: 'Events only' },
            { value: 'CUSTOM', label: 'Custom…' },
          ],
          onChange: (value) => setLineFilterMode(value === 'CUSTOM' ? EventLogTableFilterMode.CUSTOM_ENTRIES : (value as EventLogTableFilterMode)),
        },
      },
      {
        kind: 'input',
        input: {
          id: 'customFilter',
          title: 'Custom filter pattern (MatchExpression syntax)',
          placeholder: 'e.g. className(cMessage)',
          value: customFilterPattern,
          widthPx: 160,
          onChange: (value) => {
            customFilterPattern = value;
            persistState();
            if (lastAnchorRef) void reload({ kind: 'ref', ref: lastAnchorRef }, 0);
          },
        },
      },
      { kind: 'separator' },
      {
        kind: 'dropdown',
        dropdown: {
          id: 'nameMode',
          title: 'Module Name Mode',
          value: modes.nameMode,
          options: [
            { value: 'SMART_NAME', label: 'Smart name' },
            { value: 'FULL_NAME', label: 'Full name' },
            { value: 'FULL_PATH', label: 'Full path' },
          ],
          onChange: (value) => setNameMode(value as TableRenderModes['nameMode']),
        },
      },
      {
        kind: 'dropdown',
        dropdown: {
          id: 'typeMode',
          title: 'Type Mode',
          value: modes.typeMode,
          options: [
            { value: 'CPP', label: 'C++ type' },
            { value: 'NED', label: 'NED type' },
          ],
          onChange: (value) => setTypeMode(value as TableRenderModes['typeMode']),
        },
      },
      {
        kind: 'dropdown',
        dropdown: {
          id: 'displayMode',
          title: 'Display Mode',
          value: modes.displayMode,
          options: [
            { value: 'DESCRIPTIVE', label: 'Descriptive' },
            { value: 'RAW', label: 'Raw' },
          ],
          onChange: (value) => setDisplayMode(value as TableRenderModes['displayMode']),
        },
      },
    ]);
    handle.setItemVisible('customFilter', filterMode === EventLogTableFilterMode.CUSTOM_ENTRIES);
    // Table content-assist (phase U10): wire the position-aware autocomplete dropdown
    // onto the raw `<input>` `buildToolbar()` just created for the `customFilter` item
    // -- see `computeCustomFilterProposals()`'s doc comment for the proposal source.
    const customFilterInput = handle.getInputElement('customFilter');
    if (customFilterInput) attachAutocomplete(customFilterInput, computeCustomFilterProposals);
    return handle;
  }

  // Mount the toolbar into a container the caller (tableMain.ts) has already put in the
  // DOM (`#toolbar`, alongside the status strip U1 built) -- looked up lazily so this
  // module doesn't need to know tableMain.ts's exact DOM layout beyond that one id.
  const toolbarContainer = document.getElementById('toolbar');
  if (toolbarContainer) {
    toolbarHandle = buildTableToolbar(toolbarContainer, () => void rpc.request(ElogMethods.checkChanges, undefined));
    // Cover the "reopened with Custom-filter already persisted" case -- the toolbar's
    // initial dropdown value already reflects `filterMode` without a `setLineFilterMode()`
    // call, so that setter's own `requestCustomFilterAssistDataOnce()` never runs for this case.
    if (filterMode === EventLogTableFilterMode.CUSTOM_ENTRIES) requestCustomFilterAssistDataOnce();
  }

  return {
    start(): void {
      // Phase U10 (GAP 2) -- resume near the last remembered position instead of always
      // jumping back to row 0; `'event'` finds the nearest still-existing row the same
      // way `reanchorCurrent()`'s post-filter-change re-anchor already does. Falls back
      // to `'first'` for a fresh file (no persisted anchor at all).
      const anchor: RowAnchor = persisted.lastEventNumber !== undefined ? { kind: 'event', eventNumber: persisted.lastEventNumber } : { kind: 'first' };
      initialLoadPromise = reload(anchor, 0);
    },
    onEngineChanged(change): void {
      if (change === 'overwritten') {
        selection = EMPTY_SELECTION;
        void reload({ kind: 'first' }, 0);
        return;
      }
      if (scrolledToEnd) void reload({ kind: 'last' }, viewportRowCount - 1);
    },
    onFilterChanged(): void {
      reanchorCurrent();
    },
    applyReveal(target): void {
      if (target.ref === null) return;
      selection = gotoElement(target.ref);
      void revealRef(target.ref).then(() => {
        repaint();
        emitSelectionChanged();
      });
    },
    applySetSelection(sel): void {
      // Phase U9 -- see `initialLoadPromise`'s own doc comment: serialize behind
      // `start()`'s own in-flight first-row reload (if any is still outstanding) so a
      // fresh mount's selection-seeding call never races it.
      const pending = initialLoadPromise;
      initialLoadPromise = null;
      if (pending) void pending.then(() => applySetSelectionImpl(sel));
      else void applySetSelectionImpl(sel);
    },
    refreshCurrentWindow(): void {
      reanchorCurrent();
    },
    setBookmarks(bookmarks): void {
      bookmarkedEventNumbers = new Set(bookmarks.filter((b) => b.kind === 'Event').map((b) => b.eventNumber!));
      repaint();
    },
    setPinned(newPinned): void {
      pinned = newPinned;
    },
    openFindBar,
    repeatFind,
    dispose(): void {
      disposed = true;
      resizeObserver.disconnect();
    },
  };
}

function makeHeaderCol(label: string, widthPx: number | undefined): { el: HTMLDivElement; resizer: HTMLDivElement } {
  const el = document.createElement('div');
  el.className = 'elog-col';
  el.style.flex = widthPx !== undefined ? `0 0 ${widthPx}px` : '1 1 auto';
  el.textContent = label;
  const resizer = document.createElement('div');
  resizer.className = 'elog-col-resizer';
  if (widthPx !== undefined) el.appendChild(resizer);
  return { el, resizer };
}

function wireResizer(resizer: HTMLDivElement, onDrag: (deltaPx: number) => void): void {
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    let lastX = e.clientX;
    const move = (ev: MouseEvent): void => {
      onDrag(ev.clientX - lastX);
      lastX = ev.clientX;
    };
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}
