import type { Node as SyntaxNode } from 'web-tree-sitter';
import { childrenOfType } from '../parser/treeUtils';
import { nedPropertyInfo, sectionNode } from './nedAst';

/**
 * Display-string ("@display") *instance* model: parses actual display-string
 * values and resolves properties through the inheritance fallback chain, with
 * the IDE's default-value semantics. This is the value-level counterpart of
 * the content-assist schema in `displayString.ts`.
 *
 * Faithful port of the Eclipse IDE's `DisplayString.java` /
 * `IDisplayString.java` (ui/org.omnetpp.ned.model, ui/org.omnetpp.common.core):
 * same parse rules (`\` escapes, `${...}` passthrough), same two-tier defaults
 * (EMPTY_DEFAULTS for absent values, VARIABLE_DEFAULTS as placeholder visuals
 * for unresolved `$param` references), same `-` antivalue that neutralizes an
 * inherited value, and the same reverse-order enum shorthand matching.
 */

// ---- parsing ---------------------------------------------------------------

/** Tag name → argument list, in declaration order. Unknown tags are kept. */
export type DisplayTags = Map<string, string[]>;

/** `${...}`: index of the matching `}` (nesting- and quote-aware), or end of text. */
function closeBraceIndex(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
    } else if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      if (--depth === 0) return i;
    }
  }
  return text.length - 1; // unbalanced: take the rest (the IDE throws; we render best-effort)
}

/**
 * Parse a display string (`tag=arg1,arg2;tag2=...`) into its tags. Port of
 * `DisplayString.parseTags`: `\` escapes the next char (for `\;` `\=` `\,`),
 * and `${...}` expressions are carried verbatim as argument text.
 */
export function parseDisplayString(text: string): DisplayTags {
  const tags: DisplayTags = new Map();
  let args: string[] | undefined;
  let sb = '';
  let insideTagName = true;

  const openTag = (name: string): void => {
    args = [];
    tags.set(name, args);
    insideTagName = false;
  };

  for (let pos = 0; pos < text.length; pos++) {
    const c = text[pos];
    if (c === '\\' && pos + 1 < text.length) {
      sb += text[++pos];
    } else if (c === ';') {
      if (insideTagName) openTag(sb);
      else args!.push(sb);
      sb = '';
      insideTagName = true;
    } else if (c === '$' && text[pos + 1] === '$' && !insideTagName) {
      sb += text[pos + 1];
    } else if (c === '$' && text[pos + 1] === '{' && !insideTagName) {
      const end = closeBraceIndex(text, pos + 1);
      sb += text.slice(pos, end + 1);
      pos = end;
    } else if (c === '=' && insideTagName) {
      openTag(sb);
      sb = '';
    } else if (c === ',' && !insideTagName) {
      args!.push(sb);
      sb = '';
    } else {
      sb += c;
    }
  }
  if (sb.length > 0) {
    if (insideTagName) openTag(sb);
    else args!.push(sb);
  }
  return tags;
}

// ---- property schema (IDisplayString.Prop) ---------------------------------

export type DisplayPropType = 'string' | 'integer' | 'distance' | 'coordinate' | 'color' | 'image';

/** One `name=shorthandRegex` alternative of an enumerated argument. */
interface EnumItem {
  name: string;
  regex: RegExp;
}

export interface DisplayProp {
  tag: string;
  pos: number;
  type: DisplayPropType;
  enumItems?: EnumItem[];
}

const item = (name: string, regex: string): EnumItem => ({ name, regex: new RegExp(`^(?:${regex})$`) });

const LAYOUT_ENUM = [
  item('row', 'r.*'), item('column', 'c.*'), item('matrix', 'm.*'),
  item('ring', 'ri.*'), item('cring', 'cr.*'), item('exact', 'e.*|x.*'),
];
const SHAPE_ENUM = [item('rectangle', 'r.*'), item('oval', 'o.*')];
const IMAGE_SIZE_ENUM = [
  item('very small', 'v.*s.*'), item('small', 's.*'), item('normal', 'n.*'),
  item('large', 'l.*'), item('very large', 'v[^s]*l.*'),
];
const FLIP_ENUM = [item('none', 'none|'), item('horizontal', 'h.*'), item('vertical', 'v.*'), item('both', 'b.*')];
const TEXT_POS_ENUM = [item('left', 'l.*'), item('right', 'r.*'), item('top', 't.*')];
const BG_IMAGE_MODE_ENUM = [item('fix', 'f.*'), item('tile', 't.*'), item('stretch', 's.*'), item('center', 'c.*')];
const ROUTING_ENUM = [
  item('horizontal', 'h.*'), item('vertical', 'v.*'), item('south', 's.*'), item('north', 'n.*'),
  item('east', 'e.*'), item('west', 'w.*'), item('auto', 'a.*'), item('manual', 'm.*'),
];
const ROUTING_DEST_ENUM = ROUTING_ENUM.slice(0, -1);
const LINE_STYLE_ENUM = [item('solid', 's.*'), item('dotted', 'd.*'), item('dashed', 'da.*')];

