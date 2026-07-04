// A lightweight, dependency-free C++ scanner for OMNeT++ cross-referencing.
//
// It does NOT parse C++ — it tokenizes (stripping comments, strings, char
// literals and preprocessor lines) and then recognizes exactly the handful of
// OMNeT++ patterns we cross-reference:
//
//   - `Define_Module(Class)` / `Define_Channel(Class)` / `Define_Network(Class)`
//     — the registration that ties a C++ class to a NED type. The class token is
//     qualified with the enclosing `namespace {}` stack.
//   - literal `par("name")`, `gate("name")`, `getSubmodule("name")` (and the
//     `hasPar`/`hasGate`/`gateSize` variants) — member accesses, attributed to
//     the enclosing class (a `class X {}` body or an out-of-line `X::method()`
//     definition).
//
// By design it only sees STRING-LITERAL arguments. `par(parName.c_str())`,
// concatenations, and cached references are invisible — a deliberate limitation
// that keeps any "unused member" diagnostic built on top a soft hint, never an
// error. The result holds only values (names + `Location`s), so it survives in
// the cross-reference graph with no live parse-tree references. A tree-sitter-cpp
// backend could replace this module without changing `CppScanResult`.

import type { Location, Position } from '../model/location';

export type CppMemberKind = 'param' | 'gate' | 'submodule';

/** A `Define_Module`/`Define_Channel`/`Define_Network` class registration. */
export interface CppClassDecl {
  /** Namespace-qualified class name, e.g. `inet::UdpBasicApp` (or `Foo`). */
  qualifiedName: string;
  simpleName: string;
  kind: 'module' | 'channel';
  /** Location of the class-name token inside the macro call. */
  decl: Location;
}

/** A literal `par()`/`gate()`/`getSubmodule()` access attributed to a class. */
export interface CppMemberAccess {
  /** Qualified name of the enclosing class, or '' when it could not be determined. */
  ownerClass: string;
  kind: CppMemberKind;
  name: string;
  /** Location of the string-literal argument. */
  src: Location;
}

export interface CppScanResult {
  classes: CppClassDecl[];
  accesses: CppMemberAccess[];
}

const CPP_EXTS = ['.cc', '.cpp', '.cxx', '.h', '.hpp', '.hxx', '.hh'];

/**
 * Whether a file name is a C++ source we should scan: a C/C++ extension that is
 * NOT an opp_msgc-generated `*_m.cc`/`*_m.h` (those mirror `.msg` files, already
 * covered by the MSG cache, and would double-count).
 */
export function isCppSourceFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (!CPP_EXTS.some((e) => lower.endsWith(e))) return false;
  if (/_m\.(cc|cpp|cxx|h|hpp|hxx|hh)$/.test(lower)) return false;
  return true;
}

const REGISTRATION: Record<string, 'module' | 'channel'> = {
  Define_Module: 'module',
  Define_Network: 'module',
  Define_Channel: 'channel',
};

const ACCESS_FUNCS: Record<string, CppMemberKind> = {
  par: 'param',
  hasPar: 'param',
  gate: 'gate',
  hasGate: 'gate',
  gateSize: 'gate',
  getSubmodule: 'submodule',
};

interface Tok {
  type: 'id' | 'str' | 'punct';
  value: string;
  start: number;
  end: number;
}

function isIdStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}
function isIdPart(c: string): boolean {
  return isIdStart(c) || (c >= '0' && c <= '9');
}

