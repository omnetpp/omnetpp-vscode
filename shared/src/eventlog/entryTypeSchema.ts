/**
 * buildEntryTypeSchema() -- derives the `EntryTypeSchema` (entry-type code -> attribute
 * names) `entryProposals.ts`'s `computeEntryProposals()` needs, from the generated
 * `entries.ts` (never hand-duplicated -- each code's field list comes straight from
 * `createEntry(code).getAttributeNames()`).
 *
 * Deliberately its own file, separate from `entryProposals.ts`: that module is
 * imported directly into the Event Log Table's BROWSER bundle (see
 * `shared/package.json`'s `./entry-proposals` subpath and `esbuild.mjs`'s comment on
 * the Sequence Chart/Event Log Table webviews staying free of "the eventlog engine
 * barrel"), so it must never import `entries.ts` (part of that engine barrel, per
 * `shared/src/eventlog/index.ts`'s header) even indirectly. This file DOES import
 * `entries.ts` and is only ever called engine-side (`client/worker/src/engineSession.ts`,
 * answering the `elog/getEntryTypeSchema` RPC -- see `elogProtocol.ts`) -- the browser
 * receives the already-computed `EntryTypeSchema` as plain JSON over that RPC, the same
 * way it already receives `FilterHints` (`filterHints.ts`) and `ElogModule`
 * (`moduleTree.ts`).
 *
 * ENTRY_TYPE_CODES is the exact set (and order) `EventLogEntryProposalProvider.java`'s
 * static initializer enumerates (verified by reading the source, not guessed) -- the
 * "real" top-level eventlog line types a filter expression can name. `entries.ts`
 * generates many more classes than this (abstract bases, and the description/
 * reference/found/custom-* helper entries used for other porting purposes -- see that
 * file's own header) that Java's provider deliberately excludes; this list preserves
 * that exact curation rather than exposing every code `entries.ts`/`createEntry()`
 * knows about.
 */

import { createEntry } from './entries';
import type { EntryTypeSchema } from './elogProtocol';

export const ENTRY_TYPE_CODES = [
  'SB', // SimulationBeginEntry
  'SE', // SimulationEndEntry
  'BU', // BubbleEntry
  'CMB', // ComponentMethodBeginEntry
  'CME', // ComponentMethodEndEntry
  'MC', // ModuleCreatedEntry
  'MD', // ModuleDeletedEntry
  'GC', // GateCreatedEntry
  'GD', // GateDeletedEntry
  'CC', // ConnectionCreatedEntry
  'CD', // ConnectionDeletedEntry
  'CDC', // ConnectionDisplayStringChangedEntry
  'MDC', // ModuleDisplayStringChangedEntry
  'E', // EventEntry
  'CE', // CancelEventEntry
  'BS', // BeginSendEntry
  'ES', // EndSendEntry
  'SD', // SendDirectEntry
  'SH', // SendHopEntry
  'DM', // DeleteMessageEntry
  'EN', // EncapsulatePacketEntry
  'DE', // DecapsulatePacketEntry
] as const;

/** Builds the entry-type-code -> attribute-names schema `computeEntryProposals()` needs, deriving every attribute list from `entries.ts`'s generated classes (via `createEntry()`/`getAttributeNames()`) rather than hand-copying it -- see this file's header. */
export function buildEntryTypeSchema(): EntryTypeSchema {
  const schema: EntryTypeSchema = {};
  for (const code of ENTRY_TYPE_CODES) {
    const entry = createEntry(code);
    if (!entry) throw new Error(`buildEntryTypeSchema: entries.ts's createEntry() no longer recognizes code '${code}' (see ENTRY_TYPE_CODES's doc comment)`);
    schema[code] = entry.getAttributeNames();
  }
  return schema;
}
