import { test } from 'bun:test';
import assert from 'node:assert';
import { TimelineMode, type RenderDependency, type RenderMethodCall, type TimelineEvent } from '@omnetpp/shared/elog-protocol';
import type { EventLogPalette } from '../eventlog/common/theme';
import { deriveAxes } from '../eventlog/chart/axes';
import { buildDrawList, MAX_EVENT_MARKS_PER_COLUMN } from '../eventlog/chart/drawList';
import { GUTTER_LEFT_WIDTH, GUTTER_TOP_HEIGHT, createViewportState, resize } from '../eventlog/chart/viewportState';

const theme: EventLogPalette = {
  foreground: '#ccc',
  background: '#1e1e1e',
  descriptionForeground: '#9d9d9d',
  selectionBackground: '#04395e',
  border: '#454545',
  isDark: true,
  eventColor: '#e06666',
  arrowColor: '#6ea8fe',
  methodCallColor: '#f0a35e',
};

function event_(eventNumber: number, moduleId: number, tc: number, opts: Partial<TimelineEvent> = {}): TimelineEvent {
  return { eventNumber, moduleId, simulationTime: String(tc), tcBegin: tc, tcEnd: tc, causeEventNumber: -1, isSelfMessageProcessingEvent: false, ...opts };
}

function dep_(overrides: Partial<RenderDependency> & Pick<RenderDependency, 'causeEventNumber' | 'consequenceEventNumber'>): RenderDependency {
  return {
    kind: 'send',
    causeModuleId: 1,
    causeTc: 0,
    causeSimulationTime: '0',
    consequenceModuleId: 2,
    consequenceTc: 10,
    consequenceSimulationTime: '10',
    messageName: 'msg',
    messageClassName: 'cMessage',
    ...overrides,
  };
}

function baseViewport(width = 800, height = 600) {
  // pixelsPerTc chosen so the fixtures' tc range (0..50) stays fully within the
  // content width at these dimensions -- the default zoom (50 px/tc) would push
  // most of the synthetic events off-screen and make horizontal culling dominate
  // these primitive-count assertions instead of the behavior under test.
  return { ...resize(createViewportState(), width, height), pixelsPerTc: 10 };
}

// A synthetic ViewportModel: 3 axes (module 1,2,3), 6 events, 4 deps (one with a null tc, one self-dep).
const events3: TimelineEvent[] = [
  event_(1, 1, 0),
  event_(2, 2, 10),
  event_(3, 3, 20, { isSelfMessageProcessingEvent: true }),
  event_(4, 1, 30),
  event_(5, 2, 40),
  event_(6, 3, 50),
];
const deps4: RenderDependency[] = [
  dep_({ causeEventNumber: 1, consequenceEventNumber: 2, causeModuleId: 1, causeTc: 0, consequenceModuleId: 2, consequenceTc: 10 }),
  dep_({ causeEventNumber: 2, consequenceEventNumber: 3, kind: 'reuse', causeModuleId: 2, causeTc: 10, consequenceModuleId: 3, consequenceTc: 20 }),
  dep_({ causeEventNumber: 4, consequenceEventNumber: 5, causeModuleId: 1, causeTc: null, consequenceModuleId: 2, consequenceTc: 40, causeSimulationTime: null }), // off-computed-range
  dep_({ causeEventNumber: 5, consequenceEventNumber: 6, causeModuleId: 2, causeTc: 40, consequenceModuleId: 2, consequenceTc: 50 }), // self-dependency (same module both sides)
];

function draw(viewport = baseViewport(), events = events3, dependencies = deps4, methodCalls: RenderMethodCall[] = []) {
  const axesLayout = deriveAxes(new Set([1, 2, 3]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  return buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events, dependencies, methodCalls, axesLayout, ticks: [], theme });
}

test('produces one axisLine + one axisLabel per known axis', () => {
  const primitives = draw();
  assert.strictEqual(primitives.filter((p) => p.kind === 'axisLine').length, 3);
  assert.strictEqual(primitives.filter((p) => p.kind === 'axisLabel').length, 3);
});

test('normal events become eventMark, the self-message event becomes selfEventMark', () => {
  const primitives = draw();
  const marks = primitives.filter((p) => p.kind === 'eventMark');
  const selfMarks = primitives.filter((p) => p.kind === 'selfEventMark');
  assert.strictEqual(marks.length, 5);
  assert.strictEqual(selfMarks.length, 1);
  assert.strictEqual((selfMarks[0] as { eventNumber: number }).eventNumber, 3);
});

