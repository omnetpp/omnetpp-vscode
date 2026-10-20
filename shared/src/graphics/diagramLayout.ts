import type { PreviewConnection, PreviewScene, PreviewSubmodule } from '../protocol';
import { BasicSpringEmbedderLayout } from './springEmbedder';
import { arrangementOf, arrangementOffset } from './arrangement';
import { arrowcoords, type Pt, type Rect, type RoutingConstraint, type RoutingDir } from './arrowcoords';
import { DisplayString, Prop, displayStringFromChain } from '../ned/displayStringModel';
import { parseColor } from './colors';

/**
 * Turns a PreviewScene into positioned, styled figures, replicating the
 * Eclipse graphical NED editor's rendering rules: SubmoduleFigure shape/icon
 * resolution, CompoundModuleLayout's layouter setup (border 30 capped at half
 * the area, p= locations fixed, everything else spring-embedded), auto-sizing
 * of the compound area, connection bundling and arrowcoords routing.
 *
 * Host-agnostic (moved here from the preview webview): icon resolution and
 * text measurement are injected — the webview supplies canvas-based
 * implementations, the doc generator disk lookups + font metrics.
 */

/** A ready-to-render icon. `href` goes into `<image href>` verbatim (data:
 *  URI, relative path or webview URI). When the provider cannot pre-tint
 *  pixel data (the Node provider), it sets `tint` and the SVG renderer
 *  applies the IDE's luminance blend as a color-matrix filter instead. */
export interface ResolvedIcon {
  href: string;
  width: number;
  height: number;
  tint?: { color: string; pct: number };
}

export interface IconProvider {
  get(id: string, sizeSuffix?: string, tintColor?: string, tintPct?: number): Promise<ResolvedIcon | undefined>;
}

/** Advance width of `text` at 12px in the diagram font (sans-serif). */
export type TextMeasurer = (text: string) => number;

export interface DiagramBuildOptions {
  icons: IconProvider;
  measureText: TextMeasurer;
  seed: number;
  /** More tooltip paragraphs for a submodule (the documentation figure adds
   *  the type's description and the source). */
  submoduleTooltip?: (sub: PreviewSubmodule) => string[];
}

export interface ShapeSpec {
  kind: 'rectangle' | 'oval';
  fill?: string;
  borderColor?: string;
  borderWidth: number;
}

export interface SubFigure {
  sub: PreviewSubmodule;
  index: number;
  ds: DisplayString;
  /** Center position (model coordinates = px at 100% zoom). */
  cx: number;
  cy: number;
  /** Shape-bounds size (anchor box for connections). */
  width: number;
  height: number;
  pinned: boolean;
  shape?: ShapeSpec;
  icon?: ResolvedIcon;
  icon2?: ResolvedIcon;
  iconTransform?: { rotation: number; flip?: 'horizontal' | 'vertical' | 'both'; scaleX: number; scaleY: number };
  queue: boolean;
  text?: { text: string; pos: 'left' | 'right' | 'top'; color: string };
  range?: { radius: number; fill?: string; borderColor?: string; borderWidth: number };
  label: string;
  /** Measured width of `label` (so renderers need no text measurer). */
  labelWidth: number;
  tooltip: string;
}

export interface ConnFigure {
  conn: PreviewConnection;
  index: number;
  points: Pt[];
  /** Self-connection arc (drawn instead of `points`). */
  selfArc?: { cx: number; cy: number; r: number; onBorder: boolean };
  color: string;
  width: number;
  style: 'solid' | 'dotted' | 'dashed';
  /** width=0 connections render as a faint hairline (IDE: alpha 16/255). */
  faint: boolean;
  arrowhead: boolean;
  marker?: string;
  tooltip: string;
}

export interface BackgroundSpec {
  width: number;
  height: number;
  fill?: string;
  borderColor?: string;
  borderWidth: number;
  grid?: { distance: number; subdivision: number; color: string };
  image?: { icon: ResolvedIcon; mode: 'fix' | 'tile' | 'stretch' | 'center' };
  tooltip?: string;
}

export interface DiagramModel {
  background: BackgroundSpec;
  /** The compound type's own `i=` icon, shown before its name in the title
   *  (IDE: CompoundModuleTypeFigure's title area, always the normal size). */
  titleIcon?: ResolvedIcon;
  submodules: SubFigure[];
  connections: ConnFigure[];
}

