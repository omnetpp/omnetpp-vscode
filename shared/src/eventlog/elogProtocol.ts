/**
 * The worker RPC protocol (JSON-RPC over stdio, `vscode-jsonrpc`) between the
 * extension host (`client/src/eventlog/workerClient.ts`) and the dedicated
 * per-`.elog` worker process (`client/worker/`, phase E8). Every shape here is
 * **JSON-pure**: no `bigint`, no class instances, no `Map`/`Set` -- just plain
 * objects/arrays/strings/numbers/booleans, so it survives `JSON.stringify` (the wire
 * format `vscode-jsonrpc`'s `StreamMessageReader`/`StreamMessageWriter` use) without a
 * custom (de)serializer. In particular:
 *  - simulation times (`BigDecimal` engine-side) travel as **decimal strings**
 *    (`BigDecimal.toString()`/`BigDecimal.parse()` round-trip them exactly, per
 *    bigDecimal.ts).
 *  - event numbers, offsets, module/message ids stay plain `number` (already
 *    safe-integer-asserted engine-side, per the port plan).
 *
 * Method-name/DTO-shape source: the port plan's "Key protocol shapes" section
 * (`/home/rhornig/.claude/plans/i-want-to-implement-breezy-treasure.md`). This file
 * follows that sketch as closely as possible -- deviations (a handful of small,
 * additive ones: `elog/getSummary`, `elog/close`, and a couple of DTO fields the
 * sketch left implicit) are called out per-symbol below and summarized in the E8
 * phase report.
 *
 * This module is deliberately dependency-light (mirrors `shared/src/protocol.ts`):
 * only `import type` from the rest of `shared/src/eventlog/`, so a consumer can
 * import `@omnetpp/shared/elog-protocol` (see `shared/package.json`'s "exports")
 * without dragging in the whole eventlog engine (parser, FileReader, etc.) -- the
 * browser-side Sequence Chart/Event Log webviews (U-track) only ever need these
 * types, never the engine itself (which stays worker-thread-only).
 */

import type { EventLogTableFilterMode, MatchKind, TimelineMode } from './enums';
import type { ElogModule } from './moduleTree';

export type { ElogModule };

// ---------------------------------------------------------------------------------
// Method names
// ---------------------------------------------------------------------------------

/** Request method names of the worker's `elog/*` JSON-RPC surface. */
export const ElogMethods = {
  /** request: OpenParams → LogSummary -- opens (or replaces) the file this worker serves. */
  open: 'elog/open',
  /**
   * request: void → LogSummary. ADDITIVE (not in the plan's sketch, small): a cheap
   * re-fetch of the current summary without re-opening -- useful right after an
   * `elog/changed` notification, or for a client that just wants to refresh a status
   * bar. `elog/open`'s result already covers the initial-load case.
   */
  getSummary: 'elog/getSummary',
  /** request: void → ElogModule | null */
  getModuleTree: 'elog/getModuleTree',
  /** request: FilterParams | null → LogSummary -- long-running, cancellable. `null` reverts to the raw (unfiltered) log. */
  setFilter: 'elog/setFilter',
  /** request: ScSetTimelineModeParams → ScState */
  scSetTimelineMode: 'elog/sc/setTimelineMode',
  /** request: ScRelocateOriginParams → ScState */
  scRelocateOrigin: 'elog/sc/relocateOrigin',
  /** request: ViewportParams → ViewportModel -- long-running, cancellable. */
  scGetViewport: 'elog/sc/getViewport',
  /** request: MapCoordsParams → MapCoordsResult */
  scMapCoords: 'elog/sc/mapCoords',
  /** request: AdjacencyParams → AdjacencyResult -- long-running, cancellable. */
  scAdjacencyMatrix: 'elog/sc/adjacencyMatrix',
  /** request: RowWindowParams → RowWindow */
  tableGetRows: 'elog/table/getRows',
  /** request: TableNavigateParams → RowRef | null */
  tableNavigate: 'elog/table/navigate',
  /** request: TablePositionParams → TablePositionResult */
  tablePosition: 'elog/table/position',
  /** request: GotoEventParams → GotoResult */
  gotoEvent: 'elog/gotoEvent',
  /** request: GotoSimTimeParams → GotoResult */
  gotoSimTime: 'elog/gotoSimTime',
  /** request: FindTextParams → FindTextResult -- long-running, cancellable. */
  findText: 'elog/findText',
  /** request: EventDetailParams → EventDetail | null */
  getEventDetail: 'elog/getEventDetail',
  /** request: void → void. ADDITIVE: releases the open file/engine (E9 will add "Release Memory" semantics on top). */
  close: 'elog/close',
} as const;

