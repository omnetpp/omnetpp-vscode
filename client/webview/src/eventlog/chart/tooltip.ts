/**
 * tooltip.ts — hover tooltip UI: 500ms idle after the pointer stops moving over the
 * chart -> hit-test at the last position -> resolve the hit into whatever engine data
 * the label text needs (may be a `getEventDetail` round trip for the event case) ->
 * render `labelProvider.ts`'s HTML into a positioned div. Dismissed on further mouse
 * movement (restarts the timer), `mouseleave`, or any wheel/scroll (the chart's own
 * `wheel` handler in `interactions.ts` pans/zooms, which would leave a stale tooltip
 * pointing at the wrong screen position otherwise).
 *
 * Port intent: Java's hover trigger is the platform's own `SWT.MouseHover`/JFace
 * `HoverSupport` default timing (no explicit delay constant in `SequenceChart.java` --
 * verified by reading the source, see `hitTest.ts`'s header for the same citation).
 * This port picks a concrete, documented `500ms` (this phase's own design note) since a
 * webview has no platform hover-delay concept to inherit.
 *
 * DOM-only, not unit-tested (same convention as `interactions.ts`/`canvasStack.ts`) --
 * the pure pieces it calls into (`hitTest()`, `labelProvider.ts`'s builders) are
 * covered by `hitTest.test.ts`/`labelProvider.test.ts`.
 */

import { buildTooltipHtml, type LabelProviderContext, type ResolvedHit } from './labelProvider';

export interface TooltipDeps {
  /** The element hover/mousemove/leave/wheel are observed on (the chart's canvas container). */
  hostElement: HTMLElement;
  /**
   * Resolves whatever is at content-area point `(px, py)` (same space as
   * `hitTest.ts`'s primitives) into label data, or `null` if nothing is there.
   * Async because the event case may need an on-demand `elog/getEventDetail` round
   * trip for the message-line dump (`chartMain.ts` supplies this, backed by the
   * currently-loaded viewport model + a direct RPC call).
   */
  resolveHit(px: number, py: number): Promise<ResolvedHit | null>;
  ctx: LabelProviderContext;
  hoverDelayMs?: number;
}

export interface TooltipHandle {
  dispose(): void;
}

const DEFAULT_HOVER_DELAY_MS = 500;

export function attachTooltip(deps: TooltipDeps): TooltipHandle {
  const { hostElement, resolveHit, ctx } = deps;
  const delay = deps.hoverDelayMs ?? DEFAULT_HOVER_DELAY_MS;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let tooltipEl: HTMLElement | null = null;

  function hide(): void {
    generation++;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    tooltipEl?.remove();
    tooltipEl = null;
  }

  function showAt(clientX: number, clientY: number, html: string): void {
    tooltipEl?.remove();
    const el = document.createElement('div');
    el.className = 'elog-tooltip';
    // `html` is labelProvider.ts-controlled markup (bold/br/span only, its own message-line
    // text already HTML-escaped) -- never raw, unescaped user/log content.
    el.innerHTML = html;
    document.body.appendChild(el);
    const rect = el.getBoundingClientRect();
    const left = Math.max(0, Math.min(clientX + 12, window.innerWidth - rect.width - 4));
    const top = Math.max(0, Math.min(clientY + 12, window.innerHeight - rect.height - 4));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    tooltipEl = el;
  }

  const onMouseMove = (e: MouseEvent): void => {
    hide();
    const rect = hostElement.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const clientX = e.clientX;
    const clientY = e.clientY;
    const myGeneration = generation;
    timer = setTimeout(() => {
      void resolveHit(px, py).then((resolved) => {
        if (myGeneration !== generation || !resolved) return;
        showAt(clientX, clientY, buildTooltipHtml(resolved, ctx));
      });
    }, delay);
  };

  const onDismiss = (): void => hide();

  hostElement.addEventListener('mousemove', onMouseMove);
  hostElement.addEventListener('mouseleave', onDismiss);
  hostElement.addEventListener('mousedown', onDismiss);
  hostElement.addEventListener('wheel', onDismiss, { passive: true });

  return {
    dispose(): void {
      hide();
      hostElement.removeEventListener('mousemove', onMouseMove);
      hostElement.removeEventListener('mouseleave', onDismiss);
      hostElement.removeEventListener('mousedown', onDismiss);
      hostElement.removeEventListener('wheel', onDismiss);
    },
  };
}
