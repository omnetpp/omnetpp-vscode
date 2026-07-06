/**
 * Usage/inheritance diagram rendering for the documentation generator: small
 * directed graphs drawn with the built-in layered layout and the exact node
 * colors / edge styles of the Eclipse generator's graphviz output
 * (DocumentationGenerator.DotGraph): yellow modules, blue networks, green
 * channels, dashed interface borders; hollow-triangle inheritance arrowheads
 * at the supertype end, dashed interface-implementation edges, filled
 * arrowheads on usage edges.
 *
 * Browser-safe: pure math + strings, no Node/vscode imports.
 */

import { SvgBuilder } from '../graphics/svgBuilder';
import { approxTextWidth } from '../graphics/textMetrics';
import type { LinkArea, RenderedSvg } from '../graphics/diagramSvg';
import { layeredLayout, type LayeredEdge, type LayeredNode } from './layeredLayout';

export interface DocGraphNode {
  /** Page id of the type (or a synthetic id for unresolved names). */
  id: string;
  label: string;
  /** NED/MSG type kind, or 'unresolved'. */
  kind: string;
  /** The page's own type: highlighted fill. */
  focus?: boolean;
  tooltip?: string;
}

export interface DocGraphEdge {
  /** inheritance/interface: src = supertype; usage: src = user. */
  src: string;
  dest: string;
  kind: 'inheritance' | 'interface' | 'usage';
}

export interface DocGraph {
  nodes: DocGraphNode[];
  edges: DocGraphEdge[];
}

export interface GraphDiagramOptions {
  /** href for a node id (undefined = no link). */
  hrefFor?: (id: string) => string | undefined;
  measureText?: (text: string, sizePx: number) => number;
}

// Eclipse DotGraph node colors: [focus, neighbor]
const NODE_COLORS: Record<string, [string, string]> = {
  network: ['#9090ff', '#d0d0ff'],
  struct: ['#9090ff', '#d0d0ff'],
  compound: ['#fff700', '#fffcaf'],
  simple: ['#fff700', '#fffcaf'],
  moduleinterface: ['#fff700', '#fffcaf'],
  message: ['#fff700', '#fffcaf'],
  packet: ['#fff700', '#fffcaf'],
  class: ['#fff700', '#fffcaf'],
  channel: ['#90ff90', '#d0ffd0'],
  channelinterface: ['#90ff90', '#d0ffd0'],
  enum: ['#90ff90', '#d0ffd0'],
  unresolved: ['#ff0000', '#ff0000'],
};

const FONT_SIZE = 10; // dot: fontsize=10
const NODE_H = 24; // ~ dot's height=.25in at 96dpi
const PAD_X = 8;
const MARGIN = 8;

export function renderGraphDiagramSvg(graph: DocGraph, opts: GraphDiagramOptions = {}): RenderedSvg {
  const measure = opts.measureText ?? approxTextWidth;
  const layoutNodes: LayeredNode[] = graph.nodes.map((n) => ({
    id: n.id,
    width: Math.max(40, measure(n.label, FONT_SIZE) + 2 * PAD_X),
    height: NODE_H,
  }));
  const layoutEdges: LayeredEdge[] = graph.edges.map((e) => ({ src: e.src, dest: e.dest }));
  const layout = layeredLayout(layoutNodes, layoutEdges);

  const width = layout.width + 2 * MARGIN;
  const height = layout.height + 2 * MARGIN;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const sizeById = new Map(layoutNodes.map((n) => [n.id, n]));

  const b = new SvgBuilder();
  b.open('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    style: `font: ${FONT_SIZE}px Helvetica, Arial, sans-serif`,
  });

  // edges under nodes
  for (const edge of graph.edges) {
    const src = layout.pos.get(edge.src);
    const dest = layout.pos.get(edge.dest);
    const srcSize = sizeById.get(edge.src);
    const destSize = sizeById.get(edge.dest);
    if (!src || !dest || !srcSize || !destSize) continue;
    // connect box borders along the src-bottom -> dest-top axis; when ranks
    // are equal (rare), fall back to a straight center line
    const downward = dest.y > src.y;
    const from = {
      x: src.x + MARGIN,
      y: src.y + (downward ? srcSize.height / 2 : -srcSize.height / 2) + MARGIN,
    };
    const to = {
      x: dest.x + MARGIN,
      y: dest.y + (downward ? -destSize.height / 2 : destSize.height / 2) + MARGIN,
    };
    const dashed = edge.kind === 'interface';
    const attrs: Record<string, string | number> = { stroke: '#404040', 'stroke-width': 1, fill: 'none' };
    if (dashed) attrs['stroke-dasharray'] = '4 2';

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;

    if (edge.kind === 'usage') {
      // filled arrowhead at the dest (used type) end
      const L = 8;
      const W = 3.5;
      b.el('line', { x1: from.x, y1: from.y, x2: to.x - ux * L, y2: to.y - uy * L, ...attrs });
      const bx = to.x - L * ux;
      const by = to.y - L * uy;
      b.el('polygon', {
        points: `${to.x},${to.y} ${bx - W * uy},${by + W * ux} ${bx + W * uy},${by - W * ux}`,
        fill: '#404040',
      });
    } else {
      // hollow triangle at the src (supertype) end — UML generalization
      const L = 10;
      const W = 5;
      b.el('line', { x1: from.x + ux * L, y1: from.y + uy * L, x2: to.x, y2: to.y, ...attrs });
      const bx = from.x + L * ux;
      const by = from.y + L * uy;
      b.el('polygon', {
        points: `${from.x},${from.y} ${bx - W * uy},${by + W * ux} ${bx + W * uy},${by - W * ux}`,
        fill: 'white',
        stroke: '#404040',
        'stroke-width': 1,
      });
    }
  }

  // nodes
  const areas: LinkArea[] = [];
  for (const layoutNode of layoutNodes) {
    const node = nodeById.get(layoutNode.id)!;
    const pos = layout.pos.get(node.id)!;
    const cx = pos.x + MARGIN;
    const cy = pos.y + MARGIN;
    const [focusColor, plainColor] = NODE_COLORS[node.kind] ?? ['#dedede', '#f0f0f0'];
    const isInterface = node.kind === 'moduleinterface' || node.kind === 'channelinterface';
    const href = opts.hrefFor?.(node.id);
    if (href) b.open('a', { href });
    b.open('g');
    if (node.tooltip) b.el('title', {}, node.tooltip);
    const rectAttrs: Record<string, string | number> = {
      x: cx - layoutNode.width / 2,
      y: cy - layoutNode.height / 2,
      width: layoutNode.width,
      height: layoutNode.height,
      fill: node.focus ? focusColor : plainColor,
      stroke: 'black',
      'stroke-width': 1,
    };
    if (isInterface) rectAttrs['stroke-dasharray'] = '4 2';
    b.el('rect', rectAttrs);
    b.el(
      'text',
      { x: cx, y: cy + FONT_SIZE / 2 - 1.5, 'text-anchor': 'middle', 'font-size': FONT_SIZE, fill: 'black' },
      node.label,
    );
    b.close();
    if (href) b.close();
    areas.push({
      x: cx - layoutNode.width / 2,
      y: cy - layoutNode.height / 2,
      width: layoutNode.width,
      height: layoutNode.height,
      targetFqName: node.id,
      href,
      tooltip: node.tooltip ?? node.label,
    });
  }

  b.close();
  return { svg: b.toString(), width, height, areas };
}