/** Notification method names (server→client; no response expected). */
export const ElogNotifications = {
  /** Sent at most once per ~100ms while a long-running request is in flight (see `EventLogOptions.onProgress`). Params: `ElogProgressParams`. */
  progress: 'elog/progress',
  /** Sent when the engine detects (via its watcher) that the underlying file changed out from under an idle worker. Params: `ElogChangedParams`. */
  changed: 'elog/changed',
} as const;

/**
 * JSON-RPC error code for a request that failed because the underlying file changed
 * mid-scan (`FileChangedError`, fileReader.ts) -- port plan: "Requests interrupted by
 * a file change fail with error -32010 ContentChanged {change, summary} → client
 * retries." Chosen from the LSP-reserved-but-unused range below -32000 (server error
 * range), matching how `vscode-languageserver`/`vscode-jsonrpc` reserve
 * `-32099..-32000` for application-defined server errors.
 */
export const CONTENT_CHANGED_ERROR_CODE = -32010;

/**
 * JSON-RPC error code for a request cancelled via `$/cancelRequest` (`vscode-jsonrpc`'s
 * `CancellationToken` machinery -- see client/worker/src/main.ts's header). Plain
 * `vscode-jsonrpc` doesn't itself define this value (only `vscode-languageserver-
 * protocol`'s `LSPErrorCodes.RequestCancelled` does, package this codebase doesn't
 * depend on) -- defined here instead so both the worker (which throws it) and
 * `workerClient.ts`/webviews (which need to recognize "this failed because I asked it
 * to") agree on the same number without an extra dependency. Value matches
 * `LSPErrorCodes.RequestCancelled` (-32800) for interop with any tooling that already
 * knows that convention.
 */
export const REQUEST_CANCELLED_ERROR_CODE = -32800;

/** `error.data` shape for a `CONTENT_CHANGED_ERROR_CODE` error response. */
export interface ContentChangedErrorData {
  change: 'appended' | 'overwritten';
  summary: LogSummary;
}

// ---------------------------------------------------------------------------------
// elog/open, elog/getSummary
// ---------------------------------------------------------------------------------

/** Options mirrored from `EventLogOptions` (eventLog.ts) -- all optional, engine-side defaults apply. */
export interface ElogOpenOptions {
  eventCacheLimit?: number;
  offsetCacheLimit?: number;
  smallFileThresholdBytes?: number;
  parseBeginEndBytes?: number;
}

export interface OpenParams {
  /** Absolute path to the `.elog` file. */
  path: string;
  options?: ElogOpenOptions;
}

/** Result of `elog/open`/`elog/getSummary`, and the fresh summary bundled into `ContentChangedErrorData`/`ElogChangedParams`. */
export interface LogSummary {
  path: string;
  fileSize: number;
  isEmpty: boolean;
  firstEventNumber: number;
  lastEventNumber: number;
  /** decimal string, or `null` iff `isEmpty`. */
  firstSimulationTime: string | null;
  /** decimal string, or `null` iff `isEmpty`. */
  lastSimulationTime: string | null;
  approximateNumberOfEvents: number;
  /**
   * Bumped every time the coordinate system or the underlying (possibly filtered) log
   * is swapped/reset -- a stale-response guard: the webview drops any response/
   * viewport whose `coordinateSystemVersion` doesn't match the latest one it has seen
   * (port plan: "Stale-response protection").
   */
  coordinateSystemVersion: number;
  /** `true` once `elog/setFilter` has installed a non-null `FilteredEventLog` in place of the raw log. */
  filtered: boolean;
}

