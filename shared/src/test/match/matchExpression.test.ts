/**
 * Tests for shared/src/match/matchExpression.ts, ported from
 * omnetpp-dev/src/common/matchexpression.h/.cc + matchexpression.y +
 * matchexpressionlexer.h/.cc (no Java source; see that file's header for the grammar
 * decisions this suite verifies: no implicit AND, AND binds tighter than OR, NOT binds
 * to a single term only, case-insensitive keywords, malformed expressions throw).
 */

import { test } from 'bun:test';
import assert from 'node:assert';
import { MatchExpression, MatchableString } from '../../match/matchExpression';

function matches(pattern: string, text: string, dottedpath = false, fullstring = true, casesensitive = true): boolean {
  const expr = new MatchExpression(pattern, dottedpath, fullstring, casesensitive);
  return expr.matches(new MatchableString(text));
}

// ---------------------------------------------------------------------------------
// basics: implicit default field pattern, blank pattern
// ---------------------------------------------------------------------------------

test('MatchExpression: a bare pattern matches the default field', () => {
  assert.ok(matches('node*', 'node5'));
  assert.ok(!matches('node*', 'host5'));
});

test('MatchExpression: an empty (or whitespace-only) pattern matches nothing', () => {
  assert.ok(!matches('', 'anything'));
  assert.ok(!matches('   ', 'anything'));
});

test('MatchExpression: quoted string literal with escapes', () => {
  assert.ok(matches('"node\\ttab"', 'node\ttab'));
});

// ---------------------------------------------------------------------------------
// field =~ pattern
// ---------------------------------------------------------------------------------

class Fielded extends MatchableString {
  constructor(
    private readonly fields: Record<string, string>,
    defaultValue: string,
  ) {
    super(defaultValue);
  }
  override getAsString(attribute?: string): string | null {
    if (attribute === undefined) return super.getAsString();
    return this.fields[attribute] ?? null;
  }
}

test('MatchExpression: field =~ pattern matches a named field, not the default field', () => {
  const obj = new Fielded({ className: 'StandardHost' }, 'myHost');
  // sanity: a plain MatchableString has no "className" field, so "className=~*" never matches it
  assert.ok(!matches('className=~*', 'myHost'));
  const expr = new MatchExpression('className=~StandardHost*', false, true, true);
  assert.ok(expr.matches(obj));
  const expr2 = new MatchExpression('className=~Router*', false, true, true);
  assert.ok(!expr2.matches(obj));
});

test('MatchExpression: an unknown field (getAsString returns null) never matches', () => {
  const obj = new Fielded({}, 'default');
  const expr = new MatchExpression('missingField=~*', false, true, true);
  assert.ok(!expr.matches(obj));
});

// ---------------------------------------------------------------------------------
// AND / OR / NOT / precedence / parens
// ---------------------------------------------------------------------------------

test('MatchExpression: "or" combines two patterns', () => {
  assert.ok(matches('node* or host*', 'host7'));
  assert.ok(matches('node* or host*', 'node7'));
  assert.ok(!matches('node* or host*', 'router7'));
});

test('MatchExpression: "and" combines two patterns', () => {
  const obj = new Fielded({ className: 'PPPFrame' }, 'packet-42');
  const expr = new MatchExpression('packet-* and className=~PPPFrame', false, true, true);
  assert.ok(expr.matches(obj));
  const expr2 = new MatchExpression('packet-* and className=~TCPSegment', false, true, true);
  assert.ok(!expr2.matches(obj));
});

test('MatchExpression: AND binds tighter than OR ("a or b and c" == "a or (b and c)")', () => {
  const obj = new Fielded({ k: 'yes' }, 'nomatch');
  // "a" matches default field directly; want to see AND grouped with the *second* operand of OR
  const expr = new MatchExpression('nevermatches* or k=~yes and stillmatches*', false, true, true);
  // k=~yes is true, but "stillmatches*" does not match the default field "nomatch" -> AND is false -> OR is false
  assert.ok(!expr.matches(obj));
  const objDefault = new Fielded({ k: 'yes' }, 'stillmatchesXYZ');
  assert.ok(expr.matches(objDefault));
});

