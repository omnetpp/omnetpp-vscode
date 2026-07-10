/**
 * Phase U10 test suite: `computeEntryProposals()` (shared/src/eventlog/
 * entryProposals.ts), the port of Eclipse's `EventLogEntryProposalProvider` +
 * `MatchExpressionContentProposalProvider`. Exercises every grammar position the ported
 * logic distinguishes (start of expression / after AND / after OR / after `(` / after
 * NOT / after `)` / after `field =~` / after a complete value), plus the two
 * upstream-faithful quirks that are easy to get wrong in a naive re-implementation:
 * `getLastDefaultFieldValue()` returning the FIRST standalone entry-type token in the
 * text (not the nearest one to the cursor), and `getFieldValueProposals()` being an
 * unconditional no-op (see entryProposals.ts's header for both, verified against the
 * real Java source).
 *
 * Uses the REAL schema (`buildEntryTypeSchema()`, derived from `entries.ts`) rather
 * than a hand-mocked one, so these tests also double as a sync check between the two
 * files (a code renamed/removed from `ENTRY_TYPE_CODES` or `entries.ts` would surface
 * here as a broken assertion, not just at runtime).
 */

import { test } from 'bun:test';
import assert from 'node:assert';
import { computeEntryProposals, type EntryProposal } from '../../eventlog/entryProposals';
import { buildEntryTypeSchema, ENTRY_TYPE_CODES } from '../../eventlog/entryTypeSchema';

const schema = buildEntryTypeSchema();

function texts(proposals: EntryProposal[]): string[] {
  return proposals.map((p) => p.text);
}

function labels(proposals: EntryProposal[]): string[] {
  return proposals.map((p) => p.label);
}

// ---------------------------------------------------------------------------------
// entryTypeSchema.ts sanity (the data computeEntryProposals() is driven by)
// ---------------------------------------------------------------------------------

test('entryTypeSchema: buildEntryTypeSchema() has exactly one entry per ENTRY_TYPE_CODES code', () => {
  assert.deepEqual(Object.keys(schema).sort(), [...ENTRY_TYPE_CODES].sort());
  // Almost every entry type has at least one attribute; CME (ComponentMethodEndEntry)
  // is a genuine exception -- a bare marker line with no fields of its own (verified
  // against entries.ts: parse()/getAttributeNames() are both empty), matching the real
  // Java ComponentMethodEndEntry.
  for (const code of ENTRY_TYPE_CODES) {
    assert.ok(Array.isArray(schema[code]), `schema['${code}'] should be an array`);
    if (code !== 'CME') assert.ok(schema[code].length > 0, `schema['${code}'] should have at least one attribute`);
  }
});

test('entryTypeSchema: BS (BeginSendEntry) schema includes its own fields and its inherited MessageDescriptionEntry/MessageReferenceEntry fields', () => {
  assert.deepEqual(schema.BS, [
    'id', 'tid', 'eid', 'etid', 'c', 'n', 'k', 'p', 'l', 'er', 'm', 'sm', 'sg', 'st', 'am', 'ag', 'at', 'd', 'pe',
    'sd', 'up', 'tx',
  ]);
});

// ---------------------------------------------------------------------------------
// 1. Empty input / start of expression -> entry-type codes + NOT (no field names: no
//    entry type is "in scope" yet).
// ---------------------------------------------------------------------------------

test('computeEntryProposals: empty input offers every entry-type code (sorted) + NOT, no field names', () => {
  const result = computeEntryProposals('', 0, schema);
  assert.equal(result.positionKind, 'expr-start');
  assert.equal(result.replaceStart, 0);
  assert.equal(result.replaceEnd, 0);
  // every code present, each as "<code> "
  for (const code of ENTRY_TYPE_CODES) assert.ok(texts(result.proposals).includes(`${code} `), `missing proposal for '${code}'`);
  assert.ok(texts(result.proposals).includes('NOT '));
  // entry-type codes are sorted ahead of NOT (Java: field names, then default-field
  // values, then NOT appended unsorted at the end)
  assert.equal(result.proposals[result.proposals.length - 1].label, 'NOT');
  // field-name proposals: none of BS's fields (e.g. "sd =~ ") should appear, since no
  // entry type is in scope for a totally empty input
  assert.ok(!texts(result.proposals).includes('sd =~ '));
});

