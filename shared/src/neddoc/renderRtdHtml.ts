/**
 * "Read the Docs" HTML theme: the same self-contained static site as the modern
 * HtmlRenderer (identical page content, nav-tree data and client-side search
 * data), reskinned to follow Sphinx's `sphinx_rtd_theme` closely — the real
 * `.wy-nav-side` / `.wy-side-nav-search` chrome, and a navigation tree that
 * uses the theme's own markup (`p.caption` section headers, `toctree-l1/2/3…`
 * list items, the `.current` chain, `toctree-expand` toggles) and the verbatim
 * RTD spacing/colours ported from theme.css.
 *
 * To get that exact markup we override the shared `neddoc.js` with an
 * RTD-specific navigation builder (RTD_NEDDOC_JS); the nav-tree data and search
 * data files are inherited unchanged. Page paths, section markup and the search
 * data are all inherited from HtmlRenderer, so the themes stay in lockstep.
 *
 * No external assets or web fonts (RTD's Lato / Roboto Slab are named first in
 * the font stacks but fall back to system serif/sans, so file:// works offline;
 * the FontAwesome expand glyphs are replaced with Unicode triangles).
 */

import type { GeneratedFile, RenderCtx } from './renderer';
import { HtmlRenderer } from './renderHtml';

export class RtdHtmlRenderer extends HtmlRenderer {
  readonly format = 'html-readthedocs' as const;

