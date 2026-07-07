/**
 * The match-expression language: patterns, `field =~ pattern`, combined with
 * AND/OR/NOT and parentheses. Ported from:
 *   omnetpp-dev/src/common/matchexpression.h/.cc
 *   omnetpp-dev/src/common/matchexpression.y      (bison grammar)
 *   omnetpp-dev/src/common/matchexpressionlexer.h/.cc  (hand-written reentrant lexer)
 *
 * Per the port plan's Risk #3, none of this has a Java source -- `org.omnetpp.common.
 * engine.MatchExpression`/`PatternMatcher` are JNI wrappers around the C++ classes
 * above, so the C++ is the only porting source (see patternMatcher.ts's header for the
 * same note).
 *
 * DESIGN: the C++ implementation is a two-stage pipeline -- `parsePattern()` (bison,
 * generated from matchexpression.y) turns the input into a flat, postfix (reverse
 * Polish) `vector<Elem>` of AND/OR/NOT/PATTERN markers, and `generateEvaluator()` then
 * replays that vector through a `std::stack<ExprNode*>` to build an expression tree
 * (`AndNode`/`OrNode`/`NotNode`/leaf nodes wrapping a compiled `PatternMatcher`). This
 * port keeps the same two-stage shape (`parseToElems()` + `buildTree()`) but skips the
 * postfix/stack detour: a straightforward recursive-descent parser builds the
 * expression tree directly (permitted by the port plan: "you may evaluate an AST
 * directly as long as semantics match"), verified against the grammar below.
 *
 * GRAMMAR DECISIONS (verified against matchexpression.y, not assumed):
 *  - There is NO implicit AND (or any other implicit operator) between adjacent terms.
 *    The grammar has no production for `term term` -- `or_expr`/`and_expr` only ever
 *    combine two sub-expressions through an explicit OR_/AND_ token. Two patterns
 *    written back-to-back with nothing between them (e.g. `"foo bar"`, unquoted) is a
 *    parse error (an unconsumed second STRINGLITERAL after a complete `expression`).
 *  - AND binds tighter than OR: `and_expr` nests inside `or_expr`'s alternative, so
 *    `a or b and c` parses as `a or (b and c)`.
 *  - NOT binds to exactly one `term` (`not_expr : NOT_ term`), NOT to another
 *    `not_expr`/`and_expr`/`or_expr` -- so `not not a` is a parse error (`not` is
 *    followed by a `term`, and `term` has no path back through `not_expr`); the only
 *    way to negate a negation is with parentheses: `not (not a)`. Also `not a and b`
 *    parses as `(not a) and b` (NOT applies to the single term `a`, then AND combines
 *    with `b`), not `not (a and b)`.
 *  - AND/OR/NOT keywords are recognized case-insensitively (see the lexer), but only
 *    when they appear as an *entire* unquoted token (`strncasecmp(start, "and", 3)`
 *    with an exact length match) -- `"android"` or `"andb"` lexes as one STRINGLITERAL,
 *    not as `AND_` followed by more text.
 *  - A malformed expression (unbalanced parens, a stray operator, an empty parenthesized
 *    group, trailing garbage after a complete expression, etc.) throws.
 *  - A blank pattern (empty string, or only whitespace) is special-cased before parsing
 *    even starts: `matches()` on it always returns false (mirrors `opp_isblank()` in
 *    `MatchExpression::setPattern()` -- the C++ never invokes the parser at all here).
 */

import { PatternMatcher } from './patternMatcher';

// ---------------------------------------------------------------------------------
// Matchable -- port of `MatchExpression::Matchable`. Unified into the same
// optional-argument `getAsString(attribute?)` shape as the rest of this port (see
// eventLogEntry.ts's file header for the convention this follows); the generated
// eventlog entry classes (entries.ts) and `Event`/`FilteredEvent` already implement
// exactly this signature structurally, so they satisfy `Matchable` with no adapter.
// ---------------------------------------------------------------------------------

