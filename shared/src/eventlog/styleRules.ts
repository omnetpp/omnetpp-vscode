/**
 * styleRules.ts (PURE, host-agnostic) — the "Configure Style" rule model + evaluator,
 * port of `SequenceChartStyleProvider`/`MatchExpressionArrayFallback`/
 * `MatchExpressionFallback` (`omnetpp-dev/ui/org.omnetpp.sequencechart/src/org/omnetpp/
 * sequencechart/widgets/`, all three read in full) plus `ConfigureStyleDialog.java`
 * (the six-table editor UI it feeds) and `SequenceChartSettings.java` (the persisted
 * field shapes). Everything here is pure data + pure functions — no vscode/DOM — so it
 * lives in `shared/` per this repo's convention (host-agnostic analysis belongs there;
 * only the editor DOM lives in `client/webview/`).
 *
 * MODEL (verified against the Java, not assumed):
 *  - Six independent categories: Axes, Axis headers, Events, Self events, Message
 *    sends, Method calls — each has its own enable flag + ordered rule list
 *    (`SequenceChartSettings.enableXColoring` + `XColorFallback: Pair<String,String[]>[]`).
 *    A category whose enable flag is off behaves exactly as if its rule list were
 *    empty (`setSequenceChartSettings`: `enableAxesColoring ? getColorFallback(...) :
 *    new Pair[0]`) — this port folds that into `StyleRuleResolver.resolve()` directly
 *    rather than exposing a separate "gate" step.
 *  - Each rule is `(pattern, colors)`: `pattern` is a `MatchExpression` string (already
 *    ported at `../match/matchExpression.ts`, reused verbatim here — same glob/AND/OR/
 *    NOT/field syntax NED's own `@statistic` filters use), `colors` is the dialog's raw
 *    "Colors" cell text — a COMMA-SEPARATED list of color tokens (`ConfigureStyleDialog`
 *    uses a plain `TextCellEditor` for this column, not a picker; `getColorFallback()`
 *    parses each comma-split token as either the literal string `"light"`/`"dark"`
 *    (expanding to `ColorFactory.getGoodLightColors()`/`getGoodDarkColors()`, ported as
 *    `GOOD_LIGHT_COLORS`/`GOOD_DARK_COLORS` in `../graphics/colors.ts`) or a single
 *    `ColorFactory.asColor()`-parseable color (X11 name or `#rrggbb`/`@hhssbb`, ported as
 *    `parseColor()`) — an unparseable token is silently dropped, matching Java's
 *    `if (color != null) colors.add(color)`.
 *  - Resolution (`MatchExpressionFallback.resolveFallback`): rules are evaluated
 *    TOP-TO-BOTTOM, FIRST MATCH WINS (`for (i = 0..size) if (matcher.matches(obj))
 *    return values[i]`); a category with zero enabled rules, or where nothing matches,
 *    falls through to the caller's own default (Java: `defaultValue`, a single-color
 *    array) — this port returns `null` for "no override, use your own default" instead
 *    of re-exposing Java's literal default colors (those are UI-layer theme colors
 *    already computed in `client/webview/src/eventlog/common/theme.ts`/`drawList.ts`,
 *    not this module's concern).
 *  - A MATCHED rule's color list is then indexed by
 *    `Math.abs(identity.hashCode()) % colors.length` (`MatchExpressionArrayFallback.
 *    resolveArrayFallback`) — `identity` is always the object's DEFAULT (bare,
 *    no-argument) match string, even when the rule's pattern matched via a NAMED field
 *    (`fieldname =~ "..."`) — ported exactly (`indexAttribute` is `null` for all six
 *    fields in `SequenceChartStyleProvider`, so `resolveArrayFallback` always falls back
 *    to the bare `getAsString()`). This lets a single pattern like `"**"` (matches
 *    every module) auto-assign a stable, DISTINCT color per matched module/message/
 *    method — the "light"/"dark" palette tokens exist specifically for this.
 *    `javaStringHashCode()` below ports `java.lang.String.hashCode()` bit-for-bit
 *    (`s[0]*31^(n-1) + ... + s[n-1]`, 32-bit wraparound via `Math.imul`) so identical
 *    identity strings hash to the identical color Java would have chosen.
 *
 * IDENTITY STRINGS PER CATEGORY (verified by reading each `IMatchableObject`
 * implementation the Java style provider actually keys by — NOT assumed to be
 * "whatever's convenient"; the two module categories are asymmetric, which is easy to
 * get wrong):
 *  - Axes / Axis headers: keyed by `ModuleTreeItem`, whose `getAsString()` returns
 *    `getModuleName()` — the module's LOCAL name (e.g. `"host[2]"`), NOT its full
 *    dotted path. `getAsString("name")` is a synonym for the same value; no other
 *    named attribute exists.
 *  - Events / Self events: keyed by `IEvent` (`Event.getAsString()` /
 *    `getAsString("moduleName")`), which returns the event's owning module's FULL
 *    DOTTED PATH (`ModuleDescriptionEntry.fullName`, e.g. `"Net.host[2].app"`) — the
 *    OPPOSITE of the axis case. This asymmetry is real, not a porting slip (verified
 *    against both `ModuleTreeItem.getAsString()` and `Event.getAsString()`).
 *  - Message sends: keyed by a local wrapper around `MessageDescriptionEntry`, default
 *    = the message NAME; `getAsString("c")` = the message's class name (Java exposes a
 *    much larger token set — `n/c/k/p/l/er/m/sm/sg/st/am/ag/at/d/pe/id` — but this
 *    port's wire DTO (`RenderDependency`) only carries `messageName`/`messageClassName`,
 *    so only the default and `"c"` are supported; an attribute pattern using any other
 *    field always misses, same as an unknown attribute in Java).
 *  - Method calls: keyed by a local wrapper around `ComponentMethodBeginEntry`, default
 *    = the method NAME (`getAsString("m")` is a synonym for the same value; Java's other
 *    two attributes, `sm`/`tm`, are numeric component ids this port's `RenderMethodCall`
 *    DTO doesn't carry as strings, so they're not exposed here either).
 *
 * DEVIATION (documented, and a genuine improvement, not a shortcut): Java's own
 * `Math.abs(indexAttributeValue.hashCode())` can, for the one-in-4-billion string whose
 * `hashCode()` is exactly `Integer.MIN_VALUE`, stay NEGATIVE (`Math.abs` has no positive
 * 32-bit representation for that value) and throw `ArrayIndexOutOfBoundsException`. This
 * port's `javaStringHashCode()` still returns the same 32-bit-wrapped value Java would,
 * but `Math.abs()` on a JS `number` is exact for any 32-bit integer magnitude (JS numbers
 * are not 32-bit ints), so the index is always non-negative here — the crash simply
 * doesn't reproduce. Not "fixed" by special-casing, just doesn't exist in this port.
 */

