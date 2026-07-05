/**
 * The classic OMNeT++ submodule layouter: a faithful TypeScript port of
 * `src/layout/basicspringembedderlayout.cc` and its RNG
 * (`src/common/lcgrandom.cc`) from the OMNeT++ source tree. Given the same
 * seed and the same graph (same insertion order), it produces the same
 * layout as the Eclipse IDE's graphical NED editor and Qtenv.
 *
 * Browser-safe: pure math, no Node/vscode imports.
 */

const GLRAND_MAX = 0x7ffffffe; // 2^31 - 2

/** Park–Miller MINSTD linear congruential RNG (port of LCGRandom). */
export class LcgRandom {
  private seed = 1;

  constructor(seed = 1) {
    this.setSeed(seed);
  }

  getSeed(): number {
    return this.seed;
  }

  setSeed(seed: number): void {
    if (seed < 1 || seed > GLRAND_MAX) throw new Error(`LcgRandom: invalid seed: ${seed}`);
    this.seed = seed;
    this.next01(); // consume one value, so that small seeds work correctly
  }

  next01(): number {
    // all intermediates stay well below 2^53, so double arithmetic is exact
    const a = 16807, q = 127773, r = 2836;
    this.seed = a * (this.seed % q) - r * Math.trunc(this.seed / q);
    if (this.seed <= 0) this.seed += GLRAND_MAX + 1;
    return this.seed / (GLRAND_MAX + 1);
  }

  /** Port of LCGRandom::selfTest — golden-value check of the generator. */
  selfTest(): boolean {
    this.seed = 1;
    for (let i = 0; i < 10000; i++) this.next01();
    return this.seed === 1043618065;
  }
}

interface Anchor {
  name: string;
  refcount: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  x1off: number;
  y1off: number;
  x2off: number;
  y2off: number;
}

interface LayoutNode {
  nodeId: number;
  fixed: boolean;
  anchor?: Anchor;
  x: number;
  y: number;
  offx: number;
  offy: number;
  sx: number; // half width
  sy: number; // half height
  vx: number;
  vy: number;
  color: number;
  connectedToFixed: boolean;
}

interface LayoutEdge {
  src: LayoutNode;
  dest: LayoutNode;
  len: number;
}

export interface SpringEmbedderOptions {
  /** Layout area (bgb size); 0 = unspecified. Must be ≥ 2*border when given. */
  width?: number;
  height?: number;
  border?: number;
  repulsiveForce?: number;
  attractionForce?: number;
  defaultEdgeLen?: number;
  maxIterations?: number;
}

/**
 * Port of BasicSpringEmbedderLayout. Usage mirrors the C++ API: add nodes and
 * edges (insertion order matters for reproducibility!), `execute()`, then read
 * positions (node centers) back with `getNodePosition()`.
 */
export class BasicSpringEmbedderLayout {
  private readonly rand: LcgRandom;
  private readonly nodes: LayoutNode[] = [];
  private readonly nodeMap = new Map<number, LayoutNode>();
  private readonly edges: LayoutEdge[] = [];
  private readonly anchors: Anchor[] = [];

  private haveFixedNode = false;
  private haveAnchoredNode = false;
  private allNodesAreFixed = true;

  private readonly width: number;
  private readonly height: number;
  private readonly border: number;
  private readonly repulsiveForce: number;
  private readonly attractionForce: number;
  private readonly defaultEdgeLen: number;
  private readonly maxIterations: number;

  private minx = 0;
  private miny = 0;
  private maxx = 0;
  private maxy = 0;

  constructor(seed = 1, options: SpringEmbedderOptions = {}) {
    this.rand = new LcgRandom(seed);
    this.width = options.width ?? 0;
    this.height = options.height ?? 0;
    this.border = options.border ?? 0;
    this.repulsiveForce = options.repulsiveForce ?? 50;
    this.attractionForce = options.attractionForce ?? 0.3;
    this.defaultEdgeLen = options.defaultEdgeLen ?? 40;
    this.maxIterations = options.maxIterations ?? 500;
    if (this.width !== 0 && this.width < 2 * this.border) throw new Error('width smaller than 2*border');
    if (this.height !== 0 && this.height < 2 * this.border) throw new Error('height smaller than 2*border');
  }

  getSeed(): number {
    return this.rand.getSeed();
  }

  addMovableNode(nodeId: number, width: number, height: number): void {
    this.allNodesAreFixed = false;
    this.putNode({
      nodeId, fixed: false, x: 0, y: 0, offx: 0, offy: 0,
      sx: width / 2, sy: height / 2, vx: 0, vy: 0, color: -1, connectedToFixed: false,
    });
  }

