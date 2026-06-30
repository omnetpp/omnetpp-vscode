import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import type { Location, Position, Range } from '../model/location';
import { ancestorOfType, namedDescendantAt, nodeRange } from '../parser/treeUtils';
import { NedResourceCache, NedFileInfo, BUILTIN_URI } from './nedResourceCache';
import { DocRefResolver, DocRefTarget, linkifyDocRefs } from '../doc/docRefs';
import { NedTypeInfo } from './nedTypeInfo';
import { NED_TYPE_NODES, isTypeNode, nameNode, paramInfo, paramDocComment } from './nedAst';

const TYPEREF_NODES = ['extends', 'implements', 'like_type'];

/**
 * A connection endpoint module-part (`a` in `a.out --> b.in`) is aliased to the
 * `module` node type even though it is not a type definition. The grammar places
 * it under the connection's `src`/`dest` field, so its parent disambiguates it
 * from a real compound-module definition.
 */
function isConnectionEndpointModule(n: SyntaxNode): boolean {
  return n.type === 'module' && (n.parent?.type === 'src' || n.parent?.type === 'dest');
}

/** fq-name of the topmost compound/network ancestor of a node, for inner lookups. */
export function topmostCompoundFq(
  cache: NedResourceCache,
  node: SyntaxNode,
  uri: string,
): string | undefined {
  let fq: string | undefined;
  let cur: SyntaxNode | null = node;
  while (cur) {
    if ((cur.type === 'module' || cur.type === 'network') && !isConnectionEndpointModule(cur)) {
      const f = cache.getFqNameForNode(cur, uri);
      if (f) fq = f; // keep going up; last assignment = topmost
    }
    cur = cur.parent;
  }
  return fq;
}

/** A submodule's concrete `type` node. */
function isSubmoduleType(n: SyntaxNode): boolean {
  return n.type === 'type' && n.parent?.type === 'submodule';
}
/** A channel type/name reference in a connection (`--> Chan -->` or `c: Chan`). */
function isConnectionChannelRef(n: SyntaxNode): boolean {
  return (n.type === 'type' || n.type === 'name') && n.parent?.type === 'connection';
}
/** A concrete (non-wildcard) `import a.b.Type;` spec referencing a type. */
function isImportRef(n: SyntaxNode): boolean {
  return n.type === 'name' && n.parent?.type === 'import' && !n.text.includes('*');
}
/** Any node that references a NED type (vs. declaring one). */
export function isTypeRefNode(n: SyntaxNode): boolean {
  return (
    TYPEREF_NODES.includes(n.type) ||
    isSubmoduleType(n) ||
    isConnectionChannelRef(n) ||
    isImportRef(n)
  );
}

/**
 * The lookup context (enclosing compound fq-name) for resolving a type reference.
 * `extends`/`implements` are in a type header, so their scope is the type's
 * ENCLOSING context (undefined for a top-level type) — matching NedTypeInfo.resolve()
 * — which prevents a type's own inner types from shadowing its base. Body
 * references (submodule type, `like`, connection channel) resolve in the topmost
 * compound module's scope so they can see inner types.
 */
export function enclosingContextFor(
  cache: NedResourceCache,
  refNode: SyntaxNode,
  uri: string,
): string | undefined {
  if (refNode.type === 'extends' || refNode.type === 'implements') {
    const typeNode = ancestorOfType(refNode, NED_TYPE_NODES as unknown as string[]);
    if (!typeNode) return undefined;
    const info = cache.typeInfoForNode(typeNode, uri);
    return info?.isInnerType ? info.enclosingFqName : undefined;
  }
  return topmostCompoundFq(cache, refNode, uri);
}

export interface TypeRef {
  kind: 'typeref';
  refNode: SyntaxNode;
  name: string;
  target?: NedTypeInfo;
}
export interface TypeDef {
  kind: 'typedef';
  nameNode: SyntaxNode;
  info: NedTypeInfo;
}
export type NedRef = TypeRef | TypeDef | null;

