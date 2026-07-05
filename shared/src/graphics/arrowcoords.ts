/**
 * Connection-arrow endpoint/route computation: a faithful TypeScript port of
 * `src/layout/arrowcoords.cc` from the OMNeT++ source tree — the same routing
 * engine the Eclipse IDE's graphical NED editor and Qtenv use, so connection
 * shapes match the IDE exactly.
 *
 * Routing rules (in priority order):
 *  1. Overlap rule: ≥10px x/y overlap ⇒ straight H/V line through the overlap.
 *  2. L-shape rule: no overlap + a direction from the `m` tag ⇒ one-bend route.
 *  3. Fallback: straight line between the "junction rects" of the two boxes,
 *     offset perpendicular to the line for bundled (parallel) connections.
 * Special cases: same-rect, containment (submodule ↔ enclosing compound), and
 * manual mode (`m=m,x%,y%,x%,y%` anchor percentages).
 *
 * Browser-safe: pure math, no Node/vscode imports.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type RoutingDir = 'h' | 'v' | 'n' | 'e' | 's' | 'w' | 'a' | 'm';

/** Routing constraint parsed from the display string's `m` tag. */
export interface RoutingConstraint {
  srcDir?: RoutingDir;
  destDir?: Exclude<RoutingDir, 'a' | 'm'>;
  /** Manual-mode anchor points, in percentages (0-100) of the rects. */
  srcAnchX?: number;
  srcAnchY?: number;
  destAnchX?: number;
  destAnchY?: number;
}

const left = (r: Rect): number => r.x;
const right = (r: Rect): number => r.x + r.width;
const top = (r: Rect): number => r.y;
const bottom = (r: Rect): number => r.y + r.height;
const center = (r: Rect): Pt => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const containsPt = (r: Rect, p: Pt): boolean => left(r) <= p.x && p.x <= right(r) && top(r) <= p.y && p.y <= bottom(r);
const containsRect = (a: Rect, b: Rect): boolean =>
  left(a) <= left(b) && top(a) <= top(b) && right(b) <= right(a) && bottom(b) <= bottom(a);
const sameRect = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const intersects = (a: Rect, b: Rect): boolean =>
  Math.min(right(a), right(b)) > Math.max(left(a), left(b)) &&
  Math.min(bottom(a), bottom(b)) > Math.max(top(a), top(b));
const samePt = (a: Pt, b: Pt): boolean => a.x === b.x && a.y === b.y;

/** Adjust p1 toward p2 so it lands on the rect boundary (in place). */
function clipLineToRect(p1: Pt, p2: Pt, rect: Rect): void {
  const p1Inside = containsPt(rect, p1);
  const p2Inside = containsPt(rect, p2);

  // clip the line to two edges of the rect: y=cy (horizontal) and x=cx (vertical)
  let cx: number, cy: number;
  if (p1Inside && !p2Inside) {
    cx = p1.x < p2.x ? right(rect) : left(rect);
    cy = p1.y < p2.y ? bottom(rect) : top(rect);
  } else if (!p1Inside && !p2Inside) {
    cx = p1.x < p2.x ? right(rect) : left(rect);
    cy = p1.y < p2.y ? bottom(rect) : top(rect);
  } else {
    cx = p1.x < p2.x ? left(rect) : right(rect);
    cy = p1.y < p2.y ? top(rect) : bottom(rect);
  }

  if (p1.x === p2.x) {
    if (p1.x < left(rect)) p1.x = left(rect);
    if (p1.x > right(rect)) p1.x = right(rect);
    if (p1.x !== left(rect) && p1.x !== right(rect)) p1.y = cy;
    return;
  }
  if (p1.y === p2.y) {
    if (p1.y < top(rect)) p1.y = top(rect);
    if (p1.y > bottom(rect)) p1.y = bottom(rect);
    if (p1.y !== top(rect) && p1.y !== bottom(rect)) p1.x = cx;
    return;
  }

  // write the line as y = ax + b
  const a = (p2.y - p1.y) / (p2.x - p1.x);
  const b = p1.y - a * p1.x;
  const xx = (cy - b) / a; // on the y=cy edge
  const yy = a * cx + b; // on the x=cx edge

  if (xx >= left(rect) && xx <= right(rect)) {
    p1.x = xx;
    p1.y = cy;
  } else if (yy >= top(rect) && yy <= bottom(rect)) {
    p1.x = cx;
    p1.y = yy;
  } else {
    p1.x = cx;
    p1.y = cy;
  }
}

