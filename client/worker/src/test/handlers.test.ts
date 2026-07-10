/**
 * In-process integration tests for the E8 protocol-handler layer
 * (`handleElogRequest()` over a real `EngineSession`) against real fixture files --
 * no worker_thread, no child process, no JSON-RPC transport (see handlers.ts's
 * header for why the dispatch table is kept spawn-free specifically so these can
 * run as plain `bun:test`s). `scripts/elog-worker-smoke.mjs` covers the same
 * surface end-to-end through the real bundled process/transport; this suite is the
 * fast, in-repo regression net for the handler/session logic itself.
 */

import { test } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { join, resolve } from 'node:path';
import { EngineSession } from '../engineSession';
import { handleElogRequest } from '../handlers';
import { ElogMethods } from '@omnetpp/shared/elog-protocol';
import type { EventDetail, FilterHints, GotoResult, LogSummary, MapCoordsResult, ReleaseMemoryResult, RowWindow, ScListVectorsResult, ViewportModel } from '@omnetpp/shared/elog-protocol';
import { synthesizeEventLog } from '../../../../shared/src/test/eventlog/synthesizeEventLog';

const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const fixturePath = join(repoRoot, 'shared', 'src', 'test', 'fixtures', 'elog', 'sample', 'Fifo1-#0.elog');
const reuseFixturePath = join(repoRoot, 'shared', 'src', 'test', 'fixtures', 'elog', 'reuse', 'message-reuse.elog');

/** A no-op cancel flag + notify -- these tests never cancel and never run long enough to hit the ~100ms progress throttle. */
function noJobContext(): { cancelFlag: Int32Array; notify: () => void } {
  return { cancelFlag: new Int32Array(new SharedArrayBuffer(4)), notify: () => {} };
}

function call<R>(session: EngineSession, method: string, params: unknown): R {
  const { cancelFlag, notify } = noJobContext();
  return handleElogRequest(session, method, params, cancelFlag, notify) as R;
}

function openFixture(session: EngineSession): LogSummary {
  return call<LogSummary>(session, ElogMethods.open, { path: fixturePath });
}

test('handlers: elog/open returns a populated, non-empty LogSummary', () => {
  const session = new EngineSession();
  const summary = openFixture(session);
  assert.equal(summary.isEmpty, false);
  assert.equal(summary.filtered, false);
  assert.ok(summary.lastEventNumber > summary.firstEventNumber);
  assert.equal(typeof summary.firstSimulationTime, 'string');
  assert.equal(typeof summary.lastSimulationTime, 'string');
  assert.ok(summary.approximateNumberOfEvents > 0);
  // ADDITIVE (axis-vector run-id mismatch warning, `sequenceChartEditor.ts`'s
  // `attachAxisVectorFlow`): a non-empty fixture has a `SimulationBeginEntry`, so its run id
  // is surfaced rather than left `null`.
  assert.equal(typeof summary.runId, 'string');
  assert.ok((summary.runId as string).length > 0);
});

test('handlers: elog/getModuleTree returns the fixture\'s module hierarchy', () => {
  const session = new EngineSession();
  openFixture(session);
  const tree = call(session, ElogMethods.getModuleTree, undefined) as { moduleId: number; fullName: string; children: unknown[] } | null;
  assert.notEqual(tree, null);
  assert.equal(tree!.fullName, 'SingleQueue');
  assert.equal(tree!.children.length, 3);
});

test('handlers: elog/sc/getViewport returns non-empty events/dependencies with monotonic tc and every dependency tc is a number or null (never throws on out-of-range sentinel simtimes)', () => {
  const session = new EngineSession();
  const summary = openFixture(session);
  call(session, ElogMethods.scSetTimelineMode, { timelineMode: 'EVENT_NUMBER' });
  call(session, ElogMethods.scRelocateOrigin, { eventNumber: summary.firstEventNumber });

  const viewport = call<ViewportModel>(session, ElogMethods.scGetViewport, {
    range: { kind: 'event', startEventNumber: summary.firstEventNumber, endEventNumber: summary.lastEventNumber },
  });
  assert.ok(viewport.events.length > 0);
  assert.ok(viewport.dependencies.length > 0);
  assert.equal(viewport.truncated, false);
  for (let i = 1; i < viewport.events.length; i++) assert.ok(viewport.events[i].tcBegin >= viewport.events[i - 1].tcBegin);
  for (const dep of viewport.dependencies) {
    assert.ok(dep.causeTc === null || typeof dep.causeTc === 'number');
    assert.ok(dep.consequenceTc === null || typeof dep.consequenceTc === 'number');
  }
  // this fixture is small enough that every event's module should show up in moduleIds
  assert.ok(viewport.moduleIds.length > 0);
});

