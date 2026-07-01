import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { paramInfo } from '../ned/nedAst';
import type { Node as SyntaxNode } from 'web-tree-sitter';

/** Parse one NED type body and return the first parameter's info. */
async function firstParam(src: string) {
  const tree = (await getParsers()).parse('ned', src);
  let param: SyntaxNode | null = null;
  const visit = (n: SyntaxNode) => {
    if (param) return;
    if (n.type === 'parameter') { param = n; return; }
    for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i)!);
  };
  visit(tree.rootNode);
  assert.ok(param, 'no parameter node found');
  return paramInfo(param);
}

test('@enum members with parentheses inside quotes are parsed intact', async () => {
  const info = await firstParam(
    'simple Foo {\n  parameters:\n    string modeSet @enum("a","b","g(erp)","g(mixed)","n(mixed-2.4Ghz)","p","ac") = default("g(mixed)");\n}\n',
  );
  assert.deepEqual(info.enumValues, ['a', 'b', 'g(erp)', 'g(mixed)', 'n(mixed-2.4Ghz)', 'p', 'ac']);
});

test('@enum with commas inside quotes are not split', async () => {
  const info = await firstParam(
    'simple Foo {\n  parameters:\n    string s @enum("a,b", "c") = default("c");\n}\n',
  );
  assert.deepEqual(info.enumValues, ['a,b', 'c']);
});

test('plain @enum still parses', async () => {
  const info = await firstParam(
    'simple Foo {\n  parameters:\n    string s @enum("x", "y", "z");\n}\n',
  );
  assert.deepEqual(info.enumValues, ['x', 'y', 'z']);
});

test('a parameter without @enum has no enumValues', async () => {
  const info = await firstParam('simple Foo {\n  parameters:\n    string s = default("x");\n}\n');
  assert.equal(info.enumValues, undefined);
});