import { GOOD_DARK_COLORS, GOOD_LIGHT_COLORS, parseColor } from '../graphics/colors';
import { MatchExpression, type Matchable } from '../match/matchExpression';

// ---------------------------------------------------------------------------------
// Persisted / wire shape
// ---------------------------------------------------------------------------------

export type StyleCategory = 'axes' | 'axisHeaders' | 'events' | 'selfEvents' | 'messageSends' | 'methodCalls';

/** Display order + labels for the six category tabs — used by both the editor dialog and (for stable iteration) the resolver's compile step. */
export const STYLE_CATEGORIES: readonly { id: StyleCategory; label: string }[] = [
  { id: 'axes', label: 'Axes' },
  { id: 'axisHeaders', label: 'Axis headers' },
  { id: 'events', label: 'Events' },
  { id: 'selfEvents', label: 'Self events' },
  { id: 'messageSends', label: 'Message sends' },
  { id: 'methodCalls', label: 'Method calls' },
];

/** One row of a category's table: a `MatchExpression` pattern and the dialog's raw (unparsed) Colors cell text. */
export interface StyleRule {
  pattern: string;
  /** Comma-separated color tokens (literal color names/hex, or `"light"`/`"dark"`) — see this file's header. */
  colors: string;
}

export interface StyleCategorySettings {
  enabled: boolean;
  rules: StyleRule[];
}