function color(ds: DisplayString, prop: (typeof Prop)[keyof typeof Prop]): string | undefined {
  return parseColor(ds.getAsString(prop));
}

function resolveImage(ds: DisplayString, icons: IconProvider, sizeSuffix?: string): Promise<ResolvedIcon | undefined> {
  return icons.get(
    ds.getAsString(Prop.IMAGE),
    sizeSuffix,
    ds.getAsString(Prop.IMAGE_COLOR) || undefined,
    ds.getAsInt(Prop.IMAGE_COLOR_PERCENTAGE, 30),
  );
}

/** Resolve one submodule's visual spec (shape/icon/decorations), IDE rules. */
async function buildSubFigure(
  sub: PreviewSubmodule,
  index: number,
  opts: DiagramBuildOptions,
): Promise<SubFigure> {
  const icons = opts.icons;
  const ds = displayStringFromChain(sub.displayChain);

  const hasIconTag = ds.containsTag('i') && ds.getAsString(Prop.IMAGE) !== '';
  const hasShape = ds.containsTag('b');

  let shape: ShapeSpec | undefined;
  if (hasShape) {
    shape = {
      kind: (ds.getAsEnum(Prop.SHAPE) as ShapeSpec['kind']) ?? 'rectangle',
      fill: color(ds, Prop.SHAPE_FILL_COLOR),
      borderColor: color(ds, Prop.SHAPE_BORDER_COLOR),
      borderWidth: ds.getAsInt(Prop.SHAPE_BORDER_WIDTH, 2),
    };
  }

  let icon: ResolvedIcon | undefined;
  if (hasIconTag) {
    const sizeName = ds.getAsEnum(Prop.IMAGE_SIZE);
    const suffix = sizeName ? { 'very small': 'vs', small: 's', large: 'l', 'very large': 'vl' }[sizeName] : undefined;
    icon = await resolveImage(ds, icons, suffix);
  } else if (!hasShape) {
    icon = await icons.get('_internal/default'); // no i, no b: the IDE's default icon
  }

  let icon2: ResolvedIcon | undefined;
  if (ds.containsTag('i2') && ds.getAsString(Prop.IMAGE2) !== '') {
    icon2 = await icons.get(
      ds.getAsString(Prop.IMAGE2),
      undefined,
      ds.getAsString(Prop.IMAGE2_COLOR) || undefined,
      ds.getAsInt(Prop.IMAGE2_COLOR_PERCENTAGE, 30),
    );
  }

  let iconTransform: SubFigure['iconTransform'];
  if (ds.containsTag('it')) {
    const scaleX = ds.getAsCoordinate(Prop.IMAGE_SCALE_X) ?? 1;
    iconTransform = {
      rotation: ds.getAsCoordinate(Prop.IMAGE_ROTATION) ?? 0,
      flip: ds.getAsEnum(Prop.IMAGE_FLIP) as 'horizontal' | 'vertical' | 'both' | undefined,
      scaleX,
      scaleY: ds.getAsCoordinate(Prop.IMAGE_SCALE_Y) ?? scaleX,
    };
  }

  // shape bounds: the shape's size when a b tag exists, otherwise the icon size
  const size = ds.getSize();
  const width = shape ? size.width ?? 40 : icon?.width ?? 40;
  const height = shape ? size.height ?? 24 : icon?.height ?? 24;

  const rangeRadius = ds.getRange();
  const location = ds.getLocation();

  const textValue = ds.getAsString(Prop.TEXT);
  const label = sub.vectorSize !== undefined ? `${sub.name}[${sub.vectorSize}]` : sub.name;

  const tooltipLines = [
    `${label}: ${sub.resolvedTypeFqName ?? sub.typeName ?? '<unresolved>'}${sub.isLike ? ` (like ${sub.typeName ?? '?'})` : ''}`,
  ];
  if (sub.inheritedFrom) tooltipLines.push(`inherited from ${sub.inheritedFrom}`);
  const tt = ds.getAsString(Prop.TOOLTIP);
  if (tt) tooltipLines.push(tt);
  for (const part of opts.submoduleTooltip?.(sub) ?? []) tooltipLines.push('', part);

  return {
    sub,
    index,
    ds,
    cx: location?.x ?? 0,
    cy: location?.y ?? 0,
    pinned: location !== undefined,
    width,
    height,
    shape,
    icon,
    icon2,
    iconTransform,
    queue: ds.getAsString(Prop.QUEUE_NAME).trim() !== '',
    text: textValue
      ? {
          text: textValue,
          pos: (ds.getAsEnum(Prop.TEXT_POS) as 'left' | 'right' | 'top') ?? 'top',
          color: color(ds, Prop.TEXT_COLOR) ?? parseColor('blue')!,
        }
      : undefined,
    range:
      rangeRadius !== undefined
        ? {
            radius: rangeRadius,
            fill: color(ds, Prop.RANGE_FILL_COLOR),
            borderColor: color(ds, Prop.RANGE_BORDER_COLOR),
            borderWidth: ds.getAsInt(Prop.RANGE_BORDER_WIDTH, 1),
          }
        : undefined,
    label,
    labelWidth: opts.measureText(label),
    tooltip: tooltipLines.join('\n'),
  };
}

