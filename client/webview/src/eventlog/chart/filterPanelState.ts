/**
 * filterPanelState.ts (PURE) -- the Filter panel's UI state and the pure functions
 * that turn it into a wire `FilterParams` (or back-fill it from a context-menu
 * shortcut). Ported (intent) from `FilterEventLogDialog.java`'s field set + its
 * reflection-driven `parseFilterParameters()`/`unparseFilterParameters()` (verified by
 * reading the source): Java keeps ALL widget values (`Text`/`CheckboxTableViewer`/...)
 * live regardless of whether their owning checkbox-tree leaf is currently checked --
 * unchecking a section is non-destructive, the values just stop contributing to the
 * built `EventLogFilterParameters`/filter-description text. This state mirrors that:
 * one boolean per section (`FilterSectionFlags`) plus every field's value, independent
 * of each other.
 *
 * SCOPE decisions vs. `FilterEventLogDialog.java`'s 6-section/14-leaf tree (see the U7
 * phase report for the full rationale, summarized here):
 *  - "Range filter by simulation time" (Java's `enableSimulationTimeRangeFilter`) is
 *    now PORTED (`rangeSimulationTime`, alongside the event-number range leaf
 *    `rangeEventNumbers`) -- see `FilterParams.lowerSimulationTimeLimit`/
 *    `upperSimulationTimeLimit` and `filteredEventLog.ts`'s
 *    `resolveConsideredEventNumberRange()` for the engine-side combination. (Earlier
 *    phases DROPPED this for lack of engine support; that gap is closed.)
 *  - Java's "by name" (a `ModuleTreeViewer` producing module IDs) and "by ID" (a flat
 *    `CheckboxTableViewer`, ALSO producing module IDs -- same underlying selection,
 *    just two input widgets over the same module list) are MERGED into ONE section,
 *    `moduleTree`, backed by the module checkbox tree the phase brief asks for
 *    (tri-state parents) -- `FilterParams.moduleIds` is a single flat array either way,
 *    so nothing is lost: any module selectable via Java's flat "by ID" list is equally
 *    selectable by ticking it in the tree.
 *  - `moduleClassName` (`FilterParams.moduleClassNames`) has NO Java dialog
 *    counterpart at all (`FilteredEventLog`/its C++ ancestor support it; Java's own
 *    dialog just never exposed a widget for it) -- this port ADDS a section for it
 *    (full `FilterParams` coverage, matching the phase brief's "full FilterParams
 *    coverage" goal), by direct analogy with message's own "by class name" section.
 *  - Java's four ID-list widgets (event numbers excluded, message ID/tree ID/
 *    encapsulation ID/encapsulation tree ID) are `EditableCheckboxList`s (add/edit/
 *    remove rows, each independently checkable). This port uses plain comma-separated
 *    number-list text inputs instead (phase brief: "comma-separated id lists") --
 *    strictly simpler (no per-row enable flag; a whole field is either in the list or
 *    not), which loses only the Java-specific "keep a row around but temporarily
 *    un-tick it" behavior, not any filtering capability.
 */

import type { FilterParams } from '@omnetpp/shared/elog-protocol';

/** One boolean per checkbox-tree leaf (`FilterEventLogDialog.java`'s `FilterDialogTreeNode`s) -- see this file's header for the two leaves merged/added relative to Java's own 14. */
export interface FilterSectionFlags {
  collectionLimits: boolean;
  rangeEventNumbers: boolean;
  rangeSimulationTime: boolean;
  excludedEventNumbers: boolean;
  moduleExpression: boolean;
  moduleNedType: boolean;
  moduleTree: boolean;
  moduleClassName: boolean;
  messageExpression: boolean;
  messageClassName: boolean;
  messageName: boolean;
  messageId: boolean;
  messageTreeId: boolean;
  messageEncapsulationId: boolean;
  messageEncapsulationTreeId: boolean;
  trace: boolean;
}