test('computeEntryProposals: entry-type-code proposals are sorted alphabetically by code', () => {
  const result = computeEntryProposals('', 0, schema);
  const codeLabels = labels(result.proposals).filter((l) => (ENTRY_TYPE_CODES as readonly string[]).includes(l));
  const sorted = [...codeLabels].sort();
  assert.deepEqual(codeLabels, sorted);
});

// ---------------------------------------------------------------------------------
// 2. After AND / OR / ( -> same "expr-start" position, PLUS field names for whichever
//    entry-type is "in scope" (the first standalone entry-type token in the text).
// ---------------------------------------------------------------------------------

test('computeEntryProposals: after "BS AND " offers BS\'s field names (suffixed " =~ "), all entry-type codes, and NOT', () => {
  const text = 'BS AND ';
  const result = computeEntryProposals(text, text.length, schema);
  assert.equal(result.positionKind, 'expr-start');
  assert.ok(texts(result.proposals).includes('sd =~ '), 'expected BS-specific field "sd"');
  assert.ok(texts(result.proposals).includes('id =~ '), 'expected inherited field "id"');
  assert.ok(texts(result.proposals).includes('BS '));
  assert.ok(texts(result.proposals).includes('NOT '));
});

test('computeEntryProposals: after "BS OR " behaves the same as after "BS AND "', () => {
  const text = 'BS OR ';
  const result = computeEntryProposals(text, text.length, schema);
  assert.equal(result.positionKind, 'expr-start');
  assert.ok(texts(result.proposals).includes('sd =~ '));
});

test('computeEntryProposals: after "(" offers entry-type codes + NOT, no field names (nothing in scope yet)', () => {
  const text = '(';
  const result = computeEntryProposals(text, text.length, schema);
  assert.equal(result.positionKind, 'expr-start');
  assert.ok(texts(result.proposals).includes('BS '));
  assert.ok(texts(result.proposals).includes('NOT '));
  assert.ok(!texts(result.proposals).includes('sd =~ '));
});

// ---------------------------------------------------------------------------------
// 3. The upstream quirk: getLastDefaultFieldValue() returns the FIRST standalone
//    entry-type token in the text, not the nearest one to the cursor.
// ---------------------------------------------------------------------------------

test('computeEntryProposals: "BS AND x =~ 1 OR ES AND " still offers BS\'s fields, not ES\'s (Eclipse\'s real, documented quirk)', () => {
  const text = 'BS AND x =~ 1 OR ES AND ';
  const result = computeEntryProposals(text, text.length, schema);
  assert.equal(result.positionKind, 'expr-start');
  assert.ok(texts(result.proposals).includes('sd =~ '), 'expected BS-specific field "sd" (first standalone entry-type token)');
  assert.ok(!texts(result.proposals).includes('i =~ '), 'ES-specific field "i" should NOT appear -- the scan never reaches "ES"');
});

// ---------------------------------------------------------------------------------
// 4. After NOT -> field names + entry-type codes, but NOT itself is not re-offered.
// ---------------------------------------------------------------------------------

test('computeEntryProposals: after "NOT " offers entry-type codes but not NOT itself', () => {
  const text = 'NOT ';
  const result = computeEntryProposals(text, text.length, schema);
  assert.equal(result.positionKind, 'after-not');
  assert.ok(texts(result.proposals).includes('BS '));
  assert.ok(!labels(result.proposals).includes('NOT'));
});

// ---------------------------------------------------------------------------------
// 5. After a closing paren -> AND / OR only.
// ---------------------------------------------------------------------------------

test('computeEntryProposals: after ")" offers exactly AND and OR', () => {
  const text = '(BS) ';
  const result = computeEntryProposals(text, text.length, schema);
  assert.equal(result.positionKind, 'after-close-paren');
  assert.deepEqual(texts(result.proposals).sort(), ['AND ', 'OR ']);
});