test('MatchExpression: "not" negates a single term', () => {
  assert.ok(matches('not node*', 'host7'));
  assert.ok(!matches('not node*', 'node7'));
});

test('MatchExpression: "not a and b" == "(not a) and b", not "not (a and b)"', () => {
  const obj = new Fielded({ k: 'yes' }, 'nodeX');
  // (not "nodeX") is false -> AND with anything is false
  const expr = new MatchExpression('not node* and k=~yes', false, true, true);
  assert.ok(!expr.matches(obj));
  const obj2 = new Fielded({ k: 'yes' }, 'hostX');
  assert.ok(expr.matches(obj2)); // not "hostX" matches "node*" -> true, and k=~yes -> true
});

test('MatchExpression: parentheses override precedence', () => {
  const objBothFalseDefault = new Fielded({ k: 'no' }, 'nodeX');
  const grouped = new MatchExpression('not (node* and k=~yes)', false, true, true);
  // node* matches, k=~yes doesn't -> inner AND is false -> NOT true
  assert.ok(grouped.matches(objBothFalseDefault));
  const objBothTrue = new Fielded({ k: 'yes' }, 'nodeX');
  assert.ok(!grouped.matches(objBothTrue));
});

test('MatchExpression: double "not" requires parentheses ("not not a" is a parse error; "not (not a)" works)', () => {
  assert.throws(() => new MatchExpression('not not node*', false, true, true));
  assert.ok(matches('not (not node*)', 'node5'));
  assert.ok(!matches('not (not node*)', 'host5'));
});

test('MatchExpression: AND/OR/NOT keywords are case-insensitive', () => {
  assert.ok(matches('node* OR host*', 'host1'));
  assert.ok(matches('node* And node*', 'node1') === true);
  assert.ok(matches('NOT node*', 'host1'));
});

test('MatchExpression: keyword-like text is only recognized when the ENTIRE unquoted token matches ("android" is a literal, not "and" + "roid")', () => {
  assert.ok(matches('android', 'android'));
  assert.ok(!matches('android', 'somethingelse'));
});

// ---------------------------------------------------------------------------------
// realistic multi-clause examples straight from the class doc comment
// ---------------------------------------------------------------------------------

test('MatchExpression: "className=~TCPSegment and not kind=~{0..2} and SYN or data-*" example from the doc comment', () => {
  const expr = new MatchExpression('className=~TCPSegment and not kind=~{0..2} and SYN or data-*', false, true, true);
  const tcpSynLikeName = new Fielded({ className: 'TCPSegment', kind: '5' }, 'SYN');
  assert.ok(expr.matches(tcpSynLikeName));
  const dataPacket = new Fielded({ className: 'IPDatagram' }, 'data-42');
  assert.ok(expr.matches(dataPacket)); // matches via "or data-*"
  const tcpButExcludedKind = new Fielded({ className: 'TCPSegment', kind: '1' }, 'SYN');
  assert.ok(!expr.matches(tcpButExcludedKind)); // kind is in {0..2} -> "not kind=~{0..2}" is false -> whole AND chain false, and default field isn't "data-*"
});

// ---------------------------------------------------------------------------------
// malformed expressions throw
// ---------------------------------------------------------------------------------

test('MatchExpression: malformed expressions throw', () => {
  assert.throws(() => new MatchExpression('(node*', false, true, true)); // unbalanced paren
  assert.throws(() => new MatchExpression('node*)', false, true, true)); // stray closing paren
  assert.throws(() => new MatchExpression('and node*', false, true, true)); // leading operator
  assert.throws(() => new MatchExpression('node* and', false, true, true)); // trailing operator
  assert.throws(() => new MatchExpression('node* host*', false, true, true)); // no implicit AND -- trailing garbage
  assert.throws(() => new MatchExpression('()', false, true, true)); // empty group
});

test('MatchExpression: dottedpath/fullstring/casesensitive flags are threaded through to the underlying PatternMatcher', () => {
  assert.ok(matches('**.foo', 'a.b.foo', true, true, true));
  assert.ok(!matches('*.foo', 'a.b.foo', true, true, true));
  assert.ok(matches('tev', 'whatever', false, false, true));
  assert.ok(!matches('tev', 'whatever', false, true, true));
  assert.ok(matches('NODE*', 'node5', false, true, false));
});
