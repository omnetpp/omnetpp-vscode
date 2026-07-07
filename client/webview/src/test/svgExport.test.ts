import { test } from 'bun:test';
import assert from 'node:assert';
import { TimelineMode, type TimelineEvent } from '@omnetpp/shared/elog-protocol';
import { deriveAxes } from '../eventlog/chart/axes';
import { DEFAULT_DISPLAY_FLAGS } from '../eventlog/chart/displayFlags';
import { buildDrawList, type DrawPrimitive } from '../eventlog/chart/drawList';
import {
  buildChartSvg,
  computeExportWidthPx,
  EXPORT_WIDTH_CAP_PX,
  exceedsExportWidthCap,
  isExportRangeAvailable,
  resolveExportRange,
  type ExportRangeContext,
} from '../eventlog/chart/svgExport';
import { GUTTER_LEFT_WIDTH, GUTTER_TOP_HEIGHT, createViewportState, resize } from '../eventlog/chart/viewportState';
import type { EventLogPalette } from '../eventlog/common/theme';

const theme: EventLogPalette = {
  foreground: '#cccccc',
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

// ---------------------------------------------------------------------------------
// resolveExportRange / isExportRangeAvailable / cap check -- pure range resolution
// ---------------------------------------------------------------------------------

function baseCtx(overrides: Partial<ExportRangeContext> = {}): ExportRangeContext {
  return {
    visibleLeftTc: 100,
    visibleRightTc: 200,
    wholeBeginTc: 0,
    wholeEndTc: 1000,
    selectedTcs: undefined,
    pixelsPerTc: 10,
    extraSpacePx: 0,
    ...overrides,
  };
}

test('resolveExportRange: "visible" resolves to the viewport\'s own visible tc range', () => {
  const range = resolveExportRange('visible', baseCtx());
  assert.deepStrictEqual(range, { tcBegin: 100, tcEnd: 200 });
});

test('resolveExportRange: "whole" resolves to the whole-log tc span', () => {
  const range = resolveExportRange('whole', baseCtx());
  assert.deepStrictEqual(range, { tcBegin: 0, tcEnd: 1000 });
});

test('resolveExportRange: "whole" is unavailable (null) when the whole-log span is unknown', () => {
  assert.strictEqual(isExportRangeAvailable('whole', baseCtx({ wholeBeginTc: null })), false);
  assert.strictEqual(resolveExportRange('whole', baseCtx({ wholeBeginTc: null })), null);
});

test('resolveExportRange: "selected" requires exactly two selected events\' tc (via selectedTcs) and is unavailable otherwise', () => {
  assert.strictEqual(isExportRangeAvailable('selected', baseCtx()), false);
  assert.strictEqual(resolveExportRange('selected', baseCtx()), null);
  const range = resolveExportRange('selected', baseCtx({ selectedTcs: [30, 70] }));
  assert.deepStrictEqual(range, { tcBegin: 30, tcEnd: 70 });
});

test('resolveExportRange: extra-space padding (px) is converted to tc via pixelsPerTc and applied symmetrically', () => {
  // pixelsPerTc=10, extraSpacePx=50 -> 5 tc of padding on each side
  const range = resolveExportRange('visible', baseCtx({ extraSpacePx: 50 }));
  assert.deepStrictEqual(range, { tcBegin: 95, tcEnd: 205 });
});

test('computeExportWidthPx / exceedsExportWidthCap: the pixel-cap-with-confirmation gate', () => {
  const narrow = { tcBegin: 0, tcEnd: 100 };
  assert.strictEqual(computeExportWidthPx(narrow, 10), 1000);
  assert.strictEqual(exceedsExportWidthCap(narrow, 10), false);

  const wide = { tcBegin: 0, tcEnd: 10_000 };
  const widthPx = computeExportWidthPx(wide, 10);
  assert.ok(widthPx > EXPORT_WIDTH_CAP_PX, `expected ${widthPx} > ${EXPORT_WIDTH_CAP_PX}`);
  assert.strictEqual(exceedsExportWidthCap(wide, 10), true);
});

// ---------------------------------------------------------------------------------
// buildChartSvg -- serializer fidelity (canned primitive list -> SVG string)
// ---------------------------------------------------------------------------------

test('buildChartSvg: root <svg> carries the requested width/height/viewBox and a background rect', () => {
  const svg = buildChartSvg({ primitives: [], widthPx: 800, heightPx: 200, backgroundColor: '#1e1e1e', fontFamily: 'sans-serif' });
  assert.ok(svg.startsWith('<svg '), svg.slice(0, 40));
  assert.ok(svg.includes('width="800"'));
  assert.ok(svg.includes('height="200"'));
  assert.ok(svg.includes('viewBox="0 0 800 200"'));
  assert.ok(svg.includes('<rect x="0" y="0" width="800" height="200" fill="#1e1e1e"/>'));
  assert.ok(svg.endsWith('</svg>'));
});

test('buildChartSvg: one <line>/<circle>/<text> per matching primitive, colors and dash arrays preserved', () => {
  const primitives: DrawPrimitive[] = [
    { kind: 'axisLine', moduleId: 1, x1: 0, x2: 100, y: 10, lineHeight: 2, color: '#ffffff' },
    { kind: 'eventMark', eventNumber: 1, moduleId: 1, x: 10, y: 10, radius: 3, color: '#cc0000' },
    { kind: 'arrow', arrowKind: 'send', x1: 0, y1: 10, x2: 50, y2: 20, color: '#0000cc', dash: [2, 2] },
    { kind: 'label', x: 5, y: 5, text: 'hello & <world>', color: '#cccccc', align: 'left' },
  ];
  const svg = buildChartSvg({ primitives, widthPx: 200, heightPx: 50, backgroundColor: '#000000', fontFamily: 'sans-serif' });

  assert.strictEqual((svg.match(/<line /g) ?? []).length, 2, 'axisLine + arrow both serialize as <line>');
  assert.strictEqual((svg.match(/<circle /g) ?? []).length, 1);
  assert.strictEqual((svg.match(/<text /g) ?? []).length, 1);
  assert.ok(svg.includes('stroke="#0000cc"'));
  assert.ok(svg.includes('stroke-dasharray="2,2"'));
  assert.ok(svg.includes('fill="#cc0000"'));
  // XML-escaped text content (SvgBuilder.el()'s escapeXml, reused verbatim)
  assert.ok(svg.includes('hello &amp; &lt;world&gt;'));
  assert.ok(!svg.includes('hello & <world>'));
});

test('buildChartSvg: a solid (non-dashed) arrow omits stroke-dasharray entirely', () => {
  const primitives: DrawPrimitive[] = [{ kind: 'arrow', arrowKind: 'send', x1: 0, y1: 0, x2: 10, y2: 10, color: '#0000cc' }];
  const svg = buildChartSvg({ primitives, widthPx: 50, heightPx: 50, backgroundColor: '#fff', fontFamily: 'sans-serif' });
  assert.ok(!svg.includes('stroke-dasharray'));
});

test('buildChartSvg: rotated labels use transform=rotate(...) (fidelity IMPROVEMENT over Java, which disables headers for SVG export)', () => {
  const primitives: DrawPrimitive[] = [{ kind: 'label', x: 12, y: 34, text: 'send()', color: '#cc6600', align: 'center', rotateDeg: -90 }];
  const svg = buildChartSvg({ primitives, widthPx: 50, heightPx: 50, backgroundColor: '#fff', fontFamily: 'sans-serif' });
  assert.ok(svg.includes('transform="translate(12 34) rotate(-90)"'));
  assert.ok(svg.includes('text-anchor="middle"'));
});

test('buildChartSvg: ellipseArc emits a stroked, unfilled <path> (polyline approximation, see this module\'s header)', () => {
  const primitives: DrawPrimitive[] = [{ kind: 'ellipseArc', x1: 0, x2: 20, y: 50, height: 8, quarter: -1, color: '#00ee00' }];
  const svg = buildChartSvg({ primitives, widthPx: 100, heightPx: 100, backgroundColor: '#fff', fontFamily: 'sans-serif' });
  assert.strictEqual((svg.match(/<path /g) ?? []).length, 1);
  assert.ok(svg.includes('fill="none"'));
  assert.ok(svg.includes('stroke="#00ee00"'));
  // a real "d" polyline with multiple M/L points, not a degenerate single-point path
  const d = /<path d="([^"]+)"/.exec(svg)![1];
  assert.ok(d.split(' L ').length > 5, `expected several polyline segments, got: ${d}`);
});

