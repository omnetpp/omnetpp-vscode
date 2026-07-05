import type { PreviewScene } from '@omnetpp/shared/protocol';
import type { BackgroundSpec, ConnFigure, DiagramModel, SubFigure } from './figures';
import { textWidth } from './figures';

/**
 * Renders a DiagramModel to an SVG element, layered like the IDE's
 * CompoundModuleFigure: background box → grid → background image → range
 * indicators → connections → submodules. Submodule/connection groups carry
 * data-* attributes for hit-testing and <title> tooltips.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const NAME_GAP = 2;
const FONT_SIZE = 12;

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

function addTitle(parent: Element, text: string): void {
  const t = document.createElementNS(SVG_NS, 'title');
  t.textContent = text;
  parent.appendChild(t);
}

function renderBackground(bg: BackgroundSpec, root: SVGElement): void {
  const rect = el('rect', {
    x: 0, y: 0, width: bg.width, height: bg.height,
    fill: bg.fill ?? 'none',
    stroke: bg.borderColor ?? 'none',
    'stroke-width': bg.borderWidth,
  }, root);
  if (bg.tooltip) addTitle(rect, bg.tooltip);

  if (bg.image) {
    const { icon, mode } = bg.image;
    if (mode === 'stretch') {
      el('image', { href: icon.dataUri, x: 0, y: 0, width: bg.width, height: bg.height, preserveAspectRatio: 'none' }, root);
    } else if (mode === 'center') {
      el('image', {
        href: icon.dataUri,
        x: (bg.width - icon.width) / 2, y: (bg.height - icon.height) / 2,
        width: icon.width, height: icon.height,
      }, root);
    } else if (mode === 'tile') {
      for (let y = 0; y < bg.height; y += icon.height) {
        for (let x = 0; x < bg.width; x += icon.width) {
          el('image', { href: icon.dataUri, x, y, width: icon.width, height: icon.height }, root);
        }
      }
    } else {
      el('image', { href: icon.dataUri, x: 0, y: 0, width: icon.width, height: icon.height }, root);
    }
  }

  if (bg.grid && bg.grid.distance > 0) {
    const g = el('g', { stroke: bg.grid.color, 'stroke-width': 1 }, root);
    const minor = el('g', { stroke: bg.grid.color, 'stroke-width': 1, 'stroke-dasharray': '1 3' }, root);
    const step = bg.grid.distance;
    const sub = Math.max(1, bg.grid.subdivision);
    for (let x = step; x < bg.width; x += step) {
      el('line', { x1: x, y1: 0, x2: x, y2: bg.height }, g);
      for (let i = 1; i < sub; i++) {
        const mx = x - (step * i) / sub;
        if (mx > 0) el('line', { x1: mx, y1: 0, x2: mx, y2: bg.height }, minor);
      }
    }
    for (let y = step; y < bg.height; y += step) {
      el('line', { x1: 0, y1: y, x2: bg.width, y2: y }, g);
      for (let i = 1; i < sub; i++) {
        const my = y - (step * i) / sub;
        if (my > 0) el('line', { x1: 0, y1: my, x2: bg.width, y2: my }, minor);
      }
    }
  }
}

function renderRange(f: SubFigure, root: SVGElement): void {
  if (!f.range) return;
  // IDE RangeFigure: fixed alpha 64/255 for both fill and outline
  const attrs: Record<string, string | number> = {
    cx: f.cx, cy: f.cy, r: f.range.radius, opacity: 64 / 255, fill: 'none',
  };
  if (f.range.fill) attrs.fill = f.range.fill;
  if (f.range.borderColor && f.range.borderWidth > 0) {
    attrs.stroke = f.range.borderColor;
    attrs['stroke-width'] = f.range.borderWidth;
  }
  el('circle', attrs, root);
}

function dashArray(style: ConnFigure['style'], width: number): string | undefined {
  const w = Math.max(1, width);
  if (style === 'dashed') return `${4 * w} ${2 * w}`;
  if (style === 'dotted') return `${w} ${w}`;
  return undefined;
}

function renderConnection(c: ConnFigure, root: SVGElement): void {
  const g = el('g', { 'data-conn': c.index, cursor: 'pointer' }, root);
  addTitle(g, c.tooltip);
  const stroke: Record<string, string | number> = {
    stroke: c.color,
    'stroke-width': c.faint ? 1 : c.width,
    fill: 'none',
  };
  if (c.faint) stroke.opacity = 16 / 255;
  const dash = dashArray(c.style, c.width);
  if (dash) stroke['stroke-dasharray'] = dash;

  let endPoint: { x: number; y: number } | undefined;
  let endDir: { x: number; y: number } | undefined;

  if (c.selfArc) {
    const { cx, cy, r } = c.selfArc;
    // circular arc near the top-right corner (3/4 circle for submodules,
    // 1/4 on the compound border)
    const path = c.selfArc.onBorder
      ? `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx} ${cy + r}`
      : `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx} ${cy + r}`;
    el('path', { d: path, ...stroke }, g);
    endPoint = { x: cx, y: cy + r };
    endDir = { x: 0, y: 1 };
  } else if (c.points.length >= 2) {
    el('polyline', { points: c.points.map((p) => `${p.x},${p.y}`).join(' '), ...stroke }, g);
    // invisible fat line to make thin connections clickable
    el('polyline', {
      points: c.points.map((p) => `${p.x},${p.y}`).join(' '),
      stroke: 'transparent', 'stroke-width': 8, fill: 'none',
    }, g);
    endPoint = c.points[c.points.length - 1];
    const prev = c.points[c.points.length - 2];
    const len = Math.hypot(endPoint.x - prev.x, endPoint.y - prev.y) || 1;
    endDir = { x: (endPoint.x - prev.x) / len, y: (endPoint.y - prev.y) / len };
  }

  if (c.arrowhead && endPoint && endDir) {
    // draw2d TRIANGLE_TIP scaled (5+w, 2+w): tip at the endpoint
    const L = 5 + c.width;
    const W = 2 + c.width;
    const bx = endPoint.x - L * endDir.x;
    const by = endPoint.y - L * endDir.y;
    const nx = -endDir.y;
    const ny = endDir.x;
    const pts = [
      `${endPoint.x},${endPoint.y}`,
      `${bx + W * nx},${by + W * ny}`,
      `${bx - W * nx},${by - W * ny}`,
    ].join(' ');
    const arrow = el('polygon', { points: pts, fill: c.color }, g);
    if (c.faint) arrow.setAttribute('opacity', String(16 / 255));
  }

  if (c.marker) {
    // 'o' (for-loop) / '?' (conditional) hint at the line midpoint
    const mid = c.selfArc
      ? { x: c.selfArc.cx + c.selfArc.r, y: c.selfArc.cy }
      : midpoint(c.points);
    if (mid) {
      el('circle', { cx: mid.x, cy: mid.y, r: 7, fill: 'white', stroke: c.color, 'stroke-width': 1 }, g);
      const t = el('text', {
        x: mid.x, y: mid.y + 3.5, 'text-anchor': 'middle',
        'font-size': 10, 'font-family': 'sans-serif', fill: c.color,
      }, g);
      t.textContent = c.marker;
    }
  }
}

function midpoint(points: { x: number; y: number }[]): { x: number; y: number } | undefined {
  if (points.length < 2) return undefined;
  if (points.length === 3) return points[1]; // L-shape: the bend
  const [a, b] = [points[0], points[points.length - 1]];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function iconTransformAttr(f: SubFigure, x: number, y: number, w: number, h: number): string | undefined {
  const t = f.iconTransform;
  if (!t) return undefined;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const parts: string[] = [];
  if (t.rotation) parts.push(`rotate(${t.rotation} ${cx} ${cy})`);
  const sx = (t.flip === 'horizontal' || t.flip === 'both' ? -1 : 1) * (t.scaleX || 1);
  const sy = (t.flip === 'vertical' || t.flip === 'both' ? -1 : 1) * (t.scaleY || 1);
  if (sx !== 1 || sy !== 1) parts.push(`translate(${cx} ${cy}) scale(${sx} ${sy}) translate(${-cx} ${-cy})`);
  return parts.length ? parts.join(' ') : undefined;
}

function renderSubmodule(f: SubFigure, root: SVGElement): void {
  const g = el('g', { 'data-sub': f.index, cursor: 'pointer' }, root);
  addTitle(g, f.tooltip);

  const left = f.cx - f.width / 2;
  const top = f.cy - f.height / 2;

  if (f.shape) {
    const attrs: Record<string, string | number> = {
      fill: f.shape.fill ?? 'none',
      stroke: f.shape.borderWidth > 0 ? f.shape.borderColor ?? 'none' : 'none',
      'stroke-width': f.shape.borderWidth,
    };
    if (f.shape.kind === 'oval') {
      el('ellipse', { cx: f.cx, cy: f.cy, rx: f.width / 2, ry: f.height / 2, ...attrs }, g);
    } else {
      el('rect', { x: left, y: top, width: f.width, height: f.height, ...attrs }, g);
    }
  }

  if (f.icon) {
    // icon centered over the shape bounds
    const ix = f.cx - f.icon.width / 2;
    const iy = f.cy - f.icon.height / 2;
    const attrs: Record<string, string | number> = {
      href: f.icon.dataUri, x: ix, y: iy, width: f.icon.width, height: f.icon.height,
    };
    const tf = iconTransformAttr(f, ix, iy, f.icon.width, f.icon.height);
    if (tf) attrs.transform = tf;
    el('image', attrs, g);
  }

  if (f.icon2) {
    // status icon at the upper-right corner of the shape bounds
    el('image', {
      href: f.icon2.dataUri,
      x: left + f.width - f.icon2.width / 2,
      y: top - f.icon2.height / 2,
      width: f.icon2.width,
      height: f.icon2.height,
    }, g);
  }

  if (f.queue) {
    // static '#' placeholder at the bottom-right (no live queue in the editor)
    const t = el('text', {
      x: left + f.width + 1, y: top + f.height,
      'font-size': FONT_SIZE, 'font-family': 'sans-serif', fill: 'black',
    }, g);
    t.textContent = '#';
  }

  if (f.text) {
    const attrs: Record<string, string | number> = {
      'font-size': FONT_SIZE, 'font-family': 'sans-serif', fill: f.text.color,
    };
    if (f.text.pos === 'left') {
      Object.assign(attrs, { x: left - 2, y: top + FONT_SIZE / 2, 'text-anchor': 'end' });
    } else if (f.text.pos === 'right') {
      Object.assign(attrs, { x: left + f.width + 2, y: top + FONT_SIZE / 2 });
    } else {
      Object.assign(attrs, { x: f.cx, y: top - 3, 'text-anchor': 'middle' });
    }
    const t = el('text', attrs, g);
    t.textContent = f.text.text;
  }

  // name label centered below the shape
  const label = el('text', {
    x: f.cx, y: top + f.height + NAME_GAP + FONT_SIZE - 2,
    'text-anchor': 'middle', 'font-size': FONT_SIZE, 'font-family': 'sans-serif', fill: 'black',
  }, g);
  label.textContent = f.label;
}

/** Render a full compound-module diagram. */
export function renderDiagram(model: DiagramModel, title: string): SVGSVGElement {
  const bg = model.background;
  // margin so out-of-area content (labels, ranges, the title) stays visible
  const bounds = { x1: 0, y1: 0, x2: bg.width, y2: bg.height };
  for (const f of model.submodules) {
    bounds.x1 = Math.min(bounds.x1, f.cx - f.width / 2 - (f.range?.radius ?? 0));
    bounds.y1 = Math.min(bounds.y1, f.cy - f.height / 2 - (f.range?.radius ?? 0));
    bounds.x2 = Math.max(bounds.x2, f.cx + f.width / 2 + (f.range?.radius ?? 0), f.cx + textWidth(f.label) / 2);
    bounds.y2 = Math.max(bounds.y2, f.cy + f.height / 2 + (f.range?.radius ?? 0) + NAME_GAP + FONT_SIZE);
  }
  const margin = 12;
  const titleH = 20;
  const x = bounds.x1 - margin;
  const y = bounds.y1 - margin - titleH;
  const w = bounds.x2 - bounds.x1 + 2 * margin;
  const h = bounds.y2 - bounds.y1 + 2 * margin + titleH;

  const svg = el('svg', { xmlns: SVG_NS, viewBox: `${x} ${y} ${w} ${h}`, width: w, height: h });
  svg.style.font = `${FONT_SIZE}px sans-serif`;

  const heading = el('text', {
    x: 0, y: bounds.y1 - margin - 6,
    'font-size': FONT_SIZE + 1, 'font-family': 'sans-serif', 'font-weight': 'bold', fill: 'black',
  }, svg);
  heading.textContent = title;

  renderBackground(bg, svg);
  for (const f of model.submodules) renderRange(f, svg);
  for (const c of model.connections) renderConnection(c, svg);
  for (const f of model.submodules) renderSubmodule(f, svg);
  return svg;
}

/** Render the non-compound "card": the type's own icon/shape + name + kind. */
export function renderCard(scene: PreviewScene, figure: SubFigure): SVGSVGElement {
  const w = Math.max(figure.width + 80, textWidth(scene.simpleName) + 40, 160);
  const h = figure.height + 76;
  const svg = el('svg', { xmlns: SVG_NS, viewBox: `0 0 ${w} ${h}`, width: w, height: h });
  svg.style.font = `${FONT_SIZE}px sans-serif`;
  figure.cx = w / 2;
  figure.cy = 26 + figure.height / 2;
  figure.label = scene.simpleName;
  renderSubmodule(figure, svg);
  const kind = el('text', {
    x: w / 2, y: h - 12, 'text-anchor': 'middle',
    'font-size': FONT_SIZE - 1, 'font-family': 'sans-serif', fill: '#666666',
  }, svg);
  kind.textContent = scene.kind === 'moduleinterface' ? 'module interface'
    : scene.kind === 'channelinterface' ? 'channel interface' : scene.kind;
  return svg;
}
