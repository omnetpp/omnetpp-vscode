/**
 * Modern static-site HTML renderer of the NED documentation generator: the
 * same page content and tables as the Eclipse neddoc output, but with a
 * clean, self-contained template — fixed sidebar with a collapsible nav tree
 * and client-side type search, vanilla JS/CSS, no external assets or CDN.
 *
 * Nav/search data are emitted as .js files defining globals (not fetched
 * JSON) so the documentation also works from file:// URLs.
 */

import { emitHtml, escapeHtmlAll, escapeHtmlText, type HtmlEmitOpts } from './commentEmit';
import type { DocCell, DocModel, DocPage, DocPageRef, DocSection, NavNode } from './docModel';
import type { DocFormat } from './options';
import type { NeddocRenderer, RenderCtx, GeneratedFile } from './renderer';
import { EXTERNAL_TYPE_CSS, defaultPagePath, dirOf, externalHref, externalTypeHtml, pageById, relativeRef } from './renderer';
import { isAbsoluteUrl } from './externalDocs';
import { SOURCE_HIGHLIGHT_CSS, highlightSourceHtml } from './sourceHighlight';

export class HtmlRenderer implements NeddocRenderer {
  // widened so themed subclasses (RtdHtmlRenderer) can set their own format
  readonly format: DocFormat = 'html';
  readonly pageExtension = '.html';

  pagePath(ref: DocPageRef): string {
    return defaultPagePath(ref, this.pageExtension);
  }

  renderPage(page: DocPage, ctx: RenderCtx): string {
    const fromDir = dirOf(this.pagePath(page.ref));
    const root = fromDir ? '../'.repeat(fromDir.split('/').length) : '';
    const linkTo = (pageId: string, anchor?: string): string => {
      const target = pageById(ctx.model, pageId);
      if (target) return relativeRef(fromDir, this.pagePath(target)) + (anchor ? `#${anchor}` : '');
      const ext = ctx.model.externalTypes.get(pageId);
      return (ext && externalHref(ext, fromDir)) ?? '#';
    };
    const emitOpts = htmlEmitOpts(ctx, linkTo, fromDir);
    const body = page.sections.map((s) => this.renderSection(s, page, ctx, emitOpts, fromDir)).filter(Boolean).join('\n');
    const title = escapeHtmlAll(page.ref.title);
    const projectTitle = escapeHtmlAll(ctx.options.projectTitle ?? 'NED Documentation');
    const heading = page.ownHeading ? '' : `<h1>${title}</h1>\n`;
    return this.pageShell({ root, pageId: page.ref.id, title, projectTitle, heading, body });
  }

