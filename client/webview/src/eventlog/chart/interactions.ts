/**
 * interactions.ts — DOM event wiring for pan/zoom/scroll/click/hover/keyboard, driving
 * the pure state transitions in `viewportState.ts` and the pure hit-testing/selection
 * logic in `hitTest.ts`/`selection.ts` (both live in `chartMain.ts`, which owns the
 * viewport model / RPC / selection state this module has no access to — this file only
 * translates DOM events into coordinates + callback invocations).
 *
 * Semantics ported from `SequenceChart.java`'s mouse/keyboard listeners (verified by
 * reading the source — see `hitTest.ts`'s header for the exact citation):
 *  - plain wheel: vertical axis-stack scroll. Ctrl/Cmd+wheel: zoom (cursor-anchored,
 *    a deliberate deviation from Java's always-center-anchored `zoomBy` — documented
 *    since U3). Shift+wheel: horizontal pan.
 *  - Drag (plain mouse button, no modifier, movement beyond a small threshold): pans.
 *  - Click (mousedown+mouseup with NO drag movement in between): hit-test at the
 *    point, apply as a selection click (`Ctrl/Cmd` held = toggle, per `selection.ts`).
 *  - Double-click: hit-test (a DIFFERENT, shorter cascade — `hitTest.ts`'s
 *    `pickDoubleClickTarget`), zoom-to-message / open-module (U8 stub).
 *  - Context menu (right-click / context-menu key): hit-test, hand the FULL hit list
 *    to the callback (`chartContextMenu.ts` builds per-object sections from it).
 *  - Keyboard: Home/End -> gotoBegin/gotoEnd; PageUp/PageDown -> vertical page scroll;
 *    ArrowUp/ArrowDown -> vertical scroll by one axis-spacing step; `+`/`-`/`*` ->
 *    zoomIn/zoomOut/defaultZoom (viewport-center-anchored, matching Java exactly);
 *    Esc -> clear selection; F5 -> refresh; Tab -> toggle "show time differences"
 *    (phase U5: renders a dashed polyline + simtime-delta labels between selected
 *    events, `drawList.ts`'s `showTimeDifferences` gate); Delete -> exclude selected events (STUB, U7 owns
 *    the Filter UI this needs); plain ArrowLeft/ArrowRight -> move focus to the
 *    previous/next event; Ctrl/Cmd+ArrowLeft/ArrowRight -> go to cause/consequence
 *    event; Shift+ArrowLeft/ArrowRight -> go to the previous/next event on the SAME
 *    module; Ctrl/Cmd+D (phase U6) -> toggle bookmark for the current selection.
 */

import type { AxesLayout } from './axes';
import { maxVerticalScroll } from './axes';
import type { DrawPrimitive } from './drawList';
import type { HitObject } from './hitTest';
import { contentHeight, gotoBeginAt, gotoEndAt, panBy, scrollVerticalTo, zoomAt, zoomAtCenter, type ViewportState } from './viewportState';

export interface InteractionCallbacks {
  getViewport(): ViewportState;
  setViewport(v: ViewportState): void;
  getAxesLayout(): AxesLayout;
  /** Timeline coordinate of the first/last event currently known -- used by Home/End. `null` if not yet known (no-op). */
  getBeginTc(): number | null;
  getEndTc(): number | null;
  /** Called after any viewport mutation -- re-render + (if needed) refetch. */
  onChanged(): void;

  // ---- U4 additions: hit-testing, selection, dialogs, misc keyboard actions -------

