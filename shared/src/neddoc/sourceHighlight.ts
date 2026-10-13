/**
 * Syntax highlighting of the NED/MSG source listings: a port of the Eclipse
 * IDE's lexical highlighter used by the neddoc generator
 * (Ned/MsgSyntaxHighlightPartitionScanner, the *CodeColorizerScanner,
 * *DocColorizerScanner and *PrivateDocColorizerScanner classes,
 * SyntaxHighlightHelper and Keywords). Word lists, not a parse: the listings
 * look like the IDE's editor, including on code the grammar rejects.
 */

import { escapeHtmlText } from './commentEmit';
import { DOC_TAGS } from './commentAst';

export type SourceTokenClass =
  | 'keyword'
  | 'function'
  | 'type'
  | 'string'
  | 'number'
  | 'property'
  | 'comment'
  | 'comment-keyword'
  | 'comment-tag'
  | 'private'
  | 'private-todo';

export interface SourceToken {
  text: string;
  /** undefined: identifiers, punctuation and whitespace of the code. */
  cls?: SourceTokenClass;
}

const BOOL_CONSTANTS = ['false', 'true', 'undefined', 'nan', 'inf', 'null', 'nullptr'];
const DOC_KEYWORDS = new Set(['author', 'bug', 'date', 'see', 'since', 'todo', 'version', 'warning', 'page', 'titlepage'].map((k) => '@' + k));
const DOC_TODO = new Set(['CHECKME', 'FIXME', 'TBD', 'TODO']);
const NED_SPECIAL = new Set(['-->', '<--', '<-->', '..']);

const NED_KEYWORDS = [
  'channel', 'channelinterface', 'simple', 'module', 'network', 'moduleinterface',
  'parameters', 'gates', 'types', 'submodules', 'connections',
  'allowunconnected', 'extends', 'for', 'if', 'import', 'like', 'package', 'property',
  'sizeof', 'const', 'default', 'ask', 'this', 'parent', 'index', 'typename',
];
const NED_TYPES = ['inout', 'input', 'output', 'bool', 'double', 'int', 'string', 'object', 'xml', 'volatile'];
const NED_FUNCTIONS = [
  'acos', 'ancestorIndex', 'asin', 'atan', 'atan2', 'bernoulli', 'beta', 'binomial', 'cauchy', 'ceil',
  'chi_square', 'choose', 'contains', 'convertUnit', 'cos', 'dropUnit', 'endsWith', 'erlang_k', 'exp',
  'expand', 'exponential', 'fabs', 'firstAvailable', 'floor', 'fmod', 'fullName', 'fullPath', 'gamma_d',
  'genk_exponential', 'genk_intuniform', 'genk_normal', 'genk_truncnormal', 'genk_uniform', 'geometric',
  'hypergeometric', 'hypot', 'indexOf', 'intuniform', 'intuniformexl', 'length', 'log', 'log10',
  'lognormal', 'max', 'min', 'negbinomial', 'normal', 'parentIndex', 'pareto_shifted', 'poisson', 'pow',
  'replace', 'replaceFirst', 'replaceUnit', 'select', 'simTime', 'sin', 'sqrt', 'startsWith', 'student_t',
  'substring', 'substringAfter', 'substringAfterLast', 'substringBefore', 'substringBeforeLast', 'tail',
  'tan', 'toLower', 'toUpper', 'triang', 'trim', 'truncnormal', 'uniform', 'unitOf', 'weibull', 'xml',
  'xmldoc',
];
const MSG_KEYWORDS = ['cplusplus', 'namespace', 'struct', 'message', 'packet', 'class', 'enum', 'extends', 'import', 'properties', 'fields'];
const MSG_TYPES = [
  'abstract', 'bool', 'char', 'short', 'int', 'long', 'float', 'double', 'unsigned', 'string', 'simtime_t',
  'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64',
];

/** Word → class; later lists win, as with Eclipse's WordRule.addWord(). */
function wordTable(lists: [string[], SourceTokenClass][]): Map<string, SourceTokenClass> {
  const table = new Map<string, SourceTokenClass>();
  for (const [words, cls] of lists) for (const w of words) table.set(w, cls);
  return table;
}

const NED_WORDS = wordTable([
  [NED_KEYWORDS, 'keyword'],
  [NED_FUNCTIONS, 'function'],
  [NED_TYPES, 'type'],
  [BOOL_CONSTANTS, 'string'],
]);
const MSG_WORDS = wordTable([
  [MSG_KEYWORDS, 'keyword'],
  [MSG_TYPES, 'type'],
  [BOOL_CONSTANTS, 'string'],
]);

const WORD_RE = /[\p{L}_@][\p{L}\p{N}_]*/uy;
const AT_WORD_RE = /@\p{L}*/uy;
const SPECIAL_RE = /[\p{L}\-<>.][\p{L}\-<>.:]*/uy;
const NUMBER_RE = /\p{Nd}+/uy;
const DOC_TAG_RE = /<\/?([A-Za-z0-9]+)(?:[ \t][^>\n]*)?\/?>/y;

