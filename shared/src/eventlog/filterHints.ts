/**
 * buildFilterHints() -- the autocompletion data source for the U7 filter panel's
 * message-name/message-class-name/module-name/module-class-name/module-NED-type-name
 * pickers (`elogProtocol.ts`'s `FilterHints`, `elog/getFilterHints`). Ported intent
 * (not literal code -- there is no single Java method this mirrors) from
 * `FilterEventLogDialog.java`'s per-section population code (verified by reading the
 * source):
 *  - `createMessageFilterTreeNode()` populates its "by class name"/"by name" checkbox
 *    tables straight from `eventLog.getMessageClassNames()`/`getMessageNames()`
 *    (dictionary-sorted) -- "Message classes/names encountered so far" labels confirm
 *    this is a live, not-necessarily-complete snapshot of whatever has been parsed.
 *  - `createModuleFilterTreeNode()` populates its "by NED type" table by walking
 *    `eventLog.getEventLogEntryCache().getModuleDescriptionEntries()` and collecting
 *    the distinct `getNedTypeName()`s (dictionary-sorted) -- this port additionally
 *    collects distinct module full names/class names from the same entries (module
 *    full name and module class name have no dedicated hint list in the Java dialog,
 *    since its "by name"/"by ID" sections use a live module TREE, not a flat name
 *    list -- see `moduleTree.ts`'s own header on why this port's "by name" UI is a
 *    tree already; these two extra lists are for the FREE-TEXT expression fields'
 *    autocompletion instead, which Java's `moduleFilterExpression`/
 *    `messageFilterExpression` content-assist (`ContentAssistCommandAdapter`,
 *    `EventLogEntryProposalProvider`) covers via a much richer attribute-name-aware
 *    mechanism this port does not attempt to fully replicate -- see this file's own
 *    "documented simplification" note below).
 *
 * DOCUMENTED SIMPLIFICATION vs Java: `moduleFilterExpression`/`messageFilterExpression`
 * get proposals from `EventLogEntryProposalProvider`, which completes `MatchExpression`
 * ATTRIBUTE NAMES against a prototype entry's schema (e.g. `className(`, `id(`, ...),
 * not just free-form value lists. Porting that proposal engine is out of scope for this
 * phase (it belongs with the rest of the NED expression/attribute-schema infrastructure,
 * not the eventlog UI) -- `FilterHints` instead offers plain value lists (module/message
 * names and class names) that the panel's simpler pattern/expression inputs can offer as
 * a flat proposal list, which covers the overwhelmingly common case (matching a specific
 * known name/class) while honestly not reproducing Java's full attribute-aware
 * expression assist.
 *
 * A pure, one-shot, re-callable snapshot (same "no incremental state to keep" design as
 * `moduleTree.ts`'s `buildModuleTree()` -- see that file's header) so a caller can just
 * call this again after more of the file has been parsed to pick up newly-seen names.
 */

import type { IEventLog } from './ieventlog';
import type { FilterHints } from './elogProtocol';

/** Default cap per hint list -- generous enough for real projects' module/message vocabularies while keeping the RPC payload small and the panel's dropdowns scrollable, not "infinite". */
const DEFAULT_HINT_CAP = 300;

function sortedCapped(values: Iterable<string>, cap: number): { list: string[]; truncated: boolean } {
  const sorted = [...new Set(values)].sort((a, b) => a.localeCompare(b));
  if (sorted.length > cap) return { list: sorted.slice(0, cap), truncated: true };
  return { list: sorted, truncated: false };
}

/** Builds `FilterHints` from `eventLog`'s currently-parsed state (see this file's header for how this differs from a full-file guarantee). `cap` bounds each individual list (default `DEFAULT_HINT_CAP`); `truncated` is set if ANY list needed capping. */
export function buildFilterHints(eventLog: IEventLog, cap = DEFAULT_HINT_CAP): FilterHints {
  const moduleDescriptionEntries = eventLog.getEventLogEntryCache().getModuleDescriptionEntries();
  const moduleNameValues: string[] = [];
  const moduleClassNameValues: string[] = [];
  const moduleNedTypeNameValues: string[] = [];
  for (const entry of moduleDescriptionEntries) {
    moduleNameValues.push(entry.fullName);
    moduleClassNameValues.push(entry.moduleClassName);
    moduleNedTypeNameValues.push(entry.nedTypeName);
  }

  const moduleNames = sortedCapped(moduleNameValues, cap);
  const moduleClassNames = sortedCapped(moduleClassNameValues, cap);
  const moduleNedTypeNames = sortedCapped(moduleNedTypeNameValues, cap);
  const messageNames = sortedCapped(eventLog.getMessageNames(), cap);
  const messageClassNames = sortedCapped(eventLog.getMessageClassNames(), cap);

  return {
    moduleNames: moduleNames.list,
    moduleClassNames: moduleClassNames.list,
    moduleNedTypeNames: moduleNedTypeNames.list,
    messageNames: messageNames.list,
    messageClassNames: messageClassNames.list,
    truncated: moduleNames.truncated || moduleClassNames.truncated || moduleNedTypeNames.truncated || messageNames.truncated || messageClassNames.truncated,
  };
}
