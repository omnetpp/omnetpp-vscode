import { test } from 'bun:test';
import assert from 'node:assert';
import { getParsers } from './helpers';
import { isMsgTypeHeaderLine } from '../msg/msgAst';

async function tree(text: string) {
  return (await getParsers()).parse('msg', text);
}

test('isMsgTypeHeaderLine flags the header line of a single-line type', async () => {
  const t = await tree('message Foo {\n    int x;\n    int y;\n}\n');
  assert.equal(isMsgTypeHeaderLine(t, 0), true); // `message Foo {`
  assert.equal(isMsgTypeHeaderLine(t, 1), false); // a field line
  assert.equal(isMsgTypeHeaderLine(t, 3), false); // the closing `}`
});

test('isMsgTypeHeaderLine spans a header split across the `{`', async () => {
  const t = await tree('message Foo\n{\n    int x;\n}\n');
  assert.equal(isMsgTypeHeaderLine(t, 0), true); // `message Foo`
  assert.equal(isMsgTypeHeaderLine(t, 1), true); // `{`
  assert.equal(isMsgTypeHeaderLine(t, 2), false); // a field line
});

test('isMsgTypeHeaderLine handles multiple types', async () => {
  const t = await tree('message A {\n}\nmessage B {\n    int x;\n}\n');
  assert.equal(isMsgTypeHeaderLine(t, 0), true); // A header
  assert.equal(isMsgTypeHeaderLine(t, 2), true); // B header
  assert.equal(isMsgTypeHeaderLine(t, 3), false); // B field
});
