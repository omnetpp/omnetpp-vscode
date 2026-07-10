import { CompletionItem, CompletionItemKind, InsertTextFormat } from '../model/completion';
import { DISPLAY_COLORS } from './displayString';

/**
 * `@figure[...](type=...;key=value;...)` type-aware completion model.
 * Faithfully transcribed from the Eclipse IDE's figure-property schema:
 * `ui/org.omnetpp.ned.core/src/org/omnetpp/ned/core/NedCanvasFigureValidator.java`
 * (per-type valid-key lists in the static initializer, `getValidPropertyKeysForType`,
 * `getValidValuesForPropertyKey`) and the figure-type/property-key string constants in
 * `ui/org.omnetpp.common/src/org/omnetpp/common/canvas/CanvasFigureConstants.java`
 * (`FTYPE_*`/`PKEY_*`/`PVAL_ANCHOR_*`). The completion dispatch itself (which snippet
 * shape each key gets, which keys trigger color/image/transform-specific value
 * completion) mirrors `NedCompletionProcessor.java:406-510`.
 */

// --- figure types (CanvasFigureConstants.FTYPE_*, NedCanvasFigureValidator.validTypes order) ---

export const FIGURE_TYPES: readonly string[] = [
  'line', 'polyline', 'polygon', 'rectangle', 'oval', 'ring', 'pieslice', 'arc',
  'group', 'panel', 'text', 'label', 'image', 'pixmap', 'icon', 'path',
];

// --- shared property-key groups (mirrors the local variables in NedCanvasFigureValidator's
//     static initializer: commonFigurePropertyKeys, anchoredRectanglePropertyKeys,
//     commonLinePropertyKeys, commonShapePropertyKeys, arrowHeadPropertyKeys) ---

const COMMON_FIGURE_KEYS = ['tags', 'visible', 'tooltip', 'type', 'zIndex', 'transform'];
const ANCHORED_RECT_KEYS = ['bounds', 'pos', 'size', 'anchor'];
const COMMON_LINE_KEYS = ['lineWidth', 'zoomLineWidth', 'lineColor', 'lineOpacity', 'lineStyle', 'capStyle'];
const COMMON_SHAPE_KEYS = ['lineWidth', 'zoomLineWidth', 'lineColor', 'lineOpacity', 'fillColor', 'fillOpacity', 'lineStyle'];
const ARROWHEAD_KEYS = ['startArrowhead', 'endArrowhead'];

/**
 * Per-figure-type valid property-key lists, in the same composition order as the
 * Java static initializer (`getValidPropertyKeysForType`). `icon` shares `image`'s
 * list (`validImagePropertyKeys`, per the `FTYPE_ICON -> validImagePropertyKeys` case).
 */