const p = (tag: string, pos: number, type: DisplayPropType, enumItems?: EnumItem[]): DisplayProp =>
  ({ tag, pos, type, enumItems });

/** All display-string properties, named as in the IDE's `IDisplayString.Prop`. */
export const Prop = {
  X: p('p', 0, 'coordinate'),
  Y: p('p', 1, 'coordinate'),
  LAYOUT: p('p', 2, 'string', LAYOUT_ENUM),
  LAYOUT_PAR1: p('p', 3, 'string'),
  LAYOUT_PAR2: p('p', 4, 'string'),
  LAYOUT_PAR3: p('p', 5, 'string'),
  LAYOUT_GROUP: p('g', 0, 'string'),

  SHAPE_WIDTH: p('b', 0, 'distance'),
  SHAPE_HEIGHT: p('b', 1, 'distance'),
  SHAPE: p('b', 2, 'string', SHAPE_ENUM),
  SHAPE_FILL_COLOR: p('b', 3, 'color'),
  SHAPE_BORDER_COLOR: p('b', 4, 'color'),
  SHAPE_BORDER_WIDTH: p('b', 5, 'integer'),

  IMAGE: p('i', 0, 'image'),
  IMAGE_COLOR: p('i', 1, 'color'),
  IMAGE_COLOR_PERCENTAGE: p('i', 2, 'integer'),
  IMAGE_SIZE: p('is', 0, 'string', IMAGE_SIZE_ENUM),
  IMAGE_ROTATION: p('it', 0, 'coordinate'),
  IMAGE_FLIP: p('it', 1, 'string', FLIP_ENUM),
  IMAGE_SCALE_X: p('it', 2, 'coordinate'),
  IMAGE_SCALE_Y: p('it', 3, 'coordinate'),
  IMAGE2: p('i2', 0, 'image'),
  IMAGE2_COLOR: p('i2', 1, 'color'),
  IMAGE2_COLOR_PERCENTAGE: p('i2', 2, 'integer'),

  RANGE: p('r', 0, 'distance'),
  RANGE_FILL_COLOR: p('r', 1, 'color'),
  RANGE_BORDER_COLOR: p('r', 2, 'color'),
  RANGE_BORDER_WIDTH: p('r', 3, 'integer'),

  QUEUE_NAME: p('q', 0, 'string'),
  TEXT: p('t', 0, 'string'),
  TEXT_POS: p('t', 1, 'string', TEXT_POS_ENUM),
  TEXT_COLOR: p('t', 2, 'color'),
  TOOLTIP: p('tt', 0, 'string'),

  MODULE_WIDTH: p('bgb', 0, 'distance'),
  MODULE_HEIGHT: p('bgb', 1, 'distance'),
  MODULE_FILL_COLOR: p('bgb', 2, 'color'),
  MODULE_BORDER_COLOR: p('bgb', 3, 'color'),
  MODULE_BORDER_WIDTH: p('bgb', 4, 'integer'),
  MODULE_TOOLTIP: p('bgtt', 0, 'string'),
  MODULE_IMAGE: p('bgi', 0, 'image'),
  MODULE_IMAGE_ARRANGEMENT: p('bgi', 1, 'string', BG_IMAGE_MODE_ENUM),
  MODULE_GRID_DISTANCE: p('bgg', 0, 'distance'),
  MODULE_GRID_SUBDIVISION: p('bgg', 1, 'integer'),
  MODULE_GRID_COLOR: p('bgg', 2, 'color'),
  MODULE_UNIT: p('bgu', 0, 'string'),

  ROUTING_CONSTRAINT: p('m', 0, 'string', ROUTING_ENUM),
  ROUTING_ANCHOR_SRCX: p('m', 1, 'string', ROUTING_DEST_ENUM),
  ROUTING_ANCHOR_SRCY: p('m', 2, 'integer'),
  ROUTING_ANCHOR_DESTX: p('m', 3, 'integer'),
  ROUTING_ANCHOR_DESTY: p('m', 4, 'integer'),

  CONNECTION_COLOR: p('ls', 0, 'color'),
  CONNECTION_WIDTH: p('ls', 1, 'integer'),
  CONNECTION_STYLE: p('ls', 2, 'string', LINE_STYLE_ENUM),
} as const satisfies Record<string, DisplayProp>;

