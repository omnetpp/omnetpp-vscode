import type { PreviewScene } from '../protocol';
import type { BackgroundSpec, ConnFigure, DiagramModel, ResolvedIcon, SubFigure } from './diagramLayout';
import { SvgBuilder, type Attrs } from './svgBuilder';
import { approxTextWidth } from './textMetrics';

/**
 * Renders a DiagramModel to an SVG string, layered like the IDE's
 * CompoundModuleFigure: background box → grid → background image → range
 * indicators → connections → submodules. Submodule/connection groups carry
 * data-* attributes for hit-testing and <title> tooltips.
 *
 * This is the string twin of the preview webview's DOM renderer (which now
 * parses this output via DOMParser) — one rendering code path for both the
 * live preview and the static documentation figures. Extras for static use:
 * optional <a href> links around submodules and returned link areas, and
 * feColorMatrix tint filters for icon providers that cannot pre-tint pixels.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const NAME_GAP = 2;
const FONT_SIZE = 12;
const TITLE_FONT_SIZE = FONT_SIZE + 1;

export interface LinkArea {
  /** Rect in final image coordinates (viewBox origin subtracted). */
  x: number;
  y: number;
  width: number;
  height: number;
  targetFqName: string;
  href?: string;
  tooltip: string;
}

export interface RenderedSvg {
  svg: string;
  width: number;
  height: number;
  areas: LinkArea[];
}

export interface DiagramRenderOptions {
  title?: string;
  /** When it returns an URL for a submodule's resolved type, the submodule
   *  group is wrapped in <a href> and a LinkArea is reported. */
  linkHrefFor?: (fqName: string) => string | undefined;
}

// ---------------------------------------------------------------------------
// tint filters (Node icon providers defer tinting to the renderer)
// ---------------------------------------------------------------------------

class TintFilters {
  private ids = new Map<string, string>();

  /** filter id for a (color, pct) tint, creating it on first use. */
  idFor(tint: NonNullable<ResolvedIcon['tint']>): string {
    const key = `${tint.color}|${tint.pct}`;
    let id = this.ids.get(key);
    if (!id) {
      id = `tint${this.ids.size}`;
      this.ids.set(key, id);
    }
    return id;
  }

  /** The IDE's luminance blend c' = ((100-w)c + w·lum·tint_c/128)/100 with
   *  lum = .2126R+.7152G+.0722B is exactly one color matrix per channel:
   *  row_c = [a + k_c·.2126, k_c·.7152, k_c·.0722, 0, 0], a=(100-w)/100,
   *  k_c = w·tint_c/12800. */
  defs(): string {
    if (this.ids.size === 0) return '';
    const b = new SvgBuilder();
    b.open('defs');
    for (const [key, id] of this.ids) {
      const [color, pctStr] = key.split('|');
      const w = Math.max(0, Math.min(100, Number(pctStr)));
      const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
      const a = (100 - w) / 100;
      const rows: string[] = [];
      for (let ch = 0; ch < 3; ch++) {
        const k = (w * rgb[ch]) / 12800;
        const row = [k * 0.2126, k * 0.7152, k * 0.0722, 0, 0];
        row[ch] += a;
        rows.push(row.map((v) => round4(v)).join(' '));
      }
      rows.push('0 0 0 1 0');
      b.open('filter', { id, 'color-interpolation-filters': 'sRGB' });
      b.el('feColorMatrix', { type: 'matrix', values: rows.join('  ') });
      b.close();
    }
    b.close();
    return b.toString();
  }
}

function round4(v: number): string {
  return String(Math.round(v * 10000) / 10000);
}

function iconAttrs(icon: ResolvedIcon, filters: TintFilters, attrs: Attrs): Attrs {
  if (icon.tint) attrs.filter = `url(#${filters.idFor(icon.tint)})`;
  return attrs;
}

// ---------------------------------------------------------------------------
// figure rendering (same shapes as the webview renderer)
// ---------------------------------------------------------------------------

