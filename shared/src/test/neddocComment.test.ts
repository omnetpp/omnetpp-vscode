import { test } from 'bun:test';
import assert from 'node:assert';
import {
  parseNedComment,
  parseBriefComment,
  briefText,
  type CommentParseCtx,
  type IncludeResolution,
} from '../neddoc/commentAst';
import { emitHtml, emitMarkdown, emitRst } from '../neddoc/commentEmit';

// ---- helpers -----------------------------------------------------------------

function ctx(
  names: Record<string, string[]> = {},
  mode: 'automatic' | 'tilde' = 'tilde',
  extra: Partial<CommentParseCtx> = {},
): CommentParseCtx {
  return { hyperlinkMode: mode, lookupTypeName: (n) => names[n], ...extra };
}

const html = (raw: string, c = ctx()) => emitHtml(parseNedComment(raw, c), { hrefFor: (id) => `${id}.html` });
const md = (raw: string, c = ctx()) => emitMarkdown(parseNedComment(raw, c), { hrefFor: (id) => `${id}.md` });
const rst = (raw: string, c = ctx()) =>
  emitRst(parseNedComment(raw, c), { refFor: (id, text) => `:ref:\`${text} <${id}>\`` });

// ---- basics ------------------------------------------------------------------

test('neddoc comment: single paragraph', () => {
  assert.equal(html('// Hello world.'), '<p>Hello world.</p>');
});

test('neddoc comment: blank line separates paragraphs', () => {
  assert.equal(html('// First para.\n//\n// Second para.'), '<p>First para.</p>\n<p>Second para.</p>');
});

test('neddoc comment: whitespace-only comment lines count as blank', () => {
  assert.equal(html('// a\n//   \t\n// b'), '<p>a</p>\n<p>b</p>');
});

test('neddoc comment: /// and ///// markers strip like //', () => {
  assert.equal(html('/// a\n////// b'), '<p>a\nb</p>');
});

test('neddoc comment: //# private lines are dropped', () => {
  assert.equal(html('// public\n//# secret\n// more'), '<p>public</p>\n<p>more</p>');
});

test('neddoc comment: paragraph leading indentation is shed', () => {
  assert.equal(html('//    indented'), '<p>indented</p>');
});

// ---- horizontal rule -----------------------------------------------------------

test('neddoc comment: a line of 6+ dashes becomes a rule', () => {
  assert.equal(html('// above\n// ------\n// below'), '<p>above</p>\n<hr/>\n<p>below</p>');
});

test('neddoc comment: 5 dashes are not a rule', () => {
  assert.equal(html('// above\n// -----\n// below'), '<p>above\n-----\nbelow</p>');
});

// ---- lists ---------------------------------------------------------------------

test('neddoc comment: unordered list with continuation line', () => {
  assert.equal(
    html('// - one\n// - two\n//   more of two\n// - three'),
    '<ul><li>one</li><li>two\n  more of two</li><li>three</li></ul>',
  );
});

test('neddoc comment: nested unordered list (indent thresholds 4/7/10)', () => {
  assert.equal(
    html('// - a\n//     - b\n//        - c\n//           - d'),
    '<ul><li>a</li><ul><li>b</li><ul><li>c</li><ul><li>d</li></ul></ul></ul></ul>',
  );
});

test('neddoc comment: ordered list', () => {
  assert.equal(html('// -# one\n// -# two'), '<ol><li>one</li><li>two</li></ol>');
});

test('neddoc comment: switching list style starts a new list', () => {
  assert.equal(html('// - bullet\n// -# numbered'), '<ul><li>bullet</li></ul>\n<ol><li>numbered</li></ol>');
});

test('neddoc comment: list ends at a normal paragraph', () => {
  assert.equal(html('// - one\n//\n// after'), '<ul><li>one</li></ul>\n<p>after</p>');
});

// ---- inline formatting ----------------------------------------------------------

test('neddoc comment: backticks render as tt', () => {
  assert.equal(html('// use `send()` here'), '<p>use <tt>send()</tt> here</p>');
});

test('neddoc comment: doc keywords become bold labels in their own paragraph', () => {
  assert.equal(
    html('// Does things.\n// @author John Doe @since 4.0'),
    '<p>Does things.</p>\n<p><b>Author:</b> John Doe </p>\n<p><b>Since:</b> 4.0</p>',
  );
});

test('neddoc comment: all doc keywords map to their labels', () => {
  const out = html('// @author a @date b @todo c @bug d @see e @since f @warning g @version h');
  for (const label of ['Author:', 'Date:', 'TODO:', 'BUG:', 'See also:', 'Since:', 'WARNING:', 'Version:'])
    assert.ok(out.includes(`<b>${label}</b>`), `missing ${label} in ${out}`);
});

test('neddoc comment: URLs are auto-linked, trailing punctuation excluded', () => {
  assert.equal(
    html('// see https://example.org/doc. done'),
    '<p>see <a href="https://example.org/doc" target="_blank">https://example.org/doc</a>. done</p>',
  );
});

// ---- HTML passthrough ------------------------------------------------------------

