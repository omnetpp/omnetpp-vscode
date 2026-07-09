import { test } from 'bun:test';
import assert from 'node:assert';
import { TimelineMode, type RenderDependency, type RenderMethodCall, type TimelineEvent } from '@omnetpp/shared/elog-protocol';
import type { EventLogPalette } from '../eventlog/common/theme';
import { AUTO_AXIS_SPACING, AXIS_VECTOR_STRIP_HEIGHT, deriveAxes, layoutAxes } from '../eventlog/chart/axes';
import { DEFAULT_DISPLAY_FLAGS } from '../eventlog/chart/displayFlags';
import { BOOKMARK_MARK_COLOR, bookmarkDependencyKey, buildDrawList, MAX_EVENT_MARKS_PER_COLUMN, SELECTION_MARK_COLOR } from '../eventlog/chart/drawList';
import { GUTTER_LEFT_WIDTH, GUTTER_TOP_HEIGHT, createViewportState, resize } from '../eventlog/chart/viewportState';

const theme: EventLogPalette = {
  foreground: '#ccc',
  background: '#1e1e1e',
  descriptionForeground: '#9d9d9d',
  selectionBackground: '#04395e',
  border: '#454545',
  isDark: true,
  isHighContrast: false,
  eventColor: '#e06666',
  arrowColor: '#6ea8fe',
  methodCallColor: '#f0a35e',
  focusBorder: '#007fd4',
  regionBandColor: '#2a2a2a',
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

test('an event with a nonzero timeline width (tcEnd > tcBegin) becomes a "pill" mark (xEnd > x), a zero-width one stays a dot (xEnd == x)', () => {
  // STEP/NONLINEAR + separateEventLogEntries makes the engine hand back tcEnd > tcBegin;
  // buildDrawList must carry that span through as xEnd so canvasStack draws a stadium
  // (two half-discs + a connecting rect) instead of a plain circle -- Java `drawEvent()`.
  const widthEvents: TimelineEvent[] = [event_(1, 1, 0, { tcEnd: 4 }), event_(2, 2, 10)];
  const primitives = draw(baseViewport(), widthEvents, []);
  const marks = primitives.filter((p): p is Extract<typeof p, { kind: 'eventMark' }> => p.kind === 'eventMark');
  const pill = marks.find((m) => m.eventNumber === 1)!;
  const dot = marks.find((m) => m.eventNumber === 2)!;
  assert.ok(pill.xEnd > pill.x, `pill event should span (x=${pill.x}, xEnd=${pill.xEnd})`);
  // tcBegin=0, tcEnd=4 at 10 px/tc -> 40 px of width between the cap centers
  assert.strictEqual(pill.xEnd - pill.x, 40);
  assert.strictEqual(dot.xEnd, dot.x, 'zero-width event stays a dot (xEnd == x)');
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

test('a dependency whose BOTH endpoints are known but far apart (> 3x content width) is also drawn as a SPLIT arrow, not one long line (Eclipse getMaximumMessageDependencyDisplayWidth)', () => {
  const viewport = baseViewport(); // pixelsPerTc=10, contentWidth=690 -> split threshold at 207 tc units apart
  const axesLayout = deriveAxes(new Set([1, 2]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);

  const near = [dep_({ causeEventNumber: 1, consequenceEventNumber: 2, causeModuleId: 1, causeTc: 0, consequenceModuleId: 2, consequenceTc: 10 })];
  const nearPrims = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: [], dependencies: near, methodCalls: [], axesLayout, ticks: [], theme, displayFlags: BASE_TEST_FLAGS });
  const nearArrows = nearPrims.filter((p) => p.kind === 'arrow') as { dash?: number[] }[];
  assert.strictEqual(nearArrows.length, 1, 'a short arrow stays a single undashed segment');
  assert.ok(!nearArrows[0].dash);

  // 300 tc units apart (3000px at 10px/tc) vastly exceeds the 207-tc/2070px threshold.
  const far = [dep_({ causeEventNumber: 1, consequenceEventNumber: 2, causeModuleId: 1, causeTc: 0, consequenceModuleId: 2, consequenceTc: 300 })];
  const farPrims = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: [], dependencies: far, methodCalls: [], axesLayout, ticks: [], theme, displayFlags: BASE_TEST_FLAGS });
  const farArrows = farPrims.filter((p) => p.kind === 'arrow') as { dash?: number[] }[];
  assert.strictEqual(farArrows.length, 2, 'a too-long arrow splits into a solid stub + a dashed offscreen continuation, like a genuinely unresolvable endpoint');
  assert.ok(farArrows.some((a) => !a.dash) && farArrows.some((a) => a.dash?.length === 2 && a.dash[0] === 1 && a.dash[1] === 2));
});

