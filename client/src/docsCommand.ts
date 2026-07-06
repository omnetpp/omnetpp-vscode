// The "OMNeT++: Generate NED Documentation" command: asks for the output
// format, runs the omnetpp/generateDocs request against the live language
// server index with a cancellable progress notification, and offers to open
// the generated documentation.
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { OmnetppMethods } from '@omnetpp/shared/protocol';
import type { GenerateDocsParams, GenerateDocsProgress, GenerateDocsResult } from '@omnetpp/shared/protocol';

interface FormatItem extends vscode.QuickPickItem {
  format: GenerateDocsParams['format'];
}

const FORMATS: FormatItem[] = [
  { label: 'HTML', description: 'browsable static site with navigation and search', format: 'html' },
  { label: 'HTML (legacy)', description: 'the Eclipse IDE\'s neddoc look & feel', format: 'legacy-html' },
  { label: 'Markdown', description: '.md files with SUMMARY.md navigation', format: 'markdown' },
  { label: 'reStructuredText', description: 'Sphinx-ready .rst files', format: 'rst' },
];

export function registerDocsCommand(context: vscode.ExtensionContext, client: LanguageClient): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('omnetpp.generateNedDocumentation', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder || folder.uri.scheme !== 'file') {
        void vscode.window.showErrorMessage('Open a folder to generate NED documentation.');
        return;
      }
      const lastFormat = context.workspaceState.get<string>('omnetpp.neddoc.format', 'html');
      const picked = await vscode.window.showQuickPick(
        FORMATS.map((f) => ({ ...f, picked: f.format === lastFormat })),
        { placeHolder: 'Documentation output format' },
      );
      if (!picked) return;
      void context.workspaceState.update('omnetpp.neddoc.format', picked.format);

      const outputDir = path.join(folder.uri.fsPath, 'doc', 'neddoc');
      try {
        const result = await vscode.window.withProgress<GenerateDocsResult>(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Generating NED documentation',
            cancellable: true,
          },
          async (progress, token) => {
            const sub = client.onNotification(OmnetppMethods.generateDocsProgress, (p: GenerateDocsProgress) => {
              progress.report({ message: p.total ? `${p.step} (${p.done}/${p.total})` : p.step });
            });
            try {
              const params: GenerateDocsParams = { outputDir, format: picked.format };
              return await client.sendRequest<GenerateDocsResult>(OmnetppMethods.generateDocs, params, token);
            } finally {
              sub.dispose();
            }
          },
        );
        for (const w of result.warnings.slice(0, 3)) void vscode.window.showWarningMessage(`neddoc: ${w}`);
        const action = await vscode.window.showInformationMessage(
          `NED documentation generated: ${result.pages} page(s), ${result.diagrams} diagram(s).`,
          'Open',
          'Reveal in Explorer',
        );
        if (action === 'Open') {
          void vscode.env.openExternal(vscode.Uri.file(result.indexPath));
        } else if (action === 'Reveal in Explorer') {
          void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.indexPath));
        }
      } catch (err) {
        if (err instanceof vscode.CancellationError) return;
        const message = err instanceof Error ? err.message : String(err);
        if (/cancelled/i.test(message)) return;
        void vscode.window.showErrorMessage(`Generating NED documentation failed: ${message}`);
      }
    }),
  );
}
