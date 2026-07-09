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

// MatchKind/TimelineMode/EventLogTableFilterMode are imported as VALUES (not `import
// type`) and re-exported below -- phase U1 callers (`client/src/eventlog/
// eventLogDialogs.ts`'s goto commands, `client/webview/src/eventlog/chart/
// chartMain.ts`'s timeline-mode dropdown) and phase U2's table (the Line Filter
// dropdown, `client/webview/src/eventlog/table/tableView.ts`) need the actual enum
// members, not just the type, and (per this file's header) are only supposed to
// depend on `@omnetpp/shared/elog-protocol`, never the full `@omnetpp/shared/eventlog`
// barrel (too heavy for the browser bundle). `enums.ts` itself has zero
// dependencies and is a handful of small enums, so re-exporting these here keeps this
// subpath's "browser-safe, type-light" contract intact.
import { EventLogTableFilterMode, MatchKind, TimelineMode } from './enums';
import type { ElogModule } from './moduleTree';

export type { ElogModule };
export { EventLogTableFilterMode, MatchKind, TimelineMode };

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
  /**
   * request: void → FilterHints. ADDITIVE (phase U7): autocompletion data for the
   * filter panel's message-name/message-class-name/module-name/module-class-name/
   * module-NED-type-name pickers -- a cheap, capped scan of whatever the engine has
   * already parsed (`FilterHints`'s own doc comment). Not long-running/cancellable
   * (bounded by its own cap, unlike `setFilter`/`scGetViewport`).
   */
  getFilterHints: 'elog/getFilterHints',
  /** request: FilterParams | null → LogSummary -- long-running, cancellable. `null` reverts to the raw (unfiltered) log. */
  setFilter: 'elog/setFilter',
  /** request: ScSetTimelineModeParams → ScState */
  scSetTimelineMode: 'elog/sc/setTimelineMode',
  /** request: ScRelocateOriginParams → ScState */
  scRelocateOrigin: 'elog/sc/relocateOrigin',
  /** request: ViewportParams → ViewportModel -- long-running, cancellable. */
  scGetViewport: 'elog/sc/getViewport',
  /** request: ScListVectorsParams → ScListVectorsResult. ADDITIVE: read a `.vec` file's declarations for the "Attach Vector to Axis" picker. */
  scListVectors: 'elog/sc/listVectors',
  /** request: ScAttachVectorParams → void. ADDITIVE: attach a vector (by identity) to a module axis; the engine loads its samples for later viewport queries. */
  scAttachVector: 'elog/sc/attachVector',
  /** request: ScDetachVectorParams → void. ADDITIVE: remove a module axis's attached vector. */
  scDetachVector: 'elog/sc/detachVector',
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
  /**
   * request: TableGotoRelatedParams → RowRef | null. ADDITIVE (phase U6): the table's
   * "Go To" context-menu/keyboard family (Cause/Arrival/Origin/Reuse/Previous-Next
   * Event/Previous-Next Module Event), ported from `EventLogTableContributor.java`'s
   * per-action handlers -- see `TableGotoRelation`'s doc for the exact semantics.
   */
  tableGotoRelated: 'elog/table/gotoRelated',
  /** request: GotoEventParams → GotoResult */
  gotoEvent: 'elog/gotoEvent',
  /** request: GotoSimTimeParams → GotoResult */
  gotoSimTime: 'elog/gotoSimTime',
  /** request: FindTextParams → FindTextResult -- long-running, cancellable. */
  findText: 'elog/findText',
  /** request: EventDetailParams → EventDetail | null */
  getEventDetail: 'elog/getEventDetail',
  /**
   * request: void → CheckChangesResult. ADDITIVE (phase E9, "live follow"): forces an
   * immediate check of the underlying file against the last-synchronized state (the
   * same check the fs.watch/poll-timer hybrid in `client/worker/src/watcher.ts` drives
   * automatically) -- for a UI refresh button, or a client that wants a synchronous
   * answer instead of waiting for an unsolicited `elog/changed`. Runs as a normal,
   * low-priority job on the engine thread's FIFO queue (see engineThread.ts), so it
   * never preempts an already-queued/in-flight request; if a change is found, the
   * engine also emits the matching `elog/changed` notification (so every listener --
   * not just whoever happened to call this -- learns about it), in addition to
   * returning the result to this specific caller.
   */
  checkChanges: 'elog/checkChanges',
  /** request: void → void. ADDITIVE: releases the open file/engine (E9 will add "Release Memory" semantics on top). */
  close: 'elog/close',
  /**
   * request: void → ReleaseMemoryResult. ADDITIVE (phase U9): the "Release Memory"
   * command/context-menu item -- port of `SequenceChartContributor.
   * createReleaseMemoryAction()` (verified by reading the source), which simply does
   * `sequenceChart.getInput().synchronize(FileReader.FileChange.OVERWRITTEN)`: a full
   * cache drop + re-parse of the (unchanged-on-disk) file, even though nothing on disk
   * actually changed. This port's engine mirrors that exactly (`EngineSession.
   * releaseMemory()` calls the same OVERWRITTEN reset path `elog/checkChanges`'s
   * overwritten branch uses) -- pinned events (first/last/origin) are re-pinned
   * immediately after, matching every other OVERWRITTEN reset in this port (E9's
   * `synchronizeToCurrentFileState()`). Not long-running/cancellable (the reset itself
   * is cheap -- `parseIndicesAndSnapshots()` only re-reads index/snapshot headers, not
   * every event).
   */
  releaseMemory: 'elog/releaseMemory',
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
  /**
   * Phase E9 ("live follow"): poll-timer interval, in ms, for `client/worker/src/
   * watcher.ts`'s change-detection fallback (used alongside `fs.watch`, which can miss
   * events -- e.g. across a rename/recreate on some filesystems -- or be unsupported on
   * a network mount). `0` disables the poll timer entirely (fs.watch keeps running);
   * intended for tests that want to drive change detection deterministically via the
   * manual `elog/checkChanges` request instead of waiting on a timer. Default 3000,
   * matching the Eclipse IDE's `EventLogInput`'s `RecurringJob(3000)`.
   */
  pollIntervalMs?: number;
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
// elog/getFilterHints -- phase U7 (filter panel autocompletion)
// ---------------------------------------------------------------------------------