test('buildChartSvg: a degenerate (zero-width) ellipseArc falls back to a straight <line>, matching canvasStack.ts\'s own fallback', () => {
  const primitives: DrawPrimitive[] = [{ kind: 'ellipseArc', x1: 10, x2: 10, y: 50, height: 8, quarter: -1, color: '#00ee00' }];
  const svg = buildChartSvg({ primitives, widthPx: 100, heightPx: 100, backgroundColor: '#fff', fontFamily: 'sans-serif' });
  assert.strictEqual((svg.match(/<path /g) ?? []).length, 0);
  assert.strictEqual((svg.match(/<line /g) ?? []).length, 1);
});

test('buildChartSvg: parallelogram/zigzag draw as a filled polygon / a multi-subpath stroked path', () => {
  const primitives: DrawPrimitive[] = [
    {
      kind: 'parallelogram',
      points: [
        [0, 0],
        [10, 0],
        [8, 5],
        [-2, 5],
      ],
      color: '#333333',
    },
    {
      kind: 'zigzag',
      segments: [
        { x1: 0, y1: 0, x2: 5, y2: 5 },
        { x1: 5, y1: 5, x2: 0, y2: 10 },
      ],
      color: '#008b8b',
    },
  ];
  const svg = buildChartSvg({ primitives, widthPx: 50, heightPx: 50, backgroundColor: '#fff', fontFamily: 'sans-serif' });
  assert.ok(svg.includes('<polygon points="0,0 10,0 8,5 -2,5" fill="#333333" fill-opacity="0.25"/>'));
  assert.ok(svg.includes('<path d="M 0 0 L 5 5 M 5 5 L 0 10" stroke="#008b8b" fill="none" stroke-width="1"/>'));
});

