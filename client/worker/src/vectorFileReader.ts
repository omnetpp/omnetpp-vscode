/**
 * vectorFileReader.ts — a minimal reader for OMNeT++ output vector files (`.vec`), enough
 * to back the Sequence Chart's "vector data on a module axis" feature (Eclipse's
 * `AxisVectorBarRenderer` + the scave `IndexedVectorFileReader`, ported to TypeScript).
 *
 * DESIGN: pure, content-based (takes the whole file text, returns plain data) so it is
 * host-agnostic and unit-testable without a filesystem — the worker (`engineSession.ts`)
 * does the `fs.readFileSync` and calls these. It loads a WHOLE vector into memory, matching
 * Eclipse's own code path (`readVectorsIntoArrays` with no time range); the `.vci` block
 * index is intentionally NOT used (a documented cost trade-off — see the plan). Vectors are
 * small enough for this in practice, and data lines are monotonic in time per vector so a
 * range scan could early-exit if that ever changes.
 *
 * FORMAT (canonical writer: omnetpp `src/common/omnetppvectorfilewriter.cc`, versions 2/3):
 * line-based UTF-8 text.
 *  - `vector <id> <module> <name> <columnSpec>` — a vector declaration. `columnSpec` is a
 *    string of column letters: `E`=event number, `T`=simulation time, `V`=value (e.g.
 *    "ETV" or "TV", default "TV"). `module`/`name` are double-quoted if they contain spaces.
 *  - `attr <key> <value>` lines immediately following a declaration are that vector's
 *    attributes; we keep `type` (int/double/enum) and `enum` ("NAME=0,OTHER=1,…") for
 *    value/enum labeling.
 *  - Data lines are tab/space separated, first field = vectorId, remaining fields per the
 *    vector's `columnSpec`: ETV → `<id> <event> <simtime> <value>`, TV → `<id> <simtime>
 *    <value>`. Data lines for different vectors are interleaved.
 *  - `version`/`run`/`config`/`itervar`/blank lines are ignored by this reader.
 */

/** Meaning of a vector's `columnSpec` letters (which fields its data lines carry, in order). */
export interface VecColumns {
  /** The raw spec string, e.g. "ETV". */
  spec: string;
  /** 0-based position of the event-number field within a data line's value columns (after the leading id), or -1 if absent. */
  eventIndex: number;
  /** 0-based position of the simulation-time field, or -1 if absent. */
  timeIndex: number;
  /** 0-based position of the value field, or -1 if absent. */
  valueIndex: number;
}

/** A vector's identity + value typing, as parsed from its declaration and `attr` lines. */
export interface VecVectorInfo {
  id: number;
  module: string;
  name: string;
  columns: VecColumns;
  /** From `attr type` — `'int' | 'double' | 'enum'`, or null if unspecified. */
  type: 'int' | 'double' | 'enum' | null;
  /** From `attr enum` — value → symbolic name, or null when the vector is not an enum. */
  enum: Map<number, string> | null;
}

/** One `(eventNumber?, simtime, value)` sample of a vector. */
export interface VecSample {
  /** null when the vector has no `E` column (a `TV` vector) — the chart then aligns by simtime. */
  eventNumber: number | null;
  simtime: number;
  value: number;
}

/** The declarations found in a `.vec` file, for the attach picker. */
export interface VecListing {
  runs: string[];
  vectors: VecVectorInfo[];
}

/** A single vector fully loaded: its info plus all samples. */
export interface VecVectorData {
  info: VecVectorInfo;
  samples: VecSample[];
}

/**
 * Splits a `.vec` line into tokens on runs of whitespace, honouring double-quoted spans
 * (which may contain spaces) and `\"`/`\\` escapes inside them — mirrors the quote handling
 * of omnetpp's `LineTokenizer`. Quotes are stripped from the returned token.
 */
export function tokenizeVecLine(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    // skip leading whitespace
    while (i < n && (line[i] === ' ' || line[i] === '\t' || line[i] === '\r')) i++;
    if (i >= n) break;
    let tok = '';
    if (line[i] === '"') {
      i++; // opening quote
      while (i < n && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < n) {
          i++; // take the escaped char literally
        }
        tok += line[i];
        i++;
      }
      i++; // closing quote (if present)
    } else {
      while (i < n && line[i] !== ' ' && line[i] !== '\t' && line[i] !== '\r') {
        tok += line[i];
        i++;
      }
    }
    tokens.push(tok);
  }
  return tokens;
}

/** Parses a `columnSpec` string (e.g. "ETV") into the field positions of a data line's value columns. */
export function parseColumns(spec: string): VecColumns {
  return {
    spec,
    eventIndex: spec.indexOf('E'),
    timeIndex: spec.indexOf('T'),
    valueIndex: spec.indexOf('V'),
  };
}

/** Parses an `enum` attribute value (`"IDLE=0,BUSY=1,…"`) into a value→name map. */
export function parseEnumAttr(value: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const pair of value.split(',')) {
    const eq = pair.lastIndexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const num = Number(pair.slice(eq + 1).trim());
    if (name && Number.isFinite(num)) map.set(num, name);
  }
  return map;
}

function normalizeType(v: string): VecVectorInfo['type'] {
  return v === 'int' || v === 'double' || v === 'enum' ? v : null;
}