/** Containment case: route from the inner rect's edge to the outer rect's edge. */
function arrowcoordsContained(
  innerRect: Rect, outerRect: Rect, bundleI: number, bundleN: number, srcDir?: string,
): Pt[] {
  let dir = srcDir;
  if (!dir) {
    // auto: pick the nearest border
    const t = top(innerRect) - top(outerRect);
    const b = bottom(outerRect) - bottom(innerRect);
    const l = left(innerRect) - left(outerRect);
    const r = right(outerRect) - right(innerRect);
    if (t <= b && t <= l && t <= r) dir = 'n';
    else if (r <= b && r <= l && r <= t) dir = 'e';
    else if (l <= b && l <= r && l <= t) dir = 'w';
    else dir = 's';
  }

  // E/W: connection points shifted vertically by bundle index; N/S: horizontally
  let srcX = 0, srcY = 0, destX = 0, destY = 0;
  switch (dir) {
    case 'n':
      srcX = destX = left(innerRect) + ((bundleI + 1) * innerRect.width) / (bundleN + 1);
      srcY = top(innerRect);
      destY = top(outerRect);
      break;
    case 's':
      srcX = destX = left(innerRect) + ((bundleI + 1) * innerRect.width) / (bundleN + 1);
      srcY = bottom(innerRect);
      destY = bottom(outerRect);
      break;
    case 'e':
      srcX = right(innerRect);
      destX = right(outerRect);
      srcY = destY = top(innerRect) + ((bundleI + 1) * innerRect.height) / (bundleN + 1);
      break;
    case 'w':
      srcX = left(innerRect);
      destX = left(outerRect);
      srcY = destY = top(innerRect) + ((bundleI + 1) * innerRect.height) / (bundleN + 1);
      break;
  }
  return [{ x: srcX, y: srcY }, { x: destX, y: destY }];
}

/**
 * Adjust two intervals so they are the same size (at least half of the
 * smaller) and overlap as much as possible, without expanding either — a
 * "specialized intersection with a lower bound on size".
 */
function junctionRect(smaller: [number, number], larger: [number, number]): void {
  const smallerS = smaller[1] - smaller[0];
  const int1 = Math.max(smaller[0], larger[0]);
  const int2 = Math.min(smaller[1], larger[1]);
  const intS = int2 - int1;
  if (intS >= smallerS / 2) {
    smaller[0] = int1;
    smaller[1] = int2;
    larger[0] = int1;
    larger[1] = int2;
  } else {
    const finalS = Math.max(smallerS / 2, intS);
    if (smaller[0] < larger[0]) {
      smaller[0] = smaller[1] - finalS;
      larger[1] = larger[0] + finalS;
    } else {
      smaller[1] = smaller[0] + finalS;
      larger[0] = larger[1] - finalS;
    }
  }
}

/** Distance of `point` from the line through the origin with unit direction `dir`. */
function perpendicularDistance(dir: Pt, point: Pt): number {
  return Math.abs(dir.y * point.x - dir.x * point.y);
}

/**
 * Compute the polyline (2 or 3 points) for a connection between two module
 * bounding rectangles. `bundleI`/`bundleN` spread parallel connections of the
 * same module pair (`coeff = (i+1)/(n+1)`).
 */