test('buildChartSvg: moduleAction (interactive axis-management glyphs) is silently skipped -- not exported', () => {
  const primitives: DrawPrimitive[] = [
    { kind: 'moduleAction', action: 'expand', moduleId: 1, scope: 'axis', x: 0, y: 0, size: 11, color: '#888888' },
    { kind: 'eventMark', eventNumber: 1, moduleId: 1, x: 5, y: 5, radius: 3, color: '#cc0000' },
  ];
  const svg = buildChartSvg({ primitives, widthPx: 50, heightPx: 50, backgroundColor: '#fff', fontFamily: 'sans-serif' });
  assert.strictEqual((svg.match(/<circle /g) ?? []).length, 1, 'only the eventMark should have drawn anything');
  assert.ok(!svg.includes('#888888'));
});

// ---------------------------------------------------------------------------------
// End-to-end: resolveExportRange + a synthetic export viewport fed through the SAME
// buildDrawList() the live chart uses -- primitives outside the chosen range are
// excluded exactly like the on-screen renderer excludes off-screen ones.
// ---------------------------------------------------------------------------------

function event_(eventNumber: number, moduleId: number, tc: number): TimelineEvent {
  return { eventNumber, moduleId, simulationTime: String(tc), tcBegin: tc, tcEnd: tc, causeEventNumber: -1, isSelfMessageProcessingEvent: false };
}

test('export range clipping: an export viewport built from resolveExportRange() excludes events outside the chosen range', () => {
  const pixelsPerTc = 10;
  // one event inside the chosen "visible" range [100,200], one far outside it
  const events = [event_(1, 1, 150), event_(2, 1, 900)];
  const range = resolveExportRange('visible', {
    visibleLeftTc: 100,
    visibleRightTc: 200,
    wholeBeginTc: 0,
    wholeEndTc: 1000,
    pixelsPerTc,
    extraSpacePx: 0,
  })!;
  const widthPx = computeExportWidthPx(range, pixelsPerTc);
  const exportViewport = { ...resize(createViewportState(), GUTTER_LEFT_WIDTH + widthPx, GUTTER_TOP_HEIGHT + 200), leftTc: range.tcBegin, pixelsPerTc };
  const axesLayout = deriveAxes(new Set([1]), null, 200, false);
  const primitives = buildDrawList({
    timelineMode: TimelineMode.SIMULATION_TIME,
    viewport: exportViewport,
    events,
    dependencies: [],
    methodCalls: [],
    axesLayout,
    ticks: [],
    theme,
    displayFlags: DEFAULT_DISPLAY_FLAGS,
  });
  const eventMarks = primitives.filter((p): p is Extract<DrawPrimitive, { kind: 'eventMark' }> => p.kind === 'eventMark');
  assert.deepStrictEqual(
    eventMarks.map((m) => m.eventNumber),
    [1],
    'only the in-range event (#1) should produce an eventMark; #2 (tc=900) is outside the exported [100,200] range',
  );

  const svg = buildChartSvg({ primitives, widthPx: GUTTER_LEFT_WIDTH + widthPx, heightPx: GUTTER_TOP_HEIGHT + 200, backgroundColor: theme.background, fontFamily: 'sans-serif' });
  assert.strictEqual((svg.match(/<circle /g) ?? []).length, 1);
});
