import { test, describe } from 'bun:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tokenizeLine } from '../../eventlog/lineTokenizer';
import { EventLogEntry, EventLogTokenBasedEntry, EventLogMessageEntry } from '../../eventlog/eventLogEntry';
import { entryCodeToClassName, createEntry } from '../../eventlog/entries';
import { parseEventLogLine } from '../../eventlog/index';

// Exercises the entry parsing layer against real .elog fixtures copied verbatim from
// omnetpp-dev/test/misc/eventlog/elog/predefined/{simple,send-message,send-self-message,
// send-direct}/ and one realistic sample (samples/resultfiles/Fifo1-#0.elog).
//
// SPEC AMBIGUITY #1, RESOLVED: every predefined/ fixture file (all four
// subdirectories, not just simple/) contains a top-level "ME" entry code, and
// simple/{one,two}-event*.elog additionally contain "MMB"/"MME". None of these three
// codes exist in the *current* resources/eventlog/eventlogentries.txt spec -- they
// are artifacts of the much older OMNeT++ release these fixtures were recorded with
// (their SB lines carry `ov 1026` = OMNeT++ 4.2, vs. `ov 1536` = OMNeT++ 6.0 for the
// Fifo1 sample). Confirmed via `git log --oneline -- src/eventlog/eventlogentries.txt`
// in omnetpp-dev: commit 57150fcb5d "eventlog: rename ModuleMethodBegin/End to
// ComponentMethodBegin/End" renamed MMB/MME to today's CMB/CME; "ME" has no
// surviving equivalent at all. An unrecognized code is supposed to be silently
// skipped (matching the upstream factory's behavior for a forward-compatible
// reader), so these lines are asserted to parse to `null` rather than being treated
// as a parse failure, and are excluded from the per-line content comparison below
// (they obviously can't round-trip through a class that doesn't exist).
//
// SPEC AMBIGUITY #2, RESOLVED: even restricted to recognized-code lines, print()
// does not reproduce the *exact byte sequence* of every original fixture line --
// not even in the "current-version" Fifo1 sample, let alone in the (far older)
// predefined/ fixtures. Two distinct, independently-verified causes, both external
// to this port (i.e. properties of the historical recordings, not bugs here):
//
//  1. Field ORDER: e.g. simple/two-events.elog's `ES ... n timer pe 0 at 1` has
//     "pe" (previousEventNumber) printed *before* "at" (arrivalTime); Fifo1-#0.elog's
//     `CM ... n test pe -1 l 1000` has "pe" printed *before* "l" (messageLength).
//     Under the *current* spec, "pe" is the LAST field of MessageDescriptionEntry, so
//     our print() always emits it last -- yet these are legitimate lines from real
//     omnetpp binaries. `git log -p -- src/eventlog/eventlogentries.txt` shows why:
//     "pe" used to be several separate per-subclass fields (BeginSendEntry's own,
//     CloneMessageEntry's own, etc., each at that subclass's own field position)
//     that were later consolidated into one shared MessageDescriptionEntry field
//     positioned after every other field. Since the eventlog format is a
//     shorthand-keyed token bag (order does not matter for *reading* it -- see
//     EventLogTokenBasedEntry.getToken(), which scans for a key rather than a fixed
//     position), this is a legitimate historical field-order change, not a parsing
//     bug: two-events.elog was recorded before the consolidation.
//  2. Default OMISSION: Fifo1-#0.elog's `SD sm 2 dm 3 dg 1 pd 0 td 0 rd 0` writes
//     out `pd`/`td`/`rd` even though they're all at the spec's default value of 0
//     (current spec, and our print(), omit optional fields equal to their default --
//     this is also what the task's own porting notes anticipated as "byte equality
//     modulo default-omission").
//
// Given this, the "print() matches the original line" check below is an
// order-insensitive, default-omission-aware comparison of (key -> value) pairs --
// i.e. every key our print() emits must be present in the original line with the
// *same* value (this holds without exception, everywhere, including simple/) --
// rather than a literal string comparison, which real historical fixtures cannot be
// expected to satisfy. Field-value correctness is additionally covered by the
// self-consistent print()->reparse round trip (step 2 below), which is completely
// independent of both field order and the source file's recording-era omission
// conventions.

const fixturesDir = resolve(__dirname, '..', 'fixtures', 'elog');

function listElogFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listElogFiles(p));
    else if (name.endsWith('.elog')) out.push(p);
  }
  return out.sort();
}

const allFixtures = listElogFiles(fixturesDir);

/** Splits raw file text into logical lines, the way FileReader would hand them out (no trailing \n, drop a trailing blank artifact of the final newline). */
function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Legacy entry codes present in the predefined/ fixtures (recorded by a pre-6.0 OMNeT++) that have no equivalent in the current spec. See file header. */
const KNOWN_LEGACY_UNRECOGNIZED_CODES = new Set(['ME', 'MMB', 'MME']);

/** Tokenizes a line into its shorthand key -> value pairs (ignores index 0, the entry code). */
function toKeyValueMap(tokens: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 1; i < tokens.length; i += 2) map.set(tokens[i], tokens[i + 1]);
  return map;
}

