import type { Position, Range } from '../model/location';
import { CompletionItem, CompletionItemKind } from '../model/completion';
import { ConfigRegistry } from './configRegistry';
import { classifyKey } from './iniConfigChecks';
import type { IniDocument, IniEntry, IniSection } from './iniDocument';
import type { NedResourceCache } from '../ned/nedResourceCache';
import { matchedParamType, reachableParamPaths } from './iniParamCompletion';
import { PREDEFINED_VARS, findOccurrences, namedIterations, sectionChain } from './iniVariables';

function inRange(r: Range, pos: Position): boolean {
  if (pos.line < r.start.line || pos.line > r.end.line) return false;
  if (pos.line === r.start.line && pos.character < r.start.character) return false;
  if (pos.line === r.end.line && pos.character > r.end.character) return false;
  return true;
}

function entryAt(doc: IniDocument, pos: Position): IniEntry | undefined {
  for (const sec of doc.sections) {
    for (const e of sec.entries) {
      if (e.line === pos.line) return e;
    }
  }
  return undefined;
}

export interface HoverResult {
  markdown: string;
  range: Range;
}

export function iniHover(doc: IniDocument, registry: ConfigRegistry, pos: Position): HoverResult | null {
  const e = entryAt(doc, pos);
  if (!e) return null;

  // hovering an iteration variable inside a (single-line) value
  if (!e.value.includes('\n') && inRange(e.valueRange, pos)) {
    const v = variableHover(doc, e, pos);
    if (v) return v;
  }

  if (!inRange(e.keyRange, pos)) return null;
  const cls = classifyKey(registry, e.key);
  if (cls.kind !== 'config') return null;
  const o = cls.option;
  let md = `**${o.name}** \`${o.type}${o.unit ? ' (' + o.unit + ')' : ''}\``;
  if (o.default !== null && o.default !== '') md += ` — default: \`${o.default}\``;
  md += `\n\n${o.description}`;
  return { markdown: md, range: e.keyRange };
}

/** Hover text for a `${var}` token under the cursor within an entry value. */
function variableHover(doc: IniDocument, e: IniEntry, pos: Position): HoverResult | null {
  const offset = pos.character - e.valueRange.start.character;
  const occ = findOccurrences(e.value).find((o) => offset >= o.start && offset <= o.end);
  if (!occ) return null;
  const inner = occ.content.trim();
  const name = /^[a-zA-Z_][a-zA-Z0-9@_-]*$/.test(inner) ? inner : inner.split('=')[0].trim();
  const range: Range = {
    start: { line: e.valueRange.start.line, character: e.valueRange.start.character + occ.start },
    end: { line: e.valueRange.start.line, character: e.valueRange.start.character + occ.end },
  };
  if (PREDEFINED_VARS.has(name)) {
    return { markdown: `predefined variable \`\${${name}}\``, range };
  }
  const section = sectionAt(doc, e.line);
  if (section) {
    for (const sec of sectionChain(doc, section)) {
      const decl = namedIterations(sec).get(name);
      if (decl) return { markdown: `iteration variable \`\${${name}}\` = \`${decl.value}\``, range };
    }
  }
  return null;
}

function sectionAt(doc: IniDocument, line: number): IniSection | undefined {
  return doc.sections
    .filter((s) => s.range.start.line <= line)
    .sort((a, b) => b.range.start.line - a.range.start.line)[0];
}

/** The entry whose (possibly multi-line) value spans `line`, if `line` is a continuation. */
function valueContinuationEntry(doc: IniDocument, line: number): IniEntry | undefined {
  for (const sec of doc.sections) {
    for (const e of sec.entries) {
      if (line > e.line && line <= e.valueRange.end.line) return e;
    }
  }
  return undefined;
}

const BOOL_VALUES: CompletionItem[] = [
  { label: 'true', kind: CompletionItemKind.Value },
  { label: 'false', kind: CompletionItemKind.Value },
];

/**
 * Context-aware INI completion: section headers; config-option keys, section
 * directives and reachable parameter paths at key position; and type-appropriate
 * values (bool, `extends` config names, `default`) at value position.
 */
export function iniCompletion(
  doc: IniDocument,
  registry: ConfigRegistry,
  nedCache: NedResourceCache | undefined,
  pos: Position,
  lineText: string,
): CompletionItem[] {
  const prefix = lineText.slice(0, pos.character);
  const section = sectionAt(doc, pos.line);

  // section header
  if (/^\s*\[[^\]]*$/.test(prefix)) {
    return [
      { label: 'General', kind: CompletionItemKind.Module, insertText: 'General]' },
      { label: 'Config ', kind: CompletionItemKind.Module, insertText: 'Config ' },
    ];
  }

  // is this a value position? either there's an `=` before the cursor, or the
  // cursor sits on a backslash-continuation of a previous entry's value
  const eq = prefix.indexOf('=');
  const contEntry = eq < 0 ? valueContinuationEntry(doc, pos.line) : undefined;
  const valueKey = eq >= 0 ? prefix.slice(0, eq).trim() : contEntry?.key;

  if (valueKey !== undefined) {
    return valueCompletions(doc, registry, nedCache, section, valueKey);
  }

  // key position: section directives + config options + reachable parameter paths
  const items: CompletionItem[] = [{ label: 'extends', kind: CompletionItemKind.Keyword }];
  for (const o of registry.sectionOptions()) {
    items.push({
      label: o.name,
      kind: CompletionItemKind.Property,
      detail: `${o.type}${o.unit ? ' (' + o.unit + ')' : ''}`,
      documentation: o.description,
      insertText: o.name + ' = ',
    });
  }
  if (nedCache && section) {
    const seen = new Set<string>();
    for (const p of reachableParamPaths(doc, nedCache, section)) {
      const leaf = p.path.slice(p.path.indexOf('.') + 1); // drop the network root
      const label = '**.' + leaf;
      if (seen.has(label)) continue;
      seen.add(label);
      items.push({
        label,
        kind: CompletionItemKind.Variable,
        detail: p.type,
        insertText: label + ' = ',
      });
    }
  }
  return items;
}

function valueCompletions(
  doc: IniDocument,
  registry: ConfigRegistry,
  nedCache: NedResourceCache | undefined,
  section: IniSection | undefined,
  key: string,
): CompletionItem[] {
  // extends = <config names>
  if (key === 'extends') {
    return doc.sections
      .filter((s) => s.configName)
      .map((s) => ({ label: s.configName!, kind: CompletionItemKind.Module }));
  }
  const cls = classifyKey(registry, key);
  if (cls.kind === 'config') {
    return cls.option.type === 'bool' ? BOOL_VALUES.slice() : [];
  }
  // parameter assignment: type-appropriate values + iteration variables
  if (cls.kind === 'param-assignment' && nedCache && section) {
    const ptype = matchedParamType(doc, nedCache, section, key);
    const items: CompletionItem[] = [{ label: 'default', kind: CompletionItemKind.Keyword }];
    if (ptype === 'bool') items.push(...BOOL_VALUES);
    items.push(...variableCompletions(doc, section));
    return items;
  }
  return [];
}

/** `${var}` completion items for the variables in scope of a section. */
function variableCompletions(doc: IniDocument, section: IniSection): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const add = (name: string, detail: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    items.push({ label: `\${${name}}`, kind: CompletionItemKind.Variable, detail, insertText: `\${${name}}` });
  };
  for (const sec of sectionChain(doc, section)) {
    for (const [name, v] of namedIterations(sec)) add(name, `iteration variable = ${v.value}`);
  }
  for (const name of PREDEFINED_VARS) add(name, 'predefined variable');
  return items;
}
