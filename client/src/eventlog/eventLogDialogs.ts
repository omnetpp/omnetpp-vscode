import * as vscode from 'vscode';
import { MatchKind } from '@omnetpp/shared/elog-protocol';
import type { EventLogController } from './eventLogController';
import type { EventLogSession } from './eventLogSession';

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
 * `omnetpp.eventlog.openFilter` remains a stub: the Filter UI is phase U7 (needs
 * E5's match infra surfaced through a real panel).
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

/** Stub -- the Filter UI is phase U7 (needs E5's match infra to be surfaced through a real panel). */
export function openFilterCommand(): void {
  void vscode.window.showInformationMessage('OMNeT++: the Event Log filter panel is not implemented yet (planned for a later phase).');
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
