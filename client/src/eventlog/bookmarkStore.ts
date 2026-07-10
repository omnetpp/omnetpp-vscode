/**
 * Bookmark storage -- the pure, `vscode`-free half of phase U6's "Bookmarks" decision
 * record row (see `bookmarks.ts`'s header for the thin `vscode`-dependent wiring on top
 * of this: the "Add Bookmark" input box, the "Show Bookmarks" QuickPick command). Kept
 * in its own file, deliberately free of any `vscode` import -- unlike `eventLogSession.
 * ts` (vscode-free so it can drive a REAL worker process headlessly), the reason here is
 * narrower but the same idea: a module that imports `vscode` at all cannot be loaded by
 * `bun:test` outside the extension host (there is no real `vscode` package to resolve),
 * so the part of this subsystem the task explicitly calls out for "pure store logic
 * tests" needs to live somewhere importable standalone.
 *
 * Port of the 5 `IMarker` kinds Eclipse's `SequenceChartContributor.java`/
 * `EventLogTableContributor.java` create for their own "Toggle bookmark(s)" actions
 * (verified by reading both sources) -- see `Bookmark`'s doc comment in
 * `@omnetpp/shared/ui-protocol` for the exact per-kind field mapping this store carries
 * opaquely (it never interprets a bookmark's kind-specific fields itself, only `kind`
 * for the identity-match in `bookmarkMatches()`).
 *
 * Storage shape: `workspaceState` key `omnetpp.eventlog.bookmarks:<uri>`, a small
 * versioned blob (`BookmarksBlobV1`) per open `.elog` file -- survives a full window
 * reload (the port plan's "State persistence" row lists `bookmarks` alongside
 * `chartState`/`tableState`/`filter`, all keyed the same way). `BookmarkStore` itself is
 * storage-agnostic behind the tiny structural `MementoLike` interface below, so a test
 * can pass an in-memory fake instead of a real `vscode.ExtensionContext.workspaceState`.
 */

import type { Bookmark, BookmarkCandidate } from '@omnetpp/shared/ui-protocol';

export const BOOKMARKS_KEY_PREFIX = 'omnetpp.eventlog.bookmarks:';

export interface BookmarksBlobV1 {
  version: 1;
  bookmarks: Bookmark[];
}

/** Structural subset of `vscode.Memento` this module needs -- lets tests pass a plain in-memory fake instead of a real `vscode.ExtensionContext.workspaceState`. */
export interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

// ---------------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------------

/** Identity match for toggling ("is this candidate the SAME bookmark as `b`?") -- per-kind, mirroring what each Java "Toggle bookmark" scan actually compares (event number / module path / cause+consequence+message id / event+entry index). */
export function bookmarkMatches(candidate: BookmarkCandidate, b: Bookmark): boolean {
  if (candidate.kind !== b.kind) return false;
  switch (candidate.kind) {
    case 'Event':
      return candidate.eventNumber === b.eventNumber;
    case 'Axis':
      return candidate.modulePath === b.modulePath;
    case 'MessageDependency':
      return candidate.eventNumber === b.eventNumber && candidate.consequenceEventNumber === b.consequenceEventNumber && candidate.messageId === b.messageId;
    case 'ComponentMethodCall':
      return candidate.eventNumber === b.eventNumber && candidate.entryIndex === b.entryIndex;
    case 'Position':
      return candidate.simulationTime === b.simulationTime;
  }
}

/**
 * A bookmark is stale once its referenced event number no longer exists (an
 * OVERWRITTEN log whose new content is shorter, or simply different, than before --
 * port plan: "stale bookmarks (event number beyond last after overwrite) shown greyed
 * in the list and skipped for markers"). `Axis`/`Position` bookmarks have no event
 * number and are never reported stale by this check (a documented simplification --
 * detecting "this module no longer exists"/"this simtime is out of range" would need an
 * engine round trip this function deliberately avoids, being a pure, engine-free
 * predicate).
 */
export function isStaleBookmark(bookmark: Bookmark, lastEventNumber: number): boolean {
  return typeof bookmark.eventNumber === 'number' && bookmark.eventNumber > lastEventNumber;
}

let nextFallbackId = 1;
function generateId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `bm-${Date.now()}-${nextFallbackId++}`;
}

/** Toggles `candidate` in `bookmarks`: deletes every matching bookmark if any exist (no prompt -- matches both Java "Toggle bookmark" actions' simple delete path), else appends one new bookmark labeled `label`. */
export function toggleBookmarkInList(bookmarks: Bookmark[], candidate: BookmarkCandidate, label: string): { bookmarks: Bookmark[]; added: boolean } {
  const hasMatch = bookmarks.some((b) => bookmarkMatches(candidate, b));
  if (hasMatch) return { bookmarks: bookmarks.filter((b) => !bookmarkMatches(candidate, b)), added: false };
  return { bookmarks: [...bookmarks, { ...candidate, id: generateId(), label }], added: true };
}

