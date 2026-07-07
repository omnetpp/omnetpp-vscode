import { test } from 'bun:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BigDecimal } from '../../eventlog/bigDecimal';
import { tokenizeLine } from '../../eventlog/lineTokenizer';
import { EventLogTokenBasedEntry, EventLogMessageEntry, parseEventLogEntry } from '../../eventlog/eventLogEntry';
import * as entries from '../../eventlog/entries';

const { createEntry, entryCodeToClassName } = entries;

// ---------------------------------------------------------------------------------
// Spec coverage: entryCodeToClassName / createEntry must cover exactly the concrete
// (non-abstract) classes declared in the committed spec snapshot.
// ---------------------------------------------------------------------------------

const specPath = resolve(__dirname, '..', '..', '..', '..', 'resources', 'eventlog', 'eventlogentries.txt');
const specText = readFileSync(specPath, 'utf8');

/** Minimal re-parse of just the class-header lines, independent of the generator, to cross-check its output. */
function specClassCodes(text: string): string[] {
  const codes: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w]*) +([A-Za-z_][\w]*)(?: +: +[A-Za-z_][\w]*)? *(\/\/.*)?$/);
    if (m && m[1] !== 'abstract') codes.push(m[1]);
  }
  return codes;
}

test('entries: entryCodeToClassName covers exactly the concrete classes in the spec', () => {
  const specCodes = specClassCodes(specText);
  assert.equal(specCodes.length, 44, 'sanity: expected concrete-class count in the committed spec snapshot');
  assert.equal(Object.keys(entryCodeToClassName).length, specCodes.length);
  for (const code of specCodes) {
    assert.ok(code in entryCodeToClassName, `spec code '${code}' missing from entryCodeToClassName`);
  }
});

test('entries: createEntry() instantiates the right class for every known code', () => {
  for (const [code, className] of Object.entries(entryCodeToClassName)) {
    const entry = createEntry(code);
    assert.ok(entry, `createEntry('${code}') returned null`);
    assert.equal(entry!.getClassName(), className);
    assert.equal(entry!.getAsString(), code);
    assert.ok(entry instanceof EventLogTokenBasedEntry);
  }
});

test('entries: createEntry() returns null for unrecognized codes', () => {
  assert.equal(createEntry('ZZZ'), null);
  assert.equal(createEntry(''), null);
  assert.equal(createEntry('mc'), null); // codes are case-sensitive
  assert.equal(createEntry('ME'), null); // a legacy pre-6.0 code no longer in the spec (see entryRoundTrip.test.ts)
});

// ---------------------------------------------------------------------------------
// Comprehensive structural round trip: every concrete class, driven purely through
// getAttributeNames()/getAsString()/parse()/print() (no per-class field knowledge).
// Every attribute is fed the token value '1', which is simultaneously a valid
// int/int64, a valid bool (getBoolToken accepts 0/1), a valid simtime_t decimal, and
// a valid (non-empty, space-free) string -- so one shape of synthetic input line
// exercises every field kind uniformly.
// ---------------------------------------------------------------------------------

test('entries: parse -> print -> reparse round-trips every concrete class', () => {
  for (const [code, className] of Object.entries(entryCodeToClassName)) {
    const entry = createEntry(code)!;
    const names = entry.getAttributeNames();
    // ComponentMethodEndEntry (CME) is the one concrete class with an empty field
    // list (`CME ComponentMethodEndEntry ... {}` in the spec) -- still exercised
    // below, just with zero attributes to compare.
    const tokens = [code, ...names.flatMap((n) => [n, '1'])];
    entry.parse(tokens);

    const before = names.map((n) => entry.getAsString(n));

    const printed = entry.print();
    assert.ok(printed.startsWith(code), `${className}: print() should start with its code`);
    const reTokens = tokenizeLine(printed);
    assert.equal(reTokens[0], code);
    const reparsed = createEntry(code)!;
    reparsed.parse(reTokens);

    const after = names.map((n) => reparsed.getAsString(n));
    assert.deepEqual(after, before, `${className}: attribute values changed across print()/reparse`);
  }
});

// ---------------------------------------------------------------------------------
// Spot semantic checks called out by the phase plan.
// ---------------------------------------------------------------------------------