/** Tokenize, discarding comments, char literals and preprocessor directives. */
function tokenize(text: string): Tok[] {
  const toks: Tok[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '#') {
      // preprocessor line, honoring backslash-newline continuations
      i++;
      while (i < n) {
        if (text[i] === '\\') {
          if (text[i + 1] === '\n') i += 2;
          else if (text[i + 1] === '\r' && text[i + 2] === '\n') i += 3;
          else i++;
          continue;
        }
        if (text[i] === '\n') break;
        i++;
      }
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      let val = '';
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\') {
          val += text[i + 1] ?? '';
          i += 2;
        } else {
          val += text[i];
          i++;
        }
      }
      i++; // closing quote
      toks.push({ type: 'str', value: val, start, end: i });
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n && text[i] !== "'") {
        if (text[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (isIdStart(c)) {
      const start = i;
      i++;
      while (i < n && isIdPart(text[i])) i++;
      toks.push({ type: 'id', value: text.slice(start, i), start, end: i });
      continue;
    }
    if (c === ':' && text[i + 1] === ':') {
      toks.push({ type: 'punct', value: '::', start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (c >= '0' && c <= '9') {
      // a numeric literal — consumed but not emitted (never semantically needed)
      i++;
      while (i < n && /[0-9a-fA-Fx._]/.test(text[i])) i++;
      continue;
    }
    toks.push({ type: 'punct', value: c, start: i, end: i + 1 });
    i++;
  }
  return toks;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function posAt(starts: number[], offset: number): Position {
  // binary search for the line whose start is <= offset
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: offset - starts[lo] };
}

/** Strip a leading `::` and decide whether a name is already namespace-qualified. */
function qualify(name: string, nsStack: string[]): string {
  const stripped = name.replace(/^::/, '');
  if (stripped.includes('::') || nsStack.length === 0) return stripped;
  return `${nsStack.join('::')}::${stripped}`;
}

/** Read a (possibly `::`-qualified) name starting at token `k`; returns text + next index. */
function readQualifiedName(toks: Tok[], k: number): { name: string; next: number } | null {
  let name = '';
  let j = k;
  if (toks[j]?.value === '::') {
    name = '::';
    j++;
  }
  if (toks[j]?.type !== 'id') return null;
  name += toks[j].value;
  j++;
  while (toks[j]?.value === '::' && toks[j + 1]?.type === 'id') {
    name += '::' + toks[j + 1].value;
    j += 2;
  }
  return { name, next: j };
}

interface Frame {
  namespace?: string;
  class?: string;
}

/**
 * Determine what a `{` at `braceIdx` opens: a namespace, a class/struct body, or
 * a function definition (which carries the owning class). Returns the frame to
 * push; an "other" block returns `{}` and inherits the enclosing class.
 */
function classifyBrace(toks: Tok[], braceIdx: number, nsStack: string[]): Frame {
  // Gather the statement header: tokens back to the previous `;`/`{`/`}` at paren
  // depth 0 (so `for(;;)` semicolons and call parens are skipped).
  let start = braceIdx - 1;
  let depth = 0;
  while (start >= 0) {
    const v = toks[start].value;
    if (v === ')') depth++;
    else if (v === '(') depth--;
    else if (depth === 0 && (v === ';' || v === '{' || v === '}')) break;
    start--;
  }
  const header = toks.slice(start + 1, braceIdx);
  if (header.length === 0) return {};

  // namespace X {  |  namespace {
  if (header[0].type === 'id' && header[0].value === 'namespace') {
    const nm = header[1]?.type === 'id' ? header[1].value : undefined;
    return { namespace: nm };
  }

  // Function definition: the first `name (` whose name is preceded by `::`.
  for (let h = 0; h < header.length; h++) {
    if (header[h].value === '(' && h >= 2 && header[h - 2].value === '::') {
      // walk back the qualified class chain before the last `::`
      let c = h - 2; // at the '::' before the method name
      let cls = '';
      let p = c - 1;
      // collect segments: id (:: id)* ending at p
      const segs: string[] = [];
      while (p >= 0 && header[p].type === 'id') {
        segs.unshift(header[p].value);
        if (header[p - 1]?.value === '::') p -= 2;
        else break;
      }
      if (segs.length) {
        const leadingGlobal = header[p]?.value === '::' || header[p - 1]?.value === '::';
        cls = (leadingGlobal ? '::' : '') + segs.join('::');
        return { class: qualify(cls, nsStack) };
      }
    }
  }

  // class/struct definition: `class X`, `struct X`, `template<...> class X final : ...`
  for (let h = 0; h < header.length; h++) {
    const v = header[h].value;
    if ((v === 'class' || v === 'struct') && header[h + 1]?.type === 'id') {
      // skip `class alignas(...) X` etc. by taking the id right before ':' / end
      const nm = header[h + 1].value;
      return { class: qualify(nm, nsStack) };
    }
  }

  return {};
}

/** Scan C++ source for OMNeT++ class registrations and member accesses. */
export function scanCpp(uri: string, text: string): CppScanResult {
  const toks = tokenize(text);
  const starts = lineStarts(text);
  const loc = (t: Tok): Location => ({
    uri,
    range: { start: posAt(starts, t.start), end: posAt(starts, t.end) },
  });

  const classes: CppClassDecl[] = [];
  const accesses: CppMemberAccess[] = [];
  const frames: Frame[] = [];
  const nsStack = (): string[] =>
    frames.filter((f) => f.namespace).map((f) => f.namespace!) as string[];
  const currentClass = (): string => {
    for (let k = frames.length - 1; k >= 0; k--) if (frames[k].class) return frames[k].class!;
    return '';
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === 'punct') {
      if (t.value === '{') frames.push(classifyBrace(toks, i, nsStack()));
      else if (t.value === '}') frames.pop();
      continue;
    }
    if (t.type !== 'id') continue;

    const reg = REGISTRATION[t.value];
    if (reg && toks[i + 1]?.value === '(') {
      const nameTok = toks[i + 2];
      const read = readQualifiedName(toks, i + 2);
      if (read && nameTok) {
        const qn = qualify(read.name, nsStack());
        const simple = qn.includes('::') ? qn.slice(qn.lastIndexOf('::') + 2) : qn;
        classes.push({ qualifiedName: qn, simpleName: simple, kind: reg, decl: loc(nameTok) });
      }
      continue;
    }

    const kind = ACCESS_FUNCS[t.value];
    if (kind && toks[i + 1]?.value === '(' && toks[i + 2]?.type === 'str') {
      const strTok = toks[i + 2];
      if (strTok.value) {
        accesses.push({ ownerClass: currentClass(), kind, name: strTok.value, src: loc(strTok) });
      }
    }
  }

  return { classes, accesses };
}
