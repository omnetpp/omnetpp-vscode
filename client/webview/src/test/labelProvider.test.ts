import { test } from 'bun:test';
import assert from 'node:assert';
import type { ElogModule, EventDetail, RenderDependency, RenderMethodCall } from '@omnetpp/shared/elog-protocol';
import {
  buildAxisTooltip,
  buildDependencyLabel,
  buildDependencyTooltip,
  buildEventTooltip,
  buildMethodCallTooltip,
  buildTimestampTooltip,
  findNeighborEvents,
  formatEventLabel,
  formatSimulationTime,
  subtractDecimalStrings,
} from '../eventlog/chart/labelProvider';

const tree: ElogModule = {
  moduleId: 0,
  fullName: 'Net',
  nedTypeName: 'Network',
  moduleClassName: 'cModule',
  compound: true,
  children: [
    { moduleId: 3, fullName: 'Net.host[0].app', nedTypeName: 'App', moduleClassName: 'cModule', compound: false, children: [] },
    { moduleId: 4, fullName: 'Net.host[0].queue', nedTypeName: 'Queue', moduleClassName: 'cModule', compound: false, children: [] },
  ],
};
const ctx = { moduleTree: tree };

// ---------------------------------------------------------------------------------
// formatSimulationTime / subtractDecimalStrings -- decimal-string ports of
// TimeUtils.secondsToTimeString (see this file's header on labelProvider.ts)
// ---------------------------------------------------------------------------------

test('formatSimulationTime: whole seconds', () => {
  assert.equal(formatSimulationTime('5'), '5s');
});

test('formatSimulationTime: sub-second value skips the "0s" prefix, per Java (intPart 0 is not emitted)', () => {
  assert.equal(formatSimulationTime('0.5'), '500ms');
});

test('formatSimulationTime: mixed seconds + milliseconds', () => {
  assert.equal(formatSimulationTime('1.5'), '1s 500ms');
});

test('formatSimulationTime: zero', () => {
  assert.equal(formatSimulationTime('0'), '0s');
});

test('formatSimulationTime: nanosecond-scale value', () => {
  assert.equal(formatSimulationTime('0.000000001'), '1ns');
});

test('formatSimulationTime: negative value gets a leading "-"', () => {
  assert.equal(formatSimulationTime('-0.5'), '-500ms');
});

test('subtractDecimalStrings: exact decimal subtraction beyond double precision', () => {
  assert.equal(subtractDecimalStrings('1.000000001', '1'), '0.000000001');
});

test('subtractDecimalStrings: negative result', () => {
  assert.equal(subtractDecimalStrings('1', '1.5'), '-0.5');
});

// ---------------------------------------------------------------------------------
// buildEventTooltip
// ---------------------------------------------------------------------------------

test('buildEventTooltip: header line with module/type/time', () => {
  const html = buildEventTooltip({ eventNumber: 42, simulationTime: '1.5', moduleId: 3 }, ctx);
  assert.ok(html.includes('Event</b> #<b>42</b>'));
  assert.ok(html.includes('1s 500ms'));
  assert.ok(html.includes('(App) <b>Net.host[0].app</b> (id = 3)'));
});

test('buildEventTooltip: unknown module falls back to "Module #<id>" / "?"', () => {
  const html = buildEventTooltip({ eventNumber: 1, simulationTime: '0', moduleId: 999 }, ctx);
  assert.ok(html.includes('(?) <b>Module #999</b>'));
});

test('buildEventTooltip: includes the causing message clause when a causeDependency is supplied', () => {
  const dep: RenderDependency = {
    kind: 'send',
    causeEventNumber: 1,
    causeModuleId: 3,
    causeTc: 0,
    causeSimulationTime: '0',
    consequenceEventNumber: 2,
    consequenceModuleId: 4,
    consequenceTc: 1,
    consequenceSimulationTime: '0.001',
    messageName: 'tcpSeg',
    messageClassName: 'TCPSegment',
  };
  const html = buildEventTooltip({ eventNumber: 2, simulationTime: '0.001', moduleId: 4 }, ctx, { causeDependency: dep });
  assert.ok(html.includes('message (TCPSegment) <b>tcpSeg</b>'));
});

test('buildEventTooltip: appends up to 100 message-line entries, then a truncation notice', () => {
  const entries: EventDetail['entries'] = [];
  for (let i = 0; i < 150; i++) {
    entries.push({ ref: { eventNumber: 1, entryIndex: i }, entryClassCode: '-', entryClassName: 'EventLogMessageEntry', level: 0, contextModuleId: 3, simulationTime: '0', eventNumber: 1, fields: {}, text: `line ${i}` });
  }
  const detail: EventDetail = { eventNumber: 1, simulationTime: '0', moduleId: 3, causeEventNumber: -1, messageId: -1, entries };
  const html = buildEventTooltip({ eventNumber: 1, simulationTime: '0', moduleId: 3 }, ctx, { detail });
  assert.ok(html.includes('line 0'));
  assert.ok(html.includes('line 99'));
  assert.ok(!html.includes('line 100'), 'stops before the 101st line');
  assert.ok(html.includes('Content stripped after 100 lines'));
});

