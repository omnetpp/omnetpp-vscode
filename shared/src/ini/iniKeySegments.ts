// Cursor-position semantics of INI entries and their dotted keys: which entry a
// position falls in, how a dotted param-assignment key splits into module-path
// segments, and which `extends=` label is under the cursor. Pure INI knowledge
// (no LSP/editor concepts) used by navigation features.
import type { Position } from '../model/location';
import { posInRange } from '../model/location';
import type { IniDocument, IniEntry, IniSection } from './iniDocument';

/** The ini section + entry whose key OR value range spans `pos`, if any. */
export function iniEntryAt(
  doc: IniDocument,
  pos: Position,
): { section: IniSection; entry: IniEntry } | undefined {
  for (const section of doc.sections) {
    for (const e of section.entries) {
      if (posInRange(pos, e.keyRange) || posInRange(pos, e.valueRange)) return { section, entry: e };
    }
  }
  return undefined;
}

/** The leaf (last dotted segment) of an ini key, e.g. `typename` of `**.app.typename`. */
export function leafSegment(key: string): string {
  const dot = key.lastIndexOf('.');
  return dot < 0 ? key : key.slice(dot + 1);
}

/**
 * For a cursor within a dotted key's range, the key truncated to the end of the
 * segment under the cursor (its module-path prefix) and whether that segment is the
 * last one (the leaf parameter name). The key is always single-line. Returns
 * `undefined` when the cursor is not on the key line/range.
 */
export function keySegmentPrefixAt(
  entry: IniEntry,
  pos: Position,
): { prefix: string; segment: string; isLast: boolean } | undefined {
  const r = entry.keyRange;
  if (pos.line !== r.start.line) return undefined;
  const rel = pos.character - r.start.character;
  const key = entry.key;
  if (rel < 0 || rel > key.length) return undefined;
  const dots: number[] = [];
  for (let i = 0; i < key.length; i++) if (key[i] === '.') dots.push(i);
  let seg = 0;
  for (const d of dots) {
    if (rel > d) seg++;
    else break;
  }
  const start = seg === 0 ? 0 : dots[seg - 1] + 1;
  const end = seg < dots.length ? dots[seg] : key.length;
  return { prefix: key.slice(0, end), segment: key.slice(start, end), isLast: seg === dots.length };
}

/** A dotted-key segment whose NAME (before any `[index]`) is a wildcard — it
 *  targets no specific module type, so it should not drive type navigation. */
export function isWildcardSegment(segment: string): boolean {
  const name = segment.split('[')[0];
  return name === '' || /[*?]/.test(name);
}

/** The comma-separated `extends=` label under `pos`, if the cursor is on the value. */
export function extendsLabelAt(entry: IniEntry, pos: Position): string | undefined {
  const r = entry.valueRange;
  if (pos.line !== r.start.line) return undefined; // extends is always single-line
  const rel = pos.character - r.start.character;
  const v = entry.value;
  if (rel < 0 || rel > v.length) return undefined;
  let start = 0;
  for (let i = 0; i <= v.length; i++) {
    if (i === v.length || v[i] === ',') {
      if (rel >= start && rel <= i) return v.slice(start, i).trim() || undefined;
      start = i + 1;
    }
  }
  return undefined;
}
