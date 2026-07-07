/**
 * Phase E6 test suite, part 1: `SequenceChartFacade` (shared/src/eventlog/
 * sequenceChartFacade.ts) -- the four timeline coordinate systems (SIMULATION_TIME,
 * EVENT_NUMBER, STEP, NONLINEAR), coordinate-system relocation/versioning, and the
 * simtime<->timeline-coordinate interpolation. Fixtures: the real
 * `sample/Fifo1-#0.elog`, plus synthesized logs with duplicate simulation times and
 * zero-simtime bursts (`makeDuplicateRunSimTime`).
 */

import { test } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { BigDecimal } from '../../eventlog/bigDecimal';
import { ComponentMethodBeginEntry } from '../../eventlog/entries';
import { EventLog } from '../../eventlog/eventLog';
import { TimelineMode } from '../../eventlog/enums';
import { FilteredEventLog } from '../../eventlog/filteredEventLog';
import type { IEvent, IEventLog } from '../../eventlog/ieventlog';
import { SequenceChartFacade } from '../../eventlog/sequenceChartFacade';
import { fileReaderForContent } from './testEventLogHelper';
import { makeDuplicateRunSimTime, synthesizeEventLog } from './synthesizeEventLog';

function openEventLog(text: string): EventLog {
  return new EventLog(fileReaderForContent(text));
}

const fifoPath = resolve(__dirname, '..', 'fixtures', 'elog', 'sample', 'Fifo1-#0.elog');

/** Builds a facade in `mode`, relocated to the eventlog's first event (the coordinate-system origin for every test below). */
function makeFacade(eventLog: IEventLog, mode: TimelineMode): { facade: SequenceChartFacade; origin: IEvent } {
  const facade = new SequenceChartFacade(eventLog);
  facade.setTimelineMode(mode);
  const origin = eventLog.getFirstEvent();
  if (origin === null) throw new Error('test fixture must not be empty');
  facade.relocateTimelineCoordinateSystem(origin);
  return { facade, origin };
}

function forEachEventForward(eventLog: IEventLog, fn: (event: IEvent) => void): void {
  let event = eventLog.getFirstEvent();
  while (event !== null) {
    fn(event);
    event = event.getNextEvent();
  }
}

function bigDecimalCloseTo(a: BigDecimal, b: BigDecimal, eps: number): boolean {
  return Math.abs(a.subtract(b).doubleValue()) <= eps;
}

// ---------------------------------------------------------------------------------
// 1. SIMULATION_TIME: coord(event) == simtime(event) - simtime(origin), exactly.
// ---------------------------------------------------------------------------------

test('SequenceChartFacade: SIMULATION_TIME mode -- coord(event) == simtime(event) - simtime(origin)', () => {
  const { text } = synthesizeEventLog({ eventCount: 60, simTimeForEvent: makeDuplicateRunSimTime([5, 1, 8, 1, 1, 20]) });
  const eventLog = openEventLog(text);
  const { facade, origin } = makeFacade(eventLog, TimelineMode.SIMULATION_TIME);

  forEachEventForward(eventLog, (event) => {
    const expected = event.getSimulationTime().subtract(origin.getSimulationTime()).doubleValue();
    assert.equal(facade.getTimelineCoordinateBegin(event), expected);
    assert.equal(facade.getTimelineCoordinateEnd(event), expected); // delta is 0: separateEventLogEntries defaults false
  });
});

// ---------------------------------------------------------------------------------
// 2. EVENT_NUMBER: coord == eventNumber - originEventNumber, exactly.
// ---------------------------------------------------------------------------------

test('SequenceChartFacade: EVENT_NUMBER mode -- coord(event) == eventNumber - originEventNumber', () => {
  const { text } = synthesizeEventLog({ eventCount: 60 });
  const eventLog = openEventLog(text);
  const { facade, origin } = makeFacade(eventLog, TimelineMode.EVENT_NUMBER);

  forEachEventForward(eventLog, (event) => {
    assert.equal(facade.getTimelineCoordinateBegin(event), event.getEventNumber() - origin.getEventNumber());
  });
});

// ---------------------------------------------------------------------------------
// 3. STEP: consecutive distinct events differ by exactly the step (1); strict ordering.
// ---------------------------------------------------------------------------------

test('SequenceChartFacade: STEP mode -- consecutive events differ by exactly 1, strictly increasing', () => {
  const { text } = synthesizeEventLog({ eventCount: 60, simTimeForEvent: makeDuplicateRunSimTime([10, 10, 10, 30]) });
  const eventLog = openEventLog(text);
  const { facade } = makeFacade(eventLog, TimelineMode.STEP);

  let previous: number | null = null;
  forEachEventForward(eventLog, (event) => {
    const coord = facade.getTimelineCoordinateBegin(event);
    if (previous !== null) {
      assert.equal(coord - previous, 1);
      assert.ok(coord > previous, 'STEP coordinates must strictly increase');
    }
    previous = coord;
  });
});

