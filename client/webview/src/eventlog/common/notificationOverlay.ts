/**
 * notificationOverlay.ts (phase U9) -- a shared full-body overlay both the Sequence
 * Chart and Event Log table webviews mount over their own content area (`.elog-body`),
 * port of the three in-widget notification screens `SequenceChart.java`/
 * `EventLogTable.java`/`EventLogInput.java`'s `runWithProgressMonitor` error paths show
 * (`displayMessage`/`paintMessage`/`isOutOfSync`, read in full):
 *  - `'canceled'` -- a long-running operation the USER explicitly interrupted (a
 *    visible Cancel affordance, e.g. the filter panel's busy-Cancel button) -- "the
 *    operation was canceled" + a Refresh link.
 *  - `'outOfSync'` -- the underlying `.elog` file changed in a way this webview
 *    couldn't cleanly ride out (Java: `EventLogInput.isOutOfSync()`'s "please refresh"
 *    banner) -- surfaces after `workerClient.ts`'s automatic single `ContentChanged`
 *    retry ALSO fails (a second failure for the same underlying cause, not the
 *    ordinary/expected first one, which the retry already absorbs silently).
 *  - `'error'` -- an unexpected engine/worker failure (Java: "an internal error
 *    occurred, please report it" + a Refresh link) -- message + a collapsible Details
 *    expander with the raw error text.
 *
 * `classifyEngineError()` (pure, unit-tested) is the state-machine half: it decides
 * WHICH of the three (or `null` = stay silent) a given `engineRequest` rejection
 * should produce. `mountNotificationOverlay()` (DOM, not unit-tested -- same
 * convention as `interactions.ts`/`dialogs.ts`) is the thin rendering half.
 */

import { RequestCancelledError } from './rpc';

export type NotificationKind = 'canceled' | 'outOfSync' | 'error';

export interface NotificationState {
  kind: NotificationKind;
  message: string;
  /** Raw error text for the `'error'` kind's collapsible expander; omitted for `'canceled'`/`'outOfSync'` (nothing extra to show). */
  details?: string;
}

export interface ClassifyErrorOptions {
  /**
   * `true` when this rejection is KNOWN to correspond to a long-running operation the
   * user explicitly canceled via a visible Cancel affordance (the filter panel's busy
   * overlay, U7) -- see this file's header on the `'canceled'` kind. Default `false`:
   * a bare `RequestCancelledError` reaching this classifier with no such context is, by
   * this port's own construction, always a caller abandoning its OWN now-unwanted
   * fetch (`EngineRpc.cancel()`'s only caller in this codebase cancels a request IT
   * ISSUED, e.g. `RenderModelCache.bumpGeneration()` dropping a superseded viewport
   * prefetch during pan/zoom churn -- there is no "someone else/the server cancelled
   * your job" concept on this wire) -- these must stay silent, or panning would flash
   * an error/canceled screen dozens of times a second.
   */
  userCanceled?: boolean;
}

/** Matches `ContentChangedError`'s own wording (`engineSession.ts`: `` `eventlog file changed (${change})` ``) -- see this file's header on the `'outOfSync'` kind. */
const CONTENT_CHANGED_RE = /eventlog file changed/i;

/**
 * Classifies an `engineRequest` rejection into a `NotificationState`, or `null` when
 * the rejection should stay silent (see this file's header + `ClassifyErrorOptions`'s
 * doc comment on the cancellation split). Total and defensive: never throws, works on
 * any `unknown` rejection value (a plain `Error`, a `vscode-jsonrpc` `ResponseError`,
 * or a bare string/other thrown value).
 */
export function classifyEngineError(err: unknown, opts: ClassifyErrorOptions = {}): NotificationState | null {
  if (err instanceof RequestCancelledError) {
    return opts.userCanceled ? { kind: 'canceled', message: 'The operation was canceled.' } : null;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (CONTENT_CHANGED_RE.test(message)) {
    return { kind: 'outOfSync', message: 'The event log file changed while this request was in progress. Refresh to reload.', details: message };
  }
  return { kind: 'error', message: 'An unexpected error occurred.', details: message };
}

// ---------------------------------------------------------------------------------
// DOM overlay (not unit-tested -- see this file's header)
// ---------------------------------------------------------------------------------

export interface NotificationOverlayHandle {
  show(state: NotificationState): void;
  hide(): void;
  isShown(): boolean;
}

const KIND_ICON: Record<NotificationKind, string> = { canceled: 'circle-slash', outOfSync: 'warning', error: 'error' };

/** Mounts a hidden-by-default overlay into `container` (expected: `position:relative`, e.g. `.elog-body`) and returns a handle to show/hide it. `onRefresh` is called both when the user clicks the overlay's "Refresh" button. */
export function mountNotificationOverlay(container: HTMLElement, onRefresh: () => void): NotificationOverlayHandle {
  const el = document.createElement('div');
  el.className = 'elog-notification-overlay';
  el.style.display = 'none';
  container.appendChild(el);
  let shown = false;

  function hide(): void {
    shown = false;
    el.style.display = 'none';
  }

  function show(state: NotificationState): void {
    shown = true;
    el.innerHTML = '';
    el.style.display = 'flex';

    const icon = document.createElement('span');
    icon.className = `codicon codicon-${KIND_ICON[state.kind]} elog-notification-icon`;
    el.appendChild(icon);

    const msg = document.createElement('div');
    msg.className = 'elog-notification-message';
    msg.textContent = state.message;
    el.appendChild(msg);

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'elog-notification-refresh';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.addEventListener('click', () => {
      hide();
      onRefresh();
    });
    el.appendChild(refreshBtn);

    if (state.details) {
      const details = document.createElement('details');
      details.className = 'elog-notification-details';
      const summary = document.createElement('summary');
      summary.textContent = 'Details';
      const pre = document.createElement('pre');
      pre.textContent = state.details;
      details.append(summary, pre);
      el.appendChild(details);
    }
  }

  return { show, hide, isShown: () => shown };
}
