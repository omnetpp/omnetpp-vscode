// Validates the real, bundled eventlog worker process (dist/eventlogWorker.js,
// phase E8) end-to-end over its actual JSON-RPC transport: spawns it, opens a real
// .elog fixture, and drives every elog/* method (chart viewport, table rows, goto,
// find, filter-free navigation), plus a genuine mid-scan cancellation.
//
// Unlike scripts/mcp-smoke.mjs (MCP stdio = newline-delimited JSON), the eventlog
// worker speaks plain vscode-jsonrpc framing (Content-Length headers) -- this
// script uses the real `vscode-jsonrpc/node` package (already a project
// dependency, see package.json) instead of hand-rolling that framing, per the E8
// port plan.
//
// Usage: bun scripts/elog-worker-smoke.mjs   (after `bun run dev:build`)
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, CancellationTokenSource } from 'vscode-jsonrpc/node';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = join(root, 'dist', 'eventlogWorker.js');
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

/** Streams a large, plain (no I/S chunks) synthetic .elog to disk -- same shape as shared/src/test/eventlog/memoryBounding.test.ts's stress fixture -- so a findText miss forces a genuinely long full-file scan (needed to measure cancellation latency meaningfully). Ends with an "SE" (simulation-end) trailer, like a completed run -- NOT suitable as the starting point for the live-follow tests below (see writeLiveEventLog's doc comment). */
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

/**
 * Like writeSyntheticEventLog(), but deliberately omits the "SE" trailer -- a real,
 * still-running simulation never writes "SE" until it actually finishes, so a log
 * that's still being appended to (this smoke test's live-follow section) must not
 * have one either: appending more events after an "SE" line doesn't happen in
 * practice and isn't a scenario the engine needs to support (see eventLog.ts's
 * `synchronize()` header on the peek-guard this depends on -- it recognizes "the
 * next line is a fresh event" as the signal that the previous last event was
 * already complete, which only holds when nothing else was ever written after it).
 */
