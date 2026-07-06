/**
 * Extraction phase of the NED documentation generator: turns the NED/MSG
 * caches into the format-independent DocModel (docModel.ts). Page content and
 * section order faithfully follow the Eclipse IDE's DocumentationGenerator
 * (generateTypePage and the generate*Table methods).
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { BUILTIN_URI, type NedResourceCache } from '../ned/nedResourceCache';
import type { NedTypeInfo } from '../ned/nedTypeInfo';
import type { MsgResourceCache } from '../msg/msgResourceCache';
import type { MsgTypeInfo } from '../msg/msgTypeInfo';
import {
  fileNamespace,
  gateInfo,
  gateNodes,
  leadingDocCommentRaw,
  nedClassRefs,
  nedPropertyInfo,
  paramDocCommentRaw,
  propertyNodes,
  type NedPropertyInfo,
} from '../ned/nedAst';
import { msgLeadingDocCommentRaw, msgPropertyInfo, msgTypeProperties } from '../msg/msgAst';
import { leadingDocCommentRaw as anyLeadingDocCommentRaw, trailingDocCommentRaw } from '../ned/nedAst';
import { resolveSubmoduleType } from '../ned/nedPreviewScene';
import { parseNedComment, parseBriefComment, type CommentParseCtx, type DocBlock } from './commentAst';
import {
  namespaceAnchor,
  packageAnchor,
  pageIdForType,
  type DiagramRequest,
  type DocCell,
  type DocModel,
  type DocPage,
  type DocSection,
  type DocTableRow,
  type NavNode,
  type SearchEntry,
} from './docModel';
import type { NeddocOptions } from './options';
import type { DocGraph, DocGraphEdge, DocGraphNode } from './graphDiagram';
import { doxyUrlFor, parseDoxyTags } from './doxytags';
import { collectUnassignedParameters, paramAssignmentsOf } from './unassignedParams';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface NeddocInput {
  nedCache: NedResourceCache;
  msgCache?: MsgResourceCache;
  /** Which files are documentation targets (e.g. workspace files, not NED-path
   *  libraries). Defaults to everything except the built-in declarations. */
  isTargetUri?: (uri: string) => boolean;
  /** Project-relative display path for the "File:" line (defaults to the URI
   *  without its scheme). */
  displayPath?: (uri: string) => string;
}

const NED_KIND_LABELS: Record<string, string> = {
  simple: 'simple module',
  compound: 'compound module',
  network: 'network',
  channel: 'channel',
  moduleinterface: 'module interface',
  channelinterface: 'channel interface',
};

const MSG_KIND_LABELS: Record<string, string> = {
  message: 'message',
  packet: 'packet',
  class: 'class',
  struct: 'struct',
  enum: 'enum',
};

export function nedKindLabel(t: NedTypeInfo): string {
  if (t.kind === 'compound' && t.isNetworkType()) return 'network';
  return NED_KIND_LABELS[t.kind] ?? t.kind;
}

function defaultDisplayPath(uri: string): string {
  return uri.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/?/, '');
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export function extractDocModel(input: NeddocInput, options: NeddocOptions): DocModel {
  const warnings: string[] = [];
  const nedCache = input.nedCache;
  const isTarget = (uri: string) =>
    (uri !== BUILTIN_URI || options.includeBuiltins) && (input.isTargetUri?.(uri) ?? true);
  const displayPath = input.displayPath ?? defaultDisplayPath;

  const nedTypes = nedCache
    .allTypes()
    .filter((t) => !t.isInnerType && isTarget(t.file.uri))
    .sort((a, b) => a.fqName.localeCompare(b.fqName));
  const msgTypes =
    options.messageDefinitions && input.msgCache
      ? input.msgCache
          .allTypes()
          .filter((t) => isTarget(t.file.uri))
          .sort((a, b) => a.fqName.localeCompare(b.fqName))
      : [];

  const model = new Extraction(nedCache, input.msgCache, nedTypes, msgTypes, options, warnings, displayPath);
  return model.run();
}

class Extraction {
  private nedPageId = new Map<string, string>(); // ned fq -> page id
  private msgPageId = new Map<string, string>(); // msg fq -> page id
  private typeNames = new Map<string, string[]>(); // referable name -> page ids
  private usersOf = new Map<string, NedTypeInfo[]>(); // ned fq -> user types
  private usedBy = new Map<string, NedTypeInfo[]>(); // ned fq -> local used types
  private implementorsOf = new Map<string, NedTypeInfo[]>(); // iface fq -> all implementors
  private directImplementorsOf = new Map<string, NedTypeInfo[]>(); // iface fq -> direct implementors
  private subtypesOf = new Map<string, NedTypeInfo[]>(); // ned fq -> direct subtypes
  private msgSubtypesOf = new Map<string, MsgTypeInfo[]>();
  private msgUsersOf = new Map<string, MsgTypeInfo[]>();
  private msgUsedBy = new Map<string, MsgTypeInfo[]>();
  private commentCtx: CommentParseCtx;
  private doxyMap?: Map<string, string>;
  /** URI of the file whose comments are being parsed (anchors `@include`). */
  private currentUri?: string;
  private pages: DocPage[] = [];
  private diagrams: DiagramRequest[] = [];
  private searchIndex: SearchEntry[] = [];

  constructor(
    private nedCache: NedResourceCache,
    private msgCache: MsgResourceCache | undefined,
    private nedTypes: NedTypeInfo[],
    private msgTypes: MsgTypeInfo[],
    private options: NeddocOptions,
    private warnings: string[],
    private displayPath: (uri: string) => string,
  ) {
    for (const t of nedTypes) this.nedPageId.set(t.fqName, pageIdForType(t.fqName, 'ned'));
    for (const t of msgTypes) this.msgPageId.set(t.fqName, pageIdForType(t.fqName, 'msg'));
    if (options.doxytags) this.doxyMap = parseDoxyTags(options.doxytags.xml);
    this.collectTypeNames();
    this.collectRelations();
    const includeResolver = this.options.includeResolver;
    this.commentCtx = {
      hyperlinkMode: this.options.automaticHyperlinks ? 'automatic' : 'tilde',
      lookupTypeName: (name) => this.typeNames.get(name),
      // an @include in a type's comment resolves relative to the file the
      // comment lives in; nested includes pass their own file id explicitly
      resolveInclude: includeResolver ? (ref, fromId) => includeResolver(ref, fromId ?? this.currentUri) : undefined,
      warnings: this.warnings,
    };
  }