// ---------------------------------------------------------------------------------
// elog/getModuleTree -- ElogModule is imported from moduleTree.ts (re-exported above)
// ---------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------
// elog/setFilter
// ---------------------------------------------------------------------------------

/**
 * Mirrors `FilteredEventLogOptions` + every `FilteredEventLog` setter (filteredEventLog.ts).
 * All fields optional; an omitted field leaves the corresponding engine-side default
 * (see filteredEventLog.ts's field initializers) untouched. Passing `null` as the
 * whole `elog/setFilter` params (not this type) reverts to the unfiltered raw log.
 */
export interface FilterParams {
  firstConsideredEventNumber?: number;
  lastConsideredEventNumber?: number;
  excludedEventNumbers?: number[];

  collectMessageReuses?: boolean;

  enableModuleFilter?: boolean;
  moduleExpression?: string | null;
  moduleNames?: string[];
  moduleClassNames?: string[];
  moduleNedTypeNames?: string[];
  moduleIds?: number[];

  enableMessageFilter?: boolean;
  messageExpression?: string | null;
  messageNames?: string[];
  messageClassNames?: string[];
  messageIds?: number[];
  messageTreeIds?: number[];
  messageEncapsulationIds?: number[];
  messageEncapsulationTreeIds?: number[];

  /** Undefined/absent = no event tracing (cause/consequence highlighting off). */
  tracedEventNumber?: number;
  traceCauses?: boolean;
  traceConsequences?: boolean;
  traceSelfMessages?: boolean;
  traceMessageReuses?: boolean;
  maximumCauseDepth?: number;
  maximumNumberOfCauses?: number;
  maximumCauseCollectionTime?: number;
  maximumConsequenceDepth?: number;
  maximumNumberOfConsequences?: number;
  maximumConsequenceCollectionTime?: number;
}

// ---------------------------------------------------------------------------------
// Sequence Chart: timeline mode / origin / state
// ---------------------------------------------------------------------------------

export interface ScSetTimelineModeParams {
  timelineMode: TimelineMode;
  separateEventLogEntries?: boolean;
  /** Only meaningful for `TimelineMode.NONLINEAR`. */
  nonLinearMinimumTimelineCoordinateDelta?: number;
  /** Only meaningful for `TimelineMode.NONLINEAR`. */
  nonLinearFocus?: number;
}

export interface ScRelocateOriginParams {
  /** `null` undefines the coordinate system entirely (`undefineTimelineCoordinateSystem()`). */
  eventNumber: number | null;
}

/** Current Sequence Chart coordinate-system state, returned by both `elog/sc/setTimelineMode` and `elog/sc/relocateOrigin`. */
export interface ScState {
  timelineMode: TimelineMode;
  separateEventLogEntries: boolean;
  nonLinearMinimumTimelineCoordinateDelta: number;
  nonLinearFocus: number;
  originEventNumber: number | null;
  coordinateSystemVersion: number;
}

// ---------------------------------------------------------------------------------
// elog/sc/getViewport
// ---------------------------------------------------------------------------------

/** A viewport range expressed either in timeline coordinates or in event numbers (port plan: "tcRange|eventRange"). */
export type ViewportRange = { kind: 'tc'; tcBegin: number; tcEnd: number } | { kind: 'event'; startEventNumber: number; endEventNumber: number };

export interface ViewportParams {
  range: ViewportRange;
  /** Extra timeline-coordinate margin to prefetch on both sides beyond `range` (renderModelCache's prefetch margin, U3). Default 0. */
  marginTc?: number;
  /** Which axes' events to include; `undefined`/omitted = all currently-known modules. */
  includeModuleIds?: number[];
  includeMethodCalls?: boolean;
  includeDependencies?: boolean;
  /** Truncation cap (port plan risk #4: dense-viewport perf); default is engine-chosen. */
  maxEvents?: number;
}

