import { test } from 'bun:test';
import assert from 'node:assert';
import { buildFilterDescription } from '../eventlog/chart/filterDescription';
import { DEFAULT_FILTER_PANEL_STATE, type FilterPanelState } from '../eventlog/chart/filterPanelState';

function state(partial: Partial<FilterPanelState>): FilterPanelState {
  return { ...DEFAULT_FILTER_PANEL_STATE, ...partial, enabled: { ...DEFAULT_FILTER_PANEL_STATE.enabled, ...partial.enabled } };
}

test('buildFilterDescription: no section enabled -> "Filter for all events"', () => {
  assert.equal(buildFilterDescription(DEFAULT_FILTER_PANEL_STATE), 'Filter for all events');
});

test('buildFilterDescription: event number range, both bounds', () => {
  const s = state({ enabled: { rangeEventNumbers: true }, firstConsideredEventNumber: 10, lastConsideredEventNumber: 20 });
  assert.equal(buildFilterDescription(s), 'Filter for events where 10 <= event number <= 20');
});

test('buildFilterDescription: event number range, lower bound only', () => {
  const s = state({ enabled: { rangeEventNumbers: true }, firstConsideredEventNumber: 10, lastConsideredEventNumber: null });
  assert.equal(buildFilterDescription(s), 'Filter for events where event number >= 10');
});

test('buildFilterDescription: event number range, upper bound only', () => {
  const s = state({ enabled: { rangeEventNumbers: true }, firstConsideredEventNumber: null, lastConsideredEventNumber: 20 });
  assert.equal(buildFilterDescription(s), 'Filter for events where event number <= 20');
});

test('buildFilterDescription: simulation time range, both bounds', () => {
  const s = state({ enabled: { rangeSimulationTime: true }, lowerSimulationTimeLimit: '1.5', upperSimulationTimeLimit: '3' });
  assert.equal(buildFilterDescription(s), 'Filter for events where 1.5 <= simulation time of event <= 3');
});

test('buildFilterDescription: simulation time range, lower bound only', () => {
  const s = state({ enabled: { rangeSimulationTime: true }, lowerSimulationTimeLimit: '1.5', upperSimulationTimeLimit: '' });
  assert.equal(buildFilterDescription(s), 'Filter for events where simulation time of event >= 1.5');
});

test('buildFilterDescription: simulation time range, upper bound only', () => {
  const s = state({ enabled: { rangeSimulationTime: true }, lowerSimulationTimeLimit: '', upperSimulationTimeLimit: '3' });
  assert.equal(buildFilterDescription(s), 'Filter for events where simulation time of event <= 3');
});

test('buildFilterDescription: event number range and simulation time range both enabled -> ONE combined OR-group (Java: single "Range filter" tree node)', () => {
  const s = state({
    enabled: { rangeEventNumbers: true, rangeSimulationTime: true },
    firstConsideredEventNumber: 10,
    lastConsideredEventNumber: 20,
    lowerSimulationTimeLimit: '1',
    upperSimulationTimeLimit: '2',
  });
  assert.equal(buildFilterDescription(s), 'Filter for events where (10 <= event number <= 20) OR (1 <= simulation time of event <= 2)');
});

test('buildFilterDescription: trace delta limits are NOT included in the text (matches Java\'s own toString(), which comments them out)', () => {
  const s = state({
    enabled: { trace: true },
    tracedEventNumber: 100,
    traceCauses: true,
    traceConsequences: true,
    causeEventNumberDelta: 5,
    consequenceEventNumberDelta: 5,
    causeSimulationTimeDelta: '1',
    consequenceSimulationTimeDelta: '1',
  });
  assert.equal(buildFilterDescription(s), 'Filter for events where it is the cause or consequence of the event with event number 100');
});

test('buildFilterDescription: excluded event numbers, single value -> "prefix = v"', () => {
  const s = state({ enabled: { excludedEventNumbers: true }, excludedEventNumbers: [42] });
  assert.equal(buildFilterDescription(s), 'Filter for events where NOT event number = 42');
});

test('buildFilterDescription: excluded event numbers, 2-3 values -> "is in (...)"', () => {
  const s = state({ enabled: { excludedEventNumbers: true }, excludedEventNumbers: [1, 2, 3] });
  assert.equal(buildFilterDescription(s), 'Filter for events where NOT event number is in (1, 2, 3)');
});

