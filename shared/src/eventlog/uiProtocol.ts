/**
 * The host<->webview envelope for the Sequence Chart custom editor and the Event
 * Log table view (phase U1, "UI scaffolding" -- see the port plan's "New code
 * layout"/"Architecture" sections at
 * `/home/rhornig/.claude/plans/i-want-to-implement-breezy-treasure.md`).
 *
 * This is deliberately a thin, mostly-proxying envelope: the webview does not
 * speak `elogProtocol.ts`'s JSON-RPC directly (it has no child-process/stdio of
 * its own) -- it wraps an outgoing engine request in `engineRequest` and the host
 * (`client/src/eventlog/eventLogSession.ts`) forwards it to the worker via
 * `WorkerClient`, then wraps the result back in `engineResponse`, correlated by a
 * webview-chosen numeric/string `id` (see `client/webview/src/eventlog/common/
 * rpc.ts`'s pending-map correlator). Both message unions are JSON-pure (same
 * discipline as `elogProtocol.ts`): no class instances, no `Map`/`Set`, no
 * `bigint` -- safe to pass through `vscode.Webview.postMessage`/
 * `window.postMessage` as-is.
 *
 * Host-agnostic and browser-safe: no `vscode` import, nothing Node-specific --
 * both `client/src/eventlog/*` (extension host) and `client/webview/src/
 * eventlog/*` (the two browser IIFE bundles) import this file directly (see
 * `shared/package.json`'s `./ui-protocol` export, added alongside the existing
 * `./elog-protocol` subpath).
 *
 * NOT YET IMPLEMENTED (this phase is scaffolding only -- later phases fill these
 * in without needing to change the envelope shape):
 *  - `EventLogSelection`/`setSelection`/`selectionChanged`: chart<->table sync is
 *    U6. The shape here is the minimal placeholder the port plan's "Integrations"
 *    row describes (an `EventLogSelection` port), enough for U1 to thread a value
 *    through without deciding its final field set.
 *  - `RevealTarget`/`reveal`/`revealRequest`: goto/find results (U1 wires
 *    goto end-to-end per the phase's own deliverable list; findText stays a
 *    command stub until a later phase, but reuses the same `reveal` message).
 *  - `stateChanged`/`persistedState`: the full persistence matrix (chart state,
 *    table state, filter, bookmarks) is state-persistence's job across several
 *    phases; U1 only needs *a* place to carry whatever a webview decides to
 *    persist, opaquely, back into `workspaceState`.
 */

import type { FilterParams, LogSummary, RowRef, VectorIdentity } from './elogProtocol';

// ---------------------------------------------------------------------------------
// Shared payload shapes
// ---------------------------------------------------------------------------------

/**
 * Chart<->table selection -- `EventLogSelection`/`IEventLogSelection` port (phase U6;
 * verified against `omnetpp-dev/ui/org.omnetpp.common/src/org/omnetpp/common/eventlog/
 * EventLogSelection.java`). Java's version is a heterogeneous bag (event numbers,
 * simulation times, module-tree items, ...) belonging to exactly one `EventLogInput`
 * (single-file selections only, matching this port's one-session-per-file model); this
 * shape keeps only the part that is meaningful ACROSS the chart/table boundary --
 * `EventNumberRangeSet`'s flat membership as a plain array (selections stay
 * human-click-sized, never "select all N million events", so no range-compression is
 * needed the way the huge-file-scale table/viewport DTOs require elsewhere in this
 * port). Chart-local rich kinds (axis selection, message-dependency selection, method-
 * call selection, a bare timeline-coordinate click) are NOT part of this shared shape --
 * they stay local to `chart/selection.ts`'s `ChartSelectionState`, matching how Java's
 * `SequenceChart`-only selection kinds never make it into the workbench-wide
 * `IEventLogSelection` contract either (verified: `EventLogSelection`'s public surface
 * is only `getEventNumbers()`/`getSimulationTimes()`, nothing dependency/axis-shaped).
 *
 * `originId` implements the Eclipse re-entry guard (`isSelectionChangeInProgress`,
 * `SequenceChart.java`/`VirtualTable.java`): `EventLogSession.setSelection()` re-
 * broadcasts a `setSelection` to every attachment EXCEPT `originSink` (the one that
 * produced it), so the originating webview never re-applies its own echo. Per the
 * researched Java behavior, receiving a `setSelection` from elsewhere is NOT the same
 * as a local click: Java's `setSelection()` both applies the selection AND reveals it
 * (`reveal(event)`/`scrollToEvent(event)`), whereas a local click only selects (the
 * clicked thing is already on screen) -- both webviews' `setSelection` handlers repeat
 * that asymmetry (see `chartMain.ts`/`tableView.ts`).
 */