/** The non-compound "card": the type rendered with its own icon/shape rules. */
export async function buildCardFigure(scene: PreviewScene, opts: DiagramBuildOptions): Promise<SubFigure> {
  const pseudo = {
    name: scene.simpleName,
    isLike: false,
    displayChain: scene.displayChain,
    declUri: scene.typeUri,
    declRange: scene.typeRange ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  } as PreviewSubmodule;
  const figure = await buildSubFigure(pseudo, 0, opts);
  figure.tooltip = scene.fqName;
  return figure;
}

/** CompoundModuleLayout.createAutoLayouter: border 30, capped at half the area. */
function layoutBorder(width: number, height: number): number {
  let border = 30;
  if (width !== 0 && width < 2 * border) border = width / 2;
  if (height !== 0 && height < 2 * border) border = height / 2;
  return border;
}

/** Run the spring embedder for unpinned figures; mutates cx/cy. */
function runLayout(
  figures: SubFigure[],
  connections: PreviewConnection[],
  bgWidth: number,
  bgHeight: number,
  seed: number,
): void {
  if (!figures.length) return;
  const layout = new BasicSpringEmbedderLayout(Math.max(1, seed), {
    width: bgWidth,
    height: bgHeight,
    border: layoutBorder(bgWidth, bgHeight),
  });
  const byName = new Map(figures.map((f) => [f.sub.name, f]));

  // "g" layout groups: members are arranged by their "p" tag arrangement like the elements
  // of a submodule vector, indexed in declaration order (CompoundModuleLayout +
  // SubmoduleEditPart in the IDE)
  const groupOf = (f: SubFigure): string | undefined => f.ds.getAsString(Prop.LAYOUT_GROUP) || undefined;
  const groups = new Map<string, SubFigure[]>();
  for (const f of figures) {
    const group = groupOf(f);
    if (group) groups.set(group, [...(groups.get(group) ?? []), f]);
  }
  for (const f of figures) {
    const group = groupOf(f);
    const members = group ? groups.get(group)! : [];
    const arrangement = arrangementOf(f.ds);
    const offset = arrangementOffset(arrangement, group ? members.indexOf(f) : 0, members.length);
    if (f.pinned) {
      f.cx += offset.x;
      f.cy += offset.y;
      layout.addFixedNode(f.index, f.cx, f.cy, f.width, f.height);
    } else if (!group || arrangement.arrangement === 'none') {
      layout.addMovableNode(f.index, f.width, f.height);
    } else {
      layout.addAnchoredNode(f.index, `g:${group}`, offset.x, offset.y, f.width, f.height);
    }
  }
  for (const c of connections) {
    const src = c.srcModule ? byName.get(c.srcModule) : undefined;
    const dest = c.destModule ? byName.get(c.destModule) : undefined;
    if (src && dest && src !== dest) layout.addEdge(src.index, dest.index);
    else if (src || dest) layout.addEdgeToBorder((src ?? dest)!.index);
  }
  layout.execute();
  for (const f of figures) {
    if (!f.pinned) {
      const p = layout.getNodePosition(f.index);
      f.cx = p.x;
      f.cy = p.y;
    }
  }
}

const NAME_GAP = 2;

