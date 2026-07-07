/**
 * interactions.ts — DOM event wiring for pan/zoom/scroll (drag, wheel, toolbar
 * buttons, keyboard), driving the pure state transitions in `viewportState.ts`.
 * Not itself unit-tested (DOM-dependent); the transitions it calls into
 * (`panBy`/`zoomAt`/`scrollVerticalTo`/`gotoEndAt`/...) are pure and covered by
 * `viewportState.test.ts`/`coords.test.ts`.
 *
 * Semantics ported from `SequenceChart.java`'s mouse/keyboard listeners (verified by
 * reading the source, `:5800-5875`):
 *  - plain wheel: vertical axis-stack scroll.
 *  - Ctrl(/Cmd)+wheel: zoom by `1.1`/`1/1.1` per notch (Java: `zoomBy(1.1)` /
 *    `zoomBy(1.0/1.1)`). DEVIATION (documented, deliberate UX improvement over Java):
 *    Java's `zoomBy` always anchors at the viewport CENTER, even for the wheel
 *    handler; this port anchors at the CURSOR position instead (the plan's own
 *    brief calls for "ctrl+wheel = zoom at cursor"), which is the behavior users of
 *    virtually every other pannable/zoomable canvas UI expect.
 *  - Shift+wheel: horizontal pan (Java: `scrollHorizontal(-viewportWidth*count/20)`).
 *  - Drag (plain mouse button): pans horizontally + scrolls vertically together
 *    (Java has no explicit drag-pan code in the reviewed excerpt — SWT's default
 *    `ScrolledComposite`/native scrollbars handle drag-to-scroll; this port adds an
 *    explicit canvas-level drag-pan since a `<canvas>` has no native scrollbar
 *    equivalent).
 *  - Keyboard: Home/End -> gotoBegin/gotoEnd; PageUp/PageDown -> vertical page
 *    scroll; ArrowUp/ArrowDown -> vertical scroll by one axis-spacing step
 *    (`scrollVertical(-getAxisSpacing()-1)` / `ceil(axisSpacing+1)`); `+`/`-` ->
 *    zoomIn/zoomOut (viewport-center-anchored, matching Java exactly).
 */

import type { AxesLayout } from './axes';
import { maxVerticalScroll } from './axes';
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
}

const WHEEL_ZOOM_FACTOR = 1.1;
const KEY_ZOOM_FACTOR = 1.5; // matches Java's zoomIn()/zoomOut()

export function attachInteractions(canvas: HTMLElement, cb: InteractionCallbacks): () => void {
  let dragging = false;
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

  const onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    dragging = true;
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    canvas.style.cursor = 'grabbing';
  };

  const onMouseMove = (e: MouseEvent): void => {
    if (!dragging) return;
    const dx = e.clientX - lastClientX;
    const dy = e.clientY - lastClientY;
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

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const rect = (canvas as HTMLElement).getBoundingClientRect();
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
      case '+':
      case '=':
        mutate((v) => zoomAtCenter(v, KEY_ZOOM_FACTOR));
        e.preventDefault();
        break;
      case '-':
        mutate((v) => zoomAtCenter(v, 1 / KEY_ZOOM_FACTOR));
        e.preventDefault();
        break;
    }
  };

  canvas.style.cursor = 'grab';
  canvas.tabIndex = 0;
  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('keydown', onKeyDown);

  return () => {
    canvas.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('keydown', onKeyDown);
  };
}
