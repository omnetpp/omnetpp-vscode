/**
 * filterDescription.ts (PURE) -- the filter panel's live description text, port of
 * `EventLogFilterParameters.toString()` (`omnetpp-dev/ui/org.omnetpp.common/src/org/
 * omnetpp/common/eventlog/EventLogFilterParameters.java`, verified by reading the
 * source in full) operating on `FilterPanelState` instead of Java's reflection-parsed
 * `EventLogFilterParameters` (this port's `parseFilterParameters()`-equivalent is just
 * "the state already IS the parsed values", no reflection needed).
 *
 * Faithfully ported, INCLUDING two Java quirks/artifacts (kept deliberately, not
 * cleaned up, so the generated text matches Java's for the same inputs):
 *  - The event-number range and simulation-time range are two children of ONE "Range
 *    filter" tree node in Java, and `toString()` combines them into a SINGLE OR-group
 *    (`if (enableRangeFilter) { rangeFilters = []; if (enableEventNumberRangeFilter)
 *    ...; if (enableSimulationTimeRangeFilter) ...; filters.add(combineDesriptions("OR",
 *    rangeFilters)); }`) -- so e.g. both ranges enabled at once produce ONE
 *    parenthesized "(a) OR (b)" entry in the outer AND-list, not two separate entries.
 *    This port has no single parent flag for the pair (`rangeEventNumbers`/
 *    `rangeSimulationTime` are independent leaves, see filterPanelState.ts's header),
 *    so it pushes the combined entry whenever EITHER leaf is enabled, mirroring the
 *    same net effect.
 *  - An enabled OR-group section (module/message) that ends up with zero populated
 *    sub-filters (e.g. "by NED type" is ticked but nothing is checked in the list)
 *    still contributes an EMPTY STRING to the outer AND-list (Java:
 *    `filters.add(combineDesriptions("OR", moduleFilters))` runs unconditionally
 *    inside `if (enableModuleFilter)`, with no `moduleFilters.size() > 0` guard).
 *  - The "Event filter" (excluded event numbers) section always contributes
 *    `"NOT " + <possibly-empty>`, never conditionally skipped, for the same reason.
 *  - The trace section's text mentions ONLY causes/consequences (`traceMessageReuses`/
 *    `traceSelfMessages` and all four cause/consequence delta limits are commented out
 *    in Java's own `toString()`, `EventLogFilterParameters.java:447-455` -- "should
 *    these included in the filter description?" -- so this port leaves them out too).
 *  - Collection limits NEVER appear in the description text at all (Java's `toString()`
 *    has no `enableCollectionLimits` branch whatsoever).
 */

import type { FilterPanelState } from './filterPanelState';

type Combinable = string | number;

/** Port of `combineDesriptions()` (sic -- Java's own typo, not repeated here as a symbol name). Zero parts -> `zeroValue`; one part -> `nonZeroPrefix + part`; 2+ parts -> `nonZeroPrefix + "(p1) OPERATOR (p2) ..."`. */
function combine(operator: 'AND' | 'OR', parts: string[], zeroValue = '', nonZeroPrefix = ''): string {
  if (parts.length === 0) return zeroValue;
  if (parts.length === 1) return nonZeroPrefix + parts[0];
  return nonZeroPrefix + `(${parts.join(`) ${operator} (`)})`;
}

/** Port of `addMemberDescription()`'s pluralization rule: 0 elements -> `''` (caller decides whether to still push it, matching Java's per-call-site behavior -- see this file's header); 1 -> `"prefix = v"`; 2-3 -> `"prefix is in (v1, v2, v3)"`; 4+ -> first three + `", ..."`. */
function member(prefix: string, elements: Combinable[]): string {
  if (elements.length === 0) return '';
  if (elements.length === 1) return `${prefix} = ${elements[0]}`;
  if (elements.length <= 3) return `${prefix} is in (${elements.join(', ')})`;
  return `${prefix} is in (${elements.slice(0, 3).join(', ')}, ...)`;
}

/** Pushes `member(prefix, elements)` onto `into` ONLY if non-empty (the ordinary `addMemberDescription()` behavior, used for every OR-group sub-filter EXCEPT the two Java always pushes regardless -- see this file's header). */
function pushMember(into: string[], prefix: string, elements: Combinable[]): void {
  const text = member(prefix, elements);
  if (text.length > 0) into.push(text);
}

/** Resolves a module id to a display label for the description text -- `resolveModuleName` is typically `chartMain.ts`'s `findModuleNode(id, moduleTree)?.fullName`; falls back to `#<id>` if unresolved (module not yet parsed/known) or no resolver was supplied. */
export type ModuleNameResolver = (moduleId: number) => string | null | undefined;

