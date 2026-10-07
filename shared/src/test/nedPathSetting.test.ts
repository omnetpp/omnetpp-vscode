import { afterAll, test } from 'bun:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJsonc, stripJsonc } from '../project/jsonc';
import { readNedPathSetting, resolveNedPath } from '../node/nedPathSetting';

const tmp = mkdtempSync(join(tmpdir(), 'nedpathsetting-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function project(name: string, settings?: string): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, '.vscode'), { recursive: true });
  if (settings !== undefined) writeFileSync(join(dir, '.vscode', 'settings.json'), settings);
  return dir;
}

test('parseJsonc accepts comments and trailing commas', () => {
  const text = `{
    // line comment
    "a": "x // not a comment", /* block
    comment */ "b": [1, 2,],
    "c": "/* kept */", // trailing comment
  }`;
  assert.deepEqual(parseJsonc(text), { a: 'x // not a comment', b: [1, 2], c: '/* kept */' });
});

test('stripJsonc keeps escaped quotes inside strings and preserves line numbers', () => {
  const text = '{ "a": "q\\" // still string", /* x\ny */ "b": 1 }';
  assert.deepEqual(JSON.parse(stripJsonc(text)), { a: 'q" // still string', b: 1 });
  assert.equal(stripJsonc(text).split('\n').length, 2);
});

test('parseJsonc rejects malformed input', () => {
  assert.throws(() => parseJsonc('{ "a": }'), SyntaxError);
});

test('readNedPathSetting reads omnetpp.nedPath from .vscode/settings.json', () => {
  const dir = project('withSetting', '{\n  // libraries\n  "omnetpp.nedPath": "../inet/src;lib",\n}\n');
  assert.equal(readNedPathSetting(dir), '../inet/src;lib');
});

test('readNedPathSetting returns empty for a missing file, a missing key, or bad JSON', () => {
  assert.equal(readNedPathSetting(project('noFile')), '');
  assert.equal(readNedPathSetting(project('noKey', '{ "editor.tabSize": 2 }')), '');
  assert.equal(readNedPathSetting(project('notString', '{ "omnetpp.nedPath": 3 }')), '');
  assert.equal(readNedPathSetting(project('broken', '{ "omnetpp.nedPath": ')), '');
});

test.skipIf(process.platform === 'win32')('resolveNedPath makes relative entries absolute against the base dir', () => {
  assert.equal(resolveNedPath('../inet/src; /abs/lib', '/w/proj'), '/w/inet/src;/abs/lib');
  assert.equal(resolveNedPath('', '/w/proj'), '');
});
