/**
 * Glob-style pattern matching, adopted to OMNeT++'s specific requirements. Ported from:
 *   omnetpp-dev/src/common/patternmatcher.h/.cc
 *
 * Per the port plan's Risk #3, this class (and matchExpression.ts) has **no Java
 * source** -- `org.omnetpp.common.engine.PatternMatcher` is a JNI wrapper delegating
 * to this exact C++ class, so the C++ sources above are the only porting source. This
 * file is a faithful, "port BEHAVIOR not appearance" translation of patternmatcher.cc,
 * including its two genuinely surprising quirks (kept intentionally, not "fixed" --
 * both are cheaply verifiable against the C++ source, and other code -- e.g. the
 * doMatch() ANYSEQ shortcut -- may rely on the exact matching behavior):
 *
 *  1. `parseLiteralString()`'s bracket-numrange lookahead runs on the CURRENT cursor
 *     position even right after processing a backslash escape. Concretely, escaping
 *     the opening bracket of a numeric range (`"\[10..20]"`) does NOT disable the
 *     lookahead (since by the time the check runs, the cursor already points *at* the
 *     escaped '[' character, same as if it had not been escaped) -- so there is no way
 *     to write a literal, un-parsed "[n..m]"-shaped substring in a pattern. Ported
 *     verbatim; see `parseLiteralString()`'s comment below for the byte-for-byte trace.
 *  2. `doMatch()`'s ANYSEQ shortcut for a pattern ending "**literal" (i.e. `k ===
 *     pattern.length - 3` with the very next element a trailing LITERALSTRING) uses a
 *     plain (always case-SENSITIVE) suffix compare (`opp_stringendswith`), regardless
 *     of the matcher's own `caseSensitive` flag -- so a case-*insensitive* pattern like
 *     "**FOO" (case-insensitive) can, in this one shortcut path, end up requiring an
 *     exact-case suffix match. See the `doMatch()` ANYSEQ case below.
 *
 * Numbers: pattern/line offsets and NUMRANGE bounds are all plain `number` (event-log
 * text never carries digit runs anywhwere near `Number.MAX_SAFE_INTEGER`, unlike C++'s
 * `long`, which is why this port doesn't need a bigint here).
 */

// ---------------------------------------------------------------------------------
// Elem -- one token of a compiled pattern (port of `PatternMatcher::Elem`).
// ---------------------------------------------------------------------------------

type ElemType = 'LITERALSTRING' | 'ANYCHAR' | 'NONDOTCHAR' | 'SET' | 'NEGSET' | 'NUMRANGE' | 'ANYSEQ' | 'NONDOTSEQ' | 'END';

interface Elem {
  type: ElemType;
  /** LITERALSTRING only. */
  literalString: string;
  /** SET/NEGSET only: character-range pairs packed two chars at a time, (lo0,hi0),(lo1,hi1),... -- same packing as the C++ `setOfChars` field. */
  setOfChars: string;
  /** NUMRANGE only; -1 means "unset" (unbounded on that side). */
  numStart: number;
  numEnd: number;
}

function makeElem(type: ElemType): Elem {
  return { type, literalString: '', setOfChars: '', numStart: -1, numEnd: -1 };
}

// ---------------------------------------------------------------------------------
// small character helpers (opp_isdigit / opp_toupper / opp_isspace equivalents --
// the C++ originals are thin wrappers around the C library's ASCII-locale versions)
// ---------------------------------------------------------------------------------

function isDigitChar(c: string): boolean {
  return c >= '0' && c <= '9';
}

function toUpperChar(c: string): string {
  return c.length === 1 ? c.toUpperCase() : c;
}

/** Port of `parseNumRange()`'s pure lookahead half: given `str` and a position `pos`
 * pointing at the opening '[' or '{', tries to parse "[n..m" (stopping right before,
 * not consuming, `closingChar`). Returns `null` on failure (mirrors the C++ out
 * parameter being left unchanged on failure); does not mutate any shared cursor. */
function tryParseNumRange(str: string, pos: number, closingChar: string): { lo: number; up: number; closingPos: number } | null {
  let i = pos + 1; // skip '[' or '{'
  let lo = -1;
  let up = -1;
  if (isDigitChar(str.charAt(i))) {
    const digitsStart = i;
    while (isDigitChar(str.charAt(i))) i++;
    lo = parseInt(str.slice(digitsStart, i), 10);
  }
  if (str.charAt(i) !== '.' || str.charAt(i + 1) !== '.') return null;
  i += 2;
  if (isDigitChar(str.charAt(i))) {
    const digitsStart = i;
    while (isDigitChar(str.charAt(i))) i++;
    up = parseInt(str.slice(digitsStart, i), 10);
  }
  if (str.charAt(i) !== closingChar) return null;
  return { lo, up, closingPos: i };
}