export const FIGURE_TYPE_KEYS: Readonly<Record<string, readonly string[]>> = {
  line: [...COMMON_FIGURE_KEYS, 'points', ...COMMON_LINE_KEYS, ...ARROWHEAD_KEYS],
  polyline: [...COMMON_FIGURE_KEYS, 'points', ...COMMON_LINE_KEYS, 'joinStyle', 'smooth', ...ARROWHEAD_KEYS],
  polygon: [...COMMON_FIGURE_KEYS, 'points', ...COMMON_SHAPE_KEYS, 'joinStyle', 'smooth', 'fillRule'],
  rectangle: [...COMMON_FIGURE_KEYS, ...ANCHORED_RECT_KEYS, ...COMMON_SHAPE_KEYS, 'cornerRadius'],
  oval: [...COMMON_FIGURE_KEYS, ...ANCHORED_RECT_KEYS, ...COMMON_SHAPE_KEYS],
  ring: [...COMMON_FIGURE_KEYS, ...ANCHORED_RECT_KEYS, ...COMMON_SHAPE_KEYS, 'innerSize'],
  pieslice: [...COMMON_FIGURE_KEYS, ...ANCHORED_RECT_KEYS, ...COMMON_SHAPE_KEYS, 'startAngle', 'endAngle'],
  arc: [...COMMON_FIGURE_KEYS, ...ANCHORED_RECT_KEYS, ...COMMON_LINE_KEYS, 'startAngle', 'endAngle', ...ARROWHEAD_KEYS],
  group: [...COMMON_FIGURE_KEYS],
  panel: [...COMMON_FIGURE_KEYS, 'pos', 'anchorPoint'],
  text: [...COMMON_FIGURE_KEYS, 'pos', 'text', 'font', 'align', 'color', 'opacity', 'halo', 'anchor'],
  label: [...COMMON_FIGURE_KEYS, 'pos', 'text', 'font', 'align', 'color', 'opacity', 'halo', 'anchor', 'angle'],
  image: [...COMMON_FIGURE_KEYS, 'image', 'opacity', 'interpolation', 'tint', ...ANCHORED_RECT_KEYS],
  pixmap: [...COMMON_FIGURE_KEYS, 'opacity', 'interpolation', 'tint', ...ANCHORED_RECT_KEYS, 'resolution', 'fillColor'],
  icon: [...COMMON_FIGURE_KEYS, 'image', 'opacity', 'interpolation', 'tint', ...ANCHORED_RECT_KEYS],
  path: [...COMMON_FIGURE_KEYS, ...COMMON_SHAPE_KEYS, 'path', 'offset', 'joinStyle', 'capStyle', 'fillRule'],
};

// --- enumerated valid values per key (NedCanvasFigureValidator.getValidValuesForPropertyKey) ---

const VALID_ANCHORS = ['n', 'w', 's', 'e', 'c', 'center', 'ne', 'nw', 'sw', 'se', 'start', 'middle', 'end'];
const VALID_BOOLEANS = ['true', 'false'];

/** Keys whose value is restricted to a fixed enum (color/image/transform keys are
 *  handled separately below, matching Java's special-cased branches). */
export const FIGURE_KEY_ENUMS: Readonly<Record<string, readonly string[]>> = {
  align: ['left', 'center', 'right'],
  anchor: VALID_ANCHORS,
  capStyle: ['butt', 'square', 'round'],
  startArrowhead: ['none', 'simple', 'triangle', 'barbed'],
  endArrowhead: ['none', 'simple', 'triangle', 'barbed'],
  visible: VALID_BOOLEANS,
  smooth: VALID_BOOLEANS,
  zoomLineWidth: VALID_BOOLEANS,
  halo: VALID_BOOLEANS,
  joinStyle: ['bevel', 'miter', 'round'],
  lineStyle: ['solid', 'dashed', 'dotted'],
  fillRule: ['evenodd', 'nonzero'],
  interpolation: ['none', 'fast', 'best'],
  // re-editing an already-typed `type=` value: offer the figure type names again.
  type: FIGURE_TYPES,
};

/** Color-typed keys: `color`/`lineColor`/`fillColor` always; `tint`'s first argument only. */
const COLOR_KEYS = new Set(['color', 'lineColor', 'fillColor']);

// --- property-key -> snippet-template completion (post `type=X;`) ---
// Ported from NedCompletionProcessor.java:406-510's hand-written `makeShortTemplate` calls.
// Eclipse's `${name}` JFace-template placeholders become LSP `${N:name}` tabstops.

interface KeyTemplate {
  insertText: string;
  doc: string;
}

/** Multiple entries for a key = multiple alternative shapes offered side by side
 *  (e.g. `innerSize=` has a 1-value and a 2-value form), matching Eclipse's practice
 *  of adding several templates for the same key. */
