import * as vscode from 'vscode';
import { MatchKind } from '@omnetpp/shared/elog-protocol';
import type { EventLogController } from './eventLogController';
import type { EventLogSession } from './eventLogSession';
import type { EventLogTableViewProvider } from './eventLogTableView';
import { SEQUENCE_CHART_VIEW_TYPE } from './sequenceChartEditor';

/**
 * The goto/find commands (`omnetpp.eventlog.gotoEvent`/`.gotoSimulationTime`/
 * `.findText`/`.findNext`).
 *
 * Phase U4 decision record: "in-webview dialogs" (`common/dialogs.ts`, in the
 * Sequence Chart webview) are the primary UI -- they validate against data the
 * webview already has loaded (event-number range, last simulation time) without a
 * native-UI round trip, and their OK action reuses the webview's own
 * `elog/gotoEvent`/`elog/gotoSimTime`/`elog/findText` RPC calls, which already
 * broadcast `reveal` to every attached webview (chart + table) via
 * `EventLogSession.gotoEvent()`/`gotoSimTime()`. This file's job is the WIRING
 * decision, not the dialog UI itself: **when a Sequence Chart webview is attached to
 * the active session, forward the command into it** (`session.sendCommand(...)`,
 * handled by `chartMain.ts`'s `'command'` case) so the in-webview dialog opens;
 * **otherwise** (no chart webview at all -- e.g. only the Event Log table panel is
 * open, or no `.elog` file is open yet) fall back to the ORIGINAL native
 * `vscode.window.showInputBox()` flow below, which still works standalone. This is
 * "the simplest correct wiring" the phase brief asks for: no new native UI to
 * maintain, and the native fallback still functions when there is nowhere to forward to.
 *
 * `omnetpp.eventlog.openFilter` (phase U7): follows the very same "forward into the
 * webview if a chart is attached" shape as goto/find above, but with an extra fallback
 * step of its own -- "if no chart editor visible, open one" (`openFilterPanelForSession()`
 * below), since unlike goto/find there is no sensible NATIVE fallback for a whole filter
 * panel (a native input box cannot replicate 6 sections + a module tree). The active
 * chart editor is preferred; if none is focused, the Event Log table's currently bound
 * session (if any) is used instead -- the table has no filter panel of its own (see
 * `uiProtocol.ts`'s `requestFilterPanel` doc comment) but IS a legitimate source of
 * "which file did the user mean".
 */

async function withActiveSession(controller: EventLogController, action: string): Promise<EventLogSession | undefined> {
  const session = controller.getActiveSession();
  if (!session) {
    void vscode.window.showInformationMessage(`OMNeT++: ${action} needs a focused Sequence Chart editor.`);
    return undefined;
  }
  return session;
}

