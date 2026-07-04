import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { nedLocalDiagnostics } from '../ned/nedLocalChecks';
import { syntaxDiagnostics } from '../features/syntaxDiagnostics';

test('NED local diagnostics: duplicate param', async () => {
  const svc = await getParsers();
  const tree = svc.parse('ned', 'simple A { parameters: int x; int x; }');
  const diags = nedLocalDiagnostics(tree);
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /Duplicate parameter 'x'/);
});

test('NED syntax diagnostics on malformed input', async () => {
  const svc = await getParsers();
  const tree = svc.parse('ned', 'simple A { parameters: int n = ; }');
  assert.ok(syntaxDiagnostics(tree).length >= 1);
});
