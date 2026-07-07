import { test } from 'bun:test';
import assert from 'node:assert';
import { computeZeroSimTimeRegions } from '../eventlog/chart/zeroSimTimeRegions';

test('computeZeroSimTimeRegions: no events -> no regions', () => {
  assert.deepEqual(computeZeroSimTimeRegions([]), []);
});

test('computeZeroSimTimeRegions: all distinct simulation times, no zero-width entries -> no regions', () => {
  const events = [
    { tcBegin: 0, tcEnd: 0, simulationTime: '0' },
    { tcBegin: 10, tcEnd: 10, simulationTime: '1' },
    { tcBegin: 20, tcEnd: 20, simulationTime: '2' },
  ];
  assert.deepEqual(computeZeroSimTimeRegions(events), []);
});

test('computeZeroSimTimeRegions: a burst of 3 consecutive events sharing one simulation time merges into ONE band spanning their full tc extent', () => {
  const events = [
    { tcBegin: 0, tcEnd: 0, simulationTime: '5' },
    { tcBegin: 2, tcEnd: 2, simulationTime: '5' },
    { tcBegin: 4, tcEnd: 4, simulationTime: '5' },
  ];
  const regions = computeZeroSimTimeRegions(events);
  assert.strictEqual(regions.length, 1);
  assert.strictEqual(regions[0].tcBegin, 0);
  assert.strictEqual(regions[0].tcEnd, 4);
});

test('computeZeroSimTimeRegions: an event whose own tcBegin !== tcEnd contributes its own span as a region', () => {
  const events = [
    { tcBegin: 0, tcEnd: 0, simulationTime: '0' },
    { tcBegin: 10, tcEnd: 15, simulationTime: '1' }, // separateEventLogEntries-style spread within one event
    { tcBegin: 30, tcEnd: 30, simulationTime: '2' },
  ];
  const regions = computeZeroSimTimeRegions(events);
  assert.strictEqual(regions.length, 1);
  assert.deepEqual(regions[0], { tcBegin: 10, tcEnd: 15 });
});

test('computeZeroSimTimeRegions: two separate same-simtime bursts far apart produce two distinct bands, not merged', () => {
  const events = [
    { tcBegin: 0, tcEnd: 0, simulationTime: '5' },
    { tcBegin: 2, tcEnd: 2, simulationTime: '5' },
    { tcBegin: 100, tcEnd: 100, simulationTime: '9' },
    { tcBegin: 102, tcEnd: 102, simulationTime: '9' },
  ];
  const regions = computeZeroSimTimeRegions(events);
  assert.strictEqual(regions.length, 2);
  assert.deepEqual(regions[0], { tcBegin: 0, tcEnd: 2 });
  assert.deepEqual(regions[1], { tcBegin: 100, tcEnd: 102 });
});

test('computeZeroSimTimeRegions: events out of tc order in the input array are still handled correctly (sorted internally)', () => {
  const events = [
    { tcBegin: 4, tcEnd: 4, simulationTime: '5' },
    { tcBegin: 0, tcEnd: 0, simulationTime: '5' },
    { tcBegin: 2, tcEnd: 2, simulationTime: '5' },
  ];
  const regions = computeZeroSimTimeRegions(events);
  assert.strictEqual(regions.length, 1);
  assert.deepEqual(regions[0], { tcBegin: 0, tcEnd: 4 });
});
