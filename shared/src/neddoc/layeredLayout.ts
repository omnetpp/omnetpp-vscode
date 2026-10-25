/**
 * Minimal layered ("Sugiyama-lite") graph layout for the documentation
 * generator's usage/inheritance diagrams — the self-contained replacement
 * for the graphviz `dot` invocation the Eclipse generator shells out to.
 * Longest-path ranking, a few median-heuristic ordering sweeps, and
 * median-pull x placement: plenty for the small star/chain graphs these
 * diagrams are (per-type graphs are a focus node plus direct neighbors).
 *
 * Browser-safe: pure math, no Node/vscode imports.
 */

export interface LayeredNode {
  id: string;
  width: number;
  height: number;
}

export interface LayeredEdge {
  src: string;
  dest: string;
}

export interface LayeredOptions {
  /** Vertical gap between ranks (default 36). */
  rankSep?: number;
  /** Horizontal gap between nodes of a rank (default 24). */
  nodeSep?: number;
}

export interface LayeredResult {
  /** Node center positions. */
  pos: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

export function layeredLayout(nodes: LayeredNode[], edges: LayeredEdge[], opts: LayeredOptions = {}): LayeredResult {
  const rankSep = opts.rankSep ?? 36;
  const nodeSep = opts.nodeSep ?? 24;
  const result: LayeredResult = { pos: new Map(), width: 0, height: 0 };
  if (nodes.length === 0) return result;

  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const out: number[][] = nodes.map(() => []);
  const inn: number[][] = nodes.map(() => []);

  // drop unknown endpoints and self loops; reverse back edges (cycle guard)
  const state = new Array<number>(nodes.length).fill(0); // 0 new, 1 open, 2 done
  const usable = edges
    .map((e) => ({ src: index.get(e.src), dest: index.get(e.dest) }))
    .filter((e): e is { src: number; dest: number } => e.src !== undefined && e.dest !== undefined && e.src !== e.dest);
  const adj: number[][] = nodes.map(() => []);
  for (const e of usable) adj[e.src].push(e.dest);
  const openStack: boolean[] = new Array(nodes.length).fill(false);
  const isBackEdge = new Set<string>();
  const dfs = (v: number): void => {
    state[v] = 1;
    openStack[v] = true;
    for (const w of adj[v]) {
      if (state[w] === 0) dfs(w);
      else if (openStack[w]) isBackEdge.add(`${v}>${w}`);
    }
    openStack[v] = false;
    state[v] = 2;
  };
  for (let v = 0; v < nodes.length; v++) if (state[v] === 0) dfs(v);
  for (const e of usable) {
    const [s, d] = isBackEdge.has(`${e.src}>${e.dest}`) ? [e.dest, e.src] : [e.src, e.dest];
    out[s].push(d);
    inn[d].push(s);
  }

  // longest-path ranking (sources at rank 0)
  const rank = new Array<number>(nodes.length).fill(0);
  const visited = new Array<boolean>(nodes.length).fill(false);
  const assign = (v: number): number => {
    if (visited[v]) return rank[v];
    visited[v] = true; // pre-mark: cycles were removed, this is belt-and-braces
    let r = 0;
    for (const p of inn[v]) r = Math.max(r, assign(p) + 1);
    rank[v] = r;
    return r;
  };
  for (let v = 0; v < nodes.length; v++) assign(v);

  // group by rank, initial order = node order
  const maxRank = Math.max(...rank);
  const ranks: number[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (let v = 0; v < nodes.length; v++) ranks[rank[v]].push(v);

  // ordering: alternate down/up sweeps of the median heuristic
  const orderOf = new Array<number>(nodes.length).fill(0);
  const refreshOrder = (): void => {
    for (const row of ranks) row.forEach((v, i) => (orderOf[v] = i));
  };
  refreshOrder();
  const median = (values: number[]): number =>
    values.length === 0 ? Number.NaN : values.slice().sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)];
  for (let pass = 0; pass < 4; pass++) {
    const down = pass % 2 === 0;
    for (let r = down ? 1 : maxRank - 1; down ? r <= maxRank : r >= 0; down ? r++ : r--) {
      const neighbors = down ? inn : out;
      const keys = ranks[r].map((v) => {
        const m = median(neighbors[v].map((n) => orderOf[n]));
        return { v, key: Number.isNaN(m) ? orderOf[v] : m };
      });
      keys.sort((a, b) => a.key - b.key || orderOf[a.v] - orderOf[b.v]);
      ranks[r] = keys.map((k) => k.v);
      refreshOrder();
    }
  }

  // x placement: alternate down/up sweeps that move each node toward the
  // median of its neighbors in the rank already placed, then fit the rank to
  // those targets with the least total displacement that keeps the order and
  // spacing (isotonic regression). Overlaps are thus resolved symmetrically, so
  // a fan-out centers under its parent; the final up sweep centers parents.
  const x = new Array<number>(nodes.length).fill(0);
  for (const row of ranks) {
    let cursor = 0;
    for (const v of row) {
      x[v] = cursor + nodes[v].width / 2;
      cursor = x[v] + nodes[v].width / 2 + nodeSep;
    }
  }
  const centerMedian = (values: number[]): number => {
    const s = values.slice().sort((a, b) => a - b);
    return (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2;
  };
  const fitRank = (row: number[], target: number[]): void => {
    const offset: number[] = [0];
    for (let i = 1; i < row.length; i++)
      offset[i] = offset[i - 1] + nodes[row[i - 1]].width / 2 + nodeSep + nodes[row[i]].width / 2;
    const blocks: { sum: number; count: number }[] = [];
    for (let i = 0; i < row.length; i++) {
      blocks.push({ sum: target[i] - offset[i], count: 1 });
      while (blocks.length > 1) {
        const last = blocks[blocks.length - 1];
        const prev = blocks[blocks.length - 2];
        if (prev.sum / prev.count < last.sum / last.count) break;
        prev.sum += last.sum;
        prev.count += last.count;
        blocks.pop();
      }
    }
    let i = 0;
    for (const block of blocks)
      for (let k = 0; k < block.count; k++, i++) x[row[i]] = block.sum / block.count + offset[i];
  };
  for (let pass = 0; pass < 4; pass++) {
    const down = pass % 2 === 0;
    const neighbors = down ? inn : out;
    for (let r = down ? 1 : maxRank - 1; down ? r <= maxRank : r >= 0; down ? r++ : r--) {
      const row = ranks[r];
      fitRank(
        row,
        row.map((v) => (neighbors[v].length ? centerMedian(neighbors[v].map((n) => x[n])) : x[v])),
      );
    }
  }

  // normalize to non-negative coordinates, compute y per rank
  let minX = Infinity;
  for (let v = 0; v < nodes.length; v++) minX = Math.min(minX, x[v] - nodes[v].width / 2);
  const rankHeights = ranks.map((row) => Math.max(0, ...row.map((v) => nodes[v].height)));
  const rankY: number[] = [];
  let yCursor = 0;
  for (let r = 0; r <= maxRank; r++) {
    rankY[r] = yCursor + rankHeights[r] / 2;
    yCursor += rankHeights[r] + rankSep;
  }
  let width = 0;
  for (let v = 0; v < nodes.length; v++) {
    const cx = x[v] - minX;
    result.pos.set(nodes[v].id, { x: cx, y: rankY[rank[v]] });
    width = Math.max(width, cx + nodes[v].width / 2);
  }
  result.width = width;
  result.height = yCursor - rankSep + (maxRank >= 0 ? 0 : 0);
  return result;
}
