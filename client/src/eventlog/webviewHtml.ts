import * as vscode from 'vscode';

/**
 * Shared `buildHtml()` for the Sequence Chart custom editor and the Event Log
 * table webview view -- both load a codicon-styled in-webview toolbar (U1's
 * `client/webview/src/eventlog/common/toolbar.ts`), so both need the codicon
 * font/CSS bundled alongside their script (`copy-assets.mjs` copies
 * `@vscode/codicons`' `codicon.css`/`codicon.ttf` to `dist/webview/codicons/`).
 *
 * Cloned from `nedPreviewPanel.ts`'s `buildHtml()` (CSP nonce pattern) and
 * extended per the port plan: `style-src` gains `cspSource` (for the external
 * `codicon.css` `<link>`, which a nonce alone cannot authorize -- nonces only
 * cover inline `<style>`/`<script>` tags) and a new `font-src cspSource`
 * directive (for `codicon.css`'s `@font-face` -> `codicon.ttf`).
 */
export function buildEventLogWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, scriptFile: string, title: string): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', scriptFile));
  const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'codicons', 'codicon.css'));
  const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; connect-src ${webview.cspSource}; style-src 'nonce-${nonce}' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<link rel="stylesheet" href="${codiconCssUri}">
<style nonce="${nonce}">
  html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: var(--vscode-font-size); }
  #root { display: flex; flex-direction: column; height: 100%; }
  .elog-toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 2px; padding: 2px 6px;
    background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-editorWidget-border, transparent); }
  .elog-toolbar button { display: flex; align-items: center; justify-content: center; gap: 4px;
    height: 22px; padding: 0 4px; background: transparent; color: var(--vscode-foreground);
    border: none; border-radius: 3px; cursor: pointer; }
  .elog-toolbar button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
  .elog-toolbar button.active { background: var(--vscode-toolbar-activeBackground, rgba(128,128,128,0.3)); }
  .elog-toolbar button:disabled { opacity: 0.4; cursor: default; }
  .elog-toolbar select { height: 22px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 3px; font-size: inherit; }
  .elog-toolbar .spacer { flex: 1 1 auto; }
  .elog-status { flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 3px 8px; font-size: 11px;
    color: var(--vscode-descriptionForeground); background: var(--vscode-editorWidget-background);
    border-bottom: 1px solid var(--vscode-editorWidget-border, transparent); }
  .elog-status .placeholder { font-style: italic; }
  .elog-body { flex: 1 1 auto; overflow: auto; position: relative; }
  .elog-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: var(--vscode-descriptionForeground); font-size: 13px; text-align: center; padding: 0 24px; }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