export function arrowcoords(
  srcRect: Rect, destRect: Rect, bundleI = 0, bundleN = 1, constraint: RoutingConstraint = {},
): Pt[] {
  let srcDir: string | undefined = constraint.srcDir === 'a' ? undefined : constraint.srcDir;
  let destDir: string | undefined = constraint.destDir;

  const rel: 'same' | 'srcWithinDest' | 'destWithinSrc' | 'overlapping' | 'disjoint' =
    sameRect(srcRect, destRect) ? 'same' :
    containsRect(srcRect, destRect) ? 'destWithinSrc' :
    containsRect(destRect, srcRect) ? 'srcWithinDest' :
    intersects(srcRect, destRect) ? 'overlapping' : 'disjoint';

  // --- manual mode ---
  if (srcDir === 'm') {
    const src: Pt = {
      x: left(srcRect) + ((constraint.srcAnchX ?? 50) * srcRect.width) / 100,
      y: top(srcRect) + ((constraint.srcAnchY ?? 50) * srcRect.height) / 100,
    };
    const dest: Pt = {
      x: left(destRect) + ((constraint.destAnchX ?? 50) * destRect.width) / 100,
      y: top(destRect) + ((constraint.destAnchY ?? 50) * destRect.height) / 100,
    };
    if (rel !== 'overlapping') {
      clipLineToRect(src, dest, srcRect);
      clipLineToRect(dest, src, destRect);
    }
    return [src, dest];
  }

  const bundleCoeff = (bundleI + 1) / (bundleN + 1);

  // --- containment ---
  if (rel === 'srcWithinDest') return arrowcoordsContained(srcRect, destRect, bundleI, bundleN, srcDir);
  if (rel === 'destWithinSrc') return arrowcoordsContained(destRect, srcRect, bundleI, bundleN, srcDir).reverse();

  // --- same rect ---
  if (rel === 'same') {
    let dir = srcDir;
    if (dir === 'e' || dir === 'w') dir = 'h';
    if (dir === 'n' || dir === 's') dir = 'v';
    if (dir !== 'h' && dir !== 'v') dir = undefined;
    if (!dir) dir = srcRect.height > srcRect.width ? 'h' : 'v';
    if (dir === 'h') {
      const y = top(srcRect) + bundleCoeff * srcRect.height;
      return [{ x: left(srcRect), y }, { x: right(srcRect), y }];
    }
    const x = left(srcRect) + bundleCoeff * srcRect.width;
    return [{ x, y: top(srcRect) }, { x, y: bottom(srcRect) }];
  }

  // --- disjoint / overlapping ---
  const srcCenter = center(srcRect);
  const destCenter = center(destRect);

  // normalize cardinal directions to axes
  if (srcDir === 'e' || srcDir === 'w') srcDir = 'h';
  if (srcDir === 'n' || srcDir === 's') srcDir = 'v';
  if (destDir === 'e' || destDir === 'w') destDir = 'h';
  if (destDir === 'n' || destDir === 's') destDir = 'v';

  // same-axis combinations (h,h / v,v) cannot form an L-shape
  if (srcDir !== undefined && srcDir === destDir) {
    srcDir = undefined;
    destDir = undefined;
  }

  // --- rule 1: overlap ---
  const OVERLAP_THRESHOLD = 10;
  const yOverlapTop = Math.max(top(srcRect), top(destRect));
  const yOverlap = Math.min(bottom(srcRect), bottom(destRect)) - yOverlapTop;
  const xOverlapLeft = Math.max(left(srcRect), left(destRect));
  const xOverlap = Math.min(right(srcRect), right(destRect)) - xOverlapLeft;

  if (yOverlap >= OVERLAP_THRESHOLD) {
    const y = yOverlapTop + bundleCoeff * yOverlap;
    return destCenter.x >= srcCenter.x
      ? [{ x: right(srcRect), y }, { x: left(destRect), y }]
      : [{ x: left(srcRect), y }, { x: right(destRect), y }];
  }
  if (xOverlap >= OVERLAP_THRESHOLD) {
    const x = xOverlapLeft + bundleCoeff * xOverlap;
    return destCenter.y >= srcCenter.y
      ? [{ x, y: bottom(srcRect) }, { x, y: top(destRect) }]
      : [{ x, y: top(srcRect) }, { x, y: bottom(destRect) }];
  }

  // --- rule 2: L-shape ---
  if (srcDir !== undefined || destDir !== undefined) {
    let srcEdge: string;
    let destEdge: string;
    if (srcDir === 'h') srcEdge = destCenter.x >= srcCenter.x ? 'e' : 'w';
    else if (srcDir === 'v') srcEdge = destCenter.y >= srcCenter.y ? 's' : 'n';
    else if (destDir === 'h') srcEdge = destCenter.y >= srcCenter.y ? 's' : 'n';
    else srcEdge = destCenter.x >= srcCenter.x ? 'e' : 'w';

    if (destDir === 'h') destEdge = srcCenter.x >= destCenter.x ? 'e' : 'w';
    else if (destDir === 'v') destEdge = srcCenter.y >= destCenter.y ? 's' : 'n';
    else if (srcDir === 'h') destEdge = srcCenter.y >= destCenter.y ? 's' : 'n';
    else destEdge = srcCenter.x >= destCenter.x ? 'e' : 'w';

    const edgePoint = (rect: Rect, edge: string): Pt => {
      switch (edge) {
        case 'e': return { x: right(rect), y: top(rect) + bundleCoeff * rect.height };
        case 'w': return { x: left(rect), y: top(rect) + bundleCoeff * rect.height };
        case 's': return { x: left(rect) + bundleCoeff * rect.width, y: bottom(rect) };
        default: return { x: left(rect) + bundleCoeff * rect.width, y: top(rect) };
      }
    };
    const src = edgePoint(srcRect, srcEdge);
    const dest = edgePoint(destRect, destEdge);

    const srcIsHorizontal = srcEdge === 'e' || srcEdge === 'w';
    const bend: Pt = srcIsHorizontal ? { x: dest.x, y: src.y } : { x: src.x, y: dest.y };
    if (samePt(bend, src) || samePt(bend, dest)) return [src, dest]; // degenerate L
    return [src, bend, dest];
  }

  // --- rule 3: fallback, straight line between junction rects ---
  const srcX: [number, number] = [left(srcRect), right(srcRect)];
  const destX: [number, number] = [left(destRect), right(destRect)];
  if (srcRect.width < destRect.width) junctionRect(srcX, destX);
  else junctionRect(destX, srcX);

  const srcY: [number, number] = [top(srcRect), bottom(srcRect)];
  const destY: [number, number] = [top(destRect), bottom(destRect)];
  if (srcRect.height < destRect.height) junctionRect(srcY, destY);
  else junctionRect(destY, srcY);

  const srcWire: Rect = { x: srcX[0], y: srcY[0], width: srcX[1] - srcX[0], height: srcY[1] - srcY[0] };
  const destWire: Rect = { x: destX[0], y: destY[0], width: destX[1] - destX[0], height: destY[1] - destY[0] };

  let src = center(srcWire);
  let dest = center(destWire);
  if (samePt(src, dest)) {
    src = center(srcRect);
    dest = center(destRect);
  }
  if (samePt(src, dest)) dest = { x: dest.x + 1, y: dest.y };

  const len = Math.hypot(dest.x - src.x, dest.y - src.y);
  const dir: Pt = len === 0 ? { x: 0, y: 0 } : { x: (dest.x - src.x) / len, y: (dest.y - src.y) / len };
  const spread = Math.max(
    perpendicularDistance(dir, { x: srcWire.width, y: srcWire.height }),
    perpendicularDistance(dir, { x: -srcWire.width, y: srcWire.height }),
  );

  let normDir: Pt = { x: dir.y, y: -dir.x };
  if (dir.x < dir.y || (dir.x === dir.y && normDir.x < normDir.y)) normDir = { x: -normDir.x, y: -normDir.y };

  const offs = spread * (bundleCoeff - 0.5);
  src = { x: src.x + normDir.x * offs, y: src.y + normDir.y * offs };
  dest = { x: dest.x + normDir.x * offs, y: dest.y + normDir.y * offs };

  if (rel === 'disjoint') {
    clipLineToRect(src, dest, srcRect);
    clipLineToRect(dest, src, destRect);
  }
  return [src, dest];
}
