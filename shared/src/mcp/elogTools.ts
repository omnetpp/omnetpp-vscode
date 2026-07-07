// MCP tools letting AI agents query `.elog` files, independent of the NED/MSG/INI
// project index (shared/src/mcp/tools.ts): opens the eventlog engine (phases E1-E8,
// shared/src/eventlog/) directly against a file on disk. Same shape/conventions as
// tools.ts (ELOG_TOOLS + handleElogTool(name, args, ctx), no MCP-SDK dependency), so
// the standalone stdio server (mcp/src/server.ts) can advertise both tool sets side by
// side. Host-agnostic: file access goes through the injected RandomAccessFileProvider
// (shared/src/fs/randomAccess.ts), never Node APIs directly.
//
// Engine lifecycle: a small per-context LRU (MAX_OPEN_ENGINES, see below) of open
// `EventLog` engines keyed by resolved absolute path, each paired with the mtime it was
// opened at. A cache hit re-checks the file's current mtime (RandomAccessFile.getMtimeMs()
// -- a fresh stat, no extra open) and transparently reopens (closing the stale handle)
// if the file changed since. The engine is synchronous and runs in-process (unlike the
// worker-hosted engine phase E8 sets up for the UI's live Sequence Chart/Event Log
// views) -- an MCP query is a one-shot read, not a long-lived interactive session, so no
// worker/RPC layer is needed here.
//
// Engine options (see eventLog.ts's EventLogOptions): eventCacheLimit/offsetCacheLimit
// are set below MODEST_ENGINE_OPTIONS -- smaller than the UI's own defaults (50_000 /
// 1_000_000) -- because up to MAX_OPEN_ENGINES engines can be resident at once here, each
// serving isolated single-event/small-range queries rather than a scrolling table/chart
// viewport, so there is little reuse benefit to a large per-engine cache.

import type { RandomAccessFile, RandomAccessFileProvider } from '../fs/randomAccess';
import { BigDecimal } from '../eventlog/bigDecimal';
import { MatchKind } from '../eventlog/enums';
import { EventLog, type EventLogOptions } from '../eventlog/eventLog';
import { FileReader } from '../eventlog/fileReader';
import { FilteredEventLog } from '../eventlog/filteredEventLog';
import { EventLogMessageEntry, type EventLogEntry } from '../eventlog/eventLogEntry';
import { MessageDescriptionEntry } from '../eventlog/entries';
import { buildModuleTree, type ElogModule } from '../eventlog/moduleTree';
import type { IEvent } from '../eventlog/ieventlog';
import type { FilterParams } from '../eventlog/elogProtocol';

/** The capabilities an elog tool handler needs. Supplied by each adapter (mcp/src/server.ts for the standalone server). */
export interface ElogToolContext {
  fileProvider: RandomAccessFileProvider;
  /** Normalize a path or `file://` URI argument to an absolute filesystem path `fileProvider` can open. */
  resolvePath(file: string): string;
}

export interface ElogToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, any>, ctx: ElogToolContext): unknown;
}

// ---- engine cache (per ElogToolContext instance) --------------------------------

/** Max number of `.elog` engines kept open at once per `ElogToolContext` (LRU eviction). */
const MAX_OPEN_ENGINES = 4;

/** Conservative engine options for one-shot MCP queries -- see this file's header. */
const MODEST_ENGINE_OPTIONS: EventLogOptions = {
  eventCacheLimit: 5_000,
  offsetCacheLimit: 200_000,
};

interface EngineEntry {
  absPath: string;
  raf: RandomAccessFile;
  reader: FileReader;
  eventLog: EventLog;
  mtimeMs: number;
}

// Keyed by the ElogToolContext object itself (not exposed on the public interface,
// so a context's cache lives exactly as long as the context does) rather than a field
// on ElogToolContext -- keeps the interface a plain data shape for adapters to construct.
const engineCaches = new WeakMap<ElogToolContext, Map<string, EngineEntry>>();

function getEngineCache(ctx: ElogToolContext): Map<string, EngineEntry> {
  let cache = engineCaches.get(ctx);
  if (cache === undefined) {
    cache = new Map();
    engineCaches.set(ctx, cache);
  }
  return cache;
}

