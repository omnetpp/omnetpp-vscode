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
  scAdjacencyMatrix: 'elog/sc/adjacencyMatrix',
  scSetTimelineMode: 'elog/sc/setTimelineMode',
  scRelocateOrigin: 'elog/sc/relocateOrigin',
  scGetViewport: 'elog/sc/getViewport',
  scMapCoords: 'elog/sc/mapCoords',
  getModuleTree: 'elog/getModuleTree',
  tableGetRows: 'elog/table/getRows',
  tableNavigate: 'elog/table/navigate',
  tablePosition: 'elog/table/position',
  tableGotoRelated: 'elog/table/gotoRelated',
  findText: 'elog/findText',
  getEventDetail: 'elog/getEventDetail',
  getFilterHints: 'elog/getFilterHints',
  getEntryTypeSchema: 'elog/getEntryTypeSchema',
  setFilter: 'elog/setFilter',
  releaseMemory: 'elog/releaseMemory',
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

  // ---- U6: table "Go To" family (elog/table/gotoRelated) against the real worker -----
  await smokeSyncU6(session, summary);

  // ---- U7: filter panel plumbing (elog/getFilterHints, elog/setFilter apply/remove) --
  await smokeFilterU7(session, summary);

  // ---- U10: table content-assist schema (elog/getEntryTypeSchema) -------------------
  await smokeEntryTypeSchemaU10(session);

  // ---- U8: axis management -- adjacency matrix round trip (minimize crossings) ------
  await smokeAxisU8(session, summary);

  // ---- U9: "Release Memory" round trip (elog/releaseMemory) through the real worker --
  await smokeReleaseMemoryU9(session, summary, messages);

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

// ---------------------------------------------------------------------------------
// U6 (sync, bookmarks, goto): exercises `elog/table/gotoRelated` -- the table's "Go To"
// family (Cause/Arrival/Origin/Reuse/Previous-Next Event/Previous-Next Module Event,
// ported from `EventLogTableContributor.java`) -- against the REAL bundled worker
// (`client/worker/src/test/gotoRelated.test.ts` covers the same logic in-process,
// no worker_thread/child process; this is the end-to-end sanity net through the
// actual JSON-RPC transport, same relationship as U2/U3's own smoke sections above).
// Module ids for Fifo1 (event #10 is module 3, nearest same-module neighbors #7/#11)
// are the same hand-derived facts `gotoRelated.test.ts`'s header documents.
// ---------------------------------------------------------------------------------
async function smokeSyncU6(session, summary) {
  const prev = await session.handleEngineRequest(ElogMethods.tableGotoRelated, { from: { eventNumber: 10, entryIndex: 0 }, relation: 'prevEvent' });
  assert(prev && prev.eventNumber === 9, 'smokeSyncU6: gotoRelated(prevEvent) from #10 resolves to #9');
  const next = await session.handleEngineRequest(ElogMethods.tableGotoRelated, { from: { eventNumber: 10, entryIndex: 0 }, relation: 'nextEvent' });
  assert(next && next.eventNumber === 11, 'smokeSyncU6: gotoRelated(nextEvent) from #10 resolves to #11');

  const prevModule = await session.handleEngineRequest(ElogMethods.tableGotoRelated, { from: { eventNumber: 10, entryIndex: 0 }, relation: 'prevModuleEvent' });
  assert(prevModule && prevModule.eventNumber === 7, 'smokeSyncU6: gotoRelated(prevModuleEvent) from #10 resolves to #7');
  const nextModule = await session.handleEngineRequest(ElogMethods.tableGotoRelated, { from: { eventNumber: 10, entryIndex: 0 }, relation: 'nextModuleEvent' });
  assert(nextModule && nextModule.eventNumber === 11, 'smokeSyncU6: gotoRelated(nextModuleEvent) from #10 resolves to #11');

  // cause: scan for any event with a real cause (ce >= 0) via getEventDetail, then
  // confirm gotoRelated(cause) lands back in that exact cause event.
  let causeChecked = false;
  for (let n = summary.firstEventNumber; n <= summary.lastEventNumber && !causeChecked; n++) {
    const detail = await session.handleEngineRequest(ElogMethods.getEventDetail, { eventNumber: n });
    if (detail && detail.causeEventNumber >= 0) {
      const cause = await session.handleEngineRequest(ElogMethods.tableGotoRelated, { from: { eventNumber: n, entryIndex: 0 }, relation: 'cause' });
      assert(cause !== null, `smokeSyncU6: gotoRelated(cause) from #${n} resolves (causeEventNumber=${detail.causeEventNumber})`);
      assert(cause && cause.eventNumber === detail.causeEventNumber, `smokeSyncU6: gotoRelated(cause) from #${n} lands in cause event #${detail.causeEventNumber}`);
      causeChecked = true;
    }
  }
  assert(causeChecked, 'smokeSyncU6: found at least one event with a real cause to exercise gotoRelated(cause)');

  // reuse/origin: Fifo1 has no message-reuse pattern -- both must be silent no-ops (null).
  const reuseResult = await session.handleEngineRequest(ElogMethods.tableGotoRelated, { from: { eventNumber: summary.firstEventNumber, entryIndex: 0 }, relation: 'reuse' });
  assert(reuseResult === null, 'smokeSyncU6: gotoRelated(reuse) is a no-op (null) on a fixture with no message reuses');

  // unresolvable `from` -> null, never throws
  const notFound = await session.handleEngineRequest(ElogMethods.tableGotoRelated, { from: { eventNumber: summary.lastEventNumber + 1, entryIndex: 0 }, relation: 'cause' });
  assert(notFound === null, 'smokeSyncU6: gotoRelated() with an unresolvable `from` returns null rather than throwing');
}

