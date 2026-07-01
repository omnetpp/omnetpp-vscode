import { test } from 'bun:test';
import assert from 'node:assert';
import { parseIni, bracketDepth } from '../ini/iniDocument';
import { iniLocalDiagnostics } from '../ini/iniLocalChecks';

test('bracketDepth ignores brackets inside quoted strings', () => {
  assert.equal(bracketDepth('[{a: 1}]'), 0);
  assert.equal(bracketDepth('[{a: 1},'), 1); // one open [, {} balanced
  assert.equal(bracketDepth('expr(udp.destPort == 1441)'), 0);
  assert.equal(bracketDepth('"a ( [ { unbalanced"'), 0); // all inside a string
  assert.equal(bracketDepth('foo("literal )")'), 0); // close paren quoted
});

test('a bracketed array value spans multiple lines without backslashes', () => {
  const doc = parseIni(
    [
      '[General]',
      '*.mapping = [{stream: "A0", packetFilter: expr(udp.destPort == 1440)},',
      '             {stream: "A1", packetFilter: expr(udp.destPort == 1441)},',
      '             {stream: "A2", packetFilter: expr(udp.destPort == 1442)}]',
      '*.other = 5',
    ].join('\n'),
  );
  const gen = doc.sections[0];
  // exactly two entries — the array is ONE entry, not three
  assert.deepEqual(gen.entries.map((e) => e.key), ['*.mapping', '*.other']);
  const mapping = gen.entries[0];
  assert.equal(mapping.line, 1); // 0-based: the `[General]` header is line 0
  assert.equal(mapping.valueRange.end.line, 3); // value spans through the closing `]`
  assert.ok(mapping.value.includes('A2'));
});

test('two multi-line arrays with a shared inner fragment are NOT duplicate keys', () => {
  // Regression: the `==` inside expr(...) used to be read as the key/value
  // separator on each continuation line, yielding bogus duplicate-key errors.
  const doc = parseIni(
    [
      '[General]',
      '*.N2.mapping = [{stream: "Class A1", packetFilter: expr(udp.destPort == 1221)},',
      '                {stream: "Class A2", packetFilter: expr(udp.destPort == 1222)}]',
      '*.N4.mapping = [{stream: "Class A1", packetFilter: expr(udp.destPort == 1441)},',
      '                {stream: "Class A2", packetFilter: expr(udp.destPort == 1442)}]',
    ].join('\n'),
  );
  assert.deepEqual(
    doc.sections[0].entries.map((e) => e.key),
    ['*.N2.mapping', '*.N4.mapping'],
  );
  const dups = iniLocalDiagnostics(doc).filter((d) => d.code === 'duplicate-key');
  assert.deepEqual(dups, []);
});

test('trailing-backslash continuation still works', () => {
  const doc = parseIni('[General]\n*.x = a \\\n    b\n*.y = 2\n');
  const gen = doc.sections[0];
  assert.deepEqual(gen.entries.map((e) => e.key), ['*.x', '*.y']);
  assert.ok(gen.entries[0].value.includes('a'));
  assert.ok(gen.entries[0].value.includes('b'));
});

test('a genuinely duplicated key is still reported', () => {
  const doc = parseIni('[General]\n*.x = 1\n*.x = 2\n');
  const dups = iniLocalDiagnostics(doc).filter((d) => d.code === 'duplicate-key');
  assert.equal(dups.length, 1);
});
