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

import type { DrawPrimitive } from './drawList';

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
  render(primitives: DrawPrimitive[], antialiasing: boolean): void;
  dispose(): void;
}

const NONCACHEABLE_KINDS = new Set<DrawPrimitive['kind']>(['gutter', 'tick', 'axisLabel', 'label', 'selectionMark', 'bookmarkMark', 'infoPanel', 'timeDifferenceLabel', 'moduleAction']);

export function drawPrimitiveToCanvas(ctx: CanvasRenderingContext2D, p: DrawPrimitive): void {
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
    case 'axisLabel':
      ctx.fillStyle = p.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = '12px var(--vscode-font-family, sans-serif)';
      ctx.fillText(p.text, p.x, p.y);
      break;
    case 'label':
      ctx.fillStyle = p.color;
      ctx.font = '12px var(--vscode-font-family, sans-serif)';
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
      ctx.font = '11px var(--vscode-font-family, sans-serif)';
      ctx.fillText(p.text, p.x, p.y);
      break;
    case 'regionBand':
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.w, p.h);
      break;
    case 'axisHeaderBox': {
      ctx.fillStyle = p.color;
      const w = HEADER_BOX_WIDTH;
      ctx.fillRect(p.x, p.y0, w, Math.max(1, p.y1 - p.y0));
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(p.x, p.y0, w, Math.max(1, p.y1 - p.y0));
      if (p.y1 - p.y0 > 20) {
        ctx.save();
        ctx.fillStyle = '#000000';
        ctx.font = '10px var(--vscode-font-family, sans-serif)';
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
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
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
      ctx.fillStyle = p.background;
      ctx.fillRect(p.x, p.y, p.w, p.h);
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(p.x, p.y, p.w, p.h);
      ctx.fillStyle = p.color;
      ctx.font = '11px var(--vscode-font-family, sans-serif)';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      for (let i = 0; i < p.lines.length; i++) ctx.fillText(p.lines[i], p.x + p.w - 4, p.y + 3 + i * 15);
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
    case 'eventMark':
    case 'selfEventMark':
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, 2 * Math.PI);
      ctx.fill();
      break;
    case 'arrow':
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1;
      ctx.setLineDash(p.dash ?? []);
      ctx.beginPath();
      ctx.moveTo(p.x1, p.y1);
      ctx.lineTo(p.x2, p.y2);
      ctx.stroke();
      ctx.setLineDash([]);
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
      ctx.arc(p.x, p.y, p.radius, 0, 2 * Math.PI);
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
      const poleHeight = 8;
      const flagWidth = 6;
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
  container.style.position = 'relative';
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


  function render(primitives: DrawPrimitive[], antialiasing: boolean): void {
    const contentCtx = content.getContext('2d')!;
    const overlayCtx = overlay.getContext('2d')!;
    for (const ctx of [contentCtx, overlayCtx]) {
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = antialiasing;
      ctx.clearRect(0, 0, ctx.canvas.width / dpr, ctx.canvas.height / dpr);
    }
    for (const p of primitives) drawPrimitiveToCanvas(NONCACHEABLE_KINDS.has(p.kind) ? overlayCtx : contentCtx, p);
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
export function renderPrimitivesToCanvas(widthPx: number, heightPx: number, primitives: readonly DrawPrimitive[], backgroundColor: string, scale = 1): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(widthPx * scale));
  canvas.height = Math.max(1, Math.round(heightPx * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, widthPx, heightPx);
  for (const p of primitives) drawPrimitiveToCanvas(ctx, p);
  ctx.restore();
  return canvas;
}
