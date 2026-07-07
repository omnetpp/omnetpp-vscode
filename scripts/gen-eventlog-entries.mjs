// Generates shared/src/eventlog/entries.ts by parsing the eventlog entry class
// specification (a small line-oriented DSL — one text file describes every
// eventlog line format: entry code, class name, inheritance, and typed fields).
// Usage:
//   bun scripts/gen-eventlog-entries.mjs [<omnetppSrcDir>]
// With an argument, first refreshes the committed snapshot at
// resources/eventlog/eventlogentries.txt from
// <omnetppSrcDir>/src/eventlog/eventlogentries.txt, then regenerates from it.
// Without an argument, regenerates straight from the committed snapshot (so
// `bun run compile`/CI never need an OMNeT++ checkout).
//
// Porting sources (read to determine the exact parsing/generation rules):
//   - omnetpp-dev/src/eventlog/eventlogentries.txt — the spec itself.
//   - omnetpp-dev/src/eventlog/eventlogentries.pl — the upstream Perl generator that
//     turns the spec into eventlogentries.{h,cc}, EventLogEntryFactory.cc, and (in
//     its `$target`-gated second half) the Java sources under
//     ui/org.omnetpp.common/src/org/omnetpp/eventlog/entry/*.java, which this port
//     actually mirrors field-for-field (BigDecimal-based simtime, getXToken-style
//     parsing, etc. — much closer to this TS port than the C++ side).
//   - Precedent for this script's shape: scripts/gen-config-options.mjs.
//
// Design notes / deliberate deviations from the Perl generator (see also the
// per-topic comments below and shared/src/eventlog/eventLogEntry.ts's file header):
//
//  1. No generated constructors. The Perl generator emits two Java constructors
//     per class (no-arg, and (IChunk,int)) purely to assign field defaults, because
//     old-style Java field declarations couldn't easily carry initializers derived
//     from the spec's default column in a single place. TypeScript class field
//     initializers make that unnecessary: every generated class below has zero
//     constructors and simply declares `field: Type = defaultExpr;` — the
//     EventLogEntry base class's own field initializers (chunk=null, entryIndex=-1,
//     offset=-1) apply automatically to every subclass instance. `createEntry()`
//     builds a bare instance; shared/src/eventlog/eventLogEntry.ts's
//     `parseEventLogEntry()` sets chunk/entryIndex/offset on it afterwards.
//
//  2. print()/getAsString() split like the Java: print() renders the eventlog wire
//     format (integers as plain digits, booleans as "1"/"0", strings quoted via
//     EventLogTokenBasedEntry.quote); getAsString(attribute) renders a
//     human-readable form (booleans as "true"/"false", strings unquoted) — this
//     mirrors a real, verified divergence in the Java sources (e.g.
//     BeginSendEntry.print() writes `up 1`/`up 0` but
//     BeginSendEntry.getAsString("up")` returns `"true"`/`"false"`).
//
//  3. print() returns a plain string with NO leading-newline/trailing-newline
//     bookkeeping and no code prefix for abstract (code-less) base classes — see
//     shared/src/eventlog/eventLogEntry.ts's file header for the full rationale.
//
//  4. getAsString(attribute?: string) is typed `string | null` (the task's porting
//     note describes it as returning `string`, but both the "attribute not found"
//     fallback and optional string-valued fields with a NULL default are genuinely
//     nullable in the Java source, so declaring the honest type here avoids lying
//     to callers in later phases (MatchExpression et al.)).
//
//  5. getClassIndex() is not ported (upstream generator bug — see
//     eventLogEntry.ts's file header for the full explanation).
//
//  6. Only 5 token-getter helpers are generated against (getBoolToken/getIntToken/
//     getInt64Token/getStringToken/getSimtimeToken, all defined on
//     EventLogTokenBasedEntry) rather than one per spec type keyword: `short` reuses
//     getIntToken and `long`/`eventnumber_t`/`msgid_t`/`txid_t` reuse getInt64Token,
//     since TypeScript has one integer runtime type unlike Java's distinct
//     int/short/long/... primitives (Java only distinguished them for
//     autoboxing/width, not behavior).
//
// A note on quote()/qoute(): the porting notes for this phase point at the Java
// `EventLogTokenBasedEntry.qoute(String)`, whose embedded-quote "escaping" step
// (`text.replaceAll("\"", "\\\"")`) is, first, an observable no-op -- verified
// against a real JVM (Temurin 25): a Java replacement-string backslash escapes the
// *next character*, so the two-char replacement `\"` degrades to inserting a
// literal `"`, i.e. `"` is replaced with `"` (transcript:
// `qoute("a\"b")` -> `a"b`, unescaped; `qoute("he said \"hi\" now")` ->
// `"he said "hi" now"`, wrapped but with the inner quotes verbatim). Second, and
// more importantly, it never quotes an *empty* string, which is provably
// insufficient: real .elog files (written by the C++ engine, not the Java UI)
// contain lines like `MDC id 1 d ""` (OMNeT++ 6.0), an explicitly double-quoted
// empty display string -- ported through the Java `qoute()` rule, an empty value
// would print as nothing at all, which `LineTokenizer` cannot parse back as "the
// empty string" (confirmed to break round-trip parsing of
// shared/src/test/fixtures/elog/sample/Fifo1-#0.elog). So `quote()` instead ports
// the C++ `QUOTE`/`opp_needsquotes`/`opp_quotestr` trio
// (omnetpp-dev/src/common/stringutil.{h,cc}) -- the actual wire format real .elog
// files are written in, which also quotes empty strings, and escapes backslashes/
// embedded quotes/control characters (all already understood by LineTokenizer's
// `interpretBackslashes()`, ported independently from the same C++ source in phase
// E1). See shared/src/eventlog/eventLogEntry.ts's EventLogTokenBasedEntry.quote()
// for the full port and rationale.

