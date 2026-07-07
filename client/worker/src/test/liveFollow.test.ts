/**
 * Phase E9 ("live follow") integration tests: append/overwrite/mid-request-change
 * synchronize flows, driven at the same in-process level as
 * `client/worker/src/test/handlers.test.ts` (`handleElogRequest()` over a real
 * `EngineSession`, no worker_thread, no child process, no JSON-RPC transport) --
 * `scripts/elog-worker-smoke.mjs` covers the same surface end-to-end through the
 * real bundled process/transport and its own watcher/poll timer.
 *
 * Change detection itself (`elog/checkChanges`) is driven manually here rather than
 * through `client/worker/src/watcher.ts`'s fs.watch/poll-timer hybrid -- that hybrid
 * only ever calls into this exact same `elog/checkChanges` request path (see
 * main.ts's `requestCheckFileChange()`/engineThread.ts's job handling), so exercising
 * it manually covers the same engine-side logic deterministically. `watcher.ts`'s own
 * mechanics (fs.watch + poll timer firing `onChange`) are covered separately below,
 * as a standalone unit test of that module (no engine involved).
 */

import { test } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EngineSession } from '../engineSession';
import { handleElogRequest } from '../handlers';
import { watchFile } from '../watcher';
import { ElogMethods } from '@omnetpp/shared/elog-protocol';
import type { CheckChangesResult, FindTextResult, LogSummary, RowRef, RowWindow, ViewportModel } from '@omnetpp/shared/elog-protocol';
import { synthesizeEventLogSteps } from '../../../../shared/src/test/eventlog/synthesizeEventLog';

/** A no-op cancel flag -- these tests never cancel. */
function noCancelFlag(): Int32Array {
  return new Int32Array(new SharedArrayBuffer(4));
}

function call<R>(session: EngineSession, method: string, params: unknown, notify: () => void = () => {}): R {
  return handleElogRequest(session, method, params, noCancelFlag(), notify) as R;
}

function mkTempFile(name: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnetpp-live-follow-'));
  return { dir, file: path.join(dir, name) };
}

/**
 * Test-only escape hatch for the mid-request-change test: forces the *next*
 * `eventLog.progress()` call to actually invoke its `onProgress` hook, bypassing the
 * real (default 100ms) progress-call-interval throttle deterministically. `open()`'s
 * own initial parse already calls `progress()` near its end (priming the throttle's
 * "last called" timestamp close to "now"), so without this, whether a *subsequent*
 * `findText` scan's very first `progress()` call fires at all would depend on how
 * much wall-clock time happens to have passed since `open()` returned -- exactly the
 * kind of timing race this test is designed to avoid (see the port plan/E9 task
 * list: "prefer deterministic"). `EventLog.setProgressCallInterval(seconds)` is the
 * only public lever on the interval (no public API resets the "last called"
 * timestamp itself), so a large *negative* interval is used to force the inequality
 * `lastProgressCall + progressCallInterval < Date.now()` true unconditionally on the
 * very next call, regardless of how recently `progress()` last actually fired.
 * Reaches into `EngineSession`'s private `eventLog` field (test-only; there is no
 * public `ElogMethods` surface for tuning this, on purpose -- it's an engine-internal
 * throttle, not something a real client should ever need to adjust).
 */
function forceImmediateProgress(session: EngineSession): void {
  (session as unknown as { eventLog: { setProgressCallInterval(seconds: number): void } }).eventLog.setProgressCallInterval(-1e9);
}

// ---------------------------------------------------------------------------------
// append -> elog/changed-worthy result, viewport/table extend, RowRefs still resolve
// ---------------------------------------------------------------------------------

