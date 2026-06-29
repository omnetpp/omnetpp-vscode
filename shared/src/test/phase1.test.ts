import { test } from 'node:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { nedDocumentSymbols } from '../ned/nedSymbols';
import { msgDocumentSymbols } from '../msg/msgSymbols';
import { nedLocalDiagnostics } from '../ned/nedLocalChecks';
import { syntaxDiagnostics } from '../features/syntaxDiagnostics';
import { treeFoldingRanges } from '../features/folding';
import { parseIni } from '../ini/iniDocument';
import { iniDocumentSymbols } from '../ini/iniSymbols';
import { iniLocalDiagnostics } from '../ini/iniLocalChecks';

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

test('NED folding ranges include type and sections', async () => {
  const svc = await getParsers();
  const tree = svc.parse('ned', NED);
  const ranges = treeFoldingRanges(tree);
  // at least: Foo, parameters, gates, Net, submodules, connections, IApp...
  assert.ok(ranges.length >= 5);
});

test('MSG document symbols', async () => {
  const svc = await getParsers();
  const tree = svc.parse('msg', 'packet P extends cPacket { int seq; double t; }\nenum E { A=1; B=2; }');
  const syms = msgDocumentSymbols(tree);
  assert.deepEqual(syms.map((s) => s.name), ['P', 'E']);
  assert.deepEqual(syms[0].children?.map((c) => c.name), ['seq', 't']);
  assert.deepEqual(syms[1].children?.map((c) => c.name), ['A', 'B']);
});

// grammar adds property_key/property_value nodes; surface @properties in the outline
test('MSG document symbols include @properties', async () => {
  const svc = await getParsers();
  const tree = svc.parse(
    'msg',
    'message Foo {\n  @customize(true);\n  @display("i=block/cog");\n  int len;\n}',
  );
  const syms = msgDocumentSymbols(tree);
  const props = syms[0].children?.filter((c) => c.name.startsWith('@'));
  assert.deepEqual(props?.map((c) => c.name), ['@customize', '@display']);
  const display = props?.find((c) => c.name === '@display');
  assert.equal(display?.detail, '"i=block/cog"');
});

test('INI parsing, symbols and duplicate-key check', () => {
  const ini = `network = Foo
[Config Base]
sim-time-limit = 10s
[Config Run1]
extends = Base
**.app.typename = "X"
**.app.typename = "Y"`;
  const doc = parseIni(ini);
  assert.deepEqual(doc.sections.map((s) => s.rawName), ['General', 'Config Base', 'Config Run1']);
  const run1 = doc.sections[2];
  assert.deepEqual(run1.extends, ['Base']);
  const syms = iniDocumentSymbols(doc);
  assert.equal(syms.length, 3);
  const diags = iniLocalDiagnostics(doc);
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /Duplicate key/);
});