/** One event's Sequence Chart render data. */
export interface TimelineEvent {
  eventNumber: number;
  moduleId: number;
  /** decimal string. */
  simulationTime: string;
  tcBegin: number;
  tcEnd: number;
  causeEventNumber: number;
  isSelfMessageProcessingEvent: boolean;
}

/** A message-send/reuse/filtered-gap dependency arrow. */
export interface RenderDependency {
  kind: 'send' | 'reuse' | 'filtered';
  causeEventNumber: number;
  causeModuleId: number | null;
  causeTc: number | null;
  /** decimal string, or `null` if the cause side falls outside the currently-parsed range. */
  causeSimulationTime: string | null;
  consequenceEventNumber: number;
  consequenceModuleId: number | null;
  consequenceTc: number | null;
  /** decimal string, or `null` if the consequence side falls outside the currently-parsed range. */
  consequenceSimulationTime: string | null;
  messageName: string | null;
  messageClassName: string | null;
}

/** A `ComponentMethodBeginEntry`-derived method-call arrow. */
export interface RenderMethodCall {
  eventNumber: number;
  tc: number;
  sourceModuleId: number;
  targetModuleId: number;
  methodName: string;
}

export interface ViewportModel {
  coordinateSystemVersion: number;
  events: TimelineEvent[];
  dependencies: RenderDependency[];
  methodCalls: RenderMethodCall[];
  /** Every module id referenced by `events`/`dependencies`/`methodCalls` in this viewport (axis-selection hint for the webview). */
  moduleIds: number[];
  /** `true` iff `maxEvents` truncated the result (port plan risk #4). */
  truncated: boolean;
}

// ---------------------------------------------------------------------------------
// elog/sc/mapCoords
// ---------------------------------------------------------------------------------

export type MapCoordsParams =
  | { kind: 'tcToSimTime'; tc: number; upperLimit?: boolean }
  | { kind: 'simTimeToTc'; simulationTime: string; upperLimit?: boolean }
  | { kind: 'eventToTc'; eventNumber: number }
  | { kind: 'tcToEventNumber'; tc: number };

export interface MapCoordsResult {
  tc: number | null;
  /** decimal string, or `null` when the query kind doesn't produce a simtime. */
  simulationTime: string | null;
  eventNumber: number | null;
  coordinateSystemVersion: number;
}

// ---------------------------------------------------------------------------------
// elog/sc/adjacencyMatrix
// ---------------------------------------------------------------------------------

export interface AdjacencyParams {
  /** Axis order: `moduleIds[i]` is axis index `i`. */
  moduleIds: number[];
  /** Exact range (mutually exclusive with `numberOfSamples`): every event from `startEventNumber` to `endEventNumber` is scanned. */
  startEventNumber?: number;
  endEventNumber?: number;
  /** Approximate sampling (mutually exclusive with `startEventNumber`/`endEventNumber`): `getApproximateMessageDependencyCountAdjacencyMatrix()`. */
  numberOfSamples?: number;
  messageSendWeight?: number;
  messageReuseWeight?: number;
}

export interface AdjacencyResult {
  numberOfAxes: number;
  /** Row-major `numberOfAxes` x `numberOfAxes` matrix. */
  matrix: number[];
}

// ---------------------------------------------------------------------------------
// Event Log table: rows / navigation / position
// ---------------------------------------------------------------------------------

/**
 * Identifies one table row by the same compound key `eventLogTableFacade.ts` uses to
 * survive LRU eviction/reparsing (port plan risk #3): an entry is `(eventNumber,
 * entryIndex)`, never an object reference.
 */
export interface RowRef {
  eventNumber: number;
  entryIndex: number;
}

export type RowAnchor = { kind: 'ref'; ref: RowRef } | { kind: 'first' } | { kind: 'last' } | { kind: 'percentage'; percentage: number };