test('entries: E (EventEntry) fields', () => {
  const entry = createEntry('E')!;
  entry.parse(tokenizeLine('E # 42 t 1.5 m 7 ce 41 msg 99 f "abc def"'));
  const e = entry as entries.EventEntry;
  assert.equal(e.eventNumber, 42);
  assert.ok(e.simulationTime instanceof BigDecimal);
  assert.ok(e.simulationTime.equals(BigDecimal.parse('1.5')));
  assert.equal(e.moduleId, 7);
  assert.equal(e.causeEventNumber, 41);
  assert.equal(e.messageId, 99);
  assert.equal(e.fingerprints, 'abc def');
});

test('entries: E (EventEntry) omits the optional fingerprints field when absent', () => {
  const entry = createEntry('E')! as entries.EventEntry;
  entry.parse(tokenizeLine('E # 0 t 0 m 1 ce -1 msg -1'));
  assert.equal(entry.fingerprints, null);
  assert.equal(entry.print(), 'E # 0 t 0 m 1 ce -1 msg -1');
});

test('entries: BS (BeginSendEntry) fields, including inherited MessageDescriptionEntry fields', () => {
  const line =
    'BS id 5 tid 5 eid 5 etid 5 c cMessage n job pe 3 sd 0.5 up 1 tx 7 sm 2 st 1.25 am 3 at 2.5';
  const entry = createEntry('BS')! as entries.BeginSendEntry;
  entry.parse(tokenizeLine(line));
  assert.equal(entry.messageId, 5);
  assert.equal(entry.messageTreeId, 5);
  assert.equal(entry.messageClassName, 'cMessage');
  assert.equal(entry.messageName, 'job');
  assert.equal(entry.previousEventNumber, 3);
  assert.ok(entry.sendDelay.equals(BigDecimal.parse('0.5')));
  assert.equal(entry.isUpdate, true);
  assert.equal(entry.transmissionId, 7);
  assert.equal(entry.senderModuleId, 2);
  assert.ok(entry.sendingTime.equals(BigDecimal.parse('1.25')));
  assert.equal(entry.arrivalModuleId, 3);
  assert.ok(entry.arrivalTime.equals(BigDecimal.parse('2.5')));
});

test('entries: BS (BeginSendEntry) omits fields at their default (sendDelay 0, isUpdate false, transmissionId -1)', () => {
  const entry = createEntry('BS')! as entries.BeginSendEntry;
  entry.parse(tokenizeLine('BS id 0 tid 0 eid 0 etid 0 c cMessage n x pe -1'));
  assert.ok(entry.sendDelay.equals(BigDecimal.ZERO));
  assert.equal(entry.isUpdate, false);
  assert.equal(entry.transmissionId, -1);
  const printed = entry.print();
  assert.ok(!printed.includes(' sd '));
  assert.ok(!printed.includes(' up '));
  assert.ok(!printed.includes(' tx '));
});

test('entries: SB (SimulationBeginEntry) version fields', () => {
  const entry = createEntry('SB')! as entries.SimulationBeginEntry;
  entry.parse(tokenizeLine('SB ov 1536 ev 2 rid Fifo1-0-20211218-16:50:48-61888'));
  assert.equal(entry.omnetppVersion, 1536);
  assert.equal(entry.eventlogVersion, 2);
  assert.equal(entry.runId, 'Fifo1-0-20211218-16:50:48-61888');
  assert.equal(entry.print(), 'SB ov 1536 ev 2 rid Fifo1-0-20211218-16:50:48-61888');
});

// ---------------------------------------------------------------------------------
// EventLogMessageEntry ("- ..." free-text lines) and the top-level dispatcher.
// ---------------------------------------------------------------------------------

test('entries: parseEventLogEntry dispatches "-" lines to EventLogMessageEntry', () => {
  const result = parseEventLogEntry(createEntry, null, 0, 123, '- some free text');
  assert.ok(result instanceof EventLogMessageEntry);
  assert.equal((result as EventLogMessageEntry).text, 'some free text');
  assert.equal(result!.offset, 123);
  assert.equal(result!.print(), '- some free text');
});

test('entries: parseEventLogEntry returns null for blank lines and unknown codes', () => {
  assert.equal(parseEventLogEntry(createEntry, null, 0, 0, ''), null);
  assert.equal(parseEventLogEntry(createEntry, null, 0, 0, 'ZZZ x 1'), null);
});