/** Builds the live filter-description text from the panel's current state -- see this file's header for exact fidelity notes vs. `EventLogFilterParameters.toString()`. */
export function buildFilterDescription(state: FilterPanelState, resolveModuleName?: ModuleNameResolver): string {
  const { enabled } = state;
  const filters: string[] = [];

  // ---- range filter: event-number range + simulation-time range combine into ONE
  // OR-group (see this file's header) ----
  if (enabled.rangeEventNumbers || enabled.rangeSimulationTime) {
    const rangeFilters: string[] = [];
    if (enabled.rangeEventNumbers) {
      const first = state.firstConsideredEventNumber;
      const last = state.lastConsideredEventNumber;
      if (first !== null && last !== null) rangeFilters.push(`${first} <= event number <= ${last}`);
      else if (first !== null) rangeFilters.push(`event number >= ${first}`);
      else if (last !== null) rangeFilters.push(`event number <= ${last}`);
    }
    if (enabled.rangeSimulationTime) {
      const lower = state.lowerSimulationTimeLimit.trim();
      const upper = state.upperSimulationTimeLimit.trim();
      if (lower.length > 0 && upper.length > 0) rangeFilters.push(`${lower} <= simulation time of event <= ${upper}`);
      else if (lower.length > 0) rangeFilters.push(`simulation time of event >= ${lower}`);
      else if (upper.length > 0) rangeFilters.push(`simulation time of event <= ${upper}`);
    }
    filters.push(combine('OR', rangeFilters));
  }

  // ---- event filter (excluded event numbers) -- always "NOT ..." per Java's own artifact ----
  if (enabled.excludedEventNumbers) {
    const excludedFilters: string[] = [];
    pushMember(excludedFilters, 'event number', state.excludedEventNumbers);
    filters.push('NOT ' + combine('OR', excludedFilters));
  }

  // ---- module filter ----
  const moduleFilterEnabled = enabled.moduleExpression || enabled.moduleNedType || enabled.moduleTree || enabled.moduleClassName;
  if (moduleFilterEnabled) {
    const moduleFilters: string[] = [];
    if (enabled.moduleExpression && state.moduleExpression.length > 0) moduleFilters.push(`module matches the expression ${state.moduleExpression}`);
    if (enabled.moduleNedType) pushMember(moduleFilters, 'module NED type', state.moduleNedTypeNames);
    if (enabled.moduleTree) {
      // Java's own "by name" sub-section resolves tree-selected IDs to full paths for
      // the description (`root.findDescendantModule(id).getModuleFullPath()`); this
      // port's merged tree section does the same via `resolveModuleName`, falling back
      // to a raw `#<id>` token when unresolved -- see this file's header for why "by
      // name" and "by ID" are one section here.
      const names = state.moduleIds.map((id) => resolveModuleName?.(id) ?? `#${id}`);
      pushMember(moduleFilters, 'module', names);
    }
    if (enabled.moduleClassName) pushMember(moduleFilters, 'module class name', state.moduleClassNames);
    filters.push(combine('OR', moduleFilters));
  }

  // ---- message filter ----
  const messageFilterEnabled = enabled.messageExpression || enabled.messageClassName || enabled.messageName || enabled.messageId || enabled.messageTreeId || enabled.messageEncapsulationId || enabled.messageEncapsulationTreeId;
  if (messageFilterEnabled) {
    const messageFilters: string[] = [];
    if (enabled.messageExpression && state.messageExpression.length > 0) messageFilters.push(`message matches the expression ${state.messageExpression}`);
    if (enabled.messageClassName) pushMember(messageFilters, 'message C++ class name', state.messageClassNames);
    if (enabled.messageName) pushMember(messageFilters, 'message name', state.messageNames);
    if (enabled.messageId) pushMember(messageFilters, 'message ID', state.messageIds);
    if (enabled.messageTreeId) pushMember(messageFilters, 'message tree ID', state.messageTreeIds);
    if (enabled.messageEncapsulationId) pushMember(messageFilters, 'message encapsulation ID', state.messageEncapsulationIds);
    if (enabled.messageEncapsulationTreeId) pushMember(messageFilters, 'message encapsulation tree ID', state.messageEncapsulationTreeIds);
    filters.push(combine('OR', messageFilters));
  }

  // ---- trace (cause/consequence) filter ----
  if (enabled.trace) {
    const traceFilters: string[] = [];
    if (state.traceCauses) traceFilters.push('cause');
    if (state.traceConsequences) traceFilters.push('consequence');
    filters.push(`it is the ${traceFilters.join(' or ')} of the event with event number ${state.tracedEventNumber ?? ''}`);
  }

  return combine('AND', filters, 'Filter for all events', 'Filter for events where ');
}