  run(): DocModel {
    for (const t of this.nedTypes) this.pages.push(this.nedTypePage(t));
    for (const t of this.msgTypes) this.pages.push(this.msgTypePage(t));
    this.pages.unshift(this.indexPage(), ...this.packagesPage(), ...this.namespacesPage());
    return {
      pages: this.pages,
      navRoot: this.buildNav(),
      searchIndex: this.searchIndex,
      diagrams: this.diagrams,
      warnings: this.warnings,
    };
  }

  // ---- name map for comment type references (collectTypeNames port) ----

  private addTypeName(name: string, pageId: string): void {
    const list = this.typeNames.get(name);
    if (list) {
      if (!list.includes(pageId)) list.push(pageId);
    } else this.typeNames.set(name, [pageId]);
  }

  private collectTypeNames(): void {
    for (const t of this.nedTypes) {
      const id = this.nedPageId.get(t.fqName)!;
      this.addTypeName(t.simpleName, id);
      if (t.fqName !== t.simpleName) this.addTypeName(t.fqName, id);
    }
    for (const t of this.msgTypes) {
      const id = this.msgPageId.get(t.fqName)!;
      // a C++ name ns::sub::Foo is referable as ::ns::sub::Foo, ns::sub::Foo,
      // sub::Foo and Foo (as in the Eclipse generator)
      let qname = t.fqName;
      this.addTypeName('::' + qname, id);
      while (qname.includes('::')) {
        this.addTypeName(qname, id);
        qname = qname.slice(qname.indexOf('::') + 2);
      }
      this.addTypeName(qname, id);
    }
  }

  // ---- usage / inheritance relations ----

  private static addTo<T>(map: Map<string, T[]>, key: string, value: T): void {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  }

  /** Local used types of a NED type: submodule types + connection channels. */
  private localUsedTypes(t: NedTypeInfo): NedTypeInfo[] {
    const out = new Map<string, NedTypeInfo>();
    for (const [name, sub] of t.localSubmodules()) {
      const declOwner = t.submoduleDecl(name)?.owner ?? t;
      const resolved = resolveSubmoduleType(this.nedCache, t, declOwner, sub);
      if (resolved) out.set(resolved.fqName, resolved);
    }
    for (const conn of t.localConnections()) {
      const channelName = conn.channel?.typeName;
      if (!channelName) continue;
      const resolved = this.nedCache.lookupType(channelName, t.file, t.isInnerType ? t.enclosingFqName : undefined);
      if (resolved) out.set(resolved.fqName, resolved);
    }
    return [...out.values()];
  }

  private collectRelations(): void {
    for (const t of this.nedTypes) {
      const used = this.localUsedTypes(t);
      this.usedBy.set(t.fqName, used);
      for (const u of used) Extraction.addTo(this.usersOf, u.fqName, t);

      if (t.kind !== 'moduleinterface' && t.kind !== 'channelinterface') {
        for (const iface of t.allInterfaces()) Extraction.addTo(this.implementorsOf, iface.fqName, t);
        for (const sup of t.directSupertypes()) {
          if (sup.kind === 'moduleinterface' || sup.kind === 'channelinterface')
            Extraction.addTo(this.directImplementorsOf, sup.fqName, t);
        }
        const sup = t.superType();
        if (sup) Extraction.addTo(this.subtypesOf, sup.fqName, t);
      } else {
        for (const sup of t.directSupertypes()) Extraction.addTo(this.subtypesOf, sup.fqName, t);
      }
    }
    for (const t of this.msgTypes) {
      const sup = t.superType();
      if (sup) Extraction.addTo(this.msgSubtypesOf, sup.fqName, t);
      if (this.msgCache) {
        const used = new Map<string, MsgTypeInfo>();
        for (const f of t.localFields()) {
          if (!f.type) continue;
          const resolved = this.msgCache.lookupType(f.type.replace(/\s+/g, ''), t.namespace);
          if (resolved && resolved.fqName !== t.fqName) used.set(resolved.fqName, resolved);
        }
        this.msgUsedBy.set(t.fqName, [...used.values()]);
        for (const u of used.values()) Extraction.addTo(this.msgUsersOf, u.fqName, t);
      }
    }
  }

  // ---- shared cell builders ----

  private nedTypeLink(t: NedTypeInfo, label?: string): DocCell {
    const text = label ?? t.simpleName;
    return {
      kind: 'link',
      text,
      page: this.nedPageId.get(t.fqName),
      tooltip: text === t.fqName ? undefined : t.fqName,
    };
  }

  private msgTypeLink(t: MsgTypeInfo, label?: string): DocCell {
    const text = label ?? t.simpleName;
    return {
      kind: 'link',
      text,
      page: this.msgPageId.get(t.fqName),
      tooltip: text === t.fqName ? undefined : t.fqName,
    };
  }

  private docCell(raw: string | undefined, brief: boolean): DocCell[] {
    if (raw === undefined) return brief ? [{ kind: 'label', text: '(no description)' }] : [];
    const blocks = brief ? parseBriefComment(raw, this.commentCtx) : parseNedComment(raw, this.commentCtx);
    return [{ kind: 'doc', blocks }];
  }