export type StyleRuleSettings = Record<StyleCategory, StyleCategorySettings>;

export function emptyStyleCategorySettings(): StyleCategorySettings {
  return { enabled: false, rules: [] };
}

/** All six categories, disabled with no rules — matches Java's out-of-the-box `SequenceChartSettings` (every `enableXColoring` unset/false), i.e. the non-regression default this whole feature must fall back to. */
export function defaultStyleRuleSettings(): StyleRuleSettings {
  return {
    axes: emptyStyleCategorySettings(),
    axisHeaders: emptyStyleCategorySettings(),
    events: emptyStyleCategorySettings(),
    selfEvents: emptyStyleCategorySettings(),
    messageSends: emptyStyleCategorySettings(),
    methodCalls: emptyStyleCategorySettings(),
  };
}

/**
 * Sanitizes an arbitrary value read from persisted settings (a VS Code configuration
 * value, or old/foreign JSON) into a valid `StyleRuleSettings` — every field
 * defensively defaulted rather than trusting the shape, since this is the one place
 * untrusted external JSON (a user-edited `settings.json`, or the stale `styleRules:
 * []` array default this setting shipped with before this phase) enters the model.
 */
export function coerceStyleRuleSettings(value: unknown): StyleRuleSettings {
  const result = defaultStyleRuleSettings();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return result;
  const obj = value as Record<string, unknown>;
  for (const { id } of STYLE_CATEGORIES) {
    const raw = obj[id];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const rawObj = raw as Record<string, unknown>;
    const enabled = rawObj.enabled === true;
    const rules: StyleRule[] = [];
    if (Array.isArray(rawObj.rules)) {
      for (const r of rawObj.rules) {
        if (r === null || typeof r !== 'object') continue;
        const rObj = r as Record<string, unknown>;
        if (typeof rObj.pattern === 'string' && typeof rObj.colors === 'string') rules.push({ pattern: rObj.pattern, colors: rObj.colors });
      }
    }
    result[id] = { enabled, rules };
  }
  return result;
}

// ---------------------------------------------------------------------------------
// Color-token expansion — port of `SequenceChartStyleProvider.getColorFallback()`
// ---------------------------------------------------------------------------------

/** Splits a rule's raw Colors cell text and resolves each comma-separated token to a `#rrggbb` string, expanding `"light"`/`"dark"` to the 10-color "good color" palettes and silently dropping any token `parseColor()` can't resolve (matches Java's `if (color != null) colors.add(color)`). */
export function expandStyleColorTokens(colorsField: string): string[] {
  const out: string[] = [];
  for (const raw of colorsField.split(',')) {
    const token = raw.trim();
    if (token === '') continue;
    if (token === 'light') {
      out.push(...GOOD_LIGHT_COLORS);
      continue;
    }
    if (token === 'dark') {
      out.push(...GOOD_DARK_COLORS);
      continue;
    }
    const resolved = parseColor(token);
    if (resolved !== undefined) out.push(resolved);
  }
  return out;
}

// ---------------------------------------------------------------------------------
// java.lang.String.hashCode() port — used for the "pick one of N colors" index
// ---------------------------------------------------------------------------------

/** Port of `java.lang.String.hashCode()`: `s[0]*31^(n-1) + s[1]*31^(n-2) + ... + s[n-1]`, computed left-to-right with 32-bit wraparound (`Math.imul` mirrors Java `int` overflow). Iterates UTF-16 code units via `charCodeAt`, same as Java's own `char` iteration, so ASCII/BMP identifiers (module names, message/method names — the only inputs this is ever called with) hash identically to Java. */
export function javaStringHashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

// ---------------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------------