export interface Matchable {
  /** `attribute === undefined` is the "default field" (`getAsString()` in C++/Java); otherwise the named field (`getAsString(attribute)`), or `null` if the object has no such field. */
  getAsString(attribute?: string): string | null;
}

// ---------------------------------------------------------------------------------
// Lexer -- hand port of matchexpressionlexer.cc (kept hand-coded there too, per its
// own doc comment, because a Flex-generated lexer wasn't reentrant).
// ---------------------------------------------------------------------------------

type TokenType = 'EOF' | 'LPAREN' | 'RPAREN' | 'STRINGLITERAL' | 'MATCHES' | 'AND' | 'OR' | 'NOT';

interface Token {
  type: TokenType;
  /** STRINGLITERAL only. */
  value: string | null;
}

/**
 * Port of `MatchExpressionLexer::getNextToken()`. Ported byte-for-byte against the C++
 * cursor logic (not re-derived from the doc comment), including one easy-to-miss
 * quirk: in the C++ `switch (*ptr++) { case '=': if (*ptr=='~') {...; return MATCHES;}
 * /* no break! * / default: {...} }`, a `'='` NOT followed by `'~'` falls through into
 * the same unquoted-token scan as `default`, but critically the scan's own inner loop
 * *also* treats a bare `'='` as a token terminator (`case '=': if (*(ptr+1)=='~') goto
 * END; case '\0': ...: goto END;` -- the `if` only decides whether MATCHES would apply
 * next call, the `goto END` in the fallthrough always fires). Net effect: a lone `'='`
 * inside what would otherwise be one unquoted token always splits it there, and the
 * following token starts with (includes) that `'='` character. E.g. "foo=bar" (no
 * `"=~"` anywhere) lexes as STRINGLITERAL("foo"), STRINGLITERAL("=bar") -- two tokens,
 * not one. Ported verbatim.
 */
class MatchExpressionLexer {
  private ptr = 0;

  constructor(private readonly input: string) {}

  private charAt(offset = 0): string {
    const i = this.ptr + offset;
    return i < this.input.length ? this.input[i] : '';
  }

  getNextToken(): Token {
    while (true) {
      const start = this.ptr;
      const c = this.charAt();
      this.ptr += 1; // mirrors the C++ `*ptr++` dispatch (always advances past the first char, even in fallthrough cases)

      switch (c) {
        case '':
          return { type: 'EOF', value: null };

        case '(':
          return { type: 'LPAREN', value: null };

        case ')':
          return { type: 'RPAREN', value: null };

        case '"':
        case "'": {
          const result = parseQuotedString(this.input, start, c);
          this.ptr = result.endPos;
          return { type: 'STRINGLITERAL', value: result.value };
        }

        case ' ':
        case '\n':
        case '\t':
          continue;

        case '=':
          if (this.charAt() === '~') {
            this.ptr += 1;
            return { type: 'MATCHES', value: null };
          }
          // falls through to the unquoted-token scan, same as the C++ (see this class's header)
          return this.scanUnquotedToken(start);

        default:
          return this.scanUnquotedToken(start);
      }
    }
  }

  /** `this.ptr` already points one past `start` (the first character was consumed by the caller's dispatch, mirroring the C++ post-increment). */
  private scanUnquotedToken(start: number): Token {
    while (true) {
      const c = this.charAt();
      // a bare '=' always terminates the scan here, whether or not it's followed by
      // '~' -- see this class's header for why (the C++ fallthrough quirk)
      if (c === '=' || c === '' || c === ' ' || c === '\t' || c === '\n' || c === '(' || c === ')') break;
      this.ptr += 1;
    }
    const text = this.input.slice(start, this.ptr);
    const lower = text.toLowerCase();
    if (text.length === 2 && lower === 'or') return { type: 'OR', value: null };
    if (text.length === 3 && lower === 'and') return { type: 'AND', value: null };
    if (text.length === 3 && lower === 'not') return { type: 'NOT', value: null };
    return { type: 'STRINGLITERAL', value: text };
  }
}