/**
 * Autocompletion data for the U7 filter panel, built engine-side
 * (`shared/src/eventlog/filterHints.ts`'s `buildFilterHints()`) from whatever the
 * engine has already parsed -- a cheap, bounded scan (NOT a full-file guarantee: on a
 * huge/still-growing log this only reflects module/message names seen so far,
 * matching `FilterEventLogDialog.java`'s own "encountered so far" labels for its
 * message name/class checkbox lists, verified by reading the source). Every list is
 * capped (see `buildFilterHints()`'s `cap` parameter) with `truncated` set if any list
 * was cut off, so the panel can show "+ more" rather than silently hiding entries.
 */
export interface FilterHints {
  moduleNames: string[];
  moduleClassNames: string[];
  moduleNedTypeNames: string[];
  messageNames: string[];
  messageClassNames: string[];
  /** `true` iff any of the lists above were capped. */
  truncated: boolean;
}

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

/**
 * Port of `FilteredMessageDependency.Kind` (`SENDS`/`REUSES`/`MIXED`), carried on the
 * wire as lowercase strings rather than reusing `FilteredMessageDependencyKind`'s
 * numeric consts (JSON-pure per this file's header) -- only meaningful when
 * `RenderDependency.kind === 'filtered'`. Drives the filtered-arrow's line style/color
 * per `SequenceChartStyleProvider.getMessageDependencyLine{Style,Dash}`/
 * `getMessageDependencyColor` (verified by reading the source): `sends` = solid,
 * `reuses` = dotted, `mixed` = dashed.
 */
