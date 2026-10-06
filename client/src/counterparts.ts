// The "OMNeT++: Switch Between C++ and NED File" command (alt+o): steps the
// active editor through the .cc → .h → .ned ring of the module it belongs to.
// The server pairs the files semantically (@class, @namespace, Define_Module);
// this side only picks the next ring member and asks when it is ambiguous.
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { OmnetppMethods, nextCounterpart } from '@omnetpp/shared/protocol';
import type { CounterpartKind, CounterpartParams, CounterpartResult, CounterpartTarget } from '@omnetpp/shared/protocol';

const KIND_NAMES: Record<CounterpartKind, string> = { cc: 'C++ source', h: 'C++ header', ned: 'NED' };

async function switchCounterpart(client: LanguageClient): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const p = ed.selection.active;
  const params: CounterpartParams = {
    uri: ed.document.uri.toString(),
    position: { line: p.line, character: p.character },
  };
  let res: CounterpartResult;
  try {
    res = await client.sendRequest<CounterpartResult>(OmnetppMethods.counterparts, params);
  } catch {
    return;
  }
  const next = nextCounterpart(res);
  if (!next) {
    vscode.window.setStatusBarMessage(
      res.kind ? 'OMNeT++: no corresponding .cc/.h/.ned file found' : 'OMNeT++: not a .cc/.h/.ned file',
      4000,
    );
    return;
  }
  let target: CounterpartTarget | undefined = next.targets[0];
  if (next.targets.length > 1) {
    const picks = next.targets.map((t) => ({
      label: t.label,
      description: vscode.workspace.asRelativePath(vscode.Uri.parse(t.uri)),
      target: t,
    }));
    target = (
      await vscode.window.showQuickPick(picks, {
        title: `Open ${KIND_NAMES[next.kind]} file`,
        matchOnDescription: true,
      })
    )?.target;
  }
  if (target) await vscode.commands.executeCommand('omnetpp.openLocation', target.uri, target.range);
}

export function registerCounterpartCommand(context: vscode.ExtensionContext, client: LanguageClient): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('omnetpp.switchCounterpart', () => switchCounterpart(client)),
  );
}
