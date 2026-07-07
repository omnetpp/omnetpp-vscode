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
