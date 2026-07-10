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

interface ParsedDecimal {
  negative: boolean;
  intDigits: string;
  fracDigits: string;
}

function parseDecimalString(s: string): ParsedDecimal {
  let str = s.trim();
  let negative = false;
  if (str.startsWith('-')) {
    negative = true;
    str = str.slice(1);
  } else if (str.startsWith('+')) {
    str = str.slice(1);
  }
  const dot = str.indexOf('.');
  const intDigits = (dot < 0 ? str : str.slice(0, dot)) || '0';
  const fracDigits = dot < 0 ? '' : str.slice(dot + 1);
  return { negative, intDigits, fracDigits };
}

function stripLeadingZeros(digits: string): string {
  return digits.replace(/^0+(?=\d)/, '') || '0';
}

function formatFromUnscaled(unscaled: bigint, scale: number): string {
  const negative = unscaled < 0n;
  const abs = negative ? -unscaled : unscaled;
  const digits = abs.toString().padStart(scale + 1, '0');
  const intLen = digits.length - scale;
  const intPart = stripLeadingZeros(digits.slice(0, intLen)) || '0';
  const fracPartRaw = scale > 0 ? digits.slice(intLen) : '';
  const fracPart = fracPartRaw.replace(/0+$/, '');
  const result = fracPart ? `${intPart}.${fracPart}` : intPart;
  return (negative && result !== '0' ? '-' : '') + result;
}

/** Rounds a decimal string to at most `maxFractionDigits` fractional digits (round-half-away-from-zero), exactly, via BigInt. Returns the input unchanged when it already has few enough fractional digits. */
function roundDecimalString(decimalString: string, maxFractionDigits: number): string {
  const v = parseDecimalString(decimalString);
  if (v.fracDigits.length <= maxFractionDigits) return decimalString;
  const drop = v.fracDigits.length - maxFractionDigits;
  const divisor = 10n ** BigInt(drop);
  const magnitude = BigInt(v.intDigits + v.fracDigits);
  const rounded = (magnitude + divisor / 2n) / divisor; // round half up on the magnitude
  return formatFromUnscaled(v.negative ? -rounded : rounded, maxFractionDigits);
}

/**
 * Port of `TimeUtils.secondsToTimeString(BigDecimal)`, operating on the protocol's raw
 * decimal-seconds string directly (exact, no `BigDecimal` class needed) and rounding
 * first to `maxFractionDigits` (of a value in SECONDS, matching `decimalTime.ts`'s
 * "Time Accuracy" setting; `null`/omitted = full precision, no rounding).
 *
 * Duplicated here rather than imported from `@omnetpp/shared/eventlog` (which already
 * has this exact algorithm, as `secondsToTimeString`/`roundDecimalString`) because that
 * subpath pulls in the WHOLE eventlog parsing/indexing/facade engine into the
 * extension-host bundle for a handful of small formatting helpers -- the same
 * bundle-size concern that already motivated the webview's own `decimalTime.ts` to
 * duplicate this algorithm instead of importing `@omnetpp/shared`'s `BigDecimal`.
 */
function formatSimulationTimeSeconds(decimalString: string, maxFractionDigits: number | null): string {
  if (maxFractionDigits != null) decimalString = roundDecimalString(decimalString, maxFractionDigits);
  const parsed = parseDecimalString(decimalString);
  let intPart = stripLeadingZeros(parsed.intDigits);
  let frac = parsed.fracDigits;
  let out = '';
  for (const unit of ['s ', 'ms ', 'us ', 'ns ', 'ps ', 'fs ', 'as ']) {
    if (intPart !== '0') out += `${BigInt(intPart)}${unit}`;
    const chunk = (frac + '000').slice(0, 3);
    frac = frac.length > 3 ? frac.slice(3) : '';
    intPart = stripLeadingZeros(chunk);
  }
  if (out.length === 0) out = '0s';
  return (parsed.negative ? '-' : '') + out.trim();
}

/**
 * Human-readable title for a QuickPick entry / chart marker tooltip. `maxFractionDigits`
 * is the chart's currently-persisted "Time Accuracy" setting (see
 * `EventLogController.getChartTimeAccuracy()`) -- a `Position` bookmark's `t = ...` label
 * rounds to it, matching every other simulation-time display in this port (ruler,
 * hairline, tooltips), instead of always showing full precision regardless of what the
 * user picked in the chart.
 */
export function bookmarkTitle(b: Bookmark, maxFractionDigits: number | null = null): string {
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
      return `Position: t = ${formatSimulationTimeSeconds(b.simulationTime ?? '0', maxFractionDigits)}`;
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
