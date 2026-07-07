import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { showBookmarksCommand } from './bookmarks';
import { EventLogController } from './eventLogController';
import { EventLogTableViewProvider } from './eventLogTableView';
import { SequenceChartEditorProvider } from './sequenceChartEditor';
import {
  gotoEventCommand,
  gotoSimulationTimeCommand,
  openFilterCommand,
  findTextCommand,
  findNextCommand,
  exportSvgCommand,
  copyImageCommand,
  releaseMemoryCommand,
} from './eventLogDialogs';

/**
 * Registers the Sequence Chart custom editor + Event Log panel view + their
 * shared commands (phase U1, "UI scaffolding"). Mirrors `registerNedPreview()`'s
 * shape in `nedPreviewPanel.ts`: one `register*(context, client)`-style entry
 * point called from `extension.ts`. `client` (the `LanguageClient`) serves the
 * chart's NED type-property lookups (phase U8, `nedTypeQuery.ts` -- the
 * Network Node/Network Interface preset configurations); everything else in the
 * eventlog UI talks to its own worker processes, not the language server. Phase U10
 * additionally reuses `client` for both views' "Go to NED Declaration" action
 * (`nedNavigation.ts`), so it is now threaded into `EventLogTableViewProvider` too, not
 * just the Sequence Chart editor.
 */
export function registerEventLog(context: vscode.ExtensionContext, client?: LanguageClient): void {
  const controller = new EventLogController(context);
  context.subscriptions.push(controller);

  context.subscriptions.push(SequenceChartEditorProvider.register(context, controller, client));

  const { provider: tableView, disposable: tableViewDisposable } = EventLogTableViewProvider.register(context, controller, client);
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
    vscode.commands.registerCommand('omnetpp.eventlog.openFilter', () => void openFilterCommand(controller, tableView)),
    vscode.commands.registerCommand('omnetpp.eventlog.gotoEvent', () => gotoEventCommand(controller)),
    vscode.commands.registerCommand('omnetpp.eventlog.gotoSimulationTime', () => gotoSimulationTimeCommand(controller)),
    vscode.commands.registerCommand('omnetpp.eventlog.findText', () => findTextCommand(controller)),
    vscode.commands.registerCommand('omnetpp.eventlog.findNext', () => findNextCommand(controller)),
    vscode.commands.registerCommand('omnetpp.eventlog.showBookmarks', () => showBookmarksCommand(controller, tableView.getBoundSession())),
    // Phase U9 -- export/polish
    vscode.commands.registerCommand('omnetpp.eventlog.exportSvg', () => exportSvgCommand(controller)),
    vscode.commands.registerCommand('omnetpp.eventlog.copyImage', () => copyImageCommand(controller)),
    vscode.commands.registerCommand('omnetpp.eventlog.releaseMemory', () => void releaseMemoryCommand(controller, tableView)),
    // pin/unpin follows this codebase's established pattern for the other
    // pinnable views (pinType/unpinType, pinModule/unpinModule, ...): one
    // command per icon state, gated by the `omnetpp.eventlogTablePinned`
    // context key in package.json's `view/title` menu (both toggle the same
    // underlying state).
    vscode.commands.registerCommand('omnetpp.eventlog.pinEventLogTable', () => tableView.togglePin()),
    vscode.commands.registerCommand('omnetpp.eventlog.unpinEventLogTable', () => tableView.togglePin()),
  );
}
