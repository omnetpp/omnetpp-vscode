import { CompletionItem, CompletionItemKind, InsertTextFormat } from '../model/completion';

/**
 * Display-string ("@display") content-assist model. Mirrors the IDE's
 * `IDisplayString.java` (Tag/Prop enums, contexts and per-argument enumerated
 * values) and covers all tags currently supported by Qtenv (see
 * `src/qtenv/{submoduleitem,compoundmoduleitem,connectionitem}.cc`).
 *
 * A display string is a `;`-separated list of tags, each `key=arg0,arg1,...`.
 * The three contexts (compound-module background, submodule, connection) admit
 * different tag sets. A compound module's own `@display` is used both as its
 * background (when opened) and as its submodule appearance (in the parent), so
 * the `compound` context is the superset that also carries the submodule tags.
 */
export type DisplayContext = 'compound' | 'submodule' | 'connection';

export type DisplayArgType = 'string' | 'int' | 'distance' | 'coord' | 'color' | 'image';

export interface DisplayEnumValue {
  value: string;
  label: string;
}

export interface DisplayArg {
  name: string;
  doc: string;
  type: DisplayArgType;
  /** Enumerated allowed values (shapes, sizes, anchors, ...), if any. */
  values?: DisplayEnumValue[];
}

export interface DisplayTag {
  key: string;
  name: string;
  contexts: DisplayContext[];
  args: DisplayArg[];
}

// --- enumerated value sets (from IDisplayString.Prop EnumSpec + Qtenv) ---

const LAYOUT_VALUES: DisplayEnumValue[] = [
  { value: 'row', label: 'row' },
  { value: 'column', label: 'column' },
  { value: 'matrix', label: 'matrix' },
  { value: 'ring', label: 'ring' },
  { value: 'cring', label: 'centered ring' },
  { value: 'exact', label: 'exact' },
];
const SHAPE_VALUES: DisplayEnumValue[] = [
  { value: 'rect', label: 'rectangle' },
  { value: 'oval', label: 'oval' },
];
// Qtenv icon-size codes (imagecache.h IconSize), including xs/xl extremes.
const ICONSIZE_VALUES: DisplayEnumValue[] = [
  { value: 'xs', label: 'extra small' },
  { value: 'vs', label: 'very small' },
  { value: 's', label: 'small' },
  { value: 'n', label: 'normal' },
  { value: 'l', label: 'large' },
  { value: 'vl', label: 'very large' },
  { value: 'xl', label: 'extra large' },
];
const FLIP_VALUES: DisplayEnumValue[] = [
  { value: 'none', label: 'none' },
  { value: 'h', label: 'horizontal' },
  { value: 'v', label: 'vertical' },
  { value: 'b', label: 'both' },
];
const TEXTPOS_VALUES: DisplayEnumValue[] = [
  { value: 'l', label: 'left' },
  { value: 'r', label: 'right' },
  { value: 't', label: 'top' },
];
const BGIMAGE_MODE_VALUES: DisplayEnumValue[] = [
  { value: 'fix', label: 'fix' },
  { value: 'tile', label: 'tile' },
  { value: 'stretch', label: 'stretch' },
  { value: 'center', label: 'center' },
];
const ROUTING_VALUES: DisplayEnumValue[] = [
  { value: 'a', label: 'auto' },
  { value: 'm', label: 'manual' },
  { value: 'n', label: 'north' },
  { value: 'e', label: 'east' },
  { value: 's', label: 'south' },
  { value: 'w', label: 'west' },
  { value: 'h', label: 'horizontal' },
  { value: 'v', label: 'vertical' },
];
const LINESTYLE_VALUES: DisplayEnumValue[] = [
  { value: 'solid', label: 'solid' },
  { value: 'dotted', label: 'dotted' },
  { value: 'dashed', label: 'dashed' },
];

const COLOR_FILL: DisplayArg = { name: 'fill color', doc: 'Fill color', type: 'color' };
const COLOR_BORDER: DisplayArg = { name: 'border color', doc: 'Border color', type: 'color' };
const BORDER_WIDTH: DisplayArg = { name: 'border width', doc: 'Border width', type: 'int' };

