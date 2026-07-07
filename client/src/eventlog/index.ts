import * as vscode from 'vscode';
import { EventLogController } from './eventLogController';
import { EventLogTableViewProvider } from './eventLogTableView';
import { SequenceChartEditorProvider } from './sequenceChartEditor';
import { gotoEventCommand, gotoSimulationTimeCommand, openFilterCommand, findTextCommand, findNextCommand } from './eventLogDialogs';

/**
 * Registers the Sequence Chart custom editor + Event Log panel view + their
 * shared commands (phase U1, "UI scaffolding"). Mirrors `registerNedPreview()`'s
 * shape in `nedPreviewPanel.ts`: one `register*(context, client)`-style entry
 * point called from `extension.ts`. `client` (the `LanguageClient`) is
 * currently unused here -- the eventlog UI talks to its own worker processes,
 * not the NED/MSG/INI language server -- but the parameter is kept for
 * consistency with the other `register*` functions and in case a later phase
 * needs it (e.g. `gotoNedDeclaration`, U10, via `get_ned_type`).
 */
export function registerEventLog(context: vscode.ExtensionContext): void {
  const controller = new EventLogController(context);
  context.subscriptions.push(controller);

  context.subscriptions.push(SequenceChartEditorProvider.register(context, controller));

  const { provider: tableView, disposable: tableViewDisposable } = EventLogTableViewProvider.register(context, controller);
  context.subscriptions.push(tableViewDisposable);

  // seed the pin toggle's context key (defaults to unpinned)
  void vscode.commands.executeCommand('setContext', 'omnetpp.eventlogTablePinned', false);

  context.subscriptions.push(
    vscode.commands.registerCommand('omnetpp.eventlog.showEventLogTable', () => tableView.reveal()),
    vscode.commands.registerCommand('omnetpp.eventlog.refresh', async () => {
      // Prefer the focused Sequence Chart editor; fall back to whatever the
      // table view is currently bound to (e.g. invoked from the panel's
      // view/title while no chart editor has focus).
      if (controller.getActiveSession()) await controller.refreshActive();
      else await tableView.refresh();
    }),
    vscode.commands.registerCommand('omnetpp.eventlog.openFilter', () => openFilterCommand()),
    vscode.commands.registerCommand('omnetpp.eventlog.gotoEvent', () => gotoEventCommand(controller)),
    vscode.commands.registerCommand('omnetpp.eventlog.gotoSimulationTime', () => gotoSimulationTimeCommand(controller)),
    vscode.commands.registerCommand('omnetpp.eventlog.findText', () => findTextCommand(controller)),
    vscode.commands.registerCommand('omnetpp.eventlog.findNext', () => findNextCommand(controller)),
    // pin/unpin follows this codebase's established pattern for the other
    // pinnable views (pinType/unpinType, pinModule/unpinModule, ...): one
    // command per icon state, gated by the `omnetpp.eventlogTablePinned`
    // context key in package.json's `view/title` menu (both toggle the same
    // underlying state).
    vscode.commands.registerCommand('omnetpp.eventlog.pinEventLogTable', () => tableView.togglePin()),
    vscode.commands.registerCommand('omnetpp.eventlog.unpinEventLogTable', () => tableView.togglePin()),
  );
}
