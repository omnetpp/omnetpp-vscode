/**
 * canvasStack.ts — the two-canvas stack + tile bookkeeping (port intent: Java's
 * `CachingCanvas`/the `paintCachableLayer`/`paintNoncachableLayer` split,
 * `SequenceChart.java:3040-3431`).
 *
 * Two `<canvas>` elements, stacked via CSS (`position:absolute`, same rect), each
 * scaled for `devicePixelRatio` so strokes stay crisp on HiDPI displays:
 *  - `content`: axis lines, event/self-event marks, arrows+arrowheads, self-message
 *    ellipse arcs, transmission-duration parallelograms, filtered zigzag signs,
 *    zero-simtime region bands, method-call arrows/labels, dense-column indicator
 *    lines (Java's "cachable layer" — the bulk of the drawing, redrawn least often in
 *    Java's design).
 *  - `overlay`: gutter backgrounds, ruler ticks + tick labels, axis labels/headers
 *    (pinned to the left gutter), info panels, selection/time-difference decorations
 *    — everything Java's "noncachable layer" redraws every frame regardless of
 *    scroll.
 *
 * SCOPE NOTE (documented simplification, flagged in this phase's report): `TileCache`
 * below implements the bookkeeping half of Java's `CachingCanvas` tiling scheme
 * faithfully and is unit-testable (tile membership for a visible tc range, LRU
 * eviction past `maxTiles`, invalidation by generation) — but `render()` does NOT yet
 * blit cached per-tile bitmaps to avoid redraw work while panning; it draws the
 * current frame's full primitive list directly onto the `content` canvas every call.
 * Wiring `TileCache` into an actual blit-and-patch render path requires `drawList.ts`
 * to be invoked with TILE-LOCAL (not current-viewport-relative) coordinates per
 * tile, which is a real architectural change deferred rather than risked incorrectly
 * within this phase — noted explicitly as a follow-up perf optimization, not a
 * correctness gap (every visible primitive is still drawn correctly every frame,
 * just without the cross-frame bitmap-reuse speedup `TileCache` is designed to
 * eventually drive).
 */

import { BOOKMARK_FLAG_HEIGHT, BOOKMARK_FLAG_WIDTH, type DrawPrimitive } from './drawList';
import { GUTTER_TOP_HEIGHT } from './viewportState';

export const TILE_WIDTH_PX = 1024;
export const MAX_TILES = 32;
/** Left-gutter axis-header box width per level (mirrors `drawList.ts`'s `HEADER_LEVEL_WIDTH`, minus a small margin). */
export const HEADER_BOX_WIDTH = 9;

/** Port of `SequenceChart.java`'s `ANTIALIAS_TURN_ON_AT_MSEC`/`ANTIALIAS_TURN_OFF_AT_MSEC` (`SequenceChart.java:160-161`) — `chartMain.ts` runs the same hysteresis state machine over its own measured frame time (see `CanvasStackHandle.render()`'s doc for the honest mapping onto what this canvas can actually cheapen). */
export const ANTIALIAS_TURN_ON_AT_MSEC = 100;
export const ANTIALIAS_TURN_OFF_AT_MSEC = 300;

// ---------------------------------------------------------------------------------
// TileCache -- pure bookkeeping (no canvas/DOM dependency), unit-testable
// ---------------------------------------------------------------------------------

interface TileEntry {
  tileIndex: number;
  generation: number;
  lastAccess: number;
}

/**
 * Tracks which `(tileIndex, generation)` pairs are considered "resident" -- a stand-in
 * for "this tile's bitmap is cached and reusable". `tileIndex` is defined in a
 * VIRTUAL pixel space anchored at tc=0 (`Math.floor(tc * pixelsPerTc / TILE_WIDTH_PX)`),
 * so the same tile index means the same tc range regardless of the current
 * viewport's `leftTc` -- panning alone never changes which indices are needed for a
 * previously-seen range. `generation` invalidates every tile at once when anything
 * that changes a tile's CONTENT changes (zoom level, vscroll, coordinateSystemVersion,
 * theme, timeline mode) -- the caller is responsible for bumping it (see
 * `viewportGeneration()` below for the recommended composite key).
 */
export class TileCache {
  private readonly tiles = new Map<string, TileEntry>();
  private accessCounter = 0;

  constructor(private readonly maxTiles = MAX_TILES) {}