/** All display-string tags, grouped by the contexts that admit them. */
export const DISPLAY_TAGS: DisplayTag[] = [
  // --- compound-module background tags ---
  {
    key: 'bgb', name: 'Background box', contexts: ['compound'], args: [
      { name: 'width', doc: 'Width of the module background', type: 'distance' },
      { name: 'height', doc: 'Height of the module background', type: 'distance' },
      COLOR_FILL, COLOR_BORDER, BORDER_WIDTH,
    ],
  },
  {
    key: 'bgi', name: 'Background image', contexts: ['compound'], args: [
      { name: 'image', doc: 'Background image name', type: 'image' },
      { name: 'mode', doc: 'How to arrange the background image', type: 'string', values: BGIMAGE_MODE_VALUES },
    ],
  },
  {
    key: 'bgg', name: 'Background grid', contexts: ['compound'], args: [
      { name: 'distance', doc: 'Distance between major gridlines', type: 'distance' },
      { name: 'subdivision', doc: 'Minor gridlines per major', type: 'int' },
      { name: 'color', doc: 'Grid color', type: 'color' },
    ],
  },
  {
    key: 'bgtt', name: 'Background tooltip', contexts: ['compound'], args: [
      { name: 'tooltip', doc: 'Tooltip shown over the module background', type: 'string' },
    ],
  },
  {
    key: 'bgu', name: 'Distance unit', contexts: ['compound'], args: [
      { name: 'unit', doc: 'Name of the distance unit', type: 'string' },
    ],
  },
  {
    key: 'bgt', name: 'Background text', contexts: ['compound'], args: [
      { name: 'x', doc: 'X position', type: 'coord' },
      { name: 'y', doc: 'Y position', type: 'coord' },
      { name: 'text', doc: 'Text to display on the background', type: 'string' },
      { name: 'color', doc: 'Text color', type: 'color' },
    ],
  },

  // --- shared compound + submodule tags ---
  {
    key: 'p', name: 'Position', contexts: ['compound', 'submodule'], args: [
      { name: 'x', doc: 'X position', type: 'coord' },
      { name: 'y', doc: 'Y position', type: 'coord' },
      { name: 'arrangement', doc: 'Arrangement of submodule vectors', type: 'string', values: LAYOUT_VALUES },
      { name: 'arr. par1', doc: 'Arrangement parameter (depends on arrangement)', type: 'string' },
      { name: 'arr. par2', doc: 'Arrangement parameter (depends on arrangement)', type: 'string' },
      { name: 'arr. par3', doc: 'Arrangement parameter (depends on arrangement)', type: 'string' },
    ],
  },
  {
    key: 'g', name: 'Layout group', contexts: ['compound', 'submodule'], args: [
      { name: 'group', doc: 'Layout group name; groups unrelated modules for layout', type: 'string' },
    ],
  },
  {
    key: 'b', name: 'Box', contexts: ['compound', 'submodule'], args: [
      { name: 'width', doc: 'Width of the shape', type: 'distance' },
      { name: 'height', doc: 'Height of the shape', type: 'distance' },
      { name: 'shape', doc: 'Shape of the object', type: 'string', values: SHAPE_VALUES },
      COLOR_FILL, COLOR_BORDER, BORDER_WIDTH,
    ],
  },
  {
    key: 'i', name: 'Icon', contexts: ['compound', 'submodule'], args: [
      { name: 'icon', doc: 'An icon representing the object', type: 'image' },
      { name: 'tint color', doc: 'Color for tinting the icon', type: 'color' },
      { name: 'tint %', doc: 'Amount of tinting in percent (0-100)', type: 'int' },
    ],
  },
  {
    key: 'is', name: 'Icon size', contexts: ['compound', 'submodule'], args: [
      { name: 'size', doc: 'The size of the icon', type: 'string', values: ICONSIZE_VALUES },
    ],
  },
  {
    key: 'it', name: 'Icon transform', contexts: ['compound', 'submodule'], args: [
      { name: 'rotation', doc: 'Rotation in degrees (clockwise)', type: 'coord' },
      { name: 'flip', doc: 'Flip the icon', type: 'string', values: FLIP_VALUES },
      { name: 'scale x', doc: 'Horizontal scaling factor', type: 'coord' },
      { name: 'scale y', doc: 'Vertical scaling factor', type: 'coord' },
    ],
  },
  {
    key: 'i2', name: 'Status icon', contexts: ['compound', 'submodule'], args: [
      { name: 'overlay icon', doc: 'An icon added to the upper right corner', type: 'image' },
      { name: 'tint color', doc: 'Color for tinting the overlay icon', type: 'color' },
      { name: 'tint %', doc: 'Amount of tinting in percent (0-100)', type: 'int' },
    ],
  },
  {
    key: 'r', name: 'Range', contexts: ['compound', 'submodule'], args: [
      { name: 'radius', doc: 'Radius of the range indicator', type: 'distance' },
      COLOR_FILL, COLOR_BORDER, BORDER_WIDTH,
    ],
  },
  {
    key: 'q', name: 'Queue', contexts: ['compound', 'submodule'], args: [
      { name: 'queue object', doc: 'Displays the length of the named queue', type: 'string' },
    ],
  },

  // --- text/tooltip: compound + submodule + connection ---
  {
    key: 't', name: 'Text', contexts: ['compound', 'submodule', 'connection'], args: [
      { name: 'text', doc: 'Additional text to display', type: 'string' },
      { name: 'position', doc: 'Position of the text', type: 'string', values: TEXTPOS_VALUES },
      { name: 'color', doc: 'Color of the displayed text', type: 'color' },
    ],
  },
  {
    key: 'tt', name: 'Tooltip', contexts: ['compound', 'submodule', 'connection'], args: [
      { name: 'tooltip', doc: 'Tooltip to be displayed', type: 'string' },
    ],
  },

  // --- connection-only tags ---
  {
    key: 'm', name: 'Routing mode', contexts: ['connection'], args: [
      { name: 'src direction', doc: "Source exit direction: n/e/s/w, h/v, 'a' (auto), 'm' (manual)", type: 'string', values: ROUTING_VALUES },
      { name: 'dest dir / src anchor x', doc: 'Destination arrival direction, or source anchor x percentage', type: 'string', values: ROUTING_VALUES },
      { name: 'src anchor y', doc: 'Source anchor y as percentage', type: 'int' },
      { name: 'dest anchor x', doc: 'Destination anchor x as percentage', type: 'int' },
      { name: 'dest anchor y', doc: 'Destination anchor y as percentage', type: 'int' },
    ],
  },
  {
    key: 'ls', name: 'Line style', contexts: ['connection'], args: [
      { name: 'color', doc: 'Connection line color', type: 'color' },
      { name: 'width', doc: 'Connection line width', type: 'int' },
      { name: 'style', doc: 'Connection line style', type: 'string', values: LINESTYLE_VALUES },
    ],
  },
];