test('neddoc comment: allowlisted HTML tags pass through, unknown ones are escaped', () => {
  assert.equal(
    html('// <b>bold</b> and <blink>nope</blink>'),
    '<p><b>bold</b> and &lt;blink&gt;nope&lt;/blink&gt;</p>',
  );
});

test('neddoc comment: tag attributes are preserved', () => {
  assert.equal(html('// <img src="x.png"/> <a href="y">link</a>'), '<p><img src="x.png"/> <a href="y">link</a></p>');
});

test('neddoc comment: stray angle brackets are literal text', () => {
  assert.equal(html('// a < b and x > y'), '<p>a &lt; b and x &gt; y</p>');
});

test('neddoc comment: character entities written by the author are preserved', () => {
  assert.equal(html('// K&ouml;ln &#246; a&b'), '<p>K&ouml;ln &#246; a&amp;b</p>');
});

// ---- <pre> ------------------------------------------------------------------------

test('neddoc comment: pre blocks keep line structure and escape content', () => {
  assert.equal(html('// <pre>\n// a < b\n//    keep\n// </pre>'), '<pre>\na &lt; b\n   keep\n</pre>');
});

test('neddoc comment: no list/backtick processing inside pre', () => {
  assert.equal(html('// <pre>\n// - not a list\n// `raw`\n// </pre>'), '<pre>\n- not a list\n`raw`\n</pre>');
});

// ---- <nohtml> ----------------------------------------------------------------------

test('neddoc comment: nohtml content is verbatim (no tags, no links)', () => {
  assert.equal(
    html('// <nohtml>~Foo stays, <b>tag</b> shown</nohtml>', ctx({ Foo: ['p.Foo'] })),
    '<p>~Foo stays, &lt;b&gt;tag&lt;/b&gt; shown</p>',
  );
});

// ---- type references: tilde mode -----------------------------------------------------

test('neddoc comment: ~ref links known types, flags unknown ones', () => {
  assert.equal(
    html('// see ~Foo and ~Bar', ctx({ Foo: ['pkg.Foo'] })),
    '<p>see <a href="pkg.Foo.html">Foo</a> and <span class="error">Bar</span></p>',
  );
});

test('neddoc comment: double tilde renders one literal tilde, no link', () => {
  assert.equal(html('// ~~Foo', ctx({ Foo: ['pkg.Foo'] })), '<p>~Foo</p>');
});

test('neddoc comment: automatic mode treats ~ before a known name as markup', () => {
  const auto = ctx({ Foo: ['pkg.Foo'] }, 'automatic');
  assert.equal(html('// see ~Foo and Foo', auto), '<p>see <a href="pkg.Foo.html">Foo</a> and <a href="pkg.Foo.html">Foo</a></p>');
  assert.equal(html('// ~Nope', auto), '<p>~Nope</p>');
  assert.equal(md('// ~Foo', auto), '[Foo](pkg.Foo.md)');
});

test('neddoc comment: qualified ~ref and enum-member fallback', () => {
  assert.equal(
    html('// ~pkg.Foo and ~State::IDLE', ctx({ 'pkg.Foo': ['pkg.Foo'], State: ['pkg.State'] })),
    '<p><a href="pkg.Foo.html">pkg.Foo</a> and <a href="pkg.State.html">State</a>::IDLE</p>',
  );
});

test('neddoc comment: plain names are not linked in tilde mode', () => {
  assert.equal(html('// Foo here', ctx({ Foo: ['pkg.Foo'] })), '<p>Foo here</p>');
});

test('neddoc comment: ambiguous ~ref renders a numbered link list', () => {
  assert.equal(
    html('// ~Foo', ctx({ Foo: ['a.Foo', 'b.Foo'] })),
    '<p>Foo(<a href="a.Foo.html">1</a>,<a href="b.Foo.html">2</a>)</p>',
  );
});

// ---- type references: automatic mode ---------------------------------------------------

test('neddoc comment: automatic mode links known names', () => {
  assert.equal(
    html('// Foo talks to Bar.', ctx({ Foo: ['p.Foo'] }, 'automatic')),
    '<p><a href="p.Foo.html">Foo</a> talks to Bar.</p>',
  );
});

test('neddoc comment: backslash suppresses auto-linking, double backslash is literal', () => {
  assert.equal(
    html('// \\Foo and \\\\Foo', ctx({ Foo: ['p.Foo'] }, 'automatic')),
    '<p>Foo and \\<a href="p.Foo.html">Foo</a></p>',
  );
});

test('neddoc comment: automatic mode links a known prefix of a dotted name', () => {
  assert.equal(
    html('// Foo.bar here', ctx({ Foo: ['p.Foo'] }, 'automatic')),
    '<p><a href="p.Foo.html">Foo</a>.bar here</p>',
  );
});

test('neddoc comment: unknown names stay plain in automatic mode', () => {
  assert.equal(html('// NoSuchThing here', ctx({}, 'automatic')), '<p>NoSuchThing here</p>');
});

// ---- @include ---------------------------------------------------------------------------