const KEY_TEMPLATES: Readonly<Record<string, readonly KeyTemplate[]>> = {
  tags: [{ insertText: 'tags=${1:tag1},${2:tag2};', doc: 'the tags on the figure' }],
  size: [{ insertText: 'size=${1:width},${2:height};', doc: 'the size of the figure' }],
  font: [{ insertText: 'font=${1:family},${2:size},${3:style};', doc: 'the font of the figure' }],
  innerSize: [
    { insertText: 'innerSize=${1:size};', doc: 'the inner size of the ring' },
    { insertText: 'innerSize=${1:width},${2:height};', doc: 'the inner size of the ring' },
  ],
  cornerRadius: [
    { insertText: 'cornerRadius=${1:r};', doc: 'the corner radius of the rectangle' },
    { insertText: 'cornerRadius=${1:rx},${2:ry};', doc: 'the corner radius of the rectangle' },
  ],
  offset: [{ insertText: 'offset=${1:dx},${2:dy};', doc: "the amount of offset added to the path's coordinates" }],
  points: [{ insertText: 'points=${1:x1},${2:y1}, ${3:x2},${4:y2};', doc: "the coordinates of the figure's points" }],
  pos: [{ insertText: 'pos=${1:x},${2:y};', doc: "the coordinates of the figure's anchored point" }],
  bounds: [{ insertText: 'bounds=${1:x},${2:y},${3:width},${4:height};', doc: 'the bounding rectangle of the figure' }],
  transform: [
    { insertText: 'transform=;', doc: 'the transformations of the figure' },
    {
      insertText: 'transform=((${1:a} ${2:b}) (${3:c} ${4:d}) (${5:t1} ${6:t2}));',
      doc: 'the transformation matrix of the figure',
    },
  ],
  tint: [
    { insertText: 'tint=${1:color};', doc: 'the tint color of the image' },
    { insertText: 'tint=${1:color},${2:amount};', doc: 'the tint color and amount (0..1) of the figure' },
  ],
  resolution: [{ insertText: 'resolution=${1:width},${2:height};', doc: 'the resolution of the pixmap' }],
};

/** Generic `key=${key};` fallback for a valid key with no hand-written template
 *  (and not `type`, handled separately by the first-argument completion). */
function genericKeyTemplate(key: string): KeyTemplate {
  return { insertText: `${key}=\${1:${key}};`, doc: '' };
}

// --- transform-function value templates (transform= argument, function form) ---
// Ported from NedCompletionProcessor.java's `key.equals(PKEY_TRANSFORM)` branch.

const TRANSFORM_TUPLE_TEMPLATE: KeyTemplate = {
  insertText: '((${1:a} ${2:b}) (${3:c} ${4:d}) (${5:t1} ${6:t2}))',
  doc: 'the transformation matrix of the figure',
};

const TRANSFORM_FUNCTION_TEMPLATES: readonly KeyTemplate[] = [
  { insertText: 'translate(${1:dx}, ${2:dy})', doc: 'translates the figure by (dx,dy)' },
  { insertText: 'rotate(${1:angle})', doc: 'rotates the figure by angle degrees clockwise' },
  { insertText: 'rotate(${1:angle}, ${2:cx}, ${3:cy})', doc: 'rotates the figure around (cx,cy) by angle degrees clockwise' },
  { insertText: 'scale(${1:s})', doc: 'scales the figure by s' },
  { insertText: 'scale(${1:sx}, ${2:sy})', doc: 'scales the figure by sx horizontally and sy vertically' },
  { insertText: 'scale(${1:s}, ${2:cx}, ${3:cy})', doc: 'scales the figure around (cx,cy) by s' },
  { insertText: 'scale(${1:sx}, ${2:sy}, ${3:cx}, ${4:cy})', doc: 'scales the figure around (cx,cy) by sx horizontally and sy vertically' },
  { insertText: 'skewx(${1:factor})', doc: 'skews the figure horizontally by factor' },
  { insertText: 'skewx(${1:factor}, ${2:fixy})', doc: 'skews the figure horizontally by factor, while the fixy line stays in place' },
  { insertText: 'skewy(${1:factor})', doc: 'skews the figure vertically by factor' },
  { insertText: 'skewy(${1:factor}, ${2:fixx})', doc: 'skews the figure vertically by factor, while the fixx line stays in place' },
  { insertText: 'matrix(${1:a}, ${2:b}, ${3:c}, ${4:d}, ${5:t1}, ${6:t2})', doc: 'multiplies the transform of the figure with an affine matrix' },
];

