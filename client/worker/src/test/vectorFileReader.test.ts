import { test } from 'bun:test';
import assert from 'node:assert';
import { listVectors, parseColumns, parseEnumAttr, readVector, tokenizeVecLine, vectorValueIndex, vectorValueText } from '../vectorFileReader';

// A small hand-written .vec covering: run-level metadata, an ETV enum vector (id 0) and a
// TV double vector (id 1) with a quoted module name, and interleaved data lines.
const VEC = [
  'version 3',
  'run PureAloha1-0-20260501',
  'attr network Aloha',
  '',
  'vector 0 Aloha.server serverState:vector ETV',
  'attr enum "IDLE=0,TRANSMISSION=1,COLLISION=2"',
  'attr type enum',
  'vector 1 "Aloha.host[0]" radioDelay:vector TV',
  'attr type double',
  '0\t2\t0.223894237036\t1',
  '1\t0.25\t0.5',
  '0\t4\t0.251750941818\t2',
  '1\t0.40\t0.75',
  '0\t7\t0.300000000000\t0',
].join('\n');

test('tokenizeVecLine splits on whitespace and honours double-quoted spans + escapes', () => {
  assert.deepStrictEqual(tokenizeVecLine('vector 1 "Aloha.host[0]" radioDelay:vector TV'), ['vector', '1', 'Aloha.host[0]', 'radioDelay:vector', 'TV']);
  assert.deepStrictEqual(tokenizeVecLine('attr enum "IDLE=0,BUSY=1"'), ['attr', 'enum', 'IDLE=0,BUSY=1']);
  assert.deepStrictEqual(tokenizeVecLine('a "b c" d'), ['a', 'b c', 'd']);
  assert.deepStrictEqual(tokenizeVecLine('x "a\\"b"'), ['x', 'a"b']);
  assert.deepStrictEqual(tokenizeVecLine('0\t2\t0.22\t1'), ['0', '2', '0.22', '1']);
});

test('parseColumns maps the columnSpec letters to field positions', () => {
  const etv = parseColumns('ETV');
  assert.deepStrictEqual([etv.eventIndex, etv.timeIndex, etv.valueIndex], [0, 1, 2]);
  const tv = parseColumns('TV');
  assert.deepStrictEqual([tv.eventIndex, tv.timeIndex, tv.valueIndex], [-1, 0, 1]);
});

test('parseEnumAttr parses NAME=value pairs into a value->name map', () => {
  const m = parseEnumAttr('IDLE=0,TRANSMISSION=1,COLLISION=2');
  assert.strictEqual(m.get(0), 'IDLE');
  assert.strictEqual(m.get(1), 'TRANSMISSION');
  assert.strictEqual(m.get(2), 'COLLISION');
  assert.strictEqual(m.size, 3);
});

test('listVectors returns declarations (id/module/name/columns), attrs (type/enum), and runs', () => {
  const { runs, vectors } = listVectors(VEC);
  assert.deepStrictEqual(runs, ['PureAloha1-0-20260501']);
  assert.strictEqual(vectors.length, 2);

  const v0 = vectors.find((v) => v.id === 0)!;
  assert.strictEqual(v0.module, 'Aloha.server');
  assert.strictEqual(v0.name, 'serverState:vector');
  assert.strictEqual(v0.columns.spec, 'ETV');
  assert.strictEqual(v0.type, 'enum');
  assert.strictEqual(v0.enum?.get(1), 'TRANSMISSION');

  const v1 = vectors.find((v) => v.id === 1)!;
  assert.strictEqual(v1.module, 'Aloha.host[0]'); // quoted name unquoted
  assert.strictEqual(v1.columns.spec, 'TV');
  assert.strictEqual(v1.type, 'double');
  assert.strictEqual(v1.enum, null);
});

test('readVector loads only the requested vector, decoding columns per its spec (ETV)', () => {
  const data = readVector(VEC, 0)!;
  assert.strictEqual(data.info.type, 'enum');
  assert.strictEqual(data.samples.length, 3, 'three id-0 data lines, id-1 lines skipped');
  assert.deepStrictEqual(data.samples[0], { eventNumber: 2, simtime: 0.223894237036, value: 1 });
  assert.deepStrictEqual(data.samples[1], { eventNumber: 4, simtime: 0.251750941818, value: 2 });
  assert.deepStrictEqual(data.samples[2], { eventNumber: 7, simtime: 0.3, value: 0 });
});

test('readVector on a TV vector yields null eventNumbers (aligns by simtime)', () => {
  const data = readVector(VEC, 1)!;
  assert.strictEqual(data.samples.length, 2);
  assert.deepStrictEqual(data.samples[0], { eventNumber: null, simtime: 0.25, value: 0.5 });
  assert.deepStrictEqual(data.samples[1], { eventNumber: null, simtime: 0.4, value: 0.75 });
});

test('readVector returns null for an unknown vector id', () => {
  assert.strictEqual(readVector(VEC, 99), null);
});

test('vectorValueIndex: enum/int + whole doubles bucket by value; fractional doubles by sample index', () => {
  assert.strictEqual(vectorValueIndex(2, { type: 'enum' }, 5), 2);
  assert.strictEqual(vectorValueIndex(3, { type: 'int' }, 5), 3);
  assert.strictEqual(vectorValueIndex(4, { type: 'double' }, 5), 4); // whole double -> the integer
  assert.strictEqual(vectorValueIndex(4.2, { type: 'double' }, 5), 5); // fractional -> sample index
});

test('vectorValueText: enum name when known, else integer or raw double', () => {
  const info = { enum: new Map([[1, 'BUSY']]) };
  assert.strictEqual(vectorValueText(1, info), 'BUSY');
  assert.strictEqual(vectorValueText(2, info), '2'); // enum but value not a member -> number
  assert.strictEqual(vectorValueText(3, { enum: null }), '3');
  assert.strictEqual(vectorValueText(3.5, { enum: null }), '3.5');
});

test('readVector does not confuse a longer id with a prefix (id 1 vs 10/11)', () => {
  const vec = ['vector 1 M v TV', 'vector 10 M w TV', '10\t0.5\t7', '1\t0.6\t8', '11\t0.7\t9'].join('\n');
  const d1 = readVector(vec, 1)!;
  assert.strictEqual(d1.samples.length, 1);
  assert.strictEqual(d1.samples[0].value, 8);
});
