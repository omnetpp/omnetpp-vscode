import type { Tree, Node as SyntaxNode } from 'web-tree-sitter';
import type { Position } from '../model/location';
import { CompletionItem, CompletionItemKind } from '../model/completion';
import { ancestorOfType, namedDescendantAt } from '../parser/treeUtils';
import { NedResourceCache, NedFileInfo } from './nedResourceCache';
import { NedTypeInfo } from './nedTypeInfo';
import { NED_TYPE_NODES, NedTypeKind } from './nedAst';
import { DisplayContext, displayCompletions } from './displayString';
import {
  propertyCompletions,
  unitNameCompletions,
  signalArgCompletions,
  statisticArgCompletions,
  recordModeCompletions,
  interpolationModeCompletions,
} from './nedProperties';
import { expressionBuiltinCompletions } from './nedExpressionBuiltins';
import {
  figureTypeCompletions,
  figurePropertyKeyCompletions,
  figureKeyValueCompletions,
} from './nedFigureSchema';
import {
  globalSkeletonCompletions,
  submoduleSkeletonCompletions,
  connectionSkeletonCompletions,
} from './nedTemplates';

const TOP_LEVEL_KEYWORDS = [
  'import', 'simple', 'module', 'network', 'channel', 'moduleinterface', 'channelinterface',
];
// type-definition keywords (valid at file top level and inside a `types:` section)
const TYPE_DEF_KEYWORDS = TOP_LEVEL_KEYWORDS.filter((k) => k !== 'import');
const SECTION_KEYWORDS = ['parameters', 'gates', 'types', 'submodules', 'connections'];
const PARAM_TYPE_KEYWORDS = ['int', 'double', 'string', 'bool', 'object', 'xml', 'volatile'];
const GATE_TYPE_KEYWORDS = ['input', 'output', 'inout'];

/**
 * Doc-comment keywords (after `@`) and HTML tags (after `<`), as in the IDE.
 * Ported from: ui/org.omnetpp.common/src/org/omnetpp/common/editor/text/Keywords.java
 * (`DOC_KEYWORDS`, `DOC_TAGS`, `NED_GATE_TYPES`, `NED_PARAM_TYPES` fields).
 * This is the `NED_DOC` partition (a plain `//` comment); see `DOC_TODO_KEYWORDS`
 * below for the separate `NED_PRIVATE_DOC` (`//#`) partition's keyword set.
 */
export const DOC_KEYWORDS = [
  'author', 'bug', 'date', 'see', 'since', 'todo', 'version', 'warning', 'page', 'titlepage',
];
export const DOC_TAGS = [
  'a', 'b', 'body', 'br', 'center', 'caption', 'code', 'dd', 'dfn', 'dl', 'dt', 'em', 'form',
  'font', 'hr', 'h1', 'h2', 'h3', 'i', 'input', 'img', 'li', 'meta', 'multicol', 'ol', 'p',
  'pre', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'td', 'th', 'tr', 'tt', 'kbd', 'u',
  'ul', 'var',
];

/**
 * Keywords for a `//#`-prefixed "private"/internal doc comment (the `NED_PRIVATE_DOC`
 * partition). Ported from `Keywords.DOC_TODO`
 * (ui/org.omnetpp.common/src/org/omnetpp/common/editor/text/Keywords.java).
 */
export const DOC_TODO_KEYWORDS = ['CHECKME', 'FIXME', 'TBD', 'TODO'];

/**
 * Completion inside a `//` or `//#` documentation comment.
 *
 * Eclipse's `NedContentAssistPartitionScanner` (ui/org.omnetpp.ned.editor/.../text/assist/
 * NedContentAssistPartitionScanner.java) partitions a `//#`-prefixed line as
 * `NED_PRIVATE_DOC` (its rule is tried before the plain `//` rule, so the literal `//#`
 * — no whitespace between `//` and `#` — wins); everything else starting with `//` is
 * `NED_DOC`.
 *
 * `NedPrivateDocCompletionProcessor` (same directory) offers only
 * `Keywords.DOC_TODO` (`CHECKME`/`FIXME`/`TBD`/`TODO`) for the private partition, matched
 * against the current word under the cursor — unlike `NedDocCompletionProcessor`, it is
 * NOT gated behind a leading `@`, and it has no `<`/HTML-tag branch at all (`DOC_TAGS` is
 * never offered in a `//#` comment).
 *
 * `NedDocCompletionProcessor` (the regular `NED_DOC` partition) offers `DOC_KEYWORDS`
 * after `@` and `DOC_TAGS` after `<`/`</`, as before.
 *
 * Returns undefined when not in a doc-comment context.
 */