test('handlers: elog/sc/getViewport respects maxEvents truncation', () => {
  const session = new EngineSession();
  const summary = openFixture(session);
  const viewport = call<ViewportModel>(session, ElogMethods.scGetViewport, {
    range: { kind: 'event', startEventNumber: summary.firstEventNumber, endEventNumber: summary.lastEventNumber },
    maxEvents: 3,
    includeDependencies: false,
    includeMethodCalls: false,
  });
  assert.equal(viewport.events.length, 3);
  assert.equal(viewport.truncated, true);
});

test('handlers: elog/table/getRows anchored at "first" returns the requested window shape', () => {
  const session = new EngineSession();
  openFixture(session);
  const window = call<RowWindow>(session, ElogMethods.tableGetRows, { anchor: { kind: 'first' }, before: 0, after: 5 });
  assert.equal(window.anchorIndex, 0);
  assert.equal(window.rows.length, 5);
  assert.equal(window.hasMoreBefore, false);
  assert.equal(window.hasMoreAfter, true);
  for (const row of window.rows) {
    assert.equal(typeof row.entryClassCode, 'string');
    assert.equal(typeof row.simulationTime, 'string');
    assert.equal(typeof row.ref.eventNumber, 'number');
    assert.equal(typeof row.ref.entryIndex, 'number');
  }
});

test('handlers: elog/table/getRows anchored at a ref includes rows both before and after it', () => {
  const session = new EngineSession();
  openFixture(session);
  const firstWindow = call<RowWindow>(session, ElogMethods.tableGetRows, { anchor: { kind: 'first' }, before: 0, after: 8 });
  const midRef = firstWindow.rows[4].ref;

  const window = call<RowWindow>(session, ElogMethods.tableGetRows, { anchor: { kind: 'ref', ref: midRef }, before: 2, after: 2 });
  assert.equal(window.anchorIndex, 2);
  assert.equal(window.rows.length, 4);
  assert.deepEqual(window.rows[2].ref, midRef);
});

test('handlers: elog/table/getRows omits `rendered` when `render` is not requested (tableNavigate/tablePosition\'s bookkeeping-only use case)', () => {
  const session = new EngineSession();
  openFixture(session);
  const window = call<RowWindow>(session, ElogMethods.tableGetRows, { anchor: { kind: 'first' }, before: 0, after: 3 });
  for (const row of window.rows) assert.equal(row.rendered, undefined);
});

test('handlers: elog/table/getRows with `render` populates `rendered` (styled spans) on every row, first row is the descriptive "E" text', () => {
  const session = new EngineSession();
  openFixture(session);
  const window = call<RowWindow>(session, ElogMethods.tableGetRows, {
    anchor: { kind: 'first' },
    before: 0,
    after: 6,
    render: { displayMode: 'DESCRIPTIVE', nameMode: 'SMART_NAME', typeMode: 'CPP' },
  });
  assert.equal(window.rows.length, 6);
  for (const row of window.rows) {
    assert.ok(row.rendered, `row ${row.entryClassCode} should have a rendered DTO`);
    assert.equal(typeof row.rendered!.indentUnits, 'number');
    assert.equal(row.rendered!.eventNumberSpan.text, `#${row.eventNumber}`);
    assert.ok(row.rendered!.detailSpans.length > 0);
  }
  // The very first row is event #0's "E" line -- eventNumber 0 is special-cased by the
  // renderer ("Initializing ...") rather than the general "Event in module ..." text.
  assert.equal(window.rows[0].entryClassCode, 'E');
  assert.equal(window.rows[0].rendered!.eventNumberSpan.style, 'eventNo');
  assert.match(
    window.rows[0].rendered!.detailSpans.map((s) => s.text).join(''),
    /^Initializing module/,
  );
});