  /** Name / Type / Description table of type references (Eclipse typestable). */
  private typesTable(items: { link: DocCell; kindLabel: string; doc: string | undefined }[]): DocSection {
    const rows: DocTableRow[] = items.map((item) => ({
      cells: [[item.link], [{ kind: 'label', text: item.kindLabel }], this.docCell(item.doc, true)],
    }));
    return { kind: 'table', cssClass: 'typestable', columns: ['Name', 'Type', 'Description'], rows };
  }

  private nedTypeRef(t: NedTypeInfo) {
    return { link: this.nedTypeLink(t), kindLabel: nedKindLabel(t), doc: leadingDocCommentRaw(t.node) };
  }

  private msgTypeRef(t: MsgTypeInfo) {
    return {
      link: this.msgTypeLink(t),
      kindLabel: MSG_KIND_LABELS[t.kind] ?? t.kind,
      doc: msgLeadingDocCommentRaw(t.node),
    };
  }

  // ---- properties helpers ----

  /** Merged type-level NED properties over the inheritance chain (derived
   *  overrides base), keyed by name+index. */
  private mergedNedProperties(t: NedTypeInfo): Map<string, NedPropertyInfo> {
    const out = new Map<string, NedPropertyInfo>();
    for (const owner of [...t.ancestors()].reverse().concat(t)) {
      for (const node of propertyNodes(owner.node)) {
        const info = nedPropertyInfo(node);
        if (!info.name) continue;
        out.set(`${info.name} ${info.index ?? ''}`, info);
      }
    }
    return out;
  }

  private static unquote(value: string): string {
    const m = /^"([\s\S]*)"$/.exec(value.trim());
    return m ? m[1] : value.trim();
  }

  private static propertyValueString(info: NedPropertyInfo): string {
    return info.tags
      .map((tag) => Extraction.unquote(tag.value))
      .filter((v) => v.length > 0)
      .join(',');
  }

  private static propertyTag(info: NedPropertyInfo, key: string): string {
    const tag = info.tags.find((t) => t.key === key);
    return tag ? Extraction.unquote(tag.value) : '';
  }

  private propertyDoc(node: SyntaxNode): string | undefined {
    return trailingDocCommentRaw(node) ?? anyLeadingDocCommentRaw(node);
  }

  // ---- diagram graphs (node ids = page ids, as graphDiagram links them) ----

  private nedGraphNode(t: NedTypeInfo, focus: boolean): DocGraphNode {
    return {
      id: this.nedPageId.get(t.fqName) ?? pageIdForType(t.fqName, 'ned'),
      label: t.simpleName,
      kind: t.kind === 'compound' && t.isNetworkType() ? 'network' : t.kind,
      focus: focus || undefined,
      tooltip: `${nedKindLabel(t)} ${t.simpleName}`,
    };
  }

  private msgGraphNode(t: MsgTypeInfo, focus: boolean): DocGraphNode {
    return {
      id: this.msgPageId.get(t.fqName) ?? pageIdForType(t.fqName, 'msg'),
      label: t.simpleName,
      kind: t.kind,
      focus: focus || undefined,
      tooltip: `${MSG_KIND_LABELS[t.kind] ?? t.kind} ${t.simpleName}`,
    };
  }

  /** Focus + direct supertypes/interfaces (unresolved names in red) + direct
   *  subtypes/implementors — the per-type inheritance diagram (Eclipse). */
  private nedInheritanceGraph(t: NedTypeInfo): DocGraph {
    const focus = this.nedGraphNode(t, true);
    const nodes = new Map<string, DocGraphNode>([[focus.id, focus]]);
    const edges: DocGraphEdge[] = [];
    const isInterface = (x: NedTypeInfo) => x.kind === 'moduleinterface' || x.kind === 'channelinterface';
    const tIsInterface = isInterface(t);
    const add = (node: DocGraphNode): DocGraphNode => {
      if (!nodes.has(node.id)) nodes.set(node.id, node);
      return nodes.get(node.id)!;
    };
    const resolvedSupers = new Set<string>();
    for (const sup of t.directSupertypes()) {
      const node = add(this.nedGraphNode(sup, false));
      resolvedSupers.add(sup.simpleName);
      resolvedSupers.add(sup.fqName);
      edges.push({ src: node.id, dest: focus.id, kind: !tIsInterface && isInterface(sup) ? 'interface' : 'inheritance' });
    }
    for (const name of [...t.extendsNames(), ...t.interfaceNames()]) {
      if (resolvedSupers.has(name)) continue;
      const node = add({ id: `unresolved:${name}`, label: name, kind: 'unresolved', tooltip: `unresolved type ${name}` });
      edges.push({ src: node.id, dest: focus.id, kind: 'inheritance' });
    }
    for (const sub of this.subtypesOf.get(t.fqName) ?? []) {
      const node = add(this.nedGraphNode(sub, false));
      edges.push({ src: focus.id, dest: node.id, kind: 'inheritance' });
    }
    for (const impl of this.directImplementorsOf.get(t.fqName) ?? []) {
      const node = add(this.nedGraphNode(impl, false));
      edges.push({ src: focus.id, dest: node.id, kind: 'interface' });
    }
    return { nodes: [...nodes.values()], edges };
  }

  /** Focus + local used types + users — the per-type usage diagram. */
  private nedUsageGraph(t: NedTypeInfo): DocGraph {
    const focus = this.nedGraphNode(t, true);
    const nodes = new Map<string, DocGraphNode>([[focus.id, focus]]);
    const edges: DocGraphEdge[] = [];
    for (const used of this.usedBy.get(t.fqName) ?? []) {
      const node = this.nedGraphNode(used, false);
      if (!nodes.has(node.id)) nodes.set(node.id, node);
      edges.push({ src: focus.id, dest: node.id, kind: 'usage' });
    }
    for (const user of this.usersOf.get(t.fqName) ?? []) {
      const node = this.nedGraphNode(user, false);
      if (!nodes.has(node.id)) nodes.set(node.id, node);
      edges.push({ src: node.id, dest: focus.id, kind: 'usage' });
    }
    return { nodes: [...nodes.values()], edges };
  }

