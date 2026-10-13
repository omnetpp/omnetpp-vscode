import { test } from 'bun:test';
import assert from 'node:assert';
import { highlightSource, highlightSourceHtml, type SourceToken } from '../neddoc/sourceHighlight';

const classed = (tokens: SourceToken[]) => tokens.filter((t) => t.cls).map((t) => [t.text, t.cls]);

test('highlightSource: NED code tokens', () => {
  const code = 'simple Host { parameters: volatile xml cfg = xmldoc("a//b.xml"); int n = 42 @unit(s); gates: input in[n]; }';
  assert.deepEqual(classed(highlightSource(code, 'ned')), [
    ['simple', 'keyword'],
    ['parameters', 'keyword'],
    ['volatile', 'type'],
    ['xml', 'type'], // a type and a function: the type list wins, as in Eclipse
    ['xmldoc', 'function'],
    ['"a//b.xml"', 'string'],
    ['int', 'type'],
    ['42', 'number'],
    ['@unit', 'property'],
    ['gates', 'keyword'],
    ['input', 'type'],
  ]);
  assert.equal(highlightSource(code, 'ned').map((t) => t.text).join(''), code);
});

test('highlightSource: NED connection arrows and constants', () => {
  assert.deepEqual(classed(highlightSource('a.out --> b.in; x = true; y = 3.14;', 'ned')), [
    ['-->', 'keyword'],
    ['true', 'string'],
    ['3', 'number'],
    ['14', 'number'],
  ]);
});

test('highlightSource: doc comments and private comments', () => {
  const code = '// See <b>this</b> and <bogus>, @author Me @nope\n//# TODO: later FIXME\nsimple A {}';
  assert.deepEqual(classed(highlightSource(code, 'ned')), [
    ['// See ', 'comment'],
    ['<b>', 'comment-tag'],
    ['this', 'comment'],
    ['</b>', 'comment-tag'],
    [' and <bogus>, ', 'comment'],
    ['@author', 'comment-keyword'],
    [' Me @nope', 'comment'],
    ['//# ', 'private'],
    ['TODO', 'private-todo'],
    [': later ', 'private'],
    ['FIXME', 'private-todo'],
    ['simple', 'keyword'],
  ]);
});

test('highlightSource: MSG keywords and types', () => {
  assert.deepEqual(classed(highlightSource('packet Pkt extends Base { uint32_t len; string name = "x"; }', 'msg')), [
    ['packet', 'keyword'],
    ['extends', 'keyword'],
    ['uint32_t', 'type'],
    ['string', 'type'],
    ['"x"', 'string'],
  ]);
  // NED-only words are plain in MSG
  assert.deepEqual(classed(highlightSource('simple --> sizeof', 'msg')), []);
});

test('highlightSourceHtml: classes for the stylesheet or Eclipse inline styles, text escaped', () => {
  assert.equal(highlightSourceHtml('int a = "<x>";', 'ned', 'class'), '<span class="src-type">int</span> a = <span class="src-string">"&lt;x&gt;"</span>;');
  assert.equal(highlightSourceHtml('simple', 'ned', 'inline'), '<span style="color: #8b0000; font-weight: bold; ">simple</span>');
});
