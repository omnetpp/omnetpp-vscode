/**
 * computeEntryProposals() -- position-aware content-assist for the Event Log Table's
 * Custom-filter expression box (`MatchExpression` syntax, e.g. `BS AND id =~ 10`).
 * Ported from:
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/common/eventlog/
 *     EventLogEntryProposalProvider.java  (the eventlog-specific field-name/entry-type
 *     candidate lists)
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/common/util/
 *     MatchExpressionContentProposalProvider.java  (the position logic: which kind of
 *     proposal applies at a given cursor position, based on the last few tokens before
 *     it)
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/common/util/
 *     MatchExpressionSyntax.java's `Lexer` inner class (the position-tracking tokenizer
 *     content-assist needs -- NOT `shared/src/match/matchExpression.ts`'s lexer, which
 *     has no start/end offsets and exists for actually EVALUATING a match expression
 *     against a `Matchable`, not for editing one; `MatchExpressionSyntax.Lexer` is a
 *     separate, UI-only tokenizer in the Java source for exactly this purpose).
 *
 * GRAMMAR / POSITION RULES (verified by reading the three Java files above, not
 * guessed), given the last few tokens before the cursor:
 *  - empty input, or the last complete token is AND/OR/`(` -> offer: this "scope"'s
 *    entry-type's field names (see below), every known entry-type code, and `NOT`.
 *  - last complete token is `NOT` -> offer: field names + entry-type codes (no `NOT`
 *    this time -- `MatchExpressionSyntax`'s grammar only lets NOT precede one term, so
 *    offering NOT again would build an invalid double-negation).
 *  - last complete token is `)` -> offer: `AND`, `OR`.
 *  - last complete token is `=~` immediately preceded by a STRING_LITERAL (a field
 *    name) -> offer: field VALUE proposals for that field. Upstream's
 *    `EventLogEntryProposalProvider.getFieldValueProposals()` is a no-op (returns an
 *    empty list unconditionally) -- so this port faithfully offers nothing here too.
 *    (The Event Log Table's "flat value hints", `filterHints.ts`, are a UI-layer
 *    enrichment on top of this port, not part of the Java-parity core -- see
 *    `entryTypeSchema.ts`'s header and `client/webview/src/eventlog/table/tableView.ts`
 *    for where that's layered in.)
 *  - last complete token is a STRING_LITERAL:
 *     - and it's the pattern half of a complete `field =~ pattern` (i.e. the two tokens
 *       before it are `=~` and another STRING_LITERAL) -> offer: `AND`, `OR`.
 *     - otherwise (a bare literal, e.g. just-typed `"BS"` with nothing after) -> offer:
 *       `=~ `, `AND`, `OR`. (Grammar ambiguity: at this point the literal could still be
 *       extended into a `field =~ value` construct, or stand alone as a complete
 *       pattern followed by a boolean operator -- both are valid continuations, so both
 *       are offered; this is inherited from the generic base class, not eventlog-
 *       specific.)
 *
 * "Field names" (the schema-driven part) means: find the FIRST standalone
 * STRING_LITERAL token in the text up to the cursor that is NOT immediately followed by
 * `=~` (`getLastDefaultFieldValue()`'s scan, faithfully reproduced including its
 * surprising behavior -- see below), treat its value as an entry-type code, and look up
 * that code's attribute names in `schema`. If no such token exists, or the code isn't a
 * recognized entry type, no field names are offered (only entry-type codes + NOT/AND/
 * OR as applicable).
 *
 * SURPRISING BEHAVIOR PRESERVED FOR PARITY (verified against the Java source, not a
 * bug in this port): `getLastDefaultFieldValue()` returns the FIRST matching token when
 * scanning forward from the START of the text, not the one nearest the cursor. E.g. for
 * `BS AND x =~ 1 OR ES AND <cursor>`, the offered field names are still `BS`'s (the
 * scan finds "BS" first and returns immediately), even though "ES" is the entry type
 * actually closest to the cursor. This is Eclipse's real, shipped behavior.
 *
 * The last-few-tokens lookback also applies Java's "possibly incomplete last token"
 * rule: if the token immediately before the cursor ends exactly at the cursor (no
 * trailing separator yet typed) and is a STRING_LITERAL/AND/OR/NOT, it's treated as the
 * partial word being typed (`prefix`) rather than a complete token, and excluded from
 * the position logic above -- e.g. typing "AN" offers whatever a complete "AND" token
 * would have offered at that position, filtered down to items starting with "AN".
 *
 * Every proposal is then filtered to those whose full replacement text starts with
 * `prefix` case-insensitively (and isn't textually IDENTICAL to it -- matches
 * `ContentProposalProviderBase.filterAndWrapProposals()`'s `content.length() !=
 * prefix.length()` guard, which drops a proposal exactly equal to what's already typed).
 *
 * DEVIATIONS from the Java port (documented, not oversights):
 *  - Only the table's generic (`configuredEntryType == null`) constructor variant is
 *    ported -- `FilterEventLogDialog.java`'s per-field, entry-type-*configured*
 *    constructor (used by other dialogs, not the Event Log Table) is out of scope for
 *    this item.
 *  - `MatchExpressionContentProposalProvider.getLastFewTokens()`'s 1000-char "tail scan"
 *    (`findGoodStartingPoint()`) existed purely so Scave's very long filter strings
 *    wouldn't re-tokenize from byte 0 on every keystroke. The Event Log Table's filter
 *    box is realistically short, so this port always tokenizes the whole prefix --
 *    behavior-identical, just skips that perf shortcut.
 *  - The Java lexer's quoted-string escape handling has its own `TODO: \\ and \" within
 *    patterns` comment and a real int-vs-char `StringBuffer.append()` overload bug (a
 *    backslash escape ends up appending the ESCAPED CHARACTER'S DECIMAL CODE as digits,
 *    not the character) -- i.e. it's flagged upstream as incomplete, not a deliberate
 *    behavior to preserve. This port implements the evidently-INTENDED escape semantics
 *    (`\\` -> `\`, `\"` -> `"`) instead of replicating that bug.
 */