/** Section leaves in the panel's left-hand tree, in `FilterEventLogDialog.java`'s own top-to-bottom order (`createDialogArea()`'s `treeRoot.addChild(...)` sequence) -- drives both the panel's rendering order and `isAnyFilterActive()`'s iteration. */
export const FILTER_SECTION_ORDER: (keyof FilterSectionFlags)[] = [
  'collectionLimits',
  'rangeEventNumbers',
  'rangeSimulationTime',
  'excludedEventNumbers',
  'moduleExpression',
  'moduleNedType',
  'moduleTree',
  'moduleClassName',
  'messageExpression',
  'messageClassName',
  'messageName',
  'messageId',
  'messageTreeId',
  'messageEncapsulationId',
  'messageEncapsulationTreeId',
  'trace',
];

export const DEFAULT_SECTION_FLAGS: FilterSectionFlags = {
  collectionLimits: false,
  rangeEventNumbers: false,
  rangeSimulationTime: false,
  excludedEventNumbers: false,
  moduleExpression: false,
  moduleNedType: false,
  moduleTree: false,
  moduleClassName: false,
  messageExpression: false,
  messageClassName: false,
  messageName: false,
  messageId: false,
  messageTreeId: false,
  messageEncapsulationId: false,
  messageEncapsulationTreeId: false,
  trace: false,
};

/**
 * The full panel state: every field's value, independent of its section's enabled
 * flag (Java: "unchecking a section is non-destructive" -- see this file's header).
 * Defaults for the trace/collection-limit numeric fields match
 * `EventLogFilterParameters.java`'s own field initializers (verified: `maximumNumberOfMessageDependencies=5`,
 * `maximumDepthOfMessageDependencies=15`, `maximumMessageDependencyCollectionTime=100`,
 * `traceCauses/traceConsequences/traceMessageReuses/traceSelfMessages=true`) -- which
 * in turn match `FilteredEventLog.ts`'s own engine-side defaults exactly.
 */
export interface FilterPanelState {
  enabled: FilterSectionFlags;

  // collection limits (Java: ONE shared depth/number/time triple applied to BOTH the
  // cause and consequence side -- `FilterParams` exposes them separately per-direction,
  // but Java's dialog never exposed that asymmetry, so this port doesn't either; see
  // `buildFilterParams()`'s own comment at the call site).
  collectMessageReuses: boolean;
  maximumDepth: number;
  maximumNumber: number;
  maximumCollectionTimeMs: number;

  // range filter: event numbers
  firstConsideredEventNumber: number | null;
  lastConsideredEventNumber: number | null;

  // range filter: simulation time (decimal strings, per elogProtocol.ts's wire
  // convention -- this panel never parses them, just forwards the trimmed text; the
  // worker-side engine parses via `BigDecimal.parse()`). `''` == unset, mirroring
  // `firstConsideredEventNumber`/`lastConsideredEventNumber`'s `null` == unset (a plain
  // string field can't use `null` as cleanly as a text-input value, so empty string is
  // this field's "unset" sentinel instead).
  lowerSimulationTimeLimit: string;
  upperSimulationTimeLimit: string;

  // event filter
  excludedEventNumbers: number[];

  // module filter
  moduleExpression: string;
  moduleNedTypeNames: string[];
  moduleIds: number[];
  moduleClassNames: string[];

  // message filter
  messageExpression: string;
  messageClassNames: string[];
  messageNames: string[];
  messageIds: number[];
  messageTreeIds: number[];
  messageEncapsulationIds: number[];
  messageEncapsulationTreeIds: number[];

  // trace (cause/consequence) filter
  tracedEventNumber: number | null;
  traceCauses: boolean;
  traceConsequences: boolean;
  traceMessageReuses: boolean;
  traceSelfMessages: boolean;
  // trace filter delta limits -- bound the OVERALL considered window by distance from
  // `tracedEventNumber` (see `FilterParams`'s doc comment for how these combine with
  // the range-filter bounds above). `null`/`''` == unbounded on that dimension.
  causeEventNumberDelta: number | null;
  consequenceEventNumberDelta: number | null;
  causeSimulationTimeDelta: string;
  consequenceSimulationTimeDelta: string;
}

