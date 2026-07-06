/**
 * Minimal string-based SVG document builder for hosts without a DOM (the doc
 * generator CLI, the LSP server). Emits the same markup shapes the NED preview
 * webview builds via `document.createElementNS`, so both hosts can share one
 * rendering code path.
 *
 * Browser-safe: pure string manipulation, no Node/vscode imports.
 */

export type Attrs = Record<string, string | number | undefined>;

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Round to 2 decimals and drop trailing zeros — keeps output compact and
 *  snapshot-stable across platforms. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 100) / 100;
  return String(r);
}

function attrString(attrs?: Attrs): string {
  if (!attrs) return '';
  let out = '';
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    const text = typeof value === 'number' ? fmt(value) : escapeXml(value);
    out += ` ${key}="${text}"`;
  }
  return out;
}

export class SvgBuilder {
  private parts: string[] = [];
  private stack: string[] = [];

  /** Open a container element; must be balanced with close(). */
  open(tag: string, attrs?: Attrs): this {
    this.parts.push(`<${tag}${attrString(attrs)}>`);
    this.stack.push(tag);
    return this;
  }

  close(): this {
    const tag = this.stack.pop();
    if (!tag) throw new Error('SvgBuilder.close() with no open element');
    this.parts.push(`</${tag}>`);
    return this;
  }

  /** Leaf element. With `text` emits `<tag ...>text</tag>` (text is escaped),
   *  otherwise a self-closing `<tag .../>`. */
  el(tag: string, attrs?: Attrs, text?: string): this {
    if (text !== undefined) {
      this.parts.push(`<${tag}${attrString(attrs)}>${escapeXml(text)}</${tag}>`);
    } else {
      this.parts.push(`<${tag}${attrString(attrs)}/>`);
    }
    return this;
  }

  /** Append raw, pre-escaped markup verbatim. */
  raw(svg: string): this {
    this.parts.push(svg);
    return this;
  }

  toString(): string {
    if (this.stack.length > 0) {
      throw new Error(`SvgBuilder.toString() with unclosed <${this.stack[this.stack.length - 1]}>`);
    }
    return this.parts.join('');
  }
}