export function docCommentCompletion(prefix: string): CompletionItem[] | undefined {
  const comment = prefix.indexOf('//');
  if (comment < 0) return undefined;
  const inComment = prefix.slice(comment);
  if (inComment.startsWith('//#')) {
    return DOC_TODO_KEYWORDS.map((label) => ({ label, kind: CompletionItemKind.Keyword, insertText: label }));
  }
  if (/@(\w*)$/.test(inComment)) {
    return DOC_KEYWORDS.map((label) => ({ label: '@' + label, kind: CompletionItemKind.Keyword, insertText: '@' + label }));
  }
  if (/<(\w*)$/.test(inComment)) {
    return DOC_TAGS.map((label) => ({ label: '<' + label + '>', kind: CompletionItemKind.Snippet, insertText: label + '>' }));
  }
  return undefined;
}

function kindToCompletion(k: NedTypeKind): CompletionItemKind {
  switch (k) {
    case 'simple':
    case 'compound':
    case 'network':
      return CompletionItemKind.Module;
    case 'channel':
      return CompletionItemKind.Class;
    case 'channelinterface':
    case 'moduleinterface':
      return CompletionItemKind.Interface;
  }
}
function kindWord(t: NedTypeInfo): string {
  return t.kind === 'compound' ? 'module' : t.kind;
}

/** Top-level type completions, filtered by predicate; ambiguous names get fq form. */
function typeItems(cache: NedResourceCache, filter: (t: NedTypeInfo) => boolean): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  for (const t of cache.allTypes()) {
    if (t.isInnerType || !filter(t)) continue;
    if (seen.has(t.simpleName)) {
      items.push({ label: t.fqName, kind: kindToCompletion(t.kind), detail: kindWord(t), insertText: t.fqName });
    } else {
      seen.add(t.simpleName);
      items.push({
        label: t.simpleName,
        kind: kindToCompletion(t.kind),
        detail: `${kindWord(t)} — ${t.fqName}`,
        documentation: t.documentation(),
        insertText: t.simpleName,
      });
    }
  }
  return items;
}

const isModule = (t: NedTypeInfo) => t.isModuleType();
const isChannel = (t: NedTypeInfo) => t.kind === 'channel';
const isModuleIface = (t: NedTypeInfo) => t.kind === 'moduleinterface';
const isChannelIface = (t: NedTypeInfo) => t.kind === 'channelinterface';

function kw(items: string[]): CompletionItem[] {
  return items.map((label) => ({ label, kind: CompletionItemKind.Keyword }));
}

/** The NED type kind keyword that begins a header line, if the line is a header. */
function headerKeyword(prefix: string): string | undefined {
  const m = /^\s*(simple|module|network|channel|moduleinterface|channelinterface)\b/.exec(prefix);
  return m?.[1];
}

/** Nearest enclosing section keyword above `line`, scanning within the type body. */
function sectionByScan(lines: string[], line: number): string | undefined {
  for (let i = line; i >= 0; i--) {
    const t = (lines[i] ?? '').trim();
    if (i < line && t.includes('}')) return undefined; // left the block
    const m = /^(parameters|gates|types|submodules|connections)\s*:/.exec(t);
    if (m) return m[1];
    if (/^(simple|module|network|channel|moduleinterface|channelinterface)\b/.test(t)) {
      return undefined; // reached the type header
    }
  }
  return undefined;
}