function hexDigit(c: string): number {
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'A' && c <= 'F') return c.charCodeAt(0) - 55;
  if (c >= 'a' && c <= 'f') return c.charCodeAt(0) - 87;
  return -1;
}

/** Port of `h2d(const char*&)`: reads 1 or 2 hex digits starting at `pos` (not `pos-1` -- the caller has already skipped the 'x'), returns the parsed value and how many characters were consumed (0 if the first character isn't even a hex digit, matching the C++ `h2d` returning 0 without advancing in that case). */
function parseHexEscape(input: string, pos: number): { value: number; consumed: number } {
  const a = hexDigit(input.charAt(pos));
  if (a < 0) return { value: 0, consumed: 0 };
  const b = hexDigit(input.charAt(pos + 1));
  if (b < 0) return { value: a, consumed: 1 };
  return { value: a * 16 + b, consumed: 2 };
}

/**
 * Port of `opp_parsequotedstr(const char *txt, const char *&endp, char quot=0)` as
 * called by the lexer (quote character auto-detected from the first char, no
 * trailing-garbage check -- that's the *other* overload). `startPos` points at the
 * opening quote character (`quoteChar`, either `"` or `'`); returns the unescaped
 * value and the position right after the closing quote (and any trailing whitespace,
 * matching the C++, which skips it into `endp`).
 */
function parseQuotedString(input: string, startPos: number, quoteChar: string): { value: string; endPos: number } {
  let s = startPos;
  if (input.charAt(s) !== quoteChar) throw new Error('MatchExpression: missing opening quote');
  s += 1;
  let out = '';
  while (s < input.length && input[s] !== quoteChar) {
    const c = input[s];
    if (c === '\\') {
      s += 1;
      const esc = s < input.length ? input[s] : undefined;
      switch (esc) {
        case 'b':
          out += '\b';
          s += 1;
          break;
        case 'f':
          out += '\f';
          s += 1;
          break;
        case 'n':
          out += '\n';
          s += 1;
          break;
        case 'r':
          out += '\r';
          s += 1;
          break;
        case 't':
          out += '\t';
          s += 1;
          break;
        case 'x': {
          s += 1; // skip 'x'
          const { value, consumed } = parseHexEscape(input, s);
          out += String.fromCharCode(value);
          s += consumed;
          break;
        }
        case '\\':
          out += '\\';
          s += 1;
          break;
        case '\n':
          // line continuation: consume the newline, store nothing
          s += 1;
          break;
        case undefined:
          // string ends in a stray trailing backslash: store nothing, don't advance further
          // (the outer while's `s < input.length` check ends the loop next)
          break;
        case '=':
        case ';':
        case ',':
          throw new Error(`MatchExpression: illegal escape sequence '\\${esc}' (hint: use double backslashes to quote special characters: equal sign, comma, semicolon)`);
        default:
          if (esc === quoteChar) {
            out += quoteChar;
            s += 1;
          } else {
            throw new Error(`MatchExpression: illegal escape sequence '\\${esc}'`);
          }
      }
    } else {
      out += c;
      s += 1;
    }
  }
  if (input.charAt(s) !== quoteChar) throw new Error('MatchExpression: missing closing quote');
  s += 1;
  while (s < input.length && /\s/.test(input[s])) s++;
  return { value: out, endPos: s };
}

// ---------------------------------------------------------------------------------
// Parser -- recursive-descent, direct AST (see this file's header for why this
// replaces the C++'s bison-generated postfix-vector + stack-machine pipeline).
// ---------------------------------------------------------------------------------

/** One node of the parsed (but not yet PatternMatcher-compiled) expression tree -- port of the *shape* implied by `MatchExpression::Elem` + the grammar's reductions, built directly instead of via a postfix vector (see this file's header). */
type ParsedNode =
  | { kind: 'and'; left: ParsedNode; right: ParsedNode }
  | { kind: 'or'; left: ParsedNode; right: ParsedNode }
  | { kind: 'not'; child: ParsedNode }
  | { kind: 'pattern'; fieldname: string; pattern: string };