function renderBackground(bg: BackgroundSpec, b: SvgBuilder, filters: TintFilters): void {
  const rectAttrs: Attrs = {
    x: 0, y: 0, width: bg.width, height: bg.height,
    fill: bg.fill ?? 'none',
    stroke: bg.borderColor ?? 'none',
    'stroke-width': bg.borderWidth,
  };
  if (bg.tooltip) {
    b.open('rect', rectAttrs).el('title', {}, bg.tooltip).close();
  } else {
    b.el('rect', rectAttrs);
  }

  if (bg.image) {
    const { icon, mode } = bg.image;
    if (mode === 'stretch') {
      b.el('image', iconAttrs(icon, filters, { href: icon.href, x: 0, y: 0, width: bg.width, height: bg.height, preserveAspectRatio: 'none' }));
    } else if (mode === 'center') {
      b.el('image', iconAttrs(icon, filters, {
        href: icon.href,
        x: (bg.width - icon.width) / 2, y: (bg.height - icon.height) / 2,
        width: icon.width, height: icon.height,
      }));
    } else if (mode === 'tile') {
      for (let y = 0; y < bg.height; y += icon.height) {
        for (let x = 0; x < bg.width; x += icon.width) {
          b.el('image', iconAttrs(icon, filters, { href: icon.href, x, y, width: icon.width, height: icon.height }));
        }
      }
    } else {
      b.el('image', iconAttrs(icon, filters, { href: icon.href, x: 0, y: 0, width: icon.width, height: icon.height }));
    }
  }

  if (bg.grid && bg.grid.distance > 0) {
    b.open('g', { stroke: bg.grid.color, 'stroke-width': 1 });
    const step = bg.grid.distance;
    for (let x = step; x < bg.width; x += step) b.el('line', { x1: x, y1: 0, x2: x, y2: bg.height });
    for (let y = step; y < bg.height; y += step) b.el('line', { x1: 0, y1: y, x2: bg.width, y2: y });
    b.close();
    const sub = Math.max(1, bg.grid.subdivision);
    if (sub > 1) {
      b.open('g', { stroke: bg.grid.color, 'stroke-width': 1, 'stroke-dasharray': '1 3' });
      for (let x = step; x < bg.width; x += step) {
        for (let i = 1; i < sub; i++) {
          const mx = x - (step * i) / sub;
          if (mx > 0) b.el('line', { x1: mx, y1: 0, x2: mx, y2: bg.height });
        }
      }
      for (let y = step; y < bg.height; y += step) {
        for (let i = 1; i < sub; i++) {
          const my = y - (step * i) / sub;
          if (my > 0) b.el('line', { x1: 0, y1: my, x2: bg.width, y2: my });
        }
      }
      b.close();
    }
  }
}

function renderRange(f: SubFigure, b: SvgBuilder): void {
  if (!f.range) return;
  // IDE RangeFigure: fixed alpha 64/255 for both fill and outline
  const attrs: Attrs = { cx: f.cx, cy: f.cy, r: f.range.radius, opacity: 64 / 255, fill: 'none' };
  if (f.range.fill) attrs.fill = f.range.fill;
  if (f.range.borderColor && f.range.borderWidth > 0) {
    attrs.stroke = f.range.borderColor;
    attrs['stroke-width'] = f.range.borderWidth;
  }
  b.el('circle', attrs);
}

function dashArray(style: ConnFigure['style'], width: number): string | undefined {
  const w = Math.max(1, width);
  if (style === 'dashed') return `${4 * w} ${2 * w}`;
  if (style === 'dotted') return `${w} ${w}`;
  return undefined;
}

function renderConnection(c: ConnFigure, b: SvgBuilder): void {
  b.open('g', { 'data-conn': c.index, cursor: 'pointer' });
  b.el('title', {}, c.tooltip);
  const stroke: Attrs = {
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
    b.el('path', { d: path, ...stroke });
    endPoint = { x: cx, y: cy + r };
    endDir = { x: 0, y: 1 };
  } else if (c.points.length >= 2) {
    const pts = c.points.map((p) => `${p.x},${p.y}`).join(' ');
    b.el('polyline', { points: pts, ...stroke });
    // invisible fat line to make thin connections clickable
    b.el('polyline', { points: pts, stroke: 'transparent', 'stroke-width': 8, fill: 'none' });
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
    const attrs: Attrs = { points: pts, fill: c.color };
    if (c.faint) attrs.opacity = 16 / 255;
    b.el('polygon', attrs);
  }

  if (c.marker) {
    // '⦀' (for-loop) / '?' (conditional) hint at the line midpoint
    const mid = c.selfArc ? { x: c.selfArc.cx + c.selfArc.r, y: c.selfArc.cy } : midpoint(c.points);
    if (mid) {
      b.el('circle', { cx: mid.x, cy: mid.y, r: 7, fill: 'white', stroke: c.color, 'stroke-width': 1 });
      b.el(
        'text',
        { x: mid.x, y: mid.y + 3.5, 'text-anchor': 'middle', 'font-size': 10, 'font-family': 'sans-serif', fill: c.color },
        c.marker,
      );
    }
  }
  b.close();
}