  /** The full HTML document around a page's rendered `body` (already-escaped
   *  `title`/`projectTitle`). The head — stylesheet + the nav/search data and
   *  logic scripts, and the `#search`/`#search-results`/`#navtree` hooks
   *  neddoc.js drives — is shared by all HTML themes; subclasses override this
   *  to change only the surrounding chrome, and `styleCss()` for the theme. */
  protected pageShell(p: { root: string; pageId: string; title: string; projectTitle: string; heading: string; body: string }): string {
    const { root, pageId, title, projectTitle, heading, body } = p;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - ${projectTitle}</title>
<link rel="stylesheet" href="${root}assets/style.css">
<script>var NEDDOC_ROOT = ${JSON.stringify(root)}; var NEDDOC_PAGE = ${JSON.stringify(pageId)};</script>
<script defer src="${root}assets/navtree-data.js"></script>
<script defer src="${root}assets/search-data.js"></script>
<script defer src="${root}assets/neddoc.js"></script>
</head>
<body>
<header id="header"><a class="home" href="${root}index.html">${projectTitle}</a></header>
<nav id="sidebar">
  <input id="search" type="search" placeholder="Search types..." autocomplete="off">
  <div id="search-results" hidden></div>
  <div id="navtree"></div>
</nav>
<main id="content">
${heading}${body}
</main>
</body>
</html>
`;
  }

  /** The theme stylesheet (subclasses override; `options.customCss` still wins). */
  protected styleCss(): string {
    return STYLE_CSS;
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
            return `<a href="${escapeHtmlAll(linkTo(cell.page, cell.anchor))}"${tooltip}>${escapeHtmlText(cell.text)}</a>`;
          }
          case 'exlink':
            return `<a href="${escapeHtmlAll(cell.href)}" target="_blank">${escapeHtmlText(cell.text)}</a>`;
          case 'doc':
            return emitHtml(cell.blocks, emitOpts);
        }
      })
      .join('');
  }

  private renderSection(
    section: DocSection,
    page: DocPage,
    ctx: RenderCtx,
    emitOpts: LinkingEmitOpts,
    fromDir: string,
  ): string {
    switch (section.kind) {
      case 'badge':
        return `<div class="badge badge-${section.typeKind}">${escapeHtmlText(section.label)}</div>`;
      case 'para':
        return `<p class="meta">${this.renderCells(section.cells, emitOpts)}</p>`;
      case 'doc':
        return `<div class="description">${emitHtml(section.blocks, emitOpts)}</div>`;
      case 'subheading':
        return `<h2${section.anchor ? ` id="${escapeHtmlAll(section.anchor)}"` : ''}>${escapeHtmlText(section.text)}</h2>`;
      case 'table': {
        const head = section.columns.map((c) => `<th>${escapeHtmlText(c)}</th>`).join('');
        const rows = section.rows
          .map((row) => {
            const cls = row.cssClass ? ` class="${row.cssClass}"` : '';
            const id = row.anchor ? ` id="${escapeHtmlAll(row.anchor)}"` : '';
            const cells = row.cells.map((c) => `<td>${this.renderCells(c, emitOpts)}</td>`).join('');
            return `<tr${cls}${id}>${cells}</tr>`;
          })
          .join('\n');
        return `<table class="${escapeHtmlAll(section.cssClass)}">\n<thead><tr>${head}</tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>`;
      }
      case 'diagram': {
        if (!ctx.hasImage(section.image)) return '';
        // inline the SVG so submodule hyperlinks and tooltips stay live
        const svg = ctx.imageContent(section.image);
        if (svg) return `<div class="diagram">${rebaseSvgLinks(svg, fromDir, section.image)}</div>`;
        return `<div class="diagram"><img src="${escapeHtmlAll(relativeRef(fromDir, section.image))}" alt="${escapeHtmlAll(section.title)}"></div>`;
      }
      case 'source':
        return `<pre class="src src-${section.language}">${highlightSourceHtml(section.code, section.language, 'class')}</pre>`;
    }
  }

  auxFiles(ctx: RenderCtx): GeneratedFile[] {
    return [
      { relativePath: 'assets/style.css', content: ctx.options.customCss ?? this.styleCss() + EXTERNAL_TYPE_CSS + SOURCE_HIGHLIGHT_CSS },
      { relativePath: 'assets/neddoc.js', content: NEDDOC_JS },
      {
        relativePath: 'assets/navtree-data.js',
        content: `window.NEDDOC_NAV = ${JSON.stringify(navNodeToData(ctx.model.navRoot, this, ctx.model))};\n`,
      },
      {
        relativePath: 'assets/search-data.js',
        content:
          `window.NEDDOC_SEARCH = ${JSON.stringify(
            ctx.model.searchIndex.map((e) => ({
              n: e.name,
              f: e.fqName,
              k: e.kindLabel,
              p: pageHref(this, ctx.model, e.page),
            })),
          )};\n`,
      },
    ];
  }
}

function pageHref(renderer: HtmlRenderer, model: DocModel, pageId: string, anchor?: string): string {
  const ref = pageById(model, pageId);
  const path = ref ? renderer.pagePath(ref) : `${pageId}${renderer.pageExtension}`;
  return path + (anchor ? `#${anchor}` : '');
}

interface NavData {
  t: string;
  h?: string; // root-relative href
  u?: string; // absolute URL
  p?: string; // page id (for current-page highlighting)
  c?: NavData[];
}

function navNodeToData(node: NavNode, renderer: HtmlRenderer, model: DocModel): NavData {
  const data: NavData = { t: node.title };
  if (node.page) {
    data.h = pageHref(renderer, model, node.page, node.anchor);
    data.p = node.anchor ? undefined : node.page;
  } else if (node.href) {
    if (isAbsoluteUrl(node.href)) data.u = node.href;
    else data.h = node.href;
  }
  if (node.children.length) data.c = node.children.map((c) => navNodeToData(c, renderer, model));
  return data;
}

/** Inlined SVGs carry hrefs relative to their images/ directory; rebase them
 *  for the page's own directory. */
function rebaseSvgLinks(svg: string, fromDir: string, imagePath: string): string {
  const imageDir = dirOf(imagePath);
  return svg.replace(/href="([^"]+)"/g, (m, href: string) => {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:|^#|^\//.test(href)) return m; // absolute/anchor
    // resolve href against the image dir, then re-relativize to the page dir
    const parts = (imageDir ? imageDir.split('/') : []).concat(href.split('/'));
    const resolved: string[] = [];
    for (const part of parts) {
      // a `..` above the output root survives (dependency docs next to ours)
      if (part === '..' && resolved.length > 0 && resolved[resolved.length - 1] !== '..') resolved.pop();
      else if (part !== '.') resolved.push(part);
    }
    return `href="${relativeRef(fromDir, resolved.join('/'))}"`;
  });
}