class MatchExpressionParser {
  private lexer: MatchExpressionLexer;
  private current: Token;

  constructor(input: string) {
    this.lexer = new MatchExpressionLexer(input);
    this.current = this.lexer.getNextToken();
  }

  private advance(): Token {
    const tok = this.current;
    this.current = this.lexer.getNextToken();
    return tok;
  }

  private expect(type: TokenType): Token {
    if (this.current.type !== type) throw new Error(`MatchExpression: parse error, expected ${type} but got ${this.current.type}`);
    return this.advance();
  }

  /** Port of the grammar's `%start expression` (`expression : or_expr`), plus the trailing-garbage check the bison-generated driver does implicitly (a real `yyparse()` only accepts input that reduces to `expression` followed by EOF). */
  parse(): ParsedNode {
    const node = this.parseOrExpr();
    if (this.current.type !== 'EOF') throw new Error(`MatchExpression: parse error, unexpected trailing input at token ${this.current.type}`);
    return node;
  }

  /** `or_expr : or_expr OR_ and_expr | and_expr` (left-associative). */
  private parseOrExpr(): ParsedNode {
    let node = this.parseAndExpr();
    while (this.current.type === 'OR') {
      this.advance();
      const right = this.parseAndExpr();
      node = { kind: 'or', left: node, right };
    }
    return node;
  }

  /** `and_expr : and_expr AND_ not_expr | not_expr` (left-associative, binds tighter than OR). */
  private parseAndExpr(): ParsedNode {
    let node = this.parseNotExpr();
    while (this.current.type === 'AND') {
      this.advance();
      const right = this.parseNotExpr();
      node = { kind: 'and', left: node, right };
    }
    return node;
  }

  /** `not_expr : NOT_ term | term` -- NOT binds to exactly one `term`, not another `not_expr` (see this file's header). */
  private parseNotExpr(): ParsedNode {
    if (this.current.type === 'NOT') {
      this.advance();
      const child = this.parseTerm();
      return { kind: 'not', child };
    }
    return this.parseTerm();
  }

  /** `term : '(' or_expr ')' | fieldpattern`. */
  private parseTerm(): ParsedNode {
    if (this.current.type === 'LPAREN') {
      this.advance();
      const node = this.parseOrExpr();
      this.expect('RPAREN');
      return node;
    }
    return this.parseFieldPattern();
  }

  /** `fieldpattern : STRINGLITERAL | STRINGLITERAL MATCHES STRINGLITERAL`. */
  private parseFieldPattern(): ParsedNode {
    const first = this.expect('STRINGLITERAL');
    if (this.current.type === 'MATCHES') {
      this.advance();
      const second = this.expect('STRINGLITERAL');
      return { kind: 'pattern', fieldname: first.value!, pattern: second.value! };
    }
    return { kind: 'pattern', fieldname: '', pattern: first.value! };
  }
}

// ---------------------------------------------------------------------------------
// Evaluator tree -- port of `generateEvaluator()`'s output (the `ExprNode` tree of
// `AndNode`/`OrNode`/`NotNode`/leaf nodes), built by compiling each `ParsedNode`'s raw
// pattern string into a real `PatternMatcher` once `dottedpath`/`fullstring`/
// `casesensitive` are known (mirrors `generateEvaluator(elems, dottedpath, fullstring,
// casesensitive)` receiving those as separate arguments from `parsePattern()`'s
// flag-independent element list).
// ---------------------------------------------------------------------------------

type EvalNode =
  | { kind: 'const'; value: boolean }
  | { kind: 'and'; left: EvalNode; right: EvalNode }
  | { kind: 'or'; left: EvalNode; right: EvalNode }
  | { kind: 'not'; child: EvalNode }
  | { kind: 'pattern'; fieldname: string; matcher: PatternMatcher };