export const DEFAULT_FILTER_PANEL_STATE: FilterPanelState = {
  enabled: DEFAULT_SECTION_FLAGS,
  collectMessageReuses: true,
  maximumDepth: 15,
  maximumNumber: 5,
  maximumCollectionTimeMs: 100,
  firstConsideredEventNumber: null,
  lastConsideredEventNumber: null,
  lowerSimulationTimeLimit: '',
  upperSimulationTimeLimit: '',
  excludedEventNumbers: [],
  moduleExpression: '',
  moduleNedTypeNames: [],
  moduleIds: [],
  moduleClassNames: [],
  messageExpression: '',
  messageClassNames: [],
  messageNames: [],
  messageIds: [],
  messageTreeIds: [],
  messageEncapsulationIds: [],
  messageEncapsulationTreeIds: [],
  tracedEventNumber: null,
  traceCauses: true,
  traceConsequences: true,
  traceMessageReuses: true,
  traceSelfMessages: true,
  // Java's dialog pre-fills the two event-number deltas to 1000 (`EventLogFilterParameters
  // .causeEventNumberDelta`/`consequenceEventNumberDelta` field initializers); the
  // simulation-time deltas have no such default (`null` there, `''` == unset here).
  causeEventNumberDelta: 1000,
  consequenceEventNumberDelta: 1000,
  causeSimulationTimeDelta: '',
  consequenceSimulationTimeDelta: '',
};

/** Merges a (possibly partial/older/newer -- e.g. from a persisted `workspaceState` blob) object over the defaults, so a round trip through `JSON.stringify`/persistence always yields a fully-populated, type-safe state. `enabled` is merged one level deep (a persisted blob missing a newly-added flag defaults that one flag to `false`, not the whole object). */
export function mergeFilterPanelState(partial?: Partial<FilterPanelState> | null): FilterPanelState {
  if (!partial) return DEFAULT_FILTER_PANEL_STATE;
  return {
    ...DEFAULT_FILTER_PANEL_STATE,
    ...partial,
    enabled: { ...DEFAULT_SECTION_FLAGS, ...partial.enabled },
  };
}

/** `true` iff at least one section is enabled -- an all-disabled panel means "no filter at all" (`buildFilterParams()` returns `null` for this case, reverting to the unfiltered raw log rather than installing a no-op `FilteredEventLog`). */
export function isAnyFilterActive(state: FilterPanelState): boolean {
  return FILTER_SECTION_ORDER.some((key) => state.enabled[key]);
}

/**
 * Builds the wire `FilterParams` from the panel state, applying Java's own
 * "downstream gating" (`EventLogFilterParameters`'s getters, e.g.
 * `getExcludedEventNumbers()`/`getModuleIds()`/`isAnyModuleFilterEnabled()`, verified
 * by reading the source): a disabled section's fields are simply OMITTED from the
 * built object (never sent), regardless of what the panel's widgets currently hold --
 * so re-enabling a section later picks its old values right back up without the user
 * having to retype them (this is exactly `state`'s own "non-destructive uncheck"
 * design, see this file's header). Returns `null` (not an all-defaults object) when
 * NO section is enabled at all -- `elog/setFilter(null)` fully reverts to the raw
 * unfiltered log, cheaper than installing a `FilteredEventLog` with every dimension
 * disabled for no filtering benefit.
 */
