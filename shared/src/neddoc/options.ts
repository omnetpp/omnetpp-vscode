/**
 * Options for the NED documentation generator. Mirrors the Eclipse IDE's
 * GeneratorConfiguration booleans (same defaults), plus the output-format
 * switch that is new in this implementation.
 */

import type { IncludeResolution } from './commentAst';
import type { ExternalDocSet } from './externalDocs';
import type { DocFragmentFile } from './fragments';

export type DocFormat = 'html' | 'html-readthedocs' | 'html-material' | 'markdown' | 'rst';

/** Formats whose pages show diagrams as SVG files loaded into an <img>
 *  (Markdown viewers, Sphinx). Browsers load no external resources into such
 *  an image, so the icons of those SVGs must be embedded as data: URIs
 *  instead of referencing the icons/ files. */
export function embedsDiagramIcons(format: DocFormat): boolean {
  return format === 'markdown' || format === 'rst';
}

export interface NeddocOptions {
  /** Output format (default 'html'). */
  format: DocFormat;
  /** Render the graphical module figure on type pages (Eclipse: network diagrams). */
  typeDiagrams: boolean;
  /** Per-type usage diagrams. */
  usageDiagrams: boolean;
  /** Per-type inheritance diagrams. */
  inheritanceDiagrams: boolean;
  /** Project-wide usage diagram page (off by default, as in Eclipse). */
  fullUsageDiagrams: boolean;
  /** Project-wide inheritance diagram page (off by default, as in Eclipse). */
  fullInheritanceDiagrams: boolean;
  /** Document MSG types too. */
  messageDefinitions: boolean;
  /** Include the type's NED/MSG source on its page. */
  sourceSnippets: boolean;
  /** A page per NED/MSG file: its types and full source (Eclipse: file listings). */
  fileListings: boolean;
  /** true: link every known type name in comments; false: only ~tilde refs. */
  automaticHyperlinks: boolean;
  /** Document the built-in NED declarations (ned.DelayChannel etc.). */
  includeBuiltins: boolean;
  /** Glob-ish dir patterns excluded from documentation (Eclipse -x). */
  excludePatterns: string[];
  /** Doxygen link-out: a pre-read doxytags.xml + URL prefix for C++ links. */
  doxytags?: { xml: string; urlPrefix: string };
  /** Separately generated documentation of dependencies: references to
   *  indexed-but-not-documented types link there (Eclipse: External
   *  documentation). */
  externalDocs?: ExternalDocSet[];
  /** Documentation fragment files (Eclipse: Doc fragments file), pre-read by
   *  the host: extra content inserted at fixed anchors of the type, package
   *  and namespace pages. */
  docFragments?: DocFragmentFile[];
  /** Resolves `@include <file>` directives in comments (host provides I/O). */
  includeResolver?: (fileRef: string, fromId: string | undefined) => IncludeResolution | undefined;
  /** Title shown on the overview page and in the navigation header. */
  projectTitle?: string;
  /** Custom stylesheet CONTENT replacing the generated style.css in the
   *  html/html-material outputs (Eclipse's custom CSS option; hosts read the
   *  file). */
  customCss?: string;
  /** The vendored Eclipse "material" template files, keyed by filename
   *  (page.tmpl, navtree.tmpl, style.css, jquery.js, ...). Required for the
   *  html-material format; the host reads them from dist/neddoc-material/. */
  materialAssets?: Record<string, string | Uint8Array>;
}

/** Compile an Eclipse-style exclusion pattern (`*`, `**`) to a RegExp tested
 *  against project-relative paths. A bare name matches at any depth. */
export function excludePatternRegex(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const esc = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/ /g, '.*');
  const anywhere = !p.includes('/') ? '(^|/)' : '^';
  return new RegExp(`${anywhere}${esc}(/|$)`);
}

/**
 * Cooperative yielding for the generator's CPU-bound loops: returns a
 * function that yields to the host event loop (macrotask) whenever
 * `intervalMs` elapsed since the last yield, and is a cheap no-op otherwise.
 * Without this, progress notifications queue up during synchronous stretches
 * (extraction, diagram layout) and only flush at the end — the host UI's
 * progress bar appears frozen. Uses the global setTimeout (available in both
 * Node and browsers; no Node import needed).
 */
export function cooperativeYielder(intervalMs = 40): () => Promise<void> {
  let last = Date.now();
  return () => {
    if (Date.now() - last < intervalMs) return Promise.resolve();
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        last = Date.now();
        resolve();
      }, 0),
    );
  };
}

export function defaultNeddocOptions(): NeddocOptions {
  return {
    format: 'html',
    typeDiagrams: true,
    usageDiagrams: true,
    inheritanceDiagrams: true,
    fullUsageDiagrams: false,
    fullInheritanceDiagrams: false,
    messageDefinitions: true,
    sourceSnippets: true,
    fileListings: true,
    automaticHyperlinks: true,
    includeBuiltins: false,
    excludePatterns: [],
  };
}