function openEngine(ctx: ElogToolContext, absPath: string): EngineEntry {
  let raf: RandomAccessFile;
  try {
    raf = ctx.fileProvider.openRandomAccess(absPath);
  } catch (e) {
    throw new Error(`cannot open elog file: ${absPath} (${e instanceof Error ? e.message : String(e)})`);
  }
  const reader = new FileReader(raf);
  const eventLog = new EventLog(reader, MODEST_ENGINE_OPTIONS);
  return { absPath, raf, reader, eventLog, mtimeMs: raf.getMtimeMs() };
}

/** Moves `absPath` to the most-recently-used end of `cache`'s iteration order (delete + re-set, same idiom as EventLog's own LRU -- see eventLog.ts's header). */
function touch(cache: Map<string, EngineEntry>, absPath: string, entry: EngineEntry): void {
  cache.delete(absPath);
  cache.set(absPath, entry);
}

/**
 * Returns the (possibly cached) engine for `file`, re-opening it if the file's mtime
 * changed since it was cached, and evicting the least-recently-used entry once the
 * cache would exceed MAX_OPEN_ENGINES.
 */
function getOrOpenEngine(ctx: ElogToolContext, file: string): EngineEntry {
  const absPath = ctx.resolvePath(file);
  const cache = getEngineCache(ctx);
  const existing = cache.get(absPath);
  if (existing !== undefined) {
    let currentMtime: number;
    try {
      currentMtime = existing.raf.getMtimeMs();
    } catch {
      currentMtime = NaN; // the file vanished -- fall through, reopening below will fail with a clear error
    }
    if (currentMtime === existing.mtimeMs) {
      touch(cache, absPath, existing);
      return existing;
    }
    existing.raf.close();
    cache.delete(absPath);
  }
  const entry = openEngine(ctx, absPath);
  cache.set(absPath, entry);
  if (cache.size > MAX_OPEN_ENGINES) {
    const oldestKey = cache.keys().next().value as string;
    cache.get(oldestKey)!.raf.close();
    cache.delete(oldestKey);
  }
  return entry;
}

// ---- argument helpers ------------------------------------------------------------

function requireString(args: Record<string, any>, name: string, toolName: string): string {
  const v = args[name];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${toolName}: "${name}" is required and must be a non-empty string`);
  return v;
}

function requireNumber(args: Record<string, any>, name: string, toolName: string): number {
  const v = args[name];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${toolName}: "${name}" is required and must be a number`);
  return v;
}

// ---- safe engine lookups -----------------------------------------------------------
//
// EventLogIndex's offset-search (getOffsetForEventNumber()/getOffsetForSimulationTime(),
// eventLogIndex.ts) has a documented precondition: querying strictly outside
// [getFirstEventNumber(), getLastEventNumber()] (or the simulation-time equivalent)
// throws rather than degrading gracefully to null -- this is a deliberate, tested
// engine behavior (see eventLogIndex.test.ts's "querying an event number beyond the
// last one throws" test), not a bug, since every *internal* caller already knows it is
// asking about a real, in-range neighbour. An MCP tool's `eventNumber`/`simtime` args
// are attacker^Wagent-supplied, though, so every lookup that might land outside the
// log's range goes through one of these wrappers, turning that precondition failure
// into an ordinary "not found" result instead of an uncaught exception.

function safeGetEventForEventNumber(eventLog: EventLog, eventNumber: number, matchKind?: MatchKind): IEvent | null {
  try {
    return eventLog.getEventForEventNumber(eventNumber, matchKind);
  } catch {
    return null;
  }
}

/**
 * Defaults to FIRST_OR_NEXT rather than the engine's own EXACT default: several events
 * can legitimately share one simulation time (a "duplicate-simulation-time run" --
 * common right after a zero-duration cascade of self-messages), and EXACT throws for
 * any such tie by design (see eventLogIndex.test.ts's "EXACT should throw for
 * duplicated" case) -- not useful behavior for an agent that just wants "the event(s)
 * at this time". FIRST_OR_NEXT resolves a tie deterministically (the first event of the
 * run) and degrades gracefully (the next event after `simulationTime`) when nothing
 * matches exactly, instead of throwing either way.
 */