test('sanity: fixture set is non-empty and includes the expected subdirectories', () => {
  assert.ok(allFixtures.length >= 25, `expected at least 25 fixture files, found ${allFixtures.length}`);
  const dirs = new Set(allFixtures.map((f) => f.split('/').slice(-2, -1)[0]));
  for (const d of ['simple', 'send-message', 'send-self-message', 'send-direct', 'sample']) {
    assert.ok(dirs.has(d), `missing fixture subdirectory '${d}'`);
  }
});

test('simple/empty.elog is genuinely empty and parses to zero entries', () => {
  const text = readFileSync(join(fixturesDir, 'simple', 'empty.elog'), 'utf8');
  assert.equal(text, '');
  assert.deepEqual(splitLines(text), []);
});

describe('every fixture: no unknown codes crash the tokenizer/factory; every recognized line round-trips', () => {
  for (const file of allFixtures) {
    const rel = file.slice(fixturesDir.length + 1);
    if (rel === 'simple/empty.elog') continue; // covered separately above

    test(`fixture ${rel}`, () => {
      const text = readFileSync(file, 'utf8');
      const lines = splitLines(text);
      let recognizedCount = 0;
      let messageCount = 0;
      let unrecognizedCount = 0;
      const isSimple = rel.startsWith('simple/');

      for (const line of lines) {
        if (line.length === 0) continue; // blank separator line between events

        if (line[0] === '-') {
          const entry = parseEventLogLine(null, 0, 0, line);
          assert.ok(entry instanceof EventLogMessageEntry, `${rel}: "-" line failed to parse: ${line}`);
          assert.equal(entry!.print(), line, `${rel}: message entry did not round-trip byte-exactly: ${line}`);
          messageCount++;
          continue;
        }

        const tokens = tokenizeLine(line);
        const code = tokens[0];
        const isKnown = code in entryCodeToClassName;

        if (!isKnown) {
          assert.ok(
            KNOWN_LEGACY_UNRECOGNIZED_CODES.has(code),
            `${rel}: unexpected unrecognized code '${code}' (not one of the known legacy codes) in line: ${line}`,
          );
          const entry = parseEventLogLine(null, 0, 0, line);
          assert.equal(entry, null, `${rel}: expected a null parse result for legacy code '${code}'`);
          unrecognizedCount++;
          continue;
        }

        // 1. Parse via the top-level dispatcher.
        const entry = parseEventLogLine(null, 0, 0, line) as EventLogTokenBasedEntry;
        assert.ok(entry instanceof EventLogTokenBasedEntry, `${rel}: expected a token-based entry for line: ${line}`);
        assert.equal(entry.getAsString(), code);

        // 2. Round trip: print() -> re-tokenize -> re-parse -> same attribute values.
        const printed = entry.print();
        const reparsed = createEntry(code)!;
        reparsed.parse(tokenizeLine(printed));
        const names = entry.getAttributeNames();
        assert.deepEqual(
          names.map((n) => reparsed.getAsString(n)),
          names.map((n) => entry.getAsString(n)),
          `${rel}: round-trip attribute mismatch for line: ${line}`,
        );

        // 3. Content check vs. the original line: order-insensitive, default-omission-
        //    aware (see file header, "SPEC AMBIGUITY #2"). Every key/value pair our
        //    print() emits must be present, with the same value, in the original
        //    line's own key/value pairs -- this holds for every fixture, including
        //    simple/ (explicitly called out by the phase plan), once field-order and
        //    historical default-omission differences are accounted for.
        const printedKV = toKeyValueMap(tokenizeLine(printed));
        const originalKV = toKeyValueMap(tokens);
        for (const [key, value] of printedKV) {
          assert.ok(originalKV.has(key), `${rel}: print() emitted key '${key}' not present in the original line: ${line}`);
          assert.equal(originalKV.get(key), value, `${rel}: value mismatch for key '${key}' in line: ${line}`);
        }
        if (isSimple) {
          // simple/ fixtures never write an optional field at its default value (verified
          // by inspection), so for them the comparison is exact in both directions.
          assert.deepEqual(new Set(printedKV.keys()), new Set(originalKV.keys()), `${rel}: key set mismatch for line: ${line}`);
        }

        recognizedCount++;
      }

      assert.ok(recognizedCount + messageCount > 0, `${rel}: expected at least one parsed entry`);
    });
  }
});

test('mandatory-field presence: a parsed EventEntry always has its 5 mandatory fields set (fingerprints is the only optional one)', () => {
  // send-direct fixtures are guaranteed to contain plain "E" lines.
  const file = join(fixturesDir, 'send-direct', 'message-P0T0RE-is-processed-after-0-second-immediately-at-the-next-event.elog');
  const lines = splitLines(readFileSync(file, 'utf8'));
  let sawEvent = false;
  for (const line of lines) {
    if (!line.startsWith('E ')) continue;
    const entry = parseEventLogLine(null, 0, 0, line);
    assert.ok(entry instanceof EventLogTokenBasedEntry);
    for (const mandatory of ['#', 't', 'm', 'ce', 'msg']) {
      assert.ok((entry as EventLogTokenBasedEntry).getAsString(mandatory) !== null, `missing mandatory field '${mandatory}' in: ${line}`);
    }
    sawEvent = true;
  }
  assert.ok(sawEvent, 'fixture did not contain any E lines');
});

test('EventLogEntry base class type guard: a null return from parseEventLogLine never satisfies EventLogEntry', () => {
  const result: EventLogEntry | null = parseEventLogLine(null, 0, 0, '');
  assert.equal(result, null);
});