export type DisplayPropName = keyof typeof Prop;

/**
 * Canonical enum name for a raw argument value (e.g. `da` → `dashed`).
 * Items are matched in REVERSE declaration order against the whole value,
 * exactly like the IDE's `EnumSpec` (so `d`→dotted but `da`→dashed).
 */
export function enumNameFor(prop: DisplayProp, value: string): string | undefined {
  if (!prop.enumItems) return undefined;
  for (let i = prop.enumItems.length - 1; i >= 0; i--) {
    if (prop.enumItems[i].regex.test(value)) return prop.enumItems[i].name;
  }
  return undefined;
}

// ---- resolved display string (fallback chain + defaults) -------------------

/** Explicitly disables an inherited value, reverting to the empty-default. */
export const ANTIVALUE = '-';

/** Default values used when a tag/argument is completely absent. */
export const EMPTY_DEFAULTS_STR =
  'i=,,30;i2=,,30;b=40,24,rect,#8080ff,black,2;t=,t,blue;r=,,black,1;bgb=,,grey82,black,2;bgg=,1,grey;bgi=,fixed;ls=black,1,solid;bgu=m';

/** Placeholder values shown when an argument is an unresolved `$param` reference. */
export const VARIABLE_DEFAULTS_STR =
  'i=abstract/server,red,50;i2=status/execute,red,50;b=40,24,rect,#8080ff,black,2;t=Sample text,t,blue;r=100,white,black,3;bgb=300,200,white,black,5;bgg=100,2,black;bgi=,center;ls=green,3,dashed;bgu=km';

export interface PointF {
  x: number;
  y: number;
}

export interface DimensionF {
  width?: number;
  height?: number;
}

/**
 * A display string with an optional fallback (the owner's type / supertype
 * display string), resolving property values the way the graphical NED editor
 * does. All getters walk: local value → `$param` placeholder / `-` antivalue
 * handling → fallback chain → EMPTY_DEFAULTS.
 */
export class DisplayString {
  readonly tags: DisplayTags;

  constructor(value?: string, readonly fallback?: DisplayString) {
    this.tags = parseDisplayString(value ?? '');
  }

  /** Raw local arg: undefined if the tag is absent, '' if the arg is empty. */
  tagArg(tagName: string, pos: number): string | undefined {
    const args = this.tags.get(tagName);
    return args === undefined ? undefined : args[pos] ?? '';
  }

  /** The local (unresolved) value of a property; undefined if its tag is absent. */
  getAsStringLocal(prop: DisplayProp): string | undefined {
    return this.tagArg(prop.tag, prop.pos);
  }

  /** Port of `getTagArgUsingDefaults`: local → placeholder/antivalue → fallback → default. */
  getAsString(prop: DisplayProp, useEmptyDefaults = true, useVariableDefaults = true): string {
    const value = this.tagArg(prop.tag, prop.pos) ?? '';
    if (value.startsWith('$') && useVariableDefaults) return VARIABLE_DEFAULTS.tagArg(prop.tag, prop.pos) ?? '';
    if (value === ANTIVALUE) return useEmptyDefaults ? EMPTY_DEFAULTS.tagArg(prop.tag, prop.pos) ?? '' : '';
    if (value.length > 0) return value;
    if (this.fallback) return this.fallback.getAsString(prop, useEmptyDefaults, useVariableDefaults);
    return useEmptyDefaults ? EMPTY_DEFAULTS.tagArg(prop.tag, prop.pos) ?? '' : '';
  }

  /** Whether the property has a value in this display string or the fallback chain. */
  containsProperty(prop: DisplayProp): boolean {
    if ((this.tagArg(prop.tag, prop.pos) ?? '') !== '') return true;
    return this.fallback?.containsProperty(prop) ?? false;
  }

  /** Whether the tag appears in this display string or the fallback chain. */
  containsTag(tagName: string): boolean {
    return this.tags.has(tagName) || (this.fallback?.containsTag(tagName) ?? false);
  }

  /** Whether the effective value is an unresolved `$param`/`${expr}` placeholder. */
  isVariable(prop: DisplayProp): boolean {
    const value = this.tagArg(prop.tag, prop.pos) ?? '';
    if (value.startsWith('$')) return true;
    if (value.length > 0) return false;
    return this.fallback?.isVariable(prop) ?? false;
  }

