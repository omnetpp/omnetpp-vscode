// Inline diagnostic-suppression directives.
//
// Users silence diagnostics in-source, eslint-disable-style, using OMNeT++ idioms:
//   - NED & MSG: a *private* comment `//# suppress(...)` (private comments are
//     excluded from generated docs, so directives don't pollute them).
//   - INI: a comment starting with `### suppress(...)`.
//
// A directive sits on the line immediately *before* its target, or as a *trailing*
// comment on the target line. `suppress()` silences every diagnostic on the target;
// `suppress(code)` only that code; `suppress(a, b)` several.
//
// This module is host-agnostic (no vscode/Node). It works off raw text plus, for
// NED/MSG, the tree-sitter tree — using `comment` nodes (not a text scan) so that a
// `suppress(...)` inside a string literal or a MSG `cplusplus {{ }}` block can never
// take effect. INI has no tree; its directives are found with the same string-aware
// `#`-detection the parser uses (`stripComment`), so `#` inside quotes is ignored.

import type { Tree } from 'web-tree-sitter';
import type { Diagnostic } from '../model/location';
import { walk } from '../parser/treeUtils';
import { stripComment } from '../ini/iniDocument';

export type SuppressLanguage = 'ned' | 'msg' | 'ini';

/** Suppressions resolved to a single 0-based target line. */
export interface SuppressionEntry {
  /** `suppress()` with no code — silences every diagnostic on the line. */
  all: boolean;
  /** Specific diagnostic codes to silence. */
  codes: Set<string>;
}

/** 0-based target line → what to suppress there. */
export type SuppressionIndex = Map<number, SuppressionEntry>;

export interface SuppressInput {
  language: SuppressLanguage;
  text: string;
  /** Required for ned/msg (directives are read from `comment` nodes). */
  tree?: Tree;
}

/** Matches every `suppress(...)` occurrence; group 1 is the (possibly empty) code list. */
const DIRECTIVE_RE = /suppress\s*\(\s*([^)]*)\)/g;

/** The directive comment to insert for a Quick Fix. */
export function formatSuppressDirective(language: SuppressLanguage, code?: string): string {
  const marker = language === 'ini' ? '###' : '//#';
  return `${marker} suppress(${code ?? ''})`;
}

interface ParsedDirective {
  found: boolean;
  all: boolean;
  codes: string[];
}

/** Extract all `suppress(...)` directives from a single comment's text. */
function parseDirective(commentBody: string): ParsedDirective {
  DIRECTIVE_RE.lastIndex = 0;
  let found = false;
  let all = false;
  const codes: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = DIRECTIVE_RE.exec(commentBody)) !== null) {
    found = true;
    const inner = m[1].trim();
    if (inner === '') all = true;
    else for (const c of inner.split(/[\s,]+/).filter(Boolean)) codes.push(c);
  }
  return { found, all, codes };
}

/** Union new directives into the per-line entry (never overwrite — directives stack). */
function mergeInto(index: SuppressionIndex, line: number, all: boolean, codes: string[]): void {
  let e = index.get(line);
  if (!e) {
    e = { all: false, codes: new Set() };
    index.set(line, e);
  }
  if (all) e.all = true;
  for (const c of codes) e.codes.add(c);
}

/** A line a leading directive skips over to reach its real target (blank/comment-only). */
function isSkippableLine(line: string, language: SuppressLanguage): boolean {
  if (language === 'ini') return stripComment(line).trim() === ''; // blank or comment-only
  const t = line.trimStart();
  return t === '' || t.startsWith('//');
}

/** Nearest following line that actually carries code (skips blanks and banner comments). */
function resolveLeadingTarget(lines: string[], fromRow: number, language: SuppressLanguage): number {
  for (let r = fromRow + 1; r < lines.length; r++) {
    if (!isSkippableLine(lines[r], language)) return r;
  }
  return fromRow + 1; // past EOF — harmless, nothing is anchored there
}

/** Collect directives from NED/MSG `//#` private comments via the tree. */
function collectTreeDirectives(index: SuppressionIndex, input: SuppressInput, lines: string[]): void {
  if (!input.tree) return;
  for (const node of walk(input.tree.rootNode)) {
    if (node.type !== 'comment') continue;
    // A NED comment may span lines (trailing `\`); a MSG `comment` node groups
    // consecutive `//` lines. Treat each physical line on its own.
    const startRow = node.startPosition.row;
    const fragments = node.text.split(/\r?\n/);
    for (let i = 0; i < fragments.length; i++) {
      const row = startRow + i;
      const body = fragments[i].replace(/\r$/, '').trimStart();
      if (!body.startsWith('//#')) continue; // private comments only
      const dir = parseDirective(body);
      if (!dir.found) continue;
      // line 0 starts at the node's column; a grouped/continuation line is whole-line
      const trailing =
        i === 0 && (lines[row]?.slice(0, node.startPosition.column) ?? '').trim() !== '';
      const target = trailing ? row : resolveLeadingTarget(lines, row, input.language);
      mergeInto(index, target, dir.all, dir.codes);
    }
  }
}

/** Collect directives from INI `###` comments via a string-aware line scan. */
function collectIniDirectives(index: SuppressionIndex, lines: string[]): void {
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    const head = stripComment(line); // text before the first *unquoted* `#`
    if (head.length >= line.length) continue; // no unquoted `#` on this line
    const comment = line.slice(head.length); // begins at the `#`
    if (!comment.startsWith('###')) continue; // only `###` are directives
    const dir = parseDirective(comment);
    if (!dir.found) continue;
    const trailing = head.trim() !== '';
    const target = trailing ? row : resolveLeadingTarget(lines, row, 'ini');
    mergeInto(index, target, dir.all, dir.codes);
  }
}

/** Build the line-keyed suppression index for a document. */
export function buildSuppressionIndex(input: SuppressInput): SuppressionIndex {
  const index: SuppressionIndex = new Map();
  const lines = input.text.split(/\r?\n/);
  if (input.language === 'ini') collectIniDirectives(index, lines);
  else collectTreeDirectives(index, input, lines);
  return index;
}

/** Drop diagnostics whose start line is suppressed (all, or by matching code). */
export function applySuppressions(diags: Diagnostic[], index: SuppressionIndex): Diagnostic[] {
  if (index.size === 0) return diags;
  return diags.filter((d) => {
    const e = index.get(d.range.start.line);
    if (!e) return true;
    if (e.all) return false;
    return !(d.code !== undefined && e.codes.has(d.code));
  });
}

/**
 * Filter suppressed diagnostics for a document. The one-shot entry point used by
 * both diagnostic call sites; cheap when the file has no directives.
 */
export function filterSuppressedDiagnostics(diags: Diagnostic[], input: SuppressInput): Diagnostic[] {
  if (diags.length === 0) return diags;
  if (!input.text.includes('suppress')) return diags; // fast path: no directive possible
  return applySuppressions(diags, buildSuppressionIndex(input));
}
