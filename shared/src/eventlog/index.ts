// Public surface of the '@omnetpp/shared/eventlog' subpath (see shared/package.json
// "exports"). This is the foundation + parsing layer of the OMNeT++ eventlog
// library port:
//   - phase E1: exact-precision simulation time, line tokenization, a TreeMap
//     replacement, and a buffered bidirectional file reader with change detection.
//   - phase E2: the entry parsing layer — the ~56 eventlog entry classes (generated
//     from resources/eventlog/eventlogentries.txt by scripts/gen-eventlog-entries.mjs)
//     plus their hand-written base classes and factory dispatch.
// Host-agnostic: no vscode or Node imports (the RandomAccessFile it reads through
// is injected by the caller — see shared/src/fs/randomAccess.ts and
// shared/src/node/nodeRandomAccessFile.ts for the Node-backed implementation).

export { BigDecimal, type BigDecimalSpecial } from './bigDecimal';
export { LineTokenizer, tokenizeLine } from './lineTokenizer';
export { SortedMap, type Comparator, type SortedMapEntry } from './sortedMap';
export { MatchKind, TimelineMode, EventLogTableFilterMode, EventNumberKind, FileChange } from './enums';
export { FileReader, FileChangedError, type Line } from './fileReader';

export { EventLogEntry, EventLogMessageEntry, EventLogTokenBasedEntry, type EntryFactory, parseEventLogEntry } from './eventLogEntry';
export * from './entries';

import { parseEventLogEntry } from './eventLogEntry';
import { createEntry } from './entries';

/**
 * Convenience wiring of `parseEventLogEntry()` (hand-written, in eventLogEntry.ts)
 * to the generated `createEntry()` factory (entries.ts) — see eventLogEntry.ts's
 * file header for why the two aren't combined directly (it would create a circular
 * module dependency between the hand-written base classes and the generated file
 * that extends them).
 */
export function parseEventLogLine(chunk: unknown, entryIndex: number, offset: number, line: string) {
  return parseEventLogEntry(createEntry, chunk, entryIndex, offset, line);
}
