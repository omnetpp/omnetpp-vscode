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

import type { LogSummary, RowRef } from './elogProtocol';

// ---------------------------------------------------------------------------------
// Shared payload shapes
// ---------------------------------------------------------------------------------

/**
 * Chart<->table selection (U6 "Sync, bookmarks, goto" -- `EventLogSelection` port).
 * `originId` lets the session apply the Eclipse "re-entry guard": a webview that
 * receives a `setSelection` it just originated (round-tripped back to it) should
 * not re-broadcast it. Left minimal on purpose -- U6 will likely grow this
 * (module id, entry index, range selections).
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
  /** The webview's local selection changed (U6); `selection.originId` identifies which webview this came from. */
  | { type: 'selectionChanged'; selection: EventLogSelection }
  /** The webview wants the *other* view (or itself) to reveal something it already resolved locally (U6). */
  | { type: 'revealRequest'; target: RevealTarget }
  /** Opaque per-webview UI state to persist (`vscode.setState`-equivalent durable copy the host keeps in `workspaceState`, so a cold restore has something even before the webview reloads). */
  | { type: 'stateChanged'; state: unknown }
  /** Export request (U9) -- mirrors `nedPreviewPanel.ts`'s `export` message shape. */
  | { type: 'export'; format: 'svg' | 'png'; data: string; suggestedName: string }
  /** Ask the host to set a `setContext` key (e.g. to gate a command's `when` clause off webview-local state such as "has a selection"). */
  | { type: 'contextValue'; key: string; value: string | boolean | undefined };

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
    }
  /** Reply to a proxied `engineRequest` with the same `id`. Exactly one of `result`/`error` is set. */
  | { type: 'engineResponse'; id: number; result?: unknown; error?: { message: string; code?: number; data?: unknown } }
  /** An unsolicited engine event fanned out to every attached webview (`elog/progress`, `elog/changed`, worker restart, a host-initiated refresh, ...). `event` is an `ElogNotifications` value or a session-local synthetic one (e.g. `"restarted"`). */
  | { type: 'engineNotify'; event: string; payload: unknown }
  /** The *other* view's selection changed (U6); `selection.originId` lets the receiver skip re-applying its own echo. */
  | { type: 'setSelection'; selection: EventLogSelection }
  /** Scroll/highlight a resolved location (goto/find result, or the other view's reveal request). */
  | { type: 'reveal'; target: RevealTarget }
  /** A forwarded editor-title/view-title command the webview itself must act on (e.g. re-layout, export) -- mirrors `nedPreviewPanel.ts`'s `sendCommand()`. */
  | { type: 'command'; command: string; args?: unknown };
