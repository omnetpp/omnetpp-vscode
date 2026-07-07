/**
 * Hand-written base classes for the eventlog "entry" parsing layer. Ported from:
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/EventLogEntry.java
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/EventLogTokenBasedEntry.java
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/EventLogMessageEntry.java
 *   omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/eventlog/EventLogEntryFactory.java
 * (the generated `entries.ts`, produced by scripts/gen-eventlog-entries.mjs, extends
 * `EventLogTokenBasedEntry` from this file.)
 *
 * Deviations from the Java originals (phase E2 of the eventlog port plan):
 *
 *  - No static mutable "current line" buffer. The Java base class threads a static
 *    `currentLine`/`currentLineLength` pair through a static `parseEntry()` purely so
 *    that the per-token getter helpers can quote the offending source line in thrown
 *    exceptions. The port plan forbids static mutable state (the engine must be safe
 *    to reuse/re-enter on a worker thread), so error messages here are built from the
 *    `tokens` array itself (`tokens.join(' ')`) instead, and `parseEventLogEntry()` is
 *    a plain function taking explicit parameters — no hidden statics.
 *
 *  - `print()` returns a `string` instead of writing to a `java.io.OutputStream`: a
 *    natural adaptation for a host-agnostic engine with no stream abstraction. The
 *    returned string does NOT include a trailing newline — this matches
 *    `FileReader`'s `Line.text` (see fileReader.ts), which also excludes it. Callers
 *    that serialize to a real file append `'\n'` themselves.
 *
 *  - `getAsString()` (no args) and `getAsString(String)` (one arg) from the Java side
 *    are unified into a single `getAsString(attribute?: string)`: with no argument it
 *    returns the entry's code (or `'abstract'`), with an argument it looks up that
 *    field. Typed `string | null` (not just `string`) because both the "unknown
 *    attribute" fallback and optional string-valued fields can genuinely be null.
 *
 *  - The factory is dependency-injected rather than imported directly:
 *    `parseEventLogEntry()` below takes a `createEntry` callback parameter instead of
 *    calling `EventLogEntryFactory.parseEntry()` itself. Reason: `entries.ts` (the
 *    generated factory + all entry classes) necessarily imports the base classes
 *    defined *here*, so this file cannot import back from `entries.ts` without a
 *    circular module dependency. `shared/src/eventlog/index.ts` wires the two
 *    together with a small convenience export (`parseEventLogLine`).
 *
 *  - `getClassIndex()` is not ported. In the upstream Perl generator
 *    (eventlogentries.pl) it is computed from a loop-local `$index` counter that is
 *    incremented only during the (unrelated) C++ header-emission pass and then never
 *    reset before the Java-emission pass reads it again — so every generated Java
 *    class's `getClassIndex()` returns the same, final leftover value (verified by
 *    reading a dozen sampled generated .java files: EventEntry, BeginSendEntry,
 *    ModuleDescriptionEntry, IndexEntry, ReferenceEntry, ... all return 60). It's an
 *    upstream generator bug, carries no information, and has no callers in the ported
 *    subsystem, so this is a deliberate omission rather than an oversight.
 *
 *  - chunk/event back-reference: phase E3 (Event/IChunk) completes what was deferred
 *    here in E2. `getEvent()` ports `chunk instanceof Event ? (Event)chunk : null` as
 *    the `isIEvent()` type guard from ieventlog.ts instead of a value-level `instanceof
 *    Event` check, specifically to avoid a real circular module dependency: `Event`
 *    (event.ts) needs to import `EventLogEntry`/`EventLogMessageEntry` from *this* file
 *    at the value level (for `instanceof` checks against parsed entries), so this file
 *    cannot in turn import the concrete `Event` class as a value. `isIEvent()` only
 *    needs the `IEvent` *type* (safe, `import type`, erased at compile time) plus a
 *    duck-typed marker method (`getEventEntry`, unique to `IEvent`) checked at runtime.
 */

import { BigDecimal } from './bigDecimal';
import { tokenizeLine } from './lineTokenizer';
import { isIEvent, type IChunk, type IEvent } from './ieventlog';

