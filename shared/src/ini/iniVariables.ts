import { Diagnostic, DiagnosticSeverity, Position, Range } from '../model/location';
import type { IniDocument, IniEntry, IniSection } from './iniDocument';
import { sectionName } from './iniStructureChecks';
import { sectionChain } from './iniParamResolution';

/** Predefined OMNeT++ configuration variables (always valid as ${var} references). */
export const PREDEFINED_VARS = new Set([
  'runid', 'inifile', 'configname', 'runnumber', 'network', 'experiment',
  'measurement', 'replication', 'processid', 'datetime', 'datetimef', 'resultdir',
  'repetition', 'seedset', 'iterationvars', 'iterationvarsf', 'iterationvarsd',
]);

const IDENT = /^[a-zA-Z_][a-zA-Z0-9@_-]*$/;

export interface IterOccurrence {
  /** Raw text between `${` and `}`. */
  content: string;
  /** Offset of the `$` within the entry value. */
  start: number;
  /** Offset just past the closing `}` within the entry value. */
  end: number;
}

/** Brace-aware scan of all `${...}` occurrences in a value (handles nesting). */
export function findOccurrences(value: string): IterOccurrence[] {
  const out: IterOccurrence[] = [];
  for (let i = 0; i < value.length - 1; i++) {
    if (value[i] === '$' && value[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      for (; j < value.length && depth > 0; j++) {
        if (value[j] === '$' && value[j + 1] === '{') { depth++; j++; }
        else if (value[j] === '}') depth--;
      }
      out.push({ content: value.slice(i + 2, j - 1), start: i, end: j });
      i = j - 1;
    }
  }
  return out;
}

export interface IterVar {
  name?: string;
  value: string;
  parvar?: string;
  entry: IniEntry;
}

/** Parse a `${...}` content into a declaration/iteration descriptor. */
function parseContent(content: string): { name?: string; value: string; parvar?: string } {
  // optional "name =", then value, optional trailing "! parvar"
  let rest = content;
  let name: string | undefined;
  const eq = rest.indexOf('=');
  if (eq >= 0) {
    const candidate = rest.slice(0, eq).trim();
    if (IDENT.test(candidate)) {
      name = candidate;
      rest = rest.slice(eq + 1);
    }
  }
  let parvar: string | undefined;
  const bang = rest.lastIndexOf('!');
  if (bang >= 0) {
    const candidate = rest.slice(bang + 1).trim();
    if (IDENT.test(candidate)) {
      parvar = candidate;
      rest = rest.slice(0, bang);
    }
  }
  return { name, value: rest.trim(), parvar };
}

/** Whether a `${...}` content is a bare variable reference (not an iteration). */
function isReference(content: string): boolean {
  return IDENT.test(content.trim());
}

// The section fallback chain (self → bases → [General]) is the C3 linearization
// implemented in iniParamResolution; re-exported here for the variable-scope code.
export { sectionChain };

/** Named iteration variables declared directly in a section. */
export function namedIterations(section: IniSection): Map<string, IterVar> {
  const named = new Map<string, IterVar>();
  for (const e of section.entries) {
    if (!e.value.includes('$')) continue;
    for (const occ of findOccurrences(e.value)) {
      if (isReference(occ.content)) continue;
      const d = parseContent(occ.content);
      if (d.name && !named.has(d.name)) named.set(d.name, { ...d, entry: e });
    }
  }
  return named;
}

/** All variable names valid as ${...} references in a section (predefined + chain). */
export function sectionVariables(doc: IniDocument, section: IniSection): Set<string> {
  const out = new Set(PREDEFINED_VARS);
  for (const sec of sectionChain(doc, section)) {
    for (const name of namedIterations(sec).keys()) out.add(name);
  }
  return out;
}

/** Map an offset within an entry value to a document Position (single-line values only). */
function offsetToPos(entry: IniEntry, offset: number): Position | undefined {
  if (entry.value.includes('\n')) return undefined; // multi-line: fall back to valueRange
  return { line: entry.valueRange.start.line, character: entry.valueRange.start.character + offset };
}

function rangeFor(entry: IniEntry, start: number, end: number): Range {
  const s = offsetToPos(entry, start);
  const e = offsetToPos(entry, end);
  return s && e ? { start: s, end: e } : entry.valueRange;
}

/**
 * Iteration-variable diagnostics, mirroring InifileAnalyzer: undefined ${var}
 * references, redefinition within a section, redeclaration across the section
 * chain, attempts to redefine a predefined variable, and unknown parallel (!var).
 */
export function iniVariableDiagnostics(doc: IniDocument): Diagnostic[] {
  const out: Diagnostic[] = [];

  // declarations per section (also flags predefined-clash and in-section redefinition)
  const declsBySection = new Map<string, Map<string, IterVar>>();
  for (const section of doc.sections) {
    const named = new Map<string, IterVar>();
    for (const e of section.entries) {
      if (!e.value.includes('$')) continue;
      for (const occ of findOccurrences(e.value)) {
        if (isReference(occ.content)) continue;
        const d = parseContent(occ.content);
        if (!d.name) continue;
        if (PREDEFINED_VARS.has(d.name)) {
          out.push(diag(rangeFor(e, occ.start, occ.end),
            `\${${d.name}} is a predefined variable and cannot be changed`, 'predefined-variable'));
        } else if (named.has(d.name)) {
          out.push(diag(rangeFor(e, occ.start, occ.end),
            `Redefinition of iteration variable \${${d.name}}`, 'redefined-variable'));
        } else {
          named.set(d.name, { ...d, entry: e });
        }
      }
    }
    declsBySection.set(section.rawName, named);
  }

  // cross-section redeclaration (a named var also defined in an ancestor section)
  for (const section of doc.sections) {
    const own = declsBySection.get(section.rawName)!;
    if (!own.size) continue;
    for (const ancestor of sectionChain(doc, section)) {
      if (ancestor.rawName === section.rawName) continue;
      const ancDecls = declsBySection.get(ancestor.rawName);
      if (!ancDecls) continue;
      for (const [name, v] of own) {
        if (ancDecls.has(name)) {
          out.push(diag(v.entry.keyRange,
            `Redeclaration of iteration variable $${name}, originally defined in section [${sectionName(ancestor)}]`,
            'redeclared-variable'));
        }
      }
    }
  }

  // reference validity: ${var} references and inner $var / parallel !var
  for (const section of doc.sections) {
    const valid = sectionVariables(doc, section);
    for (const e of section.entries) {
      if (!e.value.includes('$')) continue;
      for (const occ of findOccurrences(e.value)) {
        if (isReference(occ.content)) {
          const name = occ.content.trim();
          if (!valid.has(name)) {
            out.push(diag(rangeFor(e, occ.start, occ.end), `\${${name}} is undefined`, 'undefined-variable'));
          }
          continue;
        }
        const d = parseContent(occ.content);
        // inner $var references within the iteration value
        const re = /\$([a-zA-Z_][a-zA-Z0-9@_-]*)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(d.value))) {
          if (!valid.has(m[1])) {
            out.push(diag(rangeFor(e, occ.start, occ.end), `\${${m[1]}} is undefined`, 'undefined-variable'));
          }
        }
        // parallel "! parvar" must reference a known variable
        if (d.parvar && !valid.has(d.parvar)) {
          out.push(diag(rangeFor(e, occ.start, occ.end), `Unknown iteration variable ${d.parvar}`, 'unknown-parvar'));
        }
      }
    }
  }

  return out;
}

function diag(range: Range, message: string, code: string): Diagnostic {
  return { range, severity: DiagnosticSeverity.Error, message, source: 'omnetpp', code };
}