test('entries: parseEventLogEntry sets chunk/entryIndex/offset on the parsed entry', () => {
  const chunk = { marker: true };
  const result = parseEventLogEntry(createEntry, chunk, 3, 456, 'MC id 1 c C t T n n');
  assert.ok(result);
  assert.equal(result!.getChunk(), chunk);
  assert.equal(result!.getEntryIndex(), 3);
  assert.equal(result!.getOffset(), 456);
});

// ---------------------------------------------------------------------------------
// getAttributeNames()/getAsString() reflect the full inherited attribute chain.
// ---------------------------------------------------------------------------------

test('entries: getAttributeNames() includes inherited fields in base-then-derived order', () => {
  const entry = createEntry('MC')!; // ModuleCreatedEntry -> ModuleDescriptionEntry -> ModuleReferenceEntry
  assert.deepEqual(entry.getAttributeNames(), ['id', 'c', 't', 'pid', 'n', 'cm']);
});

test('entries: getAsString() falls back through the inheritance chain for inherited attributes', () => {
  const entry = createEntry('MC')!;
  entry.parse(tokenizeLine('MC id 9 c Foo t Foo n foo'));
  assert.equal(entry.getAsString('id'), '9'); // defined on ModuleReferenceEntry (grandparent)
  assert.equal(entry.getAsString('c'), 'Foo'); // defined on ModuleDescriptionEntry (parent)
  assert.equal(entry.getAsString('nope'), null);
});

// ---------------------------------------------------------------------------------
// quote() ports the C++ QUOTE/opp_needsquotes/opp_quotestr trio (the real .elog wire
// format), not the buggy pure-Java qoute() the porting notes point at -- see
// eventLogEntry.ts's EventLogTokenBasedEntry.quote() doc comment and
// gen-eventlog-entries.mjs's header for the full rationale (an empty string and a
// couple of other real cases don't round-trip under the Java version).
// ---------------------------------------------------------------------------------

test('quote(): wraps values containing a space or requiring escaping; passes plain text through', () => {
  assert.equal(EventLogTokenBasedEntry.quote('hello'), 'hello');
  assert.equal(EventLogTokenBasedEntry.quote('hello world'), '"hello world"');
  assert.equal(EventLogTokenBasedEntry.quote(''), '""'); // empty string: always quoted (opp_needsquotes)
  assert.equal(EventLogTokenBasedEntry.quote('a"b'), '"a\\"b"'); // embedded quote: quoted AND escaped
  assert.equal(EventLogTokenBasedEntry.quote('a\\b'), '"a\\\\b"'); // embedded backslash: quoted AND escaped
  assert.equal(EventLogTokenBasedEntry.quote('he said "hi" now'), '"he said \\"hi\\" now"');
  assert.equal(EventLogTokenBasedEntry.quote('a\tb'), '"a\\tb"'); // control character
});

test('quote(): round-trips through the tokenizer (LineTokenizer\'s escape grammar matches opp_quotestr\'s)', () => {
  for (const s of ['hello world', '', 'a"b', 'a\\b', 'he said "hi" now', 'a\tb\nc']) {
    const quoted = EventLogTokenBasedEntry.quote(s);
    const tokens = tokenizeLine('X k ' + quoted);
    assert.equal(tokens[2], s, `round trip failed for ${JSON.stringify(s)} -> ${JSON.stringify(quoted)}`);
  }
});

// ---------------------------------------------------------------------------------
// Generator idempotence: regenerating from the committed snapshot reproduces
// byte-identical output.
// ---------------------------------------------------------------------------------

test('generator: regenerating entries.ts from the committed snapshot is idempotent', () => {
  const repoRoot = resolve(__dirname, '..', '..', '..', '..');
  const entriesPath = resolve(repoRoot, 'shared', 'src', 'eventlog', 'entries.ts');
  const before = readFileSync(entriesPath, 'utf8');

  const result = spawnSync('bun', ['scripts/gen-eventlog-entries.mjs'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);

  const after = readFileSync(entriesPath, 'utf8');
  assert.equal(after, before, 'regenerating entries.ts changed its content (generator is not idempotent, or entries.ts is stale)');

  // Run it a second time in a row to double-check true idempotence (not just "matches what's on disk").
  const result2 = spawnSync('bun', ['scripts/gen-eventlog-entries.mjs'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result2.status, 0, result2.stderr);
  assert.equal(readFileSync(entriesPath, 'utf8'), before);
});