export type FilteredDependencyKind = 'sends' | 'reuses' | 'mixed';

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
  /** Only present when `kind === 'filtered'` -- see `FilteredDependencyKind`'s own doc. */
  filteredKind?: FilteredDependencyKind;
  /**
   * `MessageDescriptionEntry.messageId` (or `null` if unavailable) -- ADDITIVE (phase
   * U5): Java's self-message half-ellipse height formula folds this in
   * (`eventNumberDelta = messageId + consequenceEventNumber - causeEventNumber`,
   * `SequenceChart.java:4603`) so that repeated same-event-pair self-messages (a common
   * pattern: a periodic self-timer rescheduling itself) don't all draw at the identical
   * ellipse height. `arrowGeometry.ts` falls back to `messageId = 0` when absent.
   */
  messageId?: number | null;
  /**
   * ADDITIVE (phase U5), populated only for `kind === 'send'` when `getEndSendEntry()`
   * reports a nonzero `getRemainingDuration()` (Java's `remainingDuration != null`
   * gate for `showTransmissionDurations`, `SequenceChart.java:4464-4469`): the
   * transmission's remaining/total duration expressed as a **fraction of this
   * dependency's own cause-to-consequence simulation-time span**
   * (`transmissionDuration / (consequenceSimulationTime - causeSimulationTime)`,
   * clamped to `[0, 1]`). DOCUMENTED SIMPLIFICATION vs Java: Java re-maps the absolute
   * transmission/remaining-duration `BigDecimal`s through
   * `getTimelineCoordinateForSimulationTimeAndEventInModule()` (a per-module,
   * non-affine tc mapping) to get exact parallelogram corners; this port instead scales
   * the arrow's own already-computed pixel span by this fraction (arrowGeometry.ts's
   * `computeTransmissionParallelogram()`), which is exact for `TimelineMode.
   * SIMULATION_TIME`/`STEP` (tc is affine in simtime within one dependency's short
   * span) and a close visual approximation for `EVENT_NUMBER`/`NONLINEAR` modes.
   * `null`/absent = no transmission-duration decoration for this dependency (filtered
   * dependencies never get one, matching Java's `!isFilteredMessageDependency` gate).
   */
  transmissionDurationFraction?: number | null;
  /**
   * Port of `EndSendEntry.getIsDeliveredImmediately()` -- Java's `isReceptionStart`
   * flag (`SequenceChart.java:4471`), which flips which end of the parallelogram is the
   * "instantaneous" (zero-width) side. Only meaningful alongside
   * `transmissionDurationFraction`.
   */
  isReceptionStart?: boolean;
  transmissionDurationTc1?: number | null;
  transmissionDurationTc2?: number | null;
  transmissionDurationTc3?: number | null;
  transmissionDurationTc4?: number | null;
}

/** A `ComponentMethodBeginEntry`-derived method-call arrow. */
export interface RenderMethodCall {
  eventNumber: number;
  /** Timeline coordinate of the call (the ComponentMethodBegin entry). */
  tc: number;
  /** Timeline coordinate of the return (the matching ComponentMethodEnd entry); spreads the call across a WIDTH within the event's pill (Java draws a faint bar `[tc, tcEnd]`). Defaults to `tc` (zero width) when the end entry is unavailable / no entry separation. */
  tcEnd?: number;
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
  /** ADDITIVE: per-axis vector-data strips (Eclipse `AxisVectorBarRenderer`), one entry per module with an attached vector, holding the value-step segments that fall in this viewport. Absent/empty when no vectors are attached. */
  axisVectorStrips?: AxisVectorStrip[];
}

/** One value-step segment of an axis vector strip: the value is held over `[tcBegin, tcEnd]` (from a sample's event to the next sample's event). */
export interface AxisVectorSegment {
  tcBegin: number;
  tcEnd: number;
  /** Color bucket (Eclipse `getValueIndex`): a stable index → a "good light color"; equal values share a color. */
  colorIndex: number;
  /** Raw sample value (for tooltips / Zoom-to-Value). */
  value: number;
  /** Display text (enum name or number, Eclipse `getValueText`). */
  valueText: string;
}

/** The vector-data strip for one module axis in a given viewport. */
export interface AxisVectorStrip {
  moduleId: number;
  segments: AxisVectorSegment[];
}

// ---------------------------------------------------------------------------------
// elog/sc/listVectors, attachVector, detachVector (axis vector data)
// ---------------------------------------------------------------------------------

/** A vector's identity within a `.vec` file (also the persisted attachment key parts). */
export interface VectorIdentity {
  /** Run name the vector belongs to (empty string = the file's single/only run). */
  run: string;
  /** The vector's recording module full path (e.g. `Aloha.server`). */
  vectorModule: string;
  /** The vector's name (e.g. `serverState:vector`). */
  vectorName: string;
}

export interface ScListVectorsParams {
  /** Whole `.vec` file contents (the host reads the file and passes text; the worker has no workspace access of its own). */
  content: string;
}

