import * as vscode from 'vscode';
import { MatchKind } from '@omnetpp/shared/elog-protocol';
import type { EventLogController } from './eventLogController';
import type { EventLogSession } from './eventLogSession';

/**
 * The two goto dialogs (`omnetpp.eventlog.gotoEvent`/`.gotoSimulationTime`) --
 * wired end-to-end per the U1 phase's own deliverable list ("wire refresh +
 * goto end-to-end now"). Both validate input, call the engine via the
 * currently active session, and rely on `EventLogSession.gotoEvent()`/
 * `gotoSimTime()` to broadcast the `reveal` message to every attached webview
 * (chart + table) once resolved.
 *
 * `omnetpp.eventlog.openFilter`/`.findText` are intentionally left as stubs:
 * the Filter UI (U7) and the find/goto keyboard family (U4/U6) aren't built
 * yet -- these commands exist now purely so package.json's command surface is
 * stable across phases, per this phase's own instructions.
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

/** Stub -- full find/goto keyboard family (find-in-table, F3/Shift+F3) lands with U4/U6; this keeps the command id stable from U1 on. */
export function findTextCommand(): void {
  void vscode.window.showInformationMessage('OMNeT++: Find in Event Log is not implemented yet (planned for a later phase).');
}
