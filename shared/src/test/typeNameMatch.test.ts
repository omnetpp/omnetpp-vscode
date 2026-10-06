import { test } from 'bun:test';
import assert from 'node:assert';
import { matchNedTypeName } from '../protocol';

const TYPES = ['inet.node.Router', 'inet.node.ethernet.Eth', 'other.Router', 'Standalone'];

test('an exact fq-name wins, even over a simple name it shares', () => {
  assert.deepEqual(matchNedTypeName('other.Router', TYPES), { kind: 'exact', fqName: 'other.Router' });
  assert.deepEqual(matchNedTypeName('Standalone', TYPES), { kind: 'exact', fqName: 'Standalone' });
});

test('a unique simple name matches case-insensitively', () => {
  assert.deepEqual(matchNedTypeName('eth', TYPES), { kind: 'unique', fqName: 'inet.node.ethernet.Eth' });
});

test('a simple name shared by several packages is ambiguous, never resolved silently', () => {
  assert.deepEqual(matchNedTypeName('router', TYPES), { kind: 'ambiguous', fqNames: ['inet.node.Router', 'other.Router'] });
});

test('no matching type', () => {
  assert.deepEqual(matchNedTypeName('Switch', TYPES), { kind: 'none' });
  assert.deepEqual(matchNedTypeName('node.Router', TYPES), { kind: 'none' });
});