/** Union of figure bounds incl. name labels (for compound auto-sizing). */
function contentBounds(figures: SubFigure[]): { x1: number; y1: number; x2: number; y2: number } {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const f of figures) {
    x1 = Math.min(x1, f.cx - f.width / 2, f.cx - f.labelWidth / 2);
    y1 = Math.min(y1, f.cy - f.height / 2);
    x2 = Math.max(x2, f.cx + f.width / 2, f.cx + f.labelWidth / 2);
    y2 = Math.max(y2, f.cy + f.height / 2 + NAME_GAP + 14);
  }
  return { x1, y1, x2, y2 };
}

function shapeRect(f: SubFigure): Rect {
  return { x: f.cx - f.width / 2, y: f.cy - f.height / 2, width: f.width, height: f.height };
}

const DIR_CHAR: Record<string, RoutingDir> = {
  horizontal: 'h', vertical: 'v', north: 'n', east: 'e', south: 's', west: 'w', auto: 'a', manual: 'm',
};

function routingConstraint(ds: DisplayString): RoutingConstraint {
  const srcDir = DIR_CHAR[ds.getAsEnum(Prop.ROUTING_CONSTRAINT) ?? ''];
  if (!srcDir) return {};
  if (srcDir === 'm') {
    return {
      srcDir,
      srcAnchX: ds.getAsInt(Prop.ROUTING_ANCHOR_SRCX, 50),
      srcAnchY: ds.getAsInt(Prop.ROUTING_ANCHOR_SRCY, 50),
      destAnchX: ds.getAsInt(Prop.ROUTING_ANCHOR_DESTX, 50),
      destAnchY: ds.getAsInt(Prop.ROUTING_ANCHOR_DESTY, 50),
    };
  }
  const destDir = DIR_CHAR[ds.getAsEnum(Prop.ROUTING_ANCHOR_SRCX) ?? ''];
  return { srcDir, destDir: destDir === 'a' || destDir === 'm' ? undefined : destDir };
}

function buildConnFigure(
  conn: PreviewConnection,
  index: number,
  byName: Map<string, SubFigure>,
  compoundRect: Rect,
  bundleI: number,
  bundleN: number,
): ConnFigure {
  const ds = displayStringFromChain(conn.displayChain);
  const srcFig = conn.srcModule ? byName.get(conn.srcModule) : undefined;
  const destFig = conn.destModule ? byName.get(conn.destModule) : undefined;
  const srcRect = srcFig ? shapeRect(srcFig) : compoundRect;
  const destRect = destFig ? shapeRect(destFig) : compoundRect;

  const lineWidth = ds.getAsInt(Prop.CONNECTION_WIDTH, 1);
  const base: Omit<ConnFigure, 'points' | 'selfArc'> = {
    conn,
    index,
    color: color(ds, Prop.CONNECTION_COLOR) ?? '#000000',
    width: lineWidth === 0 ? 1 : lineWidth,
    faint: lineWidth === 0,
    style: (ds.getAsEnum(Prop.CONNECTION_STYLE) as ConnFigure['style']) ?? 'solid',
    arrowhead: !conn.bidirectional,
    marker: (conn.loops.length ? '⦀' : '') + (conn.conditions.length ? '?' : '') || undefined,
    tooltip: connTooltip(conn),
  };

  // self connection: arc near the top-right corner (IDE: r=14 for submodules,
  // r=24 on the compound border)
  const sameSub = srcFig && srcFig === destFig;
  const bothBorder = !srcFig && !destFig;
  if (sameSub || bothBorder) {
    const rect = sameSub ? srcRect : compoundRect;
    return {
      ...base,
      points: [],
      selfArc: { cx: rect.x + rect.width, cy: rect.y, r: sameSub ? 14 : 24, onBorder: !sameSub },
    };
  }

  const points = arrowcoords(srcRect, destRect, bundleI, bundleN, routingConstraint(ds));
  return { ...base, points };
}

