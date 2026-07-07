// Headless smoke test for the U1 UI-scaffolding phase's session layer
// (client/src/eventlog/eventLogSession.ts): drives it exactly like a real
// custom editor/table view host would -- spawn the real bundled worker,
// initialize() against the Fifo1 fixture, attach a fake webview sink, proxy an
// engineRequest the same way sequenceChartEditor.ts's message pump does, and
// tear it down via the refcounting path. Unlike client/worker/src/test/
// eventLogSession.test.ts (bun:test, part of the regular `bun run test` gate),
// this is a standalone script in the pattern of scripts/elog-worker-smoke.mjs/
// scripts/mcp-smoke.mjs -- run it by hand after a build to sanity-check the
// real dist/eventlogWorker.js path end-to-end outside the test runner.
//
// Usage: bun scripts/eventlog-ui-smoke.mjs   (after `bun run dev:build`)
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventLogSession } from '../client/src/eventlog/eventLogSession.ts';

// This script lives in scripts/, which (unlike client/, server/, mcp/) has no
// node_modules/@omnetpp/shared symlink of its own (bun workspace linking is
// per-package), so it cannot import '@omnetpp/shared/elog-protocol' directly --
// same reason scripts/elog-worker-smoke.mjs calls methods by their literal
// wire names instead of importing `ElogMethods`. `eventLogSession.ts` itself
// resolves the import fine (its own directory IS inside client/'s workspace),
// this restriction only applies to this script's own top-level imports.
const ElogMethods = {
  scSetTimelineMode: 'elog/sc/setTimelineMode',
  scRelocateOrigin: 'elog/sc/relocateOrigin',
  scGetViewport: 'elog/sc/getViewport',
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = join(root, 'dist', 'eventlogWorker.js');
const fixturePath = join(root, 'shared', 'src', 'test', 'fixtures', 'elog', 'sample', 'Fifo1-#0.elog');

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`ok: ${message}`);
  }
}

async function main() {
  if (!fs.existsSync(bundlePath)) throw new Error(`${bundlePath} not found -- run 'bun run dev:build' first`);
  if (!fs.existsSync(fixturePath)) throw new Error(`fixture not found: ${fixturePath}`);

  let idleFired = false;
  const session = new EventLogSession('elog:eventlog-ui-smoke', fixturePath, bundlePath, {
    onIdle: () => (idleFired = true),
  });

  // ---- init summary ------------------------------------------------------------------
  const summary = await session.initialize();
  assert(summary.isEmpty === false, 'initialize(): fixture is not empty');
  assert(summary.lastEventNumber > summary.firstEventNumber, 'initialize(): has more than one event');
  assert(session.summary === summary, 'session.summary caches the resolved LogSummary');

  // ---- fake webview sink (mirrors sequenceChartEditor.ts's `MessageSink`) ------------
  const messages = [];
  const sink = { postMessage: (m) => messages.push(m) };
  session.attach('chart', sink);

  // ---- engineRequest proxy round trip (elog/sc/getViewport, per this phase's own
  // "asserting summary + a proxied elog/sc/getViewport round trip" test plan) --------
  await session.handleEngineRequest(ElogMethods.scSetTimelineMode, { timelineMode: 'EVENT_NUMBER' });
  await session.handleEngineRequest(ElogMethods.scRelocateOrigin, { eventNumber: summary.firstEventNumber });
  const viewport = await session.handleEngineRequest(ElogMethods.scGetViewport, {
    range: { kind: 'event', startEventNumber: summary.firstEventNumber, endEventNumber: summary.lastEventNumber },
  });
  assert(Array.isArray(viewport.events) && viewport.events.length > 0, 'engineRequest proxy: elog/sc/getViewport returns non-empty events');

  // ---- goto + reveal broadcast ---------------------------------------------------------
  const goto = await session.gotoEvent({ eventNumber: summary.firstEventNumber });
  assert(goto.found === true, 'gotoEvent(): finds the first event');
  const reveal = messages.find((m) => m.type === 'reveal');
  assert(!!reveal, 'gotoEvent(): broadcasts a reveal message to the attached sink');

  // ---- refresh ---------------------------------------------------------------------
  const refreshed = await session.refresh();
  assert(refreshed.changed === false, 'refresh(): no-op check on an untouched file reports unchanged');
  assert(messages.some((m) => m.type === 'engineNotify' && m.event === 'elog/refreshed'), 'refresh(): broadcasts an elog/refreshed engineNotify');

  // ---- refcounting: detaching the only sink disposes the worker ----------------------
  session.detach('chart', sink);
  assert(idleFired === true, 'detach(): last sink gone -> onIdle fired (worker disposed)');
  let rejected = false;
  try {
    await session.workerClient.getSummary();
  } catch {
    rejected = true;
  }
  assert(rejected === true, 'post-dispose: a further request fails fast (worker actually torn down)');

  console.log(failures === 0 ? '\neventlog-ui-smoke PASSED' : `\neventlog-ui-smoke FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