/** Loads a possibly-absent/older-shaped persisted blob into a plain `Bookmark[]` -- never throws on a missing/malformed value (a fresh file, or a blob from before this version existed). */
export function migrateBookmarksBlob(raw: unknown): Bookmark[] {
  if (raw && typeof raw === 'object' && Array.isArray((raw as Partial<BookmarksBlobV1>).bookmarks)) return (raw as BookmarksBlobV1).bookmarks;
  if (Array.isArray(raw)) return raw as Bookmark[];
  return [];
}

/**
 * Port of `TimeUtils.secondsToTimeString(BigDecimal)`, operating on the protocol's raw
 * decimal-seconds string directly (exact, no `BigDecimal` class needed). Duplicated here
 * rather than imported from `@omnetpp/shared/eventlog` (which already has this exact
 * algorithm, as `secondsToTimeString`) because that subpath pulls in the WHOLE eventlog
 * parsing/indexing/facade engine into the extension-host bundle for one small formatting
 * helper -- the same bundle-size concern that already motivated the webview's own
 * `formatSimulationTime()` (`client/webview/src/eventlog/common/decimalTime.ts`) to
 * duplicate this algorithm instead of importing `@omnetpp/shared`'s `BigDecimal`. This is
 * a further-trimmed variant of that webview version (no display-accuracy rounding --
 * there's no such per-user setting on the host side, and no other decimal-string
 * arithmetic is needed here, only this one direction of formatting).
 */
function formatSimulationTimeSeconds(decimalString: string): string {
  let str = decimalString.trim();
  let negative = false;
  if (str.startsWith('-')) {
    negative = true;
    str = str.slice(1);
  } else if (str.startsWith('+')) {
    str = str.slice(1);
  }
  const dot = str.indexOf('.');
  let intPart = ((dot < 0 ? str : str.slice(0, dot)) || '0').replace(/^0+(?=\d)/, '');
  let frac = dot < 0 ? '' : str.slice(dot + 1);
  let out = '';
  for (const unit of ['s ', 'ms ', 'us ', 'ns ', 'ps ', 'fs ', 'as ']) {
    if (intPart !== '0') out += `${BigInt(intPart)}${unit}`;
    const chunk = (frac + '000').slice(0, 3);
    frac = frac.length > 3 ? frac.slice(3) : '';
    intPart = chunk.replace(/^0+(?=\d)/, '') || '0';
  }
  if (out.length === 0) out = '0s';
  return (negative ? '-' : '') + out.trim();
}

/** Human-readable title for a QuickPick entry / chart marker tooltip. */
export function bookmarkTitle(b: Bookmark): string {
  switch (b.kind) {
    case 'Event':
      return `Event #${b.eventNumber}`;
    case 'Axis':
      return `Axis: ${b.modulePath}`;
    case 'MessageDependency':
      return `Message dependency (from event #${b.eventNumber})`;
    case 'ComponentMethodCall':
      return `${b.methodName ?? 'Method call'} (event #${b.eventNumber})`;
    case 'Position':
      // SI-unit formatted (e.g. "130ms", "1s 500ms"), not the raw decimal-seconds string --
      // matches how every other simulation-time display in this port (ruler, hairline,
      // tooltips) formats a `Bookmark.simulationTime`-shaped decimal string.
      return `Position: t = ${formatSimulationTimeSeconds(b.simulationTime ?? '0')}`;
  }
}

// ---------------------------------------------------------------------------------
// BookmarkStore -- one per open `.elog` file, backed by `MementoLike`.
// ---------------------------------------------------------------------------------

export class BookmarkStore {
  private bookmarks: Bookmark[];

  constructor(
    private readonly memento: MementoLike,
    private readonly uriString: string,
  ) {
    this.bookmarks = migrateBookmarksBlob(memento.get<BookmarksBlobV1 | null>(this.key(), null));
  }

  private key(): string {
    return BOOKMARKS_KEY_PREFIX + this.uriString;
  }

  list(): Bookmark[] {
    return this.bookmarks;
  }

  private async persist(): Promise<void> {
    const blob: BookmarksBlobV1 = { version: 1, bookmarks: this.bookmarks };
    await this.memento.update(this.key(), blob);
  }

  /** Toggles `candidate` (see `toggleBookmarkInList()`); `label` is used only when adding. */
  async toggle(candidate: BookmarkCandidate, label: string): Promise<{ added: boolean }> {
    const result = toggleBookmarkInList(this.bookmarks, candidate, label);
    this.bookmarks = result.bookmarks;
    await this.persist();
    return { added: result.added };
  }

  async remove(id: string): Promise<void> {
    this.bookmarks = this.bookmarks.filter((b) => b.id !== id);
    await this.persist();
  }

  /** "Bookmark Info" note editing: renames the bookmark `id` and/or replaces its notes. No-op if `id` no longer exists (e.g. removed by another webview mid-edit). */
  async update(id: string, label: string, note: string): Promise<void> {
    this.bookmarks = this.bookmarks.map((b) => (b.id === id ? { ...b, label, note } : b));
    await this.persist();
  }
}