/** Classify and resolve the NED entity referenced at a position. */
export function referenceAt(
  cache: NedResourceCache,
  file: NedFileInfo,
  tree: Tree,
  pos: Position,
): NedRef {
  const node = namedDescendantAt(tree, pos);
  if (!node) return null;

  // type definition name?
  if (node.type === 'name' && node.parent && isTypeNode(node.parent)) {
    const info = cache.typeInfoForNode(node.parent, file.uri);
    if (info) return { kind: 'typedef', nameNode: node, info };
  }

  // type reference: extends/implements/like_type, submodule type, or connection channel
  let refNode = ancestorOfType(node, TYPEREF_NODES);
  if (!refNode) {
    const cand = ancestorOfType(node, ['type', 'name']);
    if (cand && isTypeRefNode(cand)) refNode = cand;
  }
  if (refNode) {
    const name = refNode.text;
    const enclosing = enclosingContextFor(cache, refNode, file.uri);
    const target = cache.lookupType(name, file, enclosing);
    return { kind: 'typeref', refNode, name, target };
  }
  return null;
}

/** The NED type whose body the cursor's submodule belongs to (for param refs). */
function enclosingSubmoduleType(
  cache: NedResourceCache,
  file: NedFileInfo,
  node: SyntaxNode,
): NedTypeInfo | undefined {
  const sub = ancestorOfType(node, ['submodule']);
  if (!sub) return undefined;
  let typeName: string | undefined;
  for (let i = 0; i < sub.namedChildCount; i++) {
    if (sub.namedChild(i)!.type === 'type') typeName = sub.namedChild(i)!.text;
  }
  if (!typeName) return undefined;
  return cache.lookupType(typeName, file, topmostCompoundFq(cache, sub, file.uri));
}

export interface ParamRef {
  decl: Location;
  name: string;
  type?: string;
  doc?: string;
  ownerFq: string;
  range: Range;
}

/** Resolve a parameter NAME at a position (declaration or override) to its decl. */
export function paramRefAt(
  cache: NedResourceCache,
  file: NedFileInfo,
  tree: Tree,
  pos: Position,
): ParamRef | null {
  const node = namedDescendantAt(tree, pos);
  if (!node || node.type !== 'name' || node.parent?.type !== 'parameter') return null;
  const name = node.text;
  let owner =
    enclosingSubmoduleType(cache, file, node) ??
    (() => {
      const tnode = ancestorOfType(node, NED_TYPE_NODES as unknown as string[]);
      return tnode ? cache.typeInfoForNode(tnode, file.uri) : undefined;
    })();
  if (!owner) return null;
  const decl = owner.paramDecl(name);
  if (!decl) return null;
  const nn = nameNode(decl.node) ?? decl.node;
  return {
    decl: { uri: decl.owner.file.uri, range: nodeRange(nn) },
    name,
    type: paramInfo(decl.node).type,
    doc: paramDocComment(decl.node),
    ownerFq: decl.owner.fqName,
    range: nodeRange(node),
  };
}

function childByType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    if (node.namedChild(i)!.type === type) return node.namedChild(i);
  }
  return null;
}

/** The enclosing registered NED type of a node (skips the connection `module` part,
 *  which shares the `module` node type but is not a type definition). */
function enclosingTypeInfo(
  cache: NedResourceCache,
  node: SyntaxNode,
  uri: string,
): NedTypeInfo | undefined {
  let cur: SyntaxNode | null = node;
  while (cur) {
    if (isTypeNode(cur) && !isConnectionEndpointModule(cur)) {
      const info = cache.typeInfoForNode(cur, uri);
      if (info) return info;
    }
    cur = cur.parent;
  }
  return undefined;
}

/** Resolve a submodule/gate NAME inside a connection to its declaration. */
export function connectionRefAt(
  cache: NedResourceCache,
  file: NedFileInfo,
  tree: Tree,
  pos: Position,
): Location | null {
  const node = namedDescendantAt(tree, pos);
  if (!node || node.type !== 'name' || !ancestorOfType(node, ['connection'])) return null;
  const compound = enclosingTypeInfo(cache, node, file.uri);
  if (!compound) return null;
  const loc = (d: { owner: NedTypeInfo; node: SyntaxNode }): Location => ({
    uri: d.owner.file.uri,
    range: nodeRange(nameNode(d.node) ?? d.node),
  });

  // submodule reference (a `name` inside a `module` part)
  if (node.parent?.type === 'module') {
    const d = compound.submoduleDecl(node.text);
    return d ? loc(d) : null;
  }
  // gate reference (a `name` inside a `gate` part)
  if (node.parent?.type === 'gate') {
    const sd = ancestorOfType(node, ['src', 'dest']); // the connection endpoint
    const modNode = sd ? childByType(sd, 'module') : null;
    const modName = modNode ? childByType(modNode, 'name')?.text : undefined;
    let owner: NedTypeInfo | undefined = compound;
    if (modName) {
      const sub = compound.getSubmodule(modName);
      const st = sub?.type
        ? cache.lookupType(sub.type, file, topmostCompoundFq(cache, node, file.uri))
        : undefined;
      owner = st ?? undefined;
    }
    const d = owner?.gateDecl(node.text);
    return d ? loc(d) : null;
  }
  return null;
}

