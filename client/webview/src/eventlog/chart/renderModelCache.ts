/**
 * renderModelCache.ts — client-side windowed cache over `elog/sc/getViewport`
 * (port plan: "new data fetched async with prefetch margins"; risk #4: "flat number
 * arrays in postMessage payloads"; risk: "responses racing zoom changes").
 *
 * Design:
 *  - Every visible-range request is expanded by a prefetch margin (default: one full
 *    viewport width on each side) before hitting the engine, so panning within that
 *    margin is served instantly from cache without a round trip.
 *  - Windows are keyed by `(mode, coordinateSystemVersion, filterGeneration)` plus
 *    their own `[leftTc, rightTc]` span; a request is a cache HIT if some window with
 *    a matching key fully covers the requested (un-margined) range.
 *  - In-flight requests are deduped by an exact `(fetchLeft, fetchRight, mode,
 *    version, filterGeneration)` key: a second caller asking for the same window
 *    while the fetch is still in flight attaches as an additional waiter instead of
 *    re-issuing the engine request.
 *  - STALE-RESPONSE PROTECTION (the "racing zoom changes" risk): every logical
 *    state change (pan/zoom/mode switch/filter change) the caller considers
 *    "new" bumps a monotonic `generation` counter (`bumpGeneration()`). Each waiter
 *    remembers the generation active when IT registered; when a fetch resolves,
 *    only waiters whose remembered generation still equals the CURRENT generation
 *    (checked at resolution time, not at registration time) are notified and the
 *    result is only cached if its `coordinateSystemVersion` still matches what the
 *    waiter expected. A years-old in-flight request racing a fresh zoom level simply
 *    has its result silently dropped for any waiter that's since gone stale.
 *  - VERSION-MISMATCH FLUSH: if the cache holds windows from an older
 *    `coordinateSystemVersion` than the one now being requested (timeline-mode
 *    switch, origin relocation, filter apply — anything that bumps the engine's
 *    coordinate system), the entire window cache is discarded outright (those
 *    windows' tc values are no longer comparable to anything).
 *  - LRU: capped at `maxWindows` (default 8); the least-recently-accessed window is
 *    evicted first once the cap is exceeded.
 *
 * REAL CANCELLATION (phase U4 — resolves the U3 "Known follow-up"): `common/rpc.ts`'s
 * `EngineRpc.requestCancelable()` now sends an actual `$/cancelRequest` to the worker
 * when cancelled (verified to reach the engine's own `progress()`-hook cancellation
 * checks, ~60ms turnaround per phase E8's measurement) — `EngineViewportSource.
 * getViewport()` below returns `{ promise, cancel }` instead of a bare `Promise` so
 * this cache can actually reclaim wasted engine work, not just discard a result it no
 * longer wants: `bumpGeneration()`/`invalidateAll()` now cancel every in-flight fetch
 * whose waiters are ALL already stale (nobody registered against the new generation),
 * rather than leaving it to complete unwatched. A fetch that still has at least one
 * current-generation waiter is left running (its result is still wanted).
 */

import type { TimelineMode, ViewportModel, ViewportParams } from '@omnetpp/shared/elog-protocol';
import { RequestCancelledError } from '../common/rpc';

/** What `renderModelCache.ts` needs from the RPC layer — kept minimal so tests can supply a fake without touching `common/rpc.ts`. `cancel()` must be safe to call even after the promise has already settled (a no-op then). */
export interface EngineViewportSource {
  getViewport(params: ViewportParams): { promise: Promise<ViewportModel>; cancel: () => void };
}

export interface RenderModelCacheOptions {
  /** Max cached windows (LRU). Default 8, per the port plan. */
  maxWindows?: number;
  /** Prefetch margin as a multiple of the requested (un-margined) range width. Default 1 (one viewport width each side), per the port plan. */
  prefetchFactor?: number;
  includeModuleIds?: number[];
  maxEvents?: number;
  /**
   * ADDITIVE (phase U9): called when a viewport fetch fails for a reason OTHER than
   * being cancelled by `bumpGeneration()`/`invalidateAll()` (a caller-initiated
   * supersede -- see this file's header -- surfaces as `RequestCancelledError` and is
   * NEVER reported here, since panning/zooming routinely cancels dozens of these and a
   * user-facing error for each would be absurd). A genuine engine/worker failure
   * (unexpected exception, or a `ContentChanged` retry that also failed) IS reported
   * here exactly once per failing fetch -- `chartMain.ts` feeds it through
   * `common/notificationOverlay.ts`'s `classifyEngineError()` to decide whether/how to
   * show the shared overlay.
   */
  onError?: (err: unknown) => void;
}

export interface ViewportRequest {
  leftTc: number;
  rightTc: number;
  timelineMode: TimelineMode;
  coordinateSystemVersion: number;
  /** Bumped by the caller whenever the active `FilterParams` change (U7); windows from a different filter generation are not reused even at the same coordinate-system version (filtering doesn't necessarily bump `coordinateSystemVersion`). Default 0. */
  filterGeneration?: number;
}

interface CacheWindow {
  leftTc: number;
  rightTc: number;
  mode: TimelineMode;
  version: number;
  filterGeneration: number;
  model: ViewportModel;
  lastAccess: number;
}

interface Waiter {
  generation: number;
  expectedVersion: number;
  onReady: (model: ViewportModel) => void;
}