function safeGetEventForSimulationTime(eventLog: EventLog, simulationTime: BigDecimal, matchKind: MatchKind = MatchKind.FIRST_OR_NEXT): IEvent | null {
  try {
    return eventLog.getEventForSimulationTime(simulationTime, matchKind);
  } catch {
    return null;
  }
}

// ---- serialization helpers --------------------------------------------------------

/** Best-effort name of the message an event is processing: scans the event's own entries for the MessageDescriptionEntry describing its `messageId` (the message may have been described in an earlier event -- e.g. when it was sent -- in which case this returns null; a UI-grade lookup would consult the shared EventLogEntryCache, but that cache is keyed by module/gate/connection/custom ids, not message ids, so no whole-log message-id index exists to query here). */
function findProcessedMessageName(event: IEvent): string | null {
  const messageId = event.getMessageId();
  if (messageId === -1) return null;
  for (let i = 0; i < event.getNumEventLogEntries(); i++) {
    const entry = event.getEventLogEntry(i);
    if (entry instanceof MessageDescriptionEntry && entry.messageId === messageId) return entry.messageName;
  }
  return null;
}

function summarizeEvent(event: IEvent) {
  return {
    eventNumber: event.getEventNumber(),
    simulationTime: event.getSimulationTime().toString(),
    moduleId: event.getModuleId(),
    moduleName: event.getModuleDescriptionEntry().fullName,
    messageName: findProcessedMessageName(event),
    numEntries: event.getNumEventLogEntries(),
  };
}

function serializeEntry(entry: EventLogEntry, index: number) {
  const fields: Record<string, string | null> = {};
  for (const name of entry.getAttributeNames()) fields[name] = entry.getAsString(name);
  return {
    index,
    code: entry.getAsString(),
    className: entry.getClassName(),
    level: entry.getLevel(),
    contextModuleId: entry.getContextModuleId(),
    fields,
    text: entry instanceof EventLogMessageEntry ? entry.getText() : null,
  };
}

/** Reads back the exact original line text at `offset` via the engine's own FileReader (not a reconstruction via EventLogEntry.print(), which round-trips fields but not necessarily byte-for-byte whitespace/quoting). */
function readRawLine(reader: FileReader, offset: number): string {
  reader.seekTo(offset);
  return reader.getNextLine()?.text ?? '';
}

const DEFAULT_MODULE_TREE_MAX_DEPTH = 20;
const DEFAULT_MODULE_TREE_MAX_NODES = 5000;

/** Copies `root`, capping depth and total node count; returns `truncated: true` if either cap was hit. */
function capModuleTree(root: ElogModule | null, maxDepth: number, maxNodes: number): { tree: ElogModule | null; truncated: boolean } {
  if (root === null) return { tree: null, truncated: false };
  let truncated = false;
  let count = 0;
  function copy(node: ElogModule, depth: number): ElogModule | null {
    if (count >= maxNodes) {
      truncated = true;
      return null;
    }
    count++;
    const children: ElogModule[] = [];
    if (depth >= maxDepth) {
      if (node.children.length > 0) truncated = true;
    } else {
      for (const child of node.children) {
        const copied = copy(child, depth + 1);
        if (copied !== null) children.push(copied);
        else {
          truncated = true;
          break;
        }
      }
    }
    return { moduleId: node.moduleId, fullName: node.fullName, nedTypeName: node.nedTypeName, moduleClassName: node.moduleClassName, compound: node.compound, children };
  }
  return { tree: copy(root, 0), truncated };
}