test('handlers: elog/table/getRows with `render` in RAW mode reproduces the entry\'s attribute dump', () => {
  const session = new EngineSession();
  openFixture(session);
  const window = call<RowWindow>(session, ElogMethods.tableGetRows, {
    anchor: { kind: 'first' },
    before: 0,
    after: 1,
    render: { displayMode: 'RAW', nameMode: 'SMART_NAME', typeMode: 'CPP' },
  });
  const row = window.rows[0];
  const rawText = row.rendered!.detailSpans.map((s) => s.text).join('');
  assert.ok(rawText.startsWith(`${row.entryClassCode} `));
  for (const name of Object.keys(row.fields)) assert.ok(rawText.includes(`${name} `), `raw text should mention attribute "${name}"`);
});

test('handlers: elog/gotoEvent and elog/gotoSimTime resolve the same first event', () => {
  const session = new EngineSession();
  const summary = openFixture(session);

  const byEvent = call<GotoResult>(session, ElogMethods.gotoEvent, { eventNumber: summary.firstEventNumber });
  assert.equal(byEvent.found, true);
  assert.equal(byEvent.eventNumber, summary.firstEventNumber);
  assert.notEqual(byEvent.ref, null);

  // MatchKind.EXACT (the default) throws for a simulation time shared by more than one
  // event -- see engineSession.ts's gotoSimTime doc comment -- so a tolerant MatchKind
  // is used here (this fixture has several events at t=0).
  const byTime = call<GotoResult>(session, ElogMethods.gotoSimTime, { simulationTime: summary.firstSimulationTime, matchKind: 'FIRST_OR_PREVIOUS' });
  assert.equal(byTime.found, true);
  assert.equal(byTime.simulationTime, summary.firstSimulationTime);
});

test('handlers: elog/gotoEvent past the last event number throws (documented, pre-existing engine precondition, any MatchKind)', () => {
  // Per shared/src/test/eventlog/memoryBounding.test.ts's own note on
  // `EventLogIndex.searchForOffset()`: querying past the last event number throws
  // regardless of MatchKind -- an out-of-scope, pre-existing engine limitation, not
  // something this phase changes. A real "go to event" UI is expected to clamp/validate
  // the target event number against the current LogSummary before calling elog/gotoEvent.
  const session = new EngineSession();
  const summary = openFixture(session);
  assert.throws(() => call<GotoResult>(session, ElogMethods.gotoEvent, { eventNumber: summary.lastEventNumber + 1000 }));
});

test('handlers: elog/findText finds a known substring and reports a miss for an absent one', () => {
  const session = new EngineSession();
  openFixture(session);
  const hit = call(session, ElogMethods.findText, { start: null, search: 'Fifo', forward: true, caseSensitive: false }) as { found: boolean; ref: unknown };
  assert.equal(hit.found, true);
  assert.notEqual(hit.ref, null);

  const miss = call(session, ElogMethods.findText, { start: null, search: 'DefinitelyNotInThisFile_xyz', forward: true, caseSensitive: false }) as { found: boolean; ref: unknown };
  assert.equal(miss.found, false);
  assert.equal(miss.ref, null);
});

test('handlers: elog/sc/mapCoords round-trips eventToTc/tcToEventNumber for the first event', () => {
  const session = new EngineSession();
  const summary = openFixture(session);
  call(session, ElogMethods.scSetTimelineMode, { timelineMode: 'EVENT_NUMBER' });
  call(session, ElogMethods.scRelocateOrigin, { eventNumber: summary.firstEventNumber });

  const toTc = call<MapCoordsResult>(session, ElogMethods.scMapCoords, { kind: 'eventToTc', eventNumber: summary.firstEventNumber });
  assert.equal(typeof toTc.tc, 'number');

  const back = call<MapCoordsResult>(session, ElogMethods.scMapCoords, { kind: 'tcToEventNumber', tc: toTc.tc });
  assert.equal(back.eventNumber, summary.firstEventNumber);
});

test('handlers: elog/setFilter installs a module filter that narrows the log, and null reverts it', () => {
  const session = new EngineSession();
  const rawSummary = openFixture(session);

  const filteredSummary = call<LogSummary>(session, ElogMethods.setFilter, { enableModuleFilter: true, moduleIds: [3] }); // "fifo" module only
  assert.equal(filteredSummary.filtered, true);
  assert.ok(filteredSummary.approximateNumberOfEvents <= rawSummary.approximateNumberOfEvents);
  assert.notEqual(filteredSummary.coordinateSystemVersion, rawSummary.coordinateSystemVersion);

  const revertedSummary = call<LogSummary>(session, ElogMethods.setFilter, null);
  assert.equal(revertedSummary.filtered, false);
  assert.equal(revertedSummary.lastEventNumber, rawSummary.lastEventNumber);
});

