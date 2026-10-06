import { test } from 'bun:test';
import assert from 'node:assert';
import { renderMiniMarkdown } from '../eventlog/chart/miniMarkdown';

test('renderMiniMarkdown: empty source renders nothing', () => {
  assert.strictEqual(renderMiniMarkdown(''), '');
});

test('renderMiniMarkdown: plain text becomes a paragraph', () => {
  assert.strictEqual(renderMiniMarkdown('hello world'), '<p>hello world</p>');
});

test('renderMiniMarkdown: bold', () => {
  assert.strictEqual(renderMiniMarkdown('this is **bold** text'), '<p>this is <strong>bold</strong> text</p>');
});

test('renderMiniMarkdown: italic', () => {
  assert.strictEqual(renderMiniMarkdown('this is *italic* text'), '<p>this is <em>italic</em> text</p>');
});

test('renderMiniMarkdown: bold and italic together do not interfere', () => {
  assert.strictEqual(renderMiniMarkdown('**bold** and *italic*'), '<p><strong>bold</strong> and <em>italic</em></p>');
});

test('renderMiniMarkdown: inline code, including asterisks inside it, is protected from bold/italic', () => {
  assert.strictEqual(renderMiniMarkdown('use `*foo*` literally'), '<p>use <code>*foo*</code> literally</p>');
});

test('renderMiniMarkdown: a link with an allowed scheme', () => {
  assert.strictEqual(renderMiniMarkdown('see [the docs](https://example.com/docs)'), '<p>see <a href="https://example.com/docs">the docs</a></p>');
  assert.strictEqual(renderMiniMarkdown('[mail](mailto:a@b.com)'), '<p><a href="mailto:a@b.com">mail</a></p>');
});

test('renderMiniMarkdown: a link with a disallowed scheme is left as literal escaped text', () => {
  assert.strictEqual(renderMiniMarkdown('[bad](javascript:alert(1))'), '<p>[bad](javascript:alert(1))</p>');
});

test('renderMiniMarkdown: headers', () => {
  assert.strictEqual(renderMiniMarkdown('# Title'), '<h1>Title</h1>');
  assert.strictEqual(renderMiniMarkdown('## Subtitle'), '<h2>Subtitle</h2>');
});

test('renderMiniMarkdown: bullet list', () => {
  assert.strictEqual(renderMiniMarkdown('- one\n- two\n- three'), '<ul><li>one</li><li>two</li><li>three</li></ul>');
});

test('renderMiniMarkdown: numbered list', () => {
  assert.strictEqual(renderMiniMarkdown('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
});

test('renderMiniMarkdown: a single newline within a paragraph becomes <br>, a blank line starts a new paragraph', () => {
  assert.strictEqual(renderMiniMarkdown('line one\nline two'), '<p>line one<br>line two</p>');
  assert.strictEqual(renderMiniMarkdown('para one\n\npara two'), '<p>para one</p><p>para two</p>');
});

test('renderMiniMarkdown: mixed blocks in one document', () => {
  const source = '# Title\n\nSome text.\n\n- a\n- b\n\nMore text.';
  assert.strictEqual(renderMiniMarkdown(source), '<h1>Title</h1><p>Some text.</p><ul><li>a</li><li>b</li></ul><p>More text.</p>');
});

test('renderMiniMarkdown: raw < > & are escaped, never passed through as real tags', () => {
  assert.strictEqual(renderMiniMarkdown('a < b && b > c'), '<p>a &lt; b &amp;&amp; b &gt; c</p>');
  assert.strictEqual(renderMiniMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('renderMiniMarkdown: unsupported syntax passes through literally, not stripped', () => {
  assert.strictEqual(renderMiniMarkdown('~~strikethrough~~ stays literal'), '<p>~~strikethrough~~ stays literal</p>');
});

test('renderMiniMarkdown: a quote in a link URL cannot end the href attribute', () => {
  assert.strictEqual(
    renderMiniMarkdown('[x](https://a"onmouseover="alert(1))'),
    '<p><a href="https://a&quot;onmouseover=&quot;alert(1">x</a>)</p>',
  );
  assert.strictEqual(renderMiniMarkdown("[x](https://a'b)"), '<p><a href="https://a&#39;b">x</a></p>');
});

test('renderMiniMarkdown: quotes in plain text are escaped', () => {
  assert.strictEqual(renderMiniMarkdown(`say "hi" it's`), '<p>say &quot;hi&quot; it&#39;s</p>');
});

test('renderMiniMarkdown: bold/italic/code syntax inside a link URL is left alone', () => {
  assert.strictEqual(renderMiniMarkdown('[x](https://a/*b*/c)'), '<p><a href="https://a/*b*/c">x</a></p>');
  assert.strictEqual(renderMiniMarkdown('[x](https://a/**b**)'), '<p><a href="https://a/**b**">x</a></p>');
  assert.strictEqual(renderMiniMarkdown('[x](https://a/`b`)'), '<p><a href="https://a/`b`">x</a></p>');
});

test('renderMiniMarkdown: link text still gets bold/italic', () => {
  assert.strictEqual(
    renderMiniMarkdown('[**docs** here](https://e.org) and *more*'),
    '<p><a href="https://e.org"><strong>docs</strong> here</a> and <em>more</em></p>',
  );
});