test('buildEventTooltip: entries with null text (non-message-log entries) are skipped, not counted', () => {
  const detail: EventDetail = {
    eventNumber: 1,
    simulationTime: '0',
    moduleId: 3,
    causeEventNumber: -1,
    messageId: -1,
    entries: [{ ref: { eventNumber: 1, entryIndex: 0 }, entryClassCode: 'E', entryClassName: 'EventEntry', level: 0, contextModuleId: 3, simulationTime: '0', eventNumber: 1, fields: {}, text: null }],
  };
  const html = buildEventTooltip({ eventNumber: 1, simulationTime: '0', moduleId: 3 }, ctx, { detail });
  assert.ok(!html.includes('<span'));
});

// ---------------------------------------------------------------------------------
// buildDependencyTooltip / buildDependencyLabel
// ---------------------------------------------------------------------------------

function makeDep(over: Partial<RenderDependency> = {}): RenderDependency {
  return {
    kind: 'send',
    causeEventNumber: 1,
    causeModuleId: 3,
    causeTc: 0,
    causeSimulationTime: '0',
    consequenceEventNumber: 2,
    consequenceModuleId: 4,
    consequenceTc: 1,
    consequenceSimulationTime: '0.001',
    messageName: 'msgA',
    messageClassName: 'Packet',
    ...over,
  };
}

test('buildDependencyTooltip: "send" kind renders "Sending" + event range + dt', () => {
  const html = buildDependencyTooltip(makeDep());
  assert.ok(html.includes('Sending'));
  assert.ok(html.includes('(Packet) <b>msgA</b>'));
  assert.ok(html.includes('(#1 -&gt; #2)'));
  assert.ok(html.includes('dt = 1ms'));
});

test('buildDependencyTooltip: "reuse" kind renders "Reusing"', () => {
  const html = buildDependencyTooltip(makeDep({ kind: 'reuse' }));
  assert.ok(html.includes('Reusing'));
});

test('buildDependencyTooltip: "filtered" kind renders the generic derived-dependency line (documented protocol fidelity gap)', () => {
  const html = buildDependencyTooltip(makeDep({ kind: 'filtered' }));
  assert.ok(html.includes('Derived'));
  assert.ok(html.includes('message dependency'));
});

test('buildDependencyTooltip: omits dt when either side\'s simulation time is null (outside the fetched window)', () => {
  const html = buildDependencyTooltip(makeDep({ consequenceSimulationTime: null }));
  assert.ok(!html.includes('dt ='));
});

test('buildDependencyLabel: just the message name, no class/kind/id', () => {
  assert.equal(buildDependencyLabel(makeDep()), 'msgA');
});

// ---------------------------------------------------------------------------------
// buildMethodCallTooltip / buildAxisTooltip
// ---------------------------------------------------------------------------------

test('buildMethodCallTooltip: from/to module clauses', () => {
  const call: RenderMethodCall = { eventNumber: 9, tc: 5, sourceModuleId: 3, targetModuleId: 4, methodName: 'handleMessage' };
  const html = buildMethodCallTooltip(call, ctx);
  assert.ok(html.includes('Calling handleMessage'));
  assert.ok(html.includes('from module (App) <b>Net.host[0].app</b>'));
  assert.ok(html.includes('to module (Queue) <b>Net.host[0].queue</b>'));
});

test('buildAxisTooltip: module type + full path + id', () => {
  assert.equal(buildAxisTooltip(3, ctx), '<b>Axis</b> (App) <b>Net.host[0].app</b> (id = 3)');
});

// ---------------------------------------------------------------------------------
// buildTimestampTooltip / formatEventLabel / findNeighborEvents
// ---------------------------------------------------------------------------------

test('buildTimestampTooltip: with both neighbors', () => {
  const html = buildTimestampTooltip(1.5, 4, 5);
  assert.ok(html.includes('just after event #4'));
  assert.ok(html.includes('just before event #5'));
});

test('buildTimestampTooltip: unknown simTime renders "?"', () => {
  assert.ok(buildTimestampTooltip(null, null, null).includes('t = <b>?</b>'));
});

test('formatEventLabel: "#<n>"', () => {
  assert.equal(formatEventLabel(42), '#42');
});

test('findNeighborEvents: nearest before/after, excluding an exact match at tc', () => {
  const events = [
    { eventNumber: 1, tcBegin: 0 },
    { eventNumber: 2, tcBegin: 10 },
    { eventNumber: 3, tcBegin: 20 },
  ];
  assert.deepEqual(findNeighborEvents(15, events), { before: 2, after: 3 });
  assert.deepEqual(findNeighborEvents(10, events), { before: 1, after: 3 }, 'an exact match at tc is excluded from both sides');
});

test('findNeighborEvents: empty events yields no neighbors', () => {
  assert.deepEqual(findNeighborEvents(5, []), { before: null, after: null });
});