interface InFlightEntry {
  waiters: Waiter[];
  /** Cancels the underlying engine request (see this file's header) — no-op if it already settled. */
  cancel: () => void;
}

export class RenderModelCache {
  private windows: CacheWindow[] = [];
  private readonly inFlight = new Map<string, InFlightEntry>();
  private generation = 0;
  private accessCounter = 0;

  constructor(
    private readonly source: EngineViewportSource,
    private readonly options: RenderModelCacheOptions = {},
  ) {}

  /**
   * Call whenever pan/zoom/mode/filter changes in a way that makes any in-flight
   * fetch's eventual answer no longer worth applying blindly (it may still be cached
   * once it lands, just not auto-delivered to a stale waiter). Phase U4: also
   * actually CANCELS (see this file's header) every in-flight fetch that has no
   * waiter at the new generation — i.e. every fetch nobody has re-registered
   * interest in since the bump, which in practice (every call site bumps generation
   * BEFORE any caller has had a chance to `request()` again) means "every fetch
   * in flight at the moment of the bump", freeing the engine's serial job queue
   * instead of leaving it to grind through a now-useless viewport fetch.
   */
  bumpGeneration(): number {
    const newGeneration = ++this.generation;
    for (const [key, entry] of this.inFlight) {
      if (!entry.waiters.some((w) => w.generation === newGeneration)) {
        entry.cancel();
        this.inFlight.delete(key);
      }
    }
    return newGeneration;
  }

  currentGeneration(): number {
    return this.generation;
  }

  /** Drops every cached window and forgets all in-flight waiters (bumps the generation so any of their eventual results are ignored too). Called on `coordinateSystemVersion` mismatch, or explicitly by the caller on a hard reset. */
  invalidateAll(): void {
    this.windows = [];
    this.bumpGeneration();
  }

  getCachedWindowCount(): number {
    return this.windows.length;
  }

  /**
   * Requests a `ViewportModel` covering `[req.leftTc, req.rightTc]`. Returns the
   * model synchronously if a cached window already covers it; otherwise triggers
   * (or joins) an async prefetch-margined fetch and returns `null` — `onReady` is
   * called later, but ONLY if this call's generation is still current when the
   * fetch resolves (see this file's header).
   */
  request(req: ViewportRequest, onReady: (model: ViewportModel) => void): ViewportModel | null {
    const filterGeneration = req.filterGeneration ?? 0;

    if (this.windows.length > 0 && this.windows[0].version !== req.coordinateSystemVersion) this.invalidateAll();

    const hit = this.findCovering(req.leftTc, req.rightTc, req.timelineMode, req.coordinateSystemVersion, filterGeneration);
    if (hit) {
      hit.lastAccess = ++this.accessCounter;
      return hit.model;
    }

    const width = req.rightTc - req.leftTc;
    const margin = width * (this.options.prefetchFactor ?? 1);
    const fetchLeft = req.leftTc - margin;
    const fetchRight = req.rightTc + margin;
    const key = `${fetchLeft}:${fetchRight}:${req.timelineMode}:${req.coordinateSystemVersion}:${filterGeneration}`;
    const waiter: Waiter = { generation: this.generation, expectedVersion: req.coordinateSystemVersion, onReady };

    let entry = this.inFlight.get(key);
    if (!entry) {
      const params: ViewportParams = {
        range: { kind: 'tc', tcBegin: fetchLeft, tcEnd: fetchRight },
        includeModuleIds: this.options.includeModuleIds,
        maxEvents: this.options.maxEvents,
      };
      const { promise, cancel } = this.source.getViewport(params);
      entry = { waiters: [], cancel };
      this.inFlight.set(key, entry);
      promise
        .then((model) => {
          this.inFlight.delete(key);
          if (model.coordinateSystemVersion === req.coordinateSystemVersion) {
            this.addWindow({ leftTc: fetchLeft, rightTc: fetchRight, mode: req.timelineMode, version: model.coordinateSystemVersion, filterGeneration, model, lastAccess: ++this.accessCounter });
          }
          for (const w of entry!.waiters) {
            if (w.generation === this.generation && w.expectedVersion === model.coordinateSystemVersion) w.onReady(model);
          }
        })
        .catch((err: unknown) => {
          // cancelled (see `cancel()` above) or a real engine error -- either way, stop tracking it;
          // there is no waiter left to usefully notify of a rejection (`request()` only ever hands
          // back a value via `onReady`/the synchronous cache-hit return, never a rejection). A
          // GENUINE (non-cancel) failure is still worth surfacing to the caller though (phase U9) --
          // see `RenderModelCacheOptions.onError`'s doc comment on why cancels are excluded.
          this.inFlight.delete(key);
          if (!(err instanceof RequestCancelledError)) this.options.onError?.(err);
        });
    }
    entry.waiters.push(waiter);
    return null;
  }

  private findCovering(leftTc: number, rightTc: number, mode: TimelineMode, version: number, filterGeneration: number): CacheWindow | undefined {
    return this.windows.find((w) => w.mode === mode && w.version === version && w.filterGeneration === filterGeneration && w.leftTc <= leftTc && w.rightTc >= rightTc);
  }

  private addWindow(w: CacheWindow): void {
    this.windows.push(w);
    const maxWindows = this.options.maxWindows ?? 8;
    if (this.windows.length > maxWindows) {
      this.windows.sort((a, b) => a.lastAccess - b.lastAccess);
      this.windows.splice(0, this.windows.length - maxWindows);
    }
  }
}