function matchAt(re: RegExp, text: string, at: number): string | undefined {
  re.lastIndex = at;
  return re.exec(text)?.[0];
}

/** A `"..."` string on one line (backslash escapes), or undefined. */
function stringAt(text: string, at: number): string | undefined {
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '"') return text.slice(at, i + 1);
    else if (c === '\n') return undefined;
  }
  return undefined;
}

export function highlightSource(code: string, language: 'ned' | 'msg'): SourceToken[] {
  const out: SourceToken[] = [];
  const push = (text: string, cls?: SourceTokenClass) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.cls === cls) last.text += text;
    else out.push({ text, cls });
  };
  const words = language === 'ned' ? NED_WORDS : MSG_WORDS;

  const codeToken = (text: string, at: number): number => {
    const c = text[at];
    let m: string | undefined;
    if (c === '"' && (m = stringAt(text, at))) push(m, 'string');
    else if ((m = matchAt(NUMBER_RE, text, at))) push(m, 'number');
    else if (language === 'ned' && (m = matchAt(SPECIAL_RE, text, at)) && NED_SPECIAL.has(m)) push(m, 'keyword');
    else if (c === '@' && (m = matchAt(AT_WORD_RE, text, at))) push(m, 'property');
    else if ((m = matchAt(WORD_RE, text, at))) push(m, words.get(m));
    else push((m = c));
    return at + m.length;
  };

  const docToken = (text: string, at: number): number => {
    let m: string | undefined;
    const tag = text[at] === '<' ? (DOC_TAG_RE.lastIndex = at, DOC_TAG_RE.exec(text)) : null;
    if (tag && DOC_TAGS.has(tag[1].toLowerCase())) push((m = tag[0]), 'comment-tag');
    else if (text[at] === '@' && (m = matchAt(AT_WORD_RE, text, at)) && DOC_KEYWORDS.has(m)) push(m, 'comment-keyword');
    else push((m = text[at]), 'comment');
    return at + m.length;
  };

  const privateToken = (text: string, at: number): number => {
    const m = matchAt(WORD_RE, text, at) ?? text[at];
    push(m, DOC_TODO.has(m) ? 'private-todo' : 'private');
    return at + m.length;
  };

  // partitions: "strings" (so that // inside them is no comment), //# private
  // comments and // comments to the end of the line, code
  let i = 0;
  while (i < code.length) {
    if (code.startsWith('//', i)) {
      const eol = code.indexOf('\n', i);
      const end = eol < 0 ? code.length : eol;
      const scan = code.startsWith('//#', i) ? privateToken : docToken;
      const upToEol = code.slice(0, end);
      for (let j = i; j < end; ) j = scan(upToEol, j);
      i = end;
    } else {
      i = codeToken(code, i);
    }
  }
  return out;
}

const LIGHT_STYLES: Record<SourceTokenClass, string> = {
  keyword: 'color: #8b0000; font-weight: bold; ',
  function: 'color: #8b008b; ',
  type: 'color: #00008b; font-weight: bold; ',
  string: 'color: #006400; ',
  number: 'color: #006400; ',
  property: 'color: #1a1a1a; font-weight: bold; ',
  comment: 'color: #a9a9a9; font-style: italic; ',
  'comment-keyword': 'color: #00008b; ',
  'comment-tag': 'color: #8b0000; ',
  private: 'color: #cccccc; font-style: italic; ',
  'private-todo': 'color: #00008b; ',
};

/** The listing as HTML: `<span class="src-…">` for the stylesheet
 *  (SOURCE_HIGHLIGHT_CSS), or Eclipse's inline styles (HtmlRenderer.styled). */
export function highlightSourceHtml(code: string, language: 'ned' | 'msg', mode: 'class' | 'inline'): string {
  return highlightSource(code, language)
    .map(({ text, cls }) => {
      const html = escapeHtmlText(text);
      if (!cls) return html;
      return mode === 'class' ? `<span class="src-${cls}">${html}</span>` : `<span style="${LIGHT_STYLES[cls]}">${html}</span>`;
    })
    .join('');
}

/** Eclipse's light-theme colors; the comment grays are darker than Eclipse's
 *  so that they stay readable on the listing background. */
export const SOURCE_HIGHLIGHT_CSS = `
pre.src .src-keyword { color: #8b0000; font-weight: bold; }
pre.src .src-function { color: #8b008b; }
pre.src .src-type { color: #00008b; font-weight: bold; }
pre.src .src-string, pre.src .src-number { color: #006400; }
pre.src .src-property { font-weight: bold; }
pre.src .src-comment { color: #6a737d; font-style: italic; }
pre.src .src-comment-keyword, pre.src .src-private-todo { color: #00008b; font-style: italic; }
pre.src .src-comment-tag { color: #8b0000; font-style: italic; }
pre.src .src-private { color: #a0a0a0; font-style: italic; }
`;
