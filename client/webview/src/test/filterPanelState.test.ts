import { test } from 'bun:test';
import assert from 'node:assert';
import {
  applyExcludedEventNumbersToState,
  buildFilterParams,
  DEFAULT_FILTER_PANEL_STATE,
  isAnyFilterActive,
  mergeExcludedEventNumbers,
  mergeFilterPanelState,
  prefillCauseConsequenceFilter,
  prefillMessageFilter,
  type FilterPanelState,
} from '../eventlog/chart/filterPanelState';

function state(partial: Partial<FilterPanelState>): FilterPanelState {
  return { ...DEFAULT_FILTER_PANEL_STATE, ...partial, enabled: { ...DEFAULT_FILTER_PANEL_STATE.enabled, ...partial.enabled } };
}

// ---- isAnyFilterActive / buildFilterParams(null case) --------------------------------

test('isAnyFilterActive: false for the default (nothing enabled) state', () => {
  assert.equal(isAnyFilterActive(DEFAULT_FILTER_PANEL_STATE), false);
});

test('buildFilterParams: returns null when no section is enabled (reverts to unfiltered)', () => {
  assert.equal(buildFilterParams(DEFAULT_FILTER_PANEL_STATE), null);
});

// ---- disabled sections omitted from the built params (Java's "non-destructive uncheck") ----

test('buildFilterParams: a disabled section\'s values are NOT sent even though the state still holds them', () => {
  const s = state({ enabled: { rangeEventNumbers: false, trace: true }, firstConsideredEventNumber: 5, lastConsideredEventNumber: 10, tracedEventNumber: 7 });
  const params = buildFilterParams(s);
  assert.ok(params);
  assert.equal(params!.firstConsideredEventNumber, undefined);
  assert.equal(params!.lastConsideredEventNumber, undefined);
  assert.equal(params!.tracedEventNumber, 7);
});

test('buildFilterParams: range section populates only the bounds that are non-null', () => {
  const s = state({ enabled: { rangeEventNumbers: true }, firstConsideredEventNumber: 5, lastConsideredEventNumber: null });
  const params = buildFilterParams(s);
  assert.equal(params!.firstConsideredEventNumber, 5);
  assert.equal(params!.lastConsideredEventNumber, undefined);
});

test('buildFilterParams: excluded event numbers section', () => {
  const s = state({ enabled: { excludedEventNumbers: true }, excludedEventNumbers: [1, 2] });
  assert.deepEqual(buildFilterParams(s)!.excludedEventNumbers, [1, 2]);
});

test('buildFilterParams: collection limits apply ONE shared depth/number/time to both cause and consequence sides', () => {
  const s = state({ enabled: { collectionLimits: true }, collectMessageReuses: false, maximumDepth: 3, maximumNumber: 2, maximumCollectionTimeMs: 50 });
  const params = buildFilterParams(s)!;
  assert.equal(params.collectMessageReuses, false);
  assert.equal(params.maximumCauseDepth, 3);
  assert.equal(params.maximumConsequenceDepth, 3);
  assert.equal(params.maximumNumberOfCauses, 2);
  assert.equal(params.maximumNumberOfConsequences, 2);
  assert.equal(params.maximumCauseCollectionTime, 50);
  assert.equal(params.maximumConsequenceCollectionTime, 50);
});

test('buildFilterParams: module sub-sections are independently gated, but enableModuleFilter is set if ANY is enabled', () => {
  const s = state({ enabled: { moduleNedType: true }, moduleNedTypeNames: ['Fifo'], moduleExpression: 'x', moduleIds: [1], moduleClassNames: ['C'] });
  const params = buildFilterParams(s)!;
  assert.equal(params.enableModuleFilter, true);
  assert.deepEqual(params.moduleNedTypeNames, ['Fifo']);
  assert.equal(params.moduleExpression, undefined, 'moduleExpression section was disabled -- must not be sent even though a value was typed');
  assert.equal(params.moduleIds, undefined);
  assert.equal(params.moduleClassNames, undefined);
});

test('buildFilterParams: no module sub-section enabled -> enableModuleFilter is not sent at all', () => {
  const s = state({ enabled: { trace: true }, tracedEventNumber: 1 });
  const params = buildFilterParams(s)!;
  assert.equal(params.enableModuleFilter, undefined);
});

test('buildFilterParams: message sub-sections are independently gated, but enableMessageFilter is set if ANY is enabled', () => {
  const s = state({ enabled: { messageId: true }, messageIds: [9], messageNames: ['x'] });
  const params = buildFilterParams(s)!;
  assert.equal(params.enableMessageFilter, true);
  assert.deepEqual(params.messageIds, [9]);
  assert.equal(params.messageNames, undefined);
});

test('buildFilterParams: trace section requires a non-null tracedEventNumber even if enabled', () => {
  const s = state({ enabled: { trace: true }, tracedEventNumber: null });
  // trace contributes nothing (and nothing else is enabled either) -> null filter
  assert.equal(buildFilterParams(s), null);
});