// ---- member (param/gate/submodule) references, for find-refs & rename ----

export type MemberKind = 'param' | 'gate' | 'submodule';

export interface MemberKey {
  kind: MemberKind;
  /** fq-name of the most-base type that declares the member (canonical owner). */
  ownerFq: string;
  name: string;
}

export interface MemberRef {
  key: MemberKey;
  range: Range;
}

/** The most-base type in the inheritance chain that locally declares `name`. */
function rootOwner(type: NedTypeInfo, kind: MemberKind, name: string): NedTypeInfo | undefined {
  const chain = [type, ...type.ancestors()]; // nearest first
  let root: NedTypeInfo | undefined;
  for (const t of chain) {
    const has =
      kind === 'param' ? t.localParams().has(name)
      : kind === 'gate' ? t.localGates().has(name)
      : t.localSubmodules().has(name);
    if (has) root = t; // keep the last (most base) declarer
  }
  return root;
}

function ownerOfParamNode(
  cache: NedResourceCache,
  file: NedFileInfo,
  node: SyntaxNode,
): NedTypeInfo | undefined {
  return enclosingSubmoduleType(cache, file, node) ?? enclosingTypeInfo(cache, node, file.uri);
}

/** Canonical member key for a `name` node inside a connection (gate/submodule ref). */
function connectionMemberKey(
  cache: NedResourceCache,
  file: NedFileInfo,
  node: SyntaxNode,
): MemberKey | null {
  const compound = enclosingTypeInfo(cache, node, file.uri);
  if (!compound) return null;
  if (node.parent?.type === 'module') {
    const root = rootOwner(compound, 'submodule', node.text);
    return root && compound.getSubmodule(node.text)
      ? { kind: 'submodule', ownerFq: root.fqName, name: node.text }
      : null;
  }
  if (node.parent?.type === 'gate') {
    const sd = node.parent.parent;
    const modNode = sd ? childByType(sd, 'module') : null;
    const modName = modNode ? childByType(modNode, 'name')?.text : undefined;
    let owner: NedTypeInfo | undefined = compound;
    if (modName) {
      const sub = compound.getSubmodule(modName);
      owner = sub?.type
        ? cache.lookupType(sub.type, file, topmostCompoundFq(cache, node, file.uri))
        : undefined;
    }
    if (!owner) return null;
    const root = rootOwner(owner, 'gate', node.text);
    return root ? { kind: 'gate', ownerFq: root.fqName, name: node.text } : null;
  }
  return null;
}

/** The canonical member key referenced by a node, if it is a member position. */
function memberKeyAt(cache: NedResourceCache, file: NedFileInfo, node: SyntaxNode): MemberKey | null {
  if (node.type !== 'name') return null;
  const p = node.parent;
  if (!p) return null;
  const inConn = !!ancestorOfType(node, ['connection']);

  if (inConn && (p.type === 'module' || p.type === 'gate')) {
    return connectionMemberKey(cache, file, node);
  }
  // parameter declaration or override (incl. submodule param overrides)
  if (p.type === 'parameter') {
    const owner = ownerOfParamNode(cache, file, node);
    const root = owner ? rootOwner(owner, 'param', node.text) : undefined;
    return root ? { kind: 'param', ownerFq: root.fqName, name: node.text } : null;
  }
  // gate declaration (a `name` in a gates section, not a connection)
  if (p.type === 'gate') {
    const owner = enclosingTypeInfo(cache, node, file.uri);
    const root = owner ? rootOwner(owner, 'gate', node.text) : undefined;
    return root ? { kind: 'gate', ownerFq: root.fqName, name: node.text } : null;
  }
  // submodule declaration name
  if (p.type === 'submodule') {
    const owner = enclosingTypeInfo(cache, node, file.uri);
    const root = owner ? rootOwner(owner, 'submodule', node.text) : undefined;
    return root ? { kind: 'submodule', ownerFq: root.fqName, name: node.text } : null;
  }
  return null;
}

