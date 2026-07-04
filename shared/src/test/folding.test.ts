import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { treeFoldingRanges } from '../features/folding';

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

test('NED folding ranges include type and sections', async () => {
  const svc = await getParsers();
  const tree = svc.parse('ned', NED);
  const ranges = treeFoldingRanges(tree);
  // at least: Foo, parameters, gates, Net, submodules, connections, IApp...
  assert.ok(ranges.length >= 5);
});