test('the split-arrow threshold keeps the endpoint NEARER the viewport real and stubs the farther one, regardless of which side (cause or consequence) that is', () => {
  const viewport = baseViewport(); // leftTc=0, visible content = [0tc, 69tc] at 10px/tc
  const axesLayout = deriveAxes(new Set([1, 2]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);

  // consequence far in the FUTURE (off to the right) -> cause (near the view) stays real.
  const consequenceFar = [dep_({ causeEventNumber: 1, consequenceEventNumber: 2, causeModuleId: 1, causeTc: 5, consequenceModuleId: 2, consequenceTc: 5000 })];
  const cfPrims = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: [], dependencies: consequenceFar, methodCalls: [], axesLayout, ticks: [], theme, displayFlags: BASE_TEST_FLAGS });
  const cfHeads = cfPrims.filter((p) => p.kind === 'arrowHead') as { color: string }[];
  assert.strictEqual(cfHeads.length, 1);
  assert.strictEqual(cfHeads[0].color, '#ffffff', 'consequence stubbed -> the "long/synthetic endpoint" white arrowhead marks it (matches the null-consequenceTc case)');

  // cause far in the PAST (off to the left) -> consequence (near the view) stays real, so the
  // arrowhead is the dependency's own real color, not the synthetic-endpoint marker.
  const causeFar = [dep_({ causeEventNumber: 1, consequenceEventNumber: 2, causeModuleId: 1, causeTc: -5000, consequenceModuleId: 2, consequenceTc: 20 })];
  const cauPrims = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: [], dependencies: causeFar, methodCalls: [], axesLayout, ticks: [], theme, displayFlags: BASE_TEST_FLAGS });
  const cauHeads = cauPrims.filter((p) => p.kind === 'arrowHead') as { color: string }[];
  assert.strictEqual(cauHeads.length, 1);
  assert.notStrictEqual(cauHeads[0].color, '#ffffff', 'cause stubbed -> the real (consequence-side) arrowhead color is used, not the synthetic marker');
});

test('a same-module dependency (both endpoints known, distinct tc) is drawn as a real ellipseArc, not a straight arrow (phase U5)', () => {
  const primitives = draw();
  const ellipses = primitives.filter((p) => p.kind === 'ellipseArc') as { quarter: number }[];
  assert.strictEqual(ellipses.length, 1);
  assert.strictEqual(ellipses[0].quarter, -1, 'both sides in range -> full half-ellipse (quarter=-1)');
});

