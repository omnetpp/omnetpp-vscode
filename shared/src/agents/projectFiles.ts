// The files that "Set Up AI Agents" writes into a project. Each merge keeps the
// user's own content: Markdown gets one marker-delimited block that a later run
// replaces, JSONC gets entries inserted in place so comments survive.

import { blankComments, parseJsonc, stringEnd } from '../project/jsonc';

export const BLOCK_BEGIN = '<!-- omnetpp:begin';
export const BLOCK_END = '<!-- omnetpp:end -->';
export const CLAUDE_IMPORT = '@AGENTS.md';

/** What the AGENTS.md block says about the project; paths are relative to the project root. */
export interface ProjectFacts {
  /** NED source folders inside the project ('.' for the project root). */
  nedRoots: string[];
  /** `omnetpp.nedPath` entries, as written in the settings. */
  nedPathEntries: string[];
  iniFiles: string[];
  hasMakefile: boolean;
}

const MAX_INI_FILES = 10;

function codeList(items: string[]): string {
  return items.map((i) => `\`${i}\``).join(', ');
}

/** The managed AGENTS.md block, markers included. */
export function agentsMdBlock(facts: ProjectFacts): string {
  const lines = [
    `${BLOCK_BEGIN} (written by "OMNeT++: Set Up AI Agents"; edits inside this block are replaced on the next run) -->`,
    '## OMNeT++ project',
    '',
    'This is an OMNeT++ simulation model: NED files describe the network topology and modules,',
    'MSG files the message classes, INI files the simulation configurations, and C++ files the',
    'module behavior.',
    '',
  ];
  if (facts.nedRoots.length) lines.push(`- NED source folders: ${codeList(facts.nedRoots)}`);
  if (facts.nedPathEntries.length) {
    lines.push(`- Other projects on the NED path (\`omnetpp.nedPath\` in \`.vscode/settings.json\`): ${codeList(facts.nedPathEntries)}`);
  }
  if (facts.iniFiles.length) {
    const shown = facts.iniFiles.slice(0, MAX_INI_FILES);
    const more = facts.iniFiles.length - shown.length;
    lines.push(`- Simulation configurations: ${codeList(shown)}${more > 0 ? ` and ${more} more` : ''}`);
  }
  if (facts.hasMakefile) lines.push('- Build: `make` in the project root (`make MODE=debug` for a debug build).');
  lines.push(
    '',
    'When you work with NED, MSG or INI files:',
    '',
    '- Ask the `omnetpp` MCP tools (types, parameters, gates, usages, effective INI values) instead',
    '  of searching the text; the `omnetpp-tooling` skill tells which tool answers what.',
    '- Check every `.ned`, `.msg` or `.ini` file you change: `opp_lint <file>` from the project',
    '  root, or the `get_diagnostics` MCP tool. With the OMNeT++ agent plugin, the diagnostics',
    '  come back automatically after each edit.',
    BLOCK_END,
  );
  return lines.join('\n');
}

/** Put `block` into `text`: replace the existing managed block, or append it. */
export function mergeMarkerBlock(text: string | undefined, block: string): string {
  if (!text?.trim()) return `${block}\n`;
  const begin = text.indexOf(BLOCK_BEGIN);
  const end = begin < 0 ? -1 : text.indexOf(BLOCK_END, begin);
  if (begin >= 0 && end >= 0) return text.slice(0, begin) + block + text.slice(end + BLOCK_END.length);
  return `${text.trimEnd()}\n\n${block}\n`;
}

/** `text` with an `@AGENTS.md` import line, so that Claude also reads AGENTS.md
 *  (it reads AGENTS.md on its own only when there is no CLAUDE.md). */
export function ensureClaudeImport(text: string): string {
  if (new RegExp(`^\\s*${CLAUDE_IMPORT.replace('.', '\\.')}\\s*$`, 'm').test(text)) return text;
  return `${text.trimEnd()}\n\n${CLAUDE_IMPORT}\n`;
}

/** Index of the bracket that closes the one at `open`, in comment-blanked text. */
function closingBracket(blanked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < blanked.length; i++) {
    const c = blanked[i];
    if (c === '"') {
      i = stringEnd(blanked, i) - 1;
    } else if (c === '[' || c === '{') {
      depth++;
    } else if (c === ']' || c === '}') {
      if (--depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the last non-whitespace character before `end`. */
function lastNonSpace(blanked: string, end: number): number {
  let i = end - 1;
  while (i >= 0 && /\s/.test(blanked[i])) i--;
  return i;
}

/**
 * `.vscode/extensions.json` text with `ids` in its recommendations, inserted in place
 * so comments and formatting survive. Returns `text` unchanged when nothing is
 * missing, and undefined when `text` is not a JSONC object.
 */
export function mergeExtensionRecommendations(text: string | undefined, ids: string[]): string | undefined {
  if (!text?.trim()) return `${JSON.stringify({ recommendations: ids }, null, 2)}\n`;
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const existing = (parsed as { recommendations?: unknown }).recommendations;
  if (existing !== undefined && !Array.isArray(existing)) return undefined;
  const have = new Set((existing ?? []).map((x) => String(x).toLowerCase()));
  const missing = ids.filter((id) => !have.has(id.toLowerCase()));
  if (!missing.length) return text;
  const items = missing.map((id) => JSON.stringify(id)).join(', ');

  const blanked = blankComments(text);
  const insertAfter = (at: number, open: string, value: string): string => {
    const close = closingBracket(blanked, at);
    const last = lastNonSpace(blanked, close);
    const sep = blanked[last] === open || blanked[last] === ',' ? '' : ', ';
    return text.slice(0, last + 1) + sep + value + text.slice(last + 1);
  };
  if (existing !== undefined) {
    const key = /"recommendations"\s*:\s*\[/.exec(blanked);
    if (!key) return undefined;
    return insertAfter(key.index + key[0].length - 1, '[', items);
  }
  const open = blanked.indexOf('{');
  const close = closingBracket(blanked, open);
  const empty = lastNonSpace(blanked, close) === open;
  const member = `\n  "recommendations": [${items}]${empty ? '\n' : ','}`;
  return text.slice(0, open + 1) + member + text.slice(open + 1);
}
