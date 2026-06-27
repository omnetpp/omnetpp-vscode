import { CompletionItem, CompletionItemKind, InsertTextFormat } from '../model/completion';

/**
 * Standard OMNeT++ NED properties (`@name`), the NED element each attaches to,
 * and how each is inserted. The set and scopes are taken from the NED manual
 * (`doc/src/manual/ch-ned-lang.tex`) and the simulation kernel
 * (`src/sim/cmodule.cc` gates, `src/sim/netbuilder/cnednetworkbuilder.cc`
 * submodules/connections). Used for scope-aware property content assist.
 */
export type NedPropScope = 'file' | 'type' | 'param' | 'gate' | 'submodule' | 'connection';

/** flag = `@x` (no parens); args = `@x(...)`; index = `@x[name](...)`. */
type PropInsert = 'flag' | 'args' | 'index';

interface NedProperty {
  name: string;
  scopes: NedPropScope[];
  doc: string;
  insert: PropInsert;
  /** Snippet body (without the leading `@`); defaults derived from `insert`. */
  snippet?: string;
}

export const NED_PROPERTIES: NedProperty[] = [
  // file / package level
  { name: 'namespace', scopes: ['file'], insert: 'args', snippet: 'namespace(${1:name})', doc: 'C++ namespace for the types in this package/file' },
  { name: 'license', scopes: ['file'], insert: 'args', snippet: 'license(${1:LGPL})', doc: 'License of the files in this package' },

  // type level
  { name: 'display', scopes: ['type', 'submodule', 'connection'], insert: 'args', snippet: 'display("${1:}")', doc: 'Display string (icon, position, shape, colors, ...)' },
  { name: 'class', scopes: ['type', 'param'], insert: 'args', snippet: 'class(${1:cppClass})', doc: 'C++ implementation class' },
  { name: 'isNetwork', scopes: ['type'], insert: 'flag', doc: 'Marks this module type as a runnable network' },
  { name: 'signal', scopes: ['type'], insert: 'index', snippet: 'signal[${1:name}](${2:type=long})', doc: 'Declares a signal emitted by this module' },
  { name: 'statistic', scopes: ['type'], insert: 'index', snippet: 'statistic[${1:name}](source=${2:signal};record=${3:vector,stats})', doc: 'Declares a recorded statistic' },
  { name: 'defaultStatistic', scopes: ['type'], insert: 'args', snippet: 'defaultStatistic(${1:name})', doc: 'Default statistic for the module' },
  { name: 'figure', scopes: ['type'], insert: 'index', snippet: 'figure[${1:name}](type=${2:rectangle})', doc: 'Declares a canvas figure' },
  { name: 'labels', scopes: ['type', 'gate'], insert: 'args', snippet: 'labels(${1:label})', doc: 'Labels for filtering/grouping in the IDE palette' },
  { name: 'group', scopes: ['type', 'param'], insert: 'args', snippet: 'group(${1:name})', doc: 'Groups related items together' },

  // parameter level
  { name: 'unit', scopes: ['param'], insert: 'args', snippet: 'unit(${1:s})', doc: 'Measurement unit of a numeric parameter' },
  { name: 'enum', scopes: ['param'], insert: 'args', snippet: 'enum(${1:values})', doc: 'Restricts a string parameter to an enumeration' },
  { name: 'mutable', scopes: ['param'], insert: 'flag', doc: 'Parameter may be changed at runtime' },
  { name: 'prompt', scopes: ['param'], insert: 'args', snippet: 'prompt("${1:text}")', doc: 'Interactive prompt text for the parameter' },

  // gate level
  { name: 'loose', scopes: ['gate'], insert: 'flag', doc: 'Gate may be left unconnected' },
  { name: 'directIn', scopes: ['gate'], insert: 'flag', doc: 'Gate may receive messages sent directly (no connection needed)' },

  // submodule level
  { name: 'dynamic', scopes: ['submodule'], insert: 'flag', doc: 'Submodule is created dynamically at runtime' },

  // connection level
  { name: 'reconnect', scopes: ['connection'], insert: 'flag', doc: 'Connection may be reconnected at runtime' },
];

function snippetBody(p: NedProperty): string {
  if (p.snippet) return p.snippet;
  switch (p.insert) {
    case 'flag': return p.name;
    case 'index': return `${p.name}[\${1:name}]($2)`;
    case 'args': return `${p.name}($1)`;
  }
}

/**
 * Property completions for the union of the given scopes (deduplicated by name).
 * Items insert a snippet including the leading `@`.
 */
export function propertyCompletions(...scopes: NedPropScope[]): CompletionItem[] {
  const seen = new Set<string>();
  const items: CompletionItem[] = [];
  for (const p of NED_PROPERTIES) {
    if (seen.has(p.name) || !p.scopes.some((s) => scopes.includes(s))) continue;
    seen.add(p.name);
    items.push({
      label: '@' + p.name,
      kind: CompletionItemKind.Property,
      detail: p.doc,
      insertText: '@' + snippetBody(p),
      insertTextFormat: InsertTextFormat.Snippet,
    });
  }
  return items;
}