  private msgInheritanceGraph(t: MsgTypeInfo): DocGraph {
    const focus = this.msgGraphNode(t, true);
    const nodes = new Map<string, DocGraphNode>([[focus.id, focus]]);
    const edges: DocGraphEdge[] = [];
    const sup = t.superType();
    if (sup) {
      const node = this.msgGraphNode(sup, false);
      if (!nodes.has(node.id)) nodes.set(node.id, node);
      edges.push({ src: node.id, dest: focus.id, kind: 'inheritance' });
    } else if (t.extendsName()) {
      const name = t.extendsName()!;
      nodes.set(`unresolved:${name}`, { id: `unresolved:${name}`, label: name, kind: 'unresolved' });
      edges.push({ src: `unresolved:${name}`, dest: focus.id, kind: 'inheritance' });
    }
    for (const sub of this.msgSubtypesOf.get(t.fqName) ?? []) {
      const node = this.msgGraphNode(sub, false);
      if (!nodes.has(node.id)) nodes.set(node.id, node);
      edges.push({ src: focus.id, dest: node.id, kind: 'inheritance' });
    }
    return { nodes: [...nodes.values()], edges };
  }

  private msgUsageGraph(t: MsgTypeInfo): DocGraph {
    const focus = this.msgGraphNode(t, true);
    const nodes = new Map<string, DocGraphNode>([[focus.id, focus]]);
    const edges: DocGraphEdge[] = [];
    for (const used of this.msgUsedBy.get(t.fqName) ?? []) {
      const node = this.msgGraphNode(used, false);
      if (!nodes.has(node.id)) nodes.set(node.id, node);
      edges.push({ src: focus.id, dest: node.id, kind: 'usage' });
    }
    for (const user of this.msgUsersOf.get(t.fqName) ?? []) {
      const node = this.msgGraphNode(user, false);
      if (!nodes.has(node.id)) nodes.set(node.id, node);
      edges.push({ src: node.id, dest: focus.id, kind: 'usage' });
    }
    return { nodes: [...nodes.values()], edges };
  }

  // ---- NED type page ----

  private nedTypePage(t: NedTypeInfo): DocPage {
    this.currentUri = t.file.uri;
    const pageId = this.nedPageId.get(t.fqName)!;
    const kindLabel = nedKindLabel(t);
    const sections: DocSection[] = [];
    this.searchIndex.push({ name: t.simpleName, fqName: t.fqName, kindLabel, page: pageId });

    // package line + kind badge
    sections.push({
      kind: 'para',
      cells: [
        { kind: 'text', text: 'Package: ' },
        { kind: 'link', text: t.packageName || '(default)', page: 'packages', anchor: packageAnchor(t.packageName || '(default)') },
      ],
    });
    sections.push({ kind: 'badge', typeKind: t.kind, label: `${kindLabel} ${t.simpleName}` });

    // "C++ definition" link-out via a doxygen tag file (simple modules only,
    // as in Eclipse; the class name comes from @class or the type name,
    // qualified by the file's @namespace)
    if (this.doxyMap && t.kind === 'simple') {
      const cls = nedClassRefs(t.node)[0]?.className ?? t.simpleName;
      const ns = fileNamespace(t.file.tree);
      const href = doxyUrlFor(this.doxyMap, this.options.doxytags?.urlPrefix ?? '', [
        ...(ns ? [`${ns}::${cls}`] : []),
        cls,
      ]);
      if (href) sections.push({ kind: 'para', cells: [{ kind: 'exlink', text: 'C++ definition', href }] });
    }

    // description
    const rawDoc = leadingDocCommentRaw(t.node);
    if (rawDoc === undefined) sections.push({ kind: 'para', cells: [{ kind: 'label', text: '(no description)' }] });
    else sections.push({ kind: 'doc', blocks: this.parseDoc(rawDoc) });

    // diagrams (placeholders; rendered in the generate phase)
    const usedTypes = this.usedBy.get(t.fqName) ?? [];
    const users = this.usersOf.get(t.fqName) ?? [];
    const implementors = this.implementorsOf.get(t.fqName) ?? [];
    const subtypes = this.subtypesOf.get(t.fqName) ?? [];
    if (this.options.typeDiagrams && t.isModuleType()) {
      const image = `images/${pageId}-type.svg`;
      sections.push({ kind: 'diagram', diagram: 'type', image, title: t.simpleName });
      this.diagrams.push({ diagram: 'type', typeFqName: t.fqName, language: 'ned', image });
    }
    if (this.options.usageDiagrams && (usedTypes.length > 0 || users.length > 0)) {
      const image = `images/${pageId}-usage.svg`;
      sections.push({ kind: 'subheading', text: 'Usage diagram', anchor: 'usage-diagram' });
      sections.push({ kind: 'diagram', diagram: 'usage', image, title: `Usage diagram of ${t.simpleName}` });
      this.diagrams.push({ diagram: 'usage', typeFqName: t.fqName, language: 'ned', image, graph: this.nedUsageGraph(t) });
    }
    const hasInheritance =
      t.directSupertypes().length > 0 || subtypes.length > 0 || implementors.length > 0 || t.extendsNames().length > 0;
    if (this.options.inheritanceDiagrams && hasInheritance) {
      const image = `images/${pageId}-inheritance.svg`;
      sections.push({ kind: 'subheading', text: 'Inheritance diagram', anchor: 'inheritance-diagram' });
      sections.push({ kind: 'diagram', diagram: 'inheritance', image, title: `Inheritance diagram of ${t.simpleName}` });
      this.diagrams.push({
        diagram: 'inheritance',
        typeFqName: t.fqName,
        language: 'ned',
        image,
        graph: this.nedInheritanceGraph(t),
      });
    }

    // implemented by (interfaces only)
    const isInterface = t.kind === 'moduleinterface' || t.kind === 'channelinterface';
    if (isInterface && implementors.length > 0) {
      sections.push({ kind: 'subheading', text: 'Implemented by', anchor: 'implementors' });
      sections.push(this.typesTable(implementors.map((i) => this.nedTypeRef(i))));
    }

    // used in compound modules / networks
    const userCompounds = users.filter((u) => u.isModuleType() && !u.isNetworkType() && u.kind === 'compound');
    const userNetworks = users.filter((u) => u.isModuleType() && u.isNetworkType());
    if (userCompounds.length > 0) {
      sections.push({ kind: 'subheading', text: 'Used in compound modules', anchor: 'used-in' });
      sections.push(this.typesTable(userCompounds.map((u) => this.nedTypeRef(u))));
    }
    if (userNetworks.length > 0) {
      sections.push({ kind: 'subheading', text: 'Used in', anchor: 'used-in-networks' });
      sections.push(this.typesTable(userNetworks.map((u) => this.nedTypeRef(u))));
    }

    // known subclasses, extends
    if (subtypes.length > 0) {
      sections.push({ kind: 'subheading', text: 'Known subclasses', anchor: 'subclasses' });
      sections.push(this.typesTable(subtypes.map((s) => this.nedTypeRef(s))));
    }
    if (t.extendsNames().length > 0) {
      sections.push({ kind: 'subheading', text: 'Extends', anchor: 'extends' });
      const supers = isInterface ? t.directSupertypes() : t.superType() ? [t.superType()!] : [];
      if (supers.length > 0) {
        sections.push(this.typesTable(supers.map((s) => this.nedTypeRef(s))));
      } else {
        sections.push(
          this.typesTableUnresolved(t.extendsNames()[0]),
        );
      }
    }

    sections.push(...this.parametersSection(t));
    sections.push(...this.propertiesSection(this.mergedNedProperties(t)));
    if (t.isModuleType()) sections.push(...this.gatesSection(t));
    sections.push(...this.signalsSection(t));
    sections.push(...this.statisticsSection(t));
    if ((t.kind === 'compound' || t.kind === 'network') && t.isModuleType())
      sections.push(...this.unassignedParamsSection(t));

    if (this.options.sourceSnippets) {
      sections.push({ kind: 'subheading', text: 'Source code', anchor: 'source' });
      const banner = leadingDocCommentRaw(t.node);
      sections.push({ kind: 'source', language: 'ned', code: (banner ? banner + '\n' : '') + t.node.text });
    }
    sections.push({
      kind: 'para',
      cells:
        t.file.uri === BUILTIN_URI
          ? [{ kind: 'text', text: 'File: Built-in type' }]
          : [{ kind: 'text', text: `File: ${this.displayPath(t.file.uri)}` }],
    });

    return { ref: { id: pageId, title: t.simpleName, kind: 'nedtype' }, sections };
  }