/** Applies a (partial) FilterParams DTO (elogProtocol.ts) to a fresh FilteredEventLog -- every field maps 1:1 to one FilteredEventLog setter; an omitted field leaves the engine's own default untouched. */
function applyFilterParams(f: FilteredEventLog, p: FilterParams): void {
  if (p.firstConsideredEventNumber !== undefined) f.setFirstConsideredEventNumber(p.firstConsideredEventNumber);
  if (p.lastConsideredEventNumber !== undefined) f.setLastConsideredEventNumber(p.lastConsideredEventNumber);
  if (p.excludedEventNumbers) f.setExcludedEventNumbers(p.excludedEventNumbers);
  if (p.collectMessageReuses !== undefined) f.setCollectMessageReuses(p.collectMessageReuses);

  if (p.enableModuleFilter !== undefined) f.setEnableModuleFilter(p.enableModuleFilter);
  if (p.moduleExpression !== undefined) f.setModuleExpression(p.moduleExpression);
  if (p.moduleNames) f.setModuleNames(p.moduleNames);
  if (p.moduleClassNames) f.setModuleClassNames(p.moduleClassNames);
  if (p.moduleNedTypeNames) f.setModuleNedTypeNames(p.moduleNedTypeNames);
  if (p.moduleIds) f.setModuleIds(p.moduleIds);

  if (p.enableMessageFilter !== undefined) f.setEnableMessageFilter(p.enableMessageFilter);
  if (p.messageExpression !== undefined) f.setMessageExpression(p.messageExpression);
  if (p.messageNames) f.setMessageNames(p.messageNames);
  if (p.messageClassNames) f.setMessageClassNames(p.messageClassNames);
  if (p.messageIds) f.setMessageIds(p.messageIds);
  if (p.messageTreeIds) f.setMessageTreeIds(p.messageTreeIds);
  if (p.messageEncapsulationIds) f.setMessageEncapsulationIds(p.messageEncapsulationIds);
  if (p.messageEncapsulationTreeIds) f.setMessageEncapsulationTreeIds(p.messageEncapsulationTreeIds);

  if (p.tracedEventNumber !== undefined) f.setTracedEventNumber(p.tracedEventNumber);
  if (p.traceCauses !== undefined) f.setTraceCauses(p.traceCauses);
  if (p.traceConsequences !== undefined) f.setTraceConsequences(p.traceConsequences);
  if (p.traceSelfMessages !== undefined) f.setTraceSelfMessages(p.traceSelfMessages);
  if (p.traceMessageReuses !== undefined) f.setTraceMessageReuses(p.traceMessageReuses);
  if (p.maximumCauseDepth !== undefined) f.setMaximumCauseDepth(p.maximumCauseDepth);
  if (p.maximumNumberOfCauses !== undefined) f.setMaximumNumberOfCauses(p.maximumNumberOfCauses);
  if (p.maximumCauseCollectionTime !== undefined) f.setMaximumCauseCollectionTime(p.maximumCauseCollectionTime);
  if (p.maximumConsequenceDepth !== undefined) f.setMaximumConsequenceDepth(p.maximumConsequenceDepth);
  if (p.maximumNumberOfConsequences !== undefined) f.setMaximumNumberOfConsequences(p.maximumNumberOfConsequences);
  if (p.maximumConsequenceCollectionTime !== undefined) f.setMaximumConsequenceCollectionTime(p.maximumConsequenceCollectionTime);
}

// ---- tool registry ----------------------------------------------------------------

const FILE_PROPERTY = { file: { type: 'string', description: 'Absolute or workspace-relative path to the .elog file (a file:// URI is also accepted).' } };