/** One selectable vector for the attach picker. */
export interface ScVectorChoice extends VectorIdentity {
  /** The columnSpec string, e.g. `ETV`/`TV`. */
  columns: string;
  /** `'int' | 'double' | 'enum'` or null. */
  type: string | null;
}

export interface ScListVectorsResult {
  runs: string[];
  vectors: ScVectorChoice[];
}

export interface ScAttachVectorParams {
  /** The axis module the vector is attached to. */
  moduleId: number;
  /** Whole `.vec` file contents. */
  content: string;
  vector: VectorIdentity;
}

export interface ScDetachVectorParams {
  moduleId: number;
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
  /**
   * ADDITIVE (phase U8, axis management): extra module-id -> axis-index mappings for
   * modules that have NO axis of their own but whose events should count toward an
   * ancestor's axis (Java's `moduleIdToAxisModuleIndexMap` maps EVERY module id in the
   * tree to its nearest open-ancestor axis, `SequenceChart.calculateModuleIdToAxisModuleIndexMap()`
   * -- without this, a collapsed compound module's inner traffic is invisible to the
   * minimize-crossings weight matrix). Keys are module ids as strings (JSON object
   * keys); values are indices into `moduleIds`. Entries for ids already in `moduleIds`
   * are ignored (the positional mapping wins).
   */
  moduleIdToAxisIndex?: Record<string, number>;
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

export type RowAnchor =
  | { kind: 'ref'; ref: RowRef }
  | { kind: 'first' }
  | { kind: 'last' }
  | { kind: 'percentage'; percentage: number }
  /**
   * ADDITIVE (phase U6, "Sync, bookmarks, goto"): anchors at the first table row
   * (`EventLogTableFacade.getEntryInEvent(event, 0)`, which is always the "E" line and
   * so always passes every filter mode) of `eventNumber` -- the same resolution
   * `gotoEvent`'s `GotoResult.ref` already uses internally (`EngineSession.
   * eventToGotoResult()`), exposed as a `RowAnchor` variant so a webview that only has
   * an event number (e.g. an incoming cross-view `setSelection`, or a bookmark reveal)
   * can resolve a `RowRef` for it via the ordinary `elog/table/getRows` request instead
   * of a new one-off method. `-1`/nonexistent `eventNumber` resolves like any other
   * unresolvable anchor (`RowWindow.anchorIndex === -1`).
   */
  | { kind: 'event'; eventNumber: number };

export interface RowWindowParams {
  anchor: RowAnchor;
  /** Number of rows to fetch strictly before the anchor. */
  before: number;
  /** Number of rows to fetch at/after the anchor. */
  after: number;
  filterMode?: EventLogTableFilterMode;
  /** Only meaningful with `filterMode: 'CUSTOM_ENTRIES'` (`EventLogTableFacade.setCustomFilter()`). */
  customFilterPattern?: string;
  /**
   * ADDITIVE (phase U2): when present, every returned `TableRow.rendered` is populated
   * (styled-span text for the table's "Details" column plus pre-formatted Event#/Time
   * cells) using these display/name/type modes -- see `tableRowRenderer.ts`. Omitted
   * for `tableNavigate`/`tablePosition` callers that only need the raw fields (e.g.
   * resolving a fix point), and for any caller that wants to avoid the extra
   * rendering cost on a window it is only using for bookkeeping.
   */
  render?: TableRenderModes;
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
  /** ADDITIVE (phase U2): present iff the request's `RowWindowParams.render` was set -- see `tableRowRenderer.ts`. */
  rendered?: RenderedTableRow;
}

// ---------------------------------------------------------------------------------
// Event Log table row rendering (phase U2) -- styled-span row DTOs the webview paints
// directly. Built engine-side (shared/src/eventlog/tableRowRenderer.ts, a pure
// `EventLogEntry` + modes -> DTO function) from a port of
// EventLogTableRowRenderer.java's `getDescriptiveStyledText()`/`getRawStyledText()`.
// No presentation-only state (font, selection highlight, focus) travels here -- the
// webview owns all of that; only content-driven style *tokens* do.
// ---------------------------------------------------------------------------------

/** Port of `EventLogTable.NameMode`. */
export type TableNameMode = 'SMART_NAME' | 'FULL_NAME' | 'FULL_PATH';
/** Port of `EventLogTable.TypeMode`. */
export type TableTypeMode = 'CPP' | 'NED';
/** Port of `EventLogTable.DisplayMode`. */
export type TableDisplayMode = 'DESCRIPTIVE' | 'RAW';

export interface TableRenderModes {
  displayMode: TableDisplayMode;
  nameMode: TableNameMode;
  typeMode: TableTypeMode;
}

/** `EventLogTable`'s own field initializers (constructor defaults). */
export const DEFAULT_TABLE_RENDER_MODES: TableRenderModes = { displayMode: 'DESCRIPTIVE', nameMode: 'SMART_NAME', typeMode: 'CPP' };

/**
 * Style token for one span of styled text. Ported from `EventLogTableRowRenderer.java`'s
 * `Styler` constants (~lines 79-96): `const`/`constBold` = `CONSTANT_TEXT_STYLE`/
 * `BOLD_CONSTANT_TEXT_STYLE` (the leading entry-code token in RAW mode is the only bold
 * constant), `raw` = `RAW_VALUE_STYLE` (an attribute's value in RAW mode), `type` =
 * `TYPE_STYLE` (a `(NedTypeOrClassName)` parenthesized tag), `name` = `NAME_STYLE`
 * (always bold in Java -- module/gate/message names), `msg` = `EVENT_LOG_MESSAGE_STYLE`
 * ("-" free-text lines), `bubble` = `BUBBLE_ENTRY_STYLE`, `faint` =
 * `FAINT_FOREGROUND_COLOR`/`EVENT_LOG_ENTRY_*_STYLE` (dimmed Event#/Time on a non-"E"
 * row -- "duplicated event# dimming for non-first rows of an event"), `eventNo`/
 * `simtime` = `EVENT_ENTRY_EVENT_NUMBER_STYLE`/`EVENT_ENTRY_SIMULATION_TIME_STYLE` (the
 * "E" row's own Event#/Time cells), `data` = `DATA_STYLE`/`HIGHLIGHT_COLOR` (a raw
 * value embedded in descriptive text, e.g. a message kind or delay). The
 * selected-row foreground flip (`Builder.selectedStyle()`) is deliberately NOT part of
 * this token set -- it is pure presentation state the webview applies via CSS on the
 * whole selected row, so rendered rows never need to be regenerated when only the
 * selection changes.
 */
export type TableSpanStyle = 'const' | 'constBold' | 'raw' | 'type' | 'name' | 'msg' | 'bubble' | 'faint' | 'eventNo' | 'simtime' | 'data';

export interface TableSpan {
  text: string;
  style: TableSpanStyle;
}

/** Styled-row DTO: the "Details" column's spans, plus the pre-formatted Event#/Time cells (so the webview never needs to reformat a `BigDecimal` simulation time itself). */
export interface RenderedTableRow {
  /**
   * Indentation, in indent units (multiply by the webview's own pixel constant to get
   * a left offset). Port of `getIndentation()`'s `eventLogEntry.getLevel() *
   * INDENT_SPACING` term, PLUS one indent unit for any non-`EventEntry` row (Java:
   * `if (!(eventLogEntry instanceof EventEntry)) indent += INDENT_SPACING`), PLUS one
   * more for a `SendHopEntry`/`SendDirectEntry` row. Java's base `HORIZONTAL_SPACING`
   * (4px, added regardless of level) is NOT part of this unit count -- the webview
   * adds it once as a fixed per-row base offset.
   */
  indentUnits: number;
  eventNumberSpan: TableSpan;
  simTimeSpan: TableSpan;
  detailSpans: TableSpan[];
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
// elog/table/gotoRelated -- phase U6 "Go To" family (EventLogTableContributor.java port)
// ---------------------------------------------------------------------------------

/**
 * The table's "Go To" family, ported from `EventLogTableContributor.java`'s per-action
 * handlers (verified by reading the source):
 *  - `cause` (Ctrl+Up, "Go to Event Cause"): `event.getCause()`'s
 *    `getBeginMessageDescriptionEntry()` -- the sending event's `BeginSendEntry`, NOT
 *    just that event's first row (`gotoClosest=true`: if the exact entry is filtered
 *    out under the table's current line-filter mode, lands on the closest matching
 *    entry in the same event instead, `EventLogTableFacade.getClosestEntryInEvent()`).
 *  - `arrival` (Ctrl+Down, "Go to Message Arrival"): entry-precise -- `from.entryIndex`
 *    must be the specific `BeginSendEntry` row being asked about (an event can send
 *    several messages); resolves via `event.getConsequences()`, skipping
 *    `MessageReuseDependency`s, to the matching consequence's arrival event
 *    (`getEventEntry()`, `gotoClosest=false`). Java has a discard-the-result bug in the
 *    single-consequence case (verified: `return consequenceEvent.getEventEntry()` from
 *    an `execute()` whose return value nothing reads) -- this port fixes it (single
 *    non-reuse consequence navigates, matching every multi-consequence branch's intent).
 *  - `origin` (context menu only, no Java accelerator): entry-precise, the reverse of a
 *    message reuse -- `event.getCauses()`, first `MessageReuseDependency` whose
 *    `getBeginMessageDescriptionEntry()` is `from`'s own entry, → that reuse's
 *    `getCauseEvent().getEventEntry()` (`gotoClosest=false`).
 *  - `reuse` (context menu only): event-level (not entry-precise, matching Java) --
 *    `event.getConsequences()`, first `MessageReuseDependency` → its
 *    `getBeginMessageDescriptionEntry()` (`gotoClosest=true`).
 *  - `prevEvent`/`nextEvent` (Alt+Up/Alt+Down): `event.getPreviousEvent()`/
 *    `getNextEvent()` → `getEventEntry()`.
 *  - `prevModuleEvent`/`nextModuleEvent` (Shift+Up/Shift+Down): nearest previous/next
 *    event sharing `event.getModuleId()`, walking one event at a time.
 * `null` (no cause/consequence/neighbor/etc., or `from` doesn't resolve) means "no-op" --
 * matches every Java handler's silent-no-navigation behavior (none of these show an
 * error dialog for the ordinary "nothing there" case, only for a stale/filtered-out
 * `from` reference, which this port folds into "just returns null" too).
 */
export type TableGotoRelation = 'cause' | 'arrival' | 'origin' | 'reuse' | 'prevEvent' | 'nextEvent' | 'prevModuleEvent' | 'nextModuleEvent';

export interface TableGotoRelatedParams {
  /** The focused/anchor row the action is relative to -- `entryIndex` matters for `arrival`/`origin` (see `TableGotoRelation`'s doc). */
  from: RowRef;
  relation: TableGotoRelation;
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
// elog/checkChanges
// ---------------------------------------------------------------------------------

/** Result of `elog/checkChanges` -- see `ElogMethods.checkChanges`'s doc comment. */
export interface CheckChangesResult {
  changed: boolean;
  /** Present iff `changed`. */
  change?: 'appended' | 'overwritten';
  /** The current summary either way: unchanged from before if `!changed`, fresh (post-synchronize) if `changed`. */
  summary: LogSummary;
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

// ---------------------------------------------------------------------------------
// elog/releaseMemory -- phase U9
// ---------------------------------------------------------------------------------

/**
 * Result of `elog/releaseMemory`. `eventCacheSizeBefore`/`After` + `eventCacheLimit`
 * report the RAW (unfiltered) `EventLog`'s parsed-event LRU size (`EventLog.
 * getEventCacheSize()`/`getEventCacheLimit()`, phase E7) -- the dominant memory cost
 * this action targets, and the same number regardless of whether a filter is
 * currently active (a `FilteredEventLog` always wraps the one raw `EventLog`, whose
 * cache is what actually holds parsed line data). The `FilteredEvent` proxy cache
 * `FilteredEventLog` layers on top is NOT separately reported (documented
 * simplification -- it re-derives cheaply from the raw log and is a much smaller
 * memory contributor). `EventLogSession` broadcasts this same shape to every attached
 * webview as an `elog/memoryReleased` `engineNotify` event so both the Sequence Chart
 * and the Event Log table refetch their current windows against the fresh state.
 */
export interface ReleaseMemoryResult {
  summary: LogSummary;
  eventCacheSizeBefore: number;
  eventCacheSizeAfter: number;
  eventCacheLimit: number;
}