test('buildFilterDescription: excluded event numbers, 4+ values -> first three + ellipsis', () => {
  const s = state({ enabled: { excludedEventNumbers: true }, excludedEventNumbers: [1, 2, 3, 4, 5] });
  assert.equal(buildFilterDescription(s), 'Filter for events where NOT event number is in (1, 2, 3, ...)');
});

test('buildFilterDescription: excluded event numbers section enabled but empty list -> Java artifact "NOT " with nothing after', () => {
  const s = state({ enabled: { excludedEventNumbers: true }, excludedEventNumbers: [] });
  assert.equal(buildFilterDescription(s), 'Filter for events where NOT ');
});

test('buildFilterDescription: module filter by expression', () => {
  const s = state({ enabled: { moduleExpression: true }, moduleExpression: 'className(Fifo)' });
  assert.equal(buildFilterDescription(s), 'Filter for events where module matches the expression className(Fifo)');
});

test('buildFilterDescription: module filter by NED type, multiple sub-filters combine with OR', () => {
  const s = state({ enabled: { moduleExpression: true, moduleNedType: true }, moduleExpression: 'x', moduleNedTypeNames: ['Fifo', 'Sink'] });
  assert.equal(buildFilterDescription(s), 'Filter for events where (module matches the expression x) OR (module NED type is in (Fifo, Sink))');
});

test('buildFilterDescription: module filter by tree, resolves names via resolveModuleName', () => {
  const s = state({ enabled: { moduleTree: true }, moduleIds: [3, 7] });
  const resolved = buildFilterDescription(s, (id) => (id === 3 ? 'net.fifo' : null));
  assert.equal(resolved, 'Filter for events where module is in (net.fifo, #7)');
});

test('buildFilterDescription: module class name', () => {
  const s = state({ enabled: { moduleClassName: true }, moduleClassNames: ['Fifo'] });
  assert.equal(buildFilterDescription(s), 'Filter for events where module class name = Fifo');
});

test('buildFilterDescription: module filter enabled but nothing populated -> Java artifact of an empty OR-group', () => {
  const s = state({ enabled: { moduleNedType: true }, moduleNedTypeNames: [] });
  assert.equal(buildFilterDescription(s), 'Filter for events where ');
});

test('buildFilterDescription: message filter by class name and by id', () => {
  const s = state({ enabled: { messageClassName: true, messageId: true }, messageClassNames: ['cMessage'], messageIds: [5] });
  assert.equal(buildFilterDescription(s), 'Filter for events where (message C++ class name = cMessage) OR (message ID = 5)');
});

test('buildFilterDescription: message filter by name/tree id/encapsulation id/encapsulation tree id', () => {
  const s = state({
    enabled: { messageName: true, messageTreeId: true, messageEncapsulationId: true, messageEncapsulationTreeId: true },
    messageNames: ['job'],
    messageTreeIds: [1],
    messageEncapsulationIds: [2],
    messageEncapsulationTreeIds: [3],
  });
  assert.equal(
    buildFilterDescription(s),
    'Filter for events where (message name = job) OR (message tree ID = 1) OR (message encapsulation ID = 2) OR (message encapsulation tree ID = 3)',
  );
});

test('buildFilterDescription: trace both causes and consequences', () => {
  const s = state({ enabled: { trace: true }, tracedEventNumber: 100, traceCauses: true, traceConsequences: true });
  assert.equal(buildFilterDescription(s), 'Filter for events where it is the cause or consequence of the event with event number 100');
});

test('buildFilterDescription: trace causes only', () => {
  const s = state({ enabled: { trace: true }, tracedEventNumber: 100, traceCauses: true, traceConsequences: false });
  assert.equal(buildFilterDescription(s), 'Filter for events where it is the cause of the event with event number 100');
});

test('buildFilterDescription: collection limits never appear in the text', () => {
  const s = state({ enabled: { collectionLimits: true }, maximumDepth: 3, maximumNumber: 2, maximumCollectionTimeMs: 50 });
  assert.equal(buildFilterDescription(s), 'Filter for all events');
});

test('buildFilterDescription: several sections combine with AND', () => {
  const s = state({
    enabled: { rangeEventNumbers: true, trace: true },
    firstConsideredEventNumber: 0,
    lastConsideredEventNumber: 100,
    tracedEventNumber: 50,
    traceCauses: true,
    traceConsequences: true,
  });
  assert.equal(
    buildFilterDescription(s),
    'Filter for events where (0 <= event number <= 100) AND (it is the cause or consequence of the event with event number 50)',
  );
});
