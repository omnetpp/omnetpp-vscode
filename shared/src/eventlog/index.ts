// Public surface of the '@omnetpp/shared/eventlog' subpath (see shared/package.json
// "exports"). This is the foundation + parsing + event/chunk/dependency + manager
// layer of the OMNeT++ eventlog library port:
//   - phase E1: exact-precision simulation time, line tokenization, a TreeMap
//     replacement, and a buffered bidirectional file reader with change detection.
//   - phase E2: the entry parsing layer — the ~56 eventlog entry classes (generated
//     from resources/eventlog/eventlogentries.txt by scripts/gen-eventlog-entries.mjs)
//     plus their hand-written base classes and factory dispatch.
//   - phase E3: the Event object model (EventBase/Event), the Index/Snapshot chunk
//     types, the bounded per-category entry cache, message dependencies, and the
//     IEventLog/IEventLogContext interfaces E4's EventLog manager implements.
//   - phase E4: the EventLog manager itself -- EventLogBase/EventLogIndex (the
//     cached/binary/linear offset-search engine, eventLogIndex.ts) and the concrete
//     EventLog class (parsing/caching/parse-policy/synchronize, eventLog.ts).
//   - phase E6: the two facades the UI consumes -- EventLogFacade (base),
//     SequenceChartFacade (timeline coordinate systems, facade.ts/sequenceChartFacade.ts)
//     and EventLogTableFacade (virtual-table row enumeration, eventLogTableFacade.ts) --
//     plus moduleTree.ts's buildModuleTree(), a pure module-hierarchy DTO builder.
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

export {
  type IChunk,
  type IEvent,
  type IMessageDependency,
  type IEventLog,
  type IEventLogContext,
  type ProgressCallback,
  type ReadToEventLineResult,
  isIEvent,
} from './ieventlog';
export { EventBase, Event } from './event';
export { Index, Snapshot } from './chunks';
export { EventLogEntryCache } from './eventLogEntryCache';
export { MessageDependencyBase, MessageSendDependency, MessageReuseDependency, FilteredMessageDependency } from './messageDependency';

export { EventLogBase, EventLogIndex } from './eventLogIndex';
export { EventLog, type EventLogOptions } from './eventLog';

// phase E5: match infra (ported from C++, no Java source -- see shared/src/match/'s
// file headers) + the filtered view (cause/consequence tracing, module/message/event
// filters). Re-exported here too (alongside the dedicated '@omnetpp/shared/match'
// subpath) since FilteredEventLog's filter setters take `Matchable`-driven match
// expressions directly.
export { PatternMatcher } from '../match/patternMatcher';
export { MatchExpression, MatchableString, MatchableStringMap, type Matchable } from '../match/matchExpression';
export { FilteredEventLog } from './filteredEventLog';
export { FilteredEvent } from './filteredEvent';

// phase E6: the two facades the UI consumes (timeline coordinate systems for the
// Sequence Chart, virtual-table row enumeration for the Event Log table) plus the
// module-tree DTO builder.
export { EventLogFacade } from './facade';
export { SequenceChartFacade } from './sequenceChartFacade';
export { EventLogTableFacade } from './eventLogTableFacade';
export { buildModuleTree, type ElogModule } from './moduleTree';

// phase U1: the host<->webview UI envelope (see uiProtocol.ts's file header).
// Type-only, so re-exporting it here has no bearing on the barrel's runtime
// footprint -- browser bundles should still prefer the dedicated
// '@omnetpp/shared/ui-protocol' subpath (see shared/package.json) to keep the
// import intent explicit, the same way './elog-protocol' is preferred over
// this barrel for elogProtocol.ts.
export type {
  EventLogSelection,
  EventLogUiSettings,
  HostToWebviewMessage,
  RevealTarget,
  WebviewToHostMessage,
} from './uiProtocol';

import type { IChunk } from './ieventlog';
import { parseEventLogEntry } from './eventLogEntry';
import { createEntry } from './entries';

/**
 * Convenience wiring of `parseEventLogEntry()` (hand-written, in eventLogEntry.ts)
 * to the generated `createEntry()` factory (entries.ts) — see eventLogEntry.ts's
 * file header for why the two aren't combined directly (it would create a circular
 * module dependency between the hand-written base classes and the generated file
 * that extends them).
 */
export function parseEventLogLine(chunk: IChunk | null, entryIndex: number, offset: number, line: string) {
  return parseEventLogEntry(createEntry, chunk, entryIndex, offset, line);
}
