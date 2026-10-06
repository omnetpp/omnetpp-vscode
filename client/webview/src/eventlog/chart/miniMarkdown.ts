/**
 * miniMarkdown.ts (PURE) - a hand-rolled minimal Markdown-to-HTML subset for "Bookmark Info"
 * note bodies. No external dependency: this webview bundle is architecturally limited to
 * @omnetpp/shared/preview plus type-only imports (see AGENTS.md's client/webview/ notes), so
 * a real CommonMark library is out of scope -- this covers the common note-taking constructs
 * instead: bold (**x**), italic (*x*), code (backtick x backtick), links ([text](url), http(s)
 * or mailto only), headers (# / ##), lists (- / 1.), and blank-line paragraph breaks /
 * single-newline line breaks. Anything else (unsupported syntax) passes through as literal
 * escaped text, never stripped or mangled.
 *
 * Safety: every raw text run is escaped via escapeHtml() BEFORE any markdown substitution
 * inserts real tags, so the result is always safe to assign to innerHTML -- the exact
 * "provider-controlled/pre-escaped HTML" pattern tooltip.ts already documents and relies on
 * for its own hand-built tooltip HTML. Quotes are escaped too, because link URLs end up
 * inside an href="..." attribute.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const HEADER_RE = /^(#{1,2})\s+(.*)$/;
const BULLET_RE = /^-\s+/;
const NUMBERED_RE = /^\d+\.\s+/;

/**
 * A placeholder delimiter for protecting code-span content from the bold/italic/link rules
 * below. Built via String.fromCharCode (a control character no normal typed text can
 * contain), rather than authored as an escape-sequence string literal, so it can never
 * collide with real content.
 */
const PLACEHOLDER_CHAR = String.fromCharCode(1);
/** Start and end markers of a link whose URL waits in a side table (same idea as above). */
const LINK_START_CHAR = String.fromCharCode(2);
const LINK_END_CHAR = String.fromCharCode(3);

/**
 * Inline spans within one already-block-classified line/run of text: code first (protects
 * its content from the rules below behind the placeholder), then links (their URLs move to a
 * side table so bold/italic never rewrite them; the link text stays in place and still gets
 * them), then bold, then italic. text must already be escapeHtml()-escaped.
 */
function renderInline(text: string): string {
  const codeSpans: string[] = [];
  const codeSpanPattern = /`([^`\n]+?)`/g;
  let out = text.replace(codeSpanPattern, (_m, code: string) => {
    codeSpans.push(code);
    return PLACEHOLDER_CHAR + String(codeSpans.length - 1) + PLACEHOLDER_CHAR;
  });
  const restorePattern = new RegExp(PLACEHOLDER_CHAR + '(\\d+)' + PLACEHOLDER_CHAR, 'g');
  const urls: string[] = [];
  out = out.replace(/\[([^\]\n]+?)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (_m, label: string, url: string) => {
    urls.push(url.replace(restorePattern, (_c, i: string) => '`' + codeSpans[Number(i)] + '`'));
    return LINK_START_CHAR + String(urls.length - 1) + LINK_START_CHAR + label + LINK_END_CHAR;
  });
  out = out.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^\n*]+?)\*/g, '<em>$1</em>');
  const linkPattern = new RegExp(`${LINK_START_CHAR}(\\d+)${LINK_START_CHAR}([^${LINK_END_CHAR}]*)${LINK_END_CHAR}`, 'g');
  out = out.replace(linkPattern, (_m, i: string, label: string) => `<a href="${urls[Number(i)]}">${label}</a>`);
  out = out.replace(restorePattern, (_m, i: string) => `<code>${codeSpans[Number(i)]}</code>`);
  return out;
}

/** Renders source (Markdown) to a safe HTML string suitable for innerHTML. */
export function renderMiniMarkdown(source: string): string {
  const lines = source.split(/\r\n|\r|\n/);
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const header = HEADER_RE.exec(line);
    if (header) {
      const level = header[1].length;
      blocks.push(`<h${level}>${renderInline(escapeHtml(header[2]))}</h${level}>`);
      i++;
      continue;
    }
    if (BULLET_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && BULLET_RE.test(lines[i])) {
        items.push(`<li>${renderInline(escapeHtml(lines[i].replace(BULLET_RE, '')))}</li>`);
        i++;
      }
      blocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (NUMBERED_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && NUMBERED_RE.test(lines[i])) {
        items.push(`<li>${renderInline(escapeHtml(lines[i].replace(NUMBERED_RE, '')))}</li>`);
        i++;
      }
      blocks.push(`<ol>${items.join('')}</ol>`);
      continue;
    }
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !HEADER_RE.test(lines[i]) && !BULLET_RE.test(lines[i]) && !NUMBERED_RE.test(lines[i])) {
      paraLines.push(renderInline(escapeHtml(lines[i])));
      i++;
    }
    blocks.push(`<p>${paraLines.join('<br>')}</p>`);
  }
  return blocks.join('');
}