  /** (x,y) is the center of the node. */
  addFixedNode(nodeId: number, x: number, y: number, width: number, height: number): void {
    this.haveFixedNode = true;
    this.putNode({
      nodeId, fixed: true, x, y, offx: 0, offy: 0,
      sx: width / 2, sy: height / 2, vx: 0, vy: 0, color: -1, connectedToFixed: false,
    });
  }

  /** Nodes anchored to the same (named) anchor point can only move together. */
  addAnchoredNode(nodeId: number, anchorName: string, offx: number, offy: number, width: number, height: number): void {
    this.haveAnchoredNode = true;
    this.allNodesAreFixed = false;
    let anchor = this.anchors.find((a) => a.name === anchorName);
    if (!anchor) {
      anchor = { name: anchorName, refcount: 0, x: 0, y: 0, vx: 0, vy: 0, x1off: 0, y1off: 0, x2off: 0, y2off: 0 };
      this.anchors.push(anchor);
    }
    anchor.refcount++;
    this.putNode({
      nodeId, fixed: false, anchor, x: 0, y: 0, offx, offy,
      sx: width / 2, sy: height / 2, vx: 0, vy: 0, color: -1, connectedToFixed: false,
    });
  }

  addEdge(srcNodeId: number, destNodeId: number, preferredLength = 0): void {
    const src = this.nodeMap.get(srcNodeId)!;
    const dest = this.nodeMap.get(destNodeId)!;
    let len = preferredLength > 0 ? preferredLength : this.defaultEdgeLen;
    // heuristics to take submodule size into account
    len += Math.min(src.sx, src.sy) / 2 + Math.min(dest.sx, dest.sy) / 2;
    this.edges.push({ src, dest, len });
  }

  addEdgeToBorder(_srcNodeId: number, _preferredLength = 0): void {
    // this layouter algorithm ignores connections to the border
  }

  getNodePosition(nodeId: number): { x: number; y: number } {
    const n = this.nodeMap.get(nodeId)!;
    return { x: n.x, y: n.y };
  }

  private putNode(node: LayoutNode): void {
    if (this.nodeMap.has(node.nodeId)) throw new Error(`duplicate node id ${node.nodeId}`);
    this.nodes.push(node);
    this.nodeMap.set(node.nodeId, node);
  }

  execute(): void {
    if (this.nodes.length === 0 || this.allNodesAreFixed) return;

    this.computeAnchorBoundingBoxes();
    this.assignInitialPositions();

    if (!this.haveFixedNode) {
      // layout on an infinite area; nodes are scaled/shifted into the box afterwards
      this.minx = -100000000;
      this.miny = -100000000;
      this.maxx = 100000000;
      this.maxy = 100000000;
    } else {
      // top-left corner is assumed to be (0,0) — the bgp tag is not implemented
      this.minx = this.border;
      this.miny = this.border;
      this.maxx = this.width === 0 ? 100000000 : this.width - this.border;
      this.maxy = this.height === 0 ? 100000000 : this.height - this.border;
    }

    this.doColoring();
    this.markNodesConnectedToFixed();

    // stop if the max moved distance is <0.05 at least 20 times in a row
    let maxdCounter = 0;
    for (let i = 1; i < this.maxIterations && maxdCounter < 20; i++) {
      const maxd = this.relax();
      maxdCounter = maxd < 0.05 ? maxdCounter + 1 : 0;
    }

    if (!this.haveFixedNode) {
      // scale back into the given area — only without fixed/anchored nodes,
      // as explicit coordinates (and anchor spacings) must not be distorted
      const bb = this.boundingBox(() => true);
      const xfact = this.width === 0 || bb.x1 === bb.x2 || this.haveAnchoredNode ? 1 : (this.width - 2 * this.border) / (bb.x2 - bb.x1);
      const yfact = this.height === 0 || bb.y1 === bb.y2 || this.haveAnchoredNode ? 1 : (this.height - 2 * this.border) / (bb.y2 - bb.y1);
      for (const n of this.nodes) {
        n.x = this.border + (n.x - bb.x1) * xfact;
        n.y = this.border + (n.y - bb.y1) * yfact;
      }
    } else if (this.width === 0 && this.height === 0) {
      // nodes not connected to any fixed node were allowed to escape top/left; shift them back
      const bb = this.boundingBox((n) => !n.connectedToFixed);
      const dx = bb.x1 < this.border ? this.border - bb.x1 : 0;
      const dy = bb.y1 < this.border ? this.border - bb.y1 : 0;
      for (const n of this.nodes) {
        if (!n.connectedToFixed) {
          n.x += dx;
          n.y += dy;
        }
      }
    }
  }