// ---------------------------------------------------------------------------------
// PatternMatcher
// ---------------------------------------------------------------------------------

export class PatternMatcher {
  private pattern: Elem[] = [];
  private caseSensitive = true;

  constructor(pattern?: string, dottedpath?: boolean, fullstring?: boolean, casesensitive?: boolean) {
    if (pattern !== undefined) this.setPattern(pattern, dottedpath ?? false, fullstring ?? true, casesensitive ?? true);
  }

  /** Port of `setPattern()`. Throws on a malformed pattern (unmatched '{', unmatched quote-like construct -- see `parseSet()`). */
  setPattern(patt: string, dottedpath: boolean, fullstring: boolean, casesensitive: boolean): void {
    this.pattern = [];
    this.caseSensitive = casesensitive;

    let s = 0;
    while (s < patt.length) {
      let e: Elem;
      const c = patt.charAt(s);
      switch (c) {
        case '?':
          e = makeElem(dottedpath ? 'NONDOTCHAR' : 'ANYCHAR');
          s += 1;
          break;

        case '[': {
          const last = this.pattern[this.pattern.length - 1];
          const range = last !== undefined && last.type === 'LITERALSTRING' ? tryParseNumRange(patt, s, ']') : null;
          if (range === null) {
            const result = this.parseLiteralString(patt, s);
            e = result.elem;
            s = result.nextPos;
          } else {
            // NOTE: unlike the '{' case below, the C++ source does NOT advance past the
            // closing ']' here -- the next tokenizer iteration re-visits it and (since it
            // isn't a recognized special char) it gets folded into the following
            // LITERALSTRING. Ported verbatim.
            e = makeElem('NUMRANGE');
            e.numStart = range.lo;
            e.numEnd = range.up;
            s = range.closingPos;
          }
          break;
        }

        case '{': {
          const range = tryParseNumRange(patt, s, '}');
          if (range !== null) {
            e = makeElem('NUMRANGE');
            e.numStart = range.lo;
            e.numEnd = range.up;
            s = range.closingPos + 1; // skip '}'
          } else {
            const result = this.parseSet(patt, s);
            e = result.elem;
            s = result.nextPos;
          }
          break;
        }

        case '*':
          if (patt.charAt(s + 1) === '*') {
            e = makeElem('ANYSEQ');
            s += 2;
          } else {
            e = makeElem(dottedpath ? 'NONDOTSEQ' : 'ANYSEQ');
            s += 1;
          }
          break;

        default: {
          const result = this.parseLiteralString(patt, s);
          e = result.elem;
          s = result.nextPos;
          break;
        }
      }
      this.pattern.push(e);
    }

    if (!fullstring) {
      // for substring match, add "**" at both ends of the pattern (unless already there)
      if (this.pattern.length === 0 || this.pattern[this.pattern.length - 1].type !== 'ANYSEQ') this.pattern.push(makeElem('ANYSEQ'));
      if (this.pattern[0].type !== 'ANYSEQ') this.pattern.unshift(makeElem('ANYSEQ'));
    }
    this.pattern.push(makeElem('END'));
  }

  /**
   * Port of `parseSet()`. `s` must point at the opening '{' (not a numeric range --
   * the caller already ruled that out). Character ranges/enumerations, optionally
   * negated ('{^...}'); a leading '}' right after '{' or '{^' is taken literally (can't
   * otherwise be part of the set, since it would end it); backslash is NOT an escape
   * character inside a set (stored literally, matching the C++ doc comment).
   */
  private parseSet(s: string, pos: number): { elem: Elem; nextPos: number } {
    let i = pos + 1; // skip '{'
    let type: ElemType = 'SET';
    if (s.charAt(i) === '^') {
      type = 'NEGSET';
      i++;
    }
    const sbeg = i;
    let setOfChars = '';
    while (s.charAt(i) !== '' && (s.charAt(i) !== '}' || i === sbeg)) {
      let lo: string;
      let hi: string;
      if (s.charAt(i + 1) === '-' && s.charAt(i + 2) !== '' && s.charAt(i + 2) !== '}') {
        lo = s.charAt(i);
        hi = s.charAt(i + 2);
        i += 3;
      } else {
        lo = hi = s.charAt(i);
        i += 1;
      }
      if (!this.caseSensitive) {
        lo = toUpperChar(lo);
        hi = toUpperChar(hi);
      }
      setOfChars += lo + hi;
    }
    if (s.charAt(i) === '') throw new Error("PatternMatcher: Unmatched '}' in expression");
    i++; // skip '}'
    const e = makeElem(type);
    e.setOfChars = setOfChars;
    return { elem: e, nextPos: i };
  }

