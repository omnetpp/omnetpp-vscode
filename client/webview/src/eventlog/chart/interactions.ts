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
import { gotoBeginAt, gotoEndAt, panBy, scrollVerticalTo, zoomAt, zoomAtCenter, type ViewportState } from './viewportState';

export interface InteractionCallbacks {
  getViewport(): ViewportState;
  setViewport(v: ViewportState): void;
  getAxesLayout(): AxesLayout;
  /**
   * The content-area height to scroll/clamp against -- `chartMain.ts`'s
   * `notesAwareContentHeight()`, NOT the raw `contentHeight(viewport)`: this module has no
   * access to `displayFlags`/the "Bookmark Info" notes band, so without this callback its
   * own vertical-scroll clamp (`clampScroll()`) and PageUp/PageDown page size would ignore
   * that reserved band entirely, capping the max scroll short of where the notes actually
   * are.
   */
  getContentHeight(): number;
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
   * ModuleAction hotspots). `null`/`undefined` = the default `'default'` (a plain arrow;
   * the canvas does not advertise grabbability with a hand cursor -- only an active pan
   * shows the `'all-scroll'` 4-way panning cursor, see `onMouseDown`/`onMouseUp`).
   */
  getCursorAt?(px: number, py: number): string | null;
  /** Phase U11 — the pointer moved to content-area `(px, py)` without dragging; chartMain hit-tests and highlights whatever is under it (Java `mouseMove` -> `highlightedObjects`). */
  onHover?(px: number, py: number): void;
  /** Phase U11 — the pointer left the canvas, or a drag started; clear any hover highlight. */
  onHoverEnd?(): void;
  /** Phase U11 — a Ctrl/Cmd-drag rubber-band rectangle is in progress (content-area canvas px); `null` when it ends/cancels. Used to draw the marquee. */
  onRubberBand?(rect: { x0: number; y0: number; x1: number; y1: number } | null): void;
  /** Phase U11 — a Ctrl/Cmd-drag rubber-band was released; zoom the viewport to fit the rectangle (Java's rubber-band `zoomToRectangle`). */
  onZoomToRect?(rect: { x0: number; y0: number; x1: number; y1: number }): void;
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
  // Phase U11 -- Ctrl/Cmd-drag rubber-band zoom. `rubberBanding` is armed on a modified
  // mousedown; `rbStart` holds the anchor (content-area canvas px). It becomes a real
  // marquee only once movement crosses the click/drag threshold (`dragMoved`), so a plain
  // Ctrl-click still toggles selection instead of zooming.
  let rubberBanding = false;
  let rbStartX = 0;
  let rbStartY = 0;

  function mutate(fn: (v: ViewportState, axesLayout: AxesLayout) => ViewportState): void {
    const v = cb.getViewport();
    const axesLayout = cb.getAxesLayout();
    cb.setViewport(fn(v, axesLayout));
    cb.onChanged();
  }

  function clampScroll(v: ViewportState, vscroll: number, axesLayout: AxesLayout): ViewportState {
    return scrollVerticalTo(v, vscroll, maxVerticalScroll(axesLayout, cb.getContentHeight()));
  }

  function contentPoint(e: MouseEvent): { px: number; py: number } {
    const rect = canvas.getBoundingClientRect();
    return { px: e.clientX - rect.left, py: e.clientY - rect.top };
  }

  const onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    dragMoved = false;
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    cb.onHoverEnd?.(); // no hover highlight while grabbing/marquee
    // Ctrl/Cmd+drag -> rubber-band zoom rectangle instead of pan.
    if ((e.ctrlKey || e.metaKey) && cb.onZoomToRect) {
      rubberBanding = true;
      const { px, py } = contentPoint(e);
      rbStartX = px;
      rbStartY = py;
      return;
    }
    dragging = true;
    // Cursor stays the plain arrow on button-down; the 4-way panning cursor only appears
    // once movement actually crosses the drag threshold (see onMouseMove) -- a mousedown
    // that turns out to be a click never flashes the pan cursor.
  };

  const onMouseMove = (e: MouseEvent): void => {
    if (rubberBanding) {
      const { px, py } = contentPoint(e);
      if (Math.abs(e.clientX - lastClientX) > CLICK_DRAG_THRESHOLD_PX || Math.abs(e.clientY - lastClientY) > CLICK_DRAG_THRESHOLD_PX) dragMoved = true;
      if (dragMoved) cb.onRubberBand?.({ x0: rbStartX, y0: rbStartY, x1: px, y1: py });
      return;
    }
    if (!dragging) {
      // hover cursor override (phase U8) + hover highlight (phase U11) -- only when the
      // pointer is actually over the canvas.
      if (e.target instanceof Node && canvas.contains(e.target)) {
        const { px, py } = contentPoint(e);
        if (cb.getCursorAt) canvas.style.cursor = cb.getCursorAt(px, py) ?? 'default';
        cb.onHover?.(px, py);
      }
      return;
    }
    const dx = e.clientX - lastClientX;
    const dy = e.clientY - lastClientY;
    if (!dragMoved && (Math.abs(e.clientX - lastClientX) > CLICK_DRAG_THRESHOLD_PX || Math.abs(e.clientY - lastClientY) > CLICK_DRAG_THRESHOLD_PX)) {
      dragMoved = true;
      canvas.style.cursor = 'all-scroll'; // first real movement -> show the panning cursor
    }
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    mutate((v, axesLayout) => {
      const panned = panBy(v, -dx / v.pixelsPerTc);
      return clampScroll(panned, v.vscroll - dy, axesLayout);
    });
  };

  const onMouseUp = (e: MouseEvent): void => {
    if (rubberBanding) {
      rubberBanding = false;
      cb.onRubberBand?.(null);
      if (dragMoved) {
        const { px, py } = contentPoint(e);
        cb.onZoomToRect?.({ x0: rbStartX, y0: rbStartY, x1: px, y1: py });
      }
      // if it never moved, dragMoved stays false -> the native click fires and is handled
      // as a normal Ctrl-click (selection toggle) by onClick below.
      return;
    }
    dragging = false;
    canvas.style.cursor = 'default';
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
        mutate((v, axesLayout) => clampScroll(v, v.vscroll - cb.getContentHeight(), axesLayout));
        e.preventDefault();
        break;
      case 'PageDown':
        mutate((v, axesLayout) => clampScroll(v, v.vscroll + cb.getContentHeight(), axesLayout));
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

  const onMouseLeave = (): void => cb.onHoverEnd?.();

  canvas.style.cursor = 'default';
  canvas.tabIndex = 0;
  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mouseleave', onMouseLeave);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('keydown', onKeyDown);

  return () => {
    canvas.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    canvas.removeEventListener('mouseleave', onMouseLeave);
    canvas.removeEventListener('click', onClick);
    canvas.removeEventListener('dblclick', onDoubleClick);
    canvas.removeEventListener('contextmenu', onContextMenu);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('keydown', onKeyDown);
  };
}
