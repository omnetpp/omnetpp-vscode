import type { Tree, Node as SyntaxNode } from 'web-tree-sitter';
import type { Position } from '../model/location';
import { CompletionItem, CompletionItemKind } from '../model/completion';
import { ancestorOfType, namedDescendantAt } from '../parser/treeUtils';
import { NedResourceCache, NedFileInfo } from './nedResourceCache';
import { NedTypeInfo } from './nedTypeInfo';
import { NED_TYPE_NODES, NedTypeKind } from './nedAst';
import { DisplayContext, displayCompletions } from './displayString';
import { propertyCompletions } from './nedProperties';

const TOP_LEVEL_KEYWORDS = [
  'import', 'simple', 'module', 'network', 'channel', 'moduleinterface', 'channelinterface',
];
// type-definition keywords (valid at file top level and inside a `types:` section)
const TYPE_DEF_KEYWORDS = TOP_LEVEL_KEYWORDS.filter((k) => k !== 'import');
const SECTION_KEYWORDS = ['parameters', 'gates', 'types', 'submodules', 'connections'];
const PARAM_TYPE_KEYWORDS = ['int', 'double', 'string', 'bool', 'object', 'xml', 'volatile'];
const GATE_TYPE_KEYWORDS = ['input', 'output', 'inout'];

/** Doc-comment keywords (after `@`) and HTML tags (after `<`), as in the IDE. */
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
 * Completion inside a `//` documentation comment: doc keywords after `@`,
 * HTML tags after `<`. Returns undefined when not in a doc-comment context.
 */
export function docCommentCompletion(prefix: string): CompletionItem[] | undefined {
  const comment = prefix.indexOf('//');
  if (comment < 0) return undefined;
  const inComment = prefix.slice(comment);
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
  // resolve in the topmost compound's scope
  let top: SyntaxNode | null = sub;
  let topFq: string | undefined;
  while (top) {
    if (top.type === 'module' || top.type === 'network') {
      const f = cache.getFqNameForNode(top, file.uri);
      if (f) topFq = f;
    }
    top = top.parent;
  }
  return cache.lookupType(typeName, file, topFq);
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
    return displayCompletions(ctx, dm[1]);
  }

  // --- fine cues (work regardless of section) ---

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

  // channel on a connection: `--> <Chan>` / `<--> <Chan>`
  if (/(-->|<-->|<--)\s*[\w.]*$/.test(prefix)) {
    return typeItems(cache, isChannel);
  }

  // submodule type: `name: <type>` / `name[..]: type` (but NOT a section header line)
  const subMatch = /^\s*([A-Za-z_]\w*)(\[[^\]]*\])?\s*:\s*<?[\w.]*$/.exec(prefix);
  if (subMatch && !SECTION_KEYWORDS.includes(subMatch[1])) {
    return typeItems(cache, isModule);
  }

  // --- section-scoped contexts ---
  // An empty section (e.g. `parameters:` then a blank line) does not span to the
  // cursor in the parse tree, so fall back to scanning upward for the nearest
  // section keyword within the current type body.
  const lines = tree.rootNode.text.split('\n');
  const scanned = sectionByScan(lines, pos.line);
  const inParams = !!(node && ancestorOfType(node, ['parameters'])) || scanned === 'parameters';
  const inGates = !!(node && ancestorOfType(node, ['gates'])) || scanned === 'gates';
  const inSubmodules = !!(node && ancestorOfType(node, ['submodules'])) || scanned === 'submodules';
  const inConnections =
    !!(node && ancestorOfType(node, ['connections'])) || scanned === 'connections';
  const inTypes = !!(node && ancestorOfType(node, ['types'])) || scanned === 'types';

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

  // submodules section (line start, not yet a `name:` decl): offer nothing type-y
  if (inSubmodules || inConnections) {
    return [];
  }

  // `types:` section: offer inner type-definition keywords
  if (inTypes) {
    return kw(TYPE_DEF_KEYWORDS);
  }

  // inside a type body, between/before sections: the `parameters:` keyword is
  // optional, so offer section keywords AND the first-section param/property bundle.
  if (enclosingTypeNode) {
    return [...kw(SECTION_KEYWORDS), ...paramBundle()];
  }

  // file top level: type-definition / import keywords + file-level properties
  return [...kw(TOP_LEVEL_KEYWORDS), ...propertyCompletions('file')];
}