  private key(tileIndex: number, generation: number): string {
    return `${tileIndex}:${generation}`;
  }

  /** Tile indices needed to cover `[leftTc, rightTc]` at `pixelsPerTc`, virtual-space (tc=0-anchored). */
  static tileIndicesForRange(leftTc: number, rightTc: number, pixelsPerTc: number): number[] {
    if (pixelsPerTc <= 0) return [];
    const first = Math.floor((leftTc * pixelsPerTc) / TILE_WIDTH_PX);
    const last = Math.floor((rightTc * pixelsPerTc) / TILE_WIDTH_PX);
    const out: number[] = [];
    for (let i = first; i <= last; i++) out.push(i);
    return out;
  }

  isResident(tileIndex: number, generation: number): boolean {
    return this.tiles.has(this.key(tileIndex, generation));
  }

  /** Marks a tile resident (freshly rendered/cached) and touches its LRU position, evicting the least-recently-used tile(s) past `maxTiles`. */
  markResident(tileIndex: number, generation: number): void {
    const k = this.key(tileIndex, generation);
    this.tiles.set(k, { tileIndex, generation, lastAccess: ++this.accessCounter });
    if (this.tiles.size > this.maxTiles) {
      const entries = [...this.tiles.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
      for (let i = 0; i < entries.length - this.maxTiles; i++) this.tiles.delete(entries[i][0]);
    }
  }

  /** Touches (bumps LRU recency for) an already-resident tile, e.g. because it's visible again this frame. No-op if not resident. */
  touch(tileIndex: number, generation: number): void {
    const k = this.key(tileIndex, generation);
    const entry = this.tiles.get(k);
    if (entry) entry.lastAccess = ++this.accessCounter;
  }

  size(): number {
    return this.tiles.size;
  }

  clear(): void {
    this.tiles.clear();
  }
}

/** Recommended composite generation key: any of these changing means every tile's cached bitmap is stale. */
export function viewportGeneration(parts: { pixelsPerTc: number; vscroll: number; coordinateSystemVersion: number; timelineMode: string; themeVersion: number }): number {
  // A cheap, collision-resistant-enough hash for bookkeeping purposes (not cryptographic) -- callers
  // needing exactness can instead key by the tuple directly; kept as a single number for TileCache's API.
  const s = `${parts.pixelsPerTc}|${parts.vscroll}|${parts.coordinateSystemVersion}|${parts.timelineMode}|${parts.themeVersion}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

// ---------------------------------------------------------------------------------
// DOM canvas stack (not unit-tested -- DOM-dependent, per this repo's convention of
// keeping DOM-touching code thin and pushing logic into PURE modules like drawList.ts)
// ---------------------------------------------------------------------------------

export interface CanvasStackHandle {
  resize(cssWidth: number, cssHeight: number): void;
  /**
   * Draws `primitives` (from `drawList.ts`) onto the two canvases, clearing first.
   * `antialiasing` toggles `imageSmoothingEnabled`.
   *
   * ANTIALIAS AUTO-TOGGLE MAPPING (phase U5, port of `SequenceChart.java`'s
   * `ANTIALIAS_TURN_ON_AT_MSEC=100`/`ANTIALIAS_TURN_OFF_AT_MSEC=300` auto-toggle,
   * `SequenceChart.java:3466-3470`) -- HONEST NOTE on what this actually buys, since
   * Canvas2D has no per-shape vector-stroke AA switch the way SWT's `Graphics` does:
   * `imageSmoothingEnabled` only affects `drawImage()` (bitmap resampling); it has
   * **no effect** on `stroke()`/`fill()` path rendering, which browsers always
   * antialias. So flipping this flag alone would be a no-op for a canvas frame made
   * entirely of vector primitives (this one). The actual perf lever `chartMain.ts`
   * pulls when a frame's `buildDrawList()`+`render()` time crosses the threshold is
   * `drawList.ts`'s `skipLabelsForPerf` (drop the highest-count/cheapest-to-cut
   * primitives -- text labels -- first, exactly mirroring Java's OWN intent of "when
   * drawing is slow, draw less detail", just via a different lever since the literal
   * one Java used doesn't exist on this canvas). `antialiasing` is still threaded
   * through and toggled by the same measured-frame-time state machine (so a future
   * bitmap-based decoration, e.g. a cached tile blit once `TileCache` above is wired
   * into `render()`, has a real switch to flip), and its live state is surfaced in the
   * status strip for transparency, but on today's all-vector primitive set it is
   * mostly inert -- documented rather than silently pretended-real.
   */
  /** Phase U10 -- `baseFontSizePx` threads `omnetpp.sequenceChart.fontSize` through to `drawPrimitiveToCanvas()` (see its own doc comment); omitted/`undefined` keeps this file's original hardcoded 12/11/10px sizes. */
  render(primitives: DrawPrimitive[], antialiasing: boolean, baseFontSizePx?: number): void;
  dispose(): void;
}

const NONCACHEABLE_KINDS = new Set<DrawPrimitive['kind']>(['gutter', 'tick', 'axisLabel', 'axisHeaderBox', 'label', 'selectionMark', 'bookmarkMark', 'infoPanel', 'timeDifferenceLabel', 'moduleAction', 'mouseTick', 'tickPrefixBox']);

/**
 * "Gutter chrome": overlay primitives that live in (or must stay on top of) the left/top
 * gutter bands -- the opaque gutter backgrounds plus everything drawn inside them (axis
 * labels, ruler ticks/tick-labels, module-action glyphs, axis bookmark flags, info
 * panels). These are drawn in a SECOND overlay pass, ON TOP of the content-area overlay
 * decorations (event-number/message labels, selection rings, time-difference labels), so
 * a content label that scrolls under the left "module name" band is covered by the band
 * instead of bleeding across it. A `'label'` in the top ruler (y < GUTTER_TOP_HEIGHT) is a
 * tick label and belongs to this top layer too; content labels sit below it.
 */
function isGutterChrome(p: DrawPrimitive): boolean {
  switch (p.kind) {
    case 'gutter':
    case 'tick':
    case 'axisLabel':
    case 'axisHeaderBox':
    case 'moduleAction':
    case 'infoPanel':
    case 'bookmarkMark':
    case 'mouseTick':
    case 'tickPrefixBox':
      return true;
    case 'label':
      return p.y < GUTTER_TOP_HEIGHT;
    default:
      return false;
  }
}

/**
 * Phase U10 (cheap-gap closure) -- the base chart label font size in CSS px, driving
 * every hardcoded font string below. `12` is this file's own long-standing default
 * (every call site before this phase), so it doubles as the "0 = keep current
 * defaults" value `omnetpp.sequenceChart.fontSize`'s markdownDescription promises
 * (`sequenceChartEditor.ts`/`eventLogTableView.ts` already turn a `0` setting into
 * `undefined` before it ever reaches here). The three sizes below (main labels /
 * time-difference+info-panel labels / rotated axis-header labels) were always 12/11/10
 * -- i.e. base, base-1, base-2 -- so scaling by that same fixed offset at any other
 * base preserves their original relative proportions without a second set of magic
 * numbers. HONEST LIMIT (noted in the setting's own doc, not just here): this is a
 * uniform scale, not real font-metrics-aware relayout -- at far-from-12 sizes, label
 * spacing/gutter widths sized for the 12px default may look slightly cramped or
 * loose (no DPI/metrics work is in scope for this fix).
 */
export const DEFAULT_CHART_FONT_SIZE_PX = 12;

export function drawPrimitiveToCanvas(ctx: CanvasRenderingContext2D, p: DrawPrimitive, baseFontSizePx: number = DEFAULT_CHART_FONT_SIZE_PX): void {
  const mainFont = `${baseFontSizePx}px var(--vscode-font-family, sans-serif)`;
  const secondaryFont = `${baseFontSizePx - 1}px var(--vscode-font-family, sans-serif)`;
  const axisHeaderFont = `${baseFontSizePx - 2}px var(--vscode-font-family, sans-serif)`;
  switch (p.kind) {
    case 'gutter':
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.w, p.h);
      break;
    case 'axisLine':
      ctx.strokeStyle = p.color;
      ctx.lineWidth = p.lineHeight;
      ctx.beginPath();
      ctx.moveTo(p.x1, p.y);
      ctx.lineTo(p.x2, p.y);
      ctx.stroke();
      break;
    case 'axisVectorStrip': {
      // Multi-color step bar centered on the axis line (Eclipse AxisVectorBarRenderer): a
      // filled rectangle per held-value segment, a black divider at each value change, and
      // top/bottom border lines.
      const top = Math.round(p.y - p.height / 2);
      const bot = top + p.height;
      ctx.setLineDash([]);
      for (const seg of p.segments) {
        const x1 = Math.round(seg.x1);
        const w = Math.max(1, Math.round(seg.x2) - x1);
        ctx.fillStyle = seg.color;
        ctx.fillRect(x1, top, w, p.height);
        // divider at the value change (segment start)
        ctx.strokeStyle = p.borderColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x1 + 0.5, top);
        ctx.lineTo(x1 + 0.5, bot);
        ctx.stroke();
      }
      // top + bottom borders spanning the drawn extent
      const first = p.segments[0];
      const last = p.segments[p.segments.length - 1];
      if (first && last) {
        ctx.strokeStyle = p.borderColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(first.x1, top + 0.5);
        ctx.lineTo(last.x2, top + 0.5);
        ctx.moveTo(first.x1, bot - 0.5);
        ctx.lineTo(last.x2, bot - 0.5);
        ctx.stroke();
      }
      // value/enum labels (Eclipse `AxisVectorBarRenderer.drawAxis()`, phase 1): drawn at a
      // FIXED position from the segment's own start, then repeated every `canvasWidth` px so
      // a segment wider than the screen still shows a copy wherever you've scrolled to. This
      // is deliberately NOT "keep centered in the visible portion" -- the segment's true,
      // unclamped bounds are used, exactly like every other content primitive (events,
      // dependency labels, ...); the opaque gutter/compound-band overlay (drawn in a later
      // pass) naturally covers whichever copies land underneath it instead of this code
      // reserving space to avoid it.
      ctx.font = '9px "Courier New", monospace';
      ctx.fillStyle = p.labelColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (const seg of p.segments) {
        const tw = ctx.measureText(seg.valueText).width;
        if (seg.x2 - seg.x1 > tw + 6) {
          for (let x = seg.x1 + 5; x < p.canvasWidth && x < seg.x2 - tw; x += p.canvasWidth) ctx.fillText(seg.valueText, x, p.y);
        }
      }
      break;
    }
    case 'axisLabel':
      // Sit the name JUST ABOVE the axis line (baseline 2px above it) instead of centered
      // on it -- the line no longer strikes through the text, so names stay readable now
      // that the label strip is transparent.
      ctx.fillStyle = p.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.font = p.bold ? `bold ${mainFont}` : mainFont;
      ctx.fillText(p.text, p.x, p.y - 2);
      break;
    case 'axisSelectionMark': {
      // Two thin colored lines bracketing whatever is drawn on this row (above and below) --
      // Java `drawAxisMark()`. What's drawn is always CENTERED on `p.y` and `p.lineHeight`
      // tall (a plain 1/3px axis line, or the 12px vector-strip row) -- see `axisLine`/
      // `axisVectorStrip` above -- so the bracket lines are symmetric around that center
      // with a small fixed margin, instead of a fixed 1px-above offset that would sit INSIDE
      // a tall strip (the offset used to assume a thin line; see this file's change history
      // for the bug that motivated this fix).
      const halfHeight = p.lineHeight / 2;
      const margin = 1.5;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(p.x1, p.y - halfHeight - margin);
      ctx.lineTo(p.x2, p.y - halfHeight - margin);
      ctx.moveTo(p.x1, p.y + halfHeight + margin);
      ctx.lineTo(p.x2, p.y + halfHeight + margin);
      ctx.stroke();
      break;
    }
    case 'label':
      ctx.fillStyle = p.color;
      ctx.font = mainFont;
      if (p.rotateDeg) {
        // Method-call names (Java: drawn rotated -90 along the call's left edge, SequenceChart.java:3775-3781).
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotateDeg * Math.PI) / 180);
        ctx.textAlign = p.align ?? 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.text, 0, 0);
        ctx.restore();
      } else {
        ctx.textAlign = p.align ?? 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.text, p.x, p.y);
      }
      break;
    case 'timeDifferenceLabel':
      ctx.fillStyle = p.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = secondaryFont;
      ctx.fillText(p.text, p.x, p.y);
      break;
    case 'regionBand':
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.w, p.h);
      break;
    case 'axisHeaderBox': {
      // Opaque compound-module band (p.color fill, thin border) with the rotated name.
      ctx.fillStyle = p.color;
      const w = HEADER_BOX_WIDTH;
      ctx.fillRect(p.x, p.y0, w, Math.max(1, p.y1 - p.y0));
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(p.x, p.y0, w, Math.max(1, p.y1 - p.y0));
      if (p.y1 - p.y0 > 20) {
        ctx.save();
        ctx.fillStyle = p.textColor;
        ctx.font = axisHeaderFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.translate(p.x + w / 2, (p.y0 + p.y1) / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(p.label, 0, 0);
        ctx.restore();
      }
      break;
    }
    case 'ellipseArc': {
      ctx.strokeStyle = p.color;
      ctx.lineWidth = p.width ?? 1;
      ctx.setLineDash(p.dash ?? []);
      const cx = (p.x1 + p.x2) / 2;
      const rx = Math.abs(p.x2 - p.x1) / 2;
      const ry = p.height;
      // Java always draws the TOP half of the ellipse (the "hump" above the axis line, SequenceChart.java:4682); the
      // quarter param only narrows WHICH portion of that top half is actually stroked (see arrowGeometry.ts's header).
      const [startAngle, endAngle] = p.quarter === 0 ? [Math.PI, 1.5 * Math.PI] : p.quarter === 1 ? [1.5 * Math.PI, 2 * Math.PI] : [Math.PI, 2 * Math.PI];
      ctx.beginPath();
      if (rx > 0) ctx.ellipse(cx, p.y, rx, ry, 0, startAngle, endAngle);
      else ctx.moveTo(cx, p.y - ry), ctx.lineTo(cx, p.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      break;
    }
    case 'parallelogram': {
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.moveTo(p.points[0][0], p.points[0][1]);
      for (let i = 1; i < p.points.length; i++) ctx.lineTo(p.points[i][0], p.points[i][1]);
      ctx.closePath();
      ctx.fill();
      if (p.borderColor) {
        ctx.strokeStyle = p.borderColor;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.restore();
      break;
    }
    case 'zigzag':
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      for (const seg of p.segments) {
        ctx.beginPath();
        ctx.moveTo(seg.x1, seg.y1);
        ctx.lineTo(seg.x2, seg.y2);
        ctx.stroke();
      }
      break;
    case 'infoPanel': {
      // Sized to its measured text (Java measures getTextExtent), not an estimate: box
      // width = widest line + padding, right-aligned to `rightX`.
      ctx.font = secondaryFont;
      const lineH = 15;
      const padX = 6;
      const padY = 3;
      let textW = 0;
      for (const line of p.lines) textW = Math.max(textW, ctx.measureText(line).width);
      const w = Math.ceil(textW) + 2 * padX;
      const h = p.lines.length * lineH + 2 * padY;
      const x = p.rightX - w - 4;
      const y = p.edge === 'top' ? p.anchorY + 2 : p.anchorY - h - 2;
      ctx.fillStyle = p.background;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = p.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      for (let i = 0; i < p.lines.length; i++) ctx.fillText(p.lines[i], x + padX, y + padY + i * lineH);
      break;
    }
    case 'tick':
    case 'eventDensityLine':
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y0);
      ctx.lineTo(p.x, p.y1);
      ctx.stroke();
      break;
    case 'timelineMark':
      // A selected timeline coordinate -- a vertical line spanning the content height.
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y0);
      ctx.lineTo(p.x, p.y1);
      ctx.stroke();
      ctx.lineWidth = 1;
      break;
    case 'mouseTick': {
      // The live "time under the mouse": a dashed vertical hairline + a small labelled box
      // in the top gutter (Java `drawTickUnderMouse()`).
      ctx.strokeStyle = p.lineColor;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y0);
      ctx.lineTo(p.x, p.y1);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = secondaryFont;
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(p.label).width;
      const boxW = tw + 8;
      const boxH = 15;
      const boxX = Math.max(0, p.x - boxW / 2);
      const boxY = 3;
      ctx.fillStyle = p.bgColor;
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.strokeStyle = p.lineColor;
      ctx.strokeRect(boxX, boxY, boxW, boxH);
      ctx.fillStyle = p.textColor;
      ctx.textAlign = 'center';
      ctx.fillText(p.label, boxX + boxW / 2, boxY + boxH / 2);
      break;
    }
    case 'tickPrefixBox': {
      // Java `drawTickPrefix()`: the shared "+ <offset>" boxed in the top gutter's right
      // corner. Bold, measured, right-aligned to rightX.
      ctx.font = axisHeaderFont; // reuse the small bold header font
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(p.label).width;
      const boxW = Math.ceil(tw) + 8;
      const boxH = 15;
      const boxX = p.rightX - boxW - 1;
      const boxY = 3;
      ctx.fillStyle = p.bgColor;
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(boxX, boxY, boxW, boxH);
      ctx.fillStyle = p.textColor;
      ctx.textAlign = 'center';
      ctx.fillText(p.label, boxX + boxW / 2, boxY + boxH / 2);
      break;
    }
    case 'eventMark':
    case 'selfEventMark': {
      // Port of Java `drawEvent()` (SequenceChart.java:3900-3911): a plain filled disc
      // when begin==end, a stadium/"pill" (two half-discs joined by a rectangle) when the
      // event has a nonzero timeline width (STEP/NONLINEAR + separate log entries). A
      // rounded rectangle with corner radius == the event radius yields exactly that
      // stadium; the disc branch is kept explicit so the common point-event case never
      // depends on `roundRect` and always renders as a true circle.
      ctx.fillStyle = p.color;
      ctx.beginPath();
      if (p.xEnd > p.x + 0.5) ctx.roundRect(p.x - p.radius, p.y - p.radius, p.xEnd - p.x + 2 * p.radius, 2 * p.radius, p.radius);
      else ctx.arc(p.x, p.y, p.radius, 0, 2 * Math.PI);
      ctx.fill();
      break;
    }
    case 'arrow':
      ctx.strokeStyle = p.color;
      ctx.lineWidth = p.width ?? 1;
      ctx.setLineDash(p.dash ?? []);
      ctx.beginPath();
      ctx.moveTo(p.x1, p.y1);
      ctx.lineTo(p.x2, p.y2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      break;
    case 'arrowHead': {
      ctx.fillStyle = p.color;
      const tipX = p.x;
      const tipY = p.y;
      const backX = tipX - p.length * Math.cos(p.angle);
      const backY = tipY - p.length * Math.sin(p.angle);
      const perpX = (-Math.sin(p.angle) * p.width) / 2;
      const perpY = (Math.cos(p.angle) * p.width) / 2;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(backX + perpX, backY + perpY);
      ctx.lineTo(backX - perpX, backY - perpY);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'selectionMark':
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.beginPath();
      // Stadium outline around a pill event, plain ring around a dot -- mirrors the
      // eventMark/selfEventMark begin!=end split so a selected wide event reads as a
      // ring following its whole shape, not a circle stuck at its left cap.
      if (p.xEnd > p.x + 0.5) ctx.roundRect(p.x - p.radius, p.y - p.radius, p.xEnd - p.x + 2 * p.radius, 2 * p.radius, p.radius);
      else ctx.arc(p.x, p.y, p.radius, 0, 2 * Math.PI);
      ctx.stroke();
      break;
    case 'moduleAction': {
      // Phase U8 -- axis-management glyph hotspot: a bordered box with a vector
      // plus (expand) / minus (collapse) / cross (close) symbol, standing in for
      // Eclipse's expand.png/collapse.png/close.png ModuleAction images.
      const cx = p.x + p.size / 2;
      const cy = p.y + p.size / 2;
      const arm = Math.floor(p.size / 2) - 2;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.strokeRect(p.x + 0.5, p.y + 0.5, p.size - 1, p.size - 1);
      ctx.beginPath();
      if (p.action === 'close') {
        ctx.moveTo(cx - arm, cy - arm);
        ctx.lineTo(cx + arm, cy + arm);
        ctx.moveTo(cx + arm, cy - arm);
        ctx.lineTo(cx - arm, cy + arm);
      } else {
        ctx.moveTo(cx - arm, cy);
        ctx.lineTo(cx + arm, cy);
        if (p.action === 'expand') {
          ctx.moveTo(cx, cy - arm);
          ctx.lineTo(cx, cy + arm);
        }
      }
      ctx.stroke();
      break;
    }
    case 'bookmarkMark': {
      // A small filled "flag" glyph (a vertical pole + a triangular pennant) -- see
      // `drawList.ts`'s `DrawPrimitive` doc for why this stands in for Eclipse's
      // actual bookmark ruler icon.
      const poleHeight = BOOKMARK_FLAG_HEIGHT;
      const flagWidth = BOOKMARK_FLAG_WIDTH;
      ctx.fillStyle = p.color;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - poleHeight);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - poleHeight);
      ctx.lineTo(p.x + flagWidth, p.y - poleHeight + flagWidth / 2);
      ctx.lineTo(p.x, p.y - poleHeight + flagWidth);
      ctx.closePath();
      ctx.fill();
      break;
    }
  }
}

export function createCanvasStack(container: HTMLElement): CanvasStackHandle {
  const content = document.createElement('canvas');
  const overlay = document.createElement('canvas');
  for (const c of [content, overlay]) {
    c.style.position = 'absolute';
    c.style.left = '0';
    c.style.top = '0';
    c.style.width = '100%';
    c.style.height = '100%';
  }
  overlay.style.pointerEvents = 'none';
  // Do NOT touch container.style.position here: the container's stylesheet class
  // (.elog-chart-canvas-container: position:absolute; inset:0) is what stretches it to
  // fill the chart body, and an inline CSSOM 'relative' would override the class --
  // position:relative turns inset:0 into a no-op offset, collapsing the container to
  // ZERO HEIGHT. That exact override kept the chart canvas invisible in every real
  // VS Code window from day one (absolute children only need *a* positioned ancestor,
  // which absolute itself satisfies) while the happy-dom smoke, whose stub
  // ResizeObserver reports a fixed size without doing layout, stayed green.
  container.appendChild(content);
  container.appendChild(overlay);

  let dpr = window.devicePixelRatio || 1;

  function resize(cssWidth: number, cssHeight: number): void {
    dpr = window.devicePixelRatio || 1;
    for (const c of [content, overlay]) {
      c.width = Math.max(1, Math.round(cssWidth * dpr));
      c.height = Math.max(1, Math.round(cssHeight * dpr));
    }
  }


  function render(primitives: DrawPrimitive[], antialiasing: boolean, baseFontSizePx?: number): void {
    const contentCtx = content.getContext('2d')!;
    const overlayCtx = overlay.getContext('2d')!;
    for (const ctx of [contentCtx, overlayCtx]) {
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = antialiasing;
      ctx.clearRect(0, 0, ctx.canvas.width / dpr, ctx.canvas.height / dpr);
    }
    // Content canvas: everything not in the overlay set, in list order.
    for (const p of primitives) if (!NONCACHEABLE_KINDS.has(p.kind)) drawPrimitiveToCanvas(contentCtx, p, baseFontSizePx);
    // Overlay canvas, two passes: content-area decorations first, then gutter chrome on
    // top (so labels scrolled under the left band are covered by it -- see isGutterChrome).
    for (const p of primitives) if (NONCACHEABLE_KINDS.has(p.kind) && !isGutterChrome(p)) drawPrimitiveToCanvas(overlayCtx, p, baseFontSizePx);
    for (const p of primitives) if (NONCACHEABLE_KINDS.has(p.kind) && isGutterChrome(p)) drawPrimitiveToCanvas(overlayCtx, p, baseFontSizePx);
    for (const ctx of [contentCtx, overlayCtx]) ctx.restore();
  }

  function dispose(): void {
    content.remove();
    overlay.remove();
  }

  return { resize, render, dispose };
}

/**
 * Phase U9 -- "Copy Image to Clipboard" / a future PNG export path: draws `primitives`
 * onto a freshly created, untiled, non-DPI-scaled canvas of exactly `widthPx`×`heightPx`
 * CSS px (callers choose the scale -- `chartMain.ts`'s `doCopyImage()` multiplies by
 * `window.devicePixelRatio` for a crisp raster, same as the NED preview's own PNG
 * export). Reuses `drawPrimitiveToCanvas()` -- the exact same per-primitive drawing code
 * the live two-canvas stack above uses -- so the exported bitmap is pixel-for-pixel
 * identical to what the user already sees on screen, not a separate rasterization path
 * that could silently drift out of sync with it.
 */
export function renderPrimitivesToCanvas(widthPx: number, heightPx: number, primitives: readonly DrawPrimitive[], backgroundColor: string, scale = 1, baseFontSizePx?: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(widthPx * scale));
  canvas.height = Math.max(1, Math.round(heightPx * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, widthPx, heightPx);
  for (const p of primitives) drawPrimitiveToCanvas(ctx, p, baseFontSizePx);
  ctx.restore();
  return canvas;
}