import type { EntryTypeSchema } from './elogProtocol';

// ---------------------------------------------------------------------------------
// Lexer -- position-tracking port of MatchExpressionSyntax.Lexer. Deliberately
// separate from shared/src/match/matchExpression.ts's lexer (see this file's header).
// ---------------------------------------------------------------------------------

type TokenType = 'AND' | 'OR' | 'NOT' | 'MATCHES' | 'STRING_LITERAL' | 'OP' | 'CP' | 'END';

interface Token {
  type: TokenType;
  value: string | null;
  start: number;
  end: number;
}

const KEYWORDS: Record<string, TokenType> = {
  OR: 'OR', or: 'OR',
  AND: 'AND', and: 'AND',
  NOT: 'NOT', not: 'NOT',
};

/** Port of `MatchExpressionSyntax.Lexer`. Tokenizes `text` from `startPos` to its end, one `nextToken()` call at a time (mirrors the Java class's pull-based `getNextToken()`). */
class Lexer {
  private pos: number;

  constructor(private readonly text: string, startPos = 0) {
    this.pos = startPos;
  }

  private charAt(i: number): string | undefined {
    return i < this.text.length ? this.text[i] : undefined;
  }

  nextToken(): Token {
    for (;;) {
      const start = this.pos;
      const ch = this.charAt(this.pos);

      if (ch === undefined) return { type: 'END', value: null, start, end: this.pos };

      if (ch === ' ' || ch === '\n' || ch === '\t') {
        this.pos++;
        continue;
      }
      if (ch === '(') {
        this.pos++;
        return { type: 'OP', value: null, start, end: this.pos };
      }
      if (ch === ')') {
        this.pos++;
        return { type: 'CP', value: null, start, end: this.pos };
      }
      if (ch === '=') {
        const la = this.charAt(this.pos + 1);
        if (la === '~') {
          this.pos += 2;
          return { type: 'MATCHES', value: '=~', start, end: this.pos };
        }
        // A lone '=' at the start of a token is discarded (mirrors the Java lexer's
        // `break` here -- it consumes the char and loops back without emitting a
        // token). Never occurs in well-formed input: '=' is only otherwise meaningful
        // as the first character of '=~'.
        this.pos++;
        continue;
      }
      if (ch === '"') {
        this.pos++;
        let value = '';
        for (;;) {
          const c = this.charAt(this.pos);
          if (c === undefined) return { type: 'STRING_LITERAL', value, start, end: this.pos };
          if (c === '"') {
            this.pos++;
            return { type: 'STRING_LITERAL', value, start, end: this.pos };
          }
          if (c === '\\') {
            const la = this.charAt(this.pos + 1);
            if (la === '\\' || la === '"') {
              value += la;
              this.pos += 2;
            } else {
              value += c;
              this.pos += 1;
            }
          } else {
            value += c;
            this.pos += 1;
          }
        }
      }

      // default: accumulate an unquoted literal / keyword, stopping before whitespace,
      // parens, or a following '=~' (so "field=~pattern", with no spaces, still splits
      // into three tokens).
      let value = ch;
      this.pos++;
      for (;;) {
        const c = this.charAt(this.pos);
        if (c === undefined) break;
        if (c === ' ' || c === '\t' || c === '\n' || c === '(' || c === ')') break;
        if (c === '=') {
          const la = this.charAt(this.pos + 1);
          if (la === '~') break;
          value += c;
          this.pos++;
          continue;
        }
        value += c;
        this.pos++;
      }
      const kw = KEYWORDS[value];
      if (kw) return { type: kw, value, start, end: this.pos };
      return { type: 'STRING_LITERAL', value, start, end: this.pos };
    }
  }
}