/** Port of org.omnetpp.eventlog.EventLogEntry — abstract base for every entry kind. */
export abstract class EventLogEntry {
  /** Indent level (method call depth) of the module context this entry occurred in. */
  contextModuleId = -1;
  /** Indent level (method call depth) at the point this entry was recorded. */
  level = -1;

  /** Absolute byte offset of this entry's line in the .elog file. */
  offset = -1;
  /**
   * Back-reference to the owning Event/Snapshot/Index chunk. `null` both for entries
   * that genuinely have none yet (not parsed through `parseEventLogEntry()`) and for
   * entries Java parses with a `null` chunk on purpose: `Index.parse()`/
   * `Snapshot.parse()` call `EventLogEntry.parseEntry(eventLog, null, ...)` (chunk
   * argument literally `null`) for every entry inside an "I"/"S" chunk — ported
   * faithfully in chunks.ts.
   */
  chunk: IChunk | null = null;
  /** Index of this entry within its owning chunk. */
  entryIndex = -1;

  abstract getAttributeNames(): string[];
  abstract getAsString(attribute?: string): string | null;
  /** Renders this entry back to its eventlog line format, without a trailing newline. */
  abstract print(): string;
  abstract getClassName(): string;

  getContextModuleId(): number {
    return this.contextModuleId;
  }
  getLevel(): number {
    return this.level;
  }
  getOffset(): number {
    return this.offset;
  }
  getChunk(): IChunk | null {
    return this.chunk;
  }
  /** Port of `EventLogEntry.getEvent()` — see this file's header for why this uses `isIEvent()` rather than `instanceof Event`. */
  getEvent(): IEvent | null {
    return this.chunk !== null && isIEvent(this.chunk) ? this.chunk : null;
  }
  /** Port of `EventLogEntry.getEventNumber()`. Throws (like Java's implicit NPE) if `chunk` is `null`. */
  getEventNumber(): number {
    return this.chunk!.getEventNumber();
  }
  /** Port of `EventLogEntry.getSimulationTime()`. Throws (like Java's implicit NPE) if `chunk` is `null`. */
  getSimulationTime(): BigDecimal {
    return this.chunk!.getSimulationTime();
  }
  getEntryIndex(): number {
    return this.entryIndex;
  }

  /**
   * Port of `EventLogEntry.getPreviousEventLogEntry()`. Requires `getEvent()` to be
   * non-null (like Java, which dereferences the cast unconditionally).
   */
  getPreviousEventLogEntry(): EventLogEntry | null {
    const event = this.getEvent()!;
    if (this.entryIndex === 0) {
      const previousEvent = event.getPreviousEvent();
      return previousEvent !== null ? previousEvent.getEventLogEntry(previousEvent.getNumEventLogEntries() - 1) : null;
    }
    return event.getEventLogEntry(this.entryIndex - 1);
  }

  /** Port of `EventLogEntry.getNextEventLogEntry()`. Requires `getEvent()` to be non-null (see above). */
  getNextEventLogEntry(): EventLogEntry | null {
    const event = this.getEvent()!;
    if (this.entryIndex === event.getNumEventLogEntries() - 1) {
      const nextEvent = event.getNextEvent();
      return nextEvent !== null ? nextEvent.getEventLogEntry(0) : null;
    }
    return event.getEventLogEntry(this.entryIndex + 1);
  }

  /** Port of `EventLogEntry.parseEventNumber(String)`. */
  static parseEventNumber(str: string): number {
    const n = Number(str);
    if (!Number.isFinite(n)) throw new Error(`EventLogEntry: invalid event number '${str}'`);
    return n;
  }

  /** Port of `EventLogEntry.parseSimulationTime(String)`. */
  static parseSimulationTime(str: string): BigDecimal {
    return BigDecimal.parse(str);
  }
}

/** One free-text log line (`- ...`). Port of `EventLogMessageEntry`. */
export class EventLogMessageEntry extends EventLogEntry {
  text: string | null = null;

  constructor(chunk: IChunk | null = null, entryIndex = -1) {
    super();
    this.chunk = chunk;
    this.entryIndex = entryIndex;
  }

  getText(): string | null {
    return this.text;
  }