/** Builds a `VecVectorInfo` from a parsed `vector` declaration line's tokens (`['vector', id, module, name, spec]`). */
function parseDeclaration(tokens: string[]): VecVectorInfo | null {
  // `vector <id> <module> <name> [<columnSpec>]` -- columnSpec defaults to "TV" (writer default).
  if (tokens.length < 4) return null;
  const id = Number(tokens[1]);
  if (!Number.isInteger(id)) return null;
  return {
    id,
    module: tokens[2],
    name: tokens[3],
    columns: parseColumns(tokens[4] ?? 'TV'),
    type: null,
    enum: null,
  };
}

/** Applies an `attr <key> <value>` line to the vector declaration it follows. */
function applyAttr(info: VecVectorInfo, tokens: string[]): void {
  if (tokens.length < 3) return;
  const key = tokens[1];
  const value = tokens.slice(2).join(' ');
  if (key === 'type') info.type = normalizeType(value);
  else if (key === 'enum') info.enum = parseEnumAttr(value);
}

/**
 * Scans the file for vector declarations (+ their attributes) and run names, WITHOUT reading
 * any data lines' values — for the "pick a vector to attach" flow. O(lines).
 */
export function listVectors(content: string): VecListing {
  const runs: string[] = [];
  const vectors: VecVectorInfo[] = [];
  let current: VecVectorInfo | null = null;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.length > 0 && rawLine[rawLine.length - 1] === '\r' ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      current = null;
      continue;
    }
    const c0 = line[0];
    // data lines begin with a digit or '-' (the vectorId); nothing to collect from them.
    if (c0 >= '0' && c0 <= '9') {
      current = null;
      continue;
    }
    if (line.startsWith('vector ')) {
      const info = parseDeclaration(tokenizeVecLine(line));
      if (info) {
        vectors.push(info);
        current = info;
      } else {
        current = null;
      }
    } else if (line.startsWith('attr ')) {
      if (current) applyAttr(current, tokenizeVecLine(line));
    } else if (line.startsWith('run ')) {
      const tokens = tokenizeVecLine(line);
      if (tokens[1]) runs.push(tokens[1]);
      current = null;
    } else {
      current = null;
    }
  }
  return { runs, vectors };
}

/**
 * Color bucket for a sample value (Eclipse `AxisVectorBarRenderer.getValueIndex`): enum/int
 * types and whole-number doubles use the integer value itself (so equal values share a
 * color); non-integer doubles fall back to the sample index (each distinct value → a
 * distinct color). The index is fed to a "good light color" palette on the client.
 */
export function vectorValueIndex(value: number, info: Pick<VecVectorInfo, 'type'>, sampleIndex: number): number {
  if (info.type === 'enum' || info.type === 'int') return Math.floor(value);
  if (value === Math.floor(value)) return Math.floor(value);
  return sampleIndex;
}

/**
 * Display text for a sample value (Eclipse `getValueText`): an enum's symbolic name when the
 * vector is an enum and the value is a known member. When the vector IS an enum but the value
 * has no matching member, Eclipse's native `EnumType::nameOf()` (`enumtype.cc:51-54`) returns
 * null and `AxisVectorBarRenderer.drawAxis()` (`AxisVectorBarRenderer.java:176-177`) skips the
 * label entirely (a colored segment with no text) -- NOT a numeric fallback, so that case
 * returns `''` here too (the render path already treats an empty `valueText` as "draw
 * nothing"). Non-enum vectors are unaffected: the integer (for whole numbers) or the raw
 * double.
 */
export function vectorValueText(value: number, info: Pick<VecVectorInfo, 'enum'>): string {
  if (info.enum) return info.enum.get(Math.floor(value)) ?? '';
  return value === Math.floor(value) ? String(Math.floor(value)) : String(value);
}

/**
 * Loads ONE vector (by id) fully into memory: its info plus every `(eventNumber?, simtime,
 * value)` sample, streaming the whole file once. Returns null if the id has no declaration.
 */
export function readVector(content: string, vectorId: number): VecVectorData | null {
  let info: VecVectorInfo | null = null;
  const samples: VecSample[] = [];
  const idStr = String(vectorId);
  let current: VecVectorInfo | null = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.length > 0 && rawLine[rawLine.length - 1] === '\r' ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      current = null;
      continue;
    }
    const c0 = line[0];
    if (c0 >= '0' && c0 <= '9') {
      // data line -- cheap prefix check before tokenizing: must be our id followed by a separator.
      if (info === null) continue;
      const sep = line.length > idStr.length && (line[idStr.length] === '\t' || line[idStr.length] === ' ');
      if (!sep || !line.startsWith(idStr)) continue;
      const tokens = tokenizeVecLine(line);
      // tokens[0] is the id; value columns follow, indexed by the columnSpec.
      const cols = info.columns;
      const simtime = cols.timeIndex >= 0 ? Number(tokens[1 + cols.timeIndex]) : NaN;
      const value = cols.valueIndex >= 0 ? Number(tokens[1 + cols.valueIndex]) : NaN;
      const eventNumber = cols.eventIndex >= 0 ? Number(tokens[1 + cols.eventIndex]) : null;
      if (Number.isFinite(simtime) && Number.isFinite(value)) samples.push({ eventNumber, simtime, value });
      continue;
    }
    if (line.startsWith('vector ')) {
      const decl = parseDeclaration(tokenizeVecLine(line));
      current = decl;
      if (decl && decl.id === vectorId) info = decl;
    } else if (line.startsWith('attr ')) {
      if (current) applyAttr(current, tokenizeVecLine(line));
    } else {
      current = null;
    }
  }

  return info ? { info, samples } : null;
}
