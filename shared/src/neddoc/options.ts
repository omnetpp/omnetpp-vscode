/**
 * Options for the NED documentation generator. Mirrors the Eclipse IDE's
 * GeneratorConfiguration booleans (same defaults), plus the output-format
 * switch that is new in this implementation.
 */

import type { IncludeResolution } from './commentAst';

export type DocFormat = 'html' | 'legacy-html' | 'markdown' | 'rst';

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
  /** Generate per-file pages with full source listings (not yet implemented). */
  sourceFiles: boolean;
  /** true: link every known type name in comments; false: only ~tilde refs. */
  automaticHyperlinks: boolean;
  /** Document the built-in NED declarations (ned.DelayChannel etc.). */
  includeBuiltins: boolean;
  /** Glob-ish dir patterns excluded from documentation (Eclipse -x). */
  excludePatterns: string[];
  /** Doxygen link-out: a pre-read doxytags.xml + URL prefix for C++ links. */
  doxytags?: { xml: string; urlPrefix: string };
  /** Resolves `@include <file>` directives in comments (host provides I/O). */
  includeResolver?: (fileRef: string, fromId: string | undefined) => IncludeResolution | undefined;
  /** Title shown on the overview page and in the navigation header. */
  projectTitle?: string;
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
    sourceFiles: true,
    automaticHyperlinks: true,
    includeBuiltins: false,
    excludePatterns: [],
  };
}