  private assignInitialPositions(): void {
    // distribute non-fixed nodes over the area occupied by fixed nodes or an
    // area sized from the node count (60x60 px per node), whichever is larger
    let areaWidth: number, areaHeight: number, offsetX: number, offsetY: number;

    if (this.width !== 0 && this.height !== 0) {
      areaWidth = this.width - 2 * this.border;
      areaHeight = this.height - 2 * this.border;
      offsetX = offsetY = this.border;
    } else {
      const area = Math.max(60 * 60 * this.nodes.length, 600 * 400);
      const aspectRatio = 1.5;
      areaWidth = Math.sqrt(area) * aspectRatio;
      areaHeight = Math.sqrt(area) / aspectRatio;
      const margin = 0.25 * Math.min(areaWidth, areaHeight);
      offsetX = offsetY = margin; // leave some space top/left so movable nodes aren't pushed against the wall
      if (this.haveFixedNode) {
        const bb = this.boundingBox((n) => n.fixed);
        // shrink the fixed-node bounding box somewhat so nodes are not placed near its borders
        const xmargin = Math.min(150, (bb.x2 - bb.x1) / 2);
        const ymargin = Math.min(150, (bb.y2 - bb.y1) / 2);
        const x1 = bb.x1 + xmargin, x2 = bb.x2 - xmargin;
        const y1 = bb.y1 + ymargin, y2 = bb.y2 - ymargin;
        const right = Math.max(x2, offsetX + areaWidth);
        const bottom = Math.max(y2, offsetY + areaHeight);
        offsetX = Math.min(x1, offsetX);
        offsetY = Math.min(y1, offsetY);
        areaWidth = right - offsetX;
        areaHeight = bottom - offsetY;
      }
    }

    // randomize start positions over the initial area (RNG call order matters!)
    for (const a of this.anchors) {
      const bbWidth = a.x2off - a.x1off;
      const bbHeight = a.y2off - a.y1off;
      const left = offsetX + Math.max(0, areaWidth - bbWidth) * this.rand.next01();
      const top = offsetY + Math.max(0, areaHeight - bbHeight) * this.rand.next01();
      a.x = left - a.x1off;
      a.y = top - a.y1off;
      a.vx = a.vy = 0;
    }
    for (const n of this.nodes) {
      if (n.fixed) {
        // nop
      } else if (n.anchor) {
        n.x = n.anchor.x + n.offx;
        n.y = n.anchor.y + n.offy;
      } else {
        n.x = offsetX + areaWidth * this.rand.next01();
        n.y = offsetY + areaHeight * this.rand.next01();
      }
      n.vx = n.vy = 0;
    }
  }

  /** Color connected components (same traversal order as the C++ stack-based BFS). */
  private doColoring(): void {
    for (const n of this.nodes) n.color = -1;
    let currentColor = 0;
    const todo: LayoutNode[] = [];
    for (const start of this.nodes) {
      if (start.color !== -1) continue;
      todo.push(start);
      while (todo.length > 0) {
        const n = todo.pop()!;
        n.color = currentColor;
        for (const e of this.edges) {
          if (e.src === n && e.dest.color === -1) todo.push(e.dest);
          else if (e.dest === n && e.src.color === -1) todo.push(e.src);
        }
      }
      currentColor++;
    }
  }

  private markNodesConnectedToFixed(): void {
    const colorsWithFixed = new Set<number>();
    for (const n of this.nodes) if (n.fixed) colorsWithFixed.add(n.color);
    for (const n of this.nodes) n.connectedToFixed = colorsWithFixed.has(n.color);
  }

  private computeAnchorBoundingBoxes(): void {
    for (const a of this.anchors) {
      a.x1off = Infinity;
      a.y1off = Infinity;
      a.x2off = -Infinity;
      a.y2off = -Infinity;
    }
    for (const n of this.nodes) {
      const a = n.anchor;
      if (!a) continue;
      a.x1off = Math.min(a.x1off, n.offx - n.sx);
      a.y1off = Math.min(a.y1off, n.offy - n.sy);
      a.x2off = Math.max(a.x2off, n.offx + n.sx);
      a.y2off = Math.max(a.y2off, n.offy + n.sy);
    }
  }