// ---------------------------------------------------------------------------------
// 6. After "field =~" -> nothing (getFieldValueProposals() is a documented no-op
//    upstream, faithfully preserved).
// ---------------------------------------------------------------------------------

test('computeEntryProposals: after "id =~" offers nothing (upstream getFieldValueProposals() is a no-op)', () => {
  const text = 'id =~';
  const result = computeEntryProposals(text, text.length, schema);
  assert.equal(result.positionKind, 'after-matches');
  assert.deepEqual(result.proposals, []);
});

test('computeEntryProposals: after "id =~ " (with trailing space) still offers nothing', () => {
  const text = 'id =~ ';
  const result = computeEntryProposals(text, text.length, schema);
  assert.equal(result.positionKind, 'after-matches');
  assert.deepEqual(result.proposals, []);
});

// ---------------------------------------------------------------------------------
// 7. After a complete "field =~ value" -> AND / OR.
// ---------------------------------------------------------------------------------

test('computeEntryProposals: after a complete "id =~ 5 " offers AND and OR', () => {
  const text = 'id =~ 5 ';
  const result = computeEntryProposals(text, text.length, schema);
  assert.equal(result.positionKind, 'after-value');
  assert.deepEqual(texts(result.proposals).sort(), ['AND ', 'OR ']);
});

// ---------------------------------------------------------------------------------
// 8. A bare, just-completed entry-type-looking token (e.g. "BS ") is grammatically
//    ambiguous (could still become a field name via "=~", or be a complete pattern) --
//    offers "=~ ", AND, OR (matches the generic base class, not eventlog-specific).
// ---------------------------------------------------------------------------------

test('computeEntryProposals: after "BS " (bare literal, no operator yet) offers "=~ ", AND, and OR', () => {
  const text = 'BS ';
  const result = computeEntryProposals(text, text.length, schema);
  assert.equal(result.positionKind, 'after-value');
  assert.deepEqual(texts(result.proposals).sort(), ['=~ ', 'AND ', 'OR ']);
});

// ---------------------------------------------------------------------------------
// 9. Partial-word prefix filtering: typing "B" mid-word narrows down to codes
//    starting with "B" (case-insensitive), excludes anything not matching, and
//    computes the correct replaceStart/replaceEnd for the partial token.
// ---------------------------------------------------------------------------------

test('computeEntryProposals: typing "B" narrows entry-type-code proposals to those starting with "B"', () => {
  const text = 'B';
  const result = computeEntryProposals(text, text.length, schema);
  assert.equal(result.positionKind, 'expr-start');
  assert.equal(result.replaceStart, 0);
  assert.equal(result.replaceEnd, 1);
  assert.deepEqual(texts(result.proposals).sort(), ['BS ', 'BU ']);
});

test('computeEntryProposals: prefix filtering is case-insensitive', () => {
  const text = 'bs';
  const result = computeEntryProposals(text, text.length, schema);
  assert.ok(texts(result.proposals).includes('BS '));
});

test('computeEntryProposals: a proposal textually identical to what\'s already typed is excluded (content.length !== prefix.length guard)', () => {
  // "AND" alone (no trailing space yet) as the very first token: the only candidate
  // matching the "AND" prefix among AND/OR/NOT-shaped keywords is "AND " itself
  // (length 4) which differs from the 3-char prefix, so it stays; but nothing of
  // length exactly 3 should ever appear alongside it.
  const text = 'AND';
  const result = computeEntryProposals(text, text.length, schema);
  for (const p of result.proposals) assert.notEqual(p.text.length, text.length);
});

// ---------------------------------------------------------------------------------
// 10. Unknown / unrecognized "entry type" in scope -> no field names offered (map
//     lookup misses), but entry-type codes/NOT are still offered normally.
// ---------------------------------------------------------------------------------

test('computeEntryProposals: an unrecognized token in the "entry type" position yields no field names', () => {
  const text = 'bogus AND ';
  const result = computeEntryProposals(text, text.length, schema);
  assert.equal(result.positionKind, 'expr-start');
  assert.ok(!texts(result.proposals).includes('sd =~ '));
  assert.ok(texts(result.proposals).includes('BS ')); // entry-type codes still offered
});
