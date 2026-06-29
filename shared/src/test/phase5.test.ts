import { test } from 'node:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { parseExpression, ExprNode } from '../expr/exprParser';
import { inferType } from '../expr/infer';
import { nedValueDiagnostics } from '../ned/nedValueChecks';

test('expression precedence: 2 + 3 * 4', () => {
  const e = parseExpression('2 + 3 * 4') as any;
  assert.equal(e.kind, 'binary');
  assert.equal(e.op, '+');
  assert.equal(e.right.kind, 'binary');
  assert.equal(e.right.op, '*');
});

test('expression precedence: power is right-assoc and tighter than *', () => {
  const e = parseExpression('2 * 3 ^ 4') as any;
  assert.equal(e.op, '*');
  assert.equal(e.right.op, '^');
});

test('type inference', () => {
  assert.equal(inferType(parseExpression('5')).type, 'int');
  assert.equal(inferType(parseExpression('1.5')).type, 'double');
  assert.equal(inferType(parseExpression('1.5ms')).type, 'double');
  assert.equal(inferType(parseExpression('"hello"')).type, 'string');
  assert.equal(inferType(parseExpression('true')).type, 'bool');
  assert.equal(inferType(parseExpression('a < b')).type, 'bool');
  assert.equal(inferType(parseExpression('xmldoc("f.xml")')).type, 'xml');
  assert.equal(inferType(parseExpression('1 + 2')).type, 'int');
  assert.equal(inferType(parseExpression('1 + 2.0')).type, 'double');
  assert.equal(inferType(parseExpression('x + 1')).type, 'unknown'); // param ref
});

// grammar fix: NED's real operators are `##` (logical XOR) and `=~` (match),
// not `^^`/`match`; hex int literals (0xFF) are also valid
test('expression layer: ##, =~ and hex literals', () => {
  assert.equal(inferType(parseExpression('a ## b')).type, 'bool');
  assert.equal(inferType(parseExpression('name =~ "pat*"')).type, 'bool');
  const hex = parseExpression('0xFF') as any;
  assert.equal(hex.kind, 'num');
  assert.equal(hex.value, 255);
  assert.equal(hex.isInt, true);
  assert.equal(inferType(parseExpression('0x10')).type, 'int');
  // `##` binds looser than `&&` (XOR vs AND), mirroring ned2.y precedence
  const e = parseExpression('a && b ## c') as any;
  assert.equal(e.kind, 'binary');
  assert.equal(e.op, '##');
  assert.equal(e.left.op, '&&');
});

test('NED value diagnostics catch clear mismatches', async () => {
  const svc = await getParsers();
  const t = svc.parse('ned', `simple S {
    parameters:
      string s = 5;
      int n = "hello";
      bool b = 3;
      double d = 2.5;
      int ok = 1 + 2;
      double e = x * 2;
  }`);
  const diags = nedValueDiagnostics(t);
  const msgs = diags.map((d) => d.message);
  assert.ok(msgs.some((m) => /to 'string' parameter 's'/.test(m)));
  assert.ok(msgs.some((m) => /to 'int' parameter 'n'/.test(m)));
  assert.ok(msgs.some((m) => /to 'bool' parameter 'b'/.test(m)));
  // d, ok, e are valid -> exactly 3 diagnostics
  assert.equal(diags.length, 3, JSON.stringify(msgs));
});

test('parser does not crash on complex expressions', () => {
  for (const s of [
    'a.b.c[i].d',
    'this.parent.foo',
    'sizeof(gate)',
    'index',
    '(a > 0) ? "x" : "y"',
    'uniform(0, 1s)',
    'default(10)',
    '[1, 2, 3]',
    'Foo { a: 1, b: 2 }',
  ]) {
    const e: ExprNode = parseExpression(s);
    assert.ok(e && e.kind !== 'error', `failed on: ${s}`);
  }
});