// --- completion-item builders ---

function templateItem(t: KeyTemplate): CompletionItem {
  // label mirrors Eclipse's template "name" (the pattern with `${...}` placeholders
  // stripped down to their default text), so multiple shapes for the same key show
  // up as distinct, self-describing candidates.
  const label = t.insertText.replace(/\$\{\d+:([^}]*)\}/g, '$1');
  return {
    label,
    kind: CompletionItemKind.Snippet,
    detail: t.doc || undefined,
    insertText: t.insertText,
    insertTextFormat: InsertTextFormat.Snippet,
  };
}

/** First unnamed argument of `@figure[...](...)`: figure type-name candidates,
 *  each inserting a complete `type=<name>;` tag. */
export function figureTypeCompletions(): CompletionItem[] {
  return FIGURE_TYPES.map((t) => ({
    label: t,
    kind: CompletionItemKind.EnumMember,
    detail: 'figure type',
    insertText: `type=${t};`,
  }));
}

/** Property-key completion once `type=X;` has already been typed: only the keys
 *  valid for that figure type, each with its (possibly multi-shape) snippet. */
export function figurePropertyKeyCompletions(type: string): CompletionItem[] {
  const keys = FIGURE_TYPE_KEYS[type];
  if (!keys) return [];
  const items: CompletionItem[] = [];
  for (const key of keys) {
    if (key === 'type') continue; // already chosen; handled by the first-argument branch
    const templates = KEY_TEMPLATES[key] ?? [genericKeyTemplate(key)];
    for (const t of templates) items.push(templateItem(t));
  }
  return items;
}

/**
 * Value completion for a given figure property key. `valueIndex` is which
 * comma-separated value slot the cursor is in (0 = first). `iconIds` is the
 * host-enumerated icon-id list (see `displayString.ts`'s `displayCompletions`
 * and `shared/src/node/docIcons.ts`'s `listIconIds`) — reused verbatim here for
 * the `image` key, matching Eclipse's unrestricted `addImageProposals(..., ".*", ...)`
 * (unlike display-string `bgi=`, no `maps/`-prefix restriction applies to figures).
 */
export function figureKeyValueCompletions(
  key: string,
  valueIndex: number,
  prefixAfterEquals: string,
  iconIds: string[] = [],
): CompletionItem[] {
  if (COLOR_KEYS.has(key) || (key === 'tint' && valueIndex === 0)) {
    return DISPLAY_COLORS.map((c) => ({ label: c, kind: CompletionItemKind.Color, detail: 'color' }));
  }
  if (key === 'image') {
    return iconIds.map((id) => ({ label: id, kind: CompletionItemKind.Value, detail: 'image' }));
  }
  if (key === 'transform') {
    const items: CompletionItem[] = [];
    if (valueIndex === 0) items.push(templateItem(TRANSFORM_TUPLE_TEMPLATE));
    // Once the tuple form `((` has been started, the function-call templates no
    // longer apply (matches Java's `!linePrefix.matches(".*=\\s*\\(\\(.*")`  guard).
    if (!/\(\(/.test(prefixAfterEquals)) {
      for (const t of TRANSFORM_FUNCTION_TEMPLATES) items.push(templateItem(t));
    }
    return items;
  }
  const enumValues = FIGURE_KEY_ENUMS[key];
  if (enumValues) {
    return enumValues.map((v) => ({ label: v, kind: CompletionItemKind.EnumMember, detail: key }));
  }
  return [];
}