// ---------------------------------------------------------------------------
// Embedded assets
// ---------------------------------------------------------------------------

const STYLE_CSS = `/* neddoc — generated documentation stylesheet */
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 15px/1.55 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: #1f2328;
  background: #fff;
}
#header {
  position: fixed; top: 0; left: 0; right: 0; height: 44px; z-index: 10;
  background: #24292f; color: #fff; display: flex; align-items: center; padding: 0 16px;
}
#header .home { color: #fff; text-decoration: none; font-weight: 600; }
#sidebar {
  position: fixed; top: 44px; bottom: 0; left: 0; width: 300px;
  overflow: auto; padding: 10px 8px 24px; border-right: 1px solid #d0d7de; background: #f6f8fa;
}
#content { margin: 44px 0 0 300px; padding: 20px 32px 64px; max-width: 1100px; }
#search { width: 100%; padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 6px; margin-bottom: 6px; }
#search-results { background: #fff; border: 1px solid #d0d7de; border-radius: 6px; margin-bottom: 8px; max-height: 50vh; overflow: auto; }
#search-results a { display: block; padding: 4px 8px; text-decoration: none; color: inherit; }
#search-results a:hover { background: #ddf4ff; }
#search-results .kind { color: #57606a; font-size: 12px; margin-left: 6px; }
#navtree ul { list-style: none; margin: 0; padding-left: 16px; }
#navtree > ul { padding-left: 4px; }
#navtree li { margin: 1px 0; }
#navtree a { text-decoration: none; color: #0969da; }
#navtree a:hover { text-decoration: underline; }
#navtree a.current { font-weight: 600; color: #1f2328; }
#navtree details > summary { cursor: pointer; user-select: none; font-weight: 600; color: #1f2328; }
h1 { font-size: 26px; border-bottom: 1px solid #d8dee4; padding-bottom: 6px; }
h2 { font-size: 19px; margin-top: 28px; border-bottom: 1px solid #eaeef2; padding-bottom: 4px; }
a { color: #0969da; }
p.meta { color: #57606a; margin: 6px 0; }
.badge {
  display: inline-block; padding: 3px 10px; border-radius: 6px; font-weight: 600;
  border: 1px solid #d0d7de; background: #eaeef2; margin: 4px 0 12px;
}
.badge-simple { background: #eaeef2; }
.badge-compound, .badge-network { background: #fff8c5; border-color: #d4a72c; }
.badge-network { background: #ddf4ff; border-color: #54aeff; }
.badge-channel { background: #dafbe1; border-color: #4ac26b; }
.badge-moduleinterface, .badge-channelinterface { background: #fff; border-style: dashed; }
.badge-message, .badge-packet { background: #fff8c5; border-color: #d4a72c; }
.badge-class, .badge-struct { background: #eaeef2; }
.badge-enum { background: #dafbe1; border-color: #4ac26b; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; font-size: 14px; }
th, td { border: 1px solid #d0d7de; padding: 5px 9px; text-align: left; vertical-align: top; }
th { background: #f6f8fa; }
tr.inherited td { color: #57606a; background: #fbfcfd; }
td p { margin: 0 0 6px; }
td p:last-child { margin-bottom: 0; }
pre, tt, code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
pre.src { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 12px; overflow-x: auto; font-size: 13px; }
pre { background: #f6f8fa; border-radius: 6px; padding: 10px; overflow-x: auto; }
tt { background: #eff1f3; padding: 0 3px; border-radius: 3px; }
span.error { color: #cf222e; font-weight: 600; }
.diagram { margin: 10px 0 18px; overflow-x: auto; }
.diagram svg { max-width: 100%; height: auto; }
hr { border: 0; border-top: 1px solid #d8dee4; }
@media (max-width: 900px) {
  #sidebar { display: none; }
  #content { margin-left: 0; }
}
`;