  private typesTableUnresolved(name: string): DocSection {
    return {
      kind: 'table',
      cssClass: 'typestable',
      columns: ['Name', 'Type', 'Description'],
      rows: [
        {
          cells: [
            [{ kind: 'text', text: name }],
            [{ kind: 'label', text: '(unknown -- not in documented files)' }],
            [],
          ],
        },
      ],
    };
  }

  private parseDoc(raw: string): DocBlock[] {
    return parseNedComment(raw, this.commentCtx);
  }

  // ---- member tables ----

  private parametersSection(t: NedTypeInfo): DocSection[] {
    const decls = t.params();
    if (decls.size === 0) return [];
    const localNames = new Set(t.localParams().keys());
    const assignments = paramAssignmentsOf(t);
    const rows: DocTableRow[] = [];
    for (const [name, decl] of decls) {
      const declInfo = t.paramDecl(name);
      const declNode = declInfo?.node ?? decl.node;
      rows.push({
        cells: [
          [{ kind: 'text', text: name }],
          [{ kind: 'text', text: decl.type ?? '' }],
          [{ kind: 'text', text: assignments.get(name)?.value ?? '' }],
          this.docCell(paramDocCommentRaw(declNode), false),
        ],
        cssClass: localNames.has(name) ? 'local' : 'inherited',
        anchor: `param-${name}`,
      });
    }
    return [
      { kind: 'subheading', text: 'Parameters', anchor: 'parameters' },
      { kind: 'table', cssClass: 'paramstable', columns: ['Name', 'Type', 'Default value', 'Description'], rows },
    ];
  }

