/**
 * Tests for shared/src/match/patternMatcher.ts, ported from
 * omnetpp-dev/src/common/patternmatcher.h/.cc (no Java source; see that file's
 * header). Cases below mirror the pattern syntax documented in patternmatcher.h:
 * '?', '*', '**', char sets/negated sets, numeric ranges ({..} and [..]), escapes,
 * dottedpath mode, fullstring vs substring mode, and case sensitivity.
 */

import { test } from 'bun:test';
import assert from 'node:assert';
import { PatternMatcher } from '../../match/patternMatcher';

function matcher(pattern: string, dottedpath = false, fullstring = true, casesensitive = true): PatternMatcher {
  return new PatternMatcher(pattern, dottedpath, fullstring, casesensitive);
}

// ---------------------------------------------------------------------------------
// '?' / '*' / '**'
// ---------------------------------------------------------------------------------

test('PatternMatcher: "?" matches exactly one arbitrary character (fullstring, non-dottedpath: also matches ".")', () => {
  const m = matcher('a?c');
  assert.ok(m.matches('abc'));
  assert.ok(m.matches('a.c'));
  assert.ok(!m.matches('ac'));
  assert.ok(!m.matches('abbc'));
});

test('PatternMatcher: "?" in dottedpath mode does not match "."', () => {
  const m = matcher('a?c', true);
  assert.ok(m.matches('abc'));
  assert.ok(!m.matches('a.c'));
});

test('PatternMatcher: "*" (non-dottedpath) matches zero or more of any character, including "."', () => {
  const m = matcher('a*c');
  assert.ok(m.matches('ac'));
  assert.ok(m.matches('abc'));
  assert.ok(m.matches('a.b.c'));
});

test('PatternMatcher: "*" (dottedpath mode) cannot cross a "." -- only "**" can', () => {
  const single = matcher('*.foo', true);
  assert.ok(single.matches('node.foo'));
  assert.ok(!single.matches('node.sub.foo')); // '*' can't eat the extra dot
  const double = matcher('**.foo', true);
  assert.ok(double.matches('node.foo'));
  assert.ok(double.matches('node.sub.sub2.foo'));
  assert.ok(double.matches('.foo')); // ** may also match zero components
});

test('PatternMatcher: "**" (non-dottedpath) behaves exactly like "*" (no dots to treat specially)', () => {
  const m = matcher('**.foo');
  assert.ok(m.matches('node.sub.foo'));
});

test('PatternMatcher: substring (fullstring=false) wraps the pattern in "**" at both ends', () => {
  const m = matcher('tev', false, false);
  assert.ok(m.matches('whatever'));
  assert.ok(!matcher('tev', false, true).matches('whatever'));
});

// ---------------------------------------------------------------------------------
// character sets / negated sets
// ---------------------------------------------------------------------------------

test('PatternMatcher: character set {a-z} / enumeration', () => {
  const m = matcher('node{_a-zA-Z0-9}');
  assert.ok(m.matches('nodeA'));
  assert.ok(m.matches('node5'));
  assert.ok(m.matches('node_'));
  assert.ok(!m.matches('node-'));
});

test('PatternMatcher: negated set {^a-z}', () => {
  const m = matcher('x{^a-z}');
  assert.ok(m.matches('x5'));
  assert.ok(m.matches('xA'));
  assert.ok(!m.matches('xa'));
  assert.ok(!m.matches('xz'));
});

test('PatternMatcher: including "-" or "}" in a set via positioning rules', () => {
  const trailingDash = matcher('{a-z-}');
  assert.ok(trailingDash.matches('a'));
  assert.ok(trailingDash.matches('-'));
  assert.ok(!trailingDash.matches('A'));

  const leadingBrace = matcher('{}a-z}');
  assert.ok(leadingBrace.matches('}'));
  assert.ok(leadingBrace.matches('m'));
});

test('PatternMatcher: case-insensitive set matching', () => {
  const m = matcher('{a-z}', false, true, false);
  assert.ok(m.matches('A'));
  assert.ok(m.matches('a'));
});

test('PatternMatcher: unmatched "{" throws', () => {
  assert.throws(() => matcher('{a-z'));
});

// ---------------------------------------------------------------------------------
// numeric ranges: {lo..up} and [lo..up]
// ---------------------------------------------------------------------------------

test('PatternMatcher: numeric range {38..150} -- boundary values', () => {
  const m = matcher('node{38..150}');
  assert.ok(m.matches('node38'));
  assert.ok(m.matches('node150'));
  assert.ok(m.matches('node99'));
  assert.ok(!m.matches('node37'));
  assert.ok(!m.matches('node151'));
});