export function buildFilterParams(state: FilterPanelState): FilterParams | null {
  if (!isAnyFilterActive(state)) return null;
  const params: FilterParams = {};
  const { enabled } = state;

  if (enabled.collectionLimits) {
    // Java's dialog exposes ONE depth/number/time triple, applied identically to both
    // the cause and consequence side -- see this file's `FilterPanelState.maximumDepth`
    // doc comment for why this port keeps that same (simpler, less capable than the
    // engine allows) shape rather than exposing 6 separate fields.
    params.collectMessageReuses = state.collectMessageReuses;
    params.maximumCauseDepth = state.maximumDepth;
    params.maximumConsequenceDepth = state.maximumDepth;
    params.maximumNumberOfCauses = state.maximumNumber;
    params.maximumNumberOfConsequences = state.maximumNumber;
    params.maximumCauseCollectionTime = state.maximumCollectionTimeMs;
    params.maximumConsequenceCollectionTime = state.maximumCollectionTimeMs;
  }

  if (enabled.rangeEventNumbers) {
    if (state.firstConsideredEventNumber !== null) params.firstConsideredEventNumber = state.firstConsideredEventNumber;
    if (state.lastConsideredEventNumber !== null) params.lastConsideredEventNumber = state.lastConsideredEventNumber;
  }

  if (enabled.rangeSimulationTime) {
    if (state.lowerSimulationTimeLimit.trim().length > 0) params.lowerSimulationTimeLimit = state.lowerSimulationTimeLimit.trim();
    if (state.upperSimulationTimeLimit.trim().length > 0) params.upperSimulationTimeLimit = state.upperSimulationTimeLimit.trim();
  }

  if (enabled.excludedEventNumbers) params.excludedEventNumbers = state.excludedEventNumbers;

  const moduleFilterEnabled = enabled.moduleExpression || enabled.moduleNedType || enabled.moduleTree || enabled.moduleClassName;
  if (moduleFilterEnabled) {
    params.enableModuleFilter = true;
    if (enabled.moduleExpression && state.moduleExpression.length > 0) params.moduleExpression = state.moduleExpression;
    if (enabled.moduleNedType) params.moduleNedTypeNames = state.moduleNedTypeNames;
    if (enabled.moduleTree) params.moduleIds = state.moduleIds;
    if (enabled.moduleClassName) params.moduleClassNames = state.moduleClassNames;
  }

  const messageFilterEnabled = enabled.messageExpression || enabled.messageClassName || enabled.messageName || enabled.messageId || enabled.messageTreeId || enabled.messageEncapsulationId || enabled.messageEncapsulationTreeId;
  if (messageFilterEnabled) {
    params.enableMessageFilter = true;
    if (enabled.messageExpression && state.messageExpression.length > 0) params.messageExpression = state.messageExpression;
    if (enabled.messageClassName) params.messageClassNames = state.messageClassNames;
    if (enabled.messageName) params.messageNames = state.messageNames;
    if (enabled.messageId) params.messageIds = state.messageIds;
    if (enabled.messageTreeId) params.messageTreeIds = state.messageTreeIds;
    if (enabled.messageEncapsulationId) params.messageEncapsulationIds = state.messageEncapsulationIds;
    if (enabled.messageEncapsulationTreeId) params.messageEncapsulationTreeIds = state.messageEncapsulationTreeIds;
  }

  if (enabled.trace && state.tracedEventNumber !== null) {
    params.tracedEventNumber = state.tracedEventNumber;
    params.traceCauses = state.traceCauses;
    params.traceConsequences = state.traceConsequences;
    params.traceMessageReuses = state.traceMessageReuses;
    params.traceSelfMessages = state.traceSelfMessages;
    if (state.causeEventNumberDelta !== null) params.causeEventNumberDelta = state.causeEventNumberDelta;
    if (state.consequenceEventNumberDelta !== null) params.consequenceEventNumberDelta = state.consequenceEventNumberDelta;
    if (state.causeSimulationTimeDelta.trim().length > 0) params.causeSimulationTimeDelta = state.causeSimulationTimeDelta.trim();
    if (state.consequenceSimulationTimeDelta.trim().length > 0) params.consequenceSimulationTimeDelta = state.consequenceSimulationTimeDelta.trim();
  }

  // A section can be "enabled" per `isAnyFilterActive()` yet contribute NOTHING to the
  // built object (e.g. "trace" ticked with no traced event number typed yet, or a
  // module/message OR-group ticked with every sub-checkbox still empty) -- treat that
  // the same as "no filter at all" rather than sending an all-defaults `FilterParams`
  // that would install a `FilteredEventLog` filtering out nothing (and misleadingly
  // flip the status strip's Filtered badge on for zero actual effect).
  return Object.keys(params).length > 0 ? params : null;
}