function midpoint(points: { x: number; y: number }[]): { x: number; y: number } | undefined {
  if (points.length < 2) return undefined;
  if (points.length === 3) return points[1]; // L-shape: the bend
  const [a, z] = [points[0], points[points.length - 1]];
  return { x: (a.x + z.x) / 2, y: (a.y + z.y) / 2 };
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

function renderSubmodule(f: SubFigure, b: SvgBuilder, filters: TintFilters, opts: DiagramRenderOptions): void {
  const href = f.sub.resolvedTypeFqName ? opts.linkHrefFor?.(f.sub.resolvedTypeFqName) : undefined;
  // target=_top: when the SVG is embedded via <object>/<iframe>, links must
  // navigate the whole page, not the embedded browsing context
  if (href) b.open('a', { href, target: '_top' });
  b.open('g', { 'data-sub': f.index, cursor: 'pointer' });
  b.el('title', {}, f.tooltip);

  const left = f.cx - f.width / 2;
  const top = f.cy - f.height / 2;

  if (f.shape) {
    const attrs: Attrs = {
      fill: f.shape.fill ?? 'none',
      stroke: f.shape.borderWidth > 0 ? f.shape.borderColor ?? 'none' : 'none',
      'stroke-width': f.shape.borderWidth,
    };
    if (f.shape.kind === 'oval') {
      b.el('ellipse', { cx: f.cx, cy: f.cy, rx: f.width / 2, ry: f.height / 2, ...attrs });
    } else {
      b.el('rect', { x: left, y: top, width: f.width, height: f.height, ...attrs });
    }
  }

  if (f.icon) {
    // icon centered over the shape bounds
    const ix = f.cx - f.icon.width / 2;
    const iy = f.cy - f.icon.height / 2;
    const attrs = iconAttrs(f.icon, filters, { href: f.icon.href, x: ix, y: iy, width: f.icon.width, height: f.icon.height });
    const tf = iconTransformAttr(f, ix, iy, f.icon.width, f.icon.height);
    if (tf) attrs.transform = tf;
    b.el('image', attrs);
  }

  if (f.icon2) {
    // status icon at the upper-right corner of the shape bounds
    b.el('image', iconAttrs(f.icon2, filters, {
      href: f.icon2.href,
      x: left + f.width - f.icon2.width / 2,
      y: top - f.icon2.height / 2,
      width: f.icon2.width,
      height: f.icon2.height,
    }));
  }

  if (f.queue) {
    // static '#' placeholder at the bottom-right (no live queue in the editor)
    b.el(
      'text',
      { x: left + f.width + 1, y: top + f.height, 'font-size': FONT_SIZE, 'font-family': 'sans-serif', fill: 'black' },
      '#',
    );
  }

  if (f.text) {
    const attrs: Attrs = { 'font-size': FONT_SIZE, 'font-family': 'sans-serif', fill: f.text.color };
    if (f.text.pos === 'left') {
      Object.assign(attrs, { x: left - 2, y: top + FONT_SIZE / 2, 'text-anchor': 'end' });
    } else if (f.text.pos === 'right') {
      Object.assign(attrs, { x: left + f.width + 2, y: top + FONT_SIZE / 2 });
    } else {
      Object.assign(attrs, { x: f.cx, y: top - 3, 'text-anchor': 'middle' });
    }
    b.el('text', attrs, f.text.text);
  }

  // name label centered below the shape
  b.el(
    'text',
    {
      x: f.cx, y: top + f.height + NAME_GAP + FONT_SIZE - 2,
      'text-anchor': 'middle', 'font-size': FONT_SIZE, 'font-family': 'sans-serif', fill: 'black',
    },
    f.label,
  );
  b.close();
  if (href) b.close();
}

// ---------------------------------------------------------------------------
// entry points
// ---------------------------------------------------------------------------

/** Render a full compound-module diagram to an SVG string. */
export function renderDiagramSvg(model: DiagramModel, opts: DiagramRenderOptions = {}): RenderedSvg {
  const bg = model.background;
  // margin so out-of-area content (labels, ranges, the title) stays visible
  const bounds = { x1: 0, y1: 0, x2: bg.width, y2: bg.height };
  for (const f of model.submodules) {
    bounds.x1 = Math.min(bounds.x1, f.cx - f.width / 2 - (f.range?.radius ?? 0));
    bounds.y1 = Math.min(bounds.y1, f.cy - f.height / 2 - (f.range?.radius ?? 0));
    bounds.x2 = Math.max(bounds.x2, f.cx + f.width / 2 + (f.range?.radius ?? 0), f.cx + f.labelWidth / 2);
    bounds.y2 = Math.max(bounds.y2, f.cy + f.height / 2 + (f.range?.radius ?? 0) + NAME_GAP + FONT_SIZE);
  }
  const margin = 12;
  const titleIcon = opts.title === undefined ? undefined : model.titleIcon;
  const titleX = titleIcon ? titleIcon.width + 3 : 0;
  if (opts.title !== undefined) {
    // bold runs wider than the regular-weight metrics table
    bounds.x2 = Math.max(bounds.x2, titleX + approxTextWidth(opts.title, TITLE_FONT_SIZE) * 1.1);
  }
  const titleH = opts.title === undefined ? 0 : titleIcon ? titleIcon.height + 6 : 20;
  const x = bounds.x1 - margin;
  const y = bounds.y1 - margin - titleH;
  const w = bounds.x2 - bounds.x1 + 2 * margin;
  const h = bounds.y2 - bounds.y1 + 2 * margin + titleH;

  const filters = new TintFilters();
  const body = new SvgBuilder();
  if (opts.title !== undefined) {
    let baseline = bounds.y1 - margin - 6;
    if (titleIcon) {
      // IDE title area: icon at the left, the name vertically centred on it
      const iconY = bounds.y1 - margin - 4 - titleIcon.height;
      body.el('image', iconAttrs(titleIcon, filters, {
        href: titleIcon.href, x: 0, y: iconY, width: titleIcon.width, height: titleIcon.height,
      }));
      baseline = iconY + titleIcon.height / 2 + TITLE_FONT_SIZE * 0.36;
    }
    body.el(
      'text',
      {
        x: titleX, y: baseline,
        'font-size': TITLE_FONT_SIZE, 'font-family': 'sans-serif', 'font-weight': 'bold', fill: 'black',
      },
      opts.title,
    );
  }
  renderBackground(bg, body, filters);
  for (const f of model.submodules) renderRange(f, body);
  for (const c of model.connections) renderConnection(c, body);
  for (const f of model.submodules) renderSubmodule(f, body, filters, opts);

  const svg = new SvgBuilder();
  svg.open('svg', {
    xmlns: SVG_NS,
    viewBox: `${x} ${y} ${w} ${h}`,
    width: w,
    height: h,
    style: `font: ${FONT_SIZE}px sans-serif`,
  });
  svg.raw(filters.defs());
  svg.raw(body.toString());
  svg.close();

  const areas: LinkArea[] = model.submodules
    .filter((f) => f.sub.resolvedTypeFqName)
    .map((f) => ({
      x: f.cx - f.width / 2 - x,
      y: f.cy - f.height / 2 - y,
      width: f.width,
      height: f.height,
      targetFqName: f.sub.resolvedTypeFqName!,
      href: opts.linkHrefFor?.(f.sub.resolvedTypeFqName!),
      tooltip: f.tooltip,
    }));
  return { svg: svg.toString(), width: w, height: h, areas };
}

/** Render the non-compound "card": the type's own icon/shape + name + kind. */
export function renderCardSvg(scene: PreviewScene, figure: SubFigure, opts: DiagramRenderOptions = {}): RenderedSvg {
  const w = Math.max(figure.width + 80, figure.labelWidth + 40, 160);
  const h = figure.height + 76;
  figure.cx = w / 2;
  figure.cy = 26 + figure.height / 2;
  figure.label = scene.simpleName;

  const filters = new TintFilters();
  const body = new SvgBuilder();
  renderSubmodule(figure, body, filters, opts);
  body.el(
    'text',
    { x: w / 2, y: h - 12, 'text-anchor': 'middle', 'font-size': FONT_SIZE - 1, 'font-family': 'sans-serif', fill: '#666666' },
    scene.kind === 'moduleinterface' ? 'module interface' : scene.kind === 'channelinterface' ? 'channel interface' : scene.kind,
  );

  const svg = new SvgBuilder();
  svg.open('svg', { xmlns: SVG_NS, viewBox: `0 0 ${w} ${h}`, width: w, height: h, style: `font: ${FONT_SIZE}px sans-serif` });
  svg.raw(filters.defs());
  svg.raw(body.toString());
  svg.close();
  return { svg: svg.toString(), width: w, height: h, areas: [] };
}