test('PatternMatcher: numeric range with non-numeric input does not match', () => {
  const m = matcher('node{38..150}');
  assert.ok(!m.matches('nodeXY'));
  assert.ok(!m.matches('node'));
});

test('PatternMatcher: numeric range with one side omitted', () => {
  assert.ok(matcher('{10..}').matches('10'));
  assert.ok(matcher('{10..}').matches('99999'));
  assert.ok(!matcher('{10..}').matches('9'));
  assert.ok(matcher('{..99}').matches('0'));
  assert.ok(matcher('{..99}').matches('99'));
  assert.ok(!matcher('{..99}').matches('100'));
});

test('PatternMatcher: numeric range with both sides omitted matches any digit run', () => {
  const m = matcher('{..}');
  assert.ok(m.matches('0'));
  assert.ok(m.matches('123456789'));
  assert.ok(!m.matches('abc'));
});

test('PatternMatcher: bracketed numeric range [38..150], e.g. "node[38..150]" matching "node[99]"', () => {
  const m = matcher('node[38..150]');
  assert.ok(m.matches('node[99]'));
  assert.ok(!m.matches('node[200]'));
  assert.ok(!m.matches('node99')); // brackets are literal here, not just delimiters
});

test('PatternMatcher: caveat from the class doc -- "*{17..19}" also matches numbers with 17..19 as a substring at the end', () => {
  const m = matcher('*{17..19}');
  assert.ok(m.matches('a17'));
  assert.ok(m.matches('117'));
  assert.ok(m.matches('963217'));
});

// ---------------------------------------------------------------------------------
// escapes
// ---------------------------------------------------------------------------------

test('PatternMatcher: backslash escape removes special meaning of "?", "*", "{"', () => {
  assert.ok(matcher('a\\?c').matches('a?c'));
  assert.ok(!matcher('a\\?c').matches('abc'));
  assert.ok(matcher('a\\*c').matches('a*c'));
  assert.ok(matcher('a\\{c').matches('a{c'));
});

// ---------------------------------------------------------------------------------
// case sensitivity (outside of sets, already covered above)
// ---------------------------------------------------------------------------------

test('PatternMatcher: case-insensitive literal matching', () => {
  const m = matcher('StandardHost*', false, true, false);
  assert.ok(m.matches('standardhost5'));
  assert.ok(m.matches('STANDARDHOST5'));
  assert.ok(!matcher('StandardHost*', false, true, true).matches('standardhost5'));
});

// ---------------------------------------------------------------------------------
// containsWildcards / str()
// ---------------------------------------------------------------------------------

test('PatternMatcher.containsWildcards()', () => {
  assert.ok(PatternMatcher.containsWildcards('a*b'));
  assert.ok(PatternMatcher.containsWildcards('a?b'));
  assert.ok(PatternMatcher.containsWildcards('a{1..2}'));
  assert.ok(PatternMatcher.containsWildcards('a\\b'));
  assert.ok(!PatternMatcher.containsWildcards('plain'));
});

test('PatternMatcher.str() round-trips a plain literal', () => {
  assert.equal(matcher('hello').str(), 'hello');
});

test('PatternMatcher.str(): a single "*" in non-dottedpath mode is internally ANYSEQ, so it prints back as "**" (dottedpath mode round-trips "*" as-is)', () => {
  assert.equal(matcher('a*b?c').str(), 'a**b?c');
  assert.equal(matcher('a*b?c', true).str(), 'a*b?c');
});

// ---------------------------------------------------------------------------------
// patternPrefixMatches()
// ---------------------------------------------------------------------------------

test('PatternMatcher.patternPrefixMatches(): finds entries that can expand a given prefix+suffix', () => {
  // dottedpath=true: this is the cIniFile use case from the class doc comment (matching
  // module-parameter-style keys, where a single "*" cannot cross a "."). Avoids the
  // doMatch() ANYSEQ end-of-pattern shortcut, which does not account for `suffixlen`
  // (see patternMatcher.ts's ANYSEQ case) and would give the wrong answer for a
  // dottedpath=false single "*" landing exactly on that shortcut's position.
  const m = matcher('**.host*.gen.rng-1', true);
  const rest = m.patternPrefixMatches('net.host1.gen.rng-', 13); // suffix starts at ".rng-"
  assert.equal(rest, '1');
});

test('PatternMatcher.patternPrefixMatches(): returns null when the pattern does not end in a literal, or when it cannot match', () => {
  assert.equal(matcher('**.host*').patternPrefixMatches('net.host1.', 5), null);
  assert.equal(matcher('**.host*.gen.rng-1').patternPrefixMatches('completely.different', 5), null);
});
