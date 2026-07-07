import { test } from 'bun:test';
import assert from 'node:assert';
import { LineTokenizer, tokenizeLine } from '../../eventlog/lineTokenizer';

test('lineTokenizer: plain space/tab separated tokens', () => {
  assert.deepEqual(tokenizeLine('E 121.1344 e434'), ['E', '121.1344', 'e434']);
});

test('lineTokenizer: consecutive mixed separators collapse, no empty tokens', () => {
  assert.deepEqual(tokenizeLine('a \t\t  b\t c'), ['a', 'b', 'c']);
});

test('lineTokenizer: quoted token containing spaces', () => {
  assert.deepEqual(tokenizeLine('E "121.1344 e434" 222'), ['E', '121.1344 e434', '222']);
});

test('lineTokenizer: quoted token with an escaped quote inside', () => {
  assert.deepEqual(tokenizeLine('a "he said \\"hi\\"" b'), ['a', 'he said "hi"', 'b']);
});

test('lineTokenizer: quoted token with an escaped backslash', () => {
  assert.deepEqual(tokenizeLine('"a\\\\b"'), ['a\\b']);
});

test('lineTokenizer: common escapes \\n \\t \\r inside a quoted token', () => {
  assert.deepEqual(tokenizeLine('"a\\nb\\tc\\rd"'), ['a\nb\tc\rd']);
});

test('lineTokenizer: \\x hex escape', () => {
  assert.deepEqual(tokenizeLine('"\\x41"'), ['A']);
});

test('lineTokenizer: single-hex-digit \\x escape', () => {
  assert.deepEqual(tokenizeLine('"\\x4"'), [String.fromCharCode(4)]);
});

test('lineTokenizer: empty quoted string produces an empty-string token', () => {
  assert.deepEqual(tokenizeLine('a "" b'), ['a', '', 'b']);
});

test('lineTokenizer: unquoted backslash is passed through unchanged', () => {
  assert.deepEqual(tokenizeLine('a\\nb'), ['a\\nb']);
});

test('lineTokenizer: unmatched quote throws', () => {
  assert.throws(() => tokenizeLine('a "unterminated'));
});

test('lineTokenizer: empty line tokenizes to []', () => {
  assert.deepEqual(tokenizeLine(''), []);
});

test('lineTokenizer: line of only separators tokenizes to []', () => {
  assert.deepEqual(tokenizeLine('   \t\t  '), []);
});

test('lineTokenizer: trailing \\r\\n is stripped before tokenizing', () => {
  assert.deepEqual(tokenizeLine('a b\r\n'), ['a', 'b']);
  assert.deepEqual(tokenizeLine('a b\n'), ['a', 'b']);
});

test('lineTokenizer: custom separator characters via the constructor', () => {
  const t = new LineTokenizer(',', ';');
  assert.deepEqual(t.tokenize('a,b;;c,,d'), ['a', 'b', 'c', 'd']);
});

test('lineTokenizer: backslash followed by an actual newline is a line continuation (vanishes)', () => {
  assert.deepEqual(tokenizeLine('"a\\\nb"'), ['ab']);
});

test('lineTokenizer: unrecognized backslash sequence falls back to the literal character', () => {
  assert.deepEqual(tokenizeLine('"a\\z"'), ['az']);
});
