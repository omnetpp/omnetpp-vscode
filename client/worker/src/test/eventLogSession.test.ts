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