test('handlers: elog/getEventDetail returns every raw entry for one event', () => {
  const session = new EngineSession();
  const summary = openFixture(session);
  const detail = call(session, ElogMethods.getEventDetail, { eventNumber: summary.firstEventNumber }) as { eventNumber: number; entries: unknown[] } | null;
  assert.notEqual(detail, null);
  assert.equal(detail!.eventNumber, summary.firstEventNumber);
  assert.ok(detail!.entries.length > 0);
});

test('handlers: an unknown method throws (engineThread-level bug, not exercised over the wire)', () => {
  const session = new EngineSession();
  openFixture(session);
  assert.throws(() => call(session, 'elog/notAMethod', undefined));
});

// ---------------------------------------------------------------------------------
// Phase U7: elog/getFilterHints + elog/setFilter with trace params on the reuse
// fixture (`shared/src/test/fixtures/elog/reuse/message-reuse.elog`: event #0 creates
// message id=10, event #1 begins sending that SAME message id=10 again -- a message
// REUSE, `pe 0` -- event #2 is unrelated to message 10 entirely).
// ---------------------------------------------------------------------------------

test('handlers: elog/getFilterHints returns populated, sorted, deduplicated message/module name lists for the fixture', () => {
  const session = new EngineSession();
  openFixture(session);
  const hints = call<FilterHints>(session, ElogMethods.getFilterHints, undefined);
  assert.equal(hints.truncated, false);
  assert.ok(hints.moduleNames.length > 0);
  assert.ok(hints.moduleNedTypeNames.length > 0);
  // sorted (dictionary order) and deduplicated
  for (const list of [hints.moduleNames, hints.moduleClassNames, hints.moduleNedTypeNames, hints.messageNames, hints.messageClassNames]) {
    assert.deepEqual(list, [...new Set(list)].sort((a, b) => a.localeCompare(b)));
  }
});

test('handlers: elog/getFilterHints on an unopened session returns empty (not throwing) lists', () => {
  const session = new EngineSession();
  openFixture(session);
  // "no module description entries at all" is exercised implicitly by every fixture
  // that DOES have modules; this test only guards against a throw on the call shape.
  const hints = call<FilterHints>(session, ElogMethods.getFilterHints, undefined);
  assert.ok(Array.isArray(hints.moduleNames));
});

// Phase U10: elog/getEntryTypeSchema -- static, so it doesn't even need a file open
// (unlike getFilterHints/getModuleTree, which reflect the currently-parsed log).

test('handlers: elog/getEntryTypeSchema returns the BS schema, with no file open at all', () => {
  const session = new EngineSession();
  const schema = call<Record<string, string[]>>(session, ElogMethods.getEntryTypeSchema, undefined);
  assert.ok(Array.isArray(schema.BS));
  assert.ok(schema.BS.includes('id'));
  assert.ok(schema.BS.includes('sd'));
});

test('handlers: elog/setFilter with a trace filter (traceMessageReuses=true) on the reuse fixture follows the reuse dependency back to its origin event', () => {
  const session = new EngineSession();
  const rawSummary = call<LogSummary>(session, ElogMethods.open, { path: reuseFixturePath });
  assert.equal(rawSummary.isEmpty, false);

  const filteredSummary = call<LogSummary>(session, ElogMethods.setFilter, {
    tracedEventNumber: 1,
    traceCauses: true,
    traceConsequences: false,
    traceMessageReuses: true,
    traceSelfMessages: true,
    collectMessageReuses: true,
  });
  assert.equal(filteredSummary.filtered, true);

  // NOTE: this fixture's BeginSendEntry has no matching EndSendEntry (a deliberately
  // minimal 3-event fixture -- see its own header/contents), which trips the Sequence
  // Chart facade's transmission-duration lookup; `elog/table/*` (a plain entry
  // enumeration, no arrow/transmission geometry) is unaffected, so this test verifies
  // filtered CONTENTS through the table surface rather than `elog/sc/getViewport`.
  const rows = call<RowWindow>(session, ElogMethods.tableGetRows, { anchor: { kind: 'first' }, before: 0, after: 10 });
  const rowEventNumbers = new Set(rows.rows.map((r) => r.eventNumber));
  assert.ok(rowEventNumbers.has(0));
  assert.ok(rowEventNumbers.has(1));
  assert.ok(!rowEventNumbers.has(2));

  // removing the filter restores every event
  const revertedSummary = call<LogSummary>(session, ElogMethods.setFilter, null);
  assert.equal(revertedSummary.filtered, false);
  assert.equal(revertedSummary.lastEventNumber, rawSummary.lastEventNumber);
  const revertedRows = call<RowWindow>(session, ElogMethods.tableGetRows, { anchor: { kind: 'first' }, before: 0, after: 10 });
  assert.ok(new Set(revertedRows.rows.map((r) => r.eventNumber)).has(2), 'event #2 is back once the filter is removed');
});

