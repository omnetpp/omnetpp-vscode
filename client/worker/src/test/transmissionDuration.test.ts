/**
 * Regression test for the viewport transmission-duration decoration
 * (`EngineSession.fillTransmissionDuration()`): on logs whose sends carry a real
 * transmission delay (PureAloha's radio frames -- unlike the Fifo/Tictoc fixtures,
 * which never exercise this path), the send dependencies must come back decorated
 * and, above all, the viewport fetch must not throw.
 *
 * History: `fillTransmissionDuration()` called `endSendEntry.getIsDeliveredImmediately()`
 * -- a Java-style getter that does not exist on the generated entry classes (entries.ts
 * exposes plain fields) -- behind an `as unknown as` duck-type cast the compiler could
 * not see through. Every `elog/sc/getViewport` on such logs crashed with
 * "getIsDeliveredImmediately is not a function", leaving the sequence chart permanently
 * blank while all Fifo/Tictoc-based tests stayed green.
 */

import { test } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { EngineSession } from '../engineSession';
import { handleElogRequest } from '../handlers';
import { ElogMethods } from '@omnetpp/shared/elog-protocol';
import type { LogSummary, ViewportModel } from '@omnetpp/shared/elog-protocol';

const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const alohaFixturePath = join(repoRoot, 'shared', 'src', 'test', 'fixtures', 'elog', 'sample', 'PureAloha2-#0.elog');

function call<R>(session: EngineSession, method: string, params: unknown): R {
  return handleElogRequest(session, method, params, new Int32Array(new SharedArrayBuffer(4)), () => {}) as R;
}

test('viewport on a transmission-delay log decorates send dependencies and does not throw', () => {
  const session = new EngineSession();
  try {
    const summary = call<LogSummary>(session, ElogMethods.open, { path: alohaFixturePath });
    assert.ok(!summary.isEmpty);
    call(session, ElogMethods.scSetTimelineMode, { timelineMode: 'SIMULATION_TIME' });
    call(session, ElogMethods.scRelocateOrigin, { eventNumber: summary.firstEventNumber });
    const viewport = call<ViewportModel>(session, ElogMethods.scGetViewport, {
      range: { kind: 'event', startEventNumber: summary.firstEventNumber, endEventNumber: summary.lastEventNumber },
    });
    assert.ok(viewport.events.length > 0, 'viewport has events');
    assert.ok(viewport.dependencies.length > 0, 'viewport has dependencies');
    const decorated = viewport.dependencies.filter((d) => d.transmissionDurationFraction !== undefined);
    assert.ok(decorated.length > 0, 'at least one send dependency carries a transmission duration');
    for (const dep of decorated) {
      assert.ok(dep.transmissionDurationFraction! >= 0);
      assert.ok(typeof dep.transmissionDurationTc1 === 'number');
      assert.ok(typeof dep.transmissionDurationTc2 === 'number');
      assert.ok(typeof dep.transmissionDurationTc3 === 'number');
      assert.ok(typeof dep.transmissionDurationTc4 === 'number');
      assert.ok(typeof dep.isReceptionStart === 'boolean', 'isReceptionStart populated alongside the fraction');
    }
  } finally {
    session.close();
  }
});

// A log that ends while a transmission is still in progress (e.g. a run stopped by
// sim-time-limit) has transmission end times beyond the last event; mapping those onto the
// timeline threw "searchForOffset: invariant violated" and failed every viewport fetch.
test('viewport does not throw when the log ends during a transmission', () => {
  const lines = fs.readFileSync(alohaFixturePath, 'utf8').split('\n');
  const eventLineIndices = lines.flatMap((line, i) => (line.startsWith('E #') ? [i] : []));
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'elog-truncated-'));
  try {
    for (const cut of eventLineIndices.slice(2)) {
      const file = join(dir, `cut-${cut}.elog`);
      fs.writeFileSync(file, lines.slice(0, cut).join('\n') + '\n');
      const session = new EngineSession();
      try {
        const summary = call<LogSummary>(session, ElogMethods.open, { path: file });
        for (const timelineMode of ['SIMULATION_TIME', 'EVENT_NUMBER']) {
          call(session, ElogMethods.scSetTimelineMode, { timelineMode });
          call(session, ElogMethods.scRelocateOrigin, { eventNumber: summary.firstEventNumber });
          call<ViewportModel>(session, ElogMethods.scGetViewport, {
            range: { kind: 'event', startEventNumber: summary.firstEventNumber, endEventNumber: summary.lastEventNumber },
          });
        }
      } finally {
        session.close();
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