export interface EventLogSelection {
  eventNumbers: number[];
  /** Which webview produced this selection ("chart" | "table" | a session-chosen id). */
  originId?: string;
}

/** Where to reveal/scroll to, in both the chart and the table -- result of a
 *  goto/find action. Both variants carry a resolved `ref` (the table's anchor
 *  row) when the engine found one, so the table doesn't need a second round trip. */
export type RevealTarget =
  | { kind: 'event'; eventNumber: number; ref: RowRef | null }
  | { kind: 'simTime'; simulationTime: string; ref: RowRef | null };

// ---------------------------------------------------------------------------------
// Bookmarks (phase U6) -- port of the Eclipse plugins' 4 `IMarker` kinds. See
// `client/src/eventlog/bookmarks.ts`'s header for the storage/toggle logic; this file
// only carries the wire shape both webviews and the host agree on.
// ---------------------------------------------------------------------------------

/**
 * Port of the 4 marker kinds `SequenceChartContributor.java`'s "Toggle bookmark" action
 * creates (verified by reading the source), unified into one flat, optional-field shape
 * (rather than Eclipse's `IMarker` generic attribute bag) since every field is a plain
 * JSON value already. Which optional fields are populated depends on `kind`:
 *  - `'Event'`: `eventNumber`.
 *  - `'Axis'`: `modulePath` (`ModuleTreeItem.getModuleFullPath()`).
 *  - `'MessageDependency'`: `eventNumber` (the CAUSE event number), `messageId`,
 *    `consequenceEventNumber` (ADDITIVE vs. the plan's own sketch field list -- Java
 *    also stores a `dependencyIndex` into `causeEvent.getConsequences()` purely to
 *    re-resolve the exact dependency object on reveal after a possible reload;
 *    this port instead keys identity/marker-matching directly off
 *    `(eventNumber, consequenceEventNumber, messageId)`, which is what `drawList.ts`'s
 *    `dependencyKey()`-shaped matching against a loaded `RenderDependency` already
 *    needs anyway -- no separate index to keep in sync).
 *  - `'ComponentMethodCall'`: `eventNumber`, `entryIndex`, `methodName`.
 * `id` is a store-assigned stable identifier (not part of the Eclipse original, which
 * relies on `IMarker`'s own workspace-assigned id) -- lets `bookmarksChanged`/QuickPick
 * selection reference one bookmark unambiguously without repeating its full identity.
 */
export type BookmarkKind = 'Event' | 'Axis' | 'MessageDependency' | 'ComponentMethodCall';

export interface Bookmark {
  id: string;
  kind: BookmarkKind;
  /** User-entered label (Java: `IMarker.MESSAGE`, from the "Add Bookmark" input dialog). */
  label: string;
  eventNumber?: number;
  modulePath?: string;
  messageId?: number;
  consequenceEventNumber?: number;
  entryIndex?: number;
  methodName?: string;
}

/** A not-yet-labeled/identified bookmark candidate -- `id` is assigned by the store on add; `label` is filled in by the host's "Add Bookmark" input box (native UI, so the webview never carries it). */
export type BookmarkCandidate = Omit<Bookmark, 'id' | 'label'>;

/**
 * Settings threaded from `omnetpp.*` VS Code configuration into `init` (port
 * plan's "Settings" list under "State persistence"). Every field optional --
 * webviews apply their own defaults, matching how `client/src/eventlog/
 * eventLogSession.ts` reads them (`workspace.getConfiguration('omnetpp')`, with
 * `.get(key, default)`).
 */