/** Fq name of the topmost enclosing module/network (context for inner-type lookup). */
function topmostFqName(cache: NedResourceCache, file: NedFileInfo, node: SyntaxNode): string | undefined {
  let top: SyntaxNode | null = node;
  let topFq: string | undefined;
  while (top) {
    if (top.type === 'module' || top.type === 'network') {
      const f = cache.getFqNameForNode(top, file.uri);
      if (f) topFq = f;
    }
    top = top.parent;
  }
  return topFq;
}

/** The submodule whose body the cursor is in (for inherited-param completion). */
function enclosingSubmoduleType(
  cache: NedResourceCache,
  file: NedFileInfo,
  node: SyntaxNode,
): NedTypeInfo | undefined {
  const sub = ancestorOfType(node, ['submodule']);
  if (!sub) return undefined;
  let typeName: string | undefined;
  for (let i = 0; i < sub.namedChildCount; i++) {
    const c = sub.namedChild(i)!;
    if (c.type === 'type') typeName = c.text;
  }
  if (!typeName) return undefined;
  return cache.lookupType(typeName, file, topmostFqName(cache, file, sub));
}

/**
 * Resolve an EXPLICITLY NAMED submodule (by name, declared on `ownerType`) to its
 * type — unlike {@link enclosingSubmoduleType}, which resolves "the submodule whose
 * body the cursor is currently in". Used for connection-endpoint gate completion
 * (`sub1.` -> sub1's gates). Falls back to the `like` interface name when the
 * submodule has no concrete type, matching Eclipse's `extractSubmoduleTypeName`
 * (`AbstractNedCompletionProcessor.java:149-166`).
 */
function resolveSubmoduleTypeByName(
  cache: NedResourceCache,
  file: NedFileInfo,
  ownerType: NedTypeInfo,
  submoduleName: string,
): NedTypeInfo | undefined {
  const sub = ownerType.getSubmodule(submoduleName);
  const typeName = sub?.type || sub?.likeType;
  if (!typeName) return undefined;
  return cache.lookupType(typeName, file, topmostFqName(cache, file, ownerType.node));
}

/**
 * Submodule name from a trailing `sub.` / `sub[idx].` on the line, ignoring
 * anything before a connection arrow (so `a.g --> b.` resolves to `b`, not `a`).
 * Ported from Eclipse's `extractSubmoduleTypeName` (name-extraction half only —
 * type resolution is {@link resolveSubmoduleTypeByName} here).
 */
function trailingDottedSubmoduleName(prefix: string): string | undefined {
  const afterArrow = prefix.replace(/^.*(-->|<-->|<--)/, '');
  const m = /([A-Za-z_]\w*)\s*(\[[^[\]]*\])?\s*\.$/.exec(afterArrow);
  return m?.[1];
}

/**
 * True if `line` contains an unbalanced `[` (an in-progress array-size expression,
 * e.g. a submodule/gate vector size like `sub[sizeof(`). Repeatedly blanks out
 * balanced `[...]` pairs, then checks whether a stray `[` remains.
 * Ported from `AbstractNedCompletionProcessor.containsOpenBracket`.
 */
function containsOpenBracket(line: string): boolean {
  while (/\[[^[\]]*\]/.test(line)) {
    line = line.replace(/\[[^[\]]*\]/g, '###');
  }
  return line.includes('[');
}

/**
 * True when the cursor is inside a NED value expression: an assignment RHS
 * (`name = ...`, but not when a `(` precedes the `=`, which would be a property
 * argument list like `@statistic[x](title=...)` handled elsewhere), an `if`/`for`
 * condition, or an in-progress array-size expression (unbalanced `[`).
 * Ported from `NedCompletionProcessor.java:202` (the `if (line.matches(...))` guard
 * that gates the whole expression-completion block).
 */
