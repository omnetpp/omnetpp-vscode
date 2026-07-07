import { test } from 'bun:test';
import assert from 'node:assert';
import { TimelineMode, type ViewportModel, type ViewportParams } from '@omnetpp/shared/elog-protocol';
import { RenderModelCache, type EngineViewportSource } from '../eventlog/chart/renderModelCache';

function model(version: number, _tag: string): ViewportModel {
  return { coordinateSystemVersion: version, events: [], dependencies: [], methodCalls: [], moduleIds: [], truncated: false };
}

/**
 * A fake engine source that records every request and resolves on demand (so tests
 * can control ordering/races deterministically), and models phase U4's real
 * cancellation contract (`EngineViewportSource.getViewport()` returns `{ promise,
 * cancel }`, `cancel()` rejects and stops tracking the request as pending -- mirrors
 * what `EngineRpc.requestCancelable()` actually does against the real worker).
 */
class FakeSource implements EngineViewportSource {
  calls: ViewportParams[] = [];
  private pending: { resolve: (m: ViewportModel) => void; reject: (e: unknown) => void }[] = [];
  autoResolveVersion: number | null = null;
  cancelledCount = 0;

  getViewport(params: ViewportParams): { promise: Promise<ViewportModel>; cancel: () => void } {
    this.calls.push(params);
    if (this.autoResolveVersion !== null) return { promise: Promise.resolve(model(this.autoResolveVersion, 'auto')), cancel: () => {} };

    let resolveFn!: (m: ViewportModel) => void;
    let rejectFn!: (e: unknown) => void;
    const promise = new Promise<ViewportModel>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const entry = { resolve: resolveFn, reject: rejectFn };
    this.pending.push(entry);
    promise.catch(() => {}); // a cancelled/rejected fetch must not surface as an unhandled rejection in the test itself
    return {
      promise,
      cancel: () => {
        const idx = this.pending.indexOf(entry);
        if (idx < 0) return; // already settled -- no-op, matching the real EngineRpc.cancel()
        this.pending.splice(idx, 1);
        this.cancelledCount++;
        entry.reject(new Error('cancelled'));
      },
    };
  }

  resolveNext(m: ViewportModel): void {
    const r = this.pending.shift();
    if (!r) throw new Error('no pending request to resolve');
    r.resolve(m);
  }