function tokenize(text: string): Token[] {
  const lexer = new Lexer(text);
  const tokens: Token[] = [];
  for (;;) {
    const t = lexer.nextToken();
    if (t.type === 'END') break;
    tokens.push(t);
  }
  return tokens;
}

/** Port of `MatchExpressionContentProposalProvider.getLastFewTokens()`, minus the tail-scan perf shortcut (see this file's header). Returns up to `n` tokens immediately before the end of `text`, in REVERSE order (`[0]` is the last one). */
function getLastFewTokensReversed(text: string, n: number): Token[] {
  const tokens = tokenize(text);
  return tokens.slice(Math.max(0, tokens.length - n)).reverse();
}

// ---------------------------------------------------------------------------------
// Proposal computation
// ---------------------------------------------------------------------------------

export interface EntryProposal {
  /** Full text to insert in place of the partial token being typed (already includes any trailing separator, e.g. `"BS "`, `"id =~ "`, `"AND "`). */
  text: string;
  /** Display label (`text` with trailing whitespace trimmed). */
  label: string;
}

/** Which grammar position `computeEntryProposals()` decided the cursor is at -- exposed mainly so a UI layer can fold in extra, non-Java-parity proposals for specific positions (e.g. flat value hints after `field =~`, where the ported logic itself always offers nothing -- see this file's header). */
export type EntryProposalPositionKind = 'expr-start' | 'after-not' | 'after-close-paren' | 'after-matches' | 'after-value';

export interface EntryProposalResult {
  /** Which grammar position produced `proposals` -- see `EntryProposalPositionKind`. */
  positionKind: EntryProposalPositionKind;
  /** Offset (into the original `text`) where a replacement should start, i.e. `cursorOffset` minus however much of the current partial token is being completed. Equals `cursorOffset` when there's no partial token to replace. */
  replaceStart: number;
  /** Always equals `cursorOffset` -- the replaced range never extends past the cursor. */
  replaceEnd: number;
  proposals: EntryProposal[];
}

function makeProposal(content: string): EntryProposal {
  return { text: content, label: content.trim() };
}

const P_AND = makeProposal('AND ');
const P_OR = makeProposal('OR ');
const P_NOT = makeProposal('NOT ');
const P_MATCHES = makeProposal('=~ ');