function writeLiveEventLog(file, eventCount) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, 'SB ov 1536 ev 2 rid Smoke-0\n\n');
    for (let i = 0; i < eventCount; i++) {
      fs.writeSync(fd, `E # ${i} t ${i} m 1 ce -1 msg -1\n`);
      if (i === 0) fs.writeSync(fd, 'MC id 1 c C t T n root cm 1\n');
      fs.writeSync(fd, '\n');
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function main() {
  if (!fs.existsSync(workerPath)) throw new Error(`${workerPath} not found -- run 'bun run dev:build' first`);
  if (!fs.existsSync(fixturePath)) throw new Error(`fixture not found: ${fixturePath}`);

  const child = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
  const progressEvents = [];
  connection.onNotification('elog/progress', (p) => progressEvents.push(p));
  const changedEvents = [];
  connection.onNotification('elog/changed', (p) => changedEvents.push(p));
  connection.listen();

  try {
    // ---- open / getSummary / getModuleTree ------------------------------------------
    const summary = await connection.sendRequest('elog/open', { path: fixturePath });
    assert(summary.isEmpty === false, 'open: file is not empty');
    assert(summary.lastEventNumber > summary.firstEventNumber, 'open: has more than one event');
    assert(typeof summary.firstSimulationTime === 'string', 'open: firstSimulationTime is a decimal string');

    const summary2 = await connection.sendRequest('elog/getSummary', undefined);
    assert(summary2.lastEventNumber === summary.lastEventNumber, 'getSummary: matches open()');

    const moduleTree = await connection.sendRequest('elog/getModuleTree', undefined);
    assert(moduleTree !== null && typeof moduleTree.moduleId === 'number', 'getModuleTree: returns a root module');
    assert(moduleTree.children.length > 0, 'getModuleTree: root has children');

    // ---- sc/setTimelineMode + sc/getViewport ------------------------------------------
    const scState = await connection.sendRequest('elog/sc/setTimelineMode', { timelineMode: 'EVENT_NUMBER' });
    assert(scState.timelineMode === 'EVENT_NUMBER', 'sc/setTimelineMode: applied');

    await connection.sendRequest('elog/sc/relocateOrigin', { eventNumber: summary.firstEventNumber });

    const viewport = await connection.sendRequest('elog/sc/getViewport', {
      range: { kind: 'event', startEventNumber: summary.firstEventNumber, endEventNumber: summary.lastEventNumber },
    });
    assert(viewport.events.length > 0, 'sc/getViewport: events non-empty');
    assert(viewport.dependencies.length > 0, 'sc/getViewport: dependencies non-empty');
    assert(viewport.truncated === false, 'sc/getViewport: not truncated for a small fixture');
    let monotonic = true;
    for (let i = 1; i < viewport.events.length; i++) {
      if (viewport.events[i].tcBegin < viewport.events[i - 1].tcBegin) monotonic = false;
    }
    assert(monotonic, 'sc/getViewport: event tcBegin is monotonically non-decreasing (EVENT_NUMBER mode)');
    assert(
      viewport.events.every((e) => e.tcEnd >= e.tcBegin),
      'sc/getViewport: every event has tcEnd >= tcBegin',
    );

    // ---- table/getRows -----------------------------------------------------------------
    const rows = await connection.sendRequest('elog/table/getRows', { anchor: { kind: 'first' }, before: 0, after: 10 });
    assert(rows.rows.length > 0, 'table/getRows: returns rows');
    assert(rows.anchorIndex === 0, 'table/getRows: anchor is the first row when anchored at "first"');
    const row0 = rows.rows[0];
    assert(typeof row0.entryClassCode === 'string' && row0.entryClassCode.length > 0, 'table/getRows: row has an entry class code');
    assert(typeof row0.entryClassName === 'string', 'table/getRows: row has an entry class name');
    assert(typeof row0.simulationTime === 'string', 'table/getRows: row simulationTime is a decimal string');
    assert(row0.fields !== null && typeof row0.fields === 'object', 'table/getRows: row has a fields record');
    assert(typeof row0.ref.eventNumber === 'number' && typeof row0.ref.entryIndex === 'number', 'table/getRows: row has a (eventNumber, entryIndex) ref');

    // ---- findText hit + miss ------------------------------------------------------------
    const hit = await connection.sendRequest('elog/findText', { start: null, search: 'Fifo', forward: true, caseSensitive: false });
    assert(hit.found === true && hit.ref !== null, 'findText: finds a known substring');

    const miss = await connection.sendRequest('elog/findText', { start: null, search: 'ThisStringDoesNotAppearAnywhere_xyz', forward: true, caseSensitive: false });
    assert(miss.found === false && miss.ref === null, 'findText: reports a miss for an absent string');

    // ---- gotoEvent / gotoSimTime ---------------------------------------------------------
    const gotoEvt = await connection.sendRequest('elog/gotoEvent', { eventNumber: summary.firstEventNumber });
    assert(gotoEvt.found === true && gotoEvt.eventNumber === summary.firstEventNumber, 'gotoEvent: finds the first event');

    // matchKind: 'FIRST_OR_PREVIOUS' -- this fixture has several events sharing the same
    // simulation time (t=0), and MatchKind.EXACT (the elog/gotoSimTime default,
    // mirroring the engine's own IEventLog default) is documented to throw for an
    // ambiguous exact match; callers that expect duplicates pick a tolerant MatchKind,
    // exactly like the raw engine API already requires (see eventLogIndex.test.ts).
    const gotoTime = await connection.sendRequest('elog/gotoSimTime', { simulationTime: summary.firstSimulationTime, matchKind: 'FIRST_OR_PREVIOUS' });
    assert(gotoTime.found === true, 'gotoSimTime: finds an event at the first simulation time');

    // ---- long findText, cancelled promptly ------------------------------------------------
    const bigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnetpp-elog-worker-smoke-'));
    const bigFile = path.join(bigDir, 'big.elog');
    try {
      writeSyntheticEventLog(bigFile, 400_000);
      await connection.sendRequest('elog/open', { path: bigFile });

      const tokenSource = new CancellationTokenSource();
      const start = performance.now();
      const longRequest = connection.sendRequest('elog/findText', { start: null, search: 'ThisNeverMatchesAnythingInTheSyntheticLog', forward: true, caseSensitive: false }, tokenSource.token);
      // give it a moment to actually start scanning, then cancel well before a
      // full 400k-event scan could possibly finish on its own
      await new Promise((r) => setTimeout(r, 50));
      tokenSource.cancel();

      let cancelledInTime = false;
      let elapsedMs = -1;
      try {
        await longRequest;
      } catch (err) {
        elapsedMs = performance.now() - start;
        cancelledInTime = elapsedMs < 500 && /cancel/i.test(err.message ?? '');
        if (!cancelledInTime) console.error(`  (cancellation error: code=${err.code} message=${err.message} elapsedMs=${elapsedMs.toFixed(1)})`);
      }
      assert(cancelledInTime, `findText: a long-running scan is cancelled promptly (elapsed ${elapsedMs.toFixed(1)}ms, budget 500ms)`);
    } finally {
      fs.rmSync(bigDir, { recursive: true, force: true });
    }

    // ---- live follow: append -> elog/changed notification -> viewport extends ------------
    // (phase E9). Uses a small `pollIntervalMs` so the real fs.watch/poll-timer hybrid in
    // client/worker/src/watcher.ts notices the change quickly without this script ever
    // calling the manual `elog/checkChanges` request itself -- i.e. this exercises the
    // *automatic* detection path end-to-end against the real bundled process, which
    // bun:test's liveFollow.test.ts (in-process, no watcher/process involved) can't cover.
    const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnetpp-elog-worker-smoke-live-'));
    const liveFile = path.join(liveDir, 'live.elog');
    try {
      writeLiveEventLog(liveFile, 20);
      const liveSummary = await connection.sendRequest('elog/open', { path: liveFile, options: { pollIntervalMs: 200 } });
      assert(liveSummary.lastEventNumber === 19, 'live-follow: initial file has 20 events (#0..#19)');

      changedEvents.length = 0;
      // append 5 more well-formed events directly onto the file, same shape as
      // writeSyntheticEventLog's per-event body
      const fd = fs.openSync(liveFile, 'a');
      for (let i = 20; i < 25; i++) fs.writeSync(fd, `E # ${i} t ${i} m 1 ce -1 msg -1\n\n`);
      fs.closeSync(fd);

      // generous wait for the poll timer (200ms) or fs.watch (near-instant) to notice,
      // and for the resulting elog/changed notification to arrive over the wire
      await new Promise((r) => setTimeout(r, 2000));

      const appendedNotif = changedEvents.find((e) => e.change === 'appended');
      assert(appendedNotif !== undefined, 'live-follow: an "appended" elog/changed notification arrived without any manual checkChanges call');
      assert(appendedNotif?.summary.lastEventNumber === 24, 'live-follow: the notification carries a fresh summary reflecting the 5 appended events');

      const summaryAfterAppend = await connection.sendRequest('elog/getSummary', undefined);
      assert(summaryAfterAppend.lastEventNumber === 24, 'live-follow: getSummary reflects the appended events post-synchronize');

      const extendedViewport = await connection.sendRequest('elog/sc/getViewport', {
        range: { kind: 'event', startEventNumber: 0, endEventNumber: 24 },
      });
      assert(
        extendedViewport.events.some((e) => e.eventNumber === 24),
        'live-follow: sc/getViewport sees the newly appended event #24',
      );

      // ---- overwrite -> reset (phase E9) ---------------------------------------------
      changedEvents.length = 0;
      writeSyntheticEventLog(liveFile, 8); // shorter + different content -> OVERWRITTEN, not APPENDED (unconditional size decrease)

      await new Promise((r) => setTimeout(r, 2000));

      const overwrittenNotif = changedEvents.find((e) => e.change === 'overwritten');
      assert(overwrittenNotif !== undefined, 'live-follow: an "overwritten" elog/changed notification arrived automatically');
      assert(overwrittenNotif?.summary.lastEventNumber === 7, 'live-follow: the notification reflects the new (shorter) 8-event file');

      const summaryAfterOverwrite = await connection.sendRequest('elog/getSummary', undefined);
      assert(summaryAfterOverwrite.lastEventNumber === 7, 'live-follow: getSummary reflects the overwrite');
      assert(summaryAfterOverwrite.isEmpty === false, 'live-follow: the new (shorter) log is still non-empty');
    } finally {
      fs.rmSync(liveDir, { recursive: true, force: true });
    }

    // ---- close ---------------------------------------------------------------------------
    await connection.sendRequest('elog/close', undefined);
    console.log('close: OK');
  } finally {
    connection.dispose();
    child.kill();
  }

  if (failures > 0) {
    console.error(`\nelog-worker-smoke FAILED (${failures} failure(s))`);
    process.exit(1);
  }
  console.log('\nelog-worker-smoke PASSED');
}

main().catch((err) => {
  console.error('elog-worker-smoke FAILED:', err);
  process.exit(1);
});