  /** The exact primitive list the CURRENT frame was drawn from (`drawList.ts`'s output) -- fed straight into `hitTest.ts`'s `hitTest()`. */
  getPrimitives(): DrawPrimitive[];
  /** `hitTest.ts`'s `hitTest()`, called with the already-content-space `(px, py)` this module computed from the DOM event (canvas CSS px, gutters baked in -- see `drawList.ts`'s header) plus whatever `pointerTc` the caller wants to include (its own `pixelToTc`, or `null` to suppress the timestamp fallback). */
  hitTestAt(px: number, py: number): HitObject[];
  /** Plain/ctrl+click, already resolved to `pickPrimaryGroup()`-equivalent hits by the caller? No — this receives the RAW `hitTest()` result; `chartMain.ts` applies `pickPrimaryGroup`/`selection.ts`'s `applyClick` itself (keeps this module a thin DOM translator). */
  onClick(hits: HitObject[], ctrl: boolean): void;
  /** `ctrl` (phase U8): Ctrl/Cmd+double-click on an axis opens the module RECURSIVELY (`SequenceChart.java:5965`'s `SWT.MOD1` branch); plain opens one level. */
  onDoubleClick(hits: HitObject[], ctrl: boolean): void;
  /**
   * Phase U8 (optional): CSS cursor override while hovering (not dragging) -- e.g.
   * `'pointer'` over a `moduleAction` glyph (Eclipse shows the hand cursor over its
   * ModuleAction hotspots). `null`/`undefined` = the default `'grab'`.
   */
  getCursorAt?(px: number, py: number): string | null;
  onContextMenu(clientX: number, clientY: number, hits: HitObject[]): void;
  onEscape(): void;
  onRefresh(): void;
  onToggleTimeDifferences(): void;
  onDeleteExclude(): void;
  /** `direction`: `-1` = ArrowLeft (previous event), `1` = ArrowRight (next event). */
  onMoveFocus(direction: -1 | 1): void;
  onGotoCause(): void;
  onGotoConsequence(): void;
  /** Shift+ArrowLeft/Right -- nearest previous/next event on the SAME module as the focused event. */
  onSameModuleNeighbor(direction: -1 | 1): void;
  onDefaultZoom(): void;
  /** Ctrl/Cmd+D (phase U6, port plan's suggested accelerator -- Java's own chart "Toggle bookmark" action has none) -- toggles a bookmark for the current selection. */
  onToggleBookmark(): void;
}

const WHEEL_ZOOM_FACTOR = 1.1;
const KEY_ZOOM_FACTOR = 1.5; // matches Java's zoomIn()/zoomOut()
/** CSS px of mouse movement between mousedown and mouseup below which a gesture is still a "click" (Java has no explicit equivalent -- SWT's native click/drag disambiguation is platform default; this is this port's own, documented threshold). */
const CLICK_DRAG_THRESHOLD_PX = 3;

