// The "OMNeT++: Generate NED Documentation" command: resolves the
// omnetpp.neddoc.* settings (the persistent generator configuration), asks
// for the output format (preselected from the setting, with a shortcut into
// the filtered Settings UI), runs the omnetpp/generateDocs request against
// the live language server index with a cancellable progress notification,
// and offers to open the generated documentation.
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { OmnetppMethods } from '@omnetpp/shared/protocol';
import type { GenerateDocsParams, GenerateDocsProgress, GenerateDocsResult } from '@omnetpp/shared/protocol';

type DocFormat = GenerateDocsParams['format'];

interface FormatItem extends vscode.QuickPickItem {
  format?: DocFormat;
  configure?: boolean;
}

const FORMATS: { format: DocFormat; label: string; description: string }[] = [
  { format: 'html', label: 'HTML', description: 'browsable static site with navigation and search' },
  { format: 'html-readthedocs', label: 'HTML (Read the Docs)', description: 'the same static site, styled like the Read the Docs theme' },
  { format: 'html-material', label: 'HTML (Material)', description: "the Eclipse IDE's neddoc look & feel (Material Design template)" },
  { format: 'markdown', label: 'Markdown', description: '.md files with SUMMARY.md navigation' },
  { format: 'rst', label: 'reStructuredText', description: 'Sphinx-ready .rst files' },
];

/** Resolve the omnetpp.neddoc.* settings into request params (paths made
 *  absolute against the workspace folder). */
function paramsFromSettings(folder: vscode.WorkspaceFolder, format: DocFormat): GenerateDocsParams {
  const cfg = vscode.workspace.getConfiguration('omnetpp.neddoc');
  const resolvePath = (value: string): string | undefined =>
    value ? (path.isAbsolute(value) ? value : path.join(folder.uri.fsPath, value)) : undefined;
  return {
    outputDir: resolvePath(cfg.get<string>('outputDirectory', 'doc/neddoc'))!,
    format,
    title: cfg.get<string>('title', '') || folder.name,
    excludeDirs: cfg.get<string[]>('excludeDirs', []),
    networkDiagrams: cfg.get<boolean>('networkDiagrams', true),
    usageDiagrams: cfg.get<boolean>('usageDiagrams', true),
    inheritanceDiagrams: cfg.get<boolean>('inheritanceDiagrams', true),
    fullUsageDiagram: cfg.get<boolean>('fullUsageDiagram', false),
    fullInheritanceDiagram: cfg.get<boolean>('fullInheritanceDiagram', false),
    messageDefinitions: cfg.get<boolean>('messageDefinitions', true),
    sourceListings: cfg.get<boolean>('sourceListings', true),
    automaticHyperlinks: cfg.get<boolean>('automaticHyperlinks', true),
    includeBuiltins: cfg.get<boolean>('includeBuiltins', false),
    customCssPath: resolvePath(cfg.get<string>('customCss', '')),
    doxytagsPath: resolvePath(cfg.get<string>('doxytagsFile', '')),
    doxyUrlPrefix: cfg.get<string>('doxyUrlPrefix', '') || undefined,
    externalDocs: cfg.get<Record<string, string>>('externalDocs', {}),
  };
}

async function pickFormat(): Promise<DocFormat | undefined> {
  const defaultFormat = vscode.workspace.getConfiguration('omnetpp.neddoc').get<DocFormat>('format', 'html');
  const items: FormatItem[] = [
    // the configured default first, marked
    ...FORMATS.slice()
      .sort((a, b) => Number(b.format === defaultFormat) - Number(a.format === defaultFormat))
      .map((f) => ({ ...f, description: `${f.description}${f.format === defaultFormat ? '  (default)' : ''}` })),
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(gear) Configure documentation settings...', configure: true },
  ];
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Documentation output format' });
  if (!picked) return undefined;
  if (picked.configure) {
    void vscode.commands.executeCommand('workbench.action.openSettings', 'omnetpp.neddoc');
    return undefined;
  }
  return picked.format;
}

export function registerDocsCommand(context: vscode.ExtensionContext, client: LanguageClient): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('omnetpp.generateNedDocumentation', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder || folder.uri.scheme !== 'file') {
        void vscode.window.showErrorMessage('Open a folder to generate NED documentation.');
        return;
      }
      const format = await pickFormat();
      if (!format) return;
      const params = paramsFromSettings(folder, format);

      try {
        const result = await vscode.window.withProgress<GenerateDocsResult>(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Generating NED documentation',
            cancellable: true,
          },
          async (progress, token) => {
            // the server reports an overall percentage; withProgress renders a
            // determinate bar from the increments between reports
            let lastPercent = 0;
            const sub = client.onNotification(OmnetppMethods.generateDocsProgress, (p: GenerateDocsProgress) => {
              const increment = Math.max(0, Math.min(100, p.percent) - lastPercent);
              lastPercent += increment;
              progress.report({
                increment,
                message: p.total ? `${p.step} (${p.done}/${p.total})` : p.step,
              });
            });
            try {
              return await client.sendRequest<GenerateDocsResult>(OmnetppMethods.generateDocs, params, token);
            } finally {
              sub.dispose();
            }
          },
        );
        for (const w of result.warnings.slice(0, 3)) void vscode.window.showWarningMessage(`neddoc: ${w}`);
        for (const w of result.externalWarnings) client.outputChannel.appendLine(`neddoc: ${w}`);
        const unlinked = result.externalWarnings.length
          ? ` Types from ${result.externalWarnings.length} dependenc${result.externalWarnings.length === 1 ? 'y are' : 'ies are'} not linked (see the output).`
          : '';
        const action = await vscode.window.showInformationMessage(
          `NED documentation generated: ${result.pages} page(s), ${result.diagrams} diagram(s).${unlinked}`,
          'Open',
          'Reveal in Explorer',
          ...(unlinked ? ['Show Output'] : []),
        );
        if (action === 'Show Output') client.outputChannel.show(true);
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