/** Deduplicates while preserving first-seen order (`[...new Set(...)]`, ascending-sort not required -- matches how `excludedEventNumbers` is otherwise treated as an unordered set everywhere else in this port). */
function dedupe(numbers: number[]): number[] {
  return [...new Set(numbers)];
}

/**
 * Del-exclude (port of `SequenceChart.java`'s `SWT.DEL` handler, `~line 5736`, verified
 * by reading the source): merges `eventNumbers` (the current chart selection) into
 * whichever `excludedEventNumbers` the CURRENTLY-APPLIED filter already has (Java
 * mutates the live `EventLogFilterParameters.excludedEventNumbers` array in place,
 * appending only genuinely-new numbers), preserving every other field of `current`
 * unchanged. `current === null` (no filter active yet) starts a fresh range-only
 * filter with just the exclusion list, matching the task brief ("creating a
 * range-only filter if none active"). Numbers already excluded are silently skipped
 * (Java: the `outer:` continue loop) rather than re-added.
 */
export function mergeExcludedEventNumbers(current: FilterParams | null, eventNumbers: number[]): FilterParams {
  const existing = current?.excludedEventNumbers ?? [];
  const merged = dedupe([...existing, ...eventNumbers]);
  return { ...(current ?? {}), excludedEventNumbers: merged };
}

/**
 * Applies a Del-exclude merge to the PANEL state too (so re-opening the panel shows
 * the just-excluded event numbers and the "Event filter" section reads as enabled) --
 * a convenience the engine-level `mergeExcludedEventNumbers()` above has no reason to
 * know about (it only has to produce the right wire `FilterParams`).
 */
export function applyExcludedEventNumbersToState(state: FilterPanelState, eventNumbers: number[]): FilterPanelState {
  return {
    ...state,
    enabled: { ...state.enabled, excludedEventNumbers: true },
    excludedEventNumbers: dedupe([...state.excludedEventNumbers, ...eventNumbers]),
  };
}

/**
 * "Filter Causes/Consequences..." (chart context menu, per-event section) -- port of
 * `SequenceChartContributor.createFilterEventCausesConsequencesAction()` (verified by
 * reading the source): enables the trace section for `eventNumber`, tracing BOTH
 * directions. Every other field/section is left exactly as the panel already had it
 * (Java reuses the SAME live `EventLogFilterParameters` the dialog already holds --
 * this is the direct analogue).
 */
export function prefillCauseConsequenceFilter(state: FilterPanelState, eventNumber: number): FilterPanelState {
  return {
    ...state,
    enabled: { ...state.enabled, trace: true },
    tracedEventNumber: eventNumber,
    traceCauses: true,
    traceConsequences: true,
  };
}

/**
 * "Filter Message..." (chart context menu, per-dependency section) -- port of
 * `SequenceChartContributor.createFilterMessageAction()`'s INTENT (verified by reading
 * the source), simplified per the U7 phase brief ("prefilled with message ids
 * {messageId}"): Java matches/stores by `messageEncapsulationTreeId` (a small
 * documented inconsistency in the Java source itself -- it CHECKS existing entries
 * against `getMessageEncapsulationId()` but STORES `getMessageEncapsulationTreeId()`)
 * plus a ±1000-event-number window around the causing event, clamped to
 * `[0, lastEventNumber]` (Java: `Math.max(0, eventNumber - 1000)` /
 * `Math.min(lastEventNumber, eventNumber + 1000)`). This port uses the dependency's
 * plain `messageId` instead (simpler, no encapsulation-tree-id concept needs
 * surfacing through `RenderDependency`), keeping the same "narrow range + one message
 * id" shape.
 */
export function prefillMessageFilter(state: FilterPanelState, messageId: number, aroundEventNumber: number, lastEventNumber: number): FilterPanelState {
  return {
    ...state,
    enabled: { ...state.enabled, messageId: true, rangeEventNumbers: true },
    messageIds: dedupe([...state.messageIds, messageId]),
    firstConsideredEventNumber: Math.max(0, aroundEventNumber - 1000),
    lastConsideredEventNumber: Math.min(lastEventNumber, aroundEventNumber + 1000),
  };
}