  /**
   * Port of `EventLogMessageEntry.parse(String line, int length)` — everything after
   * the leading `"- "` is the message text (the `length` parameter of the Java
   * original is not needed here: unlike the C-buffer-backed original, `line` is
   * already the exact text of the line, with no trailing garbage to bound).
   */
  parseLine(line: string): void {
    this.text = line.slice(2);
  }

  print(): string {
    return '- ' + (this.text ?? '');
  }

  getClassName(): string {
    return 'EventLogMessageEntry';
  }

  getAttributeNames(): string[] {
    return ['-'];
  }

  getAsString(attribute?: string): string | null {
    if (attribute === undefined) return '-';
    if (attribute === 'type') return '-';
    if (attribute === '-') return this.text;
    return null;
  }
}

/** Base class for entries represented by shorthand-keyed tokens. Port of `EventLogTokenBasedEntry`. */
export abstract class EventLogTokenBasedEntry extends EventLogEntry {
  /**
   * Decides whether `quote()` needs to wrap a value in `"..."` at all. Port of
   * `opp_needsquotes()` (omnetpp-dev/src/common/stringutil.cc) — NOT of the Java
   * UI's own `EventLogTokenBasedEntry.qoute()`. See `quote()`'s doc comment for why.
   */
  private static needsQuotes(text: string): boolean {
    if (text.length === 0) return true;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      const isSpace = c === 0x20 || (c >= 0x09 && c <= 0x0d); // opp_isspace(): C's isspace()
      const isControl = c <= 0x1f || c === 0x7f; // opp_iscntrl(): C's iscntrl()
      if (isSpace || c === 0x5c /* \ */ || c === 0x22 /* " */ || isControl) return true;
    }
    return false;
  }

  /**
   * Renders a field value the way it's actually written to real .elog files.
   *
   * DECISION: this ports the C++ `QUOTE`/`opp_quotestr`/`opp_needsquotes` trio
   * (omnetpp-dev/src/common/stringutil.{h,cc}), not the pure-Java
   * `EventLogTokenBasedEntry.qoute(String)` the porting notes point at. Reason: real
   * .elog files are written by the C++ simulation kernel, not by the Java UI (which
   * only re-serializes entries on rarer export/save paths) — so the C++ quoting is
   * the actual wire format this port must round-trip. Concretely, the Java version
   * only quotes when the value contains a space, which is provably insufficient:
   * `resources/eventlog/eventlogentries.txt`-conformant real files contain lines
   * like `MDC id 1 d ""` (an explicitly-quoted *empty* display string) written by
   * OMNeT++ 6.0 — ported faithfully, the Java version's `qoute("")` returns `""`
   * (the empty string, unquoted) rather than the two-character token `""`, which is
   * unparseable as "the empty string" by `LineTokenizer` (an unquoted empty token
   * simply isn't a token at all) and was empirically confirmed to break round-trip
   * parsing of `shared/src/test/fixtures/elog/sample/Fifo1-#0.elog`. The C++ side
   * additionally quotes values containing a backslash, an embedded quote, or a
   * control character, which `LineTokenizer`'s escape grammar (see
   * shared/src/eventlog/lineTokenizer.ts's `interpretBackslashes()`) was already
   * built to exactly parse back — the two were ported from the same C++ source
   * (linetokenizer.cc quotes via this same escape set) independently in phase E1,
   * and now correctly compose.
   */
  static quote(text: string): string {
    if (!EventLogTokenBasedEntry.needsQuotes(text)) return text;
    let out = '"';
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      switch (c) {
        case 0x08: out += '\\b'; break;
        case 0x0c: out += '\\f'; break;
        case 0x0a: out += '\\n'; break;
        case 0x0d: out += '\\r'; break;
        case 0x09: out += '\\t'; break;
        case 0x5c: out += '\\\\'; break;
        case 0x22: out += '\\"'; break;
        default:
          if (c <= 0x1f || c === 0x7f) out += '\\x' + c.toString(16).toUpperCase().padStart(2, '0');
          else out += text[i];
      }
    }
    out += '"';
    return out;
  }

  /**
   * Looks up the value following a shorthand key token (Java: `getToken`). Tokens
   * are scanned as `(key, value)` pairs starting at index 1 (index 0 is the entry
   * code, e.g. `"MC"`). Throws if `mandatory` and no such key is present.
   */
  protected getToken(tokens: string[], sign: string, mandatory: boolean): string | null {
    for (let i = 1; i < tokens.length; i += 2) {
      if (tokens[i] === sign) return tokens[i + 1];
    }
    if (mandatory) throw new Error(`Missing mandatory token ${sign} in line: ${tokens.join(' ')}`);
    return null;
  }

  protected getBoolToken(tokens: string[], sign: string, mandatory: boolean, defaultValue: boolean): boolean {
    const value = this.getIntToken(tokens, sign, mandatory, defaultValue ? 1 : 0);
    if (value === 0) return false;
    if (value === 1) return true;
    throw new Error(`Invalid boolean ${value} in line: ${tokens.join(' ')}`);
  }

  /** Covers the Java `int`/`short` cases — both map to plain `number` in TS. */
  protected getIntToken(tokens: string[], sign: string, mandatory: boolean, defaultValue: number): number {
    const token = this.getToken(tokens, sign, mandatory);
    return token !== null ? Number(token) : defaultValue;
  }

  /** Covers the Java `long`/`int64_t`/`eventnumber_t`/`msgid_t`/`txid_t` cases. */
  protected getInt64Token(tokens: string[], sign: string, mandatory: boolean, defaultValue: number): number {
    const token = this.getToken(tokens, sign, mandatory);
    return token !== null ? Number(token) : defaultValue;
  }

  // Overloaded so that generated mandatory string fields (whose TS type is the
  // non-nullable `string`, with `''` as their pre-parse placeholder — see
  // gen-eventlog-entries.mjs) can pass `this.field` as `defaultValue` and get back
  // a `string`, while optional NULL-defaulted fields (typed `string | null`) still
  // get back `string | null`.
  protected getStringToken(tokens: string[], sign: string, mandatory: boolean, defaultValue: string): string;
  protected getStringToken(tokens: string[], sign: string, mandatory: boolean, defaultValue: string | null): string | null;
  protected getStringToken(tokens: string[], sign: string, mandatory: boolean, defaultValue: string | null): string | null {
    const token = this.getToken(tokens, sign, mandatory);
    return token !== null ? token : defaultValue;
  }

  protected getSimtimeToken(tokens: string[], sign: string, mandatory: boolean, defaultValue: BigDecimal): BigDecimal {
    const token = this.getToken(tokens, sign, mandatory);
    return token !== null ? BigDecimal.parse(token) : defaultValue;
  }

  abstract parse(tokens: string[]): void;
}