test('neddoc comment: @include splices file content', () => {
  const resolve = (ref: string): IncludeResolution | undefined =>
    ref === 'desc.txt' ? { id: 'desc.txt', content: 'included text' } : undefined;
  assert.equal(
    html('// before\n// @include desc.txt\n// after', ctx({}, 'tilde', { resolveInclude: resolve })),
    '<p>before\nincluded text\nafter</p>',
  );
});

test('neddoc comment: nested @include resolves relative to the included file', () => {
  const files: Record<string, string> = { 'a.txt': 'A\n@include b.txt', 'b.txt': 'B' };
  const fromIds: (string | undefined)[] = [];
  const resolve = (ref: string, fromId: string | undefined): IncludeResolution | undefined => {
    fromIds.push(fromId);
    return files[ref] ? { id: ref, content: files[ref] } : undefined;
  };
  assert.equal(
    html('// @include a.txt', ctx({}, 'tilde', { resolveInclude: resolve })),
    '<p>A\nB</p>',
  );
  assert.deepEqual(fromIds, [undefined, 'a.txt']);
});

test('neddoc comment: circular @include is detected and warned about', () => {
  const warnings: string[] = [];
  const resolve = (ref: string): IncludeResolution | undefined => ({ id: 'self.txt', content: '@include self.txt' });
  html('// @include self.txt', ctx({}, 'tilde', { resolveInclude: resolve, warnings }));
  assert.ok(warnings.some((w) => w.includes('circular')));
});

// ---- brief -------------------------------------------------------------------------------

test('neddoc comment: brief parse keeps only the first paragraph', () => {
  const blocks = parseBriefComment('// First para\n// second line.\n//\n// Second para.', ctx());
  assert.equal(emitHtml(blocks, { hrefFor: () => undefined }), '<p>First para\nsecond line.</p>');
});

test('neddoc comment: briefText gives first sentence, tags stripped, one line', () => {
  assert.equal(briefText('// The <b>Foo</b> module. It does things.\n// More text.'), 'The Foo module.');
  assert.equal(briefText('// No sentence end\n// second line\n//\n// next para'), 'No sentence end second line');
});

test('neddoc comment: briefText abbreviates long text', () => {
  const out = briefText('// ' + 'word '.repeat(50), 20);
  assert.ok(out.length <= 20 && out.endsWith('...'), out);
});

// ---- markdown emission --------------------------------------------------------------------

test('neddoc md: paragraphs, refs, code and lists', () => {
  const out = md('// Uses ~Foo via `send()`.\n//\n// - a\n//     - b', ctx({ Foo: ['p.Foo'] }));
  assert.equal(out, 'Uses [Foo](p.Foo.md) via `send()`.\n\n- a\n    - b');
});

test('neddoc md: markdown punctuation in text is escaped', () => {
  assert.equal(md('// *stars* and _under_ and [brackets]'), '\\*stars\\* and \\_under\\_ and \\[brackets\\]');
});

test('neddoc md: allowlisted HTML passes through, broken ref is bold', () => {
  assert.equal(md('// <b>hi</b> ~Nope', ctx()), '<b>hi</b> **Nope**');
});

test('neddoc md: pre becomes a fenced block', () => {
  assert.equal(md('// <pre>\n// x < y\n// </pre>'), '```\nx < y\n```');
});

// ---- rst emission ----------------------------------------------------------------------------

test('neddoc rst: paragraphs, refs, code and lists', () => {
  const out = rst('// Uses ~Foo via `send()`.\n//\n// - a\n//     - b', ctx({ Foo: ['p.Foo'] }));
  assert.equal(out, 'Uses :ref:`Foo <p.Foo>` via ``send()``.\n\n- a\n\n  - b');
});

test('neddoc rst: ~ref in automatic mode becomes a working :ref: role', () => {
  const auto = ctx({ Foo: ['p.Foo'] }, 'automatic');
  assert.equal(rst('// @see ~Foo', auto), '**See also:** :ref:`Foo <p.Foo>`');
  assert.equal(rst('// (~Foo, ~Foo)', auto), '(:ref:`Foo <p.Foo>`, :ref:`Foo <p.Foo>`)');
  // an unknown ~name has nothing to link, so its tilde stays as written
  assert.equal(rst('// ~Nope', auto), '~Nope');
});

test('neddoc rst: refs glued to other characters stay recognizable roles', () => {
  const refs = { Foo: ['p.Foo'] };
  assert.equal(rst('// x.~Foo#y', ctx(refs)), 'x.\\ :ref:`Foo <p.Foo>`\\ #y');
  assert.equal(rst('// ~Foo~~bar', ctx(refs)), ':ref:`Foo <p.Foo>`\\ ~bar');
});

test('neddoc rst: inline markup chars are escaped, simple tags translate', () => {
  assert.equal(rst('// *stars* and <b>bold</b>'), '\\*stars\\* and **bold**');
});

test('neddoc rst: pre becomes a literal block', () => {
  assert.equal(rst('// <pre>\n// x < y\n// </pre>'), '::\n\n   x < y');
});

test('neddoc rst: ordered list and hrule', () => {
  assert.equal(rst('// -# one\n// -# two\n//\n// ------\n//\n// end'), '1. one\n2. two\n\n----\n\nend');
});
