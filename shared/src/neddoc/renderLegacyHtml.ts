/**
 * Legacy HTML renderer: reproduces the Eclipse IDE's neddoc output — the
 * Material-Design-Lite template (page.tmpl and its jquery/navtree assets,
 * vendored under resources/neddoc-legacy/), Eclipse's flat file naming
 * (every page at the output root, type pages named by fully-qualified name),
 * the HtmlRenderer.java markup shapes, and the navtreedata.js /
 * navtreeindex0.js sidebar data files. Useful for A/B comparison against a
 * real Eclipse-generated doc/neddoc tree and as a fidelity harness.
 */

import { emitHtml, escapeHtmlAll, escapeHtmlText } from './commentEmit';
import type { DocCell, DocModel, DocPage, DocPageRef, DocSection, NavNode } from './docModel';
import type { GeneratedFile, NeddocRenderer, RenderCtx } from './renderer';
import { pageById } from './renderer';

/** Chip colors of HtmlRenderer.typeSectionHeading(). */
const CHIP_COLORS: Record<string, string> = {
  'simple module': '#ff000040',
  'compound module': '#00ff0040',
  network: '#2196f340',
  channel: '#ffca0080',
};

const KIND_LABELS: Record<string, string> = {
  simple: 'simple module',
  compound: 'compound module',
  network: 'network',
  channel: 'channel',
  moduleinterface: 'module interface',
  channelinterface: 'channel interface',
  message: 'message',
  packet: 'packet',
  class: 'class',
  struct: 'struct',
  enum: 'enum',
};

// template assets copied to the output as-is (page.tmpl/navtree.tmpl are
// consumed by the renderer itself, not shipped)
const STATIC_ASSETS = [
  'style.css',
  'material.blue-light_blue.min.css',
  'material-icons.css',
  'material-icons.woff2',
  'jquery.js',
  'navtree.js',
  'material.min.js',
];

export class LegacyHtmlRenderer implements NeddocRenderer {
  readonly format = 'legacy-html' as const;
  readonly pageExtension = '.html';

  constructor(private assets: Record<string, string | Uint8Array>) {
    for (const required of ['page.tmpl', 'navtree.tmpl']) {
      if (!(required in assets)) throw new Error(`legacy-html: missing template asset ${required}`);
    }
  }

  private asset(name: string): string {
    const a = this.assets[name];
    return typeof a === 'string' ? a : new TextDecoder().decode(a);
  }

  /** Eclipse flat naming: everything at the output root; type pages named by
   *  fq name, MSG C++ `::` becomes `-` (getOutputFileName). */
  pagePath(ref: DocPageRef): string {
    if (ref.kind === 'msgtype') return ref.id.replace(/^msg-/, '').replace(/--/g, '-') + this.pageExtension;
    return `${ref.id}${this.pageExtension}`;
  }

  imagePath(image: string): string {
    return legacyImageName(image);
  }

  renderPage(page: DocPage, ctx: RenderCtx): string {
    const linkTo = (pageId: string, anchor?: string): string => {
      const target = pageById(ctx.model, pageId);
      if (!target) return '#';
      return this.pagePath(target) + (anchor ? `#${anchor}` : '');
    };
    const content =
      page.ref.kind === 'index'
        ? DEFAULT_OVERVIEW
        : page.sections.map((s) => this.renderSection(s, ctx, linkTo)).filter(Boolean).join('\n');
    const template = this.asset('page.tmpl');
    return template.replace(/@title@/g, escapeHtmlText(page.ref.title)).replace('@content@', content);
  }

  private renderCells(cells: DocCell[], linkTo: (p: string, a?: string) => string): string {
    return cells
      .map((cell) => {
        switch (cell.kind) {
          case 'text':
            return escapeHtmlText(cell.text);
          case 'label':
            return `<i>${escapeHtmlText(cell.text)}</i>`;
          case 'link': {
            if (!cell.page) return escapeHtmlText(cell.text);
            const tooltip = cell.tooltip ? ` title="${escapeHtmlAll(cell.tooltip)}"` : '';
            return `<a${tooltip} href="${escapeHtmlAll(linkTo(cell.page, cell.anchor))}">${escapeHtmlText(cell.text)}</a>`;
          }
          case 'exlink':
            return `<a class="reference-cpp" href="${escapeHtmlAll(cell.href)}">${escapeHtmlText(cell.text)}</a>`;
          case 'doc':
            return emitHtml(cell.blocks, { hrefFor: (target) => linkTo(target) });
        }
      })
      .join('');
  }