export async function gotoEventCommand(controller: EventLogController): Promise<void> {
  const session = await withActiveSession(controller, 'Go to Event');
  if (!session) return;
  if (session.hasChartAttachment()) {
    session.sendCommand('openGotoEventDialog');
    return;
  }
  const input = await vscode.window.showInputBox({
    prompt: 'Go to event number',
    placeHolder: 'e.g. 1234',
    validateInput: (v) => (/^\d+$/.test(v.trim()) ? undefined : 'Enter a non-negative integer event number'),
  });
  if (input === undefined) return;
  const eventNumber = Number(input.trim());
  try {
    const result = await session.gotoEvent({ eventNumber, matchKind: MatchKind.EXACT });
    if (!result.found) void vscode.window.showWarningMessage(`OMNeT++: event #${eventNumber} not found.`);
  } catch (err) {
    void vscode.window.showErrorMessage(`OMNeT++: Go to Event failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function gotoSimulationTimeCommand(controller: EventLogController): Promise<void> {
  const session = await withActiveSession(controller, 'Go to Simulation Time');
  if (!session) return;
  if (session.hasChartAttachment()) {
    session.sendCommand('openGotoSimTimeDialog');
    return;
  }
  const input = await vscode.window.showInputBox({
    prompt: 'Go to simulation time',
    placeHolder: 'e.g. 1.5 or 0.000000001',
    validateInput: (v) => (/^\d+(\.\d+)?$/.test(v.trim()) ? undefined : 'Enter a non-negative decimal simulation time'),
  });
  if (input === undefined) return;
  try {
    const result = await session.gotoSimTime({ simulationTime: input.trim(), matchKind: MatchKind.FIRST_OR_PREVIOUS });
    if (!result.found) void vscode.window.showWarningMessage(`OMNeT++: simulation time ${input.trim()} not found.`);
  } catch (err) {
    void vscode.window.showErrorMessage(`OMNeT++: Go to Simulation Time failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function openFilterCommand(controller: EventLogController, tableView: EventLogTableViewProvider): Promise<void> {
  const session = controller.getActiveSession() ?? tableView.getBoundSession();
  if (!session) {
    void vscode.window.showInformationMessage('OMNeT++: Filter Event Log needs an open .elog file (a Sequence Chart editor or a bound Event Log table).');
    return;
  }
  await openFilterPanelForSession(session);
}

/**
 * Opens/focuses `session`'s Sequence Chart editor and toggles its filter panel --
 * shared by the `omnetpp.eventlog.openFilter` command above and the Event Log table's
 * "Filter…" toolbar/context-menu item (`eventLogTableView.ts`'s `requestFilterPanel`
 * handling, since the table has no filter panel of its own).
 */
export async function openFilterPanelForSession(session: EventLogSession): Promise<void> {
  if (session.hasChartAttachment()) {
    session.sendCommand('toggleFilterPanel');
    return;
  }
  // No chart webview attached yet -- open one (port plan: "if no chart editor visible,
  // open one"). `sequenceChartEditor.ts`'s `ready` handler consumes this flag right
  // after sending `init`, so the panel opens as soon as the fresh webview is ready,
  // without a race against its own bootstrap script.
  session.requestOpenFilterOnAttach();
  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.parse(session.uriString), SEQUENCE_CHART_VIEW_TYPE);
}

/**
 * Forwards to the webview's in-webview Find Text dialog (see this file's header). No
 * native fallback: Find in the Event Log is chart/table-content-specific and has no
 * sensible standalone native-input-box equivalent (there is nothing to search without
 * a webview showing rows/events) -- if no chart is attached, this just informs the
 * user instead of popping an input box that could never resolve to anything.
 */
export function findTextCommand(controller: EventLogController): void {
  const session = controller.getActiveSession();
  if (!session?.hasChartAttachment()) {
    void vscode.window.showInformationMessage('OMNeT++: Find in Event Log needs a focused Sequence Chart editor.');
    return;
  }
  session.sendCommand('openFindTextDialog');
}

/** Repeats the webview's last Find Text search (`chartMain.ts` keeps the last `FindTextState`). */
export function findNextCommand(controller: EventLogController): void {
  const session = controller.getActiveSession();
  if (!session?.hasChartAttachment()) {
    void vscode.window.showInformationMessage('OMNeT++: Find Next needs a focused Sequence Chart editor.');
    return;
  }
  session.sendCommand('findNext');
}

/**
 * Phase U9 -- "Export to SVG..." (`omnetpp.eventlog.exportSvg`): forwards into the
 * Sequence Chart webview's own in-webview export-range dialog (`chart/exportDialog.
 * ts`), which builds the SVG string client-side and posts an `export` message the
 * shared `handleExport()` (`sequenceChartEditor.ts`) already handles -- same "forward
 * if a chart is attached, otherwise inform" shape as `findTextCommand()` above (there
 * is no sensible native fallback: exporting needs the chart's already-loaded
 * draw-list geometry).
 */
export function exportSvgCommand(controller: EventLogController): void {
  const session = controller.getActiveSession();
  if (!session?.hasChartAttachment()) {
    void vscode.window.showInformationMessage('OMNeT++: Export to SVG needs a focused Sequence Chart editor.');
    return;
  }
  session.sendCommand('exportSvg');
}

/** Phase U9 -- "Copy Image to Clipboard" (`omnetpp.eventlog.copyImage`): forwards into the webview, which rasterizes its own on-screen canvas (see `chartMain.ts`'s `doCopyImage()` for the clipboard-API/file-save fallback split). */
export function copyImageCommand(controller: EventLogController): void {
  const session = controller.getActiveSession();
  if (!session?.hasChartAttachment()) {
    void vscode.window.showInformationMessage('OMNeT++: Copy Image to Clipboard needs a focused Sequence Chart editor.');
    return;
  }
  session.sendCommand('copyImage');
}

/**
 * Phase U9 -- "Release Memory" (`omnetpp.eventlog.releaseMemory`): unlike export/find,
 * this is NOT chart-specific (it acts on the shared engine, benefiting the table too)
 * -- mirrors `omnetpp.eventlog.refresh`'s own "prefer the focused chart editor, fall
 * back to whatever the table view is bound to" shape (`index.ts`'s registration),
 * so it works even when only the Event Log table panel is open.
 */
export async function releaseMemoryCommand(controller: EventLogController, tableView: EventLogTableViewProvider): Promise<void> {
  const session = controller.getActiveSession() ?? tableView.getBoundSession();
  if (!session) {
    void vscode.window.showInformationMessage('OMNeT++: Release Memory needs an open .elog file (a Sequence Chart editor or a bound Event Log table).');
    return;
  }
  try {
    const result = await session.releaseMemory();
    void vscode.window.showInformationMessage(
      `OMNeT++: Released event cache (${result.eventCacheSizeBefore.toLocaleString()} → ${result.eventCacheSizeAfter.toLocaleString()} of ${result.eventCacheLimit.toLocaleString()} events cached).`,
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`OMNeT++: Release Memory failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