// ---------------------------------------------------------------------------------
// 4. NONLINEAR: strictly monotonic; delta >= minimum delta whenever simtime advances
//    (including zero-simtime bursts, where delta == the minimum exactly); finite.
// ---------------------------------------------------------------------------------

test('SequenceChartFacade: NONLINEAR mode -- strictly monotonic, delta >= minimumDelta, all coordinates finite', () => {
  const { text } = synthesizeEventLog({ eventCount: 80, simTimeForEvent: makeDuplicateRunSimTime([1, 6, 1, 1, 1, 15, 1, 1, 1, 1, 1, 40]) });
  const eventLog = openEventLog(text);
  const { facade } = makeFacade(eventLog, TimelineMode.NONLINEAR);
  const minDelta = facade.getNonLinearMinimumTimelineCoordinateDelta();

  let previousEvent: IEvent | null = null;
  let previousCoord = 0;
  forEachEventForward(eventLog, (event) => {
    const coord = facade.getTimelineCoordinateBegin(event);
    assert.ok(Number.isFinite(coord), 'timeline coordinate must be finite');
    if (previousEvent !== null) {
      const delta = coord - previousCoord;
      assert.ok(delta > 0, 'NONLINEAR coordinates must strictly increase');
      assert.ok(delta >= minDelta - 1e-9, `delta (${delta}) must be >= minimumDelta (${minDelta})`);
      if (event.getSimulationTime().equals(previousEvent.getSimulationTime())) {
        // zero-simtime burst: delta collapses to exactly the minimum (atan(0) == 0)
        assert.ok(Math.abs(delta - minDelta) < 1e-9, 'zero-simtime-advance delta must equal the minimum exactly');
      }
    }
    previousEvent = event;
    previousCoord = coord;
  });
});

// ---------------------------------------------------------------------------------
// 5. relocate(): coord(e) == 0 right after relocating to e; version bumps; a
//    previously-cached coordinate for another event becomes unreadable (-1) via the
//    "cached, don't recompute" peek accessor once the version has moved past it.
// ---------------------------------------------------------------------------------

test('SequenceChartFacade: relocateTimelineCoordinateSystem() resets the origin to 0 and invalidates older cached coordinates', () => {
  const { text } = synthesizeEventLog({ eventCount: 40 });
  const eventLog = openEventLog(text);
  const { facade } = makeFacade(eventLog, TimelineMode.NONLINEAR);

  const tenth = eventLog.getEventForEventNumber(10)!;
  const coordBefore = facade.getTimelineCoordinateBegin(tenth); // computed + cached under the current version
  assert.ok(Number.isFinite(coordBefore));
  assert.notEqual(facade.getCachedTimelineCoordinateBegin(tenth), -1);

  const twentieth = eventLog.getEventForEventNumber(20)!;
  const originEventNumberBefore = facade.getTimelineCoordinateSystemOriginEventNumber();
  facade.relocateTimelineCoordinateSystem(twentieth);

  assert.notEqual(facade.getTimelineCoordinateSystemOriginEventNumber(), originEventNumberBefore);
  assert.equal(facade.getTimelineCoordinateSystemOriginEventNumber(), twentieth.getEventNumber());
  assert.equal(facade.getTimelineCoordinateBegin(twentieth), 0);
  assert.equal(facade.getTimelineCoordinateEnd(twentieth), 0);

  // the cached value for "tenth" predates the new coordinate-system version
  assert.equal(facade.getCachedTimelineCoordinateBegin(tenth), -1);
});

// ---------------------------------------------------------------------------------
// 6. Interpolation: round trips through getTimelineCoordinateForSimulationTime() /
//    getSimulationTimeForTimelineCoordinate(), at event points (exact) and swept
//    between-event values (approximate, tolerance defined below).
// ---------------------------------------------------------------------------------

const APPROX_TOLERANCE = 1e-6;

for (const mode of [TimelineMode.SIMULATION_TIME, TimelineMode.EVENT_NUMBER, TimelineMode.STEP, TimelineMode.NONLINEAR]) {
  test(`SequenceChartFacade: ${mode} mode -- getSimulationTimeForTimelineCoordinate(getTimelineCoordinateForSimulationTime(t)) is exact at every event's own simulation time`, () => {
    const { text } = synthesizeEventLog({ eventCount: 50 }); // strictly increasing integer simtimes -- no duplicates
    const eventLog = openEventLog(text);
    const { facade } = makeFacade(eventLog, mode);

    forEachEventForward(eventLog, (event) => {
      const t = event.getSimulationTime();
      const coord = facade.getTimelineCoordinateForSimulationTime(t);
      const roundTripped = facade.getSimulationTimeForTimelineCoordinate(coord);
      assert.ok(roundTripped.equals(t), `event #${event.getEventNumber()}: expected ${t.toString()}, got ${roundTripped.toString()}`);
    });
  });

  test(`SequenceChartFacade: ${mode} mode -- getTimelineCoordinateForSimulationTime(getSimulationTimeForTimelineCoordinate(coord)) is exact at every event's own coordinate`, () => {
    const { text } = synthesizeEventLog({ eventCount: 50 });
    const eventLog = openEventLog(text);
    const { facade } = makeFacade(eventLog, mode);

    forEachEventForward(eventLog, (event) => {
      const coord = facade.getTimelineCoordinateBegin(event);
      const simTime = facade.getSimulationTimeForTimelineCoordinate(coord);
      const roundTripped = facade.getTimelineCoordinateForSimulationTime(simTime);
      assert.ok(Math.abs(roundTripped - coord) <= APPROX_TOLERANCE, `event #${event.getEventNumber()}: expected ${coord}, got ${roundTripped}`);
    });
  });

  test(`SequenceChartFacade: ${mode} mode -- interpolation round trip is approximately stable for between-event simulation times`, () => {
    const { text } = synthesizeEventLog({ eventCount: 50 });
    const eventLog = openEventLog(text);
    const { facade } = makeFacade(eventLog, mode);

    for (let i = 0; i < 49; i++) {
      const t = BigDecimal.parse(`${i}.5`); // strictly between event #i and #i+1's simulation times
      const coord = facade.getTimelineCoordinateForSimulationTime(t);
      const roundTripped = facade.getSimulationTimeForTimelineCoordinate(coord);
      assert.ok(bigDecimalCloseTo(roundTripped, t, APPROX_TOLERANCE), `t=${t.toString()}: got ${roundTripped.toString()}`);
    }
  });
}