export interface RowWindowParams {
  anchor: RowAnchor;
  /** Number of rows to fetch strictly before the anchor. */
  before: number;
  /** Number of rows to fetch at/after the anchor. */
  after: number;
  filterMode?: EventLogTableFilterMode;
  /** Only meaningful with `filterMode: 'CUSTOM_ENTRIES'` (`EventLogTableFacade.setCustomFilter()`). */
  customFilterPattern?: string;
}

/** One raw table row -- the U2 row renderer builds styled spans from this; no presentation/formatting decisions are made here. */
export interface TableRow {
  ref: RowRef;
  /** The entry's short line code (e.g. `"E"`, `"BS"`, `"CMB"`) -- `EventLogEntry.getAsString()` with no argument. */
  entryClassCode: string;
  /** The entry's class name (e.g. `"EventEntry"`, `"BeginSendEntry"`). */
  entryClassName: string;
  /** Port of `EventLogEntry.getLevel()` -- method-call nesting depth, drives row indent. */
  level: number;
  contextModuleId: number;
  /** decimal string. */
  simulationTime: string;
  eventNumber: number;
  /** `getAttributeNames()` × `getAsString(attribute)`, in declaration order. */
  fields: Record<string, string | null>;
  /** Non-null only for `EventLogMessageEntry` ("-" log lines): its free-text content. */
  text: string | null;
}

export interface RowWindow {
  rows: TableRow[];
  /** Index into `rows` of the resolved anchor row, or `-1` if the anchor could not be resolved (e.g. empty log). */
  anchorIndex: number;
  /** `EventLogTableFacade.getApproximatePercentageForEntry()` of the anchor row (approximate scrollbar position). */
  approximatePercentage: number;
  /** `EventLogTableFacade.getApproximateNumberOfEntries()` (approximate scrollbar range). */
  approximateNumberOfEntries: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export interface TableNavigateParams {
  ref: RowRef;
  /** Signed entry distance (negative = backward), `EventLogTableFacade.getNeighbourEntry()`. */
  distance: number;
}

export interface TablePositionParams {
  ref: RowRef;
}

export interface TablePositionResult {
  approximatePercentage: number;
  approximateNumberOfEntries: number;
}

// ---------------------------------------------------------------------------------
// elog/gotoEvent, elog/gotoSimTime
// ---------------------------------------------------------------------------------

export interface GotoEventParams {
  eventNumber: number;
  matchKind?: MatchKind;
}

export interface GotoSimTimeParams {
  /** decimal string. */
  simulationTime: string;
  matchKind?: MatchKind;
}

export interface GotoResult {
  found: boolean;
  eventNumber: number | null;
  /** decimal string, or `null` if not found. */
  simulationTime: string | null;
  /** The first table row of the resolved event (anchor for both chart and table reveal), or `null` if not found. */
  ref: RowRef | null;
}

// ---------------------------------------------------------------------------------
// elog/findText
// ---------------------------------------------------------------------------------

export interface FindTextParams {
  /** `null` starts from the very first/last entry (per `forward`). */
  start: RowRef | null;
  search: string;
  forward: boolean;
  caseSensitive: boolean;
}

export interface FindTextResult {
  found: boolean;
  ref: RowRef | null;
}

// ---------------------------------------------------------------------------------
// elog/getEventDetail
// ---------------------------------------------------------------------------------

export interface EventDetailParams {
  eventNumber: number;
}

/** Every raw log entry belonging to one event (unfiltered), for a detail/inspector panel. */
export interface EventDetail {
  eventNumber: number;
  /** decimal string. */
  simulationTime: string;
  moduleId: number;
  causeEventNumber: number;
  messageId: number;
  entries: TableRow[];
}

// ---------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------

/** Params of `elog/progress` -- correlates to the in-flight request via its JSON-RPC id (there can only ever be one long-running job active at a time, per the engine's serial job queue, but a client may have several requests queued). */
export interface ElogProgressParams {
  requestId: number | string;
}

/** Params of `elog/changed` -- sent when the watcher (E9) detects the file changed while otherwise idle. */
export interface ElogChangedParams {
  change: 'appended' | 'overwritten';
  summary: LogSummary;
}
