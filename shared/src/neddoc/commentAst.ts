/**
 * NED/MSG documentation comment parser: a faithful port of the Eclipse IDE's
 * `NedCommentFormatter.makeHtmlDocu()` (org.omnetpp.common) — but instead of
 * rewriting the comment string straight to HTML, it parses the same syntax
 * into a small document AST so the doc generator can emit HTML, Markdown and
 * reStructuredText from a single parse (see commentEmit.ts).
 *
 * Input syntax (see the Java class for the authoritative rules):
 *  - lines starting with `//#` are private and dropped
 *  - `@include <file>` pulls in another file's text (circular includes detected)
 *  - blank lines separate paragraphs; a line of 6+ dashes is a horizontal rule
 *  - `- ` / `-# ` start unordered/ordered list items; leading indentation
 *    nests deeper (thresholds 4/7/10 spaces, max 4 levels)
 *  - `` `text` `` renders as inline code
 *  - @author/@date/@todo/@bug/@see/@since/@warning/@version become bold labels
 *  - http(s):// URLs are auto-linked
 *  - a small allowlist of HTML tags (DOC_TAGS) passes through; any other angle
 *    brackets are literal text; `<pre>` protects its content from
 *    restructuring; `<nohtml>` content is fully verbatim (no links, no tags)
 *  - type references: in tilde mode only `~Name` is linked (`~~` = literal
 *    tilde, unknown names are flagged as errors); in automatic mode every
 *    known type name is linked (`\Name` suppresses, `\\` = literal backslash)
 *    and a `~` in front of a linked name is dropped as reference markup
 *
 * Host-agnostic: no vscode/Node imports; `@include` resolution is injected.
 */

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type DocInline =
  /** Plain text; emitters escape it for their format. */
  | { kind: 'text'; text: string }
  /** `backtick` code span. */
  | { kind: 'code'; text: string }
  /** Bold doc-keyword label, e.g. "Author:" (starts its own paragraph). */
  | { kind: 'boldlabel'; label: string }
  /** Auto-linked http(s) URL. */
  | { kind: 'url'; href: string }
  /** Type reference. `targets` holds opaque ids from the resolver: one =
   *  plain link, several = ambiguous simple name (rendered "Name(1,2,3)"),
   *  empty = unresolved `~ref` (rendered error-styled). */
  | { kind: 'typeref'; name: string; targets: string[] }
  /** Allowlisted HTML tag passed through from the comment text. */
  | { kind: 'html'; tag: string; attrs: string; closing: boolean; selfClosing: boolean }
  /** `<nohtml>` content: rendered fully verbatim (escaped, never linked). */
  | { kind: 'literal'; text: string };

export interface DocListItem {
  /** Nesting level 1..4 (from the item's leading indentation). */
  level: number;
  inlines: DocInline[];
}

export type DocBlock =
  | { kind: 'para'; inlines: DocInline[] }
  | { kind: 'list'; ordered: boolean; items: DocListItem[] }
  /** `<pre>` block: content keeps its line structure; URLs/type refs/HTML
   *  tags are still recognized inside (as in the Java pipeline), but no
   *  paragraph/list/code-span restructuring happens. */
  | { kind: 'pre'; inlines: DocInline[] }
  | { kind: 'hrule' };

// ---------------------------------------------------------------------------
// Parse context
// ---------------------------------------------------------------------------

export interface IncludeResolution {
  /** Identity used for circular-include detection (e.g. canonical path). */
  id: string;
  content: string;
}

export interface CommentParseCtx {
  /** 'automatic': every known type name is linked, `\` suppresses.
   *  'tilde': only `~Name` is linked, unknown `~name` is an error. */
  hyperlinkMode: 'automatic' | 'tilde';
  /** Resolve a (possibly qualified) type name to opaque link-target ids.
   *  Return undefined/[] when unknown; several ids for an ambiguous simple
   *  name. */
  lookupTypeName: (name: string) => string[] | undefined;
  /** Resolve an `@include <ref>` directive (relative to the including file,
   *  identified by fromId; undefined fromId = the comment's own file). */
  resolveInclude?: (fileRef: string, fromId: string | undefined) => IncludeResolution | undefined;
  /** Collects non-fatal problems (missing/circular includes). */
  warnings?: string[];
}