  /** Canonical enum name of the resolved value (e.g. `da` → `dashed`). */
  getAsEnum(prop: DisplayProp): string | undefined {
    return enumNameFor(prop, this.getAsString(prop));
  }

  getAsInt(prop: DisplayProp, defaultValue: number): number {
    const value = Number(this.getAsString(prop));
    return Number.isFinite(value) && this.getAsString(prop).trim() !== '' ? Math.trunc(value) : defaultValue;
  }

  /** A positive distance value, or undefined (missing/invalid/non-positive). */
  getAsDistance(prop: DisplayProp): number | undefined {
    const text = this.getAsString(prop).trim();
    const value = Number(text);
    return text !== '' && Number.isFinite(value) && value > 0 ? value : undefined;
  }

  /** A coordinate value, or undefined (missing/invalid). */
  getAsCoordinate(prop: DisplayProp): number | undefined {
    const text = this.getAsString(prop).trim();
    const value = Number(text);
    return text !== '' && Number.isFinite(value) ? value : undefined;
  }

  /** The `p` tag position, or undefined when the module is unpinned. */
  getLocation(): PointF | undefined {
    const x = this.getAsCoordinate(Prop.X);
    const y = this.getAsCoordinate(Prop.Y);
    return x === undefined || y === undefined ? undefined : { x, y };
  }

  /** The `b` tag size; a missing dimension mirrors the other one if that is set. */
  getSize(): DimensionF {
    let width = this.getAsDistance(Prop.SHAPE_WIDTH);
    let height = this.getAsDistance(Prop.SHAPE_HEIGHT);
    const widthExists = this.containsProperty(Prop.SHAPE_WIDTH);
    const heightExists = this.containsProperty(Prop.SHAPE_HEIGHT);
    if (!widthExists && heightExists) width = height;
    else if (widthExists && !heightExists) height = width;
    return { width, height };
  }

  /** The `bgb` tag size; missing dimensions mean "fit to contents". */
  getCompoundSize(): DimensionF {
    return { width: this.getAsDistance(Prop.MODULE_WIDTH), height: this.getAsDistance(Prop.MODULE_HEIGHT) };
  }

  /** The `r` tag range radius, or undefined if not specified. */
  getRange(): number | undefined {
    return this.getAsDistance(Prop.RANGE);
  }
}

export const EMPTY_DEFAULTS = new DisplayString(EMPTY_DEFAULTS_STR);
export const VARIABLE_DEFAULTS = new DisplayString(VARIABLE_DEFAULTS_STR);

// ---- AST extraction ---------------------------------------------------------

/**
 * Unescape a NED string literal (strip quotes, interpret `\n`, `\t`, `\xHH`,
 * `\\`, `\"`, line continuations). Unknown escapes — notably `\;` `\,` `\=`,
 * which `opp_parsequotedstr` rejects — are kept verbatim so the display-string
 * parser still sees them; we render best-effort instead of failing.
 */
export function unquoteNedString(literal: string): string {
  let text = literal.trim();
  const quote = text[0];
  if ((quote === '"' || quote === "'") && text.length >= 2 && text.endsWith(quote)) text = text.slice(1, -1);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== '\\' || i + 1 >= text.length) {
      out += c;
      continue;
    }
    const e = text[++i];
    if (e === 'b') out += '\b';
    else if (e === 'f') out += '\f';
    else if (e === 'n') out += '\n';
    else if (e === 'r') out += '\r';
    else if (e === 't') out += '\t';
    else if (e === '\\') out += '\\';
    else if (e === '"' || e === "'") out += e;
    else if (e === '\n') { /* line continuation */ }
    else if (e === 'x') {
      let hex = '';
      while (hex.length < 2 && /[0-9a-fA-F]/.test(text[i + 1] ?? '')) hex += text[++i];
      out += String.fromCharCode(parseInt(hex || '0', 16));
    } else out += '\\' + e; // unknown escape: keep for the display-string parser
  }
  return out;
}

/**
 * The `@display("...")` value declared on a NED type, submodule or connection
 * node (unquoted and unescaped), or undefined. Types and submodules carry it
 * in their `parameters` section; connections carry it as an inline property.
 * If several `@display` properties are present, the last one wins.
 */
export function displayStringLiteralOf(node: SyntaxNode): string | undefined {
  const holder = node.type === 'connection' ? node : sectionNode(node, 'parameters') ?? node;
  let result: string | undefined;
  for (const property of childrenOfType(holder, 'property')) {
    const info = nedPropertyInfo(property);
    if (info.name !== 'display') continue;
    const raw = info.tags[0]?.value;
    if (raw !== undefined) result = unquoteNedString(raw);
  }
  return result;
}