  private boundingBox(predicate: (n: LayoutNode) => boolean): { x1: number; y1: number; x2: number; y2: number } {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const n of this.nodes) {
      if (!predicate(n)) continue;
      x1 = Math.min(x1, n.x - n.sx);
      y1 = Math.min(y1, n.y - n.sy);
      x2 = Math.max(x2, n.x + n.sx);
      y2 = Math.max(y2, n.y + n.sy);
    }
    return { x1, y1, x2, y2 };
  }

  /** One iteration of the physics loop; returns the max movement component. */
  private relax(): number {
    // edge attraction
    for (const e of this.edges) {
      if (e.src.fixed && e.dest.fixed) continue;
      if (e.src.anchor && e.src.anchor === e.dest.anchor) continue;
      const deltax = e.dest.x - e.src.x;
      const deltay = e.dest.y - e.src.y;
      let dist = Math.sqrt(deltax * deltax + deltay * deltay);
      dist = dist === 0 ? 1 : dist;
      const f = (this.attractionForce * (e.len - dist)) / dist;
      const vx = f * deltax;
      const vy = f * deltay;
      e.dest.vx += vx;
      e.dest.vy += vy;
      e.src.vx -= vx;
      e.src.vy -= vy;
    }

    // node repulsion; nodes of different components repulse only within 100 units,
    // so that unconnected networks do not blow up
    for (const n1 of this.nodes) {
      if (n1.fixed) continue;
      let fx = 0;
      let fy = 0;
      for (const n2 of this.nodes) {
        if (n1 === n2) continue;
        if (n1.anchor && n1.anchor === n2.anchor) continue;
        const deltax = n1.x - n2.x;
        const deltay = n1.y - n2.y;
        const distsq = deltax * deltax + deltay * deltay;
        if (n1.color === n2.color || distsq < 100 * 100) {
          if (distsq < 1.0) {
            // avoid division by (near) zero; random noise helps nodes move away from each other
            fx += deltax + this.rand.next01() - 0.5;
            fy += deltay + this.rand.next01() - 0.5;
          } else {
            fx += deltax / distsq;
            fy += deltay / distsq;
          }
        }
      }
      n1.vx += this.repulsiveForce * fx;
      n1.vy += this.repulsiveForce * fy;
    }

    const bgsizeGiven = this.width !== 0 || this.height !== 0;

    // move nodes by (vx,vy) limited to ±50; constrain into (minx,miny,maxx,maxy)
    let maxd = 0;
    for (const n of this.nodes) {
      if (!n.fixed && !n.anchor) {
        n.x += Math.max(-50, Math.min(50, n.vx));
        n.y += Math.max(-50, Math.min(50, n.vy));
        // without a bg size, nodes not connected to fixed ones may slip out top/left
        // (for a better layout); they are shifted back after the iterations
        const letThemOutTopLeft = !bgsizeGiven && !n.connectedToFixed;
        const minx2 = letThemOutTopLeft ? -100000000 : this.minx;
        const miny2 = letThemOutTopLeft ? -100000000 : this.miny;
        n.x = Math.max(minx2, Math.min(this.maxx, n.x));
        n.y = Math.max(miny2, Math.min(this.maxy, n.y));
      }
      if (maxd < n.vx) maxd = n.vx;
      if (maxd < n.vy) maxd = n.vy;
      // "friction": nodes stop eventually if not driven by a force
      n.vx /= 2;
      n.vy /= 2;
    }

    // anchors move by the average of their nodes' movements
    for (const a of this.anchors) {
      a.vx = 0;
      a.vy = 0;
    }
    for (const n of this.nodes) {
      if (n.anchor) {
        n.anchor.vx += n.vx / n.anchor.refcount;
        n.anchor.vy += n.vy / n.anchor.refcount;
      }
    }
    for (const a of this.anchors) {
      a.x += Math.max(-50, Math.min(50, a.vx));
      a.y += Math.max(-50, Math.min(50, a.vy));
      // check right/bottom first, so if room is too small, top/left gets aligned
      if (a.x + a.x2off > this.maxx) a.x = this.maxx - a.x2off;
      if (a.y + a.y2off > this.maxy) a.y = this.maxy - a.y2off;
      if (a.x + a.x1off < this.minx) a.x = this.minx - a.x1off;
      if (a.y + a.y1off < this.miny) a.y = this.miny - a.y1off;
      if (maxd < a.vx) maxd = a.vx;
      if (maxd < a.vy) maxd = a.vy;
      a.vx /= 2;
      a.vy /= 2;
    }

    // refresh positions of anchored nodes
    for (const n of this.nodes) {
      if (n.anchor) {
        n.x = n.anchor.x + n.offx;
        n.y = n.anchor.y + n.offy;
        n.vx = n.anchor.vx;
        n.vy = n.anchor.vy;
      }
    }

    return maxd;
  }
}