/** The HTML tags that NED doc comments may contain (Keywords.DOC_TAGS in the
 *  Eclipse IDE); anything else renders as literal text. */
export const DOC_TAGS = new Set([
  'a', 'b', 'body', 'br', 'center', 'caption', 'code', 'dd', 'dfn', 'dl', 'dt', 'em',
  'form', 'font', 'hr', 'h1', 'h2', 'h3', 'i', 'input', 'img', 'li', 'meta', 'multicol',
  'ol', 'p', 'pre', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'td', 'th', 'tr',
  'tt', 'kbd', 'u', 'ul', 'var',
]);

// Character classes from Keywords.java (rudimentary i18n identifier support).
const QCHAR = '[A-Za-z0-9_.:\\u0080-\\uffff]'; // may occur in qualified NED/C++ names
const NED_IDENT = '[A-Za-z_\\u0080-\\uffff][A-Za-z0-9_\\u0080-\\uffff]*';
const MSG_IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const NED_TYPE_RE = new RegExp(`^${NED_IDENT}(\\.${NED_IDENT})*`);
const MSG_TYPE_RE = new RegExp(`^(::)?${MSG_IDENT}(::${MSG_IDENT})*`);
const QCHAR_RE = new RegExp(QCHAR);

// Sentinels protecting extracted regions through the string-level passes
// (NUL cannot occur in source text, so they are collision-free).
const S = '\u0000';
const sentinel = (tag: string, n: number) => `${S}${tag}${n}${S}`;
const HR_SENTINEL = `${S}hr${S}`;
const SENT_RE = /\u0000(pre|nohtml|kw)(\d+)\u0000/g;

const DOC_KEYWORDS = ['author', 'date', 'todo', 'bug', 'see', 'since', 'warning', 'version'] as const;
const DOC_KEYWORD_LABELS = ['Author:', 'Date:', 'TODO:', 'BUG:', 'See also:', 'Since:', 'WARNING:', 'Version:'];

// ---------------------------------------------------------------------------
// @include expansion (port of DocumentationGenerator.getExpandedComment)
// ---------------------------------------------------------------------------

const INCLUDE_RE = /^\/\/[ \t]*@include[ \t]+(.*?)$/gm;

function expandIncludes(comment: string, ctx: CommentParseCtx, fromId: string | undefined, parents: string[]): string {
  if (!comment.includes('@include') || !ctx.resolveInclude) return comment;
  return comment.replace(INCLUDE_RE, (whole, fileRef: string) => {
    const resolved = ctx.resolveInclude!(fileRef.trim(), fromId);
    if (!resolved) {
      ctx.warnings?.push(`cannot resolve @include ${fileRef.trim()}`);
      return whole;
    }
    if (parents.includes(resolved.id)) {
      ctx.warnings?.push(`circular @include: ${[...parents, resolved.id].join(' --> ')}`);
      return whole;
    }
    // prepend '// ' so the included text goes through the same comment passes
    let content = resolved.content.replace(/^/gm, '// ');
    content = expandIncludes(content, ctx, resolved.id, [...parents, resolved.id]);
    return content;
  });
}

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

/** Parse a raw NED/MSG doc comment (the `//` markers still present) into the
 *  doc AST. Mirrors NedCommentFormatter.makeHtmlDocu step by step. */