export function attachInteractions(canvas: HTMLElement, cb: InteractionCallbacks): () => void {
  let dragging = false;
  let dragMoved = false;
  let lastClientX = 0;
  let lastClientY = 0;

  function mutate(fn: (v: ViewportState, axesLayout: AxesLayout) => ViewportState): void {
    const v = cb.getViewport();
    const axesLayout = cb.getAxesLayout();
    cb.setViewport(fn(v, axesLayout));
    cb.onChanged();
  }

  function clampScroll(v: ViewportState, vscroll: number, axesLayout: AxesLayout): ViewportState {
    return scrollVerticalTo(v, vscroll, maxVerticalScroll(axesLayout, contentHeight(v)));
  }

  function contentPoint(e: MouseEvent): { px: number; py: number } {
    const rect = canvas.getBoundingClientRect();
    return { px: e.clientX - rect.left, py: e.clientY - rect.top };
  }

  const onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    dragging = true;
    dragMoved = false;
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    canvas.style.cursor = 'grabbing';
  };

  const onMouseMove = (e: MouseEvent): void => {
    if (!dragging) {
      // hover cursor override (phase U8) -- only when the pointer is actually over the canvas
      if (cb.getCursorAt && e.target instanceof Node && canvas.contains(e.target)) {
        const { px, py } = contentPoint(e);
        canvas.style.cursor = cb.getCursorAt(px, py) ?? 'grab';
      }
      return;
    }
    const dx = e.clientX - lastClientX;
    const dy = e.clientY - lastClientY;
    if (Math.abs(e.clientX - lastClientX) > CLICK_DRAG_THRESHOLD_PX || Math.abs(e.clientY - lastClientY) > CLICK_DRAG_THRESHOLD_PX) dragMoved = true;
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    mutate((v, axesLayout) => {
      const panned = panBy(v, -dx / v.pixelsPerTc);
      return clampScroll(panned, v.vscroll - dy, axesLayout);
    });
  };

  const onMouseUp = (): void => {
    dragging = false;
    canvas.style.cursor = 'grab';
  };

  const onClick = (e: MouseEvent): void => {
    if (dragMoved) return; // this gesture was a pan, not a click -- see CLICK_DRAG_THRESHOLD_PX
    const { px, py } = contentPoint(e);
    cb.onClick(cb.hitTestAt(px, py), e.ctrlKey || e.metaKey);
  };

  const onDoubleClick = (e: MouseEvent): void => {
    const { px, py } = contentPoint(e);
    cb.onDoubleClick(cb.hitTestAt(px, py), e.ctrlKey || e.metaKey);
  };

  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    const { px, py } = contentPoint(e);
    cb.onContextMenu(e.clientX, e.clientY, cb.hitTestAt(px, py));
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const rect = canvas.getBoundingClientRect();
      const cursorContentX = e.clientX - rect.left;
      mutate((v) => zoomAt(v, cursorContentX, e.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR));
    } else if (e.shiftKey) {
      const notches = e.deltaY || e.deltaX;
      mutate((v) => panBy(v, notches / v.pixelsPerTc));
    } else {
      mutate((v, axesLayout) => clampScroll(v, v.vscroll + e.deltaY, axesLayout));
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    const ctrl = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case 'Home': {
        const tc = cb.getBeginTc();
        if (tc !== null) mutate((v) => gotoBeginAt(v, tc));
        e.preventDefault();
        break;
      }
      case 'End': {
        const tc = cb.getEndTc();
        if (tc !== null) mutate((v) => gotoEndAt(v, tc));
        e.preventDefault();
        break;
      }
      case 'PageUp':
        mutate((v, axesLayout) => clampScroll(v, v.vscroll - contentHeight(v), axesLayout));
        e.preventDefault();
        break;
      case 'PageDown':
        mutate((v, axesLayout) => clampScroll(v, v.vscroll + contentHeight(v), axesLayout));
        e.preventDefault();
        break;
      case 'ArrowUp':
        mutate((v, axesLayout) => clampScroll(v, v.vscroll - (axesLayout.spacing + 1), axesLayout));
        e.preventDefault();
        break;
      case 'ArrowDown':
        mutate((v, axesLayout) => clampScroll(v, v.vscroll + Math.ceil(axesLayout.spacing + 1), axesLayout));
        e.preventDefault();
        break;
      case 'ArrowLeft':
        if (ctrl) cb.onGotoCause();
        else if (e.shiftKey) cb.onSameModuleNeighbor(-1);
        else cb.onMoveFocus(-1);
        e.preventDefault();
        break;
      case 'ArrowRight':
        if (ctrl) cb.onGotoConsequence();
        else if (e.shiftKey) cb.onSameModuleNeighbor(1);
        else cb.onMoveFocus(1);
        e.preventDefault();
        break;
      case '+':
      case '=':
        mutate((v) => zoomAtCenter(v, KEY_ZOOM_FACTOR));
        e.preventDefault();
        break;
      case '-':
        mutate((v) => zoomAtCenter(v, 1 / KEY_ZOOM_FACTOR));
        e.preventDefault();
        break;
      case '*':
        cb.onDefaultZoom();
        e.preventDefault();
        break;
      case 'Escape':
        cb.onEscape();
        e.preventDefault();
        break;
      case 'F5':
        cb.onRefresh();
        e.preventDefault();
        break;
      case 'Tab':
        cb.onToggleTimeDifferences();
        e.preventDefault();
        break;
      case 'Delete':
      case 'Backspace':
        cb.onDeleteExclude();
        e.preventDefault();
        break;
      case 'd':
      case 'D':
        if (ctrl) {
          cb.onToggleBookmark();
          e.preventDefault();
        }
        break;
    }
  };

  canvas.style.cursor = 'grab';
  canvas.tabIndex = 0;
  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('keydown', onKeyDown);

  return () => {
    canvas.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    canvas.removeEventListener('click', onClick);
    canvas.removeEventListener('dblclick', onDoubleClick);
    canvas.removeEventListener('contextmenu', onContextMenu);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('keydown', onKeyDown);
  };
}
