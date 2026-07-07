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
import * as os from 'node:os';
import * as path from 'node:path';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CancellationTokenSource } from 'vscode-jsonrpc/node';
import { EventLogSession } from '../client/src/eventlog/eventLogSession.ts';

// This script lives in scripts/, which (unlike client/, server/, mcp/) has no
// node_modules/@omnetpp/shared symlink of its own (bun workspace linking is
// per-package), so it cannot import '@omnetpp/shared/elog-protocol' directly --
// same reason scripts/elog-worker-smoke.mjs calls methods by their literal
// wire names instead of importing `ElogMethods`. `eventLogSession.ts` itself
// resolves the import fine (its own directory IS inside client/'s workspace),
// this restriction only applies to this script's own top-level imports.
const ElogMethods = {
  getSummary: 'elog/getSummary',
  scSetTimelineMode: 'elog/sc/setTimelineMode',
  scRelocateOrigin: 'elog/sc/relocateOrigin',
  scGetViewport: 'elog/sc/getViewport',
  scMapCoords: 'elog/sc/mapCoords',
  getModuleTree: 'elog/getModuleTree',
  tableGetRows: 'elog/table/getRows',
  tableNavigate: 'elog/table/navigate',
  tablePosition: 'elog/table/position',
  findText: 'elog/findText',
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

  // ---- U3: chart-specific viewport/coords/module-tree round trips (before teardown) ----
  await smokeChartU3(session, summary);

  // ---- U2: Event Log table row-rendering round trips (before teardown) --------------
  await smokeTableU2(session, summary);

  // ---- U4: real RPC cancellation end-to-end through the actual worker ---------------
  await smokeCancellationU4(bundlePath);

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

// ---------------------------------------------------------------------------------
// U3 (chart canvas MVP): exercises the engine round trips chartMain.ts/
// renderModelCache.ts drive that the earlier engineRequest-proxy check above doesn't
// already cover -- elog/sc/mapCoords (both directions), elog/getModuleTree, and a
// tc-range (not just event-range) elog/sc/getViewport across all 4 timeline modes,
// confirming dependencies/moduleIds come back populated for a fixture with real
// message sends. Appended per this phase's plan (additive; the file's existing
// structure/tests above are untouched).
// ---------------------------------------------------------------------------------
async function smokeChartU3(session, summary) {
  const moduleTree = await session.handleEngineRequest(ElogMethods.getModuleTree, undefined);
  assert(moduleTree !== null && typeof moduleTree.moduleId === 'number', 'smokeChartU3: getModuleTree returns a root module');

  const eventToTc = await session.handleEngineRequest(ElogMethods.scMapCoords, { kind: 'eventToTc', eventNumber: summary.firstEventNumber });
  assert(typeof eventToTc.tc === 'number', 'smokeChartU3: mapCoords(eventToTc) returns a numeric tc for the first event');

  const tcToEventNumber = await session.handleEngineRequest(ElogMethods.scMapCoords, { kind: 'tcToEventNumber', tc: eventToTc.tc });
  assert(tcToEventNumber.eventNumber === summary.firstEventNumber, 'smokeChartU3: mapCoords(tcToEventNumber) round-trips back to the first event');

  for (const timelineMode of ['SIMULATION_TIME', 'EVENT_NUMBER', 'STEP', 'NONLINEAR']) {
    await session.handleEngineRequest(ElogMethods.scSetTimelineMode, { timelineMode });
    await session.handleEngineRequest(ElogMethods.scRelocateOrigin, { eventNumber: summary.firstEventNumber });
    const begin = await session.handleEngineRequest(ElogMethods.scMapCoords, { kind: 'eventToTc', eventNumber: summary.firstEventNumber });
    const end = await session.handleEngineRequest(ElogMethods.scMapCoords, { kind: 'eventToTc', eventNumber: summary.lastEventNumber });
    const viewport = await session.handleEngineRequest(ElogMethods.scGetViewport, {
      range: { kind: 'tc', tcBegin: begin.tc, tcEnd: end.tc },
      marginTc: 0,
    });
    assert(Array.isArray(viewport.events) && viewport.events.length > 0, `smokeChartU3[${timelineMode}]: tc-range getViewport returns events`);
    assert(Array.isArray(viewport.moduleIds) && viewport.moduleIds.length > 0, `smokeChartU3[${timelineMode}]: getViewport populates moduleIds`);
    assert(Array.isArray(viewport.dependencies), `smokeChartU3[${timelineMode}]: getViewport returns a dependencies array`);
  }

  // restore SIMULATION_TIME (the default) so the rest of main()'s assertions aren't affected by mode-switch side effects
  await session.handleEngineRequest(ElogMethods.scSetTimelineMode, { timelineMode: 'SIMULATION_TIME' });
  await session.handleEngineRequest(ElogMethods.scRelocateOrigin, { eventNumber: summary.firstEventNumber });
}

// ---------------------------------------------------------------------------------
// U2 (Event Log table MVP): exercises the real elog/table/* round trips through the
// real bundled worker/session -- window fetch with `render` populated (styled spans
// per tableRowRenderer.ts), the same window without `render` (bookkeeping-only shape),
// tableNavigate stepping forward/back, and tablePosition agreeing with a fetched
// window's own `approximatePercentage`. Appended per this phase's plan (additive; the
// file's existing structure/tests above are untouched).
// ---------------------------------------------------------------------------------
async function smokeTableU2(session, summary) {
  const rendered = await session.handleEngineRequest(ElogMethods.tableGetRows, {
    anchor: { kind: 'first' },
    before: 0,
    after: 6,
    render: { displayMode: 'DESCRIPTIVE', nameMode: 'SMART_NAME', typeMode: 'CPP' },
  });
  assert(rendered.rows.length === 6, 'smokeTableU2: getRows(after=6) returns 6 rows');
  assert(
    rendered.rows.every((r) => r.rendered && Array.isArray(r.rendered.detailSpans) && r.rendered.detailSpans.length > 0),
    'smokeTableU2: every row has a non-empty rendered.detailSpans (styled spans arrived for the fixture)',
  );
  assert(
    rendered.rows.every((r) => typeof r.rendered.eventNumberSpan.text === 'string' && typeof r.rendered.simTimeSpan.text === 'string'),
    'smokeTableU2: every row has rendered Event#/Time cells',
  );
  assert(rendered.rows[0].entryClassCode === 'E', 'smokeTableU2: first row is the fixture\'s first "E" line');
  assert(
    rendered.rows[0].rendered.detailSpans.map((s) => s.text).join('').startsWith('Initializing'),
    'smokeTableU2: event #0\'s descriptive text is the "Initializing ..." special case',
  );

  const unrendered = await session.handleEngineRequest(ElogMethods.tableGetRows, { anchor: { kind: 'first' }, before: 0, after: 3 });
  assert(
    unrendered.rows.every((r) => r.rendered === undefined),
    'smokeTableU2: getRows() without `render` omits the rendered field entirely',
  );

  const anchorRef = rendered.rows[3].ref;
  const forward = await session.handleEngineRequest(ElogMethods.tableNavigate, { ref: anchorRef, distance: 2 });
  assert(forward !== null, 'smokeTableU2: tableNavigate(+2) resolves a ref');
  const back = await session.handleEngineRequest(ElogMethods.tableNavigate, { ref: forward, distance: -2 });
  assert(back && back.eventNumber === anchorRef.eventNumber && back.entryIndex === anchorRef.entryIndex, 'smokeTableU2: tableNavigate(+2) then (-2) returns to the same ref');

  const position = await session.handleEngineRequest(ElogMethods.tablePosition, { ref: anchorRef });
  assert(typeof position.approximatePercentage === 'number', 'smokeTableU2: tablePosition returns a numeric approximatePercentage');
  assert(position.approximateNumberOfEntries === rendered.approximateNumberOfEntries, 'smokeTableU2: tablePosition\'s approximateNumberOfEntries agrees with getRows()\'s');

  void summary;
}

/** Streams a large, plain synthetic .elog -- same shape as scripts/elog-worker-smoke.mjs's own fixture generator -- so a findText miss forces a genuinely long full-file scan (needed to measure cancellation latency meaningfully; a tiny fixture like Fifo1 finishes before a cancelRequest notification could ever land, which is exactly why this needs its own big file + its own session/worker rather than reusing the one above). */
function writeSyntheticEventLog(file, eventCount) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, 'SB ov 1536 ev 2 rid Smoke-0\n\n');
    for (let i = 0; i < eventCount; i++) {
      fs.writeSync(fd, `E # ${i} t ${i} m 1 ce -1 msg -1\n`);
      if (i === 0) fs.writeSync(fd, 'MC id 1 c C t T n root cm 1\n');
      fs.writeSync(fd, '\n');
    }
    fs.writeSync(fd, 'SE e 0 c 9 m "done"\n');
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------------
// U4 (chart interactions): real RPC cancellation end to end -- resolves the U3 "Known
// follow-up" (`common/rpc.ts`'s `EngineRpc.cancel()` now sends an actual
// `$/cancelRequest`, not just a local no-op). `EventLogSession.handleEngineRequest()`
// threads an optional `vscode-jsonrpc` `CancellationToken` straight through to
// `WorkerClient`'s (already-token-aware) methods -- `sequenceChartEditor.ts`'s real
// host wires a fresh `vscode.CancellationTokenSource` per `engineRequest` and cancels
// it on a matching `cancelRequest`. This script drives the same `CancellationToken`
// contract directly against the real bundled worker (no fake webview panel needed),
// asserting a cancelled `elog/findText` actually REJECTS PROMPTLY (not just "never
// resolves", and not merely because the whole scan finished first) -- mirrors
// scripts/elog-worker-smoke.mjs's own cancellation scenario almost exactly, just
// through `EventLogSession`'s proxy instead of a raw `vscode-jsonrpc` connection.
// ---------------------------------------------------------------------------------
async function smokeCancellationU4(bundlePath) {
  const bigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnetpp-eventlog-ui-smoke-'));
  const bigFile = path.join(bigDir, 'big.elog');
  let bigSession;
  try {
    writeSyntheticEventLog(bigFile, 400_000);
    bigSession = new EventLogSession('elog:eventlog-ui-smoke-cancel', bigFile, bundlePath);
    await bigSession.initialize();

    const cts = new CancellationTokenSource();
    const start = performance.now();
    const longRequest = bigSession.handleEngineRequest(
      ElogMethods.findText,
      { start: null, search: 'ThisNeverMatchesAnythingInTheSyntheticLog', forward: true, caseSensitive: false },
      cts.token,
    );
    // give it a moment to actually start scanning, then cancel well before a full
    // 400k-event scan could possibly finish on its own
    await new Promise((r) => setTimeout(r, 50));
    cts.cancel();

    let cancelledInTime = false;
    let elapsedMs = -1;
    let code;
    try {
      await longRequest;
    } catch (err) {
      elapsedMs = performance.now() - start;
      code = err && typeof err.code === 'number' ? err.code : undefined;
      cancelledInTime = elapsedMs < 500 && /cancel/i.test(err.message ?? '');
      if (!cancelledInTime) console.error(`  (cancellation error: code=${code} message=${err.message} elapsedMs=${elapsedMs.toFixed(1)})`);
    }
    assert(cancelledInTime, `smokeCancellationU4: a cancelled long-running elog/findText scan rejects promptly (elapsed ${elapsedMs.toFixed(1)}ms, budget 500ms)`);
    assert(code === -32800, `smokeCancellationU4: rejection carries the standard RequestCancelled JSON-RPC error code (-32800), got ${code}`);

    // the session/worker must stay healthy afterwards -- an ordinary request right after a cancellation succeeds normally
    const followUp = await bigSession.handleEngineRequest(ElogMethods.getSummary, undefined);
    assert(followUp.isEmpty === false, 'smokeCancellationU4: the session keeps working normally after a cancelled request');
  } finally {
    bigSession?.dispose();
    fs.rmSync(bigDir, { recursive: true, force: true });
  }
}
