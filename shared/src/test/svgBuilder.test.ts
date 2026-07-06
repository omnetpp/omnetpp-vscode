import { test } from 'bun:test';
import assert from 'node:assert';
import { SvgBuilder, escapeXml, fmt } from '../graphics/svgBuilder';
import { approxTextWidth } from '../graphics/textMetrics';

// ---- escaping / number formatting -------------------------------------------

test('svgBuilder: escapeXml escapes markup-significant characters', () => {
  assert.equal(escapeXml('a<b>&"c"'), 'a&lt;b&gt;&amp;&quot;c&quot;');
  assert.equal(escapeXml('plain'), 'plain');
});

test('svgBuilder: fmt rounds to 2 decimals and drops trailing zeros', () => {
  assert.equal(fmt(1.005 + 0.12), '1.13');
  assert.equal(fmt(3), '3');
  assert.equal(fmt(2.5), '2.5');
  assert.equal(fmt(-0.333333), '-0.33');
  assert.equal(fmt(Number.NaN), '0');
});

// ---- element emission --------------------------------------------------------

test('svgBuilder: nested elements, attributes and text content', () => {
  const b = new SvgBuilder();
  b.open('svg', { width: 100.5, height: 50, xmlns: 'http://www.w3.org/2000/svg' })
    .open('g', { transform: 'translate(1,2)' })
    .el('rect', { x: 0, y: 0, width: 10.123, fill: 'red', stroke: undefined })
    .el('title', {}, 'Tool "tip" <1>')
    .close()
    .close();
  assert.equal(
    b.toString(),
    '<svg width="100.5" height="50" xmlns="http://www.w3.org/2000/svg">' +
      '<g transform="translate(1,2)">' +
      '<rect x="0" y="0" width="10.12" fill="red"/>' +
      '<title>Tool &quot;tip&quot; &lt;1&gt;</title>' +
      '</g></svg>',
  );
});

test('svgBuilder: undefined attributes are omitted, raw() passes through', () => {
  const b = new SvgBuilder();
  b.open('g', { class: undefined }).raw('<custom/>').close();
  assert.equal(b.toString(), '<g><custom/></g>');
});

test('svgBuilder: unbalanced open/close throws', () => {
  assert.throws(() => new SvgBuilder().close());
  assert.throws(() => new SvgBuilder().open('g').toString());
});

// ---- text metrics --------------------------------------------------------------

test('textMetrics: approxTextWidth scales linearly with font size', () => {
  const w12 = approxTextWidth('NodeName', 12);
  const w24 = approxTextWidth('NodeName', 24);
  assert.ok(Math.abs(w24 - 2 * w12) < 1e-9);
});

test('textMetrics: proportional widths follow Helvetica metrics', () => {
  // 'i' is much narrower than 'W'; 'm' wider than 'n'
  assert.ok(approxTextWidth('iiii') < approxTextWidth('WWWW') / 2);
  assert.ok(approxTextWidth('m') > approxTextWidth('n'));
  // a 10-char identifier at 12px lands in a plausible px range
  const w = approxTextWidth('TcpSession', 12);
  assert.ok(w > 40 && w < 90, `unexpected width ${w}`);
});

test('textMetrics: CJK characters count as full-width', () => {
  assert.ok(approxTextWidth('中', 12) > approxTextWidth('W', 12));
  assert.equal(approxTextWidth('中中', 12), 24);
});

test('textMetrics: empty string measures zero', () => {
  assert.equal(approxTextWidth(''), 0);
});
