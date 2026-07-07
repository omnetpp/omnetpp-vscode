/**
 * The Event Log table's DOM orchestrator (phase U2): header + resizable columns,
 * fixed-height row pool, custom approximate scrollbar, keyboard/mouse selection, Ctrl+C
 * copy, a minimal find bar, and follow-end-on-append. Everything DOM-free (the fix-point
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
import type { Bookmark, EventLogSelection, RevealTarget, WebviewToHostMessage } from '@omnetpp/shared/ui-protocol';
import type { EngineRpc } from '../common/rpc';
import { showContextMenu } from '../common/contextMenu';
import { buildToolbar, type ToolbarHandle } from '../common/toolbar';
import { createRowPool, computeTopIndex, type RowPool } from './rowPool';
import { buildTableContextMenu, type TableMenuActions } from './tableContextMenu';
import { compareRowRef, gotoElement, isSelected, moveFocusTo, refEquals, EMPTY_SELECTION, type SelectionState } from './selectionModel';
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
}

export interface TableViewOptions {
  root: HTMLElement;
  rpc: EngineRpc;
  postToHost: (message: WebviewToHostMessage) => void;
  persistedState: unknown;
  /** Phase U6 -- the session's bookmark list as of when this table view was (re)mounted (see `tableMain.ts`'s `init`/`bookmarksChanged` handling). */
  initialBookmarks?: Bookmark[];
}

export interface TableViewHandle {
  /** Call once the log is known non-empty, or after a full reset (e.g. overwritten). */
  start(): void;
  onEngineChanged(change: 'appended' | 'overwritten'): void;
  applyReveal(target: RevealTarget): void;
  applySetSelection(selection: EventLogSelection): void;
  /** Phase U6 -- replaces the bookmark set this view tints rows for (`bookmarksChanged`/fresh `init`). */
  setBookmarks(bookmarks: Bookmark[]): void;
  dispose(): void;
}

function isPersistedTableState(v: unknown): v is PersistedTableState {
  return typeof v === 'object' && v !== null;
}

export function createTableView(options: TableViewOptions): TableViewHandle {
  const { root, rpc, postToHost } = options;
  const persisted = isPersistedTableState(options.persistedState) ? options.persistedState : {};

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
  findInputEl.placeholder = 'Find text in event log… (Enter = next, Esc = close)';
  findBarEl.appendChild(findInputEl);

  tableEl.append(headerEl, rowsWrapperEl, scrollbarEl);
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
  /** Phase U6 -- event numbers with an `'Event'`-kind bookmark, for the row-background tint (the port plan's "table = row background tint" -- see this file's `renderRowInto()`). */
  let bookmarkedEventNumbers = new Set<number>(options.initialBookmarks?.filter((b) => b.kind === 'Event').map((b) => b.eventNumber!));
  let scrolledToEnd = false;
  let requestSeq = 0;
  let viewportRowCount = 1;
  let disposed = false;

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
    if (e.key === 'Enter') void doFind(true);
    else if (e.key === 'Escape') closeFindBar();
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

  async function reload(anchor: RowAnchor, desiredDistance: number): Promise<void> {
    const mySeq = ++requestSeq;
    const before = Math.max(0, desiredDistance) + viewportRowCount;
    const after = Math.max(1, viewportRowCount - desiredDistance) + viewportRowCount;
    const params: RowWindowParams = { anchor, before, after, filterMode, customFilterPattern, render: modes };
    let win;
    try {
      win = await rpc.request<RowWindow>(ElogMethods.tableGetRows, params);
    } catch {
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
    for (let i = 0; i < poolRows.length; i++) {
      const row = rows[topIndex + i];
      const el = poolRows[i];
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

  // ---- find (Ctrl+F, minimal -- U4 does the full filter/find UI) ---------------------------

  function openFindBar(): void {
    findBarEl.classList.add('open');
    findInputEl.focus();
    findInputEl.select();
  }
  function closeFindBar(): void {
    findBarEl.classList.remove('open');
    tableEl.focus();
  }
  async function doFind(forward: boolean): Promise<void> {
    const search = findInputEl.value;
    if (!search) return;
    const params: FindTextParams = { start: selection.focus, search, forward, caseSensitive: false };
    let result;
    try {
      result = await rpc.request<FindTextResult>(ElogMethods.findText, params);
    } catch {
      return;
    }
    if (!result.found || !result.ref) return;
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
    };
    const entries = buildTableContextMenu({ hasFocus: selection.focus !== null, hasSelection: rows.some((r) => isSelected(selection, r.ref)), actions });
    showContextMenu(e.clientX, e.clientY, entries);
  }

  // ---- persistence ------------------------------------------------------------------------

  function persistState(): void {
    const state: PersistedTableState = { modes, filterMode, customFilterPattern, colWidths };
    postToHost({ type: 'stateChanged', state });
  }

  // ---- toolbar (Line Filter / Name / Type / Display + Refresh, mounted by tableMain.ts) ---

  function buildTableToolbar(container: HTMLElement, onRefresh: () => void): ToolbarHandle {
    const handle = buildToolbar(container, [
      { kind: 'button', button: { id: 'refresh', icon: 'refresh', title: 'Refresh', onClick: onRefresh } },
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
          onChange: (value) => {
            filterMode = value === 'CUSTOM' ? EventLogTableFilterMode.CUSTOM_ENTRIES : (value as EventLogTableFilterMode);
            handle.setItemVisible('customFilter', filterMode === EventLogTableFilterMode.CUSTOM_ENTRIES);
            persistState();
            void reload({ kind: 'ref', ref: lastAnchorRef ?? { eventNumber: 0, entryIndex: 0 } }, 0);
          },
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
          onChange: (value) => {
            modes = { ...modes, nameMode: value as TableRenderModes['nameMode'] };
            persistState();
            if (lastAnchorRef) void reload({ kind: 'ref', ref: lastAnchorRef }, 0);
          },
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
          onChange: (value) => {
            modes = { ...modes, typeMode: value as TableRenderModes['typeMode'] };
            persistState();
            if (lastAnchorRef) void reload({ kind: 'ref', ref: lastAnchorRef }, 0);
          },
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
          onChange: (value) => {
            modes = { ...modes, displayMode: value as TableRenderModes['displayMode'] };
            persistState();
            if (lastAnchorRef) void reload({ kind: 'ref', ref: lastAnchorRef }, 0);
          },
        },
      },
    ]);
    handle.setItemVisible('customFilter', filterMode === EventLogTableFilterMode.CUSTOM_ENTRIES);
    return handle;
  }

  // Mount the toolbar into a container the caller (tableMain.ts) has already put in the
  // DOM (`#toolbar`, alongside the status strip U1 built) -- looked up lazily so this
  // module doesn't need to know tableMain.ts's exact DOM layout beyond that one id.
  const toolbarContainer = document.getElementById('toolbar');
  if (toolbarContainer) buildTableToolbar(toolbarContainer, () => void rpc.request(ElogMethods.checkChanges, undefined));

  return {
    start(): void {
      void reload({ kind: 'first' }, 0);
    },
    onEngineChanged(change): void {
      if (change === 'overwritten') {
        selection = EMPTY_SELECTION;
        void reload({ kind: 'first' }, 0);
        return;
      }
      if (scrolledToEnd) void reload({ kind: 'last' }, viewportRowCount - 1);
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
      void applySetSelectionImpl(sel);
    },
    setBookmarks(bookmarks): void {
      bookmarkedEventNumbers = new Set(bookmarks.filter((b) => b.kind === 'Event').map((b) => b.eventNumber!));
      repaint();
    },
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