function sameKey(a: MemberKey, b: MemberKey): boolean {
  return a.kind === b.kind && a.ownerFq === b.ownerFq && a.name === b.name;
}

/** The member (param/gate/submodule) referenced at a position, if any. */
export function memberRefAt(
  cache: NedResourceCache,
  file: NedFileInfo,
  tree: Tree,
  pos: Position,
): MemberRef | null {
  const node = namedDescendantAt(tree, pos);
  if (!node) return null;
  const key = memberKeyAt(cache, file, node);
  return key ? { key, range: nodeRange(node) } : null;
}

/**
 * All occurrences of a member (declaration, inherited overrides, connection
 * endpoints) across the project. Conservative: expression RHS references are
 * not included.
 */
export function memberReferences(cache: NedResourceCache, key: MemberKey): Location[] {
  const out: Location[] = [];
  for (const f of cache.allFiles()) {
    const stack: SyntaxNode[] = [f.tree.rootNode];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.type === 'name' && n.text === key.name) {
        const k = memberKeyAt(cache, f, n);
        if (k && sameKey(k, key)) out.push({ uri: f.uri, range: nodeRange(n) });
      }
      for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i)!);
    }
  }
  return out;
}

export function nedDefinition(
  cache: NedResourceCache,
  file: NedFileInfo,
  tree: Tree,
  pos: Position,
): Location | null {
  const ref = referenceAt(cache, file, tree, pos);
  if (ref) {
    const target = ref.kind === 'typeref' ? ref.target : ref.info;
    if (target) {
      const nn = nameNode(target.node) ?? target.node;
      return { uri: target.file.uri, range: nodeRange(nn) };
    }
    return null;
  }
  // fall back to parameter references, then connection (submodule/gate) references
  const pref = paramRefAt(cache, file, tree, pos);
  if (pref) return pref.decl;
  return connectionRefAt(cache, file, tree, pos);
}

function typeSignature(info: NedTypeInfo): string {
  const exts = info.extendsNames();
  const ifaces = info.interfaceNames();
  let s = `${kindKeyword(info)} ${info.fqName}`;
  if (exts.length) s += ` extends ${exts.join(', ')}`;
  if (ifaces.length) s += ` like ${ifaces.join(', ')}`;
  return s;
}

function kindKeyword(info: NedTypeInfo): string {
  switch (info.kind) {
    case 'simple': return 'simple';
    case 'compound': return 'module';
    case 'network': return 'network';
    case 'channel': return 'channel';
    case 'channelinterface': return 'channelinterface';
    case 'moduleinterface': return 'moduleinterface';
  }
}

export interface HoverResult {
  markdown: string;
  range: Range;
}

/** Locate a NED type definition for a doc cross-reference, skipping built-ins. */
function nedRefTarget(t: NedTypeInfo | undefined): DocRefTarget | undefined {
  if (!t || t.file.uri === BUILTIN_URI) return undefined;
  const { start } = nodeRange(nameNode(t.node) ?? t.node);
  return { uri: t.file.uri, pos: start };
}

/**
 * Resolver for `~Type` doc refs as seen from a NED type's own doc comment:
 * `ctxFile`/`enclosingFqName` reproduce that type's lookup context so unqualified
 * names follow NED precedence. Doc banners routinely name types that the owning
 * file never imports (e.g. siblings in a module family), so a context miss falls
 * back to a project-wide unique-simple-name search before finally trying
 * `external`, the cross-language fallback supplied by the caller.
 */
function nedDocResolver(
  cache: NedResourceCache,
  ctxFile: NedFileInfo,
  enclosingFqName: string | undefined,
  external?: DocRefResolver,
): DocRefResolver {
  const global = nedDocRefResolver(cache);
  return (name) =>
    nedRefTarget(cache.lookupType(name, ctxFile, enclosingFqName)) ??
    global(name) ??
    external?.(name);
}

/**
 * Context-free resolver: a qualified name resolves directly, an unqualified one
 * only when a single project type bears that simple name (an ambiguous name
 * stays plain text rather than linking to a guess). Used both as NED hover's
 * project-wide fallback and when a *MSG* doc comment references a NED type.
 */
