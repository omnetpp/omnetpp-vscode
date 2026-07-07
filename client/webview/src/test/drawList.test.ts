import { test } from 'bun:test';
import assert from 'node:assert';
import { TimelineMode, type RenderDependency, type RenderMethodCall, type TimelineEvent } from '@omnetpp/shared/elog-protocol';
import type { EventLogPalette } from '../eventlog/common/theme';
import { deriveAxes } from '../eventlog/chart/axes';
import { DEFAULT_DISPLAY_FLAGS } from '../eventlog/chart/displayFlags';
import { buildDrawList, MAX_EVENT_MARKS_PER_COLUMN, SELECTION_MARK_COLOR } from '../eventlog/chart/drawList';
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
// Event numbers start at 1 (not 0) -- event #0 is Java's own "initialization event"
// sentinel (`isInitializationEvent()`: `event.getEventNumber() == 0`, matched verbatim
// by `drawList.ts`), hidden by default (`showInitializationEvent: false`); these
// fixtures are plain ordinary events, not the initialization event, so they start at 1.
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

// NOTE: Java's own default is `showMessageReuses: false` (message-reuse arrows are
// HIDDEN by default in Eclipse -- verified, `SequenceChart.java:206`) -- this fixture
// deliberately includes a 'reuse' dependency (`deps4[1]`) to exercise reuse-specific
// rendering, so the shared `draw()` helper below explicitly re-enables it (documented
// deviation from calling `buildDrawList()` with bare defaults, done ONLY for this
// legacy fixture's convenience -- the dedicated `displayFlags.*` tests further down
// verify the true default hides it).
const BASE_TEST_FLAGS = { ...DEFAULT_DISPLAY_FLAGS, showMessageReuses: true };