export interface EventLogUiSettings {
  sequenceChart?: {
    defaultTimelineMode?: string;
    fontSize?: number;
    styleRules?: unknown;
  };
  eventlog?: {
    followEndOnAppend?: boolean;
    maxEngineMemoryMB?: number;
  };
}

// ---------------------------------------------------------------------------------
// webview -> host
// ---------------------------------------------------------------------------------

export type WebviewToHostMessage =
  /** Sent once, right after the webview app's bootstrap code runs -- triggers the host's `init` reply. */
  | { type: 'ready' }
  /**
   * A proxied `elogProtocol.ts` request (method is one of `ElogMethods`'s
   * values). `id` is chosen by the webview's rpc correlator and echoed back
   * verbatim on the matching `engineResponse`.
   */
  | { type: 'engineRequest'; id: number; method: string; params: unknown }
  /**
   * ADDITIVE (phase U4): asks the host to actually abandon the in-flight
   * `engineRequest` numbered `id` (a real `$/cancelRequest`, not just "ignore the
   * eventual answer" -- see `common/rpc.ts`'s `EngineRpc.cancel()`). No-op host-side
   * if `id` already resolved or was never issued (`sequenceChartEditor.ts`'s message
   * pump only tracks a `CancellationTokenSource` while the matching `engineRequest`
   * is still in flight).
   */
  | { type: 'cancelRequest'; id: number }
  /** The webview's local selection changed (U6); `selection.originId` identifies which webview this came from. */
  | { type: 'selectionChanged'; selection: EventLogSelection }
  /** The webview wants the *other* view (or itself) to reveal something it already resolved locally (U6). */
  | { type: 'revealRequest'; target: RevealTarget }
  /** Opaque per-webview UI state to persist (`vscode.setState`-equivalent durable copy the host keeps in `workspaceState`, so a cold restore has something even before the webview reloads). */
  | { type: 'stateChanged'; state: unknown }
  /** Export request (U9) -- mirrors `nedPreviewPanel.ts`'s `export` message shape. */
  | { type: 'export'; format: 'svg' | 'png'; data: string; suggestedName: string }
  /**
   * ADDITIVE (phase U2, Event Log table Ctrl+C): the webview has already assembled the
   * selected rows' plain text (from its own already-rendered spans -- no engine round
   * trip needed for text it already has on screen/in its row cache) and asks the host
   * to put it on the system clipboard (`vscode.env.clipboard.writeText()`), since a
   * webview has no clipboard API of its own for arbitrary text under VS Code's CSP.
   */
  | { type: 'copyText'; text: string }
  /** Ask the host to set a `setContext` key (e.g. to gate a command's `when` clause off webview-local state such as "has a selection"). */
  | { type: 'contextValue'; key: string; value: string | boolean | undefined }
  /**
   * ADDITIVE (phase U6): "Toggle Bookmark" (chart: Ctrl+D on the current selection,
   * one message per candidate; table: the focused row's event) -- see
   * `client/src/eventlog/bookmarks.ts`'s header for the toggle algorithm (delete any
   * existing match silently; otherwise prompt for a label via a native input box, then
   * add). The host replies by re-broadcasting `bookmarksChanged` to every attachment
   * (including the originator -- unlike selection, there is no echo/re-entry concern,
   * since toggling is a one-shot action, not a continuously-driven state).
   */
  | { type: 'toggleBookmark'; candidate: BookmarkCandidate }
  /**
   * ADDITIVE (phase U8, axis-management presets): asks the host to resolve which NED
   * type-level properties (`@networkNode`, `@networkInterface`, `@wireJunction`, ...)
   * each named NED type carries -- the "Network Node"/"Network Interface" preset
   * configurations select open axis modules by NED property, exactly like
   * `SequenceChartContributor.collectAxisModules(property)` does through Eclipse's
   * NEDResources. The host answers via the language server's `omnetpp/mcp/callTool`
   * (`get_ned_type`, one call per unique type name, cached host-side); a type the NED
   * index cannot resolve yields `null` for that name (webview degrades gracefully --
   * see `chartMain.ts`'s preset handlers). `id` is a webview-chosen correlator echoed
   * back on the matching `nedTypeQueryResult`.
   */
  | { type: 'nedTypeQuery'; id: number; typeNames: string[] }
  /**
   * ADDITIVE (phase U7): the Event Log table has no filter panel of its own (only the
   * Sequence Chart hosts one, `client/webview/src/eventlog/chart/filterPanel.ts`) --
   * its "Filter…" toolbar button/context-menu item sends this instead, and the HOST
   * (`eventLogTableView.ts`) opens/focuses the chart editor for the table's current
   * session (spawning one via `vscode.openWith` if none is visible yet) and forwards a
   * `{type:'command', command:'toggleFilterPanel'}` to it once attached. Mirrors
   * `omnetpp.eventlog.openFilter`'s own native-command wiring
   * (`client/src/eventlog/eventLogDialogs.ts`) for the "table only, no chart open yet"
   * case.
   */
  | { type: 'requestFilterPanel' }
  /**
   * ADDITIVE (phase U10, "Go to NED Declaration"): both the Sequence Chart's axis
   * context menu (any axis module, `chartContextMenu.ts`'s `axisSection()`) and the
   * Event Log table's row context menu (a focused row whose entry is a
   * `ModuleCreatedEntry`/`ModuleFoundEntry` -- both `ModuleDescriptionEntry` subtypes,
   * see `shared/src/eventlog/entries.ts`) let the user jump straight to the module's
   * NED type declaration, mirroring the Eclipse IDE's "Open NED Declaration" action
   * reachable from the same object menus there. `typeName` is always already a fully-
   * qualified NED type name (`ModuleDescriptionEntry.nedTypeName`'s own doc comment) --
   * no client-side name resolution needed. The host
   * (`client/src/eventlog/nedNavigation.ts`) resolves it via the language server's
   * `get_ned_type` MCP tool (same path `nedTypeQuery.ts` uses) and opens the document at
   * its `location` itself; no response message is needed since the webview has nothing
   * further to do either way -- an unresolvable type or a missing language client
   * degrades to a plain VS Code status message host-side.
   */
  | { type: 'gotoNedDeclaration'; typeName: string }
  /**
   * ADDITIVE (axis vector data): the user chose "Attach Vector to Axis" on `moduleId`. The
   * host opens a native `.vec` file dialog, then run/vector QuickPicks (the webview can't
   * open native UI), loads the vector into the worker, and replies with
   * `axisVectorAttachmentChanged`. `moduleFullPath` lets the host pre-filter the vector list
   * to the axis module (mirrors Eclipse's pre-filtered vector chooser).
   */
  | { type: 'attachAxisVector'; moduleId: number; moduleFullPath: string }
  /** ADDITIVE (axis vector data): "Detach Vector from Axis" -- host drops the worker attachment and replies with a cleared `axisVectorAttachmentChanged`. */
  | { type: 'detachAxisVector'; moduleId: number }
  /**
   * ADDITIVE (axis vector data): re-attach a persisted vector on load (no dialog) -- host
   * re-reads `fileUri` and re-loads the vector into the worker. `fileUri` is a
   * `vscode.Uri.toString()`.
   */
  | { type: 'reattachAxisVector'; moduleId: number; fileUri: string; vector: VectorIdentity }
  /**
   * ADDITIVE (axis vector data): best-effort `@defaultStatistic` auto-attach. For each
   * candidate axis (a module with a NED type, no vector attached, not persisted), the host
   * looks up the type's `@defaultStatistic`, and if a sibling `.vec` records that vector for
   * the module, attaches it (replying `axisVectorAttachmentChanged`). Silent on any miss.
   */
  | { type: 'autoAttachAxisVectors'; candidates: { moduleId: number; moduleFullPath: string; nedTypeName: string }[] };