/** Standard named colors offered for color-typed arguments (mirrors ColorFactory). */
export const DISPLAY_COLORS: string[] = [
  'black', 'white', 'grey', 'gray', 'red', 'green', 'blue', 'yellow', 'cyan', 'magenta',
  'orange', 'pink', 'purple', 'brown', 'gold', 'silver', 'navy', 'teal', 'olive', 'maroon',
  'lime', 'aqua', 'darkgreen', 'darkblue', 'darkred', 'lightblue', 'lightgreen', 'lightgrey',
];

const TAG_BY_KEY = new Map(DISPLAY_TAGS.map((t) => [t.key, t]));

/**
 * Look up a tag by its display-string key. Indexed range tags (`r`, `r0`,
 * `r1`...) and background text (`bgt`, `bgt0`...) collapse to their base tag.
 */
function lookupTag(key: string): DisplayTag | undefined {
  const direct = TAG_BY_KEY.get(key);
  if (direct) return direct;
  const m = /^(bgt|r)\d+$/.exec(key);
  return m ? TAG_BY_KEY.get(m[1]) : undefined;
}

export type DisplayCursorContext =
  | { typingKey: true; partial: string }
  | { typingKey: false; tagKey: string; argIndex: number };

/**
 * Classify what is being typed at the cursor, given the display-string text
 * between the opening quote and the cursor. Either a tag key (start of a tag,
 * after `;` or at the very beginning) or an argument of the current tag.
 */
export function displayCursorContext(insideQuotes: string): DisplayCursorContext {
  const seg = insideQuotes.slice(insideQuotes.lastIndexOf(';') + 1);
  const eq = seg.indexOf('=');
  if (eq < 0) return { typingKey: true, partial: seg.trim() };
  const tagKey = seg.slice(0, eq).trim();
  const args = seg.slice(eq + 1);
  const argIndex = (args.match(/,/g) ?? []).length;
  return { typingKey: false, tagKey, argIndex };
}

/** A short `key=a,b,...` summary of a tag's arguments, for documentation. */
function argSummary(tag: DisplayTag): string {
  return `${tag.key}=${tag.args.map((a) => a.name).join(',')}`;
}

/** A snippet body with tabstops for the first one or two arguments. */
function tagSnippet(tag: DisplayTag): string {
  const n = Math.min(tag.args.length, 2);
  if (n === 0) return tag.key;
  const stops = tag.args.slice(0, n).map((a, i) => `\${${i + 1}:${a.name}}`);
  return `${tag.key}=${stops.join(',')}`;
}

/**
 * Build display-string completion proposals for a context and the in-quote
 * prefix up to the cursor: tag keys when starting a tag, otherwise enumerated /
 * color values for the current tag's argument.
 */
export function displayCompletions(ctx: DisplayContext, insideQuotes: string): CompletionItem[] {
  const cur = displayCursorContext(insideQuotes);

  if (cur.typingKey) {
    return DISPLAY_TAGS.filter((t) => t.contexts.includes(ctx)).map((t) => ({
      label: t.key,
      kind: CompletionItemKind.Property,
      detail: `${t.key} — ${t.name}`,
      documentation: argSummary(t),
      insertText: tagSnippet(t),
      insertTextFormat: InsertTextFormat.Snippet,
    }));
  }

  const tag = lookupTag(cur.tagKey);
  if (!tag) return [];
  const arg = tag.args[cur.argIndex];
  if (!arg) return [];

  if (arg.values) {
    return arg.values.map((v) => ({
      label: v.value,
      kind: CompletionItemKind.EnumMember,
      detail: v.label,
      documentation: `${tag.name} — ${arg.name}`,
    }));
  }
  if (arg.type === 'color') {
    return DISPLAY_COLORS.map((c) => ({
      label: c,
      kind: CompletionItemKind.Color,
      detail: `${tag.name} — ${arg.name}`,
    }));
  }
  // image / free-text arguments: no enumerated proposals (see plan "Out of scope")
  return [];
}
