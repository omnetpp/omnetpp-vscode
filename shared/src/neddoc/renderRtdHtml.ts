/**
 * "Read the Docs" HTML theme: the same self-contained static site as the modern
 * HtmlRenderer (identical page content, nav-tree data, client-side search and
 * neddoc.js logic), restyled to look like the popular Sphinx `sphinx_rtd_theme`
 * — a dark left sidebar with a blue search header, a slab-serif heading font,
 * and the familiar RTD content typography. Only the page chrome (`pageShell`)
 * and the stylesheet (`styleCss`) differ from the base renderer; everything
 * else is inherited, so the two themes stay in lockstep.
 *
 * No external assets or web fonts (RTD's Lato / Roboto Slab are named first in
 * the font stacks but fall back to system serif/sans, so file:// works offline).
 */

import { HtmlRenderer } from './renderHtml';

export class RtdHtmlRenderer extends HtmlRenderer {
  readonly format = 'html-readthedocs' as const;

  protected override pageShell(p: {
    root: string;
    pageId: string;
    title: string;
    projectTitle: string;
    body: string;
  }): string {
    const { root, pageId, title, projectTitle, body } = p;
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
        <input id="search" type="search" placeholder="Search types..." autocomplete="off">
        <div id="search-results" hidden></div>
      </div>
      <div class="wy-menu wy-menu-vertical"><div id="navtree"></div></div>
    </div>
  </nav>
  <section class="wy-nav-content-wrap">
    <nav class="wy-nav-top"><a href="${root}index.html">${projectTitle}</a></nav>
    <div class="wy-nav-content">
      <div class="rst-content"><div role="main">
<h1>${title}</h1>
${body}
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
}

const RTD_STYLE_CSS = `/* neddoc — "Read the Docs" theme (sphinx_rtd_theme look, self-contained) */
* { box-sizing: border-box; }
html { font-size: 16px; }
body {
  margin: 0;
  font-family: "Lato", "Helvetica Neue", Arial, sans-serif;
  font-size: 16px; line-height: 1.6; color: #404040; background: #fcfcfc;
}
h1, h2, h3, h4, h5, h6, .rst-content .toctree-wrapper > p.caption {
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
  position: fixed; top: 0; left: 0; bottom: 0; width: 300px; z-index: 200;
  background: #343131; overflow: hidden;
}
.wy-side-scroll { width: 320px; height: 100%; overflow-x: hidden; overflow-y: auto; }
.wy-nav-content-wrap { margin-left: 300px; background: #fcfcfc; min-height: 100%; }
.wy-nav-content { max-width: 900px; margin: 0 auto; padding: 1.6em 3.2em; background: #fff; min-height: 100vh; }
.wy-nav-top { display: none; }

/* search header ----------------------------------------------------------- */
.wy-side-nav-search {
  background: #2980b9; padding: 12px 16px 16px; text-align: center; position: relative;
}
.wy-side-nav-search .home {
  display: block; color: #fff; font-weight: 700; font-size: 1.15rem; margin-bottom: 10px; padding: 4px 0;
}
.wy-side-nav-search .home:hover { text-decoration: none; opacity: .9; }
#search {
  width: 100%; padding: 7px 10px; border: 0; border-radius: 50px; font-size: .9rem; color: #333;
}
#search:focus { outline: none; }
#search-results {
  text-align: left; background: #fff; border-radius: 4px; margin-top: 8px; overflow: auto;
  max-height: 50vh; box-shadow: 0 2px 6px rgba(0,0,0,.3);
}
#search-results a { display: block; padding: 6px 10px; color: #404040; border-bottom: 1px solid #f0f0f0; }
#search-results a:last-child { border-bottom: 0; }
#search-results a:hover { background: #e7f2fa; text-decoration: none; }
#search-results .kind { color: #999; font-size: .8rem; margin-left: 6px; }

/* navigation menu --------------------------------------------------------- */
.wy-menu-vertical { width: 300px; padding: 8px 0 24px; }
#navtree ul { list-style: none; margin: 0; padding: 0; }
#navtree li { margin: 0; }
#navtree a {
  display: block; color: #d9d9d9; padding: 6px 24px; font-size: .9rem; line-height: 1.3; border: none;
}
#navtree a:hover { background: #4e4a4a; color: #d9d9d9; text-decoration: none; cursor: pointer; }
#navtree a.current { background: #fcfcfc; color: #404040; font-weight: 700; border-left: 3px solid #2980b9; }
#navtree ul ul a { padding-left: 40px; }
#navtree ul ul ul a { padding-left: 56px; }
#navtree details > summary {
  display: block; list-style: none; cursor: pointer; color: #55a5d9; text-transform: uppercase;
  font-size: .8rem; font-weight: 700; letter-spacing: .05em; padding: 10px 24px 6px; margin-top: 4px;
}
#navtree details > summary::-webkit-details-marker { display: none; }
#navtree details > summary::before { content: "\\25B8 "; color: #4e4a4a; }
#navtree details[open] > summary::before { content: "\\25BE "; }
#navtree details > summary a { display: inline; padding: 0; color: inherit; }
#navtree details details > summary { text-transform: none; color: #b3b3b3; font-weight: 400; letter-spacing: 0; }

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
    display: flex; align-items: center; background: #2980b9; color: #fff; padding: 10px 16px;
  }
  .wy-nav-top a { color: #fff; font-weight: 700; }
  .wy-nav-content { padding: 1.2em 1.4em; }
}
`;