test('arc dash follows the dependency KIND: a self-message SEND arc is solid, a REUSE arc is dotted', () => {
  const viewport = baseViewport();
  const axesLayout = deriveAxes(new Set([1, 2]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  const params = { timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: [] as TimelineEvent[], methodCalls: [] as RenderMethodCall[], axesLayout, ticks: [], theme };
  // self-message SEND (same module) -> solid arc
  const sendSelf = dep_({ causeEventNumber: 1, consequenceEventNumber: 2, kind: 'send', causeModuleId: 2, causeTc: 10, consequenceModuleId: 2, consequenceTc: 30 });
  const sendArc = buildDrawList({ ...params, dependencies: [sendSelf], displayFlags: { ...DEFAULT_DISPLAY_FLAGS, showSelfMessageSends: true } }).find((p) => p.kind === 'ellipseArc') as { dash?: number[] } | undefined;
  assert.ok(sendArc && !sendArc.dash, 'self-message send arc is solid');
  // self-message REUSE (same module) -> dotted arc
  const reuseSelf = dep_({ causeEventNumber: 1, consequenceEventNumber: 2, kind: 'reuse', causeModuleId: 2, causeTc: 10, consequenceModuleId: 2, consequenceTc: 30 });
  const reuseArc = buildDrawList({ ...params, dependencies: [reuseSelf], displayFlags: { ...DEFAULT_DISPLAY_FLAGS, showSelfMessageReuses: true } }).find((p) => p.kind === 'ellipseArc') as { dash?: number[] } | undefined;
  assert.ok(reuseArc && reuseArc.dash && reuseArc.dash.length > 0, 'reuse arc is dotted');
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

test('only the TOP (ruler) gutter gets an opaque background; the LEFT label strip is transparent (no left fill)', () => {
  const v = baseViewport(800, 600);
  const primitives = draw(v, [], []);
  const gutters = primitives.filter((p) => p.kind === 'gutter') as { part: string; w: number; h: number }[];
  const top = gutters.find((g) => g.part === 'top')!;
  assert.strictEqual(top.w, v.canvasWidth);
  assert.strictEqual(top.h, GUTTER_TOP_HEIGHT);
  assert.strictEqual(gutters.find((g) => g.part === 'left'), undefined, 'left gutter is transparent -- no fill emitted');
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
// selection / hover emphasis -- phase U11 (arrows + axes selectable, hover highlight)
// ---------------------------------------------------------------------------------

test('selectedDependencyKeys: a selected dependency is redrawn as a thicker arrow in the selection color', () => {
  // deps4[0] is a send #1 -> #2 -> dependencyKey 'send:1:2'.
  const primitives = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport: baseViewport(), events: events3, dependencies: deps4, methodCalls: [], axesLayout: deriveAxes(new Set([1, 2, 3]), null, 600 - GUTTER_TOP_HEIGHT), ticks: [], theme, displayFlags: BASE_TEST_FLAGS, selectedDependencyKeys: new Set(['send:1:2']) });
  const emphasized = primitives.filter((p): p is Extract<typeof p, { kind: 'arrow' }> => p.kind === 'arrow' && p.color === SELECTION_MARK_COLOR && (p.width ?? 1) > 1);
  assert.ok(emphasized.length >= 1, 'the selected send dependency should produce a thicker selection-colored arrow');
});

test('selectedAxisModuleIds: a selected axis gets an axisSelectionMark spanning the full canvas width (under the left module hierarchy band)', () => {
  const primitives = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport: baseViewport(), events: events3, dependencies: [], methodCalls: [], axesLayout: deriveAxes(new Set([1, 2, 3]), null, 600 - GUTTER_TOP_HEIGHT), ticks: [], theme, selectedAxisModuleIds: new Set([2]) });
  const marks = primitives.filter((p) => p.kind === 'axisSelectionMark');
  assert.strictEqual(marks.length, 1);
});

test('hovered event stays its own color but is drawn BIGGER; hovered axis label goes bold (same color)', () => {
  const primitives = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport: baseViewport(), events: events3, dependencies: [], methodCalls: [], axesLayout: deriveAxes(new Set([1, 2, 3]), null, 600 - GUTTER_TOP_HEIGHT), ticks: [], theme, hovered: { events: new Set([1]), axisModuleIds: new Set([3]) } });
  // event #1 is a normal event -> its base color is theme.eventColor; the hover emphasis mark keeps that color but is bigger, and is NOT the red selection color.
  const bigger = primitives.filter((p): p is Extract<typeof p, { kind: 'eventMark' }> => p.kind === 'eventMark' && p.eventNumber === 1 && p.radius > 3);
  assert.ok(bigger.length >= 1, 'hovered event should get a bigger mark');
  assert.ok(!bigger.some((p) => p.color === SELECTION_MARK_COLOR), 'hovered (unselected) event must keep its own color, not turn red');
  const boldLabel = primitives.filter((p) => p.kind === 'axisLabel' && p.bold) as { color: string }[];
  assert.strictEqual(boldLabel.length, 1, 'hovered axis label should be bold');
  assert.notStrictEqual(boldLabel[0].color, SELECTION_MARK_COLOR, 'hovered axis label stays its own color');
});

test('selected event/axis turn RED; selected timeline coordinate draws a vertical timelineMark', () => {
  const primitives = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport: baseViewport(), events: events3, dependencies: [], methodCalls: [], axesLayout: deriveAxes(new Set([1, 2, 3]), null, 600 - GUTTER_TOP_HEIGHT), ticks: [], theme, selectedEventNumbers: new Set([1]), selectedAxisModuleIds: new Set([2]), selectedTimelineCoords: [{ tc: 25, simulationTime: '2.5' }] });
  assert.ok(primitives.some((p) => p.kind === 'eventMark' && p.eventNumber === 1 && p.color === SELECTION_MARK_COLOR), 'selected event mark should be recolored red');
  assert.ok(primitives.some((p) => p.kind === 'axisLabel' && p.color === SELECTION_MARK_COLOR), 'selected axis label should be red');
  assert.strictEqual(primitives.filter((p) => p.kind === 'timelineMark').length, 1, 'selected timeline coordinate draws one vertical mark');
});