function connTooltip(conn: PreviewConnection): string {
  const end = (mod: string | undefined, index: string | undefined, gate: string): string =>
    mod ? `${mod}${index !== undefined ? `[${index}]` : ''}.${gate}` : gate;
  const src = end(conn.srcModule, conn.srcModuleIndex, conn.srcGate);
  const dest = end(conn.destModule, conn.destModuleIndex, conn.destGate);
  const arrow = conn.bidirectional ? '<-->' : '-->';
  const lines = [
    `${src} ${arrow} ${conn.channelTypeName ? `${conn.channelTypeName} ${arrow} ` : ''}${dest}`,
  ];
  if (conn.inheritedFrom) lines.push(`inherited from ${conn.inheritedFrom}`);
  if (conn.loops.length) lines.push(`for ${conn.loops.join(', ')}`);
  if (conn.conditions.length) lines.push(`conditional: ${conn.conditions.join(' && ')}`);
  const tt = displayStringFromChain(conn.displayChain).getAsString(Prop.TOOLTIP);
  if (tt) lines.push(tt);
  return lines.join('\n');
}

/** Build the whole positioned diagram for a compound-module scene. */
export async function buildDiagram(scene: PreviewScene, opts: DiagramBuildOptions): Promise<DiagramModel> {
  const compoundDs = displayStringFromChain(scene.displayChain);

  const figures: SubFigure[] = [];
  for (const [i, sub] of (scene.submodules ?? []).entries()) figures.push(await buildSubFigure(sub, i, opts));

  const compoundSize = compoundDs.getCompoundSize();
  runLayout(figures, scene.connections ?? [], compoundSize.width ?? 0, compoundSize.height ?? 0, opts.seed);

  // compound size: bgb, missing dimensions auto-fit to content (IDE: mirror
  // the top/left offset as the bottom/right padding); default 300x200
  let width = compoundSize.width;
  let height = compoundSize.height;
  if (width === undefined || height === undefined) {
    if (figures.length) {
      const bb = contentBounds(figures);
      width ??= bb.x2 + Math.max(bb.x1, 0);
      height ??= bb.y2 + Math.max(bb.y1, 0);
    } else {
      width ??= 300;
      height ??= 200;
    }
  }

  const background: BackgroundSpec = {
    width,
    height,
    fill: color(compoundDs, Prop.MODULE_FILL_COLOR),
    borderColor: color(compoundDs, Prop.MODULE_BORDER_COLOR),
    borderWidth: compoundDs.getAsInt(Prop.MODULE_BORDER_WIDTH, 2),
    tooltip: compoundDs.getAsString(Prop.MODULE_TOOLTIP) || undefined,
  };
  const gridDistance = compoundDs.getAsDistance(Prop.MODULE_GRID_DISTANCE);
  if (gridDistance !== undefined) {
    background.grid = {
      distance: gridDistance,
      subdivision: compoundDs.getAsInt(Prop.MODULE_GRID_SUBDIVISION, 1),
      color: color(compoundDs, Prop.MODULE_GRID_COLOR) ?? parseColor('grey')!,
    };
  }
  const bgImage = compoundDs.getAsString(Prop.MODULE_IMAGE);
  if (bgImage) {
    const loaded = await opts.icons.get(bgImage);
    if (loaded) {
      background.image = {
        icon: loaded,
        mode: (compoundDs.getAsEnum(Prop.MODULE_IMAGE_ARRANGEMENT) as 'fix' | 'tile' | 'stretch' | 'center') ?? 'fix',
      };
    }
  }

  // bundling: parallel connections between the same (unordered) module pair
  // sharing the same m[0] constraint spread out along the shared edge
  const byName = new Map(figures.map((f) => [f.sub.name, f]));
  const compoundRect: Rect = { x: 0, y: 0, width, height };
  const groups = new Map<string, number[]>();
  const conns = scene.connections ?? [];
  conns.forEach((c, i) => {
    const pair = [c.srcModule ?? '', c.destModule ?? ''].sort();
    const m0 = displayStringFromChain(c.displayChain).getAsString(Prop.ROUTING_CONSTRAINT);
    const key = `${pair[0]}~${pair[1]}|${m0}`;
    const g = groups.get(key) ?? [];
    g.push(i);
    groups.set(key, g);
  });
  const connFigures: ConnFigure[] = [];
  for (const group of groups.values()) {
    group.forEach((connIndex, i) => {
      connFigures.push(buildConnFigure(conns[connIndex], connIndex, byName, compoundRect, i, group.length));
    });
  }
  connFigures.sort((a, b) => a.index - b.index);

  const titleIcon = compoundDs.containsTag('i') && compoundDs.getAsString(Prop.IMAGE) !== ''
    ? await resolveImage(compoundDs, opts.icons)
    : undefined;

  return { background, titleIcon, submodules: figures, connections: connFigures };
}