  private renderSection(section: DocSection, ctx: RenderCtx, linkTo: (p: string, a?: string) => string): string {
    switch (section.kind) {
      case 'badge': {
        // HtmlRenderer.typeSectionHeading(): floated name + colored mdl chip
        const label = KIND_LABELS[section.typeKind] ?? section.typeKind;
        const name = section.label.startsWith(label) ? section.label.slice(label.length).trim() : section.label;
        const color = CHIP_COLORS[label] ?? (label.includes('interface') ? '#00e5ff40' : '#dedede');
        return (
          `<h2 class="comptitle" style="float: left;">${escapeHtmlText(name)}</h2>\n` +
          `<span class="mdl-chip" style="float: right; margin-top: 6pt; background-color: ${color};">\n` +
          `    <span class="mdl-chip__text">${escapeHtmlText(label)}</span>\n` +
          `</span><div style="clear: both;"></div>`
        );
      }
      case 'para':
        return `<p>${this.renderCells(section.cells, linkTo)}</p>`;
      case 'doc':
        return emitHtml(section.blocks, { hrefFor: (target) => linkTo(target) });
      case 'subheading': {
        const anchor = section.anchor ? `<span id="${escapeHtmlAll(section.anchor)}"> </span>\n` : '';
        return `${anchor}<h3 class="subtitle">${escapeHtmlText(section.text)}</h3>`;
      }
      case 'table': {
        const head = section.columns
          .map((c) => `      <th class="${c.toLowerCase().replace(/[^a-z]/g, '')}">${escapeHtmlText(c)}</th>`)
          .join('\n');
        const rows = section.rows
          .map((row) => {
            const cls = row.cssClass ? ` class="${row.cssClass}"` : '';
            const id = row.anchor ? ` id="${escapeHtmlAll(row.anchor)}"` : '';
            const cells = row.cells.map((c) => `      <td>${this.renderCells(c, linkTo)}</td>`).join('\n');
            return `   <tr${cls}${id}>\n${cells}\n   </tr>`;
          })
          .join('\n');
        return `<table class="${escapeHtmlAll(section.cssClass)}">\n   <tr>\n${head}\n   </tr>\n${rows}\n</table>`;
      }
      case 'diagram':
        if (!ctx.hasImage(section.image)) return '';
        // Eclipse embeds diagram SVGs via <object> so their links stay live;
        // images live at the root in legacy layout (strip the images/ prefix)
        return `<object type="image/svg+xml" data="${escapeHtmlAll(legacyImageName(section.image))}"></object>`;
      case 'source':
        return `<pre class="src">${escapeHtmlAll(section.code)}</pre>`;
    }
  }

  auxFiles(ctx: RenderCtx): GeneratedFile[] {
    const files: GeneratedFile[] = [];
    for (const name of STATIC_ASSETS) {
      // a custom stylesheet replaces the template's style.css (Eclipse's
      // copyStaticResources(cssPath) behavior)
      if (name === 'style.css' && ctx.options.customCss !== undefined) {
        files.push({ relativePath: name, content: ctx.options.customCss });
        continue;
      }
      if (name in this.assets) files.push({ relativePath: name, content: this.assets[name] });
    }
    files.push({ relativePath: 'navtreedata.js', content: this.navTreeData(ctx.model) });
    files.push({ relativePath: 'navtreeindex0.js', content: this.navTreeIndex(ctx.model) });
    return files;
  }

  /** navtreedata.js in the Eclipse format: nested [`title`, `url`, [children]]
   *  arrays (backtick-quoted strings), wrapped by navtree.tmpl. */
  private navTreeData(model: DocModel): string {
    const nodeStr = (node: NavNode, indent: string): string => {
      const url = node.page ? this.navUrl(model, node) : null;
      const head = `\n${indent}[\`${node.title}\`, ${url === null ? 'null' : `\`${url}\``}, `;
      if (node.children.length === 0) return `${head}null],`;
      const children = node.children.map((c) => nodeStr(c, indent + '  ')).join('');
      return `${head}[${children}\n${indent}] ],`;
    };
    const root = model.navRoot;
    const rootStr =
      `\n  [\`${root.title}\`, \`index.html\`, [` +
      root.children.map((c) => nodeStr(c, '    ')).join('') +
      `\n  ] ],`;
    return this.asset('navtree.tmpl').replace('@content@', rootStr);
  }

  private navUrl(model: DocModel, node: NavNode): string {
    const target = node.page ? pageById(model, node.page) : undefined;
    if (!target) return 'index.html';
    return this.pagePath(target) + (node.anchor ? `#${node.anchor}` : '');
  }

  /** navtreeindex0.js: url -> child-index breadcrumb into NAVTREE (used by
   *  navtree.js to expand/select the current page). */
  private navTreeIndex(model: DocModel): string {
    const entries: string[] = [];
    const seen = new Set<string>();
    const walk = (node: NavNode, path: number[]): void => {
      if (node.page) {
        const url = this.navUrl(model, node);
        if (!seen.has(url)) {
          seen.add(url);
          entries.push(`'${url}':[${path.join(',')}],`);
        }
      }
      node.children.forEach((child, i) => walk(child, [...path, i]));
    };
    model.navRoot.children.forEach((child, i) => walk(child, [i]));
    return `var NAVTREEINDEX0 = {\n${entries.join('\n')}\n};`;
  }
}

/** Legacy layout keeps images at the output root (Eclipse naming). */
export function legacyImageName(image: string): string {
  return image.replace(/^images\//, '').replace(/^msg-/, '').replace(/--/g, '-');
}

/** HtmlRenderer.defaultOverviewString(). */
const DEFAULT_OVERVIEW =
  '<center><h1>OMNeT++ Model Documentation</h1></center>\n' +
  '<center><i>Generated from NED and MSG files</i></center>\n' +
  '<p>This documentation has been generated from NED and MSG files.</p>\n' +
  '<p>Use the links in the left frame to navigate around.</p>\n' +
  "<p>Hint for model developers: if you don't like this page, try creating\n" +
  'a <tt>package.ned</tt> file with the <tt>@titlepage</tt> directive\n' +
  'embedded in a comment.</p>\n' +
  '<hr/>\n' +
  '<p>Generated by neddoc.</p>';