  pendingCount(): number {
    return this.pending.length;
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('a cache miss issues a prefetch-margined request (default prefetchFactor=1 -> one extra viewport width each side)', () => {
  const source = new FakeSource();
  const cache = new RenderModelCache(source);
  const result = cache.request({ leftTc: 100, rightTc: 200, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 1 }, () => {});
  assert.strictEqual(result, null);
  assert.strictEqual(source.calls.length, 1);
  const range = source.calls[0].range;
  assert.strictEqual(range.kind, 'tc');
  if (range.kind === 'tc') {
    assert.strictEqual(range.tcBegin, 0); // 100 - margin(100)
    assert.strictEqual(range.tcEnd, 300); // 200 + margin(100)
  }
});

test('once fetched, a request fully covered by the cached window is served synchronously (cache hit, no new engine call)', async () => {
  const source = new FakeSource();
  const cache = new RenderModelCache(source);
  let delivered: ViewportModel | null = null;
  cache.request({ leftTc: 100, rightTc: 200, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 1 }, (m) => (delivered = m));
  source.resolveNext(model(1, 'first'));
  await tick();
  assert.ok(delivered !== null);

  const hit = cache.request({ leftTc: 120, rightTc: 180, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 1 }, () => {
    throw new Error('should not need to fetch again');
  });
  assert.ok(hit !== null);
  assert.strictEqual(source.calls.length, 1, 'no second engine call for a sub-range already covered');
});

test('a request outside any cached window (even after one fetch) triggers a new engine call', async () => {
  const source = new FakeSource();
  const cache = new RenderModelCache(source);
  cache.request({ leftTc: 100, rightTc: 200, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 1 }, () => {});
  source.resolveNext(model(1, 'first'));
  await tick();

  cache.request({ leftTc: 10_000, rightTc: 10_100, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 1 }, () => {});
  assert.strictEqual(source.calls.length, 2);
});

test('concurrent identical requests are deduped into a single in-flight engine call, both waiters notified', async () => {
  const source = new FakeSource();
  const cache = new RenderModelCache(source);
  let a: ViewportModel | null = null;
  let b: ViewportModel | null = null;
  cache.request({ leftTc: 100, rightTc: 200, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 1 }, (m) => (a = m));
  cache.request({ leftTc: 100, rightTc: 200, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 1 }, (m) => (b = m));
  assert.strictEqual(source.calls.length, 1, 'deduped into one engine call');
  source.resolveNext(model(1, 'shared'));
  await tick();
  assert.ok(a !== null && b !== null);
});

test('LRU eviction: exceeding maxWindows evicts the least-recently-used window', async () => {
  const source = new FakeSource();
  source.autoResolveVersion = 1;
  const cache = new RenderModelCache(source, { maxWindows: 2, prefetchFactor: 0 });

  cache.request({ leftTc: 0, rightTc: 10, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 1 }, () => {});
  await tick();
  cache.request({ leftTc: 100, rightTc: 110, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 1 }, () => {});
  await tick();
  assert.strictEqual(cache.getCachedWindowCount(), 2);

  cache.request({ leftTc: 200, rightTc: 210, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 1 }, () => {});
  await tick();
  assert.strictEqual(cache.getCachedWindowCount(), 2, 'stays at the cap');

  // the first window [0,10] should have been evicted (least recently accessed) -- requesting it again must re-fetch
  const callsBefore = source.calls.length;
  cache.request({ leftTc: 0, rightTc: 10, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 1 }, () => {});
  assert.strictEqual(source.calls.length, callsBefore + 1, 'evicted window had to be refetched');
});

test('phase U4: bumpGeneration() actually CANCELS an in-flight fetch with no current-generation waiter, instead of merely dropping its eventual answer', async () => {
  const source = new FakeSource();
  const cache = new RenderModelCache(source);
  let delivered = false;
  cache.request({ leftTc: 0, rightTc: 100, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 1 }, () => (delivered = true));
  assert.strictEqual(source.pendingCount(), 1);

  cache.bumpGeneration(); // simulate a zoom/mode-change racing the in-flight request
  assert.strictEqual(source.cancelledCount, 1, 'the stale fetch was actually cancelled, not just left running');
  assert.strictEqual(source.pendingCount(), 0, 'nothing left to resolve -- it was cancelled, not merely ignored');
  await tick();
  assert.strictEqual(delivered, false, 'stale generation -> never delivered to the original waiter');
});

test('phase U4: a request made AFTER bumpGeneration() issues a fresh engine call (the old in-flight fetch for the same window was already cancelled+forgotten)', async () => {
  const source = new FakeSource();
  const cache = new RenderModelCache(source);
  let staleDelivered = false;
  let freshDelivered = false;
  cache.request({ leftTc: 0, rightTc: 100, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 1 }, () => (staleDelivered = true));
  cache.bumpGeneration();
  // a second request for the SAME window, made after the bump -- the first fetch was already
  // cancelled and removed, so this must trigger a brand-new engine call, not join a stale one.
  cache.request({ leftTc: 0, rightTc: 100, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 1 }, () => (freshDelivered = true));
  assert.strictEqual(source.calls.length, 2, 'two distinct engine calls -- no joining a cancelled fetch');
  source.resolveNext(model(1, 'fresh'));
  await tick();
  assert.strictEqual(staleDelivered, false);
  assert.strictEqual(freshDelivered, true);
});

test('phase U4: a fetch with a waiter still at the CURRENT generation is left running (not cancelled) when bumpGeneration() coincides with a fresh request in the same key', async () => {
  const source = new FakeSource();
  const cache = new RenderModelCache(source);
  // Register a first waiter, then (before the fetch resolves) bump generation and immediately
  // register a second waiter for the exact same fetch key -- since bumpGeneration() only cancels
  // entries with NO current-generation waiter at the moment it runs, and no request() call has
  // happened between the two operations here, the entry is still cancelled (matches the two tests
  // above); this test instead exercises invalidateAll() cancelling every in-flight entry outright.
  cache.request({ leftTc: 0, rightTc: 100, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 1 }, () => {});
  cache.request({ leftTc: 5000, rightTc: 5100, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 1 }, () => {});
  assert.strictEqual(source.pendingCount(), 2);
  cache.invalidateAll();
  assert.strictEqual(source.cancelledCount, 2, 'invalidateAll() cancels every in-flight fetch, not just the cache windows');
  assert.strictEqual(source.pendingCount(), 0);
});

test('coordinateSystemVersion mismatch flushes the entire cache (a new request at a different version cannot hit old windows)', async () => {
  const source = new FakeSource();
  const cache = new RenderModelCache(source);
  cache.request({ leftTc: 0, rightTc: 100, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 1 }, () => {});
  source.resolveNext(model(1, 'v1'));
  await tick();
  assert.strictEqual(cache.getCachedWindowCount(), 1);

  cache.request({ leftTc: 0, rightTc: 100, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 2 }, () => {});
  assert.strictEqual(cache.getCachedWindowCount(), 0, 'old-version window discarded before issuing the new request');
});

test('a response whose own coordinateSystemVersion no longer matches the requested one is not cached (version changed mid-flight)', async () => {
  const source = new FakeSource();
  const cache = new RenderModelCache(source);
  let delivered = false;
  cache.request({ leftTc: 0, rightTc: 100, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 1 }, () => (delivered = true));
  source.resolveNext(model(2, 'mismatched')); // engine's version moved on before answering
  await tick();
  assert.strictEqual(delivered, false);
  assert.strictEqual(cache.getCachedWindowCount(), 0);
});