// ---------------------------------------------------------------------------------
// U7 (filter panel): elog/getFilterHints (autocompletion data) + a real elog/setFilter
// apply/remove round trip through the actual bundled worker/session (module filter on
// Fifo1's "fifo" module, id 3 -- same module id `client/worker/src/test/handlers.
// test.ts`'s own `elog/setFilter` test uses). Appended per this phase's plan
// (additive; the file's existing structure/tests above are untouched).
// ---------------------------------------------------------------------------------
async function smokeFilterU7(session, summary) {
  const hints = await session.handleEngineRequest(ElogMethods.getFilterHints, undefined);
  assert(Array.isArray(hints.moduleNames) && hints.moduleNames.length > 0, 'smokeFilterU7: getFilterHints returns a non-empty moduleNames list');
  assert(Array.isArray(hints.moduleNedTypeNames) && hints.moduleNedTypeNames.length > 0, 'smokeFilterU7: getFilterHints returns a non-empty moduleNedTypeNames list');
  assert(hints.truncated === false, 'smokeFilterU7: getFilterHints is not truncated for this small fixture');

  const filteredSummary = await session.handleEngineRequest(ElogMethods.setFilter, { enableModuleFilter: true, moduleIds: [3] });
  assert(filteredSummary.filtered === true, 'smokeFilterU7: setFilter() with a module filter reports filtered=true');
  assert(filteredSummary.approximateNumberOfEvents <= summary.approximateNumberOfEvents, 'smokeFilterU7: the filtered viewport/summary shrinks (or stays equal) vs. the unfiltered one');
  assert(filteredSummary.coordinateSystemVersion !== summary.coordinateSystemVersion, 'smokeFilterU7: filtering bumps the coordinate-system version (stale-response guard)');

  const restoredSummary = await session.handleEngineRequest(ElogMethods.setFilter, null);
  assert(restoredSummary.filtered === false, 'smokeFilterU7: setFilter(null) removes the filter (filtered=false)');
  assert(restoredSummary.lastEventNumber === summary.lastEventNumber, 'smokeFilterU7: removing the filter restores the original last event number');
  assert(restoredSummary.approximateNumberOfEvents === summary.approximateNumberOfEvents, 'smokeFilterU7: removing the filter restores the original approximate event count');
}