function compile(node: ParsedNode, dottedpath: boolean, fullstring: boolean, casesensitive: boolean): EvalNode {
  switch (node.kind) {
    case 'and':
      return { kind: 'and', left: compile(node.left, dottedpath, fullstring, casesensitive), right: compile(node.right, dottedpath, fullstring, casesensitive) };
    case 'or':
      return { kind: 'or', left: compile(node.left, dottedpath, fullstring, casesensitive), right: compile(node.right, dottedpath, fullstring, casesensitive) };
    case 'not':
      return { kind: 'not', child: compile(node.child, dottedpath, fullstring, casesensitive) };
    case 'pattern':
      return { kind: 'pattern', fieldname: node.fieldname, matcher: new PatternMatcher(node.pattern, dottedpath, fullstring, casesensitive) };
  }
}

/**
 * Port of `ContextObjectMatchesConstPattern::evaluate()` /
 * `ContextObjectFieldMatchesConstPattern::evaluate()` (leaf evaluation) plus
 * `LogicalInfixOperatorNode::evaluate()` / `NotNode::evaluate()` (short-circuit
 * AND/OR, plain negation) -- collapsed into one recursive evaluator since every leaf
 * here is always boolean (no `UNDEF`/type-check machinery needed, unlike the general
 * expression-evaluator engine `exprnode.h` is shared with).
 */
function evaluate(node: EvalNode, object: Matchable): boolean {
  switch (node.kind) {
    case 'const':
      return node.value;
    case 'and':
      return evaluate(node.left, object) && evaluate(node.right, object);
    case 'or':
      return evaluate(node.left, object) || evaluate(node.right, object);
    case 'not':
      return !evaluate(node.child, object);
    case 'pattern': {
      const text = node.fieldname === '' ? object.getAsString() : object.getAsString(node.fieldname);
      return text === null ? false : node.matcher.matches(text);
    }
  }
}

/** True iff `text` is empty or contains only whitespace -- port of `opp_isblank()`. */
function isBlank(text: string): boolean {
  return /^\s*$/.test(text);
}

// ---------------------------------------------------------------------------------
// MatchExpression
// ---------------------------------------------------------------------------------

/** Port of `MatchExpression`. */
export class MatchExpression {
  private tree: EvalNode | null = null;

  constructor(pattern?: string, dottedpath?: boolean, fullstring?: boolean, casesensitive?: boolean) {
    if (pattern !== undefined) this.setPattern(pattern, dottedpath ?? false, fullstring ?? true, casesensitive ?? true);
  }

  /** Port of `setPattern()`. Throws on a malformed expression (see this file's header for the grammar rules this enforces). */
  setPattern(pattern: string, dottedpath: boolean, fullstring: boolean, casesensitive: boolean): void {
    if (isBlank(pattern)) {
      this.tree = { kind: 'const', value: false };
    } else {
      const parsed = new MatchExpressionParser(pattern).parse();
      this.tree = compile(parsed, dottedpath, fullstring, casesensitive);
    }
  }

  /** Port of `matches()`. */
  matches(object: Matchable): boolean {
    if (this.tree === null) throw new Error('MatchExpression: empty match expression (call setPattern() first)');
    if (object === null || object === undefined) throw new Error('MatchExpression: input is null');
    return evaluate(this.tree, object);
  }
}

// ---------------------------------------------------------------------------------
// MatchableString / MatchableStringMap -- small `Matchable` adapters, ported for
// completeness (not needed by filteredEventLog.ts, which matches directly against
// eventlog entries -- they already expose the right `getAsString(attribute?)` shape).
// ---------------------------------------------------------------------------------

/** Port of `MatchableString`. */
export class MatchableString implements Matchable {
  constructor(private readonly str: string) {}
  getAsString(attribute?: string): string | null {
    return attribute === undefined ? this.str : null;
  }
}

/** Port of `MatchableStringMap`. */
export class MatchableStringMap implements Matchable {
  constructor(
    private readonly defaultValue: string,
    private readonly stringMap: ReadonlyMap<string, string>,
  ) {}
  getAsString(attribute?: string): string | null {
    if (attribute === undefined) return this.defaultValue;
    return this.stringMap.get(attribute) ?? null;
  }
}
