/**
 * Material HTML renderer: reproduces the Eclipse IDE's neddoc output — the
 * Material-Design-Lite template (page.tmpl and its jquery/navtree assets,
 * vendored under resources/neddoc-material/), Eclipse's flat file naming
 * (every page at the output root, type pages named by fully-qualified name),
 * the HtmlRenderer.java markup shapes, and the navtreedata.js /
 * navtreeindex0.js sidebar data files. Useful for A/B comparison against a
 * real Eclipse-generated doc/neddoc tree and as a fidelity harness.
 */

import { emitHtml, escapeHtmlAll, escapeHtmlText } from './commentEmit';
import type { DocCell, DocModel, DocPage, DocPageRef, DocSection, NavNode } from './docModel';
import type { GeneratedFile, NeddocRenderer, RenderCtx } from './renderer';
import { EXTERNAL_TYPE_CSS, externalHref, pageById } from './renderer';
import { htmlEmitOpts, type LinkingEmitOpts } from './renderHtml';

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

export class MaterialHtmlRenderer implements NeddocRenderer {
  readonly format = 'html-material' as const;
  readonly pageExtension = '.html';

  constructor(private assets: Record<string, string | Uint8Array>) {
    for (const required of ['page.tmpl', 'navtree.tmpl']) {
      if (!(required in assets)) throw new Error(`html-material: missing template asset ${required}`);
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
    return materialImageName(image);
  }

  renderPage(page: DocPage, ctx: RenderCtx): string {
    const linkTo = (pageId: string, anchor?: string): string => {
      const target = pageById(ctx.model, pageId);
      if (target) return this.pagePath(target) + (anchor ? `#${anchor}` : '');
      const ext = ctx.model.externalTypes.get(pageId);
      return (ext && externalHref(ext, '')) ?? '#';
    };
    const emitOpts = htmlEmitOpts(ctx, linkTo, '');
    const content =
      page.ref.kind === 'index'
        ? DEFAULT_OVERVIEW
        : page.sections.map((s) => this.renderSection(s, ctx, emitOpts)).filter(Boolean).join('\n');
    const template = injectSearch(this.asset('page.tmpl'));
    return template.replace(/@title@/g, escapeHtmlText(page.ref.title)).replace('@content@', content);
  }

  private renderCells(cells: DocCell[], emitOpts: LinkingEmitOpts): string {
    const linkTo = emitOpts.linkTo;
    return cells
      .map((cell) => {
        switch (cell.kind) {
          case 'text':
            return escapeHtmlText(cell.text);
          case 'label':
            return `<i>${escapeHtmlText(cell.text)}</i>`;
          case 'link': {
            if (!cell.page) return escapeHtmlText(cell.text);
            const external = emitOpts.externalTypeRef(cell.page, cell.text, cell.tooltip);
            if (external !== undefined) return external;
            const tooltip = cell.tooltip ? ` title="${escapeHtmlAll(cell.tooltip)}"` : '';
            return `<a${tooltip} href="${escapeHtmlAll(linkTo(cell.page, cell.anchor))}">${escapeHtmlText(cell.text)}</a>`;
          }
          case 'exlink':
            return `<a class="reference-cpp" href="${escapeHtmlAll(cell.href)}">${escapeHtmlText(cell.text)}</a>`;
          case 'doc':
            return emitHtml(cell.blocks, emitOpts);
        }
      })
      .join('');
  }

  private renderSection(section: DocSection, ctx: RenderCtx, emitOpts: LinkingEmitOpts): string {
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
        return `<p>${this.renderCells(section.cells, emitOpts)}</p>`;
      case 'doc':
        return emitHtml(section.blocks, emitOpts);
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
            const cells = row.cells.map((c) => `      <td>${this.renderCells(c, emitOpts)}</td>`).join('\n');
            return `   <tr${cls}${id}>\n${cells}\n   </tr>`;
          })
          .join('\n');
        return `<table class="${escapeHtmlAll(section.cssClass)}">\n   <tr>\n${head}\n   </tr>\n${rows}\n</table>`;
      }
      case 'diagram':
        if (!ctx.hasImage(section.image)) return '';
        // Eclipse embeds diagram SVGs via <object> so their links stay live;
        // images live at the root in material layout (strip the images/ prefix)
        return `<object type="image/svg+xml" data="${escapeHtmlAll(materialImageName(section.image))}"></object>`;
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
      if (name === 'style.css' && name in this.assets) {
        files.push({ relativePath: name, content: this.asset(name) + EXTERNAL_TYPE_CSS });
        continue;
      }
      if (name in this.assets) files.push({ relativePath: name, content: this.assets[name] });
    }
    files.push({ relativePath: 'navtreedata.js', content: this.navTreeData(ctx.model) });
    files.push({ relativePath: 'navtreeindex0.js', content: this.navTreeIndex(ctx.model) });
    // client-side type search (the vendored template ships it disabled): the
    // flat index global + the vanilla-JS logic that injectSearch() wires in
    files.push({ relativePath: 'search-data.js', content: this.searchData(ctx.model) });
    files.push({ relativePath: 'neddoc-search.js', content: NEDDOC_SEARCH_JS });
    return files;
  }

  /** search-data.js: the flat type index as a JS global (works from file://,
   *  no fetch). Same shape the modern HtmlRenderer emits. */
  private searchData(model: DocModel): string {
    const entries = model.searchIndex.map((e) => ({
      n: e.name,
      f: e.fqName,
      k: e.kindLabel,
      p: this.searchHref(model, e.page),
    }));
    return `var NEDDOC_SEARCH = ${JSON.stringify(entries)};\n`;
  }

  /** Flat root-relative href to a type page (all material pages sit at the root,
   *  so it is valid from any page). */
  private searchHref(model: DocModel, pageId: string): string {
    const ref = pageById(model, pageId);
    return ref ? this.pagePath(ref) : `${pageId}${this.pageExtension}`;
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

/**
 * Splice the client-side type search into the vendored page.tmpl chrome: a
 * search box in the header row plus the data/logic scripts and styling. Done
 * by string replacement against stable anchors (the `</head>` tag and the MDL
 * layout spacer) so the template snapshot itself stays a verbatim copy of the
 * Eclipse original and survives asset regeneration.
 */
function injectSearch(template: string): string {
  return template
    .replace('</head>', `${SEARCH_HEAD}</head>\n`)
    .replace(
      '<div class="mdl-layout-spacer"></div>',
      `<div class="mdl-layout-spacer"></div>\n${SEARCH_BOX}`,
    );
}

/** Search styling + the two script includes, injected before `</head>`. */
const SEARCH_HEAD = `<style type="text/css">
#nd-search { position: relative; display: flex; align-items: center; }
#nd-search > .material-icons { color: #fff; margin-right: 4px; opacity: 0.9; }
#nd-search input {
  border: none; border-radius: 3px; padding: 5px 10px; font: inherit; font-size: 1rem;
  width: 200px; background: rgba(255,255,255,0.15); color: #fff;
  transition: width .15s ease, background .15s ease;
}
#nd-search input::placeholder { color: rgba(255,255,255,0.75); }
#nd-search input:focus { outline: none; background: #fff; color: #212121; width: 260px; }
#nd-search-results {
  position: absolute; top: 100%; right: 0; margin-top: 6px; min-width: 280px;
  max-width: 80vw; max-height: 60vh; overflow: auto; background: #fff; color: #212121;
  border-radius: 4px; box-shadow: 0 3px 12px rgba(0,0,0,0.35); z-index: 1000;
}
#nd-search-results a {
  display: flex; justify-content: space-between; align-items: baseline;
  padding: 6px 12px; text-decoration: none; color: #212121; border-bottom: 1px solid #f0f0f0;
}
#nd-search-results a:last-child { border-bottom: none; }
#nd-search-results a:hover, #nd-search-results a.nd-active { background: #e3f2fd; }
#nd-search-results .nd-kind { color: #757575; font-size: 0.85rem; margin-left: 12px; white-space: nowrap; }
#nd-search-results .nd-empty { padding: 6px 12px; color: #757575; }
@media print { #nd-search { display: none; } }
</style>
<script type="text/javascript" src="search-data.js"></script>
<script type="text/javascript" src="neddoc-search.js"></script>
`;

/** The header search box, injected right after the MDL layout spacer. */
const SEARCH_BOX = `        <div id="nd-search">
          <i class="material-icons">search</i>
          <input type="search" id="nd-search-input" placeholder="Search types…" autocomplete="off" aria-label="Search types" />
          <div id="nd-search-results" hidden></div>
        </div>`;

/** neddoc-search.js: substring type search with the same ranking as the modern
 *  HtmlRenderer (exact > prefix > name-substring > fq-substring), plus keyboard
 *  navigation. Reads the NEDDOC_SEARCH global from search-data.js. */
const NEDDOC_SEARCH_JS = `// neddoc material template — client-side type search (vanilla JS)
(function () {
  'use strict';
  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }
  ready(function () {
    var input = document.getElementById('nd-search-input');
    var results = document.getElementById('nd-search-results');
    var data = window.NEDDOC_SEARCH;
    if (!input || !results || !data) return;
    var active = -1;
    function items() { return results.querySelectorAll('a'); }
    function setActive(i) {
      var list = items();
      active = i;
      for (var j = 0; j < list.length; j++) list[j].className = j === i ? 'nd-active' : '';
      if (list[i]) list[i].scrollIntoView({ block: 'nearest' });
    }
    function close() { results.hidden = true; results.innerHTML = ''; active = -1; }
    function search() {
      var q = input.value.trim().toLowerCase();
      if (!q) { close(); return; }
      var hits = [];
      for (var i = 0; i < data.length; i++) {
        var e = data[i];
        var name = e.n.toLowerCase(), fq = e.f.toLowerCase();
        var idx = name.indexOf(q);
        if (idx >= 0 || fq.indexOf(q) >= 0)
          hits.push({ e: e, rank: name === q ? 0 : idx === 0 ? 1 : idx > 0 ? 2 : 3 });
      }
      hits.sort(function (a, b) { return a.rank - b.rank || a.e.n.localeCompare(b.e.n); });
      results.innerHTML = '';
      active = -1;
      var n = Math.min(hits.length, 50);
      for (var k = 0; k < n; k++) {
        var e2 = hits[k].e;
        var a = document.createElement('a');
        a.href = e2.p;
        a.title = e2.f;
        var nm = document.createElement('span');
        nm.className = 'nd-name';
        nm.textContent = e2.n;
        var kd = document.createElement('span');
        kd.className = 'nd-kind';
        kd.textContent = e2.k;
        a.appendChild(nm);
        a.appendChild(kd);
        results.appendChild(a);
      }
      if (!n) {
        var empty = document.createElement('div');
        empty.className = 'nd-empty';
        empty.textContent = 'No matching types';
        results.appendChild(empty);
      }
      results.hidden = false;
    }
    input.addEventListener('input', search);
    input.addEventListener('focus', function () { if (input.value.trim()) search(); });
    input.addEventListener('keydown', function (ev) {
      var list = items();
      if (ev.key === 'ArrowDown') { ev.preventDefault(); if (list.length) setActive((active + 1) % list.length); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); if (list.length) setActive((active - 1 + list.length) % list.length); }
      else if (ev.key === 'Enter') { if (active >= 0 && list[active]) { ev.preventDefault(); window.location.href = list[active].href; } }
      else if (ev.key === 'Escape') { close(); input.blur(); }
    });
    document.addEventListener('click', function (ev) {
      if (ev.target !== input && !results.contains(ev.target)) close();
    });
  });
})();
`;

/** Material layout keeps images at the output root (Eclipse naming). */
export function materialImageName(image: string): string {
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