export function parseNedComment(raw: string, ctx: CommentParseCtx, brief = false): DocBlock[] {
  // kill CRs, add sentries to simplify the line-oriented regexes
  let text = '\n\n' + raw.replace(/\r/g, '') + '\n\n';

  // expand @include (operates on the still-marker-prefixed text)
  text = expandIncludes(text, ctx, undefined, []);

  // remove '//#' private lines
  text = text.replace(/(?<=\n)[ \t]*\/\/#.*?\n/g, '\n');

  // remove '// ', '/// ', '//////...' from line starts
  text = text.replace(/\n[ \t]*\/\/+ ?/g, '\n');

  // protect <nohtml> and <pre> regions from all restructuring below
  // (nohtml first: a <pre> inside <nohtml> stays literal, as in Eclipse)
  const nohtmlRegions: string[] = [];
  text = text.replace(/<nohtml>([\s\S]*?)<\/nohtml>/g, (_m, body: string) => {
    nohtmlRegions.push(body);
    return sentinel('nohtml', nohtmlRegions.length - 1);
  });
  const preRegions: string[] = [];
  text = text.replace(/<pre>([\s\S]*?)<\/pre>/g, (_m, body: string) => {
    preRegions.push(body);
    return `\n\n${sentinel('pre', preRegions.length - 1)}\n\n`;
  });

  // a line of dashes outside <pre> becomes a horizontal rule
  text = text.replace(/\n[ \t]*------+[ \t]*\n/g, `\n\n${HR_SENTINEL}\n\n`);

  // whitespace-only lines count as blank
  text = text.replace(/\n[ \t]+\n/g, '\n\n');

  // blank line in front of list items so they break paragraphs
  text = text.replace(/\n( *-#? )/g, '\n\n$1');

  // brief mode: keep only the first paragraph
  if (brief) text = text.replace(/^([\s\S]*?[^ \t\n][\s\S]*?)\n\n[\s\S]*$/, '$1\n\n');

  // doc keywords start a fresh paragraph with a bold label
  text = text.replace(
    new RegExp(`@(${DOC_KEYWORDS.join('|')})\\b`, 'g'),
    (_m, kw: string) => `\n\n${sentinel('kw', DOC_KEYWORDS.indexOf(kw as (typeof DOC_KEYWORDS)[number]))}`,
  );

  // collapse excess blank lines and split into blocks
  text = text.replace(/\n\n\n+/g, '\n\n');
  const rawBlocks = text.split(/\n\n+/).filter((b) => b.trim().length > 0);

  const blocks: DocBlock[] = [];
  for (const rawBlock of rawBlocks) {
    const trimmed = rawBlock.replace(/^\n+|\n+$/g, '');
    const preMatch = new RegExp(`^[ \\t]*${S}pre(\\d+)${S}[ \\t]*$`).exec(trimmed);
    if (preMatch) {
      blocks.push({
        kind: 'pre',
        inlines: parseInlines(preRegions[Number(preMatch[1])], ctx, nohtmlRegions, preRegions, { pre: true }),
      });
      continue;
    }
    if (trimmed.trim() === HR_SENTINEL) {
      blocks.push({ kind: 'hrule' });
      continue;
    }
    const itemMatch = /^( *)-(#?)[ \t]+([\s\S]*)$/.exec(trimmed);
    if (itemMatch) {
      const indent = itemMatch[1].length;
      // Eclipse thresholds: 10+/7+/4+ leading spaces = levels 4/3/2, else 1
      const level = indent >= 10 ? 4 : indent >= 7 ? 3 : indent >= 4 ? 2 : 1;
      const ordered = itemMatch[2] === '#';
      const item: DocListItem = { level, inlines: parseInlines(itemMatch[3], ctx, nohtmlRegions, preRegions, {}) };
      const last = blocks[blocks.length - 1];
      if (last && last.kind === 'list' && last.ordered === ordered) last.items.push(item);
      else blocks.push({ kind: 'list', ordered, items: [item] });
      continue;
    }
    // paragraphs shed their leading indentation (as the Java <p> wrapping does)
    blocks.push({ kind: 'para', inlines: parseInlines(trimmed.replace(/^[ \t]+/, ''), ctx, nohtmlRegions, preRegions, {}) });
  }
  return blocks;
}

/** First paragraph of the comment (for table "Description" columns). */
export function parseBriefComment(raw: string, ctx: CommentParseCtx): DocBlock[] {
  return parseNedComment(raw, ctx, true);
}

/** One-line plain-text brief description (port of makeBriefDocu): first
 *  sentence or paragraph, known HTML tags stripped, abbreviated to maxlen. */
export function briefText(raw: string, maxlen = 1000): string {
  let comment = raw.replace(/\r/g, '');
  comment = comment.replace(/^\s*\/\/#.*$/gm, ''); // remove '//#' lines
  comment = comment.replace(/^[ \t]*\/\//gm, ''); // remove "//"s
  comment = comment.replace(/\n[ \t]*\n[\s\S]*/, ''); // first paragraph only
  comment = comment.replace(/\.\s[\s\S]*/, '.'); // first sentence only
  comment = stripKnownTags(comment);
  comment = comment.replace(/\s+/g, ' ').trim();
  if (comment.length > maxlen) comment = comment.slice(0, Math.max(0, maxlen - 3)).trimEnd() + '...';
  return comment;
}

function stripKnownTags(text: string): string {
  return text.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)( [^\n]*?)?\/?>/g, (m, tag: string) =>
    DOC_TAGS.has(tag.toLowerCase()) ? '' : m,
  );
}

// ---------------------------------------------------------------------------
// Inline tokenizer
// ---------------------------------------------------------------------------

interface InlineOpts {
  /** Inside <pre>: no code spans (backticks stay literal). */
  pre?: boolean;
}

function parseInlines(
  text: string,
  ctx: CommentParseCtx,
  nohtmlRegions: string[],
  preRegions: string[],
  opts: InlineOpts,
): DocInline[] {
  const out: DocInline[] = [];
  const pushText = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.kind === 'text') last.text += t;
    else out.push({ kind: 'text', text: t });
  };

  // Split off protected-region / doc-keyword sentinels first. split() with a
  // 2-group regex yields [text, tag, num, text, tag, num, ..., text].
  const segments = text.split(SENT_RE);
  for (let i = 0; i < segments.length; i += 3) {
    const plain = segments[i];
    if (plain) tokenizePlain(plain, ctx, out, pushText, opts);
    const tag = segments[i + 1];
    const num = Number(segments[i + 2]);
    if (tag === 'nohtml') out.push({ kind: 'literal', text: nohtmlRegions[num] });
    else if (tag === 'kw') out.push({ kind: 'boldlabel', label: DOC_KEYWORD_LABELS[num] });
    else if (tag === 'pre') out.push(...parseInlines(preRegions[num], ctx, nohtmlRegions, preRegions, { pre: true }));
  }
  return out;
}

// Inline token scanner over a plain text segment: code spans, HTML tags,
// URLs, then type references within the remaining text runs.
function tokenizePlain(
  text: string,
  ctx: CommentParseCtx,
  out: DocInline[],
  pushText: (t: string) => void,
  opts: InlineOpts,
): void {
  // token: `code` (same line) | <tag ...> | </tag> | URL
  const tokenRe = opts.pre
    ? /(<\/?[a-zA-Z][a-zA-Z0-9]*(?: [^<>\n]*?)?\/?>)|(https?:\/\/[^\s]+[^\s.,;"'])/g
    : /(`[^`\n]*`)|(<\/?[a-zA-Z][a-zA-Z0-9]*(?: [^<>\n]*?)?\/?>)|(https?:\/\/[^\s]+[^\s.,;"'])/g;
  let last = 0;
  for (let m = tokenRe.exec(text); m; m = tokenRe.exec(text)) {
    emitTextWithTypeRefs(text.slice(last, m.index), ctx, out, pushText);
    const token = m[0];
    if (token.startsWith('`')) {
      out.push({ kind: 'code', text: token.slice(1, -1) });
    } else if (token.startsWith('<')) {
      const tagMatch = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?: [^<>\n]*?)?)(\/?)>$/.exec(token)!;
      const tagName = tagMatch[2].toLowerCase();
      if (DOC_TAGS.has(tagName)) {
        out.push({
          kind: 'html',
          tag: tagName,
          attrs: tagMatch[3].trim(),
          closing: tagMatch[1] === '/',
          selfClosing: tagMatch[4] === '/',
        });
      } else {
        pushText(token); // unknown tag stays literal text
      }
    } else {
      out.push({ kind: 'url', href: token });
    }
    last = m.index + token.length;
  }
  emitTextWithTypeRefs(text.slice(last), ctx, out, pushText);
}