function draw(viewport = baseViewport(), events = events3, dependencies = deps4, methodCalls: RenderMethodCall[] = []) {
  const axesLayout = deriveAxes(new Set([1, 2, 3]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  return buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events, dependencies, methodCalls, axesLayout, ticks: [], theme, displayFlags: BASE_TEST_FLAGS });
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

test('a dependency with a null tc on one side is drawn as a SPLIT arrow (dashed offscreen segment + solid segment), not skipped (phase U5)', () => {
  const primitives = draw();
  // 4 deps total: dep0 (send, both known) -> 1 arrow segment; dep1 (reuse, both known) -> 1 arrow segment;
  // dep2 (causeTc null, cross-module) -> 2 segments (split); dep3 (self, both known, distinct tc) -> ellipseArc, no arrow segments.
  const arrows = primitives.filter((p) => p.kind === 'arrow') as { dash?: number[] }[];
  assert.strictEqual(arrows.length, 4);
  const dashedOffscreen = arrows.filter((a) => a.dash && a.dash.length === 2 && a.dash[0] === 1 && a.dash[1] === 2);
  assert.strictEqual(dashedOffscreen.length, 1, 'exactly one offscreen-continuation segment (the split dep)');
  const heads = primitives.filter((p) => p.kind === 'arrowHead');
  assert.strictEqual(heads.length, 4, 'one arrowhead per non-hairpin dependency (3 cross-module + 1 self-ellipse)');
});

test('a same-module dependency (both endpoints known, distinct tc) is drawn as a real ellipseArc, not a straight arrow (phase U5)', () => {
  const primitives = draw();
  const ellipses = primitives.filter((p) => p.kind === 'ellipseArc') as { quarter: number }[];
  assert.strictEqual(ellipses.length, 1);
  assert.strictEqual(ellipses[0].quarter, -1, 'both sides in range -> full half-ellipse (quarter=-1)');
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
  for (let i = 1; i <= 5; i++) fewEvents.push(event_(i, 1, 5)); // start at 1 -- event #0 is the (hidden-by-default) initialization event
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

// ---------------------------------------------------------------------------------
// selectionMark -- phase U4 (Eclipse's drawSelectionMarks port)
// ---------------------------------------------------------------------------------

test('selectedEventNumbers: a selected event gets an extra selectionMark ring at the same position', () => {
  const viewport = baseViewport();
  const axesLayout = deriveAxes(new Set([1, 2, 3]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  const primitives = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: events3, dependencies: [], methodCalls: [], axesLayout, ticks: [], theme, selectedEventNumbers: new Set([2]) });
  const mark = primitives.find((p) => p.kind === 'eventMark' && p.eventNumber === 2) as { x: number; y: number };
  const selectionMarks = primitives.filter((p) => p.kind === 'selectionMark') as { x: number; y: number; color: string }[];
  assert.strictEqual(selectionMarks.length, 1);
  assert.strictEqual(selectionMarks[0].x, mark.x);
  assert.strictEqual(selectionMarks[0].y, mark.y);
  assert.strictEqual(selectionMarks[0].color, SELECTION_MARK_COLOR);
});

test('selectedEventNumbers omitted/empty: no selectionMark primitives at all', () => {
  const primitives = draw();
  assert.strictEqual(primitives.filter((p) => p.kind === 'selectionMark').length, 0);
});

test('selectedEventNumbers: an event number not present in the viewport is simply not drawn (no crash, no stray mark)', () => {
  const viewport = baseViewport();
  const axesLayout = deriveAxes(new Set([1, 2, 3]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  const primitives = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: events3, dependencies: [], methodCalls: [], axesLayout, ticks: [], theme, selectedEventNumbers: new Set([999]) });
  assert.strictEqual(primitives.filter((p) => p.kind === 'selectionMark').length, 0);
});

// ---------------------------------------------------------------------------------
// displayFlags gating (phase U5) -- each toggle flips expected primitive presence
// ---------------------------------------------------------------------------------

function drawWithFlags(flags: Parameters<typeof buildDrawList>[0]['displayFlags']) {
  const viewport = baseViewport();
  const axesLayout = deriveAxes(new Set([1, 2, 3]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  return buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: events3, dependencies: deps4, methodCalls: [{ eventNumber: 1, tc: 5, sourceModuleId: 1, targetModuleId: 2, methodName: 'doStuff' }], axesLayout, ticks: [], theme, displayFlags: flags });
}

test('displayFlags.showArrowHeads=false -> no arrowHead primitives at all', () => {
  const primitives = drawWithFlags({ ...DEFAULT_DISPLAY_FLAGS, showArrowHeads: false });
  assert.strictEqual(primitives.filter((p) => p.kind === 'arrowHead').length, 0);
});

test('displayFlags.showEventNumbers=false -> no "#n" event-number labels', () => {
  const withNumbers = drawWithFlags({ ...DEFAULT_DISPLAY_FLAGS, showEventNumbers: true });
  const withoutNumbers = drawWithFlags({ ...DEFAULT_DISPLAY_FLAGS, showEventNumbers: false });
  assert.ok((withNumbers.filter((p) => p.kind === 'label' && (p as { text: string }).text.startsWith('#')).length) > 0);
  assert.strictEqual(withoutNumbers.filter((p) => p.kind === 'label' && (p as { text: string }).text.startsWith('#')).length, 0);
});

test('displayFlags.showMessageSends=false -> the plain "send" dependency disappears (reuse/self untouched)', () => {
  const primitives = drawWithFlags({ ...DEFAULT_DISPLAY_FLAGS, showMessageSends: false, showMessageReuses: true });
  const sendArrows = primitives.filter((p) => p.kind === 'arrow' && (p as { arrowKind: string }).arrowKind === 'send');
  assert.strictEqual(sendArrows.length, 0);
  const reuseArrows = primitives.filter((p) => p.kind === 'arrow' && (p as { arrowKind: string }).arrowKind === 'reuse');
  assert.ok(reuseArrows.length > 0, 'reuse dependency unaffected by showMessageSends');
});

test('displayFlags.showComponentMethodCalls=false -> method-call arrow/label disappear', () => {
  const primitives = drawWithFlags({ ...DEFAULT_DISPLAY_FLAGS, showComponentMethodCalls: false });
  assert.strictEqual(primitives.filter((p) => p.kind === 'arrow' && (p as { arrowKind: string }).arrowKind === 'method').length, 0);
});

test('displayFlags.showAxes=false -> no axisLine/axisLabel primitives (empty-axes toggle change: axis count effectively drops to 0 drawn axes)', () => {
  const primitives = drawWithFlags({ ...DEFAULT_DISPLAY_FLAGS, showAxes: false });
  assert.strictEqual(primitives.filter((p) => p.kind === 'axisLine').length, 0);
  assert.strictEqual(primitives.filter((p) => p.kind === 'axisLabel').length, 0);
});

test('displayFlags.showMessageNames=false -> no message-name labels near dependencies', () => {
  const withNames = drawWithFlags({ ...DEFAULT_DISPLAY_FLAGS, showMessageNames: true });
  const withoutNames = drawWithFlags({ ...DEFAULT_DISPLAY_FLAGS, showMessageNames: false });
  assert.ok(withNames.filter((p) => p.kind === 'label' && (p as { text: string }).text === 'msg').length > 0);
  assert.strictEqual(withoutNames.filter((p) => p.kind === 'label' && (p as { text: string }).text === 'msg').length, 0);
});

test('skipLabelsForPerf=true suppresses message-name/event-number/method-name labels but keeps arrows/marks', () => {
  const viewport = baseViewport();
  const axesLayout = deriveAxes(new Set([1, 2, 3]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  const primitives = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: events3, dependencies: deps4, methodCalls: [], axesLayout, ticks: [], theme, skipLabelsForPerf: true });
  assert.strictEqual(primitives.filter((p) => p.kind === 'label' && (p as { text: string }).text === 'msg').length, 0);
  assert.ok(primitives.some((p) => p.kind === 'arrow'), 'arrows still drawn under perf degrade');
  assert.ok(primitives.some((p) => p.kind === 'eventMark'), 'event marks still drawn under perf degrade');
});

// ---------------------------------------------------------------------------------
// zero-simulation-time regions (phase U5)
// ---------------------------------------------------------------------------------

test('a burst of events sharing the same simulation time produces a regionBand spanning their tc extent', () => {
  const burstEvents: TimelineEvent[] = [event_(10, 1, 0, { simulationTime: '5' }), event_(11, 1, 2, { simulationTime: '5' }), event_(12, 1, 4, { simulationTime: '5' })];
  const viewport = baseViewport();
  const axesLayout = deriveAxes(new Set([1]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  const primitives = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: burstEvents, dependencies: [], methodCalls: [], axesLayout, ticks: [], theme });
  const bands = primitives.filter((p) => p.kind === 'regionBand') as { x: number; w: number }[];
  assert.strictEqual(bands.length, 1, 'the three same-simtime events merge into a single band');
});

test('displayFlags.showZeroSimulationTimeRegions=false -> no regionBand primitives', () => {
  const burstEvents: TimelineEvent[] = [event_(10, 1, 0, { simulationTime: '5' }), event_(11, 1, 4, { simulationTime: '5' })];
  const viewport = baseViewport();
  const axesLayout = deriveAxes(new Set([1]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  const primitives = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: burstEvents, dependencies: [], methodCalls: [], axesLayout, ticks: [], theme, displayFlags: { ...DEFAULT_DISPLAY_FLAGS, showZeroSimulationTimeRegions: false } });
  assert.strictEqual(primitives.filter((p) => p.kind === 'regionBand').length, 0);
});
