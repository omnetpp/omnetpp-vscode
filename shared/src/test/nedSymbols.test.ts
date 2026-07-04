import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { nedDocumentSymbols } from '../ned/nedSymbols';

const NED = `package a.b;
simple Foo {
  parameters:
    int n = 5;
    double d;
  gates:
    input in;
    output out[];
}
module Net {
  submodules:
    host: Foo;
    r: Foo;
  connections:
    host.out++ --> r.in++;
}
moduleinterface IApp { gates: input g; }`;

test('NED document symbols', async () => {
  const svc = await getParsers();
  const tree = svc.parse('ned', NED);
  const syms = nedDocumentSymbols(tree);
  assert.deepEqual(syms.map((s) => s.name), ['Foo', 'Net', 'IApp']);
  const foo = syms[0];
  assert.deepEqual(foo.children?.filter((c) => c.kind === 7 /*Property*/).map((c) => c.name), ['n', 'd']);
  const gates = foo.children?.filter((c) => c.kind === 8 /*Field*/).map((c) => c.name);
  assert.deepEqual(gates, ['in', 'out[]']);
  const net = syms[1];
  assert.deepEqual(net.children?.map((c) => c.name), ['host', 'r']);
});