// ---------------------------------------------------------------------------
// Type-reference recognition (port of replaceTypeReferences)
// ---------------------------------------------------------------------------

function emitTextWithTypeRefs(
  text: string,
  ctx: CommentParseCtx,
  out: DocInline[],
  pushText: (t: string) => void,
): void {
  if (!text) return;
  const tilde = ctx.hyperlinkMode === 'tilde';
  // Tilde mode: tildes + candidate name. Auto mode: optional backslashes +
  // candidate name (rejected below when it starts inside an identifier).
  const candidateRe = tilde
    ? new RegExp(`(~+)(${QCHAR}*[A-Za-z0-9_\\u0080-\\uffff])`, 'g')
    : new RegExp(`(\\\\*)(${QCHAR}+)`, 'g');
  let last = 0;
  for (let m = candidateRe.exec(text); m; m = candidateRe.exec(text)) {
    const prefixes = m[1]; // tildes or backslashes
    if (!tilde && prefixes.length === 0) {
      // Java's (?<!QCHAR) lookbehind: names right after an identifier char
      // don't count (can only happen straight after a rejected candidate)
      const prev = m.index > 0 ? text[m.index - 1] : '';
      if ((prev && QCHAR_RE.test(prev)) || !mayBeTypeName(m[2], ctx)) {
        pushText(text.slice(last, candidateRe.lastIndex));
        last = candidateRe.lastIndex;
        continue;
      }
    }
    let before = text.slice(last, m.index);
    last = candidateRe.lastIndex;

    let identifier = m[2];

    // refine the candidate: match as NED name and as C++ name, take the longer
    const nedLen = NED_TYPE_RE.exec(identifier)?.[0].length ?? 0;
    const msgLen = MSG_TYPE_RE.exec(identifier)?.[0].length ?? 0;
    const len = Math.max(nedLen, msgLen);
    if (len === 0) {
      pushText(before + m[0]); // false positive (e.g. "~123"), leave as-is
      continue;
    }
    let suffix = identifier.slice(len);
    identifier = identifier.slice(0, len);

    let targets = ctx.lookupTypeName(identifier);

    // enum-member fallback: "State::IDLE" -> type "State" + suffix "::IDLE"
    if ((!targets || targets.length === 0) && identifier.includes('::')) {
      const pos = identifier.lastIndexOf('::');
      const found = ctx.lookupTypeName(identifier.slice(0, pos));
      if (found && found.length > 0) {
        suffix = identifier.slice(pos) + suffix;
        identifier = identifier.slice(0, pos);
        targets = found;
      }
    }

    // automatic mode matches KNOWN names (Java builds a regex from them), so
    // a shorter qualified prefix of the candidate may be the actual match:
    // known "Foo" in "Foo.bar" links "Foo" and leaves ".bar" as text
    if (!tilde && (!targets || targets.length === 0)) {
      let name = identifier;
      for (;;) {
        const pos = Math.max(name.lastIndexOf('::'), name.lastIndexOf('.'));
        if (pos <= 0) break;
        name = name.slice(0, pos);
        const found = ctx.lookupTypeName(name);
        if (found && found.length > 0) {
          suffix = identifier.slice(name.length) + suffix;
          identifier = name;
          targets = found;
          break;
        }
      }
    }

    // doubled prefix chars mean one literal char in the output
    const even = prefixes.length % 2 === 0;
    const literalPrefix = prefixes.slice(0, Math.floor(prefixes.length / 2));

    const shouldLink = tilde ? !even : even && targets !== undefined && targets.length > 0;
    // automatic mode: a `~` right before a linked name is tilde-mode reference
    // markup (common in existing comments, e.g. "@see ~Foo"), not text.
    // Eclipse keeps it, which in RST glues it to the role and breaks the link.
    if (shouldLink && !tilde && !literalPrefix && before.endsWith('~')) before = before.slice(0, -1);
    pushText(before);
    if (literalPrefix) pushText(literalPrefix);
    if (shouldLink) {
      out.push({ kind: 'typeref', name: identifier, targets: targets ?? [] });
      if (suffix) pushText(suffix);
    } else {
      pushText(identifier + suffix);
    }
  }
  pushText(text.slice(last));
}

// Fast pre-filter for automatic mode: could this candidate (or one of its
// qualified prefixes) possibly be a known type name?
function mayBeTypeName(candidate: string, ctx: CommentParseCtx): boolean {
  const found = ctx.lookupTypeName(candidate);
  if (found && found.length > 0) return true;
  let name = candidate;
  for (;;) {
    const pos = Math.max(name.lastIndexOf('::'), name.lastIndexOf('.'));
    if (pos <= 0) return false;
    name = name.slice(0, pos);
    const t = ctx.lookupTypeName(name);
    if (t && t.length > 0) return true;
  }
}
