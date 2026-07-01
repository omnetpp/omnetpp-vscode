import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import { childrenOfType, firstChildOfType, childByField } from '../parser/treeUtils';

/** tree-sitter node types for the six NED type definitions. */
export const NED_TYPE_NODES = [
  'simple',
  'module',
  'network',
  'channel',
  'channel_interface',
  'moduleinterface',
] as const;

export type NedTypeKind =
  | 'simple'
  | 'compound'
  | 'network'
  | 'channel'
  | 'channelinterface'
  | 'moduleinterface';

export function isTypeNode(node: SyntaxNode): boolean {
  return (NED_TYPE_NODES as readonly string[]).includes(node.type);
}

export function typeKind(node: SyntaxNode): NedTypeKind {
  switch (node.type) {
    case 'simple':
      return 'simple';
    case 'module':
      return 'compound';
    case 'network':
      return 'network';
    case 'channel':
      return 'channel';
    case 'channel_interface':
      return 'channelinterface';
    case 'moduleinterface':
      return 'moduleinterface';
    default:
      throw new Error(`not a NED type node: ${node.type}`);
  }
}

/** The `name` child node of a type/param/gate/submodule, or null. */
export function nameNode(node: SyntaxNode): SyntaxNode | null {
  return firstChildOfType(node, 'name');
}

export function nameText(node: SyntaxNode): string | undefined {
  return nameNode(node)?.text;
}

export function extendsNodes(node: SyntaxNode): SyntaxNode[] {
  return childrenOfType(node, 'extends');
}

export function implementsNodes(node: SyntaxNode): SyntaxNode[] {
  return childrenOfType(node, 'implements');
}

export function sectionNode(typeNode: SyntaxNode, section: string): SyntaxNode | null {
  return firstChildOfType(typeNode, section);
}

/** All top-level NED type definitions in a file. */
export function topLevelTypes(tree: Tree): SyntaxNode[] {
  const root = tree.rootNode;
  const out: SyntaxNode[] = [];
  for (let i = 0; i < root.namedChildCount; i++) {
    const c = root.namedChild(i)!;
    if (isTypeNode(c)) out.push(c);
  }
  return out;
}

/** Inner types declared in a compound module's `types:` section. */
export function innerTypes(typeNode: SyntaxNode): SyntaxNode[] {
  const types = sectionNode(typeNode, 'types');
  if (!types) return [];
  const out: SyntaxNode[] = [];
  for (let i = 0; i < types.namedChildCount; i++) {
    const c = types.namedChild(i)!;
    if (isTypeNode(c)) out.push(c);
  }
  return out;
}

export function packageNode(tree: Tree): SyntaxNode | null {
  return firstChildOfType(tree.rootNode, 'package');
}

export function importNodes(tree: Tree): SyntaxNode[] {
  return childrenOfType(tree.rootNode, 'import');
}

/** The declared package name of a file ('' if none). */
export function filePackage(tree: Tree): string {
  const pkg = packageNode(tree);
  return pkg ? nameNode(pkg)?.text ?? '' : '';
}

/** The import specs of a file. */
export function fileImports(tree: Tree): string[] {
  return importNodes(tree)
    .map((imp) => nameNode(imp)?.text)
    .filter((s): s is string => !!s);
}

/** Parameters declared directly in a type's `parameters:` section. */
export function paramNodes(typeNode: SyntaxNode): SyntaxNode[] {
  const params = sectionNode(typeNode, 'parameters');
  return params ? childrenOfType(params, 'parameter') : [];
}

/** Property assignments (e.g. @display) in a type's parameters section. */
export function propertyNodes(typeNode: SyntaxNode): SyntaxNode[] {
  const params = sectionNode(typeNode, 'parameters');
  return params ? childrenOfType(params, 'property') : [];
}

export function gateNodes(typeNode: SyntaxNode): SyntaxNode[] {
  const gates = sectionNode(typeNode, 'gates');
  return gates ? childrenOfType(gates, 'gate') : [];
}

export function submoduleNodes(typeNode: SyntaxNode): SyntaxNode[] {
  const subs = sectionNode(typeNode, 'submodules');
  return subs ? childrenOfType(subs, 'submodule') : [];
}

export interface ParamInfo {
  node: SyntaxNode;
  name?: string;
  type?: string;
  value?: string;
  isPattern: boolean;
  volatile: boolean;
  /** Measurement unit from a `@unit(...)` property, if any. */
  unit?: string;
  /** Allowed values from an `@enum(...)` property, if any. */
  enumValues?: string[];
}

