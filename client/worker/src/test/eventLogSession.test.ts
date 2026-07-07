/**
 * Headless test for `client/src/eventlog/eventLogSession.ts` (phase U1) --
 * lives next to `handlers.test.ts`/`liveFollow.test.ts` (not under
 * `client/src/test/`, which doesn't exist and isn't wired into `bun run test`'s
 * test-path list; `client/worker/src/test/` already is, per `package.json`'s
 * `test` script and this directory's own precedent).
 *
 * Unlike `handlers.test.ts` (which calls `handleElogRequest()` in-process,
 * with no child process at all), this test drives `EventLogSession` for
 * real: it spawns the actual bundled `dist/eventlogWorker.js` via
 * `WorkerClient` (real `child_process.spawn`, real JSON-RPC over stdio) --
 * the "real worker bundle" the U1 phase's test plan calls for. If the bundle
 * doesn't exist yet (a fresh checkout that hasn't run `bun run dev:build`),
 * this file builds just that one esbuild target itself first, so `bun run
 * test` stays runnable standalone regardless of build order (mirrors how
 * `scripts/elog-worker-smoke.mjs` needs the same bundle, but as a script that
 * assumes it already exists -- this test can't assume that).
 */

import { test, beforeAll } from 'bun:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { ElogMethods } from '@omnetpp/shared/elog-protocol';
import type { HostToWebviewMessage } from '@omnetpp/shared/ui-protocol';
import { EventLogSession, type MessageSink } from '../../../src/eventlog/eventLogSession';

const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const fixturePath = join(repoRoot, 'shared', 'src', 'test', 'fixtures', 'elog', 'sample', 'Fifo1-#0.elog');
const bundlePath = join(repoRoot, 'dist', 'eventlogWorker.js');

