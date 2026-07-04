import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { msgDocumentSymbols } from '../msg/msgSymbols';

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