  protected override pageShell(p: {
    root: string;
    pageId: string;
    title: string;
    projectTitle: string;
    heading: string;
    body: string;
  }): string {
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
<body class="wy-body-for-nav">
<div class="wy-grid-for-nav">
  <nav class="wy-nav-side">
    <div class="wy-side-scroll">
      <div class="wy-side-nav-search">
        <a href="${root}index.html" class="home">${projectTitle}</a>
        <div class="wy-search"><input id="search" type="text" placeholder="Search types..." autocomplete="off"><div id="search-results" hidden></div></div>
      </div>
      <div class="wy-menu wy-menu-vertical" role="navigation" aria-label="Navigation menu"><div id="navtree"></div></div>
    </div>
  </nav>
  <section class="wy-nav-content-wrap">
    <nav class="wy-nav-top"><a href="${root}index.html">${projectTitle}</a></nav>
    <div class="wy-nav-content">
      <div class="rst-content"><div role="main">
${heading}${body}
      </div></div>
    </div>
  </section>
</div>
</body>
</html>
`;
  }

  protected override styleCss(): string {
    return RTD_STYLE_CSS;
  }

  /** Swap the shared neddoc.js for the RTD navigation builder; keep the
   *  inherited navtree-data.js / search-data.js / style.css entries. */
  override auxFiles(ctx: RenderCtx): GeneratedFile[] {
    return super.auxFiles(ctx).map((f) =>
      f.relativePath === 'assets/neddoc.js' ? { ...f, content: RTD_NEDDOC_JS } : f,
    );
  }
}

// ---------------------------------------------------------------------------
// Navigation builder — produces sphinx_rtd_theme toctree markup + behaviour
// ---------------------------------------------------------------------------

const RTD_NEDDOC_JS = `// neddoc — Read the Docs navigation tree + client-side search (vanilla JS)
(function () {
  'use strict';
  function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }
  // Render one nav node as an RTD <li class="toctree-lN">; returns true when
  // the node (or a descendant) is the current page, so ancestors get .current.
  function renderNode(node, ul, level) {
    var li = el('li', 'toctree-l' + level, ul);
    var a = el('a', 'reference internal', li);
    a.href = node.h ? NEDDOC_ROOT + node.h : '#';
    var hasChildren = node.c && node.c.length;
    if (hasChildren) {
      var btn = el('button', 'toctree-expand', a);
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Toggle navigation of this section');
    }
    a.appendChild(document.createTextNode(node.t));
    var current = node.p && node.p === NEDDOC_PAGE;
    if (hasChildren) {
      var childUl = el('ul', null, li);
      for (var i = 0; i < node.c.length; i++)
        if (renderNode(node.c[i], childUl, level + 1)) current = true;
    }
    if (node.p && node.p === NEDDOC_PAGE) a.className += ' current';
    if (current) li.className += ' current';
    return current;
  }
  function buildNav() {
    var root = document.getElementById('navtree');
    var nav = window.NEDDOC_NAV;
    if (!root || !nav || !nav.c) return;
    var lead = null; // leading captionless <ul> for top-level page links
    for (var i = 0; i < nav.c.length; i++) {
      var top = nav.c[i];
      var hasChildren = top.c && top.c.length;
      if (top.h || !hasChildren) {
        if (!lead) lead = el('ul', null, root);
        renderNode(top, lead, 1);
      } else {
        lead = null;
        var cap = el('p', 'caption', root);
        cap.setAttribute('role', 'heading');
        var span = el('span', 'caption-text', cap);
        span.textContent = top.t;
        var ul = el('ul', null, root);
        for (var j = 0; j < top.c.length; j++) renderNode(top.c[j], ul, 1);
      }
    }
    // expand/collapse via the toctree-expand toggles (RTD toggleCurrent)
    root.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('button.toctree-expand') : null;
      if (!btn) return;
      ev.preventDefault();
      var li = btn.closest('li');
      if (!li) return;
      var sibs = li.parentNode.children;
      for (var k = 0; k < sibs.length; k++)
        if (sibs[k] !== li && sibs[k].tagName === 'LI') sibs[k].classList.remove('current');
      li.classList.toggle('current');
    });
    var cur = root.querySelector('a.current');
    if (cur) cur.scrollIntoView({ block: 'center' });
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
        var a = el('a', null, results);
        a.href = NEDDOC_ROOT + hit.p;
        a.title = hit.f;
        a.textContent = hit.n;
        el('span', 'kind', a).textContent = hit.k;
      }
      results.hidden = hits.length === 0;
    });
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', function () { buildNav(); initSearch(); });
  else { buildNav(); initSearch(); }
})();
`;

// ---------------------------------------------------------------------------
// Stylesheet — sphinx_rtd_theme look, nav rules ported verbatim from theme.css
// ---------------------------------------------------------------------------

const RTD_STYLE_CSS = `/* neddoc — "Read the Docs" theme (sphinx_rtd_theme look, self-contained) */
* { box-sizing: border-box; }
html { font-size: 16px; }
body {
  margin: 0;
  font-family: "Lato", "Helvetica Neue", Arial, sans-serif;
  font-size: 16px; line-height: 1.6; color: #404040; background: #fcfcfc;
}
h1, h2, h3, h4, h5, h6 {
  font-family: "Roboto Slab", "ff-tisa-web-pro", Georgia, Arial, sans-serif;
  font-weight: 700; color: #404040; margin: 24px 0 16px;
}
h1 { font-size: 1.75rem; border-bottom: 1px solid #e1e4e5; padding-bottom: .4em; margin-top: 0; }
h2 { font-size: 1.4rem; }
h3 { font-size: 1.2rem; }
a { color: #2980b9; text-decoration: none; }
a:hover { color: #3091d1; text-decoration: underline; }

/* layout ------------------------------------------------------------------ */
.wy-grid-for-nav { position: relative; }
.wy-nav-side {
  position: fixed; top: 0; bottom: 0; left: 0; width: 300px; z-index: 200;
  padding-bottom: 2em; overflow-x: hidden; color: #9b9b9b; background: #343131;
}
.wy-side-scroll { width: 320px; height: 100%; overflow-x: hidden; overflow-y: auto; }
.wy-nav-content-wrap { margin-left: 300px; background: #fcfcfc; min-height: 100%; }
.wy-nav-content { max-width: 800px; margin: auto; padding: 1.618em 3.236em; height: 100%; }
.wy-nav-top { display: none; }

/* search header (.wy-side-nav-search) ------------------------------------- */
.wy-side-nav-search {
  display: block; width: 300px; padding: .809em; margin-bottom: .809em; z-index: 200;
  background-color: #2980b9; text-align: center; color: #fcfcfc;
}
.wy-side-nav-search > a.home {
  color: #fcfcfc; font-size: 100%; font-weight: 700; display: inline-block;
  padding: 4px 6px; margin-bottom: .809em; max-width: 100%; border-radius: 4px;
}
.wy-side-nav-search > a.home:hover { background: rgba(255,255,255,.1); text-decoration: none; }
.wy-side-nav-search .wy-search { position: relative; }
#search {
  width: 100%; border-radius: 50px; padding: 6px 12px; border: 1px solid #2472a4;
  font-size: .9rem; color: #333; box-shadow: inset 0 1px 3px #ddd;
}
#search:focus { outline: none; }
#search-results {
  text-align: left; background: #fff; border-radius: 4px; margin-top: 8px; overflow: auto;
  max-height: 50vh; box-shadow: 0 2px 6px rgba(0,0,0,.3);
}
#search-results a { display: block; padding: 6px 10px; color: #404040; border-bottom: 1px solid #f0f0f0; }
#search-results a:last-child { border-bottom: 0; }
#search-results a:hover { background: #e7f2fa; text-decoration: none; }
#search-results .kind { color: #999; font-size: .8rem; margin-left: 6px; float: right; }

/* navigation menu (.wy-menu-vertical) — ported from sphinx_rtd_theme -------- */
.wy-menu-vertical { width: 300px; padding-bottom: 1em; }
.wy-menu-vertical ul { list-style: none; margin: 0; padding: 0; }
.wy-menu-vertical li { margin: 0; }
.wy-menu-vertical p.caption {
  color: #55a5d9; height: 32px; line-height: 32px; padding: 0 1.618em; margin: 12px 0 0;
  display: block; font-weight: 700; text-transform: uppercase; font-size: 85%; white-space: nowrap;
}
.wy-menu-vertical p.caption .caption-text { color: #55a5d9; }
.wy-menu-vertical a {
  line-height: 18px; padding: .4045em 1.618em; display: block; position: relative;
  font-size: 90%; color: #d9d9d9;
}
.wy-menu-vertical a:hover { background-color: #4e4a4a; cursor: pointer; }
.wy-menu-vertical a:hover button.toctree-expand { color: #d9d9d9; }
.wy-menu-vertical a:active { background-color: #2980b9; cursor: pointer; color: #fff; }
.wy-menu-vertical li ul { display: none; }
.wy-menu-vertical li.current ul { display: block; }
.wy-menu-vertical li ul li a { margin-bottom: 0; color: #d9d9d9; font-weight: 400; }
.wy-menu-vertical li.current { background: #e3e3e3; }
.wy-menu-vertical li.current a { color: #757575; border-right: 1px solid #c9c9c9; padding: .4045em 2.427em; }
.wy-menu-vertical li.current a:hover { background: #d6d6d6; }
.wy-menu-vertical li.current > a, .wy-menu-vertical li.on a {
  color: #404040; font-weight: 700; position: relative; background: #fcfcfc; border: none; padding: .4045em 1.618em;
}
.wy-menu-vertical li.current > a:hover, .wy-menu-vertical li.on a:hover { background: #fcfcfc; }
.wy-menu-vertical li.toctree-l1.current > a { border-top: 1px solid #c9c9c9; border-bottom: 1px solid #c9c9c9; }
.wy-menu-vertical li.toctree-l2 a, .wy-menu-vertical li.toctree-l3 a, .wy-menu-vertical li.toctree-l4 a { color: #404040; }
.wy-menu-vertical li.toctree-l3, .wy-menu-vertical li.toctree-l4 { font-size: .9em; }
.wy-menu-vertical li.toctree-l2.current > a { background: #c9c9c9; padding: .4045em 2.427em; }
.wy-menu-vertical li.toctree-l2.current li.toctree-l3 > a { background: #c9c9c9; padding: .4045em 1.618em .4045em 4.045em; }
.wy-menu-vertical li.toctree-l3.current > a { background: #bdbdbd; padding: .4045em 4.045em; }
.wy-menu-vertical li.toctree-l3.current li.toctree-l4 > a { background: #bdbdbd; padding: .4045em 1.618em .4045em 5.663em; }
.wy-menu-vertical li.toctree-l4.current > a { padding: .4045em 5.663em; }
.wy-menu-vertical .toctree-l1.current .toctree-l2 > ul, .wy-menu-vertical .toctree-l2.current .toctree-l3 > ul { display: none; }
.wy-menu-vertical .toctree-l1.current .current.toctree-l2 > ul, .wy-menu-vertical .toctree-l2.current .current.toctree-l3 > ul { display: block; }
/* expand toggles: FontAwesome glyphs replaced with offline Unicode triangles */
.wy-menu-vertical li button.toctree-expand {
  display: block; float: left; margin-left: -1.2em; line-height: 18px; font-size: .8em;
  color: #4d4d4d; border: none; background: none; padding: 0 .4em 0 0; cursor: pointer;
}
.wy-menu-vertical li button.toctree-expand:before { content: "\\25B8"; }
.wy-menu-vertical li.current > a button.toctree-expand { color: #333; }
.wy-menu-vertical li.current > a button.toctree-expand:before { content: "\\25BE"; }
.wy-menu-vertical li.toctree-l2 button.toctree-expand { color: #a3a3a3; }
.wy-menu-vertical li.toctree-l3 button.toctree-expand { color: #969696; }

/* content ----------------------------------------------------------------- */
[role="main"] { padding-bottom: 3em; }
p.meta { color: #666; margin: 6px 0; }
.description { margin: 12px 0; }
.badge {
  display: inline-block; padding: 3px 12px; border-radius: 4px; font-weight: 700; font-size: .85rem;
  border: 1px solid #d0d7de; background: #eaeef2; margin: 4px 0 14px; color: #404040;
}
.badge-compound, .badge-network, .badge-message, .badge-packet { background: #fff8c5; border-color: #d4a72c; }
.badge-network { background: #ddf4ff; border-color: #54aeff; }
.badge-channel, .badge-enum { background: #dafbe1; border-color: #4ac26b; }
.badge-moduleinterface, .badge-channelinterface { background: #fff; border-style: dashed; }

table { border-collapse: collapse; width: 100%; margin: 12px 0 20px; font-size: .9rem; }
th, td { border: 1px solid #e1e4e5; padding: 8px 12px; text-align: left; vertical-align: top; }
th { background: #e1e4e5; font-weight: 700; }
tbody tr:nth-child(2n) td { background: #f3f6f6; }
tr.inherited td { color: #666; font-style: italic; }
td p { margin: 0 0 6px; }
td p:last-child { margin-bottom: 0; }

pre, tt, code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; }
tt, code, span.pre { color: #e74c3c; background: #fff; border: 1px solid #e1e4e5; border-radius: 3px; padding: 2px 5px; font-size: .85em; }
pre, pre.src {
  background: #f8f8f8; border: 1px solid #e1e4e5; border-radius: 0; padding: 12px;
  overflow-x: auto; font-size: .8rem; line-height: 1.4; color: #404040;
}
pre tt, pre code, pre.src tt { border: 0; background: transparent; padding: 0; color: inherit; }
span.error { color: #e74c3c; font-weight: 700; }
.diagram { margin: 14px 0 22px; overflow-x: auto; }
.diagram svg { max-width: 100%; height: auto; }
hr { border: 0; border-top: 1px solid #e1e4e5; margin: 24px 0; }

/* responsive -------------------------------------------------------------- */
@media (max-width: 768px) {
  .wy-nav-side { left: -300px; }
  .wy-nav-content-wrap { margin-left: 0; }
  .wy-nav-top {
    display: flex; align-items: center; background: #2980b9; color: #fff; padding: .4045em .809em;
  }
  .wy-nav-top a { color: #fff; font-weight: 700; }
  .wy-nav-content { padding: 1.618em; }
}
`;
