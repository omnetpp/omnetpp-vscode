/**
 * canvasStack.ts — the two-canvas stack + tile bookkeeping (port intent: Java's
 * `CachingCanvas`/the `paintCachableLayer`/`paintNoncachableLayer` split,
 * `SequenceChart.java:3040-3431`).
 *
 * Two `<canvas>` elements, stacked via CSS (`position:absolute`, same rect), each
 * scaled for `devicePixelRatio` so strokes stay crisp on HiDPI displays:
 *  - `content`: axis lines, event/self-event marks, arrows+arrowheads, hairpins,
 *    method-call arrows/labels, dense-column indicator lines (Java's "cachable
 *    layer" — the bulk of the drawing, redrawn least often in Java's design).
 *  - `overlay`: gutter backgrounds, ruler ticks + tick labels, axis labels (pinned to
 *    the left gutter) — everything Java's "noncachable layer" redraws every frame
 *    regardless of scroll (selection/highlight/tooltip decorations are U4, not drawn
 *    here yet).
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
  /** Draws `primitives` (from `drawList.ts`) onto the two canvases, clearing first. `antialiasing` toggles `imageSmoothingEnabled` (best-effort -- Canvas2D has no direct vector-stroke AA switch; the "auto" 100/300ms perf-triggered toggle itself is U5, this is just the plumbing). */
  render(primitives: DrawPrimitive[], antialiasing: boolean): void;
  dispose(): void;
}

const NONCACHEABLE_KINDS = new Set<DrawPrimitive['kind']>(['gutter', 'tick', 'axisLabel', 'label']);

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

  function drawPrimitive(ctx: CanvasRenderingContext2D, p: DrawPrimitive): void {
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
        ctx.textAlign = p.align ?? 'left';
        ctx.textBaseline = 'middle';
        ctx.font = '12px var(--vscode-font-family, sans-serif)';
        ctx.fillText(p.text, p.x, p.y);
        break;
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
      case 'hairpin': {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(p.x1, p.y);
        ctx.lineTo(p.x1, p.y - p.height);
        ctx.lineTo(p.x2, p.y - p.height);
        ctx.lineTo(p.x2, p.y);
        ctx.stroke();
        break;
      }
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
    for (const p of primitives) drawPrimitive(NONCACHEABLE_KINDS.has(p.kind) ? overlayCtx : contentCtx, p);
    for (const ctx of [contentCtx, overlayCtx]) ctx.restore();
  }

  function dispose(): void {
    content.remove();
    overlay.remove();
  }

  return { resize, render, dispose };
}
