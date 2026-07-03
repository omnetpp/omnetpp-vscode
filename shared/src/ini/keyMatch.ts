// Low-level OMNeT++ key/pattern matching, shared by the module-tree expander and
// the INI param resolver. Kept dependency-free so `moduleTree.ts` can use it without
// importing `iniParamResolution.ts` (which imports `moduleTree.ts`).
//
// Mirrors OMNeT++'s common/PatternMatcher (dottedpath mode). Besides `*`/`**`/`?`,
// it understands OMNeT++'s brace forms:
//   - a character set `{a-z}` / negated `{^a-z}` — matches a single character;
//     the body is an enumeration of characters and `a-b` ranges (so `{3,5}` matches
//     one of `3` `,` `5`, i.e. `node{3,5}` matches `node3` and `node5`);
//   - a numeric range `{lo..up}` — matches a run of digits whose value is in range
//     (either bound may be omitted, e.g. `{10..}`, `{..99}`, `{..}`).
// Square-bracket forms (`[lo..up]`, `[i]`) are handled upstream by `normIndices`,
// which collapses every vector index to `[]`.

/** Collapse vector indices to [] for pattern comparison. */
export function normIndices(s: string): string {
  return s.replace(/\[[^\]]*\]/g, '[]');
}

/** Escape a single character for use inside a JS regex character class. */
function escInClass(c: string): string {
  return /[\\\]^-]/.test(c) ? '\\' + c : c;
}

/** Escape a single character for use in a JS regex (outside a class). */
function escLiteral(c: string): string {
  return /[a-zA-Z0-9_]/.test(c) ? c : '\\' + c;
}

/** Wrap an alternation so it can be safely concatenated with neighbours. */
function group(s: string): string {
  return s.includes('|') ? `(?:${s})` : s;
}

/** Regex for a run of digits (`num`-length strings), value in [a, b], a<=b, same digit count. */
function sameLenRange(a: string, b: string): string {
  if (a === b) return a;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const prefix = a.slice(0, i);
  const lo = +a[i];
  const hi = +b[i];
  const restLen = a.length - i - 1;
  const charClass = (x: number, y: number) => (x === y ? String(x) : `[${x}-${y}]`);
  const anyDigits = (n: number) => (n === 0 ? '' : n === 1 ? '[0-9]' : `[0-9]{${n}}`);
  if (restLen === 0) return prefix + charClass(lo, hi);
  const alts: string[] = [];
  alts.push(String(lo) + group(sameLenRange(a.slice(i + 1), '9'.repeat(restLen))));
  if (hi - lo >= 2) alts.push(charClass(lo + 1, hi - 1) + anyDigits(restLen));
  alts.push(String(hi) + group(sameLenRange('0'.repeat(restLen), b.slice(i + 1))));
  return prefix + group(alts.join('|'));
}

/** Regex (alternation) for integers in [lo, up], 0<=lo<=up, canonical (no leading zeros). */
function boundedRange(lo: number, up: number): string {
  const parts: string[] = [];
  let a = lo;
  while (a <= up) {
    const maxSame = Math.pow(10, String(a).length) - 1;
    const b = Math.min(up, maxSame);
    parts.push(sameLenRange(String(a), String(b)));
    a = b + 1;
  }
  return parts.map(group).join('|');
}

/** Regex matching a digit run whose numeric value is in [lo, up] (null = unbounded).
 *  Leading zeros are allowed (OMNeT++ compares via atol). The trailing `(?![0-9])`
 *  makes the range consume the WHOLE run of digits, as OMNeT++'s NUMRANGE does
 *  (`atol` reads every consecutive digit before range-checking) — so an adjacent
 *  digit-matching element cannot steal trailing digits. */
function numRangeToRegex(lo: number | null, up: number | null): string {
  if (lo === null && up === null) return '[0-9]+(?![0-9])';
  const body =
    lo === null
      ? boundedRange(0, up!) // only nonnegative integers exist
      : up === null
        ? `${group(sameLenRange(String(lo), '9'.repeat(String(lo).length)))}|[1-9][0-9]{${String(lo).length},}`
        : boundedRange(lo, up);
  return `0*(?:${body})(?![0-9])`;
}

/** Parse a `{lo..up}` numeric range starting at `norm[i]==='{'`; null if not a range. */
function parseNumRange(norm: string, i: number): { lo: number | null; up: number | null; next: number } | null {
  let j = i + 1;
  let lo: number | null = null;
  if (/[0-9]/.test(norm[j] ?? '')) {
    let n = '';
    while (/[0-9]/.test(norm[j] ?? '')) n += norm[j++];
    lo = parseInt(n, 10);
  }
  if (norm[j] !== '.' || norm[j + 1] !== '.') return null;
  j += 2;
  let up: number | null = null;
  if (/[0-9]/.test(norm[j] ?? '')) {
    let n = '';
    while (/[0-9]/.test(norm[j] ?? '')) n += norm[j++];
    up = parseInt(n, 10);
  }
  if (norm[j] !== '}') return null;
  return { lo, up, next: j + 1 };
}

/** Parse a `{...}` character set starting at `norm[i]==='{'`; null if unterminated. */
function parseSet(norm: string, i: number): { regex: string; next: number } | null {
  let j = i + 1;
  let negated = false;
  if (norm[j] === '^') {
    negated = true;
    j++;
  }
  const sbeg = j; // a leading '}' is a literal member, not the terminator
  let body = '';
  while (j < norm.length && (norm[j] !== '}' || j === sbeg)) {
    if (norm[j + 1] === '-' && norm[j + 2] !== undefined && norm[j + 2] !== '}') {
      // a reversed range (lo > hi) matches nothing in OMNeT++ (isInSet is never true);
      // drop it rather than emit an invalid JS regex range.
      if (norm[j].charCodeAt(0) <= norm[j + 2].charCodeAt(0))
        body += `${escInClass(norm[j])}-${escInClass(norm[j + 2])}`;
      j += 3;
    } else {
      body += escInClass(norm[j]);
      j += 1;
    }
  }
  if (norm[j] !== '}') return null; // unterminated: caller falls back to a literal '{'
  // an empty positive set matches no character; an empty negated set matches any.
  if (body === '') return { regex: negated ? '[\\s\\S]' : '[^\\s\\S]', next: j + 1 };
  return { regex: `[${negated ? '^' : ''}${body}]`, next: j + 1 };
}

/** Compile an ini key (OMNeT++ wildcard pattern) to an anchored RegExp. */
export function iniKeyToRegex(key: string): RegExp {
  const norm = normIndices(key);
  let out = '';
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === '\\' && norm[i + 1] !== undefined) { out += escLiteral(norm[i + 1]); i++; }
    else if (c === '*' && norm[i + 1] === '*') { out += '.*'; i++; }
    else if (c === '*') out += '[^.]*';
    else if (c === '?') out += '[^.]';
    else if (c === '[' && norm[i + 1] === ']') { out += '\\[\\]'; i++; }
    else if (c === '{') {
      const range = parseNumRange(norm, i);
      if (range) {
        out += `(?:${numRangeToRegex(range.lo, range.up)})`;
        i = range.next - 1;
        continue;
      }
      const set = parseSet(norm, i);
      if (set) {
        out += set.regex;
        i = set.next - 1;
        continue;
      }
      out += '\\{'; // unterminated brace: treat literally
    }
    else if (/[a-zA-Z0-9_]/.test(c)) out += c;
    else out += '\\' + c;
  }
  return new RegExp('^' + out + '$');
}
