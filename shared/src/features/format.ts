import type { Tree } from 'web-tree-sitter';
import type { TextEdit } from '../model/location';

export interface FormatOptions {
  tabSize: number;
  insertSpaces: boolean;
}

interface ScanState {
  depth: number;
  inBlockComment: boolean;
}

/** Scan a line (already past leading whitespace handling) updating brace depth. */
function scanLine(line: string, state: ScanState): { leadingClosers: number } {
  let leadingClosers = 0;
  let countingLeading = true;
  let quote = ''; // '"' or "'" while inside a string/char literal, else ''
  let inLineComment = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (state.inBlockComment) {
      if (c === '*' && line[i + 1] === '/') {
        state.inBlockComment = false;
        i++;
      }
      countingLeading = false;
      continue;
    }
    if (inLineComment) break;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && line[i + 1] === '/') { inLineComment = true; break; }
    if (c === '/' && line[i + 1] === '*') { state.inBlockComment = true; i++; countingLeading = false; continue; }
    if (c === '"' || c === "'") { quote = c; countingLeading = false; continue; }
    if (c === ' ' || c === '\t') continue;
    if (c === '}') {
      if (countingLeading) leadingClosers++;
      state.depth--;
    } else {
      countingLeading = false;
      if (c === '{') state.depth++;
    }
  }
  return { leadingClosers };
}

/**
 * Re-indent NED/MSG source by brace nesting depth. Conservative: only adjusts
 * leading whitespace; never reflows content, strings, or comments.
 */
export function formatBraceIndent(text: string, opts: FormatOptions): string {
  const unit = opts.insertSpaces ? ' '.repeat(opts.tabSize) : '\t';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const state: ScanState = { depth: 0, inBlockComment: false };
  const out: string[] = [];

  for (const raw of lines) {
    const wasInBlock = state.inBlockComment;
    const trimmed = raw.trim();
    const depthBefore = state.depth;
    const { leadingClosers } = scanLine(raw, state);

    if (trimmed === '') {
      out.push('');
      continue;
    }
    if (wasInBlock) {
      // preserve original indentation inside block comments
      out.push(raw.replace(/\s+$/, ''));
      continue;
    }
    const level = Math.max(0, depthBefore - leadingClosers);
    out.push(unit.repeat(level) + trimmed);
  }

  return out.join(eol);
}

/** Document formatting as a single full-range replace edit. */
export function formatDocumentEdits(text: string, _tree: Tree | undefined, opts: FormatOptions): TextEdit[] {
  const formatted = formatBraceIndent(text, opts);
  if (formatted === text) return [];
  const lines = text.split(/\r?\n/);
  return [
    {
      range: {
        start: { line: 0, character: 0 },
        end: { line: lines.length - 1, character: lines[lines.length - 1].length },
      },
      newText: formatted,
    },
  ];
}