test('live-follow: appending well-formed events is detected, extends the viewport/table, and pre-append RowRefs still resolve', () => {
  const { dir, file } = mkTempFile('live.elog');
  try {
    const steps = synthesizeEventLogSteps({ eventCount: 30 });
    const initialEventCount = 20;
    fs.writeFileSync(file, steps.cumulativeText[initialEventCount]);

    const session = new EngineSession();
    const initialSummary = call<LogSummary>(session, ElogMethods.open, { path: file });
    assert.equal(initialSummary.lastEventNumber, initialEventCount - 1);

    // capture RowRefs from before the append via elog/gotoEvent (exact -- "the first
    // table row of the resolved event", not an entry-count guess: event #0 also has an
    // "MC" entry, so table rows and event numbers aren't 1:1 -- see elogProtocol.ts's
    // TableRow/RowRef docs). Confirm both keep resolving correctly afterward (port
    // plan risk #3: RowRefs are a (eventNumber, entryIndex) compound key, not an
    // object reference, so they must survive the reparse/eviction an APPENDED
    // synchronize triggers).
    const midGoto = call<{ found: boolean; ref: RowRef | null }>(session, ElogMethods.gotoEvent, { eventNumber: 10 });
    assert.equal(midGoto.found, true);
    const midRef = midGoto.ref!;
    const lastGotoBeforeAppend = call<{ found: boolean; ref: RowRef | null }>(session, ElogMethods.gotoEvent, { eventNumber: initialEventCount - 1 });
    assert.equal(lastGotoBeforeAppend.found, true);
    const lastRefBeforeAppend = lastGotoBeforeAppend.ref!;

    // append 5 more well-formed events directly to the file (same bytes a live
    // simulation process would have appended -- see synthesizeEventLogSteps's header).
    const finalEventCount = 25;
    const appended = steps.cumulativeText[finalEventCount].slice(steps.cumulativeText[initialEventCount].length);
    fs.appendFileSync(file, appended);

    const checkResult = call<CheckChangesResult>(session, ElogMethods.checkChanges, undefined);
    assert.equal(checkResult.changed, true, 'checkChanges: detects the append');
    assert.equal(checkResult.change, 'appended');
    assert.equal(checkResult.summary.lastEventNumber, finalEventCount - 1, 'checkChanges: fresh summary reflects the 5 appended events');

    // a second check right after is a no-op (nothing changed since the last sync)
    const secondCheck = call<CheckChangesResult>(session, ElogMethods.checkChanges, undefined);
    assert.equal(secondCheck.changed, false, 'checkChanges: idempotent once synchronized');

    // viewport now includes the newly appended events
    const viewport = call<ViewportModel>(session, ElogMethods.scGetViewport, {
      range: { kind: 'event', startEventNumber: 0, endEventNumber: finalEventCount - 1 },
    });
    assert.equal(viewport.events.length, finalEventCount, 'sc/getViewport: every event 0..24 is visible after synchronize');
    assert.ok(
      viewport.events.some((e) => e.eventNumber === finalEventCount - 1),
      'sc/getViewport: the newly appended last event is visible',
    );

    // table extends too: anchored at "last" now reaches event #24, and elog/gotoEvent
    // resolves every newly appended event number
    const afterWindow = call<RowWindow>(session, ElogMethods.tableGetRows, { anchor: { kind: 'last' }, before: 0, after: 1 });
    assert.equal(afterWindow.rows[0].eventNumber, finalEventCount - 1);
    for (let eventNumber = initialEventCount; eventNumber < finalEventCount; eventNumber++) {
      const goto = call<{ found: boolean }>(session, ElogMethods.gotoEvent, { eventNumber });
      assert.equal(goto.found, true, `event #${eventNumber} (appended) is reachable via gotoEvent`);
    }

    // pre-append RowRefs still resolve to the same logical row
    const midWindow = call<RowWindow>(session, ElogMethods.tableGetRows, { anchor: { kind: 'ref', ref: midRef }, before: 0, after: 1 });
    assert.deepEqual(midWindow.rows[0].ref, midRef, 'a RowRef captured before the append still resolves after synchronize');
    assert.equal(midWindow.rows[0].eventNumber, 10);

    const lastRefWindow = call<RowWindow>(session, ElogMethods.tableGetRows, { anchor: { kind: 'ref', ref: lastRefBeforeAppend }, before: 0, after: 1 });
    assert.deepEqual(lastRefWindow.rows[0].ref, lastRefBeforeAppend, 'the RowRef for the pre-append last row also still resolves (its Event was reparsed by the APPENDED synchronize)');

    // navigating forward from the old last row (a single-entry event, like every
    // appended one) reaches the newly appended rows
    const navigated = call<RowRef | null>(session, ElogMethods.tableNavigate, { ref: lastRefBeforeAppend, distance: 5 });
    assert.notEqual(navigated, null);
    assert.equal(navigated!.eventNumber, finalEventCount - 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------
// half-written event: detected but invisible until completed
// ---------------------------------------------------------------------------------

test('live-follow: a half-written (truncated mid-line) appended event is invisible until completed', () => {
  const { dir, file } = mkTempFile('live.elog');
  try {
    const steps = synthesizeEventLogSteps({ eventCount: 22 });
    const initialEventCount = 20;
    fs.writeFileSync(file, steps.cumulativeText[initialEventCount]);

    const session = new EngineSession();
    const initialSummary = call<LogSummary>(session, ElogMethods.open, { path: file });
    assert.equal(initialSummary.lastEventNumber, initialEventCount - 1);

    // append event #20's line, but truncated mid-line (no trailing '\n' at all --
    // FileReader's "an incomplete last line is not returned" rule, ported from
    // filereader.cc, means this half-line must not surface as a new event).
    const fullNextEventLine = `E # ${initialEventCount} t ${steps.simTimes[initialEventCount]} m 1 ce -1 msg -1\n`;
    const halfLine = fullNextEventLine.slice(0, Math.floor(fullNextEventLine.length / 2));
    assert.ok(!halfLine.includes('\n'), 'test setup: the half-line has no newline at all');
    fs.appendFileSync(file, halfLine);

    const checkAfterHalf = call<CheckChangesResult>(session, ElogMethods.checkChanges, undefined);
    // the file did change size (detected), but the appended bytes don't contain a
    // complete new event yet
    assert.equal(checkAfterHalf.changed, true, 'checkChanges: still detects a byte-level append even though no full line was added');
    assert.equal(checkAfterHalf.summary.lastEventNumber, initialEventCount - 1, 'the half-written event is not visible yet');

    const viewportAfterHalf = call<ViewportModel>(session, ElogMethods.scGetViewport, {
      range: { kind: 'event', startEventNumber: 0, endEventNumber: initialEventCount - 1 },
    });
    assert.ok(
      !viewportAfterHalf.events.some((e) => e.eventNumber === initialEventCount),
      'the half-written event does not appear in a viewport',
    );

    // complete the line (and the rest of that event's block, i.e. the "MC"-less body
    // + blank line, matching synthesizeEventLogSteps's per-event shape)
    const restOfLine = fullNextEventLine.slice(halfLine.length) + '\n';
    fs.appendFileSync(file, restOfLine);

    const checkAfterComplete = call<CheckChangesResult>(session, ElogMethods.checkChanges, undefined);
    assert.equal(checkAfterComplete.changed, true);
    assert.equal(checkAfterComplete.summary.lastEventNumber, initialEventCount, 'the event is visible once its line is completed');

    const detail = call(session, ElogMethods.getEventDetail, { eventNumber: initialEventCount }) as { eventNumber: number } | null;
    assert.notEqual(detail, null);
    assert.equal(detail!.eventNumber, initialEventCount);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------
// overwrite -> full reset, with an active filter re-applied
// ---------------------------------------------------------------------------------

test('live-follow: overwriting the file resets the log and re-applies the retained filter', () => {
  const { dir, file } = mkTempFile('live.elog');
  try {
    const originalSteps = synthesizeEventLogSteps({ eventCount: 20 });
    fs.writeFileSync(file, originalSteps.cumulativeText[20]);

    const session = new EngineSession();
    const openSummary = call<LogSummary>(session, ElogMethods.open, { path: file });
    assert.equal(openSummary.lastEventNumber, 19);

    // install a filter that only lets even event numbers through (module id 1 is the
    // only module every event belongs to in this fixture, so filter by event number
    // via excludedEventNumbers instead of a module filter, to keep this test focused
    // on "the filter survives an overwrite", not module-filter semantics).
    const excluded = Array.from({ length: 20 }, (_, i) => i).filter((i) => i % 2 === 1);
    const filteredSummary = call<LogSummary>(session, ElogMethods.setFilter, { excludedEventNumbers: excluded });
    assert.equal(filteredSummary.filtered, true);
    assert.equal(filteredSummary.lastEventNumber, 18, 'filtered log\'s last (even) event number before the overwrite');

    // overwrite with a *shorter* log (a real simulation restart producing fewer
    // events than the previous run reached) -- shrinking guarantees FileReader's
    // getFileChange() reports OVERWRITTEN unconditionally (a size decrease), so this
    // assertion doesn't depend on filesystem mtime resolution.
    const newSteps = synthesizeEventLogSteps({ eventCount: 8, simTimeForEvent: (i) => String(1000 + i) });
    fs.writeFileSync(file, newSteps.cumulativeText[8]);

    const checkResult = call<CheckChangesResult>(session, ElogMethods.checkChanges, undefined);
    assert.equal(checkResult.changed, true);
    assert.equal(checkResult.change, 'overwritten');
    assert.equal(checkResult.summary.filtered, true, 'the filtered view is still active after the overwrite');
    assert.equal(checkResult.summary.lastEventNumber, 6, 'new log has 8 events (#0..#7); filtered (even-only) last is #6');
    assert.equal(checkResult.summary.firstSimulationTime, '1000', 'old event numbers/simtimes are gone -- this is the new log\'s content');

    // the filtered table view actually works post-overwrite (not just the summary)
    const window = call<RowWindow>(session, ElogMethods.tableGetRows, { anchor: { kind: 'first' }, before: 0, after: 10 });
    const eventNumbersSeen = new Set(window.rows.map((r) => r.eventNumber));
    assert.ok(eventNumbersSeen.has(0) && eventNumbersSeen.has(2) && eventNumbersSeen.has(6), 'filtered table shows the even-numbered events of the new (shorter) log');
    assert.ok(![...eventNumbersSeen].some((n) => n % 2 === 1), 'odd-numbered events stay excluded after the overwrite (filter re-applied, not dropped)');

    // reverting the filter reaches the whole new (shorter) log
    const revertedSummary = call<LogSummary>(session, ElogMethods.setFilter, null);
    assert.equal(revertedSummary.filtered, false);
    assert.equal(revertedSummary.lastEventNumber, 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------
// mid-request change: a running request observes FileChangedError -> ContentChanged
// ---------------------------------------------------------------------------------

test('live-follow: a file change mid-scan surfaces as a ContentChanged error, and a manual retry against the now-synchronized state succeeds', () => {
  const { dir, file } = mkTempFile('big.elog');
  try {
    // Large enough (well over FileReader's default 256KB buffer) that a full-file
    // findText miss needs several buffer-window reloads -- each one calls
    // checkFileForChanges() first (fileReader.ts's forceLoad()), so a change that
    // happens partway through the scan is guaranteed to be observed by a *later*
    // reload, deterministically (no wall-clock race): the mutation below happens
    // inside the `notify` callback, which `EventLog.progress()` invokes -- forced to
    // fire on its very first call (see `forceImmediateProgress()` below) rather than
    // relying on the real ~100ms progress-call-interval throttle, which `open()`'s own
    // initial parse already primes close to "now" (a fast, sub-100ms in-memory scan
    // right after `open()` would otherwise never trip the throttle at all, making
    // "mid-scan" purely a matter of wall-clock luck -- exactly the flakiness this test
    // is meant to avoid).
    const steps = synthesizeEventLogSteps({ eventCount: 20_000 });
    fs.writeFileSync(file, steps.cumulativeText[20_000]);

    const session = new EngineSession();
    call<LogSummary>(session, ElogMethods.open, { path: file });
    forceImmediateProgress(session);

    let mutated = false;
    const mutateOnFirstProgress = (): void => {
      if (mutated) return;
      mutated = true;
      fs.appendFileSync(file, 'E # 999999 t 999999 m 1 ce -1 msg -1\n\n');
    };

    const searchParams = { start: null, search: 'ThisStringNeverAppearsAnywhereInTheSyntheticLog_xyz', forward: true, caseSensitive: false };

    let caughtErr: unknown = null;
    try {
      call<FindTextResult>(session, ElogMethods.findText, searchParams, mutateOnFirstProgress);
      assert.fail('expected findText to throw once the file changed mid-scan');
    } catch (err) {
      caughtErr = err;
    }
    assert.ok(mutated, 'the file was actually mutated mid-scan (via the progress hook)');
    assert.equal((caughtErr as { name: string }).name, 'ContentChangedError');
    const contentChangedErr = caughtErr as { change: string; summary: LogSummary };
    assert.equal(contentChangedErr.change, 'appended');
    assert.equal(contentChangedErr.summary.lastEventNumber, 999_999, 'the ContentChanged error carries a fresh summary reflecting the appended event (#999999, the literal event number appended above)');

    // manual retry of the exact same request: the engine is already synchronized (the
    // error-handling path itself ran the full synchronize flow), so this just succeeds
    const retryResult = call<FindTextResult>(session, ElogMethods.findText, searchParams);
    assert.equal(retryResult.found, false, 'the retried findText completes normally against the now-synchronized state');

    // and the summary reflects the appended event without needing another checkChanges
    const summaryAfter = call<LogSummary>(session, ElogMethods.getSummary, undefined);
    assert.equal(summaryAfter.lastEventNumber, 999_999);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------
// watcher.ts: fs.watch + poll-timer hybrid, in isolation (no engine involved)
// ---------------------------------------------------------------------------------

test('watcher: a poll tick fires onChange without any fs.watch event, given a small pollIntervalMs', async () => {
  const { dir, file } = mkTempFile('watched.elog');
  fs.writeFileSync(file, 'hello\n');
  let changeCount = 0;
  // pollIntervalMs alone is what's under test here (fs.watch may or may not also
  // fire on this platform -- either way onChange must fire at least once within the
  // generous timeout below, purely from the poll timer if nothing else).
  const watcher = watchFile(file, () => {
    changeCount++;
  }, { pollIntervalMs: 20 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(changeCount > 0, `expected at least one onChange call from the poll timer within 500ms, got ${changeCount}`);
  } finally {
    watcher.dispose();
  }
  const countAtDispose = changeCount;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(changeCount, countAtDispose, 'dispose() stops further onChange calls');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('watcher: pollIntervalMs 0 disables the poll timer (fs.watch, if it fires at all, is the only source of onChange)', async () => {
  const { dir, file } = mkTempFile('watched2.elog');
  fs.writeFileSync(file, 'hello\n');
  let changeCount = 0;
  const watcher = watchFile(file, () => {
    changeCount++;
  }, { pollIntervalMs: 0 });
  try {
    // no mutation at all -- with polling disabled and no file change, fs.watch
    // shouldn't fire either
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(changeCount, 0, 'no poll timer and no actual file change means no onChange call');
  } finally {
    watcher.dispose();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
