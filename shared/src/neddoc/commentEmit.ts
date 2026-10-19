/**
 * Emitters that turn the parsed NED comment AST (commentAst.ts) into HTML,
 * Markdown or reStructuredText. The HTML output mirrors what the Eclipse
 * IDE's NedCommentFormatter produces (same tags, same escaping rules); the
 * Markdown/RST outputs are equivalent renderings with format-appropriate
 * degradations (documented inline).
 *
 * Host-agnostic: no vscode/Node imports.
 */

import type { DocBlock, DocInline } from './commentAst';

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

export interface HtmlEmitOpts {
  /** Page-relative href for a type-reference target id; undefined = no link. */
  hrefFor: (targetId: string) => string | undefined;
  /** Complete markup for a single-target reference that needs special
   *  rendering (dependency types); undefined = the normal link. */
  typeRef?: (targetId: string, text: string) => string | undefined;
}

/** Escape text for HTML, but keep character entities the author wrote
 *  (`&ouml;` etc.) intact — the Eclipse formatter does the same. */
export function escapeHtmlText(text: string): string {
  return text
    .replace(/&(?![a-zA-Z]+;|#\d+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape text fully (for `<nohtml>` verbatim content and attributes). */
export function escapeHtmlAll(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function htmlTag(inline: Extract<DocInline, { kind: 'html' }>): string {
  if (inline.closing) return `</${inline.tag}>`;
  const attrs = inline.attrs ? ` ${inline.attrs}` : '';
  return `<${inline.tag}${attrs}${inline.selfClosing ? '/' : ''}>`;
}

export function emitHtmlInlines(inlines: DocInline[], opts: HtmlEmitOpts): string {
  let out = '';
  for (const inline of inlines) {
    switch (inline.kind) {
      case 'text':
        out += escapeHtmlText(inline.text);
        break;
      case 'code':
        out += `<tt>${escapeHtmlText(inline.text)}</tt>`;
        break;
      case 'boldlabel':
        out += `<b>${inline.label}</b>`;
        break;
      case 'url':
        out += `<a href="${escapeHtmlAll(inline.href)}" target="_blank">${escapeHtmlText(inline.href)}</a>`;
        break;
      case 'typeref':
        out += htmlTypeRef(inline, opts);
        break;
      case 'html':
        out += htmlTag(inline);
        break;
      case 'literal':
        out += escapeHtmlAll(inline.text);
        break;
    }
  }
  return out;
}

function htmlTypeRef(ref: Extract<DocInline, { kind: 'typeref' }>, opts: HtmlEmitOpts): string {
  const name = escapeHtmlText(ref.name);
  if (ref.targets.length === 0) return `<span class="error">${name}</span>`;
  if (ref.targets.length === 1) {
    const special = opts.typeRef?.(ref.targets[0], ref.name);
    if (special !== undefined) return special;
    const href = opts.hrefFor(ref.targets[0]);
    return href ? `<a href="${escapeHtmlAll(href)}">${name}</a>` : name;
  }
  // ambiguous simple name: "Name(1,2,3)" with numbered links (Eclipse style)
  const links = ref.targets
    .map((t, i) => {
      const href = opts.hrefFor(t);
      return href ? `<a href="${escapeHtmlAll(href)}">${i + 1}</a>` : String(i + 1);
    })
    .join(',');
  return `${name}(${links})`;
}

export function emitHtml(blocks: DocBlock[], opts: HtmlEmitOpts): string {
  const out: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'para':
        out.push(`<p>${emitHtmlInlines(block.inlines, opts)}</p>`);
        break;
      case 'pre':
        out.push(`<pre>${emitHtmlInlines(block.inlines, opts)}</pre>`);
        break;
      case 'hrule':
        out.push('<hr/>');
        break;
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        let level = 0;
        let html = '';
        for (const item of block.items) {
          while (level < item.level) {
            html += `<${tag}>`;
            level++;
          }
          while (level > item.level) {
            html += `</${tag}>`;
            level--;
          }
          html += `<li>${emitHtmlInlines(item.inlines, opts)}</li>`;
        }
        while (level > 0) {
          html += `</${tag}>`;
          level--;
        }
        out.push(html);
        break;
      }
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export interface MarkdownEmitOpts {
  /** Page-relative link target for a type-reference id; undefined = no link. */
  hrefFor: (targetId: string) => string | undefined;
  /** Complete markup for a single-target reference that needs special
   *  rendering (dependency types); undefined = the normal link. */
  typeRef?: (targetId: string, text: string) => string | undefined;
}

/** Escape Markdown-significant punctuation in plain text. */
export function escapeMdText(text: string): string {
  return text.replace(/[\\`*_[\]<>&|~]/g, (c) => '\\' + c);
}

function mdCodeSpan(text: string): string {
  if (!text) return '``';
  // pick a backtick fence longer than any run inside the code
  const runs = text.match(/`+/g);
  const fence = '`'.repeat(runs ? Math.max(...runs.map((r) => r.length)) + 1 : 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

export function emitMarkdownInlines(inlines: DocInline[], opts: MarkdownEmitOpts): string {
  let out = '';
  for (const inline of inlines) {
    switch (inline.kind) {
      case 'text':
        out += escapeMdText(inline.text);
        break;
      case 'code':
        out += mdCodeSpan(inline.text);
        break;
      case 'boldlabel':
        out += `**${inline.label}**`;
        break;
      case 'url':
        out += `<${inline.href}>`;
        break;
      case 'typeref':
        out += mdTypeRef(inline, opts);
        break;
      case 'html':
        // inline HTML is valid Markdown; pass the allowlisted tag through
        out += htmlTag(inline);
        break;
      case 'literal':
        out += escapeMdText(inline.text);
        break;
    }
  }
  return out;
}

function mdTypeRef(ref: Extract<DocInline, { kind: 'typeref' }>, opts: MarkdownEmitOpts): string {
  const name = escapeMdText(ref.name);
  if (ref.targets.length === 0) return `**${name}**`; // unresolved ~ref: bold, no link
  if (ref.targets.length === 1) {
    const special = opts.typeRef?.(ref.targets[0], ref.name);
    if (special !== undefined) return special;
    const href = opts.hrefFor(ref.targets[0]);
    return href ? `[${name}](${href})` : name;
  }
  const links = ref.targets
    .map((t, i) => {
      const href = opts.hrefFor(t);
      return href ? `[${i + 1}](${href})` : String(i + 1);
    })
    .join(',');
  return `${name}(${links})`;
}

/** Flatten inline content to plain text (for fenced code blocks etc.). */
export function flattenInlines(inlines: DocInline[]): string {
  let out = '';
  for (const inline of inlines) {
    switch (inline.kind) {
      case 'text':
      case 'code':
      case 'literal':
        out += inline.text;
        break;
      case 'boldlabel':
        out += inline.label;
        break;
      case 'url':
        out += inline.href;
        break;
      case 'typeref':
        out += inline.name;
        break;
      case 'html':
        out += htmlTag(inline);
        break;
    }
  }
  return out;
}

export function emitMarkdown(blocks: DocBlock[], opts: MarkdownEmitOpts): string {
  const out: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'para':
        out.push(emitMarkdownInlines(block.inlines, opts));
        break;
      case 'pre':
        // degradation: <pre> becomes a fenced block; links/tags inside lost
        out.push('```\n' + trimBlankEdges(flattenInlines(block.inlines)) + '\n```');
        break;
      case 'hrule':
        out.push('---');
        break;
      case 'list': {
        const lines: string[] = [];
        let n = 0;
        for (const item of block.items) {
          const indent = '    '.repeat(item.level - 1);
          const marker = block.ordered ? `${++n}.` : '-';
          const content = emitMarkdownInlines(item.inlines, opts).replace(/\n/g, `\n${indent}  `);
          lines.push(`${indent}${marker} ${content}`);
        }
        out.push(lines.join('\n'));
        break;
      }
    }
  }
  return out.join('\n\n');
}

function trimBlankEdges(text: string): string {
  return text.replace(/^\n+|\n+$/g, '');
}

// ---------------------------------------------------------------------------
// reStructuredText
// ---------------------------------------------------------------------------

export interface RstEmitOpts {
  /** Render a type-reference link, e.g. an anonymous hyperlink or a :ref:
   *  role; return undefined to render plain text. `text` is unescaped. */
  refFor: (targetId: string, text: string) => string | undefined;
}

/** Escape RST inline-markup start characters in plain text. */
export function escapeRstText(text: string): string {
  return text.replace(/[\\*`_|]/g, (c) => '\\' + c);
}

// paired formatting tags with an RST inline-markup equivalent
const RST_TAG_MARKUP: Record<string, string> = {
  b: '**',
  strong: '**',
  i: '*',
  em: '*',
  tt: '``',
  code: '``',
  kbd: '``',
  var: '*',
  dfn: '*',
};

// Inline markup is only recognized when the character before its start is
// whitespace or one of these (docutils "inline markup recognition rules"),
// and the character after its end is whitespace or one of the second set;
// non-ASCII punctuation is allowed on both sides.
const RST_BEFORE_MARKUP = /[\s\-:/'"<([{]|(?![\x00-\x7f])\p{P}/u;
const RST_AFTER_MARKUP = /[\s\-.,:;!?\\/'")\]}>]|(?![\x00-\x7f])\p{P}/u;

export function emitRstInlines(inlines: DocInline[], opts: RstEmitOpts): string {
  let out = '';
  let prevKind: DocInline['kind'] | undefined;
  for (const inline of inlines) {
    let chunk = '';
    switch (inline.kind) {
      case 'text':
        chunk = escapeRstText(inline.text);
        break;
      case 'code':
        chunk = `\`\`${inline.text}\`\``;
        break;
      case 'boldlabel':
        chunk = `**${inline.label}**`;
        break;
      case 'url':
        chunk = inline.href; // Sphinx auto-links bare URLs
        break;
      case 'typeref':
        chunk = rstTypeRef(inline, opts);
        // a ref glued to preceding text (e.g. "x.~Foo") would not be
        // recognized as a role; "\ " is an escaped space that renders as nothing
        if (isRstText(prevKind) && !RST_BEFORE_MARKUP.test(out[out.length - 1])) chunk = '\\ ' + chunk;
        break;
      case 'html': {
        // degradation: translate simple formatting tags, drop the rest
        const markup = RST_TAG_MARKUP[inline.tag];
        if (markup) chunk = markup;
        else if (inline.tag === 'br' && !inline.closing) chunk = '\n';
        break;
      }
      case 'literal':
        chunk = escapeRstText(inline.text);
        break;
    }
    if (prevKind === 'typeref' && isRstText(inline.kind) && chunk && !RST_AFTER_MARKUP.test(chunk[0])) {
      chunk = '\\ ' + chunk;
    }
    if (chunk) prevKind = inline.kind;
    out += chunk;
  }
  return out;
}

// Plain-text chunks; markup chunks (<b> → "**" etc.) are left alone, since a
// role cannot be nested in other RST inline markup anyway.
function isRstText(kind: DocInline['kind'] | undefined): boolean {
  return kind === 'text' || kind === 'literal';
}

function rstTypeRef(ref: Extract<DocInline, { kind: 'typeref' }>, opts: RstEmitOpts): string {
  const name = ref.name;
  if (ref.targets.length === 0) return `**${escapeRstText(name)}**`;
  if (ref.targets.length === 1) return opts.refFor(ref.targets[0], name) ?? escapeRstText(name);
  const links = ref.targets.map((t, i) => opts.refFor(t, String(i + 1)) ?? String(i + 1)).join(',');
  return `${escapeRstText(name)}\\ (${links})`;
}

export function emitRst(blocks: DocBlock[], opts: RstEmitOpts): string {
  const out: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'para':
        out.push(emitRstInlines(block.inlines, opts));
        break;
      case 'pre': {
        const body = trimBlankEdges(flattenInlines(block.inlines))
          .split('\n')
          .map((l) => '   ' + l)
          .join('\n');
        out.push('::\n\n' + body);
        break;
      }
      case 'hrule':
        out.push('----');
        break;
      case 'list': {
        const lines: string[] = [];
        let prevLevel = 1;
        let n = 0;
        for (const item of block.items) {
          const indent = '  '.repeat(item.level - 1);
          const marker = block.ordered ? `${++n}.` : '-';
          const content = emitRstInlines(item.inlines, opts).replace(/\n/g, `\n${indent}  `);
          // RST requires a blank line when the nesting level changes
          if (lines.length > 0 && item.level !== prevLevel) lines.push('');
          lines.push(`${indent}${marker} ${content}`);
          prevLevel = item.level;
        }
        out.push(lines.join('\n'));
        break;
      }
    }
  }
  return out.join('\n\n');
}
