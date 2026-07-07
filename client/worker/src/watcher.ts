/**
 * File-change watcher -- phase E9 ("live follow") real implementation, replacing the
 * E8 stub. Two independent mechanisms feed the same `onChange` callback (either is
 * sufficient on its own -- this is deliberately belt-and-suspenders, matching the
 * port plan's "fs.watch + 3s poll hybrid"):
 *
 *  - `fs.watch()`: near-instant, but notoriously unreliable at the edges --
 *    platform-dependent, can fire spuriously (e.g. several events for one logical
 *    write), and can silently stop delivering events across a rename (a simulation
 *    restart that truncates+reopens, or deletes+recreates, the file at the same
 *    path -- `inotify` on Linux watches the *inode*, not the path, so a fresh inode
 *    at the same path is invisible to an already-established watch). Both cases are
 *    handled here: spurious fires are harmless (`EngineSession.checkForChanges()`/
 *    `elog/checkChanges` is idempotent -- a no-op unless the file actually changed
 *    since the last synchronize), and a `rename` event triggers a best-effort
 *    re-`fs.watch()` of the same path so a recreated file keeps being watched.
 *  - The poll timer: the reliable fallback that works on any filesystem (including
 *    network mounts where `fs.watch` support is patchy or entirely unsupported), at
 *    the cost of latency. `pollIntervalMs` mirrors the Eclipse IDE's
 *    `EventLogInput`'s `RecurringJob(3000)` (`ElogOpenOptions.pollIntervalMs`,
 *    default 3000); `0` disables it (tests drive change detection deterministically
 *    via a manual `elog/checkChanges` request instead of waiting on a timer).
 *
 * Neither mechanism does any engine work itself -- both only ever *request* a check
 * by calling `onChange()`. `main.ts`'s caller (`requestCheckFileChange()`) turns that
 * into a low-priority `elog/checkChanges` job on the engine thread's regular FIFO
 * queue, deduplicated so at most one such job is outstanding at a time -- see
 * main.ts's header for why that's enough to satisfy "must not preempt in-flight
 * jobs; dedupe if one is already queued" even though this module fires `onChange()`
 * freely (main.ts is the one place that turns repeated calls into at most one
 * in-flight job).
 */

import * as fs from 'node:fs';

export interface FileWatcher {
  dispose(): void;
}

export interface WatchOptions {
  /** See this file's header. `undefined` uses the default (3000). `0` disables the poll timer entirely. */
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 3000;

export function watchFile(path: string, onChange: () => void, options: WatchOptions = {}): FileWatcher {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let disposed = false;
  let fsWatcher: fs.FSWatcher | null = null;

  function closeFsWatcher(): void {
    try {
      fsWatcher?.close();
    } catch {
      // already closed/invalid -- nothing to do
    }
    fsWatcher = null;
  }

  function tryWatch(): void {
    if (disposed) return;
    closeFsWatcher();
    try {
      const watcher = fs.watch(path, (eventType) => {
        if (disposed) return;
        onChange();
        // A 'rename' event (the file at `path` was deleted/recreated, e.g. a
        // simulation restart) can leave this watch pointed at an inode nothing will
        // ever write to again -- reattach, best effort. If `path` doesn't exist for
        // the brief moment mid-rename, `tryWatch()`'s own catch below just leaves us
        // poll-only until the next successful (re)attach attempt.
        if (eventType === 'rename') tryWatch();
      });
      watcher.on('error', () => {
        // e.g. EACCES/ENOSPC on some platforms/filesystems, or the watched path
        // disappearing out from under us -- fall back to poll-only silently (unless
        // the poll timer is also disabled, in which case only fs.watch's own retry
        // above, or a future manual `elog/checkChanges`, will notice further changes).
        closeFsWatcher();
      });
      // Never keeps the process alive on its own (matches the poll timer below) --
      // the JSON-RPC connection's stdio streams are what actually keep the worker
      // process running for as long as the extension host wants it to.
      watcher.unref();
      fsWatcher = watcher;
    } catch {
      // e.g. the path doesn't exist (yet, or momentarily mid-rename), or the
      // platform/filesystem doesn't support fs.watch at all (some network mounts) --
      // the poll timer (unless disabled) is the fallback either way.
      fsWatcher = null;
    }
  }
  tryWatch();

  let timer: ReturnType<typeof setInterval> | null = null;
  if (pollIntervalMs > 0) {
    timer = setInterval(() => {
      if (!disposed) onChange();
    }, pollIntervalMs);
    timer.unref();
  }

  return {
    dispose(): void {
      disposed = true;
      closeFsWatcher();
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
