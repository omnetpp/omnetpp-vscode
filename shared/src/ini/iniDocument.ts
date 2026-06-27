import type { Range } from '../model/location';

export interface IniEntry {
  /** The key, e.g. "network", "**.app.typename", "sim-time-limit". */
  key: string;
  /** The raw value text (comment stripped, trimmed). */
  value: string;
  keyRange: Range;
  valueRange: Range;
  /** 0-based line of the key. */
  line: number;
}

export type SectionType = 'general' | 'config';

export interface IniSection {
  /** Raw header content, e.g. "General" or "Config Foo". */
  rawName: string;
  type: SectionType;
  /** For config sections, the config name (e.g. "Foo"); undefined for [General]. */
  configName?: string;
  /** Section names this section extends (from an `extends=` entry). */
  extends: string[];
  /** Range of the whole section (header through last entry). */
  range: Range;
  headerRange: Range;
  entries: IniEntry[];
}

export interface IniInclude {
  path: string;
  line: number;
  range: Range;
}

export interface IniDocument {
  sections: IniSection[];
  includes: IniInclude[];
}

/** Whether the character at index i is escaped by an odd run of backslashes. */
function isEscaped(s: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) n++;
  return n % 2 === 1;
}

function stripComment(line: string): string {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && !isEscaped(line, i)) inStr = !inStr;
    else if (c === '#' && !inStr) return line.slice(0, i);
  }
  return line;
}

const SECTION_RE = /^\s*\[(.*)\]\s*$/;
const INCLUDE_RE = /^\s*include\s+(.+?)\s*$/;

/**
 * Parses an OMNeT++ ini file into sections and entries. Handles `#` comments,
 * backslash line continuation, `[General]`/`[Config X]` sections, `include`
 * directives, and recognizes `extends=` for section inheritance.
 */
export function parseIni(text: string): IniDocument {
  const lines = text.split(/\r?\n/);
  const sections: IniSection[] = [];
  const includes: IniInclude[] = [];

  // Implicit [General] section for entries before the first header.
  let current: IniSection | undefined;

  const ensureGeneral = (line: number): IniSection => {
    if (!current) {
      // implicit [General] has no header; anchor it at the top of the file
      current = {
        rawName: 'General',
        type: 'general',
        extends: [],
        range: { start: { line: 0, character: 0 }, end: { line, character: 0 } },
        headerRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        entries: [],
      };
      sections.push(current);
    }
    return current;
  };

  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i];
    const stripped = stripComment(raw);

    const sectionMatch = SECTION_RE.exec(stripped);
    if (sectionMatch) {
      const rawName = sectionMatch[1].trim();
      const isGeneral = rawName === 'General';
      // The `Config` prefix is optional in OMNeT++: `[Foo]` ≡ `[Config Foo]`.
      // Every non-[General] section is a config; its name is the header minus an
      // optional `Config ` prefix.
      const configName = isGeneral ? undefined : rawName.replace(/^Config\s+/, '').trim();
      const headerEnd = stripped.trimEnd().length; // exclude trailing comment/whitespace
      current = {
        rawName,
        type: isGeneral ? 'general' : 'config',
        configName,
        extends: [],
        range: { start: { line: i, character: 0 }, end: { line: i, character: headerEnd } },
        headerRange: { start: { line: i, character: 0 }, end: { line: i, character: headerEnd } },
        entries: [],
      };
      sections.push(current);
      continue;
    }

    const includeMatch = INCLUDE_RE.exec(stripped);
    if (includeMatch && !stripped.includes('=')) {
      includes.push({
        path: includeMatch[1].trim(),
        line: i,
        range: { start: { line: i, character: 0 }, end: { line: i, character: raw.length } },
      });
      continue;
    }

    if (!stripped.trim()) continue;

    // key = value (support line continuation)
    const eq = indexOfUnquoted(stripped, '=');
    if (eq < 0) continue;

    const startLine = i;
    const keyRaw = stripped.slice(0, eq);
    const key = keyRaw.trim();
    const keyStart = keyRaw.length - keyRaw.trimStart().length;
    let value = stripped.slice(eq + 1);
    const valueStartChar = eq + 1 + (value.length - value.trimStart().length);
    let endLine = startLine;

    // line continuation: a trailing backslash joins the next line
    while (value.trimEnd().endsWith('\\') && i + 1 < lines.length) {
      value = value.trimEnd().slice(0, -1);
      i++;
      raw = lines[i];
      value += '\n' + stripComment(raw);
      endLine = i;
    }

    const trimmedValue = value.trim();
    // precise value end (excludes trailing comment/whitespace)
    const valueEnd =
      endLine === startLine
        ? { line: startLine, character: valueStartChar + trimmedValue.length }
        : { line: endLine, character: stripComment(lines[endLine]).trimEnd().length };
    const entry: IniEntry = {
      key,
      value: trimmedValue,
      keyRange: {
        start: { line: startLine, character: keyStart },
        end: { line: startLine, character: keyStart + key.length },
      },
      valueRange: {
        start: { line: startLine, character: valueStartChar },
        end: valueEnd,
      },
      line: startLine,
    };

    const sec = ensureGeneral(startLine);
    sec.entries.push(entry);
    if (key === 'extends') {
      sec.extends = trimmedValue.split(',').map((s) => s.trim()).filter(Boolean);
    }
    sec.range.end = valueEnd;
  }

  return { sections, includes };
}

/** A config section summarized for the Configurations view / run selectors. */
export interface ConfigSummary {
  /** Canonical config name (the `Config ` prefix, if any, stripped). */
  name: string;
  /** Raw header content, e.g. "Config Foo" or "Foo". */
  rawName: string;
  /** Header range, for navigation. */
  range: Range;
  /** Declared `abstract = true` in this very section (abstract is NOT inherited). */
  abstract: boolean;
  extends: string[];
  description?: string;
}

const TRUE_RE = /^(true|1|yes)$/i;

/**
 * Summarize the named config sections of an ini document (skips `[General]`).
 * `abstract` reflects only the section's own `abstract = true` entry, matching
 * OMNeT++ semantics where abstractness is not inherited from base configs.
 */
export function configSummaries(doc: IniDocument): ConfigSummary[] {
  return doc.sections
    .filter((s) => s.type === 'config' && s.configName)
    .map((s) => ({
      name: s.configName!,
      rawName: s.rawName,
      range: s.headerRange,
      abstract: s.entries.some((e) => e.key === 'abstract' && TRUE_RE.test(e.value.trim())),
      extends: s.extends,
      description: s.entries.find((e) => e.key === 'description')?.value || undefined,
    }));
}

function indexOfUnquoted(s: string, ch: string): number {
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && !isEscaped(s, i)) inStr = !inStr;
    else if (c === ch && !inStr) return i;
  }
  return -1;
}
