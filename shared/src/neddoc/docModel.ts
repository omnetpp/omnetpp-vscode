/**
 * The format-independent documentation model: what the extraction phase
 * (extract.ts) produces from the NED/MSG caches and what the renderers
 * (renderHtml.ts, renderMarkdown.ts, ...) consume. Section kinds and their
 * order mirror the pages the Eclipse IDE's neddoc generator produces.
 */

import type { DocBlock } from './commentAst';
import type { DocGraph } from './graphDiagram';
import type { ExternalTypeRef } from './externalDocs';

export type PageKind =
  | 'index'
  | 'packages'
  | 'namespaces'
  /** A listing of the types of one category (networks, modules, ...) or of the files. */
  | 'category'
  | 'nedtype'
  | 'msgtype'
  | 'file'
  | 'topic'
  | 'fulldiagram';

export interface DocPageRef {
  /** Stable page id; the renderer derives the output path from it. Type pages
   *  use the sanitized fully-qualified name (`::` becomes `--`). */
  id: string;
  title: string;
  kind: PageKind;
}

/** An atomic piece of table-cell / paragraph content. */
export type DocCell =
  | { kind: 'text'; text: string }
  /** Link to a documented page or an external type's id (plain text when
   *  `page` is undefined). */
  | { kind: 'link'; text: string; page?: string; anchor?: string; tooltip?: string }
  /** Link to an external URL (e.g. doxygen C++ documentation). */
  | { kind: 'exlink'; text: string; href: string }
  /** Italic annotation, e.g. "(no description)" or a readable type kind. */
  | { kind: 'label'; text: string }
  /** Processed doc-comment content. */
  | { kind: 'doc'; blocks: DocBlock[] };

export interface DocTableRow {
  cells: DocCell[][];
  /** Row styling: member declared locally vs inherited from a base type. */
  cssClass?: 'local' | 'inherited';
  anchor?: string;
}

export type DiagramKind = 'type' | 'usage' | 'inheritance';

export type DocSection =
  /** Colored type-kind chip under the page title ("simple module", ...). */
  | { kind: 'badge'; typeKind: string; label: string }
  /** A one-line paragraph of cells (package line, C++ link, file line, ...). */
  | { kind: 'para'; cells: DocCell[] }
  /** The processed description comment. */
  | { kind: 'doc'; blocks: DocBlock[] }
  | { kind: 'subheading'; text: string; anchor?: string }
  | { kind: 'table'; cssClass: string; columns: string[]; rows: DocTableRow[] }
  /** Placeholder for a generated SVG diagram; `image` is the output-relative
   *  file path the generator will write (e.g. `images/a.b.C-usage.svg`). */
  | { kind: 'diagram'; diagram: DiagramKind; image: string; title: string }
  | { kind: 'source'; language: 'ned' | 'msg'; code: string };

export interface DocPage {
  ref: DocPageRef;
  sections: DocSection[];
  /** The content brings its own heading (an `@titlepage`): renderers that
   *  can do without one print no page heading. */
  ownHeading?: boolean;
  /** The NED/MSG kind of a type page (`typeKind()` values), recorded in the
   *  tag files. */
  typeKind?: string;
}

/** Navigation-tree node (drives the HTML sidebar, Markdown SUMMARY.md and the
 *  RST toctrees). */
export interface NavNode {
  title: string;
  page?: string;
  anchor?: string;
  /** A link to something not generated (`@externalpage`): an absolute URL or
   *  a path relative to the output root. */
  href?: string;
  children: NavNode[];
}

export interface SearchEntry {
  name: string;
  fqName: string;
  kindLabel: string;
  page: string;
}

/** A diagram the generator must render (resolved in the generate phase). */
export interface DiagramRequest {
  diagram: DiagramKind;
  /** fq name of the type the diagram belongs to ('' for full diagrams). */
  typeFqName: string;
  language: 'ned' | 'msg';
  /** Output-relative SVG path (matches the referencing section's `image`). */
  image: string;
  /** Node/edge graph for usage/inheritance diagrams (node ids = page ids). */
  graph?: DocGraph;
}

export interface DocModel {
  pages: DocPage[];
  navRoot: NavNode;
  searchIndex: SearchEntry[];
  diagrams: DiagramRequest[];
  warnings: string[];
  /** Indexed types this run does not document, by page id (cells and
   *  comment references point at these ids like at local pages). */
  externalTypes: Map<string, ExternalTypeRef>;
  /** One line per dependency whose types are referenced but cannot be
   *  linked. Kept apart from `warnings`: they are expected whenever a
   *  dependency's documentation is not configured. */
  externalWarnings: string[];
}

/** Page id for a type: fq name with `::` (MSG C++ names) mapped to `--`. */
export function pageIdForType(fqName: string, language: 'ned' | 'msg'): string {
  const id = fqName.replace(/::/g, '--');
  return language === 'msg' ? `msg-${id}` : id;
}

/** Page id for a NED/MSG file listing: the project-relative path with `/`
 *  mapped to `-` (the Eclipse file name), prefixed to stay apart from type ids. */
export function pageIdForFile(path: string): string {
  return `file-${path.replace(/\//g, '-')}`;
}

/** Page id for an `@page` topic page, from its sanitized `.html` file name. */
export function pageIdForTopic(fileName: string): string {
  return `page-${fileName.replace(/\.html$/, '')}`;
}

/** Anchor id for a package on the packages page (dots become underscores,
 *  as in the Eclipse generator). */
export function packageAnchor(packageName: string): string {
  return packageName.replace(/\./g, '_');
}

/** Anchor id for a C++ namespace on the namespaces page. */
export function namespaceAnchor(namespace: string): string {
  return (namespace || '(default)').replace(/::/g, '_');
}
