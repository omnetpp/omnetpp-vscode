import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import {
  filterSuppressedDiagnostics,
  formatSuppressDirective,
  type SuppressInput,
} from '../diagnostics/suppress';
import { type Diagnostic, DiagnosticSeverity } from '../model/location';

/** A throwaway diagnostic anchored at `line` with the given `code`. */
function d(line: number, code: string): Diagnostic {
  return {
    range: { start: { line, character: 0 }, end: { line, character: 4 } },
    severity: DiagnosticSeverity.Warning,
    message: code,
    code,
  };
}

/** Codes (as `line:code`) that survive filtering. */
function survivors(input: SuppressInput, diags: Diagnostic[]): string[] {
  return filterSuppressedDiagnostics(diags, input).map((x) => `${x.range.start.line}:${x.code}`);
}

async function ned(text: string): Promise<SuppressInput> {
  const tree = (await getParsers()).parse('ned', text);
  return { language: 'ned', text, tree };
}
async function msg(text: string): Promise<SuppressInput> {
  const tree = (await getParsers()).parse('msg', text);
  return { language: 'msg', text, tree };
}
function ini(text: string): SuppressInput {
  return { language: 'ini', text };
}

// ---- NED -----------------------------------------------------------------

test('NED leading //# suppresses the next line, scoped to the code', async () => {
  const input = await ned('//# suppress(duplicate)\nsimple Foo {}\n');
  assert.deepEqual(survivors(input, [d(1, 'duplicate'), d(1, 'other'), d(0, 'duplicate')]), [
    '1:other',
    '0:duplicate',
  ]);
});

test('NED trailing //# suppresses its own line', async () => {
  const input = await ned('simple Foo {} //# suppress(duplicate)\n');
  assert.deepEqual(survivors(input, [d(0, 'duplicate'), d(0, 'other')]), ['0:other']);
});

test('NED suppress() with no code silences everything on the target', async () => {
  const input = await ned('//# suppress()\nsimple Foo {}\n');
  assert.deepEqual(survivors(input, [d(1, 'duplicate'), d(1, 'whatever')]), []);
});

test('NED suppress(a, b) silences several codes', async () => {
  const input = await ned('//# suppress(type-mismatch, duplicate)\nsimple Foo {}\n');
  assert.deepEqual(survivors(input, [d(1, 'duplicate'), d(1, 'type-mismatch'), d(1, 'c')]), ['1:c']);
});

test('NED leading directive skips banner comments and blank lines', async () => {
  const input = await ned('//# suppress(duplicate)\n// a banner\n// more\n\nsimple Foo {}\n');
  assert.deepEqual(survivors(input, [d(4, 'duplicate')]), []);
});

test('NED stacked leading directives union onto the same target', async () => {
  const input = await ned('//# suppress(a)\n//# suppress(b)\nsimple Foo {}\n');
  assert.deepEqual(survivors(input, [d(2, 'a'), d(2, 'b'), d(2, 'c')]), ['2:c']);
});

test('NED plain // comment (not //#) does not suppress', async () => {
  const input = await ned('// suppress(duplicate)\nsimple Foo {}\n');
  assert.deepEqual(survivors(input, [d(1, 'duplicate')]), ['1:duplicate']);
});

test('NED suppress( inside a string literal does not take effect', async () => {
  const input = await ned('simple Foo { @display("//# suppress(duplicate)"); }\n');
  assert.deepEqual(survivors(input, [d(0, 'duplicate')]), ['0:duplicate']);
});

// ---- MSG -----------------------------------------------------------------

test('MSG trailing //# on a field line suppresses that line', async () => {
  const input = await msg('message Foo {\n    int x; //# suppress(duplicate)\n}\n');
  assert.deepEqual(survivors(input, [d(1, 'duplicate'), d(1, 'other')]), ['1:other']);
});

test('MSG leading //# above a type suppresses the type line', async () => {
  const input = await msg('//# suppress(duplicate)\nmessage Foo {\n}\n');
  assert.deepEqual(survivors(input, [d(1, 'duplicate')]), []);
});

test('MSG trailing //# on a TYPE HEADER line is unsupported (documented limitation)', async () => {
  // The MSG grammar drops the trailing comment on a type-header line, so it
  // cannot be seen — the diagnostic survives. Use a leading directive instead.
  const input = await msg('message Foo //# suppress(duplicate)\n{\n}\n');
  assert.deepEqual(survivors(input, [d(0, 'duplicate')]), ['0:duplicate']);
});

// ---- INI -----------------------------------------------------------------

test('INI trailing ### suppresses its own line', () => {
  const input = ini('[General]\n*.x = 5  ### suppress(no-matching-param)\n');
  assert.deepEqual(survivors(input, [d(1, 'no-matching-param'), d(1, 'other')]), ['1:other']);
});

test('INI leading ### suppresses the next key line', () => {
  const input = ini('[General]\n### suppress(no-matching-param)\n*.x = 5\n');
  assert.deepEqual(survivors(input, [d(2, 'no-matching-param')]), []);
});

test('INI trailing ### on a section header suppresses a header-anchored code', () => {
  const input = ini('[Config 1bad]  ### suppress(bad-section-name)\n');
  assert.deepEqual(survivors(input, [d(0, 'bad-section-name')]), []);
});

test('INI ### inside a quoted value does not take effect', () => {
  const input = ini('[General]\n*.x = "a ### suppress(foo)"\n');
  assert.deepEqual(survivors(input, [d(1, 'foo')]), ['1:foo']);
});

test('INI single # and ## comments do not suppress', () => {
  const one = ini('[General]\n*.x = 5  # suppress(foo)\n');
  assert.deepEqual(survivors(one, [d(1, 'foo')]), ['1:foo']);
  const two = ini('[General]\n*.x = 5  ## suppress(foo)\n');
  assert.deepEqual(survivors(two, [d(1, 'foo')]), ['1:foo']);
});

// ---- whitespace / line endings -------------------------------------------

test('CRLF line endings are handled', async () => {
  const input = await ned('//# suppress(duplicate)\r\nsimple Foo {}\r\n');
  assert.deepEqual(survivors(input, [d(1, 'duplicate')]), []);
});

test('tab-indented leading directive targets the tab-indented code line', async () => {
  const input = await ned('module M {\n\t//# suppress(duplicate)\n\tsubmodules:\n}\n');
  assert.deepEqual(survivors(input, [d(2, 'duplicate'), d(2, 'other')]), ['2:other']);
});

// ---- early-out / formatting ----------------------------------------------

test('files without the word "suppress" are returned unchanged (early-out)', async () => {
  const input = await ned('simple Foo {}\n');
  const diags = [d(0, 'duplicate')];
  assert.strictEqual(filterSuppressedDiagnostics(diags, input), diags); // same reference
});

test('formatSuppressDirective uses the right marker per language', () => {
  assert.equal(formatSuppressDirective('ned', 'duplicate'), '//# suppress(duplicate)');
  assert.equal(formatSuppressDirective('msg', 'duplicate'), '//# suppress(duplicate)');
  assert.equal(formatSuppressDirective('ini', 'no-matching-param'), '### suppress(no-matching-param)');
  assert.equal(formatSuppressDirective('ned'), '//# suppress()');
});