import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const snapshotPath = join(root, 'resources', 'eventlog', 'eventlogentries.txt');
const outPath = join(root, 'shared', 'src', 'eventlog', 'entries.ts');

if (process.argv[2]) {
  const srcDir = resolve(process.argv[2]);
  const upstreamPath = join(srcDir, 'src', 'eventlog', 'eventlogentries.txt');
  mkdirSync(dirname(snapshotPath), { recursive: true });
  copyFileSync(upstreamPath, snapshotPath);
  console.log(`Refreshed snapshot from ${upstreamPath}`);
}

// ---------------------------------------------------------------------------------
// 1. Parse the spec (line-oriented state machine, mirroring eventlogentries.pl's
//    single `while (<FILE>)` loop with its ordered elsif chain: blank line, //
//    comment, class header, opening brace, field, closing brace, else die).
// ---------------------------------------------------------------------------------

const RE_BLANK = /^ *$/;
const RE_COMMENT = /^ *\/\//;
const RE_CLASS_HEADER = /^([A-Za-z_][\w]*) +([A-Za-z_][\w]*)(?: +: +([A-Za-z_][\w]*))? *(\/\/.*)?$/;
const RE_OPEN_BRACE = /^ *\{ *$/;
const RE_FIELD = /^ +([\w#]+) +([A-Za-z_][\w]*) +([A-Za-z_][\w]*)(?: +([^ ]+))? *(\/\/.*)?$/;
const RE_CLOSE_BRACE = /^ *\} *$/;

function stripComment(m) {
  return m ? m.replace(/^\/\/\s?/, '') : '';
}

function parseSpec(text) {
  const lines = text.split(/\r?\n/);
  const classes = [];
  let current = null;
  let fields = [];
  const seenCodes = new Set();

  for (const line of lines) {
    let m;
    if (RE_BLANK.test(line)) continue;
    if (RE_COMMENT.test(line)) continue;
    if ((m = line.match(RE_CLASS_HEADER))) {
      const code = m[1];
      const name = m[2];
      const superName = m[3] || 'EventLogTokenBasedEntry';
      if (code !== 'abstract') {
        if (seenCodes.has(code)) throw new Error(`gen-eventlog-entries: class code '${code}' used twice`);
        seenCodes.add(code);
      }
      current = { code, name, super: superName, comment: stripComment(m[4]), fields: [] };
      fields = [];
      continue;
    }
    if (RE_OPEN_BRACE.test(line)) continue;
    if ((m = line.match(RE_FIELD))) {
      fields.push({
        code: m[1],
        type: m[2],
        name: m[3],
        default: m[4] ?? null,
        comment: stripComment(m[5]),
      });
      continue;
    }
    if (RE_CLOSE_BRACE.test(line)) {
      if (!current) throw new Error('gen-eventlog-entries: stray closing brace');
      current.fields = fields;
      classes.push(current);
      current = null;
      fields = [];
      continue;
    }
    throw new Error(`gen-eventlog-entries: unrecognized spec line: ${JSON.stringify(line)}`);
  }
  if (current) throw new Error(`gen-eventlog-entries: class '${current.name}' missing closing brace`);
  return classes;
}

// ---------------------------------------------------------------------------------
// 2. Type mapping (spec type keyword -> TS runtime type, token-getter helper, and
//    the *generic* (no explicit spec default) pre-parse field value).
// ---------------------------------------------------------------------------------

const TYPE_INFO = {
  int: { tokenGetter: 'getIntToken', genericDefault: '-1' },
  short: { tokenGetter: 'getIntToken', genericDefault: '-1' },
  long: { tokenGetter: 'getInt64Token', genericDefault: '-1' },
  int64_t: { tokenGetter: 'getInt64Token', genericDefault: '-1' },
  eventnumber_t: { tokenGetter: 'getInt64Token', genericDefault: '-1' },
  msgid_t: { tokenGetter: 'getInt64Token', genericDefault: '-1' },
  txid_t: { tokenGetter: 'getInt64Token', genericDefault: '-1' },
  bool: { tokenGetter: 'getBoolToken', genericDefault: 'false' },
  string: { tokenGetter: 'getStringToken', genericDefault: 'null' },
  simtime_t: { tokenGetter: 'getSimtimeToken', genericDefault: 'BigDecimal.NIL' },
};

const NUMERIC_TYPES = new Set(['int', 'short', 'long', 'int64_t', 'eventnumber_t', 'msgid_t', 'txid_t']);

/** Simtime_t literal defaults observed in the current spec are only "0" and "-1"; use the named constants for readability. */
function simtimeLiteral(token) {
  if (token === '0') return 'BigDecimal.ZERO';
  if (token === '-1') return 'BigDecimal.MINUS_ONE';
  return `BigDecimal.parse('${token}')`;
}

/** Computes the derived, generator-facing shape of one spec field. */
function resolveField(f, className) {
  const info = TYPE_INFO[f.type];
  if (!info) throw new Error(`gen-eventlog-entries: unknown field type '${f.type}' (field ${f.name} of ${className})`);
  const mandatory = f.default === null;

  let tsType;
  let defaultExpr;
  if (f.type === 'string') {
    if (mandatory) {
      tsType = 'string';
      defaultExpr = "''"; // sensible non-null placeholder; parse() always overwrites mandatory fields
    } else {
      if (f.default !== 'NULL')
        throw new Error(`gen-eventlog-entries: only NULL is supported as a string default (field ${f.name} of ${className}, got '${f.default}')`);
      tsType = 'string | null';
      defaultExpr = 'null';
    }
  } else if (f.type === 'bool') {
    tsType = 'boolean';
    defaultExpr = mandatory ? info.genericDefault : f.default;
  } else if (f.type === 'simtime_t') {
    tsType = 'BigDecimal';
    defaultExpr = mandatory ? info.genericDefault : simtimeLiteral(f.default);
  } else if (NUMERIC_TYPES.has(f.type)) {
    tsType = 'number';
    defaultExpr = mandatory ? info.genericDefault : f.default;
  } else {
    throw new Error(`gen-eventlog-entries: unhandled field type '${f.type}'`);
  }

  return { ...f, mandatory, tsType, defaultExpr, tokenGetter: info.tokenGetter };
}

// ---------------------------------------------------------------------------------
// 3. Per-class code emission.
// ---------------------------------------------------------------------------------

function printValueExpr(f) {
  if (f.type === 'string') return `EventLogTokenBasedEntry.quote(this.${f.name})`;
  if (f.type === 'bool') return `(this.${f.name} ? '1' : '0')`;
  if (f.type === 'simtime_t') return `this.${f.name}.toString()`;
  return `String(this.${f.name})`;
}

function asStringValueExpr(f) {
  if (f.type === 'string') return `this.${f.name}`;
  if (f.type === 'simtime_t') return `this.${f.name}.toString()`;
  return `String(this.${f.name})`; // bool -> "true"/"false" (String(boolean)), matching Java's String.valueOf(boolean)
}

function printOmissionCheck(f) {
  if (f.type === 'string') return `this.${f.name} !== null`;
  if (f.type === 'bool') return `this.${f.name} !== ${f.defaultExpr}`;
  if (f.type === 'simtime_t') return `!this.${f.name}.equals(${f.defaultExpr})`;
  return `this.${f.name} !== ${f.defaultExpr}`;
}

function generateClass(cls) {
  const fields = cls.fields.map((f) => resolveField(f, cls.name));
  const hasSuperclass = cls.super !== 'EventLogTokenBasedEntry';
  const codeLiteral = cls.code === 'abstract' ? 'abstract' : cls.code;

  const lines = [];
  if (cls.comment) lines.push(`/** ${cls.comment} */`);
  lines.push(`export class ${cls.name} extends ${cls.super} {`);

  for (const f of fields) {
    const comment = f.comment ? ` // ${f.comment}` : '';
    lines.push(`  ${f.name}: ${f.tsType} = ${f.defaultExpr};${comment}`);
  }
  lines.push('');

  // parse()
  lines.push('  parse(tokens: string[]): void {');
  if (hasSuperclass) lines.push('    super.parse(tokens);');
  for (const f of fields) {
    lines.push(`    this.${f.name} = this.${f.tokenGetter}(tokens, '${f.code}', ${f.mandatory}, this.${f.name});`);
  }
  lines.push('  }');
  lines.push('');

  // print()
  lines.push('  print(): string {');
  lines.push("    let out = '';");
  if (cls.code !== 'abstract') lines.push(`    out += '${codeLiteral}';`);
  if (hasSuperclass) lines.push('    out += super.print();');
  for (const f of fields) {
    if (f.mandatory) {
      lines.push(`    out += ' ${f.code} ' + ${printValueExpr(f)};`);
    } else if (f.type === 'string') {
      // Local capture so TS narrows `string | null` -> `string` inside the branch.
      lines.push(`    { const v = this.${f.name}; if (v !== null) out += ' ${f.code} ' + EventLogTokenBasedEntry.quote(v); }`);
    } else {
      lines.push(`    if (${printOmissionCheck(f)}) out += ' ${f.code} ' + ${printValueExpr(f)};`);
    }
  }
  lines.push('    return out;');
  lines.push('  }');
  lines.push('');

  // getAttributeNames()
  lines.push('  getAttributeNames(): string[] {');
  lines.push(`    const names: string[] = ${hasSuperclass ? 'super.getAttributeNames()' : '[]'};`);
  for (const f of fields) lines.push(`    names.push('${f.code}');`);
  lines.push('    return names;');
  lines.push('  }');
  lines.push('');

  // getAsString()
  lines.push('  getAsString(attribute?: string): string | null {');
  lines.push(`    if (attribute === undefined) return '${codeLiteral}';`);
  for (const f of fields) {
    lines.push(`    if (attribute === '${f.code}') return ${asStringValueExpr(f)};`);
  }
  lines.push(`    return ${hasSuperclass ? 'super.getAsString(attribute)' : 'null'};`);
  lines.push('  }');
  lines.push('');

  lines.push(`  getClassName(): string { return '${cls.name}'; }`);
  lines.push('');
  // Explicitly typed `: string` (rather than left to infer as the narrow string
  // literal) — TS requires a derived class's static-side property types to be
  // assignable to the base class's, which fails class-to-class across the
  // hierarchy if every class's `code`/`className` were each inferred as its own
  // distinct literal type.
  lines.push(`  static readonly code: string = '${codeLiteral}';`);
  lines.push(`  static readonly className: string = '${cls.name}';`);
  lines.push('}');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------
// 4. Whole-file assembly: topologically order classes (superclass before subclass —
//    the spec already appears to declare classes in this order throughout, but we
//    don't rely on that) so no class is referenced by `extends` before it exists.
// ---------------------------------------------------------------------------------

function topoSort(classes) {
  const byName = new Map(classes.map((c) => [c.name, c]));
  const visited = new Set();
  const out = [];
  function visit(c) {
    if (visited.has(c.name)) return;
    visited.add(c.name);
    const superClass = byName.get(c.super);
    if (superClass) visit(superClass);
    out.push(c);
  }
  for (const c of classes) visit(c);
  return out;
}

function generate(classes) {
  const ordered = topoSort(classes);
  const concrete = classes.filter((c) => c.code !== 'abstract');

  const header = `// GENERATED FILE - DO NOT EDIT.
// Generated by scripts/gen-eventlog-entries.mjs from resources/eventlog/eventlogentries.txt.
// Regenerate with: bun scripts/gen-eventlog-entries.mjs [<omnetppSrcDir>]
//
// Porting source: omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/entry/*.java
// (one class per eventlog entry code; field types/defaults/token-getter dispatch
// mirror eventlogentries.pl's Java-emission pass). See the generator script's header
// comment for the full list of deliberate deviations (no generated constructors,
// print()/getAsString() formatting split, the quote() no-op-escape parity, etc.)
// and shared/src/eventlog/eventLogEntry.ts for the hand-written base classes.

import { BigDecimal } from './bigDecimal';
import { EventLogTokenBasedEntry } from './eventLogEntry';
`;

  const classBodies = ordered.map(generateClass).join('\n\n');

  const factoryCases = concrete.map((c) => `    case '${c.code}': return new ${c.name}();`).join('\n');
  const factory = `
/** Creates a fresh (unparsed) entry instance for the given entry code, or null if the code is not recognized. */
export function createEntry(code: string): EventLogTokenBasedEntry | null {
  switch (code) {
${factoryCases}
    default: return null;
  }
}
`;

  const mapEntries = concrete.map((c) => `  ${c.code}: '${c.name}',`).join('\n');
  const map = `
export const entryCodeToClassName: Record<string, string> = {
${mapEntries}
};
`;

  return header + '\n' + classBodies + '\n' + factory + map;
}

// ---------------------------------------------------------------------------------

const text = readFileSync(snapshotPath, 'utf8');
const classes = parseSpec(text);
const concreteCount = classes.filter((c) => c.code !== 'abstract').length;
const abstractCount = classes.length - concreteCount;

const out = generate(classes);
writeFileSync(outPath, out);
console.log(`Wrote ${concreteCount} entry classes (+ ${abstractCount} abstract bases) to ${outPath}`);