const NEDDOC_JS = `// neddoc — sidebar nav tree + client-side type search (vanilla JS)
(function () {
  'use strict';
  function el(tag, attrs, parent) {
    var e = document.createElement(tag);
    for (var k in attrs) {
      if (k === 'text') e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(e);
    return e;
  }
  function buildTree(node, parent, depth) {
    var li = el('li', {}, parent);
    var hasChildren = node.c && node.c.length;
    var container = li;
    if (hasChildren) {
      var details = el('details', depth < 1 ? { open: '' } : {}, li);
      var summary = el('summary', {}, details);
      if (node.h || node.u) {
        var a = el('a', { href: node.u || NEDDOC_ROOT + node.h, text: node.t }, summary);
        if (node.p === NEDDOC_PAGE) a.className = 'current';
      } else summary.textContent = node.t;
      container = el('ul', {}, details);
    } else if (node.h || node.u) {
      var link = el('a', { href: node.u || NEDDOC_ROOT + node.h, text: node.t }, li);
      if (node.p === NEDDOC_PAGE) {
        link.className = 'current';
        var d = li.parentElement && li.parentElement.closest('details');
        while (d) { d.open = true; d = d.parentElement && d.parentElement.closest('details'); }
      }
    } else {
      li.textContent = node.t;
    }
    if (hasChildren) for (var i = 0; i < node.c.length; i++) buildTree(node.c[i], container, depth + 1);
  }
  function initTree() {
    var root = document.getElementById('navtree');
    if (!root || !window.NEDDOC_NAV) return;
    var ul = el('ul', {}, root);
    var top = window.NEDDOC_NAV.c || [];
    for (var i = 0; i < top.length; i++) buildTree(top[i], ul, 0);
    var current = root.querySelector('a.current');
    if (current) current.scrollIntoView({ block: 'center' });
  }
  function initSearch() {
    var input = document.getElementById('search');
    var results = document.getElementById('search-results');
    if (!input || !results || !window.NEDDOC_SEARCH) return;
    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase();
      results.innerHTML = '';
      if (!q) { results.hidden = true; return; }
      var hits = [];
      for (var i = 0; i < NEDDOC_SEARCH.length && hits.length < 50; i++) {
        var e = NEDDOC_SEARCH[i];
        var name = e.n.toLowerCase(), fq = e.f.toLowerCase();
        if (name.indexOf(q) >= 0 || fq.indexOf(q) >= 0)
          hits.push({ e: e, rank: name === q ? 0 : name.indexOf(q) === 0 ? 1 : name.indexOf(q) >= 0 ? 2 : 3 });
      }
      hits.sort(function (a, b) { return a.rank - b.rank || a.e.n.localeCompare(b.e.n); });
      for (var j = 0; j < hits.length; j++) {
        var hit = hits[j].e;
        var a = el('a', { href: NEDDOC_ROOT + hit.p, title: hit.f }, results);
        a.textContent = hit.n;
        el('span', { class: 'kind', text: hit.k }, a);
      }
      results.hidden = hits.length === 0;
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { initTree(); initSearch(); });
  else { initTree(); initSearch(); }
})();
`;

/** Comment-emitter options plus the page's link resolution, shared by the
 *  HTML renderers: dependency types render as `externaltype` references. */
export interface LinkingEmitOpts extends HtmlEmitOpts {
  linkTo: (pageId: string, anchor?: string) => string;
  externalTypeRef: (pageId: string, text: string, tooltip?: string) => string | undefined;
}

export function htmlEmitOpts(
  ctx: RenderCtx,
  linkTo: (pageId: string, anchor?: string) => string,
  fromDir: string,
): LinkingEmitOpts {
  const externalTypeRef = (pageId: string, text: string, tooltip?: string): string | undefined => {
    const ext = ctx.model.externalTypes.get(pageId);
    return ext ? externalTypeHtml(ext, text, fromDir, tooltip) : undefined;
  };
  return {
    linkTo,
    externalTypeRef,
    hrefFor: (target) => {
      const href = linkTo(target);
      return href === '#' ? undefined : href;
    },
    typeRef: (target, text) => externalTypeRef(target, text),
  };
}
