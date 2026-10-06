// Find the files that belong together with a .cc, .h or .ned file: the NED
// type, the C++ class that implements it (its `Define_*` registration) and the
// header that defines the class. The pairing is semantic — `@class`,
// `@namespace` and the extends-chain rule of `nedImplClass` — so a NED type
// whose class lives in differently named files is still found. A ring member
// the index cannot fill falls back to the same-basename sibling file.

import type { Location, Position, Range } from '../model/location';
import { nodeRange } from '../parser/treeUtils';
import type { SemanticDatabase } from './semanticDatabase';
import {
  COUNTERPART_EXTENSIONS,
  COUNTERPART_RING,
  counterpartKind,
  type CounterpartResult,
} from './counterpartRing';

export async function findCounterparts(
  db: SemanticDatabase,
  uri: string,
  position: Position | undefined,
  exists: (uri: string) => Promise<boolean>,
): Promise<CounterpartResult> {
  const kind = counterpartKind(uri);
  const out: CounterpartResult = { kind, cc: [], h: [], ned: [] };
  if (!kind) return out;

  const add = (loc: Location, label: string): void => {
    const k = counterpartKind(loc.uri);
    if (!k || loc.uri === uri || out[k].some((t) => t.uri === loc.uri)) return;
    out[k].push({ uri: loc.uri, range: loc.range, label });
  };

  const classes = kind === 'ned' ? nedFileClasses(db, uri, position) : cppFileClasses(db, uri);
  for (const qn of classes) {
    const reg = db.cppCache.classByQualifiedName(qn);
    if (reg) add(reg.decl, qn);
    for (const d of db.cppCache.definitionsOf(qn)) add(d.decl, qn);
    if (kind !== 'ned') for (const t of db.findImplTypes(qn)) add(t.decl, t.fqName);
  }
  // Several candidates are common: one class serving many NED types via
  // @class, or copies of a header kept for a tutorial. The file named like
  // the module's own files is the one meant; only without such a file is the
  // choice left to the user.
  const ccStems = out.cc.map((t) => stemOf(t.uri));
  for (const k of COUNTERPART_RING) {
    if (out[k].length < 2) continue;
    const stems = new Set([stemOf(uri), ...(k === 'cc' ? [] : ccStems)]);
    const named = out[k].filter((t) => stems.has(stemOf(t.uri)));
    if (named.length === 1) out[k] = named;
  }

  const stem = uri.slice(0, uri.lastIndexOf('.'));
  for (const k of COUNTERPART_RING) {
    if (k === kind || out[k].length) continue;
    for (const ext of COUNTERPART_EXTENSIONS[k]) {
      const sibling = stem + ext;
      if (await exists(sibling)) {
        out[k].push({ uri: sibling, label: decodeURIComponent(sibling.slice(sibling.lastIndexOf('/') + 1)) });
        break;
      }
    }
  }
  return out;
}

/**
 * The C++ classes of the NED types in a file. With a cursor inside a type that
 * has a class, only that type counts, so a multi-module file jumps straight to
 * the module being edited.
 */
function nedFileClasses(db: SemanticDatabase, uri: string, position: Position | undefined): string[] {
  const classOf = new Map<string, string>();
  const types = db.nedCache.typesInFile(uri);
  for (const t of types) {
    const c = db.findImplClass(t.fqName);
    if (c) classOf.set(t.fqName, c.qualifiedName);
  }
  if (position) {
    const enclosing = types
      .filter((t) => classOf.has(t.fqName) && contains(nodeRange(t.node), position))
      .sort((a, b) => b.node.startIndex - a.node.startIndex)[0];
    if (enclosing) return [classOf.get(enclosing.fqName)!];
  }
  return [...new Set(classOf.values())];
}

/** The classes a C++ file registers (`Define_*`) or defines (`class X {`). */
function cppFileClasses(db: SemanticDatabase, uri: string): string[] {
  const file = db.cppCache.getFile(uri);
  if (!file) return [];
  return [...new Set([...file.classes, ...file.definitions].map((c) => c.qualifiedName))];
}

/** The file name without folder and extension. */
function stemOf(uri: string): string {
  const name = uri.slice(uri.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function contains(r: Range, p: Position): boolean {
  const afterStart = p.line > r.start.line || (p.line === r.start.line && p.character >= r.start.character);
  const beforeEnd = p.line < r.end.line || (p.line === r.end.line && p.character <= r.end.character);
  return afterStart && beforeEnd;
}