function isExpressionContext(line: string): boolean {
  return /^[^(]*=.*$/.test(line) || /\b(if|for)\b/.test(line) || containsOpenBracket(line);
}

/**
 * Context-aware NED completion. Combines tree ancestry (which section the cursor
 * is in, the type being defined) with line-prefix cues so only meaningful items
 * are offered per context.
 */
export function nedCompletion(
  cache: NedResourceCache,
  file: NedFileInfo,
  tree: Tree,
  pos: Position,
  lineText: string,
  /** Icon ids available for `i=`/`i2=`/`bgi=` display-string completion (see
   *  `displayCompletions`'s `iconIds` param). Host-provided, since enumerating
   *  the filesystem needs Node access `shared/` doesn't have; defaults to `[]`
   *  for callers (tests, other hosts) that don't supply it. */
  iconIds: string[] = [],
): CompletionItem[] {
  const prefix = lineText.slice(0, pos.character);

  // documentation-comment completion (doc keywords / HTML tags)
  const doc = docCommentCompletion(prefix);
  if (doc) return doc;

  const node = namedDescendantAt(tree, pos);
  const enclosingTypeNode = node ? ancestorOfType(node, NED_TYPE_NODES as unknown as string[]) : null;
  const hk = headerKeyword(prefix);

  // inside a `@display("...")` string: offer display-string tags / argument values.
  // The unclosed opening quote up to the cursor means we are within the string;
  // display strings are single-line, so the line prefix is sufficient.
  const dm = /@display\s*\(\s*"([^"]*)$/.exec(prefix);
  if (dm) {
    const ctx: DisplayContext =
      node && ancestorOfType(node, ['connection']) ? 'connection'
        : node && ancestorOfType(node, ['submodule']) ? 'submodule'
          : 'compound';
    return displayCompletions(ctx, dm[1], iconIds);
  }

  // inside `@unit(...)`'s argument list: offer known unit names. Ported from
  // NedCompletionProcessor.java:390-391.
  if (/@unit\s*\(\s*\w*$/.test(prefix)) {
    return unitNameCompletions();
  }

  // inside `@signal[...](...)` / `@statistic[...](...)`'s argument list: argument-name
  // templates, plus nested `unit=`/`record=`/`interpolationmode=` value completion.
  // Ported from NedCompletionProcessor.java:392-405.
  const inSignalArgs = /@signal\s*\[[^\]]*\]\s*\(/.test(prefix);
  const inStatisticArgs = /@statistic\s*\[[^\]]*\]\s*\(/.test(prefix);
  if (inSignalArgs || inStatisticArgs) {
    if (/\bunit\s*=\s*\w*$/.test(prefix)) return unitNameCompletions();
    if (inStatisticArgs) {
      if (/\brecord\s*=\s*(?:[\w-]*,)*[\w-]*$/.test(prefix)) return recordModeCompletions();
      if (/\binterpolationmode\s*=\s*[\w-]*$/.test(prefix)) return interpolationModeCompletions();
      return statisticArgCompletions();
    }
    return signalArgCompletions();
  }

  // inside `@figure[...](...)`'s argument list: type-aware property-key/value
  // completion. Ported from NedCompletionProcessor.java:406-510, driven by the
  // NedCanvasFigureValidator schema transcribed in nedFigureSchema.ts. The three
  // sub-cases are mutually exclusive (by construction of the regexes below, same
  // as in the Java source): first unnamed arg (no `=` typed yet) -> figure-type
  // candidates; right after a completed `key=value;` pair -> that type's valid
  // property keys; inside a key's own value -> per-key value completion
  // (color/image/transform/enum, or [] when the key has no enumerated values).
  if (/@figure\s*\[[^\]]*\]\s*\(/.test(prefix)) {
    if (/@figure\s*\[[^\]]*\]\s*\([^=,;]*$/.test(prefix)) {
      return figureTypeCompletions();
    }
    if (/;\s*$/.test(prefix)) {
      const typeMatch = /\btype\s*=\s*([A-Za-z_]\w*)\s*;/.exec(prefix);
      return typeMatch ? figurePropertyKeyCompletions(typeMatch[1]) : [];
    }
    const kv = /\W*(\w*)\s*=([\w\s.,()#/-]*)$/.exec(prefix);
    if (kv) {
      const key = kv[1];
      const valueIndex = (kv[2].match(/,/g) ?? []).length;
      return figureKeyValueCompletions(key, valueIndex, kv[2], iconIds);
    }
    return [];
  }

  // --- section-scoped contexts ---
  // An empty section (e.g. `parameters:` then a blank line) does not span to the
  // cursor in the parse tree, so fall back to scanning upward for the nearest
  // section keyword within the current type body. Computed up front (rather than
  // just before its first use) so the fine cues below can be section-aware too.
  const lines = tree.rootNode.text.split('\n');
  const scanned = sectionByScan(lines, pos.line);
  const inParams = !!(node && ancestorOfType(node, ['parameters'])) || scanned === 'parameters';
  const inGates = !!(node && ancestorOfType(node, ['gates'])) || scanned === 'gates';
  const inSubmodules = !!(node && ancestorOfType(node, ['submodules'])) || scanned === 'submodules';
  const inConnections =
    !!(node && ancestorOfType(node, ['connections'])) || scanned === 'connections';
  const inTypes = !!(node && ancestorOfType(node, ['types'])) || scanned === 'types';

  // --- fine cues (work regardless of section) ---

  // bare type header, neither `extends` nor `like` typed yet: offer the keywords
  // themselves (e.g. `module Foo ` -> `extends`/`like`). Ported from
  // NedCompletionProcessor.java:138-142. Interfaces only support `extends`.
  const bareHeader =
    /^\s*(simple|module|network|channel|moduleinterface|channelinterface)\s+[A-Za-z_]\w*\s+[A-Za-z]*$/.exec(prefix);
  if (bareHeader && !/\b(extends|like)\b/.test(prefix)) {
    const isIface = bareHeader[1] === 'moduleinterface' || bareHeader[1] === 'channelinterface';
    return isIface ? kw(['extends']) : kw(['extends', 'like']);
  }

  // `extends <Type>` — filter by the kind of the type being defined
  if (/\bextends\s+[\w.]*$/.test(prefix)) {
    const k = hk ?? enclosingTypeNode?.type;
    if (k === 'channel') return typeItems(cache, isChannel);
    if (k === 'channelinterface') return typeItems(cache, isChannelIface);
    if (k === 'moduleinterface') return typeItems(cache, isModuleIface);
    return typeItems(cache, isModule); // simple/module/network
  }

  // `like <Interface>`
  if (/\blike\s+[\w.]*$/.test(prefix)) {
    const k = hk ?? enclosingTypeNode?.type;
    return typeItems(cache, k === 'channel' ? isChannelIface : isModuleIface);
  }

  // bare `connections` keyword, no colon yet: offer the `allowunconnected` keyword
  // so it can be completed to `connections allowunconnected:`.
  if (enclosingTypeNode && /\bconnections\s*$/.test(prefix)) {
    return kw(['allowunconnected']);
  }

  // submodule type: `name: <type>` / `name[..]: type` (but NOT a section header
  // line, and not the `channelname:` position inside a `connections:` section —
  // that is handled by the connections-endpoint logic below).
  const subMatch = /^\s*([A-Za-z_]\w*)(\[[^\]]*\])?\s*:\s*<?[\w.]*$/.exec(prefix);
  if (subMatch && !SECTION_KEYWORDS.includes(subMatch[1]) && !inConnections) {
    return typeItems(cache, isModule);
  }

  // Expression-context member-access + built-ins completion: cursor is inside a
  // value expression (assignment RHS, `if`/`for` condition, or an in-progress
  // array-size expression). Checked regardless of section, matching the Java
  // source's unconditional placement. Ported from NedCompletionProcessor.java:202-246.
  if (isExpressionContext(prefix)) {
    const items: CompletionItem[] = [];
    // `submoduleType`: the type of the submodule whose body the cursor is
    // currently in (only set inside a submodule's own `{ ... }` block) — matches
    // Java's `submoduleType` (SECT_SUBMODULE_PARAMETERS/GATES only).
    const submoduleType = node ? enclosingSubmoduleType(cache, file, node) : undefined;
    // `typeInfo`: the innermost enclosing type actually being defined (module/
    // network/... header) — matches Java's `nedTypeInfo`.
    const typeInfo = enclosingTypeNode ? cache.typeInfoForNode(enclosingTypeNode, file.uri) : undefined;

    if (/\bthis *\.$/.test(prefix)) {
      // `this.` -> the submodule's own parameter names (only meaningful inside a
      // submodule's parameter-assignment body, matching Java's `submoduleType!=null` guard).
      if (submoduleType) for (const [name, p] of submoduleType.params()) {
        items.push({ label: name, kind: CompletionItemKind.Property, detail: p.type });
      }
    } else if (/\bsizeof *\($/.test(prefix)) {
      // `sizeof(` -> gate + submodule names of the enclosing type.
      if (typeInfo) {
        for (const [name, g] of typeInfo.gates()) {
          items.push({ label: name, kind: CompletionItemKind.Field, detail: g.type });
        }
        for (const name of typeInfo.submodules().keys()) {
          items.push({ label: name, kind: CompletionItemKind.Variable, detail: 'submodule' });
        }
      }
    } else if (prefix.endsWith('.')) {
      // trailing `sub.` -> parameter names of the resolved submodule's type (and,
      // specifically inside `sizeof(...)`, its gate names too).
      const dotSub = trailingDottedSubmoduleName(prefix);
      const subType = dotSub && typeInfo && resolveSubmoduleTypeByName(cache, file, typeInfo, dotSub);
      if (subType) {
        if (/\bsizeof *\(/.test(prefix)) {
          for (const [name, g] of subType.gates()) {
            items.push({ label: name, kind: CompletionItemKind.Field, detail: g.type });
          }
        }
        for (const [name, p] of subType.params()) {
          items.push({ label: name, kind: CompletionItemKind.Property, detail: p.type });
        }
      }
    } else {
      // bare expression position: parameter names of the enclosing type.
      if (typeInfo) for (const [name, p] of typeInfo.params()) {
        items.push({ label: name, kind: CompletionItemKind.Property, detail: p.type });
      }
    }

    items.push(...expressionBuiltinCompletions());
    return items;
  }

  // The (implicit) parameters section: param type keywords + inherited params to
  // assign + type/parameter-level properties. The `parameters:` keyword is
  // optional, so this same bundle is offered at the top of a keyword-less body.
  const paramBundle = (): CompletionItem[] => {
    const items = kw(PARAM_TYPE_KEYWORDS);
    const info =
      (node ? enclosingSubmoduleType(cache, file, node) : undefined) ??
      (enclosingTypeNode ? cache.typeInfoForNode(enclosingTypeNode, file.uri) : undefined);
    if (info) {
      for (const [name, p] of info.params()) {
        items.push({ label: name, kind: CompletionItemKind.Property, detail: p.type, documentation: p.value });
      }
    }
    items.push(...propertyCompletions('type', 'param'));
    return items;
  };

  // submodule body: assigning the submodule's (inherited) parameters + properties
  const subAncestor = node ? ancestorOfType(node, ['submodule']) : null;
  if (subAncestor && pos.line > subAncestor.startPosition.row) {
    const subType = enclosingSubmoduleType(cache, file, node!);
    const items = kw(['parameters', 'gates']);
    if (subType) for (const [name, p] of subType.params()) {
      items.push({ label: name, kind: CompletionItemKind.Property, detail: p.type });
    }
    items.push(...propertyCompletions('submodule'));
    return items;
  }

  // connection body (channel-spec `{ ... }`): connection-level properties
  if (node && ancestorOfType(node, ['connection'])) {
    return propertyCompletions('connection');
  }

  // gates section: gate direction keywords + inherited gate names + gate properties
  if (inGates) {
    const items = kw(GATE_TYPE_KEYWORDS);
    if (enclosingTypeNode) {
      const info = cache.typeInfoForNode(enclosingTypeNode, file.uri);
      if (info) for (const [name, g] of info.gates()) {
        items.push({ label: name, kind: CompletionItemKind.Field, detail: g.type });
      }
    }
    items.push(...propertyCompletions('gate'));
    return items;
  }

  // parameters section (explicit or implicit `parameters` node)
  if (inParams) {
    return paramBundle();
  }

  // submodules section: `if <cond>` after a completed submodule type name, or
  // after a `like Interface` clause. Ported from NedCompletionProcessor.java:276-303
  // (only the `if` cue — the type-name-after-`:` and interface-name-after-`like`
  // cues are already covered by the `subMatch`/`like` cues above). On any other
  // (typically empty) line in the section, offer submodule-declaration skeleton
  // snippets — ported from NedCompletionProcessor.java:191-193
  // (`proposedNedSubmoduleTempl`, offered on an empty SECT_SUBMODULES line).
  if (inSubmodules) {
    const ifAfterType =
      /^\s*[A-Za-z_]\w*(\[[^\]]*\])?\s*:\s*[A-Za-z_][\w.]*\s+[A-Za-z]*$/.test(prefix);
    const ifAfterLike =
      /^\s*[A-Za-z_]\w*(\[[^\]]*\])?\s*:\s*<[^>]*>\s*like\s+[A-Za-z_][\w.]*\s+[A-Za-z]*$/.test(prefix);
    if (ifAfterType || ifAfterLike) return kw(['if']);
    return submoduleSkeletonCompletions();
  }

  // connections section: endpoint completion. Ported from
  // NedCompletionProcessor.java:305-342 (SECT_CONNECTIONS).
  if (inConnections) {
    const typeInfo = enclosingTypeNode ? cache.typeInfoForNode(enclosingTypeNode, file.uri) : undefined;

    // after `sub.` / `sub[i].`: gate names of the resolved submodule's type
    const dotSub = trailingDottedSubmoduleName(prefix);
    if (dotSub) {
      const subType = typeInfo && resolveSubmoduleTypeByName(cache, file, typeInfo, dotSub);
      const items: CompletionItem[] = [];
      if (subType) for (const [name, g] of subType.gates()) {
        items.push({ label: name, kind: CompletionItemKind.Field, detail: g.type });
      }
      return items;
    }

    // after a trailing `channelname:` — offer channel types
    if (/[A-Za-z_]\w*\s*:\s*\w*$/.test(prefix)) {
      return typeItems(cache, isChannel);
    }

    // at line start, or right after an arrow (`-->`/`<--`/`<-->`): submodule names
    // + the enclosing type's own gate names; if exactly one arrow is already on
    // the line, also channel type names (for a channel-mediated connection). At
    // (true) line start only — not right after an arrow — also offer connection
    // topology skeleton snippets, matching Eclipse's `line.equals("")` guard around
    // `proposedNedConnectionTempl` (NedCompletionProcessor.java:340-341).
    const atLineStart = /^\s*\w*$/.test(prefix);
    const afterArrow = /(-->|<-->|<--)\s*\w*$/.test(prefix);
    if (atLineStart || afterArrow) {
      const items: CompletionItem[] = [];
      if (typeInfo) {
        for (const name of typeInfo.submodules().keys()) {
          items.push({ label: name, kind: CompletionItemKind.Variable, detail: 'submodule' });
        }
        for (const [name, g] of typeInfo.gates()) {
          items.push({ label: name, kind: CompletionItemKind.Field, detail: g.type });
        }
        const arrowCount = (prefix.match(/-->|<-->|<--/g) ?? []).length;
        if (arrowCount === 1) items.push(...typeItems(cache, isChannel));
      }
      if (atLineStart) items.push(...connectionSkeletonCompletions());
      return items;
    }

    return [];
  }

  // `types:` section: offer inner type-definition keywords + module/type skeleton
  // snippets. Ported from NedCompletionProcessor.java:188-190
  // (`proposedNedGlobalTempl`, also offered for SECT_TYPES, not just SECT_GLOBAL).
  if (inTypes) {
    return [...kw(TYPE_DEF_KEYWORDS), ...globalSkeletonCompletions()];
  }

  // inside a type body, between/before sections: the `parameters:` keyword is
  // optional, so offer section keywords AND the first-section param/property bundle.
  if (enclosingTypeNode) {
    return [...kw(SECTION_KEYWORDS), ...paramBundle()];
  }

  // file top level: type-definition / import keywords + file-level properties +
  // module/type skeleton snippets. Ported from NedCompletionProcessor.java:188-190
  // (`proposedNedGlobalTempl`, offered for SECT_GLOBAL).
  return [...kw(TOP_LEVEL_KEYWORDS), ...propertyCompletions('file'), ...globalSkeletonCompletions()];
}
