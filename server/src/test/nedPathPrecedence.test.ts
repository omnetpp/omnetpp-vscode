import { afterAll, test } from 'bun:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { effectiveNedPath } from '../commandLine';

const tmp = mkdtempSync(join(tmpdir(), 'nedpath-precedence-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const proj = join(tmp, 'proj');
mkdirSync(join(proj, '.vscode'), { recursive: true });
writeFileSync(join(proj, '.vscode', 'settings.json'), '{ "omnetpp.nedPath": "../inet/src" }');

test('the editor value wins and is resolved against the project dir', () => {
  assert.equal(effectiveNedPath('lib', { nedPath: '/cli' }, proj), resolve(proj, 'lib'));
});

test('without an editor value the command line wins over the settings file', () => {
  assert.equal(effectiveNedPath('', { nedPath: '/cli' }, proj), '/cli');
  assert.equal(effectiveNedPath(undefined, { nedPath: '/cli' }, proj), '/cli');
});

test('the settings file is the last fallback, relative to the project dir', () => {
  assert.equal(effectiveNedPath(undefined, { nedPath: '' }, proj), resolve(tmp, 'inet', 'src'));
  assert.equal(effectiveNedPath(undefined, { nedPath: '' }, join(tmp, 'other')), '');
});