  private propertiesSection(merged: Map<string, NedPropertyInfo>): DocSection[] {
    // only properties without an [index] appear here (as in Eclipse; indexed
    // ones like @signal[x]/@statistic[x] have their own tables)
    const rows: DocTableRow[] = [];
    const names = [...merged.values()]
      .filter((p) => !p.index)
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const info of names) {
      rows.push({
        cells: [
          [{ kind: 'text', text: info.name }],
          [{ kind: 'text', text: Extraction.propertyValueString(info) }],
          this.docCell(this.propertyDoc(info.node), false),
        ],
        anchor: `property-${info.name}`,
      });
    }
    if (rows.length === 0) return [];
    return [
      { kind: 'subheading', text: 'Properties', anchor: 'properties' },
      { kind: 'table', cssClass: 'propertiestable', columns: ['Name', 'Value', 'Description'], rows },
    ];
  }

  private gatesSection(t: NedTypeInfo): DocSection[] {
    const gates = t.gates();
    if (gates.size === 0) return [];
    const localNames = new Set(t.localGates().keys());
    const rows: DocTableRow[] = [];
    for (const [name] of gates) {
      // direction comes from the declaring gate node; size from the nearest
      // vector-size assignment in the chain
      let direction = '';
      let size = '';
      let isVector = false;
      let declNode: SyntaxNode | undefined;
      for (const owner of [t, ...t.ancestors()]) {
        for (const node of gateNodes(owner.node)) {
          const info = gateInfo(node);
          if (info.name !== name) continue;
          if (!declNode) declNode = node;
          if (info.type && !direction) {
            direction = info.type;
            declNode = node;
          }
          if (info.isVector) {
            isVector = true;
            if (!size) size = /\[\s*([^\]]+?)\s*\]/.exec(node.text)?.[1] ?? '';
          }
        }
      }
      rows.push({
        cells: [
          [{ kind: 'text', text: name + (isVector ? ' [ ]' : '') }],
          [{ kind: 'text', text: direction }],
          [{ kind: 'text', text: size }],
          this.docCell(declNode ? paramDocCommentRaw(declNode) : undefined, false),
        ],
        cssClass: localNames.has(name) ? 'local' : 'inherited',
        anchor: `gate-${name}`,
      });
    }
    return [
      { kind: 'subheading', text: 'Gates', anchor: 'gates' },
      { kind: 'table', cssClass: 'gatestable', columns: ['Name', 'Direction', 'Size', 'Description'], rows },
    ];
  }

  private indexedProperties(t: NedTypeInfo, propertyName: string): NedPropertyInfo[] {
    const merged = this.mergedNedProperties(t);
    return [...merged.values()]
      .filter((p) => p.name === propertyName && p.index)
      .sort((a, b) => (a.index ?? '').localeCompare(b.index ?? ''));
  }

  private signalsSection(t: NedTypeInfo): DocSection[] {
    const signals = this.indexedProperties(t, 'signal');
    if (signals.length === 0) return [];
    const rows: DocTableRow[] = signals.map((info) => ({
      cells: [
        [{ kind: 'text', text: info.index! }],
        this.cppTypeCell(Extraction.propertyTag(info, 'type')),
        [{ kind: 'text', text: Extraction.propertyTag(info, 'unit') }],
        this.docCell(this.propertyDoc(info.node), false),
      ],
      cssClass: 'local',
      anchor: `signal-${info.index}`,
    }));
    return [
      { kind: 'subheading', text: 'Signals', anchor: 'signals' },
      { kind: 'table', cssClass: 'signalstable', columns: ['Name', 'Type', 'Unit', 'Description'], rows },
    ];
  }

  /** A C++ type name cell: linked when it names a documented MSG type. */
  private cppTypeCell(cppType: string): DocCell[] {
    if (!cppType) return [];
    const targets = this.typeNames.get(cppType.replace(/\s+/g, ''));
    if (targets && targets.length === 1 && targets[0].startsWith('msg-'))
      return [{ kind: 'link', text: cppType, page: targets[0] }];
    return [{ kind: 'text', text: cppType }];
  }

  private statisticsSection(t: NedTypeInfo): DocSection[] {
    const statistics = this.indexedProperties(t, 'statistic');
    if (statistics.length === 0) return [];
    const rows: DocTableRow[] = statistics.map((info) => ({
      cells: [
        [{ kind: 'text', text: info.index! }],
        [{ kind: 'text', text: Extraction.propertyTag(info, 'title') }],
        [{ kind: 'text', text: Extraction.propertyTag(info, 'source') }],
        [{ kind: 'text', text: Extraction.propertyTag(info, 'record') }],
        [{ kind: 'text', text: Extraction.propertyTag(info, 'unit') }],
        [{ kind: 'text', text: Extraction.propertyTag(info, 'interpolationmode') }],
        this.docCell(this.propertyDoc(info.node), false),
      ],
      cssClass: 'local',
      anchor: `statistic-${info.index}`,
    }));
    return [
      { kind: 'subheading', text: 'Statistics', anchor: 'statistics' },
      {
        kind: 'table',
        cssClass: 'statisticstable',
        columns: ['Name', 'Title', 'Source', 'Record', 'Unit', 'Interpolation Mode', 'Description'],
        rows,
      },
    ];
  }

  private unassignedParamsSection(t: NedTypeInfo): DocSection[] {
    const params = collectUnassignedParameters(this.nedCache, t);
    if (params.length === 0) return [];
    const rows: DocTableRow[] = params.map((row) => {
      const nameCells: DocCell[] = [];
      row.path.forEach((seg, i) => {
        if (i > 0) nameCells.push({ kind: 'text', text: '.' });
        if (seg.typeFqName && this.nedPageId.has(seg.typeFqName)) {
          nameCells.push({ kind: 'link', text: seg.text, page: this.nedPageId.get(seg.typeFqName), tooltip: seg.typeFqName });
        } else {
          nameCells.push({ kind: 'text', text: seg.text });
        }
      });
      return {
        cells: [
          nameCells,
          [{ kind: 'text', text: row.param.type ?? '' }],
          [{ kind: 'text', text: row.value ?? '' }],
          this.docCell(paramDocCommentRaw(row.declNode), false),
        ],
      };
    });
    return [
      { kind: 'subheading', text: 'Unassigned submodule parameters', anchor: 'unassigned-parameters' },
      {
        kind: 'table',
        cssClass: 'deepparamstable',
        columns: ['Name', 'Type', 'Default value', 'Description'],
        rows,
      },
    ];
  }

  // ---- MSG type page ----

  private msgTypePage(t: MsgTypeInfo): DocPage {
    this.currentUri = t.file.uri;
    const pageId = this.msgPageId.get(t.fqName)!;
    const kindLabel = MSG_KIND_LABELS[t.kind] ?? t.kind;
    const sections: DocSection[] = [];
    this.searchIndex.push({ name: t.simpleName, fqName: t.fqName, kindLabel, page: pageId });

    const ns = t.namespace || '(default)';
    sections.push({
      kind: 'para',
      cells: [
        { kind: 'text', text: 'Namespace: ' },
        { kind: 'link', text: ns, page: 'namespaces', anchor: namespaceAnchor(t.namespace) },
      ],
    });
    sections.push({ kind: 'badge', typeKind: t.kind, label: `${kindLabel} ${t.simpleName}` });

    // "C++ definition" link-out (message compiler generates a same-named class)
    if (this.doxyMap) {
      const href = doxyUrlFor(this.doxyMap, this.options.doxytags?.urlPrefix ?? '', [t.fqName, t.simpleName]);
      if (href) sections.push({ kind: 'para', cells: [{ kind: 'exlink', text: 'C++ definition', href }] });
    }

    const rawDoc = msgLeadingDocCommentRaw(t.node);
    if (rawDoc === undefined) sections.push({ kind: 'para', cells: [{ kind: 'label', text: '(no description)' }] });
    else sections.push({ kind: 'doc', blocks: this.parseDoc(rawDoc) });

    // diagrams
    const used = this.msgUsedBy.get(t.fqName) ?? [];
    const users = this.msgUsersOf.get(t.fqName) ?? [];
    const subtypes = this.msgSubtypesOf.get(t.fqName) ?? [];
    if (this.options.usageDiagrams && (used.length > 0 || users.length > 0)) {
      const image = `images/${pageId}-usage.svg`;
      sections.push({ kind: 'subheading', text: 'Usage diagram', anchor: 'usage-diagram' });
      sections.push({ kind: 'diagram', diagram: 'usage', image, title: `Usage diagram of ${t.simpleName}` });
      this.diagrams.push({ diagram: 'usage', typeFqName: t.fqName, language: 'msg', image, graph: this.msgUsageGraph(t) });
    }
    if (this.options.inheritanceDiagrams && (t.extendsName() || subtypes.length > 0)) {
      const image = `images/${pageId}-inheritance.svg`;
      sections.push({ kind: 'subheading', text: 'Inheritance diagram', anchor: 'inheritance-diagram' });
      sections.push({ kind: 'diagram', diagram: 'inheritance', image, title: `Inheritance diagram of ${t.simpleName}` });
      this.diagrams.push({
        diagram: 'inheritance',
        typeFqName: t.fqName,
        language: 'msg',
        image,
        graph: this.msgInheritanceGraph(t),
      });
    }

    // extends / subclasses
    if (t.extendsName()) {
      sections.push({ kind: 'subheading', text: 'Extends', anchor: 'extends' });
      const sup = t.superType();
      sections.push(sup ? this.typesTable([this.msgTypeRef(sup)]) : this.typesTableUnresolved(t.extendsName()!));
    }
    if (subtypes.length > 0) {
      sections.push({ kind: 'subheading', text: 'Known subclasses', anchor: 'subclasses' });
      sections.push(this.typesTable(subtypes.map((s) => this.msgTypeRef(s))));
    }

    sections.push(...this.msgFieldsSection(t));
    sections.push(...this.msgPropertiesSection(t));

    if (this.options.sourceSnippets) {
      sections.push({ kind: 'subheading', text: 'Source code', anchor: 'source' });
      sections.push({ kind: 'source', language: 'msg', code: t.node.text });
    }
    sections.push({ kind: 'para', cells: [{ kind: 'text', text: `File: ${this.displayPath(t.file.uri)}` }] });

    return { ref: { id: pageId, title: t.simpleName, kind: 'msgtype' }, sections };
  }

  private msgFieldsSection(t: MsgTypeInfo): DocSection[] {
    const fields = t.fields();
    if (fields.length === 0) return [];
    const localNames = new Set(t.localFields().map((f) => f.name));
    const rows: DocTableRow[] = [];
    for (const f of fields) {
      if (!f.name) continue;
      const typeCells: DocCell[] = [];
      const fieldType = (f.type ?? '').trim();
      const resolved = fieldType && this.msgCache ? this.msgCache.lookupType(fieldType, t.namespace) : undefined;
      if (resolved && this.msgPageId.has(resolved.fqName)) typeCells.push(this.msgTypeLink(resolved, fieldType));
      else if (fieldType) typeCells.push({ kind: 'text', text: fieldType });
      if (f.isVector) {
        const size = /\[\s*([^\]]*?)\s*\]/.exec(f.node.text)?.[1] ?? '';
        typeCells.push({ kind: 'text', text: `[${size}]` });
      }
      rows.push({
        cells: [
          [{ kind: 'text', text: f.name }],
          typeCells,
          this.docCell(trailingDocCommentRaw(f.node) ?? anyLeadingDocCommentRaw(f.node), false),
        ],
        cssClass: localNames.has(f.name) ? 'local' : 'inherited',
        anchor: `field-${f.name}`,
      });
    }
    return [
      { kind: 'subheading', text: 'Fields', anchor: 'fields' },
      { kind: 'table', cssClass: 'fieldstable', columns: ['Name', 'Type', 'Description'], rows },
    ];
  }

  private msgPropertiesSection(t: MsgTypeInfo): DocSection[] {
    const rows: DocTableRow[] = [];
    const seen = new Set<string>();
    const chain: MsgTypeInfo[] = [];
    let cur: MsgTypeInfo | undefined = t;
    const guard = new Set<string>();
    while (cur && !guard.has(cur.fqName)) {
      guard.add(cur.fqName);
      chain.push(cur);
      cur = cur.superType();
    }
    const infos: { name: string; value: string; node: SyntaxNode }[] = [];
    for (const owner of chain) {
      for (const node of msgTypeProperties(owner.node)) {
        const info = msgPropertyInfo(node);
        if (!info.name || info.index || seen.has(info.name)) continue;
        seen.add(info.name);
        const value = info.keys
          .map((k) => k.values.map(Extraction.unquote).join(','))
          .filter((v) => v.length > 0)
          .join(';');
        infos.push({ name: info.name, value, node });
      }
    }
    infos.sort((a, b) => a.name.localeCompare(b.name));
    for (const info of infos) {
      rows.push({
        cells: [
          [{ kind: 'text', text: info.name }],
          [{ kind: 'text', text: info.value }],
          this.docCell(trailingDocCommentRaw(info.node) ?? anyLeadingDocCommentRaw(info.node), false),
        ],
      });
    }
    if (rows.length === 0) return [];
    return [
      { kind: 'subheading', text: 'Properties', anchor: 'properties' },
      { kind: 'table', cssClass: 'propertiestable', columns: ['Name', 'Value', 'Description'], rows },
    ];
  }

  // ---- structural pages ----

  private indexPage(): DocPage {
    const title = this.options.projectTitle ?? 'NED Documentation';
    const sections: DocSection[] = [
      {
        kind: 'doc',
        blocks: [
          {
            kind: 'para',
            inlines: [
              {
                kind: 'text',
                text:
                  'This documentation was generated from the NED and MSG files of the project. ' +
                  'Use the navigation tree to browse packages and types.',
              },
            ],
          },
        ],
      },
      {
        kind: 'para',
        cells: [
          {
            kind: 'text',
            text: `${this.nedTypes.length} NED type(s)` + (this.msgTypes.length ? `, ${this.msgTypes.length} message type(s)` : '') + ' documented.',
          },
        ],
      },
    ];
    return { ref: { id: 'index', title, kind: 'index' }, sections };
  }

  private packagesPage(): DocPage[] {
    if (this.nedTypes.length === 0) return [];
    const byPackage = new Map<string, NedTypeInfo[]>();
    for (const t of this.nedTypes) Extraction.addTo(byPackage, t.packageName || '(default)', t);
    const sections: DocSection[] = [];
    for (const pkg of [...byPackage.keys()].sort()) {
      sections.push({ kind: 'subheading', text: pkg, anchor: packageAnchor(pkg) });
      sections.push(this.typesTable(byPackage.get(pkg)!.map((t) => this.nedTypeRef(t))));
    }
    return [{ ref: { id: 'packages', title: 'Packages', kind: 'packages' }, sections }];
  }

  private namespacesPage(): DocPage[] {
    if (this.msgTypes.length === 0) return [];
    const byNs = new Map<string, MsgTypeInfo[]>();
    for (const t of this.msgTypes) Extraction.addTo(byNs, t.namespace || '(default)', t);
    const sections: DocSection[] = [];
    for (const ns of [...byNs.keys()].sort()) {
      sections.push({ kind: 'subheading', text: ns, anchor: namespaceAnchor(ns === '(default)' ? '' : ns) });
      sections.push(this.typesTable(byNs.get(ns)!.map((t) => this.msgTypeRef(t))));
    }
    return [{ ref: { id: 'namespaces', title: 'Namespaces', kind: 'namespaces' }, sections }];
  }

  private buildNav(): NavNode {
    const leaf = (title: string, page: string): NavNode => ({ title, page, children: [] });
    const typeLeaves = (types: NedTypeInfo[]): NavNode[] =>
      types
        .slice()
        .sort((a, b) => a.simpleName.localeCompare(b.simpleName) || a.fqName.localeCompare(b.fqName))
        .map((t) => leaf(t.simpleName, this.nedPageId.get(t.fqName)!));
    const msgLeaves = (types: MsgTypeInfo[]): NavNode[] =>
      types
        .slice()
        .sort((a, b) => a.simpleName.localeCompare(b.simpleName) || a.fqName.localeCompare(b.fqName))
        .map((t) => leaf(t.simpleName, this.msgPageId.get(t.fqName)!));

    const root: NavNode = { title: this.options.projectTitle ?? 'NED Documentation', children: [] };
    root.children.push(leaf('Overview', 'index'));

    if (this.nedTypes.length > 0) {
      const packages: NavNode = { title: 'Packages', page: 'packages', children: [] };
      const byPackage = new Map<string, NedTypeInfo[]>();
      for (const t of this.nedTypes) Extraction.addTo(byPackage, t.packageName || '(default)', t);
      for (const pkg of [...byPackage.keys()].sort())
        packages.children.push({
          title: pkg,
          page: 'packages',
          anchor: packageAnchor(pkg),
          children: typeLeaves(byPackage.get(pkg)!),
        });
      root.children.push(packages);

      const networks = this.nedTypes.filter((t) => t.isModuleType() && t.isNetworkType());
      const modules = this.nedTypes.filter((t) => t.isModuleType() && !t.isNetworkType());
      const moduleIfaces = this.nedTypes.filter((t) => t.kind === 'moduleinterface');
      const channels = this.nedTypes.filter((t) => t.kind === 'channel');
      const channelIfaces = this.nedTypes.filter((t) => t.kind === 'channelinterface');
      if (networks.length) root.children.push({ title: 'Networks', children: typeLeaves(networks) });
      if (modules.length) root.children.push({ title: 'Modules', children: typeLeaves(modules) });
      if (moduleIfaces.length) root.children.push({ title: 'Module Interfaces', children: typeLeaves(moduleIfaces) });
      if (channels.length) root.children.push({ title: 'Channels', children: typeLeaves(channels) });
      if (channelIfaces.length)
        root.children.push({ title: 'Channel Interfaces', children: typeLeaves(channelIfaces) });
    }

    if (this.msgTypes.length > 0) {
      const namespaces: NavNode = { title: 'Namespaces', page: 'namespaces', children: [] };
      const byNs = new Map<string, MsgTypeInfo[]>();
      for (const t of this.msgTypes) Extraction.addTo(byNs, t.namespace || '(default)', t);
      for (const ns of [...byNs.keys()].sort())
        namespaces.children.push({
          title: ns,
          page: 'namespaces',
          anchor: namespaceAnchor(ns === '(default)' ? '' : ns),
          children: msgLeaves(byNs.get(ns)!),
        });
      root.children.push(namespaces);

      const msgDefs: NavNode = { title: 'Message Definitions', children: [] };
      const byKind: [string, string][] = [
        ['message', 'Messages'],
        ['packet', 'Packets'],
        ['class', 'Classes'],
        ['struct', 'Structs'],
        ['enum', 'Enums'],
      ];
      for (const [kind, title] of byKind) {
        const types = this.msgTypes.filter((t) => t.kind === kind);
        if (types.length) msgDefs.children.push({ title, children: msgLeaves(types) });
      }
      if (msgDefs.children.length) root.children.push(msgDefs);
    }

    return root;
  }
}
