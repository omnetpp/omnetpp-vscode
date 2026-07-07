/**
 * Phase U10 -- shared version-tolerant loader for the two per-webview persisted-state
 * blobs (`chartMain.ts`'s `PersistedChartState`, `tableView.ts`'s `PersistedTableState`).
 * Pulled out into its own DOM-free module (unlike `chartMain.ts`/`tableView.ts`, which
 * are the untested-by-design DOM glue, per that file's own header) so the migration
 * behavior itself is unit-testable (`client/webview/src/test/persistedState.test.ts`).
 *
 * Mirrors `client/src/eventlog/bookmarkStore.ts`'s already-versioned `BookmarksBlobV1`
 * decision record ("a small versioned blob... survives a full window reload"), but
 * generalized across two call sites with a single, deliberately simple policy (the port
 * plan's "a version bump test", "graceful migration"):
 *  - `raw` missing, `null`, or not an object at all -> fresh defaults (`{}`) -- covers a
 *    file that has never been persisted, and a corrupt/foreign value somehow lodged in
 *    `workspaceState`/`vscode.setState`.
 *  - `raw.version` ABSENT -- a pre-U10 blob, from before either persisted-state shape
 *    carried a `version` field at all. Every field either shape has ever had is (and
 *    remains) optional, so a plain merge is safe: an old blob's known fields round-trip,
 *    and any field it never had just stays `undefined` (the caller's own defaulting
 *    already handles that, same as today). Chosen over "treat versionless as garbage"
 *    because it costs nothing extra and avoids a needless one-time reset of chart/table
 *    preferences for every user upgrading into this phase.
 *  - `raw.version` PRESENT and `<= currentVersion` -- accepted as-is (version 1 today);
 *    the `version` key itself is stripped from the returned partial so it never leaks
 *    into the caller's own state object as a stray extra property.
 *  - `raw.version` PRESENT and `> currentVersion` (or not a number at all) -- a shape
 *    from a FUTURE build this version cannot safely interpret (field meanings may have
 *    changed) -- dropped entirely, fresh defaults, rather than risk merging fields whose
 *    semantics moved out from under them.
 */

/** Loads `raw` (whatever `vscode.getState()`/an inbound `persistedState` message payload happens to hold) into a plain partial `T`, per this file's header policy. Never throws. */
export function loadPersistedBlob<T extends object>(raw: unknown, currentVersion: number): Partial<T> {
  if (raw === null || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  if ('version' in obj) {
    const version = obj.version;
    if (typeof version !== 'number' || version > currentVersion) return {};
  }
  const { version: _version, ...rest } = obj;
  return rest as Partial<T>;
}

/** Stamps `version` onto `state` right before handing it to `vscode.setState()`/a `stateChanged` postMessage -- the write-side counterpart to `loadPersistedBlob()`. */
export function withVersion<T extends object>(state: T, version: number): T & { version: number } {
  return { ...state, version };
}
