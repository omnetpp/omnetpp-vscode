/**
 * "Toggle Bookmark"/"Show Bookmarks" host-side wiring (phase U6, "Bookmarks" decision
 * record row) -- the thin `vscode`-dependent half; `bookmarkStore.ts` holds the pure
 * storage/toggle logic and stays importable outside the extension host (see that
 * file's header for why the split exists). Re-exports `bookmarkStore.ts`'s public
 * surface too, so callers elsewhere in `client/src/eventlog/` (e.g.
 * `eventLogController.ts`) can import everything bookmark-related from this one
 * module without needing to know about the split.
 *
 * Reveal (`revealBookmark()`): Event/MessageDependency/ComponentMethodCall kinds all
 * carry an `eventNumber` and reveal exactly like a goto (both chart and table, via
 * `EventLogSession.gotoEvent()`, which already broadcasts a `reveal` to every
 * attachment) -- a documented simplification vs. Java's per-kind
 * `SequenceChartEditor.gotoMarker()` (which re-resolves the exact dependency/method-call
 * object and scrolls to the arrow/call itself, not just the containing event): landing
 * on the right event's row/mark is enough to find the bookmarked item by eye, and Java
 * itself never synchronizes an Axis/MessageDependency/ComponentMethodCall bookmark's
 * reveal to the OTHER editor anyway (its header note: "reveal is per-editor, not
 * synchronized across table + chart" -- this port already does strictly better by
 * revealing in both). Axis kind has no event at all -- it reveals by asking the chart
 * webview to center that axis (`sendCommand('centerOnAxisBookmark', ...)`); the table
 * has nothing meaningful to do for a module-only bookmark, so it is left untouched.
 * Position kind (a bare timeline position, no event/module) similarly asks the chart to
 * center on its simulation time (`sendCommand('centerOnSimulationTimeBookmark', ...)`).
 */

import * as vscode from 'vscode';
import type { Bookmark, BookmarkCandidate, BookmarkKind } from '@omnetpp/shared/ui-protocol';
import { bookmarkMatches, bookmarkTitle, isStaleBookmark, type BookmarkStore } from './bookmarkStore';
import type { EventLogController } from './eventLogController';
import type { EventLogSession } from './eventLogSession';

export * from './bookmarkStore';

/**
 * Handles a webview's `toggleBookmark` message: silently deletes an existing match
 * (matches Java's plain delete, no confirmation), otherwise prompts for a label via a
 * native input box (`InputDialog` in Java) and adds it if the user doesn't cancel.
 * Either way, broadcasts the fresh list to every attached webview (origin included --
 * unlike selection, there is no echo/re-entry concern for a one-shot toggle).
 */
export async function handleToggleBookmarkMessage(store: BookmarkStore, session: EventLogSession, candidate: BookmarkCandidate): Promise<void> {
  const alreadyBookmarked = store.list().some((b) => bookmarkMatches(candidate, b));
  if (alreadyBookmarked) {
    await store.toggle(candidate, '');
  } else {
    const label = await vscode.window.showInputBox({ prompt: 'Enter Bookmark name:', placeHolder: bookmarkKindDefaultPrompt(candidate.kind) });
    if (label === undefined) return; // cancelled -- do not add
    await store.toggle(candidate, label);
  }
  session.postToAll({ type: 'bookmarksChanged', bookmarks: store.list() });
}

function bookmarkKindDefaultPrompt(kind: BookmarkKind): string {
  switch (kind) {
    case 'Event':
      return 'e.g. "interesting timeout"';
    case 'Axis':
      return 'e.g. "the bottleneck module"';
    case 'MessageDependency':
      return 'e.g. "the lost packet"';
    case 'ComponentMethodCall':
      return 'e.g. "the misbehaving call"';
    case 'Position':
      return 'e.g. "steady state reached"';
  }
}

/** Reveals `bookmark` in both attached webviews (Event/MessageDependency/ComponentMethodCall kinds), centers the chart on its axis (Axis kind), or centers the chart on its timeline position (Position kind) -- see this file's header for the per-kind rationale. */
export async function revealBookmark(session: EventLogSession, bookmark: Bookmark): Promise<void> {
  if (bookmark.kind === 'Axis') {
    session.sendCommand('centerOnAxisBookmark', { modulePath: bookmark.modulePath });
    return;
  }
  if (bookmark.kind === 'Position') {
    session.sendCommand('centerOnSimulationTimeBookmark', { simulationTime: bookmark.simulationTime });
    return;
  }
  if (typeof bookmark.eventNumber !== 'number') return;
  try {
    await session.gotoEvent({ eventNumber: bookmark.eventNumber });
  } catch {
    // engine busy/unresolvable -- best-effort, matches every other goto call site's error handling
  }
}

/**
 * `omnetpp.eventlog.showBookmarks` -- native QuickPick over the relevant session's
 * bookmarks (no in-webview equivalent is possible: a webview cannot show OS-native
 * quick-pick UI under CSP). Stale bookmarks (see `isStaleBookmark()`) are shown
 * greyed/flagged and are not selectable-to-reveal (matches the port plan: "skipped for
 * markers"). Prefers the focused Sequence Chart editor's session (matches the
 * `editor/title` entry point); falls back to `fallbackSession` (the Event Log table
 * panel's currently-bound session -- see `eventLogTableView.ts`'s `getBoundSession()`)
 * for the `view/title` entry point, so the command still works when only the panel,
 * not any chart editor, is open/focused.
 */
export async function showBookmarksCommand(controller: EventLogController, fallbackSession?: EventLogSession): Promise<void> {
  const session = controller.getActiveSession() ?? fallbackSession;
  if (!session) {
    void vscode.window.showInformationMessage('OMNeT++: Show Bookmarks needs an open Sequence Chart editor or Event Log table.');
    return;
  }
  const store = controller.getBookmarkStore(vscode.Uri.parse(session.uriString));
  const bookmarks = store.list();
  if (bookmarks.length === 0) {
    void vscode.window.showInformationMessage('OMNeT++: this event log has no bookmarks yet.');
    return;
  }
  const lastEventNumber = session.summary?.lastEventNumber ?? null;
  interface Item extends vscode.QuickPickItem {
    bookmark: Bookmark;
    stale: boolean;
  }
  const items: Item[] = bookmarks.map((b) => {
    const stale = lastEventNumber !== null && isStaleBookmark(b, lastEventNumber);
    return {
      label: `${stale ? '$(warning) ' : ''}${bookmarkTitle(b)}`,
      description: b.label,
      detail: stale ? 'Stale -- this event no longer exists in the current log' : undefined,
      bookmark: b,
      stale,
    };
  });
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Go to bookmark' });
  if (!picked || picked.stale) return;
  await revealBookmark(session, picked.bookmark);
}