  /**
   * Port of `parseLiteralString()`. Consumes chars up to (not including) the next
   * '?'/'{'/'*', processing backslash escapes, EXCEPT that it breaks early -- without
   * consuming -- right before a "[n..m]" numeric range (the lookahead described in this
   * file's header): the '[' has already been appended to the literal by the time this
   * check runs (see the trace below), so a pattern like "abc[10..20]" tokenizes as
   * LITERALSTRING("abc["), NUMRANGE(10,20), LITERALSTRING("]") -- semantically
   * equivalent to matching literal "abc[", then a bounded digit run, then literal "]".
   *
   * The escape-then-lookahead interaction (quirk #1 in this file's header): after
   * `\X`, the cursor points AT the escaped character `X` (mirroring C++'s `*(++s)`).
   * The bracket lookahead below then runs against *that* (post-escape) position, so
   * `\[` does not defeat it if a valid "n..m]" follows the escaped '['.
   */
  private parseLiteralString(s: string, pos: number): { elem: Elem; nextPos: number } {
    const e = makeElem('LITERALSTRING');
    let i = pos;
    while (true) {
      const c = s.charAt(i);
      if (c === '' || c === '?' || c === '{' || c === '*') break;
      if (c === '\\') {
        i++;
        e.literalString += s.charAt(i); // appends '' (nothing) for a trailing lone backslash at EOS
      } else {
        e.literalString += c;
      }
      if (s.charAt(i) === '[' && tryParseNumRange(s, i, ']') !== null) break; // see header note: does NOT advance `i`
      i++;
    }
    return { elem: e, nextPos: i };
  }

  private isInSet(c: string, setOfChars: string): boolean {
    const ch = this.caseSensitive ? c : toUpperChar(c); // setOfChars is already uppercased at parse time when case-insensitive
    for (let i = 0; i < setOfChars.length; i += 2) {
      if (ch >= setOfChars[i] && ch <= setOfChars[i + 1]) return true;
    }
    return false;
  }

  /** Port of `doMatch()`. `k` = index into `this.pattern`; `s` = index into `line`. */
  private doMatch(line: string, s0: number, k0: number, suffixlen: number): boolean {
    let s = s0;
    let k = k0;
    while (true) {
      const e = this.pattern[k];
      switch (e.type) {
        case 'LITERALSTRING': {
          let len = e.literalString.length;
          // special case: last string literal with prefix match: allow s to be shorter
          if (suffixlen > 0 && k === this.pattern.length - 2) len -= suffixlen;
          if (!regionMatches(line, s, e.literalString, len, this.caseSensitive)) return false;
          s += len;
          break;
        }

        case 'ANYCHAR':
          if (s >= line.length) return false;
          s += 1;
          break;

        case 'NONDOTCHAR':
          if (s >= line.length || line.charAt(s) === '.') return false;
          s += 1;
          break;

        case 'SET':
          if (s >= line.length || !this.isInSet(line.charAt(s), e.setOfChars)) return false;
          s += 1;
          break;

        case 'NEGSET':
          if (s >= line.length || this.isInSet(line.charAt(s), e.setOfChars)) return false;
          s += 1;
          break;

        case 'NUMRANGE': {
          if (!isDigitChar(line.charAt(s))) return false;
          const digitsStart = s;
          while (isDigitChar(line.charAt(s))) s++;
          const num = parseInt(line.slice(digitsStart, s), 10);
          if ((e.numStart >= 0 && num < e.numStart) || (e.numEnd >= 0 && num > e.numEnd)) return false;
          break;
        }

        case 'ANYSEQ': {
          // potential shortcuts (see this file's header for the case-sensitivity quirk
          // on the second one)
          if (k === this.pattern.length - 2) return true;
          if (k === this.pattern.length - 3 && this.pattern[k + 1].type === 'LITERALSTRING') return line.slice(s).endsWith(this.pattern[k + 1].literalString);
          // general case
          while (true) {
            if (this.doMatch(line, s, k + 1, suffixlen)) return true;
            if (s >= line.length) return false;
            s += 1;
          }
        }

        case 'NONDOTSEQ':
          while (true) {
            if (this.doMatch(line, s, k + 1, suffixlen)) return true;
            if (s >= line.length || line.charAt(s) === '.') return false;
            s += 1;
          }

        case 'END':
          return s === line.length;

        default:
          throw new Error('PatternMatcher.doMatch: unknown element type');
      }
      k += 1;
    }
  }