test('time differences: selected events + timeline coords produce a dashed polyline with delta labels', () => {
  const primitives = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport: baseViewport(), events: events3, dependencies: [], methodCalls: [], axesLayout: deriveAxes(new Set([1, 2, 3]), null, 600 - GUTTER_TOP_HEIGHT), ticks: [], theme, displayFlags: { ...DEFAULT_DISPLAY_FLAGS, showTimeDifferences: true }, selectedEventNumbers: new Set([1, 2]), selectedTimelineCoords: [{ tc: 45, simulationTime: '4.5' }] });
  // 3 points (2 events + 1 coord) -> 2 connecting dashed segments + 2 delta labels.
  const dashed = primitives.filter((p) => p.kind === 'arrow' && p.dash && p.dash[0] === 3 && p.dash[1] === 2);
  assert.strictEqual(dashed.length, 2, 'two dashed time-difference segments through the three selected points');
  assert.strictEqual(primitives.filter((p) => p.kind === 'timeDifferenceLabel').length, 2);
});

test('hovering a self-message arc widens its ellipseArc (so hover is visible on arcs, not just straight arrows)', () => {
  // deps4[3] is a self-dependency on module 2 (#5 -> #6) -> dependencyKey 'send:5:6'.
  const base = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport: baseViewport(), events: events3, dependencies: deps4, methodCalls: [], axesLayout: deriveAxes(new Set([1, 2, 3]), null, 600 - GUTTER_TOP_HEIGHT), ticks: [], theme, displayFlags: BASE_TEST_FLAGS });
  assert.ok(base.some((p) => p.kind === 'ellipseArc'), 'the self-dependency draws an ellipseArc');
  const hovered = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport: baseViewport(), events: events3, dependencies: deps4, methodCalls: [], axesLayout: deriveAxes(new Set([1, 2, 3]), null, 600 - GUTTER_TOP_HEIGHT), ticks: [], theme, displayFlags: BASE_TEST_FLAGS, hovered: { dependencyKeys: new Set(['send:5:6']) } });
  const wide = hovered.filter((p): p is Extract<typeof p, { kind: 'ellipseArc' }> => p.kind === 'ellipseArc' && (p.width ?? 1) > 1);
  assert.ok(wide.length >= 1, 'the hovered self-arc should be redrawn wider');
});