interface CompiledRule {
  /** `null` when `pattern` failed to parse (`MatchExpression`'s constructor throws on malformed input) — skipped at resolve time, same as a rule that simply never matches (Java has no analogous "row failed to compile" state since its `TextCellEditor` never round-trips through a throwing parser at edit time; this port degrades to "this rule is inert" rather than crashing the whole resolver). */
  matcher: MatchExpression | null;
  colors: string[];
}

interface CompiledCategory {
  enabled: boolean;
  rules: CompiledRule[];
}

/**
 * Precompiles a `StyleRuleSettings` once (parsing every pattern, expanding every color
 * list) so `resolve()` — called once per drawn axis/event/arrow, potentially thousands
 * of times per frame — does no parsing work. Construct one instance per settings
 * version (the caller, `chartMain.ts`, rebuilds it whenever `styleRules` changes, not
 * on every frame).
 */
export class StyleRuleResolver {
  private readonly compiled: Record<StyleCategory, CompiledCategory>;

  constructor(settings?: StyleRuleSettings) {
    const s = settings ?? defaultStyleRuleSettings();
    const compiled = {} as Record<StyleCategory, CompiledCategory>;
    for (const { id } of STYLE_CATEGORIES) {
      const cat = s[id] ?? emptyStyleCategorySettings();
      const rules: CompiledRule[] = cat.rules.map((rule) => {
        let matcher: MatchExpression | null = null;
        try {
          // Java: `new MatchExpression(expression, /*dottedpath*/ false, /*fullstring*/ false, /*casesensitive*/ true)` — verified in `MatchExpressionFallback.addFallback()`.
          matcher = new MatchExpression(rule.pattern, false, false, true);
        } catch {
          matcher = null;
        }
        return { matcher, colors: expandStyleColorTokens(rule.colors) };
      });
      compiled[id] = { enabled: cat.enabled, rules };
    }
    this.compiled = compiled;
  }

  /**
   * Resolves `category`'s override color for `matchable`, or `null` when the category
   * is disabled/empty, nothing matches, or the matched rule's color list is empty
   * (Java would divide-by-zero/index a length-0 array there — `null` "no override" is
   * this port's documented, crash-free substitute). `null` always means "the caller's
   * own existing default color applies unchanged".
   */
  resolve(category: StyleCategory, matchable: Matchable): string | null {
    const compiled = this.compiled[category];
    if (!compiled.enabled) return null;
    for (const rule of compiled.rules) {
      if (rule.matcher === null) continue;
      if (!rule.matcher.matches(matchable)) continue;
      if (rule.colors.length === 0) return null;
      const identity = matchable.getAsString() ?? '';
      const index = Math.abs(javaStringHashCode(identity)) % rule.colors.length;
      return rule.colors[index];
    }
    return null;
  }
}

// ---------------------------------------------------------------------------------
// Matchable builders — one per category's identity-string convention (see this file's
// header). Kept here (not duplicated at each `drawList.ts` call site) so the
// attribute-name mapping stays in exactly one place.
// ---------------------------------------------------------------------------------

/** Axes / Axis headers: local module name, `getAsString("name")` synonym. */
export function axisMatchable(localModuleName: string): Matchable {
  return { getAsString: (attribute) => (attribute === undefined || attribute === 'name' ? localModuleName : null) };
}

/** Events / Self events: the event's owning module's FULL dotted path (see this file's header for why this differs from `axisMatchable`), `getAsString("moduleName")` synonym. */
export function eventMatchable(moduleFullPath: string): Matchable {
  return { getAsString: (attribute) => (attribute === undefined || attribute === 'moduleName' ? moduleFullPath : null) };
}

/** Message sends: message name (default / `"n"`), class name (`"c"`, `null` if unknown). */
export function messageSendMatchable(messageName: string, messageClassName: string | null): Matchable {
  return {
    getAsString: (attribute) => {
      if (attribute === undefined || attribute === 'n') return messageName;
      if (attribute === 'c') return messageClassName;
      return null;
    },
  };
}

/** Method calls: method name, `getAsString("m")` synonym. */
export function methodCallMatchable(methodName: string): Matchable {
  return { getAsString: (attribute) => (attribute === undefined || attribute === 'm' ? methodName : null) };
}