/** Injected by `shared/src/eventlog/index.ts` with the generated `createEntry` from entries.ts. */
export type EntryFactory = (code: string) => EventLogTokenBasedEntry | null;

/**
 * Dispatches a single already-read (but not yet tokenized) eventlog line to the
 * right entry class. Merged port of `EventLogEntry.parseEntry` +
 * `EventLogEntryFactory.parseEntry`, adapted to take explicit parameters instead of
 * relying on Java's static `currentLine` bookkeeping (see file header) and to take
 * the class factory as a parameter (to avoid a circular import with entries.ts).
 *
 * Returns null for a blank line or an unrecognized entry code (matching the Java:
 * an unknown code is silently ignored, not an error).
 */
export function parseEventLogEntry(
  createEntry: EntryFactory,
  chunk: IChunk | null,
  entryIndex: number,
  offset: number,
  line: string,
): EventLogEntry | null {
  if (line.length === 0) return null;
  if (line[0] === '-') {
    const message = new EventLogMessageEntry(chunk, entryIndex);
    message.parseLine(line);
    message.offset = offset;
    return message;
  }
  const tokens = tokenizeLine(line);
  if (tokens.length < 1) return null;
  const entry = createEntry(tokens[0]);
  if (entry === null) return null;
  entry.chunk = chunk;
  entry.entryIndex = entryIndex;
  entry.parse(tokens);
  entry.offset = offset;
  return entry;
}
