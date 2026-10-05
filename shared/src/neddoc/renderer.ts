/**
 * Renderer abstraction of the NED documentation generator: one implementation
 * per output format (renderHtml.ts, renderMarkdown.ts, renderRst.ts,
 * renderMaterialHtml.ts). Shared here: the output path scheme and relative-path
 * helpers all formats use.
 */

import type { DocFormat, NeddocOptions } from './options';
import type { DocModel, DocPage, DocPageRef } from './docModel';
import { isAbsoluteUrl, type ExternalTypeRef } from './externalDocs';
import { escapeHtmlAll, escapeHtmlText } from './commentEmit';

export interface GeneratedFile {
  relativePath: string;
  content: string | Uint8Array;
}

export interface RenderCtx {
  model: DocModel;
  options: NeddocOptions;
  /** True when the SVG for a diagram section was actually generated. */
  hasImage(image: string): boolean;
  /** Content of a generated SVG (for renderers that inline diagrams). */
  imageContent(image: string): string | undefined;
}

export interface NeddocRenderer {
  readonly format: DocFormat;
  readonly pageExtension: string;
  /** Output-relative path of a page. */
  pagePath(ref: DocPageRef): string;
  /** Output path for a diagram SVG; defaults to the model's images/ path
   *  (the material layout keeps images at the root under Eclipse names). */
  imagePath?(image: string): string;
  renderPage(page: DocPage, ctx: RenderCtx): string;
  /** Non-page outputs: assets, nav data, SUMMARY.md, index toctrees, ... */
  auxFiles(ctx: RenderCtx): GeneratedFile[];
}

/** Default path scheme: type pages under types/, structural pages at the root. */
export function defaultPagePath(ref: DocPageRef, extension: string): string {
  return ref.kind === 'nedtype' || ref.kind === 'msgtype' ? `types/${ref.id}${extension}` : `${ref.id}${extension}`;
}

export function dirOf(relativePath: string): string {
  const i = relativePath.lastIndexOf('/');
  return i < 0 ? '' : relativePath.slice(0, i);
}

/** Relative reference from `fromDir` (output-relative, '' = root) to an
 *  output-relative target path. */
export function relativeRef(fromDir: string, toPath: string): string {
  const from = fromDir ? fromDir.split('/') : [];
  const to = toPath.split('/');
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  const ups = from.length - common;
  return '../'.repeat(ups) + to.slice(common).join('/');
}

/** Look up a page ref by id (pages are few; linear scan is fine). */
export function pageById(model: DocModel, id: string): DocPageRef | undefined {
  return model.pages.find((p) => p.ref.id === id)?.ref;
}

/** href from `fromDir` to a dependency type's external page (undefined when
 *  it cannot be linked). Relative targets are relative to the output root. */
export function externalHref(ref: ExternalTypeRef, fromDir: string): string | undefined {
  if (!ref.target) return undefined;
  return isAbsoluteUrl(ref.target) ? ref.target : relativeRef(fromDir, ref.target);
}

/** Tooltip marking a dependency type (Eclipse: "[from <project>]"). */
export function externalTooltip(ref: ExternalTypeRef, base?: string): string {
  const marker = ref.target ? `[from ${ref.from}] \u2197` : `[from ${ref.from} \u2014 not documented here]`;
  return base ? `${base} ${marker}` : marker;
}

/** HTML for a reference to a dependency type: an `externaltype` link (the
 *  stylesheet adds the ↗), or a marked span when it cannot be linked. */
export function externalTypeHtml(ref: ExternalTypeRef, text: string, fromDir: string, tooltip?: string): string {
  const href = externalHref(ref, fromDir);
  const title = ` title="${escapeHtmlAll(externalTooltip(ref, tooltip))}"`;
  return href
    ? `<a class="externaltype" href="${escapeHtmlAll(href)}"${title}>${escapeHtmlText(text)}</a>`
    : `<span class="externaltype"${title}>${escapeHtmlText(text)}</span>`;
}

/** Stylesheet rules for externaltype references, appended to the built-in
 *  stylesheets of the HTML formats. */
export const EXTERNAL_TYPE_CSS = `
.externaltype { cursor: alias; }
span.externaltype { border-bottom: 1px dotted currentColor; cursor: help; }
a.externaltype::after { content: "\\2197"; font-size: 75%; margin-left: 0.1em; }
`;