/** Extract the `@unit(...)` value from a parameter declaration's text. */
function paramUnit(text: string): string | undefined {
  const m = /@unit\s*\(\s*([^)]*?)\s*\)/.exec(text);
  return m ? m[1].replace(/^["']|["']$/g, '').trim() || undefined : undefined;
}

/**
 * Extract the `@enum(...)` members from a parameter declaration's text.
 *
 * The member list is scanned quote- and paren-aware: a `)` or `,` inside a quoted
 * member (e.g. `@enum("g(erp)", "n(mixed-2.4Ghz)")`) neither closes the property nor
 * separates a member. Surrounding quotes are stripped from each member.
 */
function paramEnum(text: string): string[] | undefined {
  const kw = text.search(/@enum\s*\(/);
  if (kw < 0) return undefined;
  const open = text.indexOf('(', kw);
  if (open < 0) return undefined;

  // Walk from the opening paren to its match, tracking string state so brackets and
  // separators inside quotes are ignored; collect members split on top-level commas.
  const members: string[] = [];
  let cur = '';
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let closed = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === '\\' && i + 1 < text.length) cur += text[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(') { depth++; if (depth > 1) cur += c; continue; }
    if (c === ')') {
      depth--;
      if (depth === 0) { closed = true; break; }
      cur += c;
      continue;
    }
    if (c === ',' && depth === 1) { members.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (!closed) return undefined; // unterminated @enum(...) — treat as absent
  members.push(cur);

  const vals = members.map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  return vals.length ? vals : undefined;
}

export function paramInfo(node: SyntaxNode): ParamInfo {
  const pattern = firstChildOfType(node, 'pattern');
  return {
    node,
    name: nameText(node),
    type: firstChildOfType(node, 'type')?.text,
    value: firstChildOfType(node, 'value')?.text,
    isPattern: !!pattern,
    volatile: /\bvolatile\b/.test(node.text.split('=')[0] ?? ''),
    unit: paramUnit(node.text),
    enumValues: paramEnum(node.text),
  };
}

export interface GateInfo {
  node: SyntaxNode;
  name?: string;
  type?: string; // input | output | inout
  isVector: boolean;
}

export function gateInfo(node: SyntaxNode): GateInfo {
  // the gate direction is exposed via the `direction` field (input|output|inout)
  return {
    node,
    name: nameText(node),
    type: (childByField(node, 'direction') ?? firstChildOfType(node, 'type'))?.text,
    isVector: !!firstChildOfType(node, 'vector'),
  };
}

export interface SubmoduleInfo {
  node: SyntaxNode;
  name?: string;
  type?: string; // concrete type (when not 'like')
  likeType?: string; // interface name (when 'like')
  isVector: boolean;
  isLike: boolean;
}

export function submoduleInfo(node: SyntaxNode): SubmoduleInfo {
  const likeType = firstChildOfType(node, 'like_type');
  return {
    node,
    name: nameText(node),
    type: firstChildOfType(node, 'type')?.text,
    likeType: likeType?.text,
    isVector: !!firstChildOfType(node, 'vector'),
    isLike: !!likeType,
  };
}

// ---- properties (@class, @signal, @namespace, ...) ------------------------

export interface NedPropertyTag {
  /** the tag key (e.g. `type` in `@signal[s](type=Foo)`), if any. */
  key?: string;
  value: string;
  /** the value node (for go-to-def / diagnostics range). */
  node: SyntaxNode;
}

export interface NedPropertyInfo {
  name: string;
  /** the `[index]` selector (e.g. the signal name), if any. */
  index?: string;
  tags: NedPropertyTag[];
  node: SyntaxNode;
}

export function nedPropertyInfo(node: SyntaxNode): NedPropertyInfo {
  const tags: NedPropertyTag[] = [];
  for (const tag of childrenOfType(node, 'tag')) {
    const vl = firstChildOfType(tag, 'value_list');
    tags.push({
      key: firstChildOfType(tag, 'name')?.text.trim(),
      value: (vl?.text ?? '').trim(),
      node: vl ?? tag,
    });
  }
  return { name: nameNode(node)?.text ?? '', index: firstChildOfType(node, 'index')?.text, tags, node };
}

/** The file-level `@namespace(...)` value (the C++ namespace), if declared. */
export function fileNamespace(tree: Tree): string | undefined {
  for (const p of childrenOfType(tree.rootNode, 'property')) {
    if (nameNode(p)?.text === 'namespace') {
      const v = nedPropertyInfo(p).tags[0]?.value;
      if (v) return v;
    }
  }
  return undefined;
}

/** A reference from NED to a C++/MSG class (via `@class` or `@signal(type=...)`). */
export interface NedClassRef {
  className: string;
  node: SyntaxNode;
}

/** `@class(...)` backing-class references on a type. */
export function nedClassRefs(typeNode: SyntaxNode): NedClassRef[] {
  const out: NedClassRef[] = [];
  for (const p of propertyNodes(typeNode)) {
    const info = nedPropertyInfo(p);
    if (info.name === 'class' && info.tags[0]?.value) {
      out.push({ className: info.tags[0].value, node: info.tags[0].node });
    }
  }
  return out;
}

/** `@signal[...](type=Foo)` carried-type references on a type. */
export function nedSignalTypeRefs(typeNode: SyntaxNode): NedClassRef[] {
  const out: NedClassRef[] = [];
  for (const p of propertyNodes(typeNode)) {
    const info = nedPropertyInfo(p);
    if (info.name !== 'signal') continue;
    const typeTag = info.tags.find((t) => t.key === 'type');
    if (typeTag?.value) out.push({ className: typeTag.value, node: typeTag.node });
  }
  return out;
}

// ---- connections ----------------------------------------------------------

export type ConnDirection = '-->' | '<--' | '<-->';

/** One endpoint of a connection: a submodule gate or the parent compound's gate. */
export interface ConnEndpoint {
  /** submodule name; undefined ⇒ the enclosing compound's own gate. */
  module?: string;
  /** index expression text on the submodule (vector submodule), if any. */
  moduleIndex?: string;
  gate: string;
  /** `$i` / `$o` selector on a bidirectional gate, if any. */
  subgate?: '$i' | '$o';
  /** gate index expression text, if any. */
  gateIndex?: string;
  /** the `++` (append) marker on the gate. */
  gatePlusplus: boolean;
  node: SyntaxNode;
  moduleNameNode?: SyntaxNode;
  gateNameNode?: SyntaxNode;
}

/** The channel of a connection: a named/typed channel and/or inline params. */
export interface ChannelSpec {
  /** the `c` in `c: Chan`, if the channel is named. */
  channelName?: string;
  /** the channel type name (dotted), if specified. */
  typeName?: string;
  /** inline `{ ... }` channel parameter assignments. */
  inlineParams: ParamInfo[];
  /** the node naming the channel type (for go-to-def / validation). */
  typeNode?: SyntaxNode;
}

export interface ConnectionInfo {
  src: ConnEndpoint;
  dest: ConnEndpoint;
  direction: ConnDirection;
  channel?: ChannelSpec;
  /** enclosing `for` loops (parametric connections). */
  loops: { paramName: string; from: string; to: string }[];
  /** `if` condition expression texts on the connection or enclosing group. */
  conditions: string[];
  node: SyntaxNode;
}

function connEndpoint(ep: SyntaxNode | null): ConnEndpoint {
  const moduleNode = ep ? firstChildOfType(ep, 'module') : null;
  const gateNode = ep ? firstChildOfType(ep, 'gate') : null;
  const moduleNameNode = moduleNode ? nameNode(moduleNode) : null;
  const gateNameNode = gateNode ? nameNode(gateNode) : null;
  return {
    module: moduleNameNode?.text,
    moduleIndex: moduleNode ? firstChildOfType(moduleNode, 'index')?.text : undefined,
    gate: gateNameNode?.text ?? '',
    subgate: gateNode ? (firstChildOfType(gateNode, 'subgate')?.text as '$i' | '$o' | undefined) : undefined,
    gateIndex: gateNode ? firstChildOfType(gateNode, 'index')?.text : undefined,
    gatePlusplus: !!(gateNode && firstChildOfType(gateNode, 'plusplus')),
    node: ep ?? gateNode ?? moduleNode!,
    moduleNameNode: moduleNameNode ?? undefined,
    gateNameNode: gateNameNode ?? undefined,
  };
}

/** Parse a `connection` node into a structured ConnectionInfo. */
export function connectionInfo(node: SyntaxNode): ConnectionInfo {
  const arrow = (firstChildOfType(node, 'arrow')?.text ?? '-->') as ConnDirection;
  // channel: named (`c:` name + `type`) or unnamed (a `name` between the arrows)
  const typeNode = firstChildOfType(node, 'type');
  const nameNodeChild = firstChildOfType(node, 'name'); // the `c:` label or the dotted type
  const inlineParams = childrenOfType(node, 'parameter').map(paramInfo);
  let channel: ChannelSpec | undefined;
  if (typeNode) {
    channel = {
      channelName: nameNodeChild?.text.replace(/:$/, ''),
      typeName: typeNode.text,
      inlineParams,
      typeNode,
    };
  } else if (nameNodeChild) {
    channel = { typeName: nameNodeChild.text, inlineParams, typeNode: nameNodeChild };
  } else if (inlineParams.length) {
    channel = { inlineParams };
  }

  const loops: ConnectionInfo['loops'] = [];
  const conditions: string[] = [];
  for (const c of childrenOfType(node, 'condition')) {
    const v = firstChildOfType(c, 'value');
    if (v) conditions.push(v.text);
  }
  let cur: SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === 'connection_group') {
      for (const lp of childrenOfType(cur, 'loop')) {
        loops.push({
          paramName: firstChildOfType(lp, 'param_name')?.text ?? '',
          from: firstChildOfType(lp, 'from_value')?.text ?? '',
          to: firstChildOfType(lp, 'to_value')?.text ?? '',
        });
      }
      for (const c of childrenOfType(cur, 'condition')) {
        const v = firstChildOfType(c, 'value');
        if (v) conditions.push(v.text);
      }
    }
    cur = cur.parent;
  }

  return {
    src: connEndpoint(firstChildOfType(node, 'src')),
    dest: connEndpoint(firstChildOfType(node, 'dest')),
    direction: arrow,
    channel,
    loops,
    conditions,
    node,
  };
}

/** All `connection` nodes in a type's `connections:` section (incl. inside groups). */
export function connectionNodes(typeNode: SyntaxNode): SyntaxNode[] {
  const sec = sectionNode(typeNode, 'connections');
  if (!sec) return [];
  const out: SyntaxNode[] = [];
  const visit = (n: SyntaxNode): void => {
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i)!;
      if (c.type === 'connection') out.push(c);
      else if (c.type === 'connection_group') visit(c);
    }
  };
  visit(sec);
  return out;
}