test('initialization event (#0) draws a pill on its OWN (compound) axis, only when shown', () => {
  // #0 lives on the network/system compound (module 1); its outgoing dependency (#0 -> #1)
  // is therefore a cross-module arrow (mod 1 -> mod 2), not a source self-message.
  const initEvent = event_(0, 1, 0, { tcEnd: 5 }); // #0 on module 1, nonzero width
  const viewport = baseViewport();
  const axesLayout = deriveAxes(new Set([1, 2, 3]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  // hidden by default
  const hidden = buildDrawList({ timelineMode: TimelineMode.STEP, viewport, events: [initEvent], dependencies: [], methodCalls: [], axesLayout, ticks: [], theme });
  assert.strictEqual(hidden.filter((p) => p.kind === 'eventMark' && p.eventNumber === 0).length, 0, 'hidden unless showInitializationEvent');
  // shown -> one pill on module 1's axis, pill-shaped (xEnd > x)
  const shown = buildDrawList({ timelineMode: TimelineMode.STEP, viewport, events: [initEvent], dependencies: [], methodCalls: [], axesLayout, ticks: [], theme, displayFlags: { ...DEFAULT_DISPLAY_FLAGS, showInitializationEvent: true } });
  const marks = shown.filter((p): p is Extract<typeof p, { kind: 'eventMark' }> => p.kind === 'eventMark' && p.eventNumber === 0);
  assert.strictEqual(marks.length, 1, 'one init mark on its own axis');
  assert.strictEqual(marks[0].moduleId, 1, 'drawn on the init event\'s own (compound) module');
  assert.ok(marks[0].xEnd > marks[0].x, 'pill-shaped (has the event width)');
});

test('no selection/hover params: no emphasis primitives (axisSelectionMark, bold label, thick arrow)', () => {
  const primitives = draw();
  assert.strictEqual(primitives.filter((p) => p.kind === 'axisSelectionMark').length, 0);
  assert.strictEqual(primitives.filter((p) => p.kind === 'axisLabel' && p.bold).length, 0);
  assert.strictEqual(primitives.filter((p) => p.kind === 'arrow' && (p.width ?? 1) > 1).length, 0);
});

// ---------------------------------------------------------------------------------
// bookmarkMark -- phase U6 (Eclipse's bookmark ring/flag decoration port)
// ---------------------------------------------------------------------------------

test('bookmarkedEventNumbers: a bookmarked event gets a bookmarkMark near its event mark', () => {
  const viewport = baseViewport();
  const axesLayout = deriveAxes(new Set([1, 2, 3]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  const primitives = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: events3, dependencies: [], methodCalls: [], axesLayout, ticks: [], theme, bookmarkedEventNumbers: new Set([2]) });
  const marks = primitives.filter((p) => p.kind === 'bookmarkMark') as { x: number; y: number; color: string }[];
  assert.strictEqual(marks.length, 1);
  assert.strictEqual(marks[0].color, BOOKMARK_MARK_COLOR);
});

test('bookmarkedEventNumbers omitted/empty: no bookmarkMark primitives at all', () => {
  const primitives = draw();
  assert.strictEqual(primitives.filter((p) => p.kind === 'bookmarkMark').length, 0);
});

test('bookmarkedModuleIds: a bookmarked axis gets a bookmarkMark at its axis line', () => {
  const viewport = baseViewport();
  const axesLayout = deriveAxes(new Set([1, 2, 3]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  const primitives = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: [], dependencies: [], methodCalls: [], axesLayout, ticks: [], theme, bookmarkedModuleIds: new Set([2]) });
  assert.strictEqual(primitives.filter((p) => p.kind === 'bookmarkMark').length, 1);
});

test('bookmarkedDependencyKeys: a dependency matching bookmarkDependencyKey(causeEventNumber, consequenceEventNumber, messageId) gets a bookmarkMark', () => {
  const viewport = baseViewport();
  const axesLayout = deriveAxes(new Set([1, 2, 3]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  const dep = dep_({ causeEventNumber: 1, consequenceEventNumber: 2, causeModuleId: 1, causeTc: 0, consequenceModuleId: 2, consequenceTc: 10, messageId: 7 });
  const key = bookmarkDependencyKey(1, 2, 7);
  const primitives = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: events3, dependencies: [dep], methodCalls: [], axesLayout, ticks: [], theme, bookmarkedDependencyKeys: new Set([key]) });
  assert.strictEqual(primitives.filter((p) => p.kind === 'bookmarkMark').length, 1);
});

test('bookmarkedDependencyKeys: a non-matching key produces no bookmarkMark', () => {
  const viewport = baseViewport();
  const axesLayout = deriveAxes(new Set([1, 2, 3]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  const dep = dep_({ causeEventNumber: 1, consequenceEventNumber: 2, causeModuleId: 1, causeTc: 0, consequenceModuleId: 2, consequenceTc: 10, messageId: 7 });
  const primitives = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: events3, dependencies: [dep], methodCalls: [], axesLayout, ticks: [], theme, bookmarkedDependencyKeys: new Set([bookmarkDependencyKey(1, 2, 8)]) });
  assert.strictEqual(primitives.filter((p) => p.kind === 'bookmarkMark').length, 0);
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

test('displayFlags.showHairlines=false -> no tick primitives, but tick labels still draw (phase U10 cheap-gap fix)', () => {
  const viewport = baseViewport();
  const axesLayout = deriveAxes(new Set([1, 2, 3]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  const ticks = [{ tc: 10, label: '10s' }];
  const withHairlines = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: [], dependencies: [], methodCalls: [], axesLayout, ticks, theme, displayFlags: { ...DEFAULT_DISPLAY_FLAGS, showHairlines: true } });
  const withoutHairlines = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: [], dependencies: [], methodCalls: [], axesLayout, ticks, theme, displayFlags: { ...DEFAULT_DISPLAY_FLAGS, showHairlines: false } });
  assert.strictEqual(withHairlines.filter((p) => p.kind === 'tick').length, 1);
  assert.strictEqual(withoutHairlines.filter((p) => p.kind === 'tick').length, 0);
  assert.strictEqual(withoutHairlines.filter((p) => p.kind === 'label' && (p as { text: string }).text === '10s').length, 1, 'the ruler label itself is not a hairline and still draws');
});

test('displayFlags.showZeroSimulationTimeRegions=false -> no regionBand primitives', () => {
  const burstEvents: TimelineEvent[] = [event_(10, 1, 0, { simulationTime: '5' }), event_(11, 1, 4, { simulationTime: '5' })];
  const viewport = baseViewport();
  const axesLayout = deriveAxes(new Set([1]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  const primitives = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: burstEvents, dependencies: [], methodCalls: [], axesLayout, ticks: [], theme, displayFlags: { ...DEFAULT_DISPLAY_FLAGS, showZeroSimulationTimeRegions: false } });
  assert.strictEqual(primitives.filter((p) => p.kind === 'regionBand').length, 0);
});

// ---------------------------------------------------------------------------------
// phase U8: moduleAction glyphs + closed-submodule -> ancestor-axis attribution
// ---------------------------------------------------------------------------------

test('U8 axisGlyphs: expand/collapse per the passed visibility info (no "close" glyph -- filtering removes axes instead)', () => {
  const viewport = baseViewport();
  const axesLayout = deriveAxes(new Set([1, 2]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  const axisGlyphs = new Map([
    [1, { expand: true, collapse: false }],
    [2, { expand: false, collapse: true }],
  ]);
  const primitives = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: [], dependencies: [], methodCalls: [], axesLayout, ticks: [], theme, displayFlags: DEFAULT_DISPLAY_FLAGS, axisGlyphs });
  const glyphs = primitives.filter((p) => p.kind === 'moduleAction');
  const forModule = (id: number) => glyphs.filter((g) => g.moduleId === id).map((g) => g.action).sort();
  assert.deepEqual(forModule(1), ['expand']);
  assert.deepEqual(forModule(2), ['collapse']);
  assert.ok(glyphs.every((g) => g.action !== 'close'), 'no close glyphs');
  assert.ok(glyphs.every((g) => g.scope === 'axis'));
  // glyphs live inside the left gutter (right-aligned hotspot slots)
  assert.ok(glyphs.every((g) => g.x >= 0 && g.x + g.size <= GUTTER_LEFT_WIDTH));
});

test('axis vector strip: shown as an OVERLAY on top of the (always-drawn) axis line, only when the flag is on AND a strip exists', () => {
  const viewport = baseViewport();
  const axesLayout = deriveAxes(new Set([1, 2]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  const strips = [
    {
      moduleId: 1,
      segments: [
        { tcBegin: 0, tcEnd: 10, colorIndex: 0, value: 0, valueText: 'EMPTY' },
        { tcBegin: 10, tcEnd: 30, colorIndex: 1, value: 1, valueText: 'BUSY' },
      ],
    },
  ];
  const base = { timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: [] as TimelineEvent[], dependencies: [], methodCalls: [], axesLayout, ticks: [], theme, axisVectorStrips: strips };

  // flag ON: module 1 renders a strip (2 segments) PLUS its axis line still underneath (so
  // the axis stays visible outside the strip's covered range); module 2 (no strip) has just its line.
  const on = buildDrawList({ ...base, displayFlags: { ...DEFAULT_DISPLAY_FLAGS, showAxisVectorData: true } });
  const strip = on.find((p): p is Extract<typeof p, { kind: 'axisVectorStrip' }> => p.kind === 'axisVectorStrip');
  assert.ok(strip && strip.moduleId === 1 && strip.segments.length === 2, 'strip with two segments');
  assert.ok(strip!.segments[0].color !== strip!.segments[1].color, 'distinct values get distinct colors');
  assert.ok(on.some((p) => p.kind === 'axisLine' && p.moduleId === 1), 'the axis line is still drawn UNDER the strip for module 1');
  assert.ok(on.some((p) => p.kind === 'axisLine' && p.moduleId === 2), 'module 2 keeps its line');

  // flag OFF: no strip, module 1 keeps its plain line.
  const off = buildDrawList({ ...base, displayFlags: { ...DEFAULT_DISPLAY_FLAGS, showAxisVectorData: false } });
  assert.ok(!off.some((p) => p.kind === 'axisVectorStrip'));
  assert.ok(off.some((p) => p.kind === 'axisLine' && p.moduleId === 1));
});

test('a vector-strip axis keeps a THIN underlying axisLine (compound/simple thickness), even though its row reserves the taller strip height for layout', () => {
  const viewport = baseViewport();
  // simple (non-compound) module -> axes.ts would normally give lineHeight=1; layoutAxes'
  // stripModuleIds param bumps the RESERVED row height to AXIS_VECTOR_STRIP_HEIGHT (12) --
  // the rendered axisLine primitive must still use the thin 1px thickness, not 12.
  const axesLayout = layoutAxes([1], null, viewport.canvasHeight - GUTTER_TOP_HEIGHT, AUTO_AXIS_SPACING, new Set([1]));
  const strips = [{ moduleId: 1, segments: [{ tcBegin: 0, tcEnd: 10, colorIndex: 0, value: 0, valueText: 'A' }] }];
  const primitives = buildDrawList({
    timelineMode: TimelineMode.SIMULATION_TIME,
    viewport,
    events: [] as TimelineEvent[],
    dependencies: [],
    methodCalls: [],
    axesLayout,
    ticks: [],
    theme,
    axisVectorStrips: strips,
    displayFlags: { ...DEFAULT_DISPLAY_FLAGS, showAxisVectorData: true },
    selectedAxisModuleIds: new Set([1]),
  });
  const line = primitives.find((p): p is Extract<typeof p, { kind: 'axisLine' }> => p.kind === 'axisLine' && p.moduleId === 1)!;
  assert.strictEqual(line.lineHeight, 1, 'the drawn axis line stays 1px thick (simple module), not the 12px strip row height');
  // The selection mark, in contrast, MUST carry the full strip height so its bracket lines
  // (drawn symmetrically around it by canvasStack.ts/svgExport.ts) actually bracket the strip
  // instead of sitting inside it -- this is the "incorrectly offsetted" bug being fixed.
  const mark = primitives.find((p): p is Extract<typeof p, { kind: 'axisSelectionMark' }> => p.kind === 'axisSelectionMark')!;
  assert.strictEqual(mark.lineHeight, AXIS_VECTOR_STRIP_HEIGHT, 'the selection mark height tracks the strip row, not the thin line');
});

test('U8 axisGlyphs: the glyph sits immediately BEFORE (to the left of) the module name', () => {
  const viewport = baseViewport();
  const axesLayout = deriveAxes(new Set([1]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  const primitives = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: [], dependencies: [], methodCalls: [], axesLayout, ticks: [], theme, displayFlags: DEFAULT_DISPLAY_FLAGS, axisGlyphs: new Map([[1, { expand: false, collapse: true }]]) });
  const glyph = primitives.find((p): p is Extract<typeof p, { kind: 'moduleAction' }> => p.kind === 'moduleAction')!;
  const label = primitives.find((p): p is Extract<typeof p, { kind: 'axisLabel' }> => p.kind === 'axisLabel')!;
  assert.ok(glyph.x + glyph.size <= label.x, `glyph (ends at ${glyph.x + glyph.size}) should be left of the label (x=${label.x})`);
});

test('method calls with a nonzero duration draw a bar (parallelogram) + a solid call line and a dashed return line', () => {
  const viewport = baseViewport();
  const axesLayout = deriveAxes(new Set([1, 2, 3]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  const calls: RenderMethodCall[] = [{ eventNumber: 5, tc: 10, tcEnd: 20, sourceModuleId: 1, targetModuleId: 2, methodName: 'initialize()' }];
  const primitives = buildDrawList({ timelineMode: TimelineMode.STEP, viewport, events: [], dependencies: [], methodCalls: calls, axesLayout, ticks: [], theme, displayFlags: BASE_TEST_FLAGS });
  assert.strictEqual(primitives.filter((p) => p.kind === 'parallelogram').length, 1, 'a faint duration bar');
  const methodArrows = primitives.filter((p): p is Extract<typeof p, { kind: 'arrow' }> => p.kind === 'arrow' && p.arrowKind === 'method');
  assert.strictEqual(methodArrows.length, 2, 'a call line and a return line');
  assert.ok(methodArrows.some((a) => !a.dash) && methodArrows.some((a) => a.dash), 'one solid (call), one dashed (return)');
  assert.ok(methodArrows[0].x1 !== methodArrows[1].x1, 'call and return lines are at different x (the calls span a width)');
});

test('method calls are hoverable/selectable: a selected call is emphasized red, a hovered one thicker', () => {
  const viewport = baseViewport();
  const axesLayout = deriveAxes(new Set([1, 2, 3]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  const calls: RenderMethodCall[] = [{ eventNumber: 5, tc: 10, tcEnd: 20, sourceModuleId: 1, targetModuleId: 2, methodName: 'initialize()' }];
  const key = '5:1:2:10'; // methodCallKey(eventNumber:source:target:tc)
  const selected = buildDrawList({ timelineMode: TimelineMode.STEP, viewport, events: [], dependencies: [], methodCalls: calls, axesLayout, ticks: [], theme, displayFlags: BASE_TEST_FLAGS, selectedMethodCallKeys: new Set([key]) });
  assert.ok(selected.some((p) => p.kind === 'arrow' && p.arrowKind === 'method' && p.color === SELECTION_MARK_COLOR), 'selected call redrawn red');
  const hovered = buildDrawList({ timelineMode: TimelineMode.STEP, viewport, events: [], dependencies: [], methodCalls: calls, axesLayout, ticks: [], theme, displayFlags: BASE_TEST_FLAGS, hovered: { methodCallKeys: new Set([key]) } });
  assert.ok(hovered.some((p) => p.kind === 'arrow' && p.arrowKind === 'method' && (p.width ?? 1) > 1 && p.color !== SELECTION_MARK_COLOR), 'hovered call redrawn thicker in its own color');
});

test('a zero-duration method call (tcEnd == tc) is still a single line, no bar', () => {
  const viewport = baseViewport();
  const axesLayout = deriveAxes(new Set([1, 2]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  const calls: RenderMethodCall[] = [{ eventNumber: 5, tc: 10, sourceModuleId: 1, targetModuleId: 2, methodName: 'foo()' }];
  const primitives = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: [], dependencies: [], methodCalls: calls, axesLayout, ticks: [], theme, displayFlags: BASE_TEST_FLAGS });
  assert.strictEqual(primitives.filter((p) => p.kind === 'parallelogram').length, 0);
  assert.strictEqual(primitives.filter((p) => p.kind === 'arrow' && p.arrowKind === 'method').length, 1);
});

test('U8 axisGlyphs omitted: no moduleAction primitives at all (module tree not loaded)', () => {
  const primitives = draw();
  assert.equal(primitives.filter((p) => p.kind === 'moduleAction').length, 0);
});

test('U8 moduleIdToAxisModuleId: events/deps of a closed submodule draw on the ancestor axis', () => {
  const viewport = baseViewport();
  // only module 1 has an axis; module 9 is a (closed) descendant mapped onto it
  const axesLayout = deriveAxes(new Set([1]), null, viewport.canvasHeight - GUTTER_TOP_HEIGHT);
  const mapped = new Map([[9, 1]]);
  const orphanEvents = [event_(1, 9, 10)];
  const withMap = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: orphanEvents, dependencies: [], methodCalls: [], axesLayout, ticks: [], theme, displayFlags: DEFAULT_DISPLAY_FLAGS, moduleIdToAxisModuleId: mapped });
  const mark = withMap.find((p) => p.kind === 'eventMark');
  assert.ok(mark, 'the mapped event draws');
  const axisY = withMap.find((p) => p.kind === 'axisLine' && p.moduleId === 1)!;
  assert.equal((mark as { y: number }).y, (axisY as { y: number }).y, 'drawn at module 1\'s axis row');

  const withoutMap = buildDrawList({ timelineMode: TimelineMode.SIMULATION_TIME, viewport, events: orphanEvents, dependencies: [], methodCalls: [], axesLayout, ticks: [], theme, displayFlags: DEFAULT_DISPLAY_FLAGS });
  assert.equal(withoutMap.filter((p) => p.kind === 'eventMark').length, 0, 'pre-U8 behavior without the map: no axis, no mark');
});