  /** Port of `matches()`. Throws if the pattern was never set (the C++ default constructor leaves an empty vector, which `matches()` would otherwise index out of bounds on). */
  matches(line: string): boolean {
    if (this.pattern.length === 0) throw new Error('PatternMatcher.matches: pattern not set (call setPattern() first)');

    // shortcut: omnetpp.ini keys often begin with "*"/"**" but end in a string literal,
    // so checking the last 2 chars first is usually a perf win -- case-sensitive only
    // (matches the C++ comment: "omnetpp.ini is case sensitive").
    if (this.pattern.length >= 2 && this.caseSensitive) {
      const e = this.pattern[this.pattern.length - 2];
      if (e.type === 'LITERALSTRING') {
        const pattlen = e.literalString.length;
        const linelen = line.length;
        if (pattlen >= 2 && linelen >= 2 && (line[linelen - 1] !== e.literalString[pattlen - 1] || line[linelen - 2] !== e.literalString[pattlen - 2])) return false;
      }
    }

    return this.doMatch(line, 0, 0, 0);
  }

  /**
   * Port of `covers()`. Approximate -- per the C++ comment, doesn't account for
   * numeric ranges (e.g. "*.node[0..10].foo" covers "*.node[3..6].foo", but this
   * returns false, same as the C++ original).
   */
  covers(pattern: string): boolean {
    return this.matches(pattern);
  }

  /** Port of `patternPrefixMatches()`. See patternmatcher.h's doc comment for the full contract. */
  patternPrefixMatches(line: string, suffixoffset: number): string | null {
    if (!this.caseSensitive) throw new Error('PatternMatcher.patternPrefixMatches: does not support case-insensitive match');
    if (this.pattern.length === 0) throw new Error('PatternMatcher.patternPrefixMatches: pattern not set (call setPattern() first)');
    if (this.pattern.length < 2) return null;
    const e = this.pattern[this.pattern.length - 2];
    if (e.type !== 'LITERALSTRING') return null;

    const needle = line.slice(suffixoffset);
    const p = e.literalString.indexOf(needle);
    if (p === -1) return null;
    const restStart = p + needle.length;
    const rest = e.literalString.slice(restStart);
    const pattsuffixlen = e.literalString.length - restStart;

    return this.doMatch(line, 0, 0, pattsuffixlen) ? rest : null;
  }

  /** Port of `str()`. */
  str(): string {
    let out = '';
    for (const e of this.pattern) {
      switch (e.type) {
        case 'LITERALSTRING':
          out += e.literalString;
          break;
        case 'ANYCHAR':
        case 'NONDOTCHAR':
          out += '?';
          break;
        case 'ANYSEQ':
          out += '**';
          break;
        case 'NONDOTSEQ':
          out += '*';
          break;
        case 'SET':
          out += '[' + printSetRanges(e.setOfChars) + ']';
          break;
        case 'NEGSET':
          out += '[^' + printSetRanges(e.setOfChars) + ']';
          break;
        case 'NUMRANGE':
          out += '{' + (e.numStart >= 0 ? String(e.numStart) : '') + '..' + (e.numEnd >= 0 ? String(e.numEnd) : '') + '}';
          break;
        case 'END':
          break;
      }
    }
    return out;
  }

  /** Utility function to determine whether a given string contains wildcards. Port of `containsWildcards()`. */
  static containsWildcards(pattern: string): boolean {
    return pattern.includes('?') || pattern.includes('*') || pattern.includes('\\') || pattern.includes('{') || pattern.includes('..');
  }
}

function printSetRanges(setOfChars: string): string {
  let out = '';
  for (let i = 0; i < setOfChars.length; i += 2) out += setOfChars[i] + '-' + setOfChars[i + 1];
  return out;
}

/** Port of the `strncmp`/`strncasecmp` comparison in `doMatch()`'s LITERALSTRING case:
 * compares `len` characters of `line` (starting at `pos`) against the first `len`
 * characters of `literal`. Returns false if `line` doesn't have `len` characters
 * remaining from `pos` (mirrors `strncmp` hitting `line`'s NUL terminator before `len`
 * bytes were compared and reading a mismatch against the literal's non-NUL byte there). */
function regionMatches(line: string, pos: number, literal: string, len: number, caseSensitive: boolean): boolean {
  if (len <= 0) return len === 0;
  if (pos < 0 || pos + len > line.length) return false;
  const a = line.substr(pos, len);
  const b = literal.slice(0, len);
  return caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase();
}
