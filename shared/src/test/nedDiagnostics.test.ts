import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { nedLocalDiagnostics } from '../ned/nedLocalChecks';
import { syntaxDiagnostics } from '../features/syntaxDiagnostics';
import { nedValueDiagnostics } from '../ned/nedValueChecks';

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

test('NED object/array literals: one key-value pair, trailing commas, multi-line', async () => {
  const svc = await getParsers();
  const text = `simple S {
  parameters:
    object a = {"k": "v"};
    object b = {k: 1,};
    object c = [1, 2,];
    object d = {
        "outer": {"inner": [1, 2,]},
    };
}
module M {
  submodules:
    s: S {
      parameters:
        a = {"ethernetmac": "ethIf"};
    }
}`;
  const tree = svc.parse('ned', text);
  assert.deepEqual(syntaxDiagnostics(tree), []);
  assert.deepEqual(nedLocalDiagnostics(tree), []);
  assert.deepEqual(nedValueDiagnostics(tree), []);
});