// ---- section-enabled independence (persistence round trip) ---------------------------

test('mergeFilterPanelState: round-trips a partial (older/newer) blob over the defaults', () => {
  const partial = { enabled: { trace: true }, tracedEventNumber: 42 };
  const merged = mergeFilterPanelState(partial as Partial<FilterPanelState>);
  assert.equal(merged.enabled.trace, true);
  assert.equal(merged.enabled.rangeEventNumbers, false, 'unspecified flags fall back to their default (false), not left undefined');
  assert.equal(merged.tracedEventNumber, 42);
  assert.equal(merged.maximumDepth, DEFAULT_FILTER_PANEL_STATE.maximumDepth, 'unspecified value fields keep their default');
});

test('mergeFilterPanelState: null/undefined input returns the defaults object', () => {
  assert.deepEqual(mergeFilterPanelState(null), DEFAULT_FILTER_PANEL_STATE);
  assert.deepEqual(mergeFilterPanelState(undefined), DEFAULT_FILTER_PANEL_STATE);
});

test('section-enabled independence: a section can hold values while disabled, and re-enabling it does not lose them', () => {
  let s = state({ enabled: { rangeEventNumbers: true }, firstConsideredEventNumber: 5 });
  assert.equal(buildFilterParams(s)!.firstConsideredEventNumber, 5);
  s = { ...s, enabled: { ...s.enabled, rangeEventNumbers: false } }; // uncheck
  assert.equal(s.firstConsideredEventNumber, 5, 'value survives the uncheck');
  assert.equal(buildFilterParams(s), null, 'disabled -> not sent (and nothing else enabled)');
  s = { ...s, enabled: { ...s.enabled, rangeEventNumbers: true } }; // re-check
  assert.equal(buildFilterParams(s)!.firstConsideredEventNumber, 5, 'value is back without having to retype it');
});

// ---- Del-exclusion merge logic --------------------------------------------------------

test('mergeExcludedEventNumbers: starts a fresh range-only... exclusion-only filter when none is active', () => {
  const params = mergeExcludedEventNumbers(null, [3, 5]);
  assert.deepEqual(params.excludedEventNumbers, [3, 5]);
});

test('mergeExcludedEventNumbers: appends to an existing filter\'s excludedEventNumbers, deduplicated', () => {
  const current = { excludedEventNumbers: [1, 2], moduleExpression: 'x' };
  const params = mergeExcludedEventNumbers(current, [2, 3]);
  assert.deepEqual(params.excludedEventNumbers, [1, 2, 3]);
  assert.equal(params.moduleExpression, 'x', 'every other field of the current filter is preserved untouched');
});

test('mergeExcludedEventNumbers: does not mutate the input FilterParams object', () => {
  const current = { excludedEventNumbers: [1] };
  mergeExcludedEventNumbers(current, [2]);
  assert.deepEqual(current.excludedEventNumbers, [1]);
});

test('applyExcludedEventNumbersToState: enables the section and merges into the panel state too', () => {
  const s = applyExcludedEventNumbersToState(DEFAULT_FILTER_PANEL_STATE, [7, 8]);
  assert.equal(s.enabled.excludedEventNumbers, true);
  assert.deepEqual(s.excludedEventNumbers, [7, 8]);
  const s2 = applyExcludedEventNumbersToState(s, [8, 9]);
  assert.deepEqual(s2.excludedEventNumbers, [7, 8, 9]);
});

// ---- context-menu prefill shortcuts ----------------------------------------------------

test('prefillCauseConsequenceFilter: enables trace for the given event, both directions', () => {
  const s = prefillCauseConsequenceFilter(DEFAULT_FILTER_PANEL_STATE, 123);
  assert.equal(s.enabled.trace, true);
  assert.equal(s.tracedEventNumber, 123);
  assert.equal(s.traceCauses, true);
  assert.equal(s.traceConsequences, true);
});

test('prefillMessageFilter: enables messageId + a +-1000 event-number range clamped to [0, lastEventNumber]', () => {
  const s = prefillMessageFilter(DEFAULT_FILTER_PANEL_STATE, 55, 500, 10_000);
  assert.equal(s.enabled.messageId, true);
  assert.deepEqual(s.messageIds, [55]);
  assert.equal(s.enabled.rangeEventNumbers, true);
  assert.equal(s.firstConsideredEventNumber, 0);
  assert.equal(s.lastConsideredEventNumber, 1500);
});

test('prefillMessageFilter: clamps the upper bound to lastEventNumber near the end of the log', () => {
  const s = prefillMessageFilter(DEFAULT_FILTER_PANEL_STATE, 55, 9_900, 10_000);
  assert.equal(s.lastConsideredEventNumber, 10_000);
  assert.equal(s.firstConsideredEventNumber, 8_900);
});