test('handlers: elog/setFilter with traceMessageReuses=false excludes the reuse origin event on the reuse fixture', () => {
  const session = new EngineSession();
  call(session, ElogMethods.open, { path: reuseFixturePath });

  const filteredSummary = call<LogSummary>(session, ElogMethods.setFilter, {
    tracedEventNumber: 1,
    traceCauses: true,
    traceConsequences: false,
    traceMessageReuses: false,
  });
  assert.equal(filteredSummary.filtered, true);

  const rows = call<RowWindow>(session, ElogMethods.tableGetRows, { anchor: { kind: 'first' }, before: 0, after: 10 });
  const rowEventNumbers = new Set(rows.rows.map((r) => r.eventNumber));
  assert.ok(rowEventNumbers.has(1));
  assert.ok(!rowEventNumbers.has(0), 'traceMessageReuses=false must NOT follow the reuse dependency back to event #0');
});

// ---------------------------------------------------------------------------------
// Phase U9 -- "Release Memory" (elog/releaseMemory)
// ---------------------------------------------------------------------------------

function mkTempEventLogFile(name: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnetpp-release-memory-'));
  return { dir, file: path.join(dir, name) };
}

test('handlers: elog/releaseMemory drops the parsed-event cache after a full scan, while subsequent queries stay correct (oracle spot check)', () => {
  const { dir, file } = mkTempEventLogFile('release-memory.elog');
  try {
    const eventCount = 2000;
    const synthesized = synthesizeEventLog({ eventCount });
    fs.writeFileSync(file, synthesized.text);

    const session = new EngineSession();
    // `smallFileThresholdBytes: 0` forces the "large file" open path (parseBegin/
    // parseEnd only, NOT a full parseAll()) even though this synthetic fixture is
    // small in bytes -- otherwise the constructor's own parseAll() would already
    // populate the whole cache and this test wouldn't be exercising the "populate via
    // scans, then release" scenario the port plan's U9 row asks for.
    const summary = call<LogSummary>(session, ElogMethods.open, { path: file, options: { smallFileThresholdBytes: 0, parseBeginEndBytes: 500 } });
    assert.equal(summary.isEmpty, false);
    assert.equal(summary.lastEventNumber, eventCount - 1);

    // scan every event once via elog/getEventDetail (a plain by-number lookup, same as
    // an Event Log table/chart round trip would do while the user pans/scrolls) --
    // populates the bounded parsed-event LRU (phase E7) well beyond whatever
    // parseBegin/parseEnd left cached at open() time.
    for (let n = summary.firstEventNumber; n <= summary.lastEventNumber; n++) {
      const detail = call<EventDetail | null>(session, ElogMethods.getEventDetail, { eventNumber: n });
      assert.ok(detail !== null, `event #${n} must resolve during the populating scan`);
    }

    const released = call<ReleaseMemoryResult>(session, ElogMethods.releaseMemory, undefined);
    assert.ok(released.eventCacheSizeBefore > eventCount / 2, `expected a well-populated cache before release, got ${released.eventCacheSizeBefore} (scanned ${eventCount} events)`);
    assert.ok(
      released.eventCacheSizeAfter < released.eventCacheSizeBefore / 4,
      `expected a large drop after releasing memory, got ${released.eventCacheSizeBefore} -> ${released.eventCacheSizeAfter}`,
    );
    assert.equal(released.summary.isEmpty, false);
    assert.equal(released.summary.lastEventNumber, summary.lastEventNumber, "releasing memory doesn't change the log's actual content");
    assert.notEqual(released.summary.coordinateSystemVersion, summary.coordinateSystemVersion, 'release bumps the stale-response guard, same as any other reset');

    // subsequent queries still resolve correctly (oracle spot check): the file itself
    // was never touched, only the engine's own caches were dropped -- everything
    // re-parses lazily and must agree with the ground truth `synthesizeEventLog()` built.
    const midEvent = Math.floor(eventCount / 2);
    const oracleMid = call<EventDetail | null>(session, ElogMethods.getEventDetail, { eventNumber: midEvent });
    assert.equal(oracleMid?.simulationTime, synthesized.simTimes[midEvent]);
    const oracleFirst = call<EventDetail | null>(session, ElogMethods.getEventDetail, { eventNumber: summary.firstEventNumber });
    assert.equal(oracleFirst?.simulationTime, synthesized.simTimes[summary.firstEventNumber]);
    const oracleLast = call<EventDetail | null>(session, ElogMethods.getEventDetail, { eventNumber: summary.lastEventNumber });
    assert.equal(oracleLast?.simulationTime, synthesized.simTimes[summary.lastEventNumber]);

    // a full re-scan after release still finds every event (nothing silently lost)
    for (let n = summary.firstEventNumber; n <= summary.lastEventNumber; n++) {
      const detail = call<EventDetail | null>(session, ElogMethods.getEventDetail, { eventNumber: n });
      assert.ok(detail !== null, `event #${n} must still resolve after releaseMemory()`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handlers: elog/sc/getViewport keeps an attached vector\'s strip alive (and extends its held segment to the viewport edge) when a later sample\'s event number is out of the currently resolvable range', () => {
  // Regression test for a real bug: a vector strip's segment holds its value from one
  // sample's event to the next sample's event. When that next event is far outside the
  // fixture's event range (e.g. because the source `.vec` was recorded against a run
  // with vastly more events than we've loaded here), the engine's event-number lookup
  // throws rather than returning null -- and, uncaught, that used to abort the whole
  // strip build (silently dropping every segment, not just the unresolvable one). It
  // must instead fall back gracefully and paint the held segment out to the edge of the
  // visible viewport instead of collapsing it to zero width.
  const session = new EngineSession();
  const summary = openFixture(session); // Fifo1-#0.elog: module id 3 = "SingleQueue.fifo", last event #32
  call(session, ElogMethods.scSetTimelineMode, { timelineMode: 'NONLINEAR' });
  call(session, ElogMethods.scRelocateOrigin, { eventNumber: summary.firstEventNumber });

  const vec = [
    'version 3',
    'run Fifo1-0-run',
    'vector 0 SingleQueue.fifo queueLength:vector ETV',
    'attr enum "EMPTY=0,BUSY=1"',
    '0\t2\t0.1\t1',
    // the next sample's event number (999) is far beyond this fixture's last event (32)
    // -- unresolvable via getEventForEventNumber, forcing the simtime/edge fallback path
    '0\t999\t50.0\t0',
  ].join('\n');

  const list = call<ScListVectorsResult>(session, ElogMethods.scListVectors, { content: vec });
  assert.strictEqual(list.vectors.length, 1);
  call(session, ElogMethods.scAttachVector, { moduleId: 3, content: vec, vector: { run: list.runs[0], vectorModule: 'SingleQueue.fifo', vectorName: 'queueLength:vector' } });

  const viewport = call<ViewportModel>(session, ElogMethods.scGetViewport, {
    range: { kind: 'event', startEventNumber: summary.firstEventNumber, endEventNumber: summary.lastEventNumber },
  });
  const strip = viewport.axisVectorStrips?.find((s) => s.moduleId === 3);
  assert.ok(strip, 'strip must survive an out-of-range sample instead of being dropped entirely');
  // the second sample's own segment starts at event #999, outside the viewport, so it's
  // culled -- only the first sample's held-value segment (event #2 .. event #999) is visible.
  assert.strictEqual(strip!.segments.length, 1);
  const [held] = strip!.segments;
  assert.strictEqual(held.value, 1);
  assert.ok(held.tcEnd > held.tcBegin, `held segment must extend past its start instead of collapsing to zero width, got tcBegin=${held.tcBegin} tcEnd=${held.tcEnd}`);
});