const TOOLS: ElogToolDef[] = [
  {
    name: 'elog_info',
    description:
      'Summary of an OMNeT++ .elog file: run id, OMNeT++/eventlog version, first/last event number and simulation time, approximate event count, simulation-end status, and module count. Opens (or reuses a cached open handle for) the file.',
    inputSchema: { type: 'object', properties: { ...FILE_PROPERTY }, required: ['file'] },
    handler: (a, ctx) => {
      const engine = getOrOpenEngine(ctx, requireString(a, 'file', 'elog_info'));
      const eventLog = engine.eventLog;
      const isEmpty = eventLog.isEmpty();
      const sb = eventLog.getSimulationBeginEntry();
      const se = eventLog.getSimulationEndEntry();
      return {
        path: engine.absPath,
        fileSize: engine.reader.getFileSize(),
        isEmpty,
        runId: sb?.runId ?? null,
        omnetppVersion: sb?.omnetppVersion ?? null,
        eventlogVersion: sb?.eventlogVersion ?? null,
        firstEventNumber: isEmpty ? null : eventLog.getFirstEventNumber(),
        lastEventNumber: isEmpty ? null : eventLog.getLastEventNumber(),
        firstSimulationTime: isEmpty ? null : eventLog.getFirstSimulationTime().toString(),
        lastSimulationTime: isEmpty ? null : eventLog.getLastSimulationTime().toString(),
        approximateNumberOfEvents: eventLog.getApproximateNumberOfEvents(),
        simulationEnded: se !== null,
        simulationEndedWithError: se?.isError ?? null,
        simulationEndMessage: se?.message ?? null,
        moduleCount: eventLog.getEventLogEntryCache().getNumModuleDescriptionEntries(),
      };
    },
  },
  {
    name: 'elog_get_module_tree',
    description:
      'The module hierarchy described by an .elog file (network/compound/simple modules, as discovered so far). Depth and total node count are capped (maxDepth/maxNodes); `truncated` is set if either cap was hit.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_PROPERTY,
        maxDepth: { type: 'number', description: `Max tree depth (default ${DEFAULT_MODULE_TREE_MAX_DEPTH}).` },
        maxNodes: { type: 'number', description: `Max total nodes (default ${DEFAULT_MODULE_TREE_MAX_NODES}).` },
      },
      required: ['file'],
    },
    handler: (a, ctx) => {
      const engine = getOrOpenEngine(ctx, requireString(a, 'file', 'elog_get_module_tree'));
      const root = buildModuleTree(engine.eventLog);
      const maxDepth = typeof a.maxDepth === 'number' ? a.maxDepth : DEFAULT_MODULE_TREE_MAX_DEPTH;
      const maxNodes = typeof a.maxNodes === 'number' ? a.maxNodes : DEFAULT_MODULE_TREE_MAX_NODES;
      return capModuleTree(root, maxDepth, maxNodes);
    },
  },
  {
    name: 'elog_get_event',
    description:
      'Full detail of one event: its "E" line fields plus every entry belonging to it (class name + fields via getAsString()), the message it is processing, its cause event number, and its consequence event numbers (capped). Identify the event by eventNumber (exact) or simtime (decimal string; resolves to the first event at/after that time, since several events can share one simulation time).',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_PROPERTY,
        eventNumber: { type: 'number', description: 'Exact event number. One of eventNumber/simtime is required.' },
        simtime: { type: 'string', description: 'Simulation time, as a decimal string; matches the first event at/after this time. One of eventNumber/simtime is required.' },
      },
      required: ['file'],
    },
    handler: (a, ctx) => {
      const engine = getOrOpenEngine(ctx, requireString(a, 'file', 'elog_get_event'));
      let event: IEvent | null;
      if (a.eventNumber !== undefined) event = safeGetEventForEventNumber(engine.eventLog, requireNumber(a, 'eventNumber', 'elog_get_event'));
      else if (a.simtime !== undefined) event = safeGetEventForSimulationTime(engine.eventLog, BigDecimal.parse(requireString(a, 'simtime', 'elog_get_event')));
      else throw new Error('elog_get_event: one of "eventNumber" or "simtime" is required');
      if (event === null) return { found: false };

      const entries = [];
      for (let i = 0; i < event.getNumEventLogEntries(); i++) entries.push(serializeEntry(event.getEventLogEntry(i), i));

      const CONSEQUENCE_CAP = 50;
      const consequenceEventNumbers = [...new Set(event.getConsequences().map((d) => d.getConsequenceEventNumber()))];
      return {
        found: true,
        eventNumber: event.getEventNumber(),
        simulationTime: event.getSimulationTime().toString(),
        moduleId: event.getModuleId(),
        moduleName: event.getModuleDescriptionEntry().fullName,
        causeEventNumber: event.getCauseEventNumber(),
        messageId: event.getMessageId(),
        messageName: findProcessedMessageName(event),
        entries,
        consequenceEventNumbers: consequenceEventNumbers.slice(0, CONSEQUENCE_CAP),
        consequencesTruncated: consequenceEventNumbers.length > CONSEQUENCE_CAP,
      };
    },
  },
  {
    name: 'elog_get_events',
    description:
      'Compact per-event summaries (eventNumber, simulationTime, moduleId/moduleName, message name, entry count) for a contiguous event range starting at fromEventNumber (the first event at/after it), up to toEventNumber (inclusive, optional) or maxCount events, whichever comes first.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_PROPERTY,
        fromEventNumber: { type: 'number' },
        toEventNumber: { type: 'number', description: 'Inclusive upper bound (optional).' },
        maxCount: { type: 'number', description: 'Max rows to return (default 50).' },
      },
      required: ['file', 'fromEventNumber'],
    },
    handler: (a, ctx) => {
      const engine = getOrOpenEngine(ctx, requireString(a, 'file', 'elog_get_events'));
      const fromEventNumber = requireNumber(a, 'fromEventNumber', 'elog_get_events');
      const maxCount = typeof a.maxCount === 'number' ? a.maxCount : 50;
      const rows = [];
      let truncated = false;
      let event = safeGetEventForEventNumber(engine.eventLog, fromEventNumber, MatchKind.FIRST_OR_NEXT);
      while (event !== null && (a.toEventNumber === undefined || event.getEventNumber() <= a.toEventNumber)) {
        if (rows.length >= maxCount) {
          truncated = true;
          break;
        }
        rows.push(summarizeEvent(event));
        event = event.getNextEvent();
      }
      return { fromEventNumber, toEventNumber: a.toEventNumber ?? null, rows, truncated };
    },
  },
  {
    name: 'elog_find_text',
    description:
      'Finds the first log line (forward or backward) whose text contains `text`. Returns the matching event number, the entry index within that event, and the exact original line text. Omit fromEventNumber to search from the very first/last entry (per `backward`); otherwise the search starts strictly after (forward) that event\'s first entry.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_PROPERTY,
        text: { type: 'string' },
        fromEventNumber: { type: 'number', description: 'Optional start position (an event number).' },
        caseSensitive: { type: 'boolean', description: 'Default false.' },
        backward: { type: 'boolean', description: 'Search backward instead of forward. Default false.' },
      },
      required: ['file', 'text'],
    },
    handler: (a, ctx) => {
      const engine = getOrOpenEngine(ctx, requireString(a, 'file', 'elog_find_text'));
      const text = requireString(a, 'text', 'elog_find_text');
      const forward = !a.backward;
      const caseSensitive = !!a.caseSensitive;
      let startEntry: EventLogEntry | null = null;
      if (a.fromEventNumber !== undefined) {
        const startEvent = safeGetEventForEventNumber(engine.eventLog, requireNumber(a, 'fromEventNumber', 'elog_find_text'));
        if (startEvent === null) return { found: false };
        startEntry = startEvent.getEventLogEntry(0);
      }
      const found = engine.eventLog.findEventLogEntry(startEntry, text, forward, caseSensitive);
      if (found === null) return { found: false };
      return {
        found: true,
        eventNumber: found.getEventNumber(),
        entryIndex: found.getEntryIndex(),
        line: readRawLine(engine.reader, found.getOffset()),
      };
    },
  },
  {
    name: 'elog_trace',
    description:
      'The cause/consequence closure of one event, via the engine\'s trace filter (the same feature behind the IDE\'s "Show cause/consequence chain" action): every event that is a transitive cause and/or consequence of eventNumber. Each result is tagged relation: "traced" (the event itself), "cause", or "consequence". The result list is capped at maxNumber (default 200; truncated flag set if more exist) -- NOTE this differs from the port plan\'s original maxDepth/maxNumber sketch: the underlying FilteredEventLog trace filter has no notion of a depth bound (it computes the whole transitive closure, gated only by the traceSelfMessages/traceMessageReuses toggles), so no maxDepth argument is exposed here.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_PROPERTY,
        eventNumber: { type: 'number' },
        causes: { type: 'boolean', description: 'Include causes. Default true.' },
        consequences: { type: 'boolean', description: 'Include consequences. Default true.' },
        traceSelfMessages: { type: 'boolean', description: 'Default true (engine default).' },
        traceMessageReuses: { type: 'boolean', description: 'Default true (engine default).' },
        maxNumber: { type: 'number', description: 'Cap on the number of returned events (default 200).' },
      },
      required: ['file', 'eventNumber'],
    },
    handler: (a, ctx) => {
      const engine = getOrOpenEngine(ctx, requireString(a, 'file', 'elog_trace'));
      const eventNumber = requireNumber(a, 'eventNumber', 'elog_trace');
      if (safeGetEventForEventNumber(engine.eventLog, eventNumber) === null) return { found: false };

      const filtered = new FilteredEventLog(engine.eventLog);
      filtered.setTracedEventNumber(eventNumber);
      filtered.setTraceCauses(a.causes ?? true);
      filtered.setTraceConsequences(a.consequences ?? true);
      if (a.traceSelfMessages !== undefined) filtered.setTraceSelfMessages(a.traceSelfMessages);
      if (a.traceMessageReuses !== undefined) filtered.setTraceMessageReuses(a.traceMessageReuses);

      const maxNumber = typeof a.maxNumber === 'number' ? a.maxNumber : 200;
      const events: { eventNumber: number; simulationTime: string; moduleId: number; messageName: string | null; relation: 'cause' | 'consequence' | 'traced' }[] = [];
      let truncated = false;
      let event = filtered.getFirstEvent();
      while (event !== null) {
        if (events.length >= maxNumber) {
          truncated = true;
          break;
        }
        const en = event.getEventNumber();
        events.push({
          eventNumber: en,
          simulationTime: event.getSimulationTime().toString(),
          moduleId: event.getModuleId(),
          messageName: findProcessedMessageName(event),
          relation: en === eventNumber ? 'traced' : en < eventNumber ? 'cause' : 'consequence',
        });
        event = event.getNextEvent();
      }
      return { found: true, eventNumber, events, truncated };
    },
  },
  {
    name: 'elog_filter_summary',
    description:
      'Applies a FilterParams filter (event range/exclusions, module filter, message filter, and/or trace filter -- same shape as the eventlog worker protocol\'s FilterParams) and reports the approximate count of matching events, the first/last matching event numbers, and a small sample of matches. Does not modify the file or any cached engine state.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILE_PROPERTY,
        filterParams: { type: 'object', description: 'FilterParams (see shared/src/eventlog/elogProtocol.ts). All fields optional.' },
        sampleSize: { type: 'number', description: 'Max number of sample matches to return (default 20).' },
      },
      required: ['file'],
    },
    handler: (a, ctx) => {
      const engine = getOrOpenEngine(ctx, requireString(a, 'file', 'elog_filter_summary'));
      const filtered = new FilteredEventLog(engine.eventLog);
      applyFilterParams(filtered, (a.filterParams ?? {}) as FilterParams);

      const isEmpty = filtered.isEmpty();
      const sampleSize = typeof a.sampleSize === 'number' ? a.sampleSize : 20;
      const sample = [];
      let event = filtered.getFirstEvent();
      while (event !== null && sample.length < sampleSize) {
        sample.push(summarizeEvent(event));
        event = event.getNextEvent();
      }
      return {
        isEmpty,
        approximateNumberOfMatchingEvents: isEmpty ? 0 : filtered.getApproximateNumberOfEvents(),
        firstMatchingEventNumber: isEmpty ? null : filtered.getFirstEventNumber(),
        lastMatchingEventNumber: isEmpty ? null : filtered.getLastEventNumber(),
        sample,
        truncated: event !== null,
      };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** MCP tool descriptors (name + description + JSON input schema) for tools/list. */
export const ELOG_TOOLS = TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

/** Dispatch an elog MCP tool call. Throws on an unknown tool name or invalid/missing arguments (mirrors handleTool's convention in tools.ts); "not found"/empty-result cases are returned as normal results (e.g. `{ found: false }`), not thrown. */
export function handleElogTool(name: string, args: Record<string, any>, ctx: ElogToolContext): unknown {
  const tool = BY_NAME.get(name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return tool.handler(args ?? {}, ctx);
}
