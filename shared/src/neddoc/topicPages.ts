/**
 * The `@titlepage`, `@page` and `@externalpage` directives of NED/MSG file
 * comments: a port of the Eclipse IDE's DocumentationGenerator
 * (mapPageMatchers, sanitizeFileName) and of nedxml's
 * SourceDocument::getFileCommentPos.
 */

export type PageDirective =
  /** Replaces the Overview page. */
  | { kind: 'titlepage'; content: string }
  /** A separate page; `fileName` is sanitized and ends in `.html`. */
  | { kind: 'page'; fileName: string; title: string; content: string }
  /** A navigation link to a page that is not generated. */
  | { kind: 'externalpage'; href: string; title: string };

/** The comment block at the top of a file: lines up to the last blank line
 *  before the first code line, or the whole file when it has no code. The
 *  `//` markers stay. */
export function fileComment(text: string): string {
  const lines = text.replace(/\r/g, '').split('\n');
  let lastBlank = 0;
  let line = 0;
  for (; line < lines.length; line++) {
    const s = lines[line].replace(/^[ \t]+/, '');
    if (s.startsWith('//')) continue;
    if (s !== '') break;
    lastBlank = line + 1;
  }
  if (line === lines.length) lastBlank = lines.length;
  return lines.slice(0, lastBlank).join('\n').trim();
}

const EXTERNAL_PAGE_RE = /^[ \t]*\/\/[ \t]*@externalpage +([^,\n]+),? *(.*?)$/gm;
const PAGE_SEPARATOR_RE = /^[ \t]*\/\/[ \t]*(?:@page|@titlepage).*$/gm;
const TITLE_PAGE_RE = /^[ \t]*\/\/[ \t]*@titlepage/;
const PAGE_RE = /^[ \t]*\/\/[ \t]*@page +([^,\n]+),? *(.*?)$/;

/** The page directives of a file comment, in the order Eclipse visits them:
 *  the external pages first, then the title page and pages in source order. */
export function pageDirectives(comment: string): PageDirective[] {
  if (!/@(?:page|titlepage|externalpage)/.test(comment)) return [];
  const result: PageDirective[] = [];
  const text = comment.replace(/\r/g, '').replace(EXTERNAL_PAGE_RE, (_line, file: string, title: string) => {
    const href = file.trim();
    result.push({ kind: 'externalpage', href, title: title.trim() || href });
    return '';
  });

  // each separator line owns the text up to the next one; text before the
  // first separator belongs to no page
  const separators = [...text.matchAll(PAGE_SEPARATOR_RE)];
  separators.forEach((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < separators.length ? separators[i + 1].index! : text.length;
    const content = text.slice(start, end);
    if (TITLE_PAGE_RE.test(m[0])) {
      result.push({ kind: 'titlepage', content });
      return;
    }
    const page = PAGE_RE.exec(m[0]);
    if (!page) return;
    const name = page[1].trim();
    result.push({ kind: 'page', fileName: sanitizePageFileName(name, '.html'), title: page[2].trim() || name, content });
  });
  return result;
}

/** Eclipse's sanitizeFileName: characters that may be invalid in file names,
 *  need quoting in an href, or differ between encodings become `_`. */
export function sanitizePageFileName(fileName: string, requiredSuffix: string): string {
  let s = fileName.trim().replace(/\s+/g, '-').replace(/\[/g, '(').replace(/\]/g, ')');
  s = s.replace(/[^-A-Za-z0-9!@$(){};+=.]/g, '_');
  return s.endsWith(requiredSuffix) ? s : s + requiredSuffix;
}
