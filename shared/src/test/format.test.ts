import { test } from 'bun:test';
import assert from 'node:assert';
import { formatBraceIndent } from '../features/format';

test('formatter re-indents by brace depth', () => {
  const messy = `module M {
parameters:
int n = 1;
submodules:
host: Foo {
}
}`;
  const out = formatBraceIndent(messy, { tabSize: 4, insertSpaces: true });
  const lines = out.split('\n');
  assert.equal(lines[0], 'module M {');
  assert.equal(lines[1], '    parameters:');
  assert.equal(lines[2], '    int n = 1;');
  assert.equal(lines[4], '    host: Foo {');
  assert.equal(lines[5], '    }');
  assert.equal(lines[6], '}');
});

test('formatter preserves strings and is idempotent', () => {
  const src = 'simple A {\n    parameters:\n    string s = "a{b}c";\n}';
  const once = formatBraceIndent(src, { tabSize: 4, insertSpaces: true });
  const twice = formatBraceIndent(once, { tabSize: 4, insertSpaces: true });
  assert.equal(once, twice);
  assert.match(once, /"a\{b\}c"/);
});