export function nedDocRefResolver(cache: NedResourceCache): DocRefResolver {
  let bySimple: Map<string, NedTypeInfo[]> | undefined;
  return (name) => {
    if (name.includes('.')) return nedRefTarget(cache.getType(name));
    if (!bySimple) {
      bySimple = new Map();
      for (const t of cache.allTypes()) {
        if (t.isInnerType || t.file.uri === BUILTIN_URI) continue;
        const arr = bySimple.get(t.simpleName);
        if (arr) arr.push(t);
        else bySimple.set(t.simpleName, [t]);
      }
    }
    const matches = bySimple.get(name);
    return matches && matches.length === 1 ? nedRefTarget(matches[0]) : undefined;
  };
}

export function nedHover(
  cache: NedResourceCache,
  file: NedFileInfo,
  tree: Tree,
  pos: Position,
  external?: DocRefResolver,
): HoverResult | null {
  const ref = referenceAt(cache, file, tree, pos);
  if (!ref) {
    // parameter reference hover
    const pref = paramRefAt(cache, file, tree, pos);
    if (pref) {
      let md = `\`\`\`ned\n${pref.type ?? ''} ${pref.name}\n\`\`\`\n\ndeclared in \`${pref.ownerFq}\``;
      if (pref.doc) {
        const owner = cache.getType(pref.ownerFq);
        const resolve = nedDocResolver(cache, owner?.file ?? file, pref.ownerFq, external);
        md += '\n\n' + linkifyDocRefs(pref.doc, resolve);
      }
      return { markdown: md, range: pref.range };
    }
    return null;
  }
  const info = ref.kind === 'typeref' ? ref.target : ref.info;
  const range = ref.kind === 'typeref' ? nodeRange(ref.refNode) : nodeRange(ref.nameNode);
  if (!info) {
    if (ref.kind === 'typeref') {
      return { markdown: `Unknown type \`${ref.name}\``, range };
    }
    return null;
  }
  let md = '```ned\n' + typeSignature(info) + '\n```';
  const doc = info.documentation();
  if (doc) {
    const resolve = nedDocResolver(cache, info.file, info.fqName, external);
    md += '\n\n' + linkifyDocRefs(doc, resolve);
  }
  return { markdown: md, range };
}

/**
 * Find all references to a NED type (by definition or any reference position).
 * When `typeUsages` is supplied (the index-backed reverse query), it is used for
 * the project-wide type-reference scan instead of re-walking every file's tree.
 */
export function nedReferences(
  cache: NedResourceCache,
  file: NedFileInfo,
  tree: Tree,
  pos: Position,
  includeDeclaration: boolean,
  typeUsages?: (fqName: string) => Location[],
): Location[] {
  const ref = referenceAt(cache, file, tree, pos);
  if (!ref) {
    // member (param/gate/submodule) references
    const mref = memberRefAt(cache, file, tree, pos);
    if (mref) {
      const refs = memberReferences(cache, mref.key);
      return includeDeclaration ? refs : refs.filter((l) => !sameRange(l.range, mref.range));
    }
    return [];
  }
  const target = ref.kind === 'typeref' ? ref.target : ref.info;
  if (!target) return [];

  const out: Location[] = [];
  if (includeDeclaration) {
    const nn = nameNode(target.node) ?? target.node;
    out.push({ uri: target.file.uri, range: nodeRange(nn) });
  }
  if (typeUsages) {
    out.push(...typeUsages(target.fqName));
  } else {
    // fallback: scan every file for type references resolving to target
    for (const f of cache.allFiles()) collectTypeRefs(cache, f, target, out);
  }
  return out;
}

function sameRange(a: Range, b: Range): boolean {
  return a.start.line === b.start.line && a.start.character === b.start.character &&
         a.end.line === b.end.line && a.end.character === b.end.character;
}

function collectTypeRefs(
  cache: NedResourceCache,
  file: NedFileInfo,
  target: NedTypeInfo,
  out: Location[],
): void {
  const root = file.tree.rootNode;
  const stack: SyntaxNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (isTypeRefNode(n) && n.text.split('.').pop() === target.simpleName) {
      const enclosing = enclosingContextFor(cache, n, file.uri);
      const resolved = cache.lookupType(n.text, file, enclosing);
      if (resolved && resolved.fqName === target.fqName) {
        out.push({ uri: file.uri, range: nodeRange(n) });
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i)!);
  }
}