// ---------------------------------------------------------------------------------
// host -> webview
// ---------------------------------------------------------------------------------

export type HostToWebviewMessage =
  /**
   * The webview's first message from the host, sent in reply to `ready`. Carries
   * everything the webview needs to render its first frame without a further
   * round trip: which file this is, its last-known engine summary (so the
   * status strip has real data immediately), persisted UI state, and settings.
   */
  | {
      type: 'init';
      fileUri: string;
      persistedState: unknown;
      settings: EventLogUiSettings;
      summary: LogSummary | null;
      /**
       * ADDITIVE (phase U6): the session's current canonical selection, so a webview
       * that (re)attaches -- a fresh reload, or a pinned table rebinding to a different
       * session -- picks up whatever is already selected without waiting for the OTHER
       * view to re-broadcast one (`EventLogSession.getSelection()`; empty
       * `{eventNumbers: []}` before anything has ever been selected in this session).
       */
      selection: EventLogSelection;
      /**
       * ADDITIVE (phase U6): every bookmark currently stored for this file
       * (`client/src/eventlog/bookmarks.ts`'s `BookmarkStore.list()`) -- both webviews
       * render their own subset (chart: event/axis/dependency/methodCall marks; table:
       * event row tint), so both need the full list up front, same reasoning as
       * `selection` above.
       */
      bookmarks: Bookmark[];
      /**
       * ADDITIVE (phase U7): the session's currently-active filter (`null` =
       * unfiltered, `EventLogSession.getCurrentFilterParams()`) -- so the Sequence
       * Chart's filter panel/Del-exclude merge logic has the real params to build on
       * top of immediately, without waiting on a round trip, even when the filter was
       * applied by a PREVIOUS session for this file (persisted + rehydrated on open,
       * see `eventLogController.ts`'s `FILTER_PARAMS_KEY`) rather than by this
       * webview itself.
       */
      filterParams: FilterParams | null;
    }
  /** Reply to a proxied `engineRequest` with the same `id`. Exactly one of `result`/`error` is set. */
  | { type: 'engineResponse'; id: number; result?: unknown; error?: { message: string; code?: number; data?: unknown } }
  /** An unsolicited engine event fanned out to every attached webview (`elog/progress`, `elog/changed`, worker restart, a host-initiated refresh, ...). `event` is an `ElogNotifications` value or a session-local synthetic one (e.g. `"restarted"`). */
  | { type: 'engineNotify'; event: string; payload: unknown }
  /** The *other* view's selection changed (U6); `selection.originId` lets the receiver skip re-applying its own echo. */
  | { type: 'setSelection'; selection: EventLogSelection }
  /** Scroll/highlight a resolved location (goto/find result, or the other view's reveal request). */
  | { type: 'reveal'; target: RevealTarget }
  /** ADDITIVE (phase U6): the full bookmark list changed (a `toggleBookmark` was applied, or the "Show Bookmarks" QuickPick's own store mutation) -- sent to every attachment, origin included. */
  | { type: 'bookmarksChanged'; bookmarks: Bookmark[] }
  /** A forwarded editor-title/view-title command the webview itself must act on (e.g. re-layout, export) -- mirrors `nedPreviewPanel.ts`'s `sendCommand()`. */
  | { type: 'command'; command: string; args?: unknown }
  /**
   * ADDITIVE (phase U8): reply to `nedTypeQuery` with the same `id`. `properties` maps
   * each requested type name to its type-level NED property names (local + inherited,
   * without the `@`), or `null` when the type could not be resolved (no language
   * client, no NED index, or an unknown/unqualified type name).
   */
  | { type: 'nedTypeQueryResult'; id: number; properties: Record<string, string[] | null> }
  /**
   * ADDITIVE (axis vector data): the host attached/detached a vector on `moduleId` (reply to
   * `attachAxisVector`/`detachAxisVector`/`reattachAxisVector`, or a failed/cancelled attach
   * with `attachment: null`). The webview updates its attachment map (menu Attach-vs-Detach
   * state + persistence) and refreshes the chart. `fileUri` is a `vscode.Uri.toString()`.
   */
  | { type: 'axisVectorAttachmentChanged'; moduleId: number; attachment: { fileUri: string; vector: VectorIdentity } | null };
