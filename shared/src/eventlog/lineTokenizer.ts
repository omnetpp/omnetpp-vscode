/**
 * Port of omnetpp src/common/linetokenizer.cc (LineTokenizer::tokenize).
 *
 * Tokenizes a line of text on two separator characters (default space and
 * tab), honoring quoted substrings: `one "two or three" four` is returned as
 * the three tokens `one`, `two or three`, `four`. A quote appearing inside a
 * quoted token must be backslash-escaped (`\"`), and a literal backslash
 * inside a quoted token must be doubled (`\\`); the usual C-style backslash
 * escapes (`\n`, `\t`, `\xHH`, ...) are also recognized there. Unquoted
 * tokens are never backslash-interpreted — this asymmetry mirrors the C++
 * source exactly.
 *
 * Unlike the C++ original, this port has no fixed-size buffers, so there is
 * no "too many tokens" limit, and each `tokenize()` call simply returns a
 * fresh array (no internal buffer reuse to replicate).
 */

/** Hex digit value (0-15) of a single character, or -1 if it isn't one. Port of `h2d(char)`. */
function hexDigitValue(c: string): number {
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - '0'.charCodeAt(0);
  if (c >= 'A' && c <= 'F') return c.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
  if (c >= 'a' && c <= 'f') return c.charCodeAt(0) - 'a'.charCodeAt(0) + 10;
  return -1;
}

/**
 * Reads up to two hex digits starting at `raw[i]` and returns their byte
 * value together with how many characters were consumed (0, 1, or 2).
 * Port of the two-argument `h2d(char *&s)` overload.
 */
function readHexByte(raw: string, i: number): { value: number; consumed: number } {
  const a = i < raw.length ? hexDigitValue(raw[i]) : -1;
  if (a < 0) return { value: 0, consumed: 0 };
  const b = i + 1 < raw.length ? hexDigitValue(raw[i + 1]) : -1;
  if (b < 0) return { value: a, consumed: 1 };
  return { value: a * 16 + b, consumed: 2 };
}

/**
 * Interprets backslash escape sequences in the raw text of a quoted token.
 * Port of the file-local `interpretBackslashes()` helper. Only invoked when
 * the raw token is known to contain at least one backslash.
 */
function interpretBackslashes(raw: string): string {
  let out = '';
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const c = raw[i];
    if (c !== '\\') {
      out += c;
      i++;
      continue;
    }
    i++; // consume the backslash
    if (i >= n) {
      // string ends in a stray backslash -- produces nothing
      break;
    }
    const next = raw[i];
    switch (next) {
      case 'b': out += '\b'; i++; break;
      case 'f': out += '\f'; i++; break;
      case 'n': out += '\n'; i++; break;
      case 'r': out += '\r'; i++; break;
      case 't': out += '\t'; i++; break;
      case 'x': {
        const { value, consumed } = readHexByte(raw, i + 1);
        out += String.fromCharCode(value);
        i += 1 + consumed;
        break;
      }
      case '"': out += '"'; i++; break;
      case '\\': out += '\\'; i++; break;
      case '\n': i++; break; // line continuation -- don't store it
      default: out += next; i++; break; // be tolerant with unrecognized escapes
    }
  }
  return out;
}

/**
 * Tokenizes lines of text into whitespace/quote-aware tokens. Faithful port
 * of `omnetpp::common::LineTokenizer` (minus its fixed-size internal
 * buffers, which are a C++ performance detail with no TS equivalent).
 */
export class LineTokenizer {
  constructor(private sep1: string = ' ', private sep2: string = '\t') {}

  /**
   * Tokenizes a single line. Trailing `\r`/`\n` characters are stripped
   * first (defensively, mirroring the C++). Throws on an unmatched quote.
   */
  tokenize(line: string): string[] {
    let end = line.length;
    while (end > 0 && (line[end - 1] === '\r' || line[end - 1] === '\n')) end--;
    const s = line.slice(0, end);
    const n = s.length;

    const tokens: string[] = [];
    let i = 0;
    for (;;) {
      // skip separators before token
      while (i < n && (s[i] === this.sep1 || s[i] === this.sep2)) i++;

      if (i >= n) {
        // end of line found -- exit loop
        break;
      } else if (s[i] === '"') {
        // parse quoted string
        i++;
        const start = i;
        let containsBackslash = false;
        while (i < n && s[i] !== '"') {
          if (s[i] === '\\') {
            i += 2; // skip the backslash and the character following it
            containsBackslash = true;
          } else {
            i++;
          }
        }
        if (i >= n || s[i] !== '"') throw new Error('Unmatched quote in line');
        const raw = s.slice(start, i);
        i++; // consume closing quote
        tokens.push(containsBackslash ? interpretBackslashes(raw) : raw);
      } else {
        // parse unquoted string -- no backslash interpretation here
        const start = i;
        while (i < n && s[i] !== this.sep1 && s[i] !== this.sep2) i++;
        tokens.push(s.slice(start, i));
      }
    }
    return tokens;
  }
}

/** Convenience one-shot form: constructs a `LineTokenizer` and calls `tokenize()`. */
export function tokenizeLine(line: string, sep1: string = ' ', sep2: string = '\t'): string[] {
  return new LineTokenizer(sep1, sep2).tokenize(line);
}
