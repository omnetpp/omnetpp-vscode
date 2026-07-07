import { test } from 'bun:test';
import assert from 'node:assert';
import { TimelineMode, type ViewportModel, type ViewportParams } from '@omnetpp/shared/elog-protocol';
import { RenderModelCache, type EngineViewportSource } from '../eventlog/chart/renderModelCache';

function model(version: number, _tag: string): ViewportModel {
  return { coordinateSystemVersion: version, events: [], dependencies: [], methodCalls: [], moduleIds: [], truncated: false };
}

/** A fake engine source that records every request and resolves on demand (so tests can control ordering/races deterministically). */
class FakeSource implements EngineViewportSource {
  calls: ViewportParams[] = [];
  private resolvers: ((m: ViewportModel) => void)[] = [];
  autoResolveVersion: number | null = null;

  getViewport(params: ViewportParams): Promise<ViewportModel> {
    this.calls.push(params);
    if (this.autoResolveVersion !== null) return Promise.resolve(model(this.autoResolveVersion, 'auto'));
    return new Promise((resolve) => this.resolvers.push(resolve as (m: ViewportModel) => void));
  }

  resolveNext(m: ViewportModel): void {
    const r = this.resolvers.shift();
    if (!r) throw new Error('no pending request to resolve');
    r(m);
  }

  pendingCount(): number {
    return this.resolvers.length;
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

test('a stale in-flight response (generation bumped after the request was made) is dropped, not delivered', async () => {
  const source = new FakeSource();
  const cache = new RenderModelCache(source);
  let delivered = false;
  cache.request({ leftTc: 0, rightTc: 100, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 1 }, () => (delivered = true));
  cache.bumpGeneration(); // simulate a zoom/mode-change racing the in-flight request
  source.resolveNext(model(1, 'stale'));
  await tick();
  assert.strictEqual(delivered, false, 'stale generation -> not delivered to the original waiter');
});

test('a waiter registered under the CURRENT generation still gets notified even if an older waiter on the same fetch went stale', async () => {
  const source = new FakeSource();
  const cache = new RenderModelCache(source);
  let staleDelivered = false;
  let freshDelivered = false;
  cache.request({ leftTc: 0, rightTc: 100, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 1 }, () => (staleDelivered = true));
  cache.bumpGeneration();
  // second waiter for the SAME window, registered under the new (current) generation -- joins the same in-flight fetch
  cache.request({ leftTc: 0, rightTc: 100, timelineMode: TimelineMode.SIMULATION_TIME, coordinateSystemVersion: 1 }, () => (freshDelivered = true));
  source.resolveNext(model(1, 'shared'));
  await tick();
  assert.strictEqual(staleDelivered, false);
  assert.strictEqual(freshDelivered, true);
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