test('a dependency with a null tc on either side is skipped entirely (no arrow/arrowHead for it)', () => {
  const primitives = draw();
  // 4 deps total: 1 null-tc (skipped), 1 self-dep (-> hairpin), 2 real cross-module arrows (-> arrow+arrowHead each)
  const arrows = primitives.filter((p) => p.kind === 'arrow');
  const heads = primitives.filter((p) => p.kind === 'arrowHead');
  assert.strictEqual(arrows.length, 2);
  assert.strictEqual(heads.length, 2);
});

test('a same-module dependency is drawn as a hairpin placeholder, not an arrow', () => {
  const primitives = draw();
  const hairpins = primitives.filter((p) => p.kind === 'hairpin');
  assert.strictEqual(hairpins.length, 1);
});

test('a "reuse" dependency gets a dashed/dotted line, distinct from a plain "send"', () => {
  const primitives = draw();
  const arrows = primitives.filter((p) => p.kind === 'arrow') as { arrowKind: string; dash?: number[] }[];
  const send = arrows.find((a) => a.arrowKind === 'send');
  const reuse = arrows.find((a) => a.arrowKind === 'reuse');
  assert.ok(send && !send.dash);
  assert.ok(reuse && reuse.dash && reuse.dash.length > 0);
});

test('method calls produce an arrow + arrowHead + label', () => {
  const primitives = draw(baseViewport(), events3, [], [{ eventNumber: 1, tc: 5, sourceModuleId: 1, targetModuleId: 2, methodName: 'doStuff' }]);
  assert.strictEqual(primitives.filter((p) => p.kind === 'arrow' && (p as { arrowKind: string }).arrowKind === 'method').length, 1);
  assert.strictEqual(primitives.filter((p) => p.kind === 'label' && (p as { text: string }).text === 'doStuff').length, 1);
});

test('VLineBuffer dedupe: 100 events at the same pixel column produce a capped number of marks plus one density-indicator line', () => {
  const denseEvents: TimelineEvent[] = [];
  for (let i = 0; i < 100; i++) denseEvents.push(event_(i, 1, 5)); // all at the exact same tc -> same pixel column
  const primitives = draw(baseViewport(), denseEvents, []);
  const marks = primitives.filter((p) => p.kind === 'eventMark' || p.kind === 'selfEventMark');
  const densityLines = primitives.filter((p) => p.kind === 'eventDensityLine');
  assert.strictEqual(marks.length, MAX_EVENT_MARKS_PER_COLUMN, 'marks capped at the per-column limit');
  assert.strictEqual(densityLines.length, 1, 'exactly one density hairline for the dense column');
});

test('a column with events at (or below) the cap gets individual marks and no density line', () => {
  const fewEvents: TimelineEvent[] = [];
  for (let i = 0; i < 5; i++) fewEvents.push(event_(i, 1, 5));
  const primitives = draw(baseViewport(), fewEvents, []);
  assert.strictEqual(primitives.filter((p) => p.kind === 'eventMark').length, 5);
  assert.strictEqual(primitives.filter((p) => p.kind === 'eventDensityLine').length, 0);
});

test('events/dependencies referencing an axis not in axesLayout are skipped rather than crashing', () => {
  const orphan = [event_(99, 999, 5)];
  const primitives = draw(baseViewport(), orphan, []);
  assert.strictEqual(primitives.filter((p) => p.kind === 'eventMark' || p.kind === 'selfEventMark').length, 0);
});

test('gutter backgrounds are always emitted, sized to the top/left gutter dimensions', () => {
  const v = baseViewport(800, 600);
  const primitives = draw(v, [], []);
  const gutters = primitives.filter((p) => p.kind === 'gutter') as { part: string; w: number; h: number }[];
  const top = gutters.find((g) => g.part === 'top')!;
  const left = gutters.find((g) => g.part === 'left')!;
  assert.strictEqual(top.w, v.canvasWidth);
  assert.strictEqual(top.h, GUTTER_TOP_HEIGHT);
  assert.strictEqual(left.w, GUTTER_LEFT_WIDTH);
  assert.strictEqual(left.h, v.canvasHeight);
});
