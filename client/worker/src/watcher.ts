/**
 * File-change watcher -- STUB for phase E8 (per the port plan/E8 task list: "the
 * watcher can be a stub file this phase -- full live-follow is E9, but the change-
 * check request path should exist"). `main.ts`'s 3s poll timer (which drives the
 * engine thread's `checkChanges` message, independent of this module -- see
 * engineThread.ts) already exercises that request path end-to-end; this module is
 * where E9 will add the low-latency `fs.watch()`-driven push side (so a change is
 * noticed immediately instead of waiting for the next poll tick) without changing
 * `main.ts`'s call site.
 */

export interface FileWatcher {
  dispose(): void;
}

/**
 * E9 will make this call `fs.watch(path, ...)` and invoke `onChange` promptly on a
 * rename/change event (debounced), in addition to (not instead of) the poll timer.
 * For now it is a no-op that still returns a valid, disposable handle, so
 * `main.ts`'s lifecycle code doesn't need to change shape once E9 lands.
 */
export function watchFile(path: string, onChange: () => void): FileWatcher {
  void path;
  void onChange;
  return { dispose(): void {} };
}