// ---------------------------------------------------------------------------------
// 7. Works identically over a FilteredEventLog: the filtered subset's own ordering
//    (skipping excluded events) satisfies the same STEP/EVENT_NUMBER/SIMULATION_TIME
//    invariants as an unfiltered log.
// ---------------------------------------------------------------------------------

test('SequenceChartFacade: SIMULATION_TIME/EVENT_NUMBER/STEP invariants hold identically over a FilteredEventLog', () => {
  const { text } = synthesizeEventLog({ eventCount: 50, simTimeForEvent: makeDuplicateRunSimTime([5, 5, 10, 1, 1, 28]) });
  const eventLog = openEventLog(text);
  const filteredLog = new FilteredEventLog(eventLog);
  filteredLog.setExcludedEventNumbers([5, 6, 7, 20, 21, 40, 41, 42]);
  assert.ok(!filteredLog.isEmpty());

  for (const mode of [TimelineMode.SIMULATION_TIME, TimelineMode.EVENT_NUMBER, TimelineMode.STEP]) {
    const { facade, origin } = makeFacade(filteredLog, mode);

    let previousCoord: number | null = null;
    let count = 0;
    let event: IEvent | null = origin;
    while (event !== null) {
      const coord = facade.getTimelineCoordinateBegin(event);
      if (mode === TimelineMode.SIMULATION_TIME) assert.equal(coord, event.getSimulationTime().subtract(origin.getSimulationTime()).doubleValue());
      if (mode === TimelineMode.EVENT_NUMBER) assert.equal(coord, event.getEventNumber() - origin.getEventNumber());
      if (mode === TimelineMode.STEP && previousCoord !== null) assert.equal(coord - previousCoord, 1);
      previousCoord = coord;
      event = event.getNextEvent();
      count++;
    }
    assert.ok(count > 10, 'filtered fixture should retain enough events to be a meaningful check');
    assert.ok(count < 50, 'the exclusion set must actually have removed events from the walk');
  }
});

// ---------------------------------------------------------------------------------
// 8. Light smoke coverage for the viewport-supporting methods ported alongside the
//    coordinate system (getComponentMethodBeginEntries / getIntersectingMessageDependencies),
//    using the real Fifo1 sample (has "CMB"/message-send activity).
// ---------------------------------------------------------------------------------

test('SequenceChartFacade: getComponentMethodBeginEntries()/getIntersectingMessageDependencies() smoke test (Fifo1 sample)', () => {
  const text = fs.readFileSync(fifoPath, 'latin1');
  const eventLog = openEventLog(text);
  const facade = new SequenceChartFacade(eventLog);
  const first = eventLog.getFirstEvent()!;
  const last = eventLog.getLastEvent()!;

  const componentMethodBeginEntries = facade.getComponentMethodBeginEntries(first, last);
  assert.ok(componentMethodBeginEntries.length > 0, 'Fifo1 sample has "CMB" activity in event #0');
  for (const entry of componentMethodBeginEntries) assert.ok(entry instanceof ComponentMethodBeginEntry);

  const dependencies = facade.getIntersectingMessageDependencies(first, last);
  assert.ok(dependencies.length > 0, 'Fifo1 sample has message sends');

  // getMessageDependencyCountAdjacencyMatrix (used by U8's minimize-crossings axis
  // ordering): just checking it returns a well-formed, non-negative matrix here, not
  // exact counts.
  const moduleIdToAxisIndexMap = new Map<number, number>([
    [1, 0],
    [2, 1],
    [3, 2],
    [4, 3],
  ]);
  const matrix = facade.getMessageDependencyCountAdjacencyMatrix(moduleIdToAxisIndexMap, first, last);
  assert.equal(matrix.length, 16);
  for (const value of matrix) assert.ok(value >= 0);
});