beforeAll(async () => {
  if (existsSync(bundlePath)) return;
  await build({
    entryPoints: [join(repoRoot, 'client', 'worker', 'src', 'main.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    sourcemap: false,
    logLevel: 'warning',
  });
});

/** Collects every `postMessage()` call -- a `MessageSink` fake standing in for `vscode.Webview`. */
function fakeSink(): MessageSink & { messages: HostToWebviewMessage[] } {
  const messages: HostToWebviewMessage[] = [];
  return {
    messages,
    postMessage(message: HostToWebviewMessage) {
      messages.push(message);
    },
  };
}

test('EventLogSession: initialize() opens the fixture and populates a real summary', async () => {
  const session = new EventLogSession('elog:test-1', fixturePath, bundlePath);
  try {
    const summary = await session.initialize();
    assert.equal(summary.isEmpty, false);
    assert.ok(summary.lastEventNumber > summary.firstEventNumber);
    assert.equal(typeof summary.firstSimulationTime, 'string');
    assert.equal(session.summary, summary);
  } finally {
    session.dispose();
  }
});

test('EventLogSession: handleEngineRequest() proxies elog/getModuleTree to the real worker', async () => {
  const session = new EventLogSession('elog:test-2', fixturePath, bundlePath);
  try {
    await session.initialize();
    const tree = (await session.handleEngineRequest(ElogMethods.getModuleTree, undefined)) as { fullName: string; children: unknown[] } | null;
    assert.notEqual(tree, null);
    assert.equal(tree!.fullName, 'SingleQueue');
    assert.equal(tree!.children.length, 3);
  } finally {
    session.dispose();
  }
});

test('EventLogSession: handleEngineRequest() rejects a proxied elog/open (the session owns its own file)', async () => {
  const session = new EventLogSession('elog:test-3', fixturePath, bundlePath);
  try {
    await session.initialize();
    await assert.rejects(() => session.handleEngineRequest(ElogMethods.open, { path: fixturePath }));
  } finally {
    session.dispose();
  }
});

test('EventLogSession: gotoEvent() resolves and broadcasts a reveal to every attached sink', async () => {
  const session = new EventLogSession('elog:test-4', fixturePath, bundlePath);
  try {
    const summary = await session.initialize();
    const chartSink = fakeSink();
    const tableSink = fakeSink();
    session.attach('chart', chartSink);
    session.attach('table', tableSink);

    const result = await session.gotoEvent({ eventNumber: summary.firstEventNumber });
    assert.equal(result.found, true);

    for (const sink of [chartSink, tableSink]) {
      const reveal = sink.messages.find((m) => m.type === 'reveal');
      assert.ok(reveal, 'expected a reveal message');
      assert.deepEqual(reveal, { type: 'reveal', target: { kind: 'event', eventNumber: summary.firstEventNumber, ref: result.ref } });
    }

    session.detach('chart', chartSink);
    session.detach('table', tableSink);
  } finally {
    session.dispose();
  }
});

test('EventLogSession: refcounting -- detaching the last sink disposes the worker (onIdle fires, further requests fail fast)', async () => {
  let idleFired = false;
  const session = new EventLogSession('elog:test-5', fixturePath, bundlePath, { onIdle: () => (idleFired = true) });
  await session.initialize();
  const chartSink = fakeSink();
  const tableSink = fakeSink();
  session.attach('chart', chartSink);
  session.attach('table', tableSink);

  session.detach('chart', chartSink);
  assert.equal(idleFired, false, 'still attached via the table sink -- must not dispose yet');

  session.detach('table', tableSink);
  assert.equal(idleFired, true, 'last sink detached -- must dispose and fire onIdle');

  // The worker's stdio connection was torn down synchronously by dispose(); any
  // further request must fail immediately rather than hang or silently succeed.
  await assert.rejects(() => session.workerClient.getSummary());
});

test('EventLogSession: force dispose() is idempotent and safe with no attachments', async () => {
  const session = new EventLogSession('elog:test-6', fixturePath, bundlePath);
  await session.initialize();
  session.dispose();
  session.dispose(); // must not throw a second time
});

// ---------------------------------------------------------------------------------
// Phase U6: canonical session selection -- re-entry guard, canonicalization, rebind push.
// ---------------------------------------------------------------------------------

test('EventLogSession: setSelection() re-broadcasts to every OTHER attached sink, never back to the originator', async () => {
  const session = new EventLogSession('elog:test-7', fixturePath, bundlePath);
  try {
    await session.initialize();
    const chartSink = fakeSink();
    const tableSink = fakeSink();
    session.attach('chart', chartSink);
    session.attach('table', tableSink);

    session.setSelection({ eventNumbers: [3, 1] }, tableSink);

    // the originator (table) must NOT see its own selection echoed back
    assert.equal(tableSink.messages.filter((m) => m.type === 'setSelection').length, 0);
    // the other view (chart) must receive it, canonicalized (deduplicated + sorted)
    const setSelectionMessages = chartSink.messages.filter((m) => m.type === 'setSelection');
    assert.equal(setSelectionMessages.length, 1);
    assert.deepEqual(setSelectionMessages[0], { type: 'setSelection', selection: { eventNumbers: [1, 3] } });
    assert.deepEqual(session.getSelection(), { eventNumbers: [1, 3] });
  } finally {
    session.dispose();
  }
});

test('EventLogSession: setSelection() deduplicates and sorts event numbers regardless of click order', async () => {
  const session = new EventLogSession('elog:test-8', fixturePath, bundlePath);
  try {
    await session.initialize();
    session.setSelection({ eventNumbers: [5, 2, 5, 2, 9] });
    assert.deepEqual(session.getSelection(), { eventNumbers: [2, 5, 9] });
  } finally {
    session.dispose();
  }
});

test('EventLogSession: attach() pushes the current selection to a newly attached sink (pinned table rebind / late attachment)', async () => {
  const session = new EventLogSession('elog:test-9', fixturePath, bundlePath);
  try {
    await session.initialize();
    const chartSink = fakeSink();
    session.attach('chart', chartSink);
    session.setSelection({ eventNumbers: [7] }, chartSink);

    // a table view attaching AFTER the selection was already made (e.g. a pinned table
    // switching to this session, or a webview reload reattaching) must see it immediately
    const tableSink = fakeSink();
    session.attach('table', tableSink);
    const pushed = tableSink.messages.filter((m) => m.type === 'setSelection');
    assert.equal(pushed.length, 1);
    assert.deepEqual(pushed[0], { type: 'setSelection', selection: { eventNumbers: [7] } });
  } finally {
    session.dispose();
  }
});

test('EventLogSession: attach() does NOT push a setSelection when the session has no selection yet', async () => {
  const session = new EventLogSession('elog:test-10', fixturePath, bundlePath);
  try {
    await session.initialize();
    const sink = fakeSink();
    session.attach('chart', sink);
    assert.equal(sink.messages.filter((m) => m.type === 'setSelection').length, 0);
  } finally {
    session.dispose();
  }
});

test('EventLogSession: reveal() round-trips to both a chart and a table sink attached at the time it fires', async () => {
  const session = new EventLogSession('elog:test-11', fixturePath, bundlePath);
  try {
    const summary = await session.initialize();
    const chartSink = fakeSink();
    const tableSink = fakeSink();
    session.attach('chart', chartSink);
    session.attach('table', tableSink);

    const target = { kind: 'event' as const, eventNumber: summary.firstEventNumber, ref: { eventNumber: summary.firstEventNumber, entryIndex: 0 } };
    session.reveal(target);

    for (const sink of [chartSink, tableSink]) {
      const reveal = sink.messages.find((m) => m.type === 'reveal');
      assert.deepEqual(reveal, { type: 'reveal', target });
    }
  } finally {
    session.dispose();
  }
});

// ---------------------------------------------------------------------------------
// Phase U7: session-mediated filtering -- setFilter() broadcasts to every attached
// sink (chart AND table, origin included -- unlike selection there is no echo/re-entry
// concern), and persisted-filter rehydration (`initialFilterParams`/`onFilterChanged`,
// the options a real `EventLogController` would wire against its own `workspaceState`).
// ---------------------------------------------------------------------------------

test('EventLogSession: setFilter() applies the filter, updates getCurrentFilterParams(), and broadcasts elog/filterChanged to every attached sink', async () => {
  const session = new EventLogSession('elog:test-12', fixturePath, bundlePath);
  try {
    const summary = await session.initialize();
    assert.equal(summary.filtered, false);
    assert.equal(session.getCurrentFilterParams(), null);

    const chartSink = fakeSink();
    const tableSink = fakeSink();
    session.attach('chart', chartSink);
    session.attach('table', tableSink);

    const params = { moduleIds: [1] };
    const filteredSummary = await session.setFilter(params);
    assert.equal(filteredSummary.filtered, true);
    assert.deepEqual(session.getCurrentFilterParams(), params);

    for (const sink of [chartSink, tableSink]) {
      const notify = sink.messages.find((m) => m.type === 'engineNotify' && m.event === 'elog/filterChanged');
      assert.ok(notify, 'expected an elog/filterChanged engineNotify on every attached sink, including the one that triggered it');
      const payload = (notify as { payload: { summary: { filtered: boolean }; params: unknown } }).payload;
      assert.equal(payload.summary.filtered, true);
      assert.deepEqual(payload.params, params);
    }
  } finally {
    session.dispose();
  }
});

test('EventLogSession: setFilter(null) removes the filter and broadcasts the unfiltered summary', async () => {
  const session = new EventLogSession('elog:test-13', fixturePath, bundlePath);
  try {
    await session.initialize();
    await session.setFilter({ moduleIds: [1] });
    assert.equal(session.getCurrentFilterParams() !== null, true);

    const sink = fakeSink();
    session.attach('chart', sink);
    const summary = await session.setFilter(null);
    assert.equal(summary.filtered, false);
    assert.equal(session.getCurrentFilterParams(), null);
    const notify = sink.messages.find((m) => m.type === 'engineNotify' && m.event === 'elog/filterChanged');
    assert.deepEqual((notify as { payload: { params: unknown } }).payload.params, null);
  } finally {
    session.dispose();
  }
});

test('EventLogSession: a persisted filter (initialFilterParams) is re-applied by initialize(), before any webview ever attaches', async () => {
  // Simulates EventLogController's rehydrate-on-reopen: a PREVIOUS session applied a
  // filter, the controller captured it via onFilterChanged (its workspaceState-writing
  // hook), and a brand new session for the SAME file is constructed with that captured
  // value as initialFilterParams (a fresh window/session, "same memento stub").
  let captured: unknown;
  const firstSession = new EventLogSession('elog:test-14a', fixturePath, bundlePath, {
    onFilterChanged: (params) => {
      captured = params;
    },
  });
  const appliedParams = { moduleIds: [2] };
  try {
    await firstSession.initialize();
    await firstSession.setFilter(appliedParams);
    assert.deepEqual(captured, appliedParams);
  } finally {
    firstSession.dispose();
  }

  const secondSession = new EventLogSession('elog:test-14b', fixturePath, bundlePath, {
    initialFilterParams: captured as typeof appliedParams,
  });
  try {
    const summary = await secondSession.initialize();
    assert.equal(summary.filtered, true, 'the persisted filter must already be applied by the time initialize() resolves');
    assert.deepEqual(secondSession.getCurrentFilterParams(), appliedParams);
  } finally {
    secondSession.dispose();
  }
});

test('EventLogSession: onFilterChanged is NOT called for the initial rehydrate itself (no redundant re-persist of a value that just came FROM the store)', async () => {
  let onFilterChangedCalls = 0;
  const session = new EventLogSession('elog:test-15', fixturePath, bundlePath, {
    initialFilterParams: { moduleIds: [1] },
    onFilterChanged: () => onFilterChangedCalls++,
  });
  try {
    await session.initialize();
    assert.equal(onFilterChangedCalls, 0);
  } finally {
    session.dispose();
  }
});

test('EventLogSession: an invalid persisted filter does not fail the whole open (best-effort rehydrate)', async () => {
  // A malformed MatchExpression (unbalanced parens) throws when the engine parses it
  // (`setModuleExpression()` -> `MatchExpression.setPattern()`) -- exercises the
  // genuinely-best-effort catch in `initialize()`: the open itself must still succeed
  // (with an unfiltered summary), matching `WorkerClient`'s own "keep it simple"
  // crash-restart philosophy this method's doc comment cites.
  const session = new EventLogSession('elog:test-17', fixturePath, bundlePath, {
    initialFilterParams: { enableModuleFilter: true, moduleExpression: '((' },
  });
  try {
    const summary = await session.initialize();
    assert.equal(summary.isEmpty, false);
    assert.equal(summary.filtered, false, 'the malformed filter must not have been left installed');
  } finally {
    session.dispose();
  }
});