/** Whether the type's `connections` section is marked `allowunconnected`. */
export function allowsUnconnected(typeNode: SyntaxNode): boolean {
  const sec = sectionNode(typeNode, 'connections');
  return !!sec && !!firstChildOfType(sec, 'allowunconnected');
}

/**
 * The doc comment immediately preceding a node (banner comment), if any.
 * Returns the comment text with leading // markers stripped.
 */
export function leadingDocComment(node: SyntaxNode): string | undefined {
  // The grammar emits one `comment` node per `//` line, so a multi-line banner
  // is a run of consecutive `comment` siblings. Walk backward over that run,
  // stopping at a non-contiguous gap or a trailing comment that shares its line
  // with a preceding statement (e.g. `package foo; // not a banner`).
  const lines: SyntaxNode[] = [];
  let cur: SyntaxNode | null = node.previousNamedSibling;
  while (
    cur &&
    cur.type === 'comment' &&
    (lines.length === 0 || cur.startPosition.row === lines[lines.length - 1].startPosition.row - 1)
  ) {
    const before = cur.previousNamedSibling;
    if (before && before.type !== 'comment' && before.endPosition.row === cur.startPosition.row) break;
    lines.push(cur);
    cur = cur.previousNamedSibling;
  }
  if (lines.length === 0) return undefined;
  lines.reverse();
  return stripCommentMarkers(lines.map((l) => l.text).join('\n'));
}

export function stripCommentMarkers(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\/\/+\s?/, ''))
    .join('\n')
    .trim();
}

/**
 * The trailing `// ...` comment on the same line as a declaration
 * (e.g. `int foo = 5; // doc`). Comments live in `extras`, so the trailing
 * comment is the next named sibling on the declaration's last line — or, for
 * the last item in a section, the next sibling of the section itself (extras
 * attach at the block boundary). Returns the text with `//` markers stripped.
 */
export function trailingDocComment(node: SyntaxNode): string | undefined {
  const endRow = node.endPosition.row;
  const candidates = [node.nextNamedSibling, node.parent?.nextNamedSibling ?? null];
  for (const cand of candidates) {
    if (cand && cand.type === 'comment' && cand.startPosition.row === endRow) {
      return stripCommentMarkers(cand.text);
    }
  }
  return undefined;
}

/**
 * Documentation for a parameter declaration: the OMNeT++ convention allows a
 * trailing comment on the same line (`int foo; // doc`) or a banner comment on
 * the line(s) above. Prefer the same-line trailing comment, falling back to the
 * leading banner.
 */
export function paramDocComment(node: SyntaxNode): string | undefined {
  return trailingDocComment(node) ?? leadingDocComment(node);
}