function byLabel(a: EntryProposal, b: EntryProposal): number {
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

/**
 * Port of `EventLogEntryProposalProvider.getLastDefaultFieldValue()`: scans
 * `textUpToCursor` from the very start and returns the value of the FIRST
 * STRING_LITERAL token that is NOT immediately followed by a MATCHES (`=~`) token --
 * see this file's header for why this is the FIRST such token, not the nearest one to
 * the cursor (a faithfully-preserved upstream quirk). Returns `null` if there is none.
 */
function getLastDefaultFieldValue(textUpToCursor: string): string | null {
  const lexer = new Lexer(textUpToCursor);
  let previous: Token | null = null;
  let current: Token | null = null;
  for (;;) {
    previous = current;
    current = lexer.nextToken();
    if (previous !== null && previous.type === 'STRING_LITERAL' && current.type !== 'MATCHES') return previous.value;
    if (current.type === 'END') return null;
  }
}

/** Port of `EventLogEntryProposalProvider.getFieldNameProposals()`: the "in scope" entry type's attribute names (see `getLastDefaultFieldValue()`), each suffixed `" =~ "`, sorted by label. Empty if there's no entry type in scope, or it isn't recognized. */
function fieldNameProposals(textUpToCursor: string, schema: EntryTypeSchema): EntryProposal[] {
  const entryType = getLastDefaultFieldValue(textUpToCursor);
  const fieldNames = entryType !== null ? schema[entryType] : undefined;
  if (!fieldNames) return [];
  return fieldNames.map((name) => makeProposal(`${name} =~ `)).sort(byLabel);
}

/** Port of `EventLogEntryProposalProvider.getDefaultFieldValueProposals()` (the `configuredEntryType == null` branch, the only one this port implements -- see file header): every known entry-type code, each suffixed a single space, sorted by label. */
function defaultFieldValueProposals(schema: EntryTypeSchema): EntryProposal[] {
  return Object.keys(schema).map((code) => makeProposal(`${code} `)).sort(byLabel);
}

const LOOKBACK = 4;

/**
 * Computes position-aware content-assist proposals for `text`'s MatchExpression
 * grammar at `cursorOffset`, using `schema` (code -> attribute names, e.g. from
 * `entryTypeSchema.ts`'s `buildEntryTypeSchema()`) for the entry-type-code and
 * field-name candidate lists. Pure and host-agnostic -- see this file's header for the
 * full grammar rules ported.
 */
export function computeEntryProposals(text: string, cursorOffset: number, schema: EntryTypeSchema): EntryProposalResult {
  const upToCursor = text.slice(0, cursorOffset);
  let tokens = getLastFewTokensReversed(upToCursor, LOOKBACK);

  let lastType: TokenType | null = tokens.length > 0 ? tokens[0].type : null;
  let prefix = '';
  const possiblyIncomplete =
    tokens.length > 0 &&
    tokens[0].end === cursorOffset &&
    (lastType === 'STRING_LITERAL' || lastType === 'AND' || lastType === 'OR' || lastType === 'NOT');
  if (possiblyIncomplete) {
    prefix = upToCursor.slice(tokens[0].start, tokens[0].end);
    tokens = tokens.slice(1);
    lastType = tokens.length > 0 ? tokens[0].type : null;
  }

  let positionKind: EntryProposalPositionKind;
  const proposals: EntryProposal[] = [];

  if (lastType === null || lastType === 'AND' || lastType === 'OR' || lastType === 'OP') {
    positionKind = 'expr-start';
    proposals.push(...fieldNameProposals(upToCursor, schema));
    proposals.push(...defaultFieldValueProposals(schema));
    proposals.push(P_NOT);
  } else if (lastType === 'NOT') {
    positionKind = 'after-not';
    proposals.push(...fieldNameProposals(upToCursor, schema));
    proposals.push(...defaultFieldValueProposals(schema));
  } else if (lastType === 'CP') {
    positionKind = 'after-close-paren';
    proposals.push(P_AND, P_OR);
  } else if (lastType === 'MATCHES') {
    positionKind = 'after-matches';
    // getFieldValueProposals() is a documented no-op upstream too -- nothing to add
    // here (see this file's header for where a UI layer may enrich this position).
  } else {
    // lastType === 'STRING_LITERAL' (the only remaining case reachable at all -- 'END'
    // can't appear as tokens[0] since tokenize() never emits it).
    positionKind = 'after-value';
    if (tokens.length >= 3 && tokens[1].type === 'MATCHES' && tokens[2].type === 'STRING_LITERAL') {
      proposals.push(P_AND, P_OR);
    } else {
      proposals.push(P_MATCHES, P_AND, P_OR);
    }
  }

  const lowerPrefix = prefix.toLowerCase();
  const filtered = proposals.filter((p) => p.text.toLowerCase().startsWith(lowerPrefix) && p.text.length !== prefix.length);

  return {
    positionKind,
    replaceStart: cursorOffset - prefix.length,
    replaceEnd: cursorOffset,
    proposals: filtered,
  };
}
