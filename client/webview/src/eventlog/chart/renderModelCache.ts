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
 * NOTE ON REAL CANCELLATION (protocol-gap workaround, flagged per this phase's
 * report): `common/rpc.ts`'s `EngineRpc.cancel()` only drops the LOCAL pending-map
 * entry — it does not send `$/cancelRequest` to the worker (its own doc comment
 * calls real cancellation "a U3/U4 concern", but `rpc.ts` is outside this phase's
 * file ownership, so wiring cancellation through it is not done here). The
 * consequence: a superseded `elog/sc/getViewport` request keeps running to
 * completion on the engine's serial job queue even after this cache has stopped
 * caring about its answer — wasted engine work, not a correctness problem (the
 * generation check above still discards the result). A future phase that owns
 * `rpc.ts` could plumb a real `CancellationToken` through `engineRequest` to reclaim
 * that wasted work.
 */

import type { TimelineMode, ViewportModel, ViewportParams } from '@omnetpp/shared/elog-protocol';

/** What `renderModelCache.ts` needs from the RPC layer — kept minimal so tests can supply a fake without touching `common/rpc.ts`. */
export interface EngineViewportSource {
  getViewport(params: ViewportParams): Promise<ViewportModel>;
}

export interface RenderModelCacheOptions {
  /** Max cached windows (LRU). Default 8, per the port plan. */
  maxWindows?: number;
  /** Prefetch margin as a multiple of the requested (un-margined) range width. Default 1 (one viewport width each side), per the port plan. */
  prefetchFactor?: number;
  includeModuleIds?: number[];
  maxEvents?: number;
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

  /** Call whenever pan/zoom/mode/filter changes in a way that makes any in-flight fetch's eventual answer no longer worth applying blindly (it may still be cached once it lands, just not auto-delivered to a stale waiter). */
  bumpGeneration(): number {
    return ++this.generation;
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
      entry = { waiters: [] };
      this.inFlight.set(key, entry);
      const params: ViewportParams = {
        range: { kind: 'tc', tcBegin: fetchLeft, tcEnd: fetchRight },
        includeModuleIds: this.options.includeModuleIds,
        maxEvents: this.options.maxEvents,
      };
      void this.source.getViewport(params).then((model) => {
        this.inFlight.delete(key);
        if (model.coordinateSystemVersion === req.coordinateSystemVersion) {
          this.addWindow({ leftTc: fetchLeft, rightTc: fetchRight, mode: req.timelineMode, version: model.coordinateSystemVersion, filterGeneration, model, lastAccess: ++this.accessCounter });
        }
        for (const w of entry!.waiters) {
          if (w.generation === this.generation && w.expectedVersion === model.coordinateSystemVersion) w.onReady(model);
        }
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