// ---------------------------------------------------------------------------------
// U10 (table content-assist): elog/getEntryTypeSchema round trip through the actual
// bundled worker/session -- the schema `computeEntryProposals()` (shared/src/eventlog/
// entryProposals.ts) needs, static and independent of the open file (unlike
// getFilterHints above), but still routed through the worker for the reasons
// `entryTypeSchema.ts`'s header explains.
// ---------------------------------------------------------------------------------
async function smokeEntryTypeSchemaU10(session) {
  const schema = await session.handleEngineRequest(ElogMethods.getEntryTypeSchema, undefined);
  assert(Array.isArray(schema.BS) && schema.BS.includes('id') && schema.BS.includes('sd'), 'smokeEntryTypeSchemaU10: getEntryTypeSchema returns BS\'s attribute names, including an inherited one ("id") and a BS-specific one ("sd")');
  assert(Array.isArray(schema.ES) && schema.ES.includes('i'), 'smokeEntryTypeSchemaU10: getEntryTypeSchema returns ES\'s own attribute ("i")');
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

// ---------------------------------------------------------------------------------
// U8 (axis management): elog/sc/adjacencyMatrix round trips over the Fifo1 fixture --
// the engine side of the Minimize Crossings ordering mode. Exercises (a) a manual
// moduleIdToAxisIndex mapping (descendant modules attributed to an ancestor axis,
// the additive AdjacencyParams field this phase introduced), (b) the exact
// event-range path, and (c) the approximate sampled path chartMain.ts actually uses
// (numberOfSamples=1000, sendWeight=1, reuseWeight=0 per FlatAxisOrderByMinimizingCost).
// ---------------------------------------------------------------------------------
async function smokeAxisU8(session, summary) {
  const moduleTree = await session.handleEngineRequest(ElogMethods.getModuleTree, undefined);
  assert(moduleTree !== null && moduleTree.children.length > 0, 'smokeAxisU8: Fifo1 module tree has submodules');
  const childIds = moduleTree.children.map((c) => c.moduleId);

  // (b) exact range over the whole fixture, axes = the root + its direct children
  // (root included so ALL of the fixture's dependencies -- including any touching
  // the network module itself -- are attributed somewhere, making the collapsed-run
  // total below exactly comparable)
  const axisIds = [moduleTree.moduleId, ...childIds];
  const exact = await session.handleEngineRequest(ElogMethods.scAdjacencyMatrix, {
    moduleIds: axisIds,
    startEventNumber: summary.firstEventNumber,
    endEventNumber: summary.lastEventNumber,
    messageSendWeight: 1,
    messageReuseWeight: 0,
  });
  assert(exact.numberOfAxes === axisIds.length, 'smokeAxisU8: exact-range matrix reports one axis per module id');
  assert(Array.isArray(exact.matrix) && exact.matrix.length === axisIds.length * axisIds.length, 'smokeAxisU8: exact-range matrix is row-major n*n');
  const totalExact = exact.matrix.reduce((sum, w) => sum + w, 0);
  assert(totalExact > 0, `smokeAxisU8: Fifo1 has message sends, so the exact matrix has nonzero weight (total ${totalExact})`);

  // (a) manual moduleIdToAxisIndex mapping: collapse everything onto ONE axis (the
  // root) by mapping every submodule to axis 0 -- weights must land in [0][0]... i.e.
  // survive the mapping rather than being dropped for "unknown" module ids
  const mapping = {};
  for (const id of childIds) mapping[String(id)] = 0;
  const collapsed = await session.handleEngineRequest(ElogMethods.scAdjacencyMatrix, {
    moduleIds: [moduleTree.moduleId],
    moduleIdToAxisIndex: mapping,
    startEventNumber: summary.firstEventNumber,
    endEventNumber: summary.lastEventNumber,
    messageSendWeight: 1,
    messageReuseWeight: 0,
  });
  assert(collapsed.numberOfAxes === 1, 'smokeAxisU8: collapsed mapping yields a single axis');
  assert(collapsed.matrix.length === 1 && collapsed.matrix[0] === totalExact, `smokeAxisU8: every dependency lands on the one mapped axis (got ${collapsed.matrix[0]}, want ${totalExact})`);

  // (c) approximate sampled path (what the chart's Minimize Crossings mode requests)
  const approx = await session.handleEngineRequest(ElogMethods.scAdjacencyMatrix, {
    moduleIds: childIds,
    numberOfSamples: 1000,
    messageSendWeight: 1,
    messageReuseWeight: 0,
  });
  assert(approx.numberOfAxes === childIds.length && approx.matrix.length === childIds.length * childIds.length, 'smokeAxisU8: sampled matrix has the right shape');
  assert(approx.matrix.reduce((sum, w) => sum + w, 0) > 0, 'smokeAxisU8: 1000 samples over the small fixture find dependencies');
}

// ---------------------------------------------------------------------------------
// U9 (export + polish): "Release Memory" (elog/releaseMemory) round trip through the
// real bundled worker/session -- asserts the request resolves with a sane
// {eventCacheSizeBefore, eventCacheSizeAfter, eventCacheLimit} shape, that the log's
// actual content is unaffected (same lastEventNumber), that it bumps the
// stale-response guard (coordinateSystemVersion) like every other reset, that it
// broadcasts an `elog/memoryReleased` engineNotify to attached sinks (mirrors
// `refresh()`'s own `elog/refreshed` broadcast, asserted above), and that the engine
// keeps answering correctly afterwards (an oracle spot check on the first event).
// ---------------------------------------------------------------------------------
async function smokeReleaseMemoryU9(session, summary, messages) {
  const released = await session.handleEngineRequest(ElogMethods.releaseMemory, undefined);
  assert(typeof released.eventCacheSizeBefore === 'number' && typeof released.eventCacheSizeAfter === 'number', 'smokeReleaseMemoryU9: returns numeric before/after cache sizes');
  assert(typeof released.eventCacheLimit === 'number' && released.eventCacheLimit > 0, 'smokeReleaseMemoryU9: returns a positive eventCacheLimit');
  assert(released.summary.isEmpty === false, 'smokeReleaseMemoryU9: the log is still non-empty after releasing memory');
  assert(released.summary.lastEventNumber === summary.lastEventNumber, "smokeReleaseMemoryU9: releasing memory doesn't change the log's actual content");
  assert(released.summary.coordinateSystemVersion !== summary.coordinateSystemVersion, 'smokeReleaseMemoryU9: release bumps the stale-response guard, same as any other reset');

  assert(messages.some((m) => m.type === 'engineNotify' && m.event === 'elog/memoryReleased'), 'smokeReleaseMemoryU9: broadcasts an elog/memoryReleased engineNotify to attached sinks');

  // the engine keeps answering correctly afterwards (oracle spot check on the first event)
  const gotoFirst = await session.gotoEvent({ eventNumber: summary.firstEventNumber });
  assert(gotoFirst.found === true, 'smokeReleaseMemoryU9: the engine still finds the first event after releasing memory');
}

