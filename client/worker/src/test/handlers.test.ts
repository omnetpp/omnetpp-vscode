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
import { join, resolve } from 'node:path';
import { EngineSession } from '../engineSession';
import { handleElogRequest } from '../handlers';
import { ElogMethods } from '@omnetpp/shared/elog-protocol';
import type { GotoResult, LogSummary, MapCoordsResult, RowWindow, ViewportModel } from '@omnetpp/shared/elog-protocol';

const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const fixturePath = join(repoRoot, 'shared', 'src', 'test', 'fixtures', 'elog', 'sample', 'Fifo1-#0.elog');

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
